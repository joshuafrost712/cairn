/**
 * tl-12's acceptance in a browser: the claims only a rendered page can prove.
 *
 * The permissions are enforced in Postgres and proved on the wire by
 * scripts/tl12-session-tests.mjs. That harness cannot say whether anybody can
 * actually DO any of it, and three of this spec's requirements are exactly that
 * kind of claim:
 *
 *   B1  an evaluator opens somebody's background from the CAPTURE screen without
 *       leaving it, and sees the compact card rather than the full one
 *   B2  a withheld profile shows the REASON, not an empty drawer — the failure the
 *       whole `denial` path exists to prevent, and one no unit test can see
 *   B3  an evaluator is offered no way to edit a colleague's background
 *   B4  an administrator edits one, and it survives a reload
 *   B5  the derived track history is visibly distinct from the self-reported one
 *   B6  merging opens the change dialog, and the dialog does not claim evidence is
 *       destroyed
 *   B7  neither the drawer nor the merge panel widens a 390px phone
 *
 *   node scripts/tl12-profiles.mjs --setup     # accounts, a workshop, two people
 *   npm run dev -- --port 5192                 # in another shell
 *   node scripts/tl12-profiles.mjs
 *   node scripts/tl12-profiles.mjs --teardown
 *
 * PORT 5192, overridable with TL12_PORT. A concurrent session left on the repo
 * default would drive somebody else's build and pass, which is the worst possible
 * green.
 *
 * Playwright is deliberately not a dependency of this repo:
 *   npm i -D --no-save playwright && npx playwright install chromium
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const BASE = `http://localhost:${process.env.TL12_PORT ?? 5192}/`
const PROJECT = 'vdbirmjvjzfdgajwgowj'
const PASSWORD = 'tl12-Throwaway-Password-1!'

const WS = 'a6120000-0000-4000-8000-000000000001'
const WS_PRIOR = 'a6120000-0000-4000-8000-000000000002'
const WS_NAME = 'TL12 Profiles Workshop'
const PRIOR_NAME = 'TL12 Epistles 2025'

const CHIEF = 'tl12-ui-chief@example.org'
const EVALUATOR = 'tl12-ui-evaluator@example.org'

/** The participant with a background, present in both workshops. */
const SUBJECT_PERSON = 'a6120000-0000-4000-8000-0000000000a1'
const SUBJECT_HERE = 'a6120000-0000-4000-8000-0000000000b1'
const SUBJECT_PRIOR = 'a6120000-0000-4000-8000-0000000000b2'
/** A second participant whose profile is admins-only, for the denial path. */
const WITHHELD_PERSON = 'a6120000-0000-4000-8000-0000000000a2'
const WITHHELD_HERE = 'a6120000-0000-4000-8000-0000000000b3'
/** A duplicate of the subject, for the merge panel. */
const DUPLICATE_PERSON = 'a6120000-0000-4000-8000-0000000000a3'
const DUPLICATE_HERE = 'a6120000-0000-4000-8000-0000000000b4'
const ACTIVITY = 'a6120000-0000-4000-8000-0000000000c1'
const GOAL = 'a6120000-0000-4000-8000-0000000000d1'
const KSA = 'a6120000-0000-4000-8000-0000000000e1'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
const readEnv = (key) =>
  env.split('\n').find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1).trim()
const SUPABASE_URL = readEnv('VITE_SUPABASE_URL')

const accessToken = execFileSync('/bin/zsh', [
  '-c',
  'set -a; . ~/.claude/secrets/supabase.env; set +a; printf %s "$SUPABASE_ACCESS_TOKEN"',
]).toString()

async function mgmt(path, init = {}) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`management ${path} -> ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}
const sql = (query) => mgmt('/database/query', { method: 'POST', body: JSON.stringify({ query }) })

async function serviceRoleKey() {
  const keys = await mgmt('/api-keys?reveal=true')
  const key = keys.find((k) => k.name === 'service_role')?.api_key
  if (!key) throw new Error('could not read the service_role key')
  return key
}

const results = []
const record = (verdict, label, outcome) => {
  results.push({ verdict, label, outcome })
  console.log(`${verdict} | ${label.slice(0, 70).padEnd(70)} | ${outcome}`)
}
const check = (label, condition, detail = '') =>
  record(condition ? 'PASS' : 'FAIL', label, detail)

async function teardown() {
  const serviceKey = await serviceRoleKey()
  const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  }).then((r) => r.json())
  for (const u of list.users ?? []) {
    if (!u.email?.startsWith('tl12-ui-')) continue
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    })
  }
  await sql(`
    delete from activity_ksa where activity_id = '${ACTIVITY}';
    delete from ksa where workshop_id in ('${WS}', '${WS_PRIOR}');
    delete from goal where workshop_id in ('${WS}', '${WS_PRIOR}');
    delete from activity where workshop_id in ('${WS}', '${WS_PRIOR}');
    delete from participant where workshop_id in ('${WS}', '${WS_PRIOR}');
    delete from workshop_member where workshop_id in ('${WS}', '${WS_PRIOR}');
    delete from app_user where email like 'tl12-ui-%';
    -- tl-12: the app_user_link_person trigger mints a person row for every
    -- account, so a teardown that removes the account and stops there leaves one
    -- behind in the live deployment. Deleting a person cascades their profile.
    delete from person where primary_email like 'tl12-ui-%';
    delete from role_allowlist where email like 'tl12-ui-%';
    delete from workshop where id in ('${WS}', '${WS_PRIOR}');
    delete from auth.identities where identity_data->>'email' like 'tl12-ui-%';
    delete from auth.users where email like 'tl12-ui-%';
    delete from person where id in ('${SUBJECT_PERSON}', '${WITHHELD_PERSON}', '${DUPLICATE_PERSON}')
       or primary_email like 'tl12-ui-%';
    select 1;`)
}

async function setup() {
  await teardown()
  const serviceKey = await serviceRoleKey()

  await sql(`
    insert into workshop (id, name, start_date, end_date, location) values
      ('${WS}',       '${WS_NAME}',   '2027-11-01', '2027-11-10', 'Nowhere'),
      ('${WS_PRIOR}', '${PRIOR_NAME}','2025-03-02', '2025-03-12', 'Elsewhere');
    insert into goal (id, workshop_id, code, title, sort_order)
      values ('${GOAL}', '${WS}', 'G1', 'TL12 Goal', 0);
    insert into ksa (id, workshop_id, goal_id, code, short_label, description, evaluator_facing_prompt, cbc_subpoint_refs)
      values ('${KSA}', '${WS}', '${GOAL}', 'Q1', 'TL12 question',
              'A fixture question.', 'How did they do?', array[]::text[]);
    insert into activity (id, workshop_id, title, day, sort_order)
      values ('${ACTIVITY}', '${WS}', 'TL12 Fixture Session', '2027-11-01', 0);
    insert into activity_ksa (activity_id, ksa_id, sort_order)
      values ('${ACTIVITY}', '${KSA}', 0);

    insert into person (id, display_name, primary_email) values
      ('${SUBJECT_PERSON}',   'TL12 Amos Khokhar', null),
      ('${WITHHELD_PERSON}',  'TL12 Bina Sitorus',  null),
      ('${DUPLICATE_PERSON}', 'TL12 Amos Kokhar',   null);

    insert into participant (id, workshop_id, name, person_id) values
      ('${SUBJECT_HERE}',   '${WS}',       'TL12 Amos Khokhar', '${SUBJECT_PERSON}'),
      ('${SUBJECT_PRIOR}',  '${WS_PRIOR}', 'TL12 Amos Khokhar', '${SUBJECT_PERSON}'),
      ('${WITHHELD_HERE}',  '${WS}',       'TL12 Bina Sitorus',  '${WITHHELD_PERSON}'),
      ('${DUPLICATE_HERE}', '${WS}',       'TL12 Amos Kokhar',   '${DUPLICATE_PERSON}');

    insert into person_profile
      (person_id, headline, certifications, experience_areas, prior_trainings, visibility) values
      ('${SUBJECT_PERSON}', 'TL12 consultant-in-training', array['CBC level 2'],
       array['Psalms drafting'],
       '[{"label": "TL12 CLAT course, Nairobi", "year": "2023"}]'::jsonb, 'workshop'),
      ('${WITHHELD_PERSON}', 'TL12 withheld headline', array['CBC level 1'],
       array[]::text[], '[]'::jsonb, 'admins');
    select 1;`)

  for (const [email, role] of [[CHIEF, 'chief_admin'], [EVALUATOR, 'evaluator']]) {
    await sql(`
      insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
      values ('${email}', array['${role}'], '${role}', 'tl-12 ui test', '${WS}')
      on conflict (email) do update set assigned_role = excluded.assigned_role,
        allowed_roles = excluded.allowed_roles, default_workshop_id = excluded.default_workshop_id;
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
        user_metadata: { name: `TL12 ${role}` },
      }),
    })
    if (!res.ok) throw new Error(`create ${email} -> ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
  // The chief admin also runs the prior workshop, so the derived history is
  // readable to them and the merge's both-workshops rule is satisfiable.
  await sql(`
    insert into workshop_member (workshop_id, app_user_id, role)
    select '${WS_PRIOR}', id, 'chief_admin' from app_user where email = '${CHIEF}'
    on conflict (workshop_id, app_user_id) do update set role = excluded.role;
    select 1;`)
}

if (process.argv.includes('--setup')) {
  await setup()
  console.log(`tl-12 UI fixtures ready. Start the app on ${BASE} and re-run without --setup.`)
  process.exit(0)
}
if (process.argv.includes('--teardown')) {
  await teardown()
  console.log('tl-12 UI fixtures removed.')
  process.exit(0)
}

// Re-provision on every run. B4 EDITS a profile, so a second run against the
// fixtures the last one left behind reads its own previous edit as the starting
// state — which is how "the compact card carries the headline" failed while the
// app was working perfectly. Cheap, and it makes the run idempotent.
await setup()

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
  // The active workshop is per-device localStorage; point it at the fixture.
  // The key is `cairn.active_workshop_id` and it is VALIDATED against the caller's
  // memberships on load (tl-01), so setting it here only works because these
  // fixture accounts really are members of WS.
  await p.evaluate((id) => localStorage.setItem('cairn.active_workshop_id', id), WS)
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.shell__brand, .pagehead__title', { timeout: 25000 })
  return p
}

/**
 * Open one person's Background control and wait for the drawer.
 *
 * Targeted by ROW rather than by `.first()`, which was the first version and was
 * wrong in a way that produced confident nonsense: /admin/participants renders a
 * Background button on every row, so `.first()` opened whichever person happened
 * to sort first — usually one of the 22 real participants with no person record —
 * and then reported on them.
 */
async function openDrawerForRow(page, name) {
  await page
    .getByRole('row', { name: new RegExp(name, 'i') })
    .first()
    .getByRole('button', { name: /^Background$/i })
    .click()
  await settle(page)
  return page.locator('[role="dialog"]').first()
}

/** The capture screen's control, which carries the person's name in its label. */
async function openDrawer(page, name) {
  await page.getByRole('button', { name: new RegExp(`Background.*${name}`, 'i') }).first().click()
  await settle(page)
  return page.locator('[role="dialog"]').first()
}

/**
 * Wait for the drawer AND for its content to stop being "Loading…".
 *
 * The card is a network read, so reading `innerText` the instant the dialog
 * appears samples the loading state and reports on it. That is the harness half of
 * a bug that was also real: before this run the drawer showed "no background has
 * been recorded" during that window rather than a spinner, so the flicker said
 * something false rather than nothing.
 */
async function settle(page) {
  await page.waitForSelector('[role="dialog"]', { timeout: 15000 })
  await page.waitForFunction(
    () => {
      const d = document.querySelector('[role="dialog"]')
      return Boolean(d) && !/Loading…/.test(d.textContent ?? '')
    },
    { timeout: 15000 },
  )
}

const noOverflow = async (page) =>
  page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    // Checking only scrollWidth <= innerWidth is a false green when BOTH grow,
    // which is tl-19's lesson; the layout viewport is the honest measure.
    layout: document.documentElement.clientWidth,
  }))

try {
  // ---- B1/B5: the evaluator, from the capture screen ------------------------
  {
    const page = await device(EVALUATOR)
    // `/capture/:clientId` takes a DRAFT's client id, not an activity id: a capture
    // is started from Home, which creates the draft. Navigating straight to the
    // activity id renders an empty capture and the wait times out on nothing.
    await page.waitForFunction(
      () => document.body.innerText.includes('TL12 Fixture Session'),
      { timeout: 25000 },
    )
    await page.getByRole('button', { name: /TL12 Fixture Session/ }).first().click()
    await page.waitForFunction(
      () => document.body.innerText.includes('TL12 Amos Khokhar'),
      { timeout: 25000 },
    )

    const beforeUrl = page.url()
    await page.getByRole('button', { name: /TL12 Amos Khokhar/ }).first().click()
    await page.waitForSelector('button:has-text("Background · TL12 Amos Khokhar")', { timeout: 15000 })
    check('B1 selecting a participant offers their background on the capture screen', true)

    const drawer = await openDrawer(page, 'TL12 Amos Khokhar')
    const text = await drawer.innerText()
    check('B1 and the drawer opens without leaving capture', page.url() === beforeUrl, page.url())
    check('B1 the compact card carries the headline', text.includes('TL12 consultant-in-training'))
    check(
      'B1 and NOT the full card: no certifications, no notes, no boundary note',
      !text.includes('CBC level 2') && !text.includes('Background, not assessment'),
      text.replace(/\s+/g, ' ').slice(0, 110),
    )

    // B5: both kinds of training, visibly apart.
    check(
      'B5 the derived training from the other workshop is shown and marked',
      text.includes(PRIOR_NAME) && text.includes('in this system'),
      text.includes(PRIOR_NAME) ? 'derived present' : 'derived MISSING',
    )
    check(
      'B5 the self-reported one is shown and marked differently',
      text.includes('TL12 CLAT course, Nairobi') && text.includes('self-reported'),
    )
    check(
      'B5 and the workshop being looked at is not listed as a prior training',
      !text.includes(WS_NAME),
    )

    // B3: an evaluator gets no edit control on somebody else's background.
    check(
      'B3 an evaluator is offered no way to edit a colleague`s background',
      (await drawer.getByRole('button', { name: /edit background/i }).count()) === 0,
    )

    await page.keyboard.press('Escape')

    // ---- B2: the withheld profile, with a reason ----------------------------
    await page.getByRole('button', { name: /TL12 Bina Sitorus/ }).first().click()
    const withheld = await openDrawer(page, 'TL12 Bina Sitorus')
    const wtext = await withheld.innerText()
    check(
      'B2 a withheld profile states the reason rather than rendering blank',
      /administrators only/i.test(wtext),
      wtext.replace(/\s+/g, ' ').slice(0, 100),
    )
    check('B2 and does not leak the withheld headline', !wtext.includes('TL12 withheld headline'))
    await page.keyboard.press('Escape')
    await page.context().close()
  }

  // ---- B4: an administrator edits, and it survives a reload -----------------
  {
    const page = await device(CHIEF)
    await page.goto(`${BASE}admin/participants`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.body.innerText.includes('TL12 Amos Khokhar'), {
      timeout: 25000,
    })
    const drawer = await openDrawerForRow(page, 'TL12 Amos Khokhar')
    check(
      'B4 an administrator IS offered the edit control',
      (await drawer.getByRole('button', { name: /edit background/i }).count()) > 0,
    )
    await drawer.getByRole('button', { name: /edit background/i }).click()
    await page.waitForSelector('#pp-headline', { timeout: 15000 })
    await page.locator('#pp-headline').fill('TL12 edited by the chief admin')
    await page.getByRole('button', { name: /save background/i }).click()
    await page.waitForTimeout(1500)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.body.innerText.includes('TL12 Amos Khokhar'), {
      timeout: 25000,
    })
    const again = await openDrawerForRow(page, 'TL12 Amos Khokhar')
    const t = await again.innerText()
    check('B4 the edit survives a reload', t.includes('TL12 edited by the chief admin'),
      t.replace(/\s+/g, ' ').slice(0, 90))

    // And it reached the backend, not just Dexie.
    const stored = await sql(
      `select headline from person_profile where person_id = '${SUBJECT_PERSON}';`)
    check('B4 and it reached Postgres, not only this device',
      stored[0]?.headline === 'TL12 edited by the chief admin', `stored=${stored[0]?.headline}`)
    await page.keyboard.press('Escape')

    // ---- B6: the merge dialog ---------------------------------------------
    await page.goto(`${BASE}admin/setup/people`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => document.body.innerText.includes('Possibly the same person'),
      { timeout: 25000 },
    )
    const panelText = await page.innerText('body')
    check('B6 the merge panel offers the surname-and-initial pair',
      panelText.includes('TL12 Amos Khokhar') && panelText.includes('TL12 Amos Kokhar'))

    await page.getByRole('button', { name: /Keep.*Merge into this one/i }).first().click()
    await page.waitForFunction(
      () => /combines|becomes one person/i.test(document.body.innerText),
      { timeout: 15000 },
    )
    const dialog = await page.innerText('body')
    check('B6 merging opens the change dialog rather than committing silently',
      /becomes one person/i.test(dialog))
    check('B6 and it warns there is no undo', /no undo/i.test(dialog))
    // The "no evidence moves or disappears" line quotes real counts and is
    // therefore ABSENT here, because these fixture people have no observations.
    // That is the dialog behaving correctly — it does not print a sentence about
    // 0 observations — so the assertion is that it did not invent one. The wording
    // itself is pinned in test/personProfiles.test.ts, where the counts exist.
    check('B6 and it does not claim anything is deleted, or quote a number it has not got',
      !/deletes? \d+ observation/i.test(dialog) && !/\b0 observation/i.test(dialog))

    // ---- B7: 390px ---------------------------------------------------------
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(400)
    const m = await noOverflow(page)
    check('B7 the merge panel fits a 390px phone',
      m.scrollWidth <= m.innerWidth && m.layout <= 390,
      `scrollWidth=${m.scrollWidth} layout=${m.layout} inner=${m.innerWidth}`)

    await page.goto(`${BASE}admin/participants`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.body.innerText.includes('TL12 Amos'), { timeout: 25000 })
    await openDrawerForRow(page, 'TL12 Amos Khokhar')
    await page.waitForTimeout(400)
    const d = await noOverflow(page)
    check('B7 and so does the open drawer',
      d.scrollWidth <= d.innerWidth && d.layout <= 390,
      `scrollWidth=${d.scrollWidth} layout=${d.layout} inner=${d.innerWidth}`)
    await page.context().close()
  }

  check('no uncaught page errors anywhere in the walk', pageErrors.length === 0,
    pageErrors.slice(0, 3).join(' | ') || 'none')
} finally {
  await browser.close()
}

const failed = results.filter((r) => r.verdict === 'FAIL')
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`)
console.log('Fixtures are LEFT IN PLACE so a failure can be inspected. Remove with --teardown.')
if (failed.length > 0) process.exitCode = 1
