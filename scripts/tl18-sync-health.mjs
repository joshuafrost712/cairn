/**
 * tl-18's acceptance, the parts that only a running browser can answer.
 *
 * Three claims are checked here because none of them can be proved from a
 * module. That the funnel's rendered numbers equal what the database actually
 * holds — a gauge whose arithmetic is right in a unit test and wrong on screen
 * is still a gauge that lies. That an evaluator typing the URL cannot reach it.
 * And that a row the backend refused surfaces its message verbatim instead of
 * being quietly counted as sent.
 *
 * The fourth claim, the stranded-build banner, needs a bundle with no backend
 * compiled into it, so it runs against a second dev server (see --local-only).
 *
 *   node scripts/tl18-sync-health.mjs --setup     # accounts + fixtures
 *   npm run dev -- --port 5180                    # in another shell
 *   node scripts/tl18-sync-health.mjs
 *   node scripts/tl18-sync-health.mjs --teardown
 *
 * And for the banner, with .env moved aside so the build has no backend:
 *   mv .env .env.off && npx vite --port 5181 ; mv .env.off .env
 *   node scripts/tl18-sync-health.mjs --local-only
 *
 * Playwright is deliberately not a dependency of this repo:
 *   npm i -D --no-save playwright && npx playwright install chromium
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const BASE = 'http://localhost:5180/'
const LOCAL_ONLY_BASE = 'http://localhost:5181/'
const PROJECT = 'vdbirmjvjzfdgajwgowj'
const PILOT_WS = '11111111-1111-1111-1111-111111111111'
const PASSWORD = 'tl18-Throwaway-Password-1!'
const ADMIN = 'tl18-health-admin@example.org'
const EVALUATOR = 'tl18-health-evaluator@example.org'
const OTHER = 'tl18-health-other@example.org'

/** Two captures nobody has processed, one processed but unconfirmed, one counting. */
const CAP_UNROUTED_A = 'tl18-cap-unrouted-a'
const CAP_UNROUTED_B = 'tl18-cap-unrouted-b'
const CAP_UNVERIFIED = 'tl18-cap-unverified'
const CAP_COUNTING = 'tl18-cap-counting'

const results = []
function check(ok, label, detail) {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

// Same source as apply-migration.mjs and tl03: never inline, never committed.
const accessToken = execFileSync('/bin/zsh', [
  '-c',
  'set -a; . ~/.claude/secrets/supabase.env; set +a; printf %s "$SUPABASE_ACCESS_TOKEN"',
]).toString()
if (!accessToken) throw new Error('no SUPABASE_ACCESS_TOKEN in ~/.claude/secrets/supabase.env')

/** Run SQL as `postgres` through the management API, same as apply-migration.mjs. */
async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`sql failed: ${res.status} ${JSON.stringify(body).slice(0, 400)}`)
  return body
}

/**
 * Read lazily, because --local-only runs with `.env` deliberately moved aside:
 * that IS the condition under test, and a module-level read would make the one
 * mode that needs no backend the only mode that cannot start without one.
 */
function supabaseUrl() {
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  const url = env.split('\n').find((l) => l.startsWith('VITE_SUPABASE_URL='))?.slice(18).trim()
  if (!url) throw new Error('.env is missing VITE_SUPABASE_URL')
  return url
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function allowlist(email, role) {
  await sql(`
    insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
    values ('${email}', array['${role}'], '${role}', 'tl-18 health fixture', '${PILOT_WS}')
    on conflict (email) do update set allowed_roles = excluded.allowed_roles,
                                      assigned_role = excluded.assigned_role,
                                      default_workshop_id = excluded.default_workshop_id;
    select 1;`)
}

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
  const res = await fetch(`${supabaseUrl()}/auth/v1/admin/users`, {
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
 * One capture at each of the three server-visible stages, written as `postgres`.
 *
 * Deliberately attributed to somebody else: the page's whole job is to show an
 * administrator other people's stuck work, so fixtures owned by the signed-in
 * account would test the one case that was never broken.
 */
async function seedFixtures() {
  const [p] = await sql(
    `select id, name from participant where workshop_id = '${PILOT_WS}' order by name limit 1;`,
  )
  if (!p) throw new Error('the pilot workshop has no participants')
  const [act] = await sql(
    `select id from activity where workshop_id = '${PILOT_WS}' order by sort_order limit 1;`,
  )
  const scope = JSON.stringify([{ name: p.name, participant_id: p.id }]).replace(/'/g, "''")
  const actId = act ? `'${act.id}'` : 'null'
  const capture = (id, text) =>
    `('${id}', '${OTHER}', ${actId}, '${PILOT_WS}', 'en', '{}'::jsonb,
      '${text}', '${scope}'::jsonb, true, 'v1', '[]'::jsonb)`
  await sql(`
    delete from verification_verdict where capture_client_id like 'tl18-%';
    delete from observation where capture_client_id like 'tl18-%';
    delete from evaluation where client_id like 'tl18-%';
    insert into evaluation (
      client_id, evaluator_email, activity_id, workshop_id, source_language, answers,
      source_text, participant_scope, attestation, ruleset_version, edit_history
    ) values
      ${capture(CAP_UNROUTED_A, 'Submitted and never processed, one.')},
      ${capture(CAP_UNROUTED_B, 'Submitted and never processed, two.')},
      ${capture(CAP_UNVERIFIED, 'Processed but nobody has confirmed it.')},
      ${capture(CAP_COUNTING, 'Processed and confirmed by two evaluators.')};
    insert into observation (
      id, capture_client_id, workshop_id, participant_id, participant_name, ksa_code,
      text, source_excerpt, evidence_designation, sentiment_flag, confidence,
      needs_review, origin, evaluator_email
    ) values
      ('${CAP_UNVERIFIED}::0', '${CAP_UNVERIFIED}', '${PILOT_WS}', '${p.id}',
       '${p.name.replace(/'/g, "''")}', 'K1.1', 'awaiting confirmation', 'excerpt', 2,
       'neutral', 'high', false, 'individual', '${OTHER}'),
      ('${CAP_COUNTING}::0', '${CAP_COUNTING}', '${PILOT_WS}', '${p.id}',
       '${p.name.replace(/'/g, "''")}', 'K1.1', 'confirmed twice', 'excerpt', 2,
       'neutral', 'high', false, 'individual', '${OTHER}');
    insert into verification_verdict (
      id, observation_id, capture_client_id, workshop_id, evaluator_email, decision, at
    ) values
      ('${CAP_COUNTING}::0::${ADMIN}', '${CAP_COUNTING}::0', '${CAP_COUNTING}',
       '${PILOT_WS}', '${ADMIN}', 'confirm', now()),
      ('${CAP_COUNTING}::0::${OTHER}', '${CAP_COUNTING}::0', '${CAP_COUNTING}',
       '${PILOT_WS}', '${OTHER}', 'confirm', now());
    select 1;`)
  return p
}

/**
 * What the page SHOULD show, computed from the database rather than hard-coded.
 *
 * The pilot workshop holds Joshua's real pilot history alongside these fixtures,
 * and hard-coded expectations would either ignore it or rot the moment the
 * recovery runs. Asking the database the same question the funnel asks is also a
 * stronger test: two independent implementations of the same rule have to agree.
 */
async function expectedCounts(threshold = 2) {
  const [row] = await sql(`
    with submitted as (
      select client_id from evaluation
       where workshop_id = '${PILOT_WS}' and attestation
    ),
    obs as (
      select o.capture_client_id, o.id,
             count(*) filter (where v.decision in ('confirm','adjust')) as confirms,
             count(*) filter (where v.decision = 'reject')              as rejects
        from observation o
        left join verification_verdict v on v.observation_id = o.id
       where o.workshop_id = '${PILOT_WS}'
       group by o.capture_client_id, o.id
    ),
    per_capture as (
      select s.client_id,
             count(obs.id)                                                      as n_obs,
             count(obs.id) filter (where obs.rejects = 0
                                     and obs.confirms >= ${threshold})          as n_counting
        from submitted s
        left join obs on obs.capture_client_id = s.client_id
       group by s.client_id
    )
    select
      count(*) filter (where n_obs = 0)                          as unrouted,
      count(*) filter (where n_obs > 0 and n_counting < n_obs)   as unverified,
      count(*) filter (where n_obs > 0 and n_counting = n_obs)   as counting
    from per_capture;`)
  return { unrouted: Number(row.unrouted), unverified: Number(row.unverified), counting: Number(row.counting) }
}

async function setup() {
  const serviceKey = await serviceRoleKey()
  await allowlist(ADMIN, 'admin')
  await allowlist(EVALUATOR, 'evaluator')
  await allowlist(OTHER, 'evaluator')
  await createUser(serviceKey, ADMIN, 'TL18 Health Admin')
  await createUser(serviceKey, EVALUATOR, 'TL18 Health Evaluator')
  await createUser(serviceKey, OTHER, 'TL18 Other Evaluator')
  const p = await seedFixtures()
  console.log(`setup done: 4 captures on ${p.name} across three stages, accounts ready`)
}

async function teardown() {
  const serviceKey = await serviceRoleKey()
  const list = await fetch(`${supabaseUrl()}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  }).then((r) => r.json())
  for (const u of list.users ?? []) {
    if (!u.email?.startsWith('tl18-health-') && !u.email?.startsWith('tl18-other')) continue
    await fetch(`${supabaseUrl()}/auth/v1/admin/users/${u.id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    })
  }
  await sql(`
    delete from verification_verdict where capture_client_id like 'tl18-%';
    delete from observation where capture_client_id like 'tl18-%';
    -- 'tl18-%', not 'tl18-cap-%': the refusal fixture is planted in the browser
    -- as 'tl18-refused', and an earlier revision of it could reach the server.
    delete from evaluation where client_id like 'tl18-%';
    -- And by author: walking the app as a test account auto-creates unattested
    -- drafts with random uuids, which no prefix match can reach. See the same
    -- clause in tl03-evaluator-surface.mjs.
    delete from evaluation where evaluator_email like 'tl18-%@example.org';
    delete from workshop_member wm using app_user u
      where u.id = wm.app_user_id and u.email like 'tl18-%@example.org';
    delete from app_user where email like 'tl18-%@example.org';
    -- tl-12: the app_user_link_person trigger mints a person row for every
    -- account, so a teardown that removes the account and stops there leaves one
    -- behind in the live deployment. Deleting a person cascades their profile.
    delete from person where primary_email like 'tl18-%@example.org';
    delete from auth.users where email like 'tl18-%@example.org';
    delete from role_allowlist where email like 'tl18-%@example.org';
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

const { chromium } = await import('playwright')

// ---------------------------------------------------------------------------
// --local-only: the stranded-build banner, against a bundle with no backend.
// ---------------------------------------------------------------------------
if (process.argv.includes('--local-only')) {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const page = await ctx.newPage()
  // '/signin', not the root: since tl-19 a signed-out visitor at '/' is sent to
  // the public landing page, so the form is one navigation further in.
  await page.goto(LOCAL_ONLY_BASE + 'signin', { waitUntil: 'domcontentloaded' })

  // Sign in locally — with no backend the app has no other mode — then plant one
  // evaluation the device can never send. That pairing is the whole failure:
  // finished work plus a build with nowhere to put it.
  await page.getByLabel(/your name/i).first().fill('TL18 Local')
  await page.getByLabel(/email/i).first().fill('tl18-local@example.org')
  await page.getByRole('button', { name: /continue/i }).first().click()
  await page.waitForSelector('.shell__brand, .pagehead__title, h1', { timeout: 20000 })

  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('cairn')
        req.onsuccess = () => {
          const tx = req.result.transaction('evaluations', 'readwrite')
          tx.objectStore('evaluations').put({
            client_id: 'tl18-local-only',
            evaluator_email: 'local@example.org',
            activity_id: null,
            workshop_id: null,
            source_language: 'en',
            answers: {},
            quick_ratings: {},
            source_text: 'recorded on a build that cannot send',
            participant_scope: [],
            attestation: true,
            ruleset_version: 'v1',
            edit_history: [],
            created_at: new Date(Date.now() - 4 * 86400000).toISOString(),
            updated_at: new Date(Date.now() - 4 * 86400000).toISOString(),
            sync_status: 'local',
            sync_error: null,
          })
          tx.oncomplete = () => resolve(true)
        }
        req.onerror = () => resolve(false)
      }),
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  const text = await page.locator('body').innerText()
  check(/cannot send your work/i.test(text), 'a build with no backend says so, loudly', text.slice(0, 120).replace(/\n/g, ' '))
  check(/not sent yet/i.test(text), 'the count of unsent work is stated', /(\d+) not sent yet[^.\n]*/i.exec(text)?.[0] ?? 'absent')
  check(/oldest 4 days/i.test(text), 'the age of the oldest unsent item is stated', /oldest [^.\n]*/i.exec(text)?.[0] ?? 'absent')
  check(!/local-only/i.test(text), 'the old muted "local-only" wording is gone', 'no muted wording')

  await browser.close()
  const failed = results.filter((r) => !r).length
  console.log(`\n${results.length - failed}/${results.length} PASS, ${failed} FAIL`)
  process.exit(failed === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------
// The main run
// ---------------------------------------------------------------------------

// Re-seed every run. The counts are read from the database immediately after, so
// a fixture left behind by a previous run would be counted on both sides and the
// comparison would still be honest — but the stage mix would not be what the
// labels below claim.
await seedFixtures()
const expected = await expectedCounts()

const browser = await chromium.launch()
const errors = []

async function device(email) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => errors.push(`${email}: ${String(e)}`))
  // '/signin', not the root: since tl-19 a signed-out visitor at '/' is sent to
  // the public landing page, so the form is one navigation further in.
  await p.goto(BASE + 'signin', { waitUntil: 'domcontentloaded' })
  await p.getByLabel(/email/i).first().fill(email)
  await p.getByLabel(/password/i).first().fill(PASSWORD)
  await p.getByRole('button', { name: /sign in/i }).first().click()
  await p.waitForSelector('.shell__brand, .pagehead__title', { timeout: 20000 })
  return p
}

/** The number rendered on the tile whose label is `label`. */
const tile = (page, label) =>
  page.evaluate((l) => {
    const node = [...document.querySelectorAll('.tile')].find((t) =>
      t.querySelector('.tile__label')?.textContent?.trim().toLowerCase() === l.toLowerCase(),
    )
    const raw = node?.querySelector('.tile__value')?.textContent?.trim()
    return raw === undefined ? null : raw
  }, label)

try {
  // =========================================================================
  // 1. An evaluator cannot reach it, even by typing the URL.
  // =========================================================================
  const ev = await device(EVALUATOR)
  await ev.goto(`${BASE}admin/sync-health`, { waitUntil: 'domcontentloaded' })
  await ev.waitForTimeout(1200)
  const evUrl = new URL(ev.url()).pathname
  const evText = await ev.locator('body').innerText()
  check(!evUrl.endsWith('/admin/sync-health'), 'an evaluator typing the URL is bounced', evUrl)
  check(!/sync health/i.test(evText), 'no part of the page rendered on the way past', evText.slice(0, 80).replace(/\n/g, ' '))

  const evNav = await ev.evaluate(() => document.body.innerHTML.toLowerCase())
  check(!evNav.includes('sync-health'), 'the nav offers no link to it', 'no sync-health in the DOM')

  // =========================================================================
  // 2. An administrator sees numbers that match the database.
  // =========================================================================
  const admin = await device(ADMIN)
  await admin.goto(`${BASE}admin/sync-health`, { waitUntil: 'domcontentloaded' })
  await admin.waitForSelector('.pagehead__title', { timeout: 20000 })
  // The page pulls all three tables on mount; give the round trip room.
  await admin.waitForTimeout(4000)

  check(
    new URL(admin.url()).pathname.endsWith('/admin/sync-health'),
    'an administrator reaches the page',
    new URL(admin.url()).pathname,
  )

  const unrouted = await tile(admin, 'Sent, not processed')
  const unverified = await tile(admin, 'Processed, not confirmed')
  const counting = await tile(admin, 'Counting')
  check(
    Number(unrouted) === expected.unrouted,
    'the unprocessed count matches the database',
    `page ${unrouted}, database ${expected.unrouted}`,
  )
  check(
    Number(unverified) === expected.unverified,
    'the unconfirmed count matches the database',
    `page ${unverified}, database ${expected.unverified}`,
  )
  check(
    Number(counting) === expected.counting,
    'the counting figure matches the database',
    `page ${counting}, database ${expected.counting}`,
  )

  const adminText = await admin.locator('body').innerText()
  check(
    adminText.includes(CAP_UNROUTED_A) === false && /submitted but never processed/i.test(adminText),
    'the exceptions are listed by evaluator, not by capture id',
    'exception section present',
  )
  check(
    /never sent it/i.test(adminText),
    'the page states the one thing it cannot see',
    /[^.]*never sent it[^.]*\./i.exec(adminText)?.[0]?.slice(0, 90) ?? 'absent',
  )

  // =========================================================================
  // 3. A row the backend refuses shows what the backend said, verbatim.
  //
  // Planted as 'local' with an activity_id that does not exist, rather than
  // planted as already-errored. A pre-set error would have been repaired by the
  // very next sync cycle — correctly, since the app's job is to keep retrying —
  // and the test would have measured nothing. This row provokes a REAL refusal
  // from Postgres, so the message on screen is the database's own words.
  // =========================================================================
  await admin.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('cairn')
        req.onsuccess = () => {
          const tx = req.result.transaction('evaluations', 'readwrite')
          tx.objectStore('evaluations').put({
            client_id: 'tl18-refused',
            evaluator_email: 'tl18-health-other@example.org',
            activity_id: '00000000-0000-4000-8000-0000000000ff', // no such activity
            workshop_id: '11111111-1111-1111-1111-111111111111',
            source_language: 'en',
            answers: {},
            quick_ratings: {},
            source_text: 'a row the backend refuses',
            participant_scope: [],
            attestation: true,
            ruleset_version: 'v1',
            edit_history: [],
            created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
            updated_at: new Date(Date.now() - 2 * 86400000).toISOString(),
            sync_status: 'local',
            sync_error: null,
          })
          tx.oncomplete = () => resolve(true)
        }
        req.onerror = () => resolve(false)
      }),
  )
  // Reload so the sync loop picks it up: Dexie's live queries observe writes made
  // THROUGH Dexie, and this one was planted with the raw IndexedDB API.
  await admin.reload({ waitUntil: 'domcontentloaded' })
  await admin.waitForSelector('.pagehead__title', { timeout: 20000 })
  await admin.waitForTimeout(6000)
  const withError = await admin.locator('body').innerText()
  check(
    /violates foreign key constraint/i.test(withError),
    "a refused row shows the database's own message rather than a generic failure",
    /[^\n]*violates foreign key[^\n]*/i.exec(withError)?.[0]?.slice(0, 90) ?? 'absent',
  )
  check(
    /refused by the shared database\s*\(1\)/i.test(withError),
    'and is counted as an exception rather than as sent',
    /refused by the shared database[^\n]*/i.exec(withError)?.[0] ?? 'absent',
  )
  check(
    Number(await tile(admin, 'Not sent')) === 1,
    'a refused row counts as not sent, never as delivered',
    `tile ${await tile(admin, 'Not sent')}`,
  )

  // =========================================================================
  // 4. Start fresh on this device.
  //
  // Last, because it empties the device the checks above were reading. Its
  // promise has two halves and both need proving: the evidence goes, and
  // everything needed to keep capturing stays. A "clear" that took the roster
  // with it would leave a phone that cannot be used until somebody reinstalls.
  // =========================================================================
  await admin.goto(`${BASE}admin/data`, { waitUntil: 'domcontentloaded' })
  await admin.waitForSelector('.pagehead__title', { timeout: 20000 })
  await admin.waitForTimeout(1500)
  const before = await admin.locator('.pagehead__meta').innerText()
  const heldBefore = Number(/(\d+) captures/.exec(before)?.[1] ?? 0)
  check(heldBefore > 0, 'the device is holding evidence before the clear', before.trim())

  await admin.getByRole('button', { name: /^start fresh on this device$/i }).first().click()
  await admin.getByRole('textbox').last().fill('start fresh')
  await admin.getByRole('button', { name: /remove this device's evidence/i }).first().click()
  await admin.waitForTimeout(2000)

  const after = await admin.locator('body').innerText()
  check(
    new RegExp(`Removed from this device: ${heldBefore} capture`).test(after),
    'it reports exactly what it removed',
    /Removed from this device[^\n]*/.exec(after)?.[0]?.slice(0, 90) ?? 'absent',
  )
  const meta = await admin.locator('.pagehead__meta').innerText()
  check(/0 captures/.test(meta), 'the device holds no captures afterwards', meta.trim())
  check(
    !/0 participants/.test(meta),
    'and the roster survived, so the device can still be used to capture',
    meta.trim(),
  )

  // =========================================================================
  // 5. The coverage-channel race, whose exclusion tl-18 removed from tl-03.
  // =========================================================================
  check(
    errors.length === 0,
    'no page errors, including the coverage-channel race tl-03 had to exclude',
    errors.slice(0, 2).join(' | ') || 'clean',
  )
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} PASS, ${failed} FAIL`)
process.exitCode = failed === 0 ? 0 : 1
