/**
 * tl-16's client half, in a browser, because none of it can be proved from a module.
 *
 * The server half is `scripts/tl16-session-tests.mjs` (real JWTs, real policies, refusals
 * read off the wire). `test/templates.test.ts` covers the specs, the validator and the
 * classifier, and `test/tl16DefaultOutput.test.ts` proves the shipped defaults render
 * byte-identically to the pre-tl-16 build. What is left is the loop the spec's acceptance
 * actually describes, which no unit test touches: an administrator types a sentence,
 * PROPOSES it, sees that nothing has changed yet, APPROVES it through tl-07's dialog, and
 * finds the new wording in a generated document — then puts the shipped text back.
 *
 * What is under test, in order:
 *   1. Every group renders, with a slot count and a shipped/yours badge.
 *   2. A slot opens on its STORED body, shows its declared variables, and previews
 *      against this workshop's real data rather than invented names.
 *   3. A misspelled variable is refused ON SAVE with the variable named, and the Propose
 *      button is disabled while it is wrong — the failure this validator exists for.
 *   4. Proposing changes NOTHING an evaluator would read: the resolved body is still the
 *      shipped one, and the slot says a proposal is waiting.
 *   5. Approving goes through the change dialog (it is `affects_future`, never silent),
 *      and only then does the stored body move.
 *   6. The new wording reaches a GENERATED PARTICIPANT EMAIL. This is the acceptance
 *      criterion and the only check here that crosses from the editor into an output.
 *   7. A pending draft generated before the change carries the "the wording was changed"
 *      notice rather than being rewritten underneath its reviewer.
 *   8. Reverting proposes the shipped text, and approving that DELETES the row rather
 *      than storing the default as an override.
 *   9. An instruction template's approval dialog carries the mid-workshop caveat, with a
 *      real capture count in it.
 *  10. Nothing on the page offers a schema, a validator or an attestation to edit.
 *
 *   VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npx vite --port 5196 --strictPort
 *   node scripts/tl16-templates.mjs
 *
 * Local-only mode (both Supabase vars blank), which is what makes it runnable with
 * nobody's password: sign-in synthesizes a membership in Dexie and `elevate()` promotes
 * it. Nothing here proves anything about authorization — that is the session harness's
 * job, and the two must not be confused.
 *
 * Port 5196, not the dev default and not tl-13's 5197: a harness pointed at another
 * worktree's server is the worst possible green. If you move the server, move this.
 *
 * Playwright is deliberately not a dependency:
 *   npm i -D --no-save playwright && npx playwright install chromium
 */
import { chromium } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'

const BASE = `http://localhost:${process.env.TL16_PORT ?? 5196}/`
const SHOTS = 'screenshots/tl16-templates'

const results = []
const check = (ok, label, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label.slice(0, 68).padEnd(68)} | ${String(detail).slice(0, 76)}`)
}

rmSync(SHOTS, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})

async function signIn() {
  await page.goto(BASE + 'signin', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#name', { timeout: 20000 })
  await page.fill('#name', 'tl16 Auditor')
  await page.fill('#email', 'tl16-auditor@example.org')
  await page.click('button[type=submit]')
  await page.waitForTimeout(1500)
}

/** Promote the synthesized membership so the admin routes render rather than bounce. */
async function elevate() {
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
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
}

/**
 * Seed one submitted capture plus one observation, so a participant email can be
 * generated and the instruction caveat has a real number behind it.
 */
async function seedEvidence() {
  return await page.evaluate(async () => {
    return await new Promise((resolve, reject) => {
      const req = indexedDB.open('cairn')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['workshops', 'participants', 'ksas', 'evaluations', 'observations'], 'readwrite')
        const ws = tx.objectStore('workshops').getAll()
        ws.onsuccess = () => {
          const workshop = ws.result[0]
          const ps = tx.objectStore('participants').getAll()
          ps.onsuccess = () => {
            const person = ps.result.find((p) => p.workshop_id === workshop.id) ?? ps.result[0]
            const ks = tx.objectStore('ksas').getAll()
            ks.onsuccess = () => {
              const question = ks.result[0]
              tx.objectStore('evaluations').put({
                client_id: 'tl16-cap-1',
                workshop_id: workshop.id,
                activity_id: 'tl16-act',
                evaluator_email: 'tl16-auditor@example.org',
                source_language: 'en',
                answers: { k: 'they named the genre and defended it' },
                quick_ratings: {},
                participant_scope: [person.id],
                focus_participant_id: person.id,
                source_text: 'they named the genre and defended it',
                attestation: true,
                ruleset_version: 'v1',
                edit_history: [],
                sync_status: 'local',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              tx.objectStore('observations').put({
                id: 'tl16-obs-1',
                capture_client_id: 'tl16-cap-1',
                workshop_id: workshop.id,
                participant_id: person.id,
                participant_name: person.name,
                ksa_code: question.code,
                text: 'named the genre and defended it',
                source_excerpt: 'named the genre',
                evidence_designation: 3,
                sentiment_flag: 'strong',
                confidence: 'high',
                needs_review: false,
                origin: 'individual',
                evaluator_email: 'tl16-auditor@example.org',
                routed_at: new Date().toISOString(),
              })
              tx.oncomplete = () => {
                db.close()
                resolve({ workshopId: workshop.id, participantId: person.id, participantName: person.name })
              }
            }
          }
        }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })
  })
}

/** Every ai_template row on the device, so an assertion can read the STORED truth. */
const storedRows = () =>
  page.evaluate(async () => {
    return await new Promise((resolve, reject) => {
      const req = indexedDB.open('cairn')
      req.onsuccess = () => {
        const db = req.result
        const all = req.result.transaction('aiTemplates', 'readonly').objectStore('aiTemplates').getAll()
        all.onsuccess = () => {
          db.close()
          resolve(all.result.map((r) => ({ key: r.template_key, body: r.body })))
        }
        all.onerror = () => reject(all.error)
      }
      req.onerror = () => reject(req.error)
    })
  })

/** Open the Templates section and expand one group by its heading text. */
async function openGroup(heading) {
  await page.goto(BASE + 'admin/setup/templates', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
  await page.getByRole('button', { expanded: false }).filter({ hasText: heading }).first().click()
  await page.waitForTimeout(500)
}

const box = (label) => page.getByRole('textbox', { name: label })

/**
 * The ONE editor block for a slot, scoped by the textarea inside it.
 *
 * Written the obvious way first — `page.getByRole('button', { name: 'Propose this
 * change' }).first()` — and that is a bug worth recording rather than quietly fixing:
 * every open slot renders a Propose button, so `.first()` reached the GREETING's, which
 * is disabled because the greeting was never edited. The "Propose is disabled while the
 * body is invalid" check therefore passed while measuring a different slot's untouched
 * button, and the harness only failed one check later when it tried to click it. A
 * harness that finds the wrong element is the same class of green as one pointed at the
 * wrong port.
 */
const editor = (label) => page.locator('.activity-item').filter({ has: box(label) })
const editorButton = (label, name) => editor(label).getByRole('button', { name })

/** Accept whatever tl-07's dialog is asking, then wait for the commit. */
async function acceptDialog() {
  const confirm = page
    .locator('button')
    .filter({ hasText: /Save|Apply|Confirm|I understand|Continue/i })
    .last()
  await confirm.click()
  await page.waitForTimeout(900)
}

try {
  await signIn()
  await elevate()
  const seeded = await seedEvidence()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)

  // --- 1. the library renders ------------------------------------------------
  await page.goto(BASE + 'admin/setup/templates', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  const joined = await page.locator('body').innerText()
  check(joined.includes('Output templates'), 'the templates section renders')
  for (const g of [
    "The participant's evaluation email",
    'The facilitator digest',
    'The participant report',
    'General AI instructions',
    'AI: turning captures into observations',
  ]) {
    check(joined.includes(g), `the group "${g.slice(0, 40)}" is listed`)
  }
  check(!/\b1 slots\b/.test(joined), 'no group says "1 slots"', joined.match(/1 slots?[^,]*/)?.[0] ?? 'none')
  check(
    joined.includes('not editable here'),
    'the page says the schema and the attestation are not editable here',
  )
  await page.screenshot({ path: `${SHOTS}/01-library.png`, fullPage: true })

  // --- 2. a slot opens on its stored body, with its variables ----------------
  await openGroup("The participant's evaluation email")
  const intro = box('Opening paragraph')
  const openedOn = await intro.inputValue()
  check(
    openedOn.includes('{{workshopName}}') && openedOn.includes('{{minValue}}'),
    'the editor opens on the STORED body, with its tokens visible',
    openedOn.slice(0, 60),
  )
  // The whole page, not `div.card`. The groups are `<section className="card">` and the
  // top blurb is `<div className="card">`, so a `div.card` scope read only the blurb —
  // which is how "the declared variables are listed" failed over a UI that lists them.
  const sectionText = await editor('Opening paragraph').innerText()
  check(sectionText.includes('You can use:'), 'the declared variables are listed under the box',
    (sectionText.match(/You can use:[^\n]{0,50}/) ?? ['(not found)'])[0])
  check(sectionText.includes('Shipped'), 'an untouched slot is badged as shipped',
    (sectionText.match(/Shipped|Yours/) ?? ['(neither)'])[0])

  // The preview, against this workshop's real name rather than an invented one.
  await editorButton('Opening paragraph', 'Preview').click()
  await page.waitForTimeout(300)
  const previewText = await editor('Opening paragraph')
    .locator('.banner')
    .allInnerTexts()
    .then((t) => t.join('\n'))
  check(
    previewText.includes('Psalms') || previewText.includes(seeded.participantName.split(' ')[0]),
    'the preview renders against this workshop’s real data',
    previewText.slice(0, 70),
  )
  check(!previewText.includes('{{'), 'the preview leaves no unfilled token', previewText.slice(0, 60))
  await page.screenshot({ path: `${SHOTS}/02-slot-open.png`, fullPage: true })

  // --- 3. a misspelled variable is refused, and Propose is disabled ----------
  await intro.fill('Here is your work at {{wrkshopName}}.')
  await page.waitForTimeout(300)
  const errText = await editor('Opening paragraph')
    .locator('.banner.warn')
    .allInnerTexts()
    .then((t) => t.join('\n'))
  check(errText.includes('wrkshopName'), 'a misspelled variable is named on screen', errText.slice(0, 80))
  const proposeBtn = editorButton('Opening paragraph', 'Propose this change')
  check(await proposeBtn.isDisabled(), 'Propose is disabled while the body is invalid')
  await page.screenshot({ path: `${SHOTS}/03-invalid.png`, fullPage: true })

  // --- 4. proposing changes nothing -----------------------------------------
  const NEW_INTRO = 'Here is what we noticed at {{workshopName}} on {{dateLabel}}, scored {{minValue}} to {{maxValue}}.'
  await intro.fill(NEW_INTRO)
  await page.waitForTimeout(250)
  check(await proposeBtn.isEnabled(), 'Propose enables once the body is valid again')
  await proposeBtn.click()
  await page.waitForTimeout(700)
  check(
    (await storedRows()).length === 0,
    'proposing wrote NO override: nothing an evaluator reads has changed',
    JSON.stringify(await storedRows()),
  )
  const afterPropose = await page.locator('body').innerText()
  check(afterPropose.includes('Waiting for approval'), 'the proposal is listed as waiting')
  await page.screenshot({ path: `${SHOTS}/04-proposed.png`, fullPage: true })

  // --- 5. approving goes through the dialog, and only then does it land ------
  await page.getByRole('button', { name: 'Approve' }).first().click()
  await page.waitForTimeout(700)
  const dialogText = await page.locator('body').innerText()
  check(
    /Rewords|generated from now on/i.test(dialogText),
    'the change dialog states what a wording change costs',
    (dialogText.match(/Rewords[^\n]{0,70}/) ?? ['(not found)'])[0],
  )
  check(
    /untouched|approver read/i.test(dialogText),
    'the dialog says approved documents are untouched',
  )
  await page.screenshot({ path: `${SHOTS}/05-dialog.png`, fullPage: true })
  await acceptDialog()

  const rowsAfter = await storedRows()
  check(
    rowsAfter.length === 1 && rowsAfter[0].body === NEW_INTRO,
    'approving stored the override, and only then',
    JSON.stringify(rowsAfter).slice(0, 90),
  )

  // --- 6. the new wording reaches a generated participant email -------------
  // The acceptance criterion. Generated through the app's own path so nothing here
  // depends on a renderer the editor also happens to call.
  const generated = await page.evaluate(async (workshopId) => {
    const mod = await import('/src/db/drafts.ts')
    const ref = await import('/src/db/templates.ts')
    await ref.mirrorActiveTemplates(workshopId)
    const drafts = await mod.generateParticipantEmails({
      now: new Date().toISOString(),
      dateLabel: '2026-08-26',
      fromName: 'Josh',
      workshopId,
    })
    const seg = await import('/src/reports/segments.ts')
    return drafts.map((d) => ({
      id: d.id,
      fingerprint: d.templateFingerprint,
      markdown: seg.segmentsToMarkdown(d.segments),
    }))
  }, seeded.workshopId)
  check(generated.length > 0, 'a participant email was generated', `${generated.length} draft(s)`)
  check(
    generated.some((d) => d.markdown.includes('Here is what we noticed at')),
    'THE AUTHORED WORDING IS IN THE GENERATED EMAIL',
    generated[0]?.markdown.split('\n').find((l) => l.includes('Here is')) ?? '(not found)',
  )
  check(
    generated.every((d) => d.fingerprint && d.fingerprint !== 'default'),
    'the draft is stamped with the templates it came from',
    generated[0]?.fingerprint,
  )

  // --- 7. a draft generated before a change says so -------------------------
  const drift = await page.evaluate(async (workshopId) => {
    const state = await import('/src/drafts/state.ts')
    const res = await import('/src/templates/resolve.ts')
    const dbmod = await import('/src/db/local.ts')
    const all = await dbmod.db.docDrafts.toArray()
    const draft = all.find((d) => d.workshopId === workshopId && d.status === 'draft')
    if (!draft) return { found: false }
    const now = res.templateFingerprint(res.getActiveTemplates())
    // Pretend the wording moved after this draft was written.
    const stale = { ...draft, templateFingerprint: 'tSOMETHINGELSE' }
    return {
      found: true,
      quietWhenCurrent: state.templatesMoved(draft, now) === false,
      loudWhenMoved: state.templatesMoved(stale, now) === true,
      quietWhenApproved: state.templatesMoved({ ...stale, status: 'approved' }, now) === false,
      id: draft.id,
    }
  }, seeded.workshopId)
  check(drift.found && drift.quietWhenCurrent, 'a freshly generated draft is not called stale')
  check(drift.found && drift.loudWhenMoved, 'a draft written before the change IS called stale')
  check(drift.found && drift.quietWhenApproved, 'an approved document is never called stale')

  // The notice itself, in the Workbench.
  if (drift.found) {
    await page.evaluate(async (id) => {
      const dbmod = await import('/src/db/local.ts')
      await dbmod.db.docDrafts.update(id, { templateFingerprint: 'tSOMETHINGELSE' })
    }, drift.id)
    await page.goto(`${BASE}outgoing/${encodeURIComponent(drift.id)}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    const wbText = await page.locator('body').innerText()
    check(
      wbText.includes('The wording was changed after this was written'),
      'the Workbench shows the wording-moved notice',
      (wbText.match(/The wording was changed[^\n]{0,50}/) ?? ['(not found)'])[0],
    )
    check(
      !wbText.includes('The evidence moved after you edited this'),
      'it does NOT claim the evidence moved, which is a different fact',
    )
    await page.screenshot({ path: `${SHOTS}/06-drift-notice.png`, fullPage: true })
  }

  // --- 8. revert deletes the row rather than storing the default ------------
  await openGroup("The participant's evaluation email")
  const sectionNow = await editor('Opening paragraph').innerText()
  check(sectionNow.includes('Yours'), 'the reworded slot is badged as the workshop’s own',
    (sectionNow.match(/Shipped|Yours/) ?? ['(neither)'])[0])
  await editorButton('Greeting', 'Revert to shipped').click().catch(() => {})
  await editorButton('Opening paragraph', 'Revert to shipped').click()
  await page.waitForTimeout(700)
  await page.getByRole('button', { name: 'Approve' }).first().click()
  await page.waitForTimeout(700)
  await acceptDialog()
  const afterRevert = await storedRows()
  check(
    afterRevert.length === 0,
    'reverting DELETED the override rather than storing the default as one',
    JSON.stringify(afterRevert).slice(0, 90),
  )
  const revertText = await page.locator('body').innerText()
  check(
    /Reverted to the shipped wording/i.test(revertText),
    'the outcome says it was a revert, not an ordinary edit',
  )
  await page.screenshot({ path: `${SHOTS}/07-reverted.png`, fullPage: true })

  // --- 9. an instruction edit carries the mid-workshop caveat ---------------
  await openGroup('AI: turning captures into observations')
  const rules = box('Turning captures into observations')
  const current = await rules.inputValue()
  check(current.includes('{{range}}'), 'the routing instructions open with their scale token')
  await rules.fill(current.replace('Rules:', 'Rules (authored by this workshop):'))
  await page.waitForTimeout(250)
  await editorButton('Turning captures into observations', 'Propose this change').click()
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: 'Approve' }).first().click()
  await page.waitForTimeout(700)
  const instrDialog = await page.locator('body').innerText()
  check(
    /already been routed under the previous version/i.test(instrDialog),
    'the dialog carries the evidence-under-different-instructions caveat',
    (instrDialog.match(/capture\(s\) have already[^\n]{0,40}/) ?? ['(not found)'])[0],
  )
  // No `\b` after the closing paren: `)` and a following space are both non-word
  // characters, so a word boundary between them can never match. The first version of
  // this assertion failed while its own detail column printed "1 capture(s)".
  check(
    /[1-9]\d* capture\(s\)/.test(instrDialog),
    'the caveat quotes a real capture count',
    (instrDialog.match(/\d+ capture\(s\)/) ?? ['(none)'])[0],
  )
  await page.screenshot({ path: `${SHOTS}/08-instruction-dialog.png`, fullPage: true })
  await acceptDialog()

  // And it reaches the routing runbook, which is what every mode reads.
  const runbook = await page.evaluate(async (workshopId) => {
    const ref = await import('/src/db/templates.ts')
    const set = await ref.templatesForWorkshop(workshopId)
    const res = await import('/src/templates/resolve.ts')
    const ws = await import('/src/ai/workspace.ts')
    const scale = await import('/src/lib/scale.ts')
    return ws.renderRoutingDoc(scale.getActiveScale(), res.bodyFor(set, 'instructions.observation_routing'))
  }, seeded.workshopId)
  check(
    runbook.includes('Rules (authored by this workshop):'),
    'the authored instruction reaches the routing runbook every mode reads',
  )
  check(
    /evidence_designation \d+-\d+/.test(runbook),
    'and the scale range is still filled in, not left as a token',
    (runbook.match(/evidence_designation \S+/) ?? ['(none)'])[0],
  )

  // --- 10. nothing editable is a contract ----------------------------------
  await page.goto(BASE + 'admin/setup/templates', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  for (const heading of [
    "The participant's evaluation email",
    'The facilitator digest',
    'The participant report',
    'General AI instructions',
    'AI: turning captures into observations',
    'AI: drafting a scenario from a document',
    'AI: drafting conversation guidance',
  ]) {
    await page
      .getByRole('button', { expanded: false })
      .filter({ hasText: heading })
      .first()
      .click()
      .catch(() => {})
    await page.waitForTimeout(250)
  }
  const everyLabel = await page.locator('textarea').evaluateAll((els) =>
    els.map((e) => e.getAttribute('aria-label') ?? ''),
  )
  check(
    everyLabel.length > 0 &&
      !everyLabel.some((l) => /schema|attestation|ruleset|validator/i.test(l)),
    'no editable box is a schema, a validator or an attestation',
    `${everyLabel.length} editable slot(s)`,
  )

  check(errors.length === 0, 'no page errors throughout', errors.slice(0, 2).join(' | '))
} finally {
  await ctx.close()
  await browser.close()
}

const failed = results.filter((r) => !r).length
console.log(`\nScreenshots in ${SHOTS}/ — the human half of this walkthrough.`)
console.log(`${results.length - failed}/${results.length} PASS, ${failed} FAIL`)
if (failed) process.exit(1)
