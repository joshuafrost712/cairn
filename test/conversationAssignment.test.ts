import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { annotateObservations } from '../src/reports/verification'
import {
  deriveNeededConversations,
  evaluatorLoads,
  normalizeEmail,
  reconcilePatch,
} from '../src/db/mentoring'
import { mentoringOutcomePatch } from '../src/db/sync'
import { obs, verdict, participant } from './factories'
import type { MentoringConversation, Participant } from '../src/lib/types'

/**
 * tl-05's decisions, isolated from their IO.
 *
 * Every one of these fails silently if it regresses, which is why it is here
 * rather than left to the browser walkthrough:
 *
 *   - reconcile runs on every visit to either conversations page, so a version
 *     of it that overwrites would unassign the whole queue on a page load and
 *     look exactly like nothing having happened;
 *   - a conversation derived with no workshop_id is refused by every policy on
 *     the table, and the refusal surfaces as an opaque constraint error rather
 *     than as "this conversation belongs nowhere";
 *   - and the evaluator's outbox patch touching one admin-owned column would
 *     make every evaluator's outcome write fail in the field, with the cause
 *     three files away from the symptom.
 */

const NOW = '2026-08-01T00:00:00.000Z'
const LATER = '2026-08-02T00:00:00.000Z'

function pmap(...ps: Participant[]): Map<string, Participant> {
  return new Map(ps.map((p) => [p.id, p]))
}

function confirmedTwice(observation_id: string) {
  return [
    verdict({ observation_id, evaluator_email: 'a@x' }),
    verdict({ observation_id, evaluator_email: 'b@x' }),
  ]
}

function derivedLow(overrides: Parameters<typeof obs>[0] = {}) {
  const o = obs({ id: 'low-1', evidence_designation: 1, participant_id: 'p-1', ...overrides })
  const annotated = annotateObservations([o], confirmedTwice(o.id))
  return deriveNeededConversations(
    annotated,
    pmap(participant({ id: 'p-1', name: 'CIT One', workshop_id: 'ws-participant' })),
    NOW,
  )[0]
}

describe('the derived conversation carries a workshop', () => {
  it('(a) takes it from the observation, which has had one since tl-04', () => {
    expect(derivedLow({ workshop_id: 'ws-obs' }).workshop_id).toBe('ws-obs')
  })

  it('(b) falls back to the participant when the observation predates tl-04', () => {
    // Same answer by a different route. Without this an observation imported
    // before tl-04 produces a conversation the backend can never accept.
    expect(derivedLow({ workshop_id: null }).workshop_id).toBe('ws-participant')
  })

  it('(c) starts unassigned, with no guidance', () => {
    const d = derivedLow({ workshop_id: 'ws-obs' })
    expect(d.assigned_to).toBeNull()
    expect(d.assigned_by).toBeNull()
    expect(d.assigned_at).toBeNull()
    expect(d.admin_guidance).toBeNull()
    expect(d.admin_guidance_updated_at).toBeNull()
  })
})

describe('reconcile never clobbers what an admin wrote', () => {
  const derived = () => derivedLow({ workshop_id: 'ws-obs' })

  const assigned = (over: Partial<MentoringConversation> = {}): MentoringConversation => ({
    ...derived(),
    workshop_id: 'ws-obs',
    status: 'scheduled',
    scheduled_for: '2026-08-05',
    assigned_to: 'kate@example.org',
    assigned_by: 'josh@example.org',
    assigned_at: LATER,
    admin_guidance: 'Lead with what improved.',
    admin_guidance_updated_at: LATER,
    sync_status: 'synced',
    ...over,
  })

  it('(a) leaves an assigned row entirely alone', () => {
    expect(reconcilePatch(assigned(), derived())).toBeNull()
  })

  it('(b) leaves a completed row alone even though the derivation says "needed"', () => {
    // The derivation always produces a fresh 'needed' stub. If reconcile ever
    // merged it in, every logged conversation would reopen on the next visit.
    expect(reconcilePatch(assigned({ status: 'completed' }), derived())).toBeNull()
  })

  it('(c) leaves an unassigned row alone too, when it already knows its workshop', () => {
    expect(
      reconcilePatch(assigned({ assigned_to: null, admin_guidance: null }), derived()),
    ).toBeNull()
  })

  it('(d) fills a missing workshop_id, and only that, and re-queues the row', () => {
    const patch = reconcilePatch(assigned({ workshop_id: null }), derived())
    expect(patch).toEqual({ workshop_id: 'ws-obs', sync_status: 'queued', sync_error: null })
    // Specifically: the repair does not carry the assignment back to null.
    expect(patch).not.toHaveProperty('assigned_to')
    expect(patch).not.toHaveProperty('admin_guidance')
    expect(patch).not.toHaveProperty('status')
  })

  it('(e) makes no repair it cannot complete', () => {
    // Both sides unknown. Writing null over null would only churn the outbox.
    const nowhere = deriveNeededConversations(
      annotateObservations(
        [obs({ id: 'low-2', evidence_designation: 0, participant_id: 'p-9', workshop_id: null })],
        confirmedTwice('low-2'),
      ),
      pmap(),
      NOW,
    )[0]
    expect(nowhere.workshop_id).toBeNull()
    expect(reconcilePatch(assigned({ workshop_id: null }), nowhere)).toBeNull()
  })
})

describe('evaluatorLoads', () => {
  const conv = (over: Partial<MentoringConversation>): MentoringConversation =>
    ({ ...derivedLow({ workshop_id: 'ws-obs' }), ...over }) as MentoringConversation

  it('(a) includes evaluators carrying nothing, who are the point of the view', () => {
    const loads = evaluatorLoads([], ['kate@example.org', 'sam@example.org'])
    expect(loads.map((l) => l.email)).toEqual(['kate@example.org', 'sam@example.org'])
    expect(loads.every((l) => l.open === 0)).toBe(true)
  })

  it('(b) counts open, scheduled and logged separately, and ignores dismissed', () => {
    const loads = evaluatorLoads(
      [
        conv({ id: 'a', assigned_to: 'kate@example.org', status: 'needed' }),
        conv({ id: 'b', assigned_to: 'kate@example.org', status: 'scheduled' }),
        conv({ id: 'c', assigned_to: 'kate@example.org', status: 'completed' }),
        conv({ id: 'd', assigned_to: 'kate@example.org', status: 'dismissed' }),
      ],
      ['kate@example.org'],
    )
    // A scheduled conversation is still carried, so it counts in both columns.
    expect(loads[0]).toEqual({ email: 'kate@example.org', open: 2, scheduled: 1, completed: 1 })
  })

  it('(c) matches case-insensitively, because the roster and the row disagree', () => {
    const loads = evaluatorLoads(
      [conv({ id: 'a', assigned_to: 'Kate@Example.org', status: 'needed' })],
      ['kate@example.org'],
    )
    expect(loads).toHaveLength(1)
    expect(loads[0].open).toBe(1)
  })

  it('(d) still shows somebody who has left the workshop while they hold work', () => {
    // Dropping them would make the per-evaluator view add up to less than the
    // queue contains, which is the one way this table could mislead.
    const loads = evaluatorLoads(
      [conv({ id: 'a', assigned_to: 'gone@example.org', status: 'needed' })],
      ['kate@example.org'],
    )
    expect(loads.map((l) => l.email).sort()).toEqual(['gone@example.org', 'kate@example.org'])
  })

  it('(e) ignores unassigned rows rather than attributing them to anybody', () => {
    const loads = evaluatorLoads([conv({ id: 'a', assigned_to: null })], ['kate@example.org'])
    expect(loads[0].open).toBe(0)
  })

  it('(f) sorts the busiest first, which is what makes it usable while assigning', () => {
    const loads = evaluatorLoads(
      [
        conv({ id: 'a', assigned_to: 'sam@example.org', status: 'needed' }),
        conv({ id: 'b', assigned_to: 'sam@example.org', status: 'needed' }),
        conv({ id: 'c', assigned_to: 'kate@example.org', status: 'needed' }),
      ],
      ['kate@example.org', 'sam@example.org'],
    )
    expect(loads.map((l) => l.email)).toEqual(['sam@example.org', 'kate@example.org'])
  })
})

describe('normalizeEmail', () => {
  it('lowercases and trims, because the read policy compares lowercased', () => {
    expect(normalizeEmail('  Kate@Example.ORG ')).toBe('kate@example.org')
  })
})

/**
 * The structural guard.
 *
 * The evaluator's outbox sends a narrow patch precisely so a stale copy of an
 * admin-owned column cannot cost them their write. That only holds while the two
 * lists stay disjoint, and they live in two files and two languages — so this
 * test reads the columns the migration's trigger freezes straight out of the SQL
 * and checks the patch against them. Adding `admin_guidance` to the patch for
 * convenience would otherwise break every evaluator's sync in the field, with
 * nothing failing until somebody is standing in a workshop.
 */
describe('the evaluator outbox patch and the database guard agree', () => {
  const sql = readFileSync(
    fileURLToPath(
      new URL('../supabase/migrations/20260801000100_conversation_assignment.sql', import.meta.url),
    ),
    'utf8',
  )

  const frozen = [...sql.matchAll(/new\.(\w+)\s+is distinct from\s+old\.\1/g)].map((m) => m[1])

  it('(a) the migration really does freeze the columns this spec says it does', () => {
    expect(new Set(frozen)).toEqual(
      new Set([
        'assigned_to',
        'assigned_by',
        'assigned_at',
        'admin_guidance',
        'admin_guidance_updated_at',
        'workshop_id',
        'participant_id',
        'trigger_observation_id',
        'trigger_ksa_code',
        'trigger_designation',
      ]),
    )
  })

  it('(b) the patch an assignee sends touches none of them', () => {
    const sent = Object.keys(
      mentoringOutcomePatch(derivedLow({ workshop_id: 'ws-obs' }) as MentoringConversation),
    )
    expect(sent.filter((k) => frozen.includes(k))).toEqual([])
  })

  it('(c) the patch still carries everything an outcome is made of', () => {
    const sent = Object.keys(
      mentoringOutcomePatch(derivedLow({ workshop_id: 'ws-obs' }) as MentoringConversation),
    )
    expect(sent.sort()).toEqual(
      ['participant_response', 'recorded_by', 'scheduled_for', 'status', 'summary', 'updated_at'],
    )
  })
})
