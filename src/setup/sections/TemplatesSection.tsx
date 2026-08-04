import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { c } from '../../lib/content/chrome'
import { db, aiTemplatePk } from '../../db/local'
import { getActiveScale, maxValue, minValue } from '../../lib/scale'
import { useAuth } from '../../auth/AuthContext'
import {
  TEMPLATE_SPECS,
  templateGroups,
  templateSpec,
  type TemplateSpec,
} from '../../templates/defaults'
import { buildTemplateSet, bodyFor, isOverridden } from '../../templates/resolve'
import { render as renderTemplate } from '../../templates/resolve'
import { validateTemplateBody, problemContentId, problemTokens } from '../../templates/validate'
import { addProposal, fdb, resolveProposal, type ContentProposal } from '../../devfeedback/db'
import { applyProposal, parseTemplateRowId } from '../../devfeedback/applyProposal'
import { countsForTemplate } from '../counts'
import { useSetupSave } from '../useSetupSave'
import type { AiTemplateRow } from '../../templates/defaults'
import type { Participant, Workshop } from '../../lib/types'

/**
 * The output template library (tl-16): the wording of everything the app produces.
 *
 * ## Why an edit here is a PROPOSAL and not a save
 *
 * These bodies live in Postgres and are read live by every device, so applying on save
 * would reword a participant's email underneath whoever is reviewing it. The Web App
 * Build Protocol's two-transport rule calls for the staged queue in exactly this case,
 * and this section reuses the one that already exists (`src/devfeedback/`) rather than
 * growing a second: one staleness contract, one applied-edit log, one apply function.
 *
 * The reason that queue is reached from here at all, when `ProposalPanel` already exists,
 * is that `ProposalPanel` is dev-gated. It renders nothing without `?dev=1`, which is
 * right for the reference copy Joshua edits in dev mode and useless for an administrator
 * authoring their workshop's emails. Same queue, same `applyProposal`, second surface.
 *
 * ## Where tl-07's dialog fires, and why it is on APPROVE
 *
 * Proposing changes nothing that anybody reads, so a warning before it would be a dialog
 * about a decision not yet taken. Approving is the act that moves the database ahead of
 * the shipped defaults, so that is where `useSetupSave()` sits — which also means the
 * approval is what reaches `setup_change_log`, and the log therefore records the moment
 * the wording actually changed rather than the moment somebody typed it.
 *
 * ## The line this section states on screen
 *
 * Guidance is authored; the contract is compiled. The JSON schemas, the validators and
 * the capture attestation are not offered here and must not be, because an editable
 * contract is an app that can be edited into accepting invalid data. It is said in the
 * UI rather than only in a comment, because the person most likely to go looking for
 * "where do I change what the AI must return" is the administrator reading this page.
 */
export function TemplatesSection({ workshop }: { workshop: Workshop }) {
  const workshopId = workshop.id
  const { identity } = useAuth()
  const { request, busy } = useSetupSave()

  const rows = useLiveQuery(
    () => db.aiTemplates.where('workshop_id').equals(workshopId).toArray(),
    [workshopId],
    [] as AiTemplateRow[],
  )
  const pending = useLiveQuery(
    () => fdb.proposals.where('status').equals('pending').toArray(),
    [],
    [] as ContentProposal[],
  )
  // Sample values for the preview, from this workshop's real data. A preview against
  // invented names would be the one thing a preview must not be: a variable error an
  // administrator only meets in a sent email is precisely what it exists to prevent.
  const participants = useLiveQuery(
    () => db.participants.where('workshop_id').equals(workshopId).toArray(),
    [workshopId],
    [] as Participant[],
  )

  const set = useMemo(() => buildTemplateSet(workshopId, rows), [workshopId, rows])
  const mine = useMemo(
    () =>
      pending.filter((p) => {
        if (p.table !== 'ai_template') return false
        const parsed = parseTemplateRowId(p.rowId)
        return parsed?.workshopId === workshopId
      }),
    [pending, workshopId],
  )

  const [openGroup, setOpenGroup] = useState<string | null>(null)
  const [notice, setNotice] = useState('')

  const groups = templateGroups()

  const proposeEdit = async (spec: TemplateSpec, next: string) => {
    const verdict = validateTemplateBody(spec.key, next)
    if (!verdict.ok) {
      setNotice(c(problemContentId(verdict.problem), 'label', problemTokens(verdict.problem)))
      return
    }
    const currentBody = bodyFor(set, spec.key)
    if (next === currentBody) {
      setNotice(c('setup.templates.no-change'))
      return
    }
    await addProposal({
      table: 'ai_template',
      rowId: aiTemplatePk(workshopId, spec.key),
      field: 'body',
      // The RESOLVED body, which for an unauthored slot is the shipped default. That is
      // what `applyProposal` reads back to check staleness, so seeding it any other way
      // would make the check compare two different questions.
      oldText: currentBody,
      newText: next,
      route: '/admin/setup/templates',
      locationLabel: spec.label,
    })
    setNotice(c('setup.templates.proposed'))
  }

  const approve = async (p: ContentProposal) => {
    const parsed = parseTemplateRowId(p.rowId)
    const spec = parsed ? templateSpec(parsed.templateKey) : undefined
    if (!parsed || !spec) {
      setNotice(c('setup.templates.error.unknown-key'))
      return
    }
    const counts = await countsForTemplate(workshopId)
    const reverting = p.newText === templateSpec(spec.key)?.body

    await request({
      change: {
        entity: 'template',
        // A revert is `delete` because that is what it does to the database: the override
        // row goes away and the shipped default takes over. Classifying it as an update
        // would make the dialog describe it as new wording arriving, which is the
        // opposite of what an administrator clicking Revert is asking for.
        operation: reverting ? 'delete' : 'update',
        entityId: spec.key,
        label: spec.label,
        fields: [{ field: 'body', before: p.oldText, after: p.newText }],
        counts,
      },
      commit: async () => {
        const outcome = await applyProposal(p, identity?.email ?? null)
        if (outcome.code === 'stale') {
          setNotice(c('setup.templates.stale'))
          return
        }
        if (outcome.code === 'missing') {
          setNotice(c('setup.templates.error.unknown-key'))
          return
        }
        if (outcome.code === 'invalid') {
          setNotice(c(problemContentId(outcome.problem!), 'label', problemTokens(outcome.problem!)))
          return
        }
        const sync = outcome.syncFailed
          ? c('setup.templates.sync-queued')
          : (outcome.stillPending ?? 0) > 0
            ? c('setup.templates.sync-pending', 'label', { n: outcome.stillPending ?? 0 })
            : c('setup.templates.sync-done')
        // `outcome.logged` is REPORTED, not dropped, and the second-AI review is why. The
        // git-tracked before/after only ever gets written by a dev server pointed at a real
        // backend, so from a deployed build — which is the only build an administrator will
        // ever be on — it can never be true. Saying nothing would leave the spec's own
        // "every applied edit appears in the git-tracked log" quietly unmet AND break the
        // widget's first invariant: never claim a success you did not observe. So the
        // sentence names where the record does exist instead.
        const record = outcome.logged
          ? c('setup.templates.logged')
          : c('setup.templates.not-logged')
        setNotice(
          `${outcome.reverted ? c('setup.templates.reverted') : c('setup.templates.applied')} ${sync} ${record}`,
        )
      },
    })
  }

  return (
    <div className="stack">
      <div className="card">
        <h2>{c('setup.templates.title')}</h2>
        <p className="small muted">{c('setup.templates.intro')}</p>
        <p className="small muted">{c('setup.templates.contract-note')}</p>
        <p className="small muted">
          {c('setup.templates.today')} <Link to="/day-email">{c('setup.templates.day-email')}</Link>{' '}
          {c('setup.templates.and')} <Link to="/outgoing">{c('setup.templates.outgoing')}</Link>.
        </p>
        {notice && <p className="banner">{notice}</p>}
      </div>

      {mine.length > 0 && (
        <section className="card">
          <h3>{c('setup.templates.proposals-title', 'label', { n: mine.length })}</h3>
          <p className="small muted">{c('setup.templates.proposals-intro')}</p>
          {mine.map((p) => {
            const parsed = parseTemplateRowId(p.rowId)
            const spec = parsed ? templateSpec(parsed.templateKey) : undefined
            return (
              <div key={p.id} className="activity-item" style={{ display: 'block', cursor: 'default' }}>
                <div className="small muted">{spec?.label ?? p.locationLabel}</div>
                <div
                  className="small"
                  style={{ marginTop: '0.25rem', textDecoration: 'line-through', opacity: 0.7, whiteSpace: 'pre-wrap' }}
                >
                  {p.oldText}
                </div>
                <div className="small" style={{ marginTop: '0.25rem', fontWeight: 600, whiteSpace: 'pre-wrap' }}>
                  {p.newText}
                </div>
                <div className="row" style={{ marginTop: '0.5rem', flexWrap: 'wrap' }}>
                  <button className="primary" disabled={busy} onClick={() => void approve(p)}>
                    {c('setup.templates.approve')}
                  </button>
                  <button className="ghost" disabled={busy} onClick={() => void resolveProposal(p.id, 'rejected')}>
                    {c('setup.templates.reject')}
                  </button>
                </div>
              </div>
            )
          })}
        </section>
      )}

      {groups.map((g) => {
        const specs = TEMPLATE_SPECS.filter((s) => s.group === g.group)
        const edited = specs.filter((s) => isOverridden(set, s.key)).length
        const open = openGroup === g.group
        return (
          <section className="card" key={g.group}>
            {/* A stacked list of expandable rows rather than a table. The protocol's own
                note on this: a dense table wrapped in a scroller passes a layout audit
                while showing a phone reader the first column, and here the narrow
                columns WOULD be the controls. */}
            <button
              className="ghost"
              style={{ width: '100%', textAlign: 'left' }}
              onClick={() => setOpenGroup(open ? null : String(g.group))}
              aria-expanded={open}
            >
              <strong>{c(`setup.templates.group.${g.group}`)}</strong>{' '}
              <span className="small muted">
                {/* A singular id rather than "1 slot(s)". Four of the seven groups hold
                    exactly one slot, so this is the common case rather than the edge one,
                    and "1 slots" was on screen in the audit's own phone screenshot —
                    which is the half of that audit a person has to do. */}
                {edited > 0
                  ? c('setup.templates.group-edited', 'label', { edited, total: specs.length })
                  : specs.length === 1
                    ? c('setup.templates.group-default-one')
                    : c('setup.templates.group-default', 'label', { total: specs.length })}
              </span>
            </button>

            {open && (
              <div className="stack-tight" style={{ marginTop: '0.75rem' }}>
                {specs.map((spec) => (
                  <TemplateEditor
                    key={spec.key}
                    spec={spec}
                    stored={bodyFor(set, spec.key)}
                    overridden={isOverridden(set, spec.key)}
                    pending={mine.some((p) => parseTemplateRowId(p.rowId)?.templateKey === spec.key)}
                    sample={sampleTokens(spec, workshop, participants)}
                    onPropose={(next) => void proposeEdit(spec, next)}
                  />
                ))}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

/**
 * One slot: what it is, what it says now, and what it may say.
 *
 * Its own component with a `key` of the template key, so switching slots RESETS the
 * draft by construction. The widget's reliability invariant #2, which shipped twice as a
 * real bug: a singleton editor keeps its local draft across targets, and the previous
 * slot's typed text leaks into the next one that opens.
 */
function TemplateEditor({
  spec,
  stored,
  overridden,
  pending,
  sample,
  onPropose,
}: {
  spec: TemplateSpec
  stored: string
  overridden: boolean
  pending: boolean
  sample: Record<string, string | number>
  onPropose: (next: string) => void
}) {
  const [draft, setDraft] = useState(stored)
  const [showPreview, setShowPreview] = useState(false)
  const verdict = validateTemplateBody(spec.key, draft)
  const changed = draft !== stored

  return (
    <div className="activity-item" style={{ display: 'block', cursor: 'default' }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: '0.4rem' }}>
        <strong className="small">{spec.label}</strong>
        <span className={overridden ? 'pill ok' : 'pill local'}>
          {overridden ? c('setup.templates.badge.edited') : c('setup.templates.badge.default')}
        </span>
        {pending && <span className="pill local">{c('setup.templates.badge.pending')}</span>}
      </div>
      <p className="small muted">{spec.help}</p>

      {/* Sized to the text rather than to `spec.multiline`. That flag answers "may this
          body contain a line break", and using it for height too gave the two-line
          sign-off the same twelve-row box as the 2,400-character general instructions —
          visible only by opening the walkthrough's own screenshot, which is the half of
          an audit a person has to do. */}
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={rowsFor(draft, spec.multiline)}
        style={{ width: '100%', fontFamily: 'inherit' }}
        aria-label={spec.label}
      />

      {spec.variables.length > 0 && (
        <p className="small muted">
          {c('setup.templates.variables')}{' '}
          {spec.variables.map((v) => (
            <span key={v.name}>
              <code>{`{{${v.name}}}`}</code> — {v.description}.{' '}
            </span>
          ))}
        </p>
      )}

      {!verdict.ok && changed && (
        <p className="banner warn small">
          {c(problemContentId(verdict.problem), 'label', problemTokens(verdict.problem))}
        </p>
      )}

      <div className="row" style={{ flexWrap: 'wrap', marginTop: '0.4rem' }}>
        <button className="primary btn--sm" disabled={!changed || !verdict.ok} onClick={() => onPropose(draft)}>
          {c('setup.templates.propose')}
        </button>
        {/* Revert is a proposal like any other edit, with the shipped text as its new
            body. `applyProposal` recognizes that and DELETES the row rather than storing
            the default as an override, which is what keeps a workshop that asked for
            "the app's own words" tracking a later deploy that improves them. */}
        <button
          className="ghost btn--sm"
          disabled={!overridden}
          onClick={() => {
            setDraft(spec.body)
            onPropose(spec.body)
          }}
        >
          {c('setup.templates.revert')}
        </button>
        <button className="ghost btn--sm" onClick={() => setShowPreview((v) => !v)}>
          {c('setup.templates.preview')}
        </button>
      </div>

      {showPreview && (
        <div className="banner small" style={{ whiteSpace: 'pre-wrap', marginTop: '0.4rem' }}>
          {previewOf(spec, draft, sample)}
        </div>
      )}
    </div>
  )
}

/**
 * How tall the box should be: enough for what is in it, plus room to grow.
 *
 * Clamped at both ends. Three rows minimum so a one-line slot still looks editable, and
 * fourteen maximum so the general instructions scroll inside their own box rather than
 * pushing every slot below them off the page.
 */
function rowsFor(body: string, multiline: boolean): number {
  if (!multiline) return 3
  const lines = body.split('\n').length
  return Math.min(14, Math.max(3, lines + 2))
}

/**
 * The draft body rendered against this workshop's real values.
 *
 * Uses the DRAFT rather than the stored body, because the question a preview answers is
 * "what will this say once approved". An unfilled token stays visible, which is the
 * filler's deliberate behaviour and exactly what should be seen here.
 */
function previewOf(
  spec: TemplateSpec,
  draft: string,
  sample: Record<string, string | number>,
): string {
  // Render through the same path a document uses, against a one-slot set, so the preview
  // cannot diverge from the real thing by using a second filler.
  return renderTemplate({ workshopId: 'preview', overrides: { [spec.key]: draft } }, spec.key, sample)
}

/**
 * Real values for each declared variable, from the active workshop.
 *
 * Every variable a spec declares gets a value, and one that has no real source gets a
 * bracketed placeholder rather than being left out — an unfilled token in a preview reads
 * as a bug in the template rather than as a gap in the sample data.
 */
function sampleTokens(
  spec: TemplateSpec,
  workshop: Workshop,
  participants: Participant[],
): Record<string, string | number> {
  const scale = getActiveScale()
  const person = participants[0]
  const firstName = person?.name.split(' ')[0] ?? 'Amos'
  const known: Record<string, string | number> = {
    firstName,
    participantName: person?.name ?? 'Amos Khokhar',
    workshopName: workshop.name,
    dateLabel: workshop.start_date ?? '2026-08-26',
    generatedOn: workshop.start_date ?? '2026-08-26',
    minValue: minValue(scale),
    maxValue: maxValue(scale),
    goalTitle: 'Exegetical accuracy',
    label: scale.points[scale.points.length - 1].label,
    value: maxValue(scale),
    fromName: workshop.name,
    toName: 'facilitators',
    mean: '2.4',
    scope: '6 participants observed, 14 observations, 2 evaluators',
    below: 3,
    observed: 8,
    captures: 2,
    teamBit: ', Team A',
    total: 14,
    required: 2,
    verified: 11,
    extra: ', 3 pending',
    evidenced: 5,
    reviewBit: ', with 2 item(s) flagged for review',
    areas: 'EXEG (Exegetical accuracy); CHECK (Community checking)',
    range: `${minValue(scale)}-${maxValue(scale)}`,
    scaleSentence: '(the scale sentence for this workshop)',
  }
  const out: Record<string, string | number> = {}
  for (const v of spec.variables) out[v.name] = known[v.name] ?? `[${v.name}]`
  return out
}
