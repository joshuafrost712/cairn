import { describe, it, expect } from 'vitest'
import { capturesToAdopt, captureRecordFromRow, type RemoteCaptureRow } from '../src/db/sync'
import { myCaptures } from '../src/db/evaluations'
import { shouldClearRoutingToken, DEFAULT_ROUTING_MODE } from '../src/routing/config'
import { NAV_GROUPS } from '../src/layout/navItems'
import { ADMIN_ROLES } from '../src/layout/roles'
import chrome from '../src/content/chrome.json'
import type { EvaluationRecord } from '../src/lib/types'

/**
 * tl-03's decisions, isolated from their IO.
 *
 * The gate itself is verified in the browser (scripts/tl03-evaluator-surface.mjs),
 * because a route guard cannot be proved by the module that declares it. What is
 * testable here is everything that fails SILENTLY: a pulled capture written over
 * an administrator's own unsent draft, an already-routed capture offered for
 * routing a second time, a colleague's work listed as "my evaluations", a
 * credential left behind on a demoted device, and a piece of backend vocabulary
 * left in a string an evaluator can read.
 */

const row = (over: Partial<RemoteCaptureRow> = {}): RemoteCaptureRow =>
  ({
    client_id: 'cap-1',
    evaluator_email: 'ev@example.org',
    activity_id: 'act-1',
    workshop_id: 'ws-1',
    source_language: 'en',
    answers: { k1: 'said something' },
    quick_ratings: {},
    focus_participant_id: null,
    source_text: 'said something',
    participant_scope: [],
    attestation: true,
    ruleset_version: 'v1',
    edit_history: [],
    created_at: '2026-07-30T08:00:00.000Z',
    updated_at: '2026-07-30T08:00:00.000Z',
    ...over,
  }) as RemoteCaptureRow

describe('capturesToAdopt', () => {
  it('adopts a capture this device has never seen', () => {
    expect(capturesToAdopt([row()], new Map()).map((r) => r.client_id)).toEqual(['cap-1'])
  })

  it('adopts over a local copy that has already synced', () => {
    // The server is authoritative once the row has been sent: another evaluator
    // may legitimately have corrected it since.
    const local = new Map([['cap-1', 'synced' as string | undefined]])
    expect(capturesToAdopt([row()], local)).toHaveLength(1)
  })

  it('refuses to overwrite the administrator’s own unsent work', () => {
    // The whole reason this is a pure function. A clobbered row still renders —
    // just with the server's older text in it, and no error anywhere.
    for (const status of ['local', 'queued', 'error']) {
      const local = new Map([['cap-1', status as string | undefined]])
      expect(capturesToAdopt([row()], local)).toEqual([])
    }
  })
})

describe('captureRecordFromRow', () => {
  it('marks a pulled capture synced and carries the server id', () => {
    const rec = captureRecordFromRow(row({ id: 'srv-9' }))
    expect(rec.sync_status).toBe('synced')
    expect(rec.server_id).toBe('srv-9')
    expect(rec.sync_error).toBeNull()
  })

  it('leaves routing_status unset, because the server never had one', () => {
    // routing_status lives only in Dexie (toRow never sends it). Inventing a
    // value here is what would make an already-routed capture look pending, or a
    // pending one look done; markRoutedFromObservations decides it from the
    // observations that actually exist.
    expect(captureRecordFromRow(row()).routing_status).toBeUndefined()
  })

  it('carries a local routing_status forward, or the pull causes double-routing', () => {
    // The failure: an administrator routes a capture, its observations have not
    // pushed yet, the next pull overwrites the row, the capture looks pending
    // again, and routing it a second time produces a second set of observations
    // for evidence that has already been verified. Nothing on screen says so.
    expect(captureRecordFromRow(row(), 'routed').routing_status).toBe('routed')
    expect(captureRecordFromRow(row(), 'sent').routing_status).toBe('sent')
  })
})

describe('myCaptures', () => {
  const rec = (over: Partial<EvaluationRecord>): EvaluationRecord =>
    ({ ...captureRecordFromRow(row()), ...over }) as EvaluationRecord

  it('keeps my own, case- and space-insensitively', () => {
    const rows = [rec({ client_id: 'a', evaluator_email: '  Josh@SIL.org ' })]
    expect(myCaptures(rows, 'josh@sil.org').map((r) => r.client_id)).toEqual(['a'])
  })

  it('drops a colleague’s capture pulled down for routing', () => {
    // The failure this prevents: an administrator opens "My evaluations" and is
    // offered the capture editor on somebody else's submitted work.
    const rows = [rec({ client_id: 'b', evaluator_email: 'other@example.org', server_id: 'srv-1' })]
    expect(myCaptures(rows, 'josh@sil.org')).toEqual([])
  })

  it('keeps an unattributed draft that has never left this device', () => {
    const rows = [rec({ client_id: 'c', evaluator_email: null, server_id: undefined })]
    expect(myCaptures(rows, 'josh@sil.org').map((r) => r.client_id)).toEqual(['c'])
  })

  it('drops an unattributed row that came from the server', () => {
    const rows = [rec({ client_id: 'd', evaluator_email: null, server_id: 'srv-2' })]
    expect(myCaptures(rows, 'josh@sil.org')).toEqual([])
  })
})

describe('shouldClearRoutingToken', () => {
  it('clears a token held by somebody who administers nothing', () => {
    expect(shouldClearRoutingToken(false, true)).toBe(true)
  })

  it('leaves an administrator’s token alone', () => {
    // Asked of every membership, not the active one: an admin of Bali who switches
    // to a workshop where they are a plain evaluator has not stopped being an
    // admin, and wiping the PAT on a workshop switch is a self-inflicted outage.
    expect(shouldClearRoutingToken(true, true)).toBe(false)
  })

  it('does nothing when there is no token', () => {
    expect(shouldClearRoutingToken(false, false)).toBe(false)
    expect(shouldClearRoutingToken(true, false)).toBe(false)
  })
})

describe('the routing surface is administrator-only', () => {
  const items = NAV_GROUPS.flatMap((g) =>
    g.items.map((i) => ({ ...i, groupRoles: g.roles ?? null })),
  )

  it('has exactly one routing entry, and it points at the admin path', () => {
    const routing = items.filter((i) => i.to.includes('routing'))
    expect(routing).toHaveLength(1)
    expect(routing[0].to).toBe('/admin/routing')
  })

  it('gates that entry on ADMIN_ROLES, not on the group default', () => {
    // A chief evaluator can reach the dashboards but must not reach a page that
    // holds a credential, so the item's own roles have to be narrower than the
    // Configure group's.
    const routing = items.find((i) => i.to === '/admin/routing')!
    expect(routing.roles).toEqual(ADMIN_ROLES)
  })

  it('leaves nothing routing-shaped in the capture group', () => {
    const capture = NAV_GROUPS.find((g) => g.labelId === 'nav.group.capture')!
    expect(capture.roles).toBeUndefined() // still everyone's, which is why this matters
    expect(capture.items.some((i) => /routing|admin/.test(i.to))).toBe(false)
  })
})

describe('the evaluator-facing copy names no mechanism', () => {
  // The spec's acceptance is a DOM grep of every route an evaluator can reach.
  // This is the same check one layer earlier, where it is cheap enough to run on
  // every commit: the ids are stamped into the DOM as data-dfb-node, so an id is
  // as visible as a label and both are audited.
  const FORBIDDEN = /github|token|\brepo\b|repository|routing|\binbox\b|outbox|claude/i

  // Prefixes an evaluator never renders. The routing screen is behind the admin
  // gate and the discrepancy inbox behind the chief gate; both may say what they
  // actually are.
  const ADMIN_ONLY = /^(routing\.|nav\.routing|nav\.discrepancy-inbox|nav\.builder)/

  const nodes = (chrome as { nodes: Array<Record<string, unknown>> }).nodes

  it('has no forbidden word in any evaluator-reachable node', () => {
    const offenders = nodes
      .filter((n) => !ADMIN_ONLY.test(String(n.id)))
      .filter((n) =>
        Object.entries(n).some(([, v]) => typeof v === 'string' && FORBIDDEN.test(v)),
      )
      .map((n) => n.id)
    expect(offenders).toEqual([])
  })

  it('has no forbidden word in any evaluator-reachable node id', () => {
    const offenders = nodes
      .map((n) => String(n.id))
      .filter((id) => !ADMIN_ONLY.test(id))
      .filter((id) => FORBIDDEN.test(id))
    expect(offenders).toEqual([])
  })

  it('still knows what the single routing mode is', () => {
    expect(DEFAULT_ROUTING_MODE).toBe('github-claude')
    expect(nodes.some((n) => n.id === `routing.mode.${DEFAULT_ROUTING_MODE}`)).toBe(true)
  })
})
