import { createHash } from "node:crypto"
import { API_USER_AGENT } from "./api-auth.mjs"
import { AuthError } from "../oauth.mjs"
import { normalizeRequest, dropBareReasoningItems, stripReasoningEncryptedContent, dropAllReasoningItems, parseReferencedReasoningId } from "./responses-compat.mjs"

export const META_API_BASE = "https://api.meta.ai/v1"
export function validateAPIBase(baseURL = META_API_BASE, localTestBackend = false) {
  const base = new URL(baseURL), normalized = base.href.replace(/\/$/, "")
  if (base.username || base.password || base.search || base.hash || (normalized !== META_API_BASE && !(localTestBackend && base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)))) throw new Error("API credentials may only be sent to Meta; local test backends must be explicitly enabled loopback HTTP")
  return normalized
}
const errorResponse = (status, message) => Response.json({ error: { type: "muse_api_error", message } }, { status })
const authFailure = error => {
  const expired = error instanceof AuthError && error.signIn === "expired"
  return Response.json({ error: { type: "muse_api_error", message: error instanceof AuthError ? error.message : "Muse credentials are temporarily unavailable; retry." } },
    { status: expired ? 401 : 503, headers: { "X-Magpie-Sign-In": expired ? "expired" : "kept" } })
}
// By default (`toolNames: "reserved"`) a name the API accepts as written is sent unchanged, description included, as a
// Chat Completions route sends it; only the Muse Code client's own tool names (RESERVED_TOOL_NAMES), a name the API
// would reject and one that could be taken for an alias get a deterministic alias. `"native"` aliases only the last
// two, `"hashed"` every name. `reasoningReplay` and `instructionsAs` are explained where they apply.
const API_NAME = /^[A-Za-z0-9_-]{1,64}$/
const aliasName = name => "client_" + createHash("sha256").update(name).digest("hex").slice(0, 40)
const TOOL_NAMES = new Set(["reserved", "native", "hashed"]), REASONING_REPLAY = new Set(["keep", "drop"]), INSTRUCTIONS_AS = new Set(["instructions", "message"])
const CUT_TURNS = new Set(["continue", "pass"])
// `toolNames: "reserved"` sends a name as declared, as a Chat Completions route such as OpenRouter's does, except the
// names a subscription key refuses because the Muse Code client uses them itself (`403 client_attestation_denied`,
// seen live with `bash`): those, and any name the API would reject or that could be taken for an alias, are aliased.
// A request refused all the same is sent again with every name aliased, and that tool set stays aliased.
export const RESERVED_TOOL_NAMES = new Set(["bash", "read", "write", "edit"])
export function validateAPIOptions({ toolNames = "reserved", reasoningReplay = "drop", instructionsAs = "message", cutTurns = "continue" } = {}) {
  if (!TOOL_NAMES.has(toolNames)) throw new Error('Option toolNames must be "reserved", "native" or "hashed"')
  if (!REASONING_REPLAY.has(reasoningReplay)) throw new Error('Option reasoningReplay must be "keep" or "drop"')
  if (!INSTRUCTIONS_AS.has(instructionsAs)) throw new Error('Option instructionsAs must be "instructions" or "message"')
  if (!CUT_TURNS.has(cutTurns)) throw new Error('Option cutTurns must be "continue" or "pass"')
  return { toolNames, reasoningReplay, instructionsAs, cutTurns }
}

// A CUT TURN. On this route Wonder sometimes ends a tool-using turn right after its opening sentence: the response is
// one message ("Opening that post now."), status completed, no function call, 0 reasoning tokens and a few dozen output
// tokens. A client that ends its turn on a text-only answer then stops before the act it announced. Sent again, the
// same request is almost never cut, and with the sentence appended as the assistant's message the model answers with
// exactly the call it announced. So, with `cutTurns: "continue"`, such a response is continued ONCE: the same request
// plus the sentence, and its answer is spliced in only when it is a bare, whole tool call (no text, no reasoning);
// otherwise the client gets the response exactly as Meta ended it. Each cut turn is one console.warn line.
const CUT_MAX_TOKENS = 100      // the measured cut sentences had 8 to 97 output tokens
const CUT_MAX_CHARS = 1000      // about 2.4 times the longest measured cut sentence
const CUT_CONTINUE_MS = 180000  // the continuation's whole request, after which the turn goes out as it ended

// The text of a response that is a cut turn, else null: completed, one message of output_text and nothing else but
// empty reasoning items, a usage that says 0 reasoning tokens and at most CUT_MAX_TOKENS output tokens.
export function cutTurnText(response) {
  if (!response || typeof response !== "object" || response.status !== "completed" || response.incomplete_details) return null
  const output = Array.isArray(response.output) ? response.output : []
  if (output.some(item => item?.type !== "message" && item?.type !== "reasoning")) return null
  const messages = output.filter(item => item?.type === "message")
  if (messages.length !== 1 || !Array.isArray(messages[0].content)) return null
  if (messages[0].content.some(part => part?.type !== "output_text" || typeof part.text !== "string")) return null
  const text = messages[0].content.map(part => part.text).join(""), usage = response.usage ?? {}
  if (!text.trim() || text.length > CUT_MAX_CHARS) return null
  if (!Number.isInteger(usage.output_tokens) || usage.output_tokens > CUT_MAX_TOKENS) return null
  return usage.output_tokens_details?.reasoning_tokens === 0 ? text : null
}

// The function calls of a continuation that is a bare, whole tool call, else a string saying why it is not: completed,
// 0 reasoning tokens, only function calls of offered tools (a message only if its text is empty, a reasoning item only
// empty), each with a call id, a name and arguments that make a JSON object.
export function bareToolCalls(response, offered) {
  if (!response || typeof response !== "object" || response.status !== "completed" || response.incomplete_details) return "it did not complete"
  const usage = response.usage ?? {}
  if (!Number.isInteger(usage.output_tokens) || usage.output_tokens_details?.reasoning_tokens !== 0) return "it reasoned or has no usage"
  const calls = []
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (item?.type === "function_call") {
      let args
      try { args = JSON.parse(item.arguments || "{}") } catch { return "its arguments are not JSON" }
      if (!args || typeof args !== "object" || Array.isArray(args)) return "its arguments are not a JSON object"
      if (typeof item.call_id !== "string" || !item.call_id || !offered.has(item.name)) return "it called no offered tool"
      calls.push(item)
    } else if (item?.type === "message") {
      if (!Array.isArray(item.content) || item.content.some(part => part?.type !== "output_text" || (part.text ?? "").trim())) return "it wrote text"
    } else if (item?.type !== "reasoning" || (item.summary ?? []).length || (item.content ?? []).length) return "it answered " + (item?.type ?? "nothing")
  }
  return calls.length ? calls : "it made no tool call"
}

// One response for the client: the cut response's output and the continuation's calls, the first request's input
// counts and both requests' output counts.
export function spliceCutTurn(cut, calls, continuation) {
  const a = cut.usage ?? {}, b = continuation.usage ?? {}, added = b.output_tokens ?? 0
  const usage = { ...a, output_tokens: a.output_tokens + added,
    ...(Number.isInteger(a.total_tokens) ? { total_tokens: a.total_tokens + added } : {}),
    output_tokens_details: { ...a.output_tokens_details, reasoning_tokens: 0 } }
  return { ...cut, output: [...cut.output, ...calls], usage }
}

export function prepareAPIRequest(input, options) {
  const { toolNames, reasoningReplay, instructionsAs } = validateAPIOptions(options)
  const body = normalizeRequest(input)
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a Responses request object")
  const names = new Map(), reverse = new Map(), declared = new Set()
  const register = name => {
    if (typeof name !== "string" || !name) throw new Error("Function tools require a name")
    const asDeclared = API_NAME.test(name) && !name.startsWith("client_") &&
      (toolNames === "native" || (toolNames === "reserved" && !RESERVED_TOOL_NAMES.has(name.toLowerCase())))
    const wire = asDeclared ? name : aliasName(name)
    names.set(name, wire); reverse.set(wire, name)
    return wire
  }
  const tools = (body.tools ?? []).map(tool => {
    if (tool.type !== "function") throw new Error("This bridge accepts client function tools. Connect MCP servers/resources/prompts in the client; hosted API tools are not implemented.")
    if (declared.has(tool.name)) throw new Error("Duplicate client tool name")
    declared.add(tool.name)
    const wire = register(tool.name)
    // An aliased tool names its client tool in the description; an unchanged tool is sent exactly as declared.
    return wire === tool.name ? { ...tool } : { ...tool, name: wire, description: `Client tool ${JSON.stringify(tool.name)}.${tool.description ? " " + tool.description : ""}` }
  })
  if (body.tool_choice != null && body.tool_choice !== "auto" && body.tool_choice !== "none") throw new Error("Meta supports automatic tool choice; required/named tool choice is not implemented")
  const history = Array.isArray(body.input) ? body.input.map(item => item?.type === "function_call" ? { ...item, name: names.get(item.name) ?? register(item.name) } : item) : body.input
  const { tool_choice: choice, ...rest } = body
  // No CLI system prompt is added. Instructions, roles, input contents, call ids
  // and tool results retain their API representation; only aliased names change.
  // `instructionsAs: "message"` sends the client's system text as the first message of the conversation, which is
  // where it sits when a chat-completions request reaches Meta's public API, and leaves `instructions` empty. A
  // request that continues a stored response keeps `instructions`: its earlier messages are already on the server.
  const asMessage = instructionsAs === "message" && body.previous_response_id == null && typeof body.instructions === "string" && body.instructions !== ""
  const items = !asMessage ? history : [{ role: "system", content: body.instructions }, ...(Array.isArray(history) ? history : history == null ? [] : [{ role: "user", content: history }])]
  const prepared = { ...rest, ...(asMessage ? { instructions: "" } : {}), store: body.store ?? false, input: items, ...(body.tools ? { tools: choice === "none" ? [] : tools } : {}) }
  // `reasoningReplay: "drop"` sends no earlier reasoning item: the model then reads only the messages, tool calls
  // and tool results of the conversation, as it does behind a client that returns no reasoning items.
  return { body: reasoningReplay === "drop" ? dropAllReasoningItems(prepared) : dropBareReasoningItems(prepared), names: reverse }
}

function responseNames(value, names) {
  if (!value || typeof value !== "object") return value
  const item = row => row?.type === "function_call" && names.has(row.name) ? { ...row, name: names.get(row.name) } : row
  return { ...value, ...(value.item ? { item: item(value.item) } : {}), ...(Array.isArray(value.output) ? { output: value.output.map(item) } : {}),
    ...(value.response ? { response: responseNames(value.response, names) } : {}) }
}

const eventData = raw => {
  const data = raw.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")
  if (!data || data === "[DONE]") return undefined
  try { return JSON.parse(data) } catch { return undefined }
}

// `continueTurn(text)`, when given, continues a cut turn (see cutTurnText): it resolves to the continuation's response
// object or rejects. `log` takes the one line each cut turn writes.
export function transformAPIResponse(response, names, onEvent = () => {}, continueTurn = null, log = line => console.warn(line)) {
  const headers = new Headers(response.headers)
  headers.delete("content-length"); headers.delete("content-encoding")
  if (!response.body || !response.ok) return response
  const offered = new Set(names.keys())
  // The calls to splice into the cut response `cut`, or null after logging why the turn goes out as it ended.
  const settle = async (cut, text, pending) => {
    const head = `magpie-muse: cut turn ${cut.id ?? "(no id)"} (${cut.usage?.output_tokens} output tokens: ${JSON.stringify(text.slice(0, 80))})`
    let result
    try { result = await pending } catch (error) { log(`${head} not continued: ${error?.message ?? error}`); return null }
    const calls = bareToolCalls(result, offered)
    if (typeof calls === "string") { log(`${head} not continued: the continuation ${calls}`); return null }
    log(`${head} continued: ${calls.map(call => names.get(call.name) ?? call.name).join(", ")}`)
    return { calls, result }
  }
  if (!(headers.get("content-type") ?? "").includes("text/event-stream")) {
    return response.json().then(async value => {
      onEvent(value)
      const text = continueTurn ? cutTurnText(value) : null
      const done = text == null ? null : await settle(value, text, continueTurn(text))
      return Response.json(responseNames(done ? spliceCutTurn(value, done.calls, done.result) : value, names), { status: response.status, headers })
    })
  }
  const decoder = new TextDecoder(), encoder = new TextEncoder()
  let buffer = "", held = null, cut = null, lastSequence = null
  const block = raw => {
    const lines = raw.split(/\r?\n/)
    const value = eventData(raw)
    if (value === undefined) return raw + "\n\n"
    onEvent(value)
    const first = lines.findIndex(line => line.startsWith("data:"))
    return lines.filter((line, i) => !line.startsWith("data:") || i === first).map((line, i) => line.startsWith("data:") ? "data: " + JSON.stringify(responseNames(value, names)) : line).join("\n") + "\n\n"
  }
  // A synthesized event, written as the upstream writes its events (with an `event:` line when the cut's had one).
  const render = (value, named) => { onEvent(value); return (named ? `event: ${value.type}\n` : "") + "data: " + JSON.stringify(responseNames(value, names)) + "\n\n" }
  // Every event goes out as it comes until a cut turn's response.completed: that event and whatever follows it are
  // held while the continuation runs, then go out after the spliced calls, or unchanged.
  const take = (controller, raw) => {
    if (held) { held.push(raw); return }
    const value = continueTurn ? eventData(raw) : undefined
    const text = value?.type === "response.completed" ? cutTurnText(value.response) : null
    if (text != null) {
      held = [raw]
      const pending = continueTurn(text)
      pending.catch(() => {})  // settled in flush; a client gone before then leaves no unhandled rejection
      cut = { value, text, pending }
      return
    }
    if (Number.isInteger(value?.sequence_number)) lastSequence = value.sequence_number
    controller.enqueue(encoder.encode(block(raw)))
  }
  const stream = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      let match
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        if (match.index > 16 * 1024 * 1024) throw new Error("Meta SSE event exceeds the bridge's 16 MiB limit")
        take(controller, buffer.slice(0, match.index))
        buffer = buffer.slice(match.index + match[0].length)
      }
      if (buffer.length > 16 * 1024 * 1024) throw new Error("Meta SSE event exceeds the bridge's 16 MiB limit")
    },
    async flush(controller) {
      buffer += decoder.decode(); if (buffer) take(controller, buffer)
      if (!held) return
      const done = await settle(cut.value.response, cut.text, cut.pending)
      if (!done) { for (const raw of held) controller.enqueue(encoder.encode(block(raw))); return }
      const named = /^event:/m.test(held[0]), base = cut.value.response.output.length
      let sequence = lastSequence
      const next = () => sequence == null ? {} : { sequence_number: ++sequence }
      const out = []
      done.calls.forEach((call, i) => {
        const output_index = base + i, args = call.arguments ?? ""
        out.push({ type: "response.output_item.added", ...next(), output_index, item: { ...call, arguments: "", status: "in_progress" } },
          { type: "response.function_call_arguments.delta", ...next(), output_index, item_id: call.id, delta: args },
          { type: "response.function_call_arguments.done", ...next(), output_index, item_id: call.id, arguments: args },
          { type: "response.output_item.done", ...next(), output_index, item: call })
      })
      out.push({ ...cut.value, ...next(), response: spliceCutTurn(cut.value.response, done.calls, done.result) })
      for (const value of out) controller.enqueue(encoder.encode(render(value, named)))
      for (const raw of held.slice(1)) controller.enqueue(encoder.encode(block(raw)))
    },
  }))
  return new Response(stream, { status: response.status, statusText: response.statusText, headers })
}

// A signal that aborts with the client's `signal` or after `ms`, on runtimes with and without AbortSignal.any.
function untilEither(signal, ms) {
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, AbortSignal.timeout(ms)])
  const controller = new AbortController(), stop = () => controller.abort(signal.reason)
  if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true })
  setTimeout(() => controller.abort(new DOMException("The continuation timed out", "TimeoutError")), ms).unref?.()
  return controller.signal
}

// The continuation's response object, from a JSON answer or, when Meta streams anyway, from its response.completed.
async function continuationResponse(response, onEvent) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`the continuation request answered ${response.status}`) }
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return response.json()
  let completed
  for (const raw of (await response.text()).split(/\r?\n\r?\n/)) {
    const value = eventData(raw)
    if (value === undefined) continue
    if (value.type === "response.subscription_usage") onEvent(value)
    if (value.type === "response.completed") completed = value.response
  }
  if (!completed) throw new Error("the continuation stream ended without response.completed")
  return completed
}

export function createAPITransport({ credential, renew, request = fetch, baseURL = META_API_BASE, localTestBackend = false, onEvent, toolNames, reasoningReplay, instructionsAs, cutTurns, log }) {
  baseURL = validateAPIBase(baseURL, localTestBackend)
  const requestOptions = validateAPIOptions({ toolNames, reasoningReplay, instructionsAs, cutTurns })
  const base = new URL(baseURL)
  const say = log ?? (line => console.warn(line))
  // The tool sets (their declared names) a subscription key refused under `toolNames: "reserved"`: sent aliased from then on.
  const refusedToolSets = new Set()
  const toolSet = value => Array.isArray(value?.tools) ? value.tools.map(tool => String(tool?.name)).sort().join("\n") : ""
  return async (input, init) => {
    const req = new Request(input, init), url = new URL(req.url)
    if (url.origin !== base.origin || url.pathname !== base.pathname.replace(/\/$/, "") + "/responses" || req.method !== "POST") return errorResponse(400, "Refusing a foreign inference destination")
    let prepared, raw, options = requestOptions
    try {
      raw = await req.json()
      if (options.toolNames === "reserved" && refusedToolSets.has(toolSet(raw))) options = { ...options, toolNames: "hashed" }
      prepared = prepareAPIRequest(raw, options)
    } catch (error) { return errorResponse(400, error.message) }
    req.signal.throwIfAborted()
    let auth, body = prepared.body
    try { auth = await credential() } catch (error) { req.signal.throwIfAborted(); return authFailure(error) }
    let renewed = auth.signIn === "renewed"
    const send = (payload = body, signal = req.signal) => {
      if (baseURL !== META_API_BASE && !auth.access?.startsWith("test-only")) throw new Error("Local test backends only accept dummy test-only credentials")
      const headers = new Headers({ authorization: "Bearer " + auth.access, "content-type": "application/json", accept: "text/event-stream, application/json", "x-api-version": "1.0.0", "user-agent": API_USER_AGENT })
      return request(baseURL.replace(/\/$/, "") + "/responses", { method: "POST", headers, body: JSON.stringify(payload), signal, redirect: "error" })
    }
    let response = await send()
    if (response.status === 401 && renew && auth.type === "oauth") {
      await response.body?.cancel()
      try { auth = await renew(auth.access) } catch (error) { req.signal.throwIfAborted(); return authFailure(error) }
      renewed = true; response = await send()
    }
    // A name the Muse Code client uses itself, declared as written, is refused on a subscription key. Under
    // "reserved" that should not happen; if it does, the same request goes again with every name aliased.
    if (response.status === 403 && options.toolNames === "reserved" && /client_attestation_denied/.test(await response.clone().text())) {
      await response.body?.cancel()
      refusedToolSets.add(toolSet(raw))
      say(`magpie-muse: a tool declared under its own name was refused (client_attestation_denied); this tool set is sent aliased from now on: ${toolSet(raw).split("\n").join(", ")}`)
      prepared = prepareAPIRequest(raw, { ...options, toolNames: "hashed" }); body = prepared.body
      response = await send()
    }
    // Bounded recovery for provider-owned reasoning references. Prompt messages,
    // function calls and actual client tool outputs are never dropped/replayed.
    for (let attempt = 0; attempt < 3 && response.status === 400; attempt++) {
      const text = await response.clone().text()
      let next = body
      if (/encrypted_content.*(?:caller|issued)/i.test(text)) next = stripReasoningEncryptedContent(body)
      else if (parseReferencedReasoningId(text)) next = dropAllReasoningItems(body)
      if (next === body) break
      await response.body?.cancel(); body = next; response = await send()
    }
    const headers = new Headers(response.headers)
    headers.set("X-Magpie-Sign-In", response.status === 401 ? "expired" : renewed ? "renewed" : "kept")
    const seen = value => onEvent?.(value, auth)
    // A cut turn is continued only where it can be: tools offered and allowed, a conversation sent whole (a request
    // continuing a stored response has its history on the server, which this continuation could not extend).
    const continuable = requestOptions.cutTurns === "continue" && response.ok && Array.isArray(body.tools) && body.tools.length > 0 && body.previous_response_id == null
    const continueTurn = !continuable ? null : async text => {
      const history = Array.isArray(body.input) ? body.input : body.input == null ? [] : [{ role: "user", content: body.input }]
      const payload = { ...body, stream: false, input: [...history, { role: "assistant", content: [{ type: "output_text", text }] }] }
      return continuationResponse(await send(payload, untilEither(req.signal, CUT_CONTINUE_MS)), seen)
    }
    return transformAPIResponse(new Response(response.body, { status: response.status, statusText: response.statusText, headers }), prepared.names, seen, continueTurn, say)
  }
}
