import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Base path the app is served under. Root by default (custom domain / Netlify);
// the GitHub Pages workflow sets VITE_BASE=/<repo>/ for a project page.
const base = process.env.VITE_BASE ?? '/'

// Dev-only endpoint backing the in-app feedback tools (src/devfeedback). It
// writes each submitted batch to feedback/incoming/<name>.md in the repo so
// Claude can read it next session. Exists only in `vite dev`, never in a build.
function feedbackInbox(): Plugin {
  return {
    name: 'cairn-feedback-inbox',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'POST' || !req.url?.split('?')[0].endsWith('/__feedback')) return next()
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          try {
            const { filename, markdown } = JSON.parse(body) as { filename?: string; markdown?: string }
            const safe = basename(filename ?? 'feedback.md').replace(/[^\w.-]/g, '_')
            const name = safe.endsWith('.md') ? safe : `${safe}.md`
            const dir = join(process.cwd(), 'feedback', 'incoming')
            mkdirSync(dir, { recursive: true })
            writeFileSync(join(dir, name), markdown ?? '')
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ path: `feedback/incoming/${name}` }))
          } catch (err) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })
    },
  }
}

/** Shared body reader for the small dev-only JSON endpoints below. */
function readJsonBody(
  req: { on: (ev: string, cb: (chunk?: unknown) => void) => void },
  done: (parsed: unknown, raw: string) => void,
) {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    try {
      done(JSON.parse(body), body)
    } catch {
      done(null, body)
    }
  })
}

// Dev-only endpoint for edit-in-place on CHROME copy: applies a structured
// {nodeId, field, oldText, newText} edit to src/content/chrome.json. The old text
// must still match the file's current value (409 otherwise), so a page left open
// on a stale render can never silently clobber a newer edit. Never bumps the
// content version — that stays a deliberate, per-release decision.
//
// Only chrome is patched here. Reference copy (KSAs, activities, workshops) is
// shared and live for every evaluator, so it never takes this path; it goes
// through the proposal queue in src/devfeedback and is applied via
// db/referenceWrite.ts.
function contentEditEndpoint(): Plugin {
  const EDITABLE_FIELDS = new Set(['label', 'guidance', 'help'])
  return {
    name: 'cairn-content-edit',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'POST' || !req.url?.split('?')[0].endsWith('/__content-edit')) return next()
        const reply = (code: number, payload: object) => {
          res.statusCode = code
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(payload))
        }
        readJsonBody(req, (parsed) => {
          try {
            const { nodeId, field, oldText, newText } = (parsed ?? {}) as {
              nodeId?: string
              field?: string
              oldText?: string
              newText?: string
            }
            if (!nodeId || !field || !EDITABLE_FIELDS.has(field) || !newText?.trim()) {
              return reply(400, {
                error: 'nodeId, an editable field, and non-empty newText are required',
              })
            }
            const file = join(process.cwd(), 'src', 'content', 'chrome.json')
            const content = JSON.parse(readFileSync(file, 'utf8')) as {
              version: string
              nodes: Array<Record<string, unknown>>
            }
            const target = content.nodes.find((n) => n.id === nodeId)
            if (!target) return reply(404, { error: `node ${nodeId} not found` })
            if ((target[field] ?? '') !== (oldText ?? '')) {
              return reply(409, { error: 'text changed since the page loaded — reload and retry' })
            }
            target[field] = newText.trim()
            writeFileSync(file, JSON.stringify(content, null, 2) + '\n')
            reply(200, { ok: true })
          } catch (err) {
            reply(400, { error: String(err) })
          }
        })
      })
    },
  }
}

// Dev-only companion to the proposal queue. When an approved reference edit is
// applied to the database, the before/after is appended here so src/data/seed.ts
// can be reconciled later and there is a git-visible record of every wording
// change that went live. Approval does not depend on this: the client posts
// best-effort and ignores failure, so a deployed build (no dev server) still
// applies the edit.
function contentLogEndpoint(): Plugin {
  return {
    name: 'cairn-content-log',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'POST' || !req.url?.split('?')[0].endsWith('/__content-log')) return next()
        readJsonBody(req, (parsed) => {
          try {
            const { date, markdown } = (parsed ?? {}) as { date?: string; markdown?: string }
            if (!markdown?.trim()) {
              res.statusCode = 400
              return res.end(JSON.stringify({ error: 'markdown is required' }))
            }
            const day = /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ? date! : 'undated'
            const dir = join(process.cwd(), 'feedback', 'content-edits')
            mkdirSync(dir, { recursive: true })
            const file = join(dir, `${day}.md`)
            if (!existsSync(file)) writeFileSync(file, `# Applied reference edits — ${day}\n`)
            appendFileSync(file, markdown.endsWith('\n') ? markdown : `${markdown}\n`)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ path: `feedback/content-edits/${day}.md` }))
          } catch (err) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base,
  server: { port: 5180 },
  plugins: [
    feedbackInbox(),
    contentEditEndpoint(),
    contentLogEndpoint(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Honest Eval — OBT Evaluation',
        short_name: 'Honest Eval',
        description: 'Field capture for OBT participant evaluation',
        theme_color: '#1f2937',
        background_color: '#ffffff',
        display: 'standalone',
        id: base,
        scope: base,
        start_url: base,
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // The app must work fully offline for capture; precache the shell.
      // navigateFallback has to carry `base`: precache URLs are base-prefixed, so
      // a hardcoded '/index.html' has no matching entry under the GitHub Pages
      // build (base=/<repo>/) and Workbox throws non-precached-url while the
      // service worker evaluates, silently killing offline navigation.
      workbox: {
        navigateFallback: `${base}index.html`,
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
      },
      devOptions: { enabled: false },
    }),
  ],
})