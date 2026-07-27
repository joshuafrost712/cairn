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
