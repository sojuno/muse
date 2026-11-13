import nodeTest from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import readline from "node:readline"
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
  assert.ok(cfg.provider["muse-cli"].models["muse-spark-1.3-contributor"])
  assert.equal(models["muse-spark-1.3-contributor"].api.id, "muse-spark-1.3-contributor")
  assert.equal(models["muse-spark-1.3"].cost.input, 1.25)
  assert.equal(models["muse-spark-1.3-contributor"].cost.input, 0.10)
  assert.equal(models["muse-wonder-1.0-contributor"], undefined, "Only base models from the account's catalog receive contributor aliases")
})

test("scripted MSP child completes a text turn and keeps the same session", async t => {
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
  const response = chat(bridge, user("SLOW"), { stream: true }, {}, abort.signal)
  while (!requests().some(r => r.method === "turn/start")) await new Promise(r => setTimeout(r, 1))
  abort.abort()
  assert.equal((await response).status, 499)
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

test("two consecutive tool steps stay inside a single Muse turn", async t => {
  const { bridge, requests } = await setup(t)
  const messages = user("TWICE CALL_TOOL")
  for (const output of ["STEP_ONE", "STEP_TWO"]) {
    const body = await (await chat(bridge, messages, { tools })).json()
    assert.equal(body.choices[0].finish_reason, "tool_calls")
    const call = body.choices[0].message.tool_calls[0]
    messages.push(body.choices[0].message, { role: "tool", tool_call_id: call.id, content: output })
  }
  const last = await (await chat(bridge, messages, { tools })).json()
  assert.equal(last.choices[0].message.content, "STEP_ONE | STEP_TWO")
  assert.equal(requests().filter(r => r.method === "turn/start").length, 1)
})

for (const stream of [false, true]) test(`reasoning deltas and completion fallback are preserved (stream=${stream})`, async t => {
  const { bridge } = await setup(t)
  const res = await chat(bridge, user("REASON COMPLETE_ONLY"), { stream, reasoning_effort: "high" })
  if (stream) {
    const out = await decode(res)
    assert.equal(out.text, "Echo: REASON COMPLETE_ONLY")
    assert.equal(out.chunks.flatMap(c => c.choices ?? []).map(c => c.delta.reasoning_content ?? "").join(""), "Thinking carefully.")
  } else {
    const body = await res.json()
    assert.equal(body.choices[0].message.reasoning_content, "Thinking carefully.")
    assert.equal(body.choices[0].message.content, "Echo: REASON COMPLETE_ONLY")
  }
})

test("inline images and requested reasoning effort reach turn/start", async t => {
  const { bridge, requests } = await setup(t)
  const content = [{ type: "text", text: "describe image" }, { type: "image_url", image_url: { url: "data:image/png;base64,dGVzdA==" } }]
  const res = await chat(bridge, [{ role: "user", content }], { reasoning_effort: "high" })
  assert.equal(res.status, 200); await res.json()
  const turn = requests().find(r => r.method === "turn/start").params
  assert.equal(turn.reasoningEffort, "high")
  assert.deepEqual(turn.input.find(p => p.type === "image"), { type: "image", mediaType: "image/png", base64Data: "dGVzdA==" })
})

test("named tool choice exposes only the selected tool, retaining its client name", async t => {
  const { bridge } = await setup(t)
  const two = [...tools, { type: "function", function: { name: "mcp__filesystem__read", parameters: { type: "object" } } }]
  const body = await (await chat(bridge, user("CALL_TOOL"), { tools: two, tool_choice: { type: "function", function: { name: "mcp__filesystem__read" } } })).json()
  assert.equal(body.choices[0].message.tool_calls[0].function.name, "mcp__filesystem__read")
})

test("a client tool error is returned to Muse as an MCP error result", async t => {
  const { bridge, requests } = await setup(t)
  const messages = user("CALL_TOOL")
  const body = await (await chat(bridge, messages, { tools })).json()
  messages.push(body.choices[0].message, { role: "tool", tool_call_id: body.choices[0].message.tool_calls[0].id, content: "Permission denied by client", is_error: true })
  const result = await (await chat(bridge, messages, { tools })).json()
  assert.equal(result.choices[0].message.content, "Permission denied by client")
  assert.equal(requests().find(r => r.method === "test/tool-result").params[0].isError, true)
})

test("rejects a partial parallel result batch without consuming any result", async t => {
  const { bridge } = await setup(t)
  const two = [...tools, { type: "function", function: { name: "other", parameters: { type: "object" } } }]
  const messages = user("PARALLEL")
  const body = await (await chat(bridge, messages, { tools: two })).json()
  const calls = body.choices[0].message.tool_calls
  messages.push(body.choices[0].message, { role: "tool", tool_call_id: calls[0].id, content: "one" })
  assert.equal((await chat(bridge, messages, { tools: two })).status, 400)
  assert.equal([...bridge.sessions.values()][0].pending.size, 2)
  messages.push({ role: "tool", tool_call_id: calls[1].id, content: "two" })
  assert.equal((await (await chat(bridge, messages, { tools: two })).json()).choices[0].message.content, "one | two")
})

test("tool definitions cannot change during a pending call", async t => {
  const { bridge } = await setup(t)
  const messages = user("CALL_TOOL")
  const body = await (await chat(bridge, messages, { tools })).json()
  messages.push(body.choices[0].message, { role: "tool", tool_call_id: body.choices[0].message.tool_calls[0].id, content: "ok" })
  assert.equal((await chat(bridge, messages, { tools: [] })).status, 409)
})

test("subagents are isolated even under the same conversation", async t => {
  const { bridge, requests } = await setup(t)
  await (await chat(bridge, user("one"), {}, { "x-magpie-subagent": "A" })).json()
  await (await chat(bridge, user("two"), {}, { "x-magpie-subagent": "B" })).json()
  assert.equal(requests().filter(r => r.method === "session/start").length, 2)
})

test("system instructions and edited history are included when a session is reseeded", async t => {
  const { bridge, requests } = await setup(t)
  const messages = [{ role: "system", content: "Use Vietnamese." }, ...user("first")]
  const first = await (await chat(bridge, messages)).json()
  messages.push(first.choices[0].message, { role: "user", content: "next" })
  messages[0].content = "Use English."
  await (await chat(bridge, messages)).json()
  const turns = requests().filter(r => r.method === "turn/start")
  assert.equal(requests().filter(r => r.method === "session/start").length, 2)
  assert.match(JSON.stringify(turns.at(-1).params.input), /Use English/)
  assert.match(JSON.stringify(turns.at(-1).params.input), /Echo: first/)
})

test("evicting an idle session releases it in the CLI", async t => {
  const { bridge, requests } = await setup(t, { maxSessions: 1 })
  await (await chat(bridge, user("one"), {}, { "x-magpie-session": "one" })).json()
  await (await chat(bridge, user("two"), {}, { "x-magpie-session": "two" })).json()
  assert.equal(bridge.sessions.size, 1)
  assert.ok(requests().some(r => r.method === "session/leave"))
})

test("MCP resources/prompts are explicitly unsupported; cross-origin access is denied", async t => {
  const { bridge } = await setup(t)
  await (await chat(bridge, user("hi"), { tools })).json()
  const route = [...bridge.server.routes.keys()][0], url = bridge.server.base + route
  const rpc = (method, headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }) })
  assert.equal((await (await rpc("resources/list")).json()).error.code, -32601)
  assert.equal((await (await rpc("prompts/list")).json()).error.code, -32601)
  assert.equal((await rpc("tools/list", { origin: "https://example.com" })).status, 403)
})

test("unsupported structured output and audio fail explicitly", async t => {
  const { bridge } = await setup(t)
  for (const option of [{ response_format: { type: "json_object" } }, { audio: { voice: "alloy" } }]) {
    assert.equal((await chat(bridge, user("hi"), option)).status, 400)
  }
})

test("remote image URLs are rejected without sending a Muse turn", async t => {
  const { bridge, requests } = await setup(t)
  const res = await chat(bridge, [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }] }])
  assert.ok(res.status >= 400)
  assert.match((await res.json()).error.message, /remote image URLs/)
  assert.equal(requests().filter(r => r.method === "turn/start").length, 0)
})

test("subscription quota errors keep their retryable HTTP status", async t => {
  const { bridge } = await setup(t)
  assert.equal((await chat(bridge, user("RATE_LIMIT"))).status, 429)
})

test("streaming requests retain an immediate auth/quota HTTP failure before any SSE bytes", async t => {
  const { bridge } = await setup(t)
  for (const [input, status] of [["AUTH_REQUIRED", 401], ["RATE_LIMIT", 429]]) {
    const res = await chat(bridge, user(input), { stream: true })
    assert.equal(res.status, status)
    assert.match(res.headers.get("content-type"), /application\/json/)
    assert.ok((await res.json()).error.message)
  }
})

test("a separate stdio filesystem MCP server executes a bridged client tool", async t => {
  const { bridge, options } = await setup(t)
  const secret = `filesystem-content-${crypto.randomUUID()}`
  fs.writeFileSync(path.join(options.workspace, "example.txt"), secret)
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/filesystem-mcp.mjs", import.meta.url)), options.workspace], { stdio: ["pipe", "pipe", "pipe"] })
  const lines = readline.createInterface({ input: child.stdout }), pending = new Map()
  let serial = 0
  lines.on("line", line => { const msg = JSON.parse(line); pending.get(msg.id)?.(msg.result); pending.delete(msg.id) })
  t.after(() => { child.stdin.end(); lines.close() })
  const rpc = (method, params = {}) => new Promise(resolve => {
    const id = ++serial; pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  })
  await rpc("initialize", { protocolVersion: "2025-03-26" })
  const catalog = await rpc("tools/list"), tool = catalog.tools[0]
  const clientTools = [{ type: "function", function: { name: `mcp__filesystem__${tool.name}`, description: tool.description, parameters: tool.inputSchema } }]
  const messages = user("CALL_TOOL")
  const first = await (await chat(bridge, messages, { tools: clientTools })).json()
  const call = first.choices[0].message.tool_calls[0]
  assert.equal(call.function.name, "mcp__filesystem__read_file")
  const result = await rpc("tools/call", { name: tool.name, arguments: JSON.parse(call.function.arguments) })
  assert.equal(result.content[0].text, secret)
  messages.push(first.choices[0].message, { role: "tool", tool_call_id: call.id, content: result.content })
  const last = await (await chat(bridge, messages, { tools: clientTools })).json()
  assert.equal(last.choices[0].message.content, secret)
})

test("plugin isolates ordinary and contributor CLI hosts and preserves the suffix", async t => {
  const { options, requests } = await setup(t)
  const hooks = await MuseCLIPlugin({}, options)
  t.after(() => hooks.dispose())
  const loader = await hooks.auth.loader()
  for (const model of ["muse-spark-1.3", "muse-spark-1.3-contributor", "muse-spark-1.3"]) {
    const res = await loader.fetch("http://muse-cli.invalid/v1/chat/completions", {
      method: "POST", headers: { "x-magpie-session": "same-session" }, body: JSON.stringify({ model, messages: user("lane-test") }),
    })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).model, model)
  }
  const launches = requests().filter(r => r.method === "test/launch")
  assert.equal(launches.length, 2)
  assert.deepEqual(launches.map(r => { const i = r.params.args.indexOf("--contributor-mode"); return r.params.args[i + 1] }).sort(), ["off", "on"])
  const selected = requests().filter(r => r.method === "session/start").map(r => r.params.modelId)
  assert.ok(selected.includes("muse-spark-1.3"))
  assert.ok(selected.includes("muse-spark-1.3-contributor"))
})
