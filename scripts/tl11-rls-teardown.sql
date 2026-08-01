-- Remove tl-11's fixtures. Prefix-scoped on `tl11-` and on the two fixture
-- workshop ids only, so it can run while another session's harness holds its own
-- rows in the same tables. Never truncate.
--
--   node scripts/apply-migration.mjs scripts/tl11-rls-teardown.sql

do $$
declare
  _w1 uuid := 'a3000000-0000-4000-8000-000000000001';
  _w2 uuid := 'a3000000-0000-4000-8000-000000000002';
begin
  delete from membership_change_log where workshop_id in (_w1, _w2);
  delete from workshop_invitation   where workshop_id in (_w1, _w2);
  delete from workshop_member       where workshop_id in (_w1, _w2);
  -- Invitations issued into other workshops by a fixture account would be caught
  -- by the email prefix rather than the workshop id; none are created today, and
  -- this is here so that stays true if a later run adds one.
  delete from workshop_invitation where email like 'tl11-%@example.org';
  delete from workshop_invitation where email like 'tl11-queue-%';
  delete from app_user  where email like 'tl11-%@example.org';
  delete from auth.users where email like 'tl11-%@example.org';
  delete from role_allowlist where email like 'tl11-%@example.org';
  delete from workshop where id in (_w1, _w2);
end $$;

drop function if exists tl11_try(text, text, uuid, text);
drop function if exists tl11_owner(text, text, text, text);
drop function if exists tl11_slug(text, text, uuid, text);
drop function if exists tl11_assert(text, boolean, text);
drop function if exists tl11_signup(uuid, text, text);
drop table if exists tl11_results;

select 'tl-11 fixtures removed' as status;
