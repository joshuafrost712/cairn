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
 * So: no file may read the evidence tables across every workshop, and no file may take
 * `db.workshops.toCollection().first()` as "the workshop", unless it is on the list
 * below with a reason. A new name here is a decision somebody has to make deliberately,
 * which is the whole point.
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

const UNSCOPED_READ = new RegExp(
  `db\\.(${SCOPED_TABLES.join('|')})\\.(toArray|count|orderBy|toCollection)\\(`,
)
const FIRST_WORKSHOP = /db\.workshops\.toCollection\(\)/

/**
 * Where an unscoped read is the right answer, and why. Each entry is a claim somebody
 * checked, not an exemption for convenience.
 */
const ALLOWED_UNSCOPED = new Map<string, string>([
  // The Dexie layer itself: these functions take a workshop id, or they read everything
  // on purpose and hand it to a pure resolver that narrows it.
  ['src/db/local.ts', 'the schema and its upgrades'],
  ['src/db/reference.ts', 'the loader; clears and repopulates the cache from the backend'],
  ['src/db/referenceWrite.ts', 'the outbox writer, which replays per-row'],
  ['src/db/sync.ts', 'pushes this device queue; scoping is by sync_status, not workshop'],
  ['src/db/backup.ts', 'a device backup is the whole device, by definition'],
  ['src/db/drafts.ts', 'generates for a NAMED workshop and resolves through observationsForWorkshop'],
  ['src/db/draftSync.ts', 'syncs every workshop the device holds, one row at a time'],
  ['src/db/mentoring.ts', 'derives conversations from observations by id'],
  ['src/db/coverage.ts', 'coverage is keyed on the capture, which names its own workshop'],
  ['src/db/admin.ts', 'roster writes, each addressed by id'],
  ['src/db/verifications.ts', 'verdicts addressed by observation id'],
  ['src/db/freshStart.ts', 'wipes the device, which is every workshop by definition'],
  ['src/db/rosterImport.ts', 'the import plan asks whether a named participant already holds evidence, by participant id'],
  ['src/data/demoScenario.ts', 'seeds and tears down its own demo rows, addressed by a demo:: prefix'],
  ['src/db/directory.ts', 'the people directory, which asks the opposite question'],
  ['src/db/settings.ts', 'settings rows, keyed by workshop already'],
  ['src/db/templates.ts', 'template rows, keyed by workshop already'],
  ['src/db/scale.ts', 'scale points, keyed by workshop already'],

  // Deliberately cross-workshop surfaces.
  ['src/pages/Workshops.tsx', 'the cross-workshop overview: reading them all IS the page'],
  ['src/reports/syncHealth.ts', 'sync health is a property of the device, not of a workshop'],
  ['src/setup/counts.ts', 'reads all, then narrows through observationsForWorkshop'],
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
    'observations and verdicts resolve an assigned conversation by id; its questions and events ARE scoped',
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

/**
 * The sanctioned idiom is a ternary: scope when there is a workshop, read everything
 * when there is not, because a device with no active workshop (local-only, or
 * mid-sign-in) must still show what it holds. Its `else` branch is a bare `toArray()`
 * and would fail the check that the `then` branch passes, so the whole expression is
 * removed before matching. A file that scopes ONE table this way and reads another
 * unscoped still fails, which is the case that matters: it is precisely what tl-16 did
 * to `Reports.tsx` and what tl-26 then found in a real report.
 */
const stripScopedTernaries = (src: string) =>
  src.replace(
    /db\.\w+\s*\.?\s*where\('workshop_id'\)[\s\S]{0,200}?:\s*(await\s+)?db\.\w+\.(toArray|count|orderBy|toCollection)\(\)/g,
    'SCOPED_TERNARY',
  )

function offenders(pattern: RegExp): string[] {
  return walk('src')
    .map((path) => path.replace(/\\/g, '/'))
    .filter((path) => !ALLOWED_UNSCOPED.has(path))
    .filter((path) => pattern.test(stripScopedTernaries(stripComments(readFileSync(path, 'utf8')))))
}

describe('every surface knows which workshop it is in', () => {
  it('no file outside the allowed set reads an evidence table across every workshop', () => {
    expect(offenders(UNSCOPED_READ)).toEqual([])
  })

  it('no file outside the allowed set takes the first workshop Dexie returns as the workshop', () => {
    expect(offenders(FIRST_WORKSHOP)).toEqual([])
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
