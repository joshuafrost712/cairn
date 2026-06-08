import { recordVerdict, clearVerdict } from '../db/verifications'
import type { AnnotatedObservation } from '../reports/verification'

const STATUS_CLASS: Record<string, string> = {
  pending: 'local',
  verified: 'synced',
  adjusted: 'synced',
  disputed: 'error',
}

// Per-observation verification controls: the signed-in evaluator records one
// verdict (confirm / adjust to a different 0–3 / reject). Re-clicking overwrites
// their prior verdict; "clear" removes it.
export function VerifyControls({ obs, evaluatorEmail }: { obs: AnnotatedObservation; evaluatorEmail: string }) {
  const mine = obs.verdicts.find((v) => v.evaluator_email === evaluatorEmail)
  const mineLabel =
    mine?.decision === 'confirm'
      ? 'you confirmed'
      : mine?.decision === 'adjust'
        ? `you set ${mine.adjusted_designation}/3`
        : mine?.decision === 'reject'
          ? 'you rejected'
          : null

  return (
    <div className="small" style={{ marginTop: '0.35rem' }}>
      <span className={`pill ${STATUS_CLASS[obs.vstatus] ?? ''}`}>{obs.vstatus}</span>{' '}
      <span className="muted">{obs.confirmCount} confirm{obs.confirmCount === 1 ? '' : 's'}{obs.rejectCount ? `, ${obs.rejectCount} reject` : ''}</span>
      <div className="row" style={{ marginTop: '0.3rem', gap: '0.35rem' }}>
        <button
          className={`ghost small ${mine?.decision === 'confirm' ? 'primary' : ''}`}
          onClick={() => recordVerdict(obs, evaluatorEmail, 'confirm')}
        >
          Confirm {obs.evidence_designation}/3
        </button>
        <span className="small muted">adjust:</span>
        {[0, 1, 2, 3].map((n) => (
          <button
            key={n}
            className={`ghost small ${mine?.decision === 'adjust' && mine.adjusted_designation === n ? 'primary' : ''}`}
            onClick={() => recordVerdict(obs, evaluatorEmail, 'adjust', { adjusted_designation: n as 0 | 1 | 2 | 3 })}
          >
            {n}
          </button>
        ))}
        <button
          className={`ghost small ${mine?.decision === 'reject' ? 'primary' : ''}`}
          onClick={() => recordVerdict(obs, evaluatorEmail, 'reject')}
        >
          Reject
        </button>
        {mine && (
          <button className="ghost small muted" onClick={() => clearVerdict(obs.id, evaluatorEmail)}>
            clear ({mineLabel})
          </button>
        )}
      </div>
    </div>
  )
}
