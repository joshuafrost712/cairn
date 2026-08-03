import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, newId } from '../../db/local'
import {
  deleteGoalRow,
  deleteKsa,
  reorderGoals,
  upsertGoal,
  upsertKsa,
  upsertWorkshop,
} from '../../db/referenceWrite'
import { c } from '../../lib/content/chrome'
import {
  goalLabel,
  groupByGoal,
  nextGoalCode,
  nextQuestionCode,
  type GoalGroup,
} from '../../lib/goals'
import type { Goal, Ksa, Workshop } from '../../lib/types'
import { countsForGoal, countsForQuestion } from '../counts'
import { diffFields } from '../impact'
import { useSetupSave } from '../useSetupSave'
import { useScaleFor } from '../../hooks/useScale'

/**
 * Goals and questions: what this workshop is evaluating for, and what it asks.
 *
 * tl-08 changed both halves of this section.
 *
 * The questions are now the WORKSHOP's rather than the deployment's. The honest
 * grey-text warning this section carried — "editing a question here edits it in
 * every workshop it is wired to" — is gone because it has stopped being true, which
 * is the whole point of the spec. What replaces it is a scoped list: the query is
 * `where('workshop_id')`, so a second workshop's Q1 is not even visible here, let
 * alone editable by accident.
 *
 * And there is a level above them. Joshua's feedback asked to edit "the
 * highest-level KSAs (or whatever other goals they have)", so a goal is a row an
 * administrator writes rather than a string matched against six hardcoded Psalms
 * competency areas. Each workshop names the level itself (`goal_label`), so an
 * organization using KSAs reads "KSA area" and nobody has to rename a schema to
 * rename a heading.
 *
 * Questions are grouped under their goals, reorderable inside one and movable
 * between them. Moving one after captures exist is a classified change with a
 * count, because every report already printed regroups under a different heading.
 */
export function QuestionsSection({ workshop }: { workshop: Workshop }) {
  const workshopId = workshop.id
  const label = goalLabel(workshop)
  const goals = useLiveQuery(
    () => db.goals.where('workshop_id').equals(workshopId).toArray(),
    [workshopId],
    [] as Goal[],
  )
  const ksas = useLiveQuery(
    () => db.ksas.where('workshop_id').equals(workshopId).toArray(),
    [workshopId],
    [] as Ksa[],
  )
  const groups = groupByGoal(ksas ?? [], goals ?? [])

  return (
    <>
      <GoalsCard workshop={workshop} goals={goals ?? []} groups={groups} />
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>{c('setup.questions.title', 'label', { count: (ksas ?? []).length })}</h2>
        </div>
        <p className="small muted">{c('setup.questions.scoped-note', 'label', { workshop: workshop.name })}</p>
        {(goals ?? []).length === 0 && (
          <p className="small muted">{c('setup.questions.no-goals', 'label', { label })}</p>
        )}
        {groups.map((group) => (
          <QuestionGroup
            key={group.goal?.id ?? 'ungrouped'}
            group={group}
            goals={goals ?? []}
            ksas={ksas ?? []}
            goalWord={label}
            workshopId={workshopId}
          />
        ))}
      </div>
      <div className="card">
        <h2>{c('setup.questions.preview-title')}</h2>
        <p className="small muted">
          {c('setup.questions.preview-help')}{' '}
          <Link to="/admin/setup/calendar">{c('setup.nav.calendar')}</Link>.
        </p>
      </div>
    </>
  )
}

/** The goals themselves: add, rename, reorder, delete. */
function GoalsCard({
  workshop,
  goals,
  groups,
}: {
  workshop: Workshop
  goals: Goal[]
  groups: GoalGroup[]
}) {
  const { request, busy } = useSetupSave()
  const label = goalLabel(workshop)
  const countFor = (goalId: string) => groups.find((g) => g.goal?.id === goalId)?.ksas.length ?? 0

  const add = async () => {
    const goal: Goal = {
      id: newId(),
      workshop_id: workshop.id,
      code: nextGoalCode(goals),
      title: '',
      description: null,
      sort_order: goals.length,
    }
    await request({
      // Nothing is grouped under it yet, so it changes no report and no capture:
      // the classifier's canonical `safe` case, saved without a dialog.
      change: { entity: 'goal', operation: 'create', entityId: goal.id, label: goal.code },
      commit: () => upsertGoal(goal),
    })
  }

  const move = async (index: number, dir: -1 | 1) => {
    const ordered = [...goals].sort((a, b) => a.sort_order - b.sort_order)
    const j = index + dir
    if (j < 0 || j >= ordered.length) return
    ;[ordered[index], ordered[j]] = [ordered[j], ordered[index]]
    // Reordering headings is presentation: no question changes goal and no
    // designation changes meaning, so it saves on the spot like a rename of a team.
    await reorderGoals(ordered)
  }

  const ordered = [...goals].sort((a, b) => a.sort_order - b.sort_order)

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>{c('setup.goals.title', 'label', { label, count: goals.length })}</h2>
        <button disabled={busy} onClick={() => void add()}>
          {c('setup.goals.add', 'label', { label })}
        </button>
      </div>
      <p className="small muted">{c('setup.goals.help', 'label', { label })}</p>
      <GoalLabelField workshop={workshop} />
      {ordered.length === 0 ? (
        <p className="small muted">{c('setup.goals.empty', 'label', { label })}</p>
      ) : (
        ordered.map((goal, i) => (
          <GoalEditor
            key={goal.id}
            goal={goal}
            questionCount={countFor(goal.id)}
            first={i === 0}
            last={i === ordered.length - 1}
            onMove={(dir) => void move(i, dir)}
          />
        ))
      )}
    </div>
  )
}

/** What this workshop calls the level above a question. */
function GoalLabelField({ workshop }: { workshop: Workshop }) {
  const { request, busy } = useSetupSave()
  const [draft, setDraft] = useState(workshop.goal_label ?? '')

  const save = async () => {
    const after: Workshop = { ...workshop, goal_label: draft.trim() || null }
    await request({
      change: {
        entity: 'workshop',
        operation: 'update',
        entityId: workshop.id,
        label: workshop.name,
        fields: diffFields(workshop, after),
      },
      commit: () => upsertWorkshop(after),
    })
  }

  return (
    <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <span>
        <label className="small muted">{c('setup.goals.label-field')}</label>
        <input
          value={draft}
          placeholder={c('setup.goals.label-placeholder')}
          onChange={(e) => setDraft(e.target.value)}
        />
      </span>
      <button
        className="ghost small"
        disabled={busy || (workshop.goal_label ?? '') === draft}
        onClick={() => void save()}
      >
        {c('setup.goals.label-save')}
      </button>
    </div>
  )
}

function GoalEditor({
  goal,
  questionCount,
  first,
  last,
  onMove,
}: {
  goal: Goal
  questionCount: number
  first: boolean
  last: boolean
  onMove: (dir: -1 | 1) => void
}) {
  const { request, busy } = useSetupSave()
  const [draft, setDraft] = useState<Goal>(goal)
  const [confirmArmed, setConfirmArmed] = useState(false)
  const label = `${goal.code} — ${goal.title || c('setup.goals.untitled')}`

  const save = async () => {
    const counts = await countsForGoal(goal.id, goal.workshop_id)
    await request({
      change: {
        entity: 'goal',
        operation: 'update',
        entityId: goal.id,
        label,
        fields: diffFields(goal, draft),
        counts,
      },
      commit: () => upsertGoal(draft),
    })
  }

  const remove = async () => {
    setConfirmArmed(false)
    const counts = await countsForGoal(goal.id, goal.workshop_id)
    await request({
      change: { entity: 'goal', operation: 'delete', entityId: goal.id, label, counts },
      commit: () => deleteGoalRow(goal.id),
    })
  }

  return (
    <div
      className="activity-item"
      // The code is an input value, which no text-based locator can read. Harnesses
      // (scripts/tl08-goals.mjs) address a goal row by this.
      data-goal-code={goal.code}
      style={{ display: 'block', cursor: 'default', marginBottom: '0.4rem' }}
    >
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <span style={{ width: '5rem' }}>
          <label className="small muted">{c('setup.goals.code')}</label>
          <input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
        </span>
        <span style={{ flex: 1, minWidth: '12rem' }}>
          <label className="small muted">{c('setup.goals.heading')}</label>
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            style={{ width: '100%' }}
          />
        </span>
        <button className="ghost small" onClick={() => onMove(-1)} disabled={busy || first}>
          ↑
        </button>
        <button className="ghost small" onClick={() => onMove(1)} disabled={busy || last}>
          ↓
        </button>
      </div>
      <label className="small muted">{c('setup.goals.description')}</label>
      <textarea
        rows={2}
        value={draft.description ?? ''}
        onChange={(e) => setDraft({ ...draft, description: e.target.value || null })}
      />
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="small muted">
          {c('setup.goals.holds', 'label', { count: questionCount })}
        </span>
        <span className="row">
          <button
            className="small"
            disabled={busy || !draft.code.trim() || diffFields(goal, draft).length === 0}
            onClick={() => void save()}
          >
            {c('setup.goals.save')}
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
        </span>
      </div>
    </div>
  )
}

/** One goal's questions, plus the Add that creates a question already inside it. */
function QuestionGroup({
  group,
  goals,
  ksas,
  goalWord,
  workshopId,
}: {
  group: GoalGroup
  goals: Goal[]
  ksas: Ksa[]
  goalWord: string
  workshopId: string
}) {
  const { request, busy } = useSetupSave()
  const scale = useScaleFor(workshopId)

  const addQuestion = async () => {
    const ksa: Ksa = {
      id: newId(),
      workshop_id: workshopId,
      // Scoped to the workshop, so this is the next free code HERE. Two workshops
      // may both hold a Q1 and neither knows about the other's.
      code: nextQuestionCode(ksas),
      goal_id: group.goal?.id ?? null,
      short_label: 'New question',
      description: '',
      evaluator_facing_prompt: '',
      ai_facing_rubric: null,
      // One empty descriptor per point of THIS workshop's scale, not a fixed
      // four (tl-09). A question born with keys 0-3 in a 1-5 workshop would show
      // its author four boxes for five points, and the fifth would silently have
      // no descriptor for the router to rate against.
      evidence_levels: Object.fromEntries(scale.points.map((p) => [String(p.value), ''])),
      cbc_subpoint_refs: [],
      guiding_questions: [],
    }
    await request({
      change: { entity: 'question', operation: 'create', entityId: ksa.id, label: ksa.code },
      commit: () => upsertKsa(ksa),
    })
  }

  return (
    <div style={{ marginTop: '0.75rem' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ margin: 0 }}>
          {group.goal
            ? `${group.goal.code} — ${group.goal.title || c('setup.goals.untitled')}`
            : c('setup.questions.ungrouped', 'label', { label: goalWord })}
        </h3>
        <button className="ghost small" disabled={busy} onClick={() => void addQuestion()}>
          {c('setup.questions.add')}
        </button>
      </div>
      {group.ksas.length === 0 ? (
        <p className="small muted">{c('setup.questions.group-empty')}</p>
      ) : (
        group.ksas.map((k) => (
          <QuestionEditor key={k.id} ksa={k} goals={goals} goalWord={goalWord} workshopId={workshopId} />
        ))
      )}
    </div>
  )
}

function QuestionEditor({
  ksa,
  goals,
  goalWord,
  workshopId,
}: {
  ksa: Ksa
  goals: Goal[]
  goalWord: string
  workshopId: string
}) {
  const { request, busy } = useSetupSave()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Ksa>(ksa)
  const [confirmArmed, setConfirmArmed] = useState(false)
  const scale = useScaleFor(workshopId)
  const levels = draft.evidence_levels ?? {}
  /**
   * Descriptors for points the scale no longer has are RETAINED here and simply
   * not rendered — `levels` is spread, so an untouched key survives the save.
   * That is the spec's requirement and it is worth stating why: shortening a
   * scale to three points and lengthening it back to four must not destroy the
   * sentence somebody wrote for the fourth. The UI says so; see
   * `setup.questions.levels-note`.
   */
  const setLevel = (n: number, v: string) =>
    setDraft({ ...draft, evidence_levels: { ...levels, [String(n)]: v } })
  const onScale = new Set(scale.points.map((p) => String(p.value)))
  const retired = Object.keys(levels).filter((k) => !onScale.has(k) && (levels[k] ?? '').trim())
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
      data-question-code={ksa.code}
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
              <label className="small muted">{c('setup.questions.code')}</label>
              <input
                value={draft.code}
                onChange={(e) => setDraft({ ...draft, code: e.target.value })}
              />
            </span>
            <span style={{ flex: 1 }}>
              <label className="small muted">{goalWord}</label>
              <select
                value={draft.goal_id ?? ''}
                onChange={(e) => setDraft({ ...draft, goal_id: e.target.value || null })}
                style={{ width: '100%' }}
              >
                <option value="">{c('setup.questions.no-goal')}</option>
                {[...goals]
                  .sort((a, b) => a.sort_order - b.sort_order)
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.code} — {g.title || c('setup.goals.untitled')}
                    </option>
                  ))}
              </select>
            </span>
          </div>
          <p className="small muted">{c('setup.questions.code-warning')}</p>
          <p className="small muted">{c('setup.questions.regroup-warning', 'label', { label: goalWord })}</p>
          <label className="small muted">{c('setup.questions.short-label')}</label>
          <input
            value={draft.short_label}
            onChange={(e) => setDraft({ ...draft, short_label: e.target.value })}
          />
          <label className="small muted">{c('setup.questions.description')}</label>
          <textarea
            rows={2}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
          <label className="small muted">{c('setup.questions.prompt')}</label>
          <textarea
            rows={2}
            value={draft.evaluator_facing_prompt}
            onChange={(e) => setDraft({ ...draft, evaluator_facing_prompt: e.target.value })}
          />
          <p className="small muted">{c('setup.questions.prompt-override-note')}</p>

          <label className="small muted">{c('setup.questions.levels')}</label>
          {scale.points.map((p) => (
            <div key={p.value} className="row" style={{ alignItems: 'flex-start' }}>
              <strong
                style={{ width: '1.5rem', paddingTop: '0.5rem' }}
                title={p.label}
                data-trigger={p.is_low_trigger || undefined}
              >
                {p.value}
              </strong>
              <textarea
                rows={2}
                aria-label={`${p.value} — ${p.label}`}
                placeholder={p.label}
                value={levels[String(p.value)] ?? ''}
                onChange={(e) => setLevel(p.value, e.target.value)}
                style={{ flex: 1 }}
              />
            </div>
          ))}
          {retired.length > 0 && (
            <p className="small muted">
              {c('setup.questions.levels-note', 'label', { points: retired.join(', ') })}
            </p>
          )}

          <label className="small muted">{c('setup.questions.guiding')}</label>
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
                {c('setup.questions.guiding-remove')}
              </button>
            </div>
          ))}
          <button className="ghost small" onClick={() => setGuiding([...guiding, ''])}>
            {c('setup.questions.guiding-add')}
          </button>

          <label className="small muted" style={{ marginTop: '0.4rem' }}>
            {c('setup.questions.rubric')}
          </label>
          <textarea
            rows={2}
            value={draft.ai_facing_rubric ?? ''}
            onChange={(e) => setDraft({ ...draft, ai_facing_rubric: e.target.value || null })}
          />
          <label className="small muted">{c('setup.questions.cbc')}</label>
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
