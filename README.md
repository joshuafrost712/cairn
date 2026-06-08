# Cairn — OBT Participant Evaluation (foundation slice)

A mobile-first field tool for capturing observer-led participant evaluation during
Oral Bible Translation (OBT) consulting workshops. This repo is the **foundation
slice** of the Participant Evaluation MVP: data model + minimal admin + the evaluator
capture flow with offline-first local persistence. The AI layer (translation,
routing-to-individuals, report generation), the multi-evaluator verification gate,
and CBC export are **deferred to later phases** — the schema accommodates them but
this slice does not build them.

"Cairn" is a working codename, renamable.

## What works now

- **Dictation:** Wispr Flow is the default input. The app just receives text, so
  native keyboard dictation or typing work too.
- **Sign in** with a name + email; the identity is stored on-device and attached to
  every evaluation, and it survives connectivity gaps.
- **Schedule-aware capture**: the home screen suggests the activity nearest to the
  current time; the evaluator can pick any other.
- **Per-question capture**: each activity shows its KSA questions, each with a
  collapsible **evidence-levels (0–3) rubric panel** that opens *without stealing
  focus* from the text field (so dictation's word-by-word cursor insertion is never
  interrupted).
- **Participant tagging**: mark who an observation is about (individual or group).
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

## AI routing layer (built; needs an API key to run)

The routing layer turns each free-form capture into **individual-level observations** —
one per (participant, KSA) claim, with a 0–3 evidence designation, sentiment, a
confidence level, and a `needs_review` flag (low-confidence or unmatched-participant
observations are never guessed silently). This is what turns stored text into the
structured evidence reports and CBC submission draw on.

- `src/ai/prompt.ts` — runtime-agnostic: frozen instructions + the activity's KSA
  rubric and roster as **prompt-cached** system blocks, the JSON-schema for structured
  output, and the model/pricing. Shared by both runtimes below.
- `src/ai/route.ts` — Node routing function (Anthropic SDK, `claude-opus-4-8`,
  adaptive thinking, structured output). Resolves participant names against the roster.
- `src/ai/cost.ts` — per-call cost logging + a configurable **spend cap**.
- `scripts/calibrate.ts` — runs synthetic field-like evaluations through routing and
  prints the structured observations (the start of the calibration workstream). Run:
  `ANTHROPIC_API_KEY=sk-... npm run calibrate` (cap via `CLAUDE_SPEND_CAP_USD`,
  default 5; per-call log written to `calibration-log.jsonl`).
- `supabase/functions/route-evaluation/` — Deno Edge Function wrapping the same
  contract for deployment: fetches an evaluation, routes it, inserts `observation`
  rows, logs the call to `claude_call_log`, and enforces a monthly cap. Deferred-deploy.

## Setup

```bash
npm install
npm run dev        # http://localhost:5173  — runs local-only with a seeded sample workshop
```

### Connect Supabase (optional for local dev, required for sync)

1. Create a project at supabase.com.
2. In the SQL editor, run `supabase/migrations/0001_foundation_schema.sql`, then
   `supabase/seed.sql` (the Psalms Workshop, Bali 2026 — real 6-area KSA framework;
   draft 0–3 evidence levels; placeholder CIT roster).
3. Copy `.env.example` to `.env` and fill in `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY` from Project Settings → API.
4. Restart `npm run dev`. The app now syncs the outbox and loads reference data from
   the backend.

> RLS note: the migration ships **permissive** row-level-security policies for the
> low-sensitivity pilot. Tighten them before any wider rollout.

## Verifying (manual, in a browser)

1. **Capture happy path** — sign in, pick an activity, type/dictate into a question
   field, toggle the rubric panel *while a field is focused* and confirm the cursor
   isn't disturbed, tag a participant, check the attestation box, submit. The
   evaluation appears in "My evaluations".
2. **Offline path** — open DevTools → Network → Offline. Create and submit an
   evaluation; it shows status "to sync". Reload the page mid-entry and confirm
   nothing is lost. Go back online and (with Supabase configured) confirm it flips to
   "synced".
3. **Edit path** — open a submitted evaluation, click into a field, change the text,
   Save changes, then Undo last edit and confirm the prior text returns.
4. **Install** — add to home screen on iOS and Android; confirm dictation inserts into
   fields on both.

## Project map

- `src/lib/` — Supabase client, shared types, input ruleset, source-text composer.
- `src/db/` — Dexie schema (`local.ts`), reference-data cache (`reference.ts`),
  evaluations repo (`evaluations.ts`), outbox sync worker (`sync.ts`).
- `src/auth/` — lightweight, offline-tolerant identity.
- `src/pages/` — SignIn, EvaluatorHome, CaptureActivity, MyEvaluations, Admin.
- `src/components/` — RubricPanel (focus-safe), SyncStatusBar, useOnline.
- `supabase/` — schema migration + seed SQL.

## Deferred (later phases)

- AI layer: server-side translation, routing free-form captures into per-individual
  observations (0–3 against CBC sub-points), sentiment lexicon + needs-review path.
- Daily / final report generation + email; multi-evaluator verification gate.
- CBC competency-platform export pipeline.
- On-device STT / translation for true offline (only if a deployment needs it).
- Raster PWA icons (192/512 png); a real auth method (password / magic link).
