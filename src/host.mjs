import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { spawnMspConnection } from "@muse-code/sdk"

export function findMuse(bin = "muse") {
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), path.join(os.homedir(), ".local/bin"), path.join(os.homedir(), ".muse/bin")]
  const file = bin.includes("/") ? path.resolve(bin) : dirs.map(d => path.join(d, bin)).find(p => {
    try { fs.accessSync(p, fs.constants.X_OK); return true } catch { return false }
  })
  try { if (!file) throw new Error(); fs.accessSync(file, fs.constants.X_OK) }
  catch { throw new Error("Muse CLI not found. Install Muse Code 1.4.15 and run muse login, or set museBin in plugin options.") }
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
    const handshake = spawnMspConnection({
      command: findMuse(this.options.museBin ?? process.env.MUSE_CLI_BIN ?? "muse"),
      args: [...(this.options.museArgs ?? []), "serve", "--preset", "empty", "--trust-workspace", "--disable-shell", "--disable-write", "--disable-request-user-input",
        ...(typeof this.options.contributorMode === "boolean" ? ["--contributor-mode", this.options.contributorMode ? "on" : "off"] : []),
        ...(this.options.serveArgs ?? [])],
      env: { ...process.env, XDG_DATA_HOME: this.dataDirectory, ...(this.options.museEnv ?? {}) },
      cwd: this.options.hostDirectory,
      shutdownTimeoutMs: 1000,
      onStderr: this.options.onStderr,
    })
    handshake.onNotification(n => this.emit(n))
    handshake.onServerRequest(async () => { throw new Error("Interactive dialogs must be handled in Muse CLI.") })
    let timer
    try {
      const spawned = await Promise.race([
        handshake.initialize({
          clientInfo: { name: "magpie_muse_cli", title: "Magpie Muse CLI bridge", version: "0.3.0" },
          capabilities: { requestedCapabilities: ["sessionMcp"], userInputDialogs: false },
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Muse CLI handshake timed out")), 20000) }),
      ])
      if (!spawned.initializeResult.grantedCapabilities?.includes("sessionMcp")) {
        await spawned.close()
        throw new Error("Muse CLI did not grant sessionMcp. Enable per-session MCP before using the client tool bridge.")
      }
      if (!/^1\.4\.15(?:\D|$)/.test(spawned.initializeResult.serverInfo?.version ?? "")) {
        await spawned.close()
        throw new Error("This bridge is pinned to Muse CLI 1.4.15. Update the CLI/SDK together.")
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
