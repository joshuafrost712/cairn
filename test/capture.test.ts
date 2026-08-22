import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  captureControls,
  captureMode,
  classifyRepoint,
  resolvedRow,
  REPOINT_CHANGES,
  type CaptureMode,
  type RepointChange,
  type RepointInput,
} from '../src/lib/capture'
import { fillTokens, findChromeNode } from '../src/lib/content/chrome'
import { evaluation, participant } from './factories'

/**
 * An evaluator in Bali evaluated one CIT, submitted, went to do the next person in
 * the same session, and found the first one's words already in the boxes.
 *
 * Three things had to be true at once. A submitted evaluation stayed fully
 * editable, roster grid and all, so the row that held A's text could be re-pointed
 * at B by one tap. "My evaluations" headlined each row with the SESSION title, so
 * the capture just submitted read as "the session you are in" and was the obvious
 * thing to open when you wanted the next person. And there was no button anywhere
 * that meant "next person": the only way to a blank capture was back through the
 * home screen, which nobody does when a list of the current session is on screen.
 *
 * Nothing about it was browser-specific, though it was reported on Edge on
 * Windows. A mouse back button is the natural "now the next one" gesture there,
 * and it lands on the capture you just filed.
 *
 * None of this is renderable here: the suite is Node-only, with no jsdom and no
 * testing-library. So the decisions were moved into `src/lib/capture.ts` where they
 * can be checked directly, and the parts that are irreducibly structural are
 * checked by reading the source, as `workshopScoping.test.ts` does.
 */

const alice = { participant_id: 'p-a', name: 'Alice Nkemba' }
const bob = participant({ id: 'p-b', name: 'Bekele Tadesse' })
const target = { id: bob.id, name: bob.name }

const repoint = (partial: Partial<RepointInput> = {}): RepointInput => ({
  submitted: true,
  instructorReview: false,
  focusMode: true,
  scope: [alice],
  focusParticipantId: alice.participant_id,
  target,
  ...partial,
})

/** One input per change, so a loop can assert something about all of them. */
const INPUT_FOR: Record<RepointChange, RepointInput> = {
  unchanged: repoint({ focusParticipantId: bob.id, scope: [{ participant_id: bob.id, name: bob.name }] }),
  'focus-set': repoint({ focusParticipantId: null, scope: [] }),
  'focus-replace': repoint(),
  'tag-add': repoint({ focusMode: false, scope: [], focusParticipantId: null }),
  'tag-remove': repoint({
    focusMode: false,
    scope: [alice, { participant_id: bob.id, name: bob.name }],
    focusParticipantId: null,
  }),
}

describe('a row is not this screen’s row until the ids agree', () => {
  const idOf = (r: { client_id: string }) => r.client_id

  it('a row belonging to another capture is not this capture’s row, however recently it was on screen', () => {
    // The defect, in one assertion. useLiveQuery hands back the PREVIOUS row for at
    // least one committed render after its dependency changes, so this is the exact
    // frame in which A's answers used to be seeded under B's id and written back.
    const aliceRow = evaluation({ client_id: 'cap-a', answers: { k1: "Alice's words" } })
    expect(resolvedRow('cap-b', aliceRow, idOf)).toEqual({ status: 'loading' })
  })

  it('waits while the query has not answered', () => {
    expect(resolvedRow('cap-a', undefined, idOf)).toEqual({ status: 'loading' })
  })

  it('reports absent when the row genuinely is not there', () => {
    expect(resolvedRow('cap-a', null, idOf)).toEqual({ status: 'absent' })
  })

  it('reports absent when nothing was asked for, so a capture with no activity falls through', () => {
    expect(resolvedRow(null, null, idOf)).toEqual({ status: 'absent' })
    expect(resolvedRow(null, undefined, idOf)).toEqual({ status: 'absent' })
  })

  it('is ready only for the row that was asked for', () => {
    const row = evaluation({ client_id: 'cap-a' })
    expect(resolvedRow('cap-a', row, idOf)).toEqual({ status: 'ready', row })
  })
})

describe('a submitted evaluation is read-only until somebody says otherwise', () => {
  it('reads the mode off the record and the intent, not off one flag', () => {
    expect(captureMode(false, false)).toBe('draft')
    // Correcting is meaningless before submission, and must not leak in.
    expect(captureMode(false, true)).toBe('draft')
    expect(captureMode(true, false)).toBe('locked')
    expect(captureMode(true, true)).toBe('correcting')
  })

  it('locks everything a locked capture must lock', () => {
    const locked = captureControls('locked')
    expect(locked.textEditable).toBe(false)
    expect(locked.rosterEditable).toBe(false)
    expect(locked.ratingsEditable).toBe(false)
    expect(locked.focusToggleEnabled).toBe(false)
    expect(locked.showSubmit).toBe(false)
    // The two ways out: correct this one, or start the next person's.
    expect(locked.showUnlock).toBe(true)
    expect(locked.showNextPerson).toBe(true)
  })

  it('leaves a draft exactly as fast as it was', () => {
    const draft = captureControls('draft')
    expect(draft.textEditable).toBe(true)
    expect(draft.rosterEditable).toBe(true)
    expect(draft.ratingsEditable).toBe(true)
    expect(draft.focusToggleEnabled).toBe(true)
    expect(draft.showSubmit).toBe(true)
    expect(draft.showUnlock).toBe(false)
    expect(draft.showNextPerson).toBe(false)
    expect(draft.showUndo).toBe(false)
  })

  it('reopens text and roster for a correction, but not the focus toggle', () => {
    const correcting = captureControls('correcting')
    expect(correcting.textEditable).toBe(true)
    expect(correcting.rosterEditable).toBe(true)
    expect(correcting.ratingsEditable).toBe(true)
    expect(correcting.showSubmit).toBe(true)
    expect(correcting.showUndo).toBe(true)
    // Flipping focus rewrites the scope wholesale, and no one sentence can honestly
    // confirm "this drops four of the five people this is about".
    expect(correcting.focusToggleEnabled).toBe(false)
    expect(correcting.showNextPerson).toBe(false)
  })

  it('offers the next person only from the locked screen, so it never competes with writing', () => {
    const withNext = (['draft', 'locked', 'correcting'] as CaptureMode[]).filter(
      (m) => captureControls(m).showNextPerson,
    )
    expect(withNext).toEqual(['locked'])
  })
})

describe('a roster tap on a submitted evaluation says what it would do', () => {
  it('classifies the tap that caused the defect, and names both people', () => {
    const d = classifyRepoint(repoint())
    expect(d.change).toBe('focus-replace')
    expect(d.confirm?.copyId).toBe('capture.repoint.focus-replace')
    expect(d.confirm?.tokens).toEqual({ from: 'Alice Nkemba', to: 'Bekele Tadesse' })
    expect(d.nextScope).toEqual([{ participant_id: 'p-b', name: 'Bekele Tadesse' }])
    expect(d.nextFocusId).toBe('p-b')
  })

  it('says nothing when the tap changes nothing', () => {
    const d = classifyRepoint(INPUT_FOR.unchanged)
    expect(d.change).toBe('unchanged')
    expect(d.confirm).toBeNull()
    expect(d.nextScope).toEqual(INPUT_FOR.unchanged.scope)
    expect(d.nextFocusId).toBe(INPUT_FOR.unchanged.focusParticipantId)
  })

  it('does not say "from" when nobody was named yet', () => {
    const d = classifyRepoint(INPUT_FOR['focus-set'])
    expect(d.change).toBe('focus-set')
    expect(d.confirm?.copyId).toBe('capture.repoint.focus-set')
    expect(d.confirm?.tokens).toEqual({ to: 'Bekele Tadesse' })
  })

  it('gives an instructor review its own sentence, because re-pointing changes who may read it', () => {
    const d = classifyRepoint(repoint({ instructorReview: true }))
    expect(d.confirm?.copyId).toBe('capture.repoint.instructor-replace')
  })

  it('adds and removes tags without pretending either is a replacement', () => {
    const add = classifyRepoint(INPUT_FOR['tag-add'])
    expect(add.change).toBe('tag-add')
    expect(add.confirm?.tokens).toEqual({ to: 'Bekele Tadesse' })
    expect(add.nextScope).toEqual([{ participant_id: 'p-b', name: 'Bekele Tadesse' }])

    const remove = classifyRepoint(INPUT_FOR['tag-remove'])
    expect(remove.change).toBe('tag-remove')
    expect(remove.confirm?.tokens).toEqual({ from: 'Bekele Tadesse' })
    expect(remove.nextScope).toEqual([alice])
  })

  it('never lets a change to a submitted evaluation through unasked', () => {
    // A loop rather than four assertions, so a sixth change added later cannot slip
    // in without a sentence to go with it.
    const unasked = REPOINT_CHANGES.filter((change) => change !== 'unchanged').filter(
      (change) => classifyRepoint(INPUT_FOR[change]).confirm === null,
    )
    expect(unasked).toEqual([])
  })

  it('asks nothing at all on a draft, so first capture is untouched', () => {
    const asked = REPOINT_CHANGES.filter(
      (change) => classifyRepoint({ ...INPUT_FOR[change], submitted: false }).confirm !== null,
    )
    expect(asked).toEqual([])
  })

  it('produces the same scope arithmetic whether or not it asks first', () => {
    // The confirm must not change the outcome, only gate it. This is what lets the
    // component hold one decision object and apply it later unchanged.
    for (const change of REPOINT_CHANGES) {
      const submitted = classifyRepoint(INPUT_FOR[change])
      const draft = classifyRepoint({ ...INPUT_FOR[change], submitted: false })
      expect(draft.nextScope, change).toEqual(submitted.nextScope)
      expect(draft.nextFocusId, change).toEqual(submitted.nextFocusId)
      expect(draft.change, change).toEqual(submitted.change)
    }
  })
})

/**
 * Does every sentence this screen can produce actually have words?
 *
 * The same reason `setupCopy.test.ts` exists. `c()` returns the id when a node is
 * missing, so a forgotten string does not crash and does not blank: it puts
 * `capture.repoint.focus-replace` on screen inside the one dialog whose entire
 * value is that it names two real people. And `fillTokens` leaves an unknown
 * `{token}` in place, so a renamed token surfaces as "from {from} to Bekele".
 */
describe('every string this screen can reach has words', () => {
  const NEW_NODES = [
    'capture.correcting-banner',
    'capture.unlock',
    'capture.locked-roster-help',
    'capture.next-person',
    'capture.next-instructor',
    'capture.next-help',
    'capture.see-evaluations',
    'capture.repoint.confirm',
    'capture.repoint.cancel',
    'myeval.state.submitted',
    'myeval.state.unsubmitted',
  ]

  it('every banner the mode table names exists', () => {
    for (const mode of ['draft', 'locked', 'correcting'] as CaptureMode[]) {
      const id = captureControls(mode).bannerId
      expect(typeof findChromeNode(id)?.label, `${mode} -> ${id}`).toBe('string')
    }
  })

  it('every new node exists', () => {
    const missing = NEW_NODES.filter((id) => typeof findChromeNode(id)?.label !== 'string')
    expect(missing).toEqual([])
  })

  it('every confirm sentence exists and has no placeholder left in it', () => {
    // Both roster modes, both instructor and trainee, so every branch that can
    // reach a copy id is walked rather than sampled.
    const inputs: RepointInput[] = [
      ...REPOINT_CHANGES.map((change) => INPUT_FOR[change]),
      ...REPOINT_CHANGES.map((change) => ({ ...INPUT_FOR[change], instructorReview: true })),
    ]
    const problems: string[] = []
    for (const input of inputs) {
      const { confirm } = classifyRepoint(input)
      if (!confirm) continue
      const label = findChromeNode(confirm.copyId)?.label
      if (typeof label !== 'string') {
        problems.push(`${confirm.copyId}: no node`)
        continue
      }
      const filled = fillTokens(label, confirm.tokens)
      const leftover = filled.match(/\{\w+\}/g)
      if (leftover) problems.push(`${confirm.copyId}: unfilled ${leftover.join(', ')}`)
      // A sentence that does not name the person it is about is the sentence that
      // let this happen in the first place.
      for (const value of Object.values(confirm.tokens)) {
        if (value && !filled.includes(value)) problems.push(`${confirm.copyId}: never says "${value}"`)
      }
    }
    expect(problems).toEqual([])
  })
})

/**
 * The structural half, which no unit test can reach.
 *
 * `resolvedRow` is only load-bearing if the form cannot ask the router which
 * capture it is, and the keyed mount is only load-bearing if it is actually
 * written. Both are one-line edits away from being undone by somebody tidying, so
 * they are asserted against the source, as `workshopScoping.test.ts` does.
 */
const FORM = 'src/pages/CaptureForm.tsx'
const RESOLVER = 'src/pages/CaptureActivity.tsx'

/** Prose about this defect must not pass or fail a check about the code. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

export function readsRouteParams(source: string): boolean {
  return /useParams/.test(stripComments(source))
}

export function mountsFormKeyed(source: string): boolean {
  const src = stripComments(source)
  const match = src.match(/<CaptureForm\b[\s\S]*?\/>/)
  if (!match) return false
  return /\bkey=\{/.test(match[0])
}

/** Writer calls whose first argument is not the record's own id. */
export function misaddressedWrites(source: string): string[] {
  const src = stripComments(source)
  const re = /\b(saveAnswers|submitEvaluation|undoLastEdit|repointEvaluation)\s*\(\s*([A-Za-z_$][\w$.]*)/g
  const bad: string[] = []
  for (const m of src.matchAll(re)) {
    if (m[2] !== 'record.client_id') bad.push(`${m[1]}(${m[2]})`)
  }
  return bad
}

/** Every `<textarea ... />` in the file that is missing an attribute. */
export function textareasMissing(source: string, attribute: string): number {
  const src = stripComments(source)
  const blocks = src.match(/<textarea\b[\s\S]*?\/>/g) ?? []
  return blocks.filter((b) => !b.includes(attribute)).length
}

export function rosterButtonGuarded(source: string): boolean {
  const src = stripComments(source)
  const match = src.match(/className=\{`participant-btn[\s\S]*?>/)
  return Boolean(match && /\bdisabled=\{/.test(match[0]))
}

describe('the fix cannot be tidied away', () => {
  const form = readFileSync(FORM, 'utf8')
  const resolver = readFileSync(RESOLVER, 'utf8')

  it('the form is handed its record, and never asks the router which capture it is', () => {
    // Two sources of truth about which capture this is is the defect. The route id
    // is the resolver's business; `record` is the form's.
    expect(readsRouteParams(form)).toBe(false)
  })

  it('the resolver mounts the form keyed on the row', () => {
    // Without the key, /capture/A to /capture/B reuses the mount and the form's
    // state initializers go on holding A's answers.
    expect(mountsFormKeyed(resolver)).toBe(true)
  })

  it('every write from the form is addressed to the record it is showing', () => {
    expect(misaddressedWrites(form)).toEqual([])
  })

  it('every textarea can be locked, and none of them autofills', () => {
    expect(textareasMissing(form, 'readOnly={')).toBe(0)
    expect(textareasMissing(form, 'autoComplete="off"')).toBe(0)
  })

  it('the roster grid can be locked', () => {
    expect(rosterButtonGuarded(form)).toBe(true)
  })

  it('the resolver still refuses a capture that is not this viewer’s to make', () => {
    // tl-30. The split moved this guard; it must not have dropped it.
    expect(resolver).toContain('capture.not-yours')
    expect(resolver).toContain('EVALUATING_ROLES')
  })
})

/**
 * The negative control: proof the detectors still detect.
 *
 * Without this, a refactor that broke one of the regexes above would leave every
 * test in the previous block green while asserting nothing at all.
 */
describe('the detectors detect', () => {
  it('catches a form that reads the route', () => {
    expect(readsRouteParams('const { clientId = "" } = useParams()')).toBe(true)
  })

  it('is not fooled by prose about useParams', () => {
    expect(readsRouteParams('// deliberately does not read useParams\n')).toBe(false)
    expect(readsRouteParams('/* no useParams here */\n')).toBe(false)
  })

  it('catches an unkeyed mount', () => {
    expect(mountsFormKeyed('<CaptureForm record={record.row} activity={activity} />')).toBe(false)
    expect(mountsFormKeyed('nothing here')).toBe(false)
    expect(mountsFormKeyed('<CaptureForm key={record.row.client_id} record={record.row} />')).toBe(true)
  })

  it('catches a write addressed to the route id', () => {
    expect(misaddressedWrites('void saveAnswers(clientId, next, {})')).toEqual(['saveAnswers(clientId)'])
    expect(misaddressedWrites('await submitEvaluation(clientId, patch)')).toEqual([
      'submitEvaluation(clientId)',
    ])
    expect(misaddressedWrites('void repointEvaluation(record.client_id, next)')).toEqual([])
  })

  it('catches a textarea with no lock and no autocomplete guard', () => {
    const bare = '<textarea id="x" value={v} onChange={f} />'
    expect(textareasMissing(bare, 'readOnly={')).toBe(1)
    expect(textareasMissing(bare, 'autoComplete="off"')).toBe(1)
    const guarded = '<textarea id="x" readOnly={!ok} autoComplete="off" value={v} />'
    expect(textareasMissing(guarded, 'readOnly={')).toBe(0)
  })

  it('catches an unguarded roster button', () => {
    expect(rosterButtonGuarded('<button className={`participant-btn`} onClick={f}>')).toBe(false)
    expect(rosterButtonGuarded('<button className={`participant-btn`} disabled={!ok} onClick={f}>')).toBe(
      true,
    )
  })

  /*
   * Stated limits, because a detector that hides its blind spots gets trusted
   * further than it has earned:
   *
   *   - `const id = record.client_id; saveAnswers(id, ...)` passes. The regex reads
   *     the argument, not what it holds.
   *   - a textarea built by a helper component rather than written as a tag is
   *     invisible to `textareasMissing`.
   *   - `readsRouteParams` matches the identifier anywhere in code, so a variable
   *     merely NAMED useParamsSomething would fail the check. That is the safe
   *     direction to be wrong in.
   */
})
