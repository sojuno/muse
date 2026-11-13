import test from "node:test"
import assert from "node:assert/strict"
import { createAPIAuth } from "../src/api-auth.mjs"
import { DEVICE_AUTH_URL, TOKEN_URL, MINT_URL } from "../oauth.mjs"

function service({ pending = false } = {}) {
  const calls = []
  const request = async (url, init) => {
    calls.push({ url, init })
    if (url === DEVICE_AUTH_URL) return Response.json({ device_code: "test-only-device", user_code: "TEST-CODE", verification_uri: "https://auth.meta.com/device", expires_in: 600, interval: 0.001 })
    if (url === TOKEN_URL) return pending ? Response.json({ error: "authorization_pending" }, { status: 400 }) : Response.json({ access_token: "dca:test-only", expires_in: 3600 })
    if (url === MINT_URL) return Response.json({ api_key: "test-only-minted", user_email: "test@example.test", is_subs_active: true })
    throw new Error("Unexpected auth destination")
  }
  return { calls, request }
}

test("API OAuth uses the published device grant and an honest application identity", async () => {
  const mock = service(), auth = createAPIAuth(undefined, mock.request)
  const flow = await auth.authorize()
  assert.equal(new URL(flow.url).hostname, "auth.meta.com")
  const result = await flow.callback()
  assert.equal(result.type, "success")
  assert.equal(result.access, "test-only-minted")
  assert.deepEqual(mock.calls.map(c => c.url), [DEVICE_AUTH_URL, TOKEN_URL, MINT_URL])
  for (const { init } of mock.calls) {
    assert.equal(init.headers.get("user-agent"), "magpie-muse/0.4.0")
    assert.equal(init.headers.get("x-api-version"), "1.0.0")
    assert.equal(init.headers.get("x-client-id"), null)
    assert.equal(init.redirect, "error")
  }
  assert.equal(mock.calls[2].init.body, "{}", "Account token stays in Authorization, not a copied CLI credential document")
  auth.close()
})

test("an already cancelled sign-in makes no device request", async () => {
  const mock = service(), auth = createAPIAuth(undefined, mock.request)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(auth.authorize({}, { signal: controller.signal }))
  assert.equal(mock.calls.length, 0)
  auth.close()
})

test("cancellation while polling stops the flow without saving an account", async () => {
  const mock = service({ pending: true }), auth = createAPIAuth(undefined, mock.request)
  const flow = await auth.authorize(), controller = new AbortController()
  const result = flow.callback(undefined, { signal: controller.signal })
  setTimeout(() => controller.abort(), 10)
  assert.equal((await result).type, "failed")
  const requests = mock.calls.length
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(mock.calls.length, requests)
  assert.equal(mock.calls.some(c => c.url === MINT_URL), false)
  auth.close()
})

test("Magpie's completed authorize context does not cancel the callback context", async () => {
  const mock = service(), auth = createAPIAuth(undefined, mock.request), initial = new AbortController()
  const flow = await auth.authorize({}, { signal: initial.signal })
  initial.abort()
  assert.equal((await flow.callback()).type, "success")
  auth.close()
})

test("a replaced sign-in cannot finish as a stale successful account", async () => {
  const mock = service(), auth = createAPIAuth(undefined, mock.request)
  const old = await auth.authorize(), current = await auth.authorize()
  assert.equal((await old.callback()).type, "failed")
  assert.equal((await current.callback()).type, "success")
  assert.equal(mock.calls.filter(c => c.url === MINT_URL).length, 1)
  auth.close()
})
