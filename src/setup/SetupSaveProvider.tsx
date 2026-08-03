import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'
import { classifySetupChange, type SetupChange, type SetupImpact } from './impact'
import { logSetupChange } from './log'
import { SetupChangeDialog } from './SetupChangeDialog'
import { SetupSaveContext, type SetupSaveApi, type SetupSaveRequest } from './setupSaveContext'
import { useWorkshopState } from './state'

/**
 * Owns the warning layer for every Setup section beneath it.
 *
 * The dialog is rendered HERE, once, rather than by each section. A section that
 * had to render its own dialog is a section that can forget to, and "forgot the
 * warning" looks identical to "the change was safe" from the outside. Sections only
 * call `request()`; whether that shows a dialog is not their decision to make.
 *
 * The commit order is deliberate and worth not rearranging:
 *
 *   classify → (warn, wait for a decision) → commit through the app's own write
 *   path → log, best-effort
 *
 * The log comes last because the change has already happened by then, and a logging
 * failure must not undo it. The write goes through referenceWrite/db.admin/db.settings
 * rather than Supabase directly, so a setup edit made offline is queued like every
 * other write instead of being lost.
 */
export function SetupSaveProvider({
  workshopId,
  children,
}: {
  workshopId: string | null
  children: ReactNode
}) {
  const { identity } = useAuth()
  const state = useWorkshopState(workshopId)
  const [awaiting, setAwaiting] = useState<{
    change: SetupChange
    impact: SetupImpact
    commit: () => Promise<void>
  } | null>(null)
  const [busy, setBusy] = useState(false)

  const run = useCallback(
    async (change: SetupChange, impact: SetupImpact, commit: () => Promise<void>) => {
      setBusy(true)
      try {
        await commit()
        if (workshopId) {
          // Best-effort and deliberately not awaited for its result: the edit is
          // already committed, so a refused or offline log must not surface as a
          // failed save.
          void logSetupChange({
            workshopId,
            change,
            impact,
            state,
            actorEmail: identity?.email ?? null,
          })
        }
      } finally {
        setBusy(false)
        setAwaiting(null)
      }
    },
    [identity?.email, state, workshopId],
  )

  const request = useCallback(
    async (request: SetupSaveRequest) => {
      const impact = classifySetupChange(request.change, state)
      if (impact.silent) {
        await run(request.change, impact, request.commit)
        return
      }
      setAwaiting({ change: request.change, impact, commit: request.commit })
    },
    [run, state],
  )

  const api = useMemo<SetupSaveApi>(
    () => ({
      request,
      state,
      busy,
      awaiting: awaiting ? { change: awaiting.change, impact: awaiting.impact } : null,
    }),
    [request, state, busy, awaiting],
  )

  return (
    <SetupSaveContext.Provider value={api}>
      {children}
      {awaiting && (
        <SetupChangeDialog
          // Remount per target, so a name typed into the destructive confirm cannot
          // leak into the next dialog that opens. A key resets by construction; an
          // effect that clears state can be half-applied.
          key={`${awaiting.change.entity}:${awaiting.change.entityId ?? 'none'}:${awaiting.change.operation}`}
          change={awaiting.change}
          impact={awaiting.impact}
          busy={busy}
          onCancel={() => setAwaiting(null)}
          onConfirm={() => void run(awaiting.change, awaiting.impact, awaiting.commit)}
        />
      )}
    </SetupSaveContext.Provider>
  )
}
