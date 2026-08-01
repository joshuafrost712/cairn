import { db, workshopSettingPk } from './local'
import { enqueueReferenceWrite, pushReferenceOutbox } from './referenceWrite'
import { setRequiredConfirmations } from '../reports/verification'
import { mirrorActiveScale } from './scale'
import { resolveSettings, settingValue, SETTINGS_DEFAULTS } from '../lib/settings'
import { SETTING_KEYS } from '../lib/types'
import type { SettingKey, WorkshopSettings, WorkshopSettingRow } from '../lib/types'

/**
 * Per-workshop settings: the offline-first cache, the write path, and the one
 * piece of glue that keeps the old synchronous accessor honest.
 *
 * Follows the same offline-first shape as db/admin.ts and db/referenceWrite.ts:
 * write Dexie immediately, queue the backend upsert, replay it when the network
 * allows.
 *
 * ## The localStorage mirror, which is the point of this module
 *
 * `getRequiredConfirmations()` in reports/verification.ts is SYNCHRONOUS and is
 * read from six places, including inside the pure gate logic that every report
 * and export runs through. Making it async to consult a database would ripple
 * through all of them and buy nothing: the value is a single small number that
 * changes about twice per workshop.
 *
 * So the read path is left exactly as it was, and this module makes the value it
 * reads CORRECT by mirroring every pull into the same localStorage key. The
 * threshold is now a workshop-level fact that happens to be cached where a
 * synchronous reader can reach it, rather than a device-level preference. The
 * useful side effect is that offline behaviour is unchanged: a phone with no
 * network still answers from the last mirrored value instead of falling back to
 * a compiled-in default.
 */

/** Cached rows for one workshop. */
export async function settingRows(workshopId: string): Promise<WorkshopSettingRow[]> {
  return db.workshopSettings.where('workshop_id').equals(workshopId).toArray()
}

/**
 * Resolved settings for one workshop, defaults applied.
 *
 * A null workshop id resolves to the defaults rather than throwing: several
 * callers run before a workshop is selected, and the honest answer there is
 * "what the app would do anyway", not an error.
 */
export async function getSettings(workshopId: string | null): Promise<WorkshopSettings> {
  if (!workshopId) return SETTINGS_DEFAULTS
  return resolveSettings(await settingRows(workshopId))
}

/**
 * Point the synchronous accessor at this workshop's threshold.
 *
 * Called on every settings read that came from the backend, and after every
 * local write, so the two can never disagree for longer than one await.
 */
export function mirrorToDevice(settings: WorkshopSettings): void {
  try {
    setRequiredConfirmations(settings.requiredConfirmations)
  } catch {
    /* storage disabled: the accessor falls back to the env default, as before */
  }
}

/**
 * Write one setting: Dexie now, backend when it can be reached.
 *
 * `updatedBy` is the acting user's email. Recorded because a threshold change
 * re-locks reports that were already ready, and "who raised it and when" is the
 * first question that gets asked when they do.
 */
export async function saveSetting(
  workshopId: string,
  key: SettingKey,
  value: unknown,
  updatedBy: string | null,
): Promise<WorkshopSettings> {
  const row: WorkshopSettingRow = {
    pk: workshopSettingPk(workshopId, key),
    workshop_id: workshopId,
    key,
    value,
    updated_by: updatedBy,
    updated_at: new Date().toISOString(),
  }
  await db.workshopSettings.put(row)
  await enqueueReferenceWrite({
    id: `workshop_setting:${row.pk}`,
    table: 'workshop_setting',
    op: 'upsert',
    rowKey: row.pk,
    // `pk` is a Dexie-only column; sending it would fail on an unknown column.
    payload: {
      workshop_id: row.workshop_id,
      key: row.key,
      value: row.value,
      updated_by: row.updated_by,
      updated_at: row.updated_at,
    },
  })
  void pushReferenceOutbox()

  const settings = await getSettings(workshopId)
  mirrorToDevice(settings)
  return settings
}

interface RemoteSettingRow {
  workshop_id: string
  key: string
  value: unknown
  updated_by?: string | null
  updated_at?: string | null
}

/**
 * Replace the cached settings with what the backend returned.
 *
 * Takes rows for every readable workshop at once, because that is the shape
 * `loadReferenceData()` pulls in.
 *
 * `inScope` is the set of workshops the pull was actually AUTHORIZED to see,
 * which the caller knows from its own `workshop` query. Pruning has to key off
 * that rather than off the ids present in `rows`, or a workshop whose last
 * setting was deleted elsewhere keeps its stale cached value here forever: zero
 * rows back would mean zero rows pruned. Keying off authorization instead means
 * a workshop RLS filtered out entirely is left alone (correct: absence is not
 * deletion) while a visible workshop that genuinely has no settings is cleared.
 */
export async function cacheSettingRows(
  rows: RemoteSettingRow[],
  inScope?: Iterable<string>,
): Promise<void> {
  const known = new Set<string>(SETTING_KEYS)
  const typed: WorkshopSettingRow[] = rows
    // A key this build does not recognize is dropped rather than cached. It
    // belongs to a newer client; storing it would put a value in the cache that
    // resolveSettings will never read and nothing will ever clean up.
    .filter((r) => known.has(r.key))
    .map((r) => ({
      pk: workshopSettingPk(r.workshop_id, r.key),
      workshop_id: r.workshop_id,
      key: r.key as SettingKey,
      value: r.value,
      updated_by: r.updated_by ?? null,
      updated_at: r.updated_at ?? null,
    }))

  const touched = new Set([...(inScope ?? []), ...rows.map((r) => r.workshop_id)])
  await db.transaction('rw', db.workshopSettings, async () => {
    for (const workshopId of touched) {
      const stale = await db.workshopSettings.where('workshop_id').equals(workshopId).toArray()
      const keep = new Set(typed.filter((t) => t.workshop_id === workshopId).map((t) => t.pk))
      await db.workshopSettings.bulkDelete(stale.filter((s) => !keep.has(s.pk)).map((s) => s.pk))
    }
    await db.workshopSettings.bulkPut(typed)
  })
}

/**
 * Re-point EVERY synchronous per-workshop mirror at whichever workshop is
 * currently selected.
 *
 * Separate from `cacheSettingRows` because the cache is per workshop and a mirror
 * is one value: switching the active scenario has to move the threshold with it,
 * or the gate would keep applying the previous workshop's rule.
 *
 * tl-09 gave the app a second such mirror (the grading scale, db/scale.ts) and
 * put it HERE rather than beside each of the six callers of this function. A
 * second mirror with its own six call sites is one forgotten call away from a
 * page that labels this workshop's numbers with the previous workshop's words,
 * and every number on it would still look plausible. One function moves them both
 * or neither.
 */
export async function mirrorActiveWorkshop(workshopId: string | null): Promise<WorkshopSettings> {
  const settings = await getSettings(workshopId)
  mirrorToDevice(settings)
  await mirrorActiveScale(workshopId)
  return settings
}

export { settingValue }
