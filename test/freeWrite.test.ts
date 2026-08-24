import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import { participantFacingQuestions } from '../src/lib/instructors'
import {
  FREE_WRITE_KEY,
  composeFreeWriteSourceText,
  composeSourceText,
  freeWriteText,
} from '../src/lib/compose'
import { findChromeNode } from '../src/lib/content/chrome'
import {
  FREE_WRITE_INPUT_RULES,
  FREE_WRITE_RULESET_VERSION,
  INPUT_RULES,
  RULESET_VERSION,
} from '../src/lib/ruleset'
import type { Activity, ActivityKsa } from '../src/lib/types'

/**
 * tl-36: the free-write capture.
 *
 * The two halves the spec asks for, tested where each of them actually decides
 * something. The question-scope half is pure and gets real tables. The UI half is
 * a React page this suite cannot mount, so what is asserted here is the seam
 * around it: the compose path, the copy it prints, and four structural invariants
 * that each fail against the pre-tl-36 file. The last group matters most, because
 * this wave has now twice had a green harness that was green about its own stub.
 */

const act = (id: string, audience?: 'participant' | 'instructor'): Pick<Activity, 'id' | 'audience'> =>
  audience ? { id, audience } : { id }
const link = (ksa_id: string, activity_id: string): Pick<ActivityKsa, 'ksa_id' | 'activity_id'> => ({
  ksa_id,
  activity_id,
})

describe('which questions a trainee capture may reach', () => {
  // The two live workshops, at the shape the database actually held on
  // 2026-08-24. The crash course names its instructor questions CC-INS1..3 and
  // Psalms names its INSTR1..3, which is the whole reason this is a wiring rule
  // and not the code list tl-36 was written with.
  const teaching = act('teach-1')
  const alsoTeaching = act('teach-2', 'participant')
  const instructorEvent = act('instr-1', 'instructor')

  it('keeps a question wired to a teaching event', () => {
    const kept = participantFacingQuestions(
      [{ id: 'q1' }],
      [link('q1', 'teach-1')],
      [teaching, instructorEvent],
    )
    expect(kept.map((k) => k.id)).toEqual(['q1'])
  })

  it('drops a question wired only to the instructor event', () => {
    const kept = participantFacingQuestions(
      [{ id: 'q1' }, { id: 'ins1' }],
      [link('q1', 'teach-1'), link('ins1', 'instr-1')],
      [teaching, instructorEvent],
    )
    expect(kept.map((k) => k.id)).toEqual(['q1'])
  })

  it('drops all three instructor questions and keeps all seven of the others', () => {
    // Psalms' real proportions: ten questions, three of them instructor-only.
    const ksas = [...Array(7)].map((_, i) => ({ id: `q${i + 1}` }))
    const instr = [{ id: 'INSTR1' }, { id: 'INSTR2' }, { id: 'INSTR3' }]
    const links = [
      ...ksas.map((k, i) => link(k.id, i % 2 === 0 ? 'teach-1' : 'teach-2')),
      ...instr.map((k) => link(k.id, 'instr-1')),
    ]
    const kept = participantFacingQuestions(
      [...ksas, ...instr],
      links,
      [teaching, alsoTeaching, instructorEvent],
    )
    expect(kept.map((k) => k.id)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'])
  })

  it('keeps a question wired to BOTH kinds of event', () => {
    // An administrator who wired it to a teaching session meant it asked there.
    const kept = participantFacingQuestions(
      [{ id: 'both' }],
      [link('both', 'instr-1'), link('both', 'teach-1')],
      [teaching, instructorEvent],
    )
    expect(kept.map((k) => k.id)).toEqual(['both'])
  })

  it('keeps an unwired question', () => {
    // A workshop mid-setup has plenty, and they carry no evidence either way.
    // `every([])` is true, which is the bug this test exists to hold shut.
    const kept = participantFacingQuestions([{ id: 'orphan' }], [], [teaching, instructorEvent])
    expect(kept.map((k) => k.id)).toEqual(['orphan'])
  })

  it('keeps a question whose only wiring points at an event this device does not hold', () => {
    // The safe direction: show a question the evaluator might need rather than
    // hide one because a wiring row outran its activity.
    const kept = participantFacingQuestions([{ id: 'q1' }], [link('q1', 'gone')], [instructorEvent])
    expect(kept.map((k) => k.id)).toEqual(['q1'])
  })

  it('treats an activity with no audience column as participant-facing', () => {
    // Every pre-tl-30 event is in that state, and Postgres defaults the column.
    const kept = participantFacingQuestions([{ id: 'q1' }], [link('q1', 'legacy')], [act('legacy')])
    expect(kept.map((k) => k.id)).toEqual(['q1'])
  })
})

describe('what a free-write capture sends to routing', () => {
  it('sends the prose, trimmed, and nothing else', () => {
    const answers = { [FREE_WRITE_KEY]: '  Ada read the psalm twice before drafting.\n\n' }
    expect(composeFreeWriteSourceText(answers)).toBe('Ada read the psalm twice before drafting.')
  })

  it('does not add the tagged names, because participant_scope already carries them', () => {
    const text = composeFreeWriteSourceText({ [FREE_WRITE_KEY]: 'Bo hesitated on verse 3.' })
    expect(text).toBe('Bo hesitated on verse 3.')
  })

  it('survives several hundred words about several people at once', () => {
    const dump = [...Array(60)]
      .map((_, i) => `Sentence ${i} about Ada, Bo, Cai and Dev.`)
      .join(' ')
    expect(composeFreeWriteSourceText({ [FREE_WRITE_KEY]: dump })).toBe(dump)
    expect(composeFreeWriteSourceText({ [FREE_WRITE_KEY]: dump }).split(/\s+/).length).toBeGreaterThan(400)
  })

  it('is empty when nothing was written, so listPendingCaptures skips it', () => {
    expect(composeFreeWriteSourceText({})).toBe('')
    expect(composeFreeWriteSourceText({ [FREE_WRITE_KEY]: '   ' })).toBe('')
  })

  it('reads back the prose an evaluator left, and tolerates a missing record', () => {
    expect(freeWriteText({ [FREE_WRITE_KEY]: 'x' })).toBe('x')
    expect(freeWriteText({})).toBe('')
    expect(freeWriteText(null)).toBe('')
    expect(freeWriteText(undefined)).toBe('')
  })

  it('the per-question compose path IGNORES free-write text, which is why submit must wait', () => {
    // The defect the `resolved` gate exists for: before the question scope
    // resolves, `freeWrite` reads false, and this is what the old path would have
    // written over real prose.
    const answers = { [FREE_WRITE_KEY]: 'Real prose an evaluator dictated.' }
    expect(composeSourceText(answers, [])).toBe('')
  })

  it('the reserved key cannot collide with a question id', () => {
    // Every KSA id in this app is a uuid. Double-underscored so it cannot be one.
    expect(FREE_WRITE_KEY).toBe('__free_write__')
    expect(FREE_WRITE_KEY).not.toMatch(/^[0-9a-f]{8}-/)
  })
})

describe('the copy the free-write capture prints', () => {
  const ids = [
    'capture.free-write-title',
    'capture.free-write-promise',
    'capture.free-write-placeholder',
    'capture.free-write-watching',
    'capture.free-write-tag-help',
    'capture.free-write-needs-name',
    'capture.free-write-questions',
    'capture.free-write-no-questions',
    'capture.free-write-rules-short',
    'home.free-write-start',
    'home.free-write-help',
  ]

  it('every id the pages ask for exists in chrome.json', () => {
    const missing = ids.filter((id) => !findChromeNode(id)?.label)
    expect(missing).toEqual([])
  })

  it('the promise says both halves of what the evaluator must do', () => {
    // If this sentence loses either half, the submit gate below is unexplained.
    const promise = findChromeNode('capture.free-write-promise')?.label ?? ''
    expect(promise.toLowerCase()).toContain('write what you saw')
    expect(promise.toLowerCase()).toContain('name the people')
  })

  it('promises filing against participants AND questions, which is what piece 1 makes true', () => {
    const promise = (findChromeNode('capture.free-write-promise')?.label ?? '').toLowerCase()
    expect(promise).toContain('participants')
    expect(promise).toContain('questions')
  })
})

describe('the structural invariants, each of which fails on the pre-tl-36 file', () => {
  const capture = readFileSync('src/pages/CaptureActivity.tsx', 'utf8')
  const home = readFileSync('src/pages/EvaluatorHome.tsx', 'utf8')
  const operations = readFileSync('src/routing/operations.ts', 'utf8')
  const reference = readFileSync('src/db/reference.ts', 'utf8')

  it('the capture screen and the routed file resolve the question set through ONE function', () => {
    // The failure this prevents is silent: the routing contract declares an empty
    // result valid for an empty scope, so a capture whose file inlined the
    // activity's questions while the screen offered the workshop's would come
    // back with zero observations and no error anywhere.
    expect(capture).toContain('ksasInScopeFor')
    expect(operations).toContain('ksasInScopeFor')
    expect(operations).not.toMatch(/ksasForActivity\(/)
  })

  it('free-write mode is derived, never stored, so this spec needs no migration', () => {
    expect(reference).toContain('freeWrite')
    expect(capture).not.toMatch(/capture_mode|free_write_mode|db\.version\(2[12]\)/)
  })

  it('submit is gated on the question set having resolved', () => {
    expect(capture).toMatch(/const resolved = questionScope !== null/)
    expect(capture).toMatch(/canSubmit = resolved && hasContent/)
    expect(capture).toMatch(/disabled=\{!attested \|\| !canSubmit\}/)
  })

  it('a free-write submit requires at least one name', () => {
    expect(capture).toMatch(/namedSomebody = scope\.length > 0/)
    expect(capture).toMatch(/!freeWrite \|\| namedSomebody/)
  })

  it('the free-write box renders instead of the per-question cards, not beside them', () => {
    expect(capture).toMatch(/\{freeWrite && \(/)
    expect(capture).toMatch(/\{!freeWrite && ksas\.map/)
  })

  it('no instructor question is excluded by its CODE anywhere', () => {
    // tl-36 as written named CC-INS1..3. Psalms' are INSTR1..3, so a code list
    // checked against the crash course would have leaked all three of Psalms'.
    for (const src of [capture, home, operations, reference]) {
      expect(src).not.toMatch(/CC-INS[123]|['"]INSTR[123]['"]/)
    }
  })

  it('the free-write entry point is hidden from a reviewer-only account', () => {
    expect(home).toMatch(/!reviewerOnly && \(/)
  })

  it('the free-write capture attests to its OWN rules, not the per-question four', () => {
    // "One activity per capture" is the exact opposite of what this box is for, and
    // an evaluator ticking a box beside it would be attesting to a rule the same
    // screen had just told them to break.
    expect(capture).toMatch(/freeWrite \? FREE_WRITE_INPUT_RULES : INPUT_RULES/)
    expect(FREE_WRITE_INPUT_RULES).not.toContain(
      'One activity per capture — start a new capture for a different activity.',
    )
    expect(FREE_WRITE_INPUT_RULES.some((r) => /several sessions/i.test(r))).toBe(true)
    // The contrast is only real while the per-question list still carries it.
    expect(INPUT_RULES.some((r) => /one activity per capture/i.test(r))).toBe(true)
    // A different ruleset is a different version, stamped on the record.
    expect(FREE_WRITE_RULESET_VERSION).not.toBe(RULESET_VERSION)
    expect(readFileSync('src/db/evaluations.ts', 'utf8')).toMatch(
      /freeWrite \? FREE_WRITE_RULESET_VERSION : RULESET_VERSION/,
    )
  })

  it('the per-session coverage line is not printed over a capture with no session', () => {
    // It read "26 of 26 still need evaluation" from an empty coverage map.
    expect(capture).toMatch(/if \(freeWrite\) return null/)
  })

  it('the free-write box carries no rating control and no guiding-question list', () => {
    const box = capture.slice(capture.indexOf('{freeWrite && ('), capture.indexOf('{!freeWrite && ksas.map'))
    expect(box).not.toContain('QuickRating')
    expect(box).not.toContain('guiding_questions')
    expect(box.match(/<textarea/g) ?? []).toHaveLength(1)
  })
})
