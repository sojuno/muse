import { createAPIProvider } from "./src/api-provider.mjs"

// Magpie calls named plugin exports. The default provider uses Meta's Responses
// API directly, preserving the client's prompts and client-owned tool execution.
export const MusePlugin = (input, options) => createAPIProvider(input, options)
