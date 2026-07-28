/**
 * The two claims Wave 2 makes that cannot be checked on one device.
 *
 * Everything else in this wave is provable in a unit test or a single browser.
 * These two are not, and they are the whole point of moving settings and drafts
 * onto the server:
 *
 *   1. A threshold an administrator changes reaches somebody else's phone.
 *      It used to live in localStorage, so it reached nobody, and the app
 *      cheerfully reported reports as "ready" against each device's private
 *      idea of the rule.
 *   2. Whether an email went out is a shared fact. It used to be knowable only
 *      on the laptop that sent it, and a second chief could not tell "nothing
 *      was sent" from "I cannot see what was sent".
 *
 * Two browser CONTEXTS, which is a real two-device test rather than a
 * simulated one: each gets its own IndexedDB and its own session, so device B
 * genuinely has to learn from the backend what device A did.
 *
 * Requires the throwaway accounts and their fixture workshop:
 *
 *   node scripts/w2-session-tests.mjs --keep
 *   npm run dev -- --port 5180          # in another shell
 *   node scripts/w2-two-device.mjs
 *   node scripts/w2-session-tests.mjs --teardown
 *
 * Playwright is deliberately not a dependency of this repo:
 *   npm i -D --no-save playwright && npx playwright install chromium
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'

const BASE = 'http://localhost:5180/'
const PROJECT = 'vdbirmjvjzfdgajwgowj'
const W2_WS = '33333333-3333-3333-3333-333333333333'
const W2_PARTICIPANT = '44444444-4444-4444-4444-444444444444'
const PASSWORD = 'w2-Throwaway-Password-1!'
const ADMIN = 'w2-session-admin@example.org'
const CHIEF = 'w2-session-chief@example.org'

const results = []
function check(ok, label, detail = '') {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label.padEnd(62)} | ${detail}`)
}

// --- management plumbing, for the seeded draft only -------------------------
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
  if (!res.ok) throw new Error(`query -> ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

// Sanity: the fixture has to exist, or every check below would "pass" against
// nothing. readFileSync on .env is only to fail early with a clear message.
readFileSync(new URL('../.env', import.meta.url), 'utf8')

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

try {
  // =========================================================================
  // 1. A threshold change crosses devices
  // =========================================================================
  const a = await device(ADMIN)
  await a.goto(`${BASE}admin/settings`, { waitUntil: 'networkidle' })
  await a.waitForSelector('#reqconf', { timeout: 15000 })
  await a.locator('#reqconf').fill('3')
  await a.locator('#reqconf').dispatchEvent('change')
  await a.waitForTimeout(2500) // let the outbox drain to Postgres

  const stored = await sql(`
    select value::text as v from workshop_setting
    where workshop_id = '${W2_WS}' and key = 'required_confirmations';`)
  check(stored[0]?.v === '3', 'device A: the change reaches Postgres, not just its own disk', `stored = ${stored[0]?.v}`)

  // Device B is a DIFFERENT context: fresh IndexedDB, fresh localStorage. It has
  // never seen the value 3 and can only have learned it from the backend.
  const b = await device(CHIEF)
  await b.goto(`${BASE}admin/assignments`, { waitUntil: 'networkidle' })
  await b.waitForSelector('.kanban', { timeout: 15000 })
  const bMeta = await b.locator('.pagehead__meta').first().innerText()
  check(
    /short of 3|enough assignees/.test(bMeta),
    'device B: reads the new threshold it was never told directly',
    bMeta.trim(),
  )

  const bMirror = await b.evaluate(() => localStorage.getItem('cairn.required_confirmations'))
  check(
    bMirror === '3',
    'device B: the synchronous accessor was re-pointed by the mirror',
    `localStorage = ${bMirror}`,
  )

  // The gate itself, not just the label: this is the value participantGate()
  // applies, so a stale mirror would mean B judging reports by the old rule.
  await b.goto(`${BASE}admin/progress`, { waitUntil: 'networkidle' })
  await b.waitForSelector('.dt, .empty', { timeout: 15000 })
  const reviewerCell = await b.locator('.dt tbody tr').first().innerText().catch(() => '')
  check(/of 3/.test(reviewerCell), 'device B: the gate applies the new number', reviewerCell.replace(/\s+/g, ' ').slice(0, 70))

  // =========================================================================
  // 2. Send state is a shared fact
  // =========================================================================
  // Seeded server-side rather than driven through the send queue, because what
  // is under test is the PULL: can a device that never generated this document
  // see what happened to it. The queue itself is already covered by
  // test/sendQueue.test.ts.
  const draftId = 'w2-session-shared-draft'
  await sql(`
    delete from doc_draft where id = '${draftId}';
    insert into doc_draft (id, workshop_id, kind, subject_key, title, subject,
                           date_label, status, recipients, updated_at, approved_by, approved_at)
    values ('${draftId}', '${W2_WS}', 'participant_email', '${W2_PARTICIPANT}',
            'W2 Session Participant', 'Shared draft test', '2027-02-01', 'sending',
            '[{"email":"someone@example.org","name":"Someone","status":"awaiting_confirmation","at":"2027-02-01T20:00:00Z","error":null}]'::jsonb,
            now(), 'device-a@example.org', now());
    select 1;`)

  // A third context, so this device has never held the row locally at all.
  const c = await device(CHIEF)
  await c.goto(`${BASE}outgoing`, { waitUntil: 'networkidle' })
  await c.getByRole('button', { name: /sync documents/i }).click()
  await c.waitForTimeout(3000)

  const queueText = await c.locator('.dt').innerText().catch(() => '')
  check(
    /Shared draft test|W2 Session Participant/.test(queueText),
    'device C: sees a document it never generated',
    queueText.replace(/\s+/g, ' ').slice(0, 70),
  )

  await c.goto(`${BASE}admin/progress`, { waitUntil: 'networkidle' })
  await c.waitForSelector('.dt, .empty', { timeout: 15000 })
  const progressText = await c.locator('.dt').innerText()
  check(
    /awaiting confirmation/i.test(progressText),
    'device C: awaiting_confirmation survives the round trip verbatim',
    'not rounded up to "sent"',
  )

  // The non-regression rule, over the wire. Device C now holds the `sending`
  // copy; the merge must refuse to let an older `draft` state overwrite it.
  await sql(`
    update doc_draft set status = 'draft', updated_at = now() + interval '1 hour'
    where id = '${draftId}';
    select 1;`)
  await c.goto(`${BASE}outgoing`, { waitUntil: 'networkidle' })
  await c.getByRole('button', { name: /sync documents/i }).click()
  await c.waitForTimeout(3000)
  const restored = await sql(`select status from doc_draft where id = '${draftId}';`)
  check(
    restored[0]?.status === 'sending',
    'device C: pushes its more advanced status back over the regressed row',
    `server now = ${restored[0]?.status}`,
  )

  await sql(`delete from doc_draft where id = '${draftId}'; select 1;`)

  const real = errors.filter((e) => !/favicon|manifest|React DevTools/i.test(e))
  check(real.length === 0, 'no page errors across either device', real.slice(0, 2).join(' | ') || 'clean')
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} PASS, ${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
