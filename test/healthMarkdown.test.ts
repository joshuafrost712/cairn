import { describe, it, expect } from 'vitest'
import { renderHealthMarkdown, type WorkshopHealth } from '../src/reports/health'
import snapshot from './fixtures/health-snapshot.json'

const health = snapshot as unknown as WorkshopHealth
const NOW = Date.parse('2026-08-31T02:00:00+00:00')

/**
 * The markdown is a contract with the vault: Joshua pastes it into notes. Section
 * order and headings are therefore asserted rather than left to drift, in the same
 * way tl-31 treats article ids. Additive changes are free; a rename is not.
 */
describe('renderHealthMarkdown', () => {
  const md = renderHealthMarkdown(health, NOW)

  it('obeys the vault formatting rules it will be pasted into', () => {
    expect(md.split('\n').filter((l) => l.trim() === '---')).toEqual([])
    // The workshop's own name is quoted verbatim and may legitimately carry one;
    // the prose this renderer authors may not.
    const authored = md.split(health.workshop!.name).join('')
    expect(authored).not.toContain('—')
  })

  it('keeps its headings and their order', () => {
    expect(md.split('\n').filter((l) => l.startsWith('#'))).toEqual([
      '# Workshop briefing: Test Workshop',
      '## Volume',
      '## Pipeline',
      '## Coverage by goal (routed only)',
      '## Coverage by participant (routed + pending-in-queue)',
    ])
  })

  it('states the volume line with the mean at two decimal places', () => {
    // Postgres renders 1.8 where the health script renders 1.80, and the parity
    // harness caught the two disagreeing about a number they had both computed
    // right. Formatting belongs here, once.
    expect(md).toContain(
      '40 captures from 3 evaluators; 12 routed observations across 4 people. Mean evidence 1.80',
    )
  })

  it('labels an unflagged sentiment rather than printing the word null', () => {
    expect(md).toContain('(sentiment: 6 strong, 4 weak, 2 unflagged)')
  })

  it('reports the routing queue with its oldest day and its owners', () => {
    expect(md).toContain(
      '- Routing queue (attested, has content, no observations yet): **7**. Oldest 2026-08-24; by evaluator: ana 5, ben 2',
    )
  })

  it('distinguishes a prose draft from a ratings-only one', () => {
    expect(md).toContain('**2**. ana (08-25, text), cara (08-26, ratings_only)')
  })

  it('names the silent devices against the payload threshold', () => {
    expect(md).toContain('- Evaluator devices silent over 24h (last delivery): cara 2026-08-25T01:00, ben 2026-08-29T01:00')
  })

  it('renders the participant table worst-covered first', () => {
    const rows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Participant'))
    expect(rows[0]).toBe('| Ada Lovelace | Alpha | 0 | 0 | **0** |')
    expect(rows[rows.length - 1]).toBe('| Bijili Kuppackal | Beta | 1 | 6 | **7** |')
    expect(rows).toHaveLength(5)
  })

  it('writes an empty team cell rather than the word null', () => {
    expect(md).toContain('| Esi Mensah |  | 0 | 1 | **1** |')
  })

  it('calls out the participants nobody has watched at all', () => {
    expect(md).toContain('**No evidence at all (routed or pending): Ada Lovelace, Cleber Santos.**')
  })

  it('reports off-roster names and unattributed observations', () => {
    expect(md).toContain('1 observations are attributed to names not on the roster')
    expect(md).toContain('Scope names matching no roster row: Keem Leong, Irene.')
  })

  it('omits the optional lines entirely when they would be zero', () => {
    const clean: WorkshopHealth = {
      ...health,
      pipeline: {
        ...health.pipeline,
        queue: { count: 0, oldest_created_at: null, by_evaluator: [] },
        drafts_with_content: [],
        last_delivery: [{ evaluator_email: 'a@example.org', last_at: '2026-08-31T01:00:00+00:00' }],
      },
      coverage: {
        participants: [
          { participant_id: 'p', name: 'Watched', team: 'A', routed: 2, pending: 0 },
        ],
        unattributed_observations: 0,
        unresolved_scope_names: [],
      },
    }
    const out = renderHealthMarkdown(clean, NOW)
    expect(out).not.toContain('No evidence at all')
    expect(out).not.toContain('Evaluator devices silent')
    expect(out).not.toContain('Scope names matching no roster row')
    expect(out).toContain('- Routing queue (attested, has content, no observations yet): **0**')
  })

  it('survives a workshop the payload could not name', () => {
    const anon: WorkshopHealth = { ...health, workshop: null }
    const out = renderHealthMarkdown(anon, NOW)
    expect(out.split('\n')[0]).toBe('# Workshop briefing: unknown workshop')
    expect(out).toContain('Workshop ? to ?.')
  })

  it('prints n/a rather than NaN when nothing has been designated yet', () => {
    const empty: WorkshopHealth = {
      ...health,
      volume: { ...health.volume, mean_evidence: null },
    }
    expect(renderHealthMarkdown(empty, NOW)).toContain('Mean evidence n/a')
  })
})
