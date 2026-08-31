-- tl-38: workshop_health(_workshop_id, _stale_hours) — the briefing's one server read.
--
--   node scripts/apply-migration.mjs supabase/migrations/20260821000100_workshop_health.sql
--
-- WHY THIS IS AN RPC AND NOT A PULL. Every other read in this app fetches whole
-- rows scoped by workshop_id and computes in JavaScript, and that is the right
-- shape for anything a device must also work offline against. It is the wrong
-- shape here for one reason: the number that matters most is a count of captures
-- that have never been submitted, and those rows live on other people's phones.
-- `pullPendingCaptures` and `pullCoverage` both filter `.eq('attestation', true)`
-- on purpose, so an evaluator's unsubmitted draft never reaches an administrator's
-- device at all. Counting them client-side would mean shipping every evaluator's
-- unfinished words to the administrator in order to say how many there are.
-- PostgREST cannot compute `has_content` server-side, so this function does.
--
-- THE RULE FOR THE NEXT ONE. An aggregate RPC is right only when correctness
-- depends on seeing rows the device is not allowed to hold. A later spec choosing
-- one over a pull should say which of those two cases it is in.
--
-- WHAT IT MUST NEVER RETURN. No `source_text`, no `answers`, no `observation.text`,
-- no `source_excerpt`. The single text field is `unresolved_scope_names`, which are
-- roster-adjacent strings typed into a participant picker ("Keem Leong", a bare
-- first name), capped at 20, and they are the input to the name-variant hygiene
-- line. Everything else is a count, an email or a timestamp.
--
-- IT RAISES RATHER THAN RETURNING AN EMPTY REPORT. A `security definer` function
-- is outside RLS, so its authorization is the only authorization it has. Answering
-- a refusal with zeros would tell an unauthorized reader that the workshop is
-- healthy, which is the one wrong answer a health surface must not give. The next
-- aggregate RPC in this program copies this shape, and copying the grants without
-- the raise would produce a function that answers everybody, failing in a way that
-- looks like data rather than like a permission bug.
--
-- PARITY. The body is `scripts/health/workshop-health.mjs`'s single
-- `json_build_object` query plus the derivations that script does in JavaScript,
-- moved into SQL and stripped of every free-text field. The script stays: it runs
-- on the management API as `postgres`, so it sees rows this function deliberately
-- cannot, and it is the second implementation the first is diffed against.

create or replace function public.workshop_health(
  _workshop_id uuid,
  _stale_hours integer default 24
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  _result jsonb;
begin
  -- The authorization, and it is the whole of it. CHIEF_ROLES in src/layout/roles.ts
  -- is the TypeScript twin of this list; the two are kept in step by hand and the
  -- wire harness asserts both directions.
  if not has_workshop_role(_workshop_id, array['chief_admin', 'admin', 'chief_evaluator']) then
    raise exception 'tl38.not_permitted_for_this_workshop'
      using errcode = '42501';
  end if;

  with cap as (
    select
      e.client_id,
      coalesce(e.evaluator_email, '?') as evaluator_email,
      e.created_at,
      e.attestation as attested,
      -- Exactly the script's predicate. `jsonb_typeof` guards a non-object
      -- `answers`, which would make jsonb_each_text error rather than return
      -- nothing; every live row is an object today and this keeps it that way
      -- if one ever is not.
      (
        length(btrim(coalesce(e.source_text, ''))) > 0
        or exists (
          select 1
          from jsonb_each_text(
            case when jsonb_typeof(e.answers) = 'object' then e.answers else '{}'::jsonb end
          ) je(k, v)
          where length(btrim(v)) > 0
        )
      ) as has_content,
      (coalesce(e.quick_ratings::text, '{}') not in ('{}', 'null')) as has_qr,
      case
        when jsonb_typeof(e.participant_scope) = 'array' then e.participant_scope
        else '[]'::jsonb
      end as participant_scope
    from evaluation e
    where e.workshop_id = _workshop_id
  ),
  obs as (
    select
      o.capture_client_id,
      o.participant_id,
      o.participant_name,
      o.ksa_code,
      o.evidence_designation,
      o.sentiment_flag
    from observation o
    where o.workshop_id = _workshop_id
  ),
  roster as (
    select p.id, p.name, t.name as team
    from participant p
    left join team t on t.id = p.team_id
    where p.workshop_id = _workshop_id
  ),
  -- Grouped by GOAL, not by the legacy `ksa.area` column.
  --
  -- `scripts/health/workshop-health.mjs` groups by `area`, and copying it here
  -- would have revived exactly the disagreement tl-08 exists to end: `area` is
  -- retained for one release cycle and `test/oneResolutionSite.test.ts` fails any
  -- code that reads it to decide a grouping. On this workshop the two agree for
  -- every question that has an area, so the parity diff is unaffected today. They
  -- do NOT agree for the three instructor questions, whose `area` is null: the
  -- script would label a routed instructor observation `INSTR1`, and the goal
  -- layer calls it "Instructor Practice", which is the right answer. If one is
  -- ever routed, the parity harness will report that field and this is the note
  -- that explains it.
  --
  -- `distinct on` is defensive: two rows sharing a code (a workshop-scoped one and
  -- a global one) would multiply the join, where the script's object literal would
  -- silently keep whichever came last.
  ksa_goal as (
    select distinct on (k.code)
      k.code,
      coalesce(g.title, k.area, k.code) as goal
    from ksa k
    left join goal g on g.id = k.goal_id
    where k.workshop_id = _workshop_id or k.workshop_id is null
    order by k.code, (k.workshop_id is null)
  ),
  routed_caps as (
    select distinct capture_client_id from obs where capture_client_id is not null
  ),
  queue as (
    select c.*
    from cap c
    where c.attested
      and c.has_content
      and not exists (select 1 from routed_caps rc where rc.capture_client_id = c.client_id)
  ),
  -- The script's nameOf(): a roster hit wins, then the observation's own name,
  -- then the literal 'UNATTRIBUTED'. participant_id is text and roster.id is uuid,
  -- so the cast goes on the uuid; casting the other way would error on any row
  -- holding a name where an id was expected.
  obs_named as (
    select
      o.*,
      coalesce(r.name, nullif(o.participant_name, ''), 'UNATTRIBUTED') as resolved_name,
      (r.id is not null) as on_roster
    from obs o
    left join roster r on r.id::text = o.participant_id
  ),
  routed_per as (
    select resolved_name, count(*)::int as n from obs_named group by 1
  ),
  pending_per as (
    select s ->> 'name' as name, count(*)::int as n
    from queue q,
         lateral jsonb_array_elements(q.participant_scope) s
    where s ->> 'name' is not null
    group by 1
  ),
  last_delivery as (
    select evaluator_email, max(created_at) as last_at
    from cap
    group by 1
  ),
  per_day as (
    -- Forced to UTC so the day boundary does not move with the session's
    -- TimeZone. The script slices an ISO string rendered in its own session,
    -- which is UTC on the management API; the parity harness re-checks it.
    select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day, count(*)::int as n
    from cap
    group by 1
  ),
  scope_names as (
    select
      s ->> 'name' as name,
      s ->> 'participant_id' as participant_id,
      count(*)::int as n
    from cap c,
         lateral jsonb_array_elements(c.participant_scope) s
    where s ->> 'name' is not null
    group by 1, 2
  ),
  unresolved_names as (
    select sn.name, sum(sn.n)::int as n
    from scope_names sn
    where not exists (
      select 1 from roster r
      where r.id::text = sn.participant_id or r.name = sn.name
    )
    group by 1
    order by 2 desc, 1
    limit 20
  )
  select jsonb_build_object(
    'workshop', (
      select jsonb_build_object(
        'id', w.id, 'name', w.name,
        'start_date', w.start_date, 'end_date', w.end_date
      )
      from workshop w where w.id = _workshop_id
    ),
    'generated_at', now(),
    'stale_hours', _stale_hours,
    'volume', jsonb_build_object(
      'captures', (select count(*)::int from cap),
      'evaluators', (select count(*)::int from last_delivery),
      'observations', (select count(*)::int from obs),
      'verdicts', (select count(*)::int from verification_verdict where workshop_id = _workshop_id),
      'people_with_routed', (select count(*)::int from routed_per),
      'mean_evidence', (
        select round(avg(evidence_designation)::numeric, 2)
        from obs where evidence_designation is not null
      ),
      'sentiment', coalesce((
        select jsonb_agg(jsonb_build_object('flag', t.sentiment_flag, 'n', t.n) order by t.n desc)
        from (
          select sentiment_flag, count(*)::int as n from obs group by 1
        ) t
      ), '[]'::jsonb),
      'per_day', coalesce((
        select jsonb_agg(jsonb_build_object('day', d.day, 'n', d.n) order by d.day)
        from per_day d
      ), '[]'::jsonb)
    ),
    'pipeline', jsonb_build_object(
      'queue', jsonb_build_object(
        'count', (select count(*)::int from queue),
        'oldest_created_at', (select min(created_at) from queue),
        'by_evaluator', coalesce((
          select jsonb_agg(jsonb_build_object('evaluator_email', t.evaluator_email, 'n', t.n)
                           order by t.n desc, t.evaluator_email)
          from (select evaluator_email, count(*)::int as n from queue group by 1) t
        ), '[]'::jsonb)
      ),
      -- Ratings-only drafts count here (an evaluator entered something) but never
      -- in the routing queue: routing reads source_text, which only answer text
      -- feeds. `kind` carries that distinction so the page never implies a
      -- ratings-only draft is prose somebody is waiting on.
      'drafts_with_content', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'evaluator_email', c.evaluator_email,
                 'created_at', c.created_at,
                 'kind', case when c.has_content then 'text' else 'ratings_only' end)
               order by c.created_at)
        from cap c
        where not c.attested and (c.has_content or c.has_qr)
      ), '[]'::jsonb),
      'empty_shells', (
        select count(*)::int from cap
        where not attested and not has_content and not has_qr
      ),
      -- The threshold travels with the payload rather than filtering it. Silence
      -- is decided once, by `silentDevices` in src/reports/health.ts, so the page
      -- and the copied markdown cannot disagree about who has gone quiet.
      'last_delivery', coalesce((
        select jsonb_agg(jsonb_build_object('evaluator_email', l.evaluator_email, 'last_at', l.last_at)
                         order by l.last_at)
        from last_delivery l
      ), '[]'::jsonb)
    ),
    'coverage', jsonb_build_object(
      'participants', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'participant_id', r.id,
                 'name', r.name,
                 'team', r.team,
                 'routed', coalesce(rp.n, 0),
                 'pending', coalesce(pp.n, 0))
               order by coalesce(rp.n, 0) + coalesce(pp.n, 0), r.name)
        from roster r
        left join routed_per rp on rp.resolved_name = r.name
        left join pending_per pp on pp.name = r.name
      ), '[]'::jsonb),
      'unattributed_observations', (select count(*)::int from obs_named where not on_roster),
      'unresolved_scope_names', coalesce((
        select jsonb_agg(u.name order by u.n desc, u.name) from unresolved_names u
      ), '[]'::jsonb)
    ),
    'by_goal', coalesce((
      select jsonb_agg(jsonb_build_object(
               'goal', t.goal, 'n', t.n, 'mean_evidence', t.mean_evidence)
             order by t.n, t.goal)
      from (
        select
          coalesce(kg.goal, o.ksa_code) as goal,
          count(*)::int as n,
          round(avg(o.evidence_designation)::numeric, 2) as mean_evidence
        from obs_named o
        left join ksa_goal kg on kg.code = o.ksa_code
        group by 1
      ) t
    ), '[]'::jsonb)
  )
  into _result;

  return _result;
end;
$$;

comment on function public.workshop_health(uuid, integer) is
  'tl-38: one workshop''s health as counts, read server-side because unsubmitted '
  'drafts never reach an administrator''s device. Returns no evidence prose. '
  'Raises tl38.not_permitted_for_this_workshop rather than returning zeros.';

-- Revoking from `public` alone locks nothing, because `anon` and `authenticated`
-- hold their grants by name rather than through the public role. Both are named.
revoke all on function public.workshop_health(uuid, integer) from public, anon;
grant execute on function public.workshop_health(uuid, integer) to authenticated;
