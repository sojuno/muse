import readline from "node:readline"
import fs from "node:fs"
import { randomUUID } from "node:crypto"
import { EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk"

const sessions = new Map(), running = new Map()
const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n")
const notify = (method, params) => send({ method, params })
const log = entry => { if (process.env.FAKE_CLI_LOG) fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify(entry) + "\n") }
if (process.argv.includes("mcp") && process.argv.includes("list")) {
  await new Promise(resolve => process.stdout.write(JSON.stringify({ servers: JSON.parse(process.env.FAKE_GATEWAY_MCP ?? "[]") }) + "\n", resolve))
  process.exit(0)
}
log({ method: "test/launch", params: { args: process.argv.slice(2) } })
const rpc = async (url, method, params = {}) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }) })
  const body = await res.json()
  if (body.error) throw new Error(body.error.message)
  return body.result
}
async function turn(sessionId, turnId, input) {
  const s = sessions.get(sessionId), state = { cancelled: false }
  running.set(turnId, state)
  const user = input.findLast(p => p.type === "text")?.text ?? ""
  let completions = 0
  const tokenSplit = { inputTokens: 10, outputTokens: 4, cachedTokens: 9, cacheReadTokens: 6, cacheWriteTokens: 3, reasoningTokens: 2 }
  const reportUsage = () => {
    if (!user.includes("TOKEN_SPLITS")) return
    completions++
    notify("session/tokenUsage", { sessionId, turnId, usage: tokenSplit, promptTokens: 19, totalTokens: 23,
      viewCursor: `usage-${completions}`, cumulative: { promptTokens: completions * 19, outputTokens: completions * 4, totalTokens: completions * 23 } })
    if (user.includes("DUPLICATE_USAGE")) notify("session/tokenUsage", { sessionId, turnId, usage: tokenSplit, promptTokens: 19, totalTokens: 23, viewCursor: `usage-${completions}` })
  }
  try {
    if (user.includes("CRASH")) process.exit(7)
    if (user.includes("AUTH_REQUIRED")) {
      notify("turn/completed", { sessionId, turnId, terminal: "failed", error: { kind: "authRequired", message: "test signed out" } }); return
    }
    if (user.includes("RATE_LIMIT")) {
      notify("turn/completed", { sessionId, turnId, terminal: "failed", error: { kind: "quotaExceeded", quota: {}, message: "Test subscription limit reached" } }); return
    }
    if (user.includes("SLOW")) await new Promise(r => setTimeout(r, 1000))
    if (user.includes("ASK_NATIVE")) for (const toolName of ["bash", `mcp__magpie_client_evil__${s.tools[0]?.name ?? "tool_fake"}`]) {
      const approvalId = randomUUID()
      notify("approval/requested", { sessionId, turnId, approvalId, toolName, currentRequirementId: { approvalId, sourceIndex: 0 }, availableChoices: [
        { choiceId: "allow-once", decision: "approved", scope: "once" }, { choiceId: "deny", decision: "denied", scope: "once" },
      ] })
    }
    let answer = `Echo: ${user}`
    if (user.includes("CALL_TOOL") || user.includes("PARALLEL")) {
      const chosen = user.includes("PARALLEL") ? s.tools : s.tools.slice(0, 1)
      const all = []
      for (let step = 0; step < (user.includes("TWICE") ? 2 : 1); step++) {
        reportUsage()
        const result = await Promise.all(chosen.map(t => rpc(s.url, "tools/call", { name: t.name, arguments: { path: "example.txt" } })))
        log({ method: "test/tool-result", params: result })
        all.push(...result)
      }
      answer = all.map(r => r.content.map(c => c.text).join("")).join(" | ")
    }
    if (state.cancelled) return
    if (user.includes("EVENT_GAP")) { notify("view/gap", { sessionId, turnId }); return }
    const itemId = randomUUID()
    if (user.includes("REASON")) {
      const reasonId = randomUUID()
      notify("item/started", { sessionId, item: { itemId: reasonId, turnId, kind: "reasoning", summary: [] } })
      notify("item/delta", { sessionId, itemId: reasonId, field: "summary.0", delta: "Thinking " })
      notify("item/completed", { sessionId, item: { itemId: reasonId, turnId, kind: "reasoning", summary: ["Thinking carefully."] } })
    }
    notify("item/started", { sessionId, item: { itemId, turnId, kind: "agentMessage", text: "" } })
    if (!user.includes("COMPLETE_ONLY")) notify("item/delta", { sessionId, itemId, field: "text", delta: answer })
    notify("item/completed", { sessionId, item: { itemId, turnId, kind: "agentMessage", text: user.includes("TEXT_CHANGED") ? "Different completed answer" : answer, ...(user.includes("TRUNCATED") ? { truncated: true } : {}) } })
    reportUsage()
    const usage = user.includes("TOKEN_SPLITS") ? Object.fromEntries(Object.entries(tokenSplit).map(([key, value]) => [key, value * completions])) : { inputTokens: 12, outputTokens: 4, cachedTokens: 2 }
    notify("turn/completed", { sessionId, turnId, terminal: "completed", ...(user.includes("USAGE_EVENTS_ONLY") ? {} : { usage }) })
  } catch (e) { notify("turn/completed", { sessionId, turnId, terminal: "failed", error: { message: e.message } }) }
  finally { running.delete(turnId) }
}

const lines = readline.createInterface({ input: process.stdin })
lines.on("close", () => process.exit(0))
lines.on("line", async line => {
  const { id, method, params = {} } = JSON.parse(line)
  if (id === undefined) return
  log({ method, params })
  const result = value => send({ id, result: value })
  try {
    if (method === "initialize") return result({
      experimentalApi: false, grantedCapabilities: process.env.FAKE_NO_MCP ? [] : ["sessionMcp"],
      schema: { version: Number(process.env.FAKE_SCHEMA_VERSION ?? 1), fingerprint: process.env.FAKE_FINGERPRINT ?? EXPECTED_SCHEMA_FINGERPRINT },
      serverInfo: { name: "test-muse", version: process.env.FAKE_CLI_VERSION ?? "1.4.15" }, sessionDurability: "durable", museHome: "/tmp/fake-muse", platformFamily: "unix", platformOs: "linux",
    })
    if (method === "model/list") return result({ models: (JSON.parse(process.env.FAKE_MODELS ?? '["muse-spark-1.3"]')).map(row => ({ contextLimit: 1048576, outputLimit: 65536, variants: ["low", "high"], ...(typeof row === "string" ? { modelId: row, displayLabel: row } : row) })) })
    if (method === "session/start") {
      const sessionId = randomUUID(), url = params.config.mcpServers.magpie_client.url
      await rpc(url, "initialize", { protocolVersion: "2025-03-26" })
      const { tools } = await rpc(url, "tools/list")
      sessions.set(sessionId, { url, tools })
      return result({ session: { sessionId }, viewCursor: "test" })
    }
    if (method === "turn/start") {
      const turnId = params.commandId
      result({ commandId: params.commandId, turnId, status: "accepted", disposition: "started" })
      void turn(params.sessionId, turnId, params.input)
      return
    }
    if (method === "turn/cancel") {
      const state = running.get(params.turnId); if (state) state.cancelled = true
      result({ commandId: params.commandId, status: "accepted" })
      notify("turn/completed", { sessionId: params.sessionId, turnId: params.turnId, terminal: "cancelled" })
      return
    }
    result({ commandId: params.commandId, status: "accepted" })
  } catch (e) { send({ id, error: { code: -32603, message: e.message } }) }
})
