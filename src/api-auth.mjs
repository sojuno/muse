import { createAuth, AuthError, DEVICE_AUTH_URL, TOKEN_URL, MINT_URL } from "../oauth.mjs"

export { USER_AGENT as API_USER_AGENT } from "../oauth.mjs"
import { USER_AGENT as API_USER_AGENT } from "../oauth.mjs"
const destinations = new Set([DEVICE_AUTH_URL, TOKEN_URL, MINT_URL])

// Reuse the tested device-grant/key-renewal engine, with an honest application
// identity and Meta's current key-exchange shape. Never read CLI credentials.
export function createAPIAuth(client, request = fetch) {
  const controllers = new Set()
  let generation = 0
  const send = (signal) => async (url, init = {}) => {
    if (!destinations.has(String(url))) throw new AuthError("refusing_auth_destination")
    signal?.throwIfAborted()
    const headers = new Headers(init.headers)
    headers.set("user-agent", API_USER_AGENT)
    headers.set("x-api-version", "1.0.0")
    headers.delete("x-client-id")
    return request(url, { ...init, headers, ...(String(url) === MINT_URL ? { body: "{}" } : {}),
      signal: signal ? AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]) : init.signal, redirect: "error" })
  }
  const engine = createAuth(client, { request: send() })
  return {
    ...engine,
    async authorize(_inputs, context = {}) {
      const own = ++generation
      for (const controller of controllers) controller.abort()
      const controller = new AbortController()
      controllers.add(controller)
      const abort = () => controller.abort()
      context.signal?.addEventListener("abort", abort, { once: true })
      if (context.signal?.aborted) abort()
      const sleep = ms => new Promise((resolve, reject) => {
        const fail = () => { clearTimeout(timer); reject(new AuthError("sign_in_cancelled")) }
        const timer = setTimeout(() => { controller.signal.removeEventListener("abort", fail); resolve() }, ms)
        controller.signal.addEventListener("abort", fail, { once: true })
        if (controller.signal.aborted) fail()
      })
      let flow
      try { flow = await createAuth(client, { request: send(controller.signal), sleep }).authorize() }
      catch (error) { controllers.delete(controller); throw error }
      finally { context.signal?.removeEventListener("abort", abort) }
      let pending
      return { ...flow, instructions: `${flow.instructions} This connects the subscription API; it does not change your Muse CLI login.`,
        callback(code, next = {}) {
          pending ??= (async () => {
            if (next.signal?.aborted || own !== generation) controller.abort()
            next.signal?.addEventListener("abort", abort, { once: true })
            try {
              if (controller.signal.aborted) return { type: "failed", error: "Muse sign-in cancelled or replaced." }
              const result = await flow.callback(code)
              return controller.signal.aborted || own !== generation ? { type: "failed", error: "Muse sign-in cancelled or replaced." } : result
            } finally { next.signal?.removeEventListener("abort", abort); controllers.delete(controller) }
          })()
          return pending
        },
      }
    },
    close() { generation++; for (const controller of controllers) controller.abort(); controllers.clear() },
  }
}
