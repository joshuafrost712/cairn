// The minimal input ruleset evaluators attest to at submission. This is the
// pre-deployment ruleset that the calibration workstream (deferred) will finalize;
// the version string is stored on every evaluation so we know which rules applied.
//
// Keep this short and expert-facing. Bump RULESET_VERSION whenever the rules change.

export const RULESET_VERSION = '2026-06-draft-1'

// Wispr Flow is the default dictation method for the workshop. The app is agnostic
// to the input source (it just receives text), so this is guidance, not a dependency.
export const DICTATION_HINT =
  'Dictate with Wispr Flow (the default input for this workshop). Typed text works too.'

export const INPUT_RULES: string[] = [
  'Name each participant you are referring to (use the names as registered).',
  'Mark whether an observation is about one person or the whole group.',
  'Stick to what you observed; keep interpretation separate from evidence.',
  'One activity per capture — start a new capture for a different activity.',
]

// A one-line version of the rules, surfaced at the top of capture so evaluators
// have them in mind before dictating (the full list + attestation stay at submit).
export const INPUT_RULES_SHORT =
  'Name who you mean, describe what you observed, one activity per capture.'

// Shared-vocabulary glossary surfaced in capture (dictation-safe popover). Edit
// freely; definitions are kept short and functional for quick reference.
export const GLOSSARY: Array<{ term: string; def: string }> = [
  { term: 'MTT', def: 'Mother-tongue translator; a local speaker on the translation team.' },
  { term: 'CLAT', def: 'Creating Local Arts Together; the workflow for translating Scripture into a local art form.' },
  { term: 'Ethnopoetics', def: "The study of how a culture's verbal art (poetry, song, story) works and what it does." },
  { term: 'ANE', def: 'Ancient Near East; the cultural world surrounding ancient Israel.' },
  { term: 'Four Es / SENSES', def: 'Internalization frameworks from earlier workshops for taking a text deeply in before drafting.' },
  { term: 'FIA', def: 'A set of exegetical and translation-helps materials used in preparation.' },
  { term: 'Scripture-as-Resources', def: 'Drawing on other Scripture passages as a resource during exegesis and drafting.' },
]
