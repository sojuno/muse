import { MuseBridge } from "./src/bridge.mjs"
import { modelPrice } from "./src/pricing.mjs"

const ID = "muse-cli"
const BASE = "http://muse-cli.invalid/v1"
const FALLBACK = ["muse-wonder-1.0", "muse-wonder-full-1.0", "muse-spark-1.3", "muse-spark-1.2"]
// model/list returns the base names even in contributor mode. Publish aliases
// for known contributor families present in the account's base catalog, and
// keep their suffix on the model id actually selected in the CLI.
const CONTRIBUTOR = new Set(["muse-spark-1.3", "muse-spark-1.2"])
const withContributors = models => models.flatMap(m => CONTRIBUTOR.has(m.id)
  ? [m, { ...m, id: `${m.id}-contributor`, name: `${m.name ?? m.id} (Contributor)`, cost: null }]
  : [m])

// Magpie loads only this entry. The legacy OAuth implementation is not loaded
// and this plugin never reads, redeems, copies or persists a Meta credential.
export const MuseCLIPlugin = async (input, options = {}) => {
  const bridge = new MuseBridge({ ...options, contributorMode: false })
  let contributor
  const simple = m => {
    const cost = modelPrice(m.id, options, m.cost)
    return { name: m.name ?? m.id, reasoning: true, tool_call: true, attachment: true,
    modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: m.context ?? 1048576, output: m.output ?? 65536 },
    variants: Object.fromEntries((m.efforts?.length ? m.efforts : ["minimal", "low", "medium", "high", "xhigh", "max"]).map(e => [e, { reasoningEffort: e }])),
    ...(cost ? { cost } : {}),
  } }
  return {
    async config(config) {
      config.provider ??= {}
      config.provider[ID] ??= { name: "Muse CLI (API reference cost)", npm: "@ai-sdk/openai-compatible", api: BASE,
        models: Object.fromEntries(withContributors(FALLBACK.map(id => ({ id }))).map(m => [m.id, simple(m)])),
      }
    },
    provider: {
      id: ID,
      async models(provider) {
        const models = await bridge.models()
        if (!models.length) return provider.models
        return Object.fromEntries(withContributors(models).map(m => [m.id, {
          ...simple(m), id: m.id, api: { id: m.id, url: BASE, npm: "@ai-sdk/openai-compatible" },
          capabilities: { reasoning: true, toolcall: true, attachment: true, input: { text: true, image: true }, output: { text: true } },
          status: "active", headers: {}, options: {}, release_date: "",
        }]))
      },
    },
    auth: {
      provider: ID, single: true, maxConcurrency: 8,
      methods: [{ type: "oauth", label: "Use local Muse CLI sign-in", async authorize() {
        // This registers a local connection only, not an OAuth exchange. An
        // account check requires an actual turn and belongs to doctor --live.
        await bridge.host.start()
        return { method: "auto", instructions: "Linked to local Muse CLI. Authentication stays in Muse; run muse login there if needed.", callback: async () => ({ type: "success", key: "local-muse-cli", accountId: "local-muse-cli" }) }
      } }],
      async loader() { return { baseURL: BASE, apiKey: "local-muse-cli", async fetch(url, init) {
        let request, model
        try {
          request = new Request(url, init)
          model = (await request.clone().json()).model
        } catch { return Response.json({ error: { type: "muse_cli_error", message: "Invalid Muse CLI request JSON" } }, { status: 400 }) }
        if (typeof model === "string" && model.endsWith("-contributor")) {
          contributor ??= new MuseBridge({ ...options, contributorMode: true })
          return contributor.fetch(request)
        }
        return bridge.fetch(request)
      } } },
    },
    "chat.headers": async (req, out) => {
      if (req.model?.providerID !== ID) return
      if (req.sessionID) out.headers["x-muse-cli-session"] = req.sessionID
    },
    async dispose() { await Promise.all([bridge.close(), contributor?.close()]) },
  }
}
