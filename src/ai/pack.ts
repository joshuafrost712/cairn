/**
 * Assembling the brief pack an operator hands to their own agent (tl-15).
 *
 * The impure half of ./brief.ts: everything that reads Dexie lives here, so the
 * renderers stay functions of their arguments and the test suite can check a pack's
 * contents without a database. Same split `workshopShape.ts` has with `estimate.ts`,
 * and for the same reason.
 *
 * WHAT A PACK IS NOT. It is not a second capture format. `input/<id>.json` is exactly
 * `captureFileFor(e)` — the file the GitHub repo receives and the relay receives —
 * because a pack whose captures were assembled differently would be a second contract
 * nobody noticed writing, and the round-trip would be validated against the wrong one.
 */

import { db } from '../db/local'
import { activitiesForWorkshop, ksasForActivity, ksasForWorkshop } from '../db/reference'
import { scaleForWorkshop } from '../db/scale'
import { captureFileFor, listPendingCaptures } from '../routing/operations'
import { renderRubricDoc, renderRosterDoc, renderSchemaJson } from './workspace'
import {
  EMPTY_LOCAL_FILES,
  renderBriefDoc,
  renderLocalFilesDoc,
  renderWorkshopDoc,
  type BriefContext,
  type BriefableFunction,
  type LocalFiles,
} from './brief'
import { goalLabel } from '../lib/goals'
import { buildZip, type ZipFile } from '../lib/zip'
import { DEFAULT_SCALE } from '../lib/scale'

export interface BriefPack {
  files: ZipFile[]
  /** How many pending captures went into `input/`. Zero is a legal pack. */
  captures: number
  /** The ids in `input/`, so the caller can say what the pack is for. */
  captureIds: string[]
  generatedAt: string
  filename: string
}

export interface BuildPackOptions {
  workshopId: string
  fn: BriefableFunction
  localFiles?: LocalFiles
  /** Passed in rather than read from the clock, so a pack is reproducible. */
  generatedAt?: string
}

/**
 * Build one pack for one function.
 *
 * Never throws on an empty workshop: a pack for a workshop with no questions is a
 * readable brief saying there are none, which is a better answer for somebody setting
 * up than an error. What it does refuse is nothing at all to do — see the caller in
 * providers/byoAgent.ts, which reports the count rather than pretending.
 */
export async function buildBriefPack(options: BuildPackOptions): Promise<BriefPack> {
  const { workshopId, fn } = options
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const localFiles = options.localFiles ?? EMPTY_LOCAL_FILES

  // `ksasForWorkshop` returns questions with their goal titles already resolved
  // (tl-08's `withGoalTitles`), so the goal table is not read here: resolving it a
  // second way is exactly what `test/oneResolutionSite.test.ts` exists to prevent.
  const [workshop, ksas, activities, participants, teams, scale] = await Promise.all([
    db.workshops.get(workshopId),
    ksasForWorkshop(workshopId),
    activitiesForWorkshop(workshopId),
    db.participants.where('workshop_id').equals(workshopId).toArray(),
    db.teams.where('workshop_id').equals(workshopId).toArray(),
    scaleForWorkshop(workshopId),
  ])

  const pending = fn === 'observation_routing' ? await listPendingCaptures() : []
  const captureFiles = await Promise.all(pending.map(captureFileFor))

  const ctx: BriefContext = {
    fn,
    workshop: {
      name: workshop?.name ?? null,
      location: workshop?.location ?? null,
      start_date: workshop?.start_date ?? null,
      end_date: workshop?.end_date ?? null,
    },
    goalLabel: goalLabel(workshop ?? null),
    scale: scale ?? DEFAULT_SCALE,
    ksas,
    pendingCount: captureFiles.length,
    localFiles,
    generatedAt,
  }

  // The calendar with each activity's wired questions, resolved through the one
  // resolution site (tl-08's `ksasForActivity`) rather than by reading the link table.
  const calendar = await Promise.all(
    activities.map(async (a) => ({
      day: a.day,
      title: a.title,
      ksaCodes: (await ksasForActivity(a.id)).map((k) => k.code),
    })),
  )

  const teamName = (id: string | null) => teams.find((t) => t.id === id)?.name ?? 'unassigned'
  const rubricDoc = renderRubricDoc(ksas, ctx.scale)

  const files: ZipFile[] = [
    { name: 'brief.md', text: renderBriefDoc(ctx) },
    { name: 'workshop.md', text: renderWorkshopDoc(ctx, calendar, rubricDoc) },
    { name: 'roster.md', text: renderRosterDoc(participants, teamName) },
    { name: 'schema.json', text: renderSchemaJson(ctx.scale) },
    { name: 'LOCAL-FILES.md', text: renderLocalFilesDoc(ctx) },
  ]

  for (const file of captureFiles) {
    files.push({
      name: `input/${file.capture_client_id}.json`,
      text: JSON.stringify(file, null, 2) + '\n',
    })
  }

  if (fn === 'observation_routing') {
    // An empty folder cannot exist in a zip, so `output/` is a file explaining itself.
    // Without it a filesystem agent has to create the folder the brief told it to write
    // into, which is a small thing that goes wrong often enough to be worth a line.
    files.push({
      name: 'output/README.md',
      text: `# Write your answers here

One file per capture, named for the capture it answers: \`output/<capture_client_id>.json\`.
See "Handing the answer back" in \`brief.md\` for the shape. Leave this file alone; the
application ignores it.
`,
    })
  }

  return {
    files,
    captures: captureFiles.length,
    captureIds: captureFiles.map((f) => f.capture_client_id),
    generatedAt,
    filename: packFilename(workshop?.name ?? null, fn, generatedAt),
  }
}

/** `throughline-routing-psalms-2026-08-04.zip`, with anything awkward stripped out. */
export function packFilename(
  workshopName: string | null,
  fn: BriefableFunction,
  generatedAt: string,
): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40)
  const job = fn.replace(/_/g, '-')
  const parts = ['throughline', job, workshopName ? slug(workshopName) : '', generatedAt.slice(0, 10)]
  return parts.filter(Boolean).join('-') + '.zip'
}

/** The pack as archive bytes. Separate from assembly so tests can read the text. */
export function packToZip(pack: BriefPack): Uint8Array {
  return buildZip(pack.files, new Date(pack.generatedAt))
}
