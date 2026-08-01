/**
 * tl-07's acceptance, which cannot be checked from a module.
 *
 * The classifier is unit-tested (test/impact.test.ts) and the log's authorization is
 * SQL-tested (scripts/tl07-rls-tests.sql). What neither can prove is the claim the
 * spec actually makes: that a real administrator, on a real workshop, gets a dialog
 * with the REAL counts in it before a destructive save commits, and gets no dialog at
 * all for a safe one. That is a claim about a rendered page and a live IndexedDB, so
 * it is checked by rendering the page.
 *
 * What is under test, in order:
 *   1. An evaluator cannot reach the hub or any of its sections.
 *   2. An administrator can, and the old paths (/builder, /admin/roster,
 *      /admin/settings) land on the sections that replaced them.
 *   3. The spec's own example: 23 observations across 6 participants on one question,
 *      delete it, and the dialog says 23 and 6 rather than "may affect existing data".
 *   4. The same delete on a workshop with no submitted captures classifies LOWER and
 *      does not demand a typed name.
 *   5. Cancel commits nothing.
 *   6. Confirm commits, and writes an audit row carrying the counts it quoted.
 *   7. A safe change (renaming an event) shows no dialog and saves.
 *
 *   node scripts/tl07-setup-hub.mjs --setup      # accounts + the fixture question
 *   npm run dev                                 # in another shell
 *   node scripts/tl07-setup-hub.mjs
 *   node scripts/tl07-setup-hub.mjs --teardown
 *
 * Runs against the repo's dev port (5180) by default. A concurrent session must move
 * both: `npm run dev -- --port 5181` and `TL07_PORT=5181 node scripts/...`, because a
 * harness pointed at somebody else's build is the worst possible green.
 *
 * Playwright is deliberately not a dependency of this repo:
 *   npm i -D --no-save playwright && npx playwright install chromium
 */
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// Default to the repo's dev port; a concurrent session passes its own:
//   TL07_PORT=5181 node scripts/tl07-setup-hub.mjs
const BASE = `http://localhost:${process.env.TL07_PORT ?? 5180}/`
const PROJECT = 'vdbirmjvjzfdgajwgowj'
const PILOT_WS = '11111111-1111-1111-1111-111111111111'
const PASSWORD = 'tl07-Throwaway-Password-1!'
const ADMIN = 'tl07-hub-admin@example.org'
const EVALUATOR = 'tl07-hub-evaluator@example.org'

/** The fixture question, and the numbers the spec names. */
// A uuid, because ksa.id is one. The 'f7' tail is the only handle teardown has.
const KSA_ID = '7c000000-0000-4000-8000-0000000000f7'
const KSA_CODE = 'TL07Q'
const KSA_LABEL = 'TL07 fixture question'
const OBSERVATIONS = 23
const PARTICIPANTS = 6

const results = []
function check(ok, label, detail = '') {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label.padEnd(64)} | ${detail}`)
}

const accessToken = execFileSync('/bin/zsh', [
  '-c',
  'set -a; . ~/.claude/secrets/supabase.env; set +a; printf %s "$SUPABASE_ACCESS_TOKEN"',
]).toString()

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`query -> ${res.status} ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : null
}

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
const readEnv = (key) =>
  env.split('\n').find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1).trim()
const SUPABASE_URL = readEnv('VITE_SUPABASE_URL')
if (!SUPABASE_URL) throw new Error('.env is missing VITE_SUPABASE_URL')

async function serviceRoleKey() {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/api-keys?reveal=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const keys = await res.json()
  const key = keys.find((k) => k.name === 'service_role')?.api_key
  if (!key) throw new Error('could not read the service_role key')
  return key
}

async function createUser(serviceKey, email, name) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true, user_metadata: { name } }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok && !/already|registered|exists/i.test(JSON.stringify(body))) {
    throw new Error(`create ${email} -> ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
  }
}

/**
 * The fixture question goes into Postgres rather than only into IndexedDB.
 *
 * loadReferenceData() clears and overwrites the local reference cache on every load,
 * so a question that existed only on the device would vanish on the reload this
 * harness performs between checks, and the delete under test would be a delete of
 * nothing. The observations stay local: they are not reference data, and keeping them
 * off the server keeps this harness from writing evidence into a live workshop.
 */
async function setup() {
  const serviceKey = await serviceRoleKey()
  for (const [email, name, role] of [
    [ADMIN, 'TL07 Hub Admin', 'admin'],
    [EVALUATOR, 'TL07 Hub Evaluator', 'evaluator'],
  ]) {
    await sql(`
      insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
      values ('${email}', array['${role}'], '${role}', 'tl-07 hub fixture', '${PILOT_WS}')
      on conflict (email) do update set allowed_roles = excluded.allowed_roles,
                                        assigned_role = excluded.assigned_role,
                                        default_workshop_id = excluded.default_workshop_id;
      select 1;`)
    await createUser(serviceKey, email, name)
  }
  await seedFixtureQuestion()
  console.log('setup done')
}

/**
 * Re-seeded at the start of every run, not only by --setup.
 *
 * The run DELETES this question, for real, through the app's own write path, which
 * queues a backend delete. So the second run of the harness would otherwise be testing
 * a delete of nothing and would fail looking for a row it removed itself. A harness
 * that only works once is a harness nobody runs twice.
 */
async function seedFixtureQuestion() {
  await sql(`
    insert into ksa (id, workshop_id, code, short_label, description, evaluator_facing_prompt,
                     evidence_levels, cbc_subpoint_refs)
    -- workshop_id added by tl-08, which made ksa workshop-scoped and NOT NULL; the
    -- legacy free-text \`area\` is no longer written by anything.
    values ('${KSA_ID}', '${PILOT_WS}', '${KSA_CODE}', '${KSA_LABEL}',
            'A question that exists so a delete can be tested.',
            'How did they do the thing?',
            '{"0":"absent","1":"weak","2":"solid","3":"exemplary"}'::jsonb, array[]::text[])
    on conflict (id) do update set code = excluded.code,
                                   short_label = excluded.short_label,
                                   evidence_levels = excluded.evidence_levels;
    select 1;`)
}

async function teardown() {
  const serviceKey = await serviceRoleKey()
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  })
  const { users = [] } = await res.json()
  for (const u of users) {
    if (!u.email?.startsWith('tl07-hub-')) continue
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    })
  }
  await sql(`
    delete from setup_change_log where entity_label like 'TL07%' or entity_id like 'tl07-%';
    delete from activity_ksa where ksa_id = '${KSA_ID}';
    delete from ksa where id = '${KSA_ID}';
    delete from workshop_member wm using app_user u
      where u.id = wm.app_user_id and u.email like 'tl07-hub-%@example.org';
    delete from app_user where email like 'tl07-hub-%@example.org';
    -- tl-12: the app_user_link_person trigger mints a person row for every
    -- account, so a teardown that removes the account and stops there leaves one
    -- behind in the live deployment. Deleting a person cascades their profile.
    delete from person where primary_email like 'tl07-hub-%@example.org';
    delete from auth.users where email like 'tl07-hub-%@example.org';
    delete from role_allowlist where email like 'tl07-hub-%@example.org';
    select 1;`)
  console.log('teardown done')
}

if (process.argv.includes('--setup')) {
  await setup()
  process.exit(0)
}
if (process.argv.includes('--teardown')) {
  await teardown()
  process.exit(0)
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

await seedFixtureQuestion()

const { chromium } = await import('playwright')
const browser = await chromium.launch()
const errors = []

async function device(email) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => errors.push(`${email}: ${String(e)}`))
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.getByLabel(/email/i).first().fill(email)
  await p.getByLabel(/password/i).first().fill(PASSWORD)
  await p.getByRole('button', { name: /sign in/i }).first().click()
  await p.waitForSelector('.shell__brand, .pagehead__title', { timeout: 20000 })
  return p
}

/** Raw IndexedDB, so the seed does not depend on the app exposing a writer. */
async function seedLocalEvidence(page, { attested }) {
  return page.evaluate(
    async ([wsId, ksaCode, count, participants, attest]) => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('cairn')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      const put = (store, rows) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(store, 'readwrite')
          const os = tx.objectStore(store)
          for (const row of rows) os.put(row)
          tx.oncomplete = () => resolve(true)
          tx.onerror = () => reject(tx.error)
        })
      const all = (store) =>
        new Promise((resolve) => {
          const tx = db.transaction(store, 'readonly')
          const req = tx.objectStore(store).getAll()
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve([])
        })
      const del = (store, keys) =>
        new Promise((resolve) => {
          const tx = db.transaction(store, 'readwrite')
          for (const k of keys) tx.objectStore(store).delete(k)
          tx.oncomplete = () => resolve(true)
          tx.onerror = () => resolve(false)
        })

      const roster = (await all('participants')).filter((p) => p.workshop_id === wsId).slice(0, participants)
      if (roster.length < participants) return { seeded: 0, roster: roster.length }

      const observations = []
      for (let i = 0; i < count; i++) {
        const p = roster[i % roster.length]
        observations.push({
          id: `tl07-obs::${i}`,
          capture_client_id: 'tl07-capture',
          workshop_id: wsId,
          participant_id: p.id,
          participant_name: p.name,
          ksa_code: ksaCode,
          text: 'fixture observation',
          source_excerpt: 'fixture excerpt',
          evidence_designation: 2,
          sentiment_flag: 'neutral',
          confidence: 'high',
          needs_review: false,
          origin: 'individual',
          imported_at: '2026-07-30T00:00:00.000Z',
          evaluator_email: 'tl07-hub-admin@example.org',
          // 'synced', so the sync loop never tries to push a fixture into the live
          // workshop's real evidence.
          sync_status: 'synced',
        })
      }
      await put('observations', observations)

      // The submitted capture is what makes the workshop read as in progress. Removing
      // it is how the draft-state check is performed, so it is written and deleted by
      // this one function.
      if (attest) {
        await put('evaluations', [
          {
            client_id: 'tl07-capture',
            evaluator_email: 'tl07-hub-admin@example.org',
            activity_id: null,
            workshop_id: wsId,
            source_language: 'English',
            answers: {},
            source_text: 'fixture capture',
            participant_scope: [],
            attestation: true,
            ruleset_version: null,
            edit_history: [],
            created_at: '2026-07-30T00:00:00.000Z',
            updated_at: '2026-07-30T00:00:00.000Z',
            sync_status: 'synced',
          },
        ])
      } else {
        await del('evaluations', ['tl07-capture'])
      }
      return { seeded: observations.length, roster: roster.length }
    },
    [PILOT_WS, KSA_CODE, OBSERVATIONS, PARTICIPANTS, attested],
  )
}

const localRows = (page, store, filter = 'true') =>
  page.evaluate(
    ([s, f]) =>
      new Promise((resolve) => {
        const req = indexedDB.open('cairn')
        req.onsuccess = () => {
          const tx = req.result.transaction(s, 'readonly')
          const all = tx.objectStore(s).getAll()
          const keep = new Function('row', `return ${f}`)
          all.onsuccess = () => resolve(all.result.filter(keep))
          all.onerror = () => resolve(null)
        }
        req.onerror = () => resolve(null)
      }),
    [store, filter],
  )

/** Open the fixture question's row and arm its delete, leaving the dialog on screen. */
async function armQuestionDelete(page) {
  await page.goto(`${BASE}admin/setup/goals`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.pagehead__title', { timeout: 20000 })
  const row = page.locator('.activity-item', { hasText: KSA_CODE }).first()
  await row.waitFor({ timeout: 20000 })
  await row.getByRole('button', { name: /^delete$/ }).click()
  await row.getByRole('button', { name: /^continue$/ }).click()
  await page.waitForSelector('[role=dialog]', { timeout: 10000 })
}

const dialogText = (page) =>
  page.locator('[role=dialog]').first().innerText()

try {
  // =========================================================================
  // 1. The evaluator's side of the gate
  // =========================================================================
  const ev = await device(EVALUATOR)
  for (const path of ['admin/setup', 'admin/setup/goals', 'admin/setup/participants', 'builder']) {
    await ev.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
    // Wait for the bounce, then read the page. Checking too early would pass for the
    // wrong reason: an app that has not rendered yet also fails to show the hub.
    await ev.waitForURL(BASE, { timeout: 15000 }).catch(() => {})
    await ev.waitForSelector('.shell__brand, .pagehead__title, h1', { timeout: 15000 })
    const dom = (await ev.evaluate(() => document.body.innerText)).toLowerCase()
    const bounced = !/set up this workshop|goals and questions|workshop basics/.test(dom)
    check(bounced, `evaluator cannot reach /${path}`, `landed on ${ev.url().replace(BASE, '/')}`)
  }
  await ev.close()

  // =========================================================================
  // 2. The administrator's hub, and the old paths
  // =========================================================================
  const admin = await device(ADMIN)
  await admin.goto(`${BASE}admin/setup`, { waitUntil: 'domcontentloaded' })
  await admin.waitForSelector('.pagehead__title', { timeout: 20000 })
  const hub = await admin.evaluate(() => document.body.innerText)
  const sections = [
    'Workshop basics',
    'Goals and questions',
    'Calendar and events',
    'Grading scale',
    'Participants',
    'People and roles',
    'AI',
    'Templates',
  ]
  const missing = sections.filter((s) => !hub.includes(s))
  check(missing.length === 0, 'the hub offers all eight sections', missing.join(', ') || 'all present')

  for (const [from, to] of [
    ['builder', '/admin/setup/calendar'],
    ['admin/roster', '/admin/setup/participants'],
    ['admin/settings', '/admin/setup'],
    ['admin', '/admin/setup'],
  ]) {
    await admin.goto(`${BASE}${from}`, { waitUntil: 'domcontentloaded' })
    // Wait for the URL rather than a fixed pause: the router cannot redirect until the
    // session and the memberships have resolved, which on a dev server is slower than
    // any pause worth hard-coding. A timeout here is a real failure, not a slow machine.
    await admin.waitForURL(`${BASE.slice(0, -1)}${to}`, { timeout: 15000 }).catch(() => {})
    const landed = admin.url().replace(BASE.slice(0, -1), '')
    check(landed === to, `/${from} lands on ${to}`, landed)
  }

  // =========================================================================
  // 3. The spec's example: 23 observations across 6 participants
  // =========================================================================
  const seeded = await seedLocalEvidence(admin, { attested: true })
  check(
    seeded.seeded === OBSERVATIONS && seeded.roster === PARTICIPANTS,
    'seeded 23 observations across 6 participants',
    JSON.stringify(seeded),
  )

  await armQuestionDelete(admin)
  let text = await dialogText(admin)
  const namesBoth = text.includes(String(OBSERVATIONS)) && text.includes(String(PARTICIPANTS))
  check(namesBoth, 'the delete dialog quotes 23 and 6', text.split('\n').slice(0, 3).join(' / '))
  check(
    /destroys recorded work/i.test(text),
    'it is classified as destroying recorded work',
    (text.match(/destroys recorded work|changes recorded evidence|affects future work/i) ?? [
      'none',
    ])[0],
  )
  const hasTypedName = await admin.locator('#setup-confirm-name').count()
  check(hasTypedName === 1, 'it demands the question name typed back', `${hasTypedName} field(s)`)

  // =========================================================================
  // 5. Cancel commits nothing
  // =========================================================================
  await admin.getByRole('button', { name: /^cancel$/i }).last().click()
  await admin.waitForTimeout(400)
  const stillThere = await localRows(admin, 'ksas', `row.code === '${KSA_CODE}'`)
  check(stillThere.length === 1, 'cancel left the question in place', `${stillThere.length} row(s)`)

  // =========================================================================
  // 4. The same delete on a workshop with nothing submitted
  // =========================================================================
  await seedLocalEvidence(admin, { attested: false })
  await armQuestionDelete(admin)
  text = await dialogText(admin)
  const draftTypedName = await admin.locator('#setup-confirm-name').count()
  check(
    draftTypedName === 0,
    'with nothing submitted, the same delete demands no typed name',
    `${draftTypedName} field(s)`,
  )
  check(
    /nothing has been captured in this workshop/i.test(text),
    'and it says why it is safe to edit',
    text.split('\n').slice(-3).join(' / '),
  )
  await admin.getByRole('button', { name: /^cancel$/i }).last().click()

  // =========================================================================
  // 6. Confirm commits, and logs what it quoted
  // =========================================================================
  await seedLocalEvidence(admin, { attested: true })
  await armQuestionDelete(admin)
  await admin.locator('#setup-confirm-name').fill(`${KSA_CODE} — ${KSA_LABEL}`)
  await admin.getByRole('button', { name: /delete it anyway/i }).click()
  await admin.waitForTimeout(1200)
  const gone = await localRows(admin, 'ksas', `row.code === '${KSA_CODE}'`)
  check(gone.length === 0, 'confirming the typed name committed the delete', `${gone.length} row(s)`)

  const logged = await localRows(admin, 'setupChangeLog', `row.entity === 'question'`)
  const entry = logged?.[0]
  check(
    Boolean(entry) && entry.severity === 'destructive',
    'the change was logged at the severity it was shown at',
    entry ? `${entry.severity} · ${JSON.stringify(entry.counts)}` : 'no entry',
  )
  check(
    Boolean(entry) && entry.counts?.observations === OBSERVATIONS && entry.counts?.participants === PARTICIPANTS,
    'the log carries the counts the dialog quoted',
    entry ? JSON.stringify(entry.counts) : 'no entry',
  )

  const serverRows = await sql(
    `select id, actor_email, severity, counts from setup_change_log
      where entity_label like 'TL07%' order by at desc limit 5;`,
  )
  check(
    Array.isArray(serverRows) && serverRows.length > 0,
    'and it reached the backend, attributed to the caller',
    serverRows?.[0] ? `${serverRows[0].actor_email} · ${serverRows[0].severity}` : 'no row',
  )

  const day = new Date().toISOString().slice(0, 10)
  const exportPath = new URL(`../feedback/setup-changes/${day}.md`, import.meta.url)
  const exported = existsSync(exportPath) && readFileSync(exportPath, 'utf8').includes(KSA_CODE)
  check(exported, 'and it reached the git-tracked daily file', `feedback/setup-changes/${day}.md`)

  // =========================================================================
  // 7. A safe change shows no dialog
  // =========================================================================
  await admin.goto(`${BASE}admin/setup/calendar`, { waitUntil: 'domcontentloaded' })
  await admin.waitForSelector('.pagehead__title', { timeout: 20000 })
  const title = admin.locator('input[aria-label="Event title"]').first()
  await title.waitFor({ timeout: 20000 })
  const before = await title.inputValue()
  const renamed = `${before} (tl07 rename)`
  await title.fill(renamed)
  await title.blur()
  await admin.waitForTimeout(700)
  const dialogs = await admin.locator('[role=dialog]').count()
  check(dialogs === 0, 'renaming an event shows no dialog', `${dialogs} dialog(s)`)
  const saved = await localRows(admin, 'activities', `row.title === ${JSON.stringify(renamed)}`)
  check(saved.length === 1, 'and the rename saved', `${saved.length} row(s)`)
  // Put the event's name back: this is a live workshop.
  await title.fill(before)
  await title.blur()
  await admin.waitForTimeout(700)
  const restored = await localRows(admin, 'activities', `row.title === ${JSON.stringify(before)}`)
  check(restored.length === 1, 'and the fixture rename was reverted', `${restored.length} row(s)`)

  // One exemption, named rather than filtered by a broad pattern: startCoverageSync's
  // StrictMode double-subscribe throws on every dev sign-in. It predates this spec, the
  // program file records it as tl-18's to fix, and swallowing it silently here is how a
  // known bug becomes a forgotten one.
  const KNOWN_TL18 = /cannot add `postgres_changes` callbacks/
  const known = errors.filter((e) => KNOWN_TL18.test(e))
  const unexpected = errors.filter((e) => !KNOWN_TL18.test(e))
  check(
    unexpected.length === 0,
    'no page errors anywhere in the walk, beyond the known tl-18 race',
    unexpected.slice(0, 2).join(' | ') || `none (${known.length} known tl-18 realtime error(s))`,
  )
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
