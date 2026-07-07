# Throughline — OBT Participant Evaluation (foundation slice)

A mobile-first field tool for capturing observer-led participant evaluation during
Oral Bible Translation (OBT) consulting workshops. It covers the data model, minimal
admin, the offline-first evaluator capture flow, and **routing** captures into
per-individual observations via Claude on a GitHub repo (no metered API — see below).
Report generation, the multi-evaluator verification gate, and CBC export are
**deferred to later phases** — the schema accommodates them but this repo does not
build them yet.

The app is named **Throughline** — every rating traces back through the evidence
behind it. (Internal storage identifiers still use the original `cairn` codename
to avoid orphaning on-device data; that is intentional and not user-visible.)

## What works now

- **Dictation:** Wispr Flow is the default input. The app just receives text, so
  native keyboard dictation or typing work too.
- **Sign in** with a name + email; the identity is stored on-device and attached to
  every evaluation, and it survives connectivity gaps.
- **Schedule-aware capture**: the home screen suggests the activity nearest to the
  current time; the evaluator can pick any other.
- **Per-question capture**: each activity shows its KSA questions as a short title
  plus an observation cue and "look/listen for" guiding questions. The evaluator
  dictates what they observed.
- **Optional quick read (0–3)**: per KSA, the evaluator can tap an optional 0–3
  (or leave it unset); the selected level's anchor shows inline and "All levels"
  reveals the full rubric. It is a *prior* the AI routing weighs against the text,
  not a final score; the multi-evaluator gate still rules. The buttons open
  *without stealing focus* from the text field, so dictation's word-by-word cursor
  insertion is never interrupted.
- **Glossary**: a focus-safe "Terms" popover defines the shared vocabulary
  (MTT, CLAT, ANE, Four Es / SENSES, FIA, ethnopoetics, …).
- **Participant tagging**: mark who an observation is about (individual or group),
  or switch on **focus mode** to attribute everything to one CIT for a clean capture.
- **Submission attestation**: confirm the text and that the input rules were followed;
  the ruleset version is stored on the evaluation.
- **Offline-first**: every change is written to IndexedDB immediately. Submissions
  enter an outbox and sync to Supabase when a connection is available. Nothing is lost
  to a bad connection.
- **Edit after submit**: open a submitted evaluation, edit in place, undo the last
  edit; a short edit history is retained.

## Tech

- React + Vite + TypeScript, installable **PWA** (`vite-plugin-pwa`).
- **Dexie** (IndexedDB) for the on-device store + outbox (`src/db/`).
- **Supabase** (Postgres + Auth) as the backend (`supabase/`).
- The app runs **local-only** when Supabase isn't configured: capture + offline
  persistence work; nothing syncs. This keeps it runnable before a backend exists.

## Routing (Claude Max on a GitHub repo — no metered API)

Routing turns each free-form capture into **individual-level observations** — one per
(participant, KSA) claim, with a 0–3 evidence designation, sentiment, a confidence
level, and a `needs_review` flag (low-confidence or unmatched-participant observations
are never guessed silently). This is what turns stored text into the structured
evidence reports and CBC submission draw on.

**It does not call a metered Claude API.** Routing is performed by Claude through a
Claude Max subscription, operating directly on a private GitHub repo. There is no
per-transaction cost. The flow:

```
app  →  routing/inbox/<id>.json   (a self-contained capture: text + in-scope KSAs + roster)
you  →  open Claude on the repo, "route the inbox per routing/ROUTING.md"
Claude → routing/outbox/<id>.json (observations matching routing/reference/schema.json)
app  →  imports outbox/ back into the device store → the Observations screen
```

Two ways to drive it, same file shapes:

- **Manual (no setup, fully phone-native).** On the **Routing** screen, "Copy pending
  captures" puts the captures on your clipboard; paste them to Claude (Max) with the
  repo's `ROUTING.md`, then paste Claude's JSON reply back into "Import observations."
  No credentials, no API.
- **Automated (optional).** Set `VITE_ROUTING_REPO` and enter a fine-grained GitHub
  token (Contents: read & write, scoped to that one private repo) on the Routing
  screen — stored on-device only. Then "Push pending → repo" and "Pull observations ←
  repo" are one tap each.

The contract is generated from the seed so what Claude sees always matches the app:

- `src/ai/contract.ts` — the routing rules, the output JSON schema, and a runtime
  validator for the (Claude-authored) observations the app imports.
- `src/ai/workspace.ts` — renders `routing/ROUTING.md` + `routing/reference/*` and
  defines the capture/observation file shapes.
- `src/routing/` — in-app config, a minimal GitHub Contents API client, and the
  push/pull + copy/paste operations.
- `npm run routing:prepare` regenerates `routing/`. Add `--synthetic` to seed
  `routing/inbox/` with field-like captures so you can test the Claude-via-Max routing
  end to end before any real data exists.

**Setting up the routing repo (automated path).** Create a **private** repo (e.g.
`you/cairn-routing`), run `npm run routing:prepare` and copy the generated `routing/`
contents into it (it holds `ROUTING.md`, `reference/`, and empty `inbox/`+`outbox/`),
push, then set `VITE_ROUTING_REPO` to it. The app then pushes real captures into that
private repo's `inbox/` — not into this code repo. The `routing/` folder committed
here is the scaffold plus synthetic example captures.

> Captures are low-sensitivity workshop notes, but the routing repo should be
> **private** and the GitHub token is a real credential — treat both like the Supabase
> keys: fine for the pilot, revisit before any wider rollout.

## Setup

```bash
npm install
npm run dev        # http://localhost:5173  — runs local-only with a seeded sample workshop
```

On first load you create a profile (name, email, role) stored on the device; everything
else runs local-only with the seeded Psalms Workshop, so a solo trial needs no backend.

## Put it on your phone

Two paths. Both run fully local (capture, routing by copy/paste with Claude, reports,
the verification gate) — no backend needed.

**Try it now over your wifi (no install).** On your computer:

```bash
npm run dev -- --host    # prints a Network URL like http://192.168.x.x:5173
```

Open that Network URL in your phone's browser (same wifi). You can use the whole app in
the browser. Note: installing to the home screen and true offline need HTTPS, so for the
real installable app use Pages below.

**Install for real (HTTPS, installable, offline-capable).** Deploy to GitHub Pages —
the workflow in `.github/workflows/deploy.yml` is ready:

1. Push this repo to GitHub (`git remote add origin … && git push -u origin main`).
2. In the repo: Settings → Pages → Source: **GitHub Actions**.
3. Wait for the "Deploy to GitHub Pages" action to finish; it prints an
   `https://<you>.github.io/<repo>/` URL.
4. Open that URL on your phone → browser menu → **Add to Home Screen**. It installs as
   the "Throughline" app and works offline.

To route observations from the phone with no setup, use the copy/paste path: on
Observations/Routing, "Copy pending captures" → paste into the Claude app (Max) with the
routing instructions → paste the JSON reply back. (A private routing repo + token, below,
makes this one-tap but isn't required to try the app.)

### Connect Supabase (optional for local dev, required for sync)

1. Create a project at supabase.com.
2. Apply the schema with the Supabase CLI: `supabase login`, `supabase link
   --project-ref <ref>`, then `supabase db push` (applies every file in
   `supabase/migrations/` in order). Optionally load `supabase/seed.sql` (the
   Psalms Workshop, Bali 2026 real 6-area KSA framework) via the SQL editor or
   `supabase db reset`. Full auth walkthrough: `docs/SETUP-AUTH.md`.
3. Copy `.env.example` to `.env` and fill in `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY` from Project Settings → API.
4. Restart `npm run dev`. The app now syncs the outbox and loads reference data from
   the backend.

> RLS note: the migration ships **permissive** row-level-security policies for the
> low-sensitivity pilot. Tighten them before any wider rollout.

## Verifying (manual, in a browser)

1. **Capture happy path** — sign in, pick an activity, type/dictate into a question
   field, tap a quick-read level and toggle "All levels" *while a field is focused*
   and confirm the cursor isn't disturbed, tag a participant, check the attestation
   box, submit. The evaluation appears in "My evaluations".
2. **Offline path** — open DevTools → Network → Offline. Create and submit an
   evaluation; it shows status "to sync". Reload the page mid-entry and confirm
   nothing is lost. Go back online and (with Supabase configured) confirm it flips to
   "synced".
3. **Edit path** — open a submitted evaluation, click into a field, change the text,
   Save changes, then Undo last edit and confirm the prior text returns.
4. **Install** — add to home screen on iOS and Android; confirm dictation inserts into
   fields on both.
5. **Routing (manual)** — `npm run routing:prepare --synthetic` to seed `routing/inbox/`,
   commit, then route it with Claude (Max) on the repo per `routing/ROUTING.md`; or in
   the app, "Copy pending captures" → paste to Claude → paste the reply into "Import
   observations" and confirm rows appear on the Observations screen.
6. **Verify + finalize** — on Observations, Confirm/Adjust/Reject each observation as an
   evaluator; a participant's report stays **locked** on Reports until every observation
   is confirmed by the required number of evaluators (set in Admin → Verification, or
   `VITE_REQUIRED_CONFIRMATIONS`; default 2), then "Finalize: copy report" produces the
   verified markdown.

## Reports and the verification gate

Reports are a **deterministic rollup** (no AI): per participant, per KSA, the
representative 0–3 is the max of the counting designations, with quotes behind every
number, a conflict flag when designations spread by 2+, and a CBC sub-point view.

The **multi-evaluator gate** sits on top: each observation collects evaluator verdicts
(confirm / adjust to a different 0–3 / reject). An observation is `verified` once N
evaluators confirm, `adjusted` when they agree on a different value, `disputed` on any
reject or disagreement, else `pending`. A participant's report is **ready to finalize**
only when all of their observations are verified or adjusted; a verified/adjusted item
counts (at its agreed value) even if routing flagged it, and a disputed item drops out.
`npm run report:preview` and `npm run gate:preview` exercise this headlessly.

**Cross-device sync.** Evaluators confirm on their own phones, so verdicts sync through
the routing repo — conflict-free because each evaluator owns exactly one file,
`routing/verdicts/<evaluator>.json`, and a device only ever writes its own. On the
Observations screen, **Sync now** pulls the latest observations, pushes this device's
verdicts, and pulls everyone else's (replacing each other evaluator's set wholesale, so
their deletions propagate); the gate then aggregates the union. A copy/paste path does
the same without a token. `src/routing/verdicts.ts` holds the logic.

## Project map

- `src/lib/` — Supabase client, shared types, input ruleset, source-text composer.
- `src/db/` — Dexie schema (`local.ts`, incl. `observations` + `verifications`),
  reference cache (`reference.ts`), evaluations (`evaluations.ts`), verdicts
  (`verifications.ts`), outbox sync worker (`sync.ts`).
- `src/ai/` — the routing **contract** (`contract.ts`: rules + schema + validator) and
  workspace generators (`workspace.ts`); `synthetic.ts` field-like test captures.
- `src/routing/` — GitHub round-trip: `config.ts`, Contents API client (`github.ts`),
  capture/observation push/pull + copy-paste (`operations.ts`), cross-device verdict
  sync (`verdicts.ts`).
- `src/reports/` — `build.ts` (rollup, verification-aware), `markdown.ts` (export),
  `verification.ts` (the gate logic).
- `src/auth/` — lightweight, offline-tolerant identity.
- `src/pages/` — SignIn, EvaluatorHome, CaptureActivity, MyEvaluations, Routing,
  Observations (+ verify controls), Reports, Admin.
- `src/components/` — QuickRating (focus-safe 0–3 + inline anchors), Glossary
  (focus-safe terms), RubricPanel (legacy full-rubric panel), SyncStatusBar,
  useOnline, VerifyControls, VerdictSync.
- `routing/` — the generated routing workspace (ROUTING.md + reference/ + inbox/outbox/
  + app-managed verdicts/).
- `supabase/` — schema migrations + seed SQL.

## Deferred (later phases)

- Author the real 0–3 evidence-level descriptors per KSA (currently draft placeholders).
- Optional narrative report layer: Claude (Max) writes participant-facing prose from the rollup.
- Report delivery (email) + a daily-vs-final report distinction.
- CBC competency-platform export pipeline (Phase 2, with the org programmer).
- Server-side translation (only if non-English capture is needed; Bali runs in English).
- On-device STT / translation for true offline (only if a deployment needs it).
- A real auth method (password / magic link) + verdict provenance/trust.
