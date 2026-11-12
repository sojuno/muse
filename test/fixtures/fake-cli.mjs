import readline from "node:readline"
import fs from "node:fs"
import { randomUUID } from "node:crypto"
import { EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk"

const sessions = new Map(), running = new Map()
const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n")
const notify = (method, params) => send({ method, params })
const log = entry => { if (process.env.FAKE_CLI_LOG) fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify(entry) + "\n") }
const rpc = async (url, method, params = {}) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }) })
  const body = await res.json()
  if (body.error) throw new Error(body.error.message)
  return body.result
}
async function turn(sessionId, turnId, input) {
  const s = sessions.get(sessionId), state = { cancelled: false }
  running.set(turnId, state)
  const user = input.at(-1)?.text ?? ""
  try {
    if (user.includes("CRASH")) process.exit(7)
    if (user.includes("AUTH_REQUIRED")) {
      notify("turn/completed", { sessionId, turnId, terminal: "failed", error: { kind: "authRequired", message: "test signed out" } }); return
    }
    if (user.includes("SLOW")) await new Promise(r => setTimeout(r, 1000))
    let answer = `Echo: ${user}`
    if (user.includes("CALL_TOOL") || user.includes("PARALLEL")) {
      const chosen = user.includes("PARALLEL") ? s.tools : s.tools.slice(0, 1)
      const result = await Promise.all(chosen.map(t => rpc(s.url, "tools/call", { name: t.name, arguments: { path: "example.txt" } })))
      answer = result.map(r => r.content.map(c => c.text).join("")).join(" | ")
    }
    if (state.cancelled) return
    const itemId = randomUUID()
    notify("item/started", { sessionId, item: { itemId, turnId, kind: "agentMessage", text: "" } })
    notify("item/delta", { sessionId, itemId, field: "text", delta: answer })
    notify("item/completed", { sessionId, item: { itemId, turnId, kind: "agentMessage", text: answer } })
    notify("turn/completed", { sessionId, turnId, terminal: "completed", usage: { inputTokens: 12, outputTokens: 4, cachedTokens: 2 } })
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
      schema: { version: 1, fingerprint: EXPECTED_SCHEMA_FINGERPRINT },
      serverInfo: { name: "test-muse", version: "1.4.15" }, sessionDurability: "durable", museHome: "/tmp/fake-muse", platformFamily: "unix", platformOs: "linux",
    })
    if (method === "model/list") return result({ models: [{ modelId: "muse-spark-1.3", displayLabel: "Muse Spark", contextLimit: 1048576, outputLimit: 65536, variants: ["low", "high"] }] })
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
