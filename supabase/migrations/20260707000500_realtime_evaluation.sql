-- Live evaluation-coverage cue: broadcast `evaluation` changes over Supabase
-- Realtime so a submission on one device shows up on other evaluators' devices
-- (the "who still needs evaluation" cue) within a couple of seconds.
--
-- `[realtime] enabled = true` is already set in supabase/config.toml, but no
-- table was in the publication and nothing subscribed. This adds the table.

alter publication supabase_realtime add table public.evaluation;

-- The client only reads the NEW record (activity_id, workshop_id,
-- participant_scope, focus_participant_id, evaluator_email, attestation), which
-- Supabase includes in INSERT/UPDATE payloads by default — no `replica identity
-- full` needed. RLS on `evaluation` is already permissive (for all using (true)),
-- which Realtime respects, so subscribed clients receive workshop events. TIGHTEN
-- along with the other permissive policies before any wider rollout.
