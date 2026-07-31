import { useContext } from 'react'
import { SetupSaveContext, type SetupSaveApi } from './setupSaveContext'

/**
 * The one way a Setup section saves.
 *
 * Every dialog-gated save in Setup routes through here, so a new section cannot
 * ship without the warning layer: there is no other function that both writes and
 * logs, and writing without logging is what this hook exists to prevent.
 *
 * THE RULE (also stated in impact.ts, because it is the one a future editor will
 * violate): a field that saves on blur may only carry changes the classifier calls
 * `safe`. A save-on-blur field cannot host a confirmation dialog without becoming
 * maddening, so anything that can classify higher moves to an explicit Save button
 * with this hook in front of it.
 *
 * Throws outside the provider rather than degrading, because degrading here means
 * an unwarned, unlogged destructive save that looks exactly like a working one.
 */
export function useSetupSave(): SetupSaveApi {
  const api = useContext(SetupSaveContext)
  if (!api) {
    throw new Error(
      'useSetupSave() outside a <SetupSaveProvider>. Every Setup section must render inside the hub (src/pages/admin/Setup.tsx) so its saves are classified and logged.',
    )
  }
  return api
}
