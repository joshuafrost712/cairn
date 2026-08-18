import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * tl-29's requirement, enforced structurally.
 *
 * Three specs each fixed one file's version of the same defect and the defect kept
 * surviving into the next file, because the safe thing was a habit rather than a
 * seam. tl-17 fixed `workshops[0]` in db/drafts.ts. tl-16 scoped four of Reports'
 * seven reads and left the questions, which is how tl-26's rehearsal produced a Crash
 * Course report headed with Psalms' name over Psalms' question codes. The rule the
 * wave earned from it is that a comment stating a precondition is not a precondition
 * the code enforces.
 *
 * So: outside the allowlist below, a read of an evidence table must be keyed —
 * `where('workshop_id')`, or a `get`/`put`/`update`/`delete` addressed by primary key.
 * Anything that can return another workshop's rows (`toArray`, `count`, `filter`,
 * `orderBy`, `sortBy`, `each`, `bulkGet`, `where` on some other index) fails, and so
 * does resolving "the workshop" as whichever one Dexie returns first.
 *
 * **The detection rule is a method whitelist rather than a list of known-bad
 * patterns**, and the second-AI review of this spec is why: its first draft matched
 * `.toArray()` and `.count()` literally, and six of seven evasions it was given walked
 * straight through — `db.observations.filter(...)`, `bulkGet`, `where('needs_review')`,
 * `(await db.workshops.toArray())[0]`, `db.table('observations')`. A negative-control
 * test below feeds those exact samples back in, because a detector nobody tests is a
 * detector that silently stops detecting.
 *
 * Read `useWorkshopEvidence()` instead, or take a workshop id as an argument.
 */

/**
 * Tables whose rows belong to exactly one workshop.
 *
 * All fifteen, not the seven this file started with. The second-AI review pointed out
 * that the short list left `activities`, `mentoringConversations`, `docDrafts`,
 * `coverage`, `assignments`, `scalePoints` and `aiConfigs` unguarded, and that this is
 * not academic: tl-29 itself had to scope `docDrafts` reads in two pages and
 * `activities` / `mentoringConversations` reads in two more, and none of them would have
 * been caught on reintroduction.
 */
const SCOPED_TABLES = [
  'observations',
  'verifications',
  'participants',
  'teams',
  'evaluations',
  'ksas',
  'goals',
  'activities',
  'mentoringConversations',
  'docDrafts',
  'coverage',
  'assignments',
] as const

/*
 * Four per-workshop tables are deliberately NOT in that list: `scalePoints`,
 * `activityKsas`, `aiConfigs` and `workshopSettings`. Each has exactly one resolver
 * that selects by workshop id in JS from a full read (`db/scale.ts`, `db/reference.ts`,
 * `db/aiConfig.ts`, `db/settings.ts`), and each holds configuration rather than
 * evidence: reading the wrong row shows an administrator the wrong toggle, not another
 * cohort's assessment of a person. Guarding them would add six allowlist entries whose
 * reason is identical, and an allowlist that long stops being read. If a spec ever
 * renders one of those rows to an evaluator, put it back.
 */

/**
 * Dexie calls that cannot return somebody else's rows: primary-key reads and writes.
 * A write is included because scoping a write is the caller's job and a mis-scoped one
 * is a different defect with a different fix (tl-01's RLS refuses it server-side).
 */
const KEYED_CALLS = new Set([
  'get',
  'put',
  'add',
  'update',
  'delete',
  'bulkPut',
  'bulkAdd',
  'bulkDelete',
  'clear',
])

/**
 * Where an unscoped read is the right answer, and why. Each entry is a claim somebody
 * checked, not an exemption for convenience.
 */
const ALLOWED_UNSCOPED = new Map<string, string>([
  // The Dexie layer itself: these functions take a workshop id, or they read everything
  // on purpose and hand it to a pure resolver that narrows it.
  ['src/db/local.ts', 'the schema and its upgrades, which predate every workshop row'],
  ['src/db/reference.ts', 'the loader; clears and repopulates the cache from the backend'],
  ['src/db/referenceWrite.ts', 'the outbox writer, which replays one row at a time'],
  ['src/db/sync.ts', 'pushes this device queue; scoping is by sync_status, not by workshop'],
  ['src/db/backup.ts', 'a device backup is the whole device, by definition'],
  ['src/db/drafts.ts', 'generates for a NAMED workshop and resolves through observationsForWorkshop'],
  ['src/db/draftSync.ts', 'syncs every workshop the device holds, one row at a time'],
  ['src/db/mentoring.ts', 'derives conversations from observations, addressed by observation id'],
  ['src/db/coverage.ts', 'coverage is keyed on the capture, which names its own workshop'],
  ['src/db/admin.ts', 'roster writes, each addressed by primary key'],
  ['src/db/verifications.ts', 'verdicts addressed by observation id'],
  ['src/db/freshStart.ts', 'wipes the device, which is every workshop by definition'],
  [
    'src/db/rosterImport.ts',
    'the import plan asks whether a named participant already holds evidence, keyed on participant id',
  ],
  ['src/data/demoScenario.ts', 'seeds and tears down its own demo rows, addressed by a demo:: prefix'],
  ['src/db/directory.ts', 'the people directory, which asks the opposite question'],
  [
    'src/db/people.ts',
    'keyed on person_id: "which workshops is this human in" is the cross-workshop question by design (tl-12)',
  ],
  [
    'src/routing/verdicts.ts',
    "keyed on evaluator_email: this device's own verdicts, which travel per evaluator rather than per workshop",
  ],
  [
    'src/components/SyncStatusBadge.tsx',
    'keyed on sync_status: what this DEVICE still owes the backend, which is a device question and spans workshops',
  ],
  ['src/db/settings.ts', 'settings rows, which are keyed by workshop already'],
  ['src/db/templates.ts', 'template rows, which are keyed by workshop already'],
  ['src/db/scale.ts', 'scale points, which are keyed by workshop already'],

  // Deliberately cross-workshop surfaces.
  ['src/pages/Workshops.tsx', 'the cross-workshop overview: reading them all IS the page'],
  ['src/reports/syncHealth.ts', 'sync health is a property of the device, not of a workshop'],
  ['src/setup/counts.ts', 'reads all, then narrows through observationsForWorkshop or by participant id'],
  ['src/hooks/useWorkshopEvidence.ts', 'the seam itself: reads all, narrows through scopeEvidence'],
  ['src/hooks/useAnalyticsBundle.ts', 'reads all, narrows through scopeEvidence'],
  ['src/hooks/useNavCounts.ts', 'reads all for the chief badges, narrows through scopeEvidence'],

  // Surfaces that resolve by id rather than by workshop, where narrowing would hide
  // the very row the user asked for.
  [
    'src/pages/Workbench.tsx',
    'resolves the evidence behind ONE named draft by observation id; the draft may belong to a workshop this device is not currently switched into, and scoping would blank the page rather than correct it',
  ],
  [
    'src/pages/MyEvaluations.tsx',
    "an evaluator's own captures, which legitimately span the workshops they work in; each row names its own activity",
  ],
  [
    'src/pages/Conversations.tsx',
    "an evaluator's own mentoring assignments, which tl-25 made genuinely cross-workshop; scoping its questions DELETED the prompt from every conversation in the other workshop, so its lookups are keyed on workshop-plus-code and its scale is resolved per conversation instead",
  ],
  [
    'src/components/VerdictSync.tsx',
    'syncs this device verdicts through the routing repo, per observation id',
  ],
  ['src/routing/operations.ts', 'the import boundary, which checks the workshop as it writes'],
  [
    'src/pages/admin/DataPage.tsx',
    'reports what this DEVICE is holding (row counts before a backup or a fresh start), which is a device question and not a workshop one',
  ],
  [
    'src/setup/sections/PersonMergePanel.tsx',
    'linking the same human across two workshops is the whole feature, so reading both rosters is the point rather than the bug',
  ],
  [
    'src/pages/Outgoing.tsx',
    'reads every draft and narrows in JS, because a NULL-workshop draft must stay visible: those are the rows draftSync refuses to push and names, and hiding them would hide the problem',
  ],
  [
    'src/pages/admin/Progress.tsx',
    'summarises the Outgoing queue and narrows the same way, null-workshop drafts included',
  ],
  [
    'src/pages/EvaluatorHome.tsx',
    'falls back to the only workshop on the device when nothing is selected, the same local-only path the evidence hook takes',
  ],
])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * Comments are stripped before the check, exactly as `oneResolutionSite.test.ts` does,
 * because there is deliberately a lot of prose about this defect in the files that used
 * to have it and prose about a bug must not fail the check on the bug.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/**
 * `\s*` around every dot, because a multi-line Dexie chain is what a formatter emits
 * when the line gets long and this codebase already writes several. The review caught
 * that version of the hole, which is the non-adversarial one: nobody has to be evading
 * the check to write it.
 */
const TABLE_CALL = new RegExp(
  `db\\s*\\.\\s*(?:(${SCOPED_TABLES.join('|')})\\s*\\.|table\\(\\s*['"\`](${SCOPED_TABLES.join(
    '|',
  )})['"\`]\\s*\\)\\s*\\.)\\s*(\\w+)\\s*\\(([^)]*)`,
  'gs',
)

/** `db.workshops` resolved positionally: `.toCollection().first()`, or `[0]` off a read. */
const FIRST_WORKSHOP = [
  /db\s*\.\s*workshops\s*\.\s*toCollection\(/,
  /db\s*\.\s*workshops\s*\.\s*(?:toArray|sortBy|orderBy)\([^)]*\)[\s\S]{0,24}?\)?\s*(?:\[\s*0\s*\]|\.\s*at\(\s*0\s*\))/,
  /db\s*\.\s*workshops\s*\.\s*(?:filter|each|limit)\(/,
  /db\s*\.\s*workshops\s*\.\s*(?:orderBy|sortBy)\([^)]*\)\s*\.\s*first\(/,
]

/** Every unkeyed read of an evidence table in one file, as `table.method` strings. */
export function unkeyedReads(source: string): string[] {
  const src = stripSameTableTernaries(stripComments(source))
  const out: string[] = []
  for (const m of src.matchAll(TABLE_CALL)) {
    const table = m[1] ?? m[2]
    const method = m[3]
    const args = m[4] ?? ''
    if (KEYED_CALLS.has(method)) continue
    // The sanctioned idiom is `where('workshop_id')`. A `where` on any other index can
    // still cross workshops, so seeing the word `where` is not enough.
    if (method === 'where' && /workshop_id/.test(args)) continue
    out.push(`${table}.${method}`)
  }
  return out
}

/**
 * The sanctioned fallback: scope when there is a workshop, read everything when there is
 * not, because a device with no active workshop (local-only, or mid-sign-in) must still
 * show what it holds. Allowed only when BOTH branches name the SAME table, which is what
 * makes this an identity rule rather than the proximity rule the review broke: a file
 * that scopes `teams` and then reads `observations` across every workshop in an
 * unrelated ternary still fails, and that is precisely what tl-16 did to `Reports.tsx`.
 */
const stripSameTableTernaries = (src: string) =>
  src.replace(
    new RegExp(
      `db\\s*\\.\\s*(${SCOPED_TABLES.join(
        '|',
      )})\\s*\\.\\s*where\\(\\s*['"\`]workshop_id['"\`][\\s\\S]{0,220}?:\\s*(?:await\\s+)?db\\s*\\.\\s*\\1\\s*\\.\\s*(?:toArray|count|orderBy|sortBy|filter|toCollection|each)\\(`,
      'g',
    ),
    'SAME_TABLE_TERNARY',
  )

function firstWorkshopHits(source: string): boolean {
  const src = stripComments(source)
  return FIRST_WORKSHOP.some((re) => re.test(src))
}

const reviewable = () =>
  walk('src')
    .map((path) => path.replace(/\\/g, '/'))
    .filter((path) => !ALLOWED_UNSCOPED.has(path))

describe('every surface knows which workshop it is in', () => {
  it('no file outside the allowed set reads an evidence table unkeyed', () => {
    const found = reviewable()
      .map((path) => [path, unkeyedReads(readFileSync(path, 'utf8'))] as const)
      .filter(([, reads]) => reads.length > 0)
      .map(([path, reads]) => `${path}: ${reads.join(', ')}`)
    expect(found).toEqual([])
  })

  it('no file outside the allowed set resolves "the workshop" positionally', () => {
    const found = reviewable().filter((path) => firstWorkshopHits(readFileSync(path, 'utf8')))
    expect(found).toEqual([])
  })

  it('every allowance names a reason, because an exemption without one is an oversight', () => {
    for (const [path, reason] of ALLOWED_UNSCOPED) {
      expect(reason.length, `${path} needs a reason`).toBeGreaterThan(20)
    }
  })

  it('every allowed path still exists, so the list cannot rot into permission for nothing', () => {
    const present = new Set(walk('src').map((p) => p.replace(/\\/g, '/')))
    const missing = [...ALLOWED_UNSCOPED.keys()].filter((p) => !present.has(p))
    expect(missing).toEqual([])
  })
})

/**
 * The negative control: proof the detector still detects.
 *
 * Every sample below is a way somebody could reintroduce the defect, and six of the
 * seven passed the first version of this file. Without this block, a refactor that
 * broke the regex would leave the four tests above green while asserting nothing.
 */
describe('the detector detects', () => {
  const CAUGHT: [string, string][] = [
    ['a bare toArray', 'const rows = await db.observations.toArray()'],
    ['a count', 'const n = await db.verifications.count()'],
    ['a filter', 'db.observations.filter((o) => o.needs_review).toArray()'],
    ['a bulkGet', 'db.observations.bulkGet(ids)'],
    ['a where on another index', "db.observations.where('needs_review').equals(1).toArray()"],
    ['an orderBy', "db.participants.orderBy('name').toArray()"],
    ['an each', 'db.evaluations.each((e) => seen.push(e))'],
    ['a dynamic table handle', "db.table('observations').toArray()"],
    ['a where on a non-workshop key', "db.teams.where('participant_id').equals(x).toArray()"],
    [
      'a multi-line chain, which is what a formatter emits and needs no adversary',
      'const rows = await db.observations\n  .toArray()',
    ],
    ['a docDraft read, one of the eight tables the short list missed', 'db.docDrafts.toArray()'],
    ['a conversation read', 'db.mentoringConversations.toArray()'],
    ['an activity read', "db.activities.orderBy('sort_order').toArray()"],
  ]

  for (const [label, sample] of CAUGHT) {
    it(`catches ${label}`, () => {
      expect(unkeyedReads(sample)).not.toEqual([])
    })
  }

  const ALLOWED: [string, string][] = [
    ['a workshop-keyed where', "db.observations.where('workshop_id').equals(id).toArray()"],
    ['a primary-key get', 'db.participants.get(id)'],
    ['a write', 'db.observations.put(record)'],
  ]

  for (const [label, sample] of ALLOWED) {
    it(`allows ${label}`, () => {
      expect(unkeyedReads(sample)).toEqual([])
    })
  }

  it('allows the same-table fallback ternary and still flags a mixed one', () => {
    // The first version of this file whitelisted the fallback by PROXIMITY, so an
    // unrelated unscoped read could hide within 200 characters of a scoped one. The
    // allowance is now keyed on the table being the same on both sides.
    const sameTable = `
      const teams = workshopId
        ? db.teams.where('workshop_id').equals(workshopId).toArray()
        : db.teams.toArray()
    `
    expect(unkeyedReads(sameTable)).toEqual([])

    const mixed = `
      const teams = db.teams.where('workshop_id').equals(id).toArray()
      const obs = flag ? mine : db.observations.toArray()
    `
    expect(unkeyedReads(mixed)).toEqual(['observations.toArray'])
  })

  it('catches the workshops[0] defect tl-17 fixed, in every spelling it has been written in', () => {
    expect(firstWorkshopHits('const w = await db.workshops.toCollection().first()')).toBe(true)
    expect(firstWorkshopHits('const w = (await db.workshops.toArray())[0]')).toBe(true)
    expect(firstWorkshopHits('const w = (await db.workshops.toArray()).at(0)')).toBe(true)
    expect(firstWorkshopHits("const w = await db.workshops.orderBy('start_date').first()")).toBe(true)
    expect(firstWorkshopHits('const w = await db.workshops.limit(1).first()')).toBe(true)
    expect(firstWorkshopHits('const w = await db.workshops.get(activeId)')).toBe(false)
  })

  it('states its own limits, because a detector that hides them is trusted too far', () => {
    // These need an AST and are accepted as a stated limit rather than a silent one. If
    // one ever shows up in review, that is the moment to reach for ts-morph, not now.
    const ACCEPTED_MISSES = [
      'const t = db.observations; t.toArray()',
      "db['observations'].toArray()",
      'const { observations } = db; observations.toArray()',
      'db.table(nameFromVariable).toArray()',
    ]
    for (const sample of ACCEPTED_MISSES) {
      expect(unkeyedReads(sample), `documented limit: ${sample}`).toEqual([])
    }
  })
})
