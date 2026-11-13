import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import net from "node:net"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

test("direct API provider through real Magpie/Bun preserves prompts, tools, reasoning and usage", { skip: !process.env.MAGPIE_TEST_BIN, timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-muse-api-test-"))
  const project = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"), MAGPIE_NO_ACCOUNTS: "0" }
  if (process.env.MAGPIE_TEST_BUN) env.MAGPIE_BUN = process.env.MAGPIE_TEST_BUN
  const received = []
  const backend = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    if (req.method === "GET") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ data: [{ id: "muse-spark-1.3" }, { id: "muse-wonder-1.0" }] })) }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    received.push({ body, headers: req.headers })
    const result = body.input?.findLast?.(item => item.type === "function_call_output")
    const output = result ? [{ type: "message", id: "msg_final", role: "assistant", status: "completed", content: [{ type: "output_text", text: "CLIENT_TOOL_RESULT_OK", annotations: [] }] }]
      : [{ type: "function_call", id: "fc_test", call_id: "call_api_test", name: body.tools[0].name, arguments: '{"path":"client.txt"}', status: "completed" }]
    res.writeHead(200, { "content-type": "text/event-stream" })
    let sequence_number = 0
    const send = (type, data) => res.write(`data: ${JSON.stringify({ type, sequence_number: sequence_number++, ...data })}\n\n`)
    const response = { id: "resp_" + received.length, object: "response", model: body.model, created_at: 1, status: "in_progress", output: [] }
    send("response.created", { response })
    for (const [i, item] of output.entries()) {
      send("response.output_item.added", { output_index: i, item: item.type === "function_call" ? { ...item, arguments: "" } : { ...item, content: [] } })
      if (item.type === "function_call") {
        send("response.function_call_arguments.delta", { output_index: i, item_id: item.id, delta: item.arguments })
        send("response.function_call_arguments.done", { output_index: i, item_id: item.id, arguments: item.arguments })
      } else {
        send("response.content_part.added", { output_index: i, item_id: item.id, content_index: 0, part: { ...item.content[0], text: "" } })
        send("response.output_text.delta", { output_index: i, item_id: item.id, content_index: 0, delta: item.content[0].text })
        send("response.output_text.done", { output_index: i, item_id: item.id, content_index: 0, text: item.content[0].text })
      }
      send("response.output_item.done", { output_index: i, item })
    }
    send("response.completed", { response: { ...response, status: "completed", output,
      usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27, input_tokens_details: { cached_tokens: 8, cache_write_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } } } })
    res.end()
  })
  await new Promise(resolve => backend.listen(0, "127.0.0.1", resolve))
  const run = (args, input) => {
    const result = spawnSync(process.env.MAGPIE_TEST_BIN, args, { env, input, encoding: "utf8", timeout: 30000 })
    assert.equal(result.status, 0, result.stderr + result.stdout)
  }
  run(["plugin", "add", project])
  run(["plugin", "options", project, JSON.stringify({ localTestBackend: true, baseURL: `http://127.0.0.1:${backend.address().port}/v1` })])
  run(["plugin", "login", "muse", "2"], "test-only-api-key\n")
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve))
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const gateway = spawn(process.env.MAGPIE_TEST_BIN, ["serve"], { env: { ...env, MAGPIE_ADDR: `127.0.0.1:${port}` }, stdio: ["ignore", "ignore", "pipe"] })
  gateway.stderr.resume(); const exited = new Promise(resolve => gateway.once("exit", resolve))
  t.after(async () => { gateway.kill("SIGTERM"); await exited; backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); fs.rmSync(root, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${port}`
  let ready = false
  for (let i = 0; i < 200; i++) { try { const value = await (await fetch(base + "/v1/models")).json(); if (value.data?.some(m => m.id === "muse/muse-wonder-1.0-contributor")) { ready = true; break } } catch {} await new Promise(resolve => setTimeout(resolve, 100)) }
  assert.ok(ready)
  const name = "mcp__filesystem__read_file", schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  const post = async (route, body, session) => {
    const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json", "x-magpie-session": session, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
    assert.equal(response.status, 200, await response.clone().text()); return response.json()
  }
  await t.test("Chat preserves client instructions and original MCP name across tool results", async () => {
    const model = "muse/muse-spark-1.3", messages = [{ role: "system", content: "SYS_API_CHAT" }, { role: "developer", content: "DEV_API_CHAT" }, { role: "user", content: "USER_API_CHAT" }]
    const tools = [{ type: "function", function: { name, parameters: schema } }]
    const first = await post("/v1/chat/completions", { model, messages, tools }, "api-chat")
    const call = first.choices[0].message.tool_calls[0]; assert.equal(call.function.name, name)
    messages.push(first.choices[0].message, { role: "tool", tool_call_id: call.id, content: "ACTUAL_CLIENT_TOOL_DATA" })
    const last = await post("/v1/chat/completions", { model, messages, tools }, "api-chat")
    assert.equal(last.choices[0].message.content, "CLIENT_TOOL_RESULT_OK")
    assert.equal(last.usage.prompt_tokens, 20); assert.equal(last.usage.completion_tokens, 7)
    assert.equal(last.usage.prompt_tokens_details.cached_tokens, 8)
    assert.equal(last.usage.prompt_tokens_details.cache_write_tokens, 3)
    assert.equal(last.usage.completion_tokens_details.reasoning_tokens, 2)
  })
  await t.test("Responses keeps instructions, developer input and Wonder Contributor model id", async () => {
    const model = "muse/muse-wonder-1.0-contributor", input = [{ role: "developer", content: "DEV_API_RESPONSES" }, { role: "user", content: "USER_API_RESPONSES" }]
    const tools = [{ type: "function", name, parameters: schema }]
    const first = await post("/v1/responses", { model, instructions: "SYS_API_RESPONSES", input, tools }, "api-responses")
    const call = first.output.find(item => item.type === "function_call"); assert.equal(call.name, name)
    input.push(call, { type: "function_call_output", call_id: call.call_id, output: "ACTUAL_CLIENT_TOOL_DATA" })
    const last = await post("/v1/responses", { model, instructions: "SYS_API_RESPONSES", input, tools }, "api-responses")
    assert.ok(last.output.some(item => item.type === "message" && item.content.some(part => part.text === "CLIENT_TOOL_RESULT_OK")))
  })
  await t.test("Messages tool_use and tool_result reach the same direct API backend", async () => {
    const model = "muse/muse-spark-1.3-contributor", messages = [{ role: "user", content: "USER_API_MESSAGES" }], tools = [{ name, input_schema: schema }]
    const first = await post("/v1/messages", { model, system: "SYS_API_MESSAGES", messages, tools, max_tokens: 1000 }, "api-messages")
    const call = first.content.find(item => item.type === "tool_use"); assert.equal(call.name, name)
    messages.push({ role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "ACTUAL_CLIENT_TOOL_DATA" }] })
    const last = await post("/v1/messages", { model, system: "SYS_API_MESSAGES", messages, tools, max_tokens: 1000 }, "api-messages")
    assert.ok(last.content.some(part => part.text === "CLIENT_TOOL_RESULT_OK"))
  })
  await t.test("upstream has client prompts without the Muse CLI system wrapper", () => {
    assert.equal(received.length, 6)
    for (const { body, headers } of received) {
      const text = JSON.stringify(body)
      assert.ok(text.includes("SYS_API_")); assert.ok(text.includes("USER_API_"))
      assert.equal(text.includes("Continue the following conversation. Preserve its system/developer instructions."), false)
      assert.equal(text.includes("Your own workspace is an empty bridge directory"), false)
      assert.match(body.tools[0].name, /^client_[a-f0-9]{40}$/)
      assert.equal(headers["user-agent"], "magpie-muse/0.4.0")
      assert.equal(headers["x-client-id"], undefined)
      assert.equal(body.model.startsWith("muse-"), true)
    }
    assert.ok(JSON.stringify(received).includes("DEV_API_CHAT")); assert.ok(JSON.stringify(received).includes("DEV_API_RESPONSES"))
    assert.ok(received.some(r => r.body.model === "muse-wonder-1.0-contributor"))
  })
  await t.test("Magpie ledger keeps full input/output/cache read/write and reasoning", async () => {
    const page = await (await fetch(base + "/v1/magpie/usage/requests?period=all&provider=muse")).json()
    const rows = page.rows.filter(row => row.out > 0)
    assert.equal(rows.length, 6)
    for (const row of rows) { assert.equal(row.in, 9); assert.equal(row.out, 7); assert.equal(row.cache_read, 8); assert.equal(row.cache_write, 3); assert.equal(row.reasoning, 2) }
  })
})
