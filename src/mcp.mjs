import http from "node:http"
import { randomBytes } from "node:crypto"

// The CLI is the MCP client. Every session gets an unguessable endpoint; no
// endpoint executes a tool locally. Its outstanding HTTP request is completed
// only when the original Magpie client supplies the corresponding tool result.
export class ToolServer {
  routes = new Map()
  async start() {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() })
    })
    this.server.requestTimeout = 0
    await new Promise((resolve, reject) => {
      this.server.once("error", reject)
      this.server.listen(0, "127.0.0.1", resolve)
    })
    this.base = `http://127.0.0.1:${this.server.address().port}`
    return this
  }
  register(session) {
    const route = `/mcp/${randomBytes(32).toString("hex")}`
    this.routes.set(route, session)
    return { url: this.base + route, remove: () => this.routes.delete(route) }
  }
  async handle(req, res) {
    const session = this.routes.get(req.url)
    if (!session || req.headers.origin || req.headers.host !== new URL(this.base).host) {
      res.writeHead(403); return res.end()
    }
    if (req.method === "DELETE") { res.writeHead(200); return res.end() }
    if (req.method !== "POST") { res.writeHead(405); return res.end() }
    let bytes = 0, chunks = []
    for await (const c of req) {
      bytes += c.length
      if (bytes > 2 * 1024 * 1024) { res.writeHead(413); return res.end() }
      chunks.push(c)
    }
    let msg
    try { msg = JSON.parse(Buffer.concat(chunks).toString()) } catch {
      res.writeHead(400); return res.end()
    }
    if (Array.isArray(msg) || msg?.jsonrpc !== "2.0") { res.writeHead(400); return res.end() }
    if (msg.id === undefined) { res.writeHead(202); return res.end() }
    const answer = (value) => {
      if (!res.destroyed) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...value }))
      }
    }
    try {
      let result
      if (msg.method === "initialize") result = {
        protocolVersion: "2025-03-26", capabilities: { tools: {} },
        serverInfo: { name: "magpie-muse-client-tools", version: "0.3.0" },
      }
      else if (msg.method === "ping") result = {}
      else if (msg.method === "tools/list") result = { tools: [...session.tools.values()].map(t => ({
        name: t.bridgeName, description: t.description, inputSchema: t.parameters,
      })) }
      else if (msg.method === "tools/call") result = await session.call(msg.params?.name, msg.params?.arguments ?? {})
      else return answer({ error: { code: -32601, message: "Unknown MCP method" } })
      answer({ result })
    } catch (e) { answer({ error: { code: -32000, message: e.message } }) }
  }
  async close() {
    this.routes.clear()
    if (!this.server) return
    this.server.closeAllConnections()
    await new Promise(resolve => this.server.close(resolve))
  }
}
