# API reference pricing

These are **USD estimates at public API list prices**, not invoices or extra charges on a Muse Code subscription. Source: [Meta Model API — Models and pricing](https://dev.meta.ai/products/meta-model-api/), cross-checked with [Muse Spark](https://dev.meta.ai/models/muse-spark), on **2026-11-13**.

| Model | Input / 1M | Cached input / 1M | Output / 1M |
| --- | ---: | ---: | ---: |
| muse-wonder-1.0 | $4.00 | $0.20 | $20.00 |
| muse-spark-1.3 | $1.25 | $0.15 | $4.25 |
| muse-spark-1.3-contributor | $0.10 | $0.002 | $0.20 |
| muse-spark-1.2 | $1.25 | $0.15 | $4.25 |
| muse-spark-1.2-contributor | $0.10 | $0.002 | $0.20 |
| muse-spark-1.1 | $1.25 | $0.15 | $4.25 |

When the CLI catalog is available, its model list is used, plus the supported Spark contributor aliases. A fallback list can appear while discovery is unavailable. A price or fallback entry does not establish access to that model.

The CLI's current catalog returns `cost: null` for the tested account. The plugin supplies the dated public reference snapshot to Magpie's native pricing engine. If a future CLI supplies a USD catalog price it is preferred, unless an explicit per-model `pricing` override is configured.

```text
USD estimate = (
  uncached_input_tokens × input_price
  + cached_input_tokens × cached_input_price
  + output_tokens × output_price
) / 1,000,000
```

The API's prompt token total includes cache reads and writes. Magpie stores uncached input, cache read and cache write separately; the cached portion is not charged twice. Reasoning tokens are already contained in output tokens and are not added again. Token counters remain available with reference pricing disabled. The gateway regression verifies ledger token counts and cost arithmetic for ordinary and contributor Spark, including separate nonzero read/write splits across protocol conversions.

## Unpriced and tiered models

- **Muse Wonder Full 1.0:** Meta lists it as subscription-only, with no public per-token API price. The plugin supplies no invented price.
- **Muse Ember 1.0:** Meta publishes different rates below/above 200k context: input $0.10/$0.30, cache $0.004/$0.012, output $0.50/$1.50 per million tokens. Magpie's provider-plugin cost field accepts a flat price, not these context tiers, so the plugin deliberately leaves Ember unpriced by default. Use a native Magpie tiered-price setting if available, or an explicit flat override for a known workload; the latter is an approximation.
- Unknown models remain unpriced when neither the CLI nor an explicit override supplies a rate. An unavailable estimate must not be interpreted as free inference or free plan quota.

`pricing` overrides apply to exact model ids, including `-contributor`. Values must be nonnegative USD rates per million tokens. If an override omits `cacheRead`, cached input uses its input rate; omitted `cacheWrite` defaults to 0 (the tested CLI reports no separate cache-write count). Set an entry to `null` to opt that model out, or `referencePricing: false` to disable the bundled snapshot.

The estimate covers usage reported to the bridge for the routed turn. It is not a reconciliation of an entire Muse account, which can also have other CLI sessions and internal/background work.
