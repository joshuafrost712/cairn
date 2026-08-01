/**
 * tl-11's acceptance in a browser: the claims that only a rendered page can prove.
 *
 * The rules are enforced in Postgres and proved by scripts/tl11-rls-tests.sql; the
 * RPCs are proved reachable by scripts/tl11-session-tests.mjs. Neither can say
 * whether an administrator can actually DO any of it, and two of the spec's
 * requirements are about exactly that: that a withheld action is not rendered
 * disabled with no explanation, and that inviting somebody does not imply an email
 * went out.
 *
 * What is under test:
 *   B1  members and pending invitations render as one list, the pending ones marked
 *   B2  an admin is offered no control that would grant admin, and is told why
 *   B3  inviting from the form adds a pending row and produces a message to send
 *   B4  withdrawing removes it from the list
 *   B5  removing a member opens the change dialog, and the dialog says the evidence
 *       they recorded is not touched
 *   B6  the section does not widen a 390px phone
 *
 *   node scripts/tl11-people.mjs --setup      # accounts and a workshop
 *   npm run dev -- --port 5191                # in another shell
 *   node scripts/tl11-people.mjs
 *   node scripts/tl11-people.mjs --teardown
 *
 * PORT 5191, not the repo default, and overridable with TL11_PORT. A concurrent
 * session left on 5180 would drive somebody else's build and pass, which is the
 * worst possible green.
 *
 * Playwright is deliberately not a dependency of this repo:
 *   npm i -D --no-save playwright && npx playwright install chromium
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const BASE = `http://localhost:${process.env.TL11_PORT ?? 5191}/`
const PROJECT = 'vdbirmjvjzfdgajwgowj'
const PASSWORD = 'tl11-Throwaway-Password-1!'

const WS = 'a6110000-0000-4000-8000-000000000001'
const WS_NAME = 'TL11 People Workshop'

const CHIEF = 'tl11-ui-chief@example.org'
const ADMIN = 'tl11-ui-admin@example.org'
/** A second admin, because "an admin cannot act on another admin" needs another admin. */
const ADMIN2 = 'tl11-ui-admin2@example.org'
const EVALUATOR = 'tl11-ui-evaluator@example.org'
const INVITEE = 'tl11-ui-invitee@example.org'

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

async function teardown() {
  const serviceKey = await serviceRoleKey()
  const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  }).then((r) => r.json())
  for (const u of list.users ?? []) {
    if (!u.email?.startsWith('tl11-ui-')) continue
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    })
  }
  await sql(`
    delete from membership_change_log where workshop_id = '${WS}';
    delete from setup_change_log where workshop_id = '${WS}';
    delete from workshop_invitation where workshop_id = '${WS}';
    delete from workshop_invitation where email like 'tl11-ui-%';
    delete from workshop_member where workshop_id = '${WS}';
    delete from activity_ksa where ksa_id in (select id from ksa where workshop_id = '${WS}');
    delete from ksa where workshop_id = '${WS}';
    delete from participant where workshop_id = '${WS}';
    delete from app_user where email like 'tl11-ui-%';
    delete from role_allowlist where email like 'tl11-ui-%';
    delete from workshop where id = '${WS}';
    delete from auth.identities where identity_data->>'email' like 'tl11-ui-%';
    delete from auth.users where email like 'tl11-ui-%';
    select 1;`)
}

async function setup() {
  await teardown()
  const serviceKey = await serviceRoleKey()
  await sql(`
    insert into workshop (id, name, start_date, end_date, location)
    values ('${WS}', '${WS_NAME}', '2027-07-01', '2027-07-05', 'Nowhere');
    insert into participant (id, workshop_id, name, preferred_language)
    values ('a6110000-0000-4000-8000-0000000000d1', '${WS}', 'TL11 UI Participant', 'English');
    select 1;`)

  for (const [email, role] of [[CHIEF, 'chief_admin'], [ADMIN, 'admin'], [ADMIN2, 'admin'], [EVALUATOR, 'evaluator']]) {
    await sql(`
      insert into role_allowlist (email, allowed_roles, assigned_role, note, default_workshop_id)
      values ('${email}', array['${role}'], '${role}', 'tl-11 ui test', '${WS}')
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
        user_metadata: { name: `TL11 ${role.replace(/_/g, ' ')}` },
      }),
    })
    if (!res.ok) throw new Error(`create ${email} -> ${res.status} ${(await res.text()).slice(0, 200)}`)
  }
  console.log(`fixtures ready: ${WS_NAME}, three accounts, password ${PASSWORD}`)
}

if (process.argv.includes('--teardown')) {
  await teardown()
  console.log('tl-11 UI fixtures removed.')
  process.exit(0)
}
if (process.argv.includes('--setup')) {
  await setup()
  process.exit(0)
}

await setup()

// ---------------------------------------------------------------------------
// The rendered app
// ---------------------------------------------------------------------------

const results = []
function check(pass, label, detail) {
  results.push({ pass, label, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${label.padEnd(70)} | ${detail}`)
}

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
  return p
}

/** The invited address, as the message must name it. */
const INVITEE_TOKEN = INVITEE

const openPeople = async (page) => {
  await page.goto(`${BASE}admin/setup/people`, { waitUntil: 'domcontentloaded' })
  // The directory is a network read, so wait for a row rather than for the route.
  await page.waitForFunction(() => document.body.innerText.includes('Who has access'), {
    timeout: 25000,
  })
  await page
    .waitForFunction(() => document.querySelectorAll('table tbody tr').length > 0, { timeout: 25000 })
    .catch(() => {})
}

try {
  {
    // B1 + B2: one chief admin's view, then the same page as an admin. The contrast
    // is the claim — the control is ABSENT for the admin, not merely disabled.
    const chief = await device(CHIEF)
    await openPeople(chief)

    const rows = await chief.evaluate(() =>
      [...document.querySelectorAll('table tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ')),
    )
    check(
      rows.some((r) => /chief admin/i.test(r)) && rows.some((r) => /evaluator/i.test(r)),
      'B1 the directory lists the workshop\'s members with their roles',
      `${rows.length} row(s)`,
    )

    // B3: invite through the form, exactly as an administrator would.
    await chief.getByLabel(/email address/i).fill(INVITEE)
    await chief.getByRole('button', { name: /^invite$/i }).click()
    // Wait for the TABLE row, not for the address anywhere on the page. The
    // success notice contains the address too and is set at the top of the commit,
    // so waiting on the text resumed the harness while the directory reload was
    // still in flight — and every later click then met a legitimately disabled
    // control. A green that depended on losing that race would have been worse.
    await chief.waitForFunction(
      (email) =>
        [...document.querySelectorAll('table tbody tr')].some((tr) => tr.innerText.includes(email)) &&
        document.body.innerText.includes('The message to send'),
      INVITEE,
      { timeout: 20000 },
    )
    const afterInvite = await chief.evaluate(() => document.body.innerText)
    check(
      /not joined/i.test(afterInvite),
      'B3 the invited address appears in the same list, marked as not joined',
      afterInvite.match(/Invited [\d-]+, not joined/)?.[0] ?? 'no pending marker',
    )
    check(
      /no email is sent|nothing has been emailed/i.test(afterInvite),
      'B3 and the page says plainly that no email was sent for them',
      'the honest-status line is present',
    )
    // Read the textarea's VALUE, not the page's text. `innerText` does not include
    // a textarea's contents, so the first version of this check was asserting on a
    // string that could never appear and failed with the panel plainly on screen.
    const message = await chief.evaluate(
      () => document.querySelector('textarea[readonly]')?.value ?? '',
    )
    check(
      /create an account using this email address/i.test(message) && message.includes(INVITEE_TOKEN),
      'B3 and hands over the message to send, addressed to them',
      message.slice(0, 70).replace(/\s+/g, ' '),
    )

    // B5: removing a member is warned about, and the warning tells the truth about
    // what happens to what they recorded.
    const evaluatorRow = chief.locator('table tbody tr', { hasText: 'TL11 evaluator' }).first()
    await evaluatorRow.getByRole('button', { name: /^remove$/i }).click()
    await evaluatorRow.getByRole('button', { name: /remove .* from this workshop/i }).click()
    await chief.waitForFunction(
      () => document.body.innerText.includes('loses access to this workshop'),
      { timeout: 20000 },
    )
    const dialog = await chief.evaluate(() => document.body.innerText)
    check(
      /no evidence is touched|nothing they recorded is deleted/i.test(dialog),
      'B5 the removal dialog says what happens to the evidence they recorded',
      dialog.match(/loses access to this workshop[^\n]*/)?.[0]?.slice(0, 90) ?? '',
    )

    // Cancel, scoped to the dialog. An unscoped match hits the ConfirmAction's own
    // Cancel underneath it, which leaves the modal open — and the next click then
    // fails with "intercepts pointer events" rather than with anything about tl-11.
    await chief.locator('[role="dialog"]').getByRole('button', { name: /cancel/i }).click()
    await chief.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 10000 })

    // B4: withdraw the invitation just issued.
    const inviteRow = chief.locator('table tbody tr', { hasText: INVITEE }).first()
    await inviteRow.getByRole('button', { name: /^withdraw$/i }).click()
    await inviteRow.getByRole('button', { name: /withdraw this invitation/i }).click()
    await chief.waitForFunction(
      (email) =>
        ![...document.querySelectorAll('table tbody tr')].some((tr) => tr.innerText.includes(email)),
      INVITEE,
      { timeout: 20000 },
    ).catch(() => {})
    // The TABLE, not the page: the success notice names the address it withdrew,
    // so an innerText check reports "still listed" for a list it is not in.
    const stillListed = await chief.evaluate(
      (email) =>
        [...document.querySelectorAll('table tbody tr')].some((tr) => tr.innerText.includes(email)),
      INVITEE,
    )
    check(!stillListed, 'B4 withdrawing removes it from the list', stillListed ? 'still listed' : 'gone')
  }

  {
    const admin = await device(ADMIN)
    await openPeople(admin)
    const body = await admin.evaluate(() => document.body.innerText)
    const roleOptions = await admin.evaluate(() =>
      [...document.querySelectorAll('select')].flatMap((s) =>
        [...s.options].map((o) => o.textContent.trim().toLowerCase()),
      ),
    )
    // The spec's requirement, and the reason it is worth a check: an admin must not
    // be offered a promotion the server would refuse.
    check(
      !roleOptions.includes('admin') && !roleOptions.includes('chief admin'),
      'B2 an admin is offered no control that would grant admin',
      JSON.stringify(roleOptions),
    )
    // The case the spec names by hand: an admin looking at another admin. The row
    // must carry a sentence, not an absence.
    const otherAdminRow = await admin.evaluate(
      (email) =>
        [...document.querySelectorAll('table tbody tr')]
          .find((tr) => tr.innerText.includes(email))?.innerText.replace(/\s+/g, ' ') ?? '',
      ADMIN2,
    )
    check(
      /only add and remove evaluators|only the chief admin can change anyone else/i.test(otherAdminRow),
      'B2 and an admin looking at another admin is told why, on that row',
      otherAdminRow.slice(0, 110),
    )
  }

  {
    // B6: the phone. tl-20's audit harness does not exist on this branch, so the
    // section checks its own width the way tl-17's did.
    const phone = await device(CHIEF, { viewport: { width: 390, height: 844 } })
    await openPeople(phone)
    const widths = await phone.evaluate(() => ({
      layout: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }))
    check(
      widths.scroll <= widths.inner + 1 && widths.layout <= 390,
      'B6 the People section does not widen a 390px phone',
      JSON.stringify(widths),
    )
  }

  check(pageErrors.length === 0, 'no uncaught page errors in any session', pageErrors.join(' | ') || 'none')
} finally {
  await browser.close()
  await teardown()
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`)
if (failed.length > 0) process.exitCode = 1
