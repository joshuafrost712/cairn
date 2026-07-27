import { Link } from 'react-router-dom'
import type { KsaRollup } from '../../reports/build'
import type { AnnotatedObservation } from '../../reports/verification'
import { Drawer } from '../data/Drawer'
import { DesignationChip } from '../data/DesignationChip'
import { EvidenceList } from './EvidenceList'

export interface CellSelection {
  participantId: string
  participantName: string
  ksaCode: string
  ksaLabel: string
  rollup: KsaRollup<AnnotatedObservation> | null
}

/**
 * The derivation rule for a representative designation, stated deterministically.
 *
 * Without this line the drawer shows four observations under a "3/3" and leaves
 * the reader to guess how one became the other. The rule is known exactly
 * (build.ts takes the max of the counting designations), so it is computed and
 * printed, not inferred and not explained by a model.
 */
function derivation(r: KsaRollup<AnnotatedObservation>): string {
  if (r.representative === null) {
    return r.toVerify.length
      ? `No counting evidence yet: ${r.toVerify.length} observation${r.toVerify.length === 1 ? ' is' : 's are'} still set aside.`
      : 'No evidence captured for this area yet.'
  }
  const parts = [
    `${r.representative}/3 is the highest of ${r.designations.length} counting designation${r.designations.length === 1 ? '' : 's'} (${r.designations.join(', ')}).`,
  ]
  if (r.toVerify.length) {
    parts.push(`${r.toVerify.length} set aside pending review.`)
  }
  if (r.conflict) {
    parts.push('Evaluators differ by 2 or more, so this is flagged for reconciliation.')
  }
  return parts.join(' ')
}

export function CellDrawer({
  selection,
  onClose,
}: {
  selection: CellSelection | null
  onClose: () => void
}) {
  if (!selection) return null
  const { rollup } = selection

  return (
    <Drawer
      open
      onClose={onClose}
      title={`${selection.participantName} · ${selection.ksaLabel}`}
      side="right"
    >
      <div className="row" style={{ marginBottom: 'var(--s-3)' }}>
        <DesignationChip
          value={rollup?.representative ?? null}
          conflict={rollup?.conflict ?? false}
        />
        <span className="small muted">{rollup ? derivation(rollup) : 'No data for this cell.'}</span>
      </div>

      <EvidenceList observations={rollup?.contributing ?? []} />

      {rollup && rollup.toVerify.length > 0 && (
        <>
          <h2 style={{ marginTop: 'var(--s-5)' }}>Set aside</h2>
          <p className="muted small">
            These do not count toward the designation above until they are verified.
          </p>
          <EvidenceList observations={rollup.toVerify} />
        </>
      )}

      <p className="small" style={{ marginTop: 'var(--s-4)' }}>
        <Link to={`/admin/participants/${selection.participantId}`}>
          open {selection.participantName}’s full record →
        </Link>
      </p>
    </Drawer>
  )
}
