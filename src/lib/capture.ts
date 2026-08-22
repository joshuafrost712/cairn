import type { ParticipantScopeEntry } from './types'

/**
 * The three decisions the capture screen makes about identity, editability and
 * consent. They live here, pure, because all three were inline in JSX and the
 * test suite is Node-only: a rule that can only be checked by rendering is a rule
 * that goes unchecked.
 *
 * Written after a field report from a Bali evaluator. He evaluated one CIT,
 * submitted, went to do the next one in the same session, and found the first
 * one's words already in the boxes. Nothing here is browser-specific, though the
 * report named Edge on Windows: a mouse back button is the natural "now the next
 * one" gesture there, and it lands you back on the capture you just submitted.
 */

export type RowState<T> = { status: 'loading' } | { status: 'absent' } | { status: 'ready'; row: T }

/**
 * A row is not this screen's row until it answers to the id this screen asked for.
 *
 * `useLiveQuery` keeps its result across a dependency change: `monitor` is a ref
 * and `hasResult` is never reset, so the fast path that reads a fresh synchronous
 * value runs only for the first subscription of a mount. Navigate /capture/A to
 * /capture/B without unmounting and there is at least one committed render where
 * the route says B and the row is still A's. Seeding from it, rendering it, or
 * writing to it puts A's words under B's name, which is the whole defect this
 * module exists to close.
 *
 * Stated limit: `absent` is NOT identity-checked, because `null` carries no
 * identity to check. Navigating from a capture that does not exist to one that
 * does would show the not-found banner for one frame. Left alone deliberately —
 * nothing navigates out of a not-found screen, so the window is unreachable, and
 * closing it would mean threading a ref of the id each query was issued for
 * through a function whose whole value is having no state.
 */
export function resolvedRow<T>(
  expectedId: string | null,
  queried: T | null | undefined,
  idOf: (row: T) => string,
): RowState<T> {
  // Nothing was asked for. A capture with no activity is a real capture, so the
  // caller has to be able to fall through rather than wait forever.
  if (expectedId === null) return { status: 'absent' }
  if (queried === undefined) return { status: 'loading' }
  if (queried === null) return { status: 'absent' }
  if (idOf(queried) !== expectedId) return { status: 'loading' }
  return { status: 'ready', row: queried }
}

/**
 * What the capture screen is for right now.
 *
 * `locked` is the state that did not exist before. A submitted evaluation used to
 * stay fully editable, with the roster grid live, which is how one CIT's text was
 * one tap away from being filed under another's.
 */
export type CaptureMode = 'draft' | 'locked' | 'correcting'

export function captureMode(attestation: boolean, correcting: boolean): CaptureMode {
  if (!attestation) return 'draft'
  return correcting ? 'correcting' : 'locked'
}

export interface CaptureControls {
  textEditable: boolean
  rosterEditable: boolean
  ratingsEditable: boolean
  focusToggleEnabled: boolean
  showUnlock: boolean
  showSubmit: boolean
  showUndo: boolean
  showNextPerson: boolean
  bannerId: string
}

/**
 * One table, so the whole behavioural change is readable in one place and a Node
 * test can assert it without a DOM.
 *
 * `focusToggleEnabled` is false while correcting on purpose. Flipping focus mode
 * rewrites the scope wholesale, and there is no honest one-sentence confirm for
 * "this drops four of the five people this evaluation is about". A mis-tag is
 * fixed by re-pointing; a capture of the wrong shape is fixed by writing a new one.
 */
export function captureControls(mode: CaptureMode): CaptureControls {
  switch (mode) {
    case 'draft':
      return {
        textEditable: true,
        rosterEditable: true,
        ratingsEditable: true,
        focusToggleEnabled: true,
        showUnlock: false,
        showSubmit: true,
        showUndo: false,
        showNextPerson: false,
        bannerId: 'capture.dictation-hint',
      }
    case 'locked':
      return {
        textEditable: false,
        rosterEditable: false,
        ratingsEditable: false,
        focusToggleEnabled: false,
        showUnlock: true,
        showSubmit: false,
        showUndo: false,
        showNextPerson: true,
        bannerId: 'capture.submitted-banner',
      }
    case 'correcting':
      return {
        textEditable: true,
        rosterEditable: true,
        ratingsEditable: true,
        focusToggleEnabled: false,
        showUnlock: false,
        showSubmit: true,
        showUndo: true,
        showNextPerson: false,
        bannerId: 'capture.correcting-banner',
      }
  }
}

/** What tapping a name in the roster grid would do to the record. */
export type RepointChange = 'unchanged' | 'focus-set' | 'focus-replace' | 'tag-add' | 'tag-remove'

/** Every change a submitted capture can undergo, so a test can loop them all. */
export const REPOINT_CHANGES: RepointChange[] = [
  'unchanged',
  'focus-set',
  'focus-replace',
  'tag-add',
  'tag-remove',
]

export interface RepointInput {
  submitted: boolean
  instructorReview: boolean
  focusMode: boolean
  scope: ParticipantScopeEntry[]
  focusParticipantId: string | null
  target: { id: string; name: string }
}

export interface RepointDecision {
  change: RepointChange
  /** The consent this change needs, or null when it needs none. */
  confirm: { copyId: string; tokens: Record<string, string> } | null
  nextScope: ParticipantScopeEntry[]
  nextFocusId: string | null
}

/**
 * What a roster tap means, and whether it needs asking first.
 *
 * The arithmetic and the write used to be the same expression: `selectFocus`
 * built the new scope and persisted it in three lines, with the answers passed
 * straight through. That is the second half of why a submitted evaluation could
 * change who it was about without anybody deciding to. Splitting them means the
 * change can be described before it happens.
 *
 * `change` is the mutation, `confirm` is the consent, and they are separate
 * fields rather than one because an unsubmitted draft must behave exactly as it
 * always did: taps are free, nothing asks, the grid stays fast. Consent is a
 * property of the record's state, not of the tap.
 */
export function classifyRepoint(input: RepointInput): RepointDecision {
  const { submitted, instructorReview, focusMode, scope, focusParticipantId, target } = input

  const decide = (
    change: RepointChange,
    nextScope: ParticipantScopeEntry[],
    nextFocusId: string | null,
    copyId: string,
    tokens: Record<string, string>,
  ): RepointDecision => ({
    change,
    // No consent needed on a draft, and none for a tap that changes nothing.
    confirm: submitted && change !== 'unchanged' ? { copyId, tokens } : null,
    nextScope,
    nextFocusId,
  })

  if (focusMode) {
    if (focusParticipantId === target.id) {
      return decide('unchanged', scope, focusParticipantId, '', {})
    }
    const next: ParticipantScopeEntry[] = [{ participant_id: target.id, name: target.name }]
    if (focusParticipantId === null) {
      return decide('focus-set', next, target.id, 'capture.repoint.focus-set', { to: target.name })
    }
    // The name comes off the record's own scope entry, so this stays pure: no
    // roster lookup, and the sentence names the person the record actually names.
    const from = scope.find((s) => s.participant_id === focusParticipantId)?.name ?? ''
    return decide(
      'focus-replace',
      next,
      target.id,
      // An instructor review moves into a different person's readable set when it
      // is re-pointed, so it gets its own sentence rather than the trainee one.
      instructorReview ? 'capture.repoint.instructor-replace' : 'capture.repoint.focus-replace',
      { from, to: target.name },
    )
  }

  const existing = scope.find((s) => s.participant_id === target.id)
  if (existing) {
    return decide(
      'tag-remove',
      scope.filter((s) => s.participant_id !== target.id),
      focusParticipantId,
      'capture.repoint.tag-remove',
      { from: existing.name },
    )
  }
  return decide(
    'tag-add',
    [...scope, { participant_id: target.id, name: target.name }],
    focusParticipantId,
    'capture.repoint.tag-add',
    { to: target.name },
  )
}
