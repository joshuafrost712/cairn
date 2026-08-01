import { db } from './local'

/**
 * Clear this device's evidence, keeping everything needed to carry on (tl-18).
 *
 * Added because "start fresh" had no supported answer. Clearing site data does
 * it, but it also takes the sign-in, the roster, the schedule and the questions,
 * which on an installed PWA on a phone means a fiddly reinstall before anyone can
 * capture anything. So this removes the six evidence stores and nothing else.
 *
 * Two things to know before calling it, both of which the page says out loud.
 *
 * It is LOCAL ONLY. A row already on the server is not deleted by this, and an
 * administrator's next pull would bring it back. The order that actually works is
 * server first, then each device — which is the order the 2026-07-30 fresh start
 * followed.
 *
 * And it is a discard, not a withdrawal. Verdict tombstones are dropped rather
 * than pushed, because a tombstone's whole purpose is to tell the server to
 * remove a verdict, and after a fresh start there is no verdict there to remove;
 * keeping them would make the next sync issue deletes for rows that no longer
 * exist. Clearing them is only correct BECAUSE the server was cleared first.
 */
export interface FreshStartResult {
  evaluations: number
  observations: number
  verdicts: number
  tombstones: number
  conversations: number
  coverage: number
}

/**
 * The stores a fresh start empties. Reference data and identity are not here.
 *
 * tl-12's `persons` and `personProfiles` are deliberately NOT in this list, and
 * the omission is a decision rather than an oversight of the kind tl-18 warned
 * about. A profile is background, not evidence: it is the same kind of thing as
 * the roster and the schedule, which this function keeps precisely so somebody can
 * carry on capturing straight afterwards. Discarding it would also throw away
 * hand-typed content that no re-sync recovers if the server copy went with it.
 */
export async function clearDeviceEvidence(): Promise<FreshStartResult> {
  const [evaluations, observations, verdicts, tombstones, conversations, coverage] =
    await Promise.all([
      db.evaluations.count(),
      db.observations.count(),
      db.verifications.count(),
      db.verdictTombstones.count(),
      db.mentoringConversations.count(),
      db.coverage.count(),
    ])

  // Sequential rather than a single transaction across six stores: Dexie would
  // need every table named up front, and a partial clear is recoverable by
  // running it again whereas a failed transaction here would be reported as
  // "nothing happened" while some stores were already empty.
  await db.evaluations.clear()
  await db.observations.clear()
  await db.verifications.clear()
  await db.verdictTombstones.clear()
  await db.mentoringConversations.clear()
  await db.coverage.clear()

  return { evaluations, observations, verdicts, tombstones, conversations, coverage }
}

/** One sentence for the page, from the counts that were actually removed. */
export function describeFreshStart(r: FreshStartResult): string {
  const total = r.evaluations + r.observations + r.verdicts + r.conversations
  if (total === 0 && r.coverage === 0 && r.tombstones === 0) {
    return 'This device was already clear. Nothing to remove.'
  }
  return (
    `Removed from this device: ${r.evaluations} capture(s), ${r.observations} observation(s), ` +
    `${r.verdicts} verdict(s), ${r.conversations} conversation(s). ` +
    'The workshop, roster, schedule and questions are untouched.'
  )
}
