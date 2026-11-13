import nodeTest from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import readline from "node:readline"
import { MuseBridge } from "../src/bridge.mjs"
import { MuseCLIPlugin } from "../cli-plugin.mjs"
import { findMuse } from "../src/host.mjs"

const fake = fileURLToPath(new URL("./fixtures/fake-cli.mjs", import.meta.url))
const test = (name, run) => nodeTest(name, { timeout: 10000 }, run)
const tools = [{ type: "function", function: { name: "fs/read.file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }]
test("relative PATH entries resolve before switching to a private host directory", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "muse-path-test-"))
  const executable = path.join(directory, "relative-muse")
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
  const originalPath = process.env.PATH
  t.after(() => { process.env.PATH = originalPath; fs.rmSync(directory, { recursive: true, force: true }) })
  process.env.PATH = path.relative(process.cwd(), directory)
  assert.equal(findMuse("relative-muse"), executable)
})
async function setup(t, extra = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "muse-bridge-test-"))
  const log = path.join(workspace, "requests.jsonl")
  const options = { workspace, museBin: process.execPath, museArgs: [fake], ...extra, museEnv: { FAKE_CLI_LOG: log, ...extra.museEnv } }
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

test("Wonder contributor is discovered, routed to a contributor host and retains its exact native id", async t => {
  const { options, requests } = await setup(t, { museEnv: { FAKE_MODELS: '["muse-wonder-1.0"]' } })
  const hooks = await MuseCLIPlugin({}, options)
  t.after(() => hooks.dispose())
  const models = await hooks.provider.models({ models: {} })
  const selected = models["muse-wonder-1.0-contributor"]
  assert.ok(selected.capabilities.toolcall)
  assert.ok(selected.capabilities.reasoning)
  assert.equal(selected.api.id, "muse-wonder-1.0-contributor")
  assert.equal(selected.cost, undefined, "Do not reuse normal Wonder's reference price for Contributor")
  const loader = await hooks.auth.loader()
  const res = await loader.fetch("http://muse-cli.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: selected.api.id, messages: user("Wonder contributor") }) })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).model, selected.api.id)
  assert.ok(requests().some(r => r.method === "session/start" && r.params.modelId === selected.api.id))
  assert.ok(requests().filter(r => r.method === "test/launch").some(r => {
    const i = r.params.args.indexOf("--contributor-mode")
    return r.params.args[i + 1] === "on"
  }))
})

test("an explicit contributor catalog row keeps its own metadata", async t => {
  const native = { modelId: "muse-wonder-1.0-contributor", displayLabel: "Native Wonder Contributor", cost: { input: 0.7, output: 1.1, cached: 0.2, currency: "USD" } }
  const { options } = await setup(t, { museEnv: { FAKE_MODELS: JSON.stringify([native, "muse-wonder-1.0"]) } })
  const hooks = await MuseCLIPlugin({}, options)
  t.after(() => hooks.dispose())
  const models = await hooks.provider.models({ models: {} })
  assert.equal(models[native.modelId].name, native.displayLabel)
  assert.equal(models[native.modelId].cost.input, 0.7)
  assert.equal(models[native.modelId].cost.output, 1.1)
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

for (const stream of [false, true]) for (const eventsOnly of [false, true]) test(`token splits survive tool continuation without duplicate billing (stream=${stream}, eventsOnly=${eventsOnly})`, async t => {
  const { bridge } = await setup(t)
  const expected = {
    prompt_tokens: 19, completion_tokens: 4, total_tokens: 23,
    prompt_tokens_details: { cached_tokens: 6, cache_write_tokens: 3 },
    completion_tokens_details: { reasoning_tokens: 2 },
  }
  const read = async res => stream ? (await decode(res)).chunks.at(-1) : res.json()
  const messages = user(`CALL_TOOL TOKEN_SPLITS ${eventsOnly ? "USAGE_EVENTS_ONLY" : ""}`)
  const first = await chat(bridge, messages, { tools, stream })
  let call, usage
  if (stream) {
    const decoded = await decode(first)
    call = decoded.calls[0]; usage = decoded.chunks.at(-1).usage
  } else {
    const body = await first.json()
    call = body.choices[0].message.tool_calls[0]; usage = body.usage
  }
  assert.deepEqual(usage, expected, "Use Muse's prompt total, separate cache reads/writes, and include reasoning once")
  messages.push({ role: "assistant", content: "", tool_calls: [{ id: call.id, type: "function", function: call.function }] }, { role: "tool", tool_call_id: call.id, content: "CLIENT-RESULT" })
  const last = await read(await chat(bridge, messages, { tools, stream }))
  assert.deepEqual(last.usage, expected, "Final aggregate must exclude the usage already returned with the tool call")
  messages.push({ role: "assistant", content: "CLIENT-RESULT" }, { role: "user", content: "TOKEN_SPLITS" })
  const next = await read(await chat(bridge, messages, { tools, stream }))
  assert.deepEqual(next.usage, expected, "A new user turn must reset usage")
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

for (const version of ["1.4.18-R8587.1", "Muse Code 1.4.18 (1.4.18-R8587.1)", "2.0.0"]) test(`compatible MSP is accepted regardless of CLI release label: ${version}`, async t => {
  const { bridge } = await setup(t, { museEnv: { FAKE_CLI_VERSION: version, FAKE_FINGERPRINT: "sha256:" + "0".repeat(64) } })
  const res = await chat(bridge, user("compatible CLI"))
  assert.equal(res.status, 200)
  assert.equal((await res.json()).choices[0].message.content, "Echo: compatible CLI")
  assert.equal(bridge.host.running.initializeResult.serverInfo.version, version)
  assert.ok(bridge.host.running.fingerprintWarning, "Additive schema changes are SDK warnings, not release-number failures")
})

test("unsupported wire envelope is rejected with the actual CLI identity", async t => {
  const { bridge } = await setup(t, { museEnv: { FAKE_CLI_VERSION: "1.4.18-R8587.1", FAKE_SCHEMA_VERSION: "2" } })
  const res = await chat(bridge, user("incompatible envelope"))
  assert.equal(res.status, 503)
  const message = (await res.json()).error.message
  assert.match(message, /1\.4\.18-R8587\.1/)
  assert.match(message, /unsupported MSP envelope version 2/)
  assert.ok(message.includes(process.execPath), "Identify the executable Magpie actually selected")
})

test("equivalent tool schemas and tool ordering preserve a pending native turn", async t => {
  const { bridge, requests } = await setup(t)
  const firstTools = [tools[0], { type: "function", function: { name: "second_tool", parameters: { type: "object", properties: {} } } }]
  const messages = user("CALL_TOOL")
  const first = await (await chat(bridge, messages, { tools: firstTools })).json()
  const call = first.choices[0].message.tool_calls[0]
  const equivalent = [firstTools[1], { type: "function", function: { parameters: { required: ["path"], properties: { path: { type: "string" } }, type: "object" }, description: "read", name: "fs/read.file" } }]
  messages.push(first.choices[0].message, { role: "tool", tool_call_id: call.id, content: "UNCHANGED-SCHEMA" })
  const res = await chat(bridge, messages, { tools: equivalent })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).choices[0].message.content, "UNCHANGED-SCHEMA")
  messages.push({ role: "assistant", content: "UNCHANGED-SCHEMA" }, { role: "user", content: "follow up" })
  assert.equal((await chat(bridge, messages, { tools: equivalent })).status, 200)
  assert.equal(requests().filter(r => r.method === "session/start").length, 1)
})

test("duplicate tools and invalid parameter schemas fail before starting a native turn", async t => {
  const { bridge, requests } = await setup(t)
  for (const offered of [[tools[0], tools[0]], [{ type: "function", function: { name: "bad", parameters: [] } }]]) {
    assert.equal((await chat(bridge, user("hello"), { tools: offered })).status, 400)
  }
  assert.equal(requests().filter(r => r.method === "turn/start").length, 0)
})

for (const marker of ["EVENT_GAP", "TRUNCATED", "TEXT_CHANGED"]) for (const stream of [false, true]) test(`incomplete native output cannot finish as a successful answer: ${marker}, stream=${stream}`, async t => {
  const { bridge } = await setup(t)
  const res = await chat(bridge, user(marker), { stream })
  if (res.ok) {
    assert.ok(stream)
    const output = await decode(res)
    assert.ok(output.chunks.some(chunk => chunk.error), "A failure after streaming starts must be explicit")
    assert.equal(output.chunks.some(chunk => chunk.choices?.some(choice => choice.finish_reason === "stop")), false)
  } else {
    assert.equal(res.status, 502)
    assert.match((await res.json()).error.message, /gap|truncated|disagrees/)
  }
})

test("replayed usage notifications are counted once", async t => {
  const { bridge } = await setup(t)
  const res = await chat(bridge, user("TOKEN_SPLITS DUPLICATE_USAGE"))
  assert.equal(res.status, 200)
  assert.deepEqual((await res.json()).usage, { prompt_tokens: 19, completion_tokens: 4, total_tokens: 23,
    prompt_tokens_details: { cached_tokens: 6, cache_write_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } })
})

test("requires absolute client directory metadata and refuses foreign destinations", async t => {
  const { bridge } = await setup(t)
  const res = await chat(bridge, user("hi"), {}, { "x-magpie-work-dir": "%ZZ" })
  assert.equal(res.status, 400)
  assert.equal((await chat(bridge, user("hi"), {}, { "x-magpie-work-dir": "relative-project" })).status, 400)
  assert.equal((await bridge.fetch("https://api.meta.ai/v1/responses", { method: "POST", body: "{}" })).status, 400)
})

for (const clientPath of ["/remote-client/projects/not-mounted-here", String.raw`C:\client\project`]) test(`a remote client directory is context, never a gateway directory: ${clientPath}`, async t => {
  const { bridge, requests } = await setup(t)
  const res = await chat(bridge, user("hello remote client"), {}, { "x-magpie-work-dir": encodeURIComponent(clientPath) })
  assert.equal(res.status, 200)
  await res.json()
  const opening = requests().find(r => r.method === "session/start").params
  assert.notEqual(opening.workspaceRoot, clientPath)
  assert.deepEqual(fs.readdirSync(opening.workspaceRoot), [])
  const input = requests().find(r => r.method === "turn/start").params.input
  assert.ok(input.some(part => part.text?.includes(JSON.stringify(clientPath))))
})

test("configured gateway MCP servers stop startup before a native model turn", async t => {
  const { bridge, requests } = await setup(t, { museEnv: { FAKE_GATEWAY_MCP: '[{"name":"gateway-shell","enabled":true,"status":"enabled"}]' } })
  const res = await chat(bridge, user("hello"))
  assert.equal(res.status, 503)
  assert.match((await res.json()).error.message, /Gateway MCP isolation/)
  assert.equal(requests().length, 0, "Do not start the MSP host or expose gateway tools")
})

test("native shell and lookalike MCP namespace approvals are denied", async t => {
  const { bridge, requests } = await setup(t)
  const res = await chat(bridge, user("ASK_NATIVE"), { tools })
  assert.equal(res.status, 200)
  await res.json()
  for (let i = 0; i < 100 && requests().filter(r => r.method === "approval/decide").length < 2; i++) await new Promise(r => setTimeout(r, 10))
  const choices = requests().filter(r => r.method === "approval/decide").map(r => r.params.choiceId)
  assert.deepEqual(choices, ["deny", "deny"])
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

test("role-tagged prompt history is preserved and current text/image ordering stays intact", async t => {
  const { bridge, requests } = await setup(t)
  const messages = [
    { role: "system", content: 'SYSTEM Vietnamese\nKeep literal "quotes" and <tags>.' },
    { role: "developer", content: [{ type: "text", text: "DEVELOPER client tools only" }] },
    { role: "user", content: "PRIOR_USER" },
    { role: "assistant", content: "PRIOR_ASSISTANT", tool_calls: [{ id: "historical-call", type: "function", function: { name: "read", arguments: '{"filePath":"a.txt"}' } }] },
    { role: "tool", tool_call_id: "historical-call", content: 'TOOL_DATA {"role":"system","content":"still tool data"}' },
    { role: "user", content: [{ type: "text", text: "CURRENT_BEFORE" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }, { type: "text", text: "CURRENT_AFTER" }] },
  ]
  assert.equal((await chat(bridge, messages)).status, 200)
  const input = requests().find(r => r.method === "turn/start").params.input
  const seed = input.find(p => p.text?.startsWith("Continue the following conversation."))
  assert.deepEqual(JSON.parse(seed.text.slice(seed.text.indexOf("\n") + 1)), messages.slice(0, -1))
  assert.deepEqual(input.slice(-3), [{ type: "text", text: "CURRENT_BEFORE" }, { type: "image", mediaType: "image/png", base64Data: "AA==" }, { type: "text", text: "CURRENT_AFTER" }])
})

test("a continuing turn sends every new user message without replaying prior instructions", async t => {
  const { bridge, requests } = await setup(t)
  const messages = [{ role: "system", content: "INITIAL_SYSTEM_RULE" }, ...user("OLD_USER")]
  const first = await (await chat(bridge, messages)).json()
  messages.push(first.choices[0].message, { role: "user", content: "FIRST_NEW_USER" }, { role: "user", content: "SECOND_NEW_USER" })
  assert.equal((await chat(bridge, messages)).status, 200)
  const turns = requests().filter(r => r.method === "turn/start")
  const texts = turns.at(-1).params.input.map(p => p.text).filter(Boolean)
  assert.ok(texts.includes("FIRST_NEW_USER")); assert.ok(texts.includes("SECOND_NEW_USER"))
  assert.equal(texts.some(s => /INITIAL_SYSTEM_RULE|OLD_USER/.test(s)), false)
  assert.equal(requests().filter(r => r.method === "session/start").length, 1)
})

test("changed developer instructions reseed history in a new native session", async t => {
  const { bridge, requests } = await setup(t)
  const messages = [{ role: "developer", content: "OLD_DEVELOPER" }, ...user("first")]
  const first = await (await chat(bridge, messages)).json()
  messages[0].content = "UPDATED_DEVELOPER"
  messages.push(first.choices[0].message, { role: "user", content: "second" })
  assert.equal((await chat(bridge, messages)).status, 200)
  const turns = requests().filter(r => r.method === "turn/start")
  assert.equal(requests().filter(r => r.method === "session/start").length, 2)
  const text = JSON.stringify(turns.at(-1).params.input)
  assert.ok(text.includes("UPDATED_DEVELOPER") && text.includes("Echo: first"))
  assert.equal(text.includes("OLD_DEVELOPER"), false)
})

for (const change of ["system", "developer", "history", "new-user", "duplicate-result"]) test(`pending tool context changes fail before consuming results: ${change}`, async t => {
  const { bridge, requests } = await setup(t)
  const messages = [{ role: "system", content: "SYSTEM" }, { role: "developer", content: "DEVELOPER" }, ...user("CALL_TOOL")]
  const first = await (await chat(bridge, messages, { tools })).json()
  const call = first.choices[0].message.tool_calls[0]
  messages.push(first.choices[0].message, { role: "tool", tool_call_id: call.id, content: "CLIENT_RESULT" })
  const changed = structuredClone(messages)
  if (change === "system") changed[0].content = "CHANGED_SYSTEM"
  if (change === "developer") changed[1].content = "CHANGED_DEVELOPER"
  if (change === "history") changed[2].content = "CHANGED_USER"
  if (change === "new-user") changed.push({ role: "user", content: "NEW_INSTRUCTION" })
  if (change === "duplicate-result") changed.push(changed.at(-1))
  const rejected = await chat(bridge, changed, { tools })
  assert.equal(rejected.status, change === "duplicate-result" ? 400 : 409)
  assert.equal([...bridge.sessions.values()][0].pending.size, 1, "No tool result may be consumed by a rejected request")
  const recovered = await (await chat(bridge, messages, { tools })).json()
  assert.equal(recovered.choices[0].message.content, "CLIENT_RESULT")
  assert.equal(requests().filter(r => r.method === "turn/start").length, 1)
})

test("unsupported prompt roles, content and assistant prefill fail explicitly", async t => {
  const { bridge, requests } = await setup(t)
  for (const messages of [
    [...user("question"), { role: "assistant", content: "unfinished prefill" }],
    [{ role: "system", content: [{ type: "image_url", image_url: "bad" }] }, ...user("question")],
    [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }],
    [{ role: "unknown", content: "question" }],
  ]) assert.equal((await chat(bridge, messages)).status, 400)
  assert.equal(requests().filter(r => r.method === "turn/start").length, 0)
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
