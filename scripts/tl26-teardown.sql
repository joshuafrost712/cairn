-- tl-26 teardown: the rehearsal leaves nothing in a workshop four people use in
-- eleven days.
--
--   node scripts/apply-migration.mjs scripts/tl26-teardown.sql
--
-- The spec names this as the one thing that must not be left behind: "an undeleted
-- rehearsal observation read on 19 August as evidence about a real participant is
-- the single most damaging thing this spec could leave." So this file deletes rather
-- than keeps, and it reports its own residue afterwards rather than asserting it is
-- clean — a teardown that prints nothing is indistinguishable from a teardown that
-- did nothing.
--
-- EVERYTHING IS SCOPED ON THE `tl26-` ACCOUNTS, never on the workshop. Deleting "the
-- Crash Course's observations" would be correct today and catastrophic the first time
-- it is run after 18 August, when those rows are four people's real evaluations. The
-- rehearsal rows are exactly the rows an account nobody will ever use again wrote.
--
-- Order is child-before-parent throughout: verdicts, then observations, then the
-- captures they came from, then the accounts.

drop table if exists tl26_teardown_log;
create table tl26_teardown_log (seq serial primary key, step text, removed bigint);

do $$
declare
  _cc    uuid := '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b';
  _ps    uuid := '11111111-1111-1111-1111-111111111111';
  _caps  text[];
  _n     bigint;
begin
  select coalesce(array_agg(client_id), '{}') into _caps
    from evaluation where evaluator_email like 'tl26-%';

  delete from verification_verdict where evaluator_email like 'tl26-%' or capture_client_id = any(_caps);
  get diagnostics _n = row_count; insert into tl26_teardown_log values (default, 'verification_verdict', _n);

  delete from observation where capture_client_id = any(_caps);
  get diagnostics _n = row_count; insert into tl26_teardown_log values (default, 'observation', _n);

  -- No `coverage` delete: coverage is a device-and-Realtime concept with no table in
  -- Postgres, which the spec's own file inventory listed as a row this rehearsal would
  -- touch. It does not exist to clean up.

  delete from evaluation where evaluator_email like 'tl26-%';
  get diagnostics _n = row_count; insert into tl26_teardown_log values (default, 'evaluation', _n);

  -- Both workshops held zero drafts before the rehearsal (verified in the record), so
  -- anything here is this spec's. Scoped to the two workshops rather than the table.
  delete from doc_draft where workshop_id in (_cc, _ps);
  get diagnostics _n = row_count; insert into tl26_teardown_log values (default, 'doc_draft', _n);

  delete from ai_call_log where actor_email like 'tl26-%';
  get diagnostics _n = row_count; insert into tl26_teardown_log values (default, 'ai_call_log', _n);

  -- The Crash Course had NO ai_config row before this spec, and tl-13 is explicit
  -- that no row is a legal state meaning "behave as before that spec". So the
  -- restoration is a delete, not a reset to a default.
  delete from ai_config where workshop_id = _cc;
  get diagnostics _n = row_count; insert into tl26_teardown_log values (default, 'ai_config (Crash Course)', _n);

  -- tl-07 logs every Setup save. The mode change was a real edit by a real admin and
  -- its log line is removed with the account that made it.
  delete from setup_change_log where actor_email like 'tl26-%';
  get diagnostics _n = row_count; insert into tl26_teardown_log values (default, 'setup_change_log', _n);

  delete from membership_change_log where actor_email like 'tl26-%' or target_email like 'tl26-%';
  get diagnostics _n = row_count; insert into tl26_teardown_log values (default, 'membership_change_log', _n);

  delete from workshop_member m using app_user au
   where au.id = m.app_user_id and au.email like 'tl26-%';
  get diagnostics _n = row_count; insert into tl26_teardown_log values (default, 'workshop_member', _n);

  delete from workshop_invitation where email like 'tl26-%';
  get diagnostics _n = row_count; insert into tl26_teardown_log values (default, 'workshop_invitation', _n);

  -- tl-12's carry-forward: `app_user_link_person` is an AFTER INSERT trigger, so
  -- every harness that provisions an account and removes only the account leaves a
  -- minted person behind. Four were found in the live deployment once already.
  delete from person where primary_email like 'tl26-%';
  get diagnostics _n = row_count; insert into tl26_teardown_log values (default, 'person', _n);

  delete from app_user where email like 'tl26-%';
  get diagnostics _n = row_count; insert into tl26_teardown_log values (default, 'app_user', _n);

  delete from auth.users where email like 'tl26-%';
  get diagnostics _n = row_count; insert into tl26_teardown_log values (default, 'auth.users', _n);
end $$;

drop table if exists tl26_setup_log;

-- The report: what was removed, then what the two workshops now hold. The Psalms
-- line is the invariant three specs in this batch re-check, and this is the spec
-- most able to have broken it.
select 'removed' as kind, step as a, removed::text as b from tl26_teardown_log
union all
select 'residue', 'evaluation/observation/verdict rows from tl26 accounts',
       (select (select count(*) from evaluation where evaluator_email like 'tl26-%')
             + (select count(*) from observation where evaluator_email like 'tl26-%')
             + (select count(*) from verification_verdict where evaluator_email like 'tl26-%'))::text
union all
select 'residue', 'tl26 accounts, memberships, invitations, persons',
       (select (select count(*) from app_user where email like 'tl26-%')
             + (select count(*) from workshop_invitation where email like 'tl26-%')
             + (select count(*) from person where primary_email like 'tl26-%')
             + (select count(*) from auth.users where email like 'tl26-%'))::text
union all
select 'crash course', 'evaluation / observation / verdict / draft',
       (select format('%s / %s / %s / %s',
          (select count(*) from evaluation where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'),
          (select count(*) from observation where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'),
          (select count(*) from verification_verdict where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'),
          (select count(*) from doc_draft where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b')))
union all
select 'crash course', 'participants / activities / questions / goals',
       (select format('%s / %s / %s / %s',
          (select count(*) from participant where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'),
          (select count(*) from activity where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'),
          (select count(*) from ksa where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'),
          (select count(*) from goal where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b')))
union all
select 'PSALMS', 'participants / activities / questions / goals — must read 22 / 17 / 7 / 7',
       (select format('%s / %s / %s / %s',
          (select count(*) from participant where workshop_id = '11111111-1111-1111-1111-111111111111'),
          (select count(*) from activity where workshop_id = '11111111-1111-1111-1111-111111111111'),
          (select count(*) from ksa where workshop_id = '11111111-1111-1111-1111-111111111111'),
          (select count(*) from goal where workshop_id = '11111111-1111-1111-1111-111111111111')))
order by 1, 2;
