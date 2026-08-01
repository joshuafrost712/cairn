import { useEffect, useState } from 'react'

/**
 * Count from zero to `to` once, on a rAF ramp.
 *
 * Returns `to` outright whenever `run` is false, which covers both of the cases
 * that matter: the block has not been scrolled to yet, and the visitor asked for
 * reduced motion. A counter stuck at 0 because its trigger never fired would be a
 * false statement on the page, not merely a missing animation — hence the value is
 * DERIVED from `run` rather than seeded into state by the effect.
 *
 * That derivation is also what keeps this out of react-hooks/set-state-in-effect:
 * the only setState here happens inside the requestAnimationFrame callback, never
 * synchronously in the effect body.
 */
export function useCountUp(
  to: number,
  { run, durationMs = 900, delayMs = 0 }: { run: boolean; durationMs?: number; delayMs?: number },
) {
  const [n, setN] = useState(0)

  useEffect(() => {
    if (!run) return
    let raf = 0
    let start = 0
    const tick = (t: number) => {
      if (!start) start = t
      const p = Math.min(1, Math.max(0, (t - start - delayMs) / durationMs))
      setN(Math.round(to * p))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [to, run, durationMs, delayMs])

  return run ? n : to
}
