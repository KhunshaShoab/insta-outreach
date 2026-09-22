-- ===========================================================================
-- Views: pipeline visibility, queues, and analytics.
-- Everything the dashboard and the daily report need is a plain SELECT.
-- ===========================================================================

-- Flat lead view used by the console, the Sheets mirror and reporting.
create or replace view v_leads_full as
select
  l.id                          as lead_id,
  l.public_ref,
  l.campaign_id,
  c.name                        as campaign_name,
  co.id                         as company_id,
  co.name                       as business_name,
  co.instagram_handle,
  co.instagram_url,
  co.website,
  co.website_domain,
  co.niche_id,
  n.name                        as niche_name,
  co.state,
  co.city,
  co.ig_followers,
  co.ig_posts,
  co.products_count,
  co.products_services,
  co.email                      as company_email,
  co.phone                      as company_phone,
  ct.full_name                  as decision_maker,
  ct.title                      as decision_maker_title,
  ct.role_category              as decision_maker_role,
  ct.email                      as decision_maker_email,
  ct.linkedin_url               as decision_maker_linkedin,
  ct.target_reason              as decision_maker_reason,
  l.stage,
  l.status,
  l.icp_score,
  l.icp_band,
  l.priority,
  l.qualified,
  l.disqualified_reason,
  l.recommended_service,
  l.outreach_angle,
  q.reason                      as qualification_reason,
  q.potential_pain_points,
  r.business_summary,
  r.why_optiflow_relevant,
  o.final_message               as latest_message,
  o.variation                   as latest_variation,
  o.status                      as message_status,
  o.sent_at                     as last_message_sent_at,
  l.replied_at,
  l.next_followup_at,
  l.followup_step,
  l.retry_count,
  l.last_error,
  l.discovered_at,
  l.notes,
  l.sheets_synced_at,
  l.updated_at
from leads l
join campaigns c on c.id = l.campaign_id
join companies co on co.id = l.company_id
left join niches n on n.id = co.niche_id
left join contacts ct on ct.id = l.contact_id
left join lateral (
  select * from qualification_results qr
  where qr.lead_id = l.id order by qr.created_at desc limit 1
) q on true
left join lateral (
  select * from research rs
  where rs.lead_id = l.id order by rs.created_at desc limit 1
) r on true
left join lateral (
  select * from outreach ou
  where ou.lead_id = l.id order by ou.created_at desc limit 1
) o on true;

-- The human approval queue.
create or replace view v_approval_queue as
select
  o.id                as outreach_id,
  o.lead_id,
  l.public_ref,
  o.campaign_id,
  o.kind,
  o.followup_step,
  o.variation,
  o.variations,
  o.message,
  o.message_edited,
  o.outreach_angle,
  o.personalisation,
  o.status,
  o.created_at,
  co.name             as business_name,
  co.instagram_handle,
  co.instagram_url,
  co.website,
  co.ig_followers,
  co.city,
  co.state,
  co.niche_id,
  ct.full_name        as target_contact,
  ct.title            as target_role,
  ct.target_reason,
  l.icp_score,
  l.icp_band,
  l.priority,
  r.business_summary,
  r.specific_observations,
  r.why_optiflow_relevant,
  q.potential_pain_points,
  q.reason            as qualification_reason
from outreach o
join leads l      on l.id = o.lead_id
join companies co on co.id = o.company_id
left join contacts ct on ct.id = o.contact_id
left join lateral (select * from research rs where rs.lead_id = l.id order by rs.created_at desc limit 1) r on true
left join lateral (select * from qualification_results qr where qr.lead_id = l.id order by qr.created_at desc limit 1) q on true
where o.status in ('DRAFT','PENDING_REVIEW')
order by
  case l.priority when 'high' then 0 when 'medium' then 1 when 'low' then 2 else 3 end,
  l.icp_score desc nulls last,
  o.created_at;

-- Approved and waiting to be sent (manual sending console reads this).
create or replace view v_send_queue as
select
  o.id as outreach_id, o.lead_id, l.public_ref, o.campaign_id, o.kind, o.followup_step,
  coalesce(o.message_edited, o.message) as message_to_send,
  o.approved_at, o.approved_by, o.scheduled_for,
  co.name as business_name, co.instagram_handle, co.instagram_url,
  ct.full_name as target_contact, l.priority, l.icp_score
from outreach o
join leads l on l.id = o.lead_id
join companies co on co.id = o.company_id
left join contacts ct on ct.id = o.contact_id
where o.status = 'APPROVED' and o.sent_at is null
order by o.approved_at;

-- Follow-ups that are due now (respecting reply-stop).
create or replace view v_followups_due as
select
  f.id as followup_id, f.lead_id, f.campaign_id, f.step, f.kind, f.due_at,
  l.public_ref, l.stage, l.status, l.icp_score,
  co.name as business_name, co.instagram_handle,
  ct.full_name as target_contact
from followups f
join leads l on l.id = f.lead_id
join companies co on co.id = l.company_id
left join contacts ct on ct.id = l.contact_id
where f.status = 'SCHEDULED'
  and f.due_at <= now()
  and l.replied_at is null
  and l.status not in ('REPLIED','INTERESTED','NOT_INTERESTED','NURTURE','CLOSED','OPTED_OUT')
order by f.due_at;

-- Conversations waiting on us.
create or replace view v_conversations_open as
select
  cv.id as conversation_id, cv.lead_id, cv.campaign_id, cv.state, cv.last_message_at,
  cv.last_direction, cv.message_count, cv.summary,
  co.name as business_name, co.instagram_handle,
  l.public_ref, l.icp_score, l.priority,
  m.body as last_inbound_message, m.classification, m.sentiment, m.urgency,
  m.recommended_action,
  sr.id as suggestion_id, sr.suggestion, sr.reason as suggestion_reason,
  sr.next_action, sr.status as suggestion_status
from conversations cv
join leads l on l.id = cv.lead_id
join companies co on co.id = l.company_id
left join lateral (
  select * from conversation_messages cm
  where cm.conversation_id = cv.id and cm.direction = 'inbound'
  order by cm.sent_at desc limit 1
) m on true
left join lateral (
  select * from suggested_responses s
  where s.conversation_id = cv.id
  order by s.created_at desc limit 1
) sr on true
where cv.state not in ('CLOSED','NOT_INTERESTED')
order by
  case m.urgency when 'high' then 0 when 'medium' then 1 else 2 end,
  cv.last_message_at desc nulls last;

-- Per-lead progress checklist ("Lead 182: scraped OK, cleaned OK, ...").
create or replace view v_lead_progress as
select
  l.id as lead_id, l.public_ref, l.campaign_id, l.stage, l.status,
  (l.discovered_at        is not null) as scraped,
  (l.cleaned_at           is not null) as cleaned,
  (l.enriched_at          is not null) as enriched,
  (l.qualified_at         is not null) as qualified,
  (l.researched_at        is not null) as researched,
  (l.message_generated_at is not null) as message_generated,
  (l.approved_at          is not null) as approved,
  (l.first_sent_at        is not null) as sent,
  (l.replied_at           is not null) as replied,
  l.last_completed_step, l.next_step, l.retry_count, l.last_error, l.last_error_at,
  s.position as stage_position
from leads l join lead_stages s on s.stage = l.stage;

-- ---------------------------------------------------------------------------
-- Analytics
-- ---------------------------------------------------------------------------
create or replace view v_campaign_funnel as
select
  l.campaign_id,
  count(*)                                                            as leads_discovered,
  count(*) filter (where l.cleaned_at is not null)                    as leads_cleaned,
  count(*) filter (where l.enriched_at is not null)                   as leads_enriched,
  count(*) filter (where l.qualified_at is not null)                  as leads_evaluated,
  count(*) filter (where l.qualified)                                 as leads_qualified,
  count(*) filter (where l.stage = 'DISQUALIFIED')                    as leads_disqualified,
  count(*) filter (where l.message_generated_at is not null)          as messages_generated,
  count(*) filter (where l.approved_at is not null)                   as messages_approved,
  count(*) filter (where l.first_sent_at is not null)                 as messages_sent,
  count(*) filter (where l.replied_at is not null)                    as replies,
  count(*) filter (where l.stage = 'INTERESTED')                      as interested,
  count(*) filter (where l.stage = 'NURTURE')                         as nurture,
  count(*) filter (where l.stage = 'NOT_INTERESTED')                  as not_interested,
  round(100.0 * count(*) filter (where l.qualified)
        / nullif(count(*) filter (where l.qualified_at is not null),0), 1) as qualification_rate,
  round(100.0 * count(*) filter (where l.replied_at is not null)
        / nullif(count(*) filter (where l.first_sent_at is not null),0), 1) as reply_rate
from leads l
group by l.campaign_id;

-- Reply-rate breakdowns. No "best" is declared here - the caller picks the
-- metric and the ordering. These views only report what was measured.
create or replace view v_performance_by_niche as
select
  co.niche_id,
  l.campaign_id,
  count(*) filter (where l.first_sent_at is not null) as sent,
  count(*) filter (where l.replied_at is not null)    as replies,
  count(*) filter (where l.stage = 'INTERESTED')      as interested,
  round(100.0 * count(*) filter (where l.replied_at is not null)
        / nullif(count(*) filter (where l.first_sent_at is not null),0), 1) as reply_rate,
  round(100.0 * count(*) filter (where l.stage = 'INTERESTED')
        / nullif(count(*) filter (where l.first_sent_at is not null),0), 1) as positive_reply_rate
from leads l join companies co on co.id = l.company_id
group by co.niche_id, l.campaign_id;

create or replace view v_performance_by_state as
select
  co.state,
  l.campaign_id,
  count(*) filter (where l.first_sent_at is not null) as sent,
  count(*) filter (where l.replied_at is not null)    as replies,
  count(*) filter (where l.stage = 'INTERESTED')      as interested,
  round(100.0 * count(*) filter (where l.replied_at is not null)
        / nullif(count(*) filter (where l.first_sent_at is not null),0), 1) as reply_rate
from leads l join companies co on co.id = l.company_id
group by co.state, l.campaign_id;

create or replace view v_performance_by_angle as
select
  o.outreach_angle,
  o.campaign_id,
  o.kind,
  count(*) filter (where o.sent_at is not null)          as sent,
  count(*) filter (where l.replied_at is not null)       as replies,
  round(100.0 * count(*) filter (where l.replied_at is not null)
        / nullif(count(*) filter (where o.sent_at is not null),0), 1) as reply_rate
from outreach o join leads l on l.id = o.lead_id
group by o.outreach_angle, o.campaign_id, o.kind;

create or replace view v_performance_by_variation as
select
  o.variation,
  o.campaign_id,
  count(*) filter (where o.sent_at is not null)    as sent,
  count(*) filter (where l.replied_at is not null) as replies,
  round(100.0 * count(*) filter (where l.replied_at is not null)
        / nullif(count(*) filter (where o.sent_at is not null),0), 1) as reply_rate
from outreach o join leads l on l.id = o.lead_id
group by o.variation, o.campaign_id;

create or replace view v_reply_categories as
select
  cm.classification,
  l.campaign_id,
  co.niche_id,
  count(*) as count
from conversation_messages cm
join leads l on l.id = cm.lead_id
join companies co on co.id = l.company_id
where cm.direction = 'inbound' and cm.classification is not null
group by cm.classification, l.campaign_id, co.niche_id;

create or replace view v_objections as
select
  cm.objection_type,
  l.campaign_id,
  co.niche_id,
  count(*) as count,
  max(cm.sent_at) as last_seen
from conversation_messages cm
join leads l on l.id = cm.lead_id
join companies co on co.id = l.company_id
where cm.direction = 'inbound' and cm.objection_type is not null
group by cm.objection_type, l.campaign_id, co.niche_id;

-- Daily activity counters, used by the daily report workflow.
create or replace view v_daily_activity as
select
  (l.discovered_at at time zone 'UTC')::date as day,
  l.campaign_id,
  count(*) as leads_discovered
from leads l group by 1, 2;

create or replace view v_daily_report as
with d as (select current_date as day)
select
  d.day,
  c.id   as campaign_id,
  c.name as campaign_name,
  (select count(*) from leads l where l.campaign_id = c.id and l.discovered_at::date = d.day)                       as leads_discovered,
  (select count(*) from leads l where l.campaign_id = c.id and l.enriched_at::date = d.day)                         as leads_enriched,
  (select count(*) from leads l where l.campaign_id = c.id and l.qualified_at::date = d.day)                        as leads_evaluated,
  (select count(*) from leads l where l.campaign_id = c.id and l.qualified_at::date = d.day and l.qualified)        as leads_qualified,
  (select count(*) from outreach o where o.campaign_id = c.id and o.created_at::date = d.day)                       as messages_generated,
  (select count(*) from outreach o where o.campaign_id = c.id and o.approved_at::date = d.day)                      as messages_approved,
  (select count(*) from outreach o where o.campaign_id = c.id and o.sent_at::date = d.day)                          as messages_sent,
  (select count(*) from conversation_messages m join leads l on l.id = m.lead_id
     where l.campaign_id = c.id and m.direction = 'inbound' and m.sent_at::date = d.day)                            as replies,
  (select count(*) from conversation_messages m join leads l on l.id = m.lead_id
     where l.campaign_id = c.id and m.direction = 'inbound' and m.sent_at::date = d.day
       and m.classification in ('interested','curious','positive','wants_details','pricing','question'))            as positive_replies,
  (select count(*) from followups f where f.campaign_id = c.id and f.status = 'SCHEDULED' and f.due_at::date <= d.day) as followups_due,
  (select count(*) from leads l where l.campaign_id = c.id and l.stage = 'INTERESTED')                              as interested_total,
  (select count(*) from leads l where l.campaign_id = c.id and l.stage = 'NURTURE')                                 as nurture_total,
  (select count(*) from leads l where l.campaign_id = c.id and l.stage = 'NOT_INTERESTED')                          as not_interested_total,
  (select count(*) from errors e where e.campaign_id = c.id and e.created_at::date = d.day and not e.resolved)      as errors_open
from campaigns c cross join d
where c.status = 'active';

-- Sheets mirror: exactly the columns in docs/02 section "Google Sheets".
create or replace view v_sheets_export as
select
  v.public_ref                      as "Lead ID",
  v.business_name                   as "Business Name",
  v.instagram_handle                as "Instagram",
  v.website                         as "Website",
  v.niche_name                      as "Niche",
  v.state                           as "State",
  v.city                            as "City",
  v.ig_followers                    as "Followers",
  v.products_count                  as "Products/Services",
  v.decision_maker                  as "Founder / Decision Maker",
  v.decision_maker_title            as "Decision Maker Role",
  coalesce(v.decision_maker_email, v.company_email) as "Email",
  v.company_phone                   as "Phone",
  v.icp_score                       as "ICP Score",
  v.icp_band                        as "Qualification",
  (v.potential_pain_points #>> '{0}') as "Pain Point",
  v.recommended_service             as "Recommended Service",
  v.outreach_angle                  as "Outreach Angle",
  v.latest_message                  as "Generated Message",
  v.message_status                  as "Message Status",
  v.status                          as "Response Status",
  v.next_followup_at                as "Follow-up Date",
  v.notes                           as "Notes",
  v.campaign_id                     as "Campaign",
  v.lead_id                         as "_lead_uuid"
from v_leads_full v
where v.qualified is true;
