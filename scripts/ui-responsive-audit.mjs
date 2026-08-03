/**
 * Two-viewport UI audit: does every route fit a phone and a laptop, does the app
 * move, and does the landing page keep its promises? Created by tl-19, extended and
 * taken over by tl-20.
 *
 * Joshua asked for a UI "designed and tested for both computer screens and phones",
 * and the only honest way to answer that is to open every route at both sizes and
 * look. So this walks the app at 1400x1000 and at 390x844, asserts no route
 * overflows horizontally, collects page errors, and writes full-page screenshots to
 * screenshots/ui-audit/ (gitignored) for the human half of the review.
 *
 * Eight things it checks that a unit test cannot:
 *   1. horizontal overflow, per route, per viewport
 *   2. the layout viewport is still the emulated one (see the note at the check)
 *   3. reduced motion: every landing heading actually visible, not stuck at opacity 0
 *   4. reduced motion on a SIGNED-IN route: the staggered task list is visible too
 *   5. the motion chunk never loads on a signed-in route, and does load on /welcome
 *   6. the drawer, the page enter, and the verify confirm actually animate
 *   7. the kanban snaps, and scrolls inside itself rather than moving the body
 *   8. page errors on any walked route
 *
 * OWNED vs INHERITED. tl-19 owned /welcome and /signin and only WARNed on the
 * signed-in routes, because failing on polish it had not done yet would have got the
 * harness switched off within a day. **tl-20 is that polish, so every route is now
 * `owned: true` and every overflow is a FAIL.** The WARN tier is kept in the code
 * rather than deleted: the next spec to add a route it has not styled yet will want
 * it, and it should be a deliberate, visible choice to use it.
 *
 * ROUTE NAMES AND tl-07. This file's signed-in route list is the pre-tl-07 shape,
 * because tl-20 is branched from tl-19 which is branched from main. When tl-07's
 * setup hub merges, `/admin/roster` and `/admin/settings` stop being pages and
 * become sections of `/admin/setup`; whoever merges second updates the ROUTES array
 * and re-runs. The `notFound` check below is what stops that from being silent: a
 * route that no longer exists redirects, and the audit says so instead of grading
 * whatever it landed on.
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

/**
 * `owned` routes gate the exit code. Every route is owned as of tl-20; see the
 * header on why the flag still exists.
 */
const ROUTES = [
  { path: 'welcome', label: 'welcome', auth: false, owned: true, settle: 1200, scroll: true },
  { path: 'signin', label: 'signin', auth: false, owned: true },
  { path: '', label: 'home', auth: true, owned: true },
  { path: 'evaluations', label: 'my-evaluations', auth: true, owned: true },
  { path: 'observations', label: 'observations', auth: true, owned: true },
  { path: 'reports', label: 'reports', auth: true, owned: true },
  { path: 'conversations', label: 'conversations', auth: true, owned: true },
  // tl-07 turned /admin/roster and /admin/settings into sections of one Setup hub,
  // so the old single-route entry is replaced by the hub and each of its eight
  // sections. They are separate entries rather than one, because a section is a
  // separate page as far as overflow is concerned: the participants table and the
  // question editor fail at 390px for different reasons, and auditing only the hub
  // would grade the nav rail and none of the editors.
  { path: 'admin/setup', label: 'admin-setup', auth: true, owned: true, elevate: true },
  { path: 'admin/setup/basics', label: 'setup-basics', auth: true, owned: true, elevate: true },
  { path: 'admin/setup/goals', label: 'setup-goals', auth: true, owned: true, elevate: true },
  { path: 'admin/setup/calendar', label: 'setup-calendar', auth: true, owned: true, elevate: true },
  { path: 'admin/setup/scale', label: 'setup-scale', auth: true, owned: true, elevate: true },
  { path: 'admin/setup/participants', label: 'setup-participants', auth: true, owned: true, elevate: true },
  { path: 'admin/setup/people', label: 'setup-people', auth: true, owned: true, elevate: true },
  { path: 'admin/setup/ai', label: 'setup-ai', auth: true, owned: true, elevate: true },
  { path: 'admin/setup/templates', label: 'setup-templates', auth: true, owned: true, elevate: true },
  { path: 'admin/progress', label: 'admin-progress', auth: true, owned: true, elevate: true },
  { path: 'admin/records', label: 'admin-records', auth: true, owned: true, elevate: true },
  // tl-20 adds the assignments board, because the kanban is the one component in
  // the app that scrolls sideways on purpose and the spec is about making that
  // legible on a phone. Auditing the polish without walking the route would have
  // been a gap the harness could not see.
  { path: 'admin/assignments', label: 'admin-assignments', auth: true, owned: true, elevate: true },
  { path: 'admin/sync-health', label: 'admin-sync-health', auth: true, owned: true, elevate: true },
  { path: 'admin/routing', label: 'admin-routing', auth: true, owned: true, elevate: true },
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

    // Did we land where we asked? A route that has been deleted or renamed
    // redirects, and without this the audit would grade the redirect target twice
    // and report a clean pass on a page that no longer exists. tl-07 renames three
    // of the paths below, so this is the check that makes the rename loud.
    note(
      `${vp.name} ${route.label}: the route still exists`,
      new URL(page.url()).pathname === '/' + route.path,
      `landed on ${new URL(page.url()).pathname}`,
      route.owned,
    )

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

    // tl-20: the brand fits on one line. Specific, and it is here because adding the
    // mark to the header is what put it at risk: 28px plus a gap out of a 390px row
    // that already held a hamburger, the sync state, a name, a role and a button was
    // enough to wrap "Honest Eval" in two. A header that grows a line on a phone is
    // a line of the page gone, on every route, permanently.
    //
    // Counted as LINE BOXES, via getClientRects() on the inline anchor, not derived
    // from a height. The first version of this check compared the element's height
    // against its computed line-height, and `line-height: normal` parses to NaN, so
    // the fallback quietly became `24 * 1.5 = 36` — exactly the height of the two
    // lines it was meant to catch. It reported PASS on the wrap it was written for.
    if (route.auth) {
      const lines = await page.evaluate(() => {
        const el = document.querySelector('.shell__brand')
        return el ? el.getClientRects().length : null
      })
      note(
        `${vp.name} ${route.label}: the brand renders on one line`,
        lines === 1,
        `${lines} line box(es)`,
        route.owned,
      )
    }

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

// ---------------------------------------------------------------------------
// 5. tl-20: the app moves. Three animations, checked where they actually run.
// ---------------------------------------------------------------------------
/*
 * `getAnimations()`, not `getComputedStyle().animationName`, and the difference is
 * the whole value of this section.
 *
 * A computed `animation-name` is the DECLARED value. It reads back exactly the same
 * whether the animation is playing, finished, or never started, so a check built on
 * it passes on a page where nothing moves — which is the false green tl-19's review
 * record was written about. `getAnimations()` returns the animations actually
 * running on the element, with a name and a play state, so it can tell "this
 * animated" from "a stylesheet mentioned an animation here".
 *
 * Both are reported: the class and declared name localise a failure (class missing =
 * the component; declared name missing = the stylesheet), and the running animation
 * is what the assertion turns on.
 */
const running = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    return {
      cls: el.className,
      declared: getComputedStyle(el).animationName,
      running: el.getAnimations().map((a) => ({
        name: a.animationName ?? '(not a css animation)',
        state: a.playState,
        t: Math.round(Number(a.currentTime ?? -1)),
      })),
    }
  }, selector)

/**
 * Record `animationstart` for a while, then hand back the names that fired.
 *
 * This, rather than sampling `getAnimations()` after the fact, is what makes the
 * three checks below trustworthy. Sampling has a window: these animations run for
 * 220ms and are removed from `getAnimations()` the moment they finish (nothing here
 * uses a fill mode, by Rule 1 in motion.css), so an empty result is ambiguous — it
 * means either "never started" or "already over", and which one you get depends on
 * how busy the machine was. The first version of the page-enter check read exactly
 * that empty array and could not say which. An event either fired or it did not.
 */
async function recordAnimations(page, act, settle = 500) {
  await page.evaluate(() => {
    window.__tl20Anims = []
    if (!window.__tl20Listening) {
      document.addEventListener('animationstart', (e) => window.__tl20Anims.push(e.animationName), true)
      window.__tl20Listening = true
    }
  })
  await act()
  await page.waitForTimeout(settle)
  return page.evaluate(() => window.__tl20Anims)
}

{
  const { ctx, page } = await newContext(VIEWPORTS[1])
  await signIn(page)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  // The drawer, from the hamburger. Phone viewport, because that is the only place
  // it opens: above 900px the nav is a sidebar and the drawer is display:none.
  const drawerAnims = await recordAnimations(page, () => page.click('.shell__menu-btn'))
  note(
    'the nav drawer slides in and its scrim fades',
    drawerAnims.includes('drawer-in') && drawerAnims.includes('scrim-in'),
    `fired: ${drawerAnims.join(' ') || 'nothing'}`,
  )
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  // Page enter, re-triggered on navigation without remounting the route. Checked
  // AFTER a navigation, not on first load, because the retrigger is the part that
  // can break: AppShell adds the class by hand and a React re-render that rewrote
  // className would silently strip it.
  await page.click('.shell__menu-btn')
  await page.waitForTimeout(150)
  const navAnims = await recordAnimations(page, () =>
    page.click('.drawer .nav__link[href$="/evaluations"]'),
  )
  note(
    'the page fades and rises on navigation',
    navAnims.includes('page-enter'),
    `fired: ${navAnims.join(' ') || 'nothing'} | ${JSON.stringify(await running(page, '.shell__content'))}`,
  )

  // The verify confirm. There is nothing to verify in a local-only run (tl-18's
  // fresh start left the workshop empty of evidence on purpose), so the harness
  // seeds ONE observation of its own. Prefix-scoped per the build protocol, though
  // the scoping is belt and braces here: a Playwright context's IndexedDB dies with
  // the context, so this never touches a real device or another harness.
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('cairn')
      req.onsuccess = () => {
        const idb = req.result
        const tx = idb.transaction('observations', 'readwrite')
        tx.objectStore('observations').put({
          id: 'tl20-audit-capture::0',
          capture_client_id: 'tl20-audit-capture',
          workshop_id: null,
          participant_id: 'tl20-audit-participant',
          participant_name: 'tl20 Audit Participant',
          ksa_code: 'Q1',
          text: 'Seeded by the tl-20 audit so the confirm control has something to confirm.',
          source_excerpt: 'seeded by the tl-20 audit',
          evidence_designation: 2,
          sentiment_flag: 'neutral',
          confidence: 'medium',
          needs_review: false,
          origin: 'individual',
          imported_at: new Date(0).toISOString(),
          evaluator_email: null,
          sync_status: 'local',
        })
        tx.oncomplete = () => {
          idb.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })
  })
  await page.goto(BASE + 'observations', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1600)
  const confirm = page.locator('button[data-dfb-node="verify.confirm"]').first()
  const seeded = (await confirm.count()) > 0
  let popAnims = []
  if (seeded) popAnims = await recordAnimations(page, () => confirm.click())
  note(
    'a recorded verdict acknowledges itself',
    seeded && popAnims.includes('confirm-pop'),
    seeded
      ? `fired: ${popAnims.join(' ') || 'nothing'}`
      : 'no confirm control rendered — the seeded observation never reached the page',
  )
  await page.screenshot({ path: `${SHOTS}/phone-verify-confirm.png`, fullPage: true })
  await ctx.close()
}

// ---------------------------------------------------------------------------
// 6. tl-20: the kanban is legible on a phone
// ---------------------------------------------------------------------------
/*
 * The board's horizontal scroll is deliberate and documented in dashboard.css; do
 * not relitigate it. What tl-20 owed it was a snap and an affordance, plus proof
 * that the strip is the thing scrolling. If the BODY scrolled instead, the columns
 * would be comparable only by moving the whole page, which is what the design
 * decision was avoiding in the first place.
 */
{
  const { ctx, page } = await newContext(VIEWPORTS[1])
  await signIn(page)
  await elevate(page)
  await page.goto(BASE + 'admin/assignments', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2200)
  const board = await page.evaluate(() => {
    const el = document.querySelector('.kanban')
    if (!el) return null
    const col = el.querySelector('.kanban__col')
    return {
      cols: el.querySelectorAll('.kanban__col').length,
      snapType: getComputedStyle(el).scrollSnapType,
      colAlign: col ? getComputedStyle(col).scrollSnapAlign : null,
      // The strip overflows itself...
      stripScrolls: el.scrollWidth > el.clientWidth,
      // ...and the body does not.
      bodyScrolls: document.documentElement.scrollWidth > window.innerWidth + 1,
      backgrounds: getComputedStyle(el).backgroundImage.split('gradient').length - 1,
    }
  })
  note(
    'the kanban renders at all (an empty board would make the rest a false green)',
    board != null && board.cols > 0,
    JSON.stringify(board),
  )
  note(
    'the kanban snaps by column',
    board?.snapType?.includes('x') === true && board?.colAlign === 'start',
    `snap-type: ${board?.snapType}, col align: ${board?.colAlign}`,
  )
  note(
    'the strip scrolls inside itself and the body does not',
    board?.stripScrolls === true && board?.bodyScrolls === false,
    `strip ${board?.stripScrolls}, body ${board?.bodyScrolls}`,
  )
  note(
    'the strip carries a there-is-more-that-way affordance',
    (board?.backgrounds ?? 0) >= 4,
    `${board?.backgrounds} gradient layer(s)`,
  )

  // The same question for the dense tables, on the route that used to widen the page
  // instead of clipping. Every wrapper that is actually overflowing must carry the
  // affordance; a wrapper whose table fits needs nothing and is not counted.
  await page.goto(BASE + 'admin/roster', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2200)
  const tables = await page.evaluate(() => {
    const wraps = [...document.querySelectorAll('.dt-wrap')]
    const overflowing = wraps.filter((el) => el.scrollWidth > el.clientWidth + 1)
    return {
      wraps: wraps.length,
      overflowing: overflowing.length,
      withoutCue: overflowing.filter(
        (el) => getComputedStyle(el).backgroundImage.split('gradient').length - 1 < 4,
      ).length,
      bodyScrolls: document.documentElement.scrollWidth > window.innerWidth + 1,
    }
  })
  note(
    'a dense table clipped on a phone says there is more to the side',
    tables.overflowing > 0 && tables.withoutCue === 0 && tables.bodyScrolls === false,
    `${tables.overflowing}/${tables.wraps} wrapper(s) overflowing, ${tables.withoutCue} without a cue, body scrolls: ${tables.bodyScrolls}`,
  )
  await page.screenshot({ path: `${SHOTS}/phone-table-scroll-cue.png`, fullPage: true })
  await ctx.close()
}

// ---------------------------------------------------------------------------
// 7. tl-20: reduced motion on a SIGNED-IN route
// ---------------------------------------------------------------------------
/*
 * Section 2 proves the landing page. This proves the app, and it exists for one
 * specific trap: the task list's entrance carries an `animation-delay` and a
 * `backwards` fill, and reduced motion zeroes DURATIONS only. Unless motion.css
 * names that animation in its reduced-motion block, the list holds its from-state
 * through the delay and flashes invisible for up to 320ms on exactly the devices
 * that asked for less movement.
 *
 * WHICH IS WHY THE ASSERTION IS ON `animation-name`, NOT ON OPACITY. The first
 * version of this check measured opacity after the page settled and passed with the
 * bug still in the stylesheet — the flash is over in a third of a second, so a
 * screenshot taken a second later shows a perfect page. Same lesson tl-19 recorded
 * about `scrollWidth`: a check that can only see the steady state cannot see a
 * transient. The opacity reading is kept as a second, weaker check, because it
 * catches the different failure of an item hidden permanently.
 */
{
  const { ctx, page, errors } = await newContext(VIEWPORTS[1], { reducedMotion: 'reduce' })
  await signIn(page)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const list = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.activity-item')]
    const cs = items[0] ? getComputedStyle(items[0]) : null
    // The pulse is the other case tokens.css cannot reach, probed off a detached
    // node because the splash is long gone by the time the app has rendered.
    const probe = document.createElement('div')
    probe.className = 'app-splash'
    const mark = document.createElement('div')
    mark.className = 'app-mark'
    probe.appendChild(mark)
    document.body.appendChild(probe)
    const splashPulseName = getComputedStyle(mark).animationName
    probe.remove()
    return {
      count: items.length,
      itemAnimation: cs?.animationName ?? null,
      itemDelay: cs?.animationDelay ?? null,
      hidden: items.filter((el) => getComputedStyle(el).opacity !== '1').length,
      splashPulseName,
    }
  })
  note(
    'reduced motion: the staggered entrance is switched off by name, not shortened',
    list.count > 0 && list.itemAnimation === 'none',
    `${list.count} items, animation-name: ${list.itemAnimation}, delay: ${list.itemDelay}`,
  )
  note(
    'reduced motion: the task list is present and fully visible',
    list.count > 0 && list.hidden === 0,
    `${list.count} items, ${list.hidden} at opacity < 1`,
  )
  note(
    'reduced motion: the splash pulse is switched off by name, not shortened',
    list.splashPulseName === 'none',
    `animation-name: ${list.splashPulseName}`,
  )
  note('reduced motion: no page errors on the signed-in home route', errors.length === 0, errors.slice(0, 2).join(' | '))
  await page.screenshot({ path: `${SHOTS}/reduced-motion-home.png`, fullPage: true })
  await ctx.close()
}

await browser.close()

const owned = results.filter((r) => r.owned)
const failed = owned.filter((r) => !r.ok)
const warned = results.filter((r) => !r.owned && !r.ok)
console.log(`\nScreenshots in ${SHOTS}/ — the human half of this audit.`)
console.log(`${owned.length - failed.length}/${owned.length} PASS, ${failed.length} FAIL`)
if (warned.length) {
  console.log(`\n${warned.length} WARN on routes nobody has claimed yet:`)
  for (const w of warned) console.log(`  - ${w.label}${w.detail ? ' | ' + w.detail : ''}`)
}
process.exit(failed.length === 0 ? 0 : 1)
