import { Link } from 'react-router-dom'
import type { KsaRollup } from '../../reports/build'
import type { AnnotatedObservation } from '../../reports/verification'
import { Drawer } from '../data/Drawer'
import { DesignationChip } from '../data/DesignationChip'
import { EvidenceList } from './EvidenceList'
import { derivationNote } from '../../reports/segments'
import { useScale } from '../../hooks/useScale'

export interface CellSelection {
  participantId: string
  participantName: string
  ksaCode: string
  ksaLabel: string
  rollup: KsaRollup<AnnotatedObservation> | null
}

export function CellDrawer({
  selection,
  onClose,
}: {
  selection: CellSelection | null
  onClose: () => void
}) {
  // The ACTIVE workshop's scale, which is the right one here: this drawer opens over
  // the heatmap of the workshop the operator is looking at. A generator producing
  // documents for a workshop it is not switched into passes its own (tl-29).
  const scale = useScale()
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
        <span className="small muted">{rollup ? derivationNote(rollup, scale) : 'No data for this cell.'}</span>
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
