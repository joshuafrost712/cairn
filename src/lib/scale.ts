/**
 * The grading scale (tl-09). Pure: no IO, no Dexie, no React.
 *
 * A designation is a number whose meaning comes ENTIRELY from the scale it was
 * recorded on. Before this module the app had one scale, 0-3, written into a
 * TypeScript union in four places and into the meaning of the number in two more:
 * `deriveNeededConversations` treated 0 and 1 as the mentoring trigger, and
 * `AT_RISK_MAX` treated the same two as trouble. An organization running a 5-point
 * scale where 3 is adequate would have got follow-up conversations for the wrong
 * participants, silently, with nothing on screen looking wrong.
 *
 * So the rule this module exists to enforce: **no consumer may decide what a
 * number means by comparing it to a literal.** Ask the scale. `isLowTrigger` is
 * the only trigger test, `conflictSpread` is the only spread test, and
 * `isValidDesignation` is the only boundary check.
 *
 * WHY VALUES ARE THE ORGANIZATION'S OWN NUMBERS. A scale is stored as the numbers
 * its users say out loud — 1-5 stays 1-5 — rather than normalized to a 0-based
 * index. Normalizing would be tidier here and would eventually print "0-4" in an
 * export or an email, which is the kind of thing nobody notices until a
 * participant reads their own report. The ramp still needs a position, so
 * `indexOfValue` converts where a position is what is wanted, at the point of use.
 *
 * WIDENING COST, STATED HONESTLY. Every designation type in the app was a literal
 * union (`0 | 1 | 2 | 3`) and is now `number`, so the compiler no longer catches a
 * foreign value at a boundary. `isValidDesignation` is what replaces that
 * guarantee, and it is only a replacement where it is actually called: see the
 * boundary list in the tl-09 review record.
 */

/**
 * One point on a workshop's scale.
 *
 * `pk` is the Dexie key, `${workshop_id}::${value}`, matching the flattening every
 * other composite-keyed cache in this app uses (see local.ts). Postgres's own key
 * is the pair, and `referenceKeyFields('scale_point')` lists it in the same order.
 */
export interface ScalePoint {
  pk: string
  workshop_id: string
  /** The organization's own number. Unique within the workshop. */
  value: number
  /** What this point is called: "Emerging", "Meets expectations". */
  label: string
  description: string | null
  /**
   * Whether landing here warrants a mentoring conversation.
   *
   * The whole reason the scale is a table rather than a list of labels. It is a
   * property of the POINT rather than a comparison against a number, because on a
   * 6-point scale "low" is not "0 or 1" and no formula gets it right for every
   * organization: some treat the bottom two as trouble, some only the bottom.
   */
  is_low_trigger: boolean
  sort_order: number
}

/** A workshop's scale, resolved and ordered. Never empty. */
export interface Scale {
  /** Null for the app default, i.e. a workshop that has authored no scale. */
  workshop_id: string | null
  /** Ascending by `sort_order`, then by `value`. At least two points. */
  points: ScalePoint[]
}

export const MIN_SCALE_POINTS = 2
export const MAX_SCALE_POINTS = 6

/** The scale every deployment had before tl-09, as labels. */
export const DEFAULT_SCALE_LABELS: Record<number, string> = {
  0: 'not yet demonstrated',
  1: 'emerging',
  2: 'competent',
  3: 'strong',
}

/** Which default points trigger a conversation: exactly today's 0-or-1 rule. */
const DEFAULT_TRIGGERS = new Set([0, 1])

export const scalePointPk = (workshop_id: string, value: number) => `${workshop_id}::${value}`

/**
 * The 0-3 scale, for a workshop that has authored none.
 *
 * The fallback is not a courtesy: an un-migrated workshop, a device that has not
 * synced, and a test fixture that predates this spec all take this path, and each
 * of them must behave EXACTLY as the app did before tl-09 rather than break or
 * quietly re-mean its numbers. `test/scale.test.ts` pins that.
 */
export function defaultScalePoints(workshopId: string | null = null): ScalePoint[] {
  return [0, 1, 2, 3].map((value, i) => ({
    pk: scalePointPk(workshopId ?? '', value),
    workshop_id: workshopId ?? '',
    value,
    label: DEFAULT_SCALE_LABELS[value],
    description: null,
    is_low_trigger: DEFAULT_TRIGGERS.has(value),
    sort_order: i,
  }))
}

export const DEFAULT_SCALE: Scale = { workshop_id: null, points: defaultScalePoints(null) }

/**
 * The active workshop's scale, synchronously, for the pure layers.
 *
 * The same shape as `getRequiredConfirmations()` in reports/verification.ts, and
 * it lives HERE, in the pure module, for the reason that one does: the readers
 * are pure functions (`designationStats` is called from about twenty places
 * inside report and dashboard code) and making them async so they could consult
 * Dexie would ripple through every one of them to buy nothing. db/scale.ts owns
 * keeping this correct; nothing else may call the setter.
 *
 * THE RULE THAT COMES WITH IT, and tl-17 learned it the expensive way with the
 * verification threshold: this holds the ACTIVE workshop's scale and no other.
 * Anything computing ACROSS workshops passes a scale explicitly, or it will
 * bucket one workshop's values against another workshop's points and every
 * number on the page will still look plausible.
 */
let active: Scale = DEFAULT_SCALE

export function getActiveScale(): Scale {
  return active
}

/** Set by db/scale.ts's mirror, and by tests. Not a general-purpose setter. */
export function setActiveScale(scale: Scale): void {
  active = scale
}

const byOrder = (a: ScalePoint, b: ScalePoint) => a.sort_order - b.sort_order || a.value - b.value

/**
 * Resolve a workshop's cached rows into a scale, falling back to the default.
 *
 * Takes rows for ANY workshop and filters, rather than trusting the caller to have
 * queried correctly: a scale silently assembled from two workshops' points is the
 * failure that would be hardest to see, because the numbers would still render.
 */
export function buildScale(workshopId: string | null, rows: ScalePoint[]): Scale {
  const mine = workshopId ? rows.filter((r) => r.workshop_id === workshopId) : []
  if (mine.length < MIN_SCALE_POINTS) return { workshop_id: null, points: defaultScalePoints(null) }
  return { workshop_id: workshopId, points: [...mine].sort(byOrder) }
}

/** The scale's own numbers, ascending by position. */
export function scaleValues(scale: Scale): number[] {
  return scale.points.map((p) => p.value)
}

export function scaleSize(scale: Scale): number {
  return scale.points.length
}

/** Where a value sits on the ramp, or -1 when it is not on this scale. */
export function indexOfValue(scale: Scale, value: number): number {
  return scale.points.findIndex((p) => p.value === value)
}

export function pointFor(scale: Scale, value: number): ScalePoint | undefined {
  return scale.points.find((p) => p.value === value)
}

/**
 * THE boundary check. Every place a designation enters the app from outside —
 * the routing import, a verdict write, a quick rating, a roster or scale import —
 * calls this, because widening the type to `number` removed the compile-time one.
 *
 * Rejects non-integers and values the scale does not define. A value that is
 * merely out of ORDER is fine; scales need not be contiguous.
 */
export function isValidDesignation(value: unknown, scale: Scale): boolean {
  if (typeof value !== 'number' || !Number.isInteger(value)) return false
  return indexOfValue(scale, value) >= 0
}

/** The points that warrant a mentoring conversation. */
export function lowTriggerValues(scale: Scale): Set<number> {
  return new Set(scale.points.filter((p) => p.is_low_trigger).map((p) => p.value))
}

/**
 * Whether a recorded designation warrants a follow-up.
 *
 * The one trigger test in the app. A value not on the scale is NOT a trigger:
 * inventing a conversation from a number nobody can explain would put a
 * participant in a hard meeting on the strength of a data error.
 */
export function isLowTrigger(scale: Scale, value: number | null | undefined): boolean {
  if (value == null) return false
  return pointFor(scale, value)?.is_low_trigger === true
}

/** A point's label, or the bare number when the scale does not define it. */
export function labelFor(scale: Scale, value: number | null | undefined): string {
  if (value == null) return ''
  return pointFor(scale, value)?.label ?? String(value)
}

/** "2 competent" — the form legends, tooltips and aria text all want. */
export function labelWithValue(scale: Scale, value: number | null | undefined): string {
  if (value == null) return ''
  const label = pointFor(scale, value)?.label
  return label ? `${value} ${label}` : String(value)
}

/** The top of the scale, for "2/3"-style readouts. */
export function maxValue(scale: Scale): number {
  return scale.points[scale.points.length - 1].value
}

export function minValue(scale: Scale): number {
  return scale.points[0].value
}

/**
 * The lowest point that does NOT warrant a follow-up: the workshop's own idea of
 * "adequate", as a number.
 *
 * Two report surfaces used the literal 2 for this — the event digest's "scored
 * below competent" pattern line, and the participant email's growth section. On
 * the app's original scale the lowest non-trigger point IS 2, so this derivation
 * reproduces today's output exactly while meaning something on a 1-5 scale.
 *
 * Falls back to the top of the scale when every point is a trigger, which
 * `validateScalePoints` refuses to save but a pulled row could still describe.
 */
export function firstAdequateValue(scale: Scale): number {
  const point = scale.points.find((p) => !p.is_low_trigger)
  return point ? point.value : maxValue(scale)
}

/**
 * How far apart two counting designations must be before a KSA rollup calls them
 * conflicting evidence.
 *
 * Scale-derived rather than the literal 2 it was, and the reason is the same one
 * behind `is_low_trigger`: a gap of 2 is two thirds of a 0-3 scale and one fifth
 * of a 0-5 one, so freezing the number would make a 6-point workshop flag pairs
 * that agree. Pinned to 2 at four points, so nothing about an existing workshop's
 * reports moves.
 *
 * Floors at 2 because a spread of 1 is adjacent points, which is disagreement the
 * verification gate already handles and not a conflict worth a reader's attention.
 */
export function conflictSpread(scale: Scale): number {
  return Math.max(2, Math.round(((scale.points.length - 1) * 2) / 3))
}

/**
 * Snap a MEAN onto a ramp position for a bar fill.
 *
 * Never used for text: the printed number is always the real mean, and rounding it
 * for display would be a lie. Snapping happens in value space and then converts to
 * a position, so a non-contiguous scale (0, 1, 3, 5) still lands on a real point.
 */
export function rampIndexForMean(mean: number, scale: Scale): number {
  let best = 0
  let bestDistance = Infinity
  scale.points.forEach((p, i) => {
    const d = Math.abs(p.value - mean)
    // `<=` so an exact tie goes to the HIGHER point, matching the `Math.round`
    // this replaced: 1.5 snapped to 2 before tl-09 and still does. Ties are rare
    // and the direction is arbitrary, which is exactly why it has to be pinned
    // rather than left to whichever way the loop happens to run.
    if (d <= bestDistance) {
      bestDistance = d
      best = i
    }
  })
  return best
}

/** Why a proposed scale cannot be saved, as a chrome node id, or null when it can. */
export type ScaleProblem =
  | 'setup.scale.error.too-few'
  | 'setup.scale.error.too-many'
  | 'setup.scale.error.duplicate-value'
  | 'setup.scale.error.non-integer'
  | 'setup.scale.error.blank-label'
  | 'setup.scale.error.all-triggers'

/**
 * Whether a proposed set of points is a legal scale.
 *
 * Mirrored EXACTLY by `scale_points_are_legal()` in the migration, which is what
 * actually enforces it — this copy only decides whether the Save button is
 * enabled. The spec's requirement is that the bound live in a constraint or an
 * RPC "not only in the UI", and the pair is the same shape tl-02 used for its
 * promotion matrix: SQL enforces, TypeScript offers.
 *
 * "At least one non-trigger point" is the rule worth defending. A scale where
 * every point warrants a conversation is not a strict workshop, it is a scale that
 * has stopped saying anything: every participant would be flagged for every
 * observation and the queue would become noise. Zero triggers is legal, and means
 * a workshop that does not use the follow-up feature.
 */
export function validateScalePoints(
  points: Pick<ScalePoint, 'value' | 'label' | 'is_low_trigger'>[],
): ScaleProblem | null {
  if (points.length < MIN_SCALE_POINTS) return 'setup.scale.error.too-few'
  if (points.length > MAX_SCALE_POINTS) return 'setup.scale.error.too-many'
  if (points.some((p) => !Number.isInteger(p.value))) return 'setup.scale.error.non-integer'
  if (new Set(points.map((p) => p.value)).size !== points.length)
    return 'setup.scale.error.duplicate-value'
  if (points.some((p) => !p.label.trim())) return 'setup.scale.error.blank-label'
  if (points.every((p) => p.is_low_trigger)) return 'setup.scale.error.all-triggers'
  return null
}

/**
 * Renumber and re-key a list of points for one workshop, ascending by value.
 *
 * The single place a `ScalePoint` row is constructed for storage, so `pk` and
 * `sort_order` cannot disagree with `value` — which they would the first time
 * somebody added a point in the middle and forgot to renumber.
 */
export function normalizeScalePoints(
  workshopId: string,
  points: Pick<ScalePoint, 'value' | 'label' | 'description' | 'is_low_trigger'>[],
): ScalePoint[] {
  return [...points]
    .sort((a, b) => a.value - b.value)
    .map((p, i) => ({
      pk: scalePointPk(workshopId, p.value),
      workshop_id: workshopId,
      value: p.value,
      label: p.label.trim(),
      description: p.description?.trim() ? p.description.trim() : null,
      is_low_trigger: p.is_low_trigger,
      sort_order: i,
    }))
}

/**
 * A free value to add at the top of a scale, and one at the bottom.
 *
 * Adding is offered as "another point above" / "another point below" rather than a
 * number field, because the number is arithmetic and the position is the decision.
 */
export function nextValueAbove(scale: Scale): number {
  return maxValue(scale) + 1
}

export function nextValueBelow(scale: Scale): number {
  return minValue(scale) - 1
}

/**
 * What changed between two scales, in the terms the change dialog reasons about.
 *
 * Returned as a shape rather than a severity because the classifier owns severity
 * and this owns arithmetic. `removed` is the field that decides whether a save
 * needs a remap: every other kind of edit leaves each recorded number pointing at
 * a point that still exists.
 */
export interface ScaleDiff {
  added: number[]
  removed: number[]
  /** Values whose label or description moved. */
  reworded: number[]
  /** Values whose `is_low_trigger` flipped. */
  retriggered: number[]
  countChanged: boolean
}

export function diffScales(before: ScalePoint[], after: ScalePoint[]): ScaleDiff {
  const beforeByValue = new Map(before.map((p) => [p.value, p]))
  const afterByValue = new Map(after.map((p) => [p.value, p]))
  const added = after.filter((p) => !beforeByValue.has(p.value)).map((p) => p.value)
  const removed = before.filter((p) => !afterByValue.has(p.value)).map((p) => p.value)
  const reworded: number[] = []
  const retriggered: number[] = []
  for (const [value, b] of beforeByValue) {
    const a = afterByValue.get(value)
    if (!a) continue
    if (a.label !== b.label || (a.description ?? '') !== (b.description ?? '')) reworded.push(value)
    if (a.is_low_trigger !== b.is_low_trigger) retriggered.push(value)
  }
  return {
    added: added.sort((x, y) => x - y),
    removed: removed.sort((x, y) => x - y),
    reworded: reworded.sort((x, y) => x - y),
    retriggered: retriggered.sort((x, y) => x - y),
    countChanged: before.length !== after.length,
  }
}
