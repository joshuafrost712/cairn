import { describe, it, expect, afterEach } from 'vitest'
import {
  buildSyncFunnel,
  exceptionRows,
  formatAge,
  stageOf,
  summarizePending,
} from '../src/reports/syncHealth'
import { acquireChannel, activeChannelTopics, resetChannelRegistry } from '../src/db/channelRegistry'
import type {
  EvaluationRecord,
  ObservationRecord,
  VerificationVerdict,
} from '../src/lib/types'

/**
 * tl-18's arithmetic, isolated from its IO.
 *
 * Every boundary here has a silent failure on the other side of it. An
 * evaluation with observations but no verdicts looks finished and is not. A row
 * refused by the backend still renders, just with stale contents. A channel
 * subscribed twice throws into a swallowed promise and the screen simply stops
 * updating. None of these produce a bug report, so they need a test.
 */

const T0 = Date.parse('2026-07-20T09:00:00.000Z')
const NOW = Date.parse('2026-07-30T09:00:00.000Z')

function evaluation(over: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return {
    client_id: 'cap-1',
    evaluator_email: 'maria@example.org',
    activity_id: 'act-1',
    workshop_id: 'ws-1',
    source_language: 'en',
    answers: {},
    quick_ratings: {},
    focus_participant_id: null,
    source_text: 'she retold the passage from memory',
    participant_scope: [],
    attestation: true,
    ruleset_version: 'v1',
    edit_history: [],
    created_at: new Date(T0).toISOString(),
    updated_at: new Date(T0).toISOString(),
    sync_status: 'synced',
    sync_error: null,
    ...over,
  }
}

function observation(over: Partial<ObservationRecord> = {}): ObservationRecord {
  return {
    id: 'cap-1::0',
    capture_client_id: 'cap-1',
    workshop_id: 'ws-1',
    participant_id: 'p-1',
    participant_name: 'Maria',
    ksa_code: 'K1',
    text: 'retold the passage accurately',
    source_excerpt: 'from memory',
    evidence_designation: 2,
    sentiment_flag: 'neutral',
    confidence: 'high',
    needs_review: false,
    origin: 'individual',
    imported_at: new Date(T0).toISOString(),
    sync_status: 'synced',
    sync_error: null,
    ...over,
  }
}

function verdict(over: Partial<VerificationVerdict> = {}): VerificationVerdict {
  return {
    id: 'cap-1::0::a@example.org',
    observation_id: 'cap-1::0',
    capture_client_id: 'cap-1',
    workshop_id: 'ws-1',
    evaluator_email: 'a@example.org',
    decision: 'confirm',
    at: new Date(T0).toISOString(),
    sync_status: 'synced',
    ...over,
  }
}

describe('stageOf', () => {
  const noVerdicts = new Map<string, VerificationVerdict[]>()

  it('an unsent evaluation is unsynced whatever else is true of it', () => {
    const row = stageOf(evaluation({ sync_status: 'local' }), [observation()], noVerdicts, 2)
    expect(row.stage).toBe('unsynced')
  })

  it('a refused row is unsynced, not synced-with-a-warning', () => {
    // The distinction that failed: 'error' is a row the server does NOT have.
    const row = stageOf(
      evaluation({ sync_status: 'error', sync_error: 'row-level security' }),
      [],
      noVerdicts,
      2,
    )
    expect(row.stage).toBe('unsynced')
    expect(row.sync_error).toBe('row-level security')
  })

  it('sent with no observations is unrouted, never counting', () => {
    const row = stageOf(evaluation(), [], noVerdicts, 2)
    expect(row.stage).toBe('synced-unrouted')
    expect(row.observations).toBe(0)
  })

  it('observations with zero verdicts are routed-unverified', () => {
    // The case a naive "has observations" check calls done.
    const row = stageOf(evaluation(), [observation()], noVerdicts, 2)
    expect(row.stage).toBe('routed-unverified')
    expect(row.awaitingVerdicts).toBe(1)
    expect(row.counting).toBe(0)
  })

  it('one short of the threshold is still not counting', () => {
    const verdicts = new Map([['cap-1::0', [verdict()]]])
    expect(stageOf(evaluation(), [observation()], verdicts, 2).stage).toBe('routed-unverified')
  })

  it('exactly at the threshold counts', () => {
    const verdicts = new Map([
      ['cap-1::0', [verdict(), verdict({ id: 'v2', evaluator_email: 'b@example.org' })]],
    ])
    const row = stageOf(evaluation(), [observation()], verdicts, 2)
    expect(row.stage).toBe('verified-counting')
    expect(row.counting).toBe(1)
  })

  it('one unconfirmed observation holds the whole evaluation back', () => {
    const verdicts = new Map([
      ['cap-1::0', [verdict(), verdict({ id: 'v2', evaluator_email: 'b@example.org' })]],
    ])
    const row = stageOf(
      evaluation(),
      [observation(), observation({ id: 'cap-1::1' })],
      verdicts,
      2,
    )
    expect(row.stage).toBe('routed-unverified')
    expect(row.counting).toBe(1)
    expect(row.awaitingVerdicts).toBe(1)
  })

  it('a rejected observation is disputed, and disputed does not count', () => {
    const verdicts = new Map([
      [
        'cap-1::0',
        [verdict(), verdict({ id: 'v2', evaluator_email: 'b@example.org', decision: 'reject' })],
      ],
    ])
    const row = stageOf(evaluation(), [observation()], verdicts, 2)
    expect(row.stage).toBe('routed-unverified')
    expect(row.disputed).toBe(1)
    expect(row.counting).toBe(0)
  })

  it('reads the threshold it is given rather than the device setting', () => {
    const verdicts = new Map([['cap-1::0', [verdict()]]])
    expect(stageOf(evaluation(), [observation()], verdicts, 1).stage).toBe('verified-counting')
    expect(stageOf(evaluation(), [observation()], verdicts, 3).stage).toBe('routed-unverified')
  })
})

describe('buildSyncFunnel', () => {
  it('counts one workshop across all four stages', () => {
    const evaluations = [
      evaluation({ client_id: 'a', sync_status: 'local' }),
      evaluation({ client_id: 'b' }),
      evaluation({ client_id: 'c' }),
      evaluation({ client_id: 'd' }),
    ]
    const observations = [
      observation({ id: 'c::0', capture_client_id: 'c' }),
      observation({ id: 'd::0', capture_client_id: 'd' }),
    ]
    const verdicts = [
      verdict({ id: 'v1', observation_id: 'd::0', capture_client_id: 'd' }),
      verdict({
        id: 'v2',
        observation_id: 'd::0',
        capture_client_id: 'd',
        evaluator_email: 'b@example.org',
      }),
    ]
    const funnel = buildSyncFunnel(evaluations, observations, verdicts, 2)
    expect(funnel.rollup).toMatchObject({
      total: 4,
      unsynced: 1,
      syncedUnrouted: 1,
      routedUnverified: 1,
      verifiedCounting: 1,
    })
  })

  it('leaves unattested drafts out and says how many', () => {
    // Otherwise "not sent" is permanently non-zero on any device mid-capture,
    // and a number that is always red is a number nobody looks at.
    const funnel = buildSyncFunnel(
      [evaluation({ client_id: 'a' }), evaluation({ client_id: 'b', attestation: false, sync_status: 'local' })],
      [],
      [],
      2,
    )
    expect(funnel.rollup.total).toBe(1)
    expect(funnel.draftsExcluded).toBe(1)
  })

  it('counts an errored row once, in both unsynced and errored', () => {
    const funnel = buildSyncFunnel(
      [evaluation({ sync_status: 'error', sync_error: 'boom' })],
      [],
      [],
      2,
    )
    expect(funnel.rollup.unsynced).toBe(1)
    expect(funnel.rollup.errored).toBe(1)
    expect(funnel.rollup.total).toBe(1)
  })

  it('breaks the same rollup down per evaluator', () => {
    const funnel = buildSyncFunnel(
      [
        evaluation({ client_id: 'a', evaluator_email: 'maria@example.org' }),
        evaluation({ client_id: 'b', evaluator_email: 'sam@example.org', sync_status: 'local' }),
        evaluation({ client_id: 'c', evaluator_email: 'sam@example.org' }),
      ],
      [],
      [],
      2,
    )
    expect(funnel.byEvaluator.map((e) => [e.evaluator_email, e.total, e.unsynced])).toEqual([
      ['maria@example.org', 1, 0],
      ['sam@example.org', 2, 1],
    ])
  })

  it('groups an evaluation with no email rather than dropping it', () => {
    const funnel = buildSyncFunnel([evaluation({ evaluator_email: null })], [], [], 2)
    expect(funnel.byEvaluator[0].evaluator_email).toBe('unattributed')
    expect(funnel.rollup.total).toBe(1)
  })

  it('ignores observations belonging to a capture it was not given', () => {
    // A stray observation must not invent a stage for a capture that is absent.
    const funnel = buildSyncFunnel(
      [evaluation({ client_id: 'a' })],
      [observation({ id: 'zz::0', capture_client_id: 'zz' })],
      [],
      2,
    )
    expect(funnel.rollup.syncedUnrouted).toBe(1)
    expect(funnel.rows).toHaveLength(1)
  })
})

describe('exceptionRows', () => {
  it('sorts each exception into exactly one list', () => {
    const funnel = buildSyncFunnel(
      [
        evaluation({ client_id: 'a', sync_status: 'error', sync_error: 'denied' }),
        evaluation({ client_id: 'b' }),
        evaluation({ client_id: 'c' }),
      ],
      [observation({ id: 'c::0', capture_client_id: 'c' })],
      [],
      2,
    )
    const ex = exceptionRows(funnel)
    expect(ex.errored.map((r) => r.client_id)).toEqual(['a'])
    expect(ex.unrouted.map((r) => r.client_id)).toEqual(['b'])
    expect(ex.unverified.map((r) => r.client_id)).toEqual(['c'])
  })
})

describe('formatAge', () => {
  it('uses the coarsest unit that is still true', () => {
    expect(formatAge(new Date(NOW - 30_000).toISOString(), NOW)).toBe('just now')
    expect(formatAge(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5 min')
    expect(formatAge(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3 hours')
    expect(formatAge(new Date(NOW - 3_600_000).toISOString(), NOW)).toBe('1 hour')
    expect(formatAge(new Date(NOW - 4 * 86_400_000).toISOString(), NOW)).toBe('4 days')
    expect(formatAge(new Date(NOW - 86_400_000).toISOString(), NOW)).toBe('1 day')
  })

  it('says unknown rather than NaN', () => {
    expect(formatAge(null, NOW)).toBe('unknown')
    expect(formatAge('not a date', NOW)).toBe('unknown')
  })
})

describe('summarizePending', () => {
  it('counts all three queues and ages the oldest', () => {
    const s = summarizePending(
      {
        evaluations: [{ updated_at: new Date(NOW - 4 * 86_400_000).toISOString() }],
        observations: [{ imported_at: new Date(NOW - 3_600_000).toISOString() }],
        verdicts: [{ at: new Date(NOW - 60_000).toISOString() }],
      },
      true,
      NOW,
    )
    expect(s.total).toBe(3)
    expect(s.oldestAge).toBe('4 days')
    expect(s.stranded).toBe(false)
  })

  it('is stranded when there is queued work and no backend at all', () => {
    // The month-long failure, reduced to one assertion.
    const s = summarizePending(
      { evaluations: [{ updated_at: new Date(NOW).toISOString() }], observations: [], verdicts: [] },
      false,
      NOW,
    )
    expect(s.stranded).toBe(true)
  })

  it('is not stranded when there is nothing to send', () => {
    expect(summarizePending({ evaluations: [], observations: [], verdicts: [] }, false, NOW).stranded).toBe(
      false,
    )
  })

  it('reports a count even when every timestamp is unusable', () => {
    const s = summarizePending({ evaluations: [{}], observations: [], verdicts: [] }, true, NOW)
    expect(s.total).toBe(1)
    expect(s.oldestAge).toBeNull()
  })
})

describe('acquireChannel', () => {
  afterEach(() => resetChannelRegistry())

  it('opens once for a topic and closes when the last holder releases', () => {
    let opens = 0
    let closes = 0
    const open = () => {
      opens++
      return () => {
        closes++
      }
    }
    const a = acquireChannel('coverage:ws-1', open)
    const b = acquireChannel('coverage:ws-1', open)
    expect(opens).toBe(1)
    a()
    expect(closes).toBe(0)
    expect(activeChannelTopics()).toEqual(['coverage:ws-1'])
    b()
    expect(closes).toBe(1)
    expect(activeChannelTopics()).toEqual([])
  })

  it('survives a release called twice', () => {
    // React StrictMode's exact shape: mount, cleanup, remount, cleanup. A
    // double-release that decremented twice would close a channel the live
    // mount is still using, and nothing on screen would say the feed had died.
    let closes = 0
    const open = () => () => {
      closes++
    }
    const first = acquireChannel('t', open)
    const second = acquireChannel('t', open)
    first()
    first()
    expect(closes).toBe(0)
    second()
    expect(closes).toBe(1)
  })

  it('reopens a topic after it was fully released', () => {
    let opens = 0
    const open = () => {
      opens++
      return () => {}
    }
    acquireChannel('t', open)()
    acquireChannel('t', open)
    expect(opens).toBe(2)
  })

  it('keeps topics independent', () => {
    const open = () => () => {}
    acquireChannel('coverage:ws-1', open)
    acquireChannel('observations:ws-1', open)
    expect(activeChannelTopics()).toEqual(['coverage:ws-1', 'observations:ws-1'])
  })
})
