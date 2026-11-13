import readline from "node:readline"
import fs from "node:fs"
import path from "node:path"

// Independent stdio MCP server. Only this client-side process reads the file;
// neither the bridge nor the scripted Muse host executes the client tool.
const root = fs.realpathSync(process.argv[2])
if (process.env.MCP_STARTUP_MARKER) fs.appendFileSync(process.env.MCP_STARTUP_MARKER, "started\n")
const lines = readline.createInterface({ input: process.stdin })
lines.on("close", () => process.exit(0))
lines.on("line", line => {
  const { id, method, params = {} } = JSON.parse(line)
  if (id === undefined) return
  const answer = data => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...data }) + "\n")
  if (method === "initialize") return answer({ result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "test-filesystem", version: "1" } } })
  if (method === "tools/list") return answer({ result: { tools: [{ name: "read_file", description: "Read a test file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] } })
  if (method === "tools/call") {
    try {
      if (params.name !== "read_file") throw new Error("Unknown tool")
      const file = fs.realpathSync(path.resolve(root, params.arguments.path))
      if (!file.startsWith(root + path.sep)) throw new Error("Outside test directory")
      return answer({ result: { content: [{ type: "text", text: fs.readFileSync(file, "utf8") }] } })
    } catch (e) { return answer({ result: { isError: true, content: [{ type: "text", text: e.message }] } }) }
  }
  answer({ error: { code: -32601, message: "Unknown method" } })
})
