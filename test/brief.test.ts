import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  GENERAL_INSTRUCTIONS,
  isBriefable,
  renderBriefDoc,
  renderLocalFilesDoc,
  renderWorkshopDoc,
  type BriefContext,
} from '../src/ai/brief'
import { renderRoutingDoc, renderRubricDoc } from '../src/ai/workspace'
import { packFilename } from '../src/ai/pack'
import {
  countRejections,
  importObservationsPack,
  mergeRejections,
  rejectionNoteTokens,
  MAX_IMPORT_FILES,
  MAX_IMPORT_FILE_BYTES,
  type ImportItemReport,
  type ImportRejection,
} from '../src/routing/operations'
import { buildZip, crc32, dosDateTime, isSafeZipPath } from '../src/lib/zip'
import { readZipDirectory, readZipEntry } from '../src/roster/unzip'
import {
  MAX_LOCAL_FILES_NOTE_CHARS,
  MAX_LOCAL_FILE_PATHS,
  MAX_LOCAL_FILE_PATH_CHARS,
  readAiBrief,
  briefValue,
  resolveAiConfig,
} from '../src/lib/aiConfig'
import { defaultScalePoints, type Scale, type ScalePoint } from '../src/lib/scale'
import type { ResolvedKsa } from '../src/lib/goals'

/**
 * tl-15's pure half: the brief, the pack's filename, the archive, and the stored
 * settings.
 *
 * The assembly itself (`buildBriefPack`) reads Dexie and is exercised by
 * scripts/tl15-agent-brief.mjs in a browser; what is testable here is everything that
 * would fail SILENTLY — a refactor that changed the runbook two shipped modes read, a
 * pack whose archive no tool can open, a five-point workshop handed a 0-3 brief, and a
 * storage cap that has drifted from the one the database enforces.
 */

const point = (value: number, label: string, low = false): ScalePoint => ({
  workshop_id: null,
  value,
  label,
  description: null,
  is_low_trigger: low,
})

const fivePoint: Scale = {
  workshop_id: 'ws-1',
  points: [
    point(1, 'not yet', true),
    point(2, 'emerging', true),
    point(3, 'developing'),
    point(4, 'competent'),
    point(5, 'exemplary'),
  ],
}

const ksa = (over: Partial<ResolvedKsa> = {}): ResolvedKsa =>
  ({
    id: 'k1',
    workshop_id: 'ws-1',
    goal_id: 'g1',
    code: 'Q1',
    goal_title: 'Exegetical accuracy',
    evaluator_facing_prompt: 'Did they check the source text?',
    ai_facing_rubric: 'Look for reference to the source.',
    evidence_levels: { '1': 'no reference', '5': 'consistent reference' },
    cbc_subpoint_refs: ['1.2'],
    ...over,
  }) as ResolvedKsa

const ctx = (over: Partial<BriefContext> = {}): BriefContext => ({
  fn: 'observation_routing',
  workshop: { name: 'Psalms Workshop', location: 'Bali', start_date: '2026-08-24', end_date: '2026-09-04' },
  goalLabel: 'KSA area',
  scale: fivePoint,
  ksas: [ksa()],
  pendingCount: 3,
  localFiles: { paths: [], note: null },
  generatedAt: '2026-08-04T09:00:00.000Z',
  ...over,
})

describe('the github-claude runbook is untouched by this spec', () => {
  /**
   * THE REGRESSION GATE OF THE WHOLE SPEC, and it is a fixture rather than an assertion
   * about wording on purpose. `renderRoutingDoc()` is in daily use in `github-claude` mode
   * AND is the system prompt the unattended worker reads, so a word changed here changes
   * what two shipped modes do. The fixtures were generated from `main` before a line of
   * tl-15 was written.
   */
  it('renders byte-identically to the fixture committed from main', () => {
    const fixture = readFileSync('test/fixtures/routing-doc-default.md', 'utf8')
    expect(renderRoutingDoc()).toBe(fixture)
  })

  it('still parameterizes its range from the scale it is given', () => {
    // The fixture above could be satisfied by a function that ignored its argument, which
    // would be exactly the tl-09 bug returning. Five points, so the range reads 1-5.
    expect(renderRoutingDoc(fivePoint)).toContain('evidence_designation 1-5')
  })

  it('renders a five-point workshop byte-identically to ITS fixture too', () => {
    /**
     * A second fixture, and the review was right that the first draft committed one and
     * used it for nothing. This one pins the whole document for a non-default scale rather
     * than the single line the assertion above checks — so a wording regression anywhere
     * else in the prompt two shipped modes read fails here instead of passing green.
     *
     * Its provenance is weaker than the default fixture's and worth saying plainly: that
     * one came from `main` and is proof this refactor changed nothing, while this one was
     * generated from the same unchanged function afterwards and is a pin against the next
     * change rather than evidence about this one.
     */
    const fixture = readFileSync('test/fixtures/routing-doc-five-point.md', 'utf8')
    expect(renderRoutingDoc(fivePoint)).toBe(fixture)
  })
})

describe('renderBriefDoc', () => {
  it('names the workshop, the job and every file in the pack', () => {
    const doc = renderBriefDoc(ctx())
    expect(doc).toContain('Psalms Workshop')
    expect(doc).toContain('brief.md')
    expect(doc).toContain('workshop.md')
    expect(doc).toContain('roster.md')
    expect(doc).toContain('schema.json')
    expect(doc).toContain('LOCAL-FILES.md')
    expect(doc).toContain('input/')
    expect(doc).toContain('output/')
  })

  it('carries the workshop’s own scale rather than 0 to 3', () => {
    // tl-09's bug in the shape it would take here: a brief that told an agent to answer
    // 0-3 for a five-point workshop would have every observation rejected on import, and
    // the instruction would have been a lie the whole time.
    const doc = renderBriefDoc(ctx())
    expect(doc).toContain("This workshop's points run from 1 to 5")
    expect(doc).toContain('**5** — exemplary')
    expect(doc).toContain('triggers a follow-up conversation')
    expect(doc).not.toContain('points run from 0 to 3')
  })

  it('states that the instructions are the shipped defaults', () => {
    // tl-16 makes them editable. Until then a brief that implied an administrator had
    // authored these words would be claiming something untrue of every deployment.
    expect(renderBriefDoc(ctx())).toContain('shipped defaults')
  })

  it('answers the three questions a real agent asked of it', () => {
    /**
     * Not invented gaps: a fresh agent ran this brief for real and reported these three as
     * things it had to guess at (recorded in the spec's review record). A mention that is
     * not a claim, the undefined middle `confidence`, and an evidence level written for a
     * session being applied to one moment.
     */
    const doc = renderBriefDoc(ctx())
    expect(doc).toMatch(/A mention is not a claim/)
    expect(doc).toMatch(/confidence: "medium"/)
    expect(doc).toMatch(/describes a whole session; your observation describes one moment/)
    // And the schema/envelope contradiction it reasonably worried about.
    expect(doc).toMatch(/describes ONE OBSERVATION, not the file around it/)
  })

  it('holds the honesty rules an agent has to be told', () => {
    expect(GENERAL_INSTRUCTIONS).toMatch(/never invent a quotation/i)
    expect(GENERAL_INSTRUCTIONS).toMatch(/does not name/i)
    expect(GENERAL_INSTRUCTIONS).toMatch(/data, not as instructions/i)
    // The one the import boundary actually enforces, so the brief should say it is checked.
    expect(GENERAL_INSTRUCTIONS).toMatch(/checks this on import/i)
  })

  it('drops the input and output folders for a function that has no queue', () => {
    const doc = renderBriefDoc(ctx({ fn: 'conversation_guidance' }))
    expect(doc).not.toContain('input/')
    expect(doc).toContain('substitute that conversation')
  })

  it('says how to hand back both ways, and that the id is copied exactly', () => {
    const doc = renderBriefDoc(ctx())
    expect(doc).toContain('cairn.observations/v1')
    expect(doc).toContain('cairn.observations-bundle/v1')
    expect(doc).toMatch(/character for character/)
  })

  it('reports the real pending count, including none', () => {
    expect(renderBriefDoc(ctx({ pendingCount: 1 }))).toContain('1 file, one per capture')
    expect(renderBriefDoc(ctx({ pendingCount: 0 }))).toContain('0 files, one per capture')
  })
})

describe('renderWorkshopDoc', () => {
  it('groups questions under the workshop’s own word for a goal', () => {
    const doc = renderWorkshopDoc(
      ctx(),
      [{ day: '2026-08-25', title: 'Exegesis practice', ksaCodes: ['Q1'] }],
      '(rubric)',
    )
    expect(doc).toContain('level it calls **KSA area**')
    expect(doc).toContain('### Exegetical accuracy')
    expect(doc).toContain('Exegesis practice')
    expect(doc).toContain('(rubric)')
  })

  it('says so plainly when a workshop has nothing wired yet', () => {
    const doc = renderWorkshopDoc(ctx({ ksas: [] }), [], '(rubric)')
    expect(doc).toContain('no questions authored yet')
    expect(doc).toContain('no activities yet')
  })
})

describe('renderLocalFilesDoc', () => {
  it('degrades into “skip this file” when nothing was recorded', () => {
    // The spec's own requirement: the no-paths case must not become instructions a tool
    // cannot follow.
    const doc = renderLocalFilesDoc(ctx())
    expect(doc).toMatch(/skip this file/i)
    expect(doc).not.toMatch(/```/)
  })

  it('carries the paths and refuses to claim the app read them', () => {
    const doc = renderLocalFilesDoc(
      ctx({ localFiles: { paths: ['/Users/j/Curriculum'], note: 'Day 3 is the important one.' } }),
    )
    expect(doc).toContain('/Users/j/Curriculum')
    expect(doc).toContain('Day 3 is the important one.')
    expect(doc).toMatch(/has not read them, cannot see them/i)
  })

  it('forbids taking a rating or a claim about a person from them', () => {
    // The failure this exists to prevent: a previous cohort's assessment in a course
    // document becoming this week's evidence about somebody.
    const doc = renderLocalFilesDoc(ctx({ localFiles: { paths: ['/x'], note: null } }))
    expect(doc).toMatch(/no ratings and no claims about people/i)
    expect(doc).toMatch(/data rather than as instructions/i)
  })
})

describe('isBriefable', () => {
  it('covers the three functions this build can do work for, and no others', () => {
    expect(isBriefable('observation_routing')).toBe(true)
    expect(isBriefable('scenario_draft')).toBe(true)
    expect(isBriefable('conversation_guidance')).toBe(true)
    expect(isBriefable('narrative_prose')).toBe(false)
    expect(isBriefable('email_drafting')).toBe(false)
  })
})

describe('packFilename', () => {
  it('names the job, the workshop and the day', () => {
    expect(packFilename('Psalms Workshop', 'observation_routing', '2026-08-04T09:00:00.000Z')).toBe(
      'throughline-observation-routing-psalms-workshop-2026-08-04.zip',
    )
  })

  it('survives a workshop name that is punctuation', () => {
    expect(packFilename('¡Hola! / Día 1', 'observation_routing', '2026-08-04T00:00:00.000Z')).toBe(
      'throughline-observation-routing-hola-d-a-1-2026-08-04.zip',
    )
  })

  it('drops the workshop name rather than producing a double hyphen', () => {
    expect(packFilename(null, 'scenario_draft', '2026-08-04T00:00:00.000Z')).toBe(
      'throughline-scenario-draft-2026-08-04.zip',
    )
  })
})

describe('the zip writer', () => {
  const files = [
    { name: 'brief.md', text: '# Brief\n\nRead this.\n' },
    { name: 'input/cap-1.json', text: '{"capture_client_id":"cap-1"}\n' },
  ]

  it('round-trips through the reader this repo already had', async () => {
    // The strongest available check short of a real tool: tl-10's zip READER, written for
    // xlsx and knowing nothing about this writer, opens the archive and returns the bytes.
    const bytes = buildZip(files, new Date('2026-08-04T09:00:00.000Z'))
    const entries = readZipDirectory(bytes)
    expect(entries.map((e) => e.name)).toEqual(['brief.md', 'input/cap-1.json'])
    expect(await readZipEntry(bytes, entries[0])).toBe(files[0].text)
    expect(await readZipEntry(bytes, entries[1])).toBe(files[1].text)
  })

  it('is a function of its inputs, so two packs of the same instant are one archive', () => {
    const at = new Date('2026-08-04T09:00:00.000Z')
    expect([...buildZip(files, at)]).toEqual([...buildZip(files, at)])
  })

  it('records a real CRC, or an unzipper reports a corrupt file', () => {
    // Checked against a known value rather than against our own implementation: crc32 of
    // "123456789" is 0xCBF43926 in every reference table.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('clamps a pre-1980 date rather than wrapping the year field', () => {
    expect(dosDateTime(new Date('1970-01-01T00:00:00Z')).date >> 9).toBe(0)
  })

  it('reads the instant in UTC, so the bytes do not depend on the machine', () => {
    /**
     * THE REVIEW'S TENTH FINDING, and the round-trip test above could not have caught it:
     * it compares two calls in one process, which agree in any timezone. The first draft
     * used the local-time getters, so the same `generatedAt` wrote 17:00 into the header in
     * Bali and 04:00 in Dallas — reproducible nowhere, which is the one property the module
     * claims. Asserted as absolute field values rather than by re-running under a second TZ,
     * because vitest cannot change the process timezone mid-run.
     */
    const at = new Date('2026-08-04T09:00:00.000Z')
    const { date, time } = dosDateTime(at)
    expect([date >> 9, (date >> 5) & 0xf, date & 0x1f]).toEqual([2026 - 1980, 8, 4])
    expect([time >> 11, (time >> 5) & 0x3f]).toEqual([9, 0])
  })

  it('refuses a path that climbs out of the archive', () => {
    for (const name of ['../escape.md', '/absolute.md', 'a\\b.md', 'dir//x.md', 'trailing/']) {
      expect(isSafeZipPath(name)).toBe(false)
      expect(() => buildZip([{ name, text: 'x' }], new Date())).toThrow(/unsafe path/)
    }
    expect(isSafeZipPath('input/cap-1.json')).toBe(true)
  })
})

describe('the stored brief settings', () => {
  it('reads what it wrote', () => {
    const brief = { localFiles: ['/a', '/b'], localFilesNote: 'note', packGeneratedAt: '2026-08-04T09:00:00.000Z' }
    expect(readAiBrief(briefValue(brief))).toEqual(brief)
  })

  it('resolves to empty for a workshop that has authored none', () => {
    const config = resolveAiConfig('ws-1', [{ workshop_id: 'ws-1', mode: 'byo-agent', functions: {} }])
    expect(config.brief).toEqual({ localFiles: [], localFilesNote: null, packGeneratedAt: null })
  })

  it('drops an over-long path rather than truncating it into a different path', () => {
    const long = '/x'.repeat(MAX_LOCAL_FILE_PATH_CHARS)
    const read = readAiBrief({ local_files: ['/fine', long] })
    expect(read.localFiles).toEqual(['/fine'])
  })

  it('drops blanks, trims, and caps the count', () => {
    const many = Array.from({ length: MAX_LOCAL_FILE_PATHS + 5 }, (_, i) => `/p${i}`)
    expect(readAiBrief({ local_files: ['  /a  ', '', '   '] }).localFiles).toEqual(['/a'])
    expect(readAiBrief({ local_files: many }).localFiles).toHaveLength(MAX_LOCAL_FILE_PATHS)
  })

  it('ignores a shape it does not understand rather than throwing', () => {
    // Tolerant in one direction only, per tl-13: the database refuses an unknown key
    // outright, and an older client reading a newer row must degrade rather than break.
    expect(readAiBrief(null).localFiles).toEqual([])
    expect(readAiBrief('nonsense').localFiles).toEqual([])
    expect(readAiBrief({ local_files: 'not-an-array' }).localFiles).toEqual([])
    expect(readAiBrief({ local_files: [1, 2, null] }).localFiles).toEqual([])
    expect(readAiBrief({ local_files_note: 42 }).localFilesNote).toBeNull()
  })
})

describe('the caps in TypeScript and in SQL are the same caps', () => {
  /**
   * The pairing tl-13 used for `AI_FUNCTION_DEFAULTS` and tl-14 for the assumption keys,
   * and for the same reason: SQL cannot import TypeScript, so nothing but a test that
   * reads the migration can stop the two copies drifting. A drifted cap is silent — the
   * client would accept a path the database then refuses, and the refusal arrives as an
   * opaque constraint error on save.
   */
  const sql = readFileSync('supabase/migrations/20260807000100_ai_brief.sql', 'utf8')

  it('agrees on the path count', () => {
    expect(sql).toContain(`jsonb_array_length(_value) > ${MAX_LOCAL_FILE_PATHS}`)
  })

  it('agrees on the path length', () => {
    expect(sql).toContain(`length(_path #>> '{}') > ${MAX_LOCAL_FILE_PATH_CHARS}`)
  })

  it('agrees on the note length', () => {
    expect(sql).toContain(`length(_value #>> '{}') > ${MAX_LOCAL_FILES_NOTE_CHARS}`)
  })

  it('keeps the three invariants the trigger already enforced', () => {
    // Re-declaring `ai_config_is_permitted` in full is how tl-14 avoided two triggers with
    // an undefined order between their refusals. Dropping one of the earlier checks while
    // doing so would be invisible until a workshop wrote an illegal configuration.
    expect(sql).toContain('ai_functions_are_legal(new.functions)')
    expect(sql).toContain('ai_assumptions_are_legal(new.assumptions)')
    expect(sql).toContain('ai_brief_is_legal(new.brief)')
    expect(sql).toContain("detail = 'tl13.hosted_ai_not_enabled_here'")
    expect(sql).toContain('new.updated_at := now()')
  })

  it('revokes execute from the roles by name, not from public', () => {
    // tl-23's scar: default privileges grant execute to anon and authenticated
    // EXPLICITLY, so `revoke ... from public` locks nothing.
    expect(sql).toMatch(/revoke all on function ai_brief_is_legal\(jsonb\) from public, anon, authenticated/)
  })

  it('does not re-declare ai_config, which would re-run grants it cannot see', () => {
    expect(sql).not.toMatch(/create table/i)
    expect(sql).not.toMatch(/create policy/i)
    expect(sql).not.toMatch(/^grant /im)
  })
})

describe('the rubric document belongs to the workshop that generated it', () => {
  /**
   * THE REVIEW'S FOURTH FINDING. `renderRubricDoc` named "the Psalms Workshop (OBT CDT
   * Workshop 3, Bali 2026)" in its own text and called every descriptor a draft placeholder,
   * both hardcoded when this app had one workshop. tl-08 gave questions a workshop and tl-17
   * gave the deployment several, so every pack for every other workshop carried Bali's name.
   * The first draft of this spec missed it because the pack test passed a stub string in
   * place of the rubric.
   */
  it('names the workshop it was generated for, and never Bali by default', () => {
    const doc = renderRubricDoc([ksa()], fivePoint, { name: 'OBT Crash Course', goalLabel: 'Competency' })
    expect(doc).toContain('**OBT Crash Course**')
    expect(doc).toContain('grouped by competency')
    expect(doc).not.toMatch(/Psalms Workshop|Bali/)
  })

  it('says nothing about drafts when every descriptor is authored', () => {
    const complete = ksa({ evidence_levels: Object.fromEntries(fivePoint.points.map((p) => [String(p.value), `level ${p.value}`])) })
    const doc = renderRubricDoc([complete], fivePoint, { name: 'OBT Crash Course' })
    expect(doc).not.toMatch(/unwritten|placeholder/i)
  })

  it('warns per question when descriptors are missing, and counts them', () => {
    // `ksa()` authors 1 and 5 of five points, so three are missing.
    const doc = renderRubricDoc([ksa()], fivePoint, { name: 'OBT Crash Course' })
    expect(doc).toContain('some still unwritten')
    expect(doc).toContain('3 of these 5 points has no descriptor yet')
    expect(doc).toContain('needs_review')
  })
})

describe('the rejection breakdown the batch surfaces report from', () => {
  const item = (rejection: ImportRejection | undefined) =>
    ({ index: 0, participant: null, ksaCode: null, status: rejection ? 'rejected' : 'stored', rejection }) as ImportItemReport

  it('counts only what was rejected, by rule', () => {
    const counts = countRejections([
      item('unsupported_quotation'),
      item('unsupported_quotation'),
      item('unknown_question'),
      item(undefined),
    ])
    expect(counts).toEqual({ unsupported_quotation: 2, unknown_question: 1 })
  })

  it('sums across files', () => {
    expect(mergeRejections({ off_scale: 1 }, { off_scale: 2, shape: 1 })).toEqual({ off_scale: 3, shape: 1 })
  })

  it('says nothing at all when neither new rule fired', () => {
    // The two rules that predate this spec are not news, so a batch that rejected only on
    // shape or scale appends no sentence rather than appending "0 and 0".
    expect(rejectionNoteTokens({ shape: 3, off_scale: 1 })).toBeNull()
    expect(rejectionNoteTokens({})).toBeNull()
    expect(rejectionNoteTokens({ unknown_question: 1 })).toEqual({ quotation: 0, question: 1 })
  })
})

describe('the default scale still starts at zero', () => {
  it('so a workshop with no scale row gets the app’s original brief', () => {
    // Guards the argument the five-point tests above rest on: they are meaningful only
    // because the default is different.
    expect(defaultScalePoints(null).map((p) => p.value)).toEqual([0, 1, 2, 3])
  })
})

describe('the upload boundary refuses a file before reading it', () => {
  /**
   * The file-level triage only: nothing here reaches Dexie, because a file refused for its
   * size or its syntax never gets as far as `storeObservationsFile`. The item-level half is
   * a browser assertion (scripts/tl15-agent-brief.mjs), like every other Dexie seam in this
   * wave.
   *
   * The point of the `read` callback is what these two tests prove: an oversize file is
   * refused WITHOUT being read, so the cap is a memory guard and not just a message. The
   * first draft took a string, which meant the caller had already loaded a 500MB file into
   * memory before the cap could refuse it.
   */
  it('refuses an oversize file without reading it, and says so distinctly', async () => {
    let read = false
    const report = await importObservationsPack([
      {
        name: 'huge.json',
        bytes: MAX_IMPORT_FILE_BYTES + 1,
        read: async () => {
          read = true
          return '{}'
        },
      },
    ])
    expect(read).toBe(false)
    expect(report.files[0].status).toBe('too_large')
    expect(report.filesSkipped).toBe(1)
    expect(report.stored).toBe(0)
  })

  it('tells unreadable apart from too big, per file, and keeps going', async () => {
    const report = await importObservationsPack([
      { name: 'garbage.json', read: async () => '{ not json' },
      { name: 'wrong-shape.json', read: async () => '{"hello":"world"}' },
    ])
    expect(report.files.map((f) => f.status)).toEqual(['malformed', 'malformed'])
    expect(report.filesSkipped).toBe(2)
  })

  it('refuses the whole batch above the file count, rather than importing a prefix', async () => {
    // The review's fifth finding in its other half: the UI used to slice to this number, so
    // the boundary's refusal was unreachable and 100 of 600 files vanished silently.
    const many = Array.from({ length: MAX_IMPORT_FILES + 1 }, (_, i) => ({
      name: `a${i}.json`,
      read: async () => '{}',
    }))
    await expect(importObservationsPack(many)).rejects.toThrow(/501 files/)
  })
})
