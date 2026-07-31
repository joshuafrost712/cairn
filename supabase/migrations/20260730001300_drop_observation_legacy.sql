-- Drop the retired foundation observation table (tl-18).
--
-- tl-04 renamed the original `observation` table to `observation_legacy` rather
-- than dropping it, because the pilot workshop's history might still have needed
-- reading during the recovery. On 2026-07-30 Joshua chose a fresh start over that
-- recovery: the stranded evaluations were archived to a local file and deleted,
-- so nothing will ever be read back out of this table.
--
-- Verified empty and unreferenced before dropping: 0 rows, 0 policies, and no
-- occurrence anywhere in src/ (the only mentions are the tl-04 migration that
-- created the name and a tl-04 RLS check asserting anon cannot read it, which is
-- retired alongside it).

drop table if exists public.observation_legacy;
