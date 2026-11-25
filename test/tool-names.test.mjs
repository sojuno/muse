import test from "node:test"
import assert from "node:assert/strict"
import { createAPITransport, prepareAPIRequest, RESERVED_TOOL_NAMES } from "../src/api-transport.mjs"

const BASE = "http://127.0.0.1:1234/v1"
const tool = (name, description = "A tool.") => ({ type: "function", name, description, parameters: { type: "object", properties: {} } })
const ALIAS = /^client_[a-f0-9]{40}$/

test("by default a declared name is sent as written; the Muse Code client's own names and unsafe names are aliased", () => {
  const tools = [tool("mcp__harbor_browser__click_element", "Click."), tool("lookup_weather"), tool("bash", "Run a shell command."), tool("Read"),
    tool("write"), tool("edit"), tool("fs/read"), tool("client_abc")]
  const input = [{ type: "function_call", call_id: "c1", name: "mcp__harbor_browser__click_element", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "ok" }, { type: "function_call", call_id: "c2", name: "bash", arguments: "{}" }]
  const out = prepareAPIRequest({ input, tools })
  assert.deepEqual(out.body.tools.slice(0, 2), tools.slice(0, 2))
  for (const i of [2, 3, 4, 5, 6, 7]) assert.match(out.body.tools[i].name, ALIAS)
  assert.equal(out.body.tools[2].description, 'Client tool "bash". Run a shell command.')
  assert.equal(out.body.input[0].name, "mcp__harbor_browser__click_element")
  assert.equal(out.body.input[2].name, out.body.tools[2].name)
  assert.equal(out.names.get("mcp__harbor_browser__click_element"), "mcp__harbor_browser__click_element")
  assert.equal(out.names.get(out.body.tools[2].name), "bash")
  assert.deepEqual([...RESERVED_TOOL_NAMES], ["bash", "read", "write", "edit"])
})

test("a refusal of a declared name sends the same request again aliased, and the tool set stays aliased", async () => {
  const sent = [], logs = []
  const transport = createAPITransport({ baseURL: BASE, localTestBackend: true, credential: async () => ({ type: "api", access: "test-only-key" }), log: line => logs.push(line),
    request: async (_url, init) => {
      const body = JSON.parse(init.body); sent.push(body)
      if (body.tools.some(t => t.name === "lookup_weather")) return Response.json({ error: { code: "client_attestation_denied", message: "Muse Code subscriptions cover requests from the Muse Code client only." } }, { status: 403 })
      return Response.json({ id: "resp_1", status: "completed", output: [{ type: "function_call", call_id: "c1", name: body.tools[0].name, arguments: "{}" }], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, output_tokens_details: { reasoning_tokens: 0 } } })
    } })
  const post = body => transport(BASE + "/responses", { method: "POST", body: JSON.stringify(body) })
  const res = await post({ input: "Weather?", tools: [tool("lookup_weather")] })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).output[0].name, "lookup_weather")
  assert.equal(sent.length, 2); assert.equal(sent[0].tools[0].name, "lookup_weather"); assert.match(sent[1].tools[0].name, ALIAS)
  assert.equal(logs.length, 1); assert.match(logs[0], /client_attestation_denied.*lookup_weather/)
  await post({ input: "Again?", tools: [tool("lookup_weather")] })
  assert.equal(sent.length, 3); assert.match(sent[2].tools[0].name, ALIAS)
  await post({ input: "Other?", tools: [tool("mcp__harbor_browser__click_element")] })
  assert.equal(sent.length, 4); assert.equal(sent[3].tools[0].name, "mcp__harbor_browser__click_element")
})

test("another 403, or a refusal under hashed names, is returned as it came", async () => {
  for (const [options, body] of [[{}, { error: { code: "forbidden", message: "no" } }], [{ toolNames: "hashed" }, { error: { code: "client_attestation_denied" } }]]) {
    let calls = 0
    const transport = createAPITransport({ baseURL: BASE, localTestBackend: true, credential: async () => ({ type: "api", access: "test-only-key" }), log: () => {}, ...options,
      request: async () => { calls++; return Response.json(body, { status: 403 }) } })
    const res = await transport(BASE + "/responses", { method: "POST", body: JSON.stringify({ input: "x", tools: [tool("lookup_weather")] }) })
    assert.equal(res.status, 403); assert.equal(calls, 1)
  }
})
