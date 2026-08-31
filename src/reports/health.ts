/**
 * The briefing's logic, with no Dexie and no Supabase in it (tl-38).
 *
 * Same shape as `syncHealth.ts` and for the same reason: the ordering, the
 * ranking and the markdown are the parts most likely to be wrong, and they are
 * only cheap to test if they are a pure function of a payload rather than of a
 * browser.
 *
 * The payload comes from the `workshop_health` RPC. Everything here is counts,
 * emails and timestamps; the one text field is `unresolved_scope_names`, which
 * are roster-adjacent strings typed into a participant picker.
 */

export interface HealthWorkshop {
  id: string
  name: string
  start_date: string | null
  end_date: string | null
}

export interface HealthPerDay {
  day: string
  n: number
}

export interface HealthSentiment {
  flag: string | null
  n: number
}

export interface HealthVolume {
  captures: number
  evaluators: number
  observations: number
  verdicts: number
  people_with_routed: number
  mean_evidence: number | string | null
  sentiment: HealthSentiment[]
  per_day: HealthPerDay[]
}

export interface HealthByEvaluator {
  evaluator_email: string
  n: number
}

export interface HealthDraft {
  evaluator_email: string
  created_at: string
  kind: 'text' | 'ratings_only'
}

export interface HealthDelivery {
  evaluator_email: string
  last_at: string
}

export interface HealthPipeline {
  queue: {
    count: number
    oldest_created_at: string | null
    by_evaluator: HealthByEvaluator[]
  }
  drafts_with_content: HealthDraft[]
  empty_shells: number
  last_delivery: HealthDelivery[]
}

export interface HealthCoverageRow {
  participant_id: string
  name: string
  team: string | null
  routed: number
  pending: number
}

export interface HealthCoverage {
  participants: HealthCoverageRow[]
  unattributed_observations: number
  unresolved_scope_names: string[]
}

/**
 * Grouped by goal, not by the legacy `ksa.area` column that tl-08 replaced.
 * `test/oneResolutionSite.test.ts` fails any code that reads `area` to decide a
 * grouping, and it is right to: the goal layer is the one resolution site.
 */
export interface HealthGoalCoverage {
  goal: string
  n: number
  mean_evidence: number | string | null
}

export interface WorkshopHealth {
  workshop: HealthWorkshop | null
  generated_at: string
  stale_hours: number
  volume: HealthVolume
  pipeline: HealthPipeline
  coverage: HealthCoverage
  by_goal: HealthGoalCoverage[]
}

/** A participant nobody has watched, or has barely watched. */
export interface CoverageGap {
  row: HealthCoverageRow
  total: number
  /** True zero: no routed observation and no pending mention anywhere. */
  unseen: boolean
}

/**
 * Participants worst-covered first.
 *
 * `pending` is counted alongside `routed` deliberately. A routing backlog is not
 * an unwatched person: on 2026-08-28 the heatmap showed Bijili with a near-empty
 * row while she was named in eleven captures nobody had routed yet. Separating
 * the true zeroes from the thin-but-pending is what stops one being read as the
 * other in the opposite direction.
 */
export function rankCoverageGaps(rows: HealthCoverageRow[]): CoverageGap[] {
  return rows
    .map((row) => ({ row, total: row.routed + row.pending, unseen: row.routed + row.pending === 0 }))
    .sort((a, b) => a.total - b.total || a.row.name.localeCompare(b.row.name))
}

/**
 * Evaluators whose last delivery is older than the window.
 *
 * One implementation, used by both the page and the copied markdown, so the two
 * can never disagree about who has gone quiet. The clock is the reader's, which
 * matches how `formatAge` already works on the sync-health page; the threshold
 * travels in the payload so it can be widened over a weekend without a migration.
 */
export function silentDevices(
  rows: HealthDelivery[],
  nowMs: number,
  staleHours: number,
): HealthDelivery[] {
  const cutoff = staleHours * 3600 * 1000
  return rows
    .filter((row) => {
      const at = Date.parse(row.last_at)
      return Number.isFinite(at) && nowMs - at > cutoff
    })
    .sort((a, b) => a.last_at.localeCompare(b.last_at))
}

export type BriefingActionKind =
  | 'route-queue'
  | 'unsubmitted-drafts'
  | 'silent-devices'
  | 'unseen-participants'
  | 'unverified'
  | 'name-variants'

export interface BriefingAction {
  kind: BriefingActionKind
  /** How many things this action is about. Never zero: a zero action is not shown. */
  count: number
  /** Where the reader goes to do it. The briefing links; it never acts. */
  to?: string
  /** Names, emails or strings the reader needs to act, already capped. */
  detail: string[]
}

/**
 * The worklist, smallest job first.
 *
 * Smallest first is a deliberate inversion of severity ordering. This is read at
 * the start of a workshop day by somebody with ten minutes, and a list headed by
 * the largest task is a list that gets closed. Every action names a surface and
 * none of them is performed here: a health panel that also acts becomes a second,
 * worse copy of the Routing page.
 */
export function briefingActions(
  health: WorkshopHealth,
  nowMs: number,
): BriefingAction[] {
  const silent = silentDevices(health.pipeline.last_delivery, nowMs, health.stale_hours)
  const unseen = rankCoverageGaps(health.coverage.participants).filter((g) => g.unseen)
  const drafts = health.pipeline.drafts_with_content
  const unverified = Math.max(0, health.volume.observations - health.volume.verdicts)

  const actions: BriefingAction[] = [
    {
      kind: 'unseen-participants',
      count: unseen.length,
      to: '/admin/workshop',
      detail: unseen.map((g) => g.row.name),
    },
    {
      kind: 'silent-devices',
      count: silent.length,
      to: '/admin/sync-health',
      detail: silent.map((row) => row.evaluator_email),
    },
    {
      kind: 'unsubmitted-drafts',
      count: drafts.length,
      detail: drafts.map((d) => `${d.evaluator_email} (${d.kind})`),
    },
    {
      kind: 'name-variants',
      count: health.coverage.unresolved_scope_names.length,
      detail: health.coverage.unresolved_scope_names,
    },
    {
      kind: 'route-queue',
      count: health.pipeline.queue.count,
      to: '/admin/routing',
      detail: health.pipeline.queue.by_evaluator.map((e) => `${e.evaluator_email} ${e.n}`),
    },
    {
      kind: 'unverified',
      count: unverified,
      to: '/observations',
      detail: [],
    },
  ]

  return actions.filter((a) => a.count > 0).sort((a, b) => a.count - b.count)
}

/**
 * Two decimal places, always.
 *
 * Postgres `round(avg(...), 2)` renders 1.8 where the script's `toFixed(2)`
 * renders 1.80, and the parity harness caught the pair disagreeing about a mean
 * they had both computed correctly. Formatting is the renderer's job, so it is
 * done once here rather than argued about at either end.
 */
function num(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'n/a'
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(2) : String(value)
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : 'n/a'
}

function localPart(email: string): string {
  return email.split('@')[0]
}

/**
 * The markdown the copy button puts on the clipboard.
 *
 * This is a contract with the vault: Joshua pastes it into notes and chats, so
 * additive changes are free and renaming a heading breaks documents already
 * written. It follows the vault's own formatting rules rather than the script's,
 * which is the one deliberate difference between them: no em dashes and no
 * horizontal rules. The numbers are the parity surface, not the punctuation.
 */
export function renderHealthMarkdown(health: WorkshopHealth, nowMs: number): string {
  const w = health.workshop
  const v = health.volume
  const p = health.pipeline
  const L: string[] = []

  L.push(`# Workshop briefing: ${w?.name ?? 'unknown workshop'}`)
  L.push(
    ``,
    `Generated ${health.generated_at.slice(0, 16)}Z. Workshop ${w?.start_date ?? '?'} to ${w?.end_date ?? '?'}.`,
  )

  L.push(``, `## Volume`)
  const sentiment = v.sentiment.map((s) => `${s.n} ${s.flag ?? 'unflagged'}`).join(', ') || 'none'
  L.push(
    ``,
    `${v.captures} captures from ${v.evaluators} evaluators; ${v.observations} routed observations across ${v.people_with_routed} people. Mean evidence ${num(v.mean_evidence)} (sentiment: ${sentiment}).`,
  )
  L.push(
    ``,
    `Captures per day: ${v.per_day.map((d) => `${d.day.slice(5)}: ${d.n}`).join(' · ') || 'none'}`,
  )

  L.push(``, `## Pipeline`)
  const byEval = p.queue.by_evaluator.map((e) => `${localPart(e.evaluator_email)} ${e.n}`).join(', ')
  L.push(
    ``,
    `- Routing queue (attested, has content, no observations yet): **${p.queue.count}**${
      p.queue.count ? `. Oldest ${day(p.queue.oldest_created_at)}; by evaluator: ${byEval}` : ''
    }`,
  )
  L.push(`- Verification verdicts recorded: **${v.verdicts}** on ${v.observations} observations.`)
  const draftList = p.drafts_with_content
    .map((d) => `${localPart(d.evaluator_email)} (${d.created_at.slice(5, 10)}, ${d.kind})`)
    .join(', ')
  L.push(
    `- Unsubmitted drafts that contain content (invisible to routing until submitted): **${p.drafts_with_content.length}**${
      p.drafts_with_content.length ? `. ${draftList}` : ''
    }`,
  )
  L.push(`- Abandoned empty capture shells: ${p.empty_shells} (benign).`)
  const silent = silentDevices(p.last_delivery, nowMs, health.stale_hours)
  if (silent.length) {
    L.push(
      `- Evaluator devices silent over ${health.stale_hours}h (last delivery): ${silent
        .map((row) => `${localPart(row.evaluator_email)} ${row.last_at.slice(0, 16)}`)
        .join(', ')}`,
    )
  }

  // Only when there is something under it. An empty section would put an H2
  // directly beneath an H2, which the vault's formatting rules forbid in a
  // document written to be pasted into a note.
  if (health.by_goal.length > 0) {
    L.push(``, `## Coverage by goal (routed only)`)
    L.push(``, ...health.by_goal.map((g) => `- ${g.n}: ${g.goal} (mean evidence ${num(g.mean_evidence)})`))
  }

  L.push(``, `## Coverage by participant (routed + pending-in-queue)`)
  L.push(``, `| Participant | Team | Routed | Pending | Total |`, `|---|---|---|---|---|`)
  const gaps = rankCoverageGaps(health.coverage.participants)
  for (const g of gaps) {
    L.push(`| ${g.row.name} | ${g.row.team ?? ''} | ${g.row.routed} | ${g.row.pending} | **${g.total}** |`)
  }

  const unseen = gaps.filter((g) => g.unseen).map((g) => g.row.name)
  if (unseen.length) {
    L.push(``, `**No evidence at all (routed or pending): ${unseen.join(', ')}.**`)
  }
  if (health.coverage.unattributed_observations) {
    L.push(
      ``,
      `${health.coverage.unattributed_observations} observations are attributed to names not on the roster. Check for name-variant mismatches.`,
    )
  }
  if (health.coverage.unresolved_scope_names.length) {
    L.push(
      ``,
      `Scope names matching no roster row: ${health.coverage.unresolved_scope_names.join(', ')}.`,
    )
  }

  return L.join('\n')
}
