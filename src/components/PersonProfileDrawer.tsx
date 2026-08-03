import { useState } from 'react'
import { Drawer } from './data/Drawer'
import { PersonProfileEditor } from './PersonProfileEditor'
import { usePersonProfile } from '../hooks/usePersonProfile'
import { isProfileEmpty } from '../lib/people'
import { c } from '../lib/content/chrome'
import type { TrackTraining } from '../lib/types'

/**
 * Somebody's background, opened from their name (tl-12).
 *
 * A drawer rather than a page, and a drawer rather than a modal, because of where
 * it is opened from: an evaluator taps a participant's name mid-observation, reads
 * four lines, and dismisses it. `Drawer` is already dismissible by scrim, Escape
 * and its own button, which is the behaviour that makes that possible.
 *
 * The one thing this component must not do is render nothing. A blank drawer reads
 * as a broken app; "this person's background is administrators only" reads as a
 * setting. `usePersonProfile` returns the denial so this can say which.
 */
export function PersonProfileDrawer({
  open,
  onClose,
  personId,
  name,
  /** Excluded from the derived track history: the workshop being looked at. */
  workshopId,
  /** Compact mode for the capture screen: headline, track, work areas, nothing else. */
  compact = false,
  /** Offered only when the caller may actually create the row; see ProfileButton. */
  onCreatePerson,
}: {
  open: boolean
  onClose: () => void
  personId: string | null
  name: string
  workshopId?: string | null
  compact?: boolean
  onCreatePerson?: () => Promise<void>
}) {
  const view = usePersonProfile(personId, workshopId)
  const [editing, setEditing] = useState(false)
  const [linking, setLinking] = useState(false)

  const body = () => {
    if (view.loading) return <p className="muted small">Loading…</p>

    if (!personId) {
      return (
        <div className="form-col">
          <p className="muted small">{c('profile.no-person')}</p>
          {onCreatePerson && (
            <>
              <p className="small muted">{c('profile.link-help')}</p>
              <div className="row">
                <button
                  className="btn--sm"
                  disabled={linking}
                  onClick={() => {
                    setLinking(true)
                    void onCreatePerson().finally(() => setLinking(false))
                  }}
                >
                  {c('profile.link')}
                </button>
              </div>
            </>
          )}
        </div>
      )
    }

    if (view.denial) {
      return (
        <>
          <p>{c(`profile.denied.${view.denial}`)}</p>
          <p className="muted small">{c('profile.denied.help')}</p>
        </>
      )
    }

    if (editing && view.canEdit) {
      return (
        <PersonProfileEditor
          personId={personId}
          name={name}
          profile={view.profile}
          onDone={() => setEditing(false)}
        />
      )
    }

    const empty = isProfileEmpty(view.profile)

    return (
      <div className="form-col">
        {view.profile?.headline?.trim() && <p style={{ margin: 0 }}>{view.profile.headline}</p>}

        {empty && !view.trainings.length && (
          <p className="muted small">{view.canEdit ? c('profile.empty-admin') : c('profile.empty')}</p>
        )}

        <Section title={c('profile.trainings')} show={view.trainings.length > 0}>
          <TrainingList trainings={compact ? view.trainings.slice(0, 4) : view.trainings} />
        </Section>

        <Section
          title={c('profile.experience-areas')}
          show={(view.profile?.experience_areas.length ?? 0) > 0}
        >
          <Chips values={(view.profile?.experience_areas ?? []).slice(0, compact ? 6 : undefined)} />
        </Section>

        {/* Everything below is deliberately absent in compact mode. The constraint
            the spec sets is "an evaluator mid-observation does not want a modal",
            and the way that gets lost is one useful field at a time. */}
        {!compact && (
          <>
            <Section
              title={c('profile.certifications')}
              show={(view.profile?.certifications.length ?? 0) > 0}
            >
              <Bullets values={view.profile?.certifications ?? []} />
            </Section>
            <Section title={c('profile.education')} show={(view.profile?.education.length ?? 0) > 0}>
              <Bullets values={view.profile?.education ?? []} />
            </Section>
            <Section title={c('profile.languages')} show={(view.profile?.languages.length ?? 0) > 0}>
              <Chips values={view.profile?.languages ?? []} />
            </Section>
            <Section title={c('profile.notes')} show={Boolean(view.profile?.notes?.trim())}>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{view.profile?.notes}</p>
            </Section>
            <p className="small muted">{c('profile.boundary')}</p>
            {view.profile?.updated_at && (
              <p className="small muted">
                {c('profile.updated', 'label', {
                  when: view.profile.updated_at.slice(0, 10),
                  who: view.profile.updated_by ?? '—',
                })}
              </p>
            )}
          </>
        )}
      </div>
    )
  }

  return (
    <Drawer
      open={open}
      onClose={() => {
        setEditing(false)
        onClose()
      }}
      title={`${c('profile.title')} — ${name}`}
      side={compact ? 'bottom' : 'right'}
      footer={
        view.canEdit && !editing && !view.denial ? (
          <div className="row">
            <button className="ghost btn--sm" onClick={() => setEditing(true)}>
              {c('profile.edit')}
            </button>
          </div>
        ) : undefined
      }
    >
      {body()}
    </Drawer>
  )
}

function Section({ title, show, children }: { title: string; show: boolean; children: React.ReactNode }) {
  if (!show) return null
  return (
    <div>
      <h3 className="small muted" style={{ margin: '0 0 var(--s-1)' }}>
        {title}
      </h3>
      {children}
    </div>
  )
}

function Bullets({ values }: { values: string[] }) {
  return (
    <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
      {values.map((v) => (
        <li key={v}>{v}</li>
      ))}
    </ul>
  )
}

function Chips({ values }: { values: string[] }) {
  return (
    <span className="row" style={{ flexWrap: 'wrap', gap: 'var(--s-1)' }}>
      {values.map((v) => (
        <span className="pill" key={v}>
          {v}
        </span>
      ))}
    </span>
  )
}

/**
 * The track history, with the two kinds visibly apart.
 *
 * That distinction is the spec's, and it is the substantive half of this whole
 * feature: a training this deployment ran is a fact it can vouch for, and one
 * somebody typed is a claim. An evaluator reading "attended the Epistles workshop"
 * should know which of the two they are reading before they let it change how they
 * read a performance.
 */
function TrainingList({ trainings }: { trainings: TrackTraining[] }) {
  return (
    <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
      {trainings.map((t) => (
        <li key={`${t.kind}:${t.label}:${t.year ?? ''}`}>
          {t.label}
          {t.year ? <span className="muted"> · {t.year}</span> : null}{' '}
          <span
            className={t.kind === 'derived' ? 'pill' : 'pill queued'}
            title={
              t.kind === 'derived'
                ? c('profile.training-derived-help')
                : c('profile.training-self-reported-help')
            }
          >
            {t.kind === 'derived'
              ? c('profile.training-derived')
              : c('profile.training-self-reported')}
          </span>
        </li>
      ))}
    </ul>
  )
}
