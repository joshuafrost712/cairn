# In-app dev feedback widget — the reusable pattern

This documents the highlight → comment → rank → "send batch to Claude" system
built into Cairn (`src/devfeedback/`), written so the same interaction can be
dropped into other apps we refine. Cairn is the reference implementation; the
Local Genres app already runs the same module. Origo (vanilla JS) gets a
variant, sketched at the end.

## What the interaction is

While using the app, Josh leaves feedback in place instead of context-switching
to write it up elsewhere:

1. **Highlight** any text on any page. A small "💬 Comment" button appears at
   the selection (or press Cmd/Ctrl+Shift+C, which also works with nothing
   selected for a page-level note).
2. A **comment window** opens, pre-filled with the highlighted text, the current
   route, and a guess at the on-page location (nearest heading). Write the
   comment, pick an importance (High/Med/Low), save.
3. A floating **"🛠 Feedback (N)"** button opens the **manager**: review every
   open comment, re-rank, edit, delete.
4. **"Send batch to Claude"** ships the whole set as one markdown file.

The batch is consumed **holistically** — Claude reads all of it, finds
overarching patterns, and proposes one consolidated plan. It does not act on
comments one at a time. (See `feedback/README.md`.)

## Design principles (why it ports cleanly)

1. **Self-contained module.** Everything lives under `src/devfeedback/`. Adopting
   it touches the host app in exactly two places: one mount line and one
   Vite-config block. No app code imports into the module.
2. **Isolated storage.** Comments live in their own IndexedDB database
   (`<app>-dev-feedback` via Dexie), never the app's production store. No schema
   migration on the real DB, no entanglement with any sync. Wiping feedback has
   zero effect on real data.
3. **Style-system-agnostic.** The module ships its own scoped CSS (every class
   prefixed `.dfb-`, its own colors and fonts). It looks the same in a plain-CSS
   app (Cairn) and a Tailwind app (Genre) with no integration work.
4. **Transport is one swappable function** (`send.ts`). Today it POSTs to a
   dev-only endpoint and falls back to a file download. Swap that one function to
   change how batches travel without touching the UI.
5. **Dev-gated, but reliably reachable.** `enabled.ts` mounts the tools only in
   `vite dev` or when `localStorage['<app>.dev'] === '1'`. Real users never see
   them. To turn them on in a deployed/installed build, open the app once with
   `?dev=1` in the URL (it persists to localStorage on that device); `?dev=0`
   turns them off. See "Accessing it reliably" below.

## Accessing it reliably

Two dependable paths, by where you are:

- **Local, full loop (recommended).** `cd <repo> && npm run dev`, open the
  printed `localhost` URL. The tools are on automatically, and "Send batch"
  writes straight to `feedback/incoming/` in the repo. This is the reliable way
  to actually round-trip feedback to Claude.
- **Deployed / installed PWA / phone.** Open the app URL once with `?dev=1`
  (e.g. `https://…/app/?dev=1`); the tools stay on for good on that device, so
  you can bookmark it or add it to the home screen. The capture/manager UI works
  fully, but the dev-server endpoint isn't there, so "Send batch" falls back to
  downloading the markdown file — you then drop that file into the repo's
  `feedback/incoming/`. (If phone-to-repo delivery needs to be hands-free,
  swap `send.ts` to commit via the app's GitHub client instead of downloading.)

## File map (`src/devfeedback/`)

- `enabled.ts` — the dev-flag gate (`isFeedbackEnabled()`).
- `db.ts` — the isolated Dexie DB, the `FeedbackComment` shape, and CRUD helpers.
- `feedbackContext.ts` — React context + `useFeedback()` hook (kept component-free
  so Fast Refresh / `react-refresh/only-export-components` stays happy).
- `FeedbackProvider.tsx` — context provider (open/close state for the comment
  window and manager, and the current draft selection).
- `SelectionLayer.tsx` — global selection listener; the floating "Comment" button
  and the keyboard shortcut; derives the location label from the DOM.
- `CommentWindow.tsx` — the comment popover (selection + location + textarea +
  importance).
- `FeedbackManager.tsx` — the slide-over: list, re-rank, edit, delete, send.
- `render.ts` — `renderBatchMarkdown()`: the batch document (handling header,
  glance summary, comments grouped by importance, raw JSON block).
- `send.ts` — `sendBatch()`: POST to `/__feedback`, download fallback.
- `DevFeedbackRoot.tsx` — the single mount point; returns `null` unless enabled.
- `devfeedback.css` — scoped styles.

## The transport: a dev-only Vite endpoint

`send.ts` POSTs `{ filename, markdown }` to `${BASE_URL}__feedback`. A tiny inline
Vite plugin (`configureServer`) in the host app's `vite.config.ts` handles that
request and writes the markdown to `feedback/incoming/<name>.md` under the repo
root (`process.cwd()`). Because it lives only in the dev server, the deployed PWA
never exposes it — which is fine, since the UI is dev-gated too. If the endpoint
is unreachable (e.g. a deployed build with the flag hand-set), `send.ts` falls
back to downloading the markdown so it can be moved into the repo by hand.

Repo plumbing each app needs:

- `feedback/incoming/` and `feedback/processed/` (each with a `.gitkeep`).
- `feedback/README.md` — the consume protocol below.
- `.gitignore` entries that ignore the batch files but keep the folders + README
  (batches are transient working artifacts, not history).

## The consume protocol (how Claude handles a batch)

When Josh says "review the feedback batch": read **all** files in
`feedback/incoming/`, cluster them by theme and shared root cause (noting the
importance ranks), present **one consolidated plan** grouped by pattern (not a
per-comment to-do list), get approval, implement, then move the processed files
to `feedback/processed/`. Never act on a single comment in isolation. This is the
whole point — overarching issues are easier and safer to fix all at once.

## Porting checklist — a React + Vite app

This took ~10 minutes for the Genre app, which shares Cairn's stack (React 19, TS,
Vite, Dexie, react-router, vite-plugin-pwa).

1. **Copy** `src/devfeedback/` into the target app.
2. **Rename the flag and DB** for the app: `DEV_FLAG_KEY` in `enabled.ts`
   (`'<app>.dev'`), the `super('<app>-dev-feedback')` name in `db.ts`, and the
   batch `schema` id in `render.ts`. Nothing else is app-specific.
3. **Mount** `<DevFeedbackRoot />` once, inside the router (it reads the route),
   alongside the app shell. In Cairn that's inside `<BrowserRouter>` in
   `src/App.tsx`; in the Genre app it's next to `<QuickJot />` in
   `src/components/Layout.tsx`.
4. **Add the Vite plugin** (`feedbackInbox()`) to the app's `vite.config.ts` and
   put it first in the `plugins` array.
5. **Add the repo plumbing** (`feedback/` folders, README, `.gitignore`).
6. **Verify:** `npm run build` compiles; `npm run dev`, flip on the flag, select
   text → comment → rank → send, and confirm a file lands in `feedback/incoming/`.

Requirements on the host app: it uses Vite, react-router (for `useLocation`),
and has `dexie` + `dexie-react-hooks` as dependencies (both Cairn-stack apps do).

## Origo variant (built)

Origo is vanilla JS served by FastAPI, composed of tool viewers inside iframes —
no React, no shared layout chrome, so the React module can't drop in. It has its
own self-contained port, shipped as two files:

- `search_server/static/feedback.js` — the whole widget in plain DOM (gate,
  isolated IndexedDB via raw `indexedDB`, comment window, manager, batch render,
  send), and `feedback.css` — the same `.dfb-` styles copied near-verbatim.
- Loaded once by the **app shell** (`static/app-shell.html`) via a `<link>` +
  `<script defer>`; no viewer HTML is touched.
- **Selection capture:** because the viewers are *same-origin* iframes, the shell
  reaches into each `iframe.contentDocument` directly (a `MutationObserver` on
  `#views` + each iframe's `load` event attach the `mouseup` / `keyup` /
  `selectionchange` listeners), and positions the shell-level "Comment" button
  using the iframe's `getBoundingClientRect()` offset. This is simpler than the
  `postMessage` relay first sketched here; the relay remains the fallback if a
  viewer is ever served cross-origin (the shell already listens on `message`).
- **Transport:** a `POST /__feedback` route in `search_server/app.py` writes
  `<repo>/feedback/incoming/<name>.md` — the cleaner analogue of the Vite plugin,
  available under the normal `bash run.sh` server with no dev server.
- **Gate:** auto-on when the host is `localhost`/`127.0.0.1`; otherwise off
  unless `localStorage['origo.dev'] === '1'` (`?dev=1` / `?dev=0` toggles it).

The batch format (schema id `origo.feedback-batch/v1`), the importance ranking,
and the consume protocol carry over unchanged; only the capture surface and the
host differ.
