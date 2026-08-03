/**
 * tl-06's acceptance, which cannot be checked from a module.
 *
 * The unit tests prove the rules and scripts/tl06-rls-tests.sql proves the
 * database enforces them. Neither can prove what Joshua actually asked for: that
 * an evaluator handed a hard conversation opens the app and finds the evidence
 * that called for it, the guidance for approaching it, and somewhere to say how it
 * went. That is three signed-in devices and two round trips, so it is here.
 *
 * What is under test, in order:
 *   1. The admin's queue derives four conversations and hands two to B, one to C.
 *   2. B sees exactly two. C sees exactly one, and B's is not merely hidden on
 *      C's device — it is not in C's IndexedDB, because the server never sent it.
 *   3. B's evidence panel carries the observation's own words, its excerpt, the
 *      question's short label and evaluator-facing prompt, and the activity title.
 *      The activity is the interesting one: an ObservationRecord has no activity,
 *      so the admin's device resolves it from the capture and the assignee
 *      receives it through the sync.
 *   4. An observation the gate adjusted shows the ADJUSTED value as effective and
 *      names the original as adjusted-from, never silently the raw number.
 *   5. An observation with no evaluator_email says "recorded by another
 *      evaluator" rather than rendering an empty byline.
 *   6. B logs an outcome with the follow-up flag; it reaches the backend and the
 *      admin finds it under the follow-up view with the note attached.
 *   7. Guidance revised after B looked is marked as changed on B's next visit.
 *   8. A conversation whose triggering observation is not on B's device shows the
 *      explicit still-arriving state rather than a blank panel or a crash.
 *   9. The evaluator's page offers no Reconcile and no Dismiss. Both were there
 *      before this spec and both are decisions that belong to the admin.
 *
 *   node scripts/tl06-evaluator-conversations.mjs --setup
 *   npm run dev -- --port 5186                          # in another shell
 *   node scripts/tl06-evaluator-conversations.mjs
 *   node scripts/tl06-evaluator-conversations.mjs --teardown
 *
 * Port 5186 (override with TL06_PORT), not the default 5180: a harness left on the
 * shared port drives another session's build and passes, which is the worst
 * possible green. tl-17 made this a parameter after tl-03's was hard-coded.
 *
 * Playwright is deliberately not a dependency of this repo:
 *   npm i -D --no-save playwright && npx playwright install chromium
 *
 * If the Management API calls fail with UND_ERR_CONNECT_TIMEOUT while curl to the
 * same host works, node is trying the AAAA record first; run it as
 * `node --dns-result-order=ipv4first scripts/tl06-evaluator-conversations.mjs`.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const PORT = process.env.TL06_PORT ?? '5186'
const BASE = `http://localhost:${PORT}/`
const PROJECT = 'vdbirmjvjzfdgajwgowj'
const PILOT_WS = '11111111-1111-1111-1111-111111111111'
const PASSWORD = 'tl06-Throwaway-Password-1!'
const PREFIX = 'tl06-ui-'
const ADMIN = `${PREFIX}admin@example.org`
const B = `${PREFIX}b@example.org`
const C = `${PREFIX}c@example.org`
const CAPTURER = `${PREFIX}capturer@example.org`

const GUIDANCE = 'Open with the two things that improved before you name the gap.'
const REVISED = 'She has heard this from two people already; be shorter than you want to be.'
const OBS_TEXT = 'Read the genre cue as a list where the source has a chiasm.'
const EXCERPT = 'he said the four lines were "just repeating the same idea"'
const SUMMARY = 'Walked through the four lines and where the turn is.'
const RESPONSE = 'Defensive at first, then asked two good questions about the drafting step.'
const NOTE = 'Wants to talk again after the next session. I would not close this yet.'

const results = []
function check(ok, label, detail = '') {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label.padEnd(74)} | ${detail}`)
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

async function serviceRoleKey() {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/api-keys?reveal=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const keys = await res.json()
  const key = keys.find((k) => k.name === 'service_role')?.api_key
  if (!key) throw new Error('could not read the service_role key')
  return key
}

async function allowlist(email, role) {
  await sql(`
    insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
    values ('${email}', array['${role}'], '${role}', 'tl-06 walkthrough fixture', '${PILOT_WS}')
    on conflict (email) do update set allowed_roles = excluded.allowed_roles,
                                      assigned_role = excluded.assigned_role,
                                      default_workshop_id = excluded.default_workshop_id;
    select 1;`)
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

const q = (s) => String(s).replace(/'/g, "''")

/**
 * Three confirmed-low observations plus a submitted capture behind each, and one
 * extra observation on the same participant and question so the pattern half of
 * the panel has something real to show.
 *
 * The captures are the point of the `evaluation` rows: `pullCoverage` reads every
 * submitted evaluation in the workshop into the coverage cache, which is how the
 * ADMIN's device learns which activity each capture belonged to and therefore how
 * `deriveNeededConversations` fills `trigger_activity_id`. Seeding the conversation
 * rows by hand would skip exactly the path this spec added.
 *
 * Observation 1 is a straight confirmed 1. Observation 2 is a 2 that both
 * verifiers ADJUSTED down to 1, so it triggers and its panel must show 1 as
 * effective with "adjusted from 2" beside it. Observation 3 has no
 * evaluator_email, so its byline must fall back rather than render blank.
 */
async function seedEvidence() {
  // Four participants, one conversation each, and that is a correctness
  // requirement rather than tidiness. The first version of this harness put two of
  // the conversations on the same participant, and every step that reaches a row
  // by clicking its name then acted on whichever of the two the table happened to
  // surface: the guidance landed on the wrong conversation, the orphan was
  // reassigned to C, and four checks failed for reasons that had nothing to do
  // with the code under test. A fixture whose rows are not distinguishable by the
  // thing the harness clicks is a harness that reports someone else's answer.
  const parts = await sql(
    `select id, name from participant where workshop_id = '${PILOT_WS}' order by name limit 4;`,
  )
  if (parts.length < 4) throw new Error('the pilot workshop needs at least four participants')
  const acts = await sql(
    `select id, title from activity where workshop_id = '${PILOT_WS}' order by sort_order limit 1;`,
  )
  if (acts.length < 1) throw new Error('the pilot workshop needs at least one activity')
  const ksas = await sql(
    `select code, short_label from ksa where workshop_id = '${PILOT_WS}' order by code limit 2;`,
  )
  if (ksas.length < 2) throw new Error('the pilot workshop needs at least two questions')

  const [p1, p2, p3, p4] = parts
  const act = acts[0]
  const [k1, k2] = ksas

  // Four conversations: three derived from real evidence, plus one written
  // straight to the backend whose trigger observation does not exist. That last
  // one is check 8 — the partial-sync state. It is simulated rather than raced,
  // because the race is a one-cycle window and a harness that waits for it is a
  // harness that fails intermittently for the wrong reason.
  await sql(`
    delete from mentoring_conversation where id like 'mc::${PREFIX}%' or id like '${PREFIX}%';
    delete from verification_verdict where capture_client_id like '${PREFIX}cap-%';
    delete from observation where capture_client_id like '${PREFIX}cap-%';
    delete from evaluation where client_id like '${PREFIX}cap-%';

    insert into evaluation (
      client_id, evaluator_email, activity_id, workshop_id, source_language, answers,
      source_text, participant_scope, attestation, ruleset_version, edit_history
    ) values
      ('${PREFIX}cap-1', '${CAPTURER}', '${act.id}', '${PILOT_WS}', 'en', '{}'::jsonb,
       'tl-06 fixture capture one', '[]'::jsonb, true, 'v1', '[]'::jsonb),
      ('${PREFIX}cap-2', '${CAPTURER}', '${act.id}', '${PILOT_WS}', 'en', '{}'::jsonb,
       'tl-06 fixture capture two', '[]'::jsonb, true, 'v1', '[]'::jsonb),
      ('${PREFIX}cap-3', '${CAPTURER}', '${act.id}', '${PILOT_WS}', 'en', '{}'::jsonb,
       'tl-06 fixture capture three', '[]'::jsonb, true, 'v1', '[]'::jsonb);

    insert into observation (
      id, capture_client_id, workshop_id, participant_id, participant_name, ksa_code,
      text, source_excerpt, evidence_designation, sentiment_flag, confidence,
      needs_review, origin, evaluator_email
    ) values
      -- 1. a straight confirmed 1, assigned to B
      ('${PREFIX}obs-1::0', '${PREFIX}cap-1', '${PILOT_WS}', '${p1.id}', '${q(p1.name)}',
       '${k1.code}', '${q(OBS_TEXT)}', '${q(EXCERPT)}', 1, 'weak', 'high', false,
       'individual', '${CAPTURER}'),
      -- the pattern beside it: same person, same question, a 2 that stands
      ('${PREFIX}obs-1::1', '${PREFIX}cap-1', '${PILOT_WS}', '${p1.id}', '${q(p1.name)}',
       '${k1.code}', 'Handled the same cue well two days earlier.', 'the second time he named the turn',
       2, 'neutral', 'high', false, 'individual', '${CAPTURER}'),
      -- 2. a 2 adjusted down to 1 by both verifiers, assigned to B
      ('${PREFIX}obs-2::0', '${PREFIX}cap-2', '${PILOT_WS}', '${p3.id}', '${q(p3.name)}',
       '${k2.code}', 'Audience check was done but not acted on.', 'moved on after the first comment',
       2, 'neutral', 'high', false, 'individual', '${CAPTURER}'),
      -- 3. no evaluator_email at all, assigned to C
      ('${PREFIX}obs-3::0', '${PREFIX}cap-3', '${PILOT_WS}', '${p2.id}', '${q(p2.name)}',
       '${k1.code}', 'Skipped the genre cue entirely.', 'read it as prose', 1,
       'weak', 'high', false, 'individual', null);

    insert into verification_verdict (
      id, observation_id, capture_client_id, workshop_id, evaluator_email, decision,
      adjusted_designation, at
    ) values
      ('${PREFIX}obs-1::0::v1', '${PREFIX}obs-1::0', '${PREFIX}cap-1', '${PILOT_WS}',
       '${PREFIX}v1@example.org', 'confirm', null, now()),
      ('${PREFIX}obs-1::0::v2', '${PREFIX}obs-1::0', '${PREFIX}cap-1', '${PILOT_WS}',
       '${PREFIX}v2@example.org', 'confirm', null, now()),
      ('${PREFIX}obs-1::1::v1', '${PREFIX}obs-1::1', '${PREFIX}cap-1', '${PILOT_WS}',
       '${PREFIX}v1@example.org', 'confirm', null, now()),
      ('${PREFIX}obs-1::1::v2', '${PREFIX}obs-1::1', '${PREFIX}cap-1', '${PILOT_WS}',
       '${PREFIX}v2@example.org', 'confirm', null, now()),
      ('${PREFIX}obs-2::0::v1', '${PREFIX}obs-2::0', '${PREFIX}cap-2', '${PILOT_WS}',
       '${PREFIX}v1@example.org', 'adjust', 1, now()),
      ('${PREFIX}obs-2::0::v2', '${PREFIX}obs-2::0', '${PREFIX}cap-2', '${PILOT_WS}',
       '${PREFIX}v2@example.org', 'adjust', 1, now()),
      ('${PREFIX}obs-3::0::v1', '${PREFIX}obs-3::0', '${PREFIX}cap-3', '${PILOT_WS}',
       '${PREFIX}v1@example.org', 'confirm', null, now()),
      ('${PREFIX}obs-3::0::v2', '${PREFIX}obs-3::0', '${PREFIX}cap-3', '${PILOT_WS}',
       '${PREFIX}v2@example.org', 'confirm', null, now());

    -- Check 8's row: assigned to B, triggered by an observation that does not exist.
    insert into mentoring_conversation (
      id, participant_id, participant_name, workshop_id, trigger_observation_id,
      trigger_ksa_code, trigger_designation, status, assigned_to, assigned_by, assigned_at
    ) values (
      '${PREFIX}orphan', '${p4.id}', '${q(p4.name)}', '${PILOT_WS}',
      '${PREFIX}obs-never-synced::0', '${k2.code}', 1, 'needed', '${B}', '${ADMIN}', now()
    );
    select 1;`)

  return { p1, p2, p3, p4, act, k1, k2 }
}

async function setup() {
  const serviceKey = await serviceRoleKey()
  await allowlist(ADMIN, 'admin')
  await allowlist(B, 'evaluator')
  await allowlist(C, 'evaluator')
  await createUser(serviceKey, ADMIN, 'TL06 Walkthrough Admin')
  await createUser(serviceKey, B, 'TL06 Evaluator B')
  await createUser(serviceKey, C, 'TL06 Evaluator C')
  const f = await seedEvidence()
  console.log(
    `setup done: 3 confirmed-low observations on ${f.p1.name} / ${f.p2.name}, activity "${f.act.title}"`,
  )
}

async function teardown() {
  const serviceKey = await serviceRoleKey()
  const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  }).then((r) => r.json())
  for (const u of list.users ?? []) {
    if (!u.email?.startsWith(PREFIX)) continue
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    })
  }
  await sql(`
    delete from mentoring_conversation where id like 'mc::${PREFIX}%' or id like '${PREFIX}%';
    delete from verification_verdict where capture_client_id like '${PREFIX}cap-%';
    delete from observation where capture_client_id like '${PREFIX}cap-%';
    delete from evaluation where client_id like '${PREFIX}cap-%';
    -- By author as well as by prefix: walking the app creates unattested drafts
    -- with random uuids that no prefix can match (tl-03's teardown learned this).
    delete from evaluation where evaluator_email like '${PREFIX}%@example.org';
    delete from workshop_member wm using app_user u
      where u.id = wm.app_user_id and u.email like '${PREFIX}%@example.org';
    delete from app_user where email like '${PREFIX}%@example.org';
    delete from auth.users where email like '${PREFIX}%@example.org';
    delete from role_allowlist where email like '${PREFIX}%@example.org';
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

const F = await seedEvidence()
const CONV1 = `mc::${PREFIX}obs-1::0`
const CONV2 = `mc::${PREFIX}obs-2::0`
const CONV3 = `mc::${PREFIX}obs-3::0`
const ORPHAN = `${PREFIX}orphan`

const { chromium } = await import('playwright')
const browser = await chromium.launch()
const errors = []

async function device(email) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => errors.push(`${email}: ${String(e)}`))
  // tl-19 moved the form to /signin; a harness that signs in at / gets the
  // landing page and times out on the email field.
  await p.goto(`${BASE}signin`, { waitUntil: 'domcontentloaded' })
  await p.getByLabel(/email/i).first().fill(email)
  await p.getByLabel(/password/i).first().fill(PASSWORD)
  await p.getByRole('button', { name: /sign in/i }).first().click()
  await p.waitForSelector('.shell__brand, .pagehead__title', { timeout: 20000 })
  return p
}

/** Rows in this device's own IndexedDB — what it holds, not what it draws. */
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

const ours = (page) =>
  localRows(
    page,
    'mentoringConversations',
    `row.id.startsWith('mc::${PREFIX}') || row.id.startsWith('${PREFIX}')`,
  )

async function serverConv(id) {
  const rows = await sql(`
    select assigned_to, admin_guidance, status, summary, participant_response,
           recorded_by, follow_up_needed, follow_up_note, trigger_activity_id
      from mentoring_conversation where id = '${id}';`)
  return rows[0] ?? null
}

const settle = (page, ms = 2500) => page.waitForTimeout(ms)

/**
 * Wait for the backend to agree rather than sleeping and hoping. The sync loop is
 * on a 30s interval, so a fixed settle reports timing failures that look exactly
 * like logic failures — tl-05's harness learned this the expensive way.
 */
async function awaitServer(id, predicate, what, budgetMs = 60000) {
  const deadline = Date.now() + budgetMs
  let last = null
  while (Date.now() < deadline) {
    last = await serverConv(id)
    if (last && predicate(last)) return { ok: true, row: last }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return { ok: false, row: last, what }
}

async function awaitLocal(page, predicate, budgetMs = 60000) {
  const deadline = Date.now() + budgetMs
  let rows = []
  while (Date.now() < deadline) {
    rows = (await ours(page)) ?? []
    if (predicate(rows)) return rows
    await page.waitForTimeout(2000)
  }
  return rows
}

async function openDrawer(page, participantName) {
  await page.getByRole('cell', { name: participantName, exact: true }).last().click()
  await page.waitForSelector('#tl05-guidance', { timeout: 10000 })
}

/** Expand one card on the evaluator's page, named by its participant. */
async function expandCard(page, participantName) {
  const card = page.locator('.activity-item').filter({ hasText: participantName }).first()
  await card.getByRole('button', { name: /^open$/i }).click()
  await page.waitForTimeout(600)
  return card
}

try {
  // =========================================================================
  // 1. The admin's queue derives the conversations and hands them out.
  // =========================================================================
  const admin = await device(ADMIN)
  await admin.goto(`${BASE}admin/conversations`, { waitUntil: 'domcontentloaded' })
  await admin.waitForSelector('.pagehead__title', { timeout: 20000 })
  // Reconcile runs on mount, which on a cold device is BEFORE the first pull has
  // brought the observations down, so the mount-time run legitimately finds
  // nothing. Wait for the pull, then ask again — which is what an admin arriving
  // mid-workshop does anyway.
  await settle(admin, 8000)
  await admin.getByRole('button', { name: /check for new triggers/i }).click()
  await settle(admin, 4000)

  let rows = await awaitLocal(admin, (r) => r.length >= 4)
  check(
    rows.length === 4,
    'the admin device derived three conversations plus the orphan it was sent',
    `${rows.length} row(s)`,
  )

  const derived = rows.filter((r) => r.id.startsWith(`mc::${PREFIX}`))
  check(
    derived.length === 3 && derived.every((r) => r.trigger_activity_id === F.act.id),
    'every derived conversation carries the activity its capture belonged to',
    [...new Set(derived.map((r) => String(r.trigger_activity_id)))].join(',') || 'no rows',
  )
  check(
    derived.length === 3 && derived.every((r) => r.follow_up_needed === false),
    'and none of them starts flagged',
    [...new Set(derived.map((r) => String(r.follow_up_needed)))].join(',') || 'no rows',
  )

  // Hand two to B and one to C, through the real drawer, with guidance on B's
  // first. One participant per conversation, so the cell the harness clicks names
  // exactly one row.
  for (const [name, who, guidance] of [
    [F.p1.name, B, GUIDANCE],
    [F.p3.name, B, null],
    [F.p2.name, C, null],
  ]) {
    await openDrawer(admin, name)
    await admin.selectOption('#tl05-assignee', who)
    await admin.getByRole('button', { name: /^(assign|reassign)$/i }).click()
    await settle(admin, 1200)
    if (guidance) {
      await admin.fill('#tl05-guidance', guidance)
      await admin.getByRole('button', { name: /save guidance/i }).click()
      await settle(admin, 1200)
    }
    // The drawer has three things called Close (scrim, header, footer), so this
    // names the one the page owns rather than matching by accessible name.
    await admin.locator('.drawer-scrim').click()
    await settle(admin, 600)
  }

  let s = await awaitServer(CONV1, (r) => r.assigned_to === B, 'CONV1 assigned to B')
  check(s.ok, 'B was given the first conversation', String(s.row?.assigned_to))
  check(
    s.row?.admin_guidance === GUIDANCE,
    'with the guidance the admin wrote for it',
    String(s.row?.admin_guidance).slice(0, 40),
  )
  check(
    s.row?.trigger_activity_id === F.act.id,
    'and the activity reached the backend, so the assignee can be told it',
    String(s.row?.trigger_activity_id),
  )
  s = await awaitServer(CONV2, (r) => r.assigned_to === B, 'CONV2 assigned to B')
  check(s.ok, 'B was given the second conversation', String(s.row?.assigned_to))
  s = await awaitServer(CONV3, (r) => r.assigned_to === C, 'CONV3 assigned to C')
  check(s.ok, 'C was given the third', String(s.row?.assigned_to))

  // =========================================================================
  // 2. Each evaluator sees exactly their own.
  // =========================================================================

  // Checked on the ADMIN's device first, and that is the only place it can be
  // checked, which is tl-05's badge lesson in a second costume. On B's device RLS
  // has already narrowed the store to B's rows, so the page renders three whether
  // or not it filters. The admin holds all four and owns none of them, so the
  // client-side filter is observable here and nowhere else.
  await admin.goto(`${BASE}conversations`, { waitUntil: 'domcontentloaded' })
  await admin.waitForSelector('h1', { timeout: 20000 })
  await settle(admin, 2500)
  const adminOwnCards = await admin.locator('.activity-item').count()
  check(
    adminOwnCards === 0,
    "the admin's own conversations page draws nothing, because none of the four is theirs",
    `${adminOwnCards} card(s)`,
  )
  await admin.goto(`${BASE}admin/conversations`, { waitUntil: 'domcontentloaded' })
  await admin.waitForSelector('.pagehead__title', { timeout: 20000 })

  const bee = await device(B)
  await bee.goto(`${BASE}conversations`, { waitUntil: 'domcontentloaded' })
  await bee.waitForSelector('h1', { timeout: 20000 })
  let bRows = await awaitLocal(bee, (r) => r.length >= 3)
  check(
    bRows.length === 3 && bRows.every((r) => r.assigned_to === B),
    "B's device holds exactly the three rows assigned to B, and nothing else",
    `${bRows.length} row(s): ${[...new Set(bRows.map((r) => String(r.assigned_to)))].join(',')}`,
  )

  // The other half of check 7, and it has to be taken HERE, on the first visit,
  // before any card has been opened. Without it the freshness check later is a
  // false green: it only ever exercises "viewed, then revised", so reverting the
  // default to "never viewed means changed" leaves every check green while marking
  // every unread conversation as changed — which is the signal meaning nothing on
  // the day it matters. Confirmed by mutation: this is the check that turns red.
  const firstVisit = (await bee.locator('body').innerText()).replace(/\s+/g, ' ')
  check(
    !/Guidance changed since you read it/i.test(firstVisit),
    'a conversation B has never opened is not marked as changed',
    '',
  )

  const cee = await device(C)
  await cee.goto(`${BASE}conversations`, { waitUntil: 'domcontentloaded' })
  await cee.waitForSelector('h1', { timeout: 20000 })
  const cRows = await awaitLocal(cee, (r) => r.length >= 1)
  check(
    cRows.length === 1 && cRows[0].assigned_to === C,
    "C's device holds exactly one, and it is C's",
    `${cRows.length} row(s)`,
  )
  // Not merely hidden: absent. The client-side filter and RLS are two different
  // claims and only this one tests the second.
  check(
    !cRows.some((r) => r.id === CONV1 || r.id === CONV2),
    "B's conversations are not in C's IndexedDB at all",
    cRows.map((r) => r.id).join(',') || 'none',
  )
  const cCards = await cee.locator('.activity-item').count()
  check(cCards === 1, 'and C\'s page draws exactly one card', `${cCards} card(s)`)

  // =========================================================================
  // 3-5. The evidence panel.
  // =========================================================================
  await bee.reload({ waitUntil: 'domcontentloaded' })
  await bee.waitForSelector('h1', { timeout: 20000 })
  await settle(bee, 2500)
  const card1 = await expandCard(bee, F.p1.name)
  const panel = (await card1.innerText()).replace(/\s+/g, ' ')

  check(panel.includes(OBS_TEXT), "the observation's own words are on the page", '')
  check(panel.includes(EXCERPT.slice(0, 40)), 'so is the verbatim excerpt from the capture', '')
  check(panel.includes(F.k1.short_label), "the question's short label is shown, not only its code", F.k1.short_label)
  const prompt = (
    await sql(`select evaluator_facing_prompt from ksa where workshop_id = '${PILOT_WS}' and code = '${F.k1.code}';`)
  )[0].evaluator_facing_prompt
  check(
    panel.includes(prompt.slice(0, 40)),
    'and the evaluator-facing prompt it was captured against',
    prompt.slice(0, 40),
  )
  check(panel.includes(F.act.title), 'the activity is named', F.act.title)
  check(panel.includes(GUIDANCE.slice(0, 30)), "the admin's guidance is rendered verbatim", '')
  check(
    panel.includes('Handled the same cue well two days earlier'),
    "the participant's other observation on the same question is shown as the pattern",
    '',
  )

  // The adjusted one, on B's second conversation.
  await card1.getByRole('button', { name: /^close$/i }).click()
  await settle(bee, 400)
  const card2 = await expandCard(bee, F.p3.name)
  const panel2 = (await card2.innerText()).replace(/\s+/g, ' ')
  check(panel2.includes('adjusted from 2'), 'an adjusted observation names what it was adjusted from', '')
  const effective = await card2.locator('.chip-d').first().getAttribute('data-d')
  check(effective === '1', 'and shows the adjusted value as the effective one', `data-d=${effective}`)

  // =========================================================================
  // 8. The partial-sync state, on the orphan row.
  // =========================================================================
  await card2.getByRole('button', { name: /^close$/i }).click()
  await settle(bee, 400)
  const orphanCard = await expandCard(bee, F.p4.name)
  const orphanText = (await orphanCard.innerText()).replace(/\s+/g, ' ')
  check(
    /has not reached this device yet/i.test(orphanText),
    'a conversation whose observation has not arrived says so, rather than showing a blank panel',
    '',
  )
  check(errors.length === 0, 'and no page error was thrown anywhere in the walk', errors.join(' | '))

  // =========================================================================
  // 9. What the evaluator can no longer do.
  // =========================================================================
  const bodyText = (await bee.locator('body').innerText()).replace(/\s+/g, ' ')
  check(!/reconcile|check for new triggers/i.test(bodyText), 'the page offers no reconcile', '')
  check(
    (await bee.getByRole('button', { name: /^dismiss$/i }).count()) === 0,
    'and no dismiss, because dropping a conversation is the admin\'s decision',
    '',
  )

  // =========================================================================
  // 6. B logs the outcome and raises the flag.
  // =========================================================================
  await orphanCard.getByRole('button', { name: /^close$/i }).click()
  await settle(bee, 400)
  const logCard = await expandCard(bee, F.p1.name)
  await logCard.getByRole('button', { name: /log the conversation/i }).click()
  await settle(bee, 500)
  // Scoped to the card and reached by label. The textareas carry ids built from the
  // conversation id, which contains `::` and so is not a usable CSS id selector
  // without escaping — and only one card is expanded at a time anyway.
  await logCard.getByLabel(/what was discussed/i).fill(SUMMARY)
  await logCard.getByLabel(/how they responded/i).fill(RESPONSE)
  await logCard.getByRole('checkbox').check()
  await settle(bee, 300)
  await logCard.getByLabel(/what your administrator should know/i).fill(NOTE)
  await logCard.getByRole('button', { name: /^save$/i }).click()
  await settle(bee, 2500)

  s = await awaitServer(CONV1, (r) => r.status === 'completed', 'CONV1 completed')
  check(s.ok, "B's outcome reached the backend", `status=${s.row?.status}`)
  check(s.row?.summary === SUMMARY, 'with the summary they wrote', String(s.row?.summary).slice(0, 30))
  check(
    s.row?.participant_response === RESPONSE,
    'and the participant response',
    String(s.row?.participant_response).slice(0, 30),
  )
  check(
    s.row?.recorded_by === B,
    'attributed to the assignee without asking them to type their own name',
    String(s.row?.recorded_by),
  )
  check(s.row?.follow_up_needed === true, 'the follow-up flag is raised', String(s.row?.follow_up_needed))
  check(s.row?.follow_up_note === NOTE, 'with the note attached', String(s.row?.follow_up_note).slice(0, 30))
  // The guard did not cost them the write, which is the whole reason the assignee
  // sends a narrow patch: B's device is holding a guidance string it did not write.
  check(
    s.row?.admin_guidance === GUIDANCE,
    "and the admin's guidance is untouched by the outcome write",
    String(s.row?.admin_guidance).slice(0, 30),
  )

  // The admin finds it under the follow-up view.
  await admin.reload({ waitUntil: 'domcontentloaded' })
  await admin.waitForSelector('.pagehead__title', { timeout: 20000 })
  await settle(admin, 6000)
  const adminText = (await admin.locator('body').innerText()).replace(/\s+/g, ' ')
  check(/Flagged as unfinished/i.test(adminText), "the admin's queue has a flagged-as-unfinished view", '')
  // Scoped to this harness's own participants, not an absolute count.
  //
  // Written as `count() === 1` first, and it failed reporting two rows — correctly.
  // The pilot workshop is shared, and scripts/tl06-rls-tests.sql leaves a flagged
  // conversation in it, so the view was right and the assertion was wrong. This is
  // the same lesson as tl-05's teardown prefix in a new place: prefix scoping
  // protects DELETES, and an absolute COUNT over a shared workshop is just as
  // capable of reporting another harness's state as its own.
  const flaggedTable = admin.locator('.card').filter({ hasText: 'Flagged as unfinished' })
  const flaggedMine = []
  for (const p of [F.p1, F.p2, F.p3, F.p4]) {
    if ((await flaggedTable.locator('tbody tr').filter({ hasText: p.name }).count()) > 0) {
      flaggedMine.push(p.name)
    }
  }
  check(
    flaggedMine.length === 1 && flaggedMine[0] === F.p1.name,
    'holding exactly the one conversation B flagged, of this run\'s four',
    flaggedMine.join(',') || 'none',
  )
  await openDrawer(admin, F.p1.name)
  const drawerText = (await admin.locator('.drawer').innerText()).replace(/\s+/g, ' ')
  check(drawerText.includes(NOTE.slice(0, 30)), "and the note B left is readable in the drawer", '')
  check(drawerText.includes(SUMMARY.slice(0, 25)), 'beside what B recorded about the conversation', '')

  // =========================================================================
  // 7. Guidance revised after B looked is marked as changed.
  // =========================================================================
  await admin.fill('#tl05-guidance', REVISED)
  await admin.getByRole('button', { name: /save guidance/i }).click()
  await settle(admin, 2000)
  s = await awaitServer(CONV1, (r) => r.admin_guidance === REVISED, 'guidance revised')
  check(s.ok, 'the admin revised the guidance after B had read it', String(s.row?.admin_guidance).slice(0, 30))

  await bee.reload({ waitUntil: 'domcontentloaded' })
  await bee.waitForSelector('h1', { timeout: 20000 })
  await awaitLocal(bee, (r) => r.find((x) => x.id === CONV1)?.admin_guidance === REVISED)
  // The card is in the folded-away section now, because B logged it.
  await bee.getByRole('button', { name: /^show \(/i }).click()
  await settle(bee, 800)
  const collapsed = bee.locator('.activity-item').filter({ hasText: F.p1.name }).first()
  // The marker is asserted on the COLLAPSED header and before opening the card, in
  // that order, because opening one is what clears it: the last-viewed stamp is
  // written by the act of opening, so an expand-then-look check would race the very
  // behaviour it is testing and could only ever pass by being fast enough.
  check(
    /Guidance changed since you read it/i.test((await collapsed.innerText()).replace(/\s+/g, ' ')),
    "B's next visit marks the guidance as changed, before they open it",
    '',
  )
  await collapsed.getByRole('button', { name: /^open$/i }).click()
  await settle(bee, 700)
  const afterText = (await collapsed.innerText()).replace(/\s+/g, ' ')
  check(afterText.includes(REVISED.slice(0, 30)), 'and opening it shows the revised text', '')
  check(!afterText.includes(GUIDANCE.slice(0, 30)), 'with the superseded wording gone', '')

  // =========================================================================
  // 10. It fits a phone.
  //
  // tl-20's scripts/ui-responsive-audit.mjs is the whole app's gate, and it does
  // not exist on this branch (cut from tl-05's, which is cut from main). So this
  // page checks its own width, the way tl-17 did for /workshops. Both assertions,
  // not just the first: tl-19 recorded that `scrollWidth <= innerWidth` is a false
  // green when content widens the layout viewport and both grow together.
  // =========================================================================
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const phone = await phoneCtx.newPage()
  phone.on('pageerror', (e) => errors.push(`phone: ${String(e)}`))
  await phone.goto(`${BASE}signin`, { waitUntil: 'domcontentloaded' })
  await phone.getByLabel(/email/i).first().fill(B)
  await phone.getByLabel(/password/i).first().fill(PASSWORD)
  await phone.getByRole('button', { name: /sign in/i }).first().click()
  await phone.waitForSelector('.shell__brand, .pagehead__title', { timeout: 20000 })
  await phone.goto(`${BASE}conversations`, { waitUntil: 'domcontentloaded' })
  await phone.waitForSelector('h1', { timeout: 20000 })
  await settle(phone, 2500)
  await expandCard(phone, F.p3.name)
  const widths = await phone.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }))
  check(
    widths.scroll <= widths.inner,
    'the expanded evidence panel does not overflow a 390px phone',
    `scrollWidth ${widths.scroll} vs innerWidth ${widths.inner}`,
  )
  check(
    widths.inner === 390,
    'and the content did not widen the layout viewport to hide the overflow',
    `innerWidth ${widths.inner}`,
  )
  check(errors.length === 0, 'no page error on the phone either', errors.join(' | '))
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r).length
console.log(
  `\n${results.length - failed}/${results.length} checks passed${failed ? ` — ${failed} FAILED` : ''}`,
)
if (errors.length) console.log(`page errors:\n  ${errors.join('\n  ')}`)
process.exit(failed ? 1 : 0)
