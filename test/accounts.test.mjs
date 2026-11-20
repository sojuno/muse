// Several accounts on one plugin instance, the way magpie runs them: each
// loader/model/usage/refresh call happens inside one account's scope, getAuth()
// returns that account, and client.auth.set saves to that same account. These
// tests hold the plugin to that contract: per-account signing, per-account
// renewal, and sign-in methods that name the account they add.
import test from "node:test"
import assert from "node:assert/strict"
import { MusePlugin } from "../plugin.mjs"
import { META_API_BASE } from "../src/api-transport.mjs"
import { MINT_URL } from "../oauth.mjs"

const oauthRecord = (email, dca, key, expires) => ({ type: "oauth", access: key, accountId: email,
  refresh: JSON.stringify({ version: 1, token: dca, tokenType: "Bearer", email }), expires })

// A stand-in for magpie's account scoping: `scope` names the account whose
// hooks are running (magpie sets this around each call), the slots hold each
// account's stored sign-in, and client.auth.set writes into the scoped slot.
function magpie(accounts) {
  const state = { scope: accounts[0].slot, saved: [] }
  for (const { slot, record } of accounts) state[slot] = record
  const client = { auth: { set: async ({ body }) => {
    state.saved.push({ scope: state.scope, body })
    state[state.scope] = { ...state[state.scope], ...body, type: "oauth" }
    return {}
  } } }
  return { state, client, inScope(slot, run) { const was = state.scope; state.scope = slot; return Promise.resolve(run()).finally(() => { state.scope = was }) } }
}

test("the auth hook allows several accounts and offers three ways to add one", async () => {
  const hooks = await MusePlugin({}, { request: async () => Response.json({}) })
  assert.equal(hooks.auth.provider, "muse")
  assert.equal(hooks.auth.single, undefined, "no single-account opt-out")
  assert.equal(hooks.auth.methods.length, 3)
  assert.equal(hooks.auth.methods[0].type, "oauth")
  assert.match(hooks.auth.methods[0].label, /device sign-in/)
  assert.equal(typeof hooks.auth.methods[0].authorize, "function")
  const importer = hooks.auth.methods[1]
  assert.equal(importer.type, "oauth")
  assert.equal(importer.prompts.length, 1)
  assert.equal(importer.prompts[0].key, "auth")
  assert.equal(importer.prompts[0].type, "password")
  assert.equal(typeof importer.prompts[0].validate, "function")
  assert.equal(typeof importer.authorize, "function")
  assert.equal(hooks.auth.methods[2].type, "api")
})

test("two accounts sign with their own keys and one renewal never writes the other's sign-in", async () => {
  const now = Date.now()
  // a starts with an expired minted key, so its first request renews it by
  // minting a fresh key from a's own DCA token; b is good as it is.
  const host = magpie([
    { slot: "a", record: oauthRecord("a@example.test", "dca:test-only-a", "test-only-key-a", now - 1000) },
    { slot: "b", record: oauthRecord("b@example.test", "dca:test-only-b", "test-only-key-b", now + 3600_000) },
  ])
  const sent = []
  const hooks = await MusePlugin({ client: host.client }, { request: async (url, init) => {
    if (url === MINT_URL) return Response.json({ api_key: "test-only-minted-" + host.state.scope, user_email: host.state.scope + "@example.test", is_subs_active: true })
    if (String(url).startsWith(META_API_BASE)) { sent.push({ scope: host.state.scope, authorization: init.headers.get("authorization") }); return Response.json({ output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }) }
    throw new Error("Unexpected request to " + url)
  } })
  const loaderOf = {}
  for (const slot of ["a", "b"]) loaderOf[slot] = await host.inScope(slot, () => hooks.auth.loader(async () => host.state[slot]))
  const ask = (slot) => host.inScope(slot, () => loaderOf[slot].fetch(META_API_BASE + "/responses", { method: "POST", body: JSON.stringify({ input: "two accounts", stream: false }) }))

  // a renews on its first request and serves with the key it minted; b serves
  // with the key it was signed in with. The renewal is saved through
  // client.auth.set, which lands in a's slot only.
  assert.equal((await ask("a")).status, 200)
  assert.equal((await ask("b")).status, 200)
  assert.deepEqual(sent.map(s => s.authorization), ["Bearer test-only-minted-a", "Bearer test-only-key-b"])
  assert.equal(host.state.saved.length, 1)
  assert.equal(host.state.saved[0].scope, "a")
  assert.match(host.state.saved[0].body.refresh, /dca:test-only-a/)
  assert.equal(host.state.b.access, "test-only-key-b")

  // A later request of a reuses its minted key without minting again, and b
  // keeps its own key and stored sign-in untouched.
  assert.equal((await ask("a")).status, 200)
  assert.equal((await ask("b")).status, 200)
  assert.deepEqual(sent.map(s => s.authorization), ["Bearer test-only-minted-a", "Bearer test-only-key-b", "Bearer test-only-minted-a", "Bearer test-only-key-b"])
  assert.equal(host.state.saved.length, 1)
  assert.equal(host.state.b.access, "test-only-key-b")
  assert.equal(host.state.saved[0].scope, "a")

  // The usage hook answers for whichever account's scope it runs in.
  assert.equal((await host.inScope("b", () => hooks.auth.usage(async () => host.state.b))).user, "b@example.test")
  assert.equal((await host.inScope("a", () => hooks.auth.usage(async () => host.state.a))).user, "a@example.test")
  hooks.dispose()
})

test("the import method mints and names the account by its email", async () => {
  const hooks = await MusePlugin({}, { request: async (url) => {
    if (url === MINT_URL) return Response.json({ api_key: "test-only-imported", user_email: "second@example.test", is_subs_active: true })
    throw new Error("Unexpected request to " + url)
  } })
  const importer = hooks.auth.methods[1]
  const file = JSON.stringify({ dca_token: "dca:test-only-second", user_email: "second@example.test" })
  assert.equal(importer.prompts[0].validate(file), null)
  assert.match(importer.prompts[0].validate("LLM|not-a-dca-token"), /DCA token/)
  const flow = await importer.authorize({ auth: file })
  assert.equal(flow.method, "auto")
  const result = await flow.callback()
  assert.equal(result.type, "success")
  assert.equal(result.access, "test-only-imported")
  assert.equal(result.accountId, "second@example.test", "the email names the account magpie keeps")
  hooks.dispose()
})
