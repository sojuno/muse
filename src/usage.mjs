const counters = usage => ({
  prompt: usage.inputTokens ?? 0,
  output: usage.outputTokens ?? 0,
  read: usage.cacheReadTokens ?? usage.cachedTokens ?? 0,
  write: usage.cacheWriteTokens ?? 0,
  reasoning: usage.reasoningTokens ?? 0,
})

// A native turn spans multiple model completions and client HTTP tool steps.
// Prefer Muse's counted-once prompt/total counters over raw provider input,
// whose cache convention can differ. Emit each token only once across replies.
export class TurnUsage {
  observed = false
  cursors = new Set()
  raw = { prompt: 0, output: 0, read: 0, write: 0, reasoning: 0 }
  sent = { ...this.raw, total: 0 }
  prompt = 0
  total = 0
  add(params) {
    if (params.viewCursor && this.cursors.has(params.viewCursor)) return
    if (params.viewCursor) this.cursors.add(params.viewCursor)
    const usage = counters(params.usage)
    this.observed = true
    for (const key of Object.keys(this.raw)) this.raw[key] += usage[key]
    this.prompt += params.promptTokens ?? usage.prompt
    this.total += params.totalTokens ?? (params.promptTokens ?? usage.prompt) + usage.output
  }
  take(aggregate) {
    if (!aggregate && !this.observed) return undefined
    const current = aggregate ? counters(aggregate) : { ...this.raw }
    if (this.observed) current.prompt = this.prompt
    current.total = this.observed ? this.total : current.prompt + current.output
    const delta = Object.fromEntries(Object.entries(current).map(([key, value]) => [key, Math.max(0, value - this.sent[key])]))
    this.sent = current
    return {
      prompt_tokens: delta.prompt,
      completion_tokens: delta.output,
      total_tokens: delta.total,
      prompt_tokens_details: { cached_tokens: delta.read, cache_write_tokens: delta.write },
      completion_tokens_details: { reasoning_tokens: delta.reasoning },
    }
  }
}
