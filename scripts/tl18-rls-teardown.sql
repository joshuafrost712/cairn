-- Teardown for scripts/tl18-rls-tests.sql. Removes every fixture row it creates.
--
-- Verdict, then observation, then evaluation: none of the three has a foreign key
-- to the others (deliberately, see the tl-04 migration), so nothing cascades and
-- the id prefix is the only handle on them.

delete from verification_verdict where id like 'tl18-%';
delete from observation where id like 'tl18-%';
delete from evaluation where client_id like 'tl18-%';

delete from workshop_member wm
 using app_user u
 where u.id = wm.app_user_id
   and u.email like 'tl18-%@example.org';

delete from app_user where email like 'tl18-%@example.org';
-- tl-12: the app_user_link_person trigger mints a person row for every account,
-- so a teardown that removes the account and stops there leaves one behind.
delete from person where primary_email like 'tl18-%@example.org';
delete from auth.users where id in (
  '5d000000-0000-4000-8000-000000000001',
  '5e000000-0000-4000-8000-000000000002'
);
delete from role_allowlist where email like 'tl18-%@example.org';

delete from workshop where id = '66666666-6666-6666-6666-666666666666';

drop function if exists tl18_try(text, text, uuid, text);
drop function if exists tl18_assert(text, boolean, text);
drop table if exists tl18_results;

select
  (select count(*) from evaluation)            as evaluations_remaining,
  (select count(*) from observation)           as observations_remaining,
  (select count(*) from verification_verdict)  as verdicts_remaining,
  (select count(*) from app_user)              as accounts_remaining,
  (select count(*) from workshop)              as workshops_remaining;
