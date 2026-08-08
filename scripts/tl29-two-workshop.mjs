/**
 * tl-29's acceptance, which no unit test can reach: the same device, two real
 * workshops, and four properties of a generated document that all have to change when
 * you switch between them.
 *
 * tl-26 ran the rehearsal that produced this spec and its finding was that the day
 * email generated with the Crash Course active came out headed "Psalms Workshop", over
 * the Crash Course's people, with designations labelled by Psalms' scale. That is a
 * defect of the render path, so it is provable only by rendering. `test/scope.test.ts`
 * pins the rules and `test/workshopScoping.test.ts` stops a new file from bypassing
 * them; this proves the pages are actually wired to them.
 *
 * The fixture pair is deliberately different in ALL FOUR respects at once, because
 * tl-26's own lesson was that Alpha and Beta could never have shown the bug: workshop B
 * has its own name, its own two participants, its own two question codes, and a
 * FIVE-point scale with its own wording. A pair differing in one respect proves one of
 * the four fixes.
 *
 * What is under test, in order:
 *   1. Two workshops on one device, both in the switcher, one selected.
 *   2. The day email under A: A's name in the heading, A's person in the body, no B
 *      person anywhere, and scores out of A's top point.
 *   3. The day email under B: every one of those four flips.
 *   4. The participant report under B lists only B's question codes as unevidenced,
 *      which is tl-26's D-d in the surface it was found in.
 *   5. The CBC export under B names B and carries only B's participant, because that
 *      file is the one artefact that leaves the app for another platform.
 *   6. The verification queue under B shows only B's observation.
 *   7. No page error anywhere, and both viewports free of body overflow on the two
 *      document pages (tl-20's rule, cheap to keep).
 *
 *   VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npx vite preview --port 5199 --strictPort
 *   node scripts/tl29-two-workshop.mjs
 *
 * Local-only mode (both Supabase vars blank), which is what makes it runnable with
 * nobody's password: sign-in synthesizes a membership over every workshop in Dexie, so
 * seeding B BEFORE signing in is what makes the switcher offer two. Nothing here proves
 * anything about authorization; RLS is the session harnesses' job.
 *
 * Port 5199, not the dev default and not any other harness's. A harness pointed at
 * another worktree's server is the worst possible green.
 *
 * Playwright is deliberately not a dependency:
 *   npm i -D --no-save playwright && npx playwright install chromium
 */
import { chromium } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'

const BASE = `http://localhost:${process.env.TL29_PORT ?? 5199}/`
const SHOTS = 'screenshots/tl29-two-workshop'

const A_NAME = 'Psalms Workshop — OBT CDT Workshop 3 (Bali 2026)'
const A_ID = '11111111-1111-1111-1111-111111111111'
const B_ID = 'tl29bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const B_NAME = 'tl29 Crash Course stand-in'
const B_PERSON = 'Tl29 Beta Participant'
const B_CODES = ['ZZ-BETA1', 'ZZ-BETA2']
const A_PERSON = 'Keem Leong'
const A_CODE = 'EXEG'

const results = []
const check = (ok, label, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label.slice(0, 70).padEnd(70)} | ${String(detail).slice(0, 70)}`)
}

rmSync(SHOTS, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})

/** One idb transaction, so the seed either lands or does not. */
async function seedWorkshopB() {
  return await page.evaluate(
    async ({ B_ID, B_NAME, B_PERSON, B_CODES, A_ID }) => {
      const put = (store, rows) => rows.forEach((r) => store.put(r))
      return await new Promise((resolve, reject) => {
        const req = indexedDB.open('cairn')
        req.onsuccess = () => {
          const db = req.result
          const names = [
            'workshops',
            'teams',
            'participants',
            'goals',
            'ksas',
            'activities',
            'scalePoints',
            'observations',
            'evaluations',
          ]
          const tx = db.transaction(names, 'readwrite')
          const now = new Date().toISOString()
          const day = now.slice(0, 10)

          put(tx.objectStore('workshops'), [
            {
              id: B_ID,
              name: B_NAME,
              start_date: day,
              end_date: day,
              location: 'Jimbaran',
              languages: ['English'],
            },
          ])
          put(tx.objectStore('teams'), [
            { id: 'tl29-team-b', workshop_id: B_ID, name: 'Beta Team' },
          ])
          put(tx.objectStore('participants'), [
            {
              id: 'tl29-p-b',
              workshop_id: B_ID,
              name: B_PERSON,
              registered_email: 'tl29-beta@example.org',
              team_id: 'tl29-team-b',
              preferred_language: null,
            },
          ])
          put(tx.objectStore('goals'), [
            {
              id: 'tl29-goal-b',
              workshop_id: B_ID,
              code: 'ZZG',
              title: 'Beta goal',
              description: null,
              sort_order: 0,
            },
          ])
          put(
            tx.objectStore('ksas'),
            B_CODES.map((code, i) => ({
              id: `tl29-ksa-${code}`,
              workshop_id: B_ID,
              goal_id: 'tl29-goal-b',
              code,
              short_label: `Beta question ${i + 1}`,
              evaluator_facing_prompt: `Beta prompt ${i + 1}`,
              guiding_questions: [],
              evidence_levels: {},
              // Required on Ksa, and omitting it crashed the day email into the
              // ErrorBoundary rather than rendering wrong, which is worth knowing: a
              // fixture missing a required array is indistinguishable on screen from a
              // page that cannot render at all.
              cbc_subpoint_refs: [],
              sort_order: i,
              area: null,
            })),
          )
          put(tx.objectStore('activities'), [
            {
              id: 'tl29-act-b',
              workshop_id: B_ID,
              name: 'Beta session',
              day,
              start_time: null,
              end_time: null,
              sort_order: 0,
              kind: 'session',
            },
          ])
          // FIVE points, and its own wording, so a score printed against the other
          // workshop's scale is visible rather than merely wrong.
          put(
            tx.objectStore('scalePoints'),
            ['beta-notyet', 'beta-starting', 'beta-fine', 'beta-strong', 'beta-best'].map(
              (label, value) => ({
                pk: `${B_ID}::${value}`,
                workshop_id: B_ID,
                value,
                label,
                description: null,
                is_low_trigger: value <= 1,
                sort_order: value,
              }),
            ),
          )
          put(tx.objectStore('evaluations'), [
            {
              client_id: 'tl29-cap-b',
              workshop_id: B_ID,
              activity_id: 'tl29-act-b',
              evaluator_email: 'tl29-auditor@example.org',
              source_language: 'en',
              answers: { k: 'beta evidence' },
              quick_ratings: {},
              participant_scope: ['tl29-p-b'],
              focus_participant_id: 'tl29-p-b',
              source_text: 'beta evidence sentence',
              attestation: true,
              ruleset_version: 'v1',
              edit_history: [],
              sync_status: 'local',
              created_at: now,
              updated_at: now,
            },
            {
              client_id: 'tl29-cap-a',
              workshop_id: A_ID,
              activity_id: null,
              evaluator_email: 'tl29-auditor@example.org',
              source_language: 'en',
              answers: { k: 'alpha evidence' },
              quick_ratings: {},
              participant_scope: ['33333333-0000-0000-0000-000000000001'],
              focus_participant_id: '33333333-0000-0000-0000-000000000001',
              source_text: 'alpha evidence sentence',
              attestation: true,
              ruleset_version: 'v1',
              edit_history: [],
              sync_status: 'local',
              created_at: now,
              updated_at: now,
            },
          ])
          // One observation per workshop, each at designation 2, so the printed
          // denominator and label are the only difference between them.
          put(tx.objectStore('observations'), [
            {
              id: 'tl29-obs-b',
              capture_client_id: 'tl29-cap-b',
              workshop_id: B_ID,
              participant_id: 'tl29-p-b',
              participant_name: B_PERSON,
              ksa_code: B_CODES[0],
              text: 'beta observation text',
              source_excerpt: 'beta evidence sentence',
              evidence_designation: 2,
              remapped_from: null,
              sentiment_flag: 'neutral',
              origin: 'individual',
              needs_review: false,
              evaluator_email: 'tl29-auditor@example.org',
              imported_at: now,
              sync_status: 'local',
            },
            {
              id: 'tl29-obs-a',
              capture_client_id: 'tl29-cap-a',
              workshop_id: A_ID,
              participant_id: '33333333-0000-0000-0000-000000000001',
              participant_name: 'Keem Leong',
              ksa_code: 'EXEG',
              text: 'alpha observation text',
              source_excerpt: 'alpha evidence sentence',
              evidence_designation: 2,
              remapped_from: null,
              sentiment_flag: 'neutral',
              origin: 'individual',
              needs_review: false,
              evaluator_email: 'tl29-auditor@example.org',
              imported_at: now,
              sync_status: 'local',
            },
          ])

          tx.oncomplete = () => {
            db.close()
            resolve('seeded')
          }
          tx.onerror = () => reject(tx.error)
        }
        req.onerror = () => reject(req.error)
      })
    },
    { B_ID, B_NAME, B_PERSON, B_CODES, A_ID },
  )
}

async function signIn() {
  await page.goto(BASE + 'signin', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#name', { timeout: 20000 })
  await page.fill('#name', 'tl29 Auditor')
  await page.fill('#email', 'tl29-auditor@example.org')
  await page.click('button[type=submit]')
  await page.waitForTimeout(1500)
}

/** Promote the synthesized memberships so /reports, /export and /day-email render. */
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

async function switchTo(id) {
  await page.evaluate((wid) => localStorage.setItem('cairn.active_workshop_id', wid), id)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
}

async function dayEmailText(label) {
  await page.goto(BASE + 'day-email', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const has = await page.locator('textarea').count()
  if (has === 0) {
    // A missing textarea means the route did not render, which is a finding rather
    // than a crash: print where we landed instead of timing out on a locator.
    await page.screenshot({ path: `${SHOTS}/day-email-${label}-MISSING.png`, fullPage: true })
    check(false, `the day email renders under ${label}`, `${page.url()} :: ${(await page.locator('body').innerText()).slice(0, 120).replace(/\n/g, ' ')}`)
    return ''
  }
  return await page.locator('textarea').first().inputValue()
}

async function bodyOverflow() {
  return await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )
}

try {
  // 1. Boot once so the app writes its seed, then add workshop B and sign in, so the
  //    synthesized memberships cover both.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  const seeded = await seedWorkshopB()
  check(seeded === 'seeded', 'workshop B seeded into Dexie beside the shipped seed', seeded)

  await signIn()
  await elevate()

  const options = await page.evaluate(() =>
    [...document.querySelectorAll('select.switcher option')].map((o) => o.textContent?.trim()),
  )
  check(
    options.length >= 2 && options.some((o) => o?.includes('tl29')),
    'the switcher offers both workshops, which is what makes the rest meaningful',
    `${options.length} options`,
  )

  // 2. Workshop A.
  await switchTo(A_ID)
  const aEmail = await dayEmailText('A')
  await page.screenshot({ path: `${SHOTS}/day-email-A.png`, fullPage: true })
  check(aEmail.includes(A_NAME), "A's day email is headed with A's name", aEmail.slice(0, 60))
  check(aEmail.includes(A_PERSON), "A's day email carries A's participant", A_PERSON)
  check(!aEmail.includes(B_PERSON), "A's day email carries NO participant of B", B_PERSON)
  check(!aEmail.includes(B_CODES[0]), "A's day email names none of B's questions", B_CODES[0])
  check(aEmail.includes('2/3'), "A's scores print out of A's top point (4-point scale)", '2/3')
  check(!aEmail.includes('2/4'), "A's scores do not print out of B's top point", '2/4')
  check(!/beta-/.test(aEmail), "A's designations carry none of B's scale wording")
  check(!(await bodyOverflow()), 'no horizontal body overflow on the day email at 1400px')

  // 3. Workshop B: all four properties flip.
  await switchTo(B_ID)
  const bEmail = await dayEmailText('B')
  await page.screenshot({ path: `${SHOTS}/day-email-B.png`, fullPage: true })
  // An empty document passes every "does not contain" check for the wrong reason. This
  // is the harness equivalent of the rule tl-24 earned: an unparsed answer is not a
  // wrong answer, and an absent document is not a correctly scoped one.
  check(bEmail.length > 200, "B's day email is a real document before anything is asserted about it", `${bEmail.length} chars`)
  check(bEmail.includes(B_NAME), "B's day email is headed with B's name, not Dexie's first", B_NAME)
  check(!bEmail.includes(A_NAME), "B's day email is NOT headed with A's name (tl-26's finding)", A_NAME)
  check(bEmail.includes(B_PERSON), "B's day email carries B's participant", B_PERSON)
  check(!bEmail.includes(A_PERSON), "B's day email carries NO participant of A", A_PERSON)
  check(bEmail.includes('2/4'), "B's scores print out of B's top point (5-point scale)", '2/4')
  check(!bEmail.includes('2/3'), "the same designation is not printed against A's scale", '2/3')
  check(/beta-/.test(bEmail), "B's designations carry B's own scale wording", 'beta-')
  check(!bEmail.includes(A_CODE), "B's day email names none of A's questions", A_CODE)

  // 4. The participant report, which is where tl-26 found the questions defect.
  await page.goto(BASE + 'reports', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${SHOTS}/reports-B.png`, fullPage: true })
  const reportText = await page.locator('body').innerText()
  check(reportText.includes(B_PERSON), "B's report list shows B's participant", B_PERSON)
  check(!reportText.includes(A_PERSON), "B's report list shows no participant of A", A_PERSON)
  check(
    reportText.includes(B_CODES[1]) && !reportText.includes(A_CODE),
    "the unevidenced list names only B's question codes",
    `${B_CODES[1]} present, ${A_CODE} absent`,
  )
  check(
    /1\/2 areas/.test(reportText),
    "the areas total counts B's two questions, not the deployment's nine",
    (reportText.match(/\d+\/\d+ areas/) ?? ['none'])[0],
  )
  check(!(await bodyOverflow()), 'no horizontal body overflow on reports at 1400px')

  // 5. The export, which leaves the app.
  //
  // Read from the COPIED JSON rather than from the page text, and only after the
  // export is non-empty. The first version of this block asserted on `body.innerText`,
  // where the active workshop's name is in the page chrome on every route and the
  // export block was empty (B's one observation is unverified and "only finalized" is
  // on by default). Both assertions passed against nothing at all — exactly the failure
  // the day-email guard above exists to prevent, one section further down.
  await page.goto(BASE + 'export', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('checkbox').first().setChecked(false)
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${SHOTS}/export-B.png`, fullPage: true })
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.getByRole('button', { name: 'Copy JSON' }).click()
  const exportJson = await page.evaluate(() => navigator.clipboard.readText())
  check(exportJson.length > 200, 'the CBC export is a real payload before anything is asserted about it', `${exportJson.length} chars`)
  const parsed = (() => {
    try {
      return JSON.parse(exportJson)
    } catch {
      return null
    }
  })()
  check(parsed?.workshop?.name === B_NAME, 'the CBC export payload names B', parsed?.workshop?.name)
  const exportNames = (parsed?.participants ?? []).map((p) => p.participant_name)
  check(
    exportNames.length === 1 && exportNames[0] === B_PERSON,
    "the CBC export payload carries only B's participant",
    exportNames.join(', ') || 'none',
  )
  const exportTops = JSON.stringify(parsed?.participants ?? [])
  check(
    !exportTops.includes(A_CODE),
    "the CBC export payload names none of A's questions",
    A_CODE,
  )

  // 6. The verification queue.
  await page.goto(BASE + 'observations', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${SHOTS}/observations-B.png`, fullPage: true })
  const obsText = await page.locator('body').innerText()
  check(obsText.includes(B_PERSON), "the verification queue shows B's observation", B_PERSON)
  check(!obsText.includes(A_PERSON), "the verification queue hides A's observation", A_PERSON)

  // 7. Phone width, on the page whose output four people receive.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(BASE + 'day-email', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${SHOTS}/day-email-B-390.png`, fullPage: true })
  check(!(await bodyOverflow()), 'no horizontal body overflow on the day email at 390px')

  check(errors.length === 0, 'no page error on any route walked', errors.slice(0, 2).join(' | '))
} finally {
  await browser.close()
}

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} checks passed. Screenshots in ${SHOTS}/`)
process.exit(passed === results.length ? 0 : 1)
