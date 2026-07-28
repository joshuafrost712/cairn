/**
 * tl-01's last gap: a Supabase-authenticated member goes offline, and their role
 * still resolves.
 *
 * The SQL and HTTP harnesses cover authorization; scripts/tl01-ui-checks.mjs
 * covers the client's role resolution in local-only mode. Neither covers the seam
 * between them — a real Supabase session, a real membership fetched from
 * `workshop_member`, then the network taken away. That is the case an evaluator
 * actually lives in during a workshop, so it is the one worth proving rather than
 * reasoning about.
 *
 * Runs against the BUILT app, not the dev server, and that is not incidental:
 * `devOptions.enabled: false` in vite.config.ts means no service worker in dev, so
 * an offline reload there cannot even fetch index.html and fails before reaching
 * anything this script is trying to measure. Offline capability is a PWA property,
 * so it has to be tested on the PWA.
 *
 * Requires the temporary accounts from scripts/tl01-session-tests.mjs:
 *
 *   node scripts/tl01-session-tests.mjs --keep
 *   npm run build && npx vite preview --port 5199 --strictPort   # in another shell
 *   node scripts/tl01-offline-seam.mjs
 *   node scripts/tl01-session-tests.mjs --teardown
 *
 * Port 5199 so it never fights a dev server already running on 5180.
 */
import { chromium } from 'playwright'

const BASE = 'http://localhost:5199/'
const EMAIL = 'tl01-session-evaluator@example.org'
const PASSWORD = 'tl01-Throwaway-Password-1!'

const results = []
const note = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label}${detail ? ' | ' + detail : ''}`)
}

const browser = await chromium.launch()
const ctx = await browser.newContext()
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

// --- online: sign in against the real project ------------------------------
await page.goto(BASE)
await page.waitForSelector('#email', { timeout: 20000 })
await page.fill('#email', EMAIL)
await page.fill('#password', PASSWORD)
await page.click('button[type=submit]')
await page.waitForTimeout(6000)

const header = await page.textContent('.shell__identity').catch(() => '')
note('a real Supabase session resolves its workshop role', /\(evaluator\)/.test(header ?? ''),
  (header ?? '').trim().replace(/\s+/g, ' '))

const cached = await page.evaluate(async () => {
  const rows = await new Promise((resolve, reject) => {
    const req = indexedDB.open('cairn')
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('workshopMembers', 'readonly')
      const all = tx.objectStore('workshopMembers').getAll()
      all.onsuccess = () => { db.close(); resolve(all.result) }
      all.onerror = () => reject(all.error)
    }
    req.onerror = () => reject(req.error)
  })
  return rows.map((r) => `${r.role}@${r.workshop_id.slice(0, 8)}`)
})
note('the membership from workshop_member is cached on the device', cached.length > 0, cached.join(','))

const workshopName = await page.evaluate(async () => {
  const rows = await new Promise((resolve, reject) => {
    const req = indexedDB.open('cairn')
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('workshops', 'readonly')
      const all = tx.objectStore('workshops').getAll()
      all.onsuccess = () => { db.close(); resolve(all.result) }
      all.onerror = () => reject(all.error)
    }
    req.onerror = () => reject(req.error)
  })
  return rows.map((w) => w.name)
})
note('only the workshops this member belongs to were pulled',
  workshopName.length === 1 && /Psalms/.test(workshopName[0]), workshopName.join(' | '))

// The service worker has to be in control before the network goes away, or the
// offline reload fails on index.html and proves nothing about role resolution.
const swReady = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return 'unsupported'
  const reg = await navigator.serviceWorker.ready
  for (let i = 0; i < 40 && !navigator.serviceWorker.controller; i++) {
    await new Promise((r) => setTimeout(r, 250))
  }
  return navigator.serviceWorker.controller ? 'controlling' : `registered-not-controlling:${!!reg}`
})
note('the service worker is controlling the page before going offline',
  swReady === 'controlling', swReady)

// --- offline: the actual question ------------------------------------------
await ctx.setOffline(true)
await page.reload()
await page.waitForTimeout(6000)

const offlineHeader = await page.textContent('.shell__identity').catch(() => '')
note('OFFLINE: the role still resolves, from the Dexie cache',
  /\(evaluator\)/.test(offlineHeader ?? ''), (offlineHeader ?? '').trim().replace(/\s+/g, ' '))

const offlineBody = await page.textContent('body')
note('OFFLINE: the app is usable, not stuck on a session check',
  !/Checking your session/.test(offlineBody ?? '') &&
    !/have not been added to a workshop/i.test(offlineBody ?? ''),
  (offlineBody ?? '').slice(0, 70).replace(/\s+/g, ' '))

const offlineNav = await page.evaluate(async () => {
  document.querySelector('.shell__menu-btn')?.click()
  await new Promise((r) => setTimeout(r, 400))
  return [...document.querySelectorAll('.drawer .nav__link')].map((a) => a.getAttribute('href'))
})
note('OFFLINE: an evaluator still gets no admin surfaces',
  offlineNav.length > 0 && !offlineNav.some((h) => h?.includes('/admin/')), offlineNav.join(' '))

// A cleared cache while offline must degrade DOWN, never to an implied admin.
await page.evaluate(async () => {
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('cairn')
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('workshopMembers', 'readwrite')
      tx.objectStore('workshopMembers').clear()
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
    req.onerror = () => reject(req.error)
  })
})
await page.reload()
// Polled rather than slept, and generously: the session bootstrap has its own
// 10s watchdog (BOOTSTRAP_TIMEOUT_MS), so a fixed 6s wait races it and reports
// the transient "Checking your session…" card as the final state.
let clearedBody = ''
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000)
  clearedBody = (await page.textContent('body')) ?? ''
  if (!/Checking your session/.test(clearedBody)) break
}
note('OFFLINE + cleared cache: degrades to the no-workshop state',
  /have not been added to a workshop/i.test(clearedBody),
  clearedBody.slice(0, 70).replace(/\s+/g, ' '))
note('OFFLINE + cleared cache: no admin surface is implied',
  !/Roster|Settings|Builder/.test(clearedBody ?? ''))

// --- back online: it recovers on its own -----------------------------------
await ctx.setOffline(false)
await page.click('button.primary')
await page.waitForTimeout(6000)
const recoveredHeader = await page.textContent('.shell__identity').catch(() => '')
note('back online: "Check again" recovers the role without a reload',
  /\(evaluator\)/.test(recoveredHeader ?? ''),
  (recoveredHeader ?? '').trim().replace(/\s+/g, ' '))

// Network failures are the point of this test, not a defect in it: a run that
// disconnects the network and logs no ERR_INTERNET_DISCONNECTED would mean the
// offline phase never actually happened. Only unexpected errors count.
const EXPECTED_OFFLINE = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|Failed to fetch|NetworkError|net::ERR_FAILED/i
const unexpected = errors.filter((e) => !EXPECTED_OFFLINE.test(e))
note('the offline phase really did lose the network', errors.some((e) => EXPECTED_OFFLINE.test(e)),
  `${errors.length - unexpected.length} expected network error(s)`)
note('no UNEXPECTED page errors across the whole run', unexpected.length === 0,
  unexpected.slice(0, 3).join(' | '))

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} PASS, ${failed.length} FAIL`)
process.exit(failed.length === 0 ? 0 : 1)
