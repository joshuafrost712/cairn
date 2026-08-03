import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  compareForAssignee,
  conversationEvidence,
  deriveNeededConversations,
  guidanceChangedSince,
  isOpenConversation,
  outcomeFields,
  reconcilePatch,
  OPEN_CONVERSATION_STATUSES,
} from '../src/db/mentoring'
import { mentoringOutcomePatch } from '../src/db/sync'
import { annotateObservations } from '../src/reports/verification'
import { readConversationViews, markConversationViewed } from '../src/lib/conversationViews'
import { obs, verdict, participant } from './factories'
import type { MentoringConversation, ObservationRecord, Participant } from '../src/lib/types'

/**
 * tl-06's rules, isolated from their IO.
 *
 * Everything here fails silently if it regresses, which is the standing reason
 * this wave puts a rule in a unit test rather than leaving it to a walkthrough:
 *
 *   - a new column on this table is assignee-writable BY SILENCE, because tl-05's
 *     guard is a deny-list, so a future admin-owned column added without touching
 *     the trigger would be editable by every evaluator and nothing would say so;
 *   - the sidebar badge and this page answer the same question in two files, and a
 *     badge reading 2 above a list of 4 is worse than either number alone;
 *   - the freshness marker's default decides whether "guidance changed" means
 *     anything, and getting it backwards makes every conversation look changed on
 *     first sight, which is indistinguishable from the signal being off;
 *   - and an assignment can reach a phone a sync cycle before the evidence behind
 *     it does, so the panel's empty case is a real state rather than a guard.
 */

const NOW = '2026-08-01T00:00:00.000Z'

function conv(partial: Partial<MentoringConversation> = {}): MentoringConversation {
  return {
    id: partial.id ?? 'mc::obs-x',
    participant_id: partial.participant_id ?? 'p-1',
    participant_name: partial.participant_name ?? 'CIT One',
    workshop_id: 'workshop_id' in partial ? (partial.workshop_id ?? null) : 'ws-1',
    trigger_observation_id:
      'trigger_observation_id' in partial ? (partial.trigger_observation_id ?? null) : 'obs-x',
    trigger_ksa_code: 'trigger_ksa_code' in partial ? (partial.trigger_ksa_code ?? null) : 'GENRE',
    trigger_designation: partial.trigger_designation ?? 1,
    trigger_activity_id:
      'trigger_activity_id' in partial ? (partial.trigger_activity_id ?? null) : null,
    status: partial.status ?? 'needed',
    scheduled_for: 'scheduled_for' in partial ? (partial.scheduled_for ?? null) : null,
    summary: partial.summary ?? null,
    participant_response: partial.participant_response ?? null,
    recorded_by: partial.recorded_by ?? null,
    assigned_to: partial.assigned_to ?? 'e1@x',
    assigned_by: partial.assigned_by ?? 'admin@x',
    assigned_at: partial.assigned_at ?? NOW,
    admin_guidance: 'admin_guidance' in partial ? (partial.admin_guidance ?? null) : 'go gently',
    admin_guidance_updated_at:
      'admin_guidance_updated_at' in partial ? (partial.admin_guidance_updated_at ?? null) : NOW,
    follow_up_needed: partial.follow_up_needed,
    follow_up_note: partial.follow_up_note,
    created_at: partial.created_at ?? NOW,
    updated_at: partial.updated_at ?? NOW,
    sync_status: partial.sync_status ?? 'synced',
  }
}

function confirmedTwice(observation_id: string) {
  return [
    verdict({ observation_id, evaluator_email: 'a@x' }),
    verdict({ observation_id, evaluator_email: 'b@x' }),
  ]
}

// ---------------------------------------------------------------------------

describe('a new column on mentoring_conversation must be classified', () => {
  const url = (name: string) => fileURLToPath(new URL(`../supabase/migrations/${name}`, import.meta.url))
  const guardSql = readFileSync(url('20260801000100_conversation_assignment.sql'), 'utf8')
  const tl06Sql = readFileSync(url('20260801000300_conversation_followup.sql'), 'utf8')

  const frozen = new Set(
    [...guardSql.matchAll(/new\.(\w+)\s+is distinct from\s+old\.\1/g)].map((m) => m[1]),
  )
  const added = [...tl06Sql.matchAll(/add column if not exists\s+(\w+)/g)].map((m) => m[1])
  const onPatch = new Set(Object.keys(mentoringOutcomePatch(conv())))

  it('the migration adds exactly the two columns this spec claims', () => {
    expect(added.sort()).toEqual(['follow_up_needed', 'follow_up_note'])
  })

  /**
   * The generalized form of tl-05's disjointness check, and the point of this
   * whole block. tl-05 asserted that the patch touches nothing frozen; that
   * catches a column wrongly ADDED to the patch and cannot catch one wrongly left
   * OFF the trigger, which is the direction that grants power rather than
   * refusing it. This says every new column landed on one side or the other.
   */
  it('every column it adds is either frozen by the guard or carried by the patch', () => {
    const unclassified = added.filter((col) => !frozen.has(col) && !onPatch.has(col))
    expect(unclassified).toEqual([])
  })

  it('and none of them is on both sides at once', () => {
    expect(added.filter((col) => frozen.has(col) && onPatch.has(col))).toEqual([])
  })

  it('the follow-up pair is on the assignee side specifically', () => {
    expect(onPatch.has('follow_up_needed')).toBe(true)
    expect(onPatch.has('follow_up_note')).toBe(true)
    expect(frozen.has('follow_up_needed')).toBe(false)
  })

  it('the patch sends false rather than nothing for a row written before tl-06', () => {
    // Rows in IndexedDB from before this spec have no such property. JSON.stringify
    // drops an undefined key, and PostgREST reads a missing key as "leave it
    // alone" — so an outcome logged on an upgraded device would silently keep
    // whatever the flag was before.
    const older = conv()
    delete (older as Partial<MentoringConversation>).follow_up_needed
    const sent = mentoringOutcomePatch(older)
    expect(sent.follow_up_needed).toBe(false)
    expect(sent.follow_up_note).toBeNull()
  })
})

describe('the badge and the page ask the same question', () => {
  it('open means assigned-and-unfinished, in one place', () => {
    expect([...OPEN_CONVERSATION_STATUSES]).toEqual(['needed', 'scheduled'])
    expect(isOpenConversation(conv({ status: 'needed' }))).toBe(true)
    expect(isOpenConversation(conv({ status: 'scheduled' }))).toBe(true)
    expect(isOpenConversation(conv({ status: 'completed' }))).toBe(false)
    expect(isOpenConversation(conv({ status: 'dismissed' }))).toBe(false)
  })
})

describe('the order is "what do I owe", not "what exists"', () => {
  it('unscheduled comes before scheduled, however recent', () => {
    const undated = conv({ id: 'b', created_at: '2026-08-01T00:00:00.000Z' })
    const dated = conv({ id: 'a', scheduled_for: '2026-08-02', created_at: '2026-07-01T00:00:00.000Z' })
    expect([dated, undated].sort(compareForAssignee).map((x) => x.id)).toEqual(['b', 'a'])
  })

  it('within the unscheduled group the oldest is first', () => {
    const older = conv({ id: 'old', created_at: '2026-07-29T00:00:00.000Z' })
    const newer = conv({ id: 'new', created_at: '2026-07-31T00:00:00.000Z' })
    expect([newer, older].sort(compareForAssignee).map((x) => x.id)).toEqual(['old', 'new'])
  })

  it('within the scheduled group the soonest is first', () => {
    const soon = conv({ id: 'soon', scheduled_for: '2026-08-02' })
    const later = conv({ id: 'later', scheduled_for: '2026-08-09' })
    expect([later, soon].sort(compareForAssignee).map((x) => x.id)).toEqual(['soon', 'later'])
  })

  it('is a total order, so the list does not reshuffle between renders', () => {
    // Two conversations derived in the same reconcile share created_at exactly,
    // which is the common case rather than a contrived one: the whole batch is
    // stamped from one nowIso. Without the id tiebreak their relative order is
    // whatever the sort happens to do.
    const a = conv({ id: 'mc::a' })
    const b = conv({ id: 'mc::b' })
    expect([b, a].sort(compareForAssignee).map((x) => x.id)).toEqual(['mc::a', 'mc::b'])
    expect([a, b].sort(compareForAssignee).map((x) => x.id)).toEqual(['mc::a', 'mc::b'])
  })
})

describe('guidance freshness', () => {
  it('is not "changed" for a conversation the evaluator has never opened', () => {
    expect(guidanceChangedSince(conv(), undefined)).toBe(false)
    expect(guidanceChangedSince(conv(), null)).toBe(false)
  })

  it('is "changed" when the admin edited it after the last view', () => {
    const c = conv({ admin_guidance_updated_at: '2026-08-01T12:00:00.000Z' })
    expect(guidanceChangedSince(c, '2026-08-01T09:00:00.000Z')).toBe(true)
  })

  it('is not "changed" when the view came after the edit, or at the same instant', () => {
    const c = conv({ admin_guidance_updated_at: '2026-08-01T09:00:00.000Z' })
    expect(guidanceChangedSince(c, '2026-08-01T12:00:00.000Z')).toBe(false)
    expect(guidanceChangedSince(c, '2026-08-01T09:00:00.000Z')).toBe(false)
  })

  it('is never "changed" when there is no guidance stamp at all', () => {
    expect(guidanceChangedSince(conv({ admin_guidance_updated_at: null }), '2020-01-01T00:00:00.000Z')).toBe(
      false,
    )
  })
})

describe('the last-viewed store', () => {
  // Node's built-in localStorage is present here but incomplete (no clear()), so
  // the store gets a real one rather than a partial one. Stubbed per-block so no
  // other test inherits it.
  beforeEach(() => {
    const mem = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: (i: number) => [...mem.keys()][i] ?? null,
      get length() {
        return mem.size
      },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('round-trips a mark', () => {
    const after = markConversationViewed({}, 'mc::a', NOW)
    expect(after['mc::a']).toBe(NOW)
    expect(readConversationViews()).toEqual({ 'mc::a': NOW })
  })

  it('degrades to "never viewed" rather than throwing on a corrupt value', () => {
    localStorage.setItem('cairn.conversation_views', '{not json')
    expect(readConversationViews()).toEqual({})
    localStorage.setItem('cairn.conversation_views', '["an array"]')
    expect(readConversationViews()).toEqual({})
    localStorage.setItem('cairn.conversation_views', '{"mc::a": 17, "mc::b": "ok"}')
    expect(readConversationViews()).toEqual({ 'mc::b': 'ok' })
  })
})

describe('the evidence behind one conversation', () => {
  function annotate(observations: ObservationRecord[]) {
    return annotateObservations(
      observations,
      observations.flatMap((o) => confirmedTwice(o.id)),
    )
  }

  it('finds the triggering observation and the pattern around it', () => {
    const trigger = obs({ id: 'obs-x', participant_id: 'p-1', ksa_code: 'GENRE', imported_at: '2026-07-30' })
    const same = obs({ id: 'obs-y', participant_id: 'p-1', ksa_code: 'GENRE', imported_at: '2026-07-31' })
    const otherKsa = obs({ id: 'obs-z', participant_id: 'p-1', ksa_code: 'AUDIENCE' })
    const otherPerson = obs({ id: 'obs-w', participant_id: 'p-2', ksa_code: 'GENRE' })

    const { trigger: t, pattern } = conversationEvidence(
      conv({ trigger_observation_id: 'obs-x' }),
      annotate([trigger, same, otherKsa, otherPerson]),
    )
    expect(t?.id).toBe('obs-x')
    expect(pattern.map((o) => o.id)).toEqual(['obs-y'])
  })

  it('orders the pattern newest first', () => {
    const rows = [
      obs({ id: 'obs-x', participant_id: 'p-1', ksa_code: 'GENRE', imported_at: '2026-07-20' }),
      obs({ id: 'obs-old', participant_id: 'p-1', ksa_code: 'GENRE', imported_at: '2026-07-21' }),
      obs({ id: 'obs-new', participant_id: 'p-1', ksa_code: 'GENRE', imported_at: '2026-07-29' }),
    ]
    const { pattern } = conversationEvidence(conv({ trigger_observation_id: 'obs-x' }), annotate(rows))
    expect(pattern.map((o) => o.id)).toEqual(['obs-new', 'obs-old'])
  })

  it('reports a missing trigger as missing, and still finds the pattern', () => {
    // The partial-sync state: the assignment arrived, the observation has not.
    // The KSA falls back to the conversation's own trigger_ksa_code, which is
    // exactly why that column is denormalized onto the row.
    const same = obs({ id: 'obs-y', participant_id: 'p-1', ksa_code: 'GENRE' })
    const { trigger, pattern } = conversationEvidence(
      conv({ trigger_observation_id: 'obs-x' }),
      annotate([same]),
    )
    expect(trigger).toBeNull()
    expect(pattern.map((o) => o.id)).toEqual(['obs-y'])
  })

  it('shows nothing rather than everything when the conversation names no question', () => {
    const other = obs({ id: 'obs-y', participant_id: 'p-1', ksa_code: 'GENRE' })
    const { pattern } = conversationEvidence(
      conv({ trigger_observation_id: null, trigger_ksa_code: null }),
      annotate([other]),
    )
    expect(pattern).toEqual([])
  })

  it('carries the adjusted designation as effective and keeps the raw one visible', () => {
    // The honesty rule the spec names for this panel, checked at the seam it
    // actually passes through rather than in the renderer.
    const raw = obs({ id: 'obs-x', participant_id: 'p-1', ksa_code: 'GENRE', evidence_designation: 1 })
    const annotated = annotateObservations(raw ? [raw] : [], [
      verdict({ observation_id: 'obs-x', evaluator_email: 'a@x', decision: 'adjust', adjusted_designation: 2 }),
      verdict({ observation_id: 'obs-x', evaluator_email: 'b@x', decision: 'adjust', adjusted_designation: 2 }),
    ])
    const { trigger } = conversationEvidence(conv({ trigger_observation_id: 'obs-x' }), annotated)
    expect(trigger?.vstatus).toBe('adjusted')
    expect(trigger?.effective_designation).toBe(2)
    expect(trigger?.evidence_designation).toBe(1)
  })
})

describe('logging an outcome', () => {
  const base = { summary: 'we talked', participant_response: 'took it well', recorded_by: 'e1@x' }

  it('completes the conversation and records the assignee', () => {
    const f = outcomeFields(base)
    expect(f.status).toBe('completed')
    expect(f.recorded_by).toBe('e1@x')
    expect(f.follow_up_needed).toBe(false)
    expect(f.follow_up_note).toBeNull()
  })

  it('keeps a note only when the flag is raised', () => {
    expect(outcomeFields({ ...base, follow_up_needed: true, follow_up_note: 'wants to talk again' }))
      .toMatchObject({ follow_up_needed: true, follow_up_note: 'wants to talk again' })
    // Typed a note, then unticked the box: the note goes with the flag, or an
    // admin ends up with a note that no view in the app will ever show them.
    expect(outcomeFields({ ...base, follow_up_needed: false, follow_up_note: 'wants to talk again' }))
      .toMatchObject({ follow_up_needed: false, follow_up_note: null })
  })

  it('treats a whitespace note as no note', () => {
    expect(outcomeFields({ ...base, follow_up_needed: true, follow_up_note: '   ' }).follow_up_note)
      .toBeNull()
  })
})

describe('the activity behind the evidence', () => {
  function low(id: string, capture: string): ObservationRecord {
    return obs({
      id,
      capture_client_id: capture,
      participant_id: 'p-1',
      workshop_id: 'ws-1',
      evidence_designation: 1,
    })
  }
  const people = (): Map<string, Participant> =>
    new Map([['p-1', participant({ id: 'p-1', workshop_id: 'ws-1' })]])

  it('is resolved from the capture the observation came from', () => {
    const annotated = annotateObservations([low('obs-x', 'cap-7')], confirmedTwice('obs-x'))
    // `undefined` in the scale slot, not a missing argument: tl-09 landed a scale
    // resolver as the fourth parameter and tl-06 wrote this call against a signature
    // where the activity map was fourth. Passing undefined keeps the default 0-3
    // scale these fixtures assume while putting the map where it now belongs.
    const [derived] = deriveNeededConversations(
      annotated,
      people(),
      NOW,
      undefined,
      new Map([['cap-7', 'act-3']]),
    )
    expect(derived.trigger_activity_id).toBe('act-3')
  })

  it('is null when the capture is not on this device, rather than guessed', () => {
    const annotated = annotateObservations([low('obs-x', 'cap-7')], confirmedTwice('obs-x'))
    const [derived] = deriveNeededConversations(annotated, people(), NOW, undefined, new Map())
    expect(derived.trigger_activity_id).toBeNull()
  })

  it('is filled in by reconcile on a row that predates tl-06, and never overwritten', () => {
    const existing = conv({ trigger_activity_id: null, workshop_id: 'ws-1' })
    const derived = conv({ trigger_activity_id: 'act-3', workshop_id: 'ws-1' })
    expect(reconcilePatch(existing, derived)).toMatchObject({
      trigger_activity_id: 'act-3',
      sync_status: 'queued',
    })

    const alreadySet = conv({ trigger_activity_id: 'act-1', workshop_id: 'ws-1' })
    expect(reconcilePatch(alreadySet, derived)).toBeNull()
  })

  it('leaves tl-05\'s workshop repair working, and combines with it', () => {
    const both = reconcilePatch(
      conv({ workshop_id: null, trigger_activity_id: null }),
      conv({ workshop_id: 'ws-1', trigger_activity_id: 'act-3' }),
    )
    expect(both).toMatchObject({
      workshop_id: 'ws-1',
      trigger_activity_id: 'act-3',
      sync_status: 'queued',
      sync_error: null,
    })
  })

  it('makes no repair, and no re-queue, when there is nothing to fill', () => {
    // The property that matters: reconcile runs on every visit to the admin queue,
    // so a version of this that returned a patch unconditionally would put the
    // whole queue back in the outbox on every page load.
    expect(reconcilePatch(conv({ workshop_id: 'ws-1', trigger_activity_id: 'act-1' }), conv())).toBeNull()
  })
})
