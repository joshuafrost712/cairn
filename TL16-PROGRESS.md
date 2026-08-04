# tl-16 progress (delete before merge)

Branch `feature/tl-16-output-templates`, worktree `~/Documents/GitHub/cairn-tl16`.
Commit `d9d2be6` holds the build; the security-definer fix and the harness are uncommitted.

## Done

- Pure layer: `src/templates/{defaults,interpolate,resolve,validate}.ts`.
- Migration `20260808000100_ai_templates.sql` — **applied live** via
  `scripts/apply-migration.mjs` because `supabase db push` HANGS on this network
  (tl-15 hit the same). **`supabase migration repair --status applied 20260808000100`
  is OWED.** tl-15's owed repair (`20260807000100`) was discharged this session, so
  all 28 prior migrations matched local to remote before this one went in.
- Dexie **v19** (`aiTemplates`), reference-outbox order **13**. Both were claimed and
  handed forward since tl-14; this is the spec that spends them.
- Generators templated: `participantEmail.ts`, `eventDigest.ts`, `markdown.ts`.
- Instructions templated: `contract.ts`, `scenarioContract.ts`, `guidancePrompt.ts`,
  `brief.ts`. Relay prompt bundle regenerated; bundler now also exports `scenarioRules`.
- Both Edge Functions read the authored body from Postgres. `draft-scenario`'s
  duplicated rules copy deleted (the two had drifted).
- `src/devfeedback/applyProposal.ts` is the one apply path; `ProposalPanel` refactored
  onto it. `ProposalTable` gains `ai_template`, no fdb version bump.
- `src/setup/sections/TemplatesSection.tsx` replaces the placeholder
  (`AiAndTemplates.tsx` deleted). tl-07 gains a `template` entity + `countsForTemplate`.
- 43 chrome nodes added; `setup.templates.pending` replaced by `.intro`.
- `test/templates.test.ts` (57), `test/tl16DefaultOutput.test.ts` (cross-build fixture),
  `test/routingAdminOnly.test.ts` exemption for `setup.templates.group.` only.
- **1,266 unit tests, tsc + eslint + build clean.**
- **Byte-identical gate MET**: 17 rendered documents/instruction blocks, 22,125 bytes,
  identical between `main` and this branch. Fixture generated FROM MAIN.
- `scripts/tl16-session-tests.mjs` — **25/25 on the wire.**

## What the session-test harness caught (worth keeping in the record)

The trigger function `ai_template_is_permitted()` was not `security definer`, so it ran
as the invoking role and could not execute `ai_template_is_legal`, whose EXECUTE is
revoked from `authenticated` by design. Every write — including a legitimate workshop
admin's — came back **42501, indistinguishable from an RLS refusal**, so the feature was
dead for everybody while every negative check in the harness passed for the wrong
reason. Caught only because the harness asserts the PERMITTED direction too.

## Still to do

1. Browser walkthrough at 390px and 1280px (author → propose → approve → revert),
   plus opening the screenshots (the protocol's half a person has to do).
2. `npm run` the two-viewport audit (`scripts/ui-responsive-audit.mjs`) — the Setup
   templates section is a new route in `ROUTES`.
3. Second-AI review (`/code-review`), apply fixes.
4. Delete this file, commit, merge `--no-ff` to `main`, push, verify the deployed
   bundle greps for a tl-16 string.
5. Write the spec record into `16-spec-tl-16-output-templates.md` §Review record, update
   `00-program-throughline.md` (order 20 → done; D5 counters spent), session log + daily
   note, and the memory file.
