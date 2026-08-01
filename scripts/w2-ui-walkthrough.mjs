/**
 * Wave 2's three new surfaces, rendered in a real browser against the real
 * backend.
 *
 * The unit tests prove the rules and the session harness proves the policies.
 * Neither renders anything, and a page that throws on mount passes both. This
 * script is the missing leg: it signs a chief in, drives the board, and asserts
 * on what is actually on screen.
 *
 * What it pins, in the order the administrator would meet it:
 *   1. /admin/assignments renders, and every participant starts under-assigned.
 *   2. Auto-assign PROPOSES and writes nothing until confirmed.
 *   3. Applying the proposal clears the warning colour.
 *   4. A transfer moves a card and both columns' loads follow.
 *   5. /admin/progress renders the chain, and /admin/settings the quotas.
 *
 * Requires the throwaway accounts and their fixture workshop:
 *
 *   node scripts/w2-session-tests.mjs --keep
 *   npm run dev -- --port 5180          # in another shell
 *   node scripts/w2-ui-walkthrough.mjs
 *   node scripts/w2-session-tests.mjs --teardown
 *
 * Playwright is deliberately not a dependency of this repo:
 *   npm i -D --no-save playwright && npx playwright install chromium
 *
 * The dev server is fine here, unlike the offline-seam script, because nothing
 * below depends on a service worker.
 */
import { chromium } from 'playwright'

const BASE = 'http://localhost:5180/'
const PASSWORD = 'w2-Throwaway-Password-1!'
const CHIEF = 'w2-session-chief@example.org'
const ADMIN = 'w2-session-admin@example.org'

const results = []
function check(ok, label, detail = '') {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label.padEnd(64)} | ${detail}`)
}

const errors = []

const browser = await chromium.launch()

/** A fresh signed-in page. Its own context, so the two accounts never share a session. */
async function signedInPage(email) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => errors.push(String(e)))
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  // '/signin', not the root: since tl-19 a signed-out visitor at '/' is sent to
  // the public landing page, so the form is one navigation further in.
  await p.goto(BASE + 'signin', { waitUntil: 'networkidle' })
  await p.getByLabel(/email/i).first().fill(email)
  await p.getByLabel(/password/i).first().fill(PASSWORD)
  await p.getByRole('button', { name: /sign in/i }).first().click()
  await p.waitForSelector('.shell__brand, .pagehead__title', { timeout: 20000 })
  return p
}

/**
 * Wait for the board to stop repainting, then count.
 *
 * Each assign() is its own Dexie write and useLiveQuery repaints per write, so
 * sampling too early reads a half-applied board. Both counters have to settle,
 * not just one: `unassigned` reaches zero as soon as every participant has their
 * FIRST assignee, while several are still one short of the threshold.
 */
async function settledBoard(p, { unassigned, under }) {
  await p
    .waitForFunction(
      ({ u, d }) =>
        document.querySelectorAll('.kanban__card--unassigned').length === u &&
        document.querySelectorAll('.kanban__card--under').length === d,
      { u: unassigned, d: under },
      { timeout: 25000 },
    )
    .catch(() => {})
  return {
    unassigned: await p.locator('.kanban__card--unassigned').count(),
    under: await p.locator('.kanban__card--under').count(),
  }
}

try {
  const page = await signedInPage(CHIEF)
  check(true, 'chief signs in against the real backend', await page.title())

  // --- the board -----------------------------------------------------------
  await page.goto(`${BASE}admin/assignments`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.kanban', { timeout: 15000 })

  const columns = await page.locator('.kanban__col').count()
  check(columns >= 2, 'the board renders with an unassigned column plus evaluators', `${columns} columns`)

  const unassignedBefore = await page.locator('.kanban__card--unassigned').count()
  check(unassignedBefore > 0, 'participants start in the attention colour', `${unassignedBefore} unassigned`)

  const metaBefore = await page.locator('.pagehead__meta').first().innerText()
  check(/short of/.test(metaBefore), 'the header leads with how many are short', metaBefore.trim())

  // --- assign one by hand, then move them ----------------------------------
  // Done BEFORE auto-assign, because once everybody has every evaluator there
  // is nowhere left to move a card to and the control correctly offers nothing.
  const firstUnassigned = page.locator('.kanban__col--none .kanban__card').first()
  const movedName = (await firstUnassigned.locator('.kanban__name').innerText()).trim()
  const picker = firstUnassigned.locator('select.cell-select')
  const firstTarget = await picker.locator('option').nth(1).getAttribute('value')
  await picker.selectOption(firstTarget)
  await page.waitForFunction(
    (n) => document.querySelectorAll('.kanban__card--unassigned').length === n,
    unassignedBefore - 1,
    { timeout: 15000 },
  )
  check(true, 'a participant can be assigned from the unassigned pile', `${movedName} -> ${firstTarget}`)

  const placed = page
    .locator('.kanban__col:not(.kanban__col--none)')
    .filter({ hasText: movedName })
  check((await placed.count()) === 1, 'the card appears under exactly one evaluator', movedName)

  const moveSelect = placed.locator('.kanban__card select.cell-select').first()
  const secondTarget = await moveSelect.locator('option').nth(1).getAttribute('value')
  if (secondTarget) {
    await moveSelect.selectOption(secondTarget)
    await page.waitForTimeout(1200)
    const nowUnder = await page
      .locator('.kanban__col:not(.kanban__col--none)')
      .filter({ hasText: movedName })
      .count()
    check(nowUnder === 1, 'a transfer moves the card rather than duplicating it', `${movedName} -> ${secondTarget}`)
  } else {
    check(false, 'transfer had no destination to offer', 'only one evaluator?')
  }

  // --- auto-assign proposes, and writes nothing ----------------------------
  await page.getByRole('button', { name: /^auto-assign$/i }).click()
  await page.waitForSelector('.proposal', { timeout: 10000 })
  const proposalRows = await page.locator('.proposal p').count()
  check(proposalRows > 0, 'auto-assign shows what it intends to do', `${proposalRows} proposed`)

  const reasons = await page.locator('.proposal .n-badge').first().innerText()
  check(
    /observation|balancing load/.test(reasons),
    'each proposal says WHY that evaluator',
    reasons.trim(),
  )

  const beforeApply = unassignedBefore - 1
  const stillUnassigned = await page.locator('.kanban__card--unassigned').count()
  check(
    stillUnassigned === beforeApply,
    'nothing is written before the administrator confirms',
    `${stillUnassigned} still unassigned`,
  )

  // --- apply ---------------------------------------------------------------
  await page.getByRole('button', { name: /^make these/i }).click()
  const after = await settledBoard(page, { unassigned: 0, under: 0 })
  check(
    after.unassigned === 0,
    'applying clears the attention colour entirely',
    `${unassignedBefore} unassigned -> ${after.unassigned}`,
  )
  check(after.under === 0, 'nobody is left short of the threshold', `${after.under} under-assigned`)

  const metaAfter = await page.locator('.pagehead__meta').first().innerText()
  check(/enough assignees/.test(metaAfter), 'the header agrees with the board', metaAfter.trim())

  // --- the observation board -----------------------------------------------
  await page.goto(`${BASE}admin/assignments?kind=observation`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.kanban', { timeout: 15000 })
  const obsHeading = await page.locator('.card h2').first().innerText()
  check(/watches/i.test(obsHeading), 'the observation board is a different board', obsHeading.trim())

  // --- progress ------------------------------------------------------------
  await page.goto(`${BASE}admin/progress`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.dt, .empty', { timeout: 15000 })
  const headers = await page.locator('.dt thead th').allInnerTexts()
  const wanted = ['participant', 'evidence', 'verification', 'reviewers', 'document', 'email']
  const got = headers.map((h) => h.trim().toLowerCase())
  check(
    wanted.every((w) => got.some((g) => g.includes(w))),
    'progress shows the whole chain in one row',
    got.join(' / '),
  )

  // --- settings, as an admin ------------------------------------------------
  // A separate account because Settings is ADMIN_ROLES while the board is
  // CHIEF_ROLES, and that split is intentional: a chief evaluator rebalances the
  // rota, an administrator sets the limits it is balanced against.
  const adminPage = await signedInPage(ADMIN)
  await adminPage.goto(`${BASE}admin/settings`, { waitUntil: 'networkidle' })
  await adminPage.waitForSelector('#reqconf', { timeout: 15000 })
  const threshold = await adminPage.locator('#reqconf').inputValue()
  check(threshold === '2', 'the threshold reads from the synced setting, not localStorage', `value = ${threshold}`)
  const quotaVisible = await adminPage.locator('#revdef').count()
  check(quotaVisible === 1, 'the review quota control is on Settings', `${quotaVisible} field`)
  const perEvaluator = await adminPage.locator('input[aria-label^="Review quota for"]').count()
  check(perEvaluator > 0, 'each evaluator has a per-person quota box', `${perEvaluator} people`)

  // The chief's board must not be reachable from an evaluator's device at all,
  // and Settings must not be reachable from the chief's. Both gates are checked
  // by RequireRole; this is the visible half of the same fact.
  await page.goto(`${BASE}admin/settings`, { waitUntil: 'networkidle' })
  const chiefSawSettings = await page.locator('#reqconf').count()
  check(chiefSawSettings === 0, 'a chief evaluator is kept out of Settings', `${chiefSawSettings} fields visible`)

  // --- nothing blew up -----------------------------------------------------
  // React error boundaries swallow a render failure into a friendly card, so a
  // page can "look fine" while having thrown. Console errors are the tell.
  const real = errors.filter((e) => !/favicon|manifest|Download the React DevTools/i.test(e))
  check(real.length === 0, 'no page errors across the walkthrough', real.slice(0, 2).join(' | ') || 'clean')
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} PASS, ${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
