// Responses compatibility helpers inherited from the reviewed original API adapter.
const DROP_FIELDS = ["generate", "prompt_cache_retention", "safety_identifier", "stream_options", "client_metadata"]


export function stripReasoningEncryptedContent(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body
  if (!Array.isArray(body.input)) return body
  let changed = false
  const input = body.input.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item
    if (item.type !== "reasoning" || !("encrypted_content" in item)) return item
    changed = true
    const { encrypted_content: _dropped, ...rest } = item
    return rest
  })
  return changed ? { ...body, input } : body
}

// dropBareReasoningItems removes every reasoning item that has nothing
// sealed in it (no encrypted_content) — unless the request asks the vendor
// to store the turn (store: true), in which case the vendor kept the items
// and a bare id resolves. A bare item is only a server-side reference: its
// summary is the model's notes to itself, which no model reads back, and
// when the vendor has nothing stored for the id the whole request goes
// back 400 "Referenced reasoning item 'rs_…' was not found or has
// expired". An old session collects one such item per turn, so dropping
// one per retry can never heal it — all of them go, up front, in one
// request. Sealed items (with encrypted_content) are kept: the 0.1.6
// retry still heals a blob sealed for another caller, and the retry loop
// below drops all reasoning the moment Meta names a dead item. Mirrors
// Magpie's own withoutBareReasoning (Codex backend, #1008), which the
// plugin path never went through.

export function dropBareReasoningItems(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body
  if (!Array.isArray(body.input)) return body
  if (body.store === true) return body
  let changed = false
  const input = body.input.filter((item) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item) && item.type === "reasoning" &&
        (typeof item.encrypted_content !== "string" || item.encrypted_content.trim() === "")) {
      changed = true
      return false
    }
    return true
  })
  return changed ? { ...body, input } : body
}

// dropAllReasoningItems removes every reasoning item from a Responses
// request body. The summaries are the model's notes to itself, and the
// text history (messages, tool calls and their results) stays, so the
// turn can still proceed — it just cannot replay any prior reasoning.
// Used only after Meta has already refused the request over a reasoning
// reference it cannot resolve: one dead reference per turn collects in
// an old session, and the id Meta names changes from attempt to attempt,
// so chasing them one by one never heals it.

export function dropAllReasoningItems(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body
  if (!Array.isArray(body.input)) return body
  let changed = false
  const input = body.input.filter((item) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item) && item.type === "reasoning") {
      changed = true
      return false
    }
    return true
  })
  return changed ? { ...body, input } : body
}

// parseReferencedReasoningId pulls the reasoning item id(s) out of Meta's
// "Referenced reasoning item '...' was not found or has expired." refusal.
// The quoted id can hold two tokens joined by ':' (rs_…:rs_…). The ids
// themselves are not acted on — the caller only needs to know the error
// is this refusal — but they are returned for the message. Returns null
// when the text is not that refusal.

export function parseReferencedReasoningId(errorText) {
  if (typeof errorText !== "string") return null
  const m = /Referenced reasoning item '([^']+)' was not found or has expired/i.exec(errorText)
  if (!m) return null
  const ids = m[1].split(":").map((s) => s.trim()).filter(Boolean)
  return ids.length ? ids : null
}

// isEncryptedContentCallerError is Meta's 400 when a Responses request
// replays a reasoning `encrypted_content` blob issued to another caller
// (another account/key). The blob is opaque — only Meta knows who it was
// issued to — so the rejection itself is the signal.

export function normalizeRequest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body
  const out = { ...body }
  for (const f of DROP_FIELDS) delete out[f]
  if (!("instructions" in out) || out.instructions == null) out.instructions = ""
  return out
}

// parseSubscriptionUsage validates and normalizes one `subscription`
// object from Meta's `response.subscription_usage` event. The event is
// the only place the allowance lives: `weekly` and `window` each carry
// `used_percent` (0-100) and `resets_at` (Unix seconds); the window also
// carries `window_duration_mins`. Returns null when nothing usable is
// in it. Pure: takes the parsed object, returns a normalized entry.
// (CLIProxyAPI knows the event too but strips it from the stream and
// never reads it — its Meta executor only counts tokens per request and
// reacts to a 429. There is no separate Meta usage endpoint to ask.)

export function parseSubscriptionUsage(subscription) {
  if (!subscription || typeof subscription !== "object" || Array.isArray(subscription)) return null
  const readWindow = (w) => {
    if (!w || typeof w !== "object" || Array.isArray(w)) return null
    const used = typeof w.used_percent === "number" && isFinite(w.used_percent) ? Math.max(0, w.used_percent) : null
    const resetsAt = typeof w.resets_at === "number" && isFinite(w.resets_at) && w.resets_at > 0
      ? new Date(w.resets_at * 1000).toISOString() : null
    const spanSecs = typeof w.window_duration_mins === "number" && isFinite(w.window_duration_mins) && w.window_duration_mins > 0
      ? w.window_duration_mins * 60 : null
    if (used === null && resetsAt === null) return null
    return { used, resetsAt, spanSecs }
  }
  const weekly = readWindow(subscription.weekly)
  const window = readWindow(subscription.window)
  if (!weekly && !window) return null
  return {
    tier: typeof subscription.tier === "string" && subscription.tier ? subscription.tier : null,
    weekly, window,
  }
}

// subscriptionWindows turns a cached subscription entry (from
// parseSubscriptionUsage) into the windows Magpie's `usage` hook returns:
// the 5-hour window and the weekly window, each with its used percent
// and reset time. Magpie's host turns `used` into the card's meter and
// routing reads the allowance from it; a window with no reading would
// show as "No allowance reported", so only windows with a reading are
// returned.

export function subscriptionWindows(cached) {
  if (!cached || typeof cached !== "object") return []
  const out = []
  if (cached.window) {
    const w = { name: "5-hour window", used: cached.window.used ?? null }
    if (cached.window.resetsAt) w.resetsAt = cached.window.resetsAt
    if (cached.window.spanSecs) w.span = cached.window.spanSecs
    out.push(w)
  }
  if (cached.weekly) {
    const w = { name: "Weekly", used: cached.weekly.used ?? null }
    if (cached.weekly.resetsAt) w.resetsAt = cached.weekly.resetsAt
    out.push(w)
  }
  return out
}

// subscriptionUsageStream returns a TransformStream that watches an SSE
// response body for Meta's `response.subscription_usage` event and records
// the latest subscription payload for the account (in `store`, keyed by
// `email`). Every chunk passes through unchanged — the plugin only
// observes, never filters — so the client still sees the event. Only
// `data:` lines mentioning "subscription" are parsed, and scanning stops
// after the first event (Meta sends one per response, first). A line may
// split across chunks, so lines are buffered until complete.
