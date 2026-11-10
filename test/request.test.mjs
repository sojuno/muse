// Offline tests for the thin request path: the gateway-built Responses
// request is signed, normalized and forwarded untouched; the answer
// passes back untouched. Network is fully mocked. Run: node --test test/
import test from "node:test"
import assert from "node:assert/strict"
import { MuseAuthPlugin, normalizeRequest } from "../index.mjs"

test("normalizeRequest: adds missing instructions, drops refused fields", () => {
  const out = normalizeRequest({
    model: "muse-spark-1.3", input: "hi", stream: true,
    client_metadata: { x: 1 }, prompt_cache_retention: "in-memory",
    safety_identifier: "s", stream_options: {}, generate: true,
  })
  assert.equal(out.instructions, "")
  assert.equal("client_metadata" in out, false)
  assert.equal("prompt_cache_retention" in out, false)
  assert.equal("safety_identifier" in out, false)
  assert.equal("stream_options" in out, false)
  assert.equal("generate" in out, false)
  assert.equal(out.model, "muse-spark-1.3")
  assert.equal(out.stream, true)
})

test("normalizeRequest: keeps an instructions that is there, keeps reasoning", () => {
  const out = normalizeRequest({
    model: "muse-wonder-1.0", input: [], instructions: "Behave.",
    reasoning: { effort: "high", summary: "auto" }, store: false,
  })
  assert.equal(out.instructions, "Behave.")
  assert.deepEqual(out.reasoning, { effort: "high", summary: "auto" })
  assert.equal(out.store, false)
})

const stubClient = {
  auth: { set: async () => ({}) },
  app: { log: async () => {} },
  config: { get: async () => ({ data: {} }) },
}

function fakeSignIn() {
  return {
    type: "oauth", access: "key-abc",
    refresh: JSON.stringify({ version: 1, token: "dca:token123", tokenType: "Bearer", baseURL: "https://api.meta.ai/v1", email: "a@b.c", name: "A B", tier: "Pro" }),
    expires: Date.now() + 3600_000,
  }
}

test("signedFetch: Responses request forwarded as-is, answer passed back", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const seen = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init })
    const done = {
      id: "resp_9", object: "response", created_at: 1700000001, status: "completed", model: "muse-spark-1.3",
      output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    }
    return new Response(JSON.stringify(done), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3", input: [{ role: "user", content: "hi" }], stream: false, store: false,
        reasoning: { effort: "high", summary: "auto" }, client_metadata: { agent: "x" },
      }),
    })
    assert.equal(res.status, 200)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, "https://api.meta.ai/v1/responses")
    const headers = new Headers(seen[0].init.headers)
    assert.equal(headers.get("Authorization"), "Bearer key-abc")
    assert.equal(headers.get("X-Client-Id"), "tbh:tui")
    assert.match(headers.get("User-Agent"), /muse-build/)
    const sent = JSON.parse(seen[0].init.body)
    assert.equal(sent.model, "muse-spark-1.3")
    assert.equal(sent.instructions, "")
    assert.equal("client_metadata" in sent, false)
    assert.deepEqual(sent.reasoning, { effort: "high", summary: "auto" })
    assert.equal(sent.store, false)
    const out = await res.json()
    assert.equal(out.status, "completed")
    assert.equal(out.output[0].content[0].text, "hello")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: stream passes through untouched", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    const sse = 'data: {"type":"response.output_text.delta","delta":"hello"}\n\n'
      + 'data: {"type":"response.completed","response":{"id":"resp_9","status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n'
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "muse-spark-1.3", input: "hi", stream: true }),
    })
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.match(text, /response\.output_text\.delta/)
    assert.match(text, /response\.completed/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: past DCA deadline still mints and serves (no unusable_sign_in)", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  let minted = 0
  globalThis.fetch = async (url, init) => {
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
    if (String(url).includes("/muse-code/key")) {
      minted++
      return json({ api_key: "key-fresh", base_url: "https://api.meta.ai/v1", user_email: "a@b.c", user_full_name: "A B", subs_tier_name: "Pro", is_subs_active: true })
    }
    return json({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] })
  }
  try {
    // A sign-in whose stamped DCA deadline passed an hour ago, while the
    // DCA token itself still mints (Meta accepts it past the stamped
    // deadline). Regression (seen live 09/11): renew() kept the stale
    // deadline, so fresh() threw unusable_sign_in on every request even
    // though a fresh key had just been minted.
    const stale = fakeSignIn()
    stale.expires = Date.now() - 3600_000
    const loader = await hooks.auth.loader(async () => stale)
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "muse-spark-1.3", input: "hi", stream: false }),
    })
    assert.equal(res.status, 200)
    assert.equal(minted, 1)
    const out = await res.json()
    assert.equal(out.output[0].content[0].text, "ok")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: 401 re-mints once and retries", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  let n = 0
  const keys = []
  globalThis.fetch = async (url, init) => {
    n++
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } })
    if (String(url).includes("/muse-code/key")) {
      return json({ api_key: "key-new", base_url: "https://api.meta.ai/v1", user_email: "a@b.c", user_full_name: "A B", subs_tier_name: "Pro", is_subs_active: true })
    }
    keys.push(new Headers(init.headers).get("Authorization"))
    if (n === 1) return new Response("", { status: 401 })
    return json({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "muse-wonder-1.0", input: "hi", stream: false }),
    })
    assert.equal(res.status, 200)
    const out = await res.json()
    assert.equal(out.output[0].content[0].text, "ok")
    assert.equal(n, 3) // 401, mint, retry
    assert.deepEqual(keys, ["Bearer key-abc", "Bearer key-new"])
    assert.equal(res.headers.get("X-Magpie-Sign-In"), "renewed")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: persistent 401 marks the sign-in expired", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes("/muse-code/key")) {
      return new Response(JSON.stringify({ api_key: "key-new", base_url: "https://api.meta.ai/v1" }), { status: 200, headers: { "Content-Type": "application/json" } })
    }
    return new Response("", { status: 401 })
  }
  try {
    const loader = await hooks.auth.loader(async () => fakeSignIn())
    const res = await loader.fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "muse-wonder-1.0", input: "hi", stream: false }),
    })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get("X-Magpie-Sign-In"), "expired")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("signedFetch: refuses foreign destinations", async () => {
  const hooks = await MuseAuthPlugin({ client: stubClient })
  const loader = await hooks.auth.loader(async () => fakeSignIn())
  await assert.rejects(
    () => loader.fetch("https://evil.test/v1/responses", { method: "POST", body: "{}" }),
    /refusing_inference_destination/,
  )
  await assert.rejects(
    () => loader.fetch("https://api.meta.ai/v1/chat/completions", { method: "POST", body: "{}" }),
    /refusing_inference_destination/,
  )
})
