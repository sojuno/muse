import nodeTest from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { MuseBridge } from "../src/bridge.mjs"
import { MuseCLIPlugin } from "../plugin.mjs"

const fake = fileURLToPath(new URL("./fixtures/fake-cli.mjs", import.meta.url))
const test = (name, run) => nodeTest(name, { timeout: 10000 }, run)
const tools = [{ type: "function", function: { name: "fs/read.file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }]
async function setup(t, extra = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "muse-bridge-test-"))
  const log = path.join(workspace, "requests.jsonl")
  const options = { workspace, museBin: process.execPath, museArgs: [fake], museEnv: { FAKE_CLI_LOG: log }, ...extra }
  const bridge = new MuseBridge(options)
  t.after(async () => { await bridge.close(); fs.rmSync(workspace, { recursive: true, force: true }) })
  return { bridge, options, requests: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [] }
}
const user = content => [{ role: "user", content }]
const chat = (b, messages, rest = {}, headers = {}, signal) => b.fetch("http://muse-cli.invalid/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-magpie-session": "session-1", ...headers }, signal, body: JSON.stringify({ model: "muse-spark-1.3", messages, ...rest }) })
const decode = async res => {
  const chunks = (await res.text()).split("\n\n").filter(s => s.startsWith("data: ") && !s.includes("[DONE]")).map(s => JSON.parse(s.slice(6)))
  return { chunks, text: chunks.flatMap(c => c.choices ?? []).map(c => c.delta.content ?? "").join(""), calls: chunks.flatMap(c => c.choices ?? []).flatMap(c => c.delta.tool_calls ?? []) }
}

test("plugin registers muse-cli, links the CLI without saving Meta credentials", async t => {
  const { options } = await setup(t)
  const hooks = await MuseCLIPlugin({ directory: "/wrong-magpie-config" }, options)
  t.after(() => hooks.dispose())
  const cfg = {}; await hooks.config(cfg)
  assert.equal(hooks.auth.provider, "muse-cli")
  assert.equal(cfg.provider["muse-cli"].npm, "@ai-sdk/openai-compatible")
  const link = await hooks.auth.methods[0].authorize()
  assert.equal((await link.callback()).key, "local-muse-cli")
  const models = await hooks.provider.models({ models: {} })
  assert.ok(models["muse-spark-1.3"].capabilities.toolcall)
})

test("real MSP child completes a text turn and keeps the same session", async t => {
  const { bridge, requests } = await setup(t)
  let messages = user("hello")
  let res = await chat(bridge, messages), body = await res.json()
  assert.equal(res.status, 200); assert.equal(body.choices[0].message.content, "Echo: hello")
  messages.push(body.choices[0].message, { role: "user", content: "again" })
  body = await (await chat(bridge, messages)).json()
  assert.equal(body.choices[0].message.content, "Echo: again")
  assert.equal(requests().filter(r => r.method === "session/start").length, 1)
  const start = requests().find(r => r.method === "session/start")
  assert.notEqual(start.params.workspaceRoot, bridge.options.workspace)
  assert.deepEqual(fs.readdirSync(start.params.workspaceRoot), [])
  assert.equal(start.params.permissionProfile, ":ask-me")
})

test("streams content and usage as Chat Completions SSE", async t => {
  const { bridge } = await setup(t)
  const res = await chat(bridge, user("hello"), { stream: true })
  assert.match(res.headers.get("content-type"), /event-stream/)
  const output = await decode(res)
  assert.equal(output.text, "Echo: hello")
  assert.equal(output.chunks.at(-1).usage.prompt_tokens, 12)
})

for (const stream of [false, true]) test(`MCP tool -> client -> result -> same Muse turn (stream=${stream})`, async t => {
  const { bridge, requests } = await setup(t)
  const messages = user("CALL_TOOL")
  const res = await chat(bridge, messages, { tools, stream })
  const body = stream ? await decode(res) : await res.json()
  const call = stream ? body.calls[0] : body.choices[0].message.tool_calls[0]
  assert.equal(call.function.name, "fs/read.file")
  assert.deepEqual(JSON.parse(call.function.arguments), { path: "example.txt" })
  messages.push({ role: "assistant", content: "", tool_calls: [{ id: call.id, type: "function", function: call.function }] }, { role: "tool", tool_call_id: call.id, content: "CLIENT-RESULT" })
  const result = await chat(bridge, messages, { tools })
  assert.equal((await result.json()).choices[0].message.content, "CLIENT-RESULT")
  assert.equal(requests().filter(r => r.method === "turn/start").length, 1)
})

test("parallel client tool calls accept a batch of results", async t => {
  const { bridge } = await setup(t)
  const two = [...tools, { type: "function", function: { name: "read_other", parameters: { type: "object" } } }]
  const messages = user("PARALLEL")
  const first = await (await chat(bridge, messages, { tools: two })).json()
  const calls = first.choices[0].message.tool_calls
  assert.equal(calls.length, 2)
  messages.push(first.choices[0].message, ...calls.map((c, i) => ({ role: "tool", tool_call_id: c.id, content: `result-${i}` })))
  const last = await (await chat(bridge, messages, { tools: two })).json()
  assert.equal(last.choices[0].message.content, "result-0 | result-1")
})

test("does not replay a user turn while waiting for client results", async t => {
  const { bridge } = await setup(t)
  await (await chat(bridge, user("CALL_TOOL"), { tools })).json()
  assert.equal((await chat(bridge, user("CALL_TOOL"), { tools })).status, 409)
})

test("rejects cross-session tool results", async t => {
  const { bridge } = await setup(t)
  const first = await (await chat(bridge, user("CALL_TOOL"), { tools })).json()
  const call = first.choices[0].message.tool_calls[0]
  const res = await chat(bridge, [{ role: "tool", tool_call_id: call.id, content: "wrong" }], { tools }, { "x-magpie-session": "other" })
  assert.equal(res.status, 400)
})

test("restarts session after history edits, model change or tool schema change", async t => {
  const { bridge, requests } = await setup(t)
  await (await chat(bridge, user("first"))).json()
  await (await chat(bridge, user("edited"))).json()
  await (await chat(bridge, user("edited"), { model: "other-model" })).json()
  assert.equal(requests().filter(r => r.method === "session/start").length, 3)
})

test("cancellation reaches Muse and releases the stream", async t => {
  const { bridge, requests } = await setup(t)
  const abort = new AbortController()
  const res = await chat(bridge, user("SLOW"), { stream: true }, {}, abort.signal)
  const reader = res.body.getReader(); await reader.read()
  abort.abort(); await reader.cancel()
  await new Promise(r => setTimeout(r, 20))
  assert.ok(requests().some(r => r.method === "turn/cancel"))
})

test("missing CLI and withheld sessionMcp are actionable failures", async t => {
  const { bridge } = await setup(t, { museBin: "/missing/muse" })
  assert.equal((await chat(bridge, user("hello"))).status, 503)
  const other = await setup(t, { museEnv: { FAKE_NO_MCP: "1" } })
  const res = await chat(other.bridge, user("hello"))
  assert.equal(res.status, 503); assert.match((await res.json()).error.message, /sessionMcp/)
})

test("requires a real client directory and refuses foreign destinations", async t => {
  const { bridge } = await setup(t)
  const res = await chat(bridge, user("hi"), {}, { "x-magpie-work-dir": "%ZZ" })
  assert.equal(res.status, 400)
  assert.equal((await bridge.fetch("https://api.meta.ai/v1/responses", { method: "POST", body: "{}" })).status, 400)
})

test("signed-out Muse errors remain sign-in errors", async t => {
  const { bridge } = await setup(t)
  const res = await chat(bridge, user("AUTH_REQUIRED"))
  assert.equal(res.status, 401); assert.match((await res.json()).error.message, /muse login/)
})

test("client tool timeout resolves the held MCP request", async t => {
  const { bridge } = await setup(t, { toolTimeoutMs: 25 })
  const first = await (await chat(bridge, user("CALL_TOOL"), { tools })).json()
  assert.ok(first.choices[0].message.tool_calls.length)
  await new Promise(r => setTimeout(r, 60))
  assert.equal([...bridge.sessions.values()][0].pending.size, 0)
  assert.equal([...bridge.sessions.values()][0].active, false)
})

test("tool_choice none never forwards an attempted tool", async t => {
  const { bridge } = await setup(t)
  const res = await chat(bridge, user("CALL_TOOL"), { tools, tool_choice: "none" })
  assert.equal(res.status, 502)
})

test("simultaneous first requests cannot create two Muse runs for one conversation", async t => {
  const { bridge, requests } = await setup(t)
  const first = chat(bridge, user("SLOW"))
  // Wait until the first request has reserved this conversation, before it has
  // received the CLI's session/start ack.
  while (!bridge.sessions.size) await new Promise(r => setTimeout(r, 1))
  assert.equal((await chat(bridge, user("other"))).status, 409)
  await (await first).json()
  assert.equal(requests().filter(r => r.method === "session/start").length, 1)
})

test("CLI crash fails its turn and the next user turn starts a fresh CLI", async t => {
  const { bridge } = await setup(t)
  assert.equal((await chat(bridge, user("CRASH"))).status, 502)
  const res = await chat(bridge, user("recovered"))
  assert.equal((await res.json()).choices[0].message.content, "Echo: recovered")
})
