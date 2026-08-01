/**
 * tl-10's acceptance: the claims that need a live database, a real file picker and
 * a rendered preview.
 *
 * The parser and the planner are unit-tested (test/rosterImport.test.ts, 42 cases
 * including a real .xlsx read end to end), and the warning copy is covered by
 * test/setupCopy.test.ts. What none of those can show is the promise the spec
 * actually makes: that choosing a file writes NOTHING, that committing writes
 * exactly what the preview said, that doing it twice changes nothing the second
 * time, and that undo puts the roster back except for anybody who has since been
 * observed.
 *
 * What is under test, in order:
 *   S1  an admin of the workshop may record a batch
 *   S2  an ordinary member cannot READ one — asserted as zero rows, because RLS
 *       denies by filtering rather than by erroring
 *   S3  an admin of ANOTHER workshop cannot read it either
 *   S4  an ordinary member cannot write one
 *   S5  nobody can delete one; undo is an update, and the record survives it
 *   S6  the workshop's admin can mark it undone
 *   B1  choosing a file writes nothing at all: the roster is untouched until commit
 *   B2  the column mapping is guessed from a real header row
 *   B3  every verdict the preview can show appears on a messy file, and the two
 *       uncommittable kinds arrive deselected
 *   B4  commit goes through the change dialog and lands exactly the previewed rows
 *   B5  idempotence: the same file again reports every row already correct and
 *       creates nothing
 *   B6  undo restores the roster and removes the team the import created
 *   B7  undo REFUSES for a participant observed since, names them, and completes
 *       for everybody else
 *   B8  an .xlsx imports end to end, and its reader chunk is not fetched until a
 *       spreadsheet is actually chosen
 *
 *   node scripts/tl10-roster-import.mjs --setup      # accounts, workshop, roster
 *   npm run dev -- --port 5188                       # in another shell
 *   node scripts/tl10-roster-import.mjs
 *   node scripts/tl10-roster-import.mjs --teardown
 *
 * PORT 5188, not the repo default, and TL10_PORT moves it. A concurrent session
 * left on 5180 would drive somebody else's build and pass, which is the worst
 * possible green.
 *
 * Playwright is deliberately not a dependency of this repo:
 *   npm i -D --no-save playwright && npx playwright install chromium
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const BASE = `http://localhost:${process.env.TL10_PORT ?? 5188}/`
const PROJECT = 'vdbirmjvjzfdgajwgowj'
const PASSWORD = 'tl10-Throwaway-Password-1!'

const WS = 'a7100000-0000-4000-8000-000000000001'
const WS_OTHER = 'a7100000-0000-4000-8000-000000000002'
const NAME = 'TL10 Import Workshop'
const ADMIN = 'tl10-admin@example.org'
const MEMBER = 'tl10-member@example.org'
const CROSS = 'tl10-cross@example.org'

/** Seeded before any import, so "update" and "already correct" have somebody to be about. */
const SEEDED = [
  ['a7100000-0000-4000-8000-00000000p001'.replace('p', 'e'), 'Ayu Ningsih', 'ayu@example.org'],
  ['a7100000-0000-4000-8000-00000000p002'.replace('p', 'e'), 'Budi Santoso', null],
]

/**
 * The clean file. Two rows match the seeded pair (one by email, one by name for
 * somebody with no address on file), three are new, and one names a team that does
 * not exist.
 */
const CLEAN_CSV = [
  'Full Name,E-Mail,Team Name,Preferred Language',
  'Ayu Ningsih,ayu@example.org,Team A,Indonesian',
  'Budi Santoso,budi@example.org,Team A,Indonesian',
  'José Álvarez,jose@example.org,Team B,Spanish',
  '김민준,minjun@example.org,Team B,Korean',
  '"Amos, Jr.",amos@example.org,,English',
  '',
].join('\n')

/** The messy file, one row per verdict the preview can show. */
const MESSY_CSV = [
  'Full Name,E-Mail,Team Name',
  'Ayu Ningsih,ayu@example.org,Team A',
  ',orphan@example.org,Team A',
  'Broken Address,not an address,Team A',
  'Twice Over,twice@example.org,Team A',
  'Twice Over Again,TWICE@example.org,Team A',
  'Fresh Person,fresh@example.org,Team Z',
  '',
].join('\n')

const results = []
function check(ok, label, detail = '') {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label.padEnd(72)} | ${detail}`)
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

async function serviceRoleKey() {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/api-keys?reveal=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const keys = await res.json()
  const key = keys.find((k) => k.name === 'service_role')?.api_key
  if (!key) throw new Error('could not read the service_role key')
  return key
}

// ---------------------------------------------------------------------------
// Fixtures. Prefix-scoped in both directions: `tl10-` accounts and two fixture
// workshop ids, so this can run beside the other harnesses on the one project.
// ---------------------------------------------------------------------------

async function provision() {
  const serviceKey = await serviceRoleKey()
  await wipe(serviceKey)

  await sql(`
    insert into workshop (id, name, start_date, end_date, location)
    values ('${WS}', '${NAME}', '2027-05-01', '2027-05-10', 'Import Town'),
           ('${WS_OTHER}', 'TL10 Other Workshop', '2027-06-01', '2027-06-10', 'Elsewhere');
    select 1;`)

  const values = SEEDED.map(
    ([id, name, email]) =>
      `('${id}', '${WS}', ${quote(name)}, ${email ? quote(email) : 'null'}, 'English')`,
  ).join(',')
  await sql(`
    insert into participant (id, workshop_id, name, registered_email, preferred_language)
    values ${values};
    select 1;`)

  for (const [email, role, ws] of [
    [ADMIN, 'admin', WS],
    [MEMBER, 'evaluator', WS],
    [CROSS, 'admin', WS_OTHER],
  ]) {
    await sql(`
      insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
      values ('${email}', array['${role}'], '${role}', 'tl-10 fixture', '${ws}')
      on conflict (email) do update set allowed_roles = excluded.allowed_roles,
        assigned_role = excluded.assigned_role, default_workshop_id = excluded.default_workshop_id;
      select 1;`)
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { name: email },
      }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok && !/already|registered|exists/i.test(JSON.stringify(body))) {
      throw new Error(`create ${email} -> ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
    }
  }

  console.log('setup done')
}

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`

async function wipe(serviceKey) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  })
  const { users = [] } = await res.json()
  for (const u of users) {
    if (!u.email?.startsWith('tl10-')) continue
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    })
  }
  await sql(`
    delete from roster_import_batch where workshop_id in ('${WS}', '${WS_OTHER}');
    delete from observation where workshop_id in ('${WS}', '${WS_OTHER}');
    delete from setup_change_log where workshop_id in ('${WS}', '${WS_OTHER}');
    delete from participant where workshop_id in ('${WS}', '${WS_OTHER}');
    delete from team where workshop_id in ('${WS}', '${WS_OTHER}');
    delete from workshop_member where workshop_id in ('${WS}', '${WS_OTHER}');
    delete from workshop where id in ('${WS}', '${WS_OTHER}');
    delete from workshop_member wm using app_user u
      where u.id = wm.app_user_id and u.email like 'tl10-%@example.org';
    delete from app_user where email like 'tl10-%@example.org';
    delete from auth.users where email like 'tl10-%@example.org';
    delete from role_allowlist where email like 'tl10-%@example.org';
    select 1;`)
}

if (process.argv.includes('--setup')) {
  await provision()
  process.exit(0)
}
if (process.argv.includes('--teardown')) {
  await wipe(await serviceRoleKey())
  console.log('teardown done')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// S: what the database allows and refuses, checked on the wire
// ---------------------------------------------------------------------------

async function token(email) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const body = await res.json()
  if (!res.ok || !body.access_token) {
    throw new Error(`sign-in failed for ${email}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
  }
  return body.access_token
}

async function rest(path, jwt, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

const adminToken = await token(ADMIN)
const memberToken = await token(MEMBER)
const crossToken = await token(CROSS)
const PROBE_BATCH = 'rosterimport_tl10_probe'

await sql(`delete from roster_import_batch where id = '${PROBE_BATCH}'; select 1;`)

{
  const r = await rest('roster_import_batch', adminToken, {
    method: 'POST',
    body: JSON.stringify({
      id: PROBE_BATCH,
      workshop_id: WS,
      actor_email: ADMIN,
      filename: 'probe.csv',
      row_count: 3,
    }),
  })
  check(r.status === 201, 'S1 an admin of the workshop may record a batch', `${r.status}`)
}

{
  // ZERO ROWS, not an error. A denied read is silent filtering, so asserting on a
  // status code here would pass whatever the policy said.
  const r = await rest(`roster_import_batch?id=eq.${PROBE_BATCH}`, memberToken)
  check(
    r.status === 200 && Array.isArray(r.body) && r.body.length === 0,
    'S2 an ordinary member reads zero batches, not an error',
    `${r.status} rows=${Array.isArray(r.body) ? r.body.length : '?'}`,
  )
}

{
  const r = await rest(`roster_import_batch?id=eq.${PROBE_BATCH}`, crossToken)
  check(
    r.status === 200 && Array.isArray(r.body) && r.body.length === 0,
    "S3 an admin of another workshop cannot read this workshop's batch",
    `${r.status} rows=${Array.isArray(r.body) ? r.body.length : '?'}`,
  )
}

{
  const r = await rest('roster_import_batch', memberToken, {
    method: 'POST',
    body: JSON.stringify({
      id: 'rosterimport_tl10_forged',
      workshop_id: WS,
      filename: 'forged.csv',
      row_count: 1,
    }),
  })
  check(
    r.status === 401 || r.status === 403,
    'S4 an ordinary member cannot record a batch',
    `${r.status} ${JSON.stringify(r.body).slice(0, 100)}`,
  )
}

{
  const r = await rest(`roster_import_batch?id=eq.${PROBE_BATCH}`, adminToken, { method: 'DELETE' })
  const still = await sql(`select count(*)::int as n from roster_import_batch where id = '${PROBE_BATCH}';`)
  const rows = still?.[0]?.n ?? still?.[0]?.count ?? 0
  check(
    (r.status === 401 || r.status === 403) && Number(rows) === 1,
    'S5 nobody can delete a batch: the record of the import survives',
    `${r.status}, rows still ${rows}`,
  )
}

{
  const r = await rest(`roster_import_batch?id=eq.${PROBE_BATCH}`, adminToken, {
    method: 'PATCH',
    body: JSON.stringify({ undone_at: new Date().toISOString(), undone_by: ADMIN }),
  })
  check(r.status === 204 || r.status === 200, 'S6 the workshop admin can mark it undone', `${r.status}`)
}

await sql(`delete from roster_import_batch where id = '${PROBE_BATCH}'; select 1;`)

// ---------------------------------------------------------------------------
// B: the rendered app
// ---------------------------------------------------------------------------

const { chromium } = await import('playwright')
const browser = await chromium.launch()
const pageErrors = []
/** Every chunk the browser fetched, so B8 can prove the reader stayed unloaded. */
const requested = []

async function device(email) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => pageErrors.push(`${email}: ${String(e)}`))
  p.on('request', (r) => requested.push(r.url()))
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.getByLabel(/email/i).first().fill(email)
  await p.getByLabel(/password/i).first().fill(PASSWORD)
  await p.getByRole('button', { name: /sign in/i }).first().click()
  await p.waitForSelector('.shell__brand, .pagehead__title', { timeout: 25000 })
  await p
    .waitForFunction((name) => document.body.innerText.includes(name), NAME, { timeout: 25000 })
    .catch(() => {})
  return p
}

/** The roster as this device holds it, read from the app's own Dexie instance. */
const roster = (p) =>
  p.evaluate(async (ws) => {
    const m = await import('/src/db/local.ts')
    const rows = await m.db.participants.where('workshop_id').equals(ws).toArray()
    return rows
      .map((r) => ({ id: r.id, name: r.name, email: r.registered_email, team: r.team_id }))
      .sort((a, b) => (a.name < b.name ? -1 : 1))
  }, WS)

const teamNames = (p) =>
  p.evaluate(async (ws) => {
    const m = await import('/src/db/local.ts')
    return (await m.db.teams.where('workshop_id').equals(ws).toArray()).map((t) => t.name).sort()
  }, WS)

async function openImporter(p) {
  await p.goto(`${BASE}admin/setup/participants`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('text=Import from a spreadsheet', { timeout: 20000 })
  const toggle = p.getByRole('button', { name: /^import a file$/ })
  if (await toggle.isVisible().catch(() => false)) await toggle.click()
  await p.waitForSelector('input[type="file"]', { timeout: 10000 })
}

async function choose(p, name, contents, mimeType = 'text/csv') {
  await p.setInputFiles('input[type="file"]', {
    name,
    mimeType,
    buffer: Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8'),
  })
  await p.waitForSelector('text=What this would do', { timeout: 15000 })
}

/** Confirm the change dialog the hub puts in front of every setup save. */
async function confirmDialog(p) {
  await p.waitForSelector('[role="dialog"]', { timeout: 10000 })
  const text = await p.locator('[role="dialog"]').innerText()
  await p.locator('[role="dialog"]').getByRole('button', { name: /^Save|^Apply|^Confirm|^Commit/i }).first().click()
  await p.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 15000 })
  return text
}

const admin = await device(ADMIN)

{
  // B1. The whole point of the spec: choosing a file changes nothing.
  const before = await roster(admin)
  await openImporter(admin)
  await choose(admin, 'bali-roster.csv', CLEAN_CSV)
  const after = await roster(admin)
  check(
    before.length === 2 && after.length === 2,
    'B1 choosing a file writes nothing: the roster is untouched until commit',
    `${before.length} -> ${after.length}`,
  )
}

{
  // B2. The mapping guess, read off the rendered dropdowns.
  const selected = await admin.evaluate(() =>
    ['name', 'registered_email', 'team', 'preferred_language'].map((f) => {
      const el = document.getElementById(`map-${f}`)
      return el ? el.options[el.selectedIndex].text : 'MISSING'
    }),
  )
  check(
    JSON.stringify(selected) ===
      JSON.stringify(['Full Name', 'E-Mail', 'Team Name', 'Preferred Language']),
    'B2 the columns are guessed from the header row',
    selected.join(' | '),
  )
}

{
  const summary = await admin.locator('text=/new,.*updated,.*already correct/').first().innerText()
  check(
    /3 new/.test(summary) && /2 updated/.test(summary),
    'B2b the preview counts three new people and two updates',
    summary,
  )
}

{
  // B4. Commit, through the dialog, and check the roster IS the file.
  const dialogText = await admin
    .getByRole('button', { name: /Import 5 row/ })
    .click()
    .then(() => confirmDialog(admin))
  const after = await roster(admin)
  const names = after.map((p) => p.name)
  const teams = await teamNames(admin)
  check(
    after.length === 5 &&
      names.includes('José Álvarez') &&
      names.includes('김민준') &&
      names.includes('Amos, Jr.') &&
      after.find((p) => p.name === 'Budi Santoso')?.email === 'budi@example.org',
    'B4 the committed roster matches the file, non-ASCII names intact',
    `${after.length} people: ${names.join(', ')}`,
  )
  check(
    teams.join(',') === 'Team A,Team B',
    'B4b the two teams named in the file were created',
    teams.join(','),
  )
  check(
    /adds 3 participant/.test(dialogText) && /updates 2/.test(dialogText),
    'B4c the change dialog quoted the real counts before committing',
    dialogText.replace(/\s+/g, ' ').slice(0, 140),
  )
}

{
  // B5. Idempotence, which is the claim that the matching rules work.
  await openImporter(admin)
  await choose(admin, 'bali-roster.csv', CLEAN_CSV)
  const summary = await admin.locator('text=/new,.*updated,.*already correct/').first().innerText()
  await admin.getByRole('button', { name: /Import 5 row/ }).click()
  await confirmDialog(admin)
  const after = await roster(admin)
  check(
    /0 new/.test(summary) && /5 already correct/.test(summary) && after.length === 5,
    'B5 the same file again is a no-op: five already correct, nothing created',
    `${summary} -> ${after.length} people`,
  )
}

{
  // B3. Every verdict, on a messy file. Checked as counts rather than by reading
  // each row, because the summary line is what an administrator actually reads.
  await openImporter(admin)
  await choose(admin, 'messy.csv', MESSY_CSV)
  const summary = await admin.locator('text=/new,.*updated,.*already correct/').first().innerText()
  const checkboxes = await admin.evaluate(() =>
    [...document.querySelectorAll('td input[type="checkbox"]')].map((el) => ({
      checked: el.checked,
      disabled: el.disabled,
    })),
  )
  const uncommittable = checkboxes.filter((c) => c.disabled)
  check(
    /1 duplicate/.test(summary) && /2 with errors/.test(summary),
    'B3 the messy file reports one duplicate and two errors',
    summary,
  )
  check(
    uncommittable.length === 3 && uncommittable.every((c) => !c.checked),
    'B3b the error and duplicate rows arrive deselected and cannot be selected',
    `${uncommittable.length} locked rows`,
  )
  await admin.getByRole('button', { name: /Discard this file/ }).click()
}

{
  // B7. Undo, with one of the imported people observed since. The refusal is the
  // interesting half: it keeps that person, names them, and finishes the rest.
  const before = await roster(admin)
  const jose = before.find((p) => p.name === 'José Álvarez')
  await admin.evaluate(async ([ws, participantId]) => {
    const m = await import('/src/db/local.ts')
    await m.db.observations.put({
      id: 'tl10-observation-1',
      capture_client_id: 'tl10-capture-1',
      workshop_id: ws,
      participant_id: participantId,
      ksa_code: 'TL10Q',
      designation: 2,
      source_text: 'observed after the import',
      sync_status: 'local',
    })
  }, [WS, jose.id])

  await admin.goto(`${BASE}admin/setup/participants`, { waitUntil: 'domcontentloaded' })
  await admin.waitForSelector('text=bali-roster.csv', { timeout: 15000 })
  // LAST, not first. The list is newest-first, and the newest batch is B5's
  // re-import, which created nothing — undoing that would correctly do nothing and
  // would prove nothing. The batch under test is the one that made the roster.
  await admin.getByRole('button', { name: /^undo$/ }).last().click()
  const dialogText = await confirmDialog(admin)
  await admin.waitForSelector('text=/Undone:/', { timeout: 15000 })
  const outcome = await admin.locator('text=/Undone:/').first().innerText()
  const after = await roster(admin)
  const names = after.map((p) => p.name)

  check(
    /observed since/.test(dialogText) || /kept rather than deleted/.test(dialogText),
    'B7 the undo dialog says somebody cannot be removed',
    dialogText.replace(/\s+/g, ' ').slice(0, 140),
  )
  check(
    names.includes('José Álvarez') && !names.includes('김민준') && !names.includes('Amos, Jr.'),
    'B7b undo removed the unobserved imports and kept the observed one',
    names.join(', '),
  )
  check(
    /José Álvarez/.test(outcome),
    'B7c the person kept is named, not counted',
    outcome.replace(/\s+/g, ' ').slice(0, 160),
  )
  check(
    after.find((p) => p.name === 'Budi Santoso')?.email === null,
    'B6 an updated field was put back to what it held before the import',
    JSON.stringify(after.find((p) => p.name === 'Budi Santoso')),
  )
  const teams = await teamNames(admin)
  check(
    teams.join(',') === 'Team B',
    'B6b a team the import created is removed if nobody is left on it, and kept if somebody is',
    teams.join(',') || '(none)',
  )
}

{
  // B8. The spreadsheet reader is its own chunk and must not be fetched by a
  // session that never opens a spreadsheet.
  const beforeChunk = requested.some((u) => /parseSpreadsheet|unzip/.test(u))
  await openImporter(admin)
  await choose(
    admin,
    'roster-sample.xlsx',
    readFileSync(new URL('../test/fixtures/roster-sample.xlsx', import.meta.url)),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  const afterChunk = requested.some((u) => /parseSpreadsheet|unzip/.test(u))
  const selected = await admin.evaluate(() => {
    const el = document.getElementById('map-name')
    return el ? el.options[el.selectedIndex].text : 'MISSING'
  })
  const summary = await admin.locator('text=/new,.*updated,.*already correct/').first().innerText()
  // Counted as "all four people in the file are accounted for" rather than as a
  // fixed split: this runs after the undo above, so which of them are new depends
  // on what the undo kept, and pinning the split would pin an unrelated result.
  const accounted = [...summary.matchAll(/(\d+) (new|updated|already correct)/g)].reduce(
    (n, m) => n + Number(m[1]),
    0,
  )
  check(!beforeChunk, 'B8 the spreadsheet reader is not fetched before a spreadsheet is chosen')
  check(afterChunk, 'B8b it is fetched when one is')
  check(
    selected === 'Full Name' && accounted === 4 && !/with errors\.$/.test(summary.replace(/0 with errors\./, 'ok')),
    'B8c the .xlsx parses into a preview with its columns mapped and all four rows read',
    `${selected} | ${summary}`,
  )
  await admin.getByRole('button', { name: /Discard this file/ }).click()
}

check(pageErrors.length === 0, 'no uncaught page errors', pageErrors.slice(0, 2).join(' | '))

await browser.close()

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
