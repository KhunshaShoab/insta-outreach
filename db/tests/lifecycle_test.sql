-- ===========================================================================
-- End-to-end lifecycle test. Run against a scratch database:
--   psql -f db/migrations/0001_schema.sql ... then
--   psql -v ON_ERROR_STOP=1 -f db/tests/lifecycle_test.sql
-- Every assertion raises an exception on failure, so a clean exit == pass.
-- ===========================================================================
\set ON_ERROR_STOP on

create or replace function assert_eq(p_actual anyelement, p_expected anyelement, p_label text)
returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL %: expected %, got %', p_label, p_expected, p_actual;
  end if;
  raise notice 'pass: %', p_label;
end $$;

do $$
declare
  v_company companies;
  v_company2 companies;
  v_lead leads;
  v_lead2 leads;
  v_contact uuid;
  v_outreach outreach;
  v_conv uuid;
  v_msg uuid;
  v_n int;
begin
  -- fixtures ---------------------------------------------------------------
  insert into niches (id, name, tier, business_model) values ('medspas','Medspas','primary','local_service')
    on conflict (id) do nothing;
  insert into campaigns (id, name, status, niche_id, followups)
    values ('ca-medspas','California Medspa Outreach','active','medspas','{"enabled":true,"day_offsets":[2,5,9]}'::jsonb)
    on conflict (id) do nothing;

  -- 1. dedupe: same business discovered three different ways ---------------
  v_company := resolve_company('Glow Med Spa LLC','glow med spa','GlowMedSpa','glowmedspa.com','+13105551234',
                               null,'Los Angeles','CA','place-1',
                               '{"instagram_url":"https://instagram.com/glowmedspa","ig_followers":4200,"products_count":6,"niche_id":"medspas"}'::jsonb);
  -- rediscovered by Instagram handle only (different casing, @ prefix stripped upstream)
  v_company2 := resolve_company('Glow Medspa','glow medspa','glowmedspa',null,null,null,null,null,null,'{}'::jsonb);
  perform assert_eq(v_company2.id, v_company.id, 'dedupe by instagram handle');
  -- rediscovered by website only
  v_company2 := resolve_company('Glow','glow',null,'glowmedspa.com',null,null,null,null,null,'{}'::jsonb);
  perform assert_eq(v_company2.id, v_company.id, 'dedupe by website domain');
  -- rediscovered by phone only
  v_company2 := resolve_company('Glow Spa','glow spa',null,null,'+13105551234',null,null,null,null,'{}'::jsonb);
  perform assert_eq(v_company2.id, v_company.id, 'dedupe by phone');
  perform assert_eq((select count(*)::int from companies), 1, 'only one company row created');

  -- 2. lead creation is idempotent per campaign ----------------------------
  v_lead  := upsert_lead('ca-medspas', v_company.id, 'google_maps', 'los angeles medspa');
  v_lead2 := upsert_lead('ca-medspas', v_company.id, 'instagram_search', 'medspa la');
  perform assert_eq(v_lead2.id, v_lead.id, 'lead is not duplicated inside a campaign');
  perform assert_eq((select count(*)::int from leads), 1, 'one lead row');

  -- 3. claiming: a claimed lead is not handed out twice --------------------
  perform claim_leads('ca-medspas','SCRAPED',10,'worker-a');
  perform assert_eq((select count(*)::int from claim_leads('ca-medspas','SCRAPED',10,'worker-b')), 0,
                    'claimed lead is not re-claimed');
  perform assert_eq((select status from leads where id = v_lead.id), 'PROCESSING', 'claim sets PROCESSING');

  -- 4. advance through the pipeline ----------------------------------------
  perform advance_lead(v_lead.id, 'CLEANED', 'NEW', 'clean.normalize');
  perform advance_lead(v_lead.id, 'ENRICHED', 'NEW', 'enrich.apollo');
  perform assert_eq((select cleaned_at is not null from leads where id = v_lead.id), true, 'cleaned_at stamped');
  perform assert_eq((select enriched_at is not null from leads where id = v_lead.id), true, 'enriched_at stamped');
  -- advancing backwards never rewinds the stage
  perform advance_lead(v_lead.id, 'SCRAPED', 'NEW', 'noop');
  perform assert_eq((select stage from leads where id = v_lead.id), 'ENRICHED', 'stage never rewinds');

  -- 5. contact + qualification ---------------------------------------------
  insert into contacts (company_id, full_name, first_name, title, role_category, is_primary_target, target_reason)
    values (v_company.id, 'Sarah Mitchell', 'Sarah', 'Founder', 'founder', true,
            'Small clinic where the founder appears to run operations directly')
    returning id into v_contact;
  update leads set contact_id = v_contact where id = v_lead.id;

  insert into qualification_results (lead_id, campaign_id, qualified, icp_score, icp_band, priority,
                                     reason, recommended_service, recommended_angle, decision_maker_found)
    values (v_lead.id, 'ca-medspas', true, 86, 'HIGH_PRIORITY', 'high',
            'Followers and treatment menu inside ICP; founder-led; visible DM-for-pricing CTA',
            'Lead response / speed-to-lead support', 'speed_to_lead', true);
  update leads set icp_score = 86, icp_band = 'HIGH_PRIORITY', priority = 'high', qualified = true,
                   recommended_service = 'Lead response / speed-to-lead support', outreach_angle = 'speed_to_lead'
    where id = v_lead.id;
  perform advance_lead(v_lead.id, 'QUALIFIED', 'NEW', 'ai.qualify');
  perform advance_lead(v_lead.id, 'RESEARCHED', 'NEW', 'ai.research');

  -- 6. message generation + approval ---------------------------------------
  insert into outreach (lead_id, campaign_id, company_id, contact_id, kind, variation, message,
                        char_count, outreach_angle, status)
    values (v_lead.id, 'ca-medspas', v_company.id, v_contact, 'initial', 'conversational',
            'Hi Sarah - saw the lip filler before/afters on your page and the "DM us for pricing" CTA. Curious how you handle those pricing DMs when the rooms are full?',
            156, 'speed_to_lead', 'PENDING_REVIEW')
    returning * into v_outreach;
  perform advance_lead(v_lead.id, 'MESSAGE_GENERATED', 'PENDING_REVIEW', 'outreach.generate');

  perform assert_eq((select count(*)::int from v_approval_queue where lead_id = v_lead.id), 1,
                    'message appears in the approval queue');

  v_outreach := approve_outreach(v_outreach.id, 'user:ops@optiflow.test',
                                 'Hi Sarah - saw the before/afters and the "DM us for pricing" CTA. How do you handle those pricing DMs when the rooms are full?');
  perform assert_eq(v_outreach.status, 'APPROVED', 'approval sets APPROVED');
  perform assert_eq((select stage from leads where id = v_lead.id), 'READY_FOR_OUTREACH', 'approval releases the lead');
  perform assert_eq((select variation from outreach where id = v_outreach.id), 'custom', 'edited message marked custom');

  -- 7. send -> conversation opened, follow-ups scheduled --------------------
  v_outreach := mark_outreach_sent(v_outreach.id, 'user:ops@optiflow.test', 'manual', null, now() - interval '3 days');
  perform assert_eq((select stage from leads where id = v_lead.id), 'DM_SENT', 'send advances to DM_SENT');
  perform assert_eq((select count(*)::int from followups where lead_id = v_lead.id and status = 'SCHEDULED'), 3,
                    'three follow-ups scheduled');
  perform assert_eq((select count(*)::int from conversation_messages where lead_id = v_lead.id and direction = 'outbound'), 1,
                    'outbound message logged in the conversation');
  -- idempotent: marking sent twice does not double-schedule
  perform mark_outreach_sent(v_outreach.id, 'user:ops@optiflow.test', 'manual');
  perform assert_eq((select count(*)::int from followups where lead_id = v_lead.id), 3, 'send is idempotent');

  -- follow-up #1 (day 2) is due by now (sent 3 days ago)
  perform assert_eq((select count(*)::int from v_followups_due where lead_id = v_lead.id), 1, 'follow-up #1 is due');

  -- 8. reply stops the entire sequence -------------------------------------
  select id into v_conv from conversations where lead_id = v_lead.id;
  insert into conversation_messages (conversation_id, lead_id, direction, body, sent_at, classification,
                                     intent, sentiment, urgency, recommended_action)
    values (v_conv, v_lead.id, 'inbound', 'Interesting. How exactly would you guys help us?', now(),
            'interested', 'wants to understand the offer', 'positive', 'high', 'continue_conversation')
    returning id into v_msg;

  perform assert_eq((select count(*)::int from followups where lead_id = v_lead.id and status = 'SCHEDULED'), 0,
                    'reply cancels every scheduled follow-up');
  perform assert_eq((select count(*)::int from followups where lead_id = v_lead.id and status = 'CANCELLED'), 3,
                    'cancelled follow-ups are kept for audit');
  perform assert_eq((select stage from leads where id = v_lead.id), 'REPLIED', 'reply moves the lead to REPLIED');
  perform assert_eq((select replied_at is not null from leads where id = v_lead.id), true, 'replied_at stamped');
  perform assert_eq((select next_followup_at from leads where id = v_lead.id), null::timestamptz, 'next_followup_at cleared');
  perform assert_eq((select count(*)::int from v_followups_due where lead_id = v_lead.id), 0, 'nothing due after a reply');

  -- 9. suggested response + outcome ----------------------------------------
  insert into suggested_responses (conversation_id, lead_id, in_reply_to, suggestion, reason, next_action)
    values (v_conv, v_lead.id, v_msg,
            'Happy to explain - in short we run the pricing and booking DMs for clinics like yours...',
            'Prospect asked a direct how-it-works question; answer concretely and keep it short',
            'continue_conversation');
  perform assert_eq((select count(*)::int from v_conversations_open where lead_id = v_lead.id), 1,
                    'conversation shows up in the open-conversation queue');

  perform set_lead_outcome(v_lead.id, 'INTERESTED', 'user:ops@optiflow.test', 'Asked for a breakdown');
  perform assert_eq((select stage from leads where id = v_lead.id), 'INTERESTED', 'outcome set to INTERESTED');

  -- 10. opt-out suppresses the business everywhere -------------------------
  perform opt_out(v_lead.id, 'prospect_request');
  perform assert_eq(is_suppressed(v_company.id), true, 'opt-out suppresses the company');
  perform assert_eq((select status from leads where id = v_lead.id), 'OPTED_OUT', 'lead marked OPTED_OUT');

  -- 11. failure handling ---------------------------------------------------
  perform fail_lead(v_lead.id, 'wf03-enrichment', 'rate_limit', 'Apollo 429', 'Apollo HTTP', 'apollo', 429);
  perform assert_eq((select retry_count from leads where id = v_lead.id), 1, 'retry_count incremented');
  perform assert_eq((select count(*)::int from errors where lead_id = v_lead.id and not resolved), 1,
                    'error queued for retry');
  perform assert_eq((select next_retry_at > now() from errors where lead_id = v_lead.id limit 1), true,
                    'retry is backed off into the future');

  -- 12. reporting ----------------------------------------------------------
  perform assert_eq(((daily_report(current_date, 'ca-medspas'))->>'messages_sent')::int >= 0, true, 'daily_report returns JSON');
  perform assert_eq((select count(*)::int from v_lead_progress where lead_id = v_lead.id and scraped and cleaned and enriched), 1,
                    'progress view reflects completed steps');
  perform assert_eq((select leads_qualified::int from v_campaign_funnel where campaign_id = 'ca-medspas'), 1,
                    'funnel counts the qualified lead');

  raise notice 'ALL LIFECYCLE ASSERTIONS PASSED';
end $$;
