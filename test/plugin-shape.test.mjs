// Offline tests for the plugin shape and the Meta device-code sign-in.
// Network is fully mocked. Run: node --test test/
import test from "node:test"
import assert from "node:assert/strict"
import { MuseAuthPlugin } from "../index.mjs"
import { createAuth } from "../oauth.mjs"

const stubClient = {
  auth: { set: async () => ({}) },
  app: { log: async () => {} },
  config: { get: async () => ({ data: {} }) },
}

test("plugin shape: config gives provider muse (Responses) with simple models", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  assert.equal(hooks.auth.provider, "muse")
  assert.equal(hooks.auth.methods.length, 1)
  assert.equal(hooks.auth.methods[0].type, "oauth")
  assert.equal(typeof hooks.auth.methods[0].authorize, "function")
  assert.equal(typeof hooks.auth.loader, "function")
  assert.equal(typeof hooks.auth.refresh, "function")
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const p = cfg.provider.muse
  assert.equal(p.npm, "@ai-sdk/openai")
  assert.equal(p.api, "https://api.meta.ai/v1")
  assert.equal(p.searches, true)
  const ids = Object.keys(p.models)
  assert.equal(ids.length, 9) // 5 base + 4 contributor (spark-1.1 has none)
  assert.ok(ids.includes("muse-wonder-full-1.0"))
  assert.ok(ids.includes("muse-spark-1.3-contributor"))
  assert.ok(!ids.includes("muse-spark-1.1-contributor"))
  const spark = p.models["muse-spark-1.3"]
  assert.equal(spark.limit.context, 1048576)
  assert.equal(spark.reasoning, true)
  assert.equal(spark.tool_call, true)
  assert.deepEqual(spark.modalities.input, ["text", "image"])
  assert.deepEqual(Object.keys(spark.variants), ["minimal", "low", "medium", "high", "xhigh", "max"])
  assert.equal(spark.variants.high.reasoningEffort, "high")
  assert.equal("cost" in spark, false) // a plan: leave cost out
})

test("provider.models returns the full OpenCode Model shape", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const provider = { id: "muse", models: {} }
  const out = await hooks.provider.models(provider, { auth: { type: "oauth" } })
  assert.equal(Object.keys(out).length, 9)
  const wonder = out["muse-wonder-1.0"]
  assert.equal(wonder.api.npm, "@ai-sdk/openai")
  assert.equal(wonder.api.url, "https://api.meta.ai/v1")
  assert.equal(wonder.limit.output, 128000)
  assert.equal(wonder.capabilities.reasoning, true)
  assert.equal(wonder.capabilities.input.audio, true)
  assert.equal(wonder.capabilities.input.video, true)
  const bootstrap = await hooks.provider.models(provider, { auth: undefined })
  assert.deepEqual(bootstrap, {})
})

test("authorize: device code -> poll pending -> token -> mint -> success", async () => {
  let fakeNow = 1_000_000
  const calls = []
  const mockFetch = async (url, init) => {
    calls.push(String(url))
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
    if (String(url).includes("/oidc/device/authorization/")) {
      return json({ device_code: "dev1", user_code: "USER-CODE", verification_uri: "https://auth.meta.com/oidc/device/authorization/", verification_uri_complete: "https://auth.meta.com/oidc/device/authorization/?user_code=USER-CODE", expires_in: 900, interval: 1 })
    }
    if (String(url).includes("/oidc/device/token/")) {
      if (calls.filter((u) => u.includes("/oidc/device/token/")).length === 1) {
        return json({ error: "authorization_pending" }, 400)
      }
      return json({ access_token: "dca:token123", token_type: "Bearer", expires_in: 3600, expires_at: Math.floor(fakeNow / 1000) + 3600 })
    }
    if (String(url).includes("/muse-code/key")) {
      return json({ api_key: "key-abc", base_url: "https://api.meta.ai/v1", user_email: "a@b.c", user_full_name: "A B", subs_tier_name: "Pro", is_subs_active: true })
    }
    throw new Error("unexpected URL " + url)
  }
  const auth = createAuth(stubClient, {
    now: () => fakeNow,
    clock: () => fakeNow,
    sleep: async (ms) => { fakeNow += ms },
    request: mockFetch,
  })
  const r = await auth.authorize()
  assert.equal(r.method, "auto")
  assert.match(r.instructions, /USER-CODE/)
  assert.match(r.url, /auth\.meta\.com/)
  const done = await r.callback()
  assert.equal(done.type, "success")
  assert.equal(done.access, "key-abc")
  assert.equal(done.accountId, "a@b.c")
  assert.ok(done.expires > fakeNow)
  const meta = JSON.parse(done.refresh)
  assert.equal(meta.token, "dca:token123")
  assert.equal(meta.email, "a@b.c")
  assert.equal(meta.tier, "Pro")
})
