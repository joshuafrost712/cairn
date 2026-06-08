// Cost accounting + spend cap for Claude API usage. Runtime-agnostic.
// Every routing call records token usage; cost is derived from PRICING and a
// configurable cap is enforced so spend stays visible and bounded.

import { PRICING } from './prompt'

export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface CallLogEntry {
  at: string // ISO timestamp (caller-supplied; runtime-agnostic)
  label: string
  usage: Usage
  costUSD: number
}

/** USD cost of one call from its token usage. */
export function costOf(usage: Usage): number {
  const m = 1_000_000
  const inp = (usage.input_tokens ?? 0) * (PRICING.inputPerM / m)
  const out = (usage.output_tokens ?? 0) * (PRICING.outputPerM / m)
  const cw = (usage.cache_creation_input_tokens ?? 0) * (PRICING.cacheWritePerM / m)
  const cr = (usage.cache_read_input_tokens ?? 0) * (PRICING.cacheReadPerM / m)
  return inp + out + cw + cr
}

export class SpendCapExceededError extends Error {
  spentUSD: number
  capUSD: number
  constructor(spentUSD: number, capUSD: number) {
    super(`Spend cap reached: $${spentUSD.toFixed(4)} of $${capUSD.toFixed(2)}`)
    this.name = 'SpendCapExceededError'
    this.spentUSD = spentUSD
    this.capUSD = capUSD
  }
}

/**
 * Tracks cumulative spend and enforces a cap. `sink` receives every call's log
 * entry (console in dev; a DB insert / file append in production). `nowISO` is
 * injected so the module stays runtime-agnostic.
 */
export class CostGuard {
  spentUSD = 0
  private capUSD: number
  private sink: (e: CallLogEntry) => void
  private nowISO: () => string
  constructor(
    capUSD: number,
    sink: (e: CallLogEntry) => void = () => {},
    nowISO: () => string = () => new Date().toISOString(),
  ) {
    this.capUSD = capUSD
    this.sink = sink
    this.nowISO = nowISO
  }

  /** Throw if we're already at/over the cap. Call before each request. */
  precheck(): void {
    if (this.spentUSD >= this.capUSD) throw new SpendCapExceededError(this.spentUSD, this.capUSD)
  }

  /** Record a completed call's usage; logs it and advances the running total. */
  record(label: string, usage: Usage): CallLogEntry {
    const costUSD = costOf(usage)
    this.spentUSD += costUSD
    const entry: CallLogEntry = { at: this.nowISO(), label, usage, costUSD }
    this.sink(entry)
    return entry
  }
}
