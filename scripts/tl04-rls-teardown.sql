-- Teardown for scripts/tl04-rls-tests.sql. Removes every fixture row it creates.
--
-- Verdicts before observations before the workshop: verification_verdict has no
-- foreign key to observation (deliberately, see the migration), so nothing
-- cascades from one to the other and the id prefix is the only handle on them.

delete from verification_verdict where id like 'tl04-%';
delete from observation where id like 'tl04-%';

delete from workshop_member wm
 using app_user u
 where u.id = wm.app_user_id
   and u.email like 'tl04-%@example.org';

delete from app_user where email like 'tl04-%@example.org';
delete from auth.users where id in (
  '5b000000-0000-4000-8000-000000000001',
  '5c000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000003'
);
delete from role_allowlist where email like 'tl04-%@example.org';

delete from workshop where id = '55555555-5555-5555-5555-555555555555';

drop function if exists tl04_try(text, text, uuid, text);
drop function if exists tl04_assert(text, boolean, text);
drop table if exists tl04_results;

select
  (select count(*) from observation)           as observations_remaining,
  (select count(*) from verification_verdict)  as verdicts_remaining,
  (select count(*) from app_user)              as accounts_remaining,
  (select count(*) from workshop)              as workshops_remaining;
