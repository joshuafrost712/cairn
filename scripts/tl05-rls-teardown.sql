-- Undo scripts/tl05-rls-tests.sql. Prefix-scoped, never by truncation: this runs
-- against the live project, which two concurrent sessions may be using, and a
-- teardown that empties a table would take another spec's fixtures with it.
--
-- The prefix is `tl05-rls-`, not `tl05-`, and the extra segment is load-bearing.
-- Written as `tl05-` first, and it deleted scripts/tl05-assignment-walkthrough's
-- `tl05-ui-*` accounts mid-session: a LIKE prefix is a prefix, so one spec's two
-- harnesses collide with each other exactly as two specs' would. Every harness
-- in this repo gets a prefix that is not a prefix of any other.

delete from mentoring_conversation where id like 'tl05-rls-%';

delete from workshop_member wm using app_user u
  where u.id = wm.app_user_id and u.email like 'tl05-rls-%@example.org';
delete from app_user where email like 'tl05-rls-%@example.org';
delete from auth.users where email like 'tl05-rls-%@example.org';
delete from role_allowlist where email like 'tl05-rls-%@example.org';

delete from participant where id = '5d000000-0000-4000-8000-0000000000aa';
delete from workshop where id = '55555555-5555-5555-5555-555555555555';

drop function if exists tl05_try(text, text, uuid, text);
drop function if exists tl05_assert(text, boolean, text);
drop table if exists tl05_results;

select 'tl-05 fixtures removed' as done;
