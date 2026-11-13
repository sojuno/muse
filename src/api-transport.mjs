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
const wireName = name => "client_" + createHash("sha256").update(name).digest("hex").slice(0, 40)

export function prepareAPIRequest(input) {
  const body = normalizeRequest(input)
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a Responses request object")
  const names = new Map(), reverse = new Map(), declared = new Set()
  const register = name => {
    if (typeof name !== "string" || !name) throw new Error("Function tools require a name")
    const wire = wireName(name)
    names.set(name, wire); reverse.set(wire, name)
    return wire
  }
  const tools = (body.tools ?? []).map(tool => {
    if (tool.type !== "function") throw new Error("This bridge accepts client function tools. Connect MCP servers/resources/prompts in the client; hosted API tools are not implemented.")
    if (declared.has(tool.name)) throw new Error("Duplicate client tool name")
    declared.add(tool.name)
    return { ...tool, name: register(tool.name), description: `Client tool ${JSON.stringify(tool.name)}.${tool.description ? " " + tool.description : ""}` }
  })
  if (body.tool_choice != null && body.tool_choice !== "auto" && body.tool_choice !== "none") throw new Error("Meta supports automatic tool choice; required/named tool choice is not implemented")
  const history = Array.isArray(body.input) ? body.input.map(item => item?.type === "function_call" ? { ...item, name: names.get(item.name) ?? register(item.name) } : item) : body.input
  const { tool_choice: choice, ...rest } = body
  // No CLI system prompt is added. Instructions, roles, input contents, call ids
  // and tool results retain their API representation; only wire names change.
  return { body: dropBareReasoningItems({ ...rest, store: body.store ?? false, input: history, ...(body.tools ? { tools: choice === "none" ? [] : tools } : {}) }), names: reverse }
}

function responseNames(value, names) {
  if (!value || typeof value !== "object") return value
  const item = row => row?.type === "function_call" && names.has(row.name) ? { ...row, name: names.get(row.name) } : row
  return { ...value, ...(value.item ? { item: item(value.item) } : {}), ...(Array.isArray(value.output) ? { output: value.output.map(item) } : {}),
    ...(value.response ? { response: responseNames(value.response, names) } : {}) }
}

export function transformAPIResponse(response, names, onEvent = () => {}) {
  const headers = new Headers(response.headers)
  headers.delete("content-length"); headers.delete("content-encoding")
  if (!response.body || !response.ok) return response
  if (!(headers.get("content-type") ?? "").includes("text/event-stream")) {
    return response.json().then(value => { onEvent(value); return Response.json(responseNames(value, names), { status: response.status, headers }) })
  }
  const decoder = new TextDecoder(), encoder = new TextEncoder()
  let buffer = ""
  const block = raw => {
    const lines = raw.split(/\r?\n/)
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")
    if (!data || data === "[DONE]") return raw + "\n\n"
    let value
    try { value = JSON.parse(data) } catch { return raw + "\n\n" }
    onEvent(value)
    const first = lines.findIndex(line => line.startsWith("data:"))
    return lines.filter((line, i) => !line.startsWith("data:") || i === first).map((line, i) => line.startsWith("data:") ? "data: " + JSON.stringify(responseNames(value, names)) : line).join("\n") + "\n\n"
  }
  const stream = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      let match
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        if (match.index > 16 * 1024 * 1024) throw new Error("Meta SSE event exceeds the bridge's 16 MiB limit")
        controller.enqueue(encoder.encode(block(buffer.slice(0, match.index))))
        buffer = buffer.slice(match.index + match[0].length)
      }
      if (buffer.length > 16 * 1024 * 1024) throw new Error("Meta SSE event exceeds the bridge's 16 MiB limit")
    },
    flush(controller) { buffer += decoder.decode(); if (buffer) controller.enqueue(encoder.encode(block(buffer))) },
  }))
  return new Response(stream, { status: response.status, statusText: response.statusText, headers })
}

export function createAPITransport({ credential, renew, request = fetch, baseURL = META_API_BASE, localTestBackend = false, onEvent }) {
  baseURL = validateAPIBase(baseURL, localTestBackend)
  const base = new URL(baseURL)
  return async (input, init) => {
    const req = new Request(input, init), url = new URL(req.url)
    if (url.origin !== base.origin || url.pathname !== base.pathname.replace(/\/$/, "") + "/responses" || req.method !== "POST") return errorResponse(400, "Refusing a foreign inference destination")
    let prepared
    try { prepared = prepareAPIRequest(await req.json()) } catch (error) { return errorResponse(400, error.message) }
    req.signal.throwIfAborted()
    let auth, body = prepared.body
    try { auth = await credential() } catch (error) { req.signal.throwIfAborted(); return authFailure(error) }
    let renewed = auth.signIn === "renewed"
    const send = () => {
      if (baseURL !== META_API_BASE && !auth.access?.startsWith("test-only")) throw new Error("Local test backends only accept dummy test-only credentials")
      const headers = new Headers({ authorization: "Bearer " + auth.access, "content-type": "application/json", accept: "text/event-stream, application/json", "x-api-version": "1.0.0", "user-agent": API_USER_AGENT })
      return request(baseURL.replace(/\/$/, "") + "/responses", { method: "POST", headers, body: JSON.stringify(body), signal: req.signal, redirect: "error" })
    }
    let response = await send()
    if (response.status === 401 && renew && auth.type === "oauth") {
      await response.body?.cancel()
      try { auth = await renew(auth.access) } catch (error) { req.signal.throwIfAborted(); return authFailure(error) }
      renewed = true; response = await send()
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
    return transformAPIResponse(new Response(response.body, { status: response.status, statusText: response.statusText, headers }), prepared.names, value => onEvent?.(value, auth))
  }
}
