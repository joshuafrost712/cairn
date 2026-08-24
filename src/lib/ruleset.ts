// The minimal input ruleset evaluators attest to at submission. This is the
// pre-deployment ruleset that the calibration workstream (deferred) will finalize;
// the version string is stored on every evaluation so we know which rules applied.
//
// Keep this short and expert-facing. Bump RULESET_VERSION whenever the rules change.
//
// Both exports deliberately stay in code rather than moving to the chrome content
// layer (content/chrome.json). Evaluators attest to INPUT_RULES at submit and
// RULESET_VERSION is stamped onto every evaluation record, so changing a rule is a
// versioned act that has to travel with a deliberate version bump, not a wording
// tweak applied in place from the running app. The presentational copy that used to
// live here (the dictation hint, the one-line rules summary, the glossary) has moved
// to chrome.json, where it IS editable.

export const RULESET_VERSION = '2026-06-draft-1'

export const INPUT_RULES: string[] = [
  'Name each participant you are referring to (use the names as registered).',
  'Mark whether an observation is about one person or the whole group.',
  'Stick to what you observed; keep interpretation separate from evidence.',
  'One activity per capture — start a new capture for a different activity.',
]

/**
 * The rules a FREE-WRITE capture asks an evaluator to attest to (tl-36).
 *
 * A separate list rather than a filtered one, and separately versioned, because
 * this is the versioned act the file header describes: two of the four rules above
 * are false of a free-write capture and one of them is its exact opposite. "One
 * activity per capture" is what the box exists to stop asking for, and "mark
 * whether an observation is about one person or the whole group" is a control the
 * screen does not offer, since the free-write path carries no focus toggle.
 *
 * Found by rendering the screen rather than by reading the code. The per-question
 * capture printed all four beside a box whose printed promise contradicted two,
 * which would have had every evaluator this week attesting to a rule the app had
 * just told them to break.
 *
 * The two rules that survive are the two that still bind, and one is added: the
 * router matches names, so a name it cannot place is the one thing that stops
 * evidence reaching a person.
 */
export const FREE_WRITE_RULESET_VERSION = '2026-08-freewrite-1'

export const FREE_WRITE_INPUT_RULES: string[] = [
  'Name each participant you are referring to (use the names as registered).',
  'Stick to what you observed; keep interpretation separate from evidence.',
  'Several people and several sessions in one capture are fine.',
  'A name we cannot match to the roster is flagged for a person, not guessed at.',
]
