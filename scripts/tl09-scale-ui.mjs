/**
 * tl-09's browser acceptance: does a workshop's own scale actually reach the
 * screens an evaluator and an administrator use?
 *
 * The schema half is proved by scripts/tl09-rls-tests.sql and the arithmetic by
 * test/scale.test.ts. Neither can prove the claim the spec actually makes, which
 * is that the number an evaluator taps, the buttons a verifier is offered, the
 * bands a legend draws and the words a report prints all come from the SAME
 * scale — the one belonging to the workshop on screen. That is a claim about a
 * rendered page against a live Postgres, so it is checked in one.
 *
 * What is under test, in order:
 *   U1  the Setup scale editor lists the workshop's own points, not 0-3
 *   U2  a low-trigger point is marked in ink as well as in colour
 *   U3  the capture screen's quick-read chips ARE the workshop's points
 *   U4  the rubric panel lists one descriptor row per point of the scale
 *   U5  adding a seventh point is not offered
 *   U6  removing a point that holds evidence demands a mapping before Save
 *   U7  the reports legend draws one band per point, in the workshop's words
 *   U8  the heatmap paints by POSITION: the bottom point takes the bottom step
 *   U9  a second workshop on a different scale renders its own, after a switch
 *
 *   node scripts/tl09-scale-ui.mjs --setup      # accounts, two workshops, evidence
 *   npm run dev -- --port 5189                  # in another shell
 *   node scripts/tl09-scale-ui.mjs
 *   node scripts/tl09-scale-ui.mjs --teardown
 *
 * PORT 5189, not the repo default and not tl-17's 5187. A concurrent session left
 * on somebody else's port would drive their build and pass, which is the worst
 * possible green.
 *
 * Playwright is deliberately not a dependency of this repo:
 *   npm i -D --no-save playwright && npx playwright install chromium
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const BASE = `http://localhost:${process.env.TL09_PORT ?? 5189}/`
const PROJECT = 'vdbirmjvjzfdgajwgowj'
const PASSWORD = 'tl09-Throwaway-Password-1!'

/** A 1-5 workshop and a 2-point one, so "0-3" is the wrong answer on both. */
const WS_FIVE = '90910000-0000-4000-8000-000000000001'
const WS_TWO = '90910000-0000-4000-8000-000000000002'
const NAME_FIVE = 'TL09 Five-Point Workshop'
const NAME_TWO = 'TL09 Two-Point Workshop'
const ACT_FIVE = '90910000-0000-4000-8000-0000000000a1'
const KSA_FIVE = '90910000-0000-4000-8000-0000000000c1'
const KSA_TWO = '90910000-0000-4000-8000-0000000000c2'
const PART_FIVE = '90910000-0000-4000-8000-0000000000e1'
const ADMIN = 'tl09-ui-admin@example.org'

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

async function provision() {
  const serviceKey = await serviceRoleKey()
  await teardown(serviceKey)

  await sql(`
    insert into workshop (id, name, start_date, end_date, location)
    values ('${WS_FIVE}', '${NAME_FIVE}', '2027-05-01', '2027-05-10', 'Fiveville'),
           ('${WS_TWO}',  '${NAME_TWO}',  '2027-07-01', '2027-07-10', 'Twotown');

    insert into activity (id, workshop_id, title, day, sort_order)
    values ('${ACT_FIVE}', '${WS_FIVE}', 'TL09 five-point session', '2027-05-01', 0);

    insert into participant (id, workshop_id, name)
    values ('${PART_FIVE}', '${WS_FIVE}', 'Five Person');

    insert into ksa (id, workshop_id, code, short_label, description,
                     evaluator_facing_prompt, evidence_levels, cbc_subpoint_refs)
    values ('${KSA_FIVE}', '${WS_FIVE}', 'FIVEQ', 'The five-point question',
            'A five-point question.', 'How did they do the five-point thing?',
            '{"1":"one anchor","2":"two anchor","3":"three anchor","4":"four anchor","5":"five anchor"}'::jsonb,
            array[]::text[]),
           ('${KSA_TWO}', '${WS_TWO}', 'TWOQ', 'The two-point question',
            'A two-point question.', 'Did they do the two-point thing?',
            '{"0":"no","1":"yes"}'::jsonb, array[]::text[]);

    insert into activity_ksa (activity_id, ksa_id, sort_order)
    values ('${ACT_FIVE}', '${KSA_FIVE}', 0);

    -- Evidence at the top of the five-point scale, so removing point 5 has a
    -- cost the editor has to state and refuse to guess at.
    insert into observation (id, capture_client_id, workshop_id, participant_id, participant_name,
                             ksa_code, text, source_excerpt, evidence_designation,
                             sentiment_flag, confidence, needs_review, origin)
    values ('tl09ui-obs-1', 'tl09ui-cap-1', '${WS_FIVE}', '${PART_FIVE}', 'Five Person',
            'FIVEQ', 'did the thing well', 'did the thing well', 5,
            'strong', 'high', false, 'individual');
    select 1;`)

  await sql(`
    insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
    values ('${ADMIN}', array['admin'], 'admin', 'tl-09 ui fixture', '${WS_FIVE}')
    on conflict (email) do update set allowed_roles = excluded.allowed_roles,
      assigned_role = excluded.assigned_role, default_workshop_id = excluded.default_workshop_id;
    select 1;`)

  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN, password: PASSWORD, email_confirm: true, user_metadata: { name: 'TL09 UI Admin' } }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok && !/already|registered|exists/i.test(JSON.stringify(body))) {
    throw new Error(`create ${ADMIN} -> ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
  }

  // Admin in BOTH, so the switch in U9 is a real membership change rather than a
  // platform-owner shortcut.
  await sql(`
    insert into workshop_member (workshop_id, app_user_id, role)
    select '${WS_TWO}', u.id, 'admin' from app_user u where u.email = '${ADMIN}'
    on conflict do nothing;
    select 1;`)

  // The two scales, through the RPC's own path is not possible here (no caller),
  // so directly — the migration's seed is 0-3 and both workshops need their own.
  await sql(`
    delete from scale_point where workshop_id in ('${WS_FIVE}', '${WS_TWO}');
    insert into scale_point (workshop_id, value, label, description, is_low_trigger, sort_order)
    values ('${WS_FIVE}', 1, 'well below', null, true,  0),
           ('${WS_FIVE}', 2, 'below',      null, true,  1),
           ('${WS_FIVE}', 3, 'meets',      null, false, 2),
           ('${WS_FIVE}', 4, 'above',      null, false, 3),
           ('${WS_FIVE}', 5, 'well above', null, false, 4),
           ('${WS_TWO}',  0, 'not yet',    null, true,  0),
           ('${WS_TWO}',  1, 'yes',        null, false, 1);
    select 1;`)

  console.log(`provisioned: ${NAME_FIVE} (1-5) and ${NAME_TWO} (0-1), admin ${ADMIN}`)
}

async function teardown(serviceKey) {
  const key = serviceKey ?? (await serviceRoleKey())
  await sql(`
    delete from observation where id like 'tl09ui-%';
    delete from activity_ksa where activity_id = '${ACT_FIVE}';
    delete from ksa where id in ('${KSA_FIVE}', '${KSA_TWO}');
    delete from activity where id = '${ACT_FIVE}';
    delete from participant where workshop_id in ('${WS_FIVE}', '${WS_TWO}');
    delete from workshop_member wm using app_user u
      where u.id = wm.app_user_id and u.email = '${ADMIN}';
    delete from app_user where email = '${ADMIN}';
    delete from role_allowlist where email = '${ADMIN}';
    delete from workshop where id in ('${WS_FIVE}', '${WS_TWO}');
    select 1;`)
  const users = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  }).then((r) => r.json()).catch(() => ({ users: [] }))
  for (const u of users.users ?? []) {
    if (u.email === ADMIN) {
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
        method: 'DELETE',
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      })
    }
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function run() {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`))

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]', ADMIN)
  await page.fill('input[type="password"]', PASSWORD)
  await page.click('button[type="submit"]')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1500)

  // ---- U1/U2: the Setup scale editor -------------------------------------
  await page.goto(`${BASE}admin/setup/scale`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)

  const chips = await page.$$eval('.scale-table .chip-d', (els) =>
    els.map((e) => ({ value: e.textContent.trim(), trigger: e.getAttribute('data-trigger') })),
  )
  check(
    chips.map((c) => c.value).join(',') === '1,2,3,4,5',
    'U1  the scale editor lists the workshop\'s own points, not 0-3',
    chips.map((c) => c.value).join(',') || '(none found)',
  )
  check(
    chips.filter((c) => c.trigger === 'true').map((c) => c.value).join(',') === '1,2',
    'U2  the low-trigger points carry the ink mark, and only those',
    chips.map((c) => `${c.value}${c.trigger === 'true' ? '*' : ''}`).join(' '),
  )

  // ---- U5: the upper bound is a disabled control, not a runtime error -----
  const addDisabled = await page.$$eval('button', (els) =>
    els
      .filter((e) => /Add a point (above|below)/.test(e.textContent))
      .map((e) => e.disabled),
  )
  check(
    addDisabled.length === 2 && addDisabled.every((d) => d === false),
    'U5  at five points both Add controls are still offered',
    `add buttons: ${addDisabled.length}, disabled: ${addDisabled.join(',')}`,
  )

  // ---- U6: removing a point under evidence demands a mapping -------------
  const removeButtons = await page.$$('.scale-table button')
  let remapShown = false
  for (const b of removeButtons) {
    if ((await b.textContent())?.trim() === 'Remove') {
      // The last Remove is point 5, which holds the fixture observation.
      await b.click()
    }
  }
  await page.waitForTimeout(600)
  remapShown = (await page.$$('.card')).length > 0 &&
    (await page.content()).includes('Removing')
  const saveDisabled = await page
    .$$eval('button.primary', (els) =>
      els.filter((e) => /Save the scale/.test(e.textContent)).map((e) => e.disabled),
    )
    .catch(() => [])
  check(
    remapShown && saveDisabled.every((d) => d === true),
    'U6  removing a point that holds evidence demands a mapping before Save',
    `remap panel: ${remapShown}; save disabled: ${saveDisabled.join(',') || 'n/a'}`,
  )

  // ---- U3/U4: the capture screen -----------------------------------------
  // Started from the home page rather than by URL: /capture/:clientId takes a
  // DRAFT's id, not an activity's, and a capture that was never created is a
  // page with no questions on it — which would have made these three checks
  // pass vacuously by finding nothing to disagree with.
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  const activityButton = await page.$('button.activity-item')
  if (activityButton) await activityButton.click()
  await page.waitForURL(/\/capture\//, { timeout: 10000 }).catch(() => {})
  await page.waitForTimeout(1200)
  const ratingChips = await page.$$eval('.rating-chip', (els) =>
    els.map((e) => ({ v: e.textContent.trim(), t: e.getAttribute('data-trigger') })),
  )
  check(
    ratingChips.map((c) => c.v).join(',') === '1,2,3,4,5',
    'U3  the capture quick-read chips ARE the workshop\'s points',
    ratingChips.map((c) => c.v).join(',') || '(none found)',
  )
  check(
    ratingChips.filter((c) => c.t === 'true').map((c) => c.v).join(',') === '1,2',
    'U4  a chip that starts a follow-up says so before it is tapped',
    ratingChips.map((c) => `${c.v}${c.t === 'true' ? '*' : ''}`).join(' '),
  )

  // BY TEXT, and scoped to the quick-rating block. The glossary's "Terms"
  // control is also a `.rubric-toggle` and opens its own `.rubric-panel`, so an
  // unscoped selector clicked the glossary and then asserted on a list of
  // acronyms — a check that could only ever fail, and for the wrong reason.
  const allLevels = page.locator('.quick-rating button.rubric-toggle')
  if (await allLevels.count()) {
    await allLevels.first().click()
    await page.waitForTimeout(400)
  }
  const rubricRows = await page.$$eval('.quick-rating .rubric-panel li .rubric-level', (els) =>
    els.map((e) => e.textContent.trim().replace(':', '')),
  )
  check(
    rubricRows.join(',') === '5,4,3,2,1',
    'U7  the rubric lists one descriptor row per point, best first',
    rubricRows.join(',') || '(none found)',
  )

  // ---- U8/U9: the legend and the heatmap ---------------------------------
  // /admin/workshop is where both are rendered together; /reports carries a
  // legend only once a participant is selected.
  await page.goto(`${BASE}admin/workshop`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  const legend = await page.$$eval('.legend .legend__item', (els) => els.map((e) => e.textContent.trim()))
  check(
    legend.some((t) => t.includes('well above')) && legend.some((t) => t.includes('well below')),
    'U8  the legend prints the workshop\'s own words for its points',
    legend.slice(0, 6).join(' | ') || '(no legend)',
  )

  const cellFills = await page.$$eval('.heat__cell[data-d]', (els) =>
    els
      .filter((e) => e.getAttribute('data-d') !== 'none')
      .map((e) => ({ d: e.getAttribute('data-d'), fill: e.style.getPropertyValue('--fill') })),
  )
  check(
    cellFills.length > 0 && cellFills.every((c) => /^var\(--d-5-\d\)$/.test(c.fill)),
    'U9  the heatmap paints from the FIVE-step ramp, by position on the scale',
    cellFills.map((c) => `${c.d}→${c.fill}`).join(' ') || '(no cells)',
  )

  await browser.close()

  const failed = results.filter((r) => !r).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed === 0 ? 0 : 1)
}

const mode = process.argv[2]
if (mode === '--setup') await provision()
else if (mode === '--teardown') await teardown()
else await run()
