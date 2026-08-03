import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SCALE,
  MAX_SCALE_POINTS,
  MIN_SCALE_POINTS,
  buildScale,
  conflictSpread,
  defaultScalePoints,
  diffScales,
  firstAdequateValue,
  indexOfValue,
  isLowTrigger,
  isValidDesignation,
  labelFor,
  labelWithValue,
  lowTriggerValues,
  maxValue,
  minValue,
  normalizeScalePoints,
  rampIndexForMean,
  scalePointPk,
  scaleValues,
  validateScalePoints,
  type ScalePoint,
} from '../src/lib/scale'
import { deriveNeededConversations } from '../src/db/mentoring'
import type { AnnotatedObservation } from '../src/reports/verification'
import type { Participant } from '../src/lib/types'

const points = (
  spec: [number, string, boolean][],
  workshopId = 'w1',
): ScalePoint[] =>
  normalizeScalePoints(
    workshopId,
    spec.map(([value, label, trigger]) => ({
      value,
      label,
      description: null,
      is_low_trigger: trigger,
    })),
  )

const scaleOf = (spec: [number, string, boolean][], workshopId = 'w1') =>
  buildScale(workshopId, points(spec, workshopId))

/** 1-5, only the bottom point low. The scale the spec's example organization runs. */
const FIVE = scaleOf([
  [1, 'well below', true],
  [2, 'below', false],
  [3, 'meets', false],
  [4, 'above', false],
  [5, 'well above', false],
])

/** A scale whose trigger is NOT its lowest point. No threshold can express this. */
const ODD = scaleOf([
  [1, 'idiosyncratic but fine', false],
  [2, 'the worrying one', true],
  [3, 'good', false],
])

describe('the default scale is exactly what the app had before tl-09', () => {
  it('is 0-3, with 0 and 1 as the conversation triggers', () => {
    expect(scaleValues(DEFAULT_SCALE)).toEqual([0, 1, 2, 3])
    expect([...lowTriggerValues(DEFAULT_SCALE)].sort()).toEqual([0, 1])
    expect(labelFor(DEFAULT_SCALE, 2)).toBe('competent')
    expect(labelWithValue(DEFAULT_SCALE, 3)).toBe('3 strong')
  })

  it('is what an un-authored workshop resolves to, so nothing breaks mid-migration', () => {
    // A device that has not synced, a workshop the migration has not reached, and
    // every pre-tl-09 test fixture take this path. Each of them must behave as
    // the app did before, rather than showing an empty scale or throwing.
    expect(buildScale('w1', [])).toEqual(DEFAULT_SCALE)
    expect(buildScale(null, points([[0, 'a', true], [1, 'b', false]]))).toEqual(DEFAULT_SCALE)
  })

  it('refuses to assemble a scale out of another workshop\'s points', () => {
    // The failure that would be hardest to see, because the numbers would still
    // render: a heatmap labelled by a workshop the reader is not looking at.
    const theirs = points([[1, 'a', true], [2, 'b', false], [3, 'c', false]], 'w2')
    expect(buildScale('w1', theirs)).toEqual(DEFAULT_SCALE)
  })
})

describe('a value is looked up, never compared to a literal', () => {
  it('resolves a position for the ramp without changing the stored number', () => {
    expect(indexOfValue(FIVE, 1)).toBe(0)
    expect(indexOfValue(FIVE, 5)).toBe(4)
    expect(scaleValues(FIVE)).toEqual([1, 2, 3, 4, 5])
    expect(minValue(FIVE)).toBe(1)
    expect(maxValue(FIVE)).toBe(5)
  })

  it('reports -1 rather than 0 for a value the scale does not define', () => {
    // 0 would be a legal index, so a caller that treated "not found" as position
    // zero would paint an unknown value as the bottom of the scale.
    expect(indexOfValue(FIVE, 0)).toBe(-1)
    expect(indexOfValue(FIVE, 6)).toBe(-1)
  })

  it('is a low trigger only where the workshop said so', () => {
    expect(isLowTrigger(ODD, 2)).toBe(true)
    expect(isLowTrigger(ODD, 1)).toBe(false)
    expect(isLowTrigger(ODD, 3)).toBe(false)
    // A value off the scale is not a trigger: inventing a conversation from a
    // number nobody can explain would put a participant in a hard meeting on the
    // strength of a data error.
    expect(isLowTrigger(ODD, 9)).toBe(false)
    expect(isLowTrigger(ODD, null)).toBe(false)
  })
})

describe('isValidDesignation is what replaces the union the compiler used to enforce', () => {
  it('accepts only integers the scale defines', () => {
    expect(isValidDesignation(3, DEFAULT_SCALE)).toBe(true)
    expect(isValidDesignation(4, DEFAULT_SCALE)).toBe(false)
    expect(isValidDesignation(0, FIVE)).toBe(false)
    expect(isValidDesignation(5, FIVE)).toBe(true)
  })

  it('rejects the shapes a widened `number` newly admits', () => {
    expect(isValidDesignation(2.5, DEFAULT_SCALE)).toBe(false)
    expect(isValidDesignation('2', DEFAULT_SCALE)).toBe(false)
    expect(isValidDesignation(null, DEFAULT_SCALE)).toBe(false)
    expect(isValidDesignation(undefined, DEFAULT_SCALE)).toBe(false)
    expect(isValidDesignation(NaN, DEFAULT_SCALE)).toBe(false)
  })

  it('accepts a non-contiguous scale, because the values are the organization\'s', () => {
    const gappy = scaleOf([[0, 'none', true], [2, 'some', false], [5, 'lots', false]])
    expect(isValidDesignation(2, gappy)).toBe(true)
    expect(isValidDesignation(1, gappy)).toBe(false)
  })
})

describe('validateScalePoints mirrors the SQL that actually enforces it', () => {
  const p = (n: number, triggers: number[] = [0]) =>
    Array.from({ length: n }, (_, i) => ({
      value: i,
      label: `p${i}`,
      is_low_trigger: triggers.includes(i),
    }))

  it('accepts every legal size and refuses the two beyond it', () => {
    for (let n = MIN_SCALE_POINTS; n <= MAX_SCALE_POINTS; n++) {
      expect(validateScalePoints(p(n))).toBeNull()
    }
    expect(validateScalePoints(p(1))).toBe('setup.scale.error.too-few')
    expect(validateScalePoints(p(7))).toBe('setup.scale.error.too-many')
  })

  it('refuses a scale on which every point calls for a conversation', () => {
    // Not strictness: a scale where every point is a trigger has stopped saying
    // anything, because every participant is flagged for every observation.
    expect(validateScalePoints(p(3, [0, 1, 2]))).toBe('setup.scale.error.all-triggers')
    // Zero triggers is legal: a workshop that does not use the follow-up feature.
    expect(validateScalePoints(p(3, []))).toBeNull()
  })

  it('refuses duplicates, non-integers and blank labels', () => {
    expect(
      validateScalePoints([
        { value: 1, label: 'a', is_low_trigger: false },
        { value: 1, label: 'b', is_low_trigger: false },
      ]),
    ).toBe('setup.scale.error.duplicate-value')
    expect(
      validateScalePoints([
        { value: 1.5, label: 'a', is_low_trigger: false },
        { value: 2, label: 'b', is_low_trigger: false },
      ]),
    ).toBe('setup.scale.error.non-integer')
    expect(
      validateScalePoints([
        { value: 1, label: '  ', is_low_trigger: false },
        { value: 2, label: 'b', is_low_trigger: false },
      ]),
    ).toBe('setup.scale.error.blank-label')
  })
})

describe('normalizeScalePoints is the one place a stored row is built', () => {
  it('renumbers sort_order and re-keys pk from the value, ascending', () => {
    const out = normalizeScalePoints('w9', [
      { value: 5, label: ' top ', description: '  ', is_low_trigger: false },
      { value: 1, label: 'bottom', description: ' why ', is_low_trigger: true },
    ])
    expect(out.map((p) => p.value)).toEqual([1, 5])
    expect(out.map((p) => p.sort_order)).toEqual([0, 1])
    expect(out.map((p) => p.pk)).toEqual([scalePointPk('w9', 1), scalePointPk('w9', 5)])
    expect(out[0].description).toBe('why')
    expect(out[1].description).toBeNull()
    expect(out[1].label).toBe('top')
  })
})

describe('the two derived rules that used to be literals', () => {
  it('conflictSpread is 2 at four points, so no existing report moves', () => {
    expect(conflictSpread(DEFAULT_SCALE)).toBe(2)
  })

  it('grows with the scale, so a 6-point workshop does not flag pairs that agree', () => {
    const six = scaleOf([
      [0, 'a', true],
      [1, 'b', false],
      [2, 'c', false],
      [3, 'd', false],
      [4, 'e', false],
      [5, 'f', false],
    ])
    expect(conflictSpread(six)).toBe(3)
    // Floors at 2: a spread of 1 is adjacent points, which the verification gate
    // already treats as disagreement.
    expect(conflictSpread(scaleOf([[0, 'a', true], [1, 'b', false]]))).toBe(2)
  })

  it('firstAdequateValue is 2 on the original scale and follows the flags elsewhere', () => {
    expect(firstAdequateValue(DEFAULT_SCALE)).toBe(2)
    expect(firstAdequateValue(FIVE)).toBe(2)
    expect(firstAdequateValue(ODD)).toBe(1)
  })
})

describe('rampIndexForMean', () => {
  it('sends an exact tie upward, matching the Math.round it replaced', () => {
    expect(rampIndexForMean(1.5, DEFAULT_SCALE)).toBe(2)
    expect(rampIndexForMean(2.5, DEFAULT_SCALE)).toBe(3)
  })

  it('lands on a real point of a gappy scale rather than in the gap', () => {
    const gappy = scaleOf([[0, 'none', true], [2, 'some', false], [5, 'lots', false]])
    expect(scaleValues(gappy)[rampIndexForMean(1.4, gappy)]).toBe(2)
    expect(scaleValues(gappy)[rampIndexForMean(4.0, gappy)]).toBe(5)
  })
})

describe('diffScales tells the change dialog what KIND of edit this is', () => {
  const before = points([[0, 'none', true], [1, 'low', true], [2, 'ok', false], [3, 'good', false]])

  it('separates a rename from a removal from an addition', () => {
    const renamed = points([[0, 'none', true], [1, 'emerging', true], [2, 'ok', false], [3, 'good', false]])
    expect(diffScales(before, renamed)).toMatchObject({
      added: [],
      removed: [],
      reworded: [1],
      retriggered: [],
      countChanged: false,
    })

    const shortened = points([[0, 'none', true], [1, 'low', true], [2, 'ok', false]])
    expect(diffScales(before, shortened)).toMatchObject({ removed: [3], added: [], countChanged: true })

    const lengthened = points([
      [0, 'none', true],
      [1, 'low', true],
      [2, 'ok', false],
      [3, 'good', false],
      [4, 'exceptional', false],
    ])
    expect(diffScales(before, lengthened)).toMatchObject({ added: [4], removed: [], countChanged: true })
  })

  it('reports a trigger flip separately from a rename, because they cost different things', () => {
    // A rename reprints; a trigger flip changes which people get a hard
    // conversation. Collapsing them into "the scale changed" is what made the
    // tl-07 placeholder classifier too loud to be believed.
    const flipped = points([[0, 'none', true], [1, 'low', false], [2, 'ok', false], [3, 'good', false]])
    expect(diffScales(before, flipped)).toMatchObject({ reworded: [], retriggered: [1] })
  })
})

describe('the mentoring trigger is declarative', () => {
  const participants = new Map<string, Participant>([
    ['p1', { id: 'p1', workshop_id: 'w1', name: 'Amos', registered_email: null, team_id: null, preferred_language: null }],
  ])

  const observation = (designation: number, workshopId: string | null = 'w1'): AnnotatedObservation =>
    ({
      id: `o-${designation}-${workshopId}`,
      capture_client_id: 'cap-1',
      workshop_id: workshopId,
      participant_id: 'p1',
      participant_name: 'Amos',
      ksa_code: 'Q1',
      text: '',
      source_excerpt: '',
      evidence_designation: designation,
      sentiment_flag: 'neutral',
      confidence: 'high',
      needs_review: false,
      origin: 'individual',
      imported_at: '2026-08-01T00:00:00Z',
      vstatus: 'verified',
      effective_designation: designation,
      confirmCount: 2,
      rejectCount: 0,
      verdicts: [],
    }) as AnnotatedObservation

  it('fires on exactly the points the workshop marked, not on 0 and 1', () => {
    const obs = [observation(1), observation(2), observation(3)]
    const derived = deriveNeededConversations(obs, participants, 'now', () => ODD)
    expect(derived.map((c) => c.trigger_designation)).toEqual([2])
  })

  it('reproduces the old behaviour exactly when the workshop has no scale', () => {
    const obs = [observation(0), observation(1), observation(2), observation(3)]
    const derived = deriveNeededConversations(obs, participants, 'now')
    expect(derived.map((c) => c.trigger_designation)).toEqual([0, 1])
  })

  it('resolves each observation against ITS OWN workshop, not one scale for the device', () => {
    // The bug this signature exists to prevent. Two workshops in one deployment
    // with different scales: a single resolved scale would derive one workshop's
    // follow-ups by the other's rules, and every row would look plausible.
    const obs = [observation(1, 'w1'), observation(1, 'w2')]
    const derived = deriveNeededConversations(obs, participants, 'now', (id) =>
      id === 'w1' ? ODD : FIVE,
    )
    // 1 is not a trigger on ODD and is on FIVE, so exactly the w2 row fires.
    expect(derived.map((c) => c.trigger_observation_id)).toEqual(['o-1-w2'])
  })
})

describe('defaultScalePoints', () => {
  it('keys itself to the workshop it is seeded for', () => {
    const seeded = defaultScalePoints('w7')
    expect(seeded).toHaveLength(4)
    expect(seeded.map((p) => p.pk)).toEqual([0, 1, 2, 3].map((v) => scalePointPk('w7', v)))
    expect(seeded.every((p) => p.workshop_id === 'w7')).toBe(true)
  })
})
