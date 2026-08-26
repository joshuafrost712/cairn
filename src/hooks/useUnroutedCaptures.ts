import { useLiveQuery } from 'dexie-react-hooks'

import { db } from '../db/local'
import { useDisplayWorkshopId } from './useWorkshopEvidence'

/**
 * How many submitted captures this workshop is holding that have produced no
 * observations yet.
 *
 * Every evidence surface in this app is built from routed observations, not from
 * raw captures, and routing is a step somebody runs. When it has not been run the
 * pages do exactly what they do when there is genuinely nothing to show: Workshop
 * Health prints 0%, Observations prints its empty state, Reports stays locked. The
 * two situations are indistinguishable on screen, and in August 2026 that cost
 * three days of a live workshop, with 83 captures sitting on the server the whole
 * time and every dashboard reporting nothing was wrong.
 *
 * Derived from whether observations EXIST for a capture rather than from the
 * capture's local `routing_status`, because that field is device-local: a capture
 * routed on the administrator's laptop still reads unrouted on the phone that
 * filed it. `markRoutedFromObservations` already reconciles the flag on pull; this
 * asks the question directly so the banner cannot disagree with the data under it.
 *
 * Deliberately not in `reports/analytics.ts`, which holds no Dexie import on
 * purpose so the cross-workshop overview can reuse its rollups.
 */
export function useUnroutedCaptures(): { count: number; loading: boolean } {
  const workshopId = useDisplayWorkshopId()
  const count = useLiveQuery(
    async () => {
      if (!workshopId) return 0
      const captures = await db.evaluations.where('workshop_id').equals(workshopId).toArray()
      const submitted = captures.filter((e) => e.attestation && (e.source_text ?? '').trim())
      if (submitted.length === 0) return 0
      // One pass over the workshop's observations rather than a get per capture:
      // this runs on every dashboard, and the table is small enough that the query
      // count matters more than the scan.
      const routed = new Set(
        (await db.observations.where('workshop_id').equals(workshopId).toArray()).map(
          (o) => o.capture_client_id,
        ),
      )
      return submitted.filter((e) => !routed.has(e.client_id)).length
    },
    [workshopId],
    // `undefined` until the first query resolves, which is what `loading` reports.
    // A banner that flashed "0 unrouted" and then corrected itself would train
    // people to ignore it.
    undefined as number | undefined,
  )
  return { count: count ?? 0, loading: count === undefined }
}
