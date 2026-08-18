/**
 * Does typing move the page? Measured, not eyeballed.
 *
 * Joshua reported that the screen jiggled up and down while people typed, because
 * the online/synced indicator lived in the sticky header and rewrote itself on
 * every keystroke of a capture. The fix floats it in a corner. "It looks fine now"
 * is not evidence that it is fixed — the shift was a few pixels several times a
 * second, which is exactly the size of thing a person stops seeing once they know
 * it is there. So this reads the numbers.
 *
 * Two checks, and the second is the one that would have caught the original bug:
 *
 *   1. TYPE. Open a real capture, type a sentence into an answer box, and compare
 *      `.shell__main`'s top edge before and after. Equal or it fails.
 *   2. TOGGLE. Force the state change directly — add and remove a pending row in
 *      IndexedDB — and re-measure. This is the mechanism rather than a symptom: the
 *      pending count appearing is what resized the header, and the live query fires
 *      on the write whether a keyboard was involved or not. It also measures the
 *      wide sidebar, which pinned itself to a hardcoded header height and drifted
 *      whenever the header changed.
 *
 * Needs the dev server from ui-responsive-audit.mjs's header running on 5198:
 *   VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npx vite --port 5198 --strictPort
 *   node scripts/sync-badge-shift-probe.mjs
 */
import { chromium } from 'playwright'

const BASE = 'http://localhost:5198/'
let failures = 0

const note = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures++
}

/**
 * Top edge of the content area, and of the sidebar when the layout has one.
 *
 * DOCUMENT coordinates, not viewport ones: a textarea that grows as you type
 * scrolls the page, and a viewport-relative reading would then report a "shift"
 * that is really the scroll, or worse, hide a real one that the scroll cancelled
 * out. Adding scrollY back asks the question that matters — did this element move
 * within the document.
 */
const edges = (page) =>
  page.evaluate(() => {
    const main = document.querySelector('.shell__main')
    const nav = document.querySelector('.shell__nav')
    const badge = document.querySelector('.syncbadge')
    const round = (n) => Math.round(n * 100) / 100
    return {
      mainTop: main ? round(main.getBoundingClientRect().top + window.scrollY) : null,
      navTop: nav ? round(nav.getBoundingClientRect().top + window.scrollY) : null,
      headerH: getComputedStyle(document.querySelector('.shell')).getPropertyValue('--header-h').trim(),
      badgeText: badge ? badge.textContent.trim() : null,
      badgePosition: badge ? getComputedStyle(badge).position : null,
      badgeWidth: badge ? round(badge.getBoundingClientRect().width) : null,
    }
  })

/** Short label for a badge whose stranded text is a whole paragraph. */
const brief = (text) => (text ?? '').slice(0, 60).replace(/\s+/g, ' ')

/** Add then remove a pending observation, which is what the badge counts. */
const togglePending = (page, present) =>
  page.evaluate(
    (add) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('cairn')
        req.onsuccess = () => {
          const idb = req.result
          const tx = idb.transaction('observations', 'readwrite')
          const store = tx.objectStore('observations')
          if (add) {
            store.put({
              id: 'shift-probe::0',
              capture_client_id: 'shift-probe',
              workshop_id: null,
              participant_id: 'shift-probe-participant',
              participant_name: 'Shift Probe Participant',
              ksa_code: 'Q1',
              text: 'Seeded by the sync-badge shift probe.',
              source_excerpt: 'seeded by the shift probe',
              evidence_designation: 2,
              sentiment_flag: 'neutral',
              confidence: 'medium',
              needs_review: false,
              origin: 'individual',
              imported_at: new Date(0).toISOString(),
              evaluator_email: null,
              sync_status: 'local',
            })
          } else {
            store.delete('shift-probe::0')
          }
          tx.oncomplete = () => {
            idb.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
        req.onerror = () => reject(req.error)
      }),
    present,
  )

const browser = await chromium.launch()

for (const viewport of [
  { width: 1400, height: 1000, label: 'laptop 1400x1000' },
  { width: 390, height: 844, label: 'phone 390x844' },
]) {
  const ctx = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.width < 900,
    hasTouch: viewport.width < 900,
  })
  const page = await ctx.newPage()
  console.log(`\n---- ${viewport.label} ----`)

  await page.goto(BASE + 'signin', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#name', { timeout: 20000 })
  await page.fill('#name', 'Shift Probe')
  await page.fill('#email', 'shift-probe@example.org')
  await page.click('button[type=submit]')
  await page.waitForTimeout(2000)

  // ---- 1. typing in a real capture ----
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const activity = page.locator('.activity-item').first()
  const haveActivity = (await activity.count()) > 0
  if (!haveActivity) {
    note(`${viewport.label}: an activity to capture against`, false, 'no .activity-item on Home')
  } else {
    await activity.click()
    await page.waitForTimeout(1800)
    const box = page.locator('textarea').first()
    const haveBox = (await box.count()) > 0
    if (!haveBox) {
      note(`${viewport.label}: an answer box to type in`, false, 'no textarea on the capture page')
    } else {
      // Scroll the box into view first, so the reading is not a scroll artefact.
      await box.scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      await box.click()
      const before = await edges(page)
      // Type slowly enough that the live query fires between letters, which is the
      // condition that produced the jiggle. `delay` is what makes this a real test.
      //
      // A local-only dev build has no backend, so a row never returns to `synced`
      // and the count cannot oscillate by itself the way it does in production.
      // Toggling a pending row mid-sentence supplies that half by hand: the badge
      // resizes with the caret in the box, which is exactly what Joshua saw.
      await box.type('The trainee retold the passage in her own words', { delay: 25 })
      await togglePending(page, true)
      await page.waitForTimeout(700)
      const midSentence = await edges(page)
      await box.type(' and checked it against the source.', { delay: 25 })
      await togglePending(page, false)
      await page.waitForTimeout(700)
      const after = await edges(page)
      note(
        `${viewport.label}: typing does not move the content area`,
        before.mainTop === midSentence.mainTop && midSentence.mainTop === after.mainTop,
        `mainTop ${before.mainTop} -> ${midSentence.mainTop} -> ${after.mainTop}`,
      )
      note(
        `${viewport.label}: the badge is fixed`,
        after.badgePosition === 'fixed',
        `position: ${after.badgePosition}`,
      )

      // The invariant itself, proved rather than inferred: make the badge grow by a
      // lot, with the caret still in the box, and nothing else may budge.
      //
      // This is here because the state-driven version of the check cannot run in a
      // local-only build. With no backend the row never returns to `synced`, so the
      // count never oscillates, and the "cannot send" paragraph pins the badge at
      // its max width — the badge's box is the one thing that CANNOT change size in
      // a dev build, which is the opposite of production. Forcing the growth asks
      // the question a keystroke asks in production, and asks it harder.
      const grown = await page.evaluate(() => {
        const badge = document.querySelector('.syncbadge')
        const line = badge.querySelector('.syncbadge__line')
        const wasHeight = badge.getBoundingClientRect().height
        const probe = document.createElement('div')
        probe.id = 'shift-probe-bulk'
        probe.textContent = 'x '.repeat(400)
        line.appendChild(probe)
        return { wasHeight, nowHeight: badge.getBoundingClientRect().height }
      })
      const withBulk = await edges(page)
      await page.evaluate(() => document.getElementById('shift-probe-bulk')?.remove())
      note(
        `${viewport.label}: the badge really did grow for this check`,
        grown.nowHeight > grown.wasHeight + 10,
        `badge height ${Math.round(grown.wasHeight)} -> ${Math.round(grown.nowHeight)}px`,
      )
      note(
        `${viewport.label}: a much bigger badge still moves nothing`,
        after.mainTop === withBulk.mainTop,
        `mainTop ${after.mainTop} -> ${withBulk.mainTop}`,
      )
    }
  }

  // ---- 2. the state change itself ----
  // /observations is a WIDE page, and that is the point: only a wide layout renders
  // `.shell__nav`, which is the element that pinned itself to a hardcoded header
  // height. Probing a narrow route measures nothing about the sidebar and reports a
  // pass for a check that never ran — which is what the first version of this file
  // did on /evaluations.
  await page.goto(BASE + 'observations', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await togglePending(page, false)
  await page.waitForTimeout(900)
  const empty = await edges(page)
  await togglePending(page, true)
  await page.waitForTimeout(900)
  const pending = await edges(page)
  await togglePending(page, false)
  await page.waitForTimeout(900)
  const emptyAgain = await edges(page)

  note(
    `${viewport.label}: a pending item appearing does not move the content area`,
    empty.mainTop === pending.mainTop && pending.mainTop === emptyAgain.mainTop,
    `mainTop ${empty.mainTop} -> ${pending.mainTop} -> ${emptyAgain.mainTop}`,
  )
  note(
    `${viewport.label}: nor the sidebar`,
    empty.navTop === pending.navTop && pending.navTop === emptyAgain.navTop,
    `navTop ${empty.navTop} -> ${pending.navTop} -> ${emptyAgain.navTop} | --header-h ${pending.headerH || '(unset)'}`,
  )
  if (viewport.width >= 900) {
    // The sidebar must sit exactly under the header, not a measured-once 57px down.
    note(
      `${viewport.label}: the sidebar starts where the header ends`,
      pending.navTop !== null && Math.abs(pending.navTop - parseFloat(pending.headerH)) <= 1,
      `navTop ${pending.navTop} vs --header-h ${pending.headerH || '(unset)'}`,
    )
  }
  note(
    `${viewport.label}: the badge did report the pending item`,
    /not sent yet/.test(pending.badgeText ?? ''),
    `badge read "${brief(pending.badgeText)}"`,
  )
  note(
    `${viewport.label}: the badge fits the viewport`,
    pending.badgeWidth !== null && pending.badgeWidth <= viewport.width,
    `badge ${pending.badgeWidth}px in ${viewport.width}px`,
  )
  note(
    `${viewport.label}: --header-h is measured, not the 57px default`,
    /^\d+px$/.test(pending.headerH ?? ''),
    `--header-h: ${pending.headerH || '(unset)'}`,
  )

  await ctx.close()
}

await browser.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
