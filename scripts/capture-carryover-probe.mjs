/**
 * The Bali report, driven in a real browser.
 *
 * An evaluator evaluated one CIT, submitted, went to do the next person in the
 * same session, and found the first one's words in the boxes. None of that is
 * checkable from a module: the suite is Node-only, and the defect lives in what a
 * committed render puts on screen. So this walks it.
 *
 * Runs against a LOCAL-ONLY build, with .env moved aside, because local-only mode
 * seeds its own workshop, roster, activities and questions
 * (db/reference.ts primeFromSeed) and synthesizes a membership at sign-in. No
 * accounts, no fixtures, nothing to tear down.
 *
 *   mv .env .env.off && npx vite --port 5191 ; mv .env.off .env    # in another shell
 *   node scripts/capture-carryover-probe.mjs                       # expects the fix
 *   node scripts/capture-carryover-probe.mjs --expect-bug          # on main
 *
 * --expect-bug inverts the verdict on the two checks that describe the defect
 * itself, so the same harness proves the bug is present before the fix and absent
 * after. A probe that has only ever been run against the fixed build has not
 * shown that it can see the bug.
 *
 * Playwright is deliberately not a dependency of this repo:
 *   npm i -D --no-save playwright && npx playwright install chromium
 */
import { chromium } from 'playwright'

const BASE = `http://localhost:${process.env.PROBE_PORT ?? 5191}/`
const EXPECT_BUG = process.argv.includes('--expect-bug')
const A_TEXT = 'PROBE-ALPHA: the first CIT read the passage twice before drafting.'

const results = []
function check(ok, label, detail) {
  results.push({ ok, label, detail })
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? `\n         ${detail}` : ''}`)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`))

try {
  // ---- sign in (local-only path takes name + email, no password) ----
  // Straight to /signin: a signed-out visitor at / gets the pitch page.
  await page.goto(`${BASE}signin`, { waitUntil: 'networkidle' })
  await page.getByPlaceholder('e.g. Joshua Frost').fill('Probe Evaluator')
  await page.getByPlaceholder('you@example.org').fill('probe@example.org')
  await page.locator('button[type=submit]').click()
  await page.waitForSelector('.activity-item', { timeout: 15000 })

  // ---- start a capture on the first activity ----
  const sessionTitle = (await page.locator('.activity-item strong').first().innerText()).trim()
  await page.locator('.activity-item').first().click()
  await page.waitForURL(/\/capture\//)
  const urlA = page.url()
  await page.waitForSelector('.participant-btn', { timeout: 15000 })

  // Focus mode, so the capture is about exactly one person: the shape the report
  // describes, and the one where re-pointing replaces rather than adds.
  const focusToggle = page.locator('.rubric-toggle', { hasText: /Focus/ }).first()
  if ((await focusToggle.count()) > 0 && (await focusToggle.getAttribute('aria-pressed')) !== 'true') {
    await focusToggle.click()
  }
  const nameA = (await page.locator('.participant-btn').nth(0).innerText()).trim().split('\n')[0]
  const nameB = (await page.locator('.participant-btn').nth(1).innerText()).trim().split('\n')[0]
  await page.locator('.participant-btn').nth(0).click()

  await page.locator('textarea').first().fill(A_TEXT)
  await page.locator('input[type=checkbox]').first().check()
  await page.locator('button.primary', { hasText: /Submit|Save changes/ }).first().click()

  // ---- after submit ----
  await page.waitForTimeout(1200)
  const stayedPut = page.url() === urlA
  check(
    EXPECT_BUG ? !stayedPut : stayedPut,
    EXPECT_BUG
      ? 'before the fix, submitting navigates away to the list of past work'
      : 'submitting stays on the capture, so the next action is not found in a list',
    `url after submit: ${page.url()}`,
  )

  if (!EXPECT_BUG) {
    const ro = await page.locator('textarea').first().getAttribute('readonly')
    check(ro !== null, 'the submitted capture is read-only')
    const stillThere = await page.locator('textarea').first().inputValue()
    check(stillThere === A_TEXT, 'its text is still legible, not blanked or greyed away')
    const rosterDisabled = await page.locator('.participant-btn').first().isDisabled()
    check(rosterDisabled, 'the roster grid is locked, so one tap cannot re-point it')

    const nextBtn = page.locator('button', { hasText: /Evaluate someone else|Review someone else/ })
    check((await nextBtn.count()) > 0, 'there is a button for the next person')
    // Above the fold matters on a locked screen: there is nothing below to read
    // down to, and the report is about somebody who went looking elsewhere.
    const box = await nextBtn.first().boundingBox()
    check(box !== null && box.y < 900, 'and it is above the fold', `y=${Math.round(box?.y ?? -1)}`)

    // ---- THE FRAME THE DEFECT LIVED IN ----
    await nextBtn.first().click()
    await page.waitForURL((u) => u.toString() !== urlA, { timeout: 15000 })
    await page.waitForSelector('textarea', { timeout: 15000 })
    await page.waitForTimeout(600)
    const values = await page.locator('textarea').evaluateAll((ns) => ns.map((n) => n.value))
    check(
      values.every((v) => v === ''),
      'the next person starts empty',
      `${values.length} boxes, non-empty: ${JSON.stringify(values.filter(Boolean))}`,
    )
    const selected = await page.locator('.participant-btn.primary').count()
    check(selected === 0, 'and with nobody selected')
    const heading = (await page.locator('h1').first().innerText()).trim()
    check(heading === sessionTitle, 'still in the same session', `${heading}`)
    const editable = (await page.locator('textarea').first().getAttribute('readonly')) === null
    check(editable, 'and it is a draft, not another locked screen')
  }

  // ---- the list that sent people to the wrong capture ----
  await page.goto(`${BASE}evaluations`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.activity-item', { timeout: 15000 })
  const headlines = await page.locator('.activity-item strong').allInnerTexts()
  check(
    EXPECT_BUG ? headlines.every((h) => h.trim() === sessionTitle) : headlines.includes(nameA),
    EXPECT_BUG
      ? 'before the fix, every row is headlined with the SESSION, so the one you just filed reads as "the session you are in"'
      : 'rows are headlined with the person, so none of them reads as "the session you are in"',
    `headlines: ${headlines.map((h) => h.trim()).join(' / ')}`,
  )

  // The submitted capture's OWN row, not the first row: after the next-person
  // click above there is a newer empty draft sitting on top of it, which is
  // correct and is what the whole fix is for.
  const rowA = page.locator('.activity-item', { hasText: nameA }).first()
  if (!EXPECT_BUG) {
    const pills = (await rowA.locator('.pill').allInnerTexts()).map((p) => p.trim())
    check(
      pills.includes('submitted'),
      'and the submitted one says so, separately from its sync state',
      pills.join(' | '),
    )
    const draftPills = await page
      .locator('.activity-item', { hasText: 'No one tagged' })
      .first()
      .locator('.pill')
      .allInnerTexts()
    check(
      draftPills.map((p) => p.trim()).includes('not submitted'),
      'and the empty draft it started says it is not submitted',
      draftPills.join(' | '),
    )
  }

  // ---- reopening a submitted capture, and correcting it on purpose ----
  await (EXPECT_BUG ? page.locator('.activity-item').first() : rowA).click()
  await page.waitForURL(/\/capture\//)
  await page.waitForSelector('textarea', { timeout: 15000 })
  await page.waitForTimeout(600)

  if (EXPECT_BUG) {
    // The defect, performed. Reopen the submitted capture and tap the next
    // person: on main the text stays and the record changes hands silently.
    const carried = await page.locator('textarea').first().inputValue()
    await page.locator('.participant-btn').nth(1).click()
    await page.waitForTimeout(400)
    const after = await page.locator('textarea').first().inputValue()
    check(
      carried === A_TEXT && after === A_TEXT,
      `THE BUG: ${nameA}'s text is still in the boxes after tapping ${nameB}, with nothing asked`,
      `text: ${after.slice(0, 60)}`,
    )
  } else {
    const locked = (await page.locator('textarea').first().getAttribute('readonly')) !== null
    check(locked, 'a submitted capture reopened from the list is read-only')

    await page.locator('button', { hasText: 'Correct this evaluation' }).click()
    await page.waitForTimeout(300)
    const nowEditable = (await page.locator('textarea').first().getAttribute('readonly')) === null
    check(nowEditable, 'correcting it is one deliberate tap')
    const attestCleared = !(await page.locator('input[type=checkbox]').first().isChecked())
    check(attestCleared, 'and the attestation is unticked, so corrected text is re-attested')

    // Re-pointing: allowed, but it has to say what it would do, by name.
    await page.locator('.participant-btn').nth(1).click()
    await page.waitForTimeout(300)
    const warn = page.locator('.banner.warn')
    const said = (await warn.count()) > 0 ? await warn.first().innerText() : ''
    check(
      said.includes(nameA) && said.includes(nameB),
      're-pointing a submitted evaluation names both people first',
      said.replace(/\s+/g, ' ').slice(0, 160),
    )
    check(
      !/\{\w+\}/.test(said) && !said.includes('capture.repoint'),
      'and the sentence is words, not a token or a copy id',
    )

    await page.locator('button', { hasText: 'Leave it as it is' }).click()
    await page.waitForTimeout(400)
    const stillA = await page.locator('.participant-btn.primary').first().innerText()
    check(stillA.trim().startsWith(nameA), 'cancelling changes nothing', stillA.trim())

    // ---- and when it IS confirmed, the coverage tick has to move with it ----
    // saveAnswers never touched coverage, so before repointEvaluation a re-point
    // left a green tick against somebody no submitted evaluation mentioned. That
    // half was invisible from inside the app, which is why it is checked here.
    const covered = () =>
      page.locator('.participant-btn').evaluateAll((ns) =>
        ns
          .filter((n) => n.querySelector('.coverage-badge'))
          .map((n) => (n.textContent ?? '').trim().split('\n')[0]),
      )
    const before = await covered()
    check(
      before.some((n) => n.startsWith(nameA)) && !before.some((n) => n.startsWith(nameB)),
      'before re-pointing, the coverage tick is on the person the evaluation names',
      before.join(', '),
    )
    await page.locator('.participant-btn').nth(1).click()
    await page.locator('button', { hasText: 'Change who this is about' }).click()
    await page.waitForTimeout(1200)
    const after = await covered()
    check(
      after.some((n) => n.startsWith(nameB)) && !after.some((n) => n.startsWith(nameA)),
      'after re-pointing, the tick has moved, with no reload',
      after.join(', '),
    )
  }
} catch (err) {
  // Loudly, and as a failure. An earlier draft let the finally block below exit 0
  // on an exception thrown before the first check, which reported "0/0 passed" and
  // read as success. A harness that can pass without asserting anything is worse
  // than no harness.
  check(false, `the walkthrough did not finish: ${err.message?.split('\n')[0]}`)
  console.log(err.stack?.split('\n').slice(0, 4).join('\n') ?? '')
} finally {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  await browser.close()
  process.exit(failed.length === 0 && results.length > 0 ? 0 : 1)
}
