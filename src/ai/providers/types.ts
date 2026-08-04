import type { AiFunction, AiMode } from '../../lib/aiConfig'

/**
 * The provider contract (tl-13).
 *
 * THE DESIGN DECISION THIS FILE EXISTS FOR: "the operator has to go and do this"
 * is a first-class OUTCOME, not an error and not a failure to return a result.
 * Two of the three modes live in that state most of the time — github-claude
 * hands a bundle to a human in a Claude Max session, byo-agent hands a brief to
 * whatever subscription the operator has — so an interface that could only say
 * "result" or "threw" would have to misrepresent them, and every caller would
 * then have to guess which errors were really successes.
 *
 * Four outcomes, and the distinction between the last two is load-bearing:
 *
 *   result          — the work is done and `value` holds it, already validated
 *                     against its contract where one exists.
 *   operator_action — nothing is wrong; a human now has something to do, and
 *                     `prompt`/`href` are what they need to do it.
 *   refused         — the app declined ON PURPOSE: a switch is off, the input is
 *                     too large, this mode cannot service this function. `reason`
 *                     is a chrome id, because a refusal is a sentence a user reads.
 *   error           — something failed. `reason` is a human-readable message, and
 *                     it is never a stack trace (Agent-Engineering-Protocol §7).
 */
export type AiOutcomeKind = 'result' | 'operator_action' | 'refused' | 'error'

export interface AiOutcome {
  kind: AiOutcomeKind
  /**
   * What the provider produced, where there is something to show. Always set on
   * `result`; also set on `operator_action` when the hand-off itself has counts
   * worth reporting ("pushed 4 captures"), because a hand-off that reported
   * nothing would look to the operator like a button that did nothing.
   */
  value?: unknown
  /** `operator_action` only: a chrome id saying what the human must now do. */
  instructionsId?: string
  /** `operator_action` only: the text to hand to their own tool. */
  prompt?: string
  /** `operator_action` only: where in the app to finish the job. */
  href?: string
  /** `refused`: a chrome id. `error`: a readable message. */
  reason?: string
  /** Which model did the work, where a model did. */
  model?: string | null
  tokensIn?: number | null
  tokensOut?: number | null
}

export const result = (value: unknown, extra: Partial<AiOutcome> = {}): AiOutcome => ({
  kind: 'result',
  value,
  ...extra,
})

export const operatorAction = (
  instructionsId: string,
  extra: Partial<AiOutcome> = {},
): AiOutcome => ({ kind: 'operator_action', instructionsId, ...extra })

export const refused = (reason: string): AiOutcome => ({ kind: 'refused', reason })

export const failed = (reason: string): AiOutcome => ({ kind: 'error', reason })

/**
 * One unit of AI work.
 *
 * A discriminated union rather than a bag with an optional payload, so a provider
 * cannot compile while reading a field the caller never sends — which is the
 * failure mode the tool-contract half of the protocol (§2) is about: a vague
 * contract invites invention.
 */
export type RoutingIntent = 'copy' | 'push' | 'run' | 'pack'

export type AiJob =
  | {
      fn: 'observation_routing'
      workshopId: string
      actorEmail?: string | null
      /**
       * `copy` prepares the bundle for a human to paste; `push` writes it to the
       * routing repo through the stored token. Both are hand-offs; only the
       * transport differs.
       *
       * `run` (tl-21) is the third thing, and the reason it is an intent rather than a
       * fourth function: it asks for the SAME work by the same contract, done here and
       * now rather than handed to somebody. Only `local-agent` can service it; the other
       * modes refuse it with a reason naming the limitation ("somebody has to sit down and
       * do this"), which is more useful than a button that does nothing.
       *
       * `pack` (tl-15) is the fourth, on the same rule: the same captures under the same
       * contract, handed over as a folder an operator's own agent can read rather than as
       * a prompt somebody pastes. It is an intent and not a function precisely so that it
       * passes the toggle and the trace like every other way of moving this work.
       */
      intent: RoutingIntent
    }
  | {
      fn: 'scenario_draft'
      workshopId: string
      actorEmail?: string | null
      document: string
      /** The workshop's own scale, so the drafter writes descriptors that fit it. */
      scale: { value: number; label: string }[]
    }
  | {
      fn: 'conversation_guidance'
      workshopId: string
      actorEmail?: string | null
      /** The evidence the guidance is being written about. Free text, untrusted. */
      brief: string
    }

/**
 * What a provider may be handed: every job except the pack (tl-15).
 *
 * The exclusion is in the TYPE rather than in a comment because it is a claim worth
 * making provable. `pack` is the one intent that is the same in every mode — it moves the
 * work rather than doing it, calls no model, holds no credential and touches no network —
 * so `runAiJob` serves it centrally, and a provider that tried to handle it would be
 * adding a fourth answer to a question with one. Getting this wrong would not have been
 * loud: `github-claude` would have fallen through to its copy hand-off and given an
 * administrator a clipboard bundle when they asked for a folder, and `hosted-api` would
 * have refused a pack for want of a deployment key it does not need.
 */
export type ProviderJob =
  | (Extract<AiJob, { fn: 'observation_routing' }> & { intent: Exclude<RoutingIntent, 'pack'> })
  | Extract<AiJob, { fn: 'scenario_draft' }>
  | Extract<AiJob, { fn: 'conversation_guidance' }>

/** What a provider must be able to do. One object per mode. */
export interface AiProvider {
  mode: AiMode
  /** Which functions this mode can actually service in this build. */
  handles(fn: AiFunction): boolean
  run(job: ProviderJob): Promise<AiOutcome>
}

/** How much text may be sent in one job. */
export const MAX_AI_INPUT_CHARS = 120_000

/** The characters of a job that count against the cap, for the trace and the check. */
export function jobInputChars(job: AiJob): number {
  switch (job.fn) {
    case 'observation_routing':
      // The bundle is assembled inside the provider from the local store, so there
      // is nothing to measure here and nothing a caller could inflate.
      //
      // Which means MAX_AI_INPUT_CHARS does not govern routing, and that is deliberate
      // rather than an oversight: a legitimate batch of a day's captures plus the rubric
      // can be large, and refusing it at 120k would block real work to enforce a cap
      // aimed at caller-supplied text. Routing's size limit lives where the bundle is
      // actually built, in the relay's own MAX_PROMPT_CHARS (400k). An oversize bundle is
      // not a raw server error either: the relay answers 400, `client.ts` maps 400/404/413
      // to `refused`, and the provider returns it as a chrome id like every other refusal.
      // Confirmed while reviewing this file on 2026-08-03; the review had it the other way.
      return 0
    case 'scenario_draft':
      return job.document.length
    case 'conversation_guidance':
      return job.brief.length
  }
}
