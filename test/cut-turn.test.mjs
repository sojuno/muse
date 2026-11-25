import test from "node:test"
import assert from "node:assert/strict"
import { createAPITransport, cutTurnText, bareToolCalls } from "../src/api-transport.mjs"

const BASE = "http://127.0.0.1:1234/v1"
const TOOL = "mcp__harbor_browser__click_element"
const SENTENCE = "Opening that post now."
const usage = (output, reasoning = 0, input = 100) => ({ input_tokens: input, output_tokens: output, total_tokens: input + output,
  input_tokens_details: { cached_tokens: 64 }, output_tokens_details: { reasoning_tokens: reasoning } })
const message = text => ({ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] })
const call = (name, args = '{"selector":"#post"}') => ({ type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: args, status: "completed" })

// Meta's stream for one response: its output items, then response.completed, then [DONE].
function sse(output, use, { named = true, status = "completed" } = {}) {
  let sequence_number = 0
  const out = []
  const send = (type, data) => out.push((named ? `event: ${type}\n` : "") + `data: ${JSON.stringify({ type, sequence_number: sequence_number++, ...data })}\n\n`)
  const response = { id: "resp_1", object: "response", created_at: 1, status: "in_progress", output: [] }
  send("response.created", { response })
  output.forEach((item, i) => {
    send("response.output_item.added", { output_index: i, item: item.type === "function_call" ? { ...item, arguments: "" } : { ...item, content: [] } })
    if (item.type === "function_call") {
      send("response.function_call_arguments.delta", { output_index: i, item_id: item.id, delta: item.arguments })
      send("response.function_call_arguments.done", { output_index: i, item_id: item.id, arguments: item.arguments })
    } else if (item.type === "message") {
      send("response.output_text.delta", { output_index: i, item_id: item.id, content_index: 0, delta: item.content[0].text })
      send("response.output_text.done", { output_index: i, item_id: item.id, content_index: 0, text: item.content[0].text })
    }
    send("response.output_item.done", { output_index: i, item })
  })
  send("response.completed", { response: { ...response, status, output, usage: use } })
  return new Response(out.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
}

// One request through the transport. `first(wire)` answers the client's request, `next(wire, body)` the continuation.
async function run({ first, next = () => { throw new Error("no continuation expected") }, request = {}, options = {}, signal } = {}) {
  const requests = [], logs = []
  const transport = createAPITransport({ baseURL: BASE, localTestBackend: true, credential: async () => ({ type: "api", access: "test-only-key" }),
    log: line => logs.push(line), ...options,
    request: async (url, init) => {
      const body = JSON.parse(init.body), wire = body.tools?.[0]?.name
      requests.push({ body, signal: init.signal })
      return requests.length === 1 ? first(wire) : next(wire, body)
    } })
  const payload = { model: "muse-wonder-1.0-contributor", stream: true, input: [{ role: "user", content: "Book it." }],
    tools: [{ type: "function", name: TOOL, parameters: { type: "object", properties: { selector: { type: "string" } } } }], ...request }
  const res = await transport(BASE + "/responses", { method: "POST", body: JSON.stringify(payload), signal })
  const text = await res.text()
  const events = text.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)))
  return { res, text, events, requests, logs }
}

const cutStream = () => sse([message(SENTENCE)], usage(8))
const asItWas = async scenario => (await run({ ...scenario, options: { cutTurns: "pass" } })).text

test("a cut turn is continued once and the announced call is spliced into the same response", async () => {
  const { text, events, requests, logs } = await run({ first: cutStream,
    next: wire => Response.json({ id: "resp_2", status: "completed", output: [call(wire)], usage: usage(20, 0, 108) }) })
  assert.equal(requests.length, 2)
  const [, cont] = requests
  assert.equal(cont.body.stream, false)
  assert.deepEqual(cont.body.input.slice(0, -1), requests[0].body.input)
  assert.deepEqual(cont.body.input.at(-1), { role: "assistant", content: [{ type: "output_text", text: SENTENCE }] })
  assert.deepEqual(cont.body.tools, requests[0].body.tools)
  assert.equal(cont.body.model, requests[0].body.model)
  const types = events.map(e => e.type)
  assert.deepEqual(types, ["response.created", "response.output_item.added", "response.output_text.delta", "response.output_text.done", "response.output_item.done",
    "response.output_item.added", "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.output_item.done", "response.completed"])
  const seq = events.map(e => e.sequence_number)
  assert.deepEqual(seq, [...seq].sort((a, b) => a - b)); assert.equal(new Set(seq).size, seq.length)
  assert.equal(events[5].output_index, 1); assert.equal(events[5].item.name, TOOL); assert.equal(events[5].item.arguments, "")
  assert.equal(events[6].delta, '{"selector":"#post"}'); assert.equal(events[8].item.name, TOOL)
  const done = events.at(-1).response
  assert.deepEqual(done.output.map(item => item.type), ["message", "function_call"])
  assert.equal(done.output[1].name, TOOL)
  assert.deepEqual(done.usage, { ...usage(8), output_tokens: 28, total_tokens: 128 })
  assert.match(text, /event: response\.function_call_arguments\.delta\n/)
  assert.ok(text.trimEnd().endsWith("data: [DONE]"))
  assert.equal(logs.length, 1); assert.match(logs[0], /cut turn resp_1 \(8 output tokens: "Opening that post now\."\) continued: mcp__harbor_browser__click_element/)
})

test("a continuation streamed anyway is read from its response.completed", async () => {
  const { events, requests, logs } = await run({ first: cutStream, next: wire => sse([call(wire)], usage(20)) })
  assert.equal(requests.length, 2)
  assert.deepEqual(events.at(-1).response.output.map(item => item.type), ["message", "function_call"])
  assert.match(logs[0], /continued/)
})

for (const [name, next, why] of [
  ["writes text", wire => Response.json({ status: "completed", output: [message("I'll click it."), call(wire)], usage: usage(30) }), /it wrote text/],
  ["reasons", wire => Response.json({ status: "completed", output: [call(wire)], usage: usage(300, 250) }), /reasoned/],
  ["answers text only", () => Response.json({ status: "completed", output: [message("Done.")], usage: usage(3) }), /wrote text/],
  ["calls a tool that was not offered", () => Response.json({ status: "completed", output: [call("client_0000")], usage: usage(20) }), /no offered tool/],
  ["sends arguments that are not JSON", wire => Response.json({ status: "completed", output: [call(wire, '{"selector":')], usage: usage(20) }), /not JSON/],
  ["has no usage", wire => Response.json({ status: "completed", output: [call(wire)] }), /no usage/],
  ["fails", () => Response.json({ error: { message: "busy" } }, { status: 500 }), /answered 500/],
  ["throws", () => { throw new Error("socket hang up") }, /socket hang up/],
]) {
  test(`a continuation that ${name} leaves the turn exactly as Meta ended it`, async () => {
    const { text, requests, logs } = await run({ first: cutStream, next })
    assert.equal(requests.length, 2)
    assert.equal(text, await asItWas({ first: cutStream }))
    assert.equal(logs.length, 1); assert.match(logs[0], /not continued/); assert.match(logs[0], why)
  })
}

for (const [name, scenario] of [
  ["a turn that reasoned", { first: () => sse([message(SENTENCE)], usage(40, 12)) }],
  ["a turn of more than 100 output tokens", { first: () => sse([message(SENTENCE)], usage(101)) }],
  ["a turn of more than 1000 characters", { first: () => sse([message("x".repeat(1001))], usage(90)) }],
  ["a sentence with its call", { first: wire => sse([message(SENTENCE), call(wire)], usage(30)) }],
  ["a call alone", { first: wire => sse([call(wire)], usage(20)) }],
  ["an incomplete turn", { first: () => sse([message(SENTENCE)], usage(8), { status: "incomplete" }) }],
  ["a turn whose usage has no reasoning count", { first: () => sse([message(SENTENCE)], { input_tokens: 1, output_tokens: 8 }) }],
  ["a request that offers no tools", { first: () => sse([message(SENTENCE)], usage(8)), request: { tools: undefined } }],
  ["a request that forbids tools", { first: () => sse([message(SENTENCE)], usage(8)), request: { tool_choice: "none" } }],
  ["a request continuing a stored response", { first: () => sse([message(SENTENCE)], usage(8)), request: { previous_response_id: "resp_0", store: true } }],
  ["the option set to pass", { first: () => sse([message(SENTENCE)], usage(8)), options: { cutTurns: "pass" } }],
]) {
  test(`${name} goes out unchanged and nothing more is sent`, async () => {
    const { text, requests, logs } = await run(scenario)
    assert.equal(requests.length, 1)
    assert.equal(logs.length, 0)
    assert.equal(text, await asItWas(scenario))
  })
}

test("a cut turn answered without streaming is continued into one response", async () => {
  const first = () => Response.json({ id: "resp_1", status: "completed", output: [message(SENTENCE)], usage: usage(8) })
  const { res, text, requests } = await run({ first, next: wire => Response.json({ status: "completed", output: [call(wire)], usage: usage(20) }) })
  assert.equal(requests.length, 2)
  const value = JSON.parse(text)
  assert.deepEqual(value.output.map(item => item.type), ["message", "function_call"])
  assert.equal(value.output[1].name, TOOL)
  assert.equal(value.usage.output_tokens, 28)
  assert.equal(res.status, 200)
})

test("the continuation follows the client's abort", async () => {
  const controller = new AbortController()
  const { requests } = await run({ first: cutStream, signal: controller.signal,
    next: wire => Response.json({ status: "completed", output: [call(wire)], usage: usage(20) }) })
  const cont = requests[1].signal
  assert.ok(cont instanceof AbortSignal); assert.equal(cont.aborted, false)
  controller.abort(); assert.equal(cont.aborted, true)
})

test("the option is validated", async () => {
  assert.throws(() => createAPITransport({ baseURL: BASE, localTestBackend: true, credential: async () => ({}), cutTurns: "maybe" }), /cutTurns/)
  assert.equal(cutTurnText({ status: "completed", output: [message(SENTENCE)], usage: usage(8) }), SENTENCE)
  assert.equal(cutTurnText({ status: "completed", output: [{ ...message(SENTENCE), content: [{ type: "refusal", refusal: "no" }] }], usage: usage(8) }), null)
  assert.equal(typeof bareToolCalls({ status: "completed", output: [], usage: usage(1) }, new Set()), "string")
})
