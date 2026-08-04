/**
 * tl-15 schema acceptance, against the LIVE project.
 *
 * SQL is tested where SQL runs. The brief validator, the re-declared trigger and the
 * function grants all live in Postgres, so a vitest assertion about them would be a claim
 * about a file rather than about the database the app writes to. `test/brief.test.ts` reads
 * the migration to keep the caps in step with the client; this runs it.
 *
 * What it proves, in order:
 *   1. `ai_config.brief` exists, is jsonb, is not null and defaults to `{}`.
 *   2. A legal brief is accepted, and read back as it was written.
 *   3. Each illegal shape is refused with its own slug: an unknown key, a non-array
 *      local_files, too many paths, an over-long path, a non-string path, an over-long
 *      note, a non-string note.
 *   4. The three invariants the trigger already enforced still fire, which is the risk of
 *      re-declaring it: a bad function map, bad assumptions, and hosted-api while the
 *      deployment switch is off.
 *   5. The three validators are executable by NOBODY but the definer's own path — no
 *      `anon`, no `authenticated` — which is the gap tl-23 found twice.
 *   6. `ai_config` is still not writable by `anon`, so nothing in this migration widened
 *      the table it altered.
 *
 * Fixture-scoped: one workshop (a6000000-...-ff15) created and deleted in teardown, so the
 * deployment's real rows are never touched.
 *
 *   node scripts/tl15-schema-checks.mjs
 */
import { execFileSync } from 'node:child_process'

const PROJECT = 'vdbirmjvjzfdgajwgowj'
const WS = 'a6000000-0000-4000-8000-00000000ff15'

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
  if (!res.ok) throw new Error(text.slice(0, 600))
  return text ? JSON.parse(text) : null
}

/** Run a batch expected to raise; returns the error text ('' when it succeeded). */
async function sqlError(query) {
  try {
    await sql(query)
    return ''
  } catch (err) {
    return String(err.message ?? err)
  }
}

const results = []
const check = (ok, label, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label.slice(0, 68).padEnd(68)} | ${String(detail).slice(0, 80)}`)
}

const setBrief = (brief) => `
  insert into ai_config (workshop_id, mode, functions, brief)
  values ('${WS}', 'github-claude', '{}'::jsonb, '${JSON.stringify(brief).replace(/'/g, "''")}'::jsonb)
  on conflict (workshop_id) do update set brief = excluded.brief;
`

// Fixture workshop, so the ai_config row has something to reference.
await sql(`
  insert into workshop (id, name, start_date, end_date, location, languages)
  values ('${WS}', 'tl15 schema fixture', '2026-08-24', '2026-09-04', 'nowhere', '{}')
  on conflict (id) do nothing;
`)

try {
  // 1. The column.
  {
    const rows = await sql(`
      select data_type, is_nullable, column_default
      from information_schema.columns
      where table_name = 'ai_config' and column_name = 'brief';
    `)
    const row = rows?.[0]
    check(Boolean(row), '1. ai_config.brief exists')
    check(row?.data_type === 'jsonb', '1. it is jsonb', row?.data_type)
    check(row?.is_nullable === 'NO', '1. not null', row?.is_nullable)
    check(String(row?.column_default ?? '').includes("'{}'"), '1. defaults to an empty object', row?.column_default)
  }

  // 2. A legal brief round-trips.
  {
    const brief = {
      local_files: ['/Users/j/Curriculum', '/Users/j/Day3.docx'],
      local_files_note: 'Day 3 is the session this workshop is built around.',
      pack_generated_at: '2026-08-04T09:00:00.000Z',
    }
    const err = await sqlError(setBrief(brief))
    check(err === '', '2. a legal brief is accepted', err.slice(0, 60))
    const rows = await sql(`select brief from ai_config where workshop_id = '${WS}';`)
    const stored = rows?.[0]?.brief
    check(
      JSON.stringify(stored?.local_files) === JSON.stringify(brief.local_files) &&
        stored?.local_files_note === brief.local_files_note &&
        stored?.pack_generated_at === brief.pack_generated_at,
      '2. and reads back exactly as written',
      JSON.stringify(stored).slice(0, 70),
    )
  }

  // 3. Each illegal shape, each with its own slug.
  {
    const cases = [
      [{ nonsense: 1 }, 'tl15.unknown_brief_key', 'an unknown key'],
      [{ local_files: 'one path' }, 'tl15.local_files_must_be_an_array', 'a string instead of an array'],
      [
        { local_files: Array.from({ length: 21 }, (_, i) => `/p${i}`) },
        'tl15.too_many_local_files',
        '21 paths',
      ],
      [{ local_files: ['/' + 'x'.repeat(501)] }, 'tl15.local_file_is_too_long', 'a 502-character path'],
      [{ local_files: [42] }, 'tl15.local_file_must_be_a_string', 'a number in the array'],
      [{ local_files_note: 'n'.repeat(2001) }, 'tl15.note_is_too_long', 'a 2001-character note'],
      [{ local_files_note: 42 }, 'tl15.note_must_be_a_string', 'a number as the note'],
      [{ pack_generated_at: 42 }, 'tl15.pack_generated_at_must_be_a_string', 'a number as the timestamp'],
    ]
    for (const [brief, slug, label] of cases) {
      const err = await sqlError(setBrief(brief))
      check(err.includes(slug), `3. refuses ${label}`, err ? slug : 'ACCEPTED IT')
    }
    // And null for a key is legal, because "cleared" is a real state.
    const err = await sqlError(setBrief({ local_files: null, local_files_note: null, pack_generated_at: null }))
    check(err === '', '3. accepts an explicitly cleared brief', err.slice(0, 50))
  }

  // 4. Re-declaring the trigger kept the invariants it already had.
  {
    const badFunctions = await sqlError(`
      update ai_config set functions = '{"not_a_function":{"enabled":true}}'::jsonb where workshop_id = '${WS}';
    `)
    check(badFunctions.includes('tl13.'), '4. a bad function map is still refused', badFunctions.slice(0, 60) || 'ACCEPTED IT')

    const badAssumption = await sqlError(`
      update ai_config set assumptions = '{"captureChars":-1}'::jsonb where workshop_id = '${WS}';
    `)
    check(
      badAssumption.includes('tl14.assumption_must_not_be_negative'),
      '4. a negative assumption is still refused',
      badAssumption.slice(0, 60) || 'ACCEPTED IT',
    )

    const hosted = await sqlError(`update ai_config set mode = 'hosted-api' where workshop_id = '${WS}';`)
    check(
      hosted.includes('tl13.hosted_ai_not_enabled_here'),
      '4. hosted-api is still refused while the deployment switch is off',
      hosted.slice(0, 60) || 'ACCEPTED IT',
    )
  }

  // 5. Nobody but the definer's path may execute the validators.
  {
    const rows = await sql(`
      select p.proname,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
             has_function_privilege('service_role', p.oid, 'execute') as service_role
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('ai_brief_is_legal', 'ai_assumptions_are_legal', 'ai_functions_are_legal')
      order by p.proname;
    `)
    check(rows?.length === 3, '5. all three validators are present', `${rows?.length}`)
    for (const row of rows ?? []) {
      check(
        row.anon === false && row.authenticated === false,
        `5. ${row.proname} is not executable by anon or authenticated`,
        `anon ${row.anon}, authenticated ${row.authenticated}`,
      )
    }
  }

  // 6. Nothing widened the table this migration altered.
  {
    const rows = await sql(`
      select
        has_table_privilege('anon', 'ai_config', 'select') as anon_select,
        has_table_privilege('anon', 'ai_config', 'insert') as anon_insert,
        has_table_privilege('authenticated', 'ai_config', 'delete') as auth_delete;
    `)
    const row = rows?.[0]
    check(
      row?.anon_select === false && row?.anon_insert === false && row?.auth_delete === false,
      '6. ai_config grants are unchanged: anon has none, authenticated cannot delete',
      JSON.stringify(row),
    )
  }
} finally {
  await sql(`delete from ai_config where workshop_id = '${WS}'; delete from workshop where id = '${WS}';`)
}

const passed = results.filter(Boolean).length
console.log(`\ntl-15 schema checks: ${passed}/${results.length} passed.`)
process.exit(passed === results.length ? 0 : 1)
