-- Per-call logging + spend visibility for the Claude routing layer.
-- The Edge Function inserts one row per API call and sums the current month
-- against a configured cap before each call.

create table claude_call_log (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  label         text,
  evaluation_id uuid references evaluation(id) on delete set null,
  model         text,
  input_tokens  int default 0,
  output_tokens int default 0,
  cache_read_input_tokens     int default 0,
  cache_creation_input_tokens int default 0,
  cost_usd      numeric not null default 0
);

create index claude_call_log_created_at_idx on claude_call_log (created_at);

alter table claude_call_log enable row level security;
-- Server-side only (service role bypasses RLS); no anon policy on purpose.
