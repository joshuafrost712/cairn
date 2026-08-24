import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import { participantFacingQuestions } from '../src/lib/instructors'
import {
  FREE_WRITE_KEY,
  composeFreeWriteSourceText,
  composeSourceText,
  canSubmitCapture,
  captureScopeView,
  freeWriteText,
  hasPerQuestionAnswer,
  isFreeWriteCapture,
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

  it('DROPS a question whose only wiring points at an event this device cannot read', () => {
    // The finding that made this a wiring rule rather than an every-check. RLS hides
    // an instructor-audience activity from a member with no reviewer pair, while the
    // questions and their wiring rows sync to everybody. So on five of Psalms' seven
    // devices the three instructor questions are wired to an activity that is not
    // there. Read as "unwired" they would be offered to a trainee brain dump; read
    // as "wired to something I cannot see" they are correctly left out.
    const kept = participantFacingQuestions([{ id: 'q1' }], [link('q1', 'invisible')], [instructorEvent])
    expect(kept.map((k) => k.id)).toEqual([])
  })

  it('and that is the difference between an unreadable wiring and no wiring at all', () => {
    // Both questions have "no visible participant-facing event". Only one of them
    // has no event at all, and only that one is kept.
    const kept = participantFacingQuestions(
      [{ id: 'orphan' }, { id: 'hidden' }],
      [link('hidden', 'invisible')],
      [teaching],
    )
    expect(kept.map((k) => k.id)).toEqual(['orphan'])
  })

  it('scopes the links to these questions itself, so no caller can get that wrong', () => {
    // The original defect lived in the CALLER, which filtered links by activity id
    // and so deleted exactly the rows that distinguish the two cases above. The
    // filter now lives here, where it is covered by a test rather than by a regex
    // over somebody else's source: the whole link table can be passed in.
    const wholeTable = [
      link('q1', 'teach-1'),
      link('someone-elses-question', 'teach-1'),
      link('ins1', 'instr-1'),
    ]
    const kept = participantFacingQuestions([{ id: 'q1' }, { id: 'ins1' }], wholeTable, [
      teaching,
      instructorEvent,
    ])
    expect(kept.map((k) => k.id)).toEqual(['q1'])
    // And the caller passes it unfiltered, which is the point.
    expect(readFileSync('src/db/reference.ts', 'utf8')).toMatch(
      /participantFacingQuestions\(ksas, links, activities\)/,
    )
  })

  it('treats an activity with no audience column as participant-facing', () => {
    // Every pre-tl-30 event is in that state, and Postgres defaults the column.
    const kept = participantFacingQuestions([{ id: 'q1' }], [link('q1', 'legacy')], [act('legacy')])
    expect(kept.map((k) => k.id)).toEqual(['q1'])
  })
})

describe('whether a capture is a free-write one', () => {
  const noEvent = { activity_id: null, workshop_id: 'w1' }
  const onEvent = { activity_id: 'a1', workshop_id: 'w1' }
  const ref = (isInstructorEvent: boolean, activityQuestions: number) => ({
    isInstructorEvent,
    activityQuestions,
  })

  it('a capture with no session is free-write', () => {
    expect(isFreeWriteCapture(noEvent, ref(false, 0))).toBe(true)
  })

  it('a capture on a session that has questions is not', () => {
    expect(isFreeWriteCapture(onEvent, ref(false, 3))).toBe(false)
  })

  it('a capture on a session with NO questions wired is, which is the three bare events', () => {
    expect(isFreeWriteCapture(onEvent, ref(false, 0))).toBe(true)
  })

  it('an instructor review is never free-write, whatever else is true', () => {
    expect(isFreeWriteCapture(onEvent, ref(true, 0))).toBe(false)
    expect(isFreeWriteCapture({ ...onEvent, answers: { [FREE_WRITE_KEY]: 'prose' } }, ref(true, 0))).toBe(
      false,
    )
  })

  it('A SUBMITTED FREE-WRITE STAYS ONE AFTER SOMEBODY WIRES A QUESTION TO ITS SESSION', () => {
    // The blocking finding. Without the stored marker this returns false, the box
    // stops rendering over prose that is still in the row, and "Save changes" writes
    // composeSourceText's empty string over a real source_text. The capture then
    // never routes, because listPendingCaptures filters on source_text.trim().
    const filed = {
      ...onEvent,
      answers: { [FREE_WRITE_KEY]: 'Ada had the pair sort their own songs first.' },
      ruleset_version: FREE_WRITE_RULESET_VERSION,
    }
    expect(isFreeWriteCapture(filed, ref(false, 2))).toBe(true)
  })

  it('the stamped ruleset alone is enough, so an emptied box does not flip the mode', () => {
    expect(
      isFreeWriteCapture({ ...onEvent, ruleset_version: FREE_WRITE_RULESET_VERSION }, ref(false, 2)),
    ).toBe(true)
  })

  it('the prose alone is enough, so an unsubmitted draft survives a wiring edit', () => {
    expect(
      isFreeWriteCapture({ ...onEvent, answers: { [FREE_WRITE_KEY]: 'half a sentence' } }, ref(false, 2)),
    ).toBe(true)
  })

  it('whitespace is not prose', () => {
    expect(isFreeWriteCapture({ ...onEvent, answers: { [FREE_WRITE_KEY]: '   ' } }, ref(false, 2))).toBe(
      false,
    )
  })

  it('a per-question capture is never mistaken for one', () => {
    const perQuestion = { ...onEvent, answers: { 'ksa-uuid': 'answered here' }, ruleset_version: RULESET_VERSION }
    expect(isFreeWriteCapture(perQuestion, ref(false, 2))).toBe(false)
  })

  it('AND STAYS ONE while its session has momentarily lost its wiring', () => {
    // The re-review's finding: the stickiness ran one way only, so an
    // administrator unwiring a session's questions to re-wire them made every
    // existing capture on it render as an empty free-write box with the
    // evaluator's answers invisible. Prose typed into that box would then take the
    // marker permanently and drop those answers from what routes.
    const stamped = { ...onEvent, ruleset_version: RULESET_VERSION }
    expect(isFreeWriteCapture(stamped, ref(false, 0))).toBe(false)
    const answered = { ...onEvent, answers: { 'ksa-uuid': 'answered here' } }
    expect(isFreeWriteCapture(answered, ref(false, 0))).toBe(false)
  })

  it('but a capture with no session at all is still free-write, marker or not', () => {
    // Nothing could ever have rendered a per-question form there.
    expect(
      isFreeWriteCapture({ ...noEvent, ruleset_version: RULESET_VERSION }, ref(false, 0)),
    ).toBe(true)
  })

  it('the reserved key alone does not count as a per-question answer', () => {
    expect(hasPerQuestionAnswer({ [FREE_WRITE_KEY]: 'prose' })).toBe(false)
    expect(hasPerQuestionAnswer({ 'ksa-uuid': 'answer' })).toBe(true)
    expect(hasPerQuestionAnswer({ 'ksa-uuid': '  ' })).toBe(false)
    expect(hasPerQuestionAnswer(null)).toBe(false)
  })

  it('is what BOTH surfaces call, so the screen and the routed file cannot disagree', () => {
    const reference = readFileSync('src/db/reference.ts', 'utf8')
    expect(reference).toContain('isFreeWriteCapture')
    // captureFileFor passes the whole record, so it gets the markers too.
    expect(readFileSync('src/routing/operations.ts', 'utf8')).toMatch(/ksasInScopeFor\(e\)/)
  })
})

describe('what the capture screen renders, and whether it may be submitted', () => {
  const scope = (freeWrite: boolean, n: number) => ({
    ksas: [...Array(n)].map((_, i) => ({ id: `q${i}` })),
    freeWrite,
  })

  it('an unresolved key reads as unresolved, not as an answer', () => {
    const v = captureScopeView(null, 'k1')
    expect(v).toEqual({ resolved: false, scopeError: false, ksas: [], freeWrite: false })
  })

  it('A STALE RESOLUTION READS AS UNRESOLVED, so no capture shows another one\'s mode', () => {
    // The vault's uselivequery-stale-across-dep-change rule, expressed as a key
    // rather than as a reset that can happen one frame late.
    const v = captureScopeView({ key: 'previous', scope: scope(true, 7) }, 'current')
    expect(v.resolved).toBe(false)
    expect(v.freeWrite).toBe(false)
    expect(v.ksas).toEqual([])
  })

  it('a matching resolution is the answer', () => {
    const v = captureScopeView({ key: 'k1', scope: scope(true, 7) }, 'k1')
    expect(v).toMatchObject({ resolved: true, scopeError: false, freeWrite: true })
    expect(v.ksas).toHaveLength(7)
  })

  it('a FAILED resolution is neither resolved nor free-write', () => {
    // The blocking regression: an error that resolved to freeWrite false with no
    // questions read as "resolved, this session has nothing wired".
    const v = captureScopeView({ key: 'k1', scope: 'error' }, 'k1')
    expect(v).toEqual({ resolved: false, scopeError: true, ksas: [], freeWrite: false })
  })

  it('a failed resolution under a stale key is just unresolved, not an error banner', () => {
    const v = captureScopeView({ key: 'previous', scope: 'error' }, 'current')
    expect(v.scopeError).toBe(false)
  })

  const base = { resolved: true, scopeError: false, hasContent: true, freeWrite: false, namedSomebody: false, hasQuestions: true }

  it('a per-session capture with content and questions may be submitted', () => {
    expect(canSubmitCapture(base)).toBe(true)
  })

  it('one question is enough', () => {
    // The guard must not refuse a legitimate single-question session.
    expect(canSubmitCapture({ ...base, hasQuestions: true })).toBe(true)
  })

  it('NO questions and not free-write is never submittable, however it is reached', () => {
    // composeSourceText over an empty list returns '', which would overwrite a
    // real source_text and silently stop the capture routing.
    expect(canSubmitCapture({ ...base, hasQuestions: false })).toBe(false)
  })

  it('an error refuses the submit even if everything else looks fine', () => {
    expect(canSubmitCapture({ ...base, scopeError: true })).toBe(false)
  })

  it('an unresolved screen refuses the submit', () => {
    expect(canSubmitCapture({ ...base, resolved: false })).toBe(false)
  })

  it('nothing written refuses the submit', () => {
    expect(canSubmitCapture({ ...base, hasContent: false })).toBe(false)
  })

  it('a free-write needs a name and does not need questions', () => {
    const fw = { ...base, freeWrite: true, hasQuestions: false }
    expect(canSubmitCapture(fw)).toBe(false)
    expect(canSubmitCapture({ ...fw, namedSomebody: true })).toBe(true)
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
    'capture.coverage-none-workshop',
    'capture.scope-error',
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
    expect(capture).toContain('captureScopeView(resolvedScope, scopeKey)')
    expect(capture).toContain('canSubmitCapture({')
    expect(capture).toMatch(/disabled=\{!attested \|\| !canSubmit\}/)
  })

  it('a free-write submit requires at least one name', () => {
    expect(capture).toMatch(/namedSomebody = scope\.length > 0/)
    // The rule itself is executed in `canSubmitCapture`'s own suite above.
    expect(capture).toMatch(/namedSomebody,/)
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

  it('the free-write entry point is offered only to somebody the insert will accept', () => {
    // `reviewerOnly` was the wrong predicate: it is false for a participant-role
    // member with no pairs, who is exactly the person evaluation_insert refuses.
    expect(home).toMatch(/\{canEvaluateTrainees && \(/)
    expect(home).toMatch(/useHasWorkshopRole\(EVALUATING_ROLES\)/)
  })

  it('the screen renders nothing until it knows which kind of capture it is', () => {
    // Otherwise the per-session chrome flashes on a free-write capture: the
    // coverage line, the focus toggle, and "one activity per capture".
    expect(capture).toMatch(/if \(!resolved\) \{\s*\n\s*return null/)
  })

  it('the screen reads its mode through the two pure functions, not from its own state', () => {
    // The second review's point: the React state machine that fixes its blocking
    // finding was asserted by regex. It is now executed, in the suite above.
    expect(capture).toContain('captureScopeView(resolvedScope, scopeKey)')
    expect(capture).toContain('canSubmitCapture({')
    expect(capture).toMatch(/scope: 'error'/)
    expect(findChromeNode('capture.scope-error')?.label).toBeTruthy()
  })

  it('the prose is not part of the resolution key, so typing cannot re-resolve', () => {
    // It flipped false to true on the first keystroke, which was the only way a
    // settled screen could fall into the error banner mid-sentence.
    expect(capture).toMatch(/const scopeKey = `\$\{recordId \?\? ''\}\|\$\{recordActivityId/)
    expect(capture).not.toContain('recordHasFreeWriteText')
  })

  it('the free-write screen reads coverage it can actually see', () => {
    // A free-write coverage row carries activity_id null, and IndexedDB does not
    // index a null key, so where('activity_id') can never return it.
    expect(capture).toContain('coverageForWorkshop')
    expect(readFileSync('src/db/coverage.ts', 'utf8')).toMatch(
      /coverageForWorkshop[\s\S]{0,200}where\('workshop_id'\)/,
    )
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
