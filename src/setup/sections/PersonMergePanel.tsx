import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/local'
import { mergePersons } from '../../db/people'
import { mergeCandidates, type MergeCandidate } from '../../lib/people'
import { countsForMerge } from '../counts'
import { useSetupSave } from '../useSetupSave'
import { c } from '../../lib/content/chrome'
import type { Person, Workshop } from '../../lib/types'

/**
 * The pairs the deployment cannot tell apart, and the one control that combines
 * them (tl-12).
 *
 * This is the surface that makes "other trainings in the same track" work for
 * anybody the automatic link cannot reach: somebody with no address on the older
 * roster, or a name spelled two ways. Everything about it is built so a wrong
 * merge is hard and a right one is quick.
 *
 * ## Why this one DOES route through `useSetupSave()` when the profile editor does not
 *
 * A merge classifies `destructive`, so the dialog fires and the change is logged
 * to `setup_change_log`. A profile edit classifies `safe`, so it would get neither
 * — see the header of PersonProfileEditor for that argument. This panel also lives
 * inside the Setup hub, where the provider exists; the editor deliberately does
 * not.
 *
 * ## Dismissals are per-device, on purpose
 *
 * "Not the same" is a judgement about two humans, and the honest place for it is a
 * table on the server. It is not worth a migration for a suggestion list: the cost
 * of forgetting is that a pair is offered again, which is mildly annoying, while
 * the cost of a shared dismissal getting the answer wrong is that nobody is ever
 * asked again. So the negative is remembered locally and the positive is
 * permanent, which is the safe asymmetry. The copy says so.
 */
const DISMISSED_KEY = 'cairn.person-merge.dismissed'

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

function saveDismissed(keys: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...keys]))
  } catch {
    /* private mode — the pair is simply offered again next time */
  }
}

const pairKey = (a: Person, b: Person) => [a.id, b.id].sort().join('::')

export function PersonMergePanel({ workshop }: { workshop: Workshop }) {
  const { request } = useSetupSave()
  const [dismissed, setDismissed] = useState(loadDismissed)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const [manualKeep, setManualKeep] = useState('')
  const [manualAbsorb, setManualAbsorb] = useState('')

  const data = useLiveQuery(async () => {
    const [people, participants] = await Promise.all([
      db.persons.toArray(),
      db.participants.toArray(),
    ])
    const workshopCount = new Map<string, number>()
    for (const p of participants) {
      if (!p.person_id) continue
      workshopCount.set(p.person_id, (workshopCount.get(p.person_id) ?? 0) + 1)
    }
    return {
      candidates: mergeCandidates(people),
      workshopCount,
      people: [...people].sort((a, b) => a.display_name.localeCompare(b.display_name)),
    }
  }, [])

  const candidates = (data?.candidates ?? []).filter((x) => !dismissed.has(pairKey(x.a, x.b)))

  const dismiss = (cand: MergeCandidate) => {
    const next = new Set(dismissed)
    next.add(pairKey(cand.a, cand.b))
    setDismissed(next)
    saveDismissed(next)
    setNotice({ tone: 'ok', text: c('setup.people.merge-dismissed') })
  }

  /**
   * `survivor` is whichever card the administrator clicked Keep on, so the two
   * directions are a real choice rather than an alphabetical accident. The counts
   * are gathered BEFORE the dialog, because the dialog's whole value is that its
   * numbers are real, and after the merge one of the two sides no longer exists.
   */
  const merge = async (survivor: Person, absorbed: Person) => {
    setBusy(true)
    setNotice(null)
    try {
      const counts = await countsForMerge(survivor.id, absorbed.id)
      await request({
        change: {
          entity: 'person_merge',
          operation: 'update',
          entityId: survivor.id,
          label: `${absorbed.display_name} → ${survivor.display_name}`,
          counts,
        },
        commit: async () => {
          const result = await mergePersons(survivor.id, absorbed.id)
          if (result.ok) {
            setNotice({
              tone: 'ok',
              text: c('setup.people.merged', 'label', {
                absorbed: result.summary.absorbedName || absorbed.display_name,
                survivor: result.summary.survivorName || survivor.display_name,
                participants: result.summary.movedParticipants,
                accounts: result.summary.movedAccounts,
              }),
            })
            return
          }
          if (result.reason === 'offline') {
            setNotice({ tone: 'error', text: c('setup.people.merge-offline') })
            return
          }
          setNotice({
            tone: 'error',
            text: result.slug
              ? // The slug maps to our own words. Rendering the server's prose
                // forever is what tl-02 built `raise_refusal`'s detail field to
                // avoid, and `toResult`'s matcher is a shape, so `tl12.*` is
                // labelled without anybody touching that regex.
                c(`refusal.${result.slug}`)
              : c('setup.people.merge-refused', 'label', { message: result.message }),
          })
        },
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card form-col">
      <h2>{c('setup.people.merge-title')}</h2>
      <p className="small muted">{c('setup.people.merge-help')}</p>

      {notice && (
        <p className={notice.tone === 'ok' ? 'small' : 'small error'} role="status">
          {notice.text}
        </p>
      )}

      {candidates.length === 0 ? (
        <p className="small muted">{c('setup.people.merge-none')}</p>
      ) : (
        candidates.map((cand) => {
          const key = pairKey(cand.a, cand.b)
          return (
            <div key={key} className="grid grid--split" style={{ alignItems: 'stretch' }}>
              <PersonCard
                person={cand.a}
                workshops={data?.workshopCount.get(cand.a.id) ?? 0}
                busy={busy}
                onKeep={() => void merge(cand.a, cand.b)}
              />
              <PersonCard
                person={cand.b}
                workshops={data?.workshopCount.get(cand.b.id) ?? 0}
                busy={busy}
                onKeep={() => void merge(cand.b, cand.a)}
              />
              <div className="form-col" style={{ gridColumn: '1 / -1' }}>
                <p className="small muted" style={{ margin: 0 }}>
                  {c(`setup.people.merge-basis.${cand.basis}`)}
                  {cand.confidence === 'certain' && ` — ${c('setup.people.merge-certain')}`}
                </p>
                <div className="row">
                  <button className="ghost btn--sm" disabled={busy} onClick={() => dismiss(cand)}>
                    {c('setup.people.merge-not-same')}
                  </button>
                </div>
              </div>
            </div>
          )
        })
      )}
      {/*
        The escape hatch, and it is not optional. Nothing is matched on a name
        unless it is nearly identical — one character apart at most, and never when
        the two hold different addresses — so a genuine duplicate spelled two very
        different ways will never be suggested. Without this, that pair could never
        be merged at all and "other trainings in the same track" would stay wrong
        for them forever. The suggestion list is a convenience; this is the feature.
      */}
      <h3 style={{ marginTop: 'var(--s-4)' }}>{c('setup.people.merge-manual-title')}</h3>
      <p className="small muted">{c('setup.people.merge-manual-help')}</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span>
          <label className="small muted" htmlFor="merge-keep">
            {c('setup.people.merge-manual-keep')}
          </label>
          <select id="merge-keep" value={manualKeep} onChange={(e) => setManualKeep(e.target.value)}>
            <option value="">—</option>
            {(data?.people ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name}
                {p.primary_email ? ` · ${p.primary_email}` : ''}
              </option>
            ))}
          </select>
        </span>
        <span>
          <label className="small muted" htmlFor="merge-absorb">
            {c('setup.people.merge-manual-absorb')}
          </label>
          <select
            id="merge-absorb"
            value={manualAbsorb}
            onChange={(e) => setManualAbsorb(e.target.value)}
          >
            <option value="">—</option>
            {(data?.people ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name}
                {p.primary_email ? ` · ${p.primary_email}` : ''}
              </option>
            ))}
          </select>
        </span>
        <button
          className="btn--sm"
          disabled={busy || !manualKeep || !manualAbsorb || manualKeep === manualAbsorb}
          onClick={() => {
            const keep = (data?.people ?? []).find((p) => p.id === manualKeep)
            const absorb = (data?.people ?? []).find((p) => p.id === manualAbsorb)
            if (!keep || !absorb) {
              setNotice({ tone: 'error', text: c('setup.people.merge-manual-pick') })
              return
            }
            void merge(keep, absorb)
          }}
        >
          {c('setup.people.merge-manual-go')}
        </button>
      </div>

      <p className="small muted">{workshop.name}</p>
    </div>
  )
}

function PersonCard({
  person,
  workshops,
  busy,
  onKeep,
}: {
  person: Person
  workshops: number
  busy: boolean
  onKeep: () => void
}) {
  return (
    <div className="card form-col" style={{ margin: 0 }}>
      <strong>{person.display_name}</strong>
      <span className="small muted">
        {person.primary_email ?? c('setup.people.merge-no-email')}
      </span>
      <span className="small muted">
        {c('setup.people.merge-appears-in', 'label', { workshops })}
      </span>
      <button className="btn--sm" disabled={busy} onClick={onKeep}>
        {c('setup.people.merge-keep')} — {c('setup.people.merge-go')}
      </button>
    </div>
  )
}
