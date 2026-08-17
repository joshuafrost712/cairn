import { describe, it, expect } from 'vitest'
import {
  observationRow,
  pickWorkshopId,
  surplusObservationIds,
  verdictRow,
  verdictsToAdopt,
} from '../src/db/sync'
import { planBackfill } from '../src/db/backfill'
import type { ObservationRecord, VerificationVerdict } from '../src/lib/types'

/**
 * tl-04's decisions, isolated from their IO.
 *
 * Every one of these was chosen because getting it wrong fails SILENTLY: an
 * observation with no workshop cannot be shared and nothing says so, a surplus
 * row left on the server keeps counting toward a participant's evidence, a
 * withdrawn verdict restored by the next pull looks exactly like a verdict the
 * evaluator meant to leave. Silent failures are the ones that need a test,
 * because there is no bug report coming.
 */

describe('pickWorkshopId', () => {
  it('prefers the originating capture', () => {
    expect(pickWorkshopId('ws-capture', ['ws-participant'], 'ws-active')).toBe('ws-capture')
  })

  it('falls back to the first participant that has one', () => {
    expect(pickWorkshopId(null, [null, undefined, 'ws-participant'], 'ws-active')).toBe(
      'ws-participant',
    )
  })

  it('falls back to the active workshop when nothing else knows', () => {
    expect(pickWorkshopId(null, [], 'ws-active')).toBe('ws-active')
    expect(pickWorkshopId(undefined, [null], 'ws-active')).toBe('ws-active')
  })

  it('returns null rather than inventing one', () => {
    // The push refuses these locally with an explanation, which is the point:
    // an opaque NOT NULL violation every 30 seconds tells a human nothing.
    expect(pickWorkshopId(null, [null], null)).toBeNull()
  })

  it('treats an empty string as absent, not as an id', () => {
    expect(pickWorkshopId('', [''], 'ws-active')).toBe('ws-active')
  })
})

describe('surplusObservationIds', () => {
  it('finds server rows a re-route dropped', () => {
    // Re-routing produced two observations where there were three. Ids are
    // positional, so ::2 is not overwritten by the upsert — it is orphaned.
    expect(surplusObservationIds(['c::0', 'c::1', 'c::2'], ['c::0', 'c::1'])).toEqual(['c::2'])
  })

  it('is empty when the sets match', () => {
    expect(surplusObservationIds(['c::0'], ['c::0'])).toEqual([])
  })

  it('is empty when local holds MORE than the server', () => {
    // The normal case mid-push. Deleting on this signal would delete rows that
    // simply have not gone up yet.
    expect(surplusObservationIds(['c::0'], ['c::0', 'c::1'])).toEqual([])
  })
})

describe('verdictsToAdopt', () => {
  const remote = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('adopts everything when nothing is pending locally', () => {
    const { adopt, held } = verdictsToAdopt(remote, [], [])
    expect(adopt.map((v) => v.id)).toEqual(['a', 'b', 'c'])
    expect(held).toBe(0)
  })

  it('holds back my own unsynced verdict, whose local copy is the newer one', () => {
    const { adopt, held } = verdictsToAdopt(remote, ['b'], [])
    expect(adopt.map((v) => v.id)).toEqual(['a', 'c'])
    expect(held).toBe(1)
  })

  it('holds back a verdict withdrawn offline, so the pull cannot restore it', () => {
    const { adopt, held } = verdictsToAdopt(remote, [], ['c'])
    expect(adopt.map((v) => v.id)).toEqual(['a', 'b'])
    expect(held).toBe(1)
  })

  it('counts a verdict that is both unsynced and withdrawn once', () => {
    const { adopt, held } = verdictsToAdopt(remote, ['a'], ['a'])
    expect(adopt.map((v) => v.id)).toEqual(['b', 'c'])
    expect(held).toBe(1)
  })
})

/**
 * The row mappers. A field missing here is data that reaches the backend as null
 * and comes back to every other device as null, with no error anywhere — which is
 * the same class of failure as not syncing at all, just harder to see.
 */
describe('observationRow', () => {
  const obs: ObservationRecord = {
    id: 'cap-1::0',
    capture_client_id: 'cap-1',
    workshop_id: 'ws-1',
    participant_id: 'p-1',
    participant_name: 'Amos',
    ksa_code: 'K1.2',
    text: 'Retold the passage without notes.',
    source_excerpt: 'he told the whole thing from memory',
    evidence_designation: 2,
    sentiment_flag: 'strong',
    confidence: 'high',
    needs_review: false,
    origin: 'individual',
    imported_at: '2026-07-30T09:00:00.000Z',
    evaluator_email: 'viji@example.org',
    sync_status: 'local',
    sync_error: null,
  }

  it('carries every field the backend column set expects', () => {
    expect(observationRow(obs)).toEqual({
      id: 'cap-1::0',
      capture_client_id: 'cap-1',
      workshop_id: 'ws-1',
      participant_id: 'p-1',
      participant_name: 'Amos',
      ksa_code: 'K1.2',
      text: 'Retold the passage without notes.',
      source_excerpt: 'he told the whole thing from memory',
      evidence_designation: 2,
      sentiment_flag: 'strong',
      confidence: 'high',
      needs_review: false,
      origin: 'individual',
      imported_at: '2026-07-30T09:00:00.000Z',
      evaluator_email: 'viji@example.org',
      // tl-30. Present on every row, not only on instructor ones, and the
      // fixture above does not set it — so this also pins the default. Omitting
      // the column would let an instructor observation arrive at a Postgres
      // default of 'participant' and become readable by the whole workshop.
      subject_kind: 'participant',
    })
  })

  it('sends an instructor observation as one', () => {
    const row = observationRow({ ...obs, subject_kind: 'instructor' }) as Record<string, unknown>
    expect(row.subject_kind).toBe('instructor')
  })

  it('does not send the local-only sync fields', () => {
    const row = observationRow(obs) as Record<string, unknown>
    expect('sync_status' in row).toBe(false)
    expect('sync_error' in row).toBe(false)
  })

  it('normalizes a missing evaluator_email to null rather than undefined', () => {
    // PostgREST drops undefined keys, which would leave a column at its default
    // instead of clearing it on an update.
    const row = observationRow({ ...obs, evaluator_email: undefined })
    expect(row.evaluator_email).toBeNull()
  })
})

describe('verdictRow', () => {
  const verdict: VerificationVerdict = {
    id: 'cap-1::0::viji@example.org',
    observation_id: 'cap-1::0',
    capture_client_id: 'cap-1',
    workshop_id: 'ws-1',
    evaluator_email: 'viji@example.org',
    decision: 'adjust',
    adjusted_designation: 1,
    note: 'closer to a 1 on this one',
    at: '2026-07-30T09:05:00.000Z',
    sync_status: 'local',
    sync_error: null,
  }

  it('carries every field, including the adjusted designation', () => {
    expect(verdictRow(verdict)).toEqual({
      id: 'cap-1::0::viji@example.org',
      observation_id: 'cap-1::0',
      capture_client_id: 'cap-1',
      workshop_id: 'ws-1',
      evaluator_email: 'viji@example.org',
      decision: 'adjust',
      adjusted_designation: 1,
      note: 'closer to a 1 on this one',
      at: '2026-07-30T09:05:00.000Z',
    })
  })

  it('sends an omitted adjustment and note as null', () => {
    const row = verdictRow({
      ...verdict,
      decision: 'confirm',
      adjusted_designation: undefined,
      note: undefined,
    })
    expect(row.adjusted_designation).toBeNull()
    expect(row.note).toBeNull()
  })

  it('keeps a 0 adjustment, which is a real designation and not an absence', () => {
    // `?? null` rather than `|| null` is the whole reason this test exists.
    expect(verdictRow({ ...verdict, adjusted_designation: 0 }).adjusted_designation).toBe(0)
  })
})

/**
 * The v11 backfill plan — the desktop half of the phone-evaluations recovery.
 *
 * Every existing observation and verdict is marked unsynced so the first cycle
 * pushes the whole pilot history up, which is what makes "one private database"
 * true retroactively. The plan is tested here rather than through a real v10
 * IndexedDB because a wrong workshop is a row that can never be shared, and that
 * is silent: nothing on any screen would say so.
 */
describe('planBackfill', () => {
  const base = {
    captureWorkshops: new Map([['cap-1', 'ws-1']]),
    participantWorkshops: new Map([['p-9', 'ws-2']]),
    activeWorkshopId: 'ws-active',
  }

  it('places an observation via its originating capture', () => {
    const plan = planBackfill({
      ...base,
      observations: [{ id: 'cap-1::0', capture_client_id: 'cap-1', participant_id: 'p-9' }],
      verdicts: [],
    })
    expect(plan.observationWorkshops.get('cap-1::0')).toBe('ws-1')
    expect(plan.unresolved).toBe(0)
  })

  it('falls back to the participant when the capture is gone from this device', () => {
    const plan = planBackfill({
      ...base,
      observations: [{ id: 'cap-x::0', capture_client_id: 'cap-x', participant_id: 'p-9' }],
      verdicts: [],
    })
    expect(plan.observationWorkshops.get('cap-x::0')).toBe('ws-2')
  })

  it('falls back to the active workshop when neither is known', () => {
    const plan = planBackfill({
      ...base,
      observations: [{ id: 'cap-x::0', capture_client_id: 'cap-x', participant_id: null }],
      verdicts: [],
    })
    expect(plan.observationWorkshops.get('cap-x::0')).toBe('ws-active')
  })

  it('counts what it could not place, so the failure is reportable', () => {
    const plan = planBackfill({
      captureWorkshops: new Map(),
      participantWorkshops: new Map(),
      activeWorkshopId: null,
      observations: [{ id: 'cap-x::0', capture_client_id: 'cap-x', participant_id: null }],
      verdicts: [],
    })
    expect(plan.observationWorkshops.get('cap-x::0')).toBeNull()
    expect(plan.unresolved).toBe(1)
  })

  it('gives a verdict the SAME workshop as its observation, never its own resolution', () => {
    // The two must agree or the backend refuses the verdict. Resolving twice from
    // the same three sources is two chances to disagree.
    const plan = planBackfill({
      ...base,
      observations: [{ id: 'cap-1::0', capture_client_id: 'cap-1', participant_id: 'p-9' }],
      verdicts: [{ id: 'cap-1::0::viji@example.org', observation_id: 'cap-1::0' }],
    })
    expect(plan.verdictWorkshops.get('cap-1::0::viji@example.org')).toBe('ws-1')
  })

  it('leaves a verdict whose observation is missing at null rather than guessing', () => {
    const plan = planBackfill({
      ...base,
      observations: [],
      verdicts: [{ id: 'gone::0::viji@example.org', observation_id: 'gone::0' }],
    })
    expect(plan.verdictWorkshops.get('gone::0::viji@example.org')).toBeNull()
  })
})
