import test from "node:test"
import assert from "node:assert/strict"
import { modelPrice, PRICE_SOURCE } from "../src/pricing.mjs"

test("Meta public reference prices distinguish regular and contributor Spark", () => {
  assert.equal(PRICE_SOURCE, "https://dev.meta.ai/products/meta-model-api/")
  assert.deepEqual(modelPrice("muse-spark-1.3"), { input: 1.25, output: 4.25, cache: { read: 0.15, write: 0 } })
  assert.deepEqual(modelPrice("muse-spark-1.3-contributor"), { input: 0.10, output: 0.20, cache: { read: 0.002, write: 0 } })
})

test("subscription-only and tiered models receive no invented flat price", () => {
  assert.equal(modelPrice("muse-wonder-full-1.0"), undefined)
  assert.equal(modelPrice("muse-ember-1.0"), undefined)
  assert.equal(modelPrice("unknown-model"), undefined)
})

test("USD prices declared by the CLI take precedence over the reference snapshot", () => {
  assert.deepEqual(modelPrice("muse-spark-1.3", {}, { currency: "USD", input: "2", output: "8", cached: "0.5" }), { input: 2, output: 8, cache: { read: 0.5, write: 0 } })
})

test("explicit per-model pricing overrides and opt-out are honored", () => {
  assert.equal(modelPrice("muse-spark-1.3", { referencePricing: false }), undefined)
  assert.equal(modelPrice("muse-spark-1.3", { pricing: { "muse-spark-1.3": null } }), undefined)
  assert.deepEqual(modelPrice("custom-model", { pricing: { "custom-model": { input: 2, output: 3 } } }), { input: 2, output: 3, cache: { read: 2, write: 0 } })
})

test("invalid or non-USD overrides are rejected", () => {
  for (const price of [{ input: -1, output: 1 }, { input: "x", output: 1 }, { input: 1, output: 1, currency: "EUR" }]) {
    assert.throws(() => modelPrice("x", { pricing: { x: price } }))
  }
})
