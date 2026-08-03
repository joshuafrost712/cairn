-- Teardown for scripts/tl02-rls-tests.sql. Removes every fixture row it creates,
-- on the tl02- prefix and the two fixture workshop ids only, so a concurrent
-- session's harness is left alone. Never truncates a table.
--
-- The log rows go first: membership_change_log cascades from workshop, but the
-- app_user references are `on delete set null`, so deleting the accounts first
-- would leave orphaned rows behind under a different id prefix.

delete from membership_change_log where workshop_id in (
  'a2000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-0000000000b1',
  'a2000000-0000-4000-8000-0000000000b2'
);

delete from participant where id = 'a2000000-0000-4000-8000-0000000000d1';

delete from workshop_member where workshop_id in (
  'a2000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-0000000000b1',
  'a2000000-0000-4000-8000-0000000000b2'
);

delete from workshop_member wm
 using app_user u
 where u.id = wm.app_user_id
   and u.email like 'tl02-%@example.org';

delete from app_user where email like 'tl02-%@example.org';
-- tl-12: the app_user_link_person trigger mints a person row for every account,
-- so a teardown that removes the account and stops there leaves one behind.
delete from person where primary_email like 'tl02-%@example.org';
delete from auth.users where id in (
  'a2000000-0000-4000-8000-0000000000c1',
  'a2000000-0000-4000-8000-0000000000a1',
  'a2000000-0000-4000-8000-0000000000a2',
  'a2000000-0000-4000-8000-0000000000e1',
  'a2000000-0000-4000-8000-0000000000ce',
  'a2000000-0000-4000-8000-0000000000f0'
);
delete from role_allowlist where email like 'tl02-%@example.org';

delete from workshop where id in (
  'a2000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-0000000000b1',
  'a2000000-0000-4000-8000-0000000000b2'
);

drop function if exists tl02_try(text, text, uuid, text);
drop function if exists tl02_slug(text, text, uuid, text, text);
drop function if exists tl02_assert(text, boolean, text);
drop function if exists tl02_uid(text);
drop table if exists tl02_results;

select
  (select count(*) from workshop)               as workshops_remaining,
  (select count(*) from app_user)               as accounts_remaining,
  (select count(*) from workshop_member)        as memberships_remaining,
  (select count(*) from membership_change_log)  as log_rows_remaining;
