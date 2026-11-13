// Offline tests for the import sign-in: paste a CLIProxyAPI Meta auth
// file (its whole JSON) or just its dca_token, and the plugin mints a
// fresh API key from that DCA token. Network is fully mocked.
// Run: node --test test/
import test from "node:test"
import assert from "node:assert/strict"
import { createAuth, parseImport, importProblem, AuthError } from "../oauth.mjs"

const stubClient = {
  auth: { set: async () => ({}) },
  app: { log: async () => {} },
  config: { get: async () => ({ data: {} }) },
}

const CPA_FILE = {
  type: "meta", auth_kind: "oauth",
  access_token: "LLM|test-minted-key", api_key: "LLM|test-minted-key",
  base_url: "https://api.meta.ai/v1", dca_token: "dca:test-dca-token",
  disabled: false, email: "file@example.com", has_payment_method: true,
  is_subs_active: true, last_refresh: "2026-11-10T10:00:00Z",
  name: "File User", subs_tier_id: "tier-123", subs_tier_name: "Pro",
  token_type: "Bearer",
}

const NATIVE_FILE = {
  providers: {
    meta: {
      access_token: "dca:native-dca-token", api_base_url: "https://api.meta.ai/v1",
      user_email: "native@example.com", user_full_name: "Native User",
    },
  },
}

test("parseImport: CLIProxyAPI flat JSON gives the DCA token + file metadata", () => {
  const { dca, meta } = parseImport(JSON.stringify(CPA_FILE))
  assert.equal(dca, "dca:test-dca-token")
  assert.equal(meta.email, "file@example.com")
  assert.equal(meta.name, "File User")
  assert.equal(meta.tier, "Pro")
  assert.equal(meta.subsActive, true)
  assert.equal(meta.baseURL, "https://api.meta.ai/v1")
})

test("parseImport: native nested Muse auth.json gives the DCA token from providers.meta", () => {
  const { dca, meta } = parseImport(JSON.stringify(NATIVE_FILE))
  assert.equal(dca, "dca:native-dca-token")
  assert.equal(meta.email, "native@example.com")
  assert.equal(meta.name, "Native User")
  assert.equal(meta.baseURL, "https://api.meta.ai/v1")
})

test("parseImport: bare DCA token passes through, metadata empty", () => {
  const { dca, meta } = parseImport("  dca:bare-token-123  ")
  assert.equal(dca, "dca:bare-token-123")
  assert.deepEqual(meta, {})
})

test("parseImport: bare API key is refused, not a DCA token", () => {
  assert.throws(() => parseImport("LLM|test-minted-key"), (e) => e instanceof AuthError && /not_a_dca_token/.test(e.message))
  assert.throws(() => parseImport("some-random-string"), /not_a_dca_token/)
})

test("parseImport: broken JSON, JSON without a DCA token, and empty paste are refused", () => {
  assert.throws(() => parseImport('{"type": "meta",'), /invalid_import_json/)
  assert.throws(() => parseImport(JSON.stringify({ type: "meta", api_key: "LLM|only-a-key" })), /no_dca_token_in_import/)
  assert.throws(() => parseImport("   "), /nothing_pasted/)
  assert.throws(() => parseImport(""), /nothing_pasted/)
})

test("parseImport: a paste wrapped in one pair of quotes still parses", () => {
  const { dca } = parseImport(`"${JSON.stringify(CPA_FILE)}"`)
  assert.equal(dca, "dca:test-dca-token")
  assert.equal(parseImport('"dca:quoted-token"').dca, "dca:quoted-token")
})

test("importProblem: null for a usable paste, plain words for a bad one", () => {
  assert.equal(importProblem(JSON.stringify(CPA_FILE)), null)
  assert.equal(importProblem("dca:bare-token-123"), null)
  assert.match(importProblem("LLM|test-minted-key"), /DCA token/)
  assert.match(importProblem('{"type": "meta",'), /JSON/)
  assert.match(importProblem(""), /Paste/)
})

function mintMock(mintBody, status = 200) {
  const calls = []
  const request = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes("/muse-code/key")) {
      return new Response(JSON.stringify(mintBody), { status, headers: { "Content-Type": "application/json" } })
    }
    throw new Error("unexpected URL " + url)
  }
  return { request, calls }
}

test("authorizeImport: whole JSON in, fresh key out, mint metadata wins", async () => {
  const { request, calls } = mintMock({ api_key: "key-fresh", base_url: "https://api.meta.ai/v1", user_email: "mint@example.com", user_full_name: "Mint User", subs_tier_name: "Ultra", is_subs_active: true })
  const auth = createAuth(stubClient, { request })
  const r = await auth.authorizeImport({ auth: JSON.stringify(CPA_FILE) })
  assert.equal(r.method, "auto")
  assert.match(r.instructions, /minting/)
  const done = await r.callback()
  assert.equal(done.type, "success")
  assert.equal(done.access, "key-fresh")
  assert.equal(done.accountId, "mint@example.com")
  assert.ok(done.expires > Date.now())
  assert.ok(done.expires <= Date.now() + 3600_000 + 5000)
  const meta = JSON.parse(done.refresh)
  assert.equal(meta.token, "dca:test-dca-token")
  assert.equal(meta.email, "mint@example.com") // mint's answer beats the file's
  assert.equal(meta.tier, "Ultra")
  assert.equal(calls.length, 1)
  const sent = JSON.parse(calls[0].init.body)
  assert.deepEqual(sent, {})
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer dca:test-dca-token")
})

test("authorizeImport: file metadata fills what the mint response does not say", async () => {
  const { request } = mintMock({ api_key: "key-fresh", base_url: "https://api.meta.ai/v1" })
  const auth = createAuth(stubClient, { request })
  const r = await auth.authorizeImport({ auth: JSON.stringify(CPA_FILE) })
  const done = await r.callback()
  assert.equal(done.type, "success")
  const meta = JSON.parse(done.refresh)
  assert.equal(meta.email, "file@example.com")
  assert.equal(meta.name, "File User")
  assert.equal(meta.tier, "Pro")
})

test("authorizeImport: bare DCA token imports with no file metadata", async () => {
  const { request } = mintMock({ api_key: "key-fresh", base_url: "https://api.meta.ai/v1", user_email: "mint@example.com", user_full_name: "Mint User", subs_tier_name: "Pro", is_subs_active: true })
  const auth = createAuth(stubClient, { request })
  const done = await (await auth.authorizeImport({ auth: "dca:bare-token-123" })).callback()
  assert.equal(done.type, "success")
  const meta = JSON.parse(done.refresh)
  assert.equal(meta.token, "dca:bare-token-123")
  assert.equal(meta.email, "mint@example.com")
})

test("authorizeImport: dead DCA token fails the mint and saves nothing", async () => {
  const { request } = mintMock({ error: "invalid_token" }, 401)
  const auth = createAuth(stubClient, { request })
  const r = await auth.authorizeImport({ auth: JSON.stringify(CPA_FILE) })
  await assert.rejects(() => r.callback(), (e) => e instanceof AuthError && /mint_failed/.test(e.message) && e.signIn === "expired")
})

test("authorizeImport: bad paste is refused before any mint", async () => {
  let minted = 0
  const request = async () => { minted++; throw new Error("must not mint") }
  const auth = createAuth(stubClient, { request })
  await assert.rejects(() => auth.authorizeImport({ auth: "LLM|test-minted-key" }), /not_a_dca_token/)
  await assert.rejects(() => auth.authorizeImport({ auth: "" }), /nothing_pasted/)
  assert.equal(minted, 0)
})
