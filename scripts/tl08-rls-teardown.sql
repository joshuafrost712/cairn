-- Teardown for scripts/tl08-rls-tests.sql. Removes every fixture row it creates.
--
-- Prefix-scoped, per the concurrency guardrails: `tl08-*` accounts and the two
-- `88888888-8888-…-88880x` workshops only. Never a truncate — another session may hold
-- another spec's harness against the same live project, and the pilot workshop's real
-- roster lives in these same tables.
--
-- Goals, questions and wiring cascade from the workshop, so deleting the two fixture
-- workshops is enough for all three.

delete from workshop_member wm
 using app_user u
 where u.id = wm.app_user_id
   and u.email like 'tl08-%@example.org';

delete from app_user where email like 'tl08-%@example.org';
delete from auth.users where id in (
  '8a000000-0000-4000-8000-000000000001',
  '8e000000-0000-4000-8000-000000000002',
  '8b000000-0000-4000-8000-000000000003'
);
delete from role_allowlist where email like 'tl08-%@example.org';

delete from workshop where id in (
  '88888888-8888-8888-8888-888888888801',
  '88888888-8888-8888-8888-888888888802'
);

drop function if exists tl08_try(text, text, uuid, text);
drop function if exists tl08_assert(text, boolean, text);
drop table if exists tl08_results;

-- The pilot workshop and its questions must be exactly as they were.
select
  (select count(*) from workshop)                        as workshops_remaining,
  (select count(*) from app_user)                        as accounts_remaining,
  (select count(*) from goal)                            as goals_remaining,
  (select count(*) from ksa)                             as questions_remaining,
  (select count(*) from ksa where workshop_id is null)   as unscoped_questions;
