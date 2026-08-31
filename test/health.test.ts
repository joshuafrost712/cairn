import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { CHIEF_ROLES } from '../src/layout/roles'
import { mayFallBackToCache } from '../src/db/health'
import {
  rankCoverageGaps,
  silentDevices,
  briefingActions,
  type HealthCoverageRow,
  type HealthDelivery,
  type WorkshopHealth,
} from '../src/reports/health'
import snapshot from './fixtures/health-snapshot.json'

const health = snapshot as unknown as WorkshopHealth

/** 2026-08-31T02:00Z, the fixture's own generation time. */
const NOW = Date.parse('2026-08-31T02:00:00+00:00')

function row(over: Partial<HealthCoverageRow> = {}): HealthCoverageRow {
  return { participant_id: 'p', name: 'Someone', team: null, routed: 0, pending: 0, ...over }
}

function delivery(over: Partial<HealthDelivery> = {}): HealthDelivery {
  return { evaluator_email: 'a@example.org', last_at: '2026-08-31T01:00:00+00:00', ...over }
}

describe('mayFallBackToCache', () => {
  it('lets an offline read show the saved copy, which is the state the cache exists for', () => {
    expect(mayFallBackToCache({ ok: false, reason: 'offline', message: '' })).toBe(true)
  })

  it('lets an unexplained error show the saved copy too', () => {
    expect(mayFallBackToCache({ ok: false, reason: 'error', message: 'boom' })).toBe(true)
  })

  it('REFUSES to show a saved copy after the server refused', () => {
    // The blocking finding this rule was extracted for. A device caches its own
    // memberships, so a demoted chief still passes the client route gate while the
    // RPC, which is the live truth, raises. Falling back would show them the last
    // report they were entitled to, undated, and let them copy it to a clipboard.
    expect(mayFallBackToCache({ ok: false, reason: 'refused', message: 'tl38.not_permitted' })).toBe(
      false,
    )
  })

  it('does not reach for the cache at all when the read succeeded', () => {
    expect(
      mayFallBackToCache({ ok: true, data: health, fetchedAt: '2026-08-31T02:00:00.000Z' }),
    ).toBe(false)
  })
})

describe('the role list the server enforces', () => {
  it('is the same set as CHIEF_ROLES, which is what the nav and the route gate use', () => {
    // `workshop_health` is `security definer`, so the array inside the migration IS
    // the authorization. Nothing else ties it to the TypeScript set: the wire
    // harness drives fixed accounts and never reads CHIEF_ROLES, so widening the
    // SQL (adding `consultant`, say) would leave the nav hiding a page the server
    // now answers, and no test would fail. The dangerous direction is the silent
    // one, so it is the one pinned here.
    const sql = readFileSync('supabase/migrations/20260821000100_workshop_health.sql', 'utf8')
    const match = sql.match(/has_workshop_role\(\s*_workshop_id\s*,\s*array\[([^\]]+)\]/)
    expect(match).not.toBeNull()
    const roles = match![1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .sort()
    expect(roles).toEqual([...CHIEF_ROLES].sort())
  })
})

describe('rankCoverageGaps', () => {
  it('puts the worst-covered participant first', () => {
    const ranked = rankCoverageGaps(health.coverage.participants)
    expect(ranked.map((g) => g.row.name)).toEqual([
      'Ada Lovelace',
      'Cleber Santos',
      'Esi Mensah',
      'Dara Okoye',
      'Bijili Kuppackal',
    ])
  })

  it('counts pending mentions toward coverage, so a routing backlog is not an unwatched person', () => {
    const ranked = rankCoverageGaps(health.coverage.participants)
    const bijili = ranked.find((g) => g.row.name === 'Bijili Kuppackal')
    // One routed observation and six mentions still in the queue. The heatmap
    // showing routed alone is what made a real person look unobserved.
    expect(bijili?.total).toBe(7)
    expect(bijili?.unseen).toBe(false)
  })

  it('separates a true zero from thin-but-pending', () => {
    const ranked = rankCoverageGaps(health.coverage.participants)
    expect(ranked.filter((g) => g.unseen).map((g) => g.row.name)).toEqual([
      'Ada Lovelace',
      'Cleber Santos',
    ])
    // Esi has nothing routed and one mention pending, which is not the same thing.
    expect(ranked.find((g) => g.row.name === 'Esi Mensah')?.unseen).toBe(false)
  })

  it('breaks a tie on name so the order does not move between renders', () => {
    const ranked = rankCoverageGaps([
      row({ participant_id: 'z', name: 'Zoe' }),
      row({ participant_id: 'a', name: 'Amos' }),
    ])
    expect(ranked.map((g) => g.row.name)).toEqual(['Amos', 'Zoe'])
  })

  it('returns nothing for an empty roster rather than throwing', () => {
    expect(rankCoverageGaps([])).toEqual([])
  })
})

describe('silentDevices', () => {
  it('reports a device past the threshold and not one inside it', () => {
    const silent = silentDevices(health.pipeline.last_delivery, NOW, 24)
    expect(silent.map((s) => s.evaluator_email)).toEqual([
      'cara@example.org',
      'ben@example.org',
    ])
  })

  it('is exclusive at the boundary, so exactly 24h old is not yet silent', () => {
    const exactly = delivery({ last_at: new Date(NOW - 24 * 3600 * 1000).toISOString() })
    expect(silentDevices([exactly], NOW, 24)).toEqual([])
    const oneSecondMore = delivery({ last_at: new Date(NOW - 24 * 3600 * 1000 - 1000).toISOString() })
    expect(silentDevices([oneSecondMore], NOW, 24)).toHaveLength(1)
  })

  it('widens with the threshold, which is what the payload carries it for', () => {
    expect(silentDevices(health.pipeline.last_delivery, NOW, 24)).toHaveLength(2)
    expect(silentDevices(health.pipeline.last_delivery, NOW, 72)).toHaveLength(1)
    expect(silentDevices(health.pipeline.last_delivery, NOW, 500)).toHaveLength(0)
  })

  it('drops an unparseable timestamp instead of calling that device silent forever', () => {
    // NaN comparisons are false, but a bare `now - NaN > cutoff` would be too, so
    // the guard is explicit rather than incidental.
    expect(silentDevices([delivery({ last_at: 'not a date' })], NOW, 24)).toEqual([])
  })

  it('sorts oldest first, because that is the device to chase', () => {
    const silent = silentDevices(health.pipeline.last_delivery, NOW, 24)
    expect(silent[0].last_at < silent[1].last_at).toBe(true)
  })
})

describe('briefingActions', () => {
  it('orders smallest job first', () => {
    const actions = briefingActions(health, NOW)
    const counts = actions.map((a) => a.count)
    expect([...counts].sort((a, b) => a - b)).toEqual(counts)
  })

  it('names every live action and no dead one', () => {
    const actions = briefingActions(health, NOW)
    expect(actions.map((a) => a.kind).sort()).toEqual([
      'name-variants',
      'route-queue',
      'silent-devices',
      'unseen-participants',
      'unsubmitted-drafts',
      'unverified',
    ])
  })

  it('drops an action whose count is zero rather than showing a reassuring zero', () => {
    const clean: WorkshopHealth = {
      ...health,
      volume: { ...health.volume, observations: 4, verdicts: 4 },
      pipeline: {
        ...health.pipeline,
        queue: { count: 0, oldest_created_at: null, by_evaluator: [] },
        drafts_with_content: [],
        last_delivery: [delivery()],
      },
      coverage: {
        participants: [row({ participant_id: 'p', name: 'Watched', routed: 3 })],
        unattributed_observations: 0,
        unresolved_scope_names: [],
      },
    }
    expect(briefingActions(clean, NOW)).toEqual([])
  })

  it('computes unverified as observations minus verdicts, floored at zero', () => {
    const actions = briefingActions(health, NOW)
    expect(actions.find((a) => a.kind === 'unverified')?.count).toBe(10)

    const over: WorkshopHealth = {
      ...health,
      volume: { ...health.volume, observations: 2, verdicts: 5 },
    }
    // More verdicts than observations should never happen, and if it does the
    // briefing must not render a negative worklist entry.
    expect(over.volume.observations - over.volume.verdicts).toBeLessThan(0)
    expect(briefingActions(over, NOW).find((a) => a.kind === 'unverified')).toBeUndefined()
  })

  it('uses the payload threshold for silence rather than a hard-coded day', () => {
    const wide: WorkshopHealth = { ...health, stale_hours: 500 }
    expect(briefingActions(wide, NOW).find((a) => a.kind === 'silent-devices')).toBeUndefined()
  })

  it('carries the detail the reader needs to act, and links where there is a surface', () => {
    const actions = briefingActions(health, NOW)
    const unseen = actions.find((a) => a.kind === 'unseen-participants')
    expect(unseen?.detail).toEqual(['Ada Lovelace', 'Cleber Santos'])
    expect(unseen?.to).toBe('/admin/workshop')
    expect(actions.find((a) => a.kind === 'route-queue')?.to).toBe('/admin/routing')
    // Unsubmitted drafts have no surface an administrator can act on, so the
    // action names the evaluator and offers no link rather than a dead one.
    expect(actions.find((a) => a.kind === 'unsubmitted-drafts')?.to).toBeUndefined()
  })
})
