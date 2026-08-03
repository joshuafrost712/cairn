/**
 * tl-21 in a browser: the mode an administrator can actually select, configure and use.
 *
 * `scripts/tl21-relay-checks.mjs` owns the relay on the wire and the unit tests own the
 * queue policy and the prompts. What neither can reach is the thing this wave has found a
 * bug in every single time: what an administrator sees, and whether a control they touch
 * reaches a store and comes back. It is also the only place the PROVIDER runs at all,
 * since it talks to Dexie from inside a page.
 *
 * What is under test, in order:
 *   1. The fourth mode is selectable, and selecting it goes through tl-07's dialog.
 *   2. The panel tells the four failures apart: not set up, not reachable, wrong token,
 *      and healthy. Each with its own fix on screen.
 *   3. A pending capture is routed end to end by one button press, with no terminal and no
 *      paste, and the observations arrive through the app's own validation.
 *   4. The token counts reach the trace, which is what tl-14's calibration was waiting on.
 *   5. NEGATIVE: a result naming a participant who is not in the workshop is rejected.
 *   6. NEGATIVE: a result carrying an off-scale designation is rejected.
 *   7. NEGATIVE: a result that is not JSON is a readable failure, not a silent nothing.
 *   8. The folder-exchange path produces a job file with the same contract.
 *   9. The other three modes refuse an unattended run rather than pretending.
 *  10. Both viewports render the panel with no body overflow.
 *
 * A LOOPBACK FETCH FROM A PAGE IS THE WHOLE POINT, so note why this can be headless:
 * finding 5 of the spec measured that headless Chromium refuses `127.0.0.1` from an
 * https:// origin but reaches it with no permission at all from a page served over
 * http://localhost, which is what a dev server is. The deployed-origin case was measured
 * by hand in Joshua's own Chrome 150 and cannot be proved here.
 *
 *   VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npx vite --port 5199 --strictPort
 *   node scripts/tl21-local-agent.mjs
 *
 * Port 5199, one above tl-14's: a harness pointed at another worktree's server is the
 * worst possible green, so the constant moves with the server.
 *
 * Playwright is deliberately not a dependency:
 *   npm i -D --no-save playwright && npx playwright install chromium
 */
import { chromium } from 'playwright'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const BASE = `http://localhost:${process.env.TL21_UI_PORT ?? 5199}/`
const RELAY_PORT = Number(process.env.TL21_RELAY_PORT || 8896)
const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}`
const TOKEN = 'tl21-ui-token-bbbbbbbbbbbbbbbbbbbbbbbb'
const SHOTS = 'screenshots/tl21-local-agent'

const results = []
const check = (ok, label, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label.slice(0, 70).padEnd(70)} | ${String(detail).slice(0, 80)}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

rmSync(SHOTS, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })

const relayHome = mkdtempSync(join(tmpdir(), 'tl21-ui-relay-'))
let relay = null

async function startRelay(fakeMode = 'ok', extraEnv = {}) {
  await stopRelay()
  const child = spawn(process.execPath, [join(HERE, '..', 'relay', 'server.mjs'), '--port', String(RELAY_PORT)], {
    env: {
      ...process.env,
      HONEST_EVAL_RELAY_HOME: relayHome,
      HONEST_EVAL_RELAY_TOKEN: TOKEN,
      HONEST_EVAL_RELAY_CLAUDE_BIN: join(HERE, 'tl21-fake-claude.mjs'),
      HONEST_EVAL_FAKE_MODE: fakeMode,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => {
    out += d
  })
  child.stderr.on('data', (d) => {
    out += d
  })
  for (let i = 0; i < 100; i++) {
    if (out.includes('listening on')) break
    await sleep(100)
  }
  if (!out.includes('listening on')) {
    console.log(out)
    throw new Error(`the relay did not start on ${RELAY_PORT}. A previous run may hold it: pkill -f relay/server.mjs`)
  }
  relay = child
}

async function stopRelay() {
  if (!relay || relay.exitCode !== null) return
  relay.kill('SIGTERM')
  for (let i = 0; i < 40; i++) {
    if (relay.exitCode !== null) break
    await sleep(50)
  }
  relay = null
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})

const text = () => page.evaluate(() => document.body.innerText)

/** Dexie, from inside the page. One helper for every fixture and every assertion. */
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
  await page.fill('#name', 'tl21 Auditor')
  await page.fill('#email', 'tl21-auditor@example.org')
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

/** Put the relay's address and token where the app reads them. */
async function configureRelay() {
  await page.evaluate(
    ([url, token]) => {
      localStorage.setItem('cairn.relay.url', url)
      localStorage.setItem('cairn.relay.token', token)
    },
    [RELAY_URL, TOKEN],
  )
}

/**
 * Seed one submitted capture about a real participant in a real activity.
 *
 * Seeded into Dexie rather than dictated through the capture screen, which is the
 * convention every harness in this wave uses (tl-18's does the same): what is under test
 * here is the routing path, and driving the capture form would add three screens of
 * failure surface between the fixture and the assertion.
 */
async function seedCapture(clientId) {
  return idb(
    `
    const tx = db.transaction(['participants', 'activities', 'workshops', 'evaluations', 'activityKsas'], 'readwrite')
    const parts = tx.objectStore('participants').getAll()
    const acts = tx.objectStore('activities').getAll()
    const wiring = tx.objectStore('activityKsas').getAll()
    tx.oncomplete = () => resolve(seeded)
    tx.onerror = () => reject(String(tx.error))
    let seeded = null
    parts.onsuccess = () => {
      acts.onsuccess = () => {
        wiring.onsuccess = () => {
          const participant = parts.result[0]
          // An activity that actually has questions wired to it, or the bundle would carry
          // no KSAs and the router would have nothing legal to answer with.
          const wired = new Set(wiring.result.map((w) => w.activity_id))
          const activity = acts.result.find((a) => wired.has(a.id)) ?? acts.result[0]
          if (!participant || !activity) { resolve(null); return }
          const now = new Date().toISOString()
          tx.objectStore('evaluations').put({
            client_id: arg,
            evaluator_email: 'tl21-auditor@example.org',
            activity_id: activity.id,
            workshop_id: participant.workshop_id,
            focus_participant_id: participant.id,
            source_language: 'en',
            answers: {},
            quick_ratings: {},
            source_text: 'She explained the passage clearly and checked that the group had understood it.',
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
          seeded = { participant: participant.name, participantId: participant.id, workshopId: participant.workshop_id, activity: activity.title }
        }
      }
    }
  `,
    clientId,
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

const setMode = (mode) =>
  idb(
    `
    const tx = db.transaction('aiConfigs', 'readwrite')
    const store = tx.objectStore('aiConfigs')
    const all = store.getAll()
    all.onsuccess = () => {
      const row = all.result[0]
      store.put({
        workshop_id: arg.workshopId,
        mode: arg.mode,
        functions: row?.functions ?? {},
        assumptions: row?.assumptions ?? {},
        updated_by: 'tl21-harness',
        updated_at: new Date().toISOString(),
      })
    }
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(String(tx.error))
  `,
    { mode: 'local-agent', ...(arguments.length ? {} : {}), ...mode },
  )

async function clickByText(label, timeout = 5000) {
  const button = page.locator('button', { hasText: label }).first()
  await button.waitFor({ state: 'visible', timeout })
  await button.click()
}

async function confirmDialog() {
  const confirm = page
    .locator('dialog button, .modal button, [role=dialog] button')
    .filter({ hasText: /^(Save|Apply|Confirm|Save anyway|Yes)/i })
  if ((await confirm.count()) > 0) {
    await confirm.first().click()
    await page.waitForTimeout(800)
    return true
  }
  return false
}

try {
  await startRelay('ok')
  await signIn()
  await elevate()
  await configureRelay()

  // ---------------------------------------------------------------------------
  // 1. The mode is selectable, through the change dialog.
  // ---------------------------------------------------------------------------
  await page.goto(BASE + 'admin/setup/ai', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${SHOTS}/01-ai-section.png`, fullPage: true })
  {
    const body = await text()
    check(body.includes('A machine at the workshop runs it'), '1. the fourth mode is offered')
    check(
      body.includes('Safari refuses a local connection') || body.includes('Safari'),
      '1. its limits name the browser requirement',
    )
    check(body.includes('The machine at this workshop'), '1. the panel that configures it is on the same screen')
  }

  {
    // Select it: the third "Use this" button belongs to the third mode card, so find the
    // card by its own heading instead of counting.
    const card = page.locator('.banner', { hasText: 'A machine at the workshop runs it' }).first()
    await card.locator('button', { hasText: 'Use this' }).click()
    await page.waitForTimeout(600)
    const dialogued = await confirmDialog()
    await page.waitForTimeout(1000)
    const body = await text()
    check(dialogued, '1. selecting the mode goes through the change dialog')
    check(
      (await page.locator('.banner', { hasText: 'A machine at the workshop runs it' }).first().innerText()).includes('in use'),
      '1. and the mode is now in use',
      body.match(/in use/) ? 'marked in use' : 'not marked',
    )
  }

  // ---------------------------------------------------------------------------
  // 2. The four states, each with its own fix.
  // ---------------------------------------------------------------------------
  {
    await clickByText('Test the connection')
    await page.waitForTimeout(2500)
    let body = await text()
    check(body.includes('ready'), '2. a running relay with a worker reports ready')
    check(/Queue: \d+ waiting/.test(body), '2. health shows the queue depth')
    check(body.includes('Drop folder'), '2. and names the folder-exchange path')
    await page.screenshot({ path: `${SHOTS}/02-healthy.png`, fullPage: true })

    await page.evaluate(() => localStorage.setItem('cairn.relay.token', 'wrong-token-wrong-token-wrong'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    await clickByText('Test the connection')
    await page.waitForTimeout(2500)
    body = await text()
    check(body.includes('wrong token'), '2. a wrong token is reported as a wrong token')
    check(body.includes('Copy it again from the terminal'), '2. with the fix for that state')
    await page.screenshot({ path: `${SHOTS}/03-bad-token.png`, fullPage: true })

    await configureRelay()
    await stopRelay()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    await clickByText('Test the connection')
    await page.waitForTimeout(4000)
    body = await text()
    check(body.includes('not reachable'), '2. a stopped relay is reported as not reachable')
    check(body.includes('Safari refuses this kind of connection'), '2. naming the browser as a cause, not just the service')
    await page.screenshot({ path: `${SHOTS}/04-not-reachable.png`, fullPage: true })

    await startRelay('no-runner')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    await clickByText('Test the connection')
    await page.waitForTimeout(3000)
    body = await text()
    check(body.includes('no worker'), '2. a relay with no usable Claude is reported as no worker')
    check(body.includes('Install Claude Code there and sign it in'), '2. with the fix for that state')
    await page.screenshot({ path: `${SHOTS}/05-no-runner.png`, fullPage: true })

    await page.evaluate(() => localStorage.removeItem('cairn.relay.token'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    await clickByText('Test the connection')
    await page.waitForTimeout(1500)
    body = await text()
    check(body.includes('not set up'), '2. no token at all is reported before anything is tried')
    await configureRelay()
  }

  // ---------------------------------------------------------------------------
  // 3-4. One button press, end to end.
  // ---------------------------------------------------------------------------
  await startRelay('ok')
  const CAP = 'tl21-cap-1'
  const seeded = await seedCapture(CAP)
  check(Boolean(seeded?.participant), '3. a capture was seeded about a real participant', seeded?.participant ?? 'none')
  await page.goto(BASE + 'admin/routing', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${SHOTS}/06-routing.png`, fullPage: true })
  {
    const body = await text()
    check(body.includes('Route on the machine at this workshop'), '3. the unattended card is on the Routing page')
    check(body.includes('Route now'), '3. with one button')
  }
  {
    await clickByText('Route now')
    await page.waitForTimeout(9000)
    const body = await text()
    const obs = await observationsFor(CAP)
    check(obs.length > 0, '3. the observations arrived in the store', `${obs.length} stored`)
    check(/Routed \d+ capture/.test(body), '3. and the screen says what happened', body.match(/Routed[^.]*\./)?.[0] ?? '')
    check(
      obs.every((o) => o.participant_id === seeded.participantId),
      '3. attributed to the participant the capture was about',
    )
    check(
      obs.every((o) => o.workshop_id === seeded.workshopId),
      '3. and carrying the workshop, so they can be shared',
    )
    await page.screenshot({ path: `${SHOTS}/07-routed.png`, fullPage: true })

    const rows = await traceRows()
    const mine = rows.filter((r) => r.mode === 'local-agent' && r.fn === 'observation_routing')
    check(mine.length > 0, '4. the call is traced against the mode', `${mine.length} rows`)
    check(
      mine.some((r) => (r.tokens_in ?? 0) > 0 && (r.tokens_out ?? 0) > 0),
      '4. with real token counts, which is what the estimator’s calibration needed',
      JSON.stringify(mine.map((r) => [r.tokens_in, r.tokens_out])),
    )
  }

  // ---------------------------------------------------------------------------
  // 5-7. The negative cases.
  // ---------------------------------------------------------------------------
  {
    const CAP2 = 'tl21-cap-2'
    await seedCapture(CAP2)
    await startRelay('ok', { HONEST_EVAL_FAKE_PARTICIPANT_ID: '00000000-0000-4000-8000-00000000dead' })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    await clickByText('Route now')
    await page.waitForTimeout(9000)
    const obs = await observationsFor(CAP2)
    check(
      obs.length === 0,
      '5. an observation naming a participant outside the workshop is rejected, not created',
      `${obs.length} stored`,
    )
  }

  {
    const CAP3 = 'tl21-cap-3'
    await seedCapture(CAP3)
    await startRelay('ok', { HONEST_EVAL_FAKE_DESIGNATION: '9' })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    await clickByText('Route now')
    await page.waitForTimeout(9000)
    const obs = await observationsFor(CAP3)
    check(obs.length === 0, '6. an off-scale designation is rejected at the import boundary', `${obs.length} stored`)
  }

  {
    const CAP4 = 'tl21-cap-4'
    await seedCapture(CAP4)
    await startRelay('notjson')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    await clickByText('Route now')
    await page.waitForTimeout(9000)
    const body = await text()
    const obs = await observationsFor(CAP4)
    check(obs.length === 0, '7. a reply that is not JSON stores nothing')
    check(
      /could not|no JSON|not JSON/i.test(body),
      '7. and says so in a sentence rather than failing silently',
      body.split('\n').find((l) => /JSON|could not/i.test(l)) ?? '',
    )
    await page.screenshot({ path: `${SHOTS}/08-not-json.png`, fullPage: true })
  }

  // ---------------------------------------------------------------------------
  // 8. The folder exchange.
  // ---------------------------------------------------------------------------
  {
    await startRelay('ok')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    await clickByText('Prepare a file instead')
    await page.waitForTimeout(2500)
    const value = await page.locator('textarea.mono').first().inputValue()
    let parsed = null
    try {
      parsed = JSON.parse(value)
    } catch {
      /* reported below */
    }
    check(Boolean(parsed?.prompt) && Boolean(parsed?.system), '8. the job file is a complete job')
    check(parsed?.fn === 'observation_routing' && parsed?.expect === 'json', '8. with the same contract the direct path uses')

    if (parsed) {
      writeFileSync(join(relayHome, 'drop', 'in', 'ui-batch.json'), JSON.stringify(parsed, null, 2))
      let out = []
      for (let i = 0; i < 60; i++) {
        out = readdirSync(join(relayHome, 'drop', 'out'))
        if (out.includes('ui-batch.result.json')) break
        await sleep(300)
      }
      check(out.includes('ui-batch.result.json'), '8. dropped into the folder, it comes back as a result')
      if (out.includes('ui-batch.result.json')) {
        const answer = readFileSync(join(relayHome, 'drop', 'out', 'ui-batch.result.json'), 'utf8')
        // Pasted into the SAME import box the copy/paste path has always used.
        await page.locator('#paste').fill(answer)
        await clickByText('Import observations')
        await page.waitForTimeout(2500)
        const body = await text()
        check(/Imported \d+ observation/.test(body), '8. and the answer imports through the existing box', body.match(/Imported[^.]*\./)?.[0] ?? '')
      }
    }
    await page.screenshot({ path: `${SHOTS}/09-folder-exchange.png`, fullPage: true })
  }

  // ---------------------------------------------------------------------------
  // 9. The other modes refuse rather than pretending.
  // ---------------------------------------------------------------------------
  {
    const CAP5 = 'tl21-cap-5'
    const s = await seedCapture(CAP5)
    await page.evaluate(
      ([workshopId]) =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open('cairn')
          req.onsuccess = () => {
            const db = req.result
            const tx = db.transaction('aiConfigs', 'readwrite')
            tx.objectStore('aiConfigs').put({
              workshop_id: workshopId,
              mode: 'github-claude',
              functions: {},
              assumptions: {},
              updated_by: 'tl21-harness',
              updated_at: new Date().toISOString(),
            })
            tx.oncomplete = () => resolve(true)
            tx.onerror = () => reject(String(tx.error))
          }
          req.onerror = () => reject(String(req.error))
        }),
      [s.workshopId],
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    const body = await text()
    check(!body.includes('Route on the machine at this workshop'), '9. the unattended card is absent in the default mode')
    await page.screenshot({ path: `${SHOTS}/10-default-mode.png`, fullPage: true })
  }

  // ---------------------------------------------------------------------------
  // 10. Both viewports.
  // ---------------------------------------------------------------------------
  {
    const phone = await ctx.newPage()
    await phone.goto(BASE + 'admin/setup/ai', { waitUntil: 'domcontentloaded' })
    await phone.setViewportSize({ width: 390, height: 844 })
    await phone.waitForTimeout(1500)
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    check(!overflow, '10. the panel does not overflow a 390px phone', `scrollWidth ${await phone.evaluate(() => document.documentElement.scrollWidth)}`)
    await phone.screenshot({ path: `${SHOTS}/11-phone-setup.png`, fullPage: true })
    await phone.close()
  }

  const realErrors = errors.filter(
    (e) =>
      !/Failed to load resource|net::ERR|401|Unauthorized|supabase|Failed to fetch/i.test(e),
  )
  check(realErrors.length === 0, 'no unexplained page errors', realErrors.slice(0, 2).join(' | '))
} finally {
  await stopRelay()
  await browser.close()
  rmSync(relayHome, { recursive: true, force: true })
}

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} checks passed`)
console.log(`screenshots: ${SHOTS}`)
if (passed !== results.length) process.exit(1)
