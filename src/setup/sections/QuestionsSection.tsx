import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, newId } from '../../db/local'
import { deleteKsa, upsertKsa } from '../../db/referenceWrite'
import { c } from '../../lib/content/chrome'
import { KSA_AREAS, type Ksa } from '../../lib/types'
import { countsForQuestion } from '../counts'
import { diffFields } from '../impact'
import { useSetupSave } from '../useSetupSave'

/**
 * Goals and questions: what each event is evaluated against.
 *
 * The editor is the Scenario Builder's, moved rather than copied. Two things it
 * gained here.
 *
 * First, an explicit Save. It always had one — a question is edited into a draft and
 * saved in one go — and that is now load-bearing rather than incidental: editing an
 * evidence-level descriptor can classify `invalidates_evidence`, which needs a
 * dialog in front of it, and a dialog cannot sit behind a blur.
 *
 * Second, the honest warning that questions are still a GLOBAL library. `ksa` has no
 * workshop_id until tl-08, so editing a question here edits it in every workshop it
 * is wired to. That was always true and was stated in one line of grey text; it is
 * now also a counted consequence in the dialog, because "changes it everywhere" and
 * "detaches 23 observations across 6 participants" are different sentences.
 */
export function QuestionsSection({ workshopId }: { workshopId: string }) {
  const { request, busy } = useSetupSave()
  const ksas = useLiveQuery(() => db.ksas.orderBy('code').toArray(), [], [] as Ksa[])

  const addQuestion = async () => {
    const next = (ksas ?? []).length + 1
    const ksa: Ksa = {
      id: newId(),
      code: `Q${next}`,
      area: KSA_AREAS[0],
      short_label: 'New question',
      description: '',
      evaluator_facing_prompt: '',
      ai_facing_rubric: null,
      evidence_levels: { '0': '', '1': '', '2': '', '3': '' },
      cbc_subpoint_refs: [],
      guiding_questions: [],
    }
    await request({
      // Not wired to any event, so nobody is asked it and no report reads it: the
      // classifier's canonical `safe` case, and it saves without a dialog.
      change: { entity: 'question', operation: 'create', entityId: ksa.id, label: ksa.code },
      commit: () => upsertKsa(ksa),
    })
  }

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>{c('setup.questions.title', 'label', { count: (ksas ?? []).length })}</h2>
          <button disabled={busy} onClick={() => void addQuestion()}>
            {c('setup.questions.add')}
          </button>
        </div>
        <p className="small muted">{c('setup.questions.global-warning')}</p>
        <p className="small muted">{c('setup.questions.goals-pending')}</p>
        {(ksas ?? []).map((k) => (
          <QuestionEditor key={k.id} ksa={k} workshopId={workshopId} />
        ))}
      </div>
      <div className="card">
        <h2>{c('setup.questions.preview-title')}</h2>
        <p className="small muted">
          {c('setup.questions.preview-help')} <Link to="/admin/setup/calendar">{c('setup.nav.calendar')}</Link>.
        </p>
      </div>
    </>
  )
}

function QuestionEditor({ ksa, workshopId }: { ksa: Ksa; workshopId: string }) {
  const { request, busy } = useSetupSave()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Ksa>(ksa)
  const [confirmArmed, setConfirmArmed] = useState(false)
  const levels = draft.evidence_levels ?? {}
  const setLevel = (n: '0' | '1' | '2' | '3', v: string) =>
    setDraft({ ...draft, evidence_levels: { ...levels, [n]: v } })
  const guiding = draft.guiding_questions ?? []
  const setGuiding = (arr: string[]) => setDraft({ ...draft, guiding_questions: arr })

  const label = `${ksa.code} — ${ksa.short_label || '(no label)'}`

  const save = async () => {
    const cleaned: Ksa = {
      ...draft,
      guiding_questions: (draft.guiding_questions ?? []).filter((g) => g.trim()),
    }
    const counts = await countsForQuestion(ksa, workshopId)
    await request({
      change: {
        entity: 'question',
        operation: 'update',
        entityId: ksa.id,
        label,
        fields: diffFields(ksa, cleaned),
        counts,
      },
      commit: () => upsertKsa(cleaned),
    })
  }

  const remove = async () => {
    setConfirmArmed(false)
    const counts = await countsForQuestion(ksa, workshopId)
    await request({
      change: { entity: 'question', operation: 'delete', entityId: ksa.id, label, counts },
      commit: () => deleteKsa(ksa.id),
    })
  }

  return (
    <div
      className="activity-item"
      style={{ display: 'block', cursor: 'default', marginBottom: '0.5rem' }}
    >
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button className="ghost small" onClick={() => setOpen((o) => !o)}>
          {open ? '▾' : '▸'} <strong>{draft.code}</strong> — {draft.short_label || '(no label)'}
        </button>
        {!confirmArmed ? (
          <button className="ghost small" disabled={busy} onClick={() => setConfirmArmed(true)}>
            {c('setup.action.delete')}
          </button>
        ) : (
          <>
            <button className="small" disabled={busy} onClick={() => void remove()}>
              {c('setup.action.delete-continue')}
            </button>
            <button className="ghost small" onClick={() => setConfirmArmed(false)}>
              {c('setup.action.cancel')}
            </button>
          </>
        )}
      </div>

      {open && (
        <div style={{ marginTop: '0.4rem' }}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span>
              <label className="small muted">Code (unique)</label>
              <input
                value={draft.code}
                onChange={(e) => setDraft({ ...draft, code: e.target.value })}
              />
            </span>
            <span style={{ flex: 1 }}>
              <label className="small muted">Area</label>
              <input
                list="ksa-areas"
                value={draft.area}
                onChange={(e) => setDraft({ ...draft, area: e.target.value })}
                style={{ width: '100%' }}
              />
              <datalist id="ksa-areas">
                {KSA_AREAS.map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </span>
          </div>
          <p className="small muted">{c('setup.questions.code-warning')}</p>
          <label className="small muted">Short label (card heading)</label>
          <input
            value={draft.short_label}
            onChange={(e) => setDraft({ ...draft, short_label: e.target.value })}
          />
          <label className="small muted">Description</label>
          <textarea
            rows={2}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
          <label className="small muted">Evaluator-facing prompt (shown while capturing)</label>
          <textarea
            rows={2}
            value={draft.evaluator_facing_prompt}
            onChange={(e) => setDraft({ ...draft, evaluator_facing_prompt: e.target.value })}
          />

          <label className="small muted">Evidence levels — what earns each 0–3</label>
          {(['0', '1', '2', '3'] as const).map((n) => (
            <div key={n} className="row" style={{ alignItems: 'flex-start' }}>
              <strong style={{ width: '1.5rem', paddingTop: '0.5rem' }}>{n}</strong>
              <textarea
                rows={2}
                value={levels[n] ?? ''}
                onChange={(e) => setLevel(n, e.target.value)}
                style={{ flex: 1 }}
              />
            </div>
          ))}

          <label className="small muted">Guiding questions (look/listen for)</label>
          {guiding.map((g, i) => (
            <div key={i} className="row">
              <input
                value={g}
                onChange={(e) => setGuiding(guiding.map((x, j) => (j === i ? e.target.value : x)))}
                style={{ flex: 1 }}
              />
              <button
                className="ghost small"
                onClick={() => setGuiding(guiding.filter((_, j) => j !== i))}
              >
                remove
              </button>
            </div>
          ))}
          <button className="ghost small" onClick={() => setGuiding([...guiding, ''])}>
            + add guiding question
          </button>

          <label className="small muted" style={{ marginTop: '0.4rem' }}>
            AI-facing rubric (optional)
          </label>
          <textarea
            rows={2}
            value={draft.ai_facing_rubric ?? ''}
            onChange={(e) => setDraft({ ...draft, ai_facing_rubric: e.target.value || null })}
          />
          <label className="small muted">CBC sub-point refs (comma-separated)</label>
          <input
            value={(draft.cbc_subpoint_refs ?? []).join(', ')}
            onChange={(e) =>
              setDraft({
                ...draft,
                cbc_subpoint_refs: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />

          <div className="row" style={{ marginTop: '0.5rem' }}>
            <button disabled={busy || !draft.code.trim()} onClick={() => void save()}>
              {c('setup.questions.save')}
            </button>
            <button className="ghost small" onClick={() => setDraft(ksa)}>
              {c('setup.action.reset')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
