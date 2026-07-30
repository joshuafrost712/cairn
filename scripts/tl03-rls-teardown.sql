-- Teardown for scripts/tl03-rls-tests.sql. Removes every fixture row it creates.
--
-- Observations before evaluations: observation has no foreign key to evaluation
-- (it references the capture by client_id, as text), so nothing cascades and the
-- id prefix is the only handle on them.

delete from observation where capture_client_id like 'tl03-%' or id like 'tl03-%';
delete from evaluation where client_id like 'tl03-%';

delete from workshop_member wm
 using app_user u
 where u.id = wm.app_user_id
   and u.email like 'tl03-%@example.org';

delete from app_user where email like 'tl03-%@example.org';
delete from auth.users where id in (
  '3e000000-0000-4000-8000-000000000001',
  '3a000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003'
);
delete from role_allowlist where email like 'tl03-%@example.org';

delete from workshop where id = '33333333-3333-3333-3333-333333333333';

drop function if exists tl03_try(text, text, uuid, text);
drop function if exists tl03_assert(text, boolean, text);
drop table if exists tl03_results;

select
  (select count(*) from evaluation)  as evaluations_remaining,
  (select count(*) from observation) as observations_remaining,
  (select count(*) from app_user)    as accounts_remaining,
  (select count(*) from workshop)    as workshops_remaining;
