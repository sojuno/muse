// USD per 1M tokens, checked 2026-11-13 against Meta's public price table.
// Subscription allowance is not a per-request API invoice.
export const PRICE_SOURCE = "https://dev.meta.ai/products/meta-model-api/"
export const PRICE_CHECKED = "2026-11-13"

const spark = { input: 1.25, output: 4.25, cacheRead: 0.15 }
const contributor = { input: 0.10, output: 0.20, cacheRead: 0.002 }
const PUBLIC = {
  "muse-wonder-1.0": { input: 4, output: 20, cacheRead: 0.20 },
  "muse-spark-1.3": spark,
  "muse-spark-1.2": spark,
  "muse-spark-1.1": spark,
  "muse-spark-1.3-contributor": contributor,
  "muse-spark-1.2-contributor": contributor,
}

function rate(value, field) {
  if ((typeof value !== "number" && typeof value !== "string") || value === "" || !Number.isFinite(Number(value)) || Number(value) < 0) {
    throw new Error(`Invalid USD price for ${field}; use a nonnegative number per 1M tokens`)
  }
  return Number(value)
}

export function modelPrice(id, options = {}, cliCost) {
  let price = options.pricing?.[id]
  if (price === null) return undefined
  if (price === undefined && cliCost && (!cliCost.currency || cliCost.currency === "USD")) {
    price = { input: cliCost.input, output: cliCost.output, cacheRead: cliCost.cached }
  }
  price ??= options.referencePricing === false ? undefined : PUBLIC[id]
  if (!price) return undefined
  if (price.currency && price.currency !== "USD") throw new Error("Muse CLI model prices must be in USD")
  const input = rate(price.input, `${id}.input`)
  return {
    input, output: rate(price.output, `${id}.output`),
    cache: { read: rate(price.cacheRead ?? input, `${id}.cacheRead`), write: rate(price.cacheWrite ?? 0, `${id}.cacheWrite`) },
  }
}
