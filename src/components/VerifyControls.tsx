import { useState } from 'react'
import { recordVerdict, clearVerdict } from '../db/verifications'
import { c } from '../lib/content/chrome'
import { Copy } from './Copy'
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
  // tl-20: the confirm acknowledges itself. On a list of thirty observations the
  // only feedback for a recorded verdict was the pill changing several lines away,
  // so a click that had registered looked like one that had missed. Cleared on
  // animationend rather than on a timer, so re-confirming re-animates and a
  // reduced-motion visitor (where the animation is a no-op) is not left with a
  // stuck class.
  const [popped, setPopped] = useState(false)
  const mineLabel =
    mine?.decision === 'confirm'
      ? c('verify.you-confirmed')
      : mine?.decision === 'adjust'
        ? c('verify.you-set', 'label', { level: mine.adjusted_designation ?? '' })
        : mine?.decision === 'reject'
          ? c('verify.you-rejected')
          : null

  return (
    <div className="small" style={{ marginTop: '0.35rem' }}>
      <span className={`pill ${STATUS_CLASS[obs.vstatus] ?? ''}`}>{obs.vstatus}</span>{' '}
      <span className="muted">{obs.confirmCount} confirm{obs.confirmCount === 1 ? '' : 's'}{obs.rejectCount ? `, ${obs.rejectCount} reject` : ''}</span>
      <div className="row" style={{ marginTop: '0.3rem', gap: '0.35rem' }}>
        <Copy
          id="verify.confirm"
          tokens={{ level: obs.evidence_designation }}
          as="button"
          className={`ghost small ${mine?.decision === 'confirm' ? 'primary' : ''} ${popped ? 'verify-pop' : ''}`}
          onClick={() => {
            setPopped(true)
            recordVerdict(obs, evaluatorEmail, 'confirm')
          }}
          onAnimationEnd={() => setPopped(false)}
        />
        <Copy id="verify.adjust" className="small muted" />
        {[0, 1, 2, 3].map((n) => (
          <button
            key={n}
            className={`ghost small ${mine?.decision === 'adjust' && mine.adjusted_designation === n ? 'primary' : ''}`}
            onClick={() => recordVerdict(obs, evaluatorEmail, 'adjust', { adjusted_designation: n as 0 | 1 | 2 | 3 })}
          >
            {n}
          </button>
        ))}
        <Copy
          id="verify.reject"
          as="button"
          className={`ghost small ${mine?.decision === 'reject' ? 'primary' : ''}`}
          onClick={() => recordVerdict(obs, evaluatorEmail, 'reject')}
        />
        {mine && (
          <Copy
            id="verify.clear"
            tokens={{ what: mineLabel ?? '' }}
            as="button"
            className="ghost small muted"
            onClick={() => clearVerdict(obs.id, evaluatorEmail)}
          />
        )}
      </div>
    </div>
  )
}
