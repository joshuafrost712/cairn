/**
 * An evaluator, as one initialed circle.
 *
 * Every tour scene that shows people uses this, so "three evaluators" is
 * visually the same three people from the problem scene through the contrast
 * scene. That continuity is the whole reason the primitives are shared rather
 * than drawn per scene.
 *
 * SVG only: the scenes are single inline SVGs with a fixed viewBox, which is what
 * lets a flow path and the node it starts from share one coordinate space and
 * still scale down to a 390px phone without a media query.
 */
export interface EvaluatorDotProps {
  x: number
  y: number
  /** Two letters. Comes from chrome.json, never inlined here. */
  initials: string
  r?: number
}

export function EvaluatorDot({ x, y, initials, r = 17 }: EvaluatorDotProps) {
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill="var(--d2)" />
      <text
        x={x}
        y={y}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={13}
        fontWeight={600}
        fill="var(--d2-ink)"
      >
        {initials}
      </text>
    </g>
  )
}