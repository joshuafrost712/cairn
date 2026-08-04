/**
 * tl-15's acceptance test: a pack, a real agent, and the answers coming home.
 *
 * The spec's own words: "generate a pack for observation routing, run it through Codex
 * against the operator's own course folder, and import the result. The output validates,
 * imports, and the observations are correct enough to keep. Record what the agent got
 * wrong, because that is feedback on the brief and the brief is the deliverable."
 *
 * So this script is deliberately only the two ends of that. It seeds two captures, opens
 * `/admin/agent-brief`, generates the pack, unzips it into a working folder beside a real
 * course-materials folder, and then WAITS — printing the folder it is waiting on. An agent
 * that has never seen this repository reads `brief.md` and writes `output/`. When files
 * appear the script uploads them through the app's own import path and prints what
 * happened, item by item.
 *
 * The agent is not scripted here on purpose. A harness that generated the answers would be
 * testing this repository's idea of what an agent would do, which is the one thing already
 * known.
 *
 *   VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npx vite --port 5199 --strictPort
 *   node scripts/tl15-roundtrip.mjs
 */
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = `http://localhost:${process.env.TL15_PORT ?? 5199}/`
const WORK = resolve('screenshots/tl15-roundtrip')
const PACK_DIR = `${WORK}/pack`
const COURSE_DIR = `${WORK}/course-materials`
const WAIT_MS = Number(process.env.TL15_WAIT_MS ?? 900_000)

/** Two dictated captures, written the way an evaluator actually talks into a phone. */
const CAPTURES = [
  {
    id: 'tl15-rt-1',
    text:
      "okay so in the genre mapping block Keem Leong ran the elicitation and he started well, he asked the MTTs " +
      "to name the kinds of songs they use at a funeral and then at a harvest, and he got four distinct genres out " +
      "of them in about ten minutes. good. but when Sajesh Pradhan offered a lament form he did not really follow " +
      "it up, he just said mm-hmm and moved on to his next question, so the team never got to work out what made " +
      "that form a lament rather than just a sad song. he also kept reading from his own list in the second half " +
      "rather than working from what the MTTs were actually saying.",
  },
  {
    id: 'tl15-rt-2',
    text:
      "Sajesh Pradhan in the same session. quiet for the first twenty minutes and then he did something quite " +
      "good, he performed one of the harvest forms the way his grandmother would have sung it, and the difference " +
      "between that and the way it had been read out made the whole group laugh and then think. that is naturally " +
      "oral. he did not connect it back to the mapping question though, so it sat there as a nice moment rather " +
      "than an argument about which genre fits.",
  },
]

/** A course document the pack will point the agent at, and that only exists here. */
const COURSE_DOC = `# Psalms Workshop (OBT CDT Workshop 3) — facilitator notes, day 1

## What the genre repertoire mapping block is for

The block is NOT about producing a correct list of genres. It is about whether the
participant can get a mother-tongue translator team to describe their own repertoire in
their own terms. A participant who arrives with a list of genres and reads it out has not
done the thing we are assessing.

## Vocabulary this course uses

- **Naturally oral** — a rendering that works when performed aloud to a listening group,
  in the register the community actually uses. Reading a written draft aloud is not
  naturally oral.
- **Holding the question open** — resisting the urge to answer your own question, so the
  team does the interpretive work. The commonest failure in workshop 3 is a facilitator
  who asks a real question and then moves on before anybody has answered it.
- **Elicitation from use, not from category** — asking "what do you sing at a funeral"
  rather than "do you have laments", so the genre comes from the community's practice.

## What we say to a participant who moves on too fast

Name the behaviour and not the person. "You asked a real question there and then moved
before Sajesh finished" is usable; "you don't listen" is not.
`

const log = (...args) => console.log(...args)

rmSync(WORK, { recursive: true, force: true })
mkdirSync(PACK_DIR, { recursive: true })
mkdirSync(COURSE_DIR, { recursive: true })
writeFileSync(`${COURSE_DIR}/day-2-facilitator-notes.md`, COURSE_DOC)

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

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

await page.goto(BASE + 'signin', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#name', { timeout: 20000 })
await page.fill('#name', 'tl15 Roundtrip')
await page.fill('#email', 'tl15-roundtrip@example.org')
await page.click('button[type=submit]')
await page.waitForTimeout(1500)
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

const seeded = await idb(
  `
  const tx = db.transaction(['participants', 'activities', 'evaluations', 'activityKsas'], 'readwrite')
  const parts = tx.objectStore('participants').getAll()
  const acts = tx.objectStore('activities').getAll()
  const wiring = tx.objectStore('activityKsas').getAll()
  let seeded = null
  tx.oncomplete = () => resolve(seeded)
  tx.onerror = () => reject(String(tx.error))
  parts.onsuccess = () => { acts.onsuccess = () => { wiring.onsuccess = () => {
    const wired = new Set(wiring.result.map((w) => w.activity_id))
    const activity = acts.result.find((a) => wired.has(a.id)) ?? acts.result[0]
    if (!activity || parts.result.length === 0) { resolve(null); return }
    const scope = parts.result.slice(0, 6).map((p) => ({ name: p.name, participant_id: p.id }))
    const now = new Date().toISOString()
    for (const cap of arg) {
      tx.objectStore('evaluations').put({
        client_id: cap.id,
        evaluator_email: 'tl15-roundtrip@example.org',
        activity_id: activity.id,
        workshop_id: parts.result[0].workshop_id,
        focus_participant_id: null,
        source_language: 'en',
        answers: {},
        quick_ratings: {},
        source_text: cap.text,
        participant_scope: scope,
        attestation: true,
        routing_status: 'local',
        ruleset_version: 'v1',
        edit_history: [],
        created_at: now,
        updated_at: now,
        sync_status: 'local',
        sync_error: null,
      })
    }
    seeded = { activity: activity.title, roster: scope.map((s) => s.name) }
  } } }
`,
  CAPTURES,
)
if (!seeded) {
  log('could not seed: no participants or activities in the local store')
  await browser.close()
  process.exit(1)
}
log(`seeded ${CAPTURES.length} captures in "${seeded.activity}" — scope: ${seeded.roster.join(', ')}`)

// Record the course folder, so LOCAL-FILES.md points at something that really exists.
await page.goto(BASE + 'admin/setup/ai', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
await page.fill('#ai-brief-paths', COURSE_DIR)
await page.fill(
  '#ai-brief-note',
  'Day 2 facilitator notes. Read them for what the exegesis block is for and for the course’s own vocabulary.',
)
await page.locator('button', { hasText: 'Save locations' }).first().click()
await page.waitForTimeout(700)
{
  const confirm = page.locator('dialog button, .modal button, [role=dialog] button').filter({
    hasText: /^(Save|Apply|Confirm|Save anyway|Yes)/i,
  })
  if ((await confirm.count()) > 0) {
    await confirm.first().click()
    await page.waitForTimeout(800)
  }
}

await page.goto(BASE + 'admin/agent-brief', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 20000 }),
  page.locator('button', { hasText: 'Generate pack' }).first().click(),
])
const zipPath = `${WORK}/pack.zip`
await download.saveAs(zipPath)
execFileSync('unzip', ['-q', '-o', zipPath, '-d', PACK_DIR])
log(`\npack unzipped to:\n  ${PACK_DIR}`)
log(`course materials at:\n  ${COURSE_DIR}`)
log(`\nWaiting for output/*.json in ${PACK_DIR}/output …`)

const outDir = `${PACK_DIR}/output`
mkdirSync(outDir, { recursive: true })
// existsSync-guarded: the agent may replace the folder rather than write into it, and a
// harness that dies on ENOENT halfway through a fifteen-minute wait wastes the whole run.
const answers = () =>
  existsSync(outDir) ? readdirSync(outDir).filter((f) => f.toLowerCase().endsWith('.json')) : []
const started = Date.now()
while (answers().length < CAPTURES.length && Date.now() - started < WAIT_MS) {
  await new Promise((r) => setTimeout(r, 4000))
}
const files = answers()
if (files.length === 0) {
  log('no answers appeared; nothing to import.')
  await browser.close()
  process.exit(1)
}
log(`found ${files.length}: ${files.join(', ')}\n`)

await page.setInputFiles(
  'input[type=file]',
  files.map((f) => `${outDir}/${f}`),
)
await page.waitForTimeout(2500)
await page.screenshot({ path: `${WORK}/import.png`, fullPage: true })
log(await page.evaluate(() => document.body.innerText))

const stored = await idb(`
  const tx = db.transaction('observations', 'readonly')
  const all = tx.objectStore('observations').getAll()
  all.onsuccess = () => resolve(all.result)
  tx.onerror = () => reject(String(tx.error))
`)
log('\n--- what was kept ---')
for (const o of stored) {
  log(
    `${o.capture_client_id} ${o.ksa_code} ${o.evidence_designation} ${o.needs_review ? '(needs review)' : ''} ` +
      `${o.participant_name}: ${o.text}\n    “${o.source_excerpt}”`,
  )
}
if (existsSync(`${PACK_DIR}/brief.md`)) {
  log(`\nbrief.md is ${readFileSync(`${PACK_DIR}/brief.md`, 'utf8').length} characters.`)
}
log(`\npage errors: ${errors.length}${errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''}`)
await browser.close()
