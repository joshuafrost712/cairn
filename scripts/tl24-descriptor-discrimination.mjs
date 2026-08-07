/**
 * tl-24's honesty check: can a second reader put the four descriptors of a
 * question back in order, with the numbers taken off?
 *
 * The failure this catches is the one the spec names: "cannot yet / partially /
 * adequately / excellently" is four labels for the same empty sentence. A rubric
 * whose four points do not describe four distinguishable things reads fine and
 * cannot be used, and no count of rows detects it. If a reader who has never seen
 * the guide can recover the intended order from the evidence alone, the descriptors
 * are doing work.
 *
 *   node scripts/tl24-descriptor-discrimination.mjs [--model qwen3.5:9b] [--codes CC-IP1,CC-DR1]
 *
 * Runs on LOCAL Qwen through Ollama, deliberately: this is high-volume,
 * shape-bounded classification, which is exactly the work that should not cost
 * frontier tokens. It is also the right kind of second reader — it has not read the
 * facilitator guide and cannot be cueing off remembered context.
 *
 * Shuffles are a fixed table rather than random, so a re-run is comparable to the
 * last one and a regression is a real change in the text.
 */
const PROJECT = 'vdbirmjvjzfdgajwgowj'
const WORKSHOP = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'
const OLLAMA = 'http://127.0.0.1:11434/api/generate'

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i === -1 ? fallback : process.argv[i + 1]
}
const MODEL = arg('--model', 'qwen3.5:9b')
const only = arg('--codes', null)?.split(',').map((s) => s.trim())

/** One permutation per question, so no presented order is the true order. */
const SHUFFLES = [
  [2, 0, 3, 1], [1, 3, 0, 2], [3, 1, 2, 0], [0, 2, 1, 3], [2, 3, 0, 1],
  [1, 0, 3, 2], [3, 2, 1, 0], [0, 3, 2, 1], [2, 1, 0, 3],
]

const { execFileSync } = await import('node:child_process')
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
  if (!res.ok) throw new Error(`query failed ${res.status}: ${await res.text()}`)
  return res.json()
}

const rows = await sql(`
  select code, short_label, evidence_levels
  from ksa where workshop_id = '${WORKSHOP}' order by code
`)
const questions = rows.filter((r) => !only || only.includes(r.code))
if (!questions.length) throw new Error('no questions matched')

async function ask(prompt) {
  const res = await fetch(OLLAMA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // `think: false` matters more than it looks. qwen3.5 is a hybrid thinking model
    // and Ollama returns its reasoning in a separate `thinking` field, so a question
    // it deliberates over comes back with `response` EMPTY — which the first run of
    // this harness scored as "a reader could not tell these four apart". An empty
    // answer is not a wrong answer, and the two must not share a verdict.
    body: JSON.stringify({ model: MODEL, prompt, stream: false, think: false, options: { temperature: 0 } }),
  })
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`)
  const { response, thinking } = await res.json()
  return (response || thinking || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

const LETTERS = ['A', 'B', 'C', 'D']
let exact = 0
let adjacent = 0
const report = []

for (const [i, q] of questions.entries()) {
  const shuffle = SHUFFLES[i % SHUFFLES.length]
  // presented[n] holds the true point (0-3) shown as letter n
  const presented = shuffle
  const shown = presented
    .map((truePoint, n) => `${LETTERS[n]}. ${q.evidence_levels[String(truePoint)]}`)
    .join('\n\n')

  const prompt = `Below are four descriptions of how one person might perform a single task, taken from an assessment rubric. They describe four different levels of the same skill, but they are in random order and the levels have been removed.

Put them in order from WEAKEST performance to STRONGEST performance.

${shown}

Answer with four letters separated by commas, weakest first, and nothing else. Example: C, A, D, B`

  const reply = await ask(prompt)
  const guessLetters = (reply.toUpperCase().match(/[ABCD]/g) ?? []).filter(
    (l, idx, all) => all.indexOf(l) === idx,
  )
  // Translate the guessed presentation order into the true points it implies.
  const guessedPoints = guessLetters.map((l) => presented[LETTERS.indexOf(l)])
  const ok = guessedPoints.length === 4 && guessedPoints.every((p, n) => p === n)
  // "Adjacent" = every descriptor is at most one place from where it belongs. A
  // rubric whose 2 and 3 are hard to separate is a different (milder) finding from
  // one whose 0 and 3 are interchangeable, and collapsing them would hide that.
  const near =
    guessedPoints.length === 4 && guessedPoints.every((p, n) => Math.abs(p - n) <= 1)

  if (ok) exact++
  else if (near) adjacent++

  report.push({ code: q.code, label: q.short_label, guessed: guessedPoints, exact: ok, adjacent: near, reply })
  const verdict = ok ? 'EXACT' : near ? 'off by one' : 'WRONG'
  console.log(`${q.code.padEnd(8)} ${verdict.padEnd(10)} recovered order: ${guessedPoints.join(' → ')}   (${q.short_label})`)
  // A reply that yielded fewer than four distinct letters is a HARNESS failure, not
  // a rubric failure, and the two must never be reported as the same thing.
  if (guessedPoints.length !== 4) console.log(`  ↳ unparsed reply: ${JSON.stringify(reply).slice(0, 400)}`)
}

console.log(
  `\n${MODEL}: ${exact}/${questions.length} recovered exactly, ${adjacent} off by one, ` +
    `${questions.length - exact - adjacent} genuinely wrong.`,
)
const failures = report.filter((r) => !r.exact && !r.adjacent)
if (failures.length) {
  console.log(`\nRewrite candidates (a reader could not tell these four apart):`)
  for (const f of failures) console.log(`  ${f.code} — ${f.label}`)
}
