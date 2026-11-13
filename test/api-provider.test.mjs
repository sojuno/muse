import test from "node:test"
import assert from "node:assert/strict"
import { MusePlugin } from "../plugin.mjs"
import { createAPITransport, prepareAPIRequest, transformAPIResponse, META_API_BASE } from "../src/api-transport.mjs"
import { AuthError } from "../oauth.mjs"

test("API payload keeps system/developer/user instructions and tool results in their API fields", () => {
  const body = { model: "muse-wonder-1.0-contributor", instructions: 'SYSTEM\nLiteral "quotes" and <tags>',
    input: [{ role: "developer", content: "DEVELOPER" }, { role: "user", content: [{ type: "input_text", text: "FIRST" }, { type: "input_image", image_url: "data:image/png;base64,AA==" }, { type: "input_text", text: "SECOND" }] },
      { type: "function_call", call_id: "call-1", name: "bash", arguments: '{"command":"pwd"}' }, { type: "function_call_output", call_id: "call-1", output: "ACTUAL_CLIENT_DIRECTORY" }, { role: "user", content: "NEW_USER_AFTER_TOOL" }],
    tools: [{ type: "function", name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } }], reasoning: { effort: "high" }, store: false }
  const copy = structuredClone(body), out = prepareAPIRequest(body)
  assert.equal(out.body.instructions, body.instructions)
  assert.deepEqual(out.body.input.slice(0, 2), body.input.slice(0, 2))
  assert.deepEqual(out.body.input.slice(3), body.input.slice(3))
  assert.equal(out.body.input[2].call_id, "call-1")
  assert.equal(out.body.input[2].arguments, body.input[2].arguments)
  assert.equal(out.body.input[2].name, out.body.tools[0].name)
  assert.equal(out.names.get(out.body.tools[0].name), "bash")
  assert.equal(out.body.model, "muse-wonder-1.0-contributor")
  assert.deepEqual(out.body.reasoning, { effort: "high" })
  assert.deepEqual(body, copy)
})

test("API names handle client MCP names, duplicate tools and unsupported hosted tools explicitly", () => {
  const out = prepareAPIRequest({ input: "test", tools: [{ type: "function", name: "mcp__filesystem/read.đọc" }] })
  assert.match(out.body.tools[0].name, /^[A-Za-z0-9_-]{1,64}$/)
  assert.equal(out.names.get(out.body.tools[0].name), "mcp__filesystem/read.đọc")
  assert.throws(() => prepareAPIRequest({ tools: [{ type: "function", name: "read" }, { type: "function", name: "read" }] }), /Duplicate/)
  assert.throws(() => prepareAPIRequest({ tools: [{ type: "mcp", server_url: "https://example.test" }] }), /Connect MCP/)
  assert.throws(() => prepareAPIRequest({ tool_choice: "required" }), /automatic tool choice/)
  assert.deepEqual(prepareAPIRequest({ tools: [{ type: "function", name: "bash" }], tool_choice: "none" }).body.tools, [])
})

test("API SSE restores client tool names and preserves reasoning/usage with byte-split UTF-8", async () => {
  const prepared = prepareAPIRequest({ tools: [{ type: "function", name: "fs/read" }] })
  const usage = { input_tokens: 20, output_tokens: 7, total_tokens: 27, input_tokens_details: { cached_tokens: 8, cache_write_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } }
  const events = [{ type: "response.output_item.added", item: { type: "function_call", name: prepared.body.tools[0].name, call_id: "call-1", arguments: "{}" } },
    { type: "response.reasoning_summary_text.delta", delta: "Kiểm tra tiếng Việt" }, { type: "response.completed", response: { output: [{ type: "function_call", name: prepared.body.tools[0].name, call_id: "call-1" }], usage } }]
  const bytes = new TextEncoder().encode(events.map(e => "event: " + e.type + "\r\ndata: " + JSON.stringify(e) + "\r\n\r\n").join("") + "data: [DONE]\n\n")
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } })
  const seen = []
  const response = await transformAPIResponse(new Response(body, { headers: { "content-type": "text/event-stream" } }), prepared.names, e => seen.push(e))
  const text = await response.text()
  const chunks = text.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)))
  assert.equal(chunks[0].item.name, "fs/read")
  assert.equal(chunks[1].delta, "Kiểm tra tiếng Việt")
  assert.equal(chunks[2].response.output[0].name, "fs/read")
  assert.deepEqual(chunks[2].response.usage, usage)
  assert.equal(seen.length, 3)
  assert.ok(text.includes("data: [DONE]"))
})

test("foreign inference is refused before reading credentials and test endpoints refuse real keys", async () => {
  let credentials = 0, sent = 0
  const transport = createAPITransport({ credential: async () => { credentials++; return { access: "private-key" } }, request: async () => { sent++; return Response.json({}) } })
  const res = await transport("https://foreign.example/v1/responses", { method: "POST", body: "{}" })
  assert.equal(res.status, 400); assert.equal(credentials, 0); assert.equal(sent, 0)
  assert.throws(() => createAPITransport({ credential: async () => ({}), baseURL: "https://foreign.example/v1", localTestBackend: true }), /loopback/)
  const local = createAPITransport({ credential: async () => ({ access: "private-key" }), baseURL: "http://127.0.0.1:1234/v1", localTestBackend: true, request: async () => { sent++; return Response.json({}) } })
  await assert.rejects(local("http://127.0.0.1:1234/v1/responses", { method: "POST", body: '{"input":"test"}' }), /dummy/)
  assert.equal(sent, 0)
})

test("API request signs with its own identity, keeps Contributor id and never adds a CLI prompt", async () => {
  const calls = []
  const hooks = await MusePlugin({}, { request: async (url, init) => { calls.push({ url, init }); return Response.json({ output: [], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }) } })
  const config = {}; await hooks.config(config)
  assert.equal(config.provider.muse.npm, "@ai-sdk/openai")
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "test-only-key" }))
  const response = await loader.fetch(META_API_BASE + "/responses", { method: "POST", body: JSON.stringify({ model: "muse-wonder-1.0-contributor", instructions: "ONLY_CLIENT_SYSTEM", input: [{ role: "user", content: "ONLY_CLIENT_USER" }], stream: false }) })
  assert.equal(response.status, 200)
  assert.equal(calls.length, 1)
  const { init } = calls[0], body = JSON.parse(init.body)
  assert.equal(body.instructions, "ONLY_CLIENT_SYSTEM")
  assert.deepEqual(body.input, [{ role: "user", content: "ONLY_CLIENT_USER" }])
  assert.equal(body.model, "muse-wonder-1.0-contributor")
  assert.equal(init.headers.get("user-agent"), "magpie-muse/0.4.0")
  assert.equal(init.headers.get("x-client-id"), null)
  assert.equal(init.headers.get("authorization"), "Bearer test-only-key")
  assert.equal(init.redirect, "error")
  await hooks.dispose()
})

test("API 401 renewal happens once, while quota and missing response context stay explicit", async () => {
  let count = 0, renewals = 0
  const transport = createAPITransport({ credential: async () => ({ type: "oauth", access: "test-only-old" }), renew: async () => { renewals++; return { type: "oauth", access: "test-only-new" } },
    request: async (_url, init) => { count++; if (count === 1) return Response.json({ error: { message: "expired credential" } }, { status: 401 }); assert.equal(init.headers.get("authorization"), "Bearer test-only-new"); return Response.json({ output: [] }) } })
  assert.equal((await transport(META_API_BASE + "/responses", { method: "POST", body: '{"input":"test"}' })).status, 200)
  assert.equal(count, 2); assert.equal(renewals, 1)
  for (const [status, message] of [[429, "quota exceeded"], [400, "previous_response_id was not found"]]) {
    let sent = 0
    const call = createAPITransport({ credential: async () => ({ type: "api", access: "test-only" }), request: async (_url, init) => {
      sent++; assert.equal(JSON.parse(init.body).previous_response_id, "resp_missing")
      return Response.json({ error: { message } }, { status, headers: { "retry-after": "9" } })
    } })
    const response = await call(META_API_BASE + "/responses", { method: "POST", body: '{"previous_response_id":"resp_missing","input":"new user","instructions":"client system"}' })
    assert.equal(response.status, status); assert.equal(sent, 1)
    assert.equal(response.headers.get("retry-after"), "9")
  }
})

test("API model discovery is account scoped and preserves native Contributor entries", async () => {
  let requests = 0
  const hooks = await MusePlugin({}, { request: async (_url, init) => {
    requests++
    if (init.headers.authorization === "Bearer test-only-second") throw new Error("temporary catalog outage")
    return Response.json({ data: [{ id: "muse-wonder-1.0", metadata: { "muse-code": { name: "Wonder" } } }, { id: "muse-wonder-1.0-contributor", metadata: { "muse-code": { name: "Native Contributor" } } }, { id: "account-specific-model" }] })
  } })
  const first = await hooks.provider.models({}, { auth: { type: "api", key: "test-only-first" } })
  assert.equal(first["muse-wonder-1.0-contributor"].name, "Native Contributor")
  assert.ok(first["account-specific-model"])
  const second = await hooks.provider.models({}, { auth: { type: "api", key: "test-only-second" } })
  assert.equal(second["account-specific-model"], undefined)
  assert.ok(second["muse-wonder-1.0-contributor"])
  assert.equal(requests, 2)
  await hooks.dispose()
})

test("concurrent model discovery cannot overwrite another account's cached catalog", async () => {
  let release, failed = false
  const paused = new Promise(resolve => { release = resolve })
  const hooks = await MusePlugin({}, { request: async (_url, init) => {
    const account = init.headers.authorization.endsWith("first") ? "first" : "second"
    if (failed) throw new Error("catalog unavailable")
    if (account === "first") await paused
    return Response.json({ data: [{ id: "private-" + account }] })
  } })
  try {
    const first = hooks.provider.models({}, { auth: { type: "api", key: "test-only-first" } })
    await hooks.provider.models({}, { auth: { type: "api", key: "test-only-second" } })
    release(); await first; failed = true
    for (const account of ["first", "second"]) {
      const models = await hooks.provider.models({}, { auth: { type: "api", key: "test-only-" + account } })
      assert.deepEqual(Object.keys(models), ["private-" + account])
    }
  } finally { release(); await hooks.dispose() }
})

test("API reasoning recovery keeps client prompts, tool history and stored response context", async () => {
  const bodies = []
  const errors = ["reasoning encrypted_content was not issued to this caller", "Referenced reasoning item 'rs_old' was not found or has expired"]
  const transport = createAPITransport({ credential: async () => ({ type: "api", access: "test-only" }), request: async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    const message = errors.shift()
    return message ? Response.json({ error: { message } }, { status: 400 }) : Response.json({ output: [] })
  } })
  const body = { instructions: "SYSTEM_UNCHANGED", store: true, previous_response_id: "resp_kept", tools: [{ type: "function", name: "read" }],
    input: [{ role: "developer", content: "DEVELOPER_UNCHANGED" }, { role: "user", content: "USER_UNCHANGED" }, { type: "reasoning", id: "rs_old", encrypted_content: "old-account-blob" },
      { type: "function_call", call_id: "call-kept", name: "read", arguments: "{}" }, { type: "function_call_output", call_id: "call-kept", output: "ACTUAL_TOOL_OUTPUT" }] }
  const response = await transport(META_API_BASE + "/responses", { method: "POST", body: JSON.stringify(body) })
  assert.equal(response.status, 200); assert.equal(bodies.length, 3)
  for (const sent of bodies) {
    assert.equal(sent.instructions, body.instructions); assert.equal(sent.previous_response_id, "resp_kept")
    assert.deepEqual(sent.input.filter(item => item.type !== "reasoning"), bodies[0].input.filter(item => item.type !== "reasoning"))
  }
  assert.equal(bodies[1].input.find(item => item.type === "reasoning").encrypted_content, undefined)
  assert.equal(bodies[2].input.some(item => item.type === "reasoning"), false)
})

test("API authentication distinguishes expired grants from transient renewal failures", async () => {
  for (const expired of [false, true]) {
    let sends = 0
    const transport = createAPITransport({ credential: async () => ({ type: "oauth", access: "test-only-old" }),
      renew: async () => { throw new AuthError(expired ? "mint_failed" : "temporarily_unavailable", expired) },
      request: async () => { sends++; return Response.json({}, { status: 401 }) } })
    const response = await transport(META_API_BASE + "/responses", { method: "POST", body: "{}" })
    assert.equal(sends, 1)
    assert.equal(response.status, expired ? 401 : 503)
    assert.equal(response.headers.get("X-Magpie-Sign-In"), expired ? "expired" : "kept")
  }
})
