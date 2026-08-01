-- Undo scripts/tl06-rls-tests.sql. Prefix-scoped, never by truncation: this runs
-- against the live project, which two concurrent sessions may be using, and a
-- teardown that empties a table would take another spec's fixtures with it.
--
-- The prefix is `tl06-rls-`, which is not a prefix of `tl06-ui-` (the browser
-- walkthrough's) or of any other harness's. tl-05 learned that the hard way by
-- deleting its own walkthrough's accounts mid-session with a `tl05-` LIKE.
--
-- It does NOT drop the two columns or either trigger. Those are the migration, and
-- the migration is not a fixture.

delete from mentoring_conversation where id like 'tl06-rls-%';

delete from workshop_member wm using app_user u
  where u.id = wm.app_user_id and u.email like 'tl06-rls-%@example.org';
delete from app_user where email like 'tl06-rls-%@example.org';
delete from auth.users where email like 'tl06-rls-%@example.org';
delete from role_allowlist where email like 'tl06-rls-%@example.org';

drop function if exists tl06_try(text, text, uuid, text);
drop function if exists tl06_assert(text, boolean, text);
drop table if exists tl06_results;

select 'tl-06 fixtures removed' as done;
