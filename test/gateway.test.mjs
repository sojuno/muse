import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

test("actual Magpie/Bun gateway converts Chat, Responses and Anthropic tool loops", { skip: !process.env.MAGPIE_TEST_BIN, timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-muse-gateway-test-"))
  const project = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
  // Magpie treats CLI-backed plugins as subscriptions too: its global
  // MAGPIE_NO_ACCOUNTS switch would disable the provider under test.
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), MAGPIE_NO_ACCOUNTS: "0" }
  if (process.env.MAGPIE_TEST_BUN) env.MAGPIE_BUN = process.env.MAGPIE_TEST_BUN
  const run = args => {
    const r = spawnSync(process.env.MAGPIE_TEST_BIN, args, { env, encoding: "utf8", timeout: 30000 })
    assert.equal(r.status, 0, r.stderr + r.stdout)
  }
  run(["plugin", "add", project])
  run(["plugin", "options", project, JSON.stringify({ workspace: root, museBin: process.execPath, museArgs: [fileURLToPath(new URL("./fixtures/fake-cli.mjs", import.meta.url))] })])
  run(["plugin", "login", "muse-cli"])
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve))
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const gateway = spawn(process.env.MAGPIE_TEST_BIN, ["serve"], { env: { ...env, MAGPIE_ADDR: `127.0.0.1:${port}` }, stdio: ["ignore", "ignore", "pipe"] })
  const exited = new Promise(resolve => gateway.once("exit", resolve))
  // Startup logs can contain configuration: retain no logs in the test report.
  gateway.stderr.resume()
  t.after(async () => { gateway.kill("SIGTERM"); await exited; fs.rmSync(root, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${port}`
  let ready = false
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`${base}/v1/models`)
      const body = await r.json()
      if (body.data?.some(m => m.id === "muse-cli/muse-spark-1.3")) { ready = true; break }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(ready, true, "Magpie did not expose the linked plugin model")
  const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  const name = "mcp__filesystem__read_file", model = "muse-cli/muse-spark-1.3"
  const post = async (route, body, session) => {
    const r = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-magpie-session": session }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
    assert.equal(r.status, 200, await r.clone().text())
    return r.json()
  }
  await t.test("Chat Completions retains MCP tool name and tool result", async () => {
    const messages = [{ role: "user", content: "CALL_TOOL" }], tools = [{ type: "function", function: { name, parameters: schema } }]
    const first = await post("/v1/chat/completions", { model, messages, tools }, "chat")
    const call = first.choices[0].message.tool_calls[0]
    assert.equal(call.function.name, name)
    messages.push(first.choices[0].message, { role: "tool", tool_call_id: call.id, content: "CHAT_TOOL_OK" })
    const last = await post("/v1/chat/completions", { model, messages, tools }, "chat")
    assert.equal(last.choices[0].message.content, "CHAT_TOOL_OK")
  })
  await t.test("Responses converts function_call and function_call_output", async () => {
    const input = [{ role: "user", content: "CALL_TOOL" }], tools = [{ type: "function", name, parameters: schema }]
    const first = await post("/v1/responses", { model, input, tools }, "responses")
    const call = first.output.find(i => i.type === "function_call")
    assert.ok(call, JSON.stringify(first)); assert.equal(call.name, name)
    input.push(call, { type: "function_call_output", call_id: call.call_id, output: "RESPONSES_TOOL_OK" })
    const last = await post("/v1/responses", { model, input, tools }, "responses")
    assert.ok(last.output.some(i => i.type === "message" && i.content.some(p => p.text === "RESPONSES_TOOL_OK")), JSON.stringify(last))
  })
  await t.test("Anthropic converts tool_use and tool_result", async () => {
    const messages = [{ role: "user", content: "CALL_TOOL" }], tools = [{ name, input_schema: schema }]
    const first = await post("/v1/messages", { model, messages, tools, max_tokens: 1000 }, "anthropic")
    const call = first.content.find(i => i.type === "tool_use")
    assert.ok(call, JSON.stringify(first)); assert.equal(call.name, name)
    messages.push({ role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "ANTHROPIC_TOOL_OK" }] })
    const last = await post("/v1/messages", { model, messages, tools, max_tokens: 1000 }, "anthropic")
    assert.ok(last.content.some(p => p.text === "ANTHROPIC_TOOL_OK"), JSON.stringify(last))
  })
  await t.test("contributor alias completes a client tool loop through Magpie", async () => {
    const model = "muse-cli/muse-spark-1.3-contributor"
    const messages = [{ role: "user", content: "CALL_TOOL" }], tools = [{ type: "function", function: { name, parameters: schema } }]
    const first = await post("/v1/chat/completions", { model, messages, tools }, "contributor")
    const call = first.choices[0].message.tool_calls[0]
    messages.push(first.choices[0].message, { role: "tool", tool_call_id: call.id, content: "CONTRIBUTOR_TOOL_OK" })
    const last = await post("/v1/chat/completions", { model, messages, tools }, "contributor")
    assert.equal(last.choices[0].message.content, "CONTRIBUTOR_TOOL_OK")
    assert.equal(last.model, model)
  })
  await t.test("Magpie usage ledger counts tokens/cache and prices each lane in USD", async () => {
    const res = await fetch(base + "/v1/magpie/usage/requests?period=all&provider=muse-cli")
    assert.equal(res.status, 200)
    const page = await res.json()
    const rows = page.rows.filter(r => r.provider === "muse-cli" && r.out > 0)
    assert.equal(rows.length, 4, JSON.stringify(page))
    for (const row of rows) {
      assert.equal(row.in, 10)
      assert.equal(row.out, 4)
      assert.equal(row.cache_read, 2)
      const contributor = row.model.endsWith("-contributor")
      const expected = contributor ? (10 * 0.10 + 2 * 0.002 + 4 * 0.20) / 1e6 : (10 * 1.25 + 2 * 0.15 + 4 * 4.25) / 1e6
      assert.ok(Math.abs(row.cost - expected) < 1e-12, JSON.stringify(row))
    }
    assert.ok(rows.some(r => r.model.endsWith("-contributor")))
  })
})
