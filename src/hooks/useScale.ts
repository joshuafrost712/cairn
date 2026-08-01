import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/local'
import { useActiveWorkshopId } from '../lib/activeWorkshop'
import { buildScale, DEFAULT_SCALE, type Scale, type ScalePoint } from '../lib/scale'

/**
 * The active workshop's grading scale, live (tl-09).
 *
 * A hook rather than a prop threaded from each page, for the reason
 * `useResolvedKsas` gives about joins: a scale resolved in eight components is a
 * scale that will be resolved differently in one of them, and the symptom would
 * be a legend whose words do not match the heatmap beside it.
 *
 * Falls back to the app's original 0-3 while the cache is cold or the workshop
 * has authored nothing, so a component never has to handle a null scale and a
 * pre-tl-09 workshop renders exactly as it always did.
 */
export function useScale(): Scale {
  const workshopId = useActiveWorkshopId()
  const points = useLiveQuery(
    () =>
      workshopId
        ? db.scalePoints.where('workshop_id').equals(workshopId).toArray()
        : Promise.resolve([] as ScalePoint[]),
    [workshopId],
    [] as ScalePoint[],
  )
  if (!workshopId) return DEFAULT_SCALE
  return buildScale(workshopId, points ?? [])
}

/**
 * A named workshop's scale, live. For the surfaces that show more than one
 * workshop at a time, which must not lean on the active one.
 */
export function useScaleFor(workshopId: string | null): Scale {
  const points = useLiveQuery(
    () =>
      workshopId
        ? db.scalePoints.where('workshop_id').equals(workshopId).toArray()
        : Promise.resolve([] as ScalePoint[]),
    [workshopId],
    [] as ScalePoint[],
  )
  if (!workshopId) return DEFAULT_SCALE
  return buildScale(workshopId, points ?? [])
}
