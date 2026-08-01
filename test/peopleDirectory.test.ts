import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { classifySetupChange, type SetupChange } from '../src/setup/impact'
import { classifySignupError } from '../src/lib/signupErrors'
import { canGrant, grantableRoles } from '../src/lib/permissions'
import { findChromeNode } from '../src/lib/content/chrome'

/**
 * tl-11: the people directory, its classifier entries, and two tripwires.
 *
 * The permission matrix itself is tested in test/permissions.test.ts (the mirror)
 * and scripts/tl11-rls-tests.sql (the enforcement). What is tested here is the
 * part that lives only in this branch: how a membership change is described before
 * it commits, what the browser makes of a refused sign-up, and the two places
 * where a later change would silently make this spec wrong.
 */

const MIGRATION = readFileSync(
  new URL('../supabase/migrations/20260801000400_invitations.sql', import.meta.url),
  'utf8',
)

const membership = (over: Partial<SetupChange>): SetupChange => ({
  entity: 'membership',
  operation: 'update',
  entityId: 'u1',
  label: 'Viji',
  ...over,
})

describe('classifying a membership change', () => {
  it('never calls a removal destructive, however much that person recorded', () => {
    const impact = classifySetupChange(
      membership({
        operation: 'delete',
        fields: [{ field: 'role', before: 'evaluator', after: null }],
        counts: { captures: 340, verdicts: 90 },
      }),
      'in_progress',
    )
    // `destructive` means work is unrecoverably lost. Removing somebody loses
    // none of it: their evaluations stay in the workshop, attributed to them.
    expect(impact.severity).toBe('invalidates_evidence')
    expect(impact.requiresTypedName).toBe(false)
    expect(impact.consequences.map((c) => c.id)).toContain('setup.impact.membership.remove')
  })

  it('drops a tier when the person recorded nothing, and says so', () => {
    const impact = classifySetupChange(
      membership({
        operation: 'delete',
        fields: [{ field: 'role', before: 'evaluator', after: null }],
        counts: { captures: 0 },
      }),
      'in_progress',
    )
    expect(impact.severity).toBe('affects_future')
    expect(impact.consequences.map((c) => c.id)).toContain('setup.impact.membership.remove-clean')
  })

  it('names the assigned follow-ups a removal would strand', () => {
    const impact = classifySetupChange(
      membership({
        operation: 'delete',
        fields: [{ field: 'role', before: 'evaluator', after: null }],
        counts: { captures: 3, assignedConversations: 2 },
      }),
      'in_progress',
    )
    const line = impact.consequences.find((c) => c.id === 'setup.impact.membership.remove-assigned')
    expect(line?.tokens?.conversations).toBe(2)
  })

  it('warns when removing the last admin besides the chief admin', () => {
    const withOthers = classifySetupChange(
      membership({
        operation: 'delete',
        fields: [{ field: 'role', before: 'admin', after: null }],
        counts: { captures: 0, remainingAdmins: 2 },
      }),
      'in_progress',
    )
    const alone = classifySetupChange(
      membership({
        operation: 'delete',
        fields: [{ field: 'role', before: 'admin', after: null }],
        counts: { captures: 0, remainingAdmins: 0 },
      }),
      'in_progress',
    )
    const ids = (i: typeof alone) => i.consequences.map((c) => c.id)
    expect(ids(withOthers)).not.toContain('setup.impact.membership.remove-last-admin')
    expect(ids(alone)).toContain('setup.impact.membership.remove-last-admin')
  })

  it('says what a promotion into administering actually confers, and a demotion takes', () => {
    const up = classifySetupChange(
      membership({ fields: [{ field: 'role', before: 'evaluator', after: 'admin' }] }),
      'in_progress',
    )
    const down = classifySetupChange(
      membership({ fields: [{ field: 'role', before: 'admin', after: 'evaluator' }] }),
      'in_progress',
    )
    expect(up.consequences.map((c) => c.id)).toContain('setup.impact.membership.gains-admin')
    expect(down.consequences.map((c) => c.id)).toContain('setup.impact.membership.loses-admin')
    // A demotion is not cheaper than a promotion: both change who can do what.
    expect(up.severity).toBe('affects_future')
    expect(down.severity).toBe('affects_future')
  })

  it('humanizes the role words in the sentence but not in the rule', () => {
    const impact = classifySetupChange(
      membership({ fields: [{ field: 'role', before: 'chief_evaluator', after: 'admin' }] }),
      'in_progress',
    )
    const line = impact.consequences.find((c) => c.id === 'setup.impact.membership.role')
    expect(line?.tokens?.from).toBe('chief evaluator')
    // ...and the rule still read the raw value, or this line would not be here.
    expect(impact.consequences.map((c) => c.id)).toContain('setup.impact.membership.gains-admin')
  })

  /**
   * The carve-out that makes membership different from every other entity.
   *
   * `applyState` silences non-delete changes in a draft workshop, and the argument
   * for it is entirely about evidence: nothing has been captured, so nothing
   * recorded can be harmed. A promotion harms no evidence in ANY state; its cost is
   * authority. Left under the blanket rule, making somebody an admin of a workshop
   * that has not started would have committed with no dialog at all.
   */
  it('does not take the draft discount, unlike every other entity', () => {
    const promotion = classifySetupChange(
      membership({ fields: [{ field: 'role', before: 'evaluator', after: 'admin' }] }),
      'draft',
    )
    expect(promotion.severity).toBe('affects_future')
    expect(promotion.silent).toBe(false)

    const rename = classifySetupChange(
      {
        entity: 'participant',
        operation: 'update',
        entityId: 'p1',
        label: 'Amos',
        fields: [{ field: 'invented_later', before: 'a', after: 'b' }],
      },
      'draft',
    )
    expect(rename.silent).toBe(true)
  })

  it('treats issuing and withdrawing an invitation as silent but still loggable', () => {
    for (const operation of ['create', 'delete'] as const) {
      const impact = classifySetupChange(
        { entity: 'invitation', operation, entityId: 'i1', label: 'a@b.org' },
        'in_progress',
      )
      expect(impact.severity).toBe('safe')
      expect(impact.silent).toBe(true)
    }
  })
})

describe('the matrix decides which invitation roles are offered', () => {
  it('offers a chief admin everything but chief admin, and an admin only evaluator', () => {
    expect(grantableRoles('chief_admin', null)).toEqual([
      'admin',
      'chief_evaluator',
      'consultant',
      'evaluator',
      'participant',
    ])
    expect(grantableRoles('admin', null)).toEqual(['evaluator'])
    expect(grantableRoles('evaluator', null)).toEqual([])
    expect(canGrant('chief_admin', null, 'chief_admin')).toBe(false)
  })

  /**
   * The invitation table's own check constraint has to agree with the matrix, or
   * the UI offers a role the database refuses at a layer with no readable message.
   */
  it('and the invitation table refuses chief_admin structurally', () => {
    const check = MIGRATION.match(/role\s+text not null\s*\n\s*check \(role in \(([^)]*)\)\)/)
    expect(check).not.toBeNull()
    expect(check?.[1]).not.toContain('chief_admin')
    for (const role of grantableRoles('chief_admin', null)) {
      expect(check?.[1]).toContain(`'${role}'`)
    }
  })
})

describe('a failed sign-up, as the browser actually receives it', () => {
  /**
   * These two strings are not invented. They are what
   * `scripts/tl11-session-tests.mjs` recorded off the wire from Supabase Auth, and
   * they are pinned here because they are facts about somebody else's service:
   * if the wrapping changes, this fails rather than the sign-up form quietly
   * reverting to showing "Database error saving new user" to invited people.
   */
  it('recognizes the wrapper the auth service actually returns', () => {
    expect(classifySignupError('Database error saving new user')).toBe('invite-only')
    expect(classifySignupError('email rate limit exceeded')).toBe('email-rate-limit')
  })

  it('keeps the two apart, because they call for opposite advice', () => {
    // Telling somebody they were never invited when the real problem is the
    // project's email quota sends them to an administrator who can do nothing.
    expect(classifySignupError('email rate limit exceeded')).not.toBe('invite-only')
  })

  it('still recognizes the trigger message if the service ever stops swallowing it', () => {
    expect(
      classifySignupError('Email x@y.org has not been invited to a workshop. Ask the workshop administrator'),
    ).toBe('invite-only')
  })

  it('leaves an unrecognized failure as the server said it', () => {
    expect(classifySignupError('Password should be at least 6 characters')).toBe('other')
  })
})

/**
 * Every refusal these RPCs can raise should be sayable in the app's own words.
 *
 * `refusalText` falls back to the server's message when a node is missing, so a
 * gap here is not a broken screen — it is Postgres prose in a place the rest of the
 * app is editable, which is the failure the content layer exists to prevent, and it
 * is invisible until somebody trips the rule.
 */
describe('every refusal slug has words in chrome.json', () => {
  it('covers the slugs raised by tl-11 and by the tl-02 RPCs it reuses', () => {
    const chief = readFileSync(
      new URL('../supabase/migrations/20260731000300_chief_admin_and_matrix.sql', import.meta.url),
      'utf8',
    )
    const slugs = new Set(
      [...`${MIGRATION}\n${chief}`.matchAll(/raise_refusal\('([a-z0-9.\_]+)'/g)].map((m) => m[1]),
    )
    expect(slugs.size).toBeGreaterThan(10)
    const missing = [...slugs].filter((slug) => !findChromeNode(`people.refusal.${slug}`)?.label)
    expect(missing).toEqual([])
  })
})

/**
 * The tripwire for the count this spec could not gather.
 *
 * `assignedConversations` is classified by impact.ts and deliberately not gathered
 * by counts.ts, because `MentoringConversation.assigned_to` is tl-05's column and
 * does not exist on this branch. A filter on it would have counted zero forever and
 * read as "nobody is holding a follow-up" — a silent wrong answer in the dialog
 * whose entire value is that its numbers are real.
 *
 * So this fails the moment tl-05 merges, unless the count is wired at the same
 * time. It is written to fail loudly rather than to be remembered.
 */
describe('the assigned-conversations count is owed to whoever merges tl-05', () => {
  it('is gathered as soon as the column it needs exists', () => {
    const types = readFileSync(new URL('../src/lib/types.ts', import.meta.url), 'utf8')
    const counts = readFileSync(new URL('../src/setup/counts.ts', import.meta.url), 'utf8')
    const conversationBlock = types.slice(
      types.indexOf('interface MentoringConversation'),
      types.indexOf('interface MentoringConversation') + 2000,
    )
    const hasAssignedTo = /\bassigned_to\b/.test(conversationBlock)
    if (!hasAssignedTo) {
      expect(counts).toContain('assignedConversations` is deliberately NOT gathered')
      return
    }
    expect(
      /assignedConversations:/.test(counts),
      'MentoringConversation.assigned_to now exists (tl-05 merged), so countsForMembership must gather assignedConversations — impact.ts already has the consequence and will otherwise report zero forever.',
    ).toBe(true)
  })
})
