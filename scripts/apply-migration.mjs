/**
 * Apply one migration file to the linked Supabase project.
 *
 * `supabase db push` is the normal path and stays the documented one. This exists
 * because the CLI is not always logged in on this machine, while the Management
 * API access token is (see the vault memory for where it lives), and because a
 * migration applied here is applied as `postgres` — the same footing the CLI uses.
 *
 *   node scripts/apply-migration.mjs supabase/migrations/<file>.sql
 *
 * It does NOT record the file in supabase_migrations.schema_migrations, so run
 * `supabase migration repair --status applied <version>` before the next
 * `db push` on a machine where the CLI is linked.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const PROJECT = 'vdbirmjvjzfdgajwgowj'
const file = process.argv[2]
if (!file) throw new Error('usage: node scripts/apply-migration.mjs <path to .sql>')

const accessToken = execFileSync('/bin/zsh', [
  '-c',
  'set -a; . ~/.claude/secrets/supabase.env; set +a; printf %s "$SUPABASE_ACCESS_TOKEN"',
]).toString()

const query = readFileSync(file, 'utf8')
const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }),
})
const text = await res.text()
if (!res.ok) {
  console.error(`FAILED ${res.status}\n${text}`)
  process.exit(1)
}
console.log(`applied ${file}`)
// Full result, not a preview: these files are also used as test harnesses whose
// last statement IS the report, and a truncated report is a report you cannot read.
if (text.trim() && text.trim() !== '[]') console.log(text)
