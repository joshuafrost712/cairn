/**
 * tl-01 client-side acceptance: does the app resolve a workshop role, discard a
 * forged workshop selection, gate its routes, and name the no-membership state?
 *
 * Runs against the app in LOCAL-ONLY mode, which is what makes it runnable without
 * anybody's password: with Supabase unconfigured the same client code paths
 * resolve a role from a synthesized membership in Dexie instead of from
 * `workshop_member`. The server side of the same spec is verified separately, and
 * has to be: nothing here proves anything about authorization. See
 * scripts/tl01-rls-tests.sql for that half.
 *
 * Prerequisites, deliberately NOT declared in package.json — the repo has no
 * browser-test dependency and tl-01 is not the spec that should add one:
 *
 *   npm i -D playwright && npx playwright install chromium-headless-shell
 *
 * Then, from the repo root, in one shell:
 *   VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npx vite --port 5199 --strictPort
 * and in another:
 *   node scripts/tl01-ui-checks.mjs
 *
 * Port 5199 rather than the usual 5180, so this never fights a dev server that is
 * already running with real config.
 */
import { chromium } from 'playwright'

const BASE = 'http://localhost:5199/'
const results = []
const note = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label}${detail ? ' | ' + detail : ''}`)
}

const browser = await chromium.launch()

async function fresh() {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  return { ctx, page, errors }
}

async function signIn(page, name, email, role) {
  // '/signin', not the root: since tl-19 a signed-out visitor at '/' is redirected
  // to the landing page, and this harness would sit waiting for a form that is one
  // click away rather than on screen.
  await page.goto(BASE + 'signin')
  await page.waitForSelector('#name', { timeout: 15000 })
  await page.fill('#name', name)
  await page.fill('#email', email)
  if (role) {
    // Local sign-in has no role picker; the role is set via the seeded membership.
  }
  await page.click('button[type=submit]')
  await page.waitForTimeout(1500)
}

// ---------------------------------------------------------------------------
// 1. Local-only sign-in lands on Home with a resolved workshop role
// ---------------------------------------------------------------------------
{
  const { ctx, page, errors } = await fresh()
  await signIn(page, 'TL01 Tester', 'tl01@example.org')
  const header = await page.textContent('.shell__identity').catch(() => '')
  note('local sign-in resolves a workshop role in the header',
    /\(evaluator\)/.test(header ?? ''), (header ?? '').trim().replace(/\s+/g, ' '))

  const ws = await page.evaluate(() => localStorage.getItem('cairn.active_workshop_id'))
  note('active workshop is set from the membership, not left null', ws != null, String(ws))

  const nav = await page.evaluate(async () => {
    document.querySelector('.shell__menu-btn')?.click()
    await new Promise((r) => setTimeout(r, 400))
    return [...document.querySelectorAll('.drawer .nav__link')].map((a) => a.getAttribute('href'))
  })
  note('evaluator nav excludes the admin surfaces',
    !nav.some((h) => h?.includes('/admin/roster') || h?.includes('/admin/settings')),
    nav.join(' '))
  note('evaluator nav still includes the capture surfaces',
    nav.includes('/') && nav.some((h) => h?.includes('/evaluations')), nav.join(' '))

  note('no page errors on the evaluator path', errors.length === 0, errors.slice(0, 3).join(' | '))
  await ctx.close()
}

// ---------------------------------------------------------------------------
// 2. A forged active-workshop id is discarded, not honored
// ---------------------------------------------------------------------------
{
  const { ctx, page, errors } = await fresh()
  await signIn(page, 'TL01 Tester', 'tl01@example.org')
  const real = await page.evaluate(() => localStorage.getItem('cairn.active_workshop_id'))

  await page.evaluate(() => localStorage.setItem('cairn.active_workshop_id', 'forged-workshop-id'))
  await page.reload()
  await page.waitForTimeout(2000)
  const after = await page.evaluate(() => localStorage.getItem('cairn.active_workshop_id'))
  note('forged workshop id is replaced by a real membership on load',
    after === real, `forged -> ${after} (real ${real})`)

  const header = await page.textContent('.shell__identity').catch(() => '')
  note('role still resolves after the forgery is corrected',
    /\(evaluator\)/.test(header ?? ''), (header ?? '').trim().replace(/\s+/g, ' '))
  note('no page errors on the forgery path', errors.length === 0, errors.slice(0, 3).join(' | '))
  await ctx.close()
}

// ---------------------------------------------------------------------------
// 3. Route gate: an evaluator cannot reach an admin route by URL
// ---------------------------------------------------------------------------
{
  const { ctx, page } = await fresh()
  await signIn(page, 'TL01 Tester', 'tl01@example.org')
  await page.goto(BASE + 'admin/settings')
  await page.waitForTimeout(1500)
  note('evaluator typing /admin/settings is bounced home',
    new URL(page.url()).pathname === '/', page.url())
  await ctx.close()
}

// ---------------------------------------------------------------------------
// 4. No membership: the state is named, not rendered as an empty dashboard
// ---------------------------------------------------------------------------
{
  const { ctx, page, errors } = await fresh()
  await signIn(page, 'TL01 Tester', 'tl01@example.org')
  // Drop the cached memberships, which is what a removed-from-the-workshop or
  // cleared-cache device looks like. Must NOT degrade to an implied admin.
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
  await page.waitForTimeout(2500)
  const body = await page.textContent('body')
  note('cleared membership cache shows the no-workshop state',
    /have not been added to a workshop/i.test(body ?? ''),
    (body ?? '').slice(0, 90).replace(/\s+/g, ' '))
  note('no-workshop state does not expose admin nav',
    !/Roster|Settings/.test(body ?? ''), '')
  note('no page errors on the no-membership path', errors.length === 0, errors.slice(0, 3).join(' | '))
  await ctx.close()
}

// ---------------------------------------------------------------------------
// 5. The positive side of the gate: an elevated workshop role unlocks the admin
//    surfaces. A gate that only ever denies has not been shown to work.
// ---------------------------------------------------------------------------
{
  const { ctx, page, errors } = await fresh()
  await signIn(page, 'TL01 Tester', 'tl01@example.org')
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('cairn')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('workshopMembers', 'readwrite')
        const store = tx.objectStore('workshopMembers')
        const all = store.getAll()
        all.onsuccess = () => {
          for (const row of all.result) store.put({ ...row, role: 'chief_admin' })
        }
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })
  })
  await page.reload()
  await page.waitForTimeout(2000)

  const header = await page.textContent('.shell__identity').catch(() => '')
  note('elevated role is reported in the header',
    /\(chief admin\)/.test(header ?? ''), (header ?? '').trim().replace(/\s+/g, ' '))

  const nav = await page.evaluate(async () => {
    document.querySelector('.shell__menu-btn')?.click()
    await new Promise((r) => setTimeout(r, 400))
    return [...document.querySelectorAll('.drawer .nav__link')].map((a) => a.getAttribute('href'))
  })
  note('chief_admin nav includes the admin surfaces',
    nav.some((h) => h?.includes('/admin/roster')) && nav.some((h) => h?.includes('/admin/settings')),
    nav.join(' '))

  await page.goto(BASE + 'admin/settings')
  await page.waitForTimeout(1500)
  note('chief_admin reaches /admin/settings rather than being bounced',
    new URL(page.url()).pathname === '/admin/settings', page.url())
  note('no page errors on the admin path', errors.length === 0, errors.slice(0, 3).join(' | '))
  await ctx.close()
}

await browser.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} PASS, ${failed.length} FAIL`)
process.exit(failed.length === 0 ? 0 : 1)
