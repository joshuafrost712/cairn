// The minimal input ruleset evaluators attest to at submission. This is the
// pre-deployment ruleset that the calibration workstream (deferred) will finalize;
// the version string is stored on every evaluation so we know which rules applied.
//
// Keep this short and expert-facing. Bump RULESET_VERSION whenever the rules change.

export const RULESET_VERSION = '2026-06-draft-1'

export const INPUT_RULES: string[] = [
  'Name each participant you are referring to (use the names as registered).',
  'Mark whether an observation is about one person or the whole group.',
  'Stick to what you observed; keep interpretation separate from evidence.',
  'One activity per capture — start a new capture for a different activity.',
]
