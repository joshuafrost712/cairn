/**
 * Two-viewport UI audit: does every route fit a phone and a laptop, and does the
 * landing page keep its promises? Created by tl-19; tl-20 extends it.
 *
 * Joshua asked for a UI "designed and tested for both computer screens and phones",
 * and the only honest way to answer that is to open every route at both sizes and
 * look. So this walks the app at 1400x1000 and at 390x844, asserts no route
 * overflows horizontally, collects page errors, and writes full-page screenshots to
 * screenshots/ui-audit/ (gitignored) for the human half of the review.
 *
 * Four things it checks that a unit test cannot:
 *   1. horizontal overflow, per route, per viewport
 *   2. reduced motion: every heading actually visible, not stuck at opacity 0
 *   3. the motion chunk never loads on a signed-in route, and does load on /welcome
 *   4. page errors on any walked route
 *
 * OWNED vs INHERITED. tl-19 owns /welcome and /signin: an overflow there is a FAIL
 * and exits nonzero. The signed-in routes are walked too, because tl-20's whole job
 * is that polish and it needs the baseline, but their overflows are reported as
 * WARN and do not fail this run. A harness that failed on work the spec had not
 * done yet would just be switched off.
 *
 * Prerequisites, deliberately NOT in package.json — the repo has no browser-test
 * dependency and this is not the spec that should add one:
 *
 *   npm i -D --no-save playwright && npx playwright install chromium-headless-shell
 *
 * Then, from the repo root, in one shell:
 *   VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npx vite --port 5198 --strictPort
 * and in another:
 *   node scripts/ui-responsive-audit.mjs
 *
 * Port 5198 rather than 5180: the repo is worked in several worktrees at once, and
 * a harness pointed at the default port drives whichever session happens to own it.
 * That is the worst possible green — a pass that proves somebody else's build. If
 * you move the server, move this constant with it.
 *
 * Runs in LOCAL-ONLY mode (both Supabase vars blank), which is what makes it
 * runnable without anybody's password: sign-in synthesizes a membership in Dexie.
 * Nothing here proves anything about authorization; that is scripts/tl0*-rls-tests.sql.
 */
import { chromium } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'

const BASE = 'http://localhost:5198/'
const SHOTS = 'screenshots/ui-audit'

const VIEWPORTS = [
  { name: 'desktop', viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 },
  {
    name: 'phone',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
]

/** `owned` routes gate the exit code; the rest are tl-20's baseline. */
const ROUTES = [
  { path: 'welcome', label: 'welcome', auth: false, owned: true, settle: 1200, scroll: true },
  { path: 'signin', label: 'signin', auth: false, owned: true },
  { path: '', label: 'home', auth: true, owned: false },
  { path: 'evaluations', label: 'my-evaluations', auth: true, owned: false },
  { path: 'observations', label: 'observations', auth: true, owned: false },
  { path: 'reports', label: 'reports', auth: true, owned: false },
  { path: 'conversations', label: 'conversations', auth: true, owned: false },
  { path: 'admin/roster', label: 'admin-roster', auth: true, owned: false, elevate: true },
  { path: 'admin/progress', label: 'admin-progress', auth: true, owned: false, elevate: true },
  { path: 'admin/records', label: 'admin-records', auth: true, owned: false, elevate: true },
  { path: 'admin/sync-health', label: 'admin-sync-health', auth: true, owned: false, elevate: true },
  { path: 'admin/routing', label: 'admin-routing', auth: true, owned: false, elevate: true },
]

const results = []
const note = (label, ok, detail = '', owned = true) => {
  results.push({ label, ok, detail, owned })
  const tag = ok ? 'PASS' : owned ? 'FAIL' : 'WARN'
  console.log(`${tag} | ${label}${detail ? ' | ' + detail : ''}`)
}

rmSync(SHOTS, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })

const browser = await chromium.launch()

async function newContext(vp, extra = {}) {
  const ctx = await browser.newContext({ ...vp, ...extra })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  return { ctx, page, errors }
}

/**
 * Local-only sign-in: name + email, no password anywhere.
 *
 * Goes to `/signin` rather than the root. Since tl-19 the root of a signed-out app
 * is the landing page, so a harness that waits for the form at `/` waits forever.
 */
async function signIn(page) {
  await page.goto(BASE + 'signin', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#name', { timeout: 20000 })
  await page.fill('#name', 'tl19 Auditor')
  await page.fill('#email', 'tl19-auditor@example.org')
  await page.click('button[type=submit]')
  await page.waitForTimeout(2000)
}

/**
 * Walk a scroll-driven page from top to bottom and back, pausing at each step.
 *
 * Two jobs. It is what makes a full-page screenshot of this page worth looking at:
 * a `whileInView` reveal fires when its element is scrolled to, so a screenshot
 * taken without scrolling shows a hero and six blank sections, which is exactly
 * what the first run of this harness produced. And it is the only way to check that
 * the reveals fire AT ALL in the animated path — the reduced-motion pass proves the
 * static branch, not this one.
 */
async function walkPage(page) {
  const height = await page.evaluate(() => document.body.scrollHeight)
  const step = Math.max(320, Math.floor((await page.evaluate(() => window.innerHeight)) * 0.7))
  for (let y = 0; y < height; y += step) {
    await page.evaluate((to) => window.scrollTo(0, to), y)
    await page.waitForTimeout(360)
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await page.waitForTimeout(900)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(500)
}

/**
 * Every `[data-wel-heading]`, with the computed opacity of the element AND of every
 * ancestor. The ancestor chain is the point: a Reveal wrapper stuck at 0 hides its
 * heading without touching the heading's own computed style, so checking the
 * element alone would pass while the section was invisible.
 */
const headingOpacities = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-wel-heading]')].map((el) => ({
      id: el.getAttribute('data-wel-heading'),
      text: el.textContent?.trim() ?? '',
      chain: (() => {
        let node = el
        const out = []
        while (node && node !== document.documentElement) {
          out.push(getComputedStyle(node).opacity)
          node = node.parentElement
        }
        return out
      })(),
    })),
  )

/** Promote the synthesized membership so the admin routes render rather than bounce. */
async function elevate(page) {
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
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
}

// ---------------------------------------------------------------------------
// 1. The route walk, at both viewports
// ---------------------------------------------------------------------------
for (const vp of VIEWPORTS) {
  // One signed-in context per viewport, reused across the authenticated routes:
  // signing in twelve times would triple the runtime and prove nothing extra.
  const signedOut = await newContext(vp)
  const signedIn = await newContext(vp)
  await signIn(signedIn.page)
  let elevated = false

  for (const route of ROUTES) {
    const { page, errors } = route.auth ? signedIn : signedOut
    if (route.elevate && !elevated) {
      await elevate(page)
      elevated = true
    }
    const before = errors.length
    await page.goto(BASE + route.path, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(route.settle ?? 900)

    if (route.scroll) {
      await walkPage(page)
      // The animated path's own reveal check. Reduced motion is verified further
      // down against the static branch; this is the branch a visitor actually gets,
      // and a scene whose reveal never fires is invisible with nothing in the
      // console to say so.
      const headings = await headingOpacities(page)
      const hidden = headings.filter((h) => h.chain.some((o) => o !== '1') || !h.text)
      note(
        `${vp.name} ${route.label}: every scene reveals after a scroll`,
        headings.length === 6 && hidden.length === 0,
        `${headings.length} headings, hidden: ${hidden.map((h) => h.id).join(' ') || 'none'}`,
        route.owned,
      )
    }

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }))
    note(
      `${vp.name} ${route.label}: no horizontal overflow`,
      overflow.scrollWidth <= overflow.innerWidth + 1,
      `${overflow.scrollWidth} > ${overflow.innerWidth}`,
      route.owned,
    )
    // And the layout viewport is still the one we emulated. Without this the check
    // above is a FALSE GREEN on any page whose content widened the viewport: both
    // numbers grow together and scrollWidth <= innerWidth stays true while the
    // phone is quietly rendering a 515px-wide page. /admin/roster does exactly
    // that today.
    note(
      `${vp.name} ${route.label}: layout viewport not widened by content`,
      overflow.innerWidth <= vp.viewport.width + 1,
      `${overflow.innerWidth} > ${vp.viewport.width}`,
      route.owned,
    )

    const fresh = errors.slice(before)
    note(
      `${vp.name} ${route.label}: no page errors`,
      fresh.length === 0,
      fresh.slice(0, 2).join(' | '),
      route.owned,
    )

    await page.screenshot({ path: `${SHOTS}/${vp.name}-${route.label}.png`, fullPage: true })
  }

  await signedOut.ctx.close()
  await signedIn.ctx.close()
}

// ---------------------------------------------------------------------------
// 2. Reduced motion: the whole page is readable, not a set of invisible sections
// ---------------------------------------------------------------------------
{
  const { ctx, page, errors } = await newContext(VIEWPORTS[0], { reducedMotion: 'reduce' })
  await page.goto(BASE + 'welcome', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)

  const hero = await page.evaluate(() => {
    const el = document.querySelector('.wel-hero__title')
    if (!el) return null
    return { text: el.textContent?.trim() ?? '', opacity: getComputedStyle(el).opacity }
  })
  note(
    'reduced motion: the hero title is visible',
    hero != null && hero.opacity === '1' && hero.text.length > 0,
    JSON.stringify(hero),
  )

  // Every scene heading, WITHOUT scrolling: under reduced motion the whole page has
  // to be readable as it stands, including the sections far below the fold that a
  // whileInView reveal would never have triggered for.
  const headings = await headingOpacities(page)
  note('reduced motion: all six scene headings are present', headings.length === 6, `${headings.length}`)
  const hidden = headings.filter((h) => h.chain.some((o) => o !== '1') || h.text.length === 0)
  note(
    'reduced motion: no heading is hidden by an unresolved reveal',
    hidden.length === 0,
    hidden.map((h) => h.id).join(' '),
  )
  note('reduced motion: no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))
  await page.screenshot({ path: `${SHOTS}/reduced-motion-welcome.png`, fullPage: true })
  await ctx.close()
}

// ---------------------------------------------------------------------------
// 3. Chunk isolation: the animation library never reaches a signed-in route
// ---------------------------------------------------------------------------
{
  const { ctx, page } = await newContext(VIEWPORTS[0])
  const requested = []
  page.on('request', (r) => requested.push(r.url()))

  await signIn(page)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const onHome = requested.filter((u) => /motion|framer/i.test(u))
  note(
    'the animation chunk never loads on the signed-in home route',
    onHome.length === 0,
    onHome.slice(0, 2).join(' | '),
  )

  requested.length = 0
  await page.goto(BASE + 'welcome', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)
  const onWelcome = requested.filter((u) => /motion|framer/i.test(u))
  note(
    'the animation chunk does load on /welcome',
    onWelcome.length > 0,
    `${onWelcome.length} request(s)`,
  )
  await ctx.close()
}

// ---------------------------------------------------------------------------
// 4. Signed out, any path lands on the landing page
// ---------------------------------------------------------------------------
{
  const { ctx, page } = await newContext(VIEWPORTS[1])
  await page.goto(BASE + 'reports/some-participant', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  note(
    'signed out, a deep link lands on /welcome',
    new URL(page.url()).pathname === '/welcome',
    page.url(),
  )
  await page.goto(BASE + 'signin', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  note(
    'signed out, /signin still renders the form rather than redirecting',
    (await page.locator('#email').count()) > 0,
    page.url(),
  )
  await ctx.close()
}

await browser.close()

const owned = results.filter((r) => r.owned)
const failed = owned.filter((r) => !r.ok)
const warned = results.filter((r) => !r.owned && !r.ok)
console.log(`\nScreenshots in ${SHOTS}/ — the human half of this audit.`)
console.log(`${owned.length - failed.length}/${owned.length} PASS on tl-19's own surfaces, ${failed.length} FAIL`)
if (warned.length) {
  console.log(`\n${warned.length} WARN on inherited routes (tl-20 owns these):`)
  for (const w of warned) console.log(`  - ${w.label}${w.detail ? ' | ' + w.detail : ''}`)
}
process.exit(failed.length === 0 ? 0 : 1)
