import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFile } from "node:child_process"
import { spawnMspConnection } from "@muse-code/sdk"

export function findMuse(bin = "muse") {
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), path.join(os.homedir(), ".local/bin"), path.join(os.homedir(), ".muse/bin")]
  const found = bin.includes("/") ? path.resolve(bin) : dirs.map(d => path.join(d, bin)).find(p => {
    try { fs.accessSync(p, fs.constants.X_OK); return true } catch { return false }
  })
  const file = found ? path.resolve(found) : undefined
  try { if (!file) throw new Error(); fs.accessSync(file, fs.constants.X_OK) }
  catch { throw new Error("Muse CLI not found. Install Muse Code and run muse login, or set museBin in plugin options.") }
  try {
    const version = fs.readFileSync(path.join(path.dirname(file), ".muse-version"), "utf8").trim()
    if (/^[\w.+-]+$/.test(version)) {
      const actual = path.join(path.dirname(file), `muse-bin-${version}`)
      fs.accessSync(actual, fs.constants.X_OK)
      return actual
    }
  } catch {}
  return file
}

export class MuseHost {
  listeners = new Set()
  generation = 0
  constructor(options = {}) { this.options = options }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  emit(n) { for (const fn of this.listeners) fn(n) }
  async start() {
    this.pending ??= this.spawn().catch(e => { this.pending = null; throw e })
    return this.pending
  }
  async spawn() {
    this.dataDirectory ??= fs.mkdtempSync(path.join(os.tmpdir(), "magpie-muse-host-"))
    this.executable = findMuse(this.options.museBin ?? process.env.MUSE_CLI_BIN ?? "muse")
    const env = { ...process.env, XDG_DATA_HOME: this.dataDirectory, ...(this.options.museEnv ?? {}) }
    const cwd = this.options.hostDirectory ?? this.dataDirectory
    // Inspect configuration through the official CLI, without opening credential
    // files or starting MCP servers. Muse cannot remove inherited MCP entries
    // with a process-only override, so refuse mixing them with client tools.
    const listing = await new Promise((resolve, reject) => {
      execFile(this.executable, [...(this.options.museArgs ?? []), "mcp", "list", "--json"], { env, cwd, timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (error) reject(new Error("Gateway MCP isolation check failed. Run muse mcp list --json with this CLI/profile, then retry; no model turn was started."))
        else resolve(stdout)
      })
    })
    let servers
    try { servers = JSON.parse(listing).servers } catch {}
    if (!Array.isArray(servers)) throw new Error("Gateway MCP isolation check returned an unsupported format. Update this plugin/CLI; no model turn was started.")
    if (servers.some(server => server.enabled !== false && server.status !== "disabled")) {
      throw new Error("Gateway MCP isolation: this Muse profile has MCP servers configured. Put client MCP servers in your client (for example OpenCode), or select a Muse profile without gateway MCP servers. This bridge will not mix gateway tools with client tools. Existing settings and login were not changed.")
    }
    const handshake = spawnMspConnection({
      command: this.executable,
      args: [...(this.options.museArgs ?? []), "serve", "--preset", "empty", "--trust-workspace", "--disable-shell", "--disable-write", "--disable-request-user-input",
        "-c", 'run.reminder_roster={"agents":[]}',
        ...(typeof this.options.contributorMode === "boolean" ? ["--contributor-mode", this.options.contributorMode ? "on" : "off"] : []),
        ...(this.options.serveArgs ?? [])],
      env, cwd,
      shutdownTimeoutMs: 1000,
      onStderr: this.options.onStderr,
    })
    handshake.onNotification(n => this.emit(n))
    handshake.onServerRequest(async () => { throw new Error("Interactive dialogs must be handled in Muse CLI.") })
    let timer
    try {
      const spawned = await Promise.race([
        handshake.initialize({
          clientInfo: { name: "magpie_muse_cli", title: "Magpie Muse CLI bridge", version: "0.3.4" },
          capabilities: { requestedCapabilities: ["sessionMcp"], userInputDialogs: false },
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Muse CLI handshake timed out")), 20000) }),
      ])
      const { schema, serverInfo, grantedCapabilities } = spawned.initializeResult
      const identity = `Muse CLI ${serverInfo?.version ?? "(unknown version)"} (${this.executable})`
      // CLI release numbers are diagnostic metadata. MSP v1 allows additive
      // schema evolution; the SDK exposes a fingerprint change as a warning.
      if (schema?.version !== 1) {
        await spawned.close()
        throw new Error(`${identity} uses unsupported MSP envelope version ${schema?.version ?? "(missing)"}. Update this plugin/SDK or choose a compatible CLI with museBin.`)
      }
      if (!grantedCapabilities?.includes("sessionMcp")) {
        await spawned.close()
        throw new Error(`${identity} did not grant sessionMcp. Enable per-session MCP before using the client tool bridge.`)
      }
      this.generation++
      this.running = spawned
      void spawned.exited.then(() => {
        if (this.running !== spawned) return
        this.running = null; this.pending = null
        this.emit({ method: "bridge/hostExited", params: {} })
      })
      return spawned
    } catch (e) { await handshake.close(); throw e }
    finally { clearTimeout(timer) }
  }
  async command(method, params) { return (await this.start()).connection.command(method, params) }
  async request(method, params = {}) { return (await this.start()).connection.request(method, params) }
  async close() {
    const running = await this.pending?.catch(() => null)
    this.running = null; this.pending = null
    await running?.close()
    if (this.dataDirectory) fs.rmSync(this.dataDirectory, { recursive: true, force: true })
    this.dataDirectory = null
  }
}
