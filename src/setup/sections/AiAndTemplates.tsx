import { Link } from 'react-router-dom'
import { ScenarioDraftPanel } from '../../components/ScenarioDraftPanel'
import { c } from '../../lib/content/chrome'
import { ADMIN_ROLES, useHasWorkshopRole } from '../../layout/roles'

/**
 * The two sections whose editors belong to later specs.
 *
 * They are real sections rather than absent ones on purpose: the hub is meant to be
 * the whole shape of setting a workshop up, and a section that simply is not there
 * reads as "the app cannot do this" rather than "this is next". Each one carries the
 * entry points that DO exist today, and says plainly what is not built.
 *
 * They also hold no editable state, so nothing here routes through useSetupSave.
 */

/** AI: the draft-fill offer that exists, and the provider modes that do not (tl-13-15). */
export function AiSection({ workshopId }: { workshopId: string }) {
  const isAdmin = useHasWorkshopRole(ADMIN_ROLES)
  return (
    <>
      <div className="card">
        <h2>{c('setup.ai.title')}</h2>
        <p className="small muted">{c('setup.ai.help')}</p>
        <p className="small muted">{c('setup.ai.modes-pending')}</p>
        {isAdmin && (
          <p className="small muted">
            {c('setup.ai.routing-help')}{' '}
            <Link to="/admin/routing">{c('setup.ai.routing-link')}</Link>.
          </p>
        )}
      </div>
      {/* The first-run "use AI to help fill this out" offer. tl-13 owns the modes
          and the function toggles; this spec only puts the entry point where
          somebody setting a workshop up would look for it. */}
      <ScenarioDraftPanel workshopId={workshopId} />
    </>
  )
}

/** Output templates (tl-16), with today's generated documents linked. */
export function TemplatesSection() {
  return (
    <div className="card">
      <h2>{c('setup.templates.title')}</h2>
      <p className="small muted">{c('setup.templates.pending')}</p>
      <p className="small muted">
        {c('setup.templates.today')} <Link to="/day-email">{c('setup.templates.day-email')}</Link>{' '}
        {c('setup.templates.and')} <Link to="/outgoing">{c('setup.templates.outgoing')}</Link>.
      </p>
    </div>
  )
}
