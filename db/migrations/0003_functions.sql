-- ===========================================================================
-- Functions and triggers: work claiming, stage transitions, deduplication,
-- follow-up scheduling, and the reply-stops-everything rule.
-- These make each n8n workflow idempotent and safely re-runnable.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- log_activity: append-only audit trail
-- ---------------------------------------------------------------------------
create or replace function log_activity(
  p_lead_id uuid,
  p_action text,
  p_actor text default 'system',
  p_detail jsonb default '{}'::jsonb,
  p_execution_id text default null
) returns bigint
language plpgsql as $$
declare v_id bigint; v_campaign text; v_company uuid;
begin
  select campaign_id, company_id into v_campaign, v_company from leads where id = p_lead_id;
  insert into activities (lead_id, campaign_id, company_id, actor, action, detail, execution_id)
  values (p_lead_id, v_campaign, v_company, p_actor, p_action, coalesce(p_detail,'{}'::jsonb), p_execution_id)
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- claim_leads: hand a worker a batch of leads at a stage, exactly once.
-- FOR UPDATE SKIP LOCKED means parallel n8n executions never collide, and a
-- crashed execution's claim expires after p_stale_minutes so work resumes.
-- ---------------------------------------------------------------------------
create or replace function claim_leads(
  p_campaign_id text,
  p_stage text,
  p_limit int default 25,
  p_worker text default 'n8n',
  p_stale_minutes int default 20,
  p_max_retries int default 3
) returns setof leads
language plpgsql as $$
begin
  return query
  with candidate as (
    select l.id
    from leads l
    where l.stage = p_stage
      and (p_campaign_id is null or l.campaign_id = p_campaign_id)
      and l.retry_count <= p_max_retries
      and (
        l.status in ('NEW','ERROR')
        or (l.status = 'PROCESSING' and l.claimed_at < now() - make_interval(mins => p_stale_minutes))
      )
    order by l.icp_score desc nulls last, l.discovered_at
    limit p_limit
    for update skip locked
  )
  update leads l
     set status = 'PROCESSING',
         claimed_by = p_worker,
         claimed_at = now()
    from candidate
   where l.id = candidate.id
  returning l.*;
end $$;

-- ---------------------------------------------------------------------------
-- advance_lead: move a lead forward, stamp the step timestamp, clear errors.
-- Idempotent: advancing to a stage the lead already passed is a no-op.
-- ---------------------------------------------------------------------------
create or replace function advance_lead(
  p_lead_id uuid,
  p_to_stage text,
  p_status text default 'NEW',
  p_step text default null,
  p_detail jsonb default '{}'::jsonb,
  p_execution_id text default null
) returns leads
language plpgsql as $$
declare
  v_lead leads;
  v_from_stage text;
  v_from_pos int;
  v_to_pos int;
begin
  select * into v_lead from leads where id = p_lead_id for update;
  if not found then
    raise exception 'advance_lead: lead % not found', p_lead_id;
  end if;

  v_from_stage := v_lead.stage;
  select position into v_from_pos from lead_stages where stage = v_from_stage;
  select position into v_to_pos   from lead_stages where stage = p_to_stage;
  if v_to_pos is null then
    raise exception 'advance_lead: unknown stage %', p_to_stage;
  end if;

  update leads set
    stage               = case when v_to_pos >= v_from_pos then p_to_stage else stage end,
    status              = p_status,
    last_completed_step = coalesce(p_step, last_completed_step),
    claimed_by          = null,
    claimed_at          = null,
    retry_count         = 0,
    last_error          = null,
    last_error_at       = null,
    last_execution_id   = coalesce(p_execution_id, last_execution_id),
    cleaned_at           = case when p_to_stage = 'CLEANED'           then coalesce(cleaned_at, now())           else cleaned_at end,
    enriched_at          = case when p_to_stage = 'ENRICHED'          then coalesce(enriched_at, now())          else enriched_at end,
    qualified_at         = case when p_to_stage = 'QUALIFIED'         then coalesce(qualified_at, now())         else qualified_at end,
    researched_at        = case when p_to_stage = 'RESEARCHED'        then coalesce(researched_at, now())        else researched_at end,
    message_generated_at = case when p_to_stage = 'MESSAGE_GENERATED' then coalesce(message_generated_at, now()) else message_generated_at end,
    approved_at          = case when p_to_stage = 'READY_FOR_OUTREACH' then coalesce(approved_at, now())         else approved_at end,
    updated_at          = now()
  where id = p_lead_id
  returning * into v_lead;

  perform log_activity(p_lead_id, 'stage_advanced', coalesce(p_detail->>'actor','system'),
    jsonb_build_object('from', v_from_stage, 'to', p_to_stage, 'step', p_step) || coalesce(p_detail,'{}'::jsonb),
    p_execution_id);

  update activities set from_stage = v_from_stage, to_stage = p_to_stage
   where id = (select max(id) from activities where lead_id = p_lead_id);

  return v_lead;
end $$;

-- ---------------------------------------------------------------------------
-- fail_lead: record a failure without stopping the campaign.
-- The lead goes back to ERROR at its current stage; claim_leads picks it up
-- again until retry_count passes the workflow's max.
-- ---------------------------------------------------------------------------
create or replace function fail_lead(
  p_lead_id uuid,
  p_workflow text,
  p_error_type text,
  p_message text,
  p_node text default null,
  p_provider text default null,
  p_http_status int default null,
  p_payload jsonb default '{}'::jsonb,
  p_max_retries int default 3,
  p_execution_id text default null
) returns leads
language plpgsql as $$
declare v_lead leads; v_retry int; v_backoff interval;
begin
  update leads
     set retry_count   = retry_count + 1,
         status        = 'ERROR',
         claimed_by    = null,
         claimed_at    = null,
         last_error    = left(p_message, 2000),
         last_error_at = now(),
         last_execution_id = coalesce(p_execution_id, last_execution_id),
         updated_at    = now()
   where id = p_lead_id
   returning * into v_lead;

  v_retry := coalesce(v_lead.retry_count, 1);
  -- exponential backoff: 2s, 4s, 8s, 16s ... capped at 1 hour
  v_backoff := make_interval(secs => least(3600, power(2, least(v_retry, 11))::int));

  insert into errors (lead_id, campaign_id, workflow, node, stage, provider, error_type,
                      message, http_status, payload, retry_count, max_retries,
                      next_retry_at, execution_id)
  values (p_lead_id, v_lead.campaign_id, p_workflow, p_node, v_lead.stage, p_provider,
          p_error_type, left(p_message, 4000), p_http_status, p_payload, v_retry, p_max_retries,
          now() + v_backoff, p_execution_id);

  perform log_activity(p_lead_id, 'step_failed', 'system',
    jsonb_build_object('workflow', p_workflow, 'node', p_node, 'error_type', p_error_type,
                       'message', left(p_message,500), 'retry_count', v_retry), p_execution_id);
  return v_lead;
end $$;

-- ---------------------------------------------------------------------------
-- resolve_company: deduplication entry point.
-- Given whatever identity keys discovery produced, return the existing company
-- or create one. Every key seen is recorded, so a later hit on ANY of them
-- resolves to the same row. This is what stops a business entering the queue
-- twice.
-- ---------------------------------------------------------------------------
create or replace function resolve_company(
  p_name text,
  p_name_normalized text,
  p_instagram_handle text default null,
  p_website_domain text default null,
  p_phone_e164 text default null,
  p_email text default null,
  p_city text default null,
  p_state text default null,
  p_place_id text default null,
  p_attrs jsonb default '{}'::jsonb
) returns companies
language plpgsql as $$
declare
  v_company companies;
  v_company_id uuid;
  v_keys text[][];
  v_name_city text;
begin
  v_name_city := p_name_normalized || '|' || coalesce(lower(p_city),'') || '|' || coalesce(upper(p_state),'');

  -- 1. try every identity key, strongest first
  select company_id into v_company_id from company_identity_keys
   where (key_type, key_value) in (
     ('instagram_handle', lower(p_instagram_handle)),
     ('website_domain',   lower(p_website_domain)),
     ('phone_e164',       p_phone_e164),
     ('email',            lower(p_email)),
     ('place_id',         p_place_id),
     ('name_city',        v_name_city)
   )
   order by case key_type
     when 'instagram_handle' then 1 when 'website_domain' then 2 when 'place_id' then 3
     when 'phone_e164' then 4 when 'email' then 5 else 6 end
   limit 1;

  -- 2. fall back to the unique columns on companies itself
  if v_company_id is null then
    select id into v_company_id from companies
     where (p_instagram_handle is not null and instagram_handle = lower(p_instagram_handle))
        or (p_website_domain   is not null and website_domain   = lower(p_website_domain))
        or (p_phone_e164       is not null and phone_e164       = p_phone_e164)
     limit 1;
  end if;

  if v_company_id is null then
    insert into companies (
      name, name_normalized, instagram_handle, website_domain, phone_e164, email, city, state,
      instagram_url, website, phone, country, category, niche_id, business_model, bio,
      website_description, products_services, products_count, ig_followers, ig_following,
      ig_posts, ig_is_business, ig_is_private, ig_is_verified, ig_last_post_at, ig_external_url,
      address, postal_code, latitude, longitude, raw
    ) values (
      p_name, p_name_normalized, lower(p_instagram_handle), lower(p_website_domain), p_phone_e164,
      lower(p_email), p_city, upper(p_state),
      p_attrs->>'instagram_url', p_attrs->>'website', p_attrs->>'phone',
      coalesce(p_attrs->>'country','US'), p_attrs->>'category', p_attrs->>'niche_id',
      p_attrs->>'business_model', p_attrs->>'bio', p_attrs->>'website_description',
      coalesce(p_attrs->'products_services','[]'::jsonb),
      nullif(p_attrs->>'products_count','')::int,
      nullif(p_attrs->>'ig_followers','')::int,
      nullif(p_attrs->>'ig_following','')::int,
      nullif(p_attrs->>'ig_posts','')::int,
      nullif(p_attrs->>'ig_is_business','')::boolean,
      nullif(p_attrs->>'ig_is_private','')::boolean,
      nullif(p_attrs->>'ig_is_verified','')::boolean,
      nullif(p_attrs->>'ig_last_post_at','')::timestamptz,
      p_attrs->>'ig_external_url', p_attrs->>'address', p_attrs->>'postal_code',
      nullif(p_attrs->>'latitude','')::double precision,
      nullif(p_attrs->>'longitude','')::double precision,
      coalesce(p_attrs->'raw','{}'::jsonb)
    )
    returning id into v_company_id;
  else
    -- merge: only fill gaps, never overwrite a known value with null
    update companies set
      instagram_handle    = coalesce(instagram_handle, lower(p_instagram_handle)),
      instagram_url       = coalesce(instagram_url, p_attrs->>'instagram_url'),
      website             = coalesce(website, p_attrs->>'website'),
      website_domain      = coalesce(website_domain, lower(p_website_domain)),
      phone               = coalesce(phone, p_attrs->>'phone'),
      phone_e164          = coalesce(phone_e164, p_phone_e164),
      email               = coalesce(email, lower(p_email)),
      city                = coalesce(city, p_city),
      state               = coalesce(state, upper(p_state)),
      category            = coalesce(category, p_attrs->>'category'),
      niche_id            = coalesce(niche_id, p_attrs->>'niche_id'),
      bio                 = coalesce(p_attrs->>'bio', bio),
      products_services   = case when jsonb_array_length(coalesce(p_attrs->'products_services','[]'::jsonb)) >
                                      jsonb_array_length(products_services)
                                 then p_attrs->'products_services' else products_services end,
      products_count      = greatest(coalesce(products_count,0), coalesce(nullif(p_attrs->>'products_count','')::int,0)),
      ig_followers        = coalesce(nullif(p_attrs->>'ig_followers','')::int, ig_followers),
      ig_posts            = coalesce(nullif(p_attrs->>'ig_posts','')::int, ig_posts),
      ig_last_post_at     = coalesce(nullif(p_attrs->>'ig_last_post_at','')::timestamptz, ig_last_post_at),
      last_seen_at        = now(),
      updated_at          = now()
    where id = v_company_id;
  end if;

  -- 3. record every key we now know about
  v_keys := array[
    array['instagram_handle', lower(p_instagram_handle)],
    array['website_domain',   lower(p_website_domain)],
    array['phone_e164',       p_phone_e164],
    array['email',            lower(p_email)],
    array['place_id',         p_place_id],
    array['name_city',        v_name_city]
  ];
  for i in 1 .. array_length(v_keys, 1) loop
    if v_keys[i][2] is not null and v_keys[i][2] <> '' then
      insert into company_identity_keys (company_id, key_type, key_value)
      values (v_company_id, v_keys[i][1], v_keys[i][2])
      on conflict (key_type, key_value) do nothing;
    end if;
  end loop;

  select * into v_company from companies where id = v_company_id;
  return v_company;
end $$;

-- ---------------------------------------------------------------------------
-- is_suppressed: opt-out / do-not-contact check, run before queueing
-- ---------------------------------------------------------------------------
create or replace function is_suppressed(p_company_id uuid) returns boolean
language plpgsql stable as $$
declare v_hit boolean;
begin
  select exists (
    select 1 from companies c
    left join suppressions s on
      (s.key_type = 'company_id'       and s.key_value = c.id::text) or
      (s.key_type = 'instagram_handle' and s.key_value = c.instagram_handle) or
      (s.key_type = 'website_domain'   and s.key_value = c.website_domain) or
      (s.key_type = 'email'            and s.key_value = c.email) or
      (s.key_type = 'phone_e164'       and s.key_value = c.phone_e164)
    where c.id = p_company_id and (c.suppressed or s.id is not null)
  ) into v_hit;
  return coalesce(v_hit, false);
end $$;

-- ---------------------------------------------------------------------------
-- upsert_lead: create the campaign-scoped lead for a resolved company.
-- The unique (campaign_id, company_id) constraint is the second dedupe wall.
-- ---------------------------------------------------------------------------
create or replace function upsert_lead(
  p_campaign_id text,
  p_company_id uuid,
  p_source text default null,
  p_search_term text default null
) returns leads
language plpgsql as $$
declare v_lead leads;
begin
  insert into leads (campaign_id, company_id, source, source_search_term)
  values (p_campaign_id, p_company_id, p_source, p_search_term)
  on conflict (campaign_id, company_id) do update
    set last_error = leads.last_error   -- no-op update so RETURNING gives the row
  returning * into v_lead;
  return v_lead;
end $$;

-- ---------------------------------------------------------------------------
-- schedule_followups: build the sequence from the campaign's day offsets.
-- Called once, when the initial DM is marked as sent.
-- ---------------------------------------------------------------------------
create or replace function schedule_followups(
  p_lead_id uuid,
  p_from timestamptz default now()
) returns int
language plpgsql as $$
declare
  v_lead leads;
  v_offsets jsonb;
  v_kinds text[] := array['followup_1','followup_2','followup_3_final'];
  v_count int := 0;
  v_offset int;
  i int;
begin
  select * into v_lead from leads where id = p_lead_id;
  if not found then return 0; end if;

  select coalesce(c.followups->'day_offsets', '[2,5,9]'::jsonb) into v_offsets
    from campaigns c where c.id = v_lead.campaign_id;

  if coalesce((select (c.followups->>'enabled')::boolean from campaigns c where c.id = v_lead.campaign_id), true) = false then
    return 0;
  end if;

  for i in 0 .. jsonb_array_length(v_offsets) - 1 loop
    exit when i + 1 > array_length(v_kinds, 1);
    v_offset := (v_offsets->>i)::int;
    insert into followups (lead_id, campaign_id, step, kind, due_at)
    values (p_lead_id, v_lead.campaign_id, i + 1, v_kinds[i + 1], p_from + make_interval(days => v_offset))
    on conflict (lead_id, step) do nothing;
    v_count := v_count + 1;
  end loop;

  update leads
     set next_followup_at = (select min(due_at) from followups
                              where lead_id = p_lead_id and status = 'SCHEDULED')
   where id = p_lead_id;

  perform log_activity(p_lead_id, 'followups_scheduled', 'system',
                       jsonb_build_object('count', v_count, 'offsets', v_offsets));
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- cancel_followups: the reply-stops-everything rule, as one call.
-- ---------------------------------------------------------------------------
create or replace function cancel_followups(p_lead_id uuid, p_reason text default 'reply_received')
returns int
language plpgsql as $$
declare v_count int;
begin
  update followups
     set status = 'CANCELLED', cancelled_reason = p_reason, updated_at = now()
   where lead_id = p_lead_id and status in ('SCHEDULED','GENERATING','PENDING_REVIEW','APPROVED');
  get diagnostics v_count = row_count;

  update outreach
     set status = 'REJECTED', rejected_reason = p_reason, updated_at = now()
   where lead_id = p_lead_id
     and kind <> 'initial'
     and status in ('DRAFT','PENDING_REVIEW','APPROVED')
     and sent_at is null;

  update leads set next_followup_at = null, updated_at = now() where id = p_lead_id;

  if v_count > 0 then
    perform log_activity(p_lead_id, 'followups_cancelled', 'system',
                         jsonb_build_object('count', v_count, 'reason', p_reason));
  end if;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Trigger: any inbound message cancels the sequence and moves the lead on.
-- This is enforced in the database so no workflow bug can keep a sequence
-- running against someone who already answered.
-- ---------------------------------------------------------------------------
create or replace function trg_inbound_message() returns trigger
language plpgsql as $$
declare v_stage_pos int; v_replied_pos int;
begin
  if new.direction <> 'inbound' then
    return new;
  end if;

  perform cancel_followups(new.lead_id, 'reply_received');

  select s.position into v_stage_pos from leads l join lead_stages s on s.stage = l.stage where l.id = new.lead_id;
  select position into v_replied_pos from lead_stages where stage = 'REPLIED';

  update leads
     set replied_at = coalesce(replied_at, new.sent_at),
         stage      = case when coalesce(v_stage_pos, 0) < v_replied_pos then 'REPLIED' else stage end,
         status     = 'REPLIED',
         next_followup_at = null,
         updated_at = now()
   where id = new.lead_id;

  update conversations
     set last_message_at = new.sent_at,
         last_direction  = 'inbound',
         message_count   = message_count + 1,
         state           = 'AWAITING_US',
         updated_at      = now()
   where id = new.conversation_id;

  update outreach
     set response_status = 'REPLIED', updated_at = now()
   where lead_id = new.lead_id and sent_at is not null;

  perform log_activity(new.lead_id, 'reply_received', 'prospect',
                       jsonb_build_object('message_id', new.id, 'preview', left(new.body, 200)));
  return new;
end $$;

drop trigger if exists trg_conversation_messages_inbound on conversation_messages;
create trigger trg_conversation_messages_inbound
  after insert on conversation_messages
  for each row execute function trg_inbound_message();

-- Outbound messages keep the conversation counters honest too.
create or replace function trg_outbound_message() returns trigger
language plpgsql as $$
begin
  if new.direction <> 'outbound' then return new; end if;
  update conversations
     set last_message_at = new.sent_at,
         last_direction  = 'outbound',
         message_count   = message_count + 1,
         state           = case when state = 'AWAITING_US' then 'AWAITING_PROSPECT' else state end,
         updated_at      = now()
   where id = new.conversation_id;
  return new;
end $$;

drop trigger if exists trg_conversation_messages_outbound on conversation_messages;
create trigger trg_conversation_messages_outbound
  after insert on conversation_messages
  for each row execute function trg_outbound_message();

-- ---------------------------------------------------------------------------
-- mark_outreach_sent: single entry point used by both the manual console and
-- the API sender. Logs the message, opens/updates the conversation, advances
-- the lead, and schedules the sequence on the first send.
-- ---------------------------------------------------------------------------
create or replace function mark_outreach_sent(
  p_outreach_id uuid,
  p_sent_by text default 'operator',
  p_send_mode text default 'manual',
  p_external_message_id text default null,
  p_sent_at timestamptz default now()
) returns outreach
language plpgsql as $$
declare v_o outreach; v_conv uuid; v_is_first boolean;
begin
  select * into v_o from outreach where id = p_outreach_id for update;
  if not found then raise exception 'mark_outreach_sent: outreach % not found', p_outreach_id; end if;
  if v_o.sent_at is not null then return v_o; end if;   -- idempotent

  insert into conversations (lead_id, campaign_id, channel, state, last_message_at, last_direction, message_count)
  values (v_o.lead_id, v_o.campaign_id, v_o.channel, 'AWAITING_PROSPECT', p_sent_at, 'outbound', 0)
  on conflict (lead_id, channel) do update set updated_at = now()
  returning id into v_conv;

  update outreach
     set status = 'SENT', sent_at = p_sent_at, sent_by = p_sent_by, send_mode = p_send_mode,
         external_message_id = p_external_message_id, conversation_id = v_conv,
         final_message = coalesce(message_edited, message), updated_at = now()
   where id = p_outreach_id
   returning * into v_o;

  insert into conversation_messages (conversation_id, lead_id, outreach_id, direction, body, sent_at, external_message_id)
  values (v_conv, v_o.lead_id, v_o.id, 'outbound', coalesce(v_o.message_edited, v_o.message), p_sent_at, p_external_message_id);

  select first_sent_at is null into v_is_first from leads where id = v_o.lead_id;

  update leads
     set stage        = case when stage in ('READY_FOR_OUTREACH','PENDING_APPROVAL','MESSAGE_GENERATED') then 'DM_SENT' else stage end,
         status       = 'SENT',
         first_sent_at = coalesce(first_sent_at, p_sent_at),
         last_sent_at  = p_sent_at,
         followup_step = greatest(followup_step, v_o.followup_step),
         updated_at    = now()
   where id = v_o.lead_id;

  if v_o.kind = 'initial' and v_is_first then
    perform schedule_followups(v_o.lead_id, p_sent_at);
  else
    update followups set status = 'SENT', sent_at = p_sent_at, outreach_id = v_o.id, updated_at = now()
     where lead_id = v_o.lead_id and step = v_o.followup_step and status <> 'SENT';
    update leads set next_followup_at = (select min(due_at) from followups
                                          where lead_id = v_o.lead_id and status = 'SCHEDULED')
     where id = v_o.lead_id;
  end if;

  perform log_activity(v_o.lead_id, 'message_sent', p_sent_by,
                       jsonb_build_object('outreach_id', v_o.id, 'kind', v_o.kind,
                                          'variation', v_o.variation, 'mode', p_send_mode));
  return v_o;
end $$;

-- ---------------------------------------------------------------------------
-- approve_outreach / reject_outreach: the human approval mechanism
-- ---------------------------------------------------------------------------
create or replace function approve_outreach(
  p_outreach_id uuid,
  p_approved_by text,
  p_edited_message text default null
) returns outreach
language plpgsql as $$
declare v_o outreach;
begin
  update outreach
     set status         = 'APPROVED',
         message_edited = coalesce(p_edited_message, message_edited),
         final_message  = coalesce(p_edited_message, message_edited, message),
         variation      = case when p_edited_message is not null then 'custom' else variation end,
         approved_by    = p_approved_by,
         approved_at    = now(),
         updated_at     = now()
   where id = p_outreach_id and status in ('DRAFT','PENDING_REVIEW')
   returning * into v_o;

  if not found then raise exception 'approve_outreach: % is not awaiting review', p_outreach_id; end if;

  update leads
     set stage  = case when stage in ('MESSAGE_GENERATED','PENDING_APPROVAL') then 'READY_FOR_OUTREACH' else stage end,
         status = 'APPROVED',
         approved_at = coalesce(approved_at, now()),
         updated_at = now()
   where id = v_o.lead_id;

  update followups set status = 'APPROVED', updated_at = now()
   where lead_id = v_o.lead_id and step = v_o.followup_step and status = 'PENDING_REVIEW';

  perform log_activity(v_o.lead_id, 'message_approved', p_approved_by,
    jsonb_build_object('outreach_id', v_o.id, 'edited', p_edited_message is not null, 'kind', v_o.kind));
  return v_o;
end $$;

create or replace function reject_outreach(
  p_outreach_id uuid,
  p_rejected_by text,
  p_reason text default null,
  p_regenerate boolean default true
) returns outreach
language plpgsql as $$
declare v_o outreach;
begin
  update outreach
     set status = 'REJECTED', rejected_reason = p_reason, updated_at = now()
   where id = p_outreach_id
   returning * into v_o;

  if not found then raise exception 'reject_outreach: outreach % not found', p_outreach_id; end if;

  update leads
     set stage  = case when p_regenerate and v_o.kind = 'initial' then 'RESEARCHED' else stage end,
         status = case when p_regenerate then 'NEW' else 'REJECTED' end,
         message_generated_at = case when p_regenerate then null else message_generated_at end,
         updated_at = now()
   where id = v_o.lead_id;

  if not p_regenerate then
    update followups set status = 'CANCELLED', cancelled_reason = 'message_rejected', updated_at = now()
     where lead_id = v_o.lead_id and status in ('SCHEDULED','PENDING_REVIEW');
  end if;

  perform log_activity(v_o.lead_id, 'message_rejected', p_rejected_by,
    jsonb_build_object('outreach_id', v_o.id, 'reason', p_reason, 'regenerate', p_regenerate));
  return v_o;
end $$;

-- ---------------------------------------------------------------------------
-- set_lead_outcome: INTERESTED / NURTURE / NOT_INTERESTED / CLOSED
-- ---------------------------------------------------------------------------
create or replace function set_lead_outcome(
  p_lead_id uuid,
  p_outcome text,
  p_actor text default 'system',
  p_note text default null
) returns leads
language plpgsql as $$
declare v_lead leads;
begin
  if p_outcome not in ('CONVERSATION','INTERESTED','NURTURE','NOT_INTERESTED','CLOSED') then
    raise exception 'set_lead_outcome: invalid outcome %', p_outcome;
  end if;

  update leads
     set stage  = p_outcome,
         status = case p_outcome
                    when 'INTERESTED'     then 'INTERESTED'
                    when 'NURTURE'        then 'NURTURE'
                    when 'NOT_INTERESTED' then 'NOT_INTERESTED'
                    when 'CLOSED'         then 'CLOSED'
                    else status end,
         notes  = case when p_note is null then notes else coalesce(notes || E'\n', '') || p_note end,
         updated_at = now()
   where id = p_lead_id
   returning * into v_lead;

  update conversations
     set state = case p_outcome
                   when 'INTERESTED'     then 'INTERESTED'
                   when 'NURTURE'        then 'NURTURE'
                   when 'NOT_INTERESTED' then 'NOT_INTERESTED'
                   when 'CLOSED'         then 'CLOSED'
                   else state end,
         updated_at = now()
   where lead_id = p_lead_id;

  if p_outcome in ('NOT_INTERESTED','CLOSED') then
    perform cancel_followups(p_lead_id, lower(p_outcome));
  end if;

  perform log_activity(p_lead_id, 'outcome_set', p_actor, jsonb_build_object('outcome', p_outcome, 'note', p_note));
  return v_lead;
end $$;

-- ---------------------------------------------------------------------------
-- opt_out: permanent suppression across every current and future campaign
-- ---------------------------------------------------------------------------
create or replace function opt_out(p_lead_id uuid, p_reason text default 'prospect_request')
returns void
language plpgsql as $$
declare v_company companies;
begin
  select c.* into v_company from companies c join leads l on l.company_id = c.id where l.id = p_lead_id;
  if not found then return; end if;

  update companies set suppressed = true, suppressed_reason = p_reason where id = v_company.id;
  insert into suppressions (key_type, key_value, reason, created_by)
    values ('company_id', v_company.id::text, p_reason, 'system')
    on conflict do nothing;
  if v_company.instagram_handle is not null then
    insert into suppressions (key_type, key_value, reason, created_by)
      values ('instagram_handle', v_company.instagram_handle, p_reason, 'system')
      on conflict do nothing;
  end if;

  perform cancel_followups(p_lead_id, 'opted_out');
  update leads set stage = 'NOT_INTERESTED', status = 'OPTED_OUT', updated_at = now() where id = p_lead_id;
  perform log_activity(p_lead_id, 'opted_out', 'system', jsonb_build_object('reason', p_reason));
end $$;

-- ---------------------------------------------------------------------------
-- daily_report: one JSON object for the report workflow / dashboard
-- ---------------------------------------------------------------------------
create or replace function daily_report(p_day date default current_date, p_campaign_id text default null)
returns jsonb
language plpgsql stable as $$
declare v jsonb;
begin
  select jsonb_build_object(
    'day', p_day,
    'campaign_id', p_campaign_id,
    'leads_discovered',  (select count(*) from leads l where l.discovered_at::date = p_day and (p_campaign_id is null or l.campaign_id = p_campaign_id)),
    'leads_enriched',    (select count(*) from leads l where l.enriched_at::date = p_day   and (p_campaign_id is null or l.campaign_id = p_campaign_id)),
    'leads_evaluated',   (select count(*) from leads l where l.qualified_at::date = p_day  and (p_campaign_id is null or l.campaign_id = p_campaign_id)),
    'leads_qualified',   (select count(*) from leads l where l.qualified_at::date = p_day and l.qualified and (p_campaign_id is null or l.campaign_id = p_campaign_id)),
    'messages_generated',(select count(*) from outreach o where o.created_at::date = p_day  and (p_campaign_id is null or o.campaign_id = p_campaign_id)),
    'messages_approved', (select count(*) from outreach o where o.approved_at::date = p_day and (p_campaign_id is null or o.campaign_id = p_campaign_id)),
    'messages_sent',     (select count(*) from outreach o where o.sent_at::date = p_day     and (p_campaign_id is null or o.campaign_id = p_campaign_id)),
    'replies',           (select count(*) from conversation_messages m join leads l on l.id = m.lead_id
                           where m.direction = 'inbound' and m.sent_at::date = p_day and (p_campaign_id is null or l.campaign_id = p_campaign_id)),
    'positive_replies',  (select count(*) from conversation_messages m join leads l on l.id = m.lead_id
                           where m.direction = 'inbound' and m.sent_at::date = p_day
                             and m.classification in ('interested','curious','positive','wants_details','pricing','question')
                             and (p_campaign_id is null or l.campaign_id = p_campaign_id)),
    'followups_due',     (select count(*) from followups f where f.status = 'SCHEDULED' and f.due_at::date <= p_day and (p_campaign_id is null or f.campaign_id = p_campaign_id)),
    'interested_total',  (select count(*) from leads l where l.stage = 'INTERESTED'     and (p_campaign_id is null or l.campaign_id = p_campaign_id)),
    'nurture_total',     (select count(*) from leads l where l.stage = 'NURTURE'        and (p_campaign_id is null or l.campaign_id = p_campaign_id)),
    'not_interested_total',(select count(*) from leads l where l.stage = 'NOT_INTERESTED' and (p_campaign_id is null or l.campaign_id = p_campaign_id)),
    'errors_open',       (select count(*) from errors e where not e.resolved and e.created_at::date = p_day and (p_campaign_id is null or e.campaign_id = p_campaign_id)),
    'by_niche',          (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from v_performance_by_niche x where (p_campaign_id is null or x.campaign_id = p_campaign_id)),
    'by_state',          (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from v_performance_by_state x where (p_campaign_id is null or x.campaign_id = p_campaign_id)),
    'by_angle',          (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from v_performance_by_angle x where (p_campaign_id is null or x.campaign_id = p_campaign_id)),
    'reply_categories',  (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from v_reply_categories x where (p_campaign_id is null or x.campaign_id = p_campaign_id)),
    'objections',        (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from v_objections x where (p_campaign_id is null or x.campaign_id = p_campaign_id))
  ) into v;
  return v;
end $$;
