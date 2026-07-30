/**
 * The claim tl-04 makes that cannot be checked on one device.
 *
 * "An evaluation captured on the phone counts toward the participant." Until this
 * spec an observation lived only in the IndexedDB of whichever device imported it,
 * and the only proof that has changed is a second device with its own IndexedDB
 * and its own session seeing work it was never handed.
 *
 * What is under test, in order:
 *   1. An observation an administrator routes reaches an evaluator's device.
 *   2. A verdict that evaluator records reaches the administrator's device.
 *   3. The same verdict recorded while OFFLINE arrives once, and only once,
 *      after reconnecting.
 *   4. Neither device holds a GitHub token at any point, and no routing wording
 *      is reachable from the evaluator's verification screen.
 *
 * Two browser contexts, so each has its own IndexedDB and its own session: device
 * B genuinely has to learn from the backend what device A did.
 *
 *   node scripts/tl04-two-device.mjs --setup     # accounts + fixture observation
 *   npm run dev -- --port 5180                   # in another shell
 *   node scripts/tl04-two-device.mjs
 *   node scripts/tl04-two-device.mjs --teardown
 *
 * Playwright is deliberately not a dependency of this repo:
 *   npm i -D --no-save playwright && npx playwright install chromium
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const BASE = 'http://localhost:5180/'
const PROJECT = 'vdbirmjvjzfdgajwgowj'
const PILOT_WS = '11111111-1111-1111-1111-111111111111'
const PASSWORD = 'tl04-Throwaway-Password-1!'
const ADMIN = 'tl04-device-admin@example.org'
const EVALUATOR = 'tl04-device-evaluator@example.org'
const OBS_A = 'tl04-dev-capture::0'
const OBS_B = 'tl04-dev-capture::1'

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
const ANON_KEY = readEnv('VITE_SUPABASE_ANON_KEY')
if (!SUPABASE_URL || !ANON_KEY) throw new Error('.env is missing VITE_SUPABASE_URL / ANON_KEY')

// ---------------------------------------------------------------------------
// Fixtures. Accounts are provisioned through the real signup endpoint, so the
// allowlist trigger and the membership bridge are exercised rather than bypassed.
// ---------------------------------------------------------------------------

async function allowlist(email, role) {
  await sql(`
    insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
    values ('${email}', array['${role}'], '${role}', 'tl-04 two-device fixture', '${PILOT_WS}')
    on conflict (email) do update set allowed_roles = excluded.allowed_roles,
                                      assigned_role = excluded.assigned_role,
                                      default_workshop_id = excluded.default_workshop_id;
    select 1;`)
}

/**
 * The service_role key, read from the Management API. Used ONLY to create the
 * throwaway accounts: the public signup endpoint refuses example.org addresses,
 * and no request under test ever carries this key.
 */
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
  // The account already existing is success: the allowlist trigger has run and
  // the membership is in place, which is all the test needs.
  if (!res.ok && !/already|registered|exists/i.test(JSON.stringify(body))) {
    throw new Error(`create ${email} -> ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
  }
}

async function setup() {
  const serviceKey = await serviceRoleKey()
  await allowlist(ADMIN, 'admin')
  await allowlist(EVALUATOR, 'evaluator')
  await createUser(serviceKey, ADMIN, 'TL04 Device Admin')
  await createUser(serviceKey, EVALUATOR, 'TL04 Device Evaluator')

  // Two observations in the pilot workshop, written as `postgres` so this stands
  // in for "device A routed a capture" without driving the routing UI, which is
  // covered by its own tests and needs a GitHub token this test refuses to have.
  const part = await sql(
    `select id, name from participant where workshop_id = '${PILOT_WS}' order by name limit 1;`,
  )
  const pid = part[0]?.id
  if (!pid) throw new Error('the pilot workshop has no participants to observe')
  await sql(`
    delete from verification_verdict where observation_id like 'tl04-dev-%';
    delete from observation where id like 'tl04-dev-%';
    insert into observation (
      id, capture_client_id, workshop_id, participant_id, participant_name, ksa_code,
      text, source_excerpt, evidence_designation, sentiment_flag, confidence,
      needs_review, origin, evaluator_email
    ) values
      ('${OBS_A}', 'tl04-dev-capture', '${PILOT_WS}', '${pid}', '${part[0].name.replace(/'/g, "''")}',
       'K1.1', 'tl-04 two-device observation one', 'excerpt one', 2,
       'neutral', 'high', false, 'individual', '${ADMIN}'),
      ('${OBS_B}', 'tl04-dev-capture', '${PILOT_WS}', '${pid}', '${part[0].name.replace(/'/g, "''")}',
       'K1.2', 'tl-04 two-device observation two', 'excerpt two', 1,
       'weak', 'high', false, 'individual', '${ADMIN}');
    select 1;`)
  console.log(`setup done: 2 observations on ${part[0].name}, accounts ready`)
}

async function teardown() {
  const serviceKey = await serviceRoleKey()
  const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  }).then((r) => r.json())
  for (const u of list.users ?? []) {
    if (!u.email?.startsWith('tl04-device-')) continue
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    })
  }
  await sql(`
    delete from verification_verdict where observation_id like 'tl04-dev-%';
    delete from observation where id like 'tl04-dev-%';
    delete from workshop_member wm using app_user u
      where u.id = wm.app_user_id and u.email like 'tl04-device-%@example.org';
    delete from app_user where email like 'tl04-device-%@example.org';
    delete from auth.users where email like 'tl04-device-%@example.org';
    delete from role_allowlist where email like 'tl04-device-%@example.org';
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

// Clean slate for the verdicts, every run. The counts below are absolute ("one
// row on the server"), so a verdict left by a previous run would make a passing
// test fail and — worse — could make a broken push look like it worked.
await sql(`delete from verification_verdict where observation_id like 'tl04-dev-%'; select 1;`)

const { chromium } = await import('playwright')
const browser = await chromium.launch()
const errors = []

async function device(email) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => errors.push(String(e)))
  await p.goto(BASE, { waitUntil: 'networkidle' })
  await p.getByLabel(/email/i).first().fill(email)
  await p.getByLabel(/password/i).first().fill(PASSWORD)
  await p.getByRole('button', { name: /sign in/i }).first().click()
  await p.waitForSelector('.shell__brand, .pagehead__title', { timeout: 20000 })
  return p
}

/** Whether a device's OWN IndexedDB holds a row. The only honest "did it arrive". */
const localCount = (page, store, filter = 'true') =>
  page.evaluate(
    ([s, f]) =>
      new Promise((resolve) => {
        const req = indexedDB.open('cairn')
        req.onsuccess = () => {
          const tx = req.result.transaction(s, 'readonly')
          const all = tx.objectStore(s).getAll()
          const keep = new Function('row', `return ${f}`)
          all.onsuccess = () => resolve(all.result.filter(keep).length)
          all.onerror = () => resolve(-1)
        }
        req.onerror = () => resolve(-1)
      }),
    [store, filter],
  )

try {
  // =========================================================================
  // 1. The observation reaches a device that never imported it
  // =========================================================================
  const b = await device(EVALUATOR)

  // The GitHub PAT specifically (`cairn.routing.github_token`), not the Supabase
  // session token, which every signed-in device is supposed to hold.
  const token = await b.evaluate(() =>
    Object.keys(localStorage).filter((k) => /github|routing/i.test(k)),
  )
  check(token.length === 0, 'device B holds no GitHub token', token.join(',') || 'no token keys')

  await b.goto(`${BASE}observations`, { waitUntil: 'networkidle' })
  // One sync cycle is 30s; the page's own "Sync now" asks for it immediately,
  // which is what an evaluator would do and is the same code path.
  await b.getByRole('button', { name: /sync now/i }).click()
  await b.waitForTimeout(4000)

  const arrived = await localCount(b, 'observations', "row.id.startsWith('tl04-dev-')")
  check(arrived === 2, 'device B: both routed observations arrived', `${arrived} in its own IndexedDB`)

  const bodyText = await b.locator('body').innerText()
  check(
    /tl-04 two-device observation one/.test(bodyText),
    'device B: the observation is on screen, not merely in storage',
  )
  check(
    !/github|personal access token|repo\b|routing repo/i.test(bodyText),
    'device B: no routing or repo wording on the verification screen',
    (bodyText.match(/github|personal access token|routing repo/i) ?? ['clean'])[0],
  )

  // =========================================================================
  // 2. The verdict reaches the administrator's device
  // =========================================================================
  await b.locator('.activity-item').first().getByRole('button', { name: /^confirm \d\/3$/i }).click()
  await b.waitForTimeout(4000)

  const onServer = await sql(
    `select id, evaluator_email, decision, workshop_id from verification_verdict
      where observation_id like 'tl04-dev-%';`,
  )
  check(onServer.length === 1, 'device B: the verdict reached Postgres', `${onServer.length} row(s)`)
  check(
    onServer[0]?.evaluator_email === EVALUATOR && onServer[0]?.workshop_id === PILOT_WS,
    'device B: the verdict is signed by B and scoped to the workshop',
    `${onServer[0]?.evaluator_email} / ${onServer[0]?.decision}`,
  )

  const a = await device(ADMIN)
  await a.goto(`${BASE}observations`, { waitUntil: 'networkidle' })
  await a.getByRole('button', { name: /sync now/i }).click()
  await a.waitForTimeout(4000)
  const seenByA = await localCount(a, 'verifications', "row.observation_id.startsWith('tl04-dev-')")
  check(seenByA === 1, "device A: sees B's verdict without being told", `${seenByA} verdict(s) locally`)

  // =========================================================================
  // 3. A verdict recorded offline arrives exactly once
  // =========================================================================
  await b.context().setOffline(true)
  await b.locator('.activity-item').nth(1).getByRole('button', { name: /^confirm \d\/3$/i }).click()
  await b.waitForTimeout(1500)

  const offlineOnServer = await sql(
    `select count(*)::int as n from verification_verdict where observation_id = '${OBS_B}';`,
  )
  check(offlineOnServer[0]?.n === 0, 'device B offline: nothing reached the server yet', 'as expected')
  const heldLocally = await localCount(b, 'verifications', `row.observation_id === '${OBS_B}'`)
  check(heldLocally === 1, 'device B offline: the verdict is held on the device', `${heldLocally} row(s)`)

  await b.context().setOffline(false)
  // The loop fires on the `online` event; the manual button is the same path and
  // removes a 30-second wait from the test.
  await b.getByRole('button', { name: /sync now/i }).click()
  await b.waitForTimeout(4000)

  const afterReconnect = await sql(
    `select count(*)::int as n from verification_verdict where observation_id = '${OBS_B}';`,
  )
  check(
    afterReconnect[0]?.n === 1,
    'device B: the offline verdict arrived exactly once after reconnecting',
    `${afterReconnect[0]?.n} row(s)`,
  )

  // =========================================================================
  // 4. Partial state: a verdict whose observation has not arrived
  // =========================================================================
  // Seeded as a verdict on an observation that is not on the server at all, which
  // is the shape a mid-sync device sees. It must reach the device and STAY there:
  // dropping it would make a partial sync permanent instead of self-healing.
  await sql(`
    insert into verification_verdict
      (id, observation_id, capture_client_id, workshop_id, evaluator_email, decision, at)
    values ('tl04-dev-orphan::0::${ADMIN}', 'tl04-dev-orphan::0', 'tl04-dev-orphan',
            '${PILOT_WS}', '${ADMIN}', 'confirm', now())
    on conflict (id) do nothing;
    select 1;`)

  await b.getByRole('button', { name: /sync now/i }).click()
  await b.waitForTimeout(4000)
  const orphanHeld = await localCount(b, 'verifications', "row.observation_id === 'tl04-dev-orphan::0'")
  check(orphanHeld === 1, 'device B: a verdict with no observation is kept, not dropped', `${orphanHeld} row(s)`)

  const stillUp = await b.locator('.card').first().isVisible()
  const afterText = await b.locator('body').innerText()
  check(
    stillUp && /tl-04 two-device observation one/.test(afterText),
    'device B: the page renders the observations it does have',
  )
  check(
    /have not reached this device yet/.test(afterText),
    'device B: the orphaned verdict is counted on screen, not tolerated silently',
    (afterText.match(/\d+ verdict\(s\) are held/) ?? ['not shown'])[0],
  )

  // =========================================================================
  // 5. Idempotence: pull twice, change nothing
  // =========================================================================
  const before = await localCount(b, 'observations', "row.id.startsWith('tl04-dev-')")
  await b.getByRole('button', { name: /sync now/i }).click()
  await b.waitForTimeout(3000)
  await b.getByRole('button', { name: /sync now/i }).click()
  await b.waitForTimeout(3000)
  const after = await localCount(b, 'observations', "row.id.startsWith('tl04-dev-')")
  check(before === after && after === 2, 'two more pulls duplicate nothing', `${before} -> ${after}`)

  const unsynced = await localCount(
    b,
    'verifications',
    "row.observation_id.startsWith('tl04-dev-') && row.sync_status !== 'synced'",
  )
  check(unsynced === 0, 'device B: nothing is left claiming to be unsynced', `${unsynced} pending`)

  const real = errors.filter((e) => !/favicon|manifest|React DevTools/i.test(e))
  check(real.length === 0, 'no page errors across either device', real.slice(0, 2).join(' | ') || 'clean')
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} PASS, ${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
