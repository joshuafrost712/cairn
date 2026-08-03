import { describe, expect, it } from 'vitest'
import {
  buildWorkshopCards,
  observationsForWorkshop,
  pendingTotal,
  workshopOptions,
} from '../src/reports/workshopOverview'
import { switchDestination } from '../src/lib/workshopSwitch'
import { NAV_GROUPS } from '../src/layout/navItems'
import { findChromeNode } from '../src/lib/content/chrome'
import { evaluation, obs, verdict } from './factories'
import type { Workshop, WorkshopMember } from '../src/lib/types'

/**
 * tl-17's arithmetic and routing rules.
 *
 * The browser harness (scripts/tl17-multi-workshop.mjs) proves the claims that
 * need a real database and a rendered page. What lives here is everything that is
 * a function of its inputs, because those are the parts that fail quietly: a card
 * showing the wrong number does not throw, and a switch that lands on a stale
 * detail page renders a plausible-looking empty state rather than an error.
 */

const member = (workshop_id: string, role: WorkshopMember['role']): WorkshopMember => ({
  workshop_id,
  app_user_id: 'u-1',
  role,
})

const workshop = (partial: Partial<Workshop> & { id: string }): Workshop => ({
  name: partial.name ?? partial.id,
  start_date: partial.start_date ?? null,
  end_date: partial.end_date ?? null,
  location: partial.location ?? null,
  languages: [],
  ...partial,
})

describe('switchDestination', () => {
  it('leaves an index page alone, so a switch does not remount it', () => {
    for (const path of ['/', '/reports', '/observations', '/admin/participants', '/workshops']) {
      expect(switchDestination(path)).toBeNull()
    }
  })

  it('falls back to the group index on a detail route', () => {
    expect(switchDestination('/reports/p-1')).toBe('/reports')
    expect(switchDestination('/admin/participants/p-1')).toBe('/admin/participants')
    expect(switchDestination('/admin/events/a-1')).toBe('/admin/events')
    expect(switchDestination('/admin/evaluators/ruth@sil.org')).toBe('/admin/evaluators')
    expect(switchDestination('/outgoing/draft-1')).toBe('/outgoing')
  })

  it('sends a capture in progress home rather than to a list', () => {
    // A half-typed capture belongs to the workshop it was started in, and the
    // evaluator has just said they are working somewhere else.
    expect(switchDestination('/capture/cap-1')).toBe('/')
  })

  it('keeps a setup SECTION, because a section is a page and not a row', () => {
    // /admin/setup/participants is equally valid in the workshop being switched
    // to. Treating it as a detail route would lose the admin's place for nothing.
    expect(switchDestination('/admin/setup/participants')).toBeNull()
    expect(switchDestination('/admin/setup')).toBeNull()
  })

  it('treats a trailing slash as the index it is', () => {
    expect(switchDestination('/reports/')).toBeNull()
  })
})

describe('workshopOptions', () => {
  const memberships = [member('w-old', 'admin'), member('w-new', 'evaluator'), member('w-draft', 'chief_admin')]
  const workshops = [
    workshop({ id: 'w-old', name: 'Bali 2026', start_date: '2026-08-01' }),
    workshop({ id: 'w-new', name: 'Crash Course', start_date: '2026-11-01' }),
    workshop({ id: 'w-draft', name: 'Unscheduled' }),
  ]

  it('orders by start date descending, with undated workshops last', () => {
    expect(workshopOptions(memberships, workshops).map((o) => o.workshop_id)).toEqual([
      'w-new',
      'w-old',
      'w-draft',
    ])
  })

  it('carries the role held in each workshop, not one global rank', () => {
    const byId = new Map(workshopOptions(memberships, workshops).map((o) => [o.workshop_id, o.role]))
    expect(byId.get('w-old')).toBe('admin')
    expect(byId.get('w-new')).toBe('evaluator')
  })

  it('reports a membership whose workshop row has not arrived, rather than dropping it', () => {
    // Memberships come from workshop_member at sign-in; names come from the
    // reference pull. Dropping the option would make a workshop unreachable on a
    // cold start, which is the moment a switcher matters most.
    const options = workshopOptions([member('w-unknown', 'admin')], [])
    expect(options).toHaveLength(1)
    expect(options[0].name).toBeNull()
  })
})

describe('observationsForWorkshop', () => {
  it('uses the observation’s own workshop when it has one', () => {
    const rows = [obs({ id: 'o-1', workshop_id: 'w-1' }), obs({ id: 'o-2', workshop_id: 'w-2' })]
    expect(observationsForWorkshop(rows, [], 'w-1').map((o) => o.id)).toEqual(['o-1'])
  })

  it('falls back to the originating capture for a pre-tl-04 row', () => {
    const rows = [
      obs({ id: 'o-1', workshop_id: null, capture_client_id: 'cap-a' }),
      obs({ id: 'o-2', workshop_id: null, capture_client_id: 'cap-b' }),
    ]
    const captures = [
      evaluation({ client_id: 'cap-a', workshop_id: 'w-1' }),
      evaluation({ client_id: 'cap-b', workshop_id: 'w-2' }),
    ]
    expect(observationsForWorkshop(rows, captures, 'w-1').map((o) => o.id)).toEqual(['o-1'])
  })

  it('leaves a row out of every workshop when neither signal resolves', () => {
    // Deliberate: an unattributable observation counted into the ACTIVE workshop
    // would inflate whichever card the admin happened to be looking at.
    const rows = [obs({ id: 'o-1', workshop_id: null, capture_client_id: 'gone' })]
    expect(observationsForWorkshop(rows, [], 'w-1')).toEqual([])
  })
})

describe('buildWorkshopCards', () => {
  const NOW = '2026-09-01T12:00:00.000Z'

  const cardFor = (over: Partial<Parameters<typeof buildWorkshopCards>[0][number]> = {}) =>
    buildWorkshopCards(
      [
        {
          membership: member('w-1', 'chief_admin'),
          workshop: workshop({ id: 'w-1', name: 'Bali', end_date: '2026-10-01' }),
          participants: 0,
          evaluations: [],
          observations: [],
          verdicts: [],
          threshold: 2,
          ...over,
        },
      ],
      NOW,
    )[0]

  it('is a draft while nobody has submitted anything, whatever the calendar says', () => {
    expect(cardFor().state).toBe('draft')
  })

  it('is in progress once a capture is attested', () => {
    expect(cardFor({ evaluations: [evaluation({ workshop_id: 'w-1' })] }).state).toBe('in_progress')
  })

  it('is closed after the end date, and the end date means the end of that day', () => {
    const card = cardFor({
      workshop: workshop({ id: 'w-1', end_date: '2026-08-31' }),
      evaluations: [evaluation({ workshop_id: 'w-1' })],
    })
    expect(card.state).toBe('closed')
  })

  it('counts a participant as evidenced only once an observation clears the bar', () => {
    const one = obs({ id: 'o-1', participant_id: 'p-1', capture_client_id: 'cap-1' })
    const base = {
      participants: 2,
      evaluations: [evaluation({ client_id: 'cap-1', workshop_id: 'w-1' })],
      observations: [one],
    }

    // One confirmation short of the threshold of 2: routed, not counting.
    const short = cardFor({ ...base, verdicts: [verdict({ observation_id: 'o-1', evaluator_email: 'a@x.org' })] })
    expect(short.participantsWithEvidence).toBe(0)
    expect(short.coveragePercent).toBe(0)
    expect(short.unverified).toBe(1)

    const met = cardFor({
      ...base,
      verdicts: [
        verdict({ observation_id: 'o-1', evaluator_email: 'a@x.org' }),
        verdict({ observation_id: 'o-1', evaluator_email: 'b@x.org' }),
      ],
    })
    expect(met.participantsWithEvidence).toBe(1)
    expect(met.coveragePercent).toBe(50)
    expect(met.unverified).toBe(0)
  })

  it('reports coverage as null with an empty roster, not as 0%', () => {
    // 0% of nobody reads as failure and means "you have not added anybody".
    const card = cardFor({ participants: 0 })
    expect(card.coveragePercent).toBeNull()
  })

  it('stages pending work exactly as the sync-health funnel does', () => {
    const card = cardFor({
      evaluations: [
        evaluation({ client_id: 'cap-1', workshop_id: 'w-1', sync_status: 'pending' }),
        evaluation({ client_id: 'cap-2', workshop_id: 'w-1', sync_status: 'synced' }),
        // A draft nobody submitted is not late work and must not be counted.
        evaluation({ client_id: 'cap-3', workshop_id: 'w-1', attestation: false }),
      ],
    })
    expect(card.submitted).toBe(2)
    expect(card.unsynced).toBe(1)
    expect(card.unrouted).toBe(1)
    expect(pendingTotal(card)).toBe(2)
  })

  it('survives a membership whose workshop row is not on the device', () => {
    const card = cardFor({ workshop: null })
    expect(card.name).toBeNull()
    expect(card.state).toBe('draft')
  })
})

describe('the workshops nav entry', () => {
  it('asks the ANYWHERE question, or it hides from the admin it is for', () => {
    // An administrator of the Crash Course who is currently pointed at Bali holds
    // `evaluator` there. An active-workshop gate would hide the one link that
    // could move them, which is the bug this scope flag exists to prevent.
    const group = NAV_GROUPS.find((g) => g.items.some((i) => i.to === '/workshops'))
    expect(group?.scope).toBe('anywhere')
    expect(group?.roles).toEqual(['admin', 'chief_admin'])
  })

  it('is the only group that does', () => {
    // Getting this backwards on an ordinary entry offers a link RequireRole then
    // bounces, which reads as a broken app.
    const anywhere = NAV_GROUPS.filter((g) => g.scope === 'anywhere').map((g) => g.labelId)
    expect(anywhere).toEqual(['nav.group.workshops'])
  })
})

describe('tl-17 copy', () => {
  it('has words for every string the new surfaces render', () => {
    // c() prints the id when a node is missing, so a typo ships as a heading
    // reading "workshops.stat.pending" rather than as a blank anybody would spot.
    const ids = [
      'switcher.aria',
      'switcher.unnamed',
      'nav.group.workshops',
      'nav.workshops',
      'workshops.title',
      'workshops.crumb',
      'workshops.meta',
      'workshops.help',
      'workshops.loading',
      'workshops.none',
      'workshops.unnamed',
      'workshops.current',
      'workshops.from',
      'workshops.until',
      'workshops.no-dates',
      'workshops.stat.participants',
      'workshops.stat.coverage',
      'workshops.stat.coverage-sub',
      'workshops.stat.coverage-empty',
      'workshops.stat.pending',
      'workshops.stat.pending-sub',
      'workshops.action.switch',
      'workshops.action.here',
      'workshops.action.setup',
      'workshops.action.health',
      'workshops.create.open',
      'workshops.create.title',
      'workshops.create.help',
      'workshops.create.name',
      'workshops.create.name-placeholder',
      'workshops.create.start',
      'workshops.create.end',
      'workshops.create.location',
      'workshops.create.dates-note',
      'workshops.create.dates-backwards',
      'workshops.create.submit',
      'workshops.create.working',
      'workshops.create.cancel',
      'workshops.create.failed',
      'workshops.create.queued',
      'setup.basics.overview-link',
      'outgoing.no-workshop',
    ]
    expect(ids.filter((id) => !findChromeNode(id)?.label)).toEqual([])
  })

  it('leaves no copy behind for the create box that moved to /workshops', () => {
    // An orphan node is not harmless: the next person editing the app's voice
    // reads it as live text and rewords a control that no longer exists.
    expect(findChromeNode('setup.basics.create')).toBeUndefined()
    expect(findChromeNode('setup.basics.new-placeholder')).toBeUndefined()
  })
})
