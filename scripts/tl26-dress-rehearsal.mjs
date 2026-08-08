/**
 * tl-26: the dress rehearsal, on the real course.
 *
 * Five captures dictated into the real capture screen against a real Crash Course
 * question about real Crash Course participants, routed by the real `claude` CLI on
 * this machine through tl-21's relay, verified through the real two-confirmation
 * gate by two real accounts, and read back out of a real report and two real day
 * emails. Nothing here is a fixture except the accounts, and the accounts are real
 * accounts provisioned through tl-11's real invite path.
 *
 * WHY THIS IS NOT LIKE THE OTHER HARNESSES IN THIS WAVE. Every earlier browser
 * harness runs against a LOCAL-ONLY build with both Supabase variables blank, which
 * is what makes them runnable with nobody's password. This one runs against the live
 * project, because the claim under test is about two real workshops on one real
 * device and there is no fixture version of that. tl-17's B11 proved the same
 * property on a fixture pair called Alpha and Beta; the Crash Course and Psalms are
 * the first real pair, and step 5 below is that fix's first honest regression test.
 *
 *   node scripts/apply-migration.mjs scripts/tl26-setup.sql
 *   HONEST_EVAL_RELAY_HOME=<tmp> HONEST_EVAL_RELAY_TOKEN=<token> \
 *     HONEST_EVAL_RELAY_PORT=8797 npm run relay          # in another shell
 *   npx vite --port 5201 --strictPort                    # in another shell
 *   node scripts/tl26-dress-rehearsal.mjs
 *   node scripts/apply-migration.mjs scripts/tl26-teardown.sql
 *
 * PORT 5201 and RELAY PORT 8797, both one clear of every other harness in this wave.
 * A harness pointed at another session's server is the worst possible green.
 *
 * Headless is legitimate here for the reason tl-21 measured: headless Chromium
 * refuses `127.0.0.1` from an https:// origin but reaches it with no permission at
 * all from a page served over http://localhost, which is what a dev server is.
 *
 * Playwright is deliberately not a dependency:
 *   npm i -D --no-save playwright && npx playwright install chromium
 */
import { chromium } from 'playwright'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const BASE = `http://localhost:${process.env.TL26_UI_PORT ?? 5201}/`
const RELAY_URL = `http://127.0.0.1:${process.env.TL26_RELAY_PORT ?? 8797}`
const RELAY_TOKEN = process.env.TL26_RELAY_TOKEN ?? 'tl26-rehearsal-token-cccccccccccccccc'
const PASSWORD = 'tl26-Throwaway-Password-1!'
const ADMIN = 'tl26-admin@example.org'
const EVALUATOR = 'tl26-evaluator@example.org'
const CC = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'
const PSALMS = '11111111-1111-1111-1111-111111111111'
const ACTIVITY = 'Exegete Passage 1'
const SHOTS = 'screenshots/tl26-dress-rehearsal'

const { captures } = JSON.parse(readFileSync(`${HERE}tl26-captures.json`, 'utf8'))

const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label.slice(0, 72).padEnd(72)} | ${String(detail).slice(0, 90)}`)
}
const note = (label, detail = '') => console.log(`   . | ${label.slice(0, 72).padEnd(72)} | ${String(detail).slice(0, 90)}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

rmSync(SHOTS, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })

const browser = await chromium.launch()

/** One signed-in device. Two of these exist, which is the whole point of the gate. */
async function device(email, label) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    // The signed-out landing page fires reads of `observation` and
    // `verification_verdict` that Postgres correctly refuses; that predates this
    // spec and is noise here rather than a finding.
    if (m.type() === 'error' && !/401|403|Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200))
  })
  await page.goto(BASE + 'signin', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#email', { timeout: 20000 })
  await page.fill('#email', email)
  await page.fill('#password', PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForTimeout(7000)
  const body = await page.evaluate(() => document.body.innerText)
  check(!body.includes('Database error') && !body.includes('Invalid login'), `${label} signs in`, page.url())
  return { ctx, page, errors, label }
}

const bodyOf = (page) => page.evaluate(() => document.body.innerText)

/** Dexie from inside the page: the only way to see what the device actually holds. */
const idb = (page, fn, arg) =>
  page.evaluate(
    ([body, argument]) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('cairn')
        req.onsuccess = () => {
          const db = req.result
          const run = new Function('db', 'arg', 'resolve', 'reject', body)
          try {
            run(db, argument, resolve, reject)
          } catch (err) {
            reject(String(err))
          }
        }
        req.onerror = () => reject(String(req.error))
      }),
    [fn, arg ?? null],
  )

const rowsIn = (page, store) =>
  idb(page, `const t=db.transaction(arg,'readonly');const r=t.objectStore(arg).getAll();r.onsuccess=()=>resolve(r.result);t.onerror=()=>reject(String(t.error))`, store)

async function setActiveWorkshop(page, id) {
  await page.evaluate((ws) => localStorage.setItem('cairn.active_workshop_id', ws), id)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)
}

const out = { tokens: null, observations: [], dayEmails: {}, report: null }

try {
  // =========================================================================
  // 0. The device, and the fact that makes step 5 testable at all.
  // =========================================================================
  const admin = await device(ADMIN, 'admin')
  await sleep(3000)

  {
    const workshops = await rowsIn(admin.page, 'workshops')
    const participants = await rowsIn(admin.page, 'participants')
    check(workshops.length === 2, '0. the device holds BOTH workshops', workshops.map((w) => w.name.slice(0, 28)).join(' | '))
    check(
      participants.filter((p) => p.workshop_id === CC).length === 4 &&
        participants.filter((p) => p.workshop_id === PSALMS).length === 22,
      '0. and both rosters, 4 and 22',
      `${participants.length} participants cached in total`,
    )
    // The ordering that decides what an unscoped read returns. Dexie hands back
    // primary-key order, and '1111…' sorts before '74d1…', so ANY page that takes
    // the first workshop gets Psalms no matter which workshop is active.
    note('0. Dexie\'s first workshop by key order', workshops[0]?.name)
    await setActiveWorkshop(admin.page, CC)
    check(
      (await bodyOf(admin.page)).includes('OBT Crash Course'),
      '0. the active workshop is the Crash Course',
    )
  }

  // =========================================================================
  // 1-2. Five captures, through the screen a facilitator actually uses.
  // =========================================================================
  for (const [i, cap] of captures.entries()) {
    await admin.page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await admin.page.waitForTimeout(1500)
    await admin.page.locator('button, a', { hasText: ACTIVITY }).first().click()
    await admin.page.waitForURL(/\/capture\//, { timeout: 15000 })
    await admin.page.waitForTimeout(1200)

    // The participant this capture is about. `about` may carry a parenthetical.
    const who = cap.about.replace(/\s*\(.*\)$/, '')
    await admin.page.locator('button.participant-btn', { hasText: who }).first().click()
    await admin.page.waitForTimeout(300)

    const textareas = admin.page.locator('textarea')
    const n = await textareas.count()
    await textareas.first().fill(cap.text)
    await admin.page.locator('input[type=checkbox]').first().check()
    await admin.page.waitForTimeout(200)
    await admin.page.locator('button.primary', { hasText: /Submit|Save changes/ }).first().click()
    await admin.page.waitForTimeout(2500)

    if (i === 0) {
      await admin.page.screenshot({ path: `${SHOTS}/01-capture.png`, fullPage: true })
      check(n === 1, '1. the activity offers exactly the one question wired to it (CC-EX1)', `${n} textarea(s)`)
    }
  }

  {
    const evals = await rowsIn(admin.page, 'evaluations')
    const mine = evals.filter((e) => e.evaluator_email === ADMIN)
    check(mine.length === captures.length, `2. ${captures.length} captures recorded through the capture screen`, `${mine.length} on device`)
    check(
      mine.every((e) => e.workshop_id === CC),
      '2. every one of them is scoped to the Crash Course',
    )
    check(
      mine.every((e) => (e.source_text ?? '').length > 200),
      '2. each carries real dictated-length prose, not a test string',
      `shortest ${Math.min(...mine.map((e) => (e.source_text ?? '').length))} chars`,
    )
  }

  // Let the outbox push them, since the router reads what the backend holds.
  await sleep(6000)

  // =========================================================================
  // 3. Route them, on this machine's own Claude subscription.
  // =========================================================================
  await admin.page.evaluate(
    ([url, token]) => {
      localStorage.setItem('cairn.relay.url', url)
      localStorage.setItem('cairn.relay.token', token)
    },
    [RELAY_URL, RELAY_TOKEN],
  )
  await admin.page.goto(BASE + 'admin/setup/ai', { waitUntil: 'domcontentloaded' })
  await admin.page.waitForTimeout(2500)

  {
    // Selecting the mode through the Setup UI rather than writing the row: tl-24
    // could not exercise tl-07's change-impact dialog at all (its method was one
    // SQL script) and left it to this spec to pick up.
    const card = admin.page.locator('.banner', { hasText: 'A machine at the workshop runs it' }).first()
    await card.locator('button', { hasText: 'Use this' }).first().click()
    await admin.page.waitForTimeout(800)
    const confirm = admin.page
      .locator('dialog button, .modal button, [role=dialog] button')
      .filter({ hasText: /^(Save|Apply|Confirm|Save anyway|Yes)/i })
    const dialogued = (await confirm.count()) > 0
    if (dialogued) await confirm.first().click()
    await admin.page.waitForTimeout(1500)
    check(dialogued, '3. selecting the routing mode goes through tl-07\'s change-impact dialog')
    await admin.page.screenshot({ path: `${SHOTS}/02-ai-mode.png`, fullPage: true })
  }

  {
    await admin.page.locator('button', { hasText: 'Test the connection' }).first().click()
    await admin.page.waitForTimeout(4000)
    const body = await bodyOf(admin.page)
    check(body.includes('ready'), '3. the relay reports ready with a signed-in runner')
  }

  await admin.page.goto(BASE + 'admin/routing', { waitUntil: 'domcontentloaded' })
  await admin.page.waitForTimeout(2500)
  await admin.page.screenshot({ path: `${SHOTS}/03-routing-before.png`, fullPage: true })

  {
    await admin.page.locator('button', { hasText: 'Route now' }).first().click()
    // A real model call per capture. tl-21 measured 3.5s each; five plus the
    // queue's own polling wants room, and a short wait here reads as a routing
    // failure rather than as impatience.
    for (let i = 0; i < 60; i++) {
      await sleep(5000)
      const obs = await rowsIn(admin.page, 'observations')
      if (obs.length > 0 && !(await bodyOf(admin.page)).includes('The machine is routing them')) break
    }
    await admin.page.waitForTimeout(2000)
    const body = await bodyOf(admin.page)
    await admin.page.screenshot({ path: `${SHOTS}/04-routing-after.png`, fullPage: true })
    const m = body.match(/Routed (\d+) capture\(s\) into (\d+) observation\(s\), (\d+) rejected — (\d+) tokens in, (\d+) out/)
    if (m) {
      out.tokens = { captures: +m[1], stored: +m[2], rejected: +m[3], in: +m[4], out: +m[5] }
      check(true, '3. the run reports its own token counts', JSON.stringify(out.tokens))
    } else {
      check(false, '3. the run reports its own token counts', body.slice(0, 300).replace(/\n/g, ' '))
    }
  }

  {
    const obs = await rowsIn(admin.page, 'observations')
    const parts = await rowsIn(admin.page, 'participants')
    const ccIds = new Set(parts.filter((p) => p.workshop_id === CC).map((p) => p.id))
    const evals = (await rowsIn(admin.page, 'evaluations')).filter((e) => e.evaluator_email === ADMIN)
    const textByCapture = new Map(evals.map((e) => [e.client_id, e.source_text ?? '']))
    out.observations = obs.map((o) => ({
      participant: o.participant_name,
      ksa: o.ksa_code,
      level: o.evidence_designation,
      excerpt: o.source_excerpt,
      text: o.text,
      confidence: o.confidence,
      grounded: (textByCapture.get(o.capture_client_id) ?? '').includes(o.source_excerpt ?? ' '),
    }))
    check(obs.length > 0, '3. observations came back', `${obs.length} stored`)
    check(obs.every((o) => o.workshop_id === CC), '3. every observation is scoped to the Crash Course')
    check(obs.every((o) => o.ksa_code === 'CC-EX1'), '3. every observation answers the wired question', [...new Set(obs.map((o) => o.ksa_code))].join(','))
    check(obs.every((o) => ccIds.has(o.participant_id)), '3. every observation names a Crash Course participant')
    check(
      out.observations.every((o) => o.grounded),
      '3. every source_excerpt is genuinely in its own capture (tl-15\'s rule, on content nobody wrote to pass it)',
      `${out.observations.filter((o) => o.grounded).length}/${out.observations.length} grounded`,
    )
    console.log('\n--- what the router said ---')
    for (const o of out.observations) console.log(`  ${o.participant} → ${o.level} (${o.confidence}) :: ${String(o.text).slice(0, 120)}`)
    console.log('---\n')
  }

  await sleep(6000)   // let the observations reach the backend for the other device

  // =========================================================================
  // 4. Verify through the real gate: two accounts, two confirmations.
  // =========================================================================
  await admin.page.goto(BASE + 'observations', { waitUntil: 'domcontentloaded' })
  await admin.page.waitForTimeout(3000)
  {
    const buttons = admin.page.locator('button', { hasText: /^Confirm/ })
    const n = await buttons.count()
    for (let i = 0; i < n; i++) {
      await buttons.nth(i).click()
      await admin.page.waitForTimeout(400)
    }
    check(n > 0, '4. the admin records the first confirmation on each observation', `${n} control(s)`)
    await admin.page.waitForTimeout(4000)
    await admin.page.screenshot({ path: `${SHOTS}/05-verify-admin.png`, fullPage: true })
  }

  const evaluator = await device(EVALUATOR, 'evaluator')
  await sleep(4000)
  {
    const workshops = await rowsIn(evaluator.page, 'workshops')
    check(workshops.length === 1 && workshops[0].id === CC, '4. the evaluator sees one workshop and it is the Crash Course', workshops.map((w) => w.name.slice(0, 30)).join('|'))
    await evaluator.page.goto(BASE + 'observations', { waitUntil: 'domcontentloaded' })
    await evaluator.page.waitForTimeout(4000)
    const buttons = evaluator.page.locator('button', { hasText: /^Confirm/ })
    const n = await buttons.count()
    for (let i = 0; i < n; i++) {
      await buttons.nth(i).click()
      await evaluator.page.waitForTimeout(400)
    }
    check(n > 0, '4. a second real account records the second confirmation', `${n} control(s)`)
    await evaluator.page.waitForTimeout(4000)
    const body = await bodyOf(evaluator.page)
    check(/verified/i.test(body), '4. the gate closes at two confirmations, without the threshold being touched')
    await evaluator.page.screenshot({ path: `${SHOTS}/06-verify-evaluator.png`, fullPage: true })
  }

  await sleep(5000)
  await admin.page.reload({ waitUntil: 'domcontentloaded' })
  await admin.page.waitForTimeout(5000)

  // =========================================================================
  // 5. The report, and THE ACCEPTANCE: two day emails, one device.
  // =========================================================================
  {
    const parts = (await rowsIn(admin.page, 'participants')).filter((p) => p.workshop_id === CC)
    const subject = out.observations[0]?.participant
    const target = parts.find((p) => p.name === subject) ?? parts[0]
    await admin.page.goto(BASE + `reports/${target.id}`, { waitUntil: 'domcontentloaded' })
    await admin.page.waitForTimeout(4000)
    const body = await bodyOf(admin.page)
    out.report = body
    await admin.page.screenshot({ path: `${SHOTS}/07-report.png`, fullPage: true })
    check(body.includes(target.name), '5. the participant report names the participant', target.name)
    check(body.includes('Exegesis notes') || body.includes('CC-EX1'), '5. and carries the question tl-24 authored')
    const labels = ['Not yet', 'Emerging', 'Competent', 'Strong']
    const shown = labels.filter((l) => body.includes(l))
    check(shown.length > 0, '5. the scale point renders with tl-24\'s own label, not a bare number', shown.join(', '))
  }

  const dayEmail = async (page) => {
    await page.goto(BASE + 'day-email', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(4000)
    const md = await page.locator('textarea.mono').first().inputValue()
    return md
  }

  {
    await setActiveWorkshop(admin.page, CC)
    const md = await dayEmail(admin.page)
    out.dayEmails.crashCourse = md
    await admin.page.screenshot({ path: `${SHOTS}/08-day-email-crash-course.png`, fullPage: true })

    const parts = await rowsIn(admin.page, 'participants')
    const ccNames = parts.filter((p) => p.workshop_id === CC).map((p) => p.name)
    const psNames = parts.filter((p) => p.workshop_id === PSALMS).map((p) => p.name)
    const leaked = psNames.filter((n) => md.includes(n))

    check(md.includes('OBT Crash Course'), '5. THE ACCEPTANCE: the Crash Course day email carries the Crash Course\'s name', md.split('\n')[0]?.slice(0, 90))
    check(leaked.length === 0, '5. THE ACCEPTANCE: and only its own four people', leaked.length ? `LEAKED ${leaked.length}: ${leaked.slice(0, 4).join(', ')}` : 'no Psalms name present')
    note('5. Crash Course names present', ccNames.filter((n) => md.includes(n)).join(', ') || 'none')
  }

  {
    await setActiveWorkshop(admin.page, PSALMS)
    const md = await dayEmail(admin.page)
    out.dayEmails.psalms = md
    await admin.page.screenshot({ path: `${SHOTS}/09-day-email-psalms.png`, fullPage: true })
    const parts = await rowsIn(admin.page, 'participants')
    const ccNames = parts.filter((p) => p.workshop_id === CC).map((p) => p.name)
    const psCount = parts.filter((p) => p.workshop_id === PSALMS).length
    const leaked = ccNames.filter((n) => md.includes(n))
    check(md.includes('Psalms Workshop'), '5. the Psalms day email carries Psalms\' name', md.split('\n')[0]?.slice(0, 90))
    check(leaked.length === 0, '5. and only its own 22', leaked.length ? `LEAKED ${leaked.length}: ${leaked.join(', ')}` : `${psCount} on file, none of the Crash Course's four present`)
  }

  // =========================================================================
  // 6. The one hardcoded /3 that is live on this workshop.
  // =========================================================================
  {
    const md = out.dayEmails.crashCourse ?? ''
    const slashes = [...md.matchAll(/(\d+)\s*\/\s*(\d+)/g)].map((m) => m[0])
    note('6. fractions printed in the day email', slashes.join(' ') || 'none')
    check(
      !slashes.some((s) => /\/\s*3$/.test(s) && Number(s.split('/')[0]) > 3),
      '6. no fraction prints a numerator above its own denominator on this 4-point scale',
      slashes.join(' ') || 'no fraction printed',
    )
  }

  writeFileSync(`${SHOTS}/rehearsal-output.json`, JSON.stringify(out, null, 2))
  writeFileSync(`${SHOTS}/day-email-crash-course.md`, out.dayEmails.crashCourse ?? '')
  writeFileSync(`${SHOTS}/day-email-psalms.md`, out.dayEmails.psalms ?? '')

  const pageErrors = [...admin.errors, ...evaluator.errors]
  check(pageErrors.length === 0, '7. no uncaught page error on any screen walked', pageErrors.slice(0, 2).join(' | '))
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
for (const f of failed) console.log(`  FAILED: ${f.label}`)
process.exit(failed.length ? 1 : 0)
