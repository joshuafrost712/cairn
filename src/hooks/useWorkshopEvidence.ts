import { useLiveQuery } from 'dexie-react-hooks'

import { db } from '../db/local'
import { scaleForWorkshop } from '../db/scale'
import { templatesForWorkshop } from '../db/templates'
import { DEFAULT_SCALE, type Scale } from '../lib/scale'
import { DEFAULT_TEMPLATES, type TemplateSet } from '../templates/resolve'
import { resolveDisplayWorkshop, scopeEvidence, type ScopedEvidence } from '../reports/scope'
import { useActiveWorkshopId } from '../lib/activeWorkshop'
import { useScopedWorkshopId } from '../layout/roles'
import type { Workshop } from '../lib/types'

export interface WorkshopEvidence extends ScopedEvidence {
  /** The active workshop's row, or null while it has not reached this device. */
  workshop: Workshop | null
  /** Its name, or the generic fallback, which is what every document heading takes. */
  workshopName: string
  scale: Scale
  templates: TemplateSet
  loading: boolean
}

const EMPTY: WorkshopEvidence = {
  workshopId: null,
  workshop: null,
  workshopName: 'Workshop',
  participants: [],
  instructorRoster: [],
  teams: [],
  ksas: [],
  goals: [],
  activities: [],
  observations: [],
  verdicts: [],
  evaluations: [],
  instructorObservations: [],
  instructorVerdicts: [],
  instructorEvaluations: [],
  unresolved: [],
  scale: DEFAULT_SCALE,
  templates: DEFAULT_TEMPLATES,
  loading: true,
}

/**
 * Which workshop a surface should DISPLAY, which is not quite the same question as
 * which workshop the user holds a role in.
 *
 * `useScopedWorkshopId()` is the authorization-safe read: it validates the device's
 * stored selection against real memberships and returns **null when there are no
 * memberships at all**. That is correct for deciding what somebody may do and wrong
 * for deciding what to show, because two legitimate states hold no memberships: a
 * local-only build with no backend configured (which is how the app runs on a field
 * device with no Supabase, and how every browser harness in this wave runs) and a
 * device that has not finished signing in. Scoping those to null was the difference
 * between this fix working and quietly doing nothing on exactly the devices that
 * evaluate offline.
 *
 * So the display scope falls back to the device's own selection. That is not the
 * client asserting a privilege: it narrows what a device shows out of what it
 * already holds, and what it holds is decided by RLS against `auth.uid()`. Where the
 * two disagree, the membership-validated answer wins, so a signed-in member can
 * never be shown a workshop they were moved out of.
 */
export function useDisplayWorkshopId(): string | null {
  const scoped = useScopedWorkshopId()
  const stored = useActiveWorkshopId()
  return scoped ?? stored
}

/**
 * One workshop's evidence, for any surface that generates a document from it.
 *
 * The seam tl-29 exists to create. Four surfaces used to read the evidence tables
 * with a bare `toArray()` and take the workshop from
 * `db.workshops.toCollection().first()`, which is Dexie primary-key order rather
 * than the workshop anybody selected. On the first device to hold two real
 * workshops, the day email came out under one workshop's name carrying the other
 * one's people, and the same designation printed against a scale that had not
 * produced it. The rules are in the pure `scopeEvidence`; this is the Dexie half.
 *
 * **Read this instead of the tables, or take a workshop id as an argument.** A
 * structural test (`test/workshopScoping.test.ts`) fails the build when a new file
 * reads them unscoped, because tl-16 and tl-26 both learned the same thing about
 * this codebase: a precondition stated in a comment is not a precondition the code
 * enforces, and the only thing that closes that gap is a tripwire.
 *
 * One live query rather than nine: Dexie observes every table the query touches, so
 * a verdict recorded on another device still repaints the page, and the scoping
 * decision happens once in a place that can be tested.
 */
export function useWorkshopEvidence(): WorkshopEvidence {
  const workshopId = useDisplayWorkshopId()

  const value = useLiveQuery(
    async (): Promise<WorkshopEvidence> => {
      const [
        workshops,
        participants,
        teams,
        ksas,
        goals,
        activities,
        observations,
        verdicts,
        evaluations,
        scale,
        templates,
      ] = await Promise.all([
        db.workshops.toArray(),
        db.participants.toArray(),
        db.teams.toArray(),
        db.ksas.toArray(),
        db.goals.toArray(),
        db.activities.toArray(),
        db.observations.toArray(),
        db.verifications.toArray(),
        db.evaluations.toArray(),
        scaleForWorkshop(workshopId),
        templatesForWorkshop(workshopId),
      ])

      const workshop = resolveDisplayWorkshop(workshops, workshopId)

      const scoped = scopeEvidence({
        workshopId,
        participants,
        teams,
        ksas,
        goals,
        activities,
        observations,
        verdicts,
        evaluations,
      })

      return {
        ...scoped,
        workshop,
        workshopName: workshop?.name ?? 'Workshop',
        scale,
        templates,
        loading: false,
      }
    },
    [workshopId],
  )

  return value ?? EMPTY
}
