-- Teardown for scripts/tl01-rls-tests.sql. Removes every fixture row it creates.
--
-- Order matters in one non-obvious place: `evaluation.workshop_id` is
-- `on delete set null`, not cascade, so deleting the fixture workshop first would
-- orphan the fixture capture rather than remove it. Captures go first.

delete from evaluation where client_id like 'tl01-%';

delete from workshop_member wm
 using app_user u
 where u.id = wm.app_user_id
   and u.email = 'tl01-fixture@example.org';

delete from app_user where email = 'tl01-fixture@example.org';
delete from auth.users where id = '33333333-3333-3333-3333-333333333333';
delete from role_allowlist where email = 'tl01-fixture@example.org';

-- Cascades take team, participant, activity, and activity_ksa with them.
delete from workshop where id in (
  '22222222-2222-2222-2222-222222222222',
  '44444444-4444-4444-4444-444444444444'
);

drop function if exists tl01_try(text, text, uuid, text);
drop table if exists tl01_results;

select
  (select count(*) from workshop) as workshops_remaining,
  (select count(*) from app_user) as accounts_remaining,
  (select count(*) from workshop_member) as memberships_remaining,
  (select count(*) from evaluation) as evaluations_remaining;
