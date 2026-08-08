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

/** Tables whose rows belong to exactly one workshop. */
const SCOPED_TABLES = [
  'observations',
  'verifications',
  'participants',
  'teams',
  'evaluations',
  'ksas',
  'goals',
] as const

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
    'src/components/SyncStatusBar.tsx',
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

const TABLE_CALL = new RegExp(
  `db\\.(?:(${SCOPED_TABLES.join('|')})\\.|table\\(\\s*['"\`](${SCOPED_TABLES.join(
    '|',
  )})['"\`]\\s*\\)\\s*\\.)(\\w+)\\s*\\(([^)]*)`,
  'g',
)

/** `db.workshops` resolved positionally: `.toCollection().first()`, or `[0]` off a read. */
const FIRST_WORKSHOP = [
  /db\.workshops\.toCollection\(/,
  /db\.workshops\.(?:toArray|sortBy|orderBy)\([^)]*\)[\s\S]{0,20}?\)?\s*\[\s*0\s*\]/,
  /db\.workshops\.(?:filter|each)\(/,
]

/** Every unkeyed read of an evidence table in one file, as `table.method` strings. */
export function unkeyedReads(source: string): string[] {
  const src = stripComments(source)
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

  it('still flags the unscoped half of a mixed ternary, which is how tl-16 half-fixed Reports', () => {
    // The sanctioned fallback (scope when there is a workshop, read everything when
    // there is not) is legitimate, and the first version of this file whitelisted it by
    // PROXIMITY, which let an unrelated unscoped read hide beside it. Both halves are
    // now reported, and the allowance is the allowlist rather than the pattern.
    const mixed = `
      const teams = db.teams.where('workshop_id').equals(id).toArray()
      const obs = flag ? mine : db.observations.toArray()
    `
    expect(unkeyedReads(mixed)).toEqual(['observations.toArray'])
  })

  it('catches the workshops[0] defect tl-17 fixed, in both of its spellings', () => {
    expect(firstWorkshopHits('const w = await db.workshops.toCollection().first()')).toBe(true)
    expect(firstWorkshopHits('const w = (await db.workshops.toArray())[0]')).toBe(true)
    expect(firstWorkshopHits('const w = await db.workshops.get(activeId)')).toBe(false)
  })
})
