import { db } from './local'
import { enqueueReferenceWrite, pushReferenceOutbox } from './referenceWrite'
import {
  buildScale,
  DEFAULT_SCALE,
  defaultScalePoints,
  normalizeScalePoints,
  scalePointPk,
  setActiveScale,
  validateScalePoints,
  type Scale,
  type ScalePoint,
} from '../lib/scale'

/**
 * The grading scale: the offline-first cache, the one write path, and the thing
 * that keeps the pure layer's synchronous mirror correct (tl-09).
 *
 * The mirror ITSELF lives in lib/scale.ts, which is pure, because its readers are
 * pure — `designationStats()` is called from about twenty places inside report
 * and dashboard code, and making it async so it could consult Dexie would ripple
 * through every one of them to buy nothing. This module is the half that has an
 * IndexedDB to read: it pulls the rows and calls `setActiveScale`. Exactly the
 * split db/settings.ts has with `getRequiredConfirmations()`, for the same reason.
 */

/** Cached points for one workshop, ordered. */
export async function scalePointsFor(workshopId: string): Promise<ScalePoint[]> {
  return db.scalePoints.where('workshop_id').equals(workshopId).toArray()
}

/** One workshop's resolved scale. The read anything cross-workshop must use. */
export async function scaleForWorkshop(workshopId: string | null): Promise<Scale> {
  if (!workshopId) return DEFAULT_SCALE
  return buildScale(workshopId, await scalePointsFor(workshopId))
}

/**
 * Re-point the synchronous mirror at whichever workshop is selected.
 *
 * Called from `loadReferenceData()` in the same breath as the settings mirror, so
 * there is no window in which fresh scale rows sit in Dexie while the reports
 * still group by the previous workshop's points.
 */
export async function mirrorActiveScale(workshopId: string | null): Promise<Scale> {
  const scale = await scaleForWorkshop(workshopId)
  setActiveScale(scale)
  return scale
}

interface RemoteScalePoint {
  workshop_id: string
  value: number
  label: string
  description?: string | null
  is_low_trigger?: boolean | null
  sort_order?: number | null
}

/**
 * Replace the cached scale points with what the backend returned.
 *
 * `inScope` carries the same meaning it does in cacheSettingRows: the workshops
 * this pull was AUTHORIZED to see, so "no rows because there are none" (prune)
 * can be told from "no rows because RLS filtered the workshop out" (leave alone).
 * Getting that backwards would empty a workshop's scale on every device belonging
 * to somebody who is not a member of it.
 */
export async function cacheScalePoints(
  rows: RemoteScalePoint[],
  inScope?: Iterable<string>,
): Promise<void> {
  const typed: ScalePoint[] = rows.map((r) => ({
    pk: scalePointPk(r.workshop_id, r.value),
    workshop_id: r.workshop_id,
    value: r.value,
    label: r.label,
    description: r.description ?? null,
    is_low_trigger: r.is_low_trigger === true,
    sort_order: r.sort_order ?? 0,
  }))

  const touched = new Set([...(inScope ?? []), ...rows.map((r) => r.workshop_id)])
  await db.transaction('rw', db.scalePoints, async () => {
    for (const workshopId of touched) {
      const stale = await db.scalePoints.where('workshop_id').equals(workshopId).toArray()
      const keep = new Set(typed.filter((t) => t.workshop_id === workshopId).map((t) => t.pk))
      await db.scalePoints.bulkDelete(stale.filter((s) => !keep.has(s.pk)).map((s) => s.pk))
    }
    await db.scalePoints.bulkPut(typed)
  })
}

/** Give a workshop the default scale locally. Used when one is created offline. */
export async function seedDefaultScale(workshopId: string): Promise<void> {
  const existing = await db.scalePoints.where('workshop_id').equals(workshopId).count()
  if (existing > 0) return
  await db.scalePoints.bulkPut(defaultScalePoints(workshopId))
}

export interface SaveScaleResult {
  ok: boolean
  /** A chrome node id naming why it was refused, when it was. */
  problem?: string
  /** Observations whose value this device moved as part of the save. */
  remapped: number
}

/**
 * Save a workshop's whole scale.
 *
 * ONE ENTRY, NOT SIX. The queued entry carries every point plus the remap, and
 * the drain applies it with a single `set_workshop_scale()` call. That is what
 * keeps the write offline-first (it sits in the same outbox as every other setup
 * edit) while still being atomic on arrival, which a per-row upsert could not be:
 * the two-to-six rule is a property of the set, and this queue pushes one row per
 * transaction.
 *
 * `remap` maps a REMOVED value to a surviving one. Applied locally here as well
 * as server-side, because the device that made the change must not go on showing
 * scores on a point its own scale no longer has while it waits for a network.
 */
export async function saveWorkshopScale(
  workshopId: string,
  points: Pick<ScalePoint, 'value' | 'label' | 'description' | 'is_low_trigger'>[],
  remap: Record<number, number> = {},
): Promise<SaveScaleResult> {
  const problem = validateScalePoints(points)
  if (problem) return { ok: false, problem, remapped: 0 }

  const normalized = normalizeScalePoints(workshopId, points)
  const surviving = new Set(normalized.map((p) => p.value))
  const previous = await scalePointsFor(workshopId)
  const removed = previous.map((p) => p.value).filter((v) => !surviving.has(v))

  // Apply the remap locally first, so this device is never showing a designation
  // that its own scale cannot label.
  let remapped = 0
  if (removed.length > 0) {
    const affected = (await db.observations.where('workshop_id').equals(workshopId).toArray()).filter(
      (o) => removed.includes(o.evidence_designation),
    )
    for (const o of affected) {
      const target = remap[o.evidence_designation]
      if (target === undefined || !surviving.has(target)) {
        return { ok: false, problem: 'setup.scale.error.needs-remap', remapped: 0 }
      }
      await db.observations.update(o.id, {
        evidence_designation: target,
        // Only the first time: a value moved twice still records where it began.
        remapped_from: o.remapped_from ?? o.evidence_designation,
        // Re-queue it, or the remap lives on this device only.
        sync_status: 'local',
        sync_error: null,
      })
      remapped++
    }
  }

  await db.transaction('rw', db.scalePoints, async () => {
    const stale = await db.scalePoints.where('workshop_id').equals(workshopId).toArray()
    await db.scalePoints.bulkDelete(stale.filter((s) => !surviving.has(s.value)).map((s) => s.pk))
    await db.scalePoints.bulkPut(normalized)
  })

  await enqueueReferenceWrite({
    id: `scale_point:${workshopId}`,
    table: 'scale_point',
    op: 'replace',
    rowKey: workshopId,
    payload: {
      workshop_id: workshopId,
      points: normalized.map((p) => ({
        value: p.value,
        label: p.label,
        description: p.description,
        is_low_trigger: p.is_low_trigger,
      })),
      remap: Object.fromEntries(Object.entries(remap).map(([k, v]) => [String(k), v])),
    },
  })
  void pushReferenceOutbox()

  await mirrorActiveScale(workshopId)
  return { ok: true, remapped }
}
