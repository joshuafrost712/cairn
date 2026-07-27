import type { LeniencyDelta } from '../../reports/analytics'

/**
 * How to say a leniency delta out loud without turning it into a verdict.
 *
 * "vs peers", never "bias" and never "accuracy": the statistic compares one
 * evaluator to the particular colleagues who happened to score the same cells,
 * which is a difference between readings, not a measurement of correctness.
 */
export function leniencyPhrase(l: LeniencyDelta): string {
  if (l.delta === null) {
    return l.pairedCells === 0
      ? 'no shared judgements yet'
      : `not enough overlap yet (${l.pairedCells} shared cell${l.pairedCells === 1 ? '' : 's'})`
  }
  if (Math.abs(l.delta) < 0.2) return 'in line with peers'
  return l.delta > 0 ? 'reads more generously than peers' : 'reads stricter than peers'
}

/** Signed, fixed to one place, or a dash when suppressed. */
export function leniencyValue(l: LeniencyDelta): string {
  if (l.delta === null) return '—'
  return `${l.delta > 0 ? '+' : ''}${l.delta.toFixed(2)}`
}
