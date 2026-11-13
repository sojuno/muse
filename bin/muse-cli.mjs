#!/usr/bin/env node
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { MuseBridge } from "../src/bridge.mjs"

if (process.argv[2] !== "doctor") {
  console.error("Usage: magpie-muse-cli doctor [--live]\nSet MUSE_CLI_BIN to your Muse Code executable. --live spends a small amount of plan quota.")
  process.exitCode = 1
} else {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-muse-doctor-"))
  const live = process.argv.includes("--live")
  const bridge = new MuseBridge({ workspace, ...(live ? {} : { serveArgs: ["--provider", "echo"] }) })
  try {
    await bridge.start()
    const host = await bridge.host.start()
    console.log(`Executable: ${bridge.host.executable}`)
    console.log(`Muse ${host.initializeResult.serverInfo.version}; sessionMcp granted; ${live ? "live" : "offline echo"} mode`)
    if (host.fingerprintWarning) console.log("MSP schema fingerprint differs from the SDK baseline (compatibility warning, not a version rejection).")
    const res = await bridge.fetch("http://muse-cli.invalid/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: live ? "muse-spark-1.3" : "echo", messages: [{ role: "user", content: "Reply with just OK; do not call any tools." }] }),
      signal: AbortSignal.timeout(60000),
    })
    const body = await res.json()
    if (!res.ok || body.error) throw new Error(body.error?.message ?? `HTTP ${res.status}`)
    if (!body.choices?.[0]?.message?.content) throw new Error("Muse returned no text")
    console.log(`${live ? "Live sign-in" : "Real Muse echo turn"}: PASS`)
  } catch (e) { console.error(e.message); process.exitCode = 1 }
  finally { await bridge.close(); fs.rmSync(workspace, { recursive: true, force: true }) }
}
