/**
 * tl-03's acceptance, which cannot be checked from a module.
 *
 * The spec's requirement is not "hide the nav link" — it is that NOTHING an
 * evaluator can reach mentions a repository, a token, an inbox, an outbox, or
 * Claude. That is a claim about rendered pages, so it is checked by rendering
 * every page an evaluator can reach (including by typing the URL) and grepping
 * the DOM. Eyeballing the source cannot prove it and a unit test cannot either;
 * the chrome.json half of the audit lives in test/routingAdminOnly.test.ts and
 * this is the other half.
 *
 * What is under test, in order:
 *   1. Every route an evaluator can reach renders no forbidden word, in text or
 *      in a data-* attribute.
 *   2. /routing and /admin/routing both send an evaluator home.
 *   3. A routing token found on an evaluator's device is cleared on sign-in.
 *   4. An administrator pulls a capture submitted from ANOTHER device, with its
 *      full source_text, and can route it. (The addendum's recovery path.)
 *   5. A capture whose observations already exist is marked done rather than
 *      offered for routing a second time.
 *   6. An administrator's own token survives.
 *   7. The manual copy/paste fallback is still there for an admin with no token.
 *
 *   node scripts/tl03-evaluator-surface.mjs --setup     # accounts + fixtures
 *   npm run dev -- --port 5180                          # in another shell
 *   node scripts/tl03-evaluator-surface.mjs
 *   node scripts/tl03-evaluator-surface.mjs --teardown
 *
 * Playwright is deliberately not a dependency of this repo:
 *   npm i -D --no-save playwright && npx playwright install chromium
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const BASE = 'http://localhost:5180/'
const PROJECT = 'vdbirmjvjzfdgajwgowj'
const PILOT_WS = '11111111-1111-1111-1111-111111111111'
const PASSWORD = 'tl03-Throwaway-Password-1!'
const ADMIN = 'tl03-surface-admin@example.org'
const EVALUATOR = 'tl03-surface-evaluator@example.org'
const OTHER = 'tl03-surface-other@example.org'

/** A capture "submitted from another phone" that has never been routed. */
const CAP_UNROUTED = 'tl03-cap-unrouted'
/** One that was routed on a different device: its observations already exist. */
const CAP_ROUTED = 'tl03-cap-routed'
const CAP_TEXT = 'Grace read the psalm aloud twice before drafting, unprompted.'

/**
 * The words the spec names, case-insensitive and on word boundaries.
 *
 * The boundaries are load-bearing, not tidiness: a bare `repo` substring matches
 * every occurrence of "report", and this app is full of reports. A grep that
 * cannot pass even on a correct build teaches nothing.
 */
const FORBIDDEN = [
  /\bgithub\b/,
  /\btokens?\b/,
  /\brepos?\b/,
  /\brepositor(y|ies)\b/,
  /\brouting\b/,
  /\binbox(es)?\b/,
  /\boutbox(es)?\b/,
  /\bclaude\b/,
]

/** Which forbidden words a rendered page contains. */
const hitsIn = (html) => FORBIDDEN.filter((re) => re.test(html)).map((re) => String(re))

const results = []
function check(ok, label, detail = '') {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label.padEnd(66)} | ${detail}`)
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function allowlist(email, role) {
  await sql(`
    insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
    values ('${email}', array['${role}'], '${role}', 'tl-03 surface fixture', '${PILOT_WS}')
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
 * Two submitted captures written as `postgres`, standing in for two phones that
 * synced their evaluations and never routed them. This is the stranded work the
 * addendum is about: it is on the server, it belongs to somebody else, and the
 * administrator's device has never seen it.
 */
async function seedCaptures() {
  const part = await sql(
    `select id, name from participant where workshop_id = '${PILOT_WS}' order by name limit 1;`,
  )
  const p = part[0]
  if (!p) throw new Error('the pilot workshop has no participants')
  const act = await sql(
    `select id from activity where workshop_id = '${PILOT_WS}' order by sort_order limit 1;`,
  )
  const scope = JSON.stringify([{ name: p.name, participant_id: p.id }]).replace(/'/g, "''")
  await sql(`
    delete from observation where capture_client_id like 'tl03-cap-%';
    delete from evaluation where client_id like 'tl03-cap-%';
    insert into evaluation (
      client_id, evaluator_email, activity_id, workshop_id, source_language, answers,
      source_text, participant_scope, attestation, ruleset_version, edit_history
    ) values
      ('${CAP_UNROUTED}', '${OTHER}', ${act[0] ? `'${act[0].id}'` : 'null'}, '${PILOT_WS}', 'en',
       '{}'::jsonb, '${CAP_TEXT.replace(/'/g, "''")}', '${scope}'::jsonb, true, 'v1', '[]'::jsonb),
      ('${CAP_ROUTED}', '${OTHER}', ${act[0] ? `'${act[0].id}'` : 'null'}, '${PILOT_WS}', 'en',
       '{}'::jsonb, 'Already routed on another device.', '${scope}'::jsonb, true, 'v1', '[]'::jsonb);
    insert into observation (
      id, capture_client_id, workshop_id, participant_id, participant_name, ksa_code,
      text, source_excerpt, evidence_designation, sentiment_flag, confidence,
      needs_review, origin, evaluator_email
    ) values
      ('${CAP_ROUTED}::0', '${CAP_ROUTED}', '${PILOT_WS}', '${p.id}',
       '${p.name.replace(/'/g, "''")}', 'K1.1', 'tl-03 already-routed observation',
       'excerpt', 2, 'neutral', 'high', false, 'individual', '${OTHER}');
    select 1;`)
  return p
}

async function setup() {
  const serviceKey = await serviceRoleKey()
  await allowlist(ADMIN, 'admin')
  await allowlist(EVALUATOR, 'evaluator')
  await allowlist(OTHER, 'evaluator')
  await createUser(serviceKey, ADMIN, 'TL03 Surface Admin')
  await createUser(serviceKey, EVALUATOR, 'TL03 Surface Evaluator')
  await createUser(serviceKey, OTHER, 'TL03 Other Evaluator')
  const p = await seedCaptures()
  console.log(`setup done: 2 captures on ${p.name} (one already routed), accounts ready`)
}

async function teardown() {
  const serviceKey = await serviceRoleKey()
  const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  }).then((r) => r.json())
  for (const u of list.users ?? []) {
    if (!u.email?.startsWith('tl03-surface-')) continue
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    })
  }
  await sql(`
    delete from verification_verdict where capture_client_id like 'tl03-cap-%';
    delete from observation where capture_client_id like 'tl03-cap-%';
    delete from evaluation where client_id like 'tl03-cap-%';
    delete from workshop_member wm using app_user u
      where u.id = wm.app_user_id and u.email like 'tl03-surface-%@example.org';
    delete from app_user where email like 'tl03-surface-%@example.org';
    delete from auth.users where email like 'tl03-surface-%@example.org';
    delete from role_allowlist where email like 'tl03-surface-%@example.org';
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

// Re-seed every run. The counts below are absolute, and a capture left marked
// routed by a previous run would make a broken pull look like it worked.
await seedCaptures()

const { chromium } = await import('playwright')
const browser = await chromium.launch()
const errors = []

async function device(email, { seedToken = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => errors.push(`${email}: ${String(e)}`))
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  if (seedToken) {
    // A credential left behind by the months when /routing was reachable by every
    // signed-in user. Planted BEFORE sign-in, which is when the rule fires.
    await p.evaluate(() =>
      localStorage.setItem('cairn.routing.github_token', 'github_pat_leftover_from_the_old_days'),
    )
    await p.reload({ waitUntil: 'domcontentloaded' })
  }
  await p.getByLabel(/email/i).first().fill(email)
  await p.getByLabel(/password/i).first().fill(PASSWORD)
  await p.getByRole('button', { name: /sign in/i }).first().click()
  await p.waitForSelector('.shell__brand, .pagehead__title', { timeout: 20000 })
  return p
}

/** Everything the DOM says, text and attributes alike, lowercased. */
const domOf = (page) => page.evaluate(() => document.body.innerHTML.toLowerCase())

const tokenKeys = (page) =>
  page.evaluate(() => Object.keys(localStorage).filter((k) => /github_token/i.test(k)))

/** Whether this device's own IndexedDB holds a row. */
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

try {
  // =========================================================================
  // 1-3. The evaluator's whole surface
  // =========================================================================
  const ev = await device(EVALUATOR, { seedToken: true })

  // Token hygiene first: the rule fires on sign-in, so by the time the shell is
  // up the token must already be gone.
  const left = await tokenKeys(ev)
  check(left.length === 0, 'evaluator sign-in cleared the leftover routing token', left.join(',') || 'none')

  // Every route an evaluator can reach, plus every one they might type. The
  // gated ones are here on purpose: a redirect that renders the page for one
  // frame before bouncing would still have leaked it.
  const OPEN = ['', 'evaluations', 'conversations', 'observations', 'reports']
  const GATED = [
    'routing',
    'admin/routing',
    'admin/roster',
    'admin/records',
    'admin/settings',
    'admin/data',
    'admin/overview',
    'admin/progress',
    'admin/workshop',
    'admin/events',
    'admin/participants',
    'admin/evaluators',
    'admin/assignments',
    'builder',
    'inbox',
    'outgoing',
    'day-email',
    'export',
  ]

  const dirty = []
  for (const route of [...OPEN, ...GATED]) {
    await ev.goto(BASE + route, { waitUntil: 'networkidle' })
    const html = await domOf(ev)
    const hits = hitsIn(html)
    if (hits.length) dirty.push(`/${route}: ${hits.join(',')}`)
  }

  // The capture screen too, reached the way an evaluator reaches it.
  await ev.goto(BASE, { waitUntil: 'networkidle' })
  const activity = ev.locator('button.activity-item').first()
  if (await activity.count()) {
    await activity.click()
    await ev.waitForURL(/\/capture\//, { timeout: 15000 })
    const html = await domOf(ev)
    const hits = hitsIn(html)
    if (hits.length) dirty.push(`/capture: ${hits.join(',')}`)
  } else {
    dirty.push('/capture: could not be reached (no activity to start)')
  }

  check(dirty.length === 0, 'no forbidden word on any route an evaluator can reach', dirty.join(' | ') || `${OPEN.length + GATED.length + 1} routes clean`)

  // The drawer is the other way in, and it is built from the same nav tree.
  await ev.goto(BASE, { waitUntil: 'networkidle' })
  await ev.locator('.shell__menu-btn').first().click()
  const drawer = (await ev.locator('.shell').first().innerHTML()).toLowerCase()
  const drawerHits = hitsIn(drawer)
  check(drawerHits.length === 0, 'the nav drawer offers an evaluator no routing entry', drawerHits.join(',') || 'clean')

  for (const path of ['routing', 'admin/routing']) {
    await ev.goto(BASE + path, { waitUntil: 'networkidle' })
    const where = new URL(ev.url()).pathname
    check(where === '/', `typing /${path} as an evaluator lands home`, where)
  }

  // =========================================================================
  // 4-7. The administrator's side
  // =========================================================================
  const admin = await device(ADMIN, { seedToken: true })

  const adminToken = await tokenKeys(admin)
  check(adminToken.length === 1, 'an administrator keeps their routing token', adminToken.join(',') || 'CLEARED')

  await admin.goto(`${BASE}admin/routing`, { waitUntil: 'networkidle' })
  check(
    new URL(admin.url()).pathname === '/admin/routing',
    'an administrator reaches /admin/routing',
    new URL(admin.url()).pathname,
  )

  // The recovery claim. The pull runs on mount; give it a beat and then ask this
  // device's own IndexedDB, which is the only honest "did it arrive".
  await admin.waitForTimeout(3000)
  const pulled = await localRows(admin, 'evaluations', `row.client_id === '${CAP_UNROUTED}'`)
  check(
    Array.isArray(pulled) && pulled.length === 1,
    'a capture submitted on another device reached the admin',
    Array.isArray(pulled) ? `${pulled.length} row(s)` : 'IndexedDB unreadable',
  )
  check(
    pulled?.[0]?.source_text === CAP_TEXT,
    'it arrived with its full source_text, not just metadata',
    JSON.stringify(pulled?.[0]?.source_text ?? null).slice(0, 80),
  )

  const already = await localRows(admin, 'evaluations', `row.client_id === '${CAP_ROUTED}'`)
  check(
    already?.[0]?.routing_status === 'routed',
    'a capture routed elsewhere is marked done, not offered again',
    String(already?.[0]?.routing_status),
  )

  const routingHtml = await domOf(admin)
  check(
    routingHtml.includes('how captures are processed'),
    'the single routing mode is stated rather than chosen',
    routingHtml.includes('how captures are processed') ? 'mode card present' : 'missing',
  )
  check(
    routingHtml.includes('copy pending captures') && routingHtml.includes('import observations'),
    'the manual copy/paste fallback survives for an admin',
    'both controls present',
  )

  // The queue itself: the unrouted capture is offered, the routed one is not.
  const queueText = await admin.locator('body').innerText()
  const m = /(\d+)\s+captures?\s+pending/i.exec(queueText)
  check(m !== null && Number(m[1]) >= 1, 'the admin queue offers the unrouted capture', m?.[0] ?? 'no count rendered')

  // One known pre-existing error is excluded, and named rather than filtered
  // quietly. `startCoverageSync` subscribes after two awaits without re-checking
  // its `cancelled` flag, so React StrictMode's double-invoke can leave a
  // subscribed coverage channel behind and the second attempt throws. It
  // reproduces on main at the same rate, it costs a live-coverage subscription in
  // dev, and it belongs to tl-18 (sync health), not here. Anything else is a
  // regression this spec introduced.
  const KNOWN = /postgres_changes.*realtime:coverage/
  const unexpected = errors.filter((e) => !KNOWN.test(e))
  check(unexpected.length === 0, 'no page errors beyond the known coverage-channel race', unexpected.slice(0, 2).join(' | ') || `${errors.length} known, 0 new`)
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} PASS, ${failed} FAIL`)
process.exitCode = failed === 0 ? 0 : 1
