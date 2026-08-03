import { Link } from 'react-router-dom'
import { c } from '../../lib/content/chrome'

/**
 * The one section whose editor still belongs to a later spec.
 *
 * It is a real section rather than an absent one on purpose: the hub is meant to be
 * the whole shape of setting a workshop up, and a section that simply is not there
 * reads as "the app cannot do this" rather than "this is next". It carries the entry
 * points that DO exist today, and says plainly what is not built.
 *
 * It holds no editable state, so nothing here routes through useSetupSave.
 *
 * The AI section used to live here beside it. tl-13 gave it three modes, five
 * toggles, a trace and real saved state, so it moved to its own file
 * (./AiSection.tsx): the reason these two shared a file was that both were
 * placeholders, and one of them no longer is.
 */

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
