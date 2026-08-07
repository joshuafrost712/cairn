-- Remove tl-25's harness fixtures. Prefix-scoped on `tl25-` only, so it can run
-- while another session holds its own rows in the same tables. Never truncate, and
-- it touches nothing the roster script wrote.
--
--   node scripts/apply-migration.mjs scripts/tl25-teardown.sql

do $$
begin
  delete from workshop_invitation where email like 'tl25-%@example.org';
  delete from workshop_member where app_user_id in
    (select id from app_user where email like 'tl25-%@example.org');
  -- Matched on the email columns rather than the id columns: both are `on delete
  -- set null`, so a log row whose target has already gone holds a null id and the
  -- address is the only handle left on it.
  delete from membership_change_log
   where actor_email like 'tl25-%@example.org' or target_email like 'tl25-%@example.org';
  delete from app_user  where email like 'tl25-%@example.org';
  delete from auth.users where email like 'tl25-%@example.org';
  delete from role_allowlist where email like 'tl25-%@example.org';
  -- Last, because app_user.person_id references it and the delete above releases
  -- the reference. `on delete set null` would tolerate the other order; being
  -- explicit costs nothing and says which way the dependency runs.
  delete from person where primary_email like 'tl25-%@example.org';
end $$;

drop function if exists tl25_try(text, text, uuid, text);
drop function if exists tl25_assert(text, boolean, text);
drop table if exists tl25_results;

select jsonb_pretty(jsonb_build_object(
  'status', 'tl-25 fixtures removed',
  'residue', jsonb_build_object(
    'tl25_app_users', (select count(*) from app_user where email like 'tl25-%'),
    'tl25_auth_users', (select count(*) from auth.users where email like 'tl25-%'),
    'tl25_persons', (select count(*) from person where primary_email like 'tl25-%'),
    'tl25_invitations', (select count(*) from workshop_invitation where email like 'tl25-%')),
  'crash_course_after', jsonb_build_object(
    'participants', (select count(*) from participant where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'),
    'teams', (select count(*) from team where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'),
    'members', (select count(*) from workshop_member where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b'),
    'invitations_pending', (select count(*) from workshop_invitation
                             where workshop_id = '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b' and status = 'pending')),
  'psalms_after', jsonb_build_object(
    'participants', (select count(*) from participant where workshop_id = '11111111-1111-1111-1111-111111111111'))
)) as teardown;
