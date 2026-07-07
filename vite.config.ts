import { mkdirSync, writeFileSync } from 'node:fs'
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
            const safe = basename(filename ?? 'feedback.md').replace(/[^\w.\-]/g, '_')
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

// https://vite.dev/config/
export default defineConfig({
  base,
  server: { port: 5180 },
  plugins: [
    feedbackInbox(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Throughline — OBT Evaluation',
        short_name: 'Throughline',
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
      workbox: {
        navigateFallback: '/index.html',
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
      },
      devOptions: { enabled: false },
    }),
  ],
})