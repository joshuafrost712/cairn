/**
 * tl-13's client half, in a browser, because none of it can be proved from a module.
 *
 * The server half is `scripts/tl13-function-tests.mjs` (real JWTs, the deployed
 * function, refusals read off the wire). The unit tests cover the guard, the resolver
 * and the prompt. What is left is the part every spec in this wave found a bug in:
 * what a real administrator SEES, and whether the switch they flick actually reaches
 * a store and comes back.
 *
 * What is under test, in order:
 *   1. The AI section renders all three modes, each with its own limitation stated.
 *   2. hosted-api is offered as unselectable WITH the reason, not hidden — in
 *      local-only mode the reason is the missing backend.
 *   3. All five functions are listed; the three unbuilt ones carry no switch, because
 *      a toggle that governs nothing reports a state the app cannot honour.
 *   4. Turning a function off goes through the change dialog and then persists across
 *      a reload — which is the whole difference between a toggle and a checkbox.
 *   5. Turning observation routing off produces the loud consequence with a real
 *      capture count in it, not a generic caution.
 *   6. The draft panel, with draft-fill off, says so and points at the manual route
 *      instead of offering a button that will be refused.
 *   7. With it on, the button hands over a prompt carrying the workshop's OWN scale
 *      points (D2, at the surface an administrator actually touches).
 *   8. The trace card records that hand-off, including its operator-action outcome.
 *   9. The Routing page reports the workshop's mode and links to where it is chosen,
 *      rather than keeping a second answer of its own (tl-03's provisional key).
 *
 *   VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npx vite --port 5197 --strictPort
 *   node scripts/tl13-ai-setup.mjs
 *
 * Local-only mode (both Supabase vars blank), which is what makes it runnable with
 * nobody's password: sign-in synthesizes a membership in Dexie and `elevate()`
 * promotes it. Nothing here proves anything about authorization — that is the
 * function harness's job, and the two must not be confused.
 *
 * Port 5197, not the dev default: a harness pointed at another worktree's server is
 * the worst possible green. If you move the server, move this constant.
 *
 * Playwright is deliberately not a dependency:
 *   npm i -D --no-save playwright && npx playwright install chromium
 */
import { chromium } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'

const BASE = `http://localhost:${process.env.TL13_PORT ?? 5197}/`
const SHOTS = 'screenshots/tl13-ai'

const results = []
const check = (ok, label, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label.slice(0, 66).padEnd(66)} | ${String(detail).slice(0, 80)}`)
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
  await page.fill('#name', 'tl13 Auditor')
  await page.fill('#email', 'tl13-auditor@example.org')
  await page.click('button[type=submit]')
  await page.waitForTimeout(1500)
}

/** Promote the synthesized membership so the admin routes render rather than bounce. */
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

/** Seed one submitted capture, so the routing-off consequence has a real number. */
async function seedCapture() {
  const workshopId = await page.evaluate(async () => {
    return await new Promise((resolve, reject) => {
      const req = indexedDB.open('cairn')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['workshops', 'evaluations'], 'readwrite')
        const workshops = tx.objectStore('workshops').getAll()
        workshops.onsuccess = () => {
          const ws = workshops.result[0]
          tx.objectStore('evaluations').put({
            client_id: 'tl13-cap-1',
            workshop_id: ws.id,
            activity_id: 'tl13-act',
            evaluator_email: 'tl13-auditor@example.org',
            source_language: 'en',
            answers: { k: 'they facilitated the check well' },
            quick_ratings: {},
            participant_scope: [],
            focus_participant_id: null,
            source_text: 'they facilitated the check well',
            attestation: true,
            ruleset_version: 'v1',
            edit_history: [],
            sync_status: 'local',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          tx.oncomplete = () => {
            db.close()
            resolve(ws.id)
          }
        }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })
  })
  return workshopId
}

const text = () => page.evaluate(() => document.body.innerText)

/** Click the button whose visible text is exactly `label` inside a row naming `row`. */
async function clickInRow(rowText, buttonText) {
  const row = page.locator('tr', { hasText: rowText }).first()
  await row.locator('button', { hasText: buttonText }).first().click()
}

async function confirmDialog() {
  // The change dialog's commit button. tl-07 renders it once, from the provider.
  const confirm = page.locator('dialog button, .modal button, [role=dialog] button').filter({
    hasText: /^(Save|Apply|Confirm|Save anyway|Yes)/i,
  })
  if ((await confirm.count()) > 0) {
    await confirm.first().click()
    return true
  }
  return false
}

await signIn()
await elevate()
await seedCapture()
await page.goto(BASE + 'admin/setup/ai', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)

// ---------------------------------------------------------------------------
// 1-3. What the section says.
// ---------------------------------------------------------------------------
{
  const body = await text()
  check(
    body.includes('A person routes it') &&
      body.includes('You point your own AI') &&
      body.includes('This workshop pays a model per use'),
    'all three modes are offered, in their own words',
  )
  check(
    /Its limit:/.test(body) && (body.match(/Its limit:/g) ?? []).length === 3,
    'each mode states its own limitation',
    `${(body.match(/Its limit:/g) ?? []).length} limits`,
  )
  check(
    body.includes('not available here') && body.includes('Hosted AI needs the backend'),
    'hosted AI is unselectable WITH the reason, not hidden',
  )
  check(
    body.includes('Turning captures into observations') &&
      body.includes('Drafting a scenario from a document') &&
      body.includes('Writing report prose') &&
      body.includes('Drafting the outgoing emails') &&
      body.includes('Suggesting how to open a hard conversation'),
    'all five functions are declared, built or not',
  )
  check(
    (body.match(/not built yet/g) ?? []).length === 2,
    'the two functions with no call path are marked, not switched',
    `${(body.match(/not built yet/g) ?? []).length} marked`,
  )
  const switches = await page.locator('table.dt button', { hasText: /Turn o/ }).count()
  check(switches === 3, 'only the built functions carry a switch', `${switches} switches`)
  check(
    body.includes('Token and cost estimates per mode are a later spec'),
    'no cost figure is invented before tl-14 exists',
  )
  await page.screenshot({ path: `${SHOTS}/ai-section.png`, fullPage: true })
}

// ---------------------------------------------------------------------------
// 4-5. A toggle that actually reaches a store, and the loud one.
// ---------------------------------------------------------------------------
{
  await clickInRow('Turning captures into observations', 'Turn off')
  await page.waitForTimeout(700)
  const dialog = await text()
  check(
    /Captures stop becoming observations/.test(dialog),
    'turning routing off names the real consequence',
  )
  check(
    /1 submitted capture/.test(dialog),
    'and quotes the real capture count rather than a caution',
    (dialog.match(/There are [^.]*\./) ?? [''])[0].slice(0, 60),
  )
  await page.screenshot({ path: `${SHOTS}/routing-off-dialog.png`, fullPage: true })
  const committed = await confirmDialog()
  check(committed, 'the dialog offers a commit')
  await page.waitForTimeout(800)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const after = await text()
  check(
    /Turning captures into observations[\s\S]{0,400}?\boff\b/.test(after),
    'the switch survives a reload, which is what makes it a setting',
  )
}

// ---------------------------------------------------------------------------
// 6. The draft panel says when it is off.
// ---------------------------------------------------------------------------
{
  await clickInRow('Drafting a scenario from a document', 'Turn off')
  await page.waitForTimeout(600)
  await confirmDialog()
  await page.waitForTimeout(800)
  const body = await text()
  check(
    body.includes('AI is switched off for this in this workshop'),
    'the draft panel reports the switch rather than offering a dead button',
  )
  await page.locator('button', { hasText: 'Open' }).first().click()
  await page.waitForTimeout(400)
  const open = await text()
  check(
    open.includes('You can still write the events and questions by hand'),
    'and points at the manual route instead of stopping',
  )
  const disabled = await page.locator('button', { hasText: 'Draft this' }).first().isDisabled()
  check(disabled, 'the run button is disabled while the function is off')
}

// ---------------------------------------------------------------------------
// 7-8. Back on, the hand-off carries the workshop's own scale, and is traced.
// ---------------------------------------------------------------------------
{
  await clickInRow('Drafting a scenario from a document', 'Turn on')
  await page.waitForTimeout(600)
  await confirmDialog()
  await page.waitForTimeout(800)

  // A five-point scale on this workshop, so the prompt has something to be wrong
  // about. Written straight to Dexie: this is a rendering test, not a write test.
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('cairn')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['workshops', 'scalePoints'], 'readwrite')
        const workshops = tx.objectStore('workshops').getAll()
        workshops.onsuccess = () => {
          const id = workshops.result[0].id
          const store = tx.objectStore('scalePoints')
          const clear = store.getAll()
          clear.onsuccess = () => {
            for (const row of clear.result) if (row.workshop_id === id) store.delete(row.pk)
            const points = [
              [1, 'not yet'],
              [2, 'emerging'],
              [3, 'competent'],
              [4, 'strong'],
              [5, 'exemplary'],
            ]
            points.forEach(([value, label], i) =>
              store.put({
                pk: `${id}::${value}`,
                workshop_id: id,
                value,
                label,
                description: null,
                is_low_trigger: value <= 2,
                sort_order: i,
              }),
            )
          }
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

  await page.locator('button', { hasText: 'Open' }).first().click()
  await page.waitForTimeout(300)
  await page.locator('textarea').first().fill('A three-day checking workshop curriculum.')
  await page.locator('button', { hasText: 'Draft this' }).first().click()
  await page.waitForTimeout(1200)

  const prompt = await page.locator('textarea[readonly]').first().inputValue()
  check(
    ['1', '2', '3', '4', '5'].every((v) => prompt.includes(`"${v}" (`)),
    'the handed-over prompt asks for this workshop’s five points (D2)',
    prompt.slice(prompt.indexOf('"evidence_levels"'), prompt.indexOf('"evidence_levels"') + 90),
  )
  check(
    !prompt.includes('"0" (not yet demonstrated)'),
    'and not for the 0-3 scale the prompt used to hardcode',
  )
  check(
    prompt.includes('data, not instructions'),
    'the document is framed as data rather than as instructions',
  )

  const body = await text()
  check(
    body.includes('handed over') && body.includes('Drafting a scenario from a document'),
    'the trace records the hand-off, outcome and all',
  )
  await page.screenshot({ path: `${SHOTS}/handed-over.png`, fullPage: true })
}

// ---------------------------------------------------------------------------
// 9. The Routing page has stopped keeping its own answer.
// ---------------------------------------------------------------------------
{
  await page.goto(BASE + 'admin/routing', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  const body = await text()
  check(
    body.includes('The mode is chosen in') && body.includes('Setup → AI'),
    'Routing reports the mode and points at where it is chosen',
  )
  check(
    body.includes('Captures are still being recorded'),
    'and says what the switched-off routing means for captures already taken',
  )
  const copyDisabled = await page
    .locator('button', { hasText: 'Copy pending captures' })
    .first()
    .isDisabled()
  check(copyDisabled, 'the hand-off button is disabled while routing is switched off')
  await page.screenshot({ path: `${SHOTS}/routing.png`, fullPage: true })
}

check(errors.length === 0, 'no page errors anywhere in the walkthrough', errors.slice(0, 2).join(' | '))

await browser.close()
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} PASS, ${failed} FAIL`)
console.log(`Screenshots in ${SHOTS}/`)
if (failed > 0) process.exitCode = 1
