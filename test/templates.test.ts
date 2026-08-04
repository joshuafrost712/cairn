import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  REQUIRED_VARIABLES,
  TEMPLATE_KEYS,
  TEMPLATE_KINDS,
  TEMPLATE_SPECS,
  defaultBody,
  specsForKind,
  templateGroups,
  templateSpec,
} from '../src/templates/defaults'
import { fillTemplateTokens, tokensIn } from '../src/templates/interpolate'
import {
  DEFAULT_TEMPLATES,
  bodyFor,
  buildTemplateSet,
  declaredVariables,
  isOverridden,
  overrideCount,
  render,
  templateFingerprint,
} from '../src/templates/resolve'
import {
  MAX_SINGLE_LINE_BODY_CHARS,
  MAX_TEMPLATE_BODY_CHARS,
  problemContentId,
  problemTokens,
  validateTemplateBody,
} from '../src/templates/validate'
import { routingRules } from '../src/ai/contract'
import { scenarioRules, SCENARIO_RULES } from '../src/ai/scenarioContract'
import { GUIDANCE_RULES, guidanceRules } from '../src/ai/guidancePrompt'
import { GENERAL_INSTRUCTIONS } from '../src/ai/brief'
import { templatesMoved } from '../src/drafts/state'
import { classifySetupChange, type SetupChange } from '../src/setup/impact'
import { parseTemplateRowId } from '../src/devfeedback/applyProposal'
import { DEFAULT_SCALE, defaultScalePoints } from '../src/lib/scale'
import type { DraftDoc } from '../src/drafts/types'

const MIGRATION = path.join(
  __dirname,
  '..',
  'supabase',
  'migrations',
  '20260808000100_ai_templates.sql',
)

describe('the template library is well-formed', () => {
  it('has a unique key for every slot', () => {
    expect(new Set(TEMPLATE_KEYS).size).toBe(TEMPLATE_KEYS.length)
  })

  it('declares a kind this build knows for every slot', () => {
    for (const spec of TEMPLATE_SPECS) expect(TEMPLATE_KINDS).toContain(spec.kind)
  })

  it('declares a non-empty label, help and body for every slot', () => {
    for (const spec of TEMPLATE_SPECS) {
      expect(spec.label.trim().length, spec.key).toBeGreaterThan(0)
      expect(spec.help.trim().length, spec.key).toBeGreaterThan(0)
      expect(spec.body.trim().length, spec.key).toBeGreaterThan(0)
    }
  })

  it('names every variable it uses, and uses every variable it names', () => {
    // Both directions. An undeclared token would render as literal braces in somebody's
    // email; a declared-but-unused one is a promise the editor makes to an administrator
    // that the renderer does not keep, which is how a variable list stops being trusted.
    for (const spec of TEMPLATE_SPECS) {
      const declared = spec.variables.map((v) => v.name)
      expect(new Set(declared).size, spec.key).toBe(declared.length)
      expect(tokensIn(spec.body).sort(), spec.key).toEqual([...declared].sort())
    }
  })

  it('accepts every shipped body through its own validator', () => {
    // The regression gate for the validator rather than for the library: a rule strict
    // enough to refuse the text this build ships would make every slot unsavable.
    for (const spec of TEMPLATE_SPECS) {
      expect(validateTemplateBody(spec.key, spec.body), spec.key).toEqual({ ok: true })
    }
  })

  it('keeps every single-line slot on one line', () => {
    for (const spec of TEMPLATE_SPECS) {
      if (spec.multiline) continue
      expect(spec.body.includes('\n'), spec.key).toBe(false)
    }
  })

  it('groups every slot, and every group holds one kind', () => {
    const groups = templateGroups()
    for (const spec of TEMPLATE_SPECS) {
      const g = groups.find((x) => x.group === spec.group)
      expect(g, spec.key).toBeDefined()
      expect(g!.kind, spec.key).toBe(spec.kind)
    }
  })

  it('has an email group per generated document kind it covers, and a report group', () => {
    const emailGroups = new Set(specsForKind('email').map((s) => s.group))
    expect(emailGroups).toEqual(new Set(['participant_email', 'event_digest']))
    expect(new Set(specsForKind('report').map((s) => s.group))).toEqual(
      new Set(['participant_report']),
    )
  })

  it('has exactly one general-instructions slot', () => {
    expect(specsForKind('instructions_general').map((s) => s.key)).toEqual(['instructions.general'])
  })

  it('requires the scale variable on the two instructions that would lie without it', () => {
    // Not a taste question. tl-09 parameterized both of these because a router shown a
    // five-point rubric and told to answer 0-3 either has every answer rejected at import
    // or answers 1-5 and the instruction was a lie. An authored body that dropped the
    // token would silently undo that, so the validator refuses it.
    expect(Object.keys(REQUIRED_VARIABLES).sort()).toEqual([
      'instructions.observation_routing',
      'instructions.scenario_draft',
    ])
    for (const [key, required] of Object.entries(REQUIRED_VARIABLES)) {
      for (const name of required) expect(declaredVariables(key), key).toContain(name)
    }
  })
})

describe('interpolation', () => {
  it('fills a declared token', () => {
    expect(fillTemplateTokens('Hi {{firstName}},', { firstName: 'Amos' })).toBe('Hi Amos,')
  })

  it('tolerates whitespace inside the braces', () => {
    expect(fillTemplateTokens('Hi {{ firstName }},', { firstName: 'Amos' })).toBe('Hi Amos,')
  })

  it('leaves an unfilled token in place rather than blanking the sentence', () => {
    expect(fillTemplateTokens('Hi {{firstName}},', {})).toBe('Hi {{firstName}},')
  })

  it('does not re-scan a substituted value, so data cannot build a token', () => {
    expect(fillTemplateTokens('{{a}}', { a: '{{b}}', b: 'no' })).toBe('{{b}}')
  })

  it('leaves the JSON in the instruction bodies alone', () => {
    // The reason the syntax is double-braced. Two of these bodies contain JSON examples,
    // and a single-brace scanner over them is one lucky whitespace from treating a JSON
    // key as a variable.
    const routing = defaultBody('instructions.observation_routing')
    expect(tokensIn(routing)).toEqual(['range'])
    expect(tokensIn(defaultBody('instructions.scenario_draft'))).toEqual(['scaleSentence'])
  })
})

describe('validation refuses what would reach a participant', () => {
  const key = 'participant_email.greeting'

  it('refuses an unknown key', () => {
    expect(validateTemplateBody('participant_email.nope', 'x')).toEqual({
      ok: false,
      problem: { code: 'unknown_key' },
    })
  })

  it('refuses an empty body', () => {
    expect(validateTemplateBody(key, '   ')).toEqual({ ok: false, problem: { code: 'empty' } })
  })

  it('refuses a misspelled variable and names it', () => {
    const v = validateTemplateBody(key, 'Hi {{frstName}},')
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.problem.code).toBe('undeclared_variable')
      expect(problemTokens(v.problem).variable).toBe('frstName')
      expect(problemContentId(v.problem)).toBe('setup.templates.error.undeclared-variable')
    }
  })

  it('refuses a single-braced token, naming the chrome syntax an admin will reach for', () => {
    const v = validateTemplateBody(key, 'Hi {firstName},')
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.problem.code).toBe('malformed_interpolation')
  })

  it('refuses an unclosed or unmatched brace pair', () => {
    for (const body of ['Hi {{firstName,', 'Hi firstName}},']) {
      const v = validateTemplateBody(key, body)
      expect(v.ok, body).toBe(false)
      if (!v.ok) expect(v.problem.code, body).toBe('malformed_interpolation')
    }
  })

  it('refuses a line break in a slot that sits inside a paragraph', () => {
    const v = validateTemplateBody(key, 'Hi\n{{firstName}},')
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.problem.code).toBe('newline_in_single_line')
  })

  it('allows a line break where the slot is a block', () => {
    expect(validateTemplateBody('participant_email.signoff', 'Bye,\n{{fromName}}')).toEqual({
      ok: true,
    })
  })

  it('refuses dropping the scale range from the routing instructions', () => {
    const v = validateTemplateBody('instructions.observation_routing', 'Route the captures.')
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.problem.code).toBe('missing_required_variable')
      expect(problemTokens(v.problem).variable).toBe('range')
    }
  })

  it('caps a single-line slot lower than a block one', () => {
    expect(MAX_SINGLE_LINE_BODY_CHARS).toBeLessThan(MAX_TEMPLATE_BODY_CHARS)
    const long = 'x'.repeat(MAX_SINGLE_LINE_BODY_CHARS + 1)
    const v = validateTemplateBody(key, long)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.problem.code).toBe('too_long')
      expect(problemTokens(v.problem).limit).toBe(MAX_SINGLE_LINE_BODY_CHARS)
    }
  })
})

describe('resolution', () => {
  const KEY = 'participant_email.greeting'

  it('falls back to the shipped body when the workshop authored nothing', () => {
    expect(bodyFor(DEFAULT_TEMPLATES, KEY)).toBe(defaultBody(KEY))
    expect(isOverridden(DEFAULT_TEMPLATES, KEY)).toBe(false)
    expect(overrideCount(DEFAULT_TEMPLATES)).toBe(0)
  })

  it('returns the override when there is one', () => {
    const set = { workshopId: 'w1', overrides: { [KEY]: 'Hello {{firstName}},' } }
    expect(render(set, KEY, { firstName: 'Amos' })).toBe('Hello Amos,')
    expect(isOverridden(set, KEY)).toBe(true)
    expect(overrideCount(set)).toBe(1)
  })

  it('ignores an override for a key this build does not declare', () => {
    // tl-13's asymmetry, inherited: an unknown key is refused by Postgres and merely
    // ignored here, so a newer client's row cannot break an older client's page.
    const set = { workshopId: 'w1', overrides: { 'participant_email.future': 'x' } }
    expect(() => bodyFor(set, 'participant_email.future')).toThrow()
    expect(bodyFor(set, KEY)).toBe(defaultBody(KEY))
  })

  it('refuses to assemble a set out of another workshop’s rows', () => {
    const rows = [
      { workshop_id: 'w1', template_key: KEY, body: 'Mine {{firstName}},' },
      { workshop_id: 'w2', template_key: KEY, body: 'Theirs {{firstName}},' },
    ]
    expect(buildTemplateSet('w1', rows).overrides[KEY]).toBe('Mine {{firstName}},')
    expect(buildTemplateSet('w2', rows).overrides[KEY]).toBe('Theirs {{firstName}},')
  })

  it('drops an unknown key when caching rather than storing it as a body', () => {
    const set = buildTemplateSet('w1', [
      { workshop_id: 'w1', template_key: 'not.a.slot', body: 'x' },
    ])
    expect(set.overrides).toEqual({})
  })

  it('has no overrides at all for a null workshop', () => {
    expect(buildTemplateSet(null, [{ workshop_id: 'w1', template_key: KEY, body: 'x' }])).toBe(
      DEFAULT_TEMPLATES,
    )
  })
})

describe('the fingerprint', () => {
  const KEY = 'participant_email.greeting'

  it('is the same string for an unauthored workshop', () => {
    expect(templateFingerprint(DEFAULT_TEMPLATES)).toBe('default')
  })

  it('changes when a body changes', () => {
    const a = templateFingerprint({ workshopId: 'w', overrides: { [KEY]: 'Hi,' } })
    const b = templateFingerprint({ workshopId: 'w', overrides: { [KEY]: 'Hi!' } })
    expect(a).not.toBe(b)
  })

  it('does not depend on key order', () => {
    const one = { workshopId: 'w', overrides: { a: '1', b: '2' } }
    const two = { workshopId: 'w', overrides: { b: '2', a: '1' } }
    expect(templateFingerprint(one)).toBe(templateFingerprint(two))
  })

  it('does not depend on the workshop id, only on the wording', () => {
    // A draft is compared against its OWN workshop's set, so folding the id in would
    // make every draft in a second workshop read as drifted for no reason.
    expect(templateFingerprint({ workshopId: 'w1', overrides: { a: '1' } })).toBe(
      templateFingerprint({ workshopId: 'w2', overrides: { a: '1' } }),
    )
  })
})

describe('a draft knows whether its wording moved', () => {
  const base = {
    id: 'd1',
    kind: 'participant_email',
    subjectKey: 'p1',
    workshopId: 'w1',
    title: 'Amos',
    subject: 's',
    dateLabel: '2026-08-26',
    revision: 1,
    supersedes: null,
    fanout: 'per-recipient',
    recipients: [],
    segments: [],
    overrides: [],
    orphans: [],
    flags: [],
    gateOverride: false,
    gateOverrideReason: null,
    generatedAt: 'now',
    updatedAt: 'now',
    approvedBy: null,
    approvedAt: null,
    approvedSnapshot: null,
  } as unknown as DraftDoc

  const draft = (patch: Partial<DraftDoc>): DraftDoc => ({ ...base, status: 'draft', ...patch })

  it('says yes when the fingerprint differs', () => {
    expect(templatesMoved(draft({ templateFingerprint: 'tabc' }), 'tdef')).toBe(true)
  })

  it('says no when it matches', () => {
    expect(templatesMoved(draft({ templateFingerprint: 'tabc' }), 'tabc')).toBe(false)
  })

  it('says no for a row written before this spec, because unknown is not stale', () => {
    expect(templatesMoved(draft({}), 'tdef')).toBe(false)
    expect(templatesMoved(draft({ templateFingerprint: null }), 'tdef')).toBe(false)
  })

  it('never labels an approved or sent document stale', () => {
    // The approval invariant. An approved document is a RECORD of what somebody read, and
    // telling a reviewer it is out of date invites them to "fix" the audit trail.
    for (const status of ['approved', 'sending', 'sent', 'superseded'] as const) {
      expect(templatesMoved(draft({ status, templateFingerprint: 'tabc' }), 'tdef'), status).toBe(
        false,
      )
    }
  })
})

describe('the shipped instructions still produce the pre-tl-16 text', () => {
  it('routing rules fill the range from the scale', () => {
    expect(routingRules(DEFAULT_SCALE)).toContain('evidence_designation 0-3')
    const five = { workshop_id: 'w', points: defaultScalePoints('w').slice(0, 3) }
    expect(routingRules(DEFAULT_SCALE)).not.toBe(routingRules(five))
  })

  it('an authored routing body reaches the rendered rules', () => {
    expect(routingRules(DEFAULT_SCALE, 'Answer {{range}} only.')).toBe('Answer 0-3 only.')
  })

  it('the named constants are the SHIPPED bodies, not a mirror-dependent read', () => {
    // Each of these is evaluated at import time. Reading them through the active mirror
    // would freeze whatever it held on first import, which is nothing, and then keep
    // returning that after it was filled.
    expect(GENERAL_INSTRUCTIONS).toBe(defaultBody('instructions.general'))
    expect(GUIDANCE_RULES).toBe(defaultBody('instructions.conversation_guidance'))
    expect(SCENARIO_RULES).toContain('You design evaluation scenarios')
    expect(SCENARIO_RULES).not.toContain('{{')
  })

  it('an authored body reaches the scenario and guidance rules', () => {
    expect(scenarioRules(undefined, 'Levels: {{scaleSentence}}')).toContain('Levels: an object')
    expect(guidanceRules('Be kind.')).toBe('Be kind.')
  })
})

describe('a wording change is classified and logged', () => {
  const change = (patch: Partial<SetupChange> = {}): SetupChange => ({
    entity: 'template',
    operation: 'update',
    entityId: 'participant_email.intro',
    label: 'Opening paragraph',
    fields: [{ field: 'body', before: 'a', after: 'b' }],
    counts: { draftsPending: 3, captures: 0 },
    ...patch,
  })

  it('affects the future and never invalidates evidence', () => {
    const impact = classifySetupChange(change(), 'in_progress')
    expect(impact.severity).toBe('affects_future')
    expect(impact.requiresTypedName).toBe(false)
    expect(impact.silent).toBe(false)
  })

  it('names the pending drafts, and says approved documents are untouched', () => {
    const ids = classifySetupChange(change(), 'in_progress').consequences.map((x) => x.id)
    expect(ids).toContain('setup.impact.template.drafts')
    expect(ids).toContain('setup.impact.template.approved-safe')
  })

  it('says nothing about pending drafts when there are none', () => {
    const ids = classifySetupChange(
      change({ counts: { draftsPending: 0 } }),
      'in_progress',
    ).consequences.map((x) => x.id)
    expect(ids).not.toContain('setup.impact.template.drafts')
  })

  it('adds the interpretive caveat only for an instruction with captures behind it', () => {
    const withCaptures = classifySetupChange(
      change({ entityId: 'instructions.observation_routing', counts: { captures: 12 } }),
      'in_progress',
    ).consequences.map((x) => x.id)
    expect(withCaptures).toContain('setup.impact.template.instructions')

    const clean = classifySetupChange(
      change({ entityId: 'instructions.observation_routing', counts: { captures: 0 } }),
      'in_progress',
    ).consequences.map((x) => x.id)
    expect(clean).not.toContain('setup.impact.template.instructions')

    const prose = classifySetupChange(
      change({ counts: { captures: 12 } }),
      'in_progress',
    ).consequences.map((x) => x.id)
    expect(prose).not.toContain('setup.impact.template.instructions')
  })

  it('describes a revert as putting the shipped wording back', () => {
    const ids = classifySetupChange(change({ operation: 'delete' }), 'in_progress').consequences.map(
      (x) => x.id,
    )
    expect(ids).toContain('setup.impact.template.revert')
    expect(ids).not.toContain('setup.impact.template.edit')
  })

  it('is not silenced by the draft-workshop discount, so the log still records it', () => {
    // The blanket exists for save-on-blur edits and `safe` means setup/log.ts writes
    // nothing. Most template authoring happens before a workshop starts, so the blanket
    // would erase the record of who wrote the words that then went out.
    const impact = classifySetupChange(change(), 'draft')
    expect(impact.severity).toBe('affects_future')
    expect(impact.silent).toBe(false)
  })
})

describe('a template proposal addresses one slot in one workshop', () => {
  it('splits a row id back into its pair', () => {
    expect(parseTemplateRowId('w1::participant_email.intro')).toEqual({
      workshopId: 'w1',
      templateKey: 'participant_email.intro',
    })
  })

  it('refuses a row id with no separator or an empty half', () => {
    for (const bad of ['w1', '::key', 'w1::', '']) {
      expect(parseTemplateRowId(bad), bad).toBeNull()
    }
  })
})

describe('the SQL mirror agrees with this build', () => {
  const sql = readFileSync(MIGRATION, 'utf8')

  it('names exactly the keys this build declares', () => {
    // The pairing tl-13 used for AI_FUNCTION_DEFAULTS and tl-15 for the brief caps: SQL
    // cannot import TypeScript, so a test that fails on drift is the only thing holding
    // the two lists together. Adding a template means editing both.
    const list = sql.slice(sql.indexOf('if p_key not in ('), sql.indexOf(') then'))
    const inSql = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
    expect(inSql).toEqual([...TEMPLATE_KEYS].sort())
  })

  it('mirrors the body length cap', () => {
    expect(sql).toContain(`length(p_body) > ${MAX_TEMPLATE_BODY_CHARS}`)
  })

  it('declares every kind this build knows, and no others', () => {
    const check = sql.slice(sql.indexOf('check (kind in ('), sql.indexOf('-- The slot this body'))
    const inSql = [...check.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
    expect(inSql).toEqual([...TEMPLATE_KINDS].sort())
  })

  it('revokes execute from the roles by name rather than from public alone', () => {
    // tl-23's scar, and the wave's third permissions-shaped one: default privileges grant
    // execute to `anon` and `authenticated` EXPLICITLY, so `revoke from public` locks
    // nothing at all.
    expect(sql).toMatch(/revoke all on function ai_template_is_legal\(text, text\)\s+from public, anon, authenticated/)
    expect(sql).toContain('revoke all on ai_template from anon, authenticated')
  })

  it('grants delete, because revert-to-default is a delete', () => {
    expect(sql).toContain('grant select, insert, update, delete on ai_template to authenticated')
  })

  it('gates writes on the same roles the Setup hub is gated on', () => {
    // Wave 2's scar: `/admin/assignments` was gated on ADMIN_ROLES while the table's write
    // policy named CHIEF_ROLES, locking a chief evaluator out of a page they could use.
    for (const verb of ['insert', 'update', 'delete']) {
      expect(sql, verb).toContain(
        `create policy ai_template_${verb} on ai_template for ${verb} to authenticated`,
      )
    }
    expect(sql).toMatch(/ai_template_select[\s\S]{0,200}is_workshop_member\(workshop_id\)/)
    expect((sql.match(/has_workshop_role\(workshop_id, array\['chief_admin', 'admin'\]\)/g) ?? []).length)
      .toBeGreaterThanOrEqual(4)
  })
})

describe('the editor cannot offer what must stay compiled in', () => {
  it('holds no schema, validator or attestation slot', () => {
    // The spec's own acceptance criterion, as a test rather than as a manual hunt: try to
    // find one in the library and fail. Guidance is authored; the contract is compiled.
    const suspicious = /schema|attestation|ruleset|validator/i
    for (const spec of TEMPLATE_SPECS) {
      expect(suspicious.test(spec.key), spec.key).toBe(false)
    }
    expect(templateSpec('instructions.observation_routing.schema')).toBeUndefined()
  })
})

describe('a browser harness leaves no fake audit record behind', () => {
  it('guards the applied-edit log on a configured backend', () => {
    // tl-14's D4 fix, applied to the OTHER logging function. In local-only mode there is
    // no database, so there is no divergence from seed.ts to record — and a harness that
    // wrote one left behind a file reading exactly like a genuine record of edits to the
    // live project. tl-16's own walkthrough produced three before this guard existed.
    //
    // A SOURCE TRIPWIRE rather than a call, and the first version of this test is the
    // reason: it asserted `isSupabaseConfigured === false` under vitest, which is true
    // only when no `.env` is present. This worktree has one (the build guard tl-18 added
    // refuses a bundle without it), so the premise was a property of the machine rather
    // than of the code. The same shape as the tl-12 tripwire that fails if a later spec
    // quietly reintroduces a column.
    const source = readFileSync(
      path.join(__dirname, '..', 'src', 'devfeedback', 'applyEdit.ts'),
      'utf8',
    )
    const fn = source.slice(source.indexOf('export async function logAppliedEdit'))
    expect(fn).toContain('if (!isSupabaseConfigured) return false')
    expect(fn.indexOf('if (!isSupabaseConfigured) return false')).toBeLessThan(fn.indexOf('fetch('))
  })
})
