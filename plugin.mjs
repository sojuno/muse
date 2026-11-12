import { MuseBridge } from "./src/bridge.mjs"

const ID = "muse-cli"
const BASE = "http://muse-cli.invalid/v1"
const FALLBACK = ["muse-wonder-1.0", "muse-wonder-full-1.0", "muse-spark-1.3", "muse-spark-1.2"]

// Magpie loads only this entry. The legacy OAuth implementation is not loaded
// and this plugin never reads, redeems, copies or persists a Meta credential.
export const MuseCLIPlugin = async (input, options = {}) => {
  const bridge = new MuseBridge(options)
  const simple = m => ({ name: m.name ?? m.id, reasoning: true, tool_call: true, attachment: true,
    modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: m.context ?? 1048576, output: m.output ?? 65536 },
    variants: Object.fromEntries((m.efforts?.length ? m.efforts : ["minimal", "low", "medium", "high", "xhigh", "max"]).map(e => [e, { reasoningEffort: e }])),
  })
  return {
    async config(config) {
      config.provider ??= {}
      config.provider[ID] ??= { name: "Muse CLI", npm: "@ai-sdk/openai-compatible", api: BASE,
        models: Object.fromEntries(FALLBACK.map(id => [id, simple({ id })])),
      }
    },
    provider: {
      id: ID,
      async models(provider) {
        const models = await bridge.models()
        if (!models.length) return provider.models
        return Object.fromEntries(models.map(m => [m.id, {
          ...simple(m), id: m.id, api: { id: m.id, url: BASE, npm: "@ai-sdk/openai-compatible" },
          capabilities: { reasoning: true, toolcall: true, attachment: true, input: { text: true, image: true }, output: { text: true } },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, status: "active", headers: {}, options: {}, release_date: "",
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
      async loader() { return { baseURL: BASE, apiKey: "local-muse-cli", fetch: (url, init) => bridge.fetch(url, init) } },
    },
    "chat.headers": async (req, out) => {
      if (req.model?.providerID !== ID) return
      if (req.sessionID) out.headers["x-muse-cli-session"] = req.sessionID
    },
    async dispose() { await bridge.close() },
  }
}
