/**
 * tl-14's client half, in a browser.
 *
 * The unit tests own the arithmetic (51 of them, with the sums written out) and
 * `scripts/tl14-schema-checks.mjs` owns the live column and its trigger. What neither
 * can reach is the thing this wave has found a bug in every single time: what an
 * administrator actually sees, and whether a control they touch reaches a store and
 * comes back.
 *
 * What is under test, in order:
 *   1. The estimate renders real numbers from the seeded workshop, not a placeholder.
 *   2. It labels derived numbers and assumptions separately, and states its exclusions.
 *   3. It shows the registry's review date, so a stale price is visible as stale.
 *   4. Changing an assumption moves the estimate in the expected direction, and the
 *      new value survives a reload — the difference between an input and a setting.
 *   5. Choosing a model goes through tl-07's change dialog and persists.
 *   6. Currency appears only in the metered mode. In local-only mode hosted AI is
 *      unavailable, so the workshop is on a subscription mode and there must be no
 *      dollar figure anywhere in the panel: a made-up price is the one thing this
 *      spec's success criteria forbid outright.
 *   7. The free-tier caveat is on screen, because this deployment's key is a free one.
 *   8. The actuals card says plainly that nothing has been measured yet, rather than
 *      showing a zero that reads like a measurement.
 *
 *   VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npx vite --port 5198 --strictPort
 *   node scripts/tl14-estimator.mjs
 *
 * Port 5198, one above tl-13's: a harness pointed at another worktree's server is the
 * worst possible green, so the constant moves with the server.
 *
 * Playwright is deliberately not a dependency:
 *   npm i -D --no-save playwright && npx playwright install chromium
 */
import { chromium } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'

const BASE = `http://localhost:${process.env.TL14_PORT ?? 5198}/`
const SHOTS = 'screenshots/tl14-estimator'

const results = []
const check = (ok, label, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label.slice(0, 66).padEnd(66)} | ${String(detail).slice(0, 90)}`)
}

rmSync(SHOTS, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
const page = await ctx.newPage()

const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})

async function signIn() {
  await page.goto(BASE + 'signin', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#name', { timeout: 20000 })
  await page.fill('#name', 'tl14 Auditor')
  await page.fill('#email', 'tl14-auditor@example.org')
  await page.click('button[type=submit]')
  await page.waitForTimeout(1500)
}

async function elevate() {
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
  await page.waitForTimeout(1200)
}

const text = () => page.evaluate(() => document.body.innerText)

/** Read the emphasised (expected-case) token figure off the band. */
async function expectedTokens() {
  const raw = await page
    .locator(".est-figure[data-emphasis='yes'] .est-figure__value")
    .first()
    .innerText()
  return Number(raw.replace(/[^\d]/g, ''))
}

async function confirmDialog() {
  const confirm = page.locator('dialog button, .modal button, [role=dialog] button').filter({
    hasText: /^(Save|Apply|Confirm|Save anyway|Yes)/i,
  })
  if ((await confirm.count()) > 0) {
    await confirm.first().click()
    await page.waitForTimeout(700)
    return true
  }
  return false
}

await signIn()
await elevate()
await page.goto(BASE + 'admin/setup/ai', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
await page.screenshot({ path: `${SHOTS}/01-desktop.png`, fullPage: true })

// ---------------------------------------------------------------------------
// 1-3. What the panel says.
// ---------------------------------------------------------------------------
let baseline = 0
{
  const body = await text()
  check(body.includes('What this would cost'), '1. the estimate panel renders')

  const hasBand = (await page.locator('.est-figure').count()) >= 3
  check(hasBand, '1. low / expected / high are all present', `${await page.locator('.est-figure').count()} figures`)

  if (hasBand) {
    baseline = await expectedTokens()
    // The demo scenario seeds a real workshop, so a zero here would mean the shape
    // derivation found nothing and the panel is showing a placeholder.
    check(baseline > 0, '1. the expected figure is a real number from the workshop', `${baseline} tokens`)
  }

  check(
    body.includes('From this workshop') && body.includes('Assumed'),
    '2. derived numbers and assumptions are labelled separately',
  )
  check(
    body.includes('Retries') && body.includes('Re-routing') && body.includes('Your own iteration'),
    '2. the exclusions are stated with the range',
  )
  check(
    body.includes('Prices and terms last checked'),
    '3. the registry review date is on screen',
  )
}

// ---------------------------------------------------------------------------
// 4. An assumption is a setting, not a scratch input.
// ---------------------------------------------------------------------------
{
  const input = page.locator('#assume-captureChars')
  const before = await input.inputValue()
  await input.fill(String(Number(before) * 4))
  await page.locator('button', { hasText: 'Save assumptions' }).first().click()
  await page.waitForTimeout(1200)

  const after = await expectedTokens()
  check(
    after > baseline,
    '4. a longer assumed capture raises the estimate',
    `${baseline} -> ${after} tokens`,
  )

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const persisted = await page.locator('#assume-captureChars').inputValue()
  check(
    Number(persisted) === Number(before) * 4,
    '4. the changed assumption survives a reload',
    `stored ${persisted}`,
  )
  await page.screenshot({ path: `${SHOTS}/02-assumption-changed.png`, fullPage: true })

  // And back, so the rest of the run reads the defaults.
  await page.locator('button', { hasText: 'Back to defaults' }).first().click()
  await page.waitForTimeout(1200)
  const reset = await page.locator('#assume-captureChars').inputValue()
  check(Number(reset) === Number(before), '4. reset restores the default', `back to ${reset}`)
}

// ---------------------------------------------------------------------------
// 5. A model choice is a config change, so it goes through the dialog.
// ---------------------------------------------------------------------------
{
  // Scoped to the model card, not just to the row text. The function's name appears
  // in BOTH the toggles list and this one, so an unscoped `.first()` finds the toggle
  // row and reports an empty picker — which is a harness bug that looks exactly like a
  // broken control.
  const modelCard = page.locator('.card', { hasText: 'Which model' }).first()
  const row = modelCard.locator('li.ai-fn', { hasText: 'Turning captures into observations' }).first()
  const select = row.locator('select').first()
  const options = await select.locator('option').allInnerTexts()
  check(options.length > 1, '5. the model picker offers the registry, plus a default', options.join(' / '))

  const target = options.find((o) => o.startsWith('Claude') || o.startsWith('Gemini'))
  if (target) {
    await select.selectOption({ label: target })
    await page.waitForTimeout(600)
    const sawDialog = await confirmDialog()
    check(sawDialog, '5. choosing a model routes through the change dialog')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    const still = await page
      .locator('.card', { hasText: 'Which model' })
      .first()
      .locator('li.ai-fn', { hasText: 'Turning captures into observations' })
      .first()
      .locator('select')
      .first()
      .inputValue()
    check(still !== '', '5. the chosen model persists across a reload', `value ${still}`)
  }
}

// ---------------------------------------------------------------------------
// 6-8. Honesty properties.
// ---------------------------------------------------------------------------
{
  const body = await text()
  // Local-only build: hosted AI is unavailable, so the workshop is on a subscription
  // mode. The panel must show tokens and no invented price. `$0.10 / $0.40` in the
  // registry list is a published rate, not a claim about this workshop, so the check
  // is scoped to the estimate card's own figures.
  const usdInFigures = await page.locator('.est-figure__usd').count()
  check(
    usdInFigures === 0,
    '6. no dollar figure in a subscription mode',
    `${usdInFigures} usd figures`,
  )
  check(
    body.includes('runs on a subscription rather than per token'),
    '6. and it says why there is no dollar figure',
  )
  // The caveat is per entry and gated on `free_tier_differs`, so the assertion is
  // about the GATING rather than about the words appearing somewhere: printed once
  // above the list it was false for the three Anthropic entries, and in a subscription
  // mode those are the only reachable ones.
  const caveats = await page.locator('.pill', { hasText: 'Paid tier only' }).count()
  check(caveats === 3, '7. the free-tier caveat is on exactly the three Gemini entries', `${caveats}`)
  check(
    body.includes('Google’s pricing page marks free-tier content'),
    '7. and it quotes the pricing page, which is where that claim actually lives',
  )
  const freeSrc = await page.locator('a', { hasText: 'Read the free-tier statement' }).count()
  check(freeSrc === 3, '7. with its own link, not the paid-tier one', `${freeSrc} links`)
  // The provider's own wording is rendered, not just this app's three-word summary.
  check(
    body.includes('retained data is never used for model training'),
    '7. each entry shows the provider’s own words, so the summary can be judged',
  )
  check(
    body.includes('No model call from this workshop has reported token counts yet'),
    '8. actuals say nothing is measured rather than showing a zero',
  )
}

// ---------------------------------------------------------------------------
// The 390px view, because a passing audit is not a usable layout.
// ---------------------------------------------------------------------------
{
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${SHOTS}/03-phone.png`, fullPage: true })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  check(overflow <= 1, 'phone: no horizontal body overflow at 390px', `${overflow}px`)

  // The assertion the audit cannot make: the controls are actually reachable. Every
  // assumption input and every model select must sit inside the viewport, which is the
  // exact failure tl-09's scale editor and tl-13's toggles both shipped.
  const offscreen = await page.evaluate(() => {
    const bad = []
    for (const el of document.querySelectorAll('.est-assume__input, li.ai-fn select, .est-figure')) {
      const r = el.getBoundingClientRect()
      if (r.right > window.innerWidth + 1 || r.left < -1) bad.push(el.className || el.tagName)
    }
    return bad
  })
  check(offscreen.length === 0, 'phone: every control and figure is inside the viewport', offscreen.join(', '))
}

check(errors.length === 0, 'no page errors', errors.slice(0, 2).join(' | '))

await browser.close()
const passed = results.filter(Boolean).length
console.log(`\ntl-14 estimator: ${passed}/${results.length} passed. Screenshots in ${SHOTS}/`)
process.exit(passed === results.length ? 0 : 1)
