/**
 * tl-05's acceptance, which cannot be checked from a module.
 *
 * The unit tests prove the rules and scripts/tl05-rls-tests.sql proves the
 * database enforces them. Neither can prove the thing Joshua actually asked for:
 * that an administrator can hand a conversation to an evaluator with guidance
 * attached, and that the evaluator finds it on their own device and nothing else.
 * That is three devices, two round trips and a page reload, so it is here.
 *
 * What is under test, in order:
 *   1. An admin reconciles and the queue fills, with every row unassigned.
 *   2. Assign with guidance; both survive a reload and the sync round trip.
 *   3. Reassigning moves the conversation and leaves the guidance intact.
 *   4. Unassigning returns it to the pool, still with its guidance.
 *   5. A second reconcile does NOT clear the assignment. This is the bug the
 *      spec names as the one most likely to be introduced, and the pure test in
 *      test/conversationAssignment.test.ts checks the rule while this checks
 *      that the rule is the one actually running.
 *   6. Each evaluator's own device shows exactly their conversation, with the
 *      guidance, and their badge counts one rather than three.
 *   7. The other two conversations are not merely hidden on that device — they
 *      are not in its IndexedDB at all, because the server never sent them.
 *
 *   node scripts/tl05-assignment-walkthrough.mjs --setup
 *   npm run dev -- --port 5185                          # in another shell
 *   node scripts/tl05-assignment-walkthrough.mjs
 *   node scripts/tl05-assignment-walkthrough.mjs --teardown
 *
 * Port 5185, not the default 5180: a second session on this repo is running its
 * own dev server, and a harness left on the shared port drives the OTHER
 * session's build and passes — the worst possible green.
 *
 * Playwright is deliberately not a dependency of this repo:
 *   npm i -D --no-save playwright && npx playwright install chromium
 *
 * If the Management API calls fail with UND_ERR_CONNECT_TIMEOUT while curl to the
 * same host works, node is trying the AAAA record first; run it as
 * `node --dns-result-order=ipv4first scripts/tl05-assignment-walkthrough.mjs`.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const BASE = 'http://localhost:5185/'
const PROJECT = 'vdbirmjvjzfdgajwgowj'
const PILOT_WS = '11111111-1111-1111-1111-111111111111'
const PASSWORD = 'tl05-Throwaway-Password-1!'
const ADMIN = 'tl05-ui-admin@example.org'
const E1 = 'tl05-ui-e1@example.org'
const E2 = 'tl05-ui-e2@example.org'
const E3 = 'tl05-ui-e3@example.org'
const PREFIX = 'tl05-ui-'

const GUIDANCE = 'Open with the two things that improved before you name the gap.'

const results = []
function check(ok, label, detail = '') {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label.padEnd(70)} | ${detail}`)
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
    values ('${email}', array['${role}'], '${role}', 'tl-05 walkthrough fixture', '${PILOT_WS}')
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

/**
 * Three confirmed-low observations, one per participant.
 *
 * Real observations with real verdicts rather than three conversation rows
 * written by hand, because point 5 is that a re-derivation does not clobber an
 * assignment — and a conversation with no observation behind it is never
 * re-derived, so seeding the end state would test nothing. Two confirming
 * verdicts each, which is the default threshold.
 */
async function seedEvidence() {
  const parts = await sql(
    `select id, name from participant where workshop_id = '${PILOT_WS}' order by name limit 3;`,
  )
  if (parts.length < 3) throw new Error('the pilot workshop needs at least three participants')

  const values = parts
    .map(
      (p, i) => `('${PREFIX}obs-${i + 1}::0', '${PREFIX}cap-${i + 1}', '${PILOT_WS}', '${p.id}',
       '${p.name.replace(/'/g, "''")}', 'K1.${i + 1}', 'tl-05 walkthrough evidence',
       'excerpt', 1, 'weak', 'high', false, 'individual', '${E1}')`,
    )
    .join(',\n')

  const verdicts = parts
    .flatMap((_, i) =>
      [E2, E3].map(
        (who) => `('${PREFIX}obs-${i + 1}::0::${who}', '${PREFIX}obs-${i + 1}::0',
         '${PREFIX}cap-${i + 1}', '${PILOT_WS}', '${who}', 'confirm', now())`,
      ),
    )
    .join(',\n')

  await sql(`
    delete from mentoring_conversation where id like 'mc::${PREFIX}%';
    delete from verification_verdict where capture_client_id like '${PREFIX}cap-%';
    delete from observation where capture_client_id like '${PREFIX}cap-%';
    insert into observation (
      id, capture_client_id, workshop_id, participant_id, participant_name, ksa_code,
      text, source_excerpt, evidence_designation, sentiment_flag, confidence,
      needs_review, origin, evaluator_email
    ) values ${values};
    insert into verification_verdict (
      id, observation_id, capture_client_id, workshop_id, evaluator_email, decision, at
    ) values ${verdicts};
    select 1;`)
  return parts
}

async function setup() {
  const serviceKey = await serviceRoleKey()
  await allowlist(ADMIN, 'admin')
  for (const e of [E1, E2, E3]) await allowlist(e, 'evaluator')
  await createUser(serviceKey, ADMIN, 'TL05 Walkthrough Admin')
  await createUser(serviceKey, E1, 'TL05 Evaluator One')
  await createUser(serviceKey, E2, 'TL05 Evaluator Two')
  await createUser(serviceKey, E3, 'TL05 Evaluator Three')
  const parts = await seedEvidence()
  console.log(`setup done: 3 confirmed-low observations on ${parts.map((p) => p.name).join(', ')}`)
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
    delete from mentoring_conversation where id like 'mc::${PREFIX}%';
    delete from verification_verdict where capture_client_id like '${PREFIX}cap-%';
    delete from observation where capture_client_id like '${PREFIX}cap-%';
    -- By author as well as by prefix: walking the app creates unattested drafts
    -- with random uuids that no prefix can match (tl-03's teardown learned this
    -- after four of them accumulated unnoticed).
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

// Re-seed every run. The counts below are absolute, and a conversation left
// assigned by a previous run would make a broken assign look like it worked.
const parts = await seedEvidence()
const CONV = parts.map((_, i) => `mc::${PREFIX}obs-${i + 1}::0`)

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

/** Rows in this device's own IndexedDB — what it actually holds, not what it draws. */
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
  localRows(page, 'mentoringConversations', `row.id.startsWith('mc::${PREFIX}')`)

/** What the backend holds, read as postgres — the other half of every claim. */
async function serverConv(id) {
  const rows = await sql(
    `select assigned_to, admin_guidance, status from mentoring_conversation where id = '${id}';`,
  )
  return rows[0] ?? null
}

async function settle(page, ms = 2500) {
  await page.waitForTimeout(ms)
}

/**
 * Wait for the backend to agree, rather than sleeping and hoping.
 *
 * The sync loop is on a 30s interval, so the first version of this harness
 * settled for 2.5s and then asserted on the server — which reported three
 * failures for writes that were correct and simply had not been sent yet. A
 * timing failure that looks exactly like a logic failure is worse than a slow
 * test, so every server-side claim polls to a deadline and reports what it last
 * saw when the deadline passes.
 */
async function awaitServer(id, predicate, what, budgetMs = 45000) {
  const deadline = Date.now() + budgetMs
  let last = null
  while (Date.now() < deadline) {
    last = await serverConv(id)
    if (last && predicate(last)) return { ok: true, row: last, waited: true }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return { ok: false, row: last, what }
}

/** Poll this device's own store until every fixture row has been sent. */
async function awaitPushed(page, budgetMs = 45000) {
  const deadline = Date.now() + budgetMs
  let rows = []
  while (Date.now() < deadline) {
    rows = await ours(page)
    if (rows.length > 0 && rows.every((r) => r.sync_status === 'synced')) return rows
    await page.waitForTimeout(2000)
  }
  return rows
}

/** Open the drawer for one conversation by clicking its row in the full queue. */
async function openDrawer(page, participantName) {
  await page.getByRole('cell', { name: participantName, exact: true }).last().click()
  await page.waitForSelector('#tl05-guidance', { timeout: 10000 })
}

try {
  // =========================================================================
  // 1. The queue fills, and everything in it is unassigned.
  // =========================================================================
  const admin = await device(ADMIN)
  await admin.goto(`${BASE}admin/conversations`, { waitUntil: 'domcontentloaded' })
  await admin.waitForSelector('.pagehead__title', { timeout: 20000 })
  // Reconcile runs on mount, which on a cold device is BEFORE the first pull has
  // brought the observations down — so the mount-time run legitimately finds
  // nothing. Wait for the pull, then ask again, which is also what an admin
  // arriving mid-workshop does.
  await settle(admin, 6000)
  await admin.getByRole('button', { name: /check for new triggers/i }).click()
  await settle(admin, 4000)

  let rows = await ours(admin)
  check(rows.length === 3, 'the admin device derived all three conversations', `${rows.length} row(s)`)
  // `every` on an empty array is true, so each of these asserts the count as
  // well. Written without it first, and all three reported PASS against zero
  // rows — the same shape of false green tl-19 and tl-20 each found one of.
  check(
    rows.length === 3 && rows.every((r) => r.workshop_id === PILOT_WS),
    'every derived conversation carries its workshop, so the backend can accept it',
    [...new Set(rows.map((r) => String(r.workshop_id)))].join(',') || 'no rows',
  )
  check(
    rows.length === 3 && rows.every((r) => r.assigned_to === null),
    'every derived conversation starts in the pool',
    rows.map((r) => String(r.assigned_to)).join(',') || 'no rows',
  )
  rows = await awaitPushed(admin)
  check(
    rows.length === 3 && rows.every((r) => r.sync_status === 'synced'),
    'the admin device pushed them to the backend',
    [...new Set(rows.map((r) => r.sync_status))].join(',') || 'no rows',
  )

  // =========================================================================
  // 2. Assign with guidance, and make it survive a reload.
  // =========================================================================
  await openDrawer(admin, parts[0].name)
  await admin.selectOption('#tl05-assignee', E1)
  await admin.getByRole('button', { name: /^assign$/i }).click()
  await admin.fill('#tl05-guidance', GUIDANCE)
  await admin.getByRole('button', { name: /save guidance/i }).click()
  await settle(admin)

  await admin.reload({ waitUntil: 'domcontentloaded' })
  await admin.waitForSelector('.pagehead__title', { timeout: 20000 })
  await settle(admin)

  let c0 = (await ours(admin)).find((r) => r.id === CONV[0])
  check(c0?.assigned_to === E1, 'the assignment survived a reload', String(c0?.assigned_to))
  check(c0?.admin_guidance === GUIDANCE, 'the guidance survived a reload', String(c0?.admin_guidance).slice(0, 40))

  let s = await awaitServer(CONV[0], (r) => r.assigned_to === E1, 'assigned to E1')
  check(s.ok, 'the assignment reached the backend', String(s.row?.assigned_to))
  check(
    s.row?.admin_guidance === GUIDANCE,
    'the guidance reached the backend',
    String(s.row?.admin_guidance).slice(0, 40),
  )

  // =========================================================================
  // 3-4. Reassign, then unassign. Guidance is about the conversation, not the
  //      person, so it must survive both.
  // =========================================================================
  await openDrawer(admin, parts[0].name)
  await admin.selectOption('#tl05-assignee', E2)
  await admin.getByRole('button', { name: /^reassign$/i }).click()
  s = await awaitServer(CONV[0], (r) => r.assigned_to === E2, 'assigned to E2')
  check(s.ok, 'reassignment moved the conversation', String(s.row?.assigned_to))
  check(
    s.row?.admin_guidance === GUIDANCE,
    'reassignment left the guidance intact',
    String(s.row?.admin_guidance).slice(0, 40),
  )

  await admin.getByRole('button', { name: /return to the pool/i }).click()
  s = await awaitServer(CONV[0], (r) => r.assigned_to === null, 'unassigned')
  check(s.ok, 'unassigning returned it to the pool', String(s.row?.assigned_to))
  check(
    s.row?.admin_guidance === GUIDANCE,
    'unassigning left the guidance intact',
    String(s.row?.admin_guidance).slice(0, 40),
  )

  // Put it back, and give the other two out, so each evaluator holds exactly one.
  await admin.reload({ waitUntil: 'domcontentloaded' })
  await admin.waitForSelector('.pagehead__title', { timeout: 20000 })
  await settle(admin, 3000)
  for (const [i, who] of [E1, E2, E3].entries()) {
    await openDrawer(admin, parts[i].name)
    await admin.selectOption('#tl05-assignee', who)
    await admin.getByRole('button', { name: /^(assign|reassign)$/i }).click()
    await settle(admin, 1500)
    // The drawer has three things called Close (scrim, header, footer), so this
    // names the one the panel owns rather than matching by accessible name.
    await admin.locator('.drawer-scrim').click()
    await settle(admin, 500)
  }

  const assignedNow = []
  for (const [i, who] of [E1, E2, E3].entries()) {
    assignedNow.push(await awaitServer(CONV[i], (r) => r.assigned_to === who, `assigned to ${who}`))
  }
  check(
    assignedNow.every((a) => a.ok),
    'all three conversations are held by three different people',
    assignedNow.map((a) => String(a.row?.assigned_to)).join(','),
  )

  // =========================================================================
  // 5. The clobber test. Reconcile runs on every visit to either conversations
  //    page, so this is not a rare path — it is the one that runs constantly.
  // =========================================================================
  await admin.getByRole('button', { name: /check for new triggers/i }).click()
  await settle(admin, 5000)
  const afterReconcile = await Promise.all(CONV.map(serverConv))
  check(
    afterReconcile.map((r) => r?.assigned_to).join(',') === [E1, E2, E3].join(','),
    'a re-reconcile did not unassign anything',
    afterReconcile.map((r) => r?.assigned_to).join(','),
  )
  check(
    afterReconcile[0]?.admin_guidance === GUIDANCE,
    'a re-reconcile did not wipe the guidance',
    String(afterReconcile[0]?.admin_guidance).slice(0, 40),
  )
  const stillThree = await ours(admin)
  check(stillThree.length === 3, 'a re-reconcile created no duplicates', `${stillThree.length} row(s)`)

  // =========================================================================
  // 5b. The badge, measured on the device where it can actually be wrong.
  //
  //     On an evaluator's device RLS has already narrowed the store to their own
  //     row, so their badge reads 1 whether or not the client filters — the check
  //     further down cannot tell the two apart, and would pass on a build with
  //     the scoping removed. The admin's device is the one holding all three with
  //     none of them theirs, so it is the only place the client-side filter is
  //     observable at all.
  // =========================================================================
  await admin.goto(`${BASE}observations`, { waitUntil: 'domcontentloaded' })
  await admin.waitForSelector('.shell__brand', { timeout: 20000 })
  await settle(admin, 1500)
  const adminNav = await admin.evaluate(() => {
    const link = (href) =>
      [...document.querySelectorAll('a')].find((a) => a.getAttribute('href') === href)
    return {
      mine: link('/conversations')?.innerText.replace(/\s+/g, ' ').trim() ?? 'NO LINK',
      queue: link('/admin/conversations')?.innerText.replace(/\s+/g, ' ').trim() ?? 'NO LINK',
    }
  })
  const adminHolds = (await ours(admin)).length
  check(
    adminHolds === 3 && !/\d/.test(adminNav.mine),
    "the admin's own badge counts none, though their device holds all three",
    `holds ${adminHolds}, badge "${adminNav.mine}"`,
  )
  // Computed, not assumed. Written as "and it should be zero" first, which failed
  // against a workshop still holding scripts/tl05-rls-tests.sql's fixtures — the
  // badge was right and the harness was wrong. An assertion that only holds on a
  // pristine database is one that will cry wolf at whoever runs it next.
  const [{ n: pooled }] = await sql(
    `select count(*)::int as n from mentoring_conversation
      where workshop_id = '${PILOT_WS}' and assigned_to is null
        and status in ('needed', 'scheduled');`,
  )
  const shown = Number((adminNav.queue.match(/(\d+)\s*$/) ?? [, '0'])[1])
  check(
    adminNav.queue !== 'NO LINK' && shown === pooled,
    'the queue badge counts exactly the conversations still in the pool',
    `badge "${adminNav.queue}" vs ${pooled} unassigned in the workshop`,
  )

  // =========================================================================
  // 6-7. The evaluator's own device.
  // =========================================================================
  const ev1 = await device(E1)
  await ev1.goto(`${BASE}conversations`, { waitUntil: 'domcontentloaded' })
  await settle(ev1, 4000)

  const ev1Rows = await ours(ev1)
  check(
    ev1Rows.length === 1 && ev1Rows[0].id === CONV[0],
    "the evaluator's device holds only their own conversation, not the other two",
    `${ev1Rows.length} row(s): ${ev1Rows.map((r) => r.id).join(',')}`,
  )

  const ev1Body = await ev1.evaluate(() => document.body.innerText)
  check(ev1Body.includes(parts[0].name), 'the evaluator sees the participant they were given', parts[0].name)
  check(
    !ev1Body.includes(parts[1].name) && !ev1Body.includes(parts[2].name),
    'the evaluator does not see the participants they were not given',
    'neither name present',
  )
  check(ev1Body.includes(GUIDANCE), "the evaluator can read the admin's guidance", 'guidance shown')

  // Read the badge from a WIDE route. /conversations is in the narrow shell —
  // "one task at a time, phone-first, no sidebar" — so the nav is not on the
  // page the badge points at, and looking for it there reports NO LINK whatever
  // the count is.
  await ev1.goto(`${BASE}observations`, { waitUntil: 'domcontentloaded' })
  await ev1.waitForSelector('.shell__brand', { timeout: 20000 })
  const badge = await ev1.evaluate(() => {
    const link = [...document.querySelectorAll('a')].find((a) =>
      /conversations/i.test(a.getAttribute('href') ?? ''),
    )
    return link?.innerText.replace(/\s+/g, ' ').trim() ?? 'NO LINK'
  })
  check(/\b1\b/.test(badge) && !/\b3\b/.test(badge), 'the badge counts one, not the workshop\'s three', badge)

  const ev2 = await device(E2)
  await ev2.goto(`${BASE}conversations`, { waitUntil: 'domcontentloaded' })
  await settle(ev2, 4000)
  const ev2Rows = await ours(ev2)
  check(
    ev2Rows.length === 1 && ev2Rows[0].id === CONV[1],
    'the second evaluator holds theirs and only theirs',
    `${ev2Rows.length} row(s): ${ev2Rows.map((r) => r.id).join(',')}`,
  )

  check(errors.length === 0, 'no uncaught page errors on any device', errors.join(' | ') || 'none')
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
