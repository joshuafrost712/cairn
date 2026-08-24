/**
 * tl-36, driven in a real browser: is the free-write box actually there, and does
 * it replace the form rather than sit beside it?
 *
 * A passing unit suite cannot answer either question. The invariants in
 * `test/freeWrite.test.ts` read the source; this renders it.
 *
 * Runs against a LOCAL-ONLY build with `.env` moved aside, because local-only mode
 * seeds its own workshop, roster, activities and questions (`primeFromSeed`) and
 * synthesizes a membership at sign-in. No accounts, no live rows, nothing to tear
 * down. That matters more than usual today: the Psalms workshop opened this
 * morning and a harness that signed into it would leave residue in a room full of
 * people using the app.
 *
 *   mv .env .env.off && npx vite --port 5193 --strictPort ; mv .env.off .env
 *   node scripts/tl36-free-write-ui.mjs
 *   node scripts/tl36-free-write-ui.mjs --expect-bug     # on main
 *
 * `--expect-bug` inverts the four checks that describe the absence, so the same
 * harness shows it can see a build without the feature. A probe only ever run
 * against the finished build has shown nothing, which this wave has now learned
 * twice in three specs.
 *
 * PORT 5193, clear of every other harness in this wave (5180 dev, 5191 carryover,
 * 5201 tl-26). A harness pointed at another session's server is the worst green.
 *
 * Playwright is deliberately not a dependency of this repo:
 *   npm i -D --no-save playwright && npx playwright install chromium
 */
import { chromium } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'

const BASE = `http://localhost:${process.env.TL36_UI_PORT ?? 5193}/`
const EXPECT_BUG = process.argv.includes('--expect-bug')
const SHOTS = 'screenshots/tl36-free-write'
const DUMP =
  'Ada had the MTT pair sort their own songs before she mentioned psalms at all. ' +
  'Bo read the passage aloud three times but explained the tree and the water as ' +
  'decoration on a proposition. Cai would not decide the dispute for the group.'

const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label.slice(0, 68).padEnd(68)} | ${String(detail).slice(0, 80)}`)
}
const note = (label, detail = '') =>
  console.log(`   . | ${label.slice(0, 68).padEnd(68)} | ${String(detail).slice(0, 80)}`)

rmSync(SHOTS, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

try {
  await page.goto(`${BASE}signin`, { waitUntil: 'networkidle' })
  await page.getByPlaceholder('e.g. Joshua Frost').fill('TL36 Probe')
  await page.getByPlaceholder('you@example.org').fill('tl36-probe@example.org')
  await page.locator('button[type=submit]').click()
  await page.waitForSelector('.activity-item', { timeout: 20000 })
  await page.screenshot({ path: `${SHOTS}/01-home.png`, fullPage: true })

  // ---- 1. the entry point exists, and is above the schedule ----------------

  const startBtn = page.locator('button', { hasText: /Just write what you saw/ })
  const present = (await startBtn.count()) > 0
  check(
    EXPECT_BUG ? !present : present,
    EXPECT_BUG
      ? 'before the fix there is no way to start a capture without a session'
      : 'the home screen offers a capture that needs no session',
  )
  if (EXPECT_BUG && !present) {
    note('the remaining checks need the button; stopping here as expected', '')
    throw { expected: true }
  }

  const btnBox = await startBtn.first().boundingBox()
  const firstActivity = await page.locator('.activity-item').first().boundingBox()
  check(
    btnBox !== null && firstActivity !== null && btnBox.y < firstActivity.y,
    'and it sits above the session list, not under it',
    `button y=${Math.round(btnBox?.y ?? -1)}, first session y=${Math.round(firstActivity?.y ?? -1)}`,
  )

  // ---- 2. the free-write capture: one box, no form ------------------------

  await startBtn.first().click()
  await page.waitForURL(/\/capture\//, { timeout: 20000 })
  await page.waitForSelector('#free-write', { timeout: 20000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOTS}/02-free-write.png`, fullPage: true })

  const boxes = await page.locator('textarea').count()
  check(boxes === 1, 'exactly one textarea on the screen', `${boxes}`)
  check(
    (await page.locator('.ksa-cue').count()) === 0,
    'no per-question prompt is rendered',
    `${await page.locator('.ksa-cue').count()} cues`,
  )
  check(
    (await page.locator('.quick-rating, .rating-chip').count()) === 0,
    'no rating control is rendered',
  )

  const promise = await page.locator('.free-write-promise').innerText()
  check(
    /write what you saw/i.test(promise) && /name the people/i.test(promise),
    'the promise is printed above the box',
    promise.slice(0, 70),
  )

  // The question set is visible on request, and is the WORKSHOP's, not a session's.
  const fold = page.locator('details.day-fold', { hasText: /filed against/i })
  check((await fold.count()) > 0, 'the questions it can be filed against are one click away')
  await fold.first().click()
  await page.waitForTimeout(200)
  const listed = await fold.first().locator('li').count()
  const perSessionMax = 3
  check(
    listed > perSessionMax,
    'and there are more of them than any one session carries',
    `${listed} listed, most any session wires is ${perSessionMax}`,
  )
  await page.screenshot({ path: `${SHOTS}/03-questions-open.png`, fullPage: true })

  // ---- 3. the submit gate: text is not enough, a name is needed -----------

  await page.locator('#free-write').fill(DUMP)
  await page.locator('input[type=checkbox]').first().check()
  await page.waitForTimeout(300)
  const submit = page.locator('button.primary', { hasText: /Submit|Save changes/ }).first()
  check(await submit.isDisabled(), 'attested, written, nobody named: submit is refused')
  const reason = page.locator('p', { hasText: /at least one name/i })
  check((await reason.count()) > 0, 'and the screen says which half is missing')
  await page.screenshot({ path: `${SHOTS}/04-needs-a-name.png`, fullPage: true })

  await page.locator('.participant-btn').nth(0).click()
  await page.locator('.participant-btn').nth(1).click()
  await page.waitForTimeout(300)
  check(await submit.isEnabled(), 'name two people and it is allowed')
  check(
    (await page.locator('.participant-btn.primary').count()) === 2,
    'two at once, because a brain dump is about several people',
  )
  await page.screenshot({ path: `${SHOTS}/05-two-named.png`, fullPage: true })

  const captureUrl = page.url()
  await submit.click()
  await page.waitForTimeout(1200)
  note('after submit', page.url())

  // ---- 4. what the submitted capture holds --------------------------------

  await page.goto(captureUrl, { waitUntil: 'networkidle' })
  await page.waitForSelector('#free-write', { timeout: 20000 })
  await page.waitForTimeout(500)
  const readBack = await page.locator('#free-write').inputValue()
  check(readBack === DUMP, 'reopening it shows the prose back, not an empty box', `${readBack.length} chars`)
  check(
    (await page.locator('textarea').count()) === 1,
    'and it is still the free-write screen, not the form',
  )
  await page.screenshot({ path: `${SHOTS}/06-reopened.png`, fullPage: true })

  // ---- 5. THE REGRESSION THAT MATTERS: a normal capture is unchanged ------
  // Twenty-four people are using the per-session form this week. If this spec
  // changed what they see, the finding is here and not in the new box.

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('.activity-item', { timeout: 20000 })
  await page.locator('.activity-item').first().click()
  await page.waitForURL(/\/capture\//, { timeout: 20000 })
  await page.waitForSelector('.ksa-cue', { timeout: 20000 })

  // The flash check. `freeWrite` is derived, and an unresolved question set used to
  // read as "no questions", so an initial `[]` would have shown the free-write box
  // for a frame on every per-session capture. Sampled hard for the first second.
  let sawFreeBox = 0
  for (let i = 0; i < 20; i++) {
    if ((await page.locator('#free-write').count()) > 0) sawFreeBox++
    await page.waitForTimeout(50)
  }
  check(sawFreeBox === 0, 'a per-session capture never shows the free-write box', `${sawFreeBox}/20 samples`)

  const cues = await page.locator('.ksa-cue').count()
  check(cues > 0, 'its per-question prompts still render', `${cues}`)
  check(
    (await page.locator('textarea').count()) === cues,
    'one textarea per question, as before',
    `${await page.locator('textarea').count()} boxes, ${cues} questions`,
  )
  const focus = page.locator('.rubric-toggle', { hasText: /Focus/ })
  check((await focus.count()) > 0, 'and the focus toggle is still offered there')
  await page.screenshot({ path: `${SHOTS}/07-per-session-unchanged.png`, fullPage: true })

  // ---- 6. phone width, because this is dictated standing up ---------------

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('button:has-text("Just write what you saw")', { timeout: 20000 })
  await page.locator('button', { hasText: /Just write what you saw/ }).first().click()
  await page.waitForSelector('#free-write', { timeout: 20000 })
  await page.waitForTimeout(400)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  check(overflow <= 0, 'no horizontal overflow at 390px', `${overflow}px`)
  await page.screenshot({ path: `${SHOTS}/08-390px.png`, fullPage: true })
} catch (e) {
  if (!e?.expected) check(false, 'the harness ran to completion', String(e).slice(0, 200))
}

check(errors.length === 0, 'no uncaught page error', errors.slice(0, 2).join(' | '))

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${SHOTS}/`)
for (const f of failed) console.log(`  - ${f.label}`)
process.exit(failed.length ? 1 : 0)
