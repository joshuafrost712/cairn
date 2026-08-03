// The per-event facilitator digest: one short email to the whole team per event.
//
// Joshua's brief for this one was specific and the constraint is brevity, so the
// shape is fixed rather than adaptive. Two sections and nothing else:
//
//   1. How the group did. The mean over observations in this event, plus a line
//      for any competency area where a quarter or more of the participants
//      observed here scored below competent.
//   2. Who needed a disciplinary conversation. One frank sentence on what they
//      did, one on how the conversation went.
//
// Roughly fifteen lines. If it grows past that, something has been added that
// belongs on the dashboard instead: the digest is the thing you read on a phone
// between sessions, and every line that is merely interesting costs the reader
// the line that mattered.
//
// Formatting follows the vault conventions: no "---" dividers, a sentence of
// body between heading levels, em dashes used sparingly.

import type { MentoringConversation } from '../lib/types'
import type { ActivityAnalytics } from './analytics'
import { MIN_N_FOR_MEAN } from './analytics'
import { firstAdequateValue, getActiveScale, maxValue, type Scale } from '../lib/scale'
import {
  SEGMENT_ID_VERSION,
  endBlock,
  push,
  segId,
  segmentsToMarkdown,
  slug,
  type DocSegment,
} from './segments'

/**
 * A competency area is called out as a group pattern when at least this share of
 * the participants observed in the event scored below the workshop's first
 * adequate point.
 *
 * The share is named and exported so the threshold is visible in the digest's
 * own tests and changeable in one place. A quarter is Joshua's number: below
 * that it is a few individuals having a hard session, which is the conversation
 * line's job, not the pattern line's.
 *
 * "Below competent" was the literal 2 until tl-09. It is now the lowest point
 * the workshop did NOT mark a low trigger, which is 2 on the app's original
 * scale — so this digest's output is unchanged for an existing workshop — and
 * which means something on a 1-5 scale, where 2 may be the second-worst score
 * there is.
 */
export const PATTERN_SHARE = 0.25

export interface EventDigestOptions {
  fromName?: string
  /** Named recipients for the greeting, e.g. "facilitators". */
  toName?: string
  /**
   * The workshop's grading scale (tl-09). Defaults to the ACTIVE workshop's,
   * which is right for every in-app caller and wrong for a job that generates
   * documents for a workshop the operator is not currently in — those pass it.
   */
  scale?: Scale
}

export interface PatternLine {
  ksa_code: string
  goal_title: string
  below: number
  observed: number
  mean: number | null
  observationIds: string[]
}

/**
 * Competency areas where a quarter or more of the participants observed in this
 * event scored below competent.
 *
 * Counted over PARTICIPANTS, not over observations. Counting observations would
 * let one participant with four low notes on the same area look like four
 * people, which is exactly the inference the digest is meant to support and
 * therefore exactly the one it must not corrupt.
 */
export function findPatterns(a: ActivityAnalytics, scale: Scale = getActiveScale()): PatternLine[] {
  const below = firstAdequateValue(scale)
  const out: PatternLine[] = []
  for (const cell of a.perKsa) {
    // byParticipant is one row per person, rolled up the same way a report rolls
    // one up. stats.n counts observations and is the wrong denominator here.
    const observed = cell.byParticipant.length
    if (observed === 0) continue
    const low = cell.byParticipant.filter((p) => p.value < below)
    if (low.length === 0) continue
    if (low.length / observed < PATTERN_SHARE) continue
    out.push({
      ksa_code: cell.ksa_code,
      goal_title: cell.goal_title,
      below: low.length,
      observed,
      mean: cell.stats.mean,
      observationIds: low.flatMap((p) => p.observationIds),
    })
  }
  // Worst share first: the reader should hit the widest problem in line one.
  return out.sort(
    (x, y) => y.below / y.observed - x.below / x.observed || y.below - x.below,
  )
}

function fmt(mean: number | null): string {
  return mean === null ? 'n/a' : mean.toFixed(1)
}

/** Build the event digest as segments. */
export function buildEventDigestSegments(
  a: ActivityAnalytics,
  conversations: MentoringConversation[],
  opts: EventDigestOptions = {},
): DocSegment[] {
  const scale = opts.scale ?? getActiveScale()
  const root = segId(SEGMENT_ID_VERSION, `ed:${slug(a.activity_id)}`)
  const out: DocSegment[] = []
  const dayBit = a.day ? ` (${a.day})` : ''

  push(out, {
    id: segId(root, 'title'),
    kind: 'heading',
    level: 2,
    text: `## ${a.title}${dayBit}`,
  })
  endBlock(out)

  push(out, {
    id: segId(root, 'greeting'),
    kind: 'paragraph',
    text: opts.toName ? `Hi ${opts.toName},` : 'Hi all,',
  })
  endBlock(out)

  // ---- 1. how the group did ------------------------------------------------

  push(out, { id: segId(root, 'grp', 'h'), kind: 'heading', level: 4, text: '**How the group did**' })

  const scope = `${a.participantsObserved} participant${a.participantsObserved === 1 ? '' : 's'} observed, ${a.observationCount} observation${a.observationCount === 1 ? '' : 's'}, ${a.evaluators.length} evaluator${a.evaluators.length === 1 ? '' : 's'}`

  if (a.overall.n === 0) {
    push(out, {
      id: segId(root, 'grp', 'none'),
      kind: 'bullet',
      text: '- No observations have been routed for this event yet, so there is nothing to summarize.',
    })
  } else {
    push(out, {
      id: segId(root, 'grp', 'mean'),
      kind: 'bullet',
      // Say which mean this is. The dashboard carries two and they differ.
      text: `- Average across all observations in this event: **${fmt(a.overall.reportableMean ?? a.overall.mean)}/${maxValue(scale)}** (${scope}).`,
      note:
        a.overall.reportableMean === null
          ? `Below ${MIN_N_FOR_MEAN} observations, so this average is shown for completeness only.`
          : `Mean over ${a.overall.n} raw observations, not over participant representatives.`,
    })
  }

  const patterns = findPatterns(a, scale)
  if (patterns.length === 0 && a.overall.n > 0) {
    push(out, {
      id: segId(root, 'grp', 'no-pattern'),
      kind: 'bullet',
      text: `- No competency area had a quarter or more of the group below competent.`,
    })
  }
  for (const p of patterns) {
    push(out, {
      id: segId(root, 'grp', `k:${slug(p.ksa_code)}`),
      kind: 'bullet',
      text: `- ${p.goal_title}: ${p.below} of ${p.observed} observed scored below competent (average ${fmt(p.mean)}/${maxValue(scale)}).`,
      ksaCode: p.ksa_code,
      evidence: p.observationIds,
      note: `A pattern line appears when at least ${Math.round(PATTERN_SHARE * 100)}% of the participants observed on this area scored below ${firstAdequateValue(scale)}/${maxValue(scale)}.`,
    })
  }
  endBlock(out)

  // ---- 2. conversations ----------------------------------------------------

  push(out, { id: segId(root, 'conv', 'h'), kind: 'heading', level: 4, text: '**Conversations**' })

  if (conversations.length === 0) {
    push(out, {
      id: segId(root, 'conv', 'none'),
      kind: 'bullet',
      text: '- Nobody from this event needed a one-to-one conversation.',
    })
  }

  for (const c of conversations) {
    const cRoot = segId(root, 'conv', `c:${slug(c.id)}`)
    // One frank sentence on what they did. The trigger observation's own text is
    // the frankest available account and it is what the evaluator actually
    // wrote, so it is quoted rather than paraphrased.
    const what = c.trigger_ksa_code
      ? `${c.participant_name}: ${c.trigger_designation ?? '?'}/${maxValue(scale)} on ${c.trigger_ksa_code}.`
      : `${c.participant_name}.`

    const how =
      c.status === 'completed'
        ? [c.summary, c.participant_response].filter(Boolean).join(' ') ||
          'Conversation held; no notes were recorded.'
        : c.status === 'scheduled'
          ? `Conversation scheduled${c.scheduled_for ? ` for ${c.scheduled_for}` : ''}, not yet held.`
          : 'Conversation needed, not yet held.'

    push(out, {
      id: segId(cRoot, 'line'),
      kind: 'bullet',
      text: `- ${what} ${how}`,
      participantId: c.participant_id,
      ksaCode: c.trigger_ksa_code ?? undefined,
      evidence: c.trigger_observation_id ? [c.trigger_observation_id] : [],
      note:
        c.status === 'completed'
          ? 'Outcome from the recorded conversation.'
          : // Worth saying out loud: the mentoring conversation is recommended for
            // the NEXT day, so a digest written the same evening will usually land
            // here. Regenerating after the conversation fills in the outcome.
            'No outcome yet. Regenerate this digest after the conversation to fill it in.',
    })
  }
  endBlock(out)

  if (a.unroutedCaptures > 0) {
    push(out, {
      id: segId(root, 'unrouted'),
      kind: 'meta',
      text: `_${a.unroutedCaptures} capture(s) from this event have not been routed into observations yet, so the numbers above are incomplete._`,
    })
    endBlock(out)
  }

  if (opts.fromName) {
    push(out, { id: segId(root, 'signoff'), kind: 'paragraph', text: `Thanks,\n${opts.fromName}` })
  }
  return out
}

/** The same document as markdown. */
export function renderEventDigestMarkdown(
  a: ActivityAnalytics,
  conversations: MentoringConversation[],
  opts: EventDigestOptions = {},
): string {
  return segmentsToMarkdown(buildEventDigestSegments(a, conversations, opts))
}

/** Subject line, kept beside the body so the two cannot drift. */
export function eventDigestSubject(a: ActivityAnalytics): string {
  return `${a.title}${a.day ? ` (${a.day})` : ''}: facilitator digest`
}

/** The conversations triggered by an observation captured in this event. */
export function conversationsForEvent(
  a: ActivityAnalytics,
  all: MentoringConversation[],
  observationToActivity: Map<string, string | null>,
): MentoringConversation[] {
  return all.filter((c) => {
    // trigger_activity_id is set when the conversation was reconciled from an
    // observation whose capture was on this device. When it is missing, fall
    // back to the same capture join the dashboard uses, which can also miss:
    // a conversation whose trigger cannot be placed is left out rather than
    // guessed into an event it may not belong to.
    if (c.trigger_activity_id) return c.trigger_activity_id === a.activity_id
    if (!c.trigger_observation_id) return false
    return observationToActivity.get(c.trigger_observation_id) === a.activity_id
  })
}
