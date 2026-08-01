/**
 * Diagnostic: WHICH element is making a route wider than the phone?
 *
 * The tl-19 audit says /admin/roster renders a 515px layout viewport on a 390px
 * phone. It does not say what did it, and guessing from the CSS is how a
 * responsive fix ends up being three unrelated changes hoping one of them worked.
 * So this walks the DOM of one route and reports every element whose border box
 * exceeds the emulated width, innermost first, with the offending computed
 * properties beside it.
 *
 * Not a gate. It is a probe kept in the repo because the next overflow will want
 * it too, and reconstructing it under time pressure is how the guessing starts.
 *
 *   node scripts/tl20-overflow-probe.mjs [route] [width]
 *
 * Needs the dev server from ui-responsive-audit.mjs's header running on 5198.
 */
import { chromium } from 'playwright'

const route = process.argv[2] ?? 'admin/roster'
const width = Number(process.argv[3] ?? 390)
const BASE = 'http://localhost:5198/'

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
})
const page = await ctx.newPage()

await page.goto(BASE + 'signin', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#name', { timeout: 20000 })
await page.fill('#name', 'tl20 Probe')
await page.fill('#email', 'tl20-probe@example.org')
await page.click('button[type=submit]')
await page.waitForTimeout(2000)

// Same promotion the audit does, for the same reason: an admin route bounces otherwise.
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
await page.goto(BASE + route, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

const report = await page.evaluate((emulated) => {
  const path = (el) => {
    const bits = []
    let node = el
    while (node && node !== document.body && bits.length < 6) {
      const cls = (node.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 3)
      bits.unshift(node.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : ''))
      node = node.parentElement
    }
    return bits.join(' > ')
  }
  const rows = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width <= emulated + 1) continue
    const cs = getComputedStyle(el)
    rows.push({
      path: path(el),
      width: Math.round(r.width),
      right: Math.round(r.right),
      text: (el.textContent ?? '').trim().slice(0, 40),
      // The usual suspects for a box that refuses to shrink.
      minWidth: cs.minWidth,
      flex: `${cs.flexGrow} ${cs.flexShrink} ${cs.flexBasis}`,
      display: cs.display,
      whiteSpace: cs.whiteSpace,
      overflowX: cs.overflowX,
      childCount: el.children.length,
    })
  }
  return {
    innerWidth: window.innerWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    // Innermost-widest first: the leaf that will not shrink is the cause; its
    // ancestors are only reporting it.
    rows: rows.sort((a, b) => a.childCount - b.childCount || b.width - a.width).slice(0, 25),
  }
}, width)

console.log(`route /${route} at ${width}px`)
console.log(`innerWidth=${report.innerWidth} documentElement.scrollWidth=${report.docScrollWidth}\n`)
for (const r of report.rows) {
  console.log(
    `${r.width}px (right ${r.right}) kids=${r.childCount} min-width:${r.minWidth} flex:${r.flex} ws:${r.whiteSpace} ovx:${r.overflowX}\n    ${r.path}\n    "${r.text}"\n`,
  )
}

await ctx.close()
await browser.close()
