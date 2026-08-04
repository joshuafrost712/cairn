/**
 * tl-15 in a browser: the pack an operator hands to their own agent, and the answers
 * coming back.
 *
 * The unit tests own the renderers, the archive and the stored settings (35 of them, with
 * the runbook pinned to a fixture committed from `main`). What they cannot reach is
 * everything this spec actually promises: that a pack downloads, that its bytes are a zip
 * a tool can open, that its `input/` holds the captures that were pending, and — the half
 * that matters most — that an answer carrying an invented quotation, an unknown
 * participant, an unknown question code or a rating off the scale is REFUSED and named,
 * while the rest of the batch still lands.
 *
 * What is under test, in order:
 *   1. The page renders, states the pending count, and offers the pack.
 *   2. Generating downloads a zip; its central directory holds every file the brief names.
 *   3. `brief.md` carries this workshop's own scale and its goal word, not the defaults.
 *   4. `LOCAL-FILES.md` degrades into "skip this file" with no paths recorded, and carries
 *      them once an administrator records them in Setup → AI.
 *   5. The pack goes through the toggle: with observation routing off it is refused.
 *   6. The pack is traced, as an `operator_action` on the workshop's own mode.
 *   7. A good `output/` file imports, and the observation reaches the store.
 *   8. Five bad items are each rejected with their own reason, and the good item in the
 *      same file still stores. Nothing partially imports.
 *   9. Re-uploading the same file reports "already done" and writes nothing — a stale pack
 *      cannot overwrite routed work.
 *  10. A file for a capture this device does not hold is refused rather than adopted.
 *  11. 390px: no overflow, and every control is inside the viewport.
 *
 *   VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npx vite --port 5199 --strictPort
 *   node scripts/tl15-agent-brief.mjs
 *
 * Port 5199, one above tl-14's: a harness pointed at another worktree's server is the
 * worst possible green, so the constant moves with the server.
 *
 * Playwright is deliberately not a dependency:
 *   npm i -D --no-save playwright && npx playwright install chromium
 */
import { chromium } from 'playwright'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/**
 * The archive is opened by the SYSTEM `unzip`, not by this repo's own reader.
 *
 * The unit test already round-trips the writer through `src/roster/unzip.ts`, which proves
 * the two agree with each other and nothing more. The claim this spec actually makes is
 * that an operator can unzip the pack on their own machine, and the only evidence for that
 * is a tool nobody here wrote opening it.
 */
const zipList = (path) =>
  execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
const zipRead = (path, name) => execFileSync('unzip', ['-p', path, name], { encoding: 'utf8' })

const BASE = `http://localhost:${process.env.TL15_PORT ?? 5199}/`
const SHOTS = 'screenshots/tl15-agent-brief'
const TMP = 'screenshots/tl15-agent-brief/tmp'

const results = []
const check = (ok, label, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label.slice(0, 66).padEnd(66)} | ${String(detail).slice(0, 90)}`)
}

rmSync(SHOTS, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 1000 },
  acceptDownloads: true,
})
const page = await ctx.newPage()

const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})

const idb = (fn, arg) =>
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

async function signIn() {
  await page.goto(BASE + 'signin', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#name', { timeout: 20000 })
  await page.fill('#name', 'tl15 Auditor')
  await page.fill('#email', 'tl15-auditor@example.org')
  await page.click('button[type=submit]')
  await page.waitForTimeout(1500)
}

async function elevate() {
  await idb(`
    const tx = db.transaction('workshopMembers', 'readwrite')
    const store = tx.objectStore('workshopMembers')
    const all = store.getAll()
    all.onsuccess = () => { for (const row of all.result) store.put({ ...row, role: 'chief_admin' }) }
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(String(tx.error))
  `)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
}

/** The dictated text every fixture quotes from, so provenance is checkable both ways. */
const SOURCE =
  'Maria read the passage aloud and asked the team what they noticed about the repeated word. ' +
  'She moved on before the group had answered.'

/**
 * Seed one submitted capture about a real participant in a real activity.
 *
 * Into Dexie rather than through the capture screen, which is every harness's convention
 * in this wave: what is under test is the pack and the import boundary, and driving the
 * capture form would add three screens of failure surface between the fixture and the
 * assertion.
 */
async function seedCapture(clientId) {
  return idb(
    `
    const tx = db.transaction(['participants', 'activities', 'evaluations', 'activityKsas', 'ksas'], 'readwrite')
    const parts = tx.objectStore('participants').getAll()
    const acts = tx.objectStore('activities').getAll()
    const wiring = tx.objectStore('activityKsas').getAll()
    const ksas = tx.objectStore('ksas').getAll()
    let seeded = null
    tx.oncomplete = () => resolve(seeded)
    tx.onerror = () => reject(String(tx.error))
    parts.onsuccess = () => { acts.onsuccess = () => { wiring.onsuccess = () => { ksas.onsuccess = () => {
      const participant = parts.result[0]
      const wired = new Set(wiring.result.map((w) => w.activity_id))
      const activity = acts.result.find((a) => wired.has(a.id)) ?? acts.result[0]
      if (!participant || !activity) { resolve(null); return }
      const code = (wiring.result.filter((w) => w.activity_id === activity.id)
        .map((w) => (ksas.result.find((k) => k.id === w.ksa_id) || {}).code)
        .filter(Boolean))[0] || (ksas.result[0] || {}).code
      const now = new Date().toISOString()
      tx.objectStore('evaluations').put({
        client_id: arg.id,
        evaluator_email: 'tl15-auditor@example.org',
        activity_id: activity.id,
        workshop_id: participant.workshop_id,
        focus_participant_id: participant.id,
        source_language: 'en',
        answers: {},
        quick_ratings: {},
        source_text: arg.source,
        participant_scope: [{ name: participant.name, participant_id: participant.id }],
        attestation: true,
        routing_status: 'local',
        ruleset_version: 'v1',
        edit_history: [],
        created_at: now,
        updated_at: now,
        sync_status: 'local',
        sync_error: null,
      })
      seeded = {
        participant: participant.name,
        participantId: participant.id,
        workshopId: participant.workshop_id,
        activity: activity.title,
        code,
      }
    } } } }
  `,
    { id: clientId, source: SOURCE },
  )
}

const observationsFor = (clientId) =>
  idb(
    `
    const tx = db.transaction('observations', 'readonly')
    const all = tx.objectStore('observations').getAll()
    all.onsuccess = () => resolve(all.result.filter((o) => o.capture_client_id === arg))
    tx.onerror = () => reject(String(tx.error))
  `,
    clientId,
  )

const traceRows = () =>
  idb(`
    const tx = db.transaction('aiCallLog', 'readonly')
    const all = tx.objectStore('aiCallLog').getAll()
    all.onsuccess = () => resolve(all.result)
    tx.onerror = () => reject(String(tx.error))
  `)

/** One observation the router might return, defaulting to a legitimate one. */
const observation = (over = {}) => ({
  participant_name: 'Maria',
  participant_id: null,
  ksa_code: 'Q1',
  text: 'Read the passage aloud to the team.',
  source_excerpt: 'read the passage aloud',
  evidence_designation: 2,
  sentiment_flag: 'strong',
  confidence: 'high',
  needs_review: false,
  origin: 'individual',
  ...over,
})

const outputFile = (captureId, observations) =>
  JSON.stringify(
    {
      schema: 'cairn.observations/v1',
      capture_client_id: captureId,
      routed_at: new Date().toISOString(),
      observations,
    },
    null,
    2,
  )

async function uploadFiles(files) {
  const paths = files.map(({ name, text }) => {
    const path = `${TMP}/${name}`
    writeFileSync(path, text)
    return path
  })
  await page.setInputFiles('input[type=file]', paths)
  await page.waitForTimeout(1500)
}

const text = () => page.evaluate(() => document.body.innerText)

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

const seeded = await seedCapture('tl15-cap-1')
if (!seeded) {
  console.log('FAIL | could not seed a capture: no participant or activity in the local store')
  await browser.close()
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 1-2. The page, and a pack that is really a zip.
// ---------------------------------------------------------------------------
await page.goto(BASE + 'admin/agent-brief', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
await page.screenshot({ path: `${SHOTS}/01-desktop.png`, fullPage: true })

{
  const body = await text()
  check(body.includes('Use your own AI subscription'), '1. the page renders')
  check(/1 capture\(s\) waiting/.test(body) || body.includes('capture(s) waiting'), '1. it states the pending count')
  check(body.includes('Codex') && body.includes('ChatGPT'), '1. it names the tools by name, per the spec')
}

{
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.locator('button', { hasText: 'Generate pack' }).first().click(),
  ])
  const path = `${TMP}/pack.zip`
  await download.saveAs(path)
  check(download.suggestedFilename().endsWith('.zip'), '2. a zip downloads', download.suggestedFilename())

  let names = []
  try {
    names = zipList(path)
  } catch (err) {
    check(false, '2. the system unzip can open the archive', String(err).slice(0, 80))
  }
  check(names.length > 0, '2. the system unzip lists its contents', `${names.length} entries`)
  check(
    ['brief.md', 'workshop.md', 'roster.md', 'schema.json', 'LOCAL-FILES.md'].every((n) => names.includes(n)),
    '2. it holds every file the brief names',
    names.join(', '),
  )
  check(
    names.includes('input/tl15-cap-1.json') && names.includes('output/README.md'),
    '2. input/ holds the pending capture and output/ exists to write into',
  )

  // 3. The brief is this workshop's, not the app's defaults.
  const brief = zipRead(path, 'brief.md')
  check(
    /This workshop's points run from \d+ to \d+/.test(brief),
    '3. brief.md states the workshop’s own scale range',
  )
  check(/\*\*\d\*\* — /.test(brief), '3. and lists its points with their labels')
  check(brief.includes('shipped defaults'), '3. and says the instructions are the shipped defaults')
  const parsed = JSON.parse(zipRead(path, 'input/tl15-cap-1.json'))
  check(
    parsed.capture_client_id === 'tl15-cap-1' && parsed.source_text === SOURCE,
    '3. the capture in input/ is the real capture, id and text intact',
  )
  check(
    Array.isArray(parsed.ksas_in_scope) && parsed.ksas_in_scope.length > 0,
    '3. with the questions in scope inlined, so the pack is self-contained',
    `${(parsed.ksas_in_scope ?? []).length} questions`,
  )

  // 4. LOCAL-FILES with nothing recorded.
  const local = zipRead(path, 'LOCAL-FILES.md')
  check(/skip this file/i.test(local), '4. LOCAL-FILES.md degrades into “skip this file”')
}

// ---------------------------------------------------------------------------
// 4b. Record paths in Setup → AI, and they reach the next pack.
// ---------------------------------------------------------------------------
{
  await page.goto(BASE + 'admin/setup/ai', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.fill('#ai-brief-paths', '/Users/j/Curriculum\n/Users/j/Day3.docx')
  await page.fill('#ai-brief-note', 'Day 3 is the session this workshop is built around.')
  await page.locator('button', { hasText: 'Save locations' }).first().click()
  await page.waitForTimeout(700)
  await confirmDialog()
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${SHOTS}/02-setup-paths.png`, fullPage: true })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const persisted = await page.locator('#ai-brief-paths').inputValue()
  check(persisted.includes('/Users/j/Day3.docx'), '4. the locations survive a reload', persisted.replace('\n', ' | '))

  await page.goto(BASE + 'admin/agent-brief', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.locator('button', { hasText: 'Generate pack' }).first().click(),
  ])
  const path = `${TMP}/pack2.zip`
  await download.saveAs(path)
  const local = zipRead(path, 'LOCAL-FILES.md')
  check(local.includes('/Users/j/Day3.docx'), '4. the next pack carries the recorded locations')
  check(local.includes('Day 3 is the session'), '4. and the administrator’s note about them')
  check(/has not read them, cannot see them/i.test(local), '4. while refusing to claim the app read them')
  check(/no ratings and no claims about people/i.test(local), '4. and forbidding ratings taken from them')
}

// ---------------------------------------------------------------------------
// 5-6. The toggle gates the pack, and the pack is traced.
// ---------------------------------------------------------------------------
{
  const rows = await traceRows()
  const packRows = rows.filter((r) => r.fn === 'observation_routing' && r.detail === 'setup.ai.op.pack-ready')
  check(packRows.length >= 2, '6. every pack is traced as an operator action', `${packRows.length} rows`)
  check(
    packRows.every((r) => r.outcome === 'operator_action' && r.mode === 'github-claude'),
    '6. and the trace records the workshop’s actual mode, not one the pack implies',
    packRows.map((r) => `${r.outcome}/${r.mode}`).join(' '),
  )

  await page.goto(BASE + 'admin/setup/ai', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const routingRow = page.locator('li.ai-fn', { hasText: 'Turning captures into observations' }).first()
  await routingRow.locator('button', { hasText: 'Turn off' }).first().click()
  await page.waitForTimeout(700)
  await confirmDialog()
  await page.waitForTimeout(800)

  await page.goto(BASE + 'admin/agent-brief', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const disabled = await page.locator('button', { hasText: 'Generate pack' }).first().isDisabled()
  check(disabled, '5. with routing switched off the pack button is disabled')
  const body = await text()
  check(/switched off|turned off|off for/i.test(body), '5. and the page says why rather than just refusing')
  await page.screenshot({ path: `${SHOTS}/03-toggle-off.png`, fullPage: true })

  // Back on, for the import half.
  await page.goto(BASE + 'admin/setup/ai', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page
    .locator('li.ai-fn', { hasText: 'Turning captures into observations' })
    .first()
    .locator('button', { hasText: 'Turn on' })
    .first()
    .click()
  await page.waitForTimeout(700)
  await confirmDialog()
  await page.waitForTimeout(800)
}

// ---------------------------------------------------------------------------
// 7-8. The answers come back, and the bad ones are named.
// ---------------------------------------------------------------------------
await page.goto(BASE + 'admin/agent-brief', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)

{
  // One good item and five bad ones in the same file: nothing partially imports, and
  // one invalid item must not take the good one with it.
  const good = observation({ participant_name: seeded.participant, ksa_code: seeded.code })
  const bad = [
    observation({ ksa_code: seeded.code, participant_id: 'p-invented', participant_name: seeded.participant }),
    observation({ ksa_code: 'Q-INVENTED', participant_name: seeded.participant }),
    observation({ ksa_code: seeded.code, evidence_designation: 9, participant_name: seeded.participant }),
    observation({
      ksa_code: seeded.code,
      participant_name: seeded.participant,
      source_excerpt: 'She explained the imagery of the psalm to each participant in turn.',
    }),
    { ...observation({ ksa_code: seeded.code }), text: undefined },
  ]
  await uploadFiles([{ name: 'tl15-cap-1.json', text: outputFile('tl15-cap-1', [good, ...bad]) }])
  await page.screenshot({ path: `${SHOTS}/04-import-report.png`, fullPage: true })

  const body = await text()
  check(/1 observation\(s\) stored/.test(body), '7. the good item stored', body.match(/\d+ observation\(s\) stored/)?.[0])
  check(/5 rejected/.test(body), '8. all five bad items were rejected', body.match(/\d+ rejected/)?.[0])
  check(
    /not in this workshop/i.test(body),
    '8. and the unknown participant is named as such',
  )
  check(/question code this workshop does not have/i.test(body), '8. the unknown question code likewise')
  check(/outside this workshop's scale|outside this workshop’s scale/i.test(body), '8. the off-scale rating likewise')
  check(
    /quotes something that is not in what the evaluator said/i.test(body),
    '8. and the invented quotation, which is the check that matters most',
  )
  check(/missing something it must have/i.test(body), '8. and the malformed item')

  const stored = await observationsFor('tl15-cap-1')
  check(stored.length === 1, '7. exactly one observation reached the store', `${stored.length} rows`)
  check(
    stored[0]?.source_excerpt === 'read the passage aloud',
    '7. and it is the grounded one',
    stored[0]?.source_excerpt,
  )
}

// ---------------------------------------------------------------------------
// 8b. A file whose every item is bad costs nothing and can be retried.
//
// The review's worst finding. Before the fix, an all-rejected file wiped the capture's
// observations, marked it routed, and — because tl-15 then refuses an already-routed
// capture — made the correction impossible: the capture was permanently routed with zero
// observations, absent from the pending queue and from every future pack, with nothing
// anywhere saying so.
// ---------------------------------------------------------------------------
{
  const second = await seedCapture('tl15-cap-2')
  await page.goto(BASE + 'admin/agent-brief', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)

  const allBad = [
    observation({
      ksaCode: second.code,
      ksa_code: second.code,
      participant_name: second.participant,
      source_excerpt: 'She explained the imagery of the psalm to each participant in turn.',
    }),
    observation({ ksa_code: 'Q-INVENTED', participant_name: second.participant }),
  ]
  await uploadFiles([{ name: 'tl15-cap-2.json', text: outputFile('tl15-cap-2', allBad) }])
  const body = await text()
  check(/nothing kept/i.test(body), '8b. a file whose every item is bad reports “nothing kept”')
  check(/0 observation\(s\) stored/.test(body), '8b. and stores nothing', body.match(/\d+ observation\(s\) stored/)?.[0])

  const stillPending = await idb(
    `
    const tx = db.transaction('evaluations', 'readonly')
    const one = tx.objectStore('evaluations').get(arg)
    one.onsuccess = () => resolve(one.result ? one.result.routing_status : null)
    tx.onerror = () => reject(String(tx.error))
  `,
    'tl15-cap-2',
  )
  check(
    stillPending !== 'routed',
    '8b. the capture is NOT marked routed, so it stays in the queue',
    `routing_status ${stillPending}`,
  )

  // And the correction lands, which is the half the old behaviour made impossible.
  const fixed = observation({ ksa_code: second.code, participant_name: second.participant })
  await uploadFiles([{ name: 'tl15-cap-2.json', text: outputFile('tl15-cap-2', [fixed]) }])
  const after = await text()
  check(/1 observation\(s\) stored/.test(after), '8b. and a corrected answer for it still imports')
  const stored = await observationsFor('tl15-cap-2')
  check(stored.length === 1, '8b. exactly one observation, from the corrected file', `${stored.length} rows`)
}
{
  // The same capture again, this time with a DIFFERENT observation. Under the spec's
  // round-trip rule this must be reported as already done and must write nothing: a pack
  // generated last week overwriting work that has since been done properly is the failure
  // the rule exists to prevent.
  const stale = observation({
    participant_name: seeded.participant,
    ksa_code: seeded.code,
    text: 'A stale answer that must not land.',
    source_excerpt: 'asked the team what they noticed',
  })
  await uploadFiles([{ name: 'tl15-cap-1.json', text: outputFile('tl15-cap-1', [stale]) }])
  const body = await text()
  check(/already done/i.test(body), '9. re-uploading the same capture reports “already done”')
  const stored = await observationsFor('tl15-cap-1')
  check(
    stored.length === 1 && stored[0].text !== 'A stale answer that must not land.',
    '9. and nothing was overwritten',
    stored.map((o) => o.text).join(' | '),
  )

  await uploadFiles([{ name: 'nobody.json', text: outputFile('tl15-cap-absent', [observation()]) }])
  const after = await text()
  check(/not this workshop's|not this workshop’s/i.test(after), '10. a capture this device does not hold is refused')
  const invented = await observationsFor('tl15-cap-absent')
  check(invented.length === 0, '10. and nothing was created for it', `${invented.length} rows`)

  await uploadFiles([{ name: 'garbage.json', text: '{ not json at all' }])
  check(/unreadable/i.test(await text()), '10. and malformed JSON is reported per file rather than thrown')
  await page.screenshot({ path: `${SHOTS}/05-refusals.png`, fullPage: true })
}

// ---------------------------------------------------------------------------
// 11. The 390px view, because a passing audit is not a usable layout.
// ---------------------------------------------------------------------------
{
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(BASE + 'admin/agent-brief', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  await page.screenshot({ path: `${SHOTS}/06-phone.png`, fullPage: true })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  check(overflow <= 1, '11. phone: no horizontal body overflow at 390px', `${overflow}px`)
  const offscreen = await page.evaluate(() => {
    const bad = []
    for (const el of document.querySelectorAll('button, input, a.small')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      if (r.right > window.innerWidth + 1 || r.left < -1) bad.push(el.textContent?.trim() || el.tagName)
    }
    return bad
  })
  check(offscreen.length === 0, '11. phone: every control is inside the viewport', offscreen.join(', '))

  await page.goto(BASE + 'admin/setup/ai', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${SHOTS}/07-phone-setup.png`, fullPage: true })
  const setupOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  check(setupOverflow <= 1, '11. phone: Setup → AI still fits with the new panel', `${setupOverflow}px`)
}

check(errors.length === 0, 'no page errors', errors.slice(0, 2).join(' | '))

await browser.close()
const passed = results.filter(Boolean).length
console.log(`\ntl-15 agent brief: ${passed}/${results.length} passed. Screenshots in ${SHOTS}/`)
process.exit(passed === results.length ? 0 : 1)
