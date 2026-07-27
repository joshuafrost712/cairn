# Self-hosting the backend (Supabase) on SIL infrastructure

For SIL's technology team. ThruLine (and, when its optional cloud features are
enabled, the genre-research-app) use **Supabase** as their backend: managed
Postgres, an auth service (GoTrue), and Realtime. This runbook covers standing that
up on SIL servers so all data lives on SIL infrastructure.

## The three options, and our recommendation

1. **Self-host Supabase on SIL (recommended).** Supabase is open source and ships as
   a Docker Compose stack. Running it on SIL infrastructure keeps every row on SIL
   servers, and the app's existing migrations, RLS policies, Realtime, and Edge
   Functions all work unchanged — no application code changes. This is the option
   the rest of this doc describes.
2. **SIL-owned managed Supabase cloud.** Least operational effort: create a Supabase
   cloud project under an SIL-owned organization account. Same zero code changes,
   but data lives at supabase.com rather than on SIL metal. A reasonable interim
   step while self-hosting is set up.
3. **Rebuild on SIL's native Postgres + auth.** Most SIL-native, largest effort:
   reimplement the data/auth layer against SIL's own Postgres and an existing auth
   service. This loses RLS and Realtime "for free" and touches
   `src/lib/supabase.ts` plus the four backend modules (`src/db/reference.ts`,
   `src/db/referenceWrite.ts`, `src/db/sync.ts`, `src/db/coverage.ts`,
   `src/auth/AuthContext.tsx`). Consider only if SIL policy forbids running the
   Supabase stack.

## Self-hosting steps (option 1)

1. **Provision a host** and install Docker + the Supabase self-host stack (Supabase
   publishes a `docker-compose.yml` and `.env` template). Put it behind SIL's
   reverse proxy with TLS. Note the resulting **API URL** and **anon key** — these
   become the app's `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

2. **Apply the schema.** From the app repo, with the Supabase CLI pointed at the SIL
   instance:
   ```
   supabase db push          # applies supabase/migrations/ in order
   ```
   This creates all tables, the `updated_at` trigger, the auth join + invite-only
   signup trigger, the Realtime publication, and the RLS policies.

3. **Seed reference data.**
   ```
   supabase db query --linked -f supabase/seed.sql
   ```
   Loads the sample workshop (roster + KSA framework). Optional if scenarios will be
   authored fresh in the Scenario Builder instead.

4. **Configure auth.**
   - Add the initial users to the `role_allowlist` table (invite-only signup reads
     it). Manage this as data, not in a migration — see `docs/SETUP-AUTH.md`.
   - Point SMTP at an SIL mail server if email confirmation / password reset is
     wanted; otherwise keep confirmation off (the pilot default).
   - Set the site URL / redirect allow-list to the SIL hosting origin.

5. **Realtime.** The migration already adds the `evaluation` table to the
   `supabase_realtime` publication (live evaluation-coverage cue). Confirm Realtime
   is enabled in the self-host stack.

6. **Edge Function + AI key (ThruLine only).**
   ```
   supabase functions deploy draft-scenario
   supabase secrets set GEMINI_API_KEY=<google-ai-studio-key>
   ```
   Powers the Scenario Builder's "draft from a document". Optional — there is a
   copy/paste fallback. See the data-handling note in `docs/DEPLOYMENT-SIL.md`
   about the Gemini free tier.

## Backups

Standard Postgres backups of the Supabase database cover all application data
(evaluations, observations, verdicts, mentoring conversations, reference/scenario
content). The app also has an in-app JSON backup/restore (Admin → Backup) for
per-device data, but the authoritative store once a backend is live is Postgres.

## Verifying the backend is actually populated

A subtle failure we hit once: a migration history can be marked "applied" against a
database that has **zero tables** (a fresh DB where only the history was stamped).
After `db push`, verify the tables exist and are seeded:

```
supabase db query --linked -f - <<'SQL'
select 'participants' as t, count(*) from participant
union all select 'activities', count(*) from activity
union all select 'ksas', count(*) from ksa;
SQL
```

Expect non-zero counts if you seeded. If counts are zero but migrations show as
applied, the migration history was stamped without running — repair with
`supabase migration repair --status reverted <version>` then `supabase db push`.
