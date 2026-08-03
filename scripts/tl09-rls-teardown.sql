-- tl-09 harness teardown.
--
-- PREFIX-SCOPED, never a truncate: two sessions share one live project, and a
-- teardown that emptied a table would wipe a concurrent harness mid-run. Every
-- row this removes was created by scripts/tl09-rls-tests.sql and is named for it.

delete from observation where id like 'tl09-%';
delete from participant where workshop_id in ('90900000-0000-4000-8000-000000000001',
                                              '90900000-0000-4000-8000-000000000002');
delete from workshop_member wm using app_user u
  where u.id = wm.app_user_id and u.email like 'tl09-%@example.org';
delete from app_user where email like 'tl09-%@example.org';
delete from auth.users where email like 'tl09-%@example.org';
delete from role_allowlist where email like 'tl09-%@example.org';
-- scale_point cascades with the workshop.
delete from workshop where id in ('90900000-0000-4000-8000-000000000001',
                                  '90900000-0000-4000-8000-000000000002');

drop table if exists tl09_results;
drop function if exists tl09_try(text, text, uuid, text);
drop function if exists tl09_assert(text, boolean, text);

select
  (select count(*) from workshop where id in ('90900000-0000-4000-8000-000000000001',
                                              '90900000-0000-4000-8000-000000000002')) as workshops_left,
  (select count(*) from scale_point where workshop_id in ('90900000-0000-4000-8000-000000000001',
                                                          '90900000-0000-4000-8000-000000000002')) as scale_rows_left,
  (select count(*) from app_user where email like 'tl09-%@example.org') as accounts_left,
  (select count(*) from observation where id like 'tl09-%') as observations_left,
  -- The pilot workshop's own scale must be untouched by any of this.
  (select count(*) from scale_point) as scale_rows_remaining;
