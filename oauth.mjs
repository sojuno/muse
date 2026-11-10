// Meta Muse (api.meta.ai) device-code OAuth + API-key minting, modelled on
// the Nous Portal plugin's auth module. The host owns persistence; this
// module never reads Meta's (or any other app's) credential files.
//
// Flow, as CLIProxyAPI's Go implementation proves it works:
//   1. POST auth.meta.com/oidc/device/authorization/ with Meta Muse CLI's
//      client_id -> device_code + user_code + verification URI.
//   2. Poll auth.meta.com/oidc/device/token/ (RFC 8628) until the user
//      approves in the browser -> DCA token (dca:...).
//   3. POST api.meta.ai/muse-code/key with the DCA token -> a real API key.
// The API key is the usable credential: it does not expire on the DCA
// timer, so the stored `expires` is the DCA deadline (the point after
// which a fresh key can no longer be minted and the user must sign in
// again), and `access` holds the API key.
//
// WARNING: this uses Meta Muse CLI's own OAuth client_id and user-agent to
// sign in outside the CLI, then calls Meta's Model API directly. Meta's
// terms say a Muse Code subscription is for use with the Muse Code CLI;
// this path carries the same ToS / account risk as CLIProxyAPI's Meta
// support, including a possible 403 client_attestation_denied if Meta
// tightens attestation. Prefer the `muse serve` path (opencode-muse) when
// that risk matters more than having a gateway-routable provider.
import { createHash } from "node:crypto"

export const ID = "muse"
export const AUTH_HOST = "https://auth.meta.com"
export const DEVICE_AUTH_URL = AUTH_HOST + "/oidc/device/authorization/"
export const TOKEN_URL = AUTH_HOST + "/oidc/device/token/"
export const MINT_URL = "https://api.meta.ai/muse-code/key"
export const API_BASE = "https://api.meta.ai/v1"
export const CLIENT_ID = "1031625952748946"
export const USER_AGENT = "muse-code/1.0.2"
// The build User-Agent the real CLI sends, captured from Muse Code
// 1.4.14-R7309.1 (build dec7d7497fecdad135ec5835a8161dbc92e55b58) on
// linux-x86_64 — the same values CLIProxyAPI v8.0.63 sends. The version
// and the build hash must move together: a new version with the old
// build's hash would be an inconsistent fingerprint. The platform is
// the host's own (CPA builds it from runtime.GOOS/GOARCH the same way);
// gateway requests are non-interactive, unlike the CLI's own terminal.
const META_CLIENT_VERSION = "1.4.14"
const META_CLIENT_BUILD = "dec7d7497fecdad135ec5835a8161dbc92e55b58"
function buildUserAgent() {
  const p = typeof process !== "undefined" ? process : {}
  let os = String(p.platform ?? "")
  if (os === "darwin") os = "macos"
  if (os === "win32") os = "windows"
  let arch = String(p.arch ?? "")
  if (arch === "x64" || arch === "amd64") arch = "x86_64"
  if (arch === "arm64") arch = "aarch64"
  if (!os) os = "linux"
  if (!arch) arch = "x86_64"
  return `muse-build/${META_CLIENT_VERSION} (non-interactive; ${os}-${arch}; build ${META_CLIENT_BUILD})`
}
export const BUILD_USER_AGENT = buildUserAgent()
export const CLIENT_HEADER = "tbh:exec"
export const GRANT = "urn:ietf:params:oauth:grant-type:device_code"
export const LEAD = 120000
export const MAX_POLL = 15 * 60 * 1000
const FALLBACK_LIFETIME = 60 * 60 * 1000
const DEAD = new Set(["invalid_grant", "invalid_token", "refresh_token_reused", "expired_token"])
const KNOWN = new Set([...DEAD, "access_denied", "authorization_pending", "slow_down", "invalid_client", "invalid_scope", "invalid_request"])
const text = (v) => typeof v === "string" ? v.trim() : ""
const positive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

export class AuthError extends Error {
  constructor(code, expired = false, status = 0) {
    // Never include a vendor's raw body, description, URL or token in an error.
    super(`Muse (Meta): ${code}${status ? ` (HTTP ${status})` : ""}. ${expired ? "Sign in again." : "Credentials kept; retry when the problem is resolved."}`)
    this.code = code
    this.signIn = expired ? "expired" : "kept"
  }
}

// metadata decodes the JSON kept in the stored sign-in's `refresh` field.
// Keep metadata in the standard refresh field, so hosts that keep only
// type/access/refresh/expires retain the DCA token and account details too.
export function metadata(auth) {
  try {
    const m = JSON.parse(auth.refresh)
    if (m?.version === 1 && text(m.token)) {
      return { ...m, baseURL: typeof m.baseURL === "string" && m.baseURL ? m.baseURL : API_BASE }
    }
  } catch {}
  throw new AuthError("unreadable_saved_sign_in")
}

function usable(a, now, lead = 0) {
  try {
    const m = metadata(a)
    return text(a.access) !== "" && text(m.token) !== "" &&
      positive(a.expires) && a.expires > now + lead
  } catch { return false }
}

function assertUsable(a, now, lead = 0) {
  if (!usable(a, now, lead)) throw new AuthError("unusable_sign_in")
}

function verificationURL(value) {
  try {
    const u = new URL(value)
    if (u.origin === AUTH_HOST && !u.username && !u.password && !u.hash) return u.href
  } catch {}
  throw new AuthError("invalid_verification_uri")
}

function transientStatus(status, headers) {
  return status === 408 || status === 429 || status >= 500 ||
    (status === 403 && headers?.has?.("x-vercel-mitigated"))
}

function refused(r, refreshing = false) {
  if (transientStatus(r.status, r.headers)) return new AuthError("temporarily_unavailable", false, r.status)
  const raw = text(r.body?.error)
  // A proxy or WAF can return 401/403 without the token endpoint seeing the
  // grant. Only an explicit OAuth code is evidence that the grant is dead.
  const code = KNOWN.has(raw) ? raw : "oauth_request_failed"
  return new AuthError(code, refreshing && DEAD.has(code), r.status)
}

function retryAfter(r, now) {
  const value = r.headers?.get?.("retry-after")
  if (!value) return 0
  const seconds = Number(value)
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - now) || 0
}

// mint exchanges a DCA token for an API key. Returns the minted key record
// plus the DCA deadline (ms epoch) the stored `expires` is derived from.
async function mint(dcaToken, request) {
  let res
  try {
    res = await request(MINT_URL, {
      method: "POST", redirect: "error",
      headers: {
        Accept: "application/json", "Content-Type": "application/json",
        Authorization: "Bearer " + dcaToken, "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ dca_token: dcaToken }),
      signal: AbortSignal.timeout(30000),
    })
  } catch { throw new AuthError("mint_endpoint_unavailable") }
  let body
  try { body = await res.json() } catch {}
  if (!res.ok || !object(body) || !text(body.api_key)) {
    if (transientStatus(res.status, res.headers)) throw new AuthError("temporarily_unavailable", false, res.status)
    throw new AuthError("mint_failed", res.status === 401 || res.status === 403, res.status)
  }
  return {
    apiKey: text(body.api_key),
    baseURL: typeof body.base_url === "string" && body.base_url ? body.base_url.replace(/\/$/, "") : API_BASE,
    email: text(body.user_email),
    name: text(body.user_full_name),
    tier: text(body.subs_tier_name),
    subsActive: body.is_subs_active === true,
  }
}

// horizon is the stored `expires` a successful mint earns. The minted API
// key is the usable credential, and minting proves the DCA token still
// works — even past the deadline Meta stamped on it at sign-in. The old
// code kept that stamped deadline after every mint, so once it passed,
// fresh() threw unusable_sign_in on every request although a fresh key
// had just been minted (seen live 09/11: sign-in worked at 23:55, then
// every request failed with unusable_sign_in until a fresh sign-in reset
// the deadline). Keep Meta's deadline while it is still ahead; past it
// (or within the refresh lead), the new key buys another FALLBACK_LIFETIME,
// and minting repeats hourly for as long as the DCA token works. Only a
// mint that actually fails with 401/403 ends the sign-in (mint_failed,
// "Sign in again").
function horizon(dcaExpiresAtMs, nowMs) {
  return positive(dcaExpiresAtMs) && dcaExpiresAtMs > nowMs + LEAD
    ? dcaExpiresAtMs
    : nowMs + FALLBACK_LIFETIME
}

// token builds the stored sign-in fields from a fresh DCA token + minted key.
function token(dca, minted, dcaExpiresAtMs, old) {
  const previous = old ? (() => { try { return metadata(old) } catch { return {} } })() : {}
  const expires = positive(dcaExpiresAtMs) ? dcaExpiresAtMs : Date.now() + FALLBACK_LIFETIME
  const m = {
    version: 1,
    token: dca,
    tokenType: "Bearer",
    baseURL: minted.baseURL || previous.baseURL || API_BASE,
    email: minted.email || previous.email || "",
    name: minted.name || previous.name || "",
    tier: minted.tier || previous.tier || "",
    subsActive: minted.subsActive ?? previous.subsActive ?? false,
  }
  return { access: minted.apiKey, refresh: JSON.stringify(m), expires }
}

export function createAuth(client, { now = Date.now, clock = () => performance.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), request = (...args) => fetch(...args) } = {}) {
  // Each fingerprint points at the SAME session through every known rotation.
  const sessions = new Map()
  const key = (a) => createHash("sha256").update(metadata(a).token).digest("hex")
  const session = (a) => {
    const k = key(a)
    if (!sessions.has(k)) sessions.set(k, { fields: { access: a.access, refresh: a.refresh, expires: a.expires } })
    return sessions.get(k)
  }
  const same = (a, b) => a?.type === b?.type && a?.access === b?.access && a?.refresh === b?.refresh

  async function postForm(url, form, timeout = 10000) {
    let res
    try {
      res = await request(url, {
        method: "POST", redirect: "error",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
        body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeout))),
      })
    } catch { throw new AuthError("token_endpoint_unavailable") }
    let body
    try { body = await res.json() } catch {}
    return { ok: res.ok && object(body) && !body.error, status: res.status, headers: res.headers, body }
  }

  // renew mints a fresh API key from the stored DCA token. Minting does not
  // rotate the DCA token, so the DCA deadline stays the sign-in's deadline.
  function renew(s) {
    if (s.pending) return s.pending
    if (s.error && now() < s.retryAt) return Promise.reject(s.error)
    s.pending = (async () => {
      await s.saving?.catch(() => {})
      const started = now()
      const m = metadata(s.fields)
      let minted
      try {
        minted = await mint(m.token, request)
      } catch (e) {
        if (e instanceof AuthError && e.signIn === "expired") throw e
        throw e
      }
      const got = token(m.token, minted, horizon(s.fields.expires, started), s.fields)
      // Record the rotated pair BEFORE persistence. A failed write must
      // never make the old key usable again.
      s.fields = got
      sessions.set(key(got), s)
      s.error = undefined
      if (!usable(got, now(), LEAD)) {
        s.error = new AuthError("unusable_sign_in")
        s.retryAt = now() + 30000
      }
      return got
    })().catch((e) => {
      s.error = e
      s.retryAt = e.signIn === "expired" ? Infinity : now() + 30000
      throw e
    }).finally(() => { s.pending = undefined })
    return s.pending
  }

  async function read(getAuth) {
    try { return await getAuth() } catch { throw new AuthError("could_not_read_sign_in") }
  }

  function persist(s, getAuth, was) {
    const saved = (s.saving ?? Promise.resolve()).catch(() => {}).then(async () => {
      const current = await read(getAuth)
      if (!same(current, was)) return undefined
      const fields = s.fields
      if (current.access === fields.access && current.refresh === fields.refresh && current.expires === fields.expires) return fields
      try {
        if (typeof client?.auth?.set !== "function") throw new Error()
        const r = await client.auth.set({ path: { id: ID }, body: { ...current, ...fields, type: "oauth" } })
        if (r?.error) throw new Error()
      } catch { throw new AuthError("could_not_save_rotated_token") }
      return fields
    })
    const finished = saved.finally(() => { if (s.saving === finished) s.saving = undefined })
    s.saving = finished
    return finished
  }

  async function fresh(getAuth, rejected) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const was = await read(getAuth)
      if (was?.type !== "oauth") throw new AuthError("not_signed_in", true)
      const s = session(was)
      let a = s.fields
      const force = rejected !== undefined && rejected === a.access
      if (force || !usable(a, now(), LEAD)) {
        try { a = await renew(s) } catch (e) {
          if (!same(await read(getAuth), was)) continue
          if (e.signIn === "expired" || force || !usable(a, now())) throw e
          // A temporary early-refresh outage does not kill a still-valid key.
        }
      }
      a = await persist(s, getAuth, was)
      if (!a) continue
      assertUsable(a, now())
      return { ...was, ...a, signIn: a.access !== was.access || a.refresh !== was.refresh ? "renewed" : "kept" }
    }
    throw new AuthError("sign_in_changed_during_refresh")
  }

  async function refresh(auth) {
    if (auth?.type !== "oauth") return undefined
    const s = session(auth)
    if (usable(s.fields, now(), LEAD)) return { ...s.fields }
    // The host, not this hook, persists the result with its account identity
    // guard. Return even an unusable successor so a rotated key is not lost.
    return { ...await renew(s) }
  }

  async function authorize() {
    const started = clock()
    const r = await postForm(DEVICE_AUTH_URL, { client_id: CLIENT_ID })
    if (!r.ok) throw refused(r)
    const b = r.body
    if (!text(b.device_code) || !text(b.user_code) || !positive(b.expires_in) ||
        (b.interval !== undefined && !positive(b.interval))) throw new AuthError("invalid_device_code_response")
    const plain = verificationURL(b.verification_uri)
    const url = b.verification_uri_complete ? verificationURL(b.verification_uri_complete) : plain
    const deadline = started + Math.min(b.expires_in * 1000, MAX_POLL)
    let interval = (b.interval ?? 5) * 1000
    let wait = interval
    let pending
    const poll = async () => {
      while (clock() < deadline) {
        // RFC 8628: the advertised interval is a minimum, including the first
        // poll. slow_down adds five seconds.
        await sleep(Math.min(wait, deadline - clock()))
        if (clock() >= deadline) break
        let answer
        const at = now()
        try {
          answer = await postForm(TOKEN_URL, { grant_type: GRANT, client_id: CLIENT_ID, device_code: b.device_code }, Math.min(10000, deadline - clock()))
        } catch (e) {
          if (e.code !== "token_endpoint_unavailable") throw e
          wait = Math.max(interval, wait * 2)
          continue
        }
        if (answer.ok) {
          const dca = text(answer.body.access_token)
          if (!dca) throw new AuthError("invalid_token_response")
          const dcaExpiresAtMs = positive(answer.body.expires_at)
            ? answer.body.expires_at * 1000
            : positive(answer.body.expires_in) ? at + answer.body.expires_in * 1000 : 0
          const minted = await mint(dca, request)
          const got = token(dca, minted, dcaExpiresAtMs, undefined)
          assertUsable(got, now(), LEAD)
          return { type: "success", ...got, ...(minted.email ? { accountId: minted.email } : {}) }
        }
        if (transientStatus(answer.status, answer.headers)) {
          wait = Math.max(interval, wait * 2, retryAfter(answer, now()))
          continue
        }
        if (answer.body?.error === "authorization_pending") { wait = interval; continue }
        if (answer.body?.error === "slow_down") { interval += 5000; wait = interval; continue }
        throw refused(answer)
      }
      throw new AuthError("expired_token")
    }
    return {
      url, method: "auto",
      instructions: `Sign in to Meta in your browser and confirm code ${b.user_code}. Finish any CAPTCHA in the browser. This finishes automatically.`,
      callback() {
        pending ??= poll().catch((e) => ({ type: "failed", error: e instanceof AuthError ? e.message : "Muse (Meta) sign-in failed; please retry." }))
        return pending
      },
    }
  }

  function current(auth) {
    if (auth?.type !== "oauth") throw new AuthError("not_signed_in", true)
    assertUsable(auth, now())
    return auth
  }
  return { authorize, refresh, fresh, current, read }
}
