/**
 * What a failed sign-up actually means, as far as the browser can tell (tl-11).
 *
 * `handle_new_user` raises `insufficient_privilege` with a sentence written to be
 * read. **None of that sentence reaches the browser.** Measured on the wire by
 * `scripts/tl11-session-tests.mjs`: Supabase Auth catches any trigger exception
 * and answers
 *
 *     {"code":500,"error_code":"unexpected_failure","msg":"Database error saving new user"}
 *
 * The first version of this matched the trigger's own words, so it would never
 * have fired once — leaving somebody who was never invited staring at "Database
 * error saving new user" and no idea what to do. That is the whole reason this
 * module exists as its own file with its own test: the string it depends on is a
 * fact about somebody else's service, so it needs pinning where a change is loud.
 *
 * Two failures are separated on purpose. `unexpected_failure` on this endpoint
 * means "a trigger refused", and the only trigger on sign-up is the invite-only
 * one — so the copy names that as the likely cause and says what to do, rather
 * than asserting a diagnosis the browser cannot make. The rate limit is the
 * opposite case: not an authorization problem at all, but the project's outbound
 * email quota, and telling somebody they were never invited when they were is
 * worse than telling them nothing. It is reachable in ordinary use, because a
 * cohort signing up the same evening will meet it.
 */

export type SignupFailure = 'invite-only' | 'email-rate-limit' | 'other'

export function classifySignupError(message: string): SignupFailure {
  if (/rate limit/i.test(message)) return 'email-rate-limit'
  if (/database error saving new user|unexpected_failure/i.test(message)) return 'invite-only'
  // Kept even though the auth service currently swallows it: if a future version
  // stops wrapping the trigger's message, this recognizes the real one.
  if (/not been invited|not authorized to sign up/i.test(message)) return 'invite-only'
  return 'other'
}

/** Chrome id for each failure the form can explain. `other` shows the server's words. */
export const SIGNUP_ERROR_ID: Record<Exclude<SignupFailure, 'other'>, string> = {
  'invite-only': 'signin.invite-only',
  'email-rate-limit': 'signin.email-rate-limit',
}
