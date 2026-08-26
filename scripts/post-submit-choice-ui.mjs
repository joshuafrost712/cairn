/**
 * The post-submit choice, driven in a real browser.
 *
 * Submitting used to end with `navigate('/evaluations')`, which took an evaluator
 * who had just written something and put them on the one screen that lists what
 * they had already written and offers no way onward. What they want next, in a
 * workshop room, is almost always another capture for the session they are still
 * sitting in.
 *
 * `test/postSubmitChoice.test.ts` reads the source and tests the offer's condition
 * as a pure function. Neither can answer the two questions that matter here: does
 * the choice actually appear where the button was, and does taking it open a NEW
 * capture on the same session with a clean attestation box. Only a browser can.
 *
 * Runs against a LOCAL-ONLY server, because local-only mode seeds its own
 * workshop, roster, activities and questions and synthesizes a membership at
 * sign-in. No accounts, no live rows, nothing to tear down — which matters: a
 * harness that signed into the real project would leave test captures in a
 * workshop other people are using.
 *
 *   printf 'VITE_SUPABASE_URL=\nVITE_SUPABASE_ANON_KEY=\n' > .env.localonly
 *   npx vite --mode localonly --port 5203 --strictPort
 *   node scripts/post-submit-choice-ui.mjs
 *   node scripts/post-submit-choice-ui.mjs --expect-bug   # against the old build
 *
 * `--expect-bug` inverts the checks that describe the old behaviour, so the same
 * harness demonstrates it can see a build WITHOUT the change. A probe only ever
 * run against the finished build has shown nothing.
 *
 * PORT 5203, clear of every other harness in this repo (5180, 5181, 5185, 5193,
 * 5198, 5199, 5201) and of 5194, where a `cairn-tl36-pre` worktree was still
 * serving when this was written. A harness pointed at another session's server is
 * the worst kind of green, and that one serves the build without this change.
 *
 * Playwright is deliberately not a dependency of this repo:
 *   npm i -D --no-save playwright && npx playwright install chromium
 */
import { chromium } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'

const BASE = `http://localhost:${process.env.POST_SUBMIT_UI_PORT ?? 5203}/`
const EXPECT_BUG = process.argv.includes('--expect-bug')
const SHOTS = 'screenshots/post-submit-choice'
const NOTE = 'Ada read the passage aloud twice before she drafted anything.'

const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label.slice(0, 66).padEnd(66)} | ${String(detail).slice(0, 80)}`)
}
const note = (label, detail = '') =>
  console.log(`   . | ${label.slice(0, 66).padEnd(66)} | ${String(detail).slice(0, 80)}`)

rmSync(SHOTS, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

/** Fill the first question box, tick the nth name, attest. Leaves submit enabled. */
async function writeACapture(nth, text) {
  await page.waitForSelector('.ksa-cue', { timeout: 20000 })
  await page.locator('textarea').first().fill(text)
  await page.locator('.participant-btn').nth(nth).click()
  await page.locator('input[type=checkbox]').first().check()
  await page.waitForTimeout(300)
}

const submitBtn = () => page.locator('button.primary', { hasText: /^(Submit|Save changes)$/ }).first()
const anotherBtn = () => page.locator('button', { hasText: /Evaluate someone else in this session/ })
const homeBtn = () => page.locator('button', { hasText: /^Back to home$/ })

/**
 * Where something sits in the DOCUMENT, not in the viewport.
 *
 * `boundingBox()` is viewport-relative, and Playwright scrolls an element into
 * view before clicking it, so comparing a box measured before a click with one
 * measured after compares two different scroll frames. That read as a 410px jump
 * on a panel that had not moved at all.
 */
const docY = (locator) =>
  locator.first().evaluate((el) => el.getBoundingClientRect().top + window.scrollY)

try {
  await page.goto(`${BASE}signin`, { waitUntil: 'networkidle' })
  await page.getByPlaceholder('e.g. Joshua Frost').fill('Post Submit Probe')
  await page.getByPlaceholder('you@example.org').fill('post-submit-probe@example.org')
  await page.locator('button[type=submit]').click()
  await page.waitForSelector('.activity-item:visible', { timeout: 20000 })

  // ---- 1. submitting does not throw you off the capture -------------------

  await page.locator('.activity-item:visible').first().click()
  await page.waitForURL(/\/capture\//, { timeout: 20000 })
  const firstCapture = page.url()
  const activityTitle = await page.locator('h1').first().innerText()
  await writeACapture(0, NOTE)
  const submitY = await docY(submitBtn())
  await page.screenshot({ path: `${SHOTS}/01-ready-to-submit.png`, fullPage: true })

  await submitBtn().click()
  await page.waitForTimeout(1500)
  note('after submit', page.url())

  const wentToList = /\/evaluations/.test(page.url())
  check(
    EXPECT_BUG ? wentToList : !wentToList,
    EXPECT_BUG
      ? 'the old build redirects to the list of what you already submitted'
      : 'submitting leaves you on the capture, not on a list of old ones',
    page.url(),
  )
  if (EXPECT_BUG) {
    check(
      (await anotherBtn().count()) === 0,
      'and the old build offers no choice about what to do next',
      `${await anotherBtn().count()} buttons`,
    )
    await page.screenshot({ path: `${SHOTS}/02-old-build-redirected.png`, fullPage: true })
    note('the remaining checks need the panel; stopping here as expected', '')
    throw { expected: true }
  }

  // ---- 2. the panel, and where it is --------------------------------------

  const banner = page.locator('[role=status]').filter({ hasText: /Submitted/ })
  check((await banner.count()) > 0, 'a confirmation says the capture was submitted')
  check(await anotherBtn().isVisible(), 'it offers another capture for the same session')
  check(await homeBtn().isVisible(), 'and it offers the home screen')
  await page.screenshot({ path: `${SHOTS}/03-panel.png`, fullPage: true })

  // GEOMETRY, not innerText. The panel has to land where the submit button was:
  // the form is over a thousand pixels long on a phone and a confirmation
  // anywhere else is one nobody scrolls back up to read. The tolerance is one
  // banner's worth of height, which is exactly what the panel adds above the row.
  const panelY = await docY(anotherBtn())
  const drift = Math.abs(panelY - submitY)
  check(
    drift < 120,
    'and it lands where the submit button was, within a line or two',
    `submit y=${Math.round(submitY)}, panel y=${Math.round(panelY)}, drift ${Math.round(drift)}px`,
  )
  check(
    (await submitBtn().count()) === 0,
    'the submit button is replaced rather than sitting beside the panel',
  )

  // ---- 3. typing again is a decision to keep working on THIS one ----------

  await page.locator('textarea').first().fill(`${NOTE} She hesitated on verse 3.`)
  await page.waitForTimeout(400)
  check(
    (await anotherBtn().count()) === 0 && (await submitBtn().count()) === 1,
    'changing a word puts the save button back and clears the panel',
  )
  check(
    (await submitBtn().innerText()).trim() === 'Save changes',
    'and the button now reads as a save, because this one is submitted',
    (await submitBtn().innerText()).trim(),
  )
  await page.screenshot({ path: `${SHOTS}/04-kept-editing.png`, fullPage: true })

  // ---- 4. saving an edit also stays put, and says so differently ----------

  await submitBtn().click()
  await page.waitForTimeout(1200)
  check(page.url() === firstCapture, 'saving a change to a submitted capture stays on it', page.url())
  const saved = page.locator('[role=status]').filter({ hasText: /Changes saved/ })
  check((await saved.count()) > 0, 'and the panel says the change was saved, not that it was submitted')
  await page.screenshot({ path: `${SHOTS}/05-changes-saved.png`, fullPage: true })

  // ---- 5. another capture, same session, clean slate ----------------------

  await anotherBtn().click()
  await page.waitForTimeout(1500)
  check(/\/capture\//.test(page.url()) && page.url() !== firstCapture, 'it opens a NEW capture', page.url())
  await page.waitForSelector('.ksa-cue', { timeout: 20000 })
  check(
    (await page.locator('h1').first().innerText()) === activityTitle,
    'on the same session, not back at the picker',
    (await page.locator('h1').first().innerText()).slice(0, 40),
  )
  // The carry-over the route key exists to stop. Same route, different param, so
  // without the key the component stays mounted and this box stays ticked — and a
  // ticked box means the next Submit is live without anybody attesting to anything.
  check(
    !(await page.locator('input[type=checkbox]').first().isChecked()),
    'with the attestation box unticked',
  )
  check((await page.locator('[role=status]').count()) === 0, 'and no panel greeting a blank capture')
  check(
    (await page.locator('textarea').first().inputValue()) === '',
    'and empty boxes, not the last capture’s text',
  )
  const badges = await page.locator('.participant-btn .coverage-badge').count()
  check(badges >= 1, 'the person just evaluated now carries a coverage tick', `${badges} badge(s)`)
  await page.screenshot({ path: `${SHOTS}/06-another-same-session.png`, fullPage: true })

  // ---- 6. and the way out -------------------------------------------------

  await writeACapture(1, 'Bo explained the tree and the water as decoration.')
  await submitBtn().click()
  await page.waitForTimeout(1500)
  await homeBtn().click()
  await page.waitForTimeout(1000)
  check(new URL(page.url()).pathname === new URL(BASE).pathname, 'back to home goes home', page.url())

  // ---- 7. the free-write capture says it differently ----------------------

  await page.locator('button', { hasText: /Just write what you saw/ }).first().click()
  await page.waitForSelector('#free-write', { timeout: 20000 })
  await page.locator('#free-write').fill('Cai would not decide the dispute for the group.')
  await page.locator('.participant-btn').nth(2).click()
  await page.locator('input[type=checkbox]').first().check()
  await page.waitForTimeout(300)
  await submitBtn().click()
  await page.waitForTimeout(1500)
  check(/\/capture\//.test(page.url()), 'a free-write submit also stays put', page.url())
  const writeAnother = page.locator('button', { hasText: /^Write another$/ })
  check(
    (await writeAnother.count()) === 1 && (await anotherBtn().count()) === 0,
    'and it offers "Write another", because it has no session to return to',
  )
  await page.screenshot({ path: `${SHOTS}/07-free-write-panel.png`, fullPage: true })
  await writeAnother.click()
  await page.waitForTimeout(1500)
  check(
    (await page.locator('#free-write').count()) === 1 &&
      (await page.locator('#free-write').inputValue()) === '',
    'which opens another empty free-write, not the question form',
  )

  // ---- 8. the list you used to be dumped on now has a way out -------------

  await page.goto(`${BASE}evaluations`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  const onward = page.locator('a', { hasText: /Start another evaluation/ })
  check((await onward.count()) === 1, 'My evaluations offers a way back to the home screen')
  await onward.click()
  await page.waitForTimeout(800)
  check(
    new URL(page.url()).pathname === new URL(BASE).pathname,
    'and it goes there',
    page.url(),
  )

  // ---- 9. phone width, because this is dictated standing up ---------------

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('.activity-item:visible', { timeout: 20000 })
  await page.locator('.activity-item:visible').first().click()
  await page.waitForURL(/\/capture\//, { timeout: 20000 })
  await writeACapture(3, 'Dee kept the group on the passage.')
  await submitBtn().click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${SHOTS}/08-390px-panel.png`, fullPage: true })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  check(overflow <= 0, 'no horizontal overflow at 390px with the panel showing', `${overflow}px`)
  // Both choices have to be reachable by thumb, not just present in the DOM.
  for (const [label, btn] of [
    ['another', anotherBtn()],
    ['home', homeBtn()],
  ]) {
    const box = await btn.boundingBox()
    check(
      box !== null && box.width > 40 && box.height > 24 && box.x >= 0 && box.x + box.width <= 390,
      `the "${label}" button is a real tap target inside a 390px screen`,
      box ? `${Math.round(box.width)}x${Math.round(box.height)} at x=${Math.round(box.x)}` : 'no box',
    )
  }
} catch (e) {
  if (!e?.expected) check(false, 'the harness ran to completion', String(e).slice(0, 200))
}

check(errors.length === 0, 'no uncaught page error', errors.slice(0, 2).join(' | '))

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${SHOTS}/`)
for (const f of failed) console.log(`  - ${f.label}`)
process.exit(failed.length ? 1 : 0)
