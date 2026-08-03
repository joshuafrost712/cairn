import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The spec's structural requirement, enforced structurally.
 *
 * tl-08 says the per-event prompt override must resolve in exactly one place, and says
 * why: three surfaces show an evaluator "the question for this event" — the capture
 * screen (`CaptureActivity`), the Setup preview, and the capture file pushed to routing
 * (`buildCaptureFile`). If each applied the override itself they would drift, and the
 * drift would be invisible: an evaluator would answer one wording while their answer
 * was read against another.
 *
 * A comment cannot enforce that. This can. The override columns may be MENTIONED only
 * where they are legitimately handled:
 *
 *   lib/goals.ts        the pure resolver
 *   db/reference.ts     the one loader that calls it (ksasForActivity)
 *   db/referenceWrite.ts the writer, which must also carry them forward on a rewire
 *   lib/types.ts        the declaration
 *   setup/impact.ts     the classifier, which must know a rewording from a rewire
 *   setup/sections/WiringSection.tsx  the editor
 *
 * A new name on this list is a decision somebody has to make deliberately, which is
 * the whole point. If a fourth surface needs the resolved question, it should call
 * `ksasForActivity`, not read the column.
 */

const ALLOWED = new Set([
  'src/lib/goals.ts',
  'src/lib/types.ts',
  'src/db/reference.ts',
  'src/db/referenceWrite.ts',
  'src/setup/impact.ts',
  'src/setup/sections/WiringSection.tsx',
])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

describe('the per-event override resolves in one place', () => {
  it('no file outside the allowed set touches prompt_override', () => {
    const offenders = walk('src')
      .filter((path) => /prompt_override|guiding_questions_override/.test(readFileSync(path, 'utf8')))
      .map((path) => path.replace(/\\/g, '/'))
      .filter((path) => !ALLOWED.has(path))
    expect(offenders).toEqual([])
  })

  it('the legacy area column is read only where migrating it is the job', () => {
    // The other half of the spec's "do not keep both as writable paths". `area` is
    // retained in Postgres for one release cycle and in the type as deprecated, and
    // any code that READS it to decide a grouping has revived the disagreement tl-08
    // exists to end.
    //
    // Two files legitimately touch it, and neither reads it as a grouping:
    //   db/goalBackfill.ts    reads it to CONVERT it into a goal — that is the job
    //   ai/scenarioDraft.ts   `DraftKsa.area` is a different field that happens to
    //                         share the name: a heading a model produced from a course
    //                         outline, which this file turns into a goal row
    //   db/referenceWrite.ts  strips it from the payload, which is a write-path mention
    const MIGRATORS = new Set([
      'src/db/goalBackfill.ts',
      'src/ai/scenarioDraft.ts',
      'src/db/referenceWrite.ts',
    ])
    // Comments are stripped first, so PROSE about the legacy column — of which there
    // is deliberately a lot, because the next editor needs to know why it is still
    // there — does not fail the check that no CODE reads it.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

    const readers = walk('src')
      .filter((path) => /\.area\b|\['area'\]/.test(stripComments(readFileSync(path, 'utf8'))))
      .map((path) => path.replace(/\\/g, '/'))
      .filter((path) => !MIGRATORS.has(path))
    expect(readers).toEqual([])
  })
})
