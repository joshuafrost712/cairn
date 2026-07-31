import { describe, it, expect } from 'vitest'
import {
  PATTERN_BELOW,
  PATTERN_SHARE,
  buildEventDigestSegments,
  conversationsForEvent,
  findPatterns,
  renderEventDigestMarkdown,
} from '../src/reports/eventDigest'
import { activityAnalytics, buildCaptureIndex, situate } from '../src/reports/analytics'
import { annotateObservations } from '../src/reports/verification'
import { activity, evaluation, ksa, obs } from './factories'
import type { MentoringConversation } from '../src/lib/types'
import type { ObservationRecord } from '../src/lib/types'

const act = activity({ id: 'act-1', title: 'Psalm 1 workshop', day: '2026-08-26' })
const ksas = [ksa('GENRE', { goal_title: 'Genre Theory' }), ksa('CHECK', { goal_title: 'Checking' })]
const cap = evaluation({ client_id: 'cap-1', activity_id: 'act-1', evaluator_email: 'josh@sil.org' })

function analyze(observations: ObservationRecord[], evaluations = [cap]) {
  const annotated = annotateObservations(observations, [])
  const situated = situate(annotated, buildCaptureIndex(evaluations))
  return activityAnalytics(act, ksas, situated, evaluations)
}

/** n participants on one KSA, the first `low` of them scoring 1 and the rest 3. */
function cohort(n: number, low: number, ksaCode = 'GENRE'): ObservationRecord[] {
  return Array.from({ length: n }, (_, i) =>
    obs({
      id: `o-${ksaCode}-${i}`,
      capture_client_id: 'cap-1',
      participant_id: `p-${i}`,
      participant_name: `P${i}`,
      ksa_code: ksaCode,
      evidence_designation: i < low ? 1 : 3,
    }),
  )
}

function conversation(partial: Partial<MentoringConversation> = {}): MentoringConversation {
  return {
    id: partial.id ?? 'mc::o-1',
    participant_id: partial.participant_id ?? 'p-0',
    participant_name: partial.participant_name ?? 'P0',
    workshop_id: 'w-1',
    trigger_observation_id: 'trigger_observation_id' in partial ? (partial.trigger_observation_id ?? null) : 'o-GENRE-0',
    trigger_ksa_code: 'trigger_ksa_code' in partial ? (partial.trigger_ksa_code ?? null) : 'GENRE',
    trigger_designation: partial.trigger_designation ?? 1,
    trigger_activity_id: 'trigger_activity_id' in partial ? (partial.trigger_activity_id ?? null) : 'act-1',
    status: partial.status ?? 'needed',
    scheduled_for: partial.scheduled_for ?? null,
    summary: partial.summary ?? null,
    participant_response: partial.participant_response ?? null,
    recorded_by: partial.recorded_by ?? null,
    created_at: '2026-08-26T18:00:00.000Z',
    updated_at: '2026-08-26T18:00:00.000Z',
    sync_status: 'synced',
  }
}

describe('the quarter threshold', () => {
  it('triggers at exactly a quarter', () => {
    // 2 of 8 is exactly 25%.
    const p = findPatterns(analyze(cohort(8, 2)))
    expect(p.map((x) => x.ksa_code)).toEqual(['GENRE'])
    expect(p[0].below).toBe(2)
    expect(p[0].observed).toBe(8)
  })

  it('does not trigger just below it', () => {
    // 2 of 9 is 22%.
    expect(findPatterns(analyze(cohort(9, 2)))).toEqual([])
  })

  it('counts people, not observations', () => {
    // One participant with four low observations on the same area is one person
    // having a hard session, not a group pattern. Counting rows would make this
    // 4 of 4 and print a pattern line that is simply false.
    const many = [
      ...Array.from({ length: 4 }, (_, i) =>
        obs({ id: `dup-${i}`, participant_id: 'p-0', participant_name: 'P0', ksa_code: 'GENRE', evidence_designation: 1 }),
      ),
      ...Array.from({ length: 7 }, (_, i) =>
        obs({ id: `ok-${i}`, participant_id: `p-${i + 1}`, participant_name: `P${i + 1}`, ksa_code: 'GENRE', evidence_designation: 3 }),
      ),
    ]
    const patterns = findPatterns(analyze(many))
    expect(patterns).toEqual([])
  })

  it('rolls a participant up to their best score, the way a report does', () => {
    // Scored 0 by one evaluator and 3 by another: the report calls that a 3, so
    // the digest must not count them as below competent.
    const split = [
      obs({ id: 'a', participant_id: 'p-0', participant_name: 'P0', ksa_code: 'GENRE', evidence_designation: 0 }),
      obs({ id: 'b', participant_id: 'p-0', participant_name: 'P0', ksa_code: 'GENRE', evidence_designation: 3 }),
      ...Array.from({ length: 3 }, (_, i) =>
        obs({ id: `c-${i}`, participant_id: `p-${i + 1}`, participant_name: `P${i + 1}`, ksa_code: 'GENRE', evidence_designation: 3 }),
      ),
    ]
    expect(findPatterns(analyze(split))).toEqual([])
  })

  it('reports the widest problem first', () => {
    const p = findPatterns(analyze([...cohort(4, 1, 'GENRE'), ...cohort(4, 3, 'CHECK')]))
    expect(p.map((x) => x.ksa_code)).toEqual(['CHECK', 'GENRE'])
  })

  it('the constants say what they mean', () => {
    expect(PATTERN_SHARE).toBe(0.25)
    expect(PATTERN_BELOW).toBe(2)
  })
})

describe('the digest document', () => {
  it('says so plainly when no area crosses the threshold, rather than printing an empty section', () => {
    const md = renderEventDigestMarkdown(analyze(cohort(8, 1)), [])
    expect(md).toContain('No competency area had a quarter or more of the group below competent.')
  })

  it('labels which average it is showing', () => {
    const segs = buildEventDigestSegments(analyze(cohort(8, 2)), [])
    const mean = segs.find((s) => s.id.endsWith('/grp/mean'))!
    expect(mean.text).toContain('Average across all observations in this event')
    expect(mean.note).toContain('not over participant representatives')
  })

  it('handles an event with nothing routed yet', () => {
    const md = renderEventDigestMarkdown(analyze([]), [])
    expect(md).toContain('nothing to summarize')
    expect(md).not.toContain('Average across')
  })

  it('warns when captures exist that produced no observations', () => {
    const a = analyze(cohort(4, 1), [cap, evaluation({ client_id: 'cap-2', activity_id: 'act-1' })])
    expect(renderEventDigestMarkdown(a, [])).toContain('have not been routed into observations yet')
  })
})

describe('the conversations section', () => {
  it('is frank about a conversation that has not happened, and invents no outcome', () => {
    const md = renderEventDigestMarkdown(analyze(cohort(4, 1)), [conversation({ status: 'needed' })])
    expect(md).toContain('P0: 1/3 on GENRE. Conversation needed, not yet held.')
  })

  it('names the scheduled date when there is one', () => {
    const md = renderEventDigestMarkdown(
      analyze(cohort(4, 1)),
      [conversation({ status: 'scheduled', scheduled_for: '2026-08-27' })],
    )
    expect(md).toContain('scheduled for 2026-08-27, not yet held')
  })

  it('renders both sentences once the conversation is done', () => {
    const md = renderEventDigestMarkdown(analyze(cohort(4, 1)), [
      conversation({
        status: 'completed',
        summary: 'We worked through how to identify a lament.',
        participant_response: 'He took it well and re-drafted that evening.',
      }),
    ])
    expect(md).toContain('We worked through how to identify a lament.')
    expect(md).toContain('He took it well and re-drafted that evening.')
  })

  it('does not leave a completed conversation blank when nobody wrote notes', () => {
    const md = renderEventDigestMarkdown(analyze(cohort(4, 1)), [conversation({ status: 'completed' })])
    expect(md).toContain('no notes were recorded')
  })

  it('says nobody needed one rather than printing an empty section', () => {
    expect(renderEventDigestMarkdown(analyze(cohort(4, 0)), [])).toContain(
      'Nobody from this event needed a one-to-one conversation.',
    )
  })

  it('links the line to the trigger observation so the pane can show what they actually did', () => {
    const segs = buildEventDigestSegments(analyze(cohort(4, 1)), [conversation()])
    const line = segs.find((s) => s.id.includes('/conv/c:'))!
    expect(line.evidence).toEqual(['o-GENRE-0'])
  })

  it('stays brief', () => {
    // The whole point of this document. Four participants, a pattern, and two
    // conversations should still be short enough to read on a phone.
    const md = renderEventDigestMarkdown(
      analyze(cohort(4, 2)),
      [conversation({ id: 'mc::1' }), conversation({ id: 'mc::2', participant_id: 'p-1', participant_name: 'P1' })],
      { fromName: 'Josh' },
    )
    expect(md.split('\n').filter((l) => l.trim()).length).toBeLessThanOrEqual(15)
  })
})

describe('conversationsForEvent', () => {
  it('prefers the recorded activity id', () => {
    const a = analyze(cohort(4, 1))
    const mine = conversation({ trigger_activity_id: 'act-1' })
    const other = conversation({ id: 'mc::x', trigger_activity_id: 'act-2' })
    expect(conversationsForEvent(a, [mine, other], new Map()).map((c) => c.id)).toEqual(['mc::o-1'])
  })

  it('falls back to the capture join when the activity was never stamped', () => {
    const a = analyze(cohort(4, 1))
    const c = conversation({ trigger_activity_id: null })
    const join = new Map([['o-GENRE-0', 'act-1']])
    expect(conversationsForEvent(a, [c], join)).toHaveLength(1)
  })

  it('leaves out a conversation it cannot place rather than guessing it into this event', () => {
    const a = analyze(cohort(4, 1))
    const c = conversation({ trigger_activity_id: null })
    expect(conversationsForEvent(a, [c], new Map())).toEqual([])
  })
})
