import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import { somebodyLeftToEvaluate } from '../src/lib/compose'
import { findChromeNode } from '../src/lib/content/chrome'

/**
 * The post-submit choice.
 *
 * Submitting used to end with `navigate('/evaluations')`, which took somebody who
 * had just written something and put them on the one screen in the app that lists
 * what they had already written and offers no way onward. What they almost always
 * want next is another capture for the session they are still sitting in.
 *
 * Two halves, tested where each of them decides something. The offer's condition
 * is pure and gets real rosters, including the two cases that must say no. The
 * panel itself is a React page this suite cannot mount, so what is asserted there
 * is the seam: the copy it prints, and the three structural facts that each fail
 * against the pre-change files.
 */

const cov = (rows: Record<string, string[]>) =>
  new Map(Object.entries(rows).map(([id, evaluators]) => [id, { evaluators }]))

const base = {
  freeWrite: false,
  evaluatorEmail: 'evaluator@example.org',
  participantIds: ['ada', 'bo', 'cai'],
  justCovered: [] as string[],
  coverage: undefined as Map<string, { evaluators: string[] }> | undefined,
}

describe('whether to offer another capture in this session', () => {
  it('offers one while names remain', () => {
    expect(somebodyLeftToEvaluate(base)).toBe(true)
  })

  it('does not count the people this capture just named', () => {
    // The coverage row for this submission has not landed when the question is
    // asked, so the names have to be passed in separately or the last capture of a
    // session offers another one for nobody.
    expect(somebodyLeftToEvaluate({ ...base, justCovered: ['ada', 'bo', 'cai'] })).toBe(false)
    expect(somebodyLeftToEvaluate({ ...base, justCovered: ['ada', 'bo'] })).toBe(true)
  })

  it('does not offer somebody this evaluator has already covered', () => {
    const coverage = cov({ ada: ['evaluator@example.org'], bo: ['evaluator@example.org'] })
    expect(somebodyLeftToEvaluate({ ...base, coverage })).toBe(true)
    expect(somebodyLeftToEvaluate({ ...base, coverage, justCovered: ['cai'] })).toBe(false)
  })

  it('a colleague having covered somebody is not this evaluator having covered them', () => {
    // Coverage is deliberately not exclusive: two evaluators on one participant is
    // a normal week. Only MY submissions retire a name from MY offer.
    const theirs = ['colleague@example.org']
    const coverage = cov({ ada: theirs, bo: theirs, cai: theirs })
    expect(somebodyLeftToEvaluate({ ...base, coverage })).toBe(true)
  })

  it('matches the evaluator regardless of how the provider cased the email', () => {
    const coverage = cov({ ada: ['Evaluator@Example.ORG'], bo: ['x@y'], cai: ['x@y'] })
    expect(somebodyLeftToEvaluate({ ...base, coverage, justCovered: ['bo', 'cai'] })).toBe(false)
  })

  it('says no on an empty roster', () => {
    // The reviewer who holds one instructor pair, once she has used it, and any
    // workshop whose roster has not loaded. Offering here is a dead end.
    expect(somebodyLeftToEvaluate({ ...base, participantIds: [] })).toBe(false)
    expect(somebodyLeftToEvaluate({ ...base, participantIds: ['ada'], justCovered: ['ada'] })).toBe(
      false,
    )
  })

  it('a free-write capture always says yes', () => {
    // It has no session to exhaust (tl-36), and an evaluator with something to
    // write has somewhere to put it whatever the roster says.
    expect(
      somebodyLeftToEvaluate({ ...base, freeWrite: true, participantIds: [], justCovered: ['ada'] }),
    ).toBe(true)
  })

  it('the empty string is not an identity', () => {
    // An evaluator with no email cannot be matched against anybody. Comparing the
    // blank would let a blank in the coverage list retire a name nobody has
    // evaluated, and hide the button on the ground that you had already done it.
    const coverage = cov({ ada: [''], bo: [''], cai: [''] })
    expect(somebodyLeftToEvaluate({ ...base, evaluatorEmail: null, coverage })).toBe(true)
    expect(somebodyLeftToEvaluate({ ...base, evaluatorEmail: '', coverage })).toBe(true)
  })
})

describe('the copy the panel prints', () => {
  const ids = [
    'capture.done.submitted',
    'capture.done.saved',
    'capture.done.another',
    'capture.done.another-free-write',
    'capture.done.home',
    'myeval.start-another',
  ]

  it('every id the panel asks for exists in chrome.json', () => {
    // `c()` prints the raw id when a node is missing, so an authoring slip here
    // ships as "capture.done.home" on a button in a workshop room.
    const missing = ids.filter((id) => !findChromeNode(id)?.label)
    expect(missing).toEqual([])
  })

  it('names the session, so the button says which one it means', () => {
    const label = (findChromeNode('capture.done.another')?.label ?? '').toLowerCase()
    expect(label).toContain('session')
  })
})

describe('nothing navigates away from a capture on its own', () => {
  // Comments are stripped first, so PROSE about the old redirect — of which there
  // is deliberately some, because the next editor needs to know why the panel is
  // there — does not fail the check that no CODE performs it. Same treatment
  // `oneResolutionSite.test.ts` gives the legacy column it guards.
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const capture = stripComments(readFileSync('src/pages/CaptureActivity.tsx', 'utf8'))
  const app = stripComments(readFileSync('src/App.tsx', 'utf8'))

  it('submitting no longer redirects to the list of what you already did', () => {
    expect(capture).not.toContain("navigate('/evaluations')")
  })

  it('the panel replaces the submit row rather than being a screen of its own', () => {
    // It has to land where the button was. The submit button sits at the bottom of
    // a form that is eleven hundred pixels long on a phone, and a confirmation
    // anywhere else is one nobody scrolls back up to read.
    expect(capture).toContain("c('capture.done.home')")
    expect(capture).toMatch(/aria-live="polite"/)
  })

  it('the capture route is keyed on the client id', () => {
    // `/capture/A` to `/capture/B` is one route with a different param, so without
    // this the component stays mounted and its state carries over: the panel would
    // greet a capture nobody had written, and a ticked attestation box would make
    // the next Submit live without anybody attesting to anything.
    expect(app).toMatch(/<CaptureActivity key={clientId} \/>/)
  })
})
