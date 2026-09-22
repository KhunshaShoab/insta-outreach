-- ===========================================================================
-- Row level security.
-- Model: n8n and the daily-report job connect with the service role and
-- bypass RLS. The approval console connects as an authenticated user and may
-- only read the queue views and call the approval/send functions.
-- Apply this on Supabase; on plain Postgres use roles + grants instead.
-- ===========================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

alter table campaigns              enable row level security;
alter table niches                 enable row level security;
alter table scoring_profiles       enable row level security;
alter table companies              enable row level security;
alter table contacts               enable row level security;
alter table leads                  enable row level security;
alter table qualification_results  enable row level security;
alter table research               enable row level security;
alter table outreach               enable row level security;
alter table conversations          enable row level security;
alter table conversation_messages  enable row level security;
alter table suggested_responses    enable row level security;
alter table followups              enable row level security;
alter table activities             enable row level security;
alter table errors                 enable row level security;
alter table suppressions           enable row level security;
alter table provider_calls         enable row level security;
alter table workflow_runs          enable row level security;
alter table daily_metrics          enable row level security;
alter table company_identity_keys  enable row level security;

-- Operators (signed-in console users) can read the pipeline...
do $$
declare t text;
begin
  foreach t in array array[
    'campaigns','niches','scoring_profiles','companies','contacts','leads',
    'qualification_results','research','outreach','conversations',
    'conversation_messages','suggested_responses','followups','activities',
    'errors','daily_metrics','workflow_runs'
  ] loop
    execute format('drop policy if exists %1$s_read on %1$s', t);
    execute format('create policy %1$s_read on %1$s for select to authenticated using (true)', t);
  end loop;
end $$;

-- ...and may only write the things a human is supposed to decide.
drop policy if exists outreach_operator_update on outreach;
create policy outreach_operator_update on outreach
  for update to authenticated
  using (status in ('DRAFT','PENDING_REVIEW','APPROVED'))
  with check (status in ('DRAFT','PENDING_REVIEW','APPROVED','REJECTED','SENT'));

drop policy if exists suggested_operator_update on suggested_responses;
create policy suggested_operator_update on suggested_responses
  for update to authenticated using (true) with check (true);

drop policy if exists leads_operator_notes on leads;
create policy leads_operator_notes on leads
  for update to authenticated using (true) with check (true);

drop policy if exists conversation_messages_operator_insert on conversation_messages;
create policy conversation_messages_operator_insert on conversation_messages
  for insert to authenticated with check (true);

drop policy if exists suppressions_operator on suppressions;
create policy suppressions_operator on suppressions
  for all to authenticated using (true) with check (true);

-- anon gets nothing at all.
revoke all on all tables in schema public from anon;

grant usage on schema public to authenticated, service_role;
grant select on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- The console calls these and nothing else.
grant execute on function approve_outreach(uuid, text, text)                      to authenticated;
grant execute on function reject_outreach(uuid, text, text, boolean)              to authenticated;
grant execute on function mark_outreach_sent(uuid, text, text, text, timestamptz) to authenticated;
grant execute on function set_lead_outcome(uuid, text, text, text)                to authenticated;
grant execute on function opt_out(uuid, text)                                     to authenticated;
grant execute on function daily_report(date, text)                                to authenticated;
