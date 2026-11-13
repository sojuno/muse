import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { MuseBridge } from "../src/bridge.mjs"

test("official CLI refuses inherited gateway MCP before starting any server", { skip: !process.env.MUSE_TEST_BIN, timeout: 15000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "muse-global-mcp-isolation-"))
  const config = path.join(directory, "config", "muse")
  fs.mkdirSync(config, { recursive: true })
  const marker = path.join(directory, "gateway-server-started")
  const settings = JSON.stringify({ schema_version: 1, mcpServers: { gateway_trap: { type: "stdio", command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/filesystem-mcp.mjs", import.meta.url)), directory], env: { MCP_STARTUP_MARKER: marker }, mode: "required" } } })
  const settingsPath = path.join(config, "settings.json")
  fs.writeFileSync(settingsPath, settings)
  const bridge = new MuseBridge({ workspace: "/remote-client/project", museBin: process.env.MUSE_TEST_BIN,
    museEnv: { XDG_CONFIG_HOME: path.join(directory, "config"), XDG_DATA_HOME: path.join(directory, "data"), XDG_CACHE_HOME: path.join(directory, "cache"), META_API_KEY: "test-only-never-used" } })
  t.after(async () => { await bridge.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const response = await bridge.fetch("http://muse-cli.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "muse-spark-1.3", messages: [{ role: "user", content: "Do not execute gateway tools" }] }) })
  assert.equal(response.status, 503)
  assert.match((await response.json()).error.message, /Gateway MCP isolation/)
  assert.equal(bridge.host.generation, 0)
  assert.equal(fs.existsSync(marker), false, "Even gateway MCP startup hooks must not run")
  assert.equal(fs.readFileSync(settingsPath, "utf8"), settings, "Do not alter the user's MCP settings")
})

// This test uses the unmodified official Linux CLI, with a deterministic API on
// loopback. No Meta login, real credential or subscription quota is involved.
for (const { stream, contributorMode, baseModel, clientTools = false, denyShell = false } of [
  { stream: false, contributorMode: false, baseModel: "muse-spark-1.3" },
  { stream: true, contributorMode: false, baseModel: "muse-spark-1.3" },
  { stream: true, contributorMode: true, baseModel: "muse-spark-1.3" },
  { stream: true, contributorMode: true, baseModel: "muse-wonder-1.0" },
  { stream: true, contributorMode: false, baseModel: "muse-spark-1.3", clientTools: true },
  { stream: true, contributorMode: true, baseModel: "muse-wonder-1.0", clientTools: true, denyShell: true },
]) test(`official Muse CLI: MCP round trip (model=${baseModel}, stream=${stream}, contributor=${contributorMode}, clientTools=${clientTools}, denyShell=${denyShell})`, { skip: !process.env.MUSE_TEST_BIN, timeout: 30000 }, async t => {
  const model = `${baseModel}${contributorMode ? "-contributor" : ""}`
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "muse-real-cli-test-"))
  const clientDirectory = path.join(directory, "client-machine")
  fs.mkdirSync(clientDirectory)
  const clientLabel = `/remote-client/projects/${path.basename(directory)}`
  const operations = [
    { name: "write", args: { filePath: clientLabel + "/client-file.txt", content: "ORIGINAL_CLIENT_DATA" } },
    { name: "read", args: { filePath: clientLabel + "/client-file.txt" } },
    { name: "edit", args: { filePath: clientLabel + "/client-file.txt", oldString: "ORIGINAL", newString: "EDITED" } },
    { name: "bash", args: { command: "pwd > client-shell.txt", description: "Record the client working directory" } },
  ]
  for (const name of ["client-file.txt", "client-shell.txt"]) fs.writeFileSync(path.join(directory, name), "GATEWAY_UNTOUCHED")
  const museEnv = { XDG_CONFIG_HOME: path.join(directory, "config"), XDG_DATA_HOME: path.join(directory, "data"), XDG_CACHE_HOME: path.join(directory, "cache"), META_API_KEY: "test-only-local-backend" }
  const auth = spawnSync(process.env.MUSE_TEST_BIN, ["auth", "set", "--provider", "meta", "--api-key-stdin"], { input: "test-only-local-backend\n", env: { ...process.env, ...museEnv }, encoding: "utf8" })
  assert.equal(auth.status, 0, auth.stderr)
  const primary = [], outputs = [], approvals = [], internal = []
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    if (req.method === "GET") {
      res.setHeader("content-type", "application/json")
      return res.end(JSON.stringify({ object: "list", data: [{ id: baseModel, object: "model", owned_by: "meta", metadata: { "muse-code": { name: "Muse test model", family: "muse", is_hidden: false, attachment: true, reasoning: true, temperature: false, tool_call: true, modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 1048576, output: 65536 }, options: { include: [] }, variants: {} } } }] }))
    }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const group = (body.tools ?? []).find(t => t.name === "mcp__magpie_client")
    const results = (body.input ?? []).filter(i => i.type === "function_call_output")
    let output
    if (group) {
      primary.push(body); outputs.push(...results)
      if (clientTools && primary.length <= operations.length) {
        const operation = operations[primary.length - 1]
        const tool = group.tools.find(t => t.description?.includes(`CLIENT_TOOL_${operation.name}`))
        assert.ok(tool, `Only the client ${operation.name} schema may be selected`)
        output = [{ type: "function_call", id: `fc_step_${primary.length}`, call_id: `call_step_${primary.length}`, name: `${group.name}.${tool.name}`, arguments: JSON.stringify(operation.args), status: "completed" }]
      } else if (!results.length) output = group.tools.map((tool, i) => ({ type: "function_call", id: `fc_client_${i}`, call_id: `call_client_${i}`, name: `${group.name}.${tool.name}`, arguments: '{"path":"example.txt"}', status: "completed" }))
      else output = [{ type: "reasoning", id: "rs_final", summary: [{ type: "summary_text", text: "Checked the tool result." }] }, { type: "message", id: "msg_final", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Verified client tool output.", annotations: [] }] }]
    } else {
      internal.push(body)
      // The CLI may ask its own reminder child to submit a bookkeeping decision.
      const group = body.tools?.[0], name = group?.tools?.[0]?.name
      output = name === "submit_reminder_decision" ? [{ type: "function_call", id: "fc_reminder", call_id: "call_reminder", name: `${group.name}.${name}`, arguments: JSON.stringify({ decision: "none", reason: "No reminder needed", advisory_text: null, confidence: null, priority: null, skill_id: null, visible_for_steps: null }), status: "completed" }] : [{ type: "message", id: "msg_internal", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] }]
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    let seq = 0
    const send = (type, data) => res.write(`data: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`)
    const response = { id: `resp_${primary.length}`, object: "response", created_at: 1, model: body.model, status: "in_progress", output: [] }
    send("response.created", { response })
    for (const [i, item] of output.entries()) {
      send("response.output_item.added", { output_index: i, item })
      send("response.output_item.done", { output_index: i, item })
    }
    send("response.completed", { response: { ...response, status: "completed", output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } } })
    res.end()
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const bridge = new MuseBridge({ workspace: clientTools ? clientLabel : directory, museBin: process.env.MUSE_TEST_BIN, museEnv, contributorMode,
    serveArgs: ["--model", baseModel, "-c", `endpoint_transport=${JSON.stringify({ base_url: `http://127.0.0.1:${server.address().port}/v1`, auth: "none" })}`],
    turnTimeoutMs: 15000,
  })
  t.after(async () => { await bridge.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }) })
  bridge.host.subscribe(n => { if (n.method === "approval/resolved") approvals.push(n.params) })
  const tools = clientTools ? operations.map(operation => ({ type: "function", function: { name: operation.name, description: `CLIENT_TOOL_${operation.name}`, parameters: { type: "object", properties: Object.fromEntries(Object.keys(operation.args).map(key => [key, { type: "string" }])), required: Object.keys(operation.args) } } }))
    : ["fs/read.file", ...(stream ? ["mcp__filesystem__read_file"] : [])].map(name => ({ type: "function", function: { name, description: "Client file tool", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }))
  const messages = [{ role: "system", content: "CLIENT_SYSTEM_RULE: use the client's tools for client operations." },
    { role: "developer", content: [{ type: "text", text: "CLIENT_DEVELOPER_RULE: keep user instructions and tool result data separate." }] },
    { role: "user", content: "Use the client file tool to read example.txt." }]
  const chat = () => bridge.fetch("http://muse-cli.invalid/v1/chat/completions", { method: "POST", headers: { "x-magpie-session": "real-cli" }, body: JSON.stringify({ model, messages, tools, stream, reasoning_effort: "low" }) })
  const usages = []
  const read = async res => {
    if (!stream || !res.ok) return res.json()
    const message = { role: "assistant", content: "", reasoning_content: "" }, calls = []
    let finish_reason, usage
    for (const line of (await res.text()).split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue
      const chunk = JSON.parse(line.slice(6)); assert.equal(chunk.error, undefined, JSON.stringify(chunk))
      usage = chunk.usage ?? usage
      for (const choice of chunk.choices ?? []) {
        message.content += choice.delta.content ?? ""
        message.reasoning_content += choice.delta.reasoning_content ?? ""
        calls.push(...(choice.delta.tool_calls ?? []).map(({ index, ...call }) => call))
        finish_reason = choice.finish_reason ?? finish_reason
      }
    }
    if (calls.length) message.tool_calls = calls
    return { choices: [{ message, finish_reason }], usage }
  }
  let last, called = []
  const checkGateway = () => {
    for (const name of ["client-file.txt", "client-shell.txt"]) {
      assert.equal(fs.readFileSync(path.join(directory, name), "utf8"), "GATEWAY_UNTOUCHED")
      assert.equal(fs.existsSync(path.join(bridge.host.dataDirectory, name)), false)
      for (const session of bridge.sessions.values()) assert.equal(fs.existsSync(path.join(session.museWorkspace, name)), false)
    }
  }
  for (let step = 0; step < (clientTools ? 6 : 4); step++) {
    last = await read(await chat())
    if (last.usage) usages.push(last.usage)
    const choice = last.choices?.[0]
    assert.ok(choice, JSON.stringify(last))
    if (choice.finish_reason !== "tool_calls") break
    const calls = choice.message.tool_calls
    assert.ok(calls.length)
    messages.push(choice.message)
    for (const call of calls) {
      assert.ok(tools.some(t => t.function.name === call.function.name))
      const args = JSON.parse(call.function.arguments)
      called.push(call.function.name)
      if (!clientTools) {
        assert.deepEqual(args, { path: "example.txt" })
        messages.push({ role: "tool", tool_call_id: call.id, content: "ONLY_THE_CLIENT_PRODUCES_THIS_RESULT" })
        continue
      }
      checkGateway()
      const operation = operations[called.length - 1]
      assert.equal(call.function.name, operation.name)
      assert.deepEqual(args, operation.args, "Keep the client's original schema and arguments")
      let content, is_error = false
      const file = path.join(clientDirectory, "client-file.txt")
      if (operation.name === "write") { assert.equal(fs.existsSync(file), false); fs.writeFileSync(file, args.content); content = "CLIENT_WRITE_OK" }
      if (operation.name === "read") { content = fs.readFileSync(file, "utf8"); assert.equal(content, "ORIGINAL_CLIENT_DATA") }
      if (operation.name === "edit") { fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(args.oldString, args.newString)); content = "CLIENT_EDIT_OK" }
      if (operation.name === "bash") {
        if (denyShell) { content = "CLIENT_DENIED_BASH"; is_error = true }
        else {
          const shell = spawnSync("/bin/sh", ["-c", args.command], { cwd: clientDirectory, encoding: "utf8", timeout: 5000 })
          assert.equal(shell.status, 0, shell.stderr)
          assert.equal(fs.readFileSync(path.join(clientDirectory, "client-shell.txt"), "utf8").trim(), clientDirectory)
          content = "CLIENT_BASH_OK"
        }
      }
      messages.push({ role: "tool", tool_call_id: call.id, content, is_error })
      checkGateway()
    }
  }
  assert.deepEqual(called.sort(), tools.map(t => t.function.name).sort())
  assert.equal(last.choices?.[0]?.message.content, "Verified client tool output.", JSON.stringify(last))
  assert.equal(last.choices?.[0]?.message.reasoning_content, "Checked the tool result.", "Real CLI reasoning summaries must reach the client without duplication")
  if (clientTools) {
    assert.equal(fs.readFileSync(path.join(clientDirectory, "client-file.txt"), "utf8"), "EDITED_CLIENT_DATA")
    assert.equal(fs.existsSync(path.join(clientDirectory, "client-shell.txt")), !denyShell)
    assert.ok(outputs.some(o => JSON.stringify(o).includes(denyShell ? "CLIENT_DENIED_BASH" : "CLIENT_BASH_OK")))
    assert.ok(outputs.some(o => JSON.stringify(o).includes("ORIGINAL_CLIENT_DATA")))
    checkGateway()
  } else assert.ok(outputs.some(o => JSON.stringify(o).includes("ONLY_THE_CLIENT_PRODUCES_THIS_RESULT")))
  assert.equal(bridge.sessions.size, 1)
  assert.ok(primary.length >= 2)
  const sum = field => usages.reduce((n, usage) => n + field(usage), 0)
  assert.equal(sum(u => u.prompt_tokens), primary.length * 10, "Tool responses and final response must count every completion exactly once")
  assert.equal(sum(u => u.completion_tokens), primary.length * 5)
  assert.equal(sum(u => u.total_tokens), primary.length * 15)
  assert.equal(sum(u => u.prompt_tokens_details.cached_tokens), primary.length * 2)
  assert.equal(sum(u => u.prompt_tokens_details.cache_write_tokens), 0)
  assert.equal(sum(u => u.completion_tokens_details.reasoning_tokens), primary.length)
  assert.ok(primary.every(p => p.model === model), "The actual CLI wire request must retain the selected model, including its contributor suffix")
  assert.ok(primary.every(p => p.reasoning?.effort === "low"), "The selected reasoning effort must reach the real CLI model request")
  for (const request of primary) {
    const input = JSON.stringify(request.input)
    assert.equal(input.split("CLIENT_SYSTEM_RULE").length - 1, 1)
    assert.equal(input.split("CLIENT_DEVELOPER_RULE").length - 1, 1)
    assert.equal(String(JSON.stringify(request.instructions)).includes("CLIENT_SYSTEM_RULE"), false, "MSP carries client instructions as context; it does not replace Muse's system instructions")
  }
  assert.ok(primary.every(p => p.tools.every(group => group.name === "mcp__magpie_client")), "Main agent must be offered client tools only")
  assert.equal(internal.length, 0, "Reminder observers must not generate hidden model requests")
  assert.ok(approvals.some(a => a.decision === "approved"))
  assert.equal(approvals.some(a => a.decision === "approvedForSession" || a.decision === "approvedPolicyAmendment"), false)
})
