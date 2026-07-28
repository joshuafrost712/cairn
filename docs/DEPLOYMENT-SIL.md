# Deploying ThruLine on SIL infrastructure

This document is written for SIL's technology team. It describes everything needed
to host **ThruLine** (the OBT participant-evaluation app; repo codename `cairn`,
product name "Honest Eval") as an official SIL-hosted website with the database and
backend on SIL infrastructure, rather than the current GitHub Pages + managed
Supabase setup.

Companion docs:
- `docs/SELF-HOST-SUPABASE.md` — how to stand up the backend on SIL servers.
- `docs/SETUP-AUTH.md` — the auth model and provisioning steps (already in this repo).

## What ThruLine is, in one paragraph

ThruLine is a **100% static frontend Progressive Web App** (React + Vite +
TypeScript). It works fully offline: every evaluation is written to the browser's
IndexedDB immediately and syncs up when a backend is present. The only backend it
needs is a **Supabase instance** (managed Postgres + Auth + Realtime), and one small
**Edge Function** (`draft-scenario`) that calls Google Gemini to draft evaluation
scenarios from an uploaded document. There is no other server-side code. If Supabase
is absent the app still runs, in local-only mode, on a single device.

## What SIL needs to provide

1. **Static web hosting over HTTPS.** The build output is a folder of static files
   (`dist/`). Any static host works: Apache/nginx/IIS, or an object store + CDN.
   Two requirements:
   - **HTTPS is mandatory** — the app is an installable PWA with a service worker,
     which browsers only allow over HTTPS.
   - **SPA fallback**: unknown paths must serve `index.html` so client-side routes
     and page refreshes resolve. (On GitHub Pages we do this by copying
     `index.html` to `404.html`; on nginx it is `try_files $uri /index.html;`.)
   - Host at a **domain root** (e.g. `https://honesteval.sil.org/`) so the default
     base path `/` is correct. To host under a subpath (e.g. `.../honesteval/`), set
     the `VITE_BASE` build variable to that subpath (see below).

2. **A build step.** Node 20+, then `npm ci && npm run build`. The output is
   entirely static — the build can run in GitHub Actions (as it does today), in
   SIL's CI, or by hand. The current CI workflow is `.github/workflows/deploy.yml`;
   it can be repointed at SIL hosting or replaced.

3. **A Supabase backend** — see `docs/SELF-HOST-SUPABASE.md`. The recommended option
   is self-hosting Supabase on SIL infrastructure so all data lives on SIL servers.

## Build-time configuration

All app configuration is Vite build-time variables (prefixed `VITE_`) and is baked
into the static bundle at build time. There is a `.env.example` in the repo root.

| Variable | Required? | Purpose | Read at |
|---|---|---|---|
| `VITE_SUPABASE_URL` | for backend | Supabase project/instance URL | `src/lib/supabase.ts` |
| `VITE_SUPABASE_ANON_KEY` | for backend | Supabase anon (publishable) key | `src/lib/supabase.ts` |
| `VITE_BASE` | if subpath | base path, e.g. `/honesteval/`; default `/` | `vite.config.ts` |
| `VITE_REQUIRED_CONFIRMATIONS` | optional | evaluators who must confirm an observation (default 2) | `src/reports/verification.ts` |
| `VITE_ROUTING_REPO`, `VITE_ROUTING_BRANCH` | optional | private GitHub repo for the AI observation-routing round-trip (has a token-free copy/paste fallback) | `src/routing/config.ts` |

The **anon key is public by design** — it ships in the browser bundle. Real access
control comes from Postgres Row-Level Security (RLS), not from hiding the key. See
"Security hardening" below.

The **Gemini API key is NOT a build variable**. It lives server-side as a Supabase
Edge Function secret (`GEMINI_API_KEY`), so it is never exposed to the browser.

## Database schema and auth

- The full schema is in `supabase/migrations/`, applied in filename order by
  `supabase db push`. It covers the core tables (`workshop`, `team`, `participant`,
  `activity`, `ksa`, `activity_ksa`, `evaluation`, `observation`,
  `mentoring_conversation`), the auth join (`app_user`), Realtime, and the
  invite-only role allowlist.
- Reference seed data (the sample Psalms workshop) is in `supabase/seed.sql`.
- **Auth** is email + password via Supabase Auth (GoTrue), invite-only: an email
  must be present in the `role_allowlist` table before it can register. Roles:
  `evaluator | consultant | chief_evaluator | admin | participant`. Full detail and
  provisioning steps are in `docs/SETUP-AUTH.md`.

## The Gemini Edge Function (`draft-scenario`)

The Scenario Builder can draft a whole evaluation scenario from an uploaded
curriculum. That single AI call runs in `supabase/functions/draft-scenario/`, which
holds the Gemini key server-side and calls the Google Generative Language API
(Gemini free tier). To enable it:

```
supabase functions deploy draft-scenario
supabase secrets set GEMINI_API_KEY=<google-ai-studio-key>   # optional: GEMINI_MODEL
```

If the function is not deployed, the Builder automatically falls back to a
token-free **copy/paste path** (it generates a prompt the author pastes into any
LLM, then pastes the JSON back), so scenario drafting works with no server AI at
all.

**Data-handling note for SIL:** the Gemini *free tier* permits Google to use
submitted content to improve its products. The app warns authors not to paste
confidential material and offers the copy/paste path as an alternative. If SIL
wants stronger guarantees, switch the function to a paid Gemini tier (data not used
for training) or another provider — only `supabase/functions/draft-scenario/` and
the `GEMINI_API_KEY` secret change; the rest of the app is unaffected.

## Runtime dependencies summary

| Dependency | Needed for | Notes |
|---|---|---|
| Static HTTPS host | serving the app | any web server / CDN |
| Supabase (Postgres + Auth + Realtime) | login, cross-device sync, live coverage | self-host recommended; app degrades to local-only without it |
| Supabase Edge Function + Gemini key | one-click scenario drafting | optional; copy/paste fallback needs nothing |
| SMTP server | email confirmation / password reset | only if those are turned on |
| GitHub repo + fine-grained PAT | automated AI observation routing | optional; copy/paste fallback needs nothing |

No Node server, no other serverless functions, and no metered API are required to
run the core app.

## Security hardening backlog (do before wider rollout)

The pilot RLS is intentionally permissive; the code and migration headers flag these
as production tasks:

1. **Tighten RLS.** Data-table writes are currently allowed to *any* authenticated
   session (`*_write ... to authenticated`). Scope writes to the appropriate roles
   (e.g. only `admin`/`chief_evaluator` may author scenarios or edit the roster).
   See `supabase/migrations/20260707000600_role_allowlist_and_rls.sql`.
2. **Move the seeded roster out of a migration.** That same migration hardcodes real
   email addresses (including `josh_frost@sil.org`) into `role_allowlist`. Manage
   the allowlist as data (dashboard/service_role), not in version-controlled SQL.
3. **Rotate secrets on handoff.** The repo's on-disk `.env` (gitignored) contains a
   live Supabase URL + anon key for the current managed project. Issue fresh
   credentials for the SIL instance and retire the old project.
4. **Email flows.** Turn on SMTP and a real password-reset flow if the deployment
   needs them (the pilot ran with email confirmation off).

## Quick verification after deploying

1. Load the site over HTTPS; confirm the sign-in screen appears and the browser
   offers "Install app".
2. Sign in with an allowlisted account; confirm the workshop and its activities
   load (proves reference read from the backend).
3. Capture a test evaluation on one device and confirm it appears on a second
   device (proves sync + Realtime).
4. Open **Scenario Builder → Draft from a document**, upload a small text file, and
   confirm either the Gemini path returns a draft or the copy/paste path works.
