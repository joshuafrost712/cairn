/**
 * tl-21's offline claim, tested rather than asserted.
 *
 * The claim is the reason this mode exists for Bali: an administrator on hotel wifi or on
 * none presses one button and the observations come back. This harness proves the half a
 * script can prove — that nothing outside the machine is needed — and it is honest about
 * the half it cannot.
 *
 * WHAT IT DOES. Serves the BUILT app through `vite preview` (never the dev server:
 * `devOptions.enabled: false` in vite.config.ts means there is no service worker in dev,
 * so an offline reload cannot fetch index.html and fails before measuring anything), loads
 * it once so the service worker takes the shell, then REFUSES every request that is not
 * loopback and reloads. From that point the page is served entirely from its own cache and
 * the only network it has is the machine it is running on. Then it routes a batch.
 *
 * WHY NOT `context.setOffline(true)`. That emulation blocks loopback too, which would
 * measure the opposite of the thing under test: on a real laptop with the wifi off,
 * 127.0.0.1 still works. Blocking everything except loopback is the accurate model of "no
 * internet, own machine only".
 *
 * WHAT THIS CANNOT PROVE, and it belongs in Joshua's pre-flight rather than here: that his
 * own Chrome reaches the DEPLOYED https:// origin's loopback fetch with the wifi off, and
 * that the `claude` CLI itself works offline — it does not, it is a network client. The
 * relay's queue is what makes that survivable: a job outlives the outage and runs when the
 * connection returns. "No internet needed" in this spec means the APP needs none, and the
 * runbook says so in those words rather than implying the model runs on the laptop.
 *
 *   ALLOW_LOCAL_ONLY_BUILD=1 VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npx vite build
 *   npx vite preview --port 5201 --strictPort
 *   node scripts/tl21-offline.mjs
 */
import { chromium } from 'playwright'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const BASE = `http://localhost:${process.env.TL21_PREVIEW_PORT ?? 5201}/`
const RELAY_PORT = Number(process.env.TL21_OFFLINE_RELAY_PORT || 8898)
const TOKEN = 'tl21-offline-token-dddddddddddddddddddd'
const SHOTS = 'screenshots/tl21-offline'

const results = []
const check = (ok, label, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label.slice(0, 70).padEnd(70)} | ${String(detail).slice(0, 80)}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

rmSync(SHOTS, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })

const relayHome = mkdtempSync(join(tmpdir(), 'tl21-offline-relay-'))
const relay = spawn(process.execPath, [join(HERE, '..', 'relay', 'server.mjs'), '--port', String(RELAY_PORT)], {
  env: {
    ...process.env,
    HONEST_EVAL_RELAY_HOME: relayHome,
    HONEST_EVAL_RELAY_TOKEN: TOKEN,
    HONEST_EVAL_RELAY_CLAUDE_BIN: join(HERE, 'tl21-fake-claude.mjs'),
    HONEST_EVAL_FAKE_MODE: 'ok',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let relayOut = ''
relay.stdout.on('data', (d) => {
  relayOut += d
})
relay.stderr.on('data', (d) => {
  relayOut += d
})
for (let i = 0; i < 100; i++) {
  if (relayOut.includes('listening on')) break
  await sleep(100)
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
const page = await ctx.newPage()
const blocked = []

const text = () => page.evaluate(() => document.body.innerText)

try {
  if (!relayOut.includes('listening on')) throw new Error(`the relay did not start on ${RELAY_PORT}`)

  // ---- online once, so the service worker takes the shell ---------------------
  await page.goto(BASE + 'signin', { waitUntil: 'load' })
  await page.waitForSelector('#name', { timeout: 20000 })
  await page.fill('#name', 'tl21 Offline')
  await page.fill('#email', 'tl21-offline@example.org')
  await page.click('button[type=submit]')
  await page.waitForTimeout(2000)
  await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('cairn')
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('workshopMembers', 'readwrite')
      const store = tx.objectStore('workshopMembers')
      const all = store.getAll()
      all.onsuccess = () => {
        for (const row of all.result) store.put({ ...row, role: 'chief_admin' })
      }
      tx.oncomplete = () => resolve()
    }
  }))
  await page.evaluate(
    ([url, token]) => {
      localStorage.setItem('cairn.relay.url', url)
      localStorage.setItem('cairn.relay.token', token)
    },
    [`http://127.0.0.1:${RELAY_PORT}`, TOKEN],
  )

  // Put the workshop in the mode and seed one submitted capture.
  const seeded = await page.evaluate(() =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open('cairn')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['participants', 'activities', 'activityKsas', 'evaluations', 'aiConfigs'], 'readwrite')
        const parts = tx.objectStore('participants').getAll()
        const acts = tx.objectStore('activities').getAll()
        const wiring = tx.objectStore('activityKsas').getAll()
        let out = null
        parts.onsuccess = () => {
          acts.onsuccess = () => {
            wiring.onsuccess = () => {
              const participant = parts.result[0]
              const wired = new Set(wiring.result.map((w) => w.activity_id))
              const activity = acts.result.find((a) => wired.has(a.id)) ?? acts.result[0]
              if (!participant || !activity) return
              const now = new Date().toISOString()
              tx.objectStore('evaluations').put({
                client_id: 'tl21-offline-cap',
                evaluator_email: 'tl21-offline@example.org',
                activity_id: activity.id,
                workshop_id: participant.workshop_id,
                focus_participant_id: participant.id,
                source_language: 'en',
                answers: {},
                quick_ratings: {},
                source_text: 'He led the group through the passage and asked good checking questions.',
                participant_scope: [{ name: participant.name, participant_id: participant.id }],
                attestation: true,
                routing_status: 'local',
                ruleset_version: 'v1',
                edit_history: [],
                created_at: now,
                updated_at: now,
                sync_status: 'local',
                sync_error: null,
              })
              tx.objectStore('aiConfigs').put({
                workshop_id: participant.workshop_id,
                mode: 'local-agent',
                functions: {},
                assumptions: {},
                updated_by: 'tl21-offline',
                updated_at: now,
              })
              out = { participant: participant.name, workshopId: participant.workshop_id }
            }
          }
        }
        tx.oncomplete = () => resolve(out)
        tx.onerror = () => reject(String(tx.error))
      }
      req.onerror = () => reject(String(req.error))
    }),
  )
  check(Boolean(seeded?.participant), 'a capture is waiting, and the workshop is in the mode', seeded?.participant ?? 'none')

  // Let the service worker install and take control of the shell.
  const swReady = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false
    const reg = await navigator.serviceWorker.ready
    return Boolean(reg?.active)
  })
  check(swReady, 'the built app registered its service worker', String(swReady))
  await page.waitForTimeout(1500)

  // ---- from here, the machine is all there is --------------------------------
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.protocol === 'data:' || url.protocol === 'blob:'
    if (local) return route.continue()
    blocked.push(url.host)
    return route.abort('internetdisconnected')
  })

  await page.goto(BASE + 'admin/routing', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${SHOTS}/01-offline-routing.png`, fullPage: true })
  {
    const body = await text()
    check(body.includes('Route on the machine at this workshop'), 'the app loads with no internet at all')
    check(body.includes('Route now'), 'and offers the one button')
  }

  {
    await page.locator('button', { hasText: 'Route now' }).first().click()
    await page.waitForTimeout(10_000)
    const body = await text()
    const obs = await page.evaluate(() =>
      new Promise((resolve) => {
        const req = indexedDB.open('cairn')
        req.onsuccess = () => {
          const tx = req.result.transaction('observations', 'readonly')
          const all = tx.objectStore('observations').getAll()
          all.onsuccess = () => resolve(all.result.filter((o) => o.capture_client_id === 'tl21-offline-cap').length)
        }
      }),
    )
    check(obs > 0, 'the batch is routed end to end with no internet', `${obs} observation(s)`)
    check(/Routed \d+ capture/.test(body), 'and the screen reports what happened', body.match(/Routed[^.]*\./)?.[0] ?? '')
    await page.screenshot({ path: `${SHOTS}/02-offline-routed.png`, fullPage: true })
  }

  /**
   * Prove the cut is real, from inside the page.
   *
   * A local-only build asks the internet for nothing — no Supabase, no fonts, no CDN —
   * so counting blocked requests would report zero and read as "the block never
   * engaged". Asking the page to reach out itself is the only way to show that it
   * cannot, which is what makes every check above mean something.
   */
  const reachedOut = await page.evaluate(async () => {
    try {
      await fetch('https://example.com/probe', { cache: 'no-store' })
      return true
    } catch {
      return false
    }
  })
  check(!reachedOut, 'the page genuinely cannot reach the internet from here', `${blocked.length} outbound request(s) refused`)
} finally {
  relay.kill('SIGTERM')
  await browser.close()
  rmSync(relayHome, { recursive: true, force: true })
}

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} checks passed`)
console.log(`screenshots: ${SHOTS}`)
if (passed !== results.length) process.exit(1)
