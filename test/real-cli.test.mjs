import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { MuseBridge } from "../src/bridge.mjs"

// This test uses the unmodified official Linux CLI, with a deterministic API on
// loopback. No Meta login, real credential or subscription quota is involved.
test("official Muse 1.4.15: MCP call crosses client HTTP turns and resumes", { skip: !process.env.MUSE_TEST_BIN, timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "muse-real-cli-test-"))
  const museEnv = { XDG_CONFIG_HOME: path.join(directory, "config"), XDG_DATA_HOME: path.join(directory, "data"), XDG_CACHE_HOME: path.join(directory, "cache"), META_API_KEY: "test-only-local-backend" }
  const auth = spawnSync(process.env.MUSE_TEST_BIN, ["auth", "set", "--provider", "meta", "--api-key-stdin"], { input: "test-only-local-backend\n", env: { ...process.env, ...museEnv }, encoding: "utf8" })
  assert.equal(auth.status, 0, auth.stderr)
  const primary = [], outputs = [], approvals = []
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    if (req.method === "GET") {
      res.setHeader("content-type", "application/json")
      return res.end(JSON.stringify({ object: "list", data: [{ id: "muse-spark-1.3", object: "model", owned_by: "meta", metadata: { "muse-code": { name: "Muse Spark", family: "muse", is_hidden: false, attachment: true, reasoning: true, temperature: false, tool_call: true, modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 1048576, output: 65536 }, options: { include: [] }, variants: {} } } }] }))
    }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const group = (body.tools ?? []).find(t => t.name === "mcp__magpie_client")
    const results = (body.input ?? []).filter(i => i.type === "function_call_output")
    let output
    if (group) {
      primary.push(body); outputs.push(...results)
      if (!results.length) output = [{ type: "function_call", id: "fc_client", call_id: "call_client", name: `${group.name}.${group.tools[0].name}`, arguments: '{"path":"example.txt"}', status: "completed" }]
      else output = [{ type: "message", id: "msg_final", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Verified client tool output.", annotations: [] }] }]
    } else {
      // The CLI may ask its own reminder child to submit a bookkeeping decision.
      const group = body.tools?.[0], name = group?.tools?.[0]?.name
      output = name === "submit_reminder_decision" ? [{ type: "function_call", id: "fc_reminder", call_id: "call_reminder", name: `${group.name}.${name}`, arguments: JSON.stringify({ decision: "none", reason: "No reminder needed", advisory_text: null, confidence: null, priority: null, skill_id: null, visible_for_steps: null }), status: "completed" }] : [{ type: "message", id: "msg_internal", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] }]
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    let seq = 0
    const send = (type, data) => res.write(`data: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`)
    const response = { id: `resp_${primary.length}`, object: "response", created_at: 1, model: "muse-spark-1.3", status: "in_progress", output: [] }
    send("response.created", { response })
    for (const [i, item] of output.entries()) {
      send("response.output_item.added", { output_index: i, item })
      send("response.output_item.done", { output_index: i, item })
    }
    send("response.completed", { response: { ...response, status: "completed", output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })
    res.end()
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const bridge = new MuseBridge({ workspace: directory, museBin: process.env.MUSE_TEST_BIN, museEnv,
    serveArgs: ["--model", "muse-spark-1.3", "-c", `endpoint_transport=${JSON.stringify({ base_url: `http://127.0.0.1:${server.address().port}/v1`, auth: "none" })}`],
    turnTimeoutMs: 15000,
  })
  t.after(async () => { await bridge.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }) })
  bridge.host.subscribe(n => { if (n.method === "approval/resolved") approvals.push(n.params) })
  const tools = [{ type: "function", function: { name: "fs/read.file", description: "Client file tool", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }]
  const messages = [{ role: "user", content: "Use the client file tool to read example.txt." }]
  const chat = () => bridge.fetch("http://muse-cli.invalid/v1/chat/completions", { method: "POST", headers: { "x-magpie-session": "real-cli" }, body: JSON.stringify({ model: "muse-spark-1.3", messages, tools }) })
  const first = await (await chat()).json()
  assert.equal(first.choices?.[0]?.finish_reason, "tool_calls", JSON.stringify(first))
  const call = first.choices[0].message.tool_calls[0]
  assert.equal(call.function.name, "fs/read.file")
  assert.deepEqual(JSON.parse(call.function.arguments), { path: "example.txt" })
  messages.push(first.choices[0].message, { role: "tool", tool_call_id: call.id, content: "ONLY_THE_CLIENT_PRODUCES_THIS_RESULT" })
  const last = await (await chat()).json()
  assert.equal(last.choices?.[0]?.message.content, "Verified client tool output.", JSON.stringify(last))
  assert.ok(outputs.some(o => JSON.stringify(o).includes("ONLY_THE_CLIENT_PRODUCES_THIS_RESULT")))
  assert.equal(bridge.sessions.size, 1)
  assert.ok(primary.length >= 2)
  assert.ok(primary.every(p => p.tools.every(group => group.name === "mcp__magpie_client")), "Main agent must be offered client tools only")
  assert.ok(approvals.some(a => a.decision === "approved"))
  assert.equal(approvals.some(a => a.decision === "approvedForSession" || a.decision === "approvedPolicyAmendment"), false)
})
