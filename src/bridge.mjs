import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createHash, randomUUID } from "node:crypto"
import { MuseHost } from "./host.mjs"
import { ToolServer } from "./mcp.mjs"

const hash = s => createHash("sha256").update(s).digest("hex")
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const errorResponse = (status, message) => Response.json({ error: { type: "muse_cli_error", message } }, { status })
const textOf = content => typeof content === "string" ? content : Array.isArray(content) ? content.filter(p => p.type === "text").map(p => p.text).join("\n") : ""
const historyKey = messages => JSON.stringify(messages.map(m => ({ role: m.role, content: m.content ?? "", ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}), ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}) })))

class Events {
  values = []
  push(value) { this.values.push(value); this.wake?.(); this.wake = null }
  async next() {
    while (!this.values.length) await new Promise(resolve => { this.wake = resolve })
    return this.values.shift()
  }
}

function toolsOf(body) {
  const tools = new Map()
  for (const item of body.tools ?? []) {
    if (item.type !== "function" || !item.function?.name) throw new Error("Only function tools are supported by the Muse CLI bridge")
    const t = item.function
    const bridgeName = `tool_${hash(t.name).slice(0, 24)}`
    tools.set(bridgeName, { ...t, bridgeName, parameters: t.parameters ?? { type: "object", properties: {} } })
  }
  if (typeof body.tool_choice === "object") {
    const name = body.tool_choice?.function?.name
    for (const [key, t] of tools) if (t.name !== name) tools.delete(key)
    if (!tools.size) throw new Error("tool_choice names a tool that is not declared")
  }
  return tools
}

function workspaceOf(headers, options) {
  let dir = options.workspace
  const raw = headers.get("x-magpie-work-dir")
  if (raw) {
    try { dir = decodeURIComponent(raw) } catch { throw new Error("Invalid working directory encoding") }
  }
  if (!dir || !path.isAbsolute(dir)) throw new Error("No absolute project directory supplied. Set plugin option workspace, or send X-Magpie-Work-Dir.")
  const real = fs.realpathSync(dir)
  if (!fs.statSync(real).isDirectory()) throw new Error("Project directory does not exist on the Muse CLI machine")
  return real
}

function inputOf(messages, seed) {
  const last = messages.findLastIndex(m => m.role === "user")
  if (last < 0) throw new Error("No user message supplied")
  const parts = []
  if (seed) {
    const transcript = messages.slice(0, last).map(m => ({ role: m.role, content: m.content, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id }))
    if (transcript.length) parts.push({ type: "text", text: `Continue the following conversation. Preserve its system/developer instructions. Prior history (JSON):\n${JSON.stringify(transcript)}` })
  }
  const content = messages[last].content
  const text = textOf(content)
  if (text) parts.push({ type: "text", text })
  for (const part of Array.isArray(content) ? content : []) {
    if (part.type !== "image_url") continue
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(url ?? "")
    if (!match) throw new Error("Muse CLI bridge accepts inline data-URL images; remote image URLs are not fetched")
    parts.push({ type: "image", mediaType: match[1], base64Data: match[2] })
  }
  return parts.length ? parts : [{ type: "text", text: "(empty message)" }]
}

class Session {
  events = new Events()
  pending = new Map()
  items = new Map()
  streamed = new Map()
  constructor(bridge, key, tools, workspace) {
    Object.assign(this, { bridge, key, tools, workspace })
    this.route = bridge.server.register(this)
    this.lastUsed = Date.now()
  }
  async start(model) {
    // Trust is required for session MCP. Trust only an empty directory we own,
    // never the user's repository or its scripts/skills/settings.
    this.museWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-muse-session-"))
    const params = {
      workspaceRoot: this.museWorkspace, modelId: model,
      config: { mcpServers: { magpie_client: { transport: "streamableHttp", url: this.route.url, mode: "required" } } },
    }
    params.permissionProfile = ":ask-me"
    const result = await this.bridge.host.command("session/start", params)
    this.id = result.session?.sessionId
    if (!this.id) throw new Error("Muse CLI returned no session id")
    this.model = model
    this.generation = this.bridge.host.generation
  }
  async call(name, args) {
    const tool = this.tools.get(name)
    if (!tool || !this.active || this.toolChoice === "none") throw new Error("Tool is not permitted for this turn")
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be an object")
    const id = `call_${randomUUID().replaceAll("-", "")}`
    let resolve
    const promise = new Promise(r => { resolve = r })
    const timer = setTimeout(() => {
      this.cancel("Timed out waiting for the client tool result")
    }, this.bridge.options.toolTimeoutMs ?? 300000)
    timer.unref?.()
    this.pending.set(id, { resolve, timer, name: tool.name, args })
    this.events.push({ type: "tool", id, name: tool.name, arguments: JSON.stringify(args) })
    return promise
  }
  deliver(messages) {
    const results = messages.filter(m => m.role === "tool")
    const current = results.filter(m => this.pending.has(m.tool_call_id))
    if (!current.length) throw new Error("No matching pending Muse tool call. The CLI process may have restarted; retry from the user turn.")
    if ([...(this.awaitingIds ?? [])].some(id => !current.some(m => m.tool_call_id === id))) throw new Error("Return results for all tool calls from the previous response together")
    for (const m of current) {
      const pending = this.pending.get(m.tool_call_id)
      clearTimeout(pending.timer)
      this.pending.delete(m.tool_call_id)
      pending.resolve({ content: [{ type: "text", text: textOf(m.content) }], ...(m.is_error ? { isError: true } : {}) })
    }
    this.awaitingIds = null
  }
  async begin(body, messages, seed) {
    this.active = true
    this.cancelled = false
    this.decisions = new Set()
    this.turnId = undefined
    this.admitting = true
    this.earlyNotifications = []
    this.toolChoice = body.tool_choice
    this.items.clear(); this.streamed.clear()
    this.history = messages
    const input = inputOf(messages, seed)
    const instruction = `The client's project directory is ${JSON.stringify(this.workspace)}. Your own workspace is an empty bridge directory, not the project. Host shell/write restrictions apply to your internal directory; client MCP tools are independently authorized and executed by the client, including its edit and shell tools when offered. Use the magpie_client MCP tools for all client operations and paths. Do not use native file, shell or other tools. Return tool results only after receiving them; do not invent results.`
    input.unshift({ type: "text", text: instruction })
    if (body.tool_choice === "none") input.unshift({ type: "text", text: "For this reply, use no tools. Answer directly." })
    if (body.tool_choice === "required" || typeof body.tool_choice === "object") input.unshift({ type: "text", text: "For this reply, you must call an offered client tool." })
    this.unsubscribe = this.bridge.host.subscribe(n => this.onNotification(n))
    this.turnTimer = setTimeout(() => this.cancel("Muse turn timed out"), this.bridge.options.turnTimeoutMs ?? 600000)
    this.turnTimer.unref?.()
    try {
      this.admission = this.bridge.host.command("turn/start", {
        sessionId: this.id, input, ifBusy: "queue",
        ...(body.reasoning_effort ? { reasoningEffort: body.reasoning_effort } : {}),
      })
      const ack = await this.admission
      this.turnId = ack.turnId
      this.admitting = false
      for (const n of this.earlyNotifications) this.onNotification(n)
      this.earlyNotifications = []
      if (this.cancelled) void this.bridge.host.command("turn/cancel", { sessionId: this.id, turnId: this.turnId }).catch(() => {})
    } catch (e) { this.finish({ error: e.message }) }
  }
  onNotification(n) {
    const p = n.params ?? {}
    if (n.method === "bridge/hostExited") return this.finish({ error: "Muse CLI exited. Retry from the last user turn; pending tools were cancelled." })
    if (p.sessionId !== this.id) return
    // The SDK routes notifications synchronously. A host can put its ack and
    // first deltas/completion in the same pipe read, before await resumes.
    if (this.admitting) { this.earlyNotifications.push(n); return }
    if (p.turnId && this.turnId && p.turnId !== this.turnId) return
    if (n.method === "approval/requested" || n.method === "approval/updated") {
      // Only the bridge MCP is trusted. Native tool approvals are denied; the
      // host is also started with the empty preset and shell/writes disabled.
      const ours = /^(mcp__magpie_client[._/]|magpie_client\/)/.test(String(p.toolName ?? p.subject?.toolName ?? ""))
      const choices = p.availableChoices ?? []
      const choice = ours ? choices.find(c => c.decision === "approved" && c.scope === "once") : choices.find(c => c.decision === "denied" || c.decision === "abort")
      const stage = `${p.approvalId}/${p.currentRequirementId?.sourceIndex ?? 0}`
      if (choice && !this.decisions.has(stage)) {
        this.decisions.add(stage)
        void this.bridge.host.command("approval/decide", {
        sessionId: this.id, approvalId: p.approvalId,
        requirementId: p.currentRequirementId ?? { approvalId: p.approvalId, sourceIndex: 0 }, choiceId: choice.choiceId,
      }).catch(() => this.cancel("Could not answer Muse tool approval"))
      }
      return
    }
    if (n.method === "session/tokenUsage" && p.usage) {
      this.usage ??= { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 }
      for (const k of Object.keys(this.usage)) this.usage[k] += Number(p.usage[k]) || 0
    }
    if (n.method.startsWith("item/") && p.item) {
      const item = p.item
      if (this.turnId && item.turnId !== this.turnId) return
      this.items.set(item.itemId, item)
      if (item.kind === "agentMessage") this.full(item.itemId, "text", item.text, "text")
      if (item.kind === "reasoning" && n.method === "item/completed") {
        for (const [i, text] of (item.summary ?? []).entries()) this.full(item.itemId, `summary.${i}`, text, "reasoning")
      }
    }
    if (n.method === "item/delta") {
      const item = this.items.get(p.itemId)
      if (!item) return
      const type = item.kind === "agentMessage" && p.field === "text" ? "text" : item.kind === "reasoning" && p.field?.startsWith("summary.") ? "reasoning" : null
      if (type) {
        const key = `${p.itemId}/${p.field}`
        this.streamed.set(key, (this.streamed.get(key) ?? "") + p.delta)
        this.events.push({ type, text: p.delta })
      }
    }
    if (n.method === "turn/completed") this.finish({
      usage: p.usage ?? this.usage,
      status: p.error?.kind === "authRequired" ? 401 : p.error && (p.error.quota != null || /quota|rate.?limit/i.test(p.error.kind ?? "")) ? 429 : 502,
      error: p.error ? (p.error.kind === "authRequired" ? "Muse is not signed in. Run muse login in a terminal." : p.error.message ?? "Muse turn failed") : p.terminal === "failed" ? (p.reason ?? "Muse turn failed") : undefined,
    })
  }
  full(id, field, full, type) {
    if (!full) return
    const key = `${id}/${field}`, seen = this.streamed.get(key) ?? ""
    if (full.startsWith(seen) && full.length > seen.length) {
      this.streamed.set(key, full)
      this.events.push({ type, text: full.slice(seen.length) })
    }
  }
  finish(event = {}) {
    if (!this.active) return
    this.active = false
    clearTimeout(this.turnTimer)
    this.unsubscribe?.()
    for (const p of this.pending.values()) {
      clearTimeout(p.timer); p.resolve({ isError: true, content: [{ type: "text", text: event.error ?? "Muse turn ended" }] })
    }
    this.pending.clear()
    this.events.push({ type: "done", ...event })
  }
  cancel(message = "Request cancelled") {
    this.cancelled = true
    const cancelling = this.active && this.turnId ? this.bridge.host.command("turn/cancel", { sessionId: this.id, turnId: this.turnId }).catch(() => {}) : Promise.resolve()
    this.finish({ error: message, status: 499 })
    return cancelling
  }
  async close() {
    await this.admission?.catch(() => {})
    await this.cancel()
    this.route.remove()
    if (this.id && this.bridge.host.running && this.generation === this.bridge.host.generation) {
      await this.bridge.host.command("session/leave", { sessionId: this.id, stop: true }).catch(() => {})
    }
    if (this.museWorkspace) fs.rmSync(this.museWorkspace, { recursive: true, force: true })
  }
}

export class MuseBridge {
  sessions = new Map()
  constructor(options = {}) { this.options = options; this.host = new MuseHost(options) }
  async start() {
    this.starting ??= new ToolServer().start().then(server => { this.server = server }).catch(e => { this.starting = null; throw e })
    await this.starting
    return this
  }
  async models() {
    const r = await this.host.request("model/list")
    return (r.models ?? []).map(m => ({ id: m.modelId, name: m.displayLabel ?? m.modelId, context: m.contextLimit ?? 1048576, output: m.outputLimit ?? 65536, efforts: m.variants ?? [], cost: m.cost }))
  }
  async fetch(input, init) {
    let request, body
    try {
      request = new Request(input, init)
      const url = new URL(request.url)
      if (url.origin !== "http://muse-cli.invalid" || url.pathname !== "/v1/chat/completions" || request.method !== "POST") return errorResponse(400, "Unsupported Muse CLI request destination")
      request.signal.throwIfAborted()
      body = await request.json()
      if (!Array.isArray(body.messages) || typeof body.model !== "string") return errorResponse(400, "model and messages are required")
      const unsupported = ["response_format", "audio", "prediction"].find(k => body[k] != null)
      if (unsupported) return errorResponse(400, `${unsupported} is not supported by the Muse CLI bridge`)
      await this.start()
      const tools = toolsOf(body)
      const workspace = workspaceOf(request.headers, this.options)
      const identity = request.headers.get("x-magpie-session") || request.headers.get("x-muse-cli-session")
      const subagent = request.headers.get("x-magpie-subagent") ?? ""
      const pending = [...this.sessions.values()].find(s => body.messages.some(m => m.role === "tool" && s.pending.has(m.tool_call_id)))
      if (!pending && body.messages.at(-1)?.role === "tool") return errorResponse(409, "No matching pending Muse tool call. Retry from the last user turn after a CLI restart.")
      if (pending && (pending.workspace !== workspace || pending.identity !== identity || pending.subagent !== subagent)) return errorResponse(400, "Tool result belongs to another conversation or workspace")
      const key = hash(JSON.stringify([identity || body.messages.find(m => m.role === "user"), subagent, workspace]))
      let session = pending ?? this.sessions.get(key)
      if (session?.busy) return errorResponse(409, "Another request is already reading this Muse session")
      if (session?.active && !pending) return errorResponse(409, "Muse is waiting for client tool results; do not resend the user turn")
      const signature = hash(JSON.stringify([...tools.values()]))
      if (pending && signature !== pending.signature) return errorResponse(409, "Tool definitions changed while Muse is waiting for their results; finish the pending turn with the original tool definitions")
      const sys = hash(JSON.stringify(body.messages.filter(m => m.role === "system" || m.role === "developer")))
      if (!pending && session && (session.generation !== this.host.generation || session.model !== body.model || session.signature !== signature || session.system !== sys || !session.completedHistory || historyKey(body.messages.slice(0, session.completedHistory.length)) !== historyKey(session.completedHistory))) {
        await session.close(); this.sessions.delete(key); session = null
      }
      if (!session) {
        // Bound live resources; never evict a session waiting for a tool result.
        for (const [k, s] of this.sessions) if (!s.active && Date.now() - s.lastUsed > 30 * 60 * 1000) { await s.close(); this.sessions.delete(k) }
        if (this.sessions.size >= (this.options.maxSessions ?? 32)) {
          const oldest = [...this.sessions.entries()].filter(([, s]) => !s.active && !s.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]
          if (oldest) { await oldest[1].close(); this.sessions.delete(oldest[0]) }
        }
        if (this.sessions.size >= (this.options.maxSessions ?? 32)) return errorResponse(503, "Muse session limit reached; finish existing conversations first")
        session = new Session(this, key, tools, workspace)
        Object.assign(session, { identity, subagent, signature, system: sys })
        session.busy = true
        this.sessions.set(key, session)
        try { await session.start(body.model) } catch (e) { await session.close(); this.sessions.delete(key); throw e }
      }
      session.busy = true; session.lastUsed = Date.now()
      const effort = body.reasoning_effort ?? request.headers.get("x-magpie-effort")
      const abort = () => session.cancel()
      request.signal.addEventListener("abort", abort, { once: true })
      const done = () => { session.busy = false; request.signal.removeEventListener("abort", abort) }
      try {
        request.signal.throwIfAborted()
        if (pending) { session.toolChoice = body.tool_choice; session.deliver(body.messages) }
        else {
          session.events = new Events(); session.usage = null
          void session.begin({ ...body, reasoning_effort: effort }, body.messages, !session.completedHistory).catch(e => session.finish({ error: e.message }))
        }
        return await this.response(session, body, request.signal, done)
      } catch (e) { done(); throw e }
    } catch (e) { return errorResponse(e.name === "AbortError" ? 499 : /not found|grant|handshake|pinned/.test(e.message) ? 503 : 400, e.message) }
  }
  async response(session, body, signal, release) {
    const id = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    let content = "", reasoning = "", calls = []
    const usageOf = u => u ? { prompt_tokens: u.inputTokens ?? 0, completion_tokens: u.outputTokens ?? 0, total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0), prompt_tokens_details: { cached_tokens: u.cachedTokens ?? 0 }, completion_tokens_details: { reasoning_tokens: u.reasoningTokens ?? 0 } } : undefined
    const next = async () => {
      let event = await session.events.next()
      if (event.type === "tool") {
        // Batch MCP calls that arrived together, including parallel calls.
        await pause(5)
        const tools = [event]
        while (session.events.values[0]?.type === "tool") tools.push(session.events.values.shift())
        event = { type: "tools", tools }
      }
      if (event.type === "text") content += event.text
      if (event.type === "reasoning") reasoning += event.text
      if (event.type === "tools") {
        calls = event.tools.map((t, index) => ({ index, id: t.id, type: "function", function: { name: t.name, arguments: t.arguments } }))
        session.awaitingIds = new Set(calls.map(t => t.id))
      }
      if (event.type === "done" && !event.error) session.completedHistory = [...body.messages, { role: "assistant", content }]
      return event
    }
    // Preserve immediate authentication/quota failures as HTTP statuses instead
    // of committing HTTP 200 before the CLI has produced any output.
    let first
    try {
      first = await next()
      if (first.type === "done" && first.error) { release(); return errorResponse(first.status ?? 502, first.error) }
    } catch (e) { release(); throw e }
    const take = async () => { if (first) { const e = first; first = null; return e } return next() }
    if (!body.stream) {
      try {
        while (true) {
          const e = await take()
          if (e.type === "done" && e.error) return errorResponse(e.status ?? 502, e.error)
          if (e.type === "tools" || e.type === "done") return Response.json({ id, object: "chat.completion", created, model: body.model, choices: [{ index: 0, message: { role: "assistant", content, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls.map(({ index, ...c }) => c) } : {}) }, finish_reason: calls.length ? "tool_calls" : "stop" }], usage: usageOf(e.usage) })
        }
      } finally { release() }
    }
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start: async controller => {
        const emit = data => controller.enqueue(encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`))
        const chunk = (delta, finish_reason = null) => ({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta, finish_reason }] })
        try {
          emit(chunk({ role: "assistant", content: "" }))
          while (!signal.aborted) {
            const e = await take()
            if (e.type === "text") emit(chunk({ content: e.text }))
            if (e.type === "reasoning") emit(chunk({ reasoning_content: e.text }))
            if (e.type === "tools") { emit(chunk({ tool_calls: calls })); emit(chunk({}, "tool_calls")); break }
            if (e.type === "done") {
              if (e.error) emit({ error: { type: "muse_cli_error", message: e.error } })
              else { emit(chunk({}, "stop")); if (e.usage) emit({ id, object: "chat.completion.chunk", created, model: body.model, choices: [], usage: usageOf(e.usage) }) }
              break
            }
          }
          emit("[DONE]"); controller.close()
        } catch { session.cancel("Client stream closed") }
        finally { release() }
      },
      cancel() { session.cancel("Client stream cancelled"); release() },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  }
  async close() {
    await Promise.all([...this.sessions.values()].map(s => s.close()))
    this.sessions.clear()
    await this.host.close()
    await this.server?.close()
  }
}
