-- tl-26 dress rehearsal: the two throwaway accounts the rehearsal is driven from.
--
--   node scripts/apply-migration.mjs scripts/tl26-setup.sql
--   node scripts/tl26-dress-rehearsal.mjs            (with npm run dev and npm run relay up)
--   node scripts/apply-migration.mjs scripts/tl26-teardown.sql
--
-- WHY TWO ACCOUNTS AND NOT ONE. The verification gate is two confirmations
-- (`required_confirmations`, default 2), and the spec is explicit that a rehearsal
-- proving the gate by switching the gate off has proved less than it looks. So the
-- second verdict comes from a second real account holding a real evaluator
-- membership, which is the same shape tl-25's negative test used.
--
-- WHY THE ADMIN IS A MEMBER OF PSALMS TOO. Step 5 is the tl-17 regression, and it
-- can only run from one device holding BOTH memberships: the failure it exists to
-- catch is `db.workshops.toArray()[0]` deciding whose name goes on a batch, which
-- is unreachable when the device knows about one workshop. Joshua holds both and
-- cannot be driven (nobody has his password), so the throwaway takes the same
-- shape. It is `admin` on Psalms, never chief_admin, and it is removed by the
-- teardown in the same session.
--
-- WHY IMPERSONATION RATHER THAN AN INSERT. tl-01 revoked the client grants on
-- `workshop_member` and `invite_to_workshop` is the only path in. The RPC resolves
-- its actor from auth.uid(), which is null under the `postgres` role this file runs
-- as, so the claim is set to Joshua's — the harness pattern every tl*-rls-tests.sql
-- has used since tl-01. `can_grant` then runs against his real chief_admin role on
-- each workshop, so an invitation he is not entitled to issue still fails. That is
-- the permission being exercised, not evaded.
--
-- The password is real bcrypt because Playwright signs in through the real Supabase
-- Auth endpoint. It is a throwaway on an example.org address that receives no mail.

drop table if exists tl26_setup_log;
create table tl26_setup_log (seq serial primary key, step text, outcome text);

do $$
declare
  _cc     uuid := '74d1c3ac-ce6e-433f-b2b6-54ab4e01e21b';   -- OBT Crash Course
  _ps     uuid := '11111111-1111-1111-1111-111111111111';   -- Psalms Workshop
  _josh   uuid;
  _pw     text := 'tl26-Throwaway-Password-1!';
  _r      record;
  _out    jsonb;
  _uid    uuid;
begin
  -- Resolve Joshua BEFORE the role switch. tl-25's session lost an afternoon here:
  -- `app_user_select` hides anybody you do not already share a workshop with, so
  -- the same select run as `authenticated` returns nothing and the claim goes in
  -- as {"sub": null}, and every invitation comes back tl02.no_account. RLS filters
  -- rather than refusing, so an empty subselect says nothing on its way past.
  select auth_user_id into _josh from app_user where email = 'josh_frost@sil.org';
  if _josh is null then
    raise exception 'no app_user for josh_frost@sil.org; nothing can be invited';
  end if;

  for _r in
    select * from (values
      ('tl26-admin@example.org',     _cc, 'admin',     'TL26 Throwaway Admin'),
      ('tl26-admin@example.org',     _ps, 'admin',     'TL26 Throwaway Admin'),
      ('tl26-evaluator@example.org', _cc, 'evaluator', 'TL26 Throwaway Evaluator')
    ) as t(email, ws, role, display)
  loop
    -- One invitation per call, each caught: the RPC raises on an already-pending
    -- invitation and a partial re-run should report that rather than abort the file.
    begin
      perform set_config('role', 'authenticated', true);
      perform set_config('request.jwt.claims',
                         json_build_object('sub', _josh, 'role', 'authenticated')::text, true);
      _out := invite_to_workshop(_r.ws, _r.email, _r.role);
      reset role;
      insert into tl26_setup_log (step, outcome)
      values (format('invite %s as %s', _r.email, _r.role), coalesce(_out->>'outcome', _out::text));
    exception when others then
      reset role;
      insert into tl26_setup_log (step, outcome)
      values (format('invite %s as %s', _r.email, _r.role), format('[%s] %s', sqlstate, sqlerrm));
    end;

    -- Then the account, which is what turns a pending invitation into a membership:
    -- handle_new_user reads the invitation and refuses a sign-up that has none.
    if not exists (select 1 from auth.users where email = _r.email) then
      _uid := gen_random_uuid();
      -- The eight empty strings are not decoration. GoTrue scans these columns into
      -- Go `string`s, which cannot hold NULL, so a hand-inserted row that leaves them
      -- null makes every sign-in for that account fail with "Database error querying
      -- schema" — a 500 that names neither the column nor the row. tl-25 never met
      -- this because it only ever asserted against Postgres and never signed in.
      -- Anything in this wave that provisions an account a browser will actually use
      -- copies this list.
      insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                              email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                              created_at, updated_at,
                              confirmation_token, email_change, email_change_token_new,
                              email_change_token_current, recovery_token,
                              phone_change, phone_change_token, reauthentication_token)
      values (_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              _r.email, crypt(_pw, gen_salt('bf')), now(),
              '{"provider":"email","providers":["email"]}'::jsonb,
              json_build_object('name', _r.display)::jsonb, now(), now(),
              '', '', '', '', '', '', '', '');
      insert into tl26_setup_log (step, outcome) values (format('account %s', _r.email), 'created');
    else
      insert into tl26_setup_log (step, outcome) values (format('account %s', _r.email), 'already existed');
    end if;
  end loop;
end $$;

-- The report. Memberships are the thing that has to be true for the harness to run
-- at all, so they are printed rather than asserted here: a missing one should stop
-- a human, not a script three steps later with a confusing message.
select 'log' as kind, step as a, outcome as b from tl26_setup_log
union all
select 'membership', au.email, format('%s on %s', m.role, w.name)
  from workshop_member m
  join workshop w on w.id = m.workshop_id
  join app_user au on au.id = m.app_user_id
 where au.email like 'tl26-%'
order by 1 desc, 2;
