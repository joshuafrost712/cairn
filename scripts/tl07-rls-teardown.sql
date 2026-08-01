-- Teardown for scripts/tl07-rls-tests.sql. Removes every fixture row it creates.
--
-- Log rows before the workshop: setup_change_log cascades from workshop, but the
-- pilot workshop is real and must survive, so the prefix is the only handle on the
-- entries written against it.

delete from setup_change_log where id like 'tl07-%';

delete from workshop_member wm
 using app_user u
 where u.id = wm.app_user_id
   and u.email like 'tl07-%@example.org';

delete from app_user where email like 'tl07-%@example.org';
-- tl-12: the app_user_link_person trigger mints a person row for every account,
-- so a teardown that removes the account and stops there leaves one behind.
delete from person where primary_email like 'tl07-%@example.org';
delete from auth.users where id in (
  '7a000000-0000-4000-8000-000000000001',
  '7e000000-0000-4000-8000-000000000002',
  '70000000-0000-4000-8000-000000000003'
);
delete from role_allowlist where email like 'tl07-%@example.org';

delete from workshop where id = '77777777-7777-7777-7777-777777777777';

drop function if exists tl07_try(text, text, uuid, text);
drop function if exists tl07_assert(text, boolean, text);
drop table if exists tl07_results;

select
  (select count(*) from setup_change_log) as setup_log_rows_remaining,
  (select count(*) from app_user)         as accounts_remaining,
  (select count(*) from workshop)         as workshops_remaining;
