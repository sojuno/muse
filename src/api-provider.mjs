import { createHash } from "node:crypto"
import { createAPIAuth, API_USER_AGENT } from "./api-auth.mjs"
import { createAPITransport, META_API_BASE, validateAPIBase } from "./api-transport.mjs"
import { metadata, AuthError } from "../oauth.mjs"
import { parseSubscriptionUsage, subscriptionWindows } from "./responses-compat.mjs"
import { modelPrice } from "./pricing.mjs"

const ID = "muse"
const NPM = "@ai-sdk/openai"
const FALLBACK = ["muse-wonder-1.0", "muse-wonder-full-1.0", "muse-spark-1.3", "muse-spark-1.2", "muse-ember-1.0"]
const CONTRIBUTORS = new Set(["muse-wonder-1.0", "muse-wonder-full-1.0", "muse-spark-1.3", "muse-spark-1.2"])
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"]
const accountKey = auth => createHash("sha256").update(auth.access).digest("hex")

export async function createAPIProvider(input = {}, options = {}) {
  const request = typeof options.request === "function" ? options.request : fetch
  const baseURL = validateAPIBase(options.localTestBackend ? options.baseURL : META_API_BASE, options.localTestBackend)
  const auth = createAPIAuth(input.client, request)
  const usage = new Map()
  const discoveries = new Map()
  const credential = async (getAuth, rejected) => {
    const saved = await auth.read(getAuth)
    if (saved?.type === "api" && typeof saved.key === "string" && saved.key.trim()) return { type: "api", access: saved.key }
    if (saved?.type !== "oauth") throw new AuthError("not_signed_in", true)
    return auth.fresh(getAuth, rejected)
  }
  const rows = models => {
    const present = new Set(models.map(m => m.id))
    return models.flatMap(m => CONTRIBUTORS.has(m.id) && !present.has(m.id + "-contributor")
      ? [m, { ...m, id: m.id + "-contributor", name: (m.name ?? m.id) + " (Contributor)", cost: null }]
      : [m])
  }
  const entry = m => {
    const variants = Object.fromEntries((m.efforts?.length ? m.efforts : EFFORTS).map(e => [e, { reasoningEffort: e }]))
    const cost = modelPrice(m.id, { referencePricing: false, ...options }, m.cost)
    return { id: m.id, name: m.name ?? m.id, api: { id: m.id, url: baseURL, npm: NPM },
      limit: { context: m.context ?? 1048576, output: m.output ?? 65536 }, reasoning: true, tool_call: true, attachment: true,
      modalities: { input: ["text", "image"], output: ["text"] }, variants, status: "active", headers: {}, options: {}, release_date: "",
      capabilities: { temperature: false, reasoning: true, attachment: true, toolcall: true, input: { text: true, image: true }, output: { text: true } },
      ...(cost ? { cost } : {}),
    }
  }
  const catalog = models => Object.fromEntries(rows(models ?? FALLBACK.map(id => ({ id }))).map(m => [m.id, entry(m)]))
  return {
    config(config) {
      config.provider ??= {}
      config.provider[ID] ??= { name: "Muse (Subscription API)", npm: NPM, api: baseURL, models: catalog() }
    },
    provider: {
      id: ID,
      async models(provider, { auth: saved } = {}) {
        const key = saved?.type === "api" ? saved.key : saved?.type === "oauth" ? saved.access : undefined
        const account = typeof key === "string" ? accountKey({ access: key }) : undefined
        let discovered = account ? discoveries.get(account) : undefined
        if (key) {
          if (baseURL !== META_API_BASE && !key.startsWith("test-only")) throw new Error("Local test model discovery only accepts dummy credentials")
          try {
            const response = await request(baseURL.replace(/\/$/, "") + "/models", { headers: { authorization: "Bearer " + key, "user-agent": API_USER_AGENT, "x-api-version": "1.0.0" }, signal: AbortSignal.timeout(3000), redirect: "error" })
            const data = response.ok ? (await response.json()).data : undefined
            if (Array.isArray(data) && data.length) discovered = data.filter(m => typeof m.id === "string").map(m => {
              const meta = m.metadata?.["muse-code"] ?? m.metadata ?? {}
              return { id: m.id, name: meta.name ?? m.id, context: meta.limit?.context, output: meta.limit?.output, efforts: meta.variants ? Object.keys(meta.variants) : undefined }
            })
            if (discovered?.length) discoveries.set(account, discovered)
          } catch { /* Keep a usable catalog during an unavailable discovery endpoint. */ }
        }
        return catalog(discovered)
      },
    },
    auth: {
      provider: ID, single: true, maxConcurrency: 8, refreshLead: 120000,
      refresh: auth.refresh,
      methods: [
        { type: "oauth", label: "Muse subscription — device sign-in", authorize: auth.authorize },
        { type: "api", label: "Existing Meta/Muse API key" },
      ],
      async loader(getAuth) {
        return { baseURL, apiKey: "muse-api-private", fetch: createAPITransport({
          credential: () => credential(getAuth), renew: rejected => credential(getAuth, rejected), request, baseURL, localTestBackend: options.localTestBackend,
          onEvent(value, current) {
            const snapshot = value.type === "response.subscription_usage" ? parseSubscriptionUsage(value.subscription) : null
            if (snapshot) usage.set(accountKey(current), snapshot)
          },
        }) }
      },
      async usage(getAuth) {
        const saved = await auth.read(getAuth)
        const key = saved?.type === "api" ? saved.key : saved?.access
        const details = saved?.type === "oauth" ? metadata(saved) : {}
        const windows = key ? subscriptionWindows(usage.get(accountKey({ access: key }))) : []
        return { ...(details.tier ? { plan: details.tier } : {}), ...(details.email ? { user: details.email } : {}), ...(windows.length ? { windows } : {}) }
      },
    },
    dispose() { auth.close(); usage.clear(); discoveries.clear() },
  }
}
