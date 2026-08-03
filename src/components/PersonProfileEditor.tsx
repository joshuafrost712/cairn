import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { deletePersonProfile, exportPerson, upsertPersonProfile } from '../db/people'
import { blankProfile, cleanList, cleanTrainings } from '../lib/people'
import { c } from '../lib/content/chrome'
import type { PersonProfile, PriorTraining, ProfileVisibility } from '../lib/types'

/**
 * Authoring one person's background (tl-12).
 *
 * ## Why this does not use `useSetupSave()`
 *
 * Every OTHER write in Setup routes through that hook, and this one deliberately
 * does not. Two reasons, and the second is the load-bearing one.
 *
 * The classifier calls a profile edit `safe`, so no dialog would ever fire. And
 * `setup/log.ts` skips `safe` changes outright, so no log entry would be written
 * either — meaning the hook would add nothing at all here. Against that, the hook
 * THROWS outside `<SetupSaveProvider>`, and this editor opens from the capture
 * screen and from the participant and evaluator detail pages, none of which are
 * inside the Setup hub. Wiring it up would have converted "no benefit" into "the
 * drawer crashes when an evaluator edits their own profile".
 *
 * The write still goes through the app's own offline-first path
 * (`upsertPersonProfile` → reference outbox), which is the part of the rule that
 * actually protects anything.
 *
 * The MERGE is the opposite case — `destructive`, dialog and log both wanted — and
 * it lives in Setup, where the provider exists. See `PersonMergePanel`.
 */
export function PersonProfileEditor({
  personId,
  name,
  profile,
  onDone,
}: {
  personId: string
  name: string
  profile: PersonProfile | null
  onDone: () => void
}) {
  const { identity } = useAuth()
  const start = profile ?? blankProfile(personId)

  const [headline, setHeadline] = useState(start.headline ?? '')
  const [certifications, setCertifications] = useState(start.certifications.join('\n'))
  const [education, setEducation] = useState(start.education.join('\n'))
  const [experience, setExperience] = useState(start.experience_areas.join('\n'))
  const [languages, setLanguages] = useState(start.languages.join('\n'))
  const [trainings, setTrainings] = useState(start.prior_trainings.map(renderTraining).join('\n'))
  const [notes, setNotes] = useState(start.notes ?? '')
  const [visibility, setVisibility] = useState<ProfileVisibility>(start.visibility)
  const [busy, setBusy] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      await upsertPersonProfile({
        person_id: personId,
        headline: headline.trim() || null,
        certifications: cleanList(lines(certifications)),
        education: cleanList(lines(education)),
        experience_areas: cleanList(lines(experience)),
        languages: cleanList(lines(languages)),
        prior_trainings: cleanTrainings(lines(trainings).map(parseTraining)),
        notes: notes.trim() || null,
        visibility,
        updated_by: identity?.email ?? null,
      })
      onDone()
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await deletePersonProfile(personId)
      onDone()
    } finally {
      setBusy(false)
    }
  }

  const download = async () => {
    const data = await exportPerson(personId)
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `profile-${name.replace(/[^\w-]+/g, '-').toLowerCase()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (confirmingDelete) {
    return (
      <div className="form-col">
        <h3 style={{ margin: 0 }}>{c('profile.delete-confirm', 'label', { name })}</h3>
        {/* The classifier calls this `safe` and it is: no evidence is touched. What
            this paragraph corrects is a MISREADING, which is not a severity — a
            control labelled "Delete" beside somebody's name reads as deleting them. */}
        <p className="small">{c('profile.delete-scope', 'label', { name })}</p>
        <div className="row">
          <button className="danger-quiet" disabled={busy} onClick={() => void remove()}>
            {c('profile.delete-go')}
          </button>
          <button className="ghost" disabled={busy} onClick={() => setConfirmingDelete(false)}>
            {c('profile.cancel')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="form-col">
      <label className="small muted" htmlFor="pp-headline">
        {c('profile.headline')}
      </label>
      <input
        id="pp-headline"
        value={headline}
        onChange={(e) => setHeadline(e.target.value)}
        placeholder="Translation consultant-in-training, Eastern Indonesia"
      />

      <ListField
        id="pp-trainings"
        label={c('profile.trainings')}
        help={c('profile.trainings-help')}
        value={trainings}
        onChange={setTrainings}
      />
      <ListField
        id="pp-experience"
        label={c('profile.experience-areas')}
        help={c('profile.list-help')}
        value={experience}
        onChange={setExperience}
      />
      <ListField
        id="pp-certifications"
        label={c('profile.certifications')}
        help={c('profile.list-help')}
        value={certifications}
        onChange={setCertifications}
      />
      <ListField
        id="pp-education"
        label={c('profile.education')}
        help={c('profile.list-help')}
        value={education}
        onChange={setEducation}
      />
      <ListField
        id="pp-languages"
        label={c('profile.languages')}
        help={c('profile.list-help')}
        value={languages}
        onChange={setLanguages}
      />

      <label className="small muted" htmlFor="pp-notes">
        {c('profile.notes')}
      </label>
      <textarea id="pp-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />

      <label className="small muted" htmlFor="pp-visibility">
        {c('profile.visibility')}
      </label>
      <select
        id="pp-visibility"
        value={visibility}
        onChange={(e) => setVisibility(e.target.value as ProfileVisibility)}
      >
        <option value="workshop">{c('profile.visibility.workshop')}</option>
        <option value="admins">{c('profile.visibility.admins')}</option>
        <option value="private">{c('profile.visibility.private')}</option>
      </select>
      <p className="small muted">{c('profile.visibility-help')}</p>

      <div className="row">
        <button disabled={busy} onClick={() => void save()}>
          {c('profile.save')}
        </button>
        <button className="ghost" disabled={busy} onClick={onDone}>
          {c('profile.cancel')}
        </button>
        <span className="spacer" />
        <button className="ghost btn--sm" disabled={busy} onClick={() => void download()}>
          {c('profile.export')}
        </button>
        {profile && (
          <button
            className="danger-quiet btn--sm"
            disabled={busy}
            onClick={() => setConfirmingDelete(true)}
          >
            {c('profile.delete')}
          </button>
        )}
      </div>
    </div>
  )
}

function ListField({
  id,
  label,
  help,
  value,
  onChange,
}: {
  id: string
  label: string
  help: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <>
      <label className="small muted" htmlFor={id}>
        {label}
      </label>
      <textarea id={id} rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
      <p className="small muted" style={{ marginTop: 'calc(var(--s-1) * -1)' }}>
        {help}
      </p>
    </>
  )
}

const lines = (v: string): string[] => v.split('\n')

/**
 * "Epistles workshop, 2025" and "Epistles workshop 2025" both parse; anything else
 * is all label.
 *
 * Lenient on purpose. The year is a sort key and a nicety, and a strict parser here
 * would reject somebody's real training because they typed a range or a season.
 */
function parseTraining(line: string): PriorTraining {
  const trimmed = line.trim()
  const m = /^(.*?)[,\s]+((?:19|20)\d{2})$/.exec(trimmed)
  if (m && m[1].trim()) return { label: m[1].trim(), year: m[2] }
  return { label: trimmed, year: null }
}

const renderTraining = (t: PriorTraining): string => (t.year ? `${t.label}, ${t.year}` : t.label)
