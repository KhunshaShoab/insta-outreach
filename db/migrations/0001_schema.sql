-- ===========================================================================
-- OptiFlow Instagram Outbound Engine - core schema
-- Target: PostgreSQL 14+ (Supabase compatible)
-- Apply order: 0001_schema -> 0002_views -> 0003_functions -> 0004_rls
-- ===========================================================================

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ---------------------------------------------------------------------------
-- Lookup tables. Stages/statuses live in tables (not enums) so the pipeline
-- can be extended without an ALTER TYPE migration on a live database.
-- ---------------------------------------------------------------------------
create table if not exists lead_stages (
  stage            text primary key,
  position         int  not null unique,
  label            text not null,
  is_terminal      boolean not null default false,
  description      text
);

create table if not exists lead_statuses (
  status           text primary key,
  label            text not null,
  category         text not null check (category in ('progress','outreach','reply','closed','error')),
  description      text
);

insert into lead_stages (stage, position, label, is_terminal, description) values
  ('SCRAPED',            10, 'Scraped',             false, 'Raw row captured from the discovery provider'),
  ('CLEANED',            20, 'Cleaned',             false, 'Normalised, filtered and de-duplicated'),
  ('ENRICHED',           30, 'Enriched',            false, 'Company + contact enrichment attempted'),
  ('QUALIFIED',          40, 'AI Qualified',        false, 'AI qualification + ICP score written'),
  ('RESEARCHED',         50, 'AI Research',         false, 'Business research brief written'),
  ('MESSAGE_GENERATED',  60, 'Message Generated',   false, 'DM variations generated'),
  ('PENDING_APPROVAL',   70, 'Pending Approval',    false, 'Waiting in the human approval queue'),
  ('READY_FOR_OUTREACH', 80, 'Ready For Outreach',  false, 'Approved and released to the sending queue'),
  ('DM_SENT',            90, 'DM Sent',             false, 'Initial DM logged as sent'),
  ('REPLIED',           100, 'Replied',             false, 'Prospect replied - automated follow-ups cancelled'),
  ('CONVERSATION',      110, 'Conversation',        false, 'Two-way conversation in progress'),
  ('INTERESTED',        120, 'Interested',          false, 'Positive intent confirmed'),
  ('NURTURE',           130, 'Nurture',             false, 'Not now - recheck later'),
  ('NOT_INTERESTED',    140, 'Not Interested',      true,  'Declined or opted out'),
  ('CLOSED',            150, 'Closed',              true,  'Handed off or ended'),
  ('DISQUALIFIED',      160, 'Disqualified',        true,  'Failed cleaning, a hard gate, or scored below threshold')
on conflict (stage) do nothing;

insert into lead_statuses (status, label, category, description) values
  ('NEW',            'New',            'progress', 'Awaiting the next pipeline step'),
  ('PROCESSING',     'Processing',     'progress', 'Claimed by a worker'),
  ('DRAFT',          'Draft',          'outreach', 'Message drafted, not submitted for review'),
  ('PENDING_REVIEW', 'Pending Review', 'outreach', 'In the approval queue'),
  ('APPROVED',       'Approved',       'outreach', 'Human approved, ready to send'),
  ('REJECTED',       'Rejected',       'outreach', 'Human rejected the draft'),
  ('SENT',           'Sent',           'outreach', 'Message logged as sent'),
  ('REPLIED',        'Replied',        'reply',    'Prospect replied'),
  ('NO_RESPONSE',    'No Response',    'reply',    'Sequence exhausted without a reply'),
  ('FOLLOWUP_DUE',   'Follow-up Due',  'reply',    'Next follow-up is due'),
  ('INTERESTED',     'Interested',     'reply',    'Positive intent'),
  ('NOT_INTERESTED', 'Not Interested', 'closed',   'Negative intent'),
  ('NURTURE',        'Nurture',        'reply',    'Revisit later'),
  ('OPTED_OUT',      'Opted Out',      'closed',   'Asked not to be contacted again - permanent suppression'),
  ('CLOSED',         'Closed',         'closed',   'Lifecycle finished'),
  ('ERROR',          'Error',          'error',    'Last step failed, see errors table')
on conflict (status) do nothing;

-- ---------------------------------------------------------------------------
-- Configuration: niches, scoring profiles, campaigns
-- ---------------------------------------------------------------------------
create table if not exists niches (
  id                  text primary key,
  name                text not null,
  tier                text not null default 'primary' check (tier in ('primary','secondary','experimental')),
  business_model      text not null default 'ecommerce_brand'
                        check (business_model in ('local_service','ecommerce_brand','hybrid')),
  keywords            text[] not null default '{}',
  negative_keywords   text[] not null default '{}',
  search_terms        text[] not null default '{}',
  instagram_hashtags  text[] not null default '{}',
  default_locations   jsonb  not null default '{}'::jsonb,
  icp_rules           jsonb  not null default '{}'::jsonb,
  pain_points         jsonb  not null default '[]'::jsonb,
  recommended_services jsonb not null default '[]'::jsonb,
  outreach_angles     jsonb  not null default '[]'::jsonb,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists scoring_profiles (
  id          text primary key,
  name        text not null,
  config      jsonb not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists campaigns (
  id                    text primary key,
  name                  text not null,
  status                text not null default 'draft' check (status in ('draft','active','paused','archived')),
  niche_id              text references niches(id) on delete restrict,
  scoring_profile_id    text references scoring_profiles(id) on delete set null default 'default',
  targeting             jsonb not null default '{}'::jsonb,
  icp                   jsonb not null default '{}'::jsonb,
  discovery             jsonb not null default '{}'::jsonb,
  enrichment            jsonb not null default '{}'::jsonb,
  qualification         jsonb not null default '{}'::jsonb,
  research              jsonb not null default '{}'::jsonb,
  outreach              jsonb not null default '{}'::jsonb,
  followups             jsonb not null default '{}'::jsonb,
  mirror                jsonb not null default '{}'::jsonb,
  schedule              jsonb not null default '{}'::jsonb,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_campaigns_status on campaigns(status);

-- ---------------------------------------------------------------------------
-- companies: one row per real-world business. The de-duplication anchor.
-- A business discovered by three campaigns is ONE company row + three leads.
-- ---------------------------------------------------------------------------
create table if not exists companies (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  name_normalized      text not null,
  instagram_handle     text,
  instagram_url        text,
  website              text,
  website_domain       text,
  email                text,
  phone                text,
  phone_e164           text,
  country              text default 'US',
  state                text,
  city                 text,
  postal_code          text,
  address              text,
  latitude             double precision,
  longitude            double precision,
  category             text,
  niche_id             text references niches(id) on delete set null,
  business_model       text,
  bio                  text,
  website_description  text,
  products_services    jsonb not null default '[]'::jsonb,
  products_count       int,
  ig_followers         int,
  ig_following         int,
  ig_posts             int,
  ig_is_business       boolean,
  ig_is_private        boolean,
  ig_is_verified       boolean,
  ig_last_post_at      timestamptz,
  ig_external_url      text,
  company_size         text,
  employee_count       int,
  linkedin_url         text,
  facebook_url         text,
  raw                  jsonb not null default '{}'::jsonb,
  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz not null default now(),
  suppressed           boolean not null default false,
  suppressed_reason    text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Deduplication: partial unique indexes on the normalised identity columns.
create unique index if not exists uq_companies_ig_handle
  on companies (instagram_handle) where instagram_handle is not null;
create unique index if not exists uq_companies_domain
  on companies (website_domain) where website_domain is not null;
create unique index if not exists uq_companies_phone
  on companies (phone_e164) where phone_e164 is not null;
create unique index if not exists uq_companies_name_city
  on companies (name_normalized, coalesce(city,''), coalesce(state,''))
  where instagram_handle is null and website_domain is null;
create index if not exists idx_companies_name_trgm on companies using gin (name_normalized gin_trgm_ops);
create index if not exists idx_companies_state_niche on companies(state, niche_id);
create index if not exists idx_companies_email on companies(email) where email is not null;

-- Explicit identity-key table: every key a company was matched on, so a later
-- discovery hit on ANY key resolves to the same company row.
create table if not exists company_identity_keys (
  id          bigserial primary key,
  company_id  uuid not null references companies(id) on delete cascade,
  key_type    text not null check (key_type in ('instagram_handle','website_domain','phone_e164','email','name_city','place_id')),
  key_value   text not null,
  created_at  timestamptz not null default now(),
  unique (key_type, key_value)
);
create index if not exists idx_identity_keys_company on company_identity_keys(company_id);

-- ---------------------------------------------------------------------------
-- contacts: people found during enrichment
-- ---------------------------------------------------------------------------
create table if not exists contacts (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies(id) on delete cascade,
  full_name         text,
  first_name        text,
  last_name         text,
  title             text,
  role_category     text check (role_category in
                      ('founder','owner','co_founder','ceo','head_of_operations',
                       'cx_director','support_manager','marketing_director','other','unknown')),
  seniority         text,
  email             text,
  phone             text,
  linkedin_url      text,
  instagram_handle  text,
  source            text,
  source_confidence numeric(4,3) check (source_confidence between 0 and 1),
  is_primary_target boolean not null default false,
  target_reason     text,
  raw               jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_contacts_company on contacts(company_id);
create unique index if not exists uq_contacts_company_email
  on contacts (company_id, lower(email)) where email is not null;
create unique index if not exists uq_contacts_primary
  on contacts (company_id) where is_primary_target;

-- ---------------------------------------------------------------------------
-- leads: one company inside one campaign. Carries the pipeline state machine.
-- ---------------------------------------------------------------------------
create table if not exists leads (
  id                   uuid primary key default gen_random_uuid(),
  public_ref           bigint generated always as identity,   -- human-friendly "Lead 182"
  campaign_id          text not null references campaigns(id) on delete cascade,
  company_id           uuid not null references companies(id) on delete cascade,
  contact_id           uuid references contacts(id) on delete set null,
  stage                text not null default 'SCRAPED' references lead_stages(stage),
  status               text not null default 'NEW' references lead_statuses(status),
  last_completed_step  text,
  next_step            text,
  icp_score            int check (icp_score between 0 and 100),
  icp_band             text check (icp_band in ('HIGH_PRIORITY','QUALIFIED','REVIEW','NOT_QUALIFIED')),
  priority             text check (priority in ('high','medium','low','none')),
  qualified            boolean,
  disqualified_reason  text,
  recommended_service  text,
  outreach_angle       text,
  source               text,
  source_search_term   text,
  -- What the cleaning stage worked out: niche keyword hits, personal-account
  -- signals, location reasoning, blocked terms. Qualification scores niche fit
  -- from these, so they have to outlive the cleaning run.
  cleaning_flags       jsonb not null default '{}'::jsonb,
  discovered_at        timestamptz not null default now(),
  cleaned_at           timestamptz,
  enriched_at          timestamptz,
  qualified_at         timestamptz,
  researched_at        timestamptz,
  message_generated_at timestamptz,
  approved_at          timestamptz,
  first_sent_at        timestamptz,
  last_sent_at         timestamptz,
  replied_at           timestamptz,
  next_followup_at     timestamptz,
  followup_step        int not null default 0,
  claimed_by           text,
  claimed_at           timestamptz,
  retry_count          int not null default 0,
  last_error           text,
  last_error_at        timestamptz,
  last_execution_id    text,
  sheets_synced_at     timestamptz,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (campaign_id, company_id)          -- never the same business twice in a campaign
);

create index if not exists idx_leads_stage_status on leads(campaign_id, stage, status);
create index if not exists idx_leads_claim on leads(stage, status, claimed_at);
create index if not exists idx_leads_followup_due on leads(next_followup_at)
  where next_followup_at is not null;
create index if not exists idx_leads_company on leads(company_id);
create index if not exists idx_leads_score on leads(campaign_id, icp_score desc nulls last);

-- ---------------------------------------------------------------------------
-- qualification_results: every qualification run is kept (auditable history)
-- ---------------------------------------------------------------------------
create table if not exists qualification_results (
  id                    uuid primary key default gen_random_uuid(),
  lead_id               uuid not null references leads(id) on delete cascade,
  campaign_id           text not null references campaigns(id) on delete cascade,
  qualified             boolean not null,
  icp_score             int not null check (icp_score between 0 and 100),
  icp_band              text not null,
  priority              text not null,
  component_scores      jsonb not null default '{}'::jsonb,   -- every weighted component, with source
  ai_scores             jsonb not null default '{}'::jsonb,   -- raw AI judgement sub-scores
  deterministic_scores  jsonb not null default '{}'::jsonb,
  hard_gate_failures    text[] not null default '{}',
  reason                text not null,
  potential_pain_points jsonb not null default '[]'::jsonb,
  recommended_service   text,
  recommended_angle     text,
  decision_maker_found  boolean not null default false,
  model                 text,
  prompt_version        text,
  tokens_in             int,
  tokens_out            int,
  latency_ms            int,
  scoring_profile_id    text,
  raw_response          jsonb,
  created_at            timestamptz not null default now()
);
create index if not exists idx_qual_lead on qualification_results(lead_id, created_at desc);

-- ---------------------------------------------------------------------------
-- research: AI business research briefs
-- ---------------------------------------------------------------------------
create table if not exists research (
  id                   uuid primary key default gen_random_uuid(),
  lead_id              uuid not null references leads(id) on delete cascade,
  campaign_id          text not null references campaigns(id) on delete cascade,
  business_summary     text not null,
  what_they_sell       text,
  who_their_customers_are text,
  products_services    jsonb not null default '[]'::jsonb,
  instagram_focus      text,
  business_model       text,
  likely_decision_maker jsonb not null default '{}'::jsonb,
  cx_needs             jsonb not null default '[]'::jsonb,
  operational_pain_points jsonb not null default '[]'::jsonb,
  why_optiflow_relevant text,
  specific_observations jsonb not null default '[]'::jsonb,   -- the personalisation fuel
  recommended_service  text,
  recommended_angle    text,
  confidence           numeric(4,3) check (confidence between 0 and 1),
  evidence             jsonb not null default '[]'::jsonb,
  model                text,
  prompt_version       text,
  raw_response         jsonb,
  created_at           timestamptz not null default now()
);
create index if not exists idx_research_lead on research(lead_id, created_at desc);

-- ---------------------------------------------------------------------------
-- outreach: one row per message drafted/approved/sent (initial + follow-ups)
-- ---------------------------------------------------------------------------
create table if not exists outreach (
  id                 uuid primary key default gen_random_uuid(),
  lead_id            uuid not null references leads(id) on delete cascade,
  campaign_id        text not null references campaigns(id) on delete cascade,
  company_id         uuid not null references companies(id) on delete cascade,
  contact_id         uuid references contacts(id) on delete set null,
  conversation_id    uuid,
  kind               text not null default 'initial'
                       check (kind in ('initial','followup_1','followup_2','followup_3_final','reply','manual')),
  followup_step      int not null default 0,
  channel            text not null default 'instagram_dm'
                       check (channel in ('instagram_dm','instagram_comment_reply','email','other')),
  variation          text check (variation in ('conversational','professional','concise','custom')),
  variations         jsonb not null default '[]'::jsonb,  -- all generated options, for audit + A/B
  message            text not null,
  message_edited     text,
  final_message      text,
  char_count         int,
  outreach_angle     text,
  personalisation    jsonb not null default '[]'::jsonb,  -- the exact facts used
  status             text not null default 'DRAFT' references lead_statuses(status),
  approved_by        text,
  approved_at        timestamptz,
  rejected_reason    text,
  scheduled_for      timestamptz,
  sent_at            timestamptz,
  sent_by            text,
  send_mode          text check (send_mode in ('manual','graph_api')),
  external_message_id text,
  response_status    text,
  next_followup_at   timestamptz,
  model              text,
  prompt_version     text,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_outreach_lead on outreach(lead_id, created_at desc);
create index if not exists idx_outreach_queue on outreach(campaign_id, status, created_at)
  where status in ('PENDING_REVIEW','APPROVED');
create index if not exists idx_outreach_sent on outreach(campaign_id, sent_at);
create unique index if not exists uq_outreach_lead_step
  on outreach(lead_id, kind) where status <> 'REJECTED';

-- ---------------------------------------------------------------------------
-- conversations + messages: the thread with a prospect
-- ---------------------------------------------------------------------------
create table if not exists conversations (
  id                 uuid primary key default gen_random_uuid(),
  lead_id            uuid not null references leads(id) on delete cascade,
  campaign_id        text not null references campaigns(id) on delete cascade,
  channel            text not null default 'instagram_dm',
  external_thread_id text,
  state              text not null default 'OPEN'
                       check (state in ('OPEN','AWAITING_PROSPECT','AWAITING_US','INTERESTED','NURTURE','NOT_INTERESTED','CLOSED')),
  last_message_at    timestamptz,
  last_direction     text check (last_direction in ('outbound','inbound')),
  message_count      int not null default 0,
  summary            text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (lead_id, channel)
);

create table if not exists conversation_messages (
  id                 uuid primary key default gen_random_uuid(),
  conversation_id    uuid not null references conversations(id) on delete cascade,
  lead_id            uuid not null references leads(id) on delete cascade,
  outreach_id        uuid references outreach(id) on delete set null,
  direction          text not null check (direction in ('outbound','inbound')),
  body               text not null,
  sent_at            timestamptz not null default now(),
  external_message_id text,
  sender_handle      text,
  -- AI classification (inbound only)
  classification     text check (classification in
                       ('interested','curious','question','wants_details','pricing','positive',
                        'maybe_later','not_interested','wrong_person','objection','unclear','auto_reply','opt_out')),
  intent             text,
  sentiment          text check (sentiment in ('positive','neutral','negative','mixed')),
  urgency            text check (urgency in ('high','medium','low')),
  objection_type     text,
  recommended_action text,
  classification_meta jsonb not null default '{}'::jsonb,
  classified_at      timestamptz,
  raw                jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);
create index if not exists idx_convmsg_conversation on conversation_messages(conversation_id, sent_at);
create index if not exists idx_convmsg_lead on conversation_messages(lead_id, sent_at desc);
create unique index if not exists uq_convmsg_external
  on conversation_messages(external_message_id) where external_message_id is not null;

-- Suggested replies produced by the AI response assistant
create table if not exists suggested_responses (
  id                 uuid primary key default gen_random_uuid(),
  conversation_id    uuid not null references conversations(id) on delete cascade,
  lead_id            uuid not null references leads(id) on delete cascade,
  in_reply_to        uuid references conversation_messages(id) on delete cascade,
  suggestion         text not null,
  reason             text,
  next_action        text,
  alternatives       jsonb not null default '[]'::jsonb,
  status             text not null default 'PENDING_REVIEW'
                       check (status in ('PENDING_REVIEW','USED','EDITED','REGENERATED','IGNORED')),
  used_message       text,
  decided_by         text,
  decided_at         timestamptz,
  model              text,
  prompt_version     text,
  raw_response       jsonb,
  created_at         timestamptz not null default now()
);
create index if not exists idx_suggested_conv on suggested_responses(conversation_id, created_at desc);

-- ---------------------------------------------------------------------------
-- followups: the scheduled sequence
-- ---------------------------------------------------------------------------
create table if not exists followups (
  id               uuid primary key default gen_random_uuid(),
  lead_id          uuid not null references leads(id) on delete cascade,
  campaign_id      text not null references campaigns(id) on delete cascade,
  step             int not null,
  kind             text not null,
  due_at           timestamptz not null,
  status           text not null default 'SCHEDULED'
                     check (status in ('SCHEDULED','GENERATING','PENDING_REVIEW','APPROVED','SENT','CANCELLED','SKIPPED','FAILED')),
  cancelled_reason text,
  outreach_id      uuid references outreach(id) on delete set null,
  generated_at     timestamptz,
  sent_at          timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (lead_id, step)
);
create index if not exists idx_followups_due on followups(status, due_at) where status = 'SCHEDULED';

-- ---------------------------------------------------------------------------
-- activities: append-only audit log of every state transition and action
-- ---------------------------------------------------------------------------
create table if not exists activities (
  id            bigserial primary key,
  lead_id       uuid references leads(id) on delete cascade,
  campaign_id   text references campaigns(id) on delete cascade,
  company_id    uuid references companies(id) on delete cascade,
  actor         text not null default 'system',   -- system | n8n:<workflow> | user:<email>
  action        text not null,
  from_stage    text,
  to_stage      text,
  from_status   text,
  to_status     text,
  detail        jsonb not null default '{}'::jsonb,
  execution_id  text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_activities_lead on activities(lead_id, created_at desc);
create index if not exists idx_activities_campaign_day on activities(campaign_id, created_at);
create index if not exists idx_activities_action on activities(action, created_at desc);

-- ---------------------------------------------------------------------------
-- errors: the failed-item queue. One failed lead never stops a campaign.
-- ---------------------------------------------------------------------------
create table if not exists errors (
  id             bigserial primary key,
  lead_id        uuid references leads(id) on delete cascade,
  campaign_id    text references campaigns(id) on delete cascade,
  workflow       text not null,
  node           text,
  stage          text,
  provider       text,
  error_type     text not null check (error_type in
                   ('rate_limit','timeout','auth','validation','provider_error','ai_schema','network','unknown')),
  message        text not null,
  http_status    int,
  payload        jsonb,
  retry_count    int not null default 0,
  max_retries    int not null default 3,
  next_retry_at  timestamptz,
  resolved       boolean not null default false,
  resolved_at    timestamptz,
  resolution     text,
  execution_id   text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_errors_retry on errors(resolved, next_retry_at) where resolved = false;
create index if not exists idx_errors_campaign on errors(campaign_id, created_at desc);

-- ---------------------------------------------------------------------------
-- suppression list: opt-outs and do-not-contact, checked before every queue
-- ---------------------------------------------------------------------------
create table if not exists suppressions (
  id          bigserial primary key,
  key_type    text not null check (key_type in ('instagram_handle','website_domain','email','phone_e164','company_id')),
  key_value   text not null,
  reason      text not null,
  created_by  text,
  created_at  timestamptz not null default now(),
  unique (key_type, key_value)
);

-- ---------------------------------------------------------------------------
-- provider_calls: rate-limit + cost accounting for every external call
-- ---------------------------------------------------------------------------
create table if not exists provider_calls (
  id            bigserial primary key,
  provider      text not null,
  operation     text not null,
  campaign_id   text,
  lead_id       uuid,
  ok            boolean not null,
  http_status   int,
  latency_ms    int,
  units         numeric(12,4),
  cost_usd      numeric(12,6),
  error         text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_provider_calls_day on provider_calls(provider, created_at);

-- ---------------------------------------------------------------------------
-- workflow_runs: resume/progress bookkeeping per workflow execution
-- ---------------------------------------------------------------------------
create table if not exists workflow_runs (
  id             uuid primary key default gen_random_uuid(),
  workflow       text not null,
  campaign_id    text references campaigns(id) on delete cascade,
  execution_id   text,
  status         text not null default 'RUNNING' check (status in ('RUNNING','SUCCESS','PARTIAL','FAILED')),
  items_in       int not null default 0,
  items_ok       int not null default 0,
  items_failed   int not null default 0,
  cursor         jsonb not null default '{}'::jsonb,   -- resume point (page, offset, last id)
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  error          text
);
create index if not exists idx_workflow_runs on workflow_runs(workflow, campaign_id, started_at desc);

-- ---------------------------------------------------------------------------
-- daily_metrics: snapshot table written by the reporting workflow
-- ---------------------------------------------------------------------------
create table if not exists daily_metrics (
  id              bigserial primary key,
  day             date not null,
  campaign_id     text references campaigns(id) on delete cascade,
  niche_id        text,
  state           text,
  metrics         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create unique index if not exists uq_daily_metrics
  on daily_metrics (day, campaign_id, coalesce(niche_id,''), coalesce(state,''));

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['niches','scoring_profiles','campaigns','companies','contacts','leads','outreach','conversations','followups']
  loop
    execute format('drop trigger if exists trg_%1$s_updated_at on %1$s', t);
    execute format('create trigger trg_%1$s_updated_at before update on %1$s for each row execute function set_updated_at()', t);
  end loop;
end $$;
