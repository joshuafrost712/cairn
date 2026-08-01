/**
 * tl-17's acceptance: the claims that need two workshops, a real database and a
 * rendered page.
 *
 * The arithmetic and the routing rules are unit-tested (test/workshopOverview.test.ts).
 * What that cannot prove is what the spec actually promises: that switching hats
 * moves EVERY workshop-scoped surface, that a day email generated in one workshop
 * carries that workshop's name and only its roster, and that creating a workshop
 * lands the creator in setup holding chief_admin without a reload. Those are claims
 * about a live Postgres, a live IndexedDB and a browser, so they are checked in one.
 *
 * What is under test, in order:
 *   S1  a non-platform-owner admin's direct workshop insert is refused, verbatim
 *   S2  a platform owner's insert succeeds and the trigger seeds chief_admin
 *   S3  the workshop read is membership-scoped for an ordinary member
 *   B1  two memberships render a switcher, newest first, each labelled with its role
 *   B2  ONE membership renders no switcher at all — the evaluator frame is unchanged
 *   B3  switching moves a workshop-scoped surface (Setup names the other workshop)
 *   B4  switching off a detail route lands on that group's index, not a 404
 *   B5  /workshops shows one card per membership with that workshop's own numbers
 *   B6  an admin-elsewhere reaches /workshops while pointed at a workshop they only
 *       evaluate in — the whole reason the gate asks the ANYWHERE question
 *   B7  a member with no admin role anywhere is bounced off /workshops
 *   B8  Create renders for the platform owner and for nobody else
 *   B9  create → chief_admin → guided setup, with no page reload
 *   B10 a stored active workshop the user was removed from resolves to a real one
 *   B11 THE ACCEPTANCE: a day email in each workshop carries the right name and
 *       only that workshop's participants
 *   B12 /workshops does not widen a 390px phone
 *
 *   node scripts/tl17-multi-workshop.mjs --setup       # accounts, workshops, rosters
 *   npm run dev -- --port 5187                         # in another shell
 *   node scripts/tl17-multi-workshop.mjs
 *   node scripts/tl17-multi-workshop.mjs --teardown
 *
 * PORT 5187, not the repo default. A concurrent session left on 5180 would drive
 * somebody else's build and pass, which is the worst possible green.
 *
 * Playwright is deliberately not a dependency of this repo:
 *   npm i -D --no-save playwright && npx playwright install chromium
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const BASE = `http://localhost:${process.env.TL17_PORT ?? 5187}/`
const PROJECT = 'vdbirmjvjzfdgajwgowj'
const PASSWORD = 'tl17-Throwaway-Password-1!'

/** Two fixture workshops, so every "which workshop" question has a wrong answer available. */
const WS_A = 'a7170000-0000-4000-8000-000000000001'
const WS_B = 'a7170000-0000-4000-8000-000000000002'
const NAME_A = 'TL17 Alpha Workshop'
const NAME_B = 'TL17 Beta Workshop'
/** B starts later, so it must sort first in the switcher. */
const START_A = '2027-03-01'
const START_B = '2027-09-01'

const OWNER = 'tl17-owner@example.org'
const ADMIN_A = 'tl17-admin-a@example.org'
const CROSS = 'tl17-cross@example.org'
const EVAL_BOTH = 'tl17-eval-both@example.org'
const SOLO = 'tl17-solo@example.org'

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
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Rosters and questions differ BY NAME between the two workshops, deliberately.
 *
 * The bug this spec fixes is a silent one: `workshops[0]` produced a plausible
 * email with the wrong workshop's name on it. A fixture whose two workshops looked
 * alike would let exactly that bug pass, so every row here says which workshop it
 * belongs to in its own text.
 */
const ROSTER = {
  [WS_A]: ['Alpha One', 'Alpha Two', 'Alpha Three'],
  [WS_B]: ['Beta One', 'Beta Two'],
}

/** Explicit fixture ids. Derived ones collided: the two workshop uuids differ in
 *  their last character only, so slicing them produced one id for both. */
const KSA_ID = { [WS_A]: 'a7170000-0000-4000-8000-00000000fe01', [WS_B]: 'a7170000-0000-4000-8000-00000000fe02' }
const participantId = (wsId, i) =>
  `a7170000-0000-4000-8000-0000000${wsId === WS_A ? 'a' : 'b'}000${i}`

async function provision() {
  const serviceKey = await serviceRoleKey()
  await wipe(serviceKey)

  await sql(`
    insert into workshop (id, name, start_date, end_date, location)
    values ('${WS_A}', '${NAME_A}', '${START_A}', '2027-03-10', 'Alphaville'),
           ('${WS_B}', '${NAME_B}', '${START_B}', '2027-09-10', 'Betatown');
    select 1;`)

  for (const [wsId, names] of Object.entries(ROSTER)) {
    const values = names
      .map((n, i) => `('${participantId(wsId, i)}', '${wsId}', '${n}', '${n.toLowerCase().replace(' ', '.')}@example.org')`)
      .join(',')
    await sql(`insert into participant (id, workshop_id, name, registered_email) values ${values}; select 1;`)
    // One question per workshop. tl-08 made `ksa` workshop-scoped, and a shared
    // question would let the report layer read the other workshop's library
    // without anything failing.
    const tag = wsId === WS_A ? 'ALPHA' : 'BETA'
    await sql(`
      insert into ksa (id, workshop_id, code, short_label, description, evaluator_facing_prompt,
                       evidence_levels, cbc_subpoint_refs)
      values ('${KSA_ID[wsId]}', '${wsId}', '${tag}Q', '${tag} question',
              'A ${tag} question.', 'How did they do the ${tag} thing?',
              '{"0":"absent","1":"weak","2":"solid","3":"exemplary"}'::jsonb, array[]::text[]);
      select 1;`)
  }

  // Accounts. `assigned_role` is the workshop role the signup trigger grants in
  // `default_workshop_id`; the second membership (and the platform tier) is set
  // below in SQL, because neither is something a client may assert.
  const accounts = [
    [OWNER, 'admin', WS_A],
    [ADMIN_A, 'admin', WS_A],
    [CROSS, 'evaluator', WS_A],
    [EVAL_BOTH, 'evaluator', WS_A],
    [SOLO, 'evaluator', WS_A],
  ]
  for (const [email, role, ws] of accounts) {
    await sql(`
      insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
      values ('${email}', array['${role}'], '${role}', 'tl-17 fixture', '${ws}')
      on conflict (email) do update set allowed_roles = excluded.allowed_roles,
        assigned_role = excluded.assigned_role, default_workshop_id = excluded.default_workshop_id;
      select 1;`)
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, email_confirm: true, user_metadata: { name: email } }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok && !/already|registered|exists/i.test(JSON.stringify(body))) {
      throw new Error(`create ${email} -> ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
    }
  }

  /**
   * The platform tier and the second memberships.
   *
   * `platform_owner` on a throwaway account is the one elevation this harness
   * makes, and it is unavoidable: only that tier may insert a workshop, so the
   * create flow cannot be tested without one. It is scoped to an account that
   * teardown deletes, and the run tears its created workshops down itself.
   */
  await sql(`
    update app_user set role = 'platform_owner' where email = '${OWNER}';
    -- Second memberships, written in SQL because workshop_member has no client
    -- write path (tl-01) and the tl-02 RPCs are not what is under test here.
    insert into workshop_member (workshop_id, app_user_id, role)
    select '${WS_B}', u.id, 'chief_admin' from app_user u where u.email = '${OWNER}'
    on conflict do nothing;
    insert into workshop_member (workshop_id, app_user_id, role)
    select '${WS_B}', u.id, 'admin' from app_user u where u.email = '${CROSS}'
    on conflict do nothing;
    insert into workshop_member (workshop_id, app_user_id, role)
    select '${WS_B}', u.id, 'evaluator' from app_user u where u.email = '${EVAL_BOTH}'
    on conflict do nothing;
    -- The owner is chief_admin in A too, so both cards offer every action.
    update workshop_member set role = 'chief_admin'
      where workshop_id = '${WS_A}'
        and app_user_id = (select id from app_user where email = '${OWNER}');
    select 1;`)

  console.log('setup done')
}

/**
 * Prefix-scoped, never a truncate.
 *
 * Two other harnesses share this project. Deleting on the `tl17-` prefix and on
 * the two fixture workshop ids is what lets them run beside each other; anything
 * broader would wipe a concurrent run's state mid-flight.
 */
async function wipe(serviceKey) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  })
  const { users = [] } = await res.json()
  for (const u of users) {
    if (!u.email?.startsWith('tl17-')) continue
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    })
  }
  await sql(`
    delete from workshop_member where workshop_id in ('${WS_A}', '${WS_B}');
    delete from participant where workshop_id in ('${WS_A}', '${WS_B}');
    delete from activity_ksa where ksa_id in (select id from ksa where workshop_id in ('${WS_A}','${WS_B}'));
    delete from ksa where workshop_id in ('${WS_A}', '${WS_B}');
    delete from workshop_setting where workshop_id in ('${WS_A}', '${WS_B}');
    delete from setup_change_log where workshop_id in ('${WS_A}', '${WS_B}');
    -- Workshops the RUN created through the app, not only the two seeded here.
    delete from workshop_member where workshop_id in (select id from workshop where name like 'TL17%');
    delete from workshop where name like 'TL17%' or id in ('${WS_A}', '${WS_B}');
    delete from workshop_member wm using app_user u
      where u.id = wm.app_user_id and u.email like 'tl17-%@example.org';
    delete from app_user where email like 'tl17-%@example.org';
    delete from auth.users where email like 'tl17-%@example.org';
    delete from role_allowlist where email like 'tl17-%@example.org';
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
// S: what the database refuses, checked on the wire
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

const CREATED_BY_SESSION = 'a7170000-0000-4000-8000-0000000000aa'

const adminToken = await token(ADMIN_A)
const ownerToken = await token(OWNER)
const evalToken = await token(EVAL_BOTH)

{
  // S1. The Create button is hidden from a non-owner; this is what happens if
  // somebody ignores that and posts anyway. A UI-only check would prove nothing.
  const r = await rest('workshop', adminToken, {
    method: 'POST',
    body: JSON.stringify({ id: CREATED_BY_SESSION, name: 'TL17 Forged Workshop' }),
  })
  check(
    r.status === 401 || r.status === 403,
    'S1 a non-platform-owner admin cannot insert a workshop',
    `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`,
  )
}

{
  // Cleared first, so a run that died before its own cleanup does not make the
  // next one fail on a duplicate key. A harness that only works once is a
  // harness nobody runs twice.
  await sql(`
    delete from workshop_member where workshop_id = '${CREATED_BY_SESSION}';
    delete from workshop where id = '${CREATED_BY_SESSION}';
    select 1;`)

  // S2. The insert succeeds AND the AFTER INSERT trigger seeds the creator as
  // chief_admin. The second half is what the create flow's membership re-fetch
  // depends on, so proving only the insert would prove the easy half.
  const r = await rest('workshop', ownerToken, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ id: CREATED_BY_SESSION, name: 'TL17 Session-Created Workshop' }),
  })
  const seeded = await sql(`
    select role from workshop_member
    where workshop_id = '${CREATED_BY_SESSION}'
      and app_user_id = (select id from app_user where email = '${OWNER}');`)
  check(
    r.status === 201 && seeded?.[0]?.role === 'chief_admin',
    'S2 a platform owner inserts, and the trigger makes them chief admin',
    `${r.status} · role=${seeded?.[0]?.role}`,
  )
  // Also the tl-02 fix in the direction tl-17 needs it: the row comes BACK.
  check(
    Array.isArray(r.body) && r.body[0]?.id === CREATED_BY_SESSION,
    'S2b the created row is returned to its creator (the tl-02 workshop_select fix)',
    JSON.stringify(r.body).slice(0, 100),
  )
  // Removed immediately. It is a third membership for OWNER, and the browser
  // checks below assert an exact switcher length — a fixture step that quietly
  // widens the fixture is how a harness starts grading the wrong thing.
  await sql(`
    delete from workshop_member where workshop_id = '${CREATED_BY_SESSION}';
    delete from workshop where id = '${CREATED_BY_SESSION}';
    select 1;`)
}

{
  // S3. An ordinary member reads their own workshops and nothing else, which is
  // what makes the client's switcher list a display of the truth rather than a
  // filter over it.
  const r = await rest('workshop?select=id,name', evalToken)
  const ids = (r.body ?? []).map((w) => w.id)
  check(
    ids.includes(WS_A) && ids.includes(WS_B) && !ids.includes(CREATED_BY_SESSION),
    'S3 workshop reads are membership-scoped for an ordinary member',
    `saw ${ids.length}`,
  )
}

// ---------------------------------------------------------------------------
// B: the rendered app
// ---------------------------------------------------------------------------

const { chromium } = await import('playwright')
const browser = await chromium.launch()
const pageErrors = []

async function device(email, { viewport } = {}) {
  const ctx = await browser.newContext({ viewport: viewport ?? { width: 1400, height: 1000 } })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => pageErrors.push(`${email}: ${String(e)}`))
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.getByLabel(/email/i).first().fill(email)
  await p.getByLabel(/password/i).first().fill(PASSWORD)
  await p.getByRole('button', { name: /sign in/i }).first().click()
  await p.waitForSelector('.shell__brand, .pagehead__title', { timeout: 25000 })
  // The reference pull has to land before any workshop NAME is on screen.
  await p.waitForFunction(
    (name) => document.body.innerText.includes(name),
    NAME_A,
    { timeout: 25000 },
  ).catch(() => {})
  return p
}

/**
 * The switcher, wherever this viewport puts it.
 *
 * There are two copies of one component: the header's, which CSS hides below
 * 900px, and the drawer's, which is what a phone gets. The desktop sessions below
 * drive the header copy, because the hamburger that opens the drawer is itself
 * hidden above 900px on a wide page — reaching for the drawer here is what made
 * the first run of this harness time out rather than fail.
 */
const SWITCHER = 'select.switcher--header'

const switcherOptions = (page, selector = SWITCHER) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)
    return el ? [...el.options].map((o) => o.textContent.trim()) : null
  }, selector)

/** Any switcher at all, for the presence/absence claims. */
const anySwitcher = (page) =>
  page.evaluate(() => document.querySelectorAll('select.switcher').length)

{
  // B1 + B2 together, because the claim is a contrast: the control appears for two
  // memberships and is ABSENT for one, not merely disabled.
  const owner = await device(OWNER)
  const opts = await switcherOptions(owner)
  check(
    Array.isArray(opts) && opts.length === 2,
    'B1 two memberships render a switcher with both workshops',
    JSON.stringify(opts),
  )
  check(
    opts?.[0]?.includes(NAME_B) && opts?.[1]?.includes(NAME_A),
    'B1b ordered by start date, newest first',
    `${opts?.[0]} then ${opts?.[1]}`,
  )
  check(
    opts?.every((o) => /\((chief admin|admin|evaluator)\)/.test(o)),
    'B1c each option says which hat you wear in that workshop',
    JSON.stringify(opts),
  )

  // The phone copy, which is the one that decides whether a phone admin is
  // stranded. The header copy is CSS-hidden at this width, so finding a switcher
  // here means finding the drawer's.
  const phone = await owner.context().newPage()
  await phone.setViewportSize({ width: 390, height: 844 })
  await phone.goto(BASE, { waitUntil: 'domcontentloaded' })
  await phone.waitForSelector('.shell__brand', { timeout: 20000 })
  const headerVisible = await phone.locator(SWITCHER).first().isVisible().catch(() => false)
  await phone.getByRole('button', { name: /open navigation menu/i }).first().click()
  await phone.waitForSelector('.drawer', { timeout: 5000 })
  const drawerOpts = await switcherOptions(phone, '.drawer select.switcher')
  check(
    !headerVisible && Array.isArray(drawerOpts) && drawerOpts.length === 2,
    'B1d on a 390px phone the switcher is in the drawer, not the header',
    `header visible=${headerVisible} drawer=${JSON.stringify(drawerOpts)}`,
  )
  await phone.close()
  await owner.context().close()

  const solo = await device(SOLO)
  check((await anySwitcher(solo)) === 0, 'B2 one membership renders no switcher at all')
  await solo.context().close()
}

const owner = await device(OWNER)

async function switchTo(page, name) {
  const value = await page.evaluate(
    ([sel, n]) => [...document.querySelector(sel).options].find((o) => o.textContent.includes(n))?.value,
    [SWITCHER, name],
  )
  if (!value) throw new Error(`no switcher option matching ${name}`)
  await page.selectOption(SWITCHER, value)
}

{
  // B3. Setup's meta line names the active workshop, so it is the cheapest honest
  // probe that the switch reached a workshop-scoped surface rather than only the
  // header.
  await owner.goto(`${BASE}admin/setup`, { waitUntil: 'domcontentloaded' })
  await owner.waitForSelector('.pagehead__meta', { timeout: 20000 })
  // Point at Alpha explicitly first. With no stored selection the app resolves to
  // memberships[0], whose order is the server's, so a test that ASSUMED it started
  // on Alpha would pass or fail on row order rather than on the switch.
  await switchTo(owner, NAME_A)
  await owner.waitForFunction(
    (n) => document.querySelector('.pagehead__meta')?.innerText.includes(n),
    NAME_A,
    { timeout: 15000 },
  )
  const before = await owner.locator('.pagehead__meta').first().innerText()
  await switchTo(owner, NAME_B)
  await owner.waitForFunction(
    (n) => document.querySelector('.pagehead__meta')?.innerText.includes(n),
    NAME_B,
    { timeout: 15000 },
  ).catch(() => {})
  const after = await owner.locator('.pagehead__meta').first().innerText()
  check(
    before.includes(NAME_A) && after.includes(NAME_B),
    'B3 switching moves a workshop-scoped surface',
    `${before.trim()} → ${after.trim()}`,
  )
}

{
  // B4. The detail-route rule, on a real route with a real id.
  const pid = await owner.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('cairn')
        req.onsuccess = () => {
          const tx = req.result.transaction('participants', 'readonly')
          const all = tx.objectStore('participants').getAll()
          all.onsuccess = () => resolve(all.result.find((p) => p.name.startsWith('Beta'))?.id ?? null)
          all.onerror = () => resolve(null)
        }
        req.onerror = () => resolve(null)
      }),
  )
  await owner.goto(`${BASE}admin/participants/${pid}`, { waitUntil: 'domcontentloaded' })
  await owner.waitForSelector('.pagehead__title', { timeout: 20000 })
  await switchTo(owner, NAME_A)
  await owner.waitForFunction(() => !location.pathname.match(/\/admin\/participants\/.+/), null, {
    timeout: 15000,
  }).catch(() => {})
  const path = new URL(owner.url()).pathname.replace(/^\/+/, '/')
  check(
    path.endsWith('/admin/participants'),
    'B4 switching off a detail route lands on that group’s index',
    path,
  )
}

{
  // B5. One card per membership, each carrying its OWN roster count. The two
  // rosters are different sizes on purpose: equal ones would let a card that
  // reads the active workshop's numbers pass.
  await owner.goto(`${BASE}workshops`, { waitUntil: 'domcontentloaded' })
  await owner.waitForSelector('.pagehead__title', { timeout: 20000 })
  const cards = await owner.evaluate(() =>
    [...document.querySelectorAll('.grid .card')].map((c) => ({
      title: c.querySelector('h2')?.innerText.trim(),
      tiles: [...c.querySelectorAll('.tile')].map((t) => ({
        label: t.querySelector('.tile__label')?.innerText.trim(),
        value: t.querySelector('.tile__value')?.innerText.trim(),
      })),
    })),
  )
  const roster = (title) =>
    cards.find((c) => c.title === title)?.tiles.find((t) => /roster/i.test(t.label))?.value
  check(cards.length === 2, 'B5 one card per membership', JSON.stringify(cards.map((c) => c.title)))
  check(
    roster(NAME_A) === String(ROSTER[WS_A].length) && roster(NAME_B) === String(ROSTER[WS_B].length),
    'B5b each card carries its own roster count, not the active workshop’s',
    `${NAME_A}=${roster(NAME_A)} ${NAME_B}=${roster(NAME_B)}`,
  )
  check(
    await owner.getByRole('button', { name: /create a workshop/i }).first().isVisible(),
    'B8 the platform owner is offered Create',
  )
}

{
  // B12. tl-20's audit harness lives on another branch and grades a route table
  // this branch does not have, so the new page checks its own phone width here.
  // 390px is the iPhone the evaluators actually carry.
  const phone = await owner.context().newPage()
  await phone.setViewportSize({ width: 390, height: 844 })
  await phone.goto(`${BASE}workshops`, { waitUntil: 'domcontentloaded' })
  await phone.waitForSelector('.pagehead__title', { timeout: 20000 })
  const width = await phone.evaluate(() => ({
    layout: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }))
  check(
    width.layout <= width.viewport,
    'B12 /workshops does not widen a 390px phone',
    `scrollWidth ${width.layout} vs viewport ${width.viewport}`,
  )
  await phone.close()
}

{
  // B11. THE ACCEPTANCE. Evidence is seeded into BOTH workshops, then a batch is
  // generated in each, and each batch is judged on the two things `workshops[0]`
  // used to get wrong: whose name is on it, and whose people are in it.
  const seed = async (page, wsId, code) =>
    page.evaluate(
      async ([ws, ksaCode]) => {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('cairn')
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        const all = (store) =>
          new Promise((resolve) => {
            const tx = db.transaction(store, 'readonly')
            const r = tx.objectStore(store).getAll()
            r.onsuccess = () => resolve(r.result)
            r.onerror = () => resolve([])
          })
        const put = (store, rows) =>
          new Promise((resolve, reject) => {
            const tx = db.transaction(store, 'readwrite')
            for (const row of rows) tx.objectStore(store).put(row)
            tx.oncomplete = () => resolve(true)
            tx.onerror = () => reject(tx.error)
          })

        const roster = (await all('participants')).filter((p) => p.workshop_id === ws)
        const capture = `tl17-cap-${ws}`
        await put('evaluations', [
          {
            client_id: capture,
            evaluator_email: 'tl17-owner@example.org',
            activity_id: null,
            workshop_id: ws,
            source_language: 'English',
            answers: {},
            source_text: 'fixture capture',
            participant_scope: [],
            attestation: true,
            ruleset_version: null,
            edit_history: [],
            created_at: '2027-01-01T00:00:00.000Z',
            updated_at: '2027-01-01T00:00:00.000Z',
            // 'synced' so the outbox never pushes a fixture into the live tables.
            sync_status: 'synced',
          },
        ])
        const observations = roster.map((p, i) => ({
          id: `tl17-obs-${ws}-${i}`,
          capture_client_id: capture,
          workshop_id: ws,
          participant_id: p.id,
          participant_name: p.name,
          ksa_code: ksaCode,
          text: `${p.name} did the thing`,
          source_excerpt: 'fixture excerpt',
          evidence_designation: 2,
          sentiment_flag: 'neutral',
          confidence: 'high',
          needs_review: false,
          origin: 'individual',
          imported_at: '2027-01-01T00:00:00.000Z',
          evaluator_email: 'tl17-owner@example.org',
          sync_status: 'synced',
        }))
        await put('observations', observations)
        // Two confirmations, because the default threshold is 2 and an
        // unconfirmed observation is not evidence the report layer will print.
        await put(
          'verifications',
          observations.flatMap((o) =>
            ['v1@example.org', 'v2@example.org'].map((who) => ({
              id: `${o.id}::${who}`,
              observation_id: o.id,
              capture_client_id: capture,
              evaluator_email: who,
              decision: 'confirm',
              adjusted_designation: null,
              note: null,
              at: '2027-01-01T00:00:00.000Z',
              sync_status: 'synced',
            })),
          ),
        )
        return { roster: roster.length, observations: observations.length }
      },
      [wsId, code],
    )

  const readDrafts = (page) =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open('cairn')
          req.onsuccess = () => {
            const tx = req.result.transaction('docDrafts', 'readonly')
            const r = tx.objectStore('docDrafts').getAll()
            r.onsuccess = () =>
              resolve(
                r.result
                  .filter((d) => d.kind === 'participant_email')
                  .map((d) => ({
                    workshopId: d.workshopId,
                    subject: d.subject,
                    title: d.title,
                    to: (d.recipients ?? []).map((x) => x.email),
                  })),
              )
            r.onerror = () => resolve([])
          }
          req.onerror = () => resolve([])
        }),
    )

  const generateIn = async (name, wsId, code) => {
    await switchTo(owner, name)
    await owner.goto(`${BASE}outgoing`, { waitUntil: 'domcontentloaded' })
    await owner.waitForSelector('.pagehead__title', { timeout: 20000 })
    const seeded = await seed(owner, wsId, code)
    // Reload so the freshly-seeded rows are what the generator reads.
    await owner.reload({ waitUntil: 'domcontentloaded' })
    await owner.waitForSelector('.pagehead__title', { timeout: 20000 })
    await owner.getByRole('button', { name: /^participant emails$/i }).first().click()
    await owner.waitForTimeout(1500)
    return { seeded, drafts: await readDrafts(owner) }
  }

  // Clear anything a previous run left, so the assertion below is about THIS run.
  await owner.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('cairn')
        req.onsuccess = () => {
          const tx = req.result.transaction('docDrafts', 'readwrite')
          tx.objectStore('docDrafts').clear()
          tx.oncomplete = () => resolve(true)
          tx.onerror = () => resolve(false)
        }
        req.onerror = () => resolve(false)
      }),
  )

  const a = await generateIn(NAME_A, WS_A, 'ALPHAQ')
  const forA = a.drafts.filter((d) => d.workshopId === WS_A)
  check(
    forA.length === ROSTER[WS_A].length && a.drafts.length === forA.length,
    'B11 a batch in Alpha covers Alpha’s roster and nothing else',
    `${a.drafts.length} drafts, ${forA.length} stamped Alpha`,
  )
  check(
    forA.every((d) => d.subject.includes(NAME_A)) &&
      forA.every((d) => d.title.startsWith('Alpha')),
    'B11b every Alpha email carries Alpha’s name and an Alpha participant',
    forA.map((d) => d.title).join(', '),
  )

  const b = await generateIn(NAME_B, WS_B, 'BETAQ')
  const forB = b.drafts.filter((d) => d.workshopId === WS_B)
  check(
    forB.length === ROSTER[WS_B].length,
    'B11c a batch in Beta covers Beta’s roster',
    `${forB.length} of ${ROSTER[WS_B].length}`,
  )
  check(
    forB.every((d) => d.subject.includes(NAME_B) && d.title.startsWith('Beta')),
    'B11d every Beta email carries Beta’s name and a Beta participant',
    forB.map((d) => d.title).join(', '),
  )
  check(
    !forB.some((d) => d.title.startsWith('Alpha')) && !forA.some((d) => d.title.startsWith('Beta')),
    'B11e neither batch leaked a participant from the other workshop',
  )
}

{
  // B9. The create flow, end to end, as the platform owner.
  const NEW_NAME = `TL17 Created Through The Flow`
  await owner.goto(`${BASE}workshops`, { waitUntil: 'domcontentloaded' })
  await owner.waitForSelector('.pagehead__title', { timeout: 20000 })
  await owner.getByRole('button', { name: /create a workshop/i }).first().click()
  await owner.getByLabel(/^name$/i).first().fill(NEW_NAME)
  await owner.getByLabel(/^starts$/i).first().fill('2028-01-05')
  await owner.getByLabel(/^ends$/i).first().fill('2028-01-12')
  await owner.getByLabel(/^location$/i).first().fill('Createville')
  await owner.getByRole('button', { name: /create and set up/i }).first().click()
  await owner.waitForFunction(() => location.pathname.endsWith('/admin/setup'), null, {
    timeout: 25000,
  }).catch(() => {})

  const path = new URL(owner.url()).pathname
  check(path.endsWith('/admin/setup'), 'B9 create lands in guided setup', path)

  // Waited for rather than read immediately: the route changes a tick before the
  // new page's header paints, so reading straight after the navigation caught
  // /workshops' own meta line and reported a flake as a failure.
  await owner
    .waitForFunction(
      (n) => document.querySelector('.pagehead__meta')?.innerText.includes(n),
      NEW_NAME,
      { timeout: 15000 },
    )
    .catch(() => {})
  const meta = await owner.locator('.pagehead__meta').first().innerText().catch(() => '')
  check(meta.includes(NEW_NAME), 'B9b setup is pointed at the workshop just created', meta.trim())

  // Without a reload: the switcher must already know about it, which it can only
  // do if the membership re-fetch saw the trigger's row.
  const opts = await switcherOptions(owner)
  check(
    opts?.some((o) => o.includes(NEW_NAME) && /chief admin/.test(o)),
    'B9c the creator holds chief admin in it, with no page reload',
    JSON.stringify(opts),
  )

  const row = await sql(`
    select w.name, wm.role from workshop w
    join workshop_member wm on wm.workshop_id = w.id
    join app_user u on u.id = wm.app_user_id
    where w.name = '${NEW_NAME}' and u.email = '${OWNER}';`)
  check(
    row?.[0]?.role === 'chief_admin',
    'B9d Postgres agrees: the row is there and the creator is its chief admin',
    JSON.stringify(row),
  )
}

{
  // B6. The whole reason /workshops asks the ANYWHERE question. This account is
  // an evaluator in Alpha (its default workshop) and an admin in Beta.
  const cross = await device(CROSS)
  await cross.goto(`${BASE}workshops`, { waitUntil: 'domcontentloaded' })
  await cross.waitForSelector('.pagehead__title, .card', { timeout: 20000 })
  const path = new URL(cross.url()).pathname
  const title = await cross.locator('.pagehead__title').first().innerText().catch(() => '')
  check(
    path.endsWith('/workshops') && /workshops/i.test(title),
    'B6 an admin-elsewhere reaches /workshops while pointed at a workshop they only evaluate in',
    `${path} · ${title.trim()}`,
  )
  const navLink = await cross.locator('nav a[href$="/workshops"]').count()
  check(navLink > 0, 'B6b and the nav offers the link rather than hiding it', String(navLink))
  await cross.context().close()
}

{
  // B7. No admin role anywhere: no page, and no link to it.
  const ev = await device(EVAL_BOTH)
  await ev.goto(`${BASE}workshops`, { waitUntil: 'domcontentloaded' })
  await ev.waitForTimeout(1500)
  const path = new URL(ev.url()).pathname
  const bodyText = await ev.evaluate(() => document.body.innerText)
  check(
    !path.endsWith('/workshops') && !/create a workshop/i.test(bodyText),
    'B7 a member with no admin role anywhere gets no /workshops content',
    path,
  )
  check(
    (await ev.locator('nav a[href$="/workshops"]').count()) === 0,
    'B7b and no nav link to it',
  )
  await ev.context().close()
}

{
  // B8b. An admin who is not the platform owner: the page, but no Create.
  const admin = await device(ADMIN_A)
  await admin.goto(`${BASE}workshops`, { waitUntil: 'domcontentloaded' })
  await admin.waitForSelector('.pagehead__title', { timeout: 20000 })
  const createCount = await admin.getByRole('button', { name: /create a workshop/i }).count()
  check(createCount === 0, 'B8b a non-owner admin sees the page and no Create button at all')

  // B10. A stored selection the user holds no membership in is a hint, not a claim.
  await admin.evaluate((forged) => localStorage.setItem('cairn.active_workshop_id', forged), WS_B)
  await admin.goto(`${BASE}admin/setup`, { waitUntil: 'domcontentloaded' })
  await admin.waitForSelector('.pagehead__meta', { timeout: 20000 })
  const meta = await admin.locator('.pagehead__meta').first().innerText()
  const stored = await admin.evaluate(() => localStorage.getItem('cairn.active_workshop_id'))
  check(
    meta.includes(NAME_A) && !meta.includes(NAME_B) && stored === WS_A,
    'B10 a stored workshop the user does not belong to resolves to one they do',
    `${meta.trim()} · stored=${stored === WS_A ? 'corrected' : stored}`,
  )
  await admin.context().close()
}

check(pageErrors.length === 0, 'no uncaught page errors in any session', pageErrors.join(' | ').slice(0, 200))

await browser.close()

// The run created a workshop through the app. Remove it here rather than leaving
// it for --teardown, so a run that is never torn down does not leave a workshop
// in the live deployment.
// Matched on the CREATED names only. An earlier version of this used the `TL17%`
// prefix and deleted the memberships of the two fixture workshops along with the
// one the run made, which left the next run signing in to "you have not been added
// to a workshop yet". A prefix wide enough to be convenient is wide enough to eat
// the fixture.
await sql(`
  delete from workshop_member where workshop_id in
    (select id from workshop where name like 'TL17 Created%' or name like 'TL17 Session-Created%');
  delete from workshop where name like 'TL17 Created%' or name like 'TL17 Session-Created%';
  select 1;`)

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
