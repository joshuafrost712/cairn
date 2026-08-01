import { Copy } from '../../components/Copy'
import { Reveal } from './Reveal'

/**
 * What the technology does, and what it does not.
 *
 * Every claim here is lifted from `docs/ai-transparency.md`, which is written for
 * the two audiences that actually carry the risk: the participants being evaluated
 * and the organizations deciding whether to send them. Four points, from that
 * document's own pros list.
 *
 * What this section deliberately does NOT say: anything about the tool having been
 * tested and vetted. `docs/ai-transparency.md:102-105` forbids that claim in
 * public copy until a vetting record exists, and this page is public and doubles
 * as the pitch link. When the record exists, the claim can be added here; not
 * before.
 */
const POINTS = [1, 2, 3, 4]

export function Trust() {
  return (
    <section className="wel-scene wel-trust">
      <div className="wel-scene__inner wel-scene__inner--stacked">
        <Reveal className="wel-scene__copy wel-scene__copy--centered">
          <Copy id="welcome.trust.eyebrow" as="p" className="wel-eyebrow" />
          <Copy
            id="welcome.trust.title"
            as="h2"
            className="wel-scene__title"
            data-wel-heading="welcome.trust"
          />
          <Copy id="welcome.trust.body" as="p" className="wel-scene__body" />
        </Reveal>
        <Reveal className="wel-trust__grid" delay={0.08}>
          {POINTS.map((n) => (
            <div className="wel-trust__point" key={n}>
              <Copy id={`welcome.trust.point-${n}.title`} as="h3" className="wel-trust__title" />
              <Copy id={`welcome.trust.point-${n}`} as="p" className="wel-trust__body" />
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  )
}
