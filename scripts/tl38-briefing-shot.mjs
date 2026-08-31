/**
 * tl-38 clause 10, the half a route walk cannot do: render the Briefing with a
 * FULL payload and look at it.
 *
 *   VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npx vite --port 5188 --strictPort
 *   AUDIT_PORT=5188 node scripts/tl38-briefing-shot.mjs
 *
 * `scripts/ui-responsive-audit.mjs` runs the app in local-only mode, so the RPC is
 * unreachable and `/admin/briefing` renders its never-fetched-and-offline empty
 * state. That state is worth auditing and it is not the state that can break a
 * layout: the risk on this page is a five-column table and a worklist of long
 * names on a 390px phone, and an empty page passes every negative assertion while
 * showing none of it. tl-09's scale editor and tl-13's function toggles both
 * passed the shared audit outright, which is where the build protocol's "open the
 * screenshots" rule comes from.
 *
 * So this seeds the localStorage snapshot `src/db/health.ts` caches into, with a
 * payload at the real workshop's scale (26 participants, 12 evaluators), and
 * grades the page that results. The seeded route is the STALE state, which is the
 * densest of the four: everything the fresh state draws, plus the age banner.
 */
import { chromium } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'

const PORT = process.env.AUDIT_PORT ?? '5188'
const BASE = `http://localhost:${PORT}/`
const SHOTS = 'screenshots/tl38'
const VIEWPORTS = [
  { name: 'phone', viewport: { width: 390, height: 844 } },
  { name: 'laptop', viewport: { width: 1280, height: 900 } },
]

const NAMES = [
  'Ada Lovelace', 'Bijili K Abraham Kuppackal', 'Cleber Santos', 'Dara Okoye',
  'Eliphas Mukhim', 'Hiramba Deb Adhikary', 'Irene van Riezen', 'Jael Claybaugh',
  'Jaime Jill Fianza', 'Jillian Figley', 'Joemar Domingo Cabading', 'Joshua C. Frost',
  'Kristina Tarp', 'Leong Keem Cheng', 'Martin Landert', 'Mathew Thomas',
  'Mukesh Kumar Nayak', 'Peter Seow', 'Raissa Santos', 'Rea Joy Lumawan (Amore)',
  'Rosemary Bolton', 'Santpaul Singh', 'Suelen Campelo', 'Sunita Kumari',
  'Victor Foisape Opungu', 'Viji Mathew',
]
const TEAMS = ['Nuaulu', 'Papua Malay', 'Sunda', 'Tombulu', 'Walak']
// Invented, not the real roster. `cairn` is a public repo, and a layout fixture
// needs addresses of a realistic SHAPE and length, not anybody's actual mailbox.
// (Five scripts already on `main` do carry real personal addresses; that is a
// pre-existing exposure worth cleaning up, and not a reason to add a sixth.)
const EMAILS = [
  'a.reyes@example.org', 'b.okonkwo@examplemail.com', 'c.lindqvist@example.org',
  'd.featherstonehaugh@examplemail.com', 'e.moreau@example.org', 'f.tan@ex.net',
  'g.abernathy@example-mission.org', 'h.nakamura@example.org', 'i.silva@examplemail.com',
  'j.wijayanto@example.my', 'k.santos@example.br', 'l.frost@example.org',
]

function payload() {
  return {
    workshop: {
      id: 'SEEDED',
      name: 'Psalms Workshop, OBT CDT Workshop 3 (Bali 2026)',
      start_date: '2026-08-24',
      end_date: '2026-09-04',
    },
    generated_at: '2026-08-31T02:00:00+00:00',
    stale_hours: 24,
    volume: {
      captures: 195, evaluators: 12, observations: 103, verdicts: 1,
      people_with_routed: 22, mean_evidence: 1.8,
      sentiment: [{ flag: 'strong', n: 44 }, { flag: 'neutral', n: 33 }, { flag: 'weak', n: 26 }],
      per_day: ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-31']
        .map((day, i) => ({ day, n: [23, 20, 50, 73, 22, 1, 3][i] })),
    },
    pipeline: {
      queue: {
        count: 52,
        oldest_created_at: '2026-08-24T06:28:40+00:00',
        by_evaluator: EMAILS.slice(0, 7).map((e, i) => ({ evaluator_email: e, n: [26, 7, 7, 4, 4, 3, 1][i] })),
      },
      drafts_with_content: EMAILS.slice(0, 3).map((e, i) => ({
        evaluator_email: e,
        created_at: `2026-08-2${5 + i}T09:00:00+00:00`,
        kind: i === 1 ? 'text' : 'ratings_only',
      })),
      empty_shells: 81,
      last_delivery: EMAILS.map((e, i) => ({
        evaluator_email: e,
        last_at: `2026-08-${String(24 + (i % 7)).padStart(2, '0')}T09:00:00+00:00`,
      })),
    },
    coverage: {
      participants: NAMES.map((name, i) => ({
        participant_id: `p${i}`,
        name,
        team: i % 6 === 5 ? null : TEAMS[i % 5],
        routed: [0, 1, 0, 5, 4, 6, 3, 3, 2, 3, 12, 0, 6, 3, 3, 9, 4, 0, 1, 9, 6, 5, 5, 6, 3, 0][i],
        pending: [0, 9, 0, 0, 3, 7, 3, 3, 9, 3, 0, 0, 7, 3, 3, 2, 2, 0, 0, 0, 0, 3, 3, 0, 1, 0][i],
      })),
      unattributed_observations: 2,
      unresolved_scope_names: ['Keem Leong', 'Irene', 'Bijili', 'Amore', 'Sant Paul Singh'],
    },
    by_goal: [
      { goal: 'Advocacy and Community Integration', n: 2, mean_evidence: 2 },
      { goal: 'Aesthetic Language, Ethnopoetics, and the Biblical Function of the Psalms', n: 4, mean_evidence: 1.75 },
      { goal: 'Interpersonal Interaction and Collaborative Posture', n: 5, mean_evidence: 2.2 },
      { goal: 'Checking Artistic Translations', n: 8, mean_evidence: 1.5 },
      { goal: 'Psalms Exegesis and Internalization', n: 15, mean_evidence: 1.87 },
      { goal: 'Genre Theory, Discovery, and Matching', n: 24, mean_evidence: 1.79 },
      { goal: 'The CLAT Process and Translation of Aesthetic Language', n: 45, mean_evidence: 1.82 },
    ],
  }
}

rmSync(SHOTS, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })

const results = []
const note = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label}${detail ? ' | ' + detail : ''}`)
}

const browser = await chromium.launch()

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext(vp)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })

  await page.goto(BASE + 'signin', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#name', { timeout: 20000 })
  await page.fill('#name', 'tl38 Auditor')
  await page.fill('#email', 'tl38-auditor@example.org')
  await page.click('button[type=submit]')
  await page.waitForTimeout(2000)

  // Promote the synthesized membership, the same way the shared audit does.
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('cairn')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('workshopMembers', 'readwrite')
        const store = tx.objectStore('workshopMembers')
        const all = store.getAll()
        all.onsuccess = () => {
          for (const row of all.result) store.put({ ...row, role: 'chief_admin' })
        }
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })
  })

  // Seed the cache under whichever workshop this device thinks is active, so the
  // page finds it. `readCachedHealth` keys on the scoped workshop id.
  const seeded = await page.evaluate(async (data) => {
    const ids = await new Promise((resolve, reject) => {
      const req = indexedDB.open('cairn')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('workshops', 'readonly')
        const all = tx.objectStore('workshops').getAll()
        all.onsuccess = () => {
          db.close()
          resolve(all.result.map((w) => w.id))
        }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })
    const snapshot = { data, fetchedAt: '2026-08-31T01:00:00.000Z' }
    for (const id of ids) localStorage.setItem(`cairn.health.${id}`, JSON.stringify(snapshot))
    return ids.length
  }, payload())
  note(`${vp.name}: seeded a cached briefing for every known workshop`, seeded > 0, `${seeded} workshop(s)`)

  const before = errors.length
  await page.goto(BASE + 'admin/briefing', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)

  note(
    `${vp.name}: the route still exists`,
    new URL(page.url()).pathname === '/admin/briefing',
    `landed on ${new URL(page.url()).pathname}`,
  )

  // The state under test is the dense one, not the empty one.
  const rendered = await page.evaluate(() => ({
    rows: document.querySelectorAll('table tbody tr').length,
    // Scoped to the worklist card. `.card ul li` also matched the goals list, so
    // the assertion would have passed with an empty worklist.
    worklist: document.querySelectorAll('.briefing-worklist ul li').length,
    hasStale: document.body.innerText.includes('Showing a saved copy'),
    hasEmpty: document.body.innerText.includes('No briefing has been read'),
  }))
  note(`${vp.name}: the participant table drew all 26 rows`, rendered.rows >= 26, `${rendered.rows} rows`)
  note(`${vp.name}: the worklist drew its actions`, rendered.worklist > 0, `${rendered.worklist} list items`)
  note(`${vp.name}: it says the numbers are a saved copy`, rendered.hasStale && !rendered.hasEmpty)

  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth > window.innerWidth + 1,
    bodyWidth: document.body.scrollWidth,
    inner: window.innerWidth,
    // Which element sticks out, if any. A bare "the body overflows" is not
    // actionable, and on a page whose densest element is a table it is almost
    // always the table.
    widest: [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className || '-'}`),
  }))
  note(
    `${vp.name}: no horizontal body overflow`,
    !overflow.body,
    `${overflow.bodyWidth}px in ${overflow.inner}px; widest: ${overflow.widest.join(', ') || 'none'}`,
  )

  // THE ASSERTION THE BODY-OVERFLOW CHECK DOES NOT MAKE. Rows are ranked on Total
  // and Total carries the unseen pill, so a Total sitting inside `.dt-wrap`'s
  // horizontal scroller is the whole table failing quietly. Measured
  // geometrically against the viewport, on every row, because the first two
  // screenshots both passed every other check with this column off screen.
  const totals = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.briefing-coverage table tbody tr')]
    const offscreen = rows.filter((tr) => {
      const cells = tr.querySelectorAll('td')
      const last = cells[cells.length - 1]
      if (!last) return true
      const r = last.getBoundingClientRect()
      return r.right > window.innerWidth + 1 || r.left < 0 || r.width === 0
    })
    return { total: rows.length, offscreen: offscreen.length }
  })
  note(
    `${vp.name}: every row's Total is on screen, not behind a scroller`,
    totals.offscreen === 0 && totals.total > 0,
    `${totals.offscreen} of ${totals.total} off screen`,
  )

  // Geometric, not innerText: an overlay or a clipped container keeps text in the
  // DOM while putting it off screen, which is how a buried control passes a
  // presence check.
  const copyBtn = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Copy as markdown'))
    if (!btn) return null
    const r = btn.getBoundingClientRect()
    return { right: r.right, left: r.left, width: r.width, inner: window.innerWidth }
  })
  note(
    `${vp.name}: the copy button is on screen and clickable`,
    Boolean(copyBtn && copyBtn.width > 0 && copyBtn.left >= 0 && copyBtn.right <= copyBtn.inner + 1),
    copyBtn ? `${Math.round(copyBtn.left)}..${Math.round(copyBtn.right)} of ${copyBtn.inner}` : 'not found',
  )

  await page.screenshot({ path: `${SHOTS}/briefing-${vp.name}.png`, fullPage: true })

  // The evaluator card, on the home the audit also walks. Asserted, not merely
  // photographed: clause 10 names the card, and a screenshot nobody diffs would
  // not notice the day `LeastWatched` started returning null.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const card = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('h2')]
    const h = heads.find((el) => el.textContent?.includes('Least watched'))
    if (!h) return null
    const list = h.parentElement?.querySelectorAll('li') ?? []
    const text = h.parentElement?.textContent ?? ''
    return {
      items: list.length,
      // Names and counts only: no designation digit out of 3, no email.
      leaksEmail: /@/.test(text),
      leaksDesignation: /\b[0-3]\s*\/\s*3\b/.test(text),
      onScreen: h.getBoundingClientRect().width > 0,
    }
  })
  note(
    `${vp.name}: the least-watched card renders names and counts only`,
    Boolean(card && card.items > 0 && card.onScreen && !card.leaksEmail && !card.leaksDesignation),
    card ? JSON.stringify(card) : 'card not found',
  )
  await page.screenshot({ path: `${SHOTS}/home-${vp.name}.png`, fullPage: true })

  const fresh = errors.slice(before)
  note(`${vp.name}: no page errors`, fresh.length === 0, fresh.slice(0, 2).join(' | '))

  await ctx.close()
}

await browser.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
console.log(`screenshots in ${SHOTS}/`)
process.exit(failed.length === 0 ? 0 : 1)
