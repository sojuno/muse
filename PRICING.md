# Optional API reference pricing

The v0.4.0 API provider defaults to **token-only reporting** (`referencePricing: false`). No USD rate is supplied unless reference pricing is explicitly enabled or an exact per-model override is configured. A missing estimate does not mean inference is free.

These are **USD estimates at public API list prices**, not invoices or extra charges on a Muse Code subscription. Source: [Meta Model API — Models and pricing](https://dev.meta.ai/products/meta-model-api/), cross-checked with [Muse Spark](https://dev.meta.ai/models/muse-spark), on **2026-11-13**.

| Model | Input / 1M | Cached input / 1M | Output / 1M |
| --- | ---: | ---: | ---: |
| muse-wonder-1.0 | $4.00 | $0.20 | $20.00 |
| muse-spark-1.3 | $1.25 | $0.15 | $4.25 |
| muse-spark-1.3-contributor | $0.10 | $0.002 | $0.20 |
| muse-spark-1.2 | $1.25 | $0.15 | $4.25 |
| muse-spark-1.2-contributor | $0.10 | $0.002 | $0.20 |
| muse-spark-1.1 | $1.25 | $0.15 | $4.25 |

When API model discovery is available, its model list is used, plus supported Wonder/Spark Contributor aliases. A fallback list can appear while discovery is unavailable. A price or fallback entry does not establish access to that model.

Enable the dated snapshot in the installed plugin's Options with `{ "referencePricing": true }`. Alternatively supply a `pricing` map of exact model ids to rates. These optional rates feed Magpie's native pricing engine; they are separate from subscription allowance.

```text
USD estimate = (
  uncached_input_tokens × input_price
  + cached_input_tokens × cached_input_price
  + output_tokens × output_price
) / 1,000,000
```

The API's prompt token total includes cache reads and writes. Magpie stores uncached input, cache read and cache write separately; the cached portion is not charged twice. Reasoning tokens are already contained in output tokens and are not added again. Token counters remain available with reference pricing disabled. Current API gateway tests verify the token splits; pricing-unit and archived CLI-gateway tests also verify the optional cost arithmetic.

## Unpriced and tiered models

- **Muse Wonder Full 1.0:** Meta lists it as subscription-only, with no public per-token API price. The plugin supplies no invented price.
- **Muse Wonder 1.0 Contributor:** no rate is included in the bundled snapshot. Its token counters work independently of prices; it does not inherit ordinary Wonder's reference rate. An explicit user override can supply a rate.
- **Muse Ember 1.0:** Meta publishes different rates below/above 200k context: input $0.10/$0.30, cache $0.004/$0.012, output $0.50/$1.50 per million tokens. Magpie's provider-plugin cost field accepts a flat price, not these context tiers, so the plugin deliberately leaves Ember unpriced by default. Use a native Magpie tiered-price setting if available, or an explicit flat override for a known workload; the latter is an approximation.
- Unknown models remain unpriced when no explicit override supplies a rate. An unavailable estimate must not be interpreted as free inference or free plan quota.

`pricing` overrides apply to exact model ids, including `-contributor`. Values must be nonnegative USD rates per million tokens. If an override omits `cacheRead`, cached input uses its input rate; omitted `cacheWrite` defaults to 0 (the live API tests reported no separate cache-write count). Set an entry to `null` to opt that model out, and leave `referencePricing: false` to keep the bundled snapshot disabled.

The estimate covers usage reported to the bridge for the routed turn. It is not a reconciliation of an entire Muse account, which can also have other clients and background work.
