// WORKFLOW 8 - Instagram Outreach Release & Logging
// Releases approved messages to the operator at a human pace, and - where the
// account is eligible and the conversation is already open - sends through the
// official API. Cold first-touch DMs are never sent by this workflow: the
// Instagram Messaging API cannot initiate a conversation, and this system does
// not pretend otherwise.
import { workflow, schedule, webhook, respond, code, supabase, rpc, switchNode, noop, http } from '../dsl.mjs';
import { withLib, configConst } from '../bundle.mjs';

export function build() {
  const wf = workflow('wf08-outreach-log', {
    description: 'Release approved messages within the daily cap and log every send.',
    tags: ['optiflow', 'outreach', 'logging']
  });

  const cron = wf.add(schedule('Release Window', '0 9,11,14,16 * * 1-5'));
  const onDemand = wf.add(webhook('Release On Demand', 'optiflow/release', 'POST'), { column: 0, row: 1 });

  const campaign = wf.add(supabase('Load Active Campaigns', {
    method: 'GET', path: 'campaigns', query: '?status=eq.active&select=*'
  }), { column: 1, row: 0 });

  const sentToday = wf.add(supabase('Count Sent Today', {
    method: 'GET',
    path: 'outreach',
    query: '?sent_at=gte.{{ new Date(new Date().setHours(0,0,0,0)).toISOString() }}&select=id,campaign_id,kind',
    notes: 'The daily cap is enforced against what was actually sent, not what was queued.'
  }), { column: 2, row: 0 });

  const queue = wf.add(supabase('Read Send Queue', {
    method: 'GET', path: 'v_send_queue', query: '?select=*&limit=200'
  }), { column: 3, row: 0 });

  const pace = wf.add(code('Apply Daily Caps + Pacing', withLib(['lib/followups.js'], `
${configConst('config/followups.default.json', 'FOLLOWUP_DEFAULTS')}

const campaigns = ($('Load Active Campaigns').first().json || []);
const sent = ($('Count Sent Today').first().json || []);
const queued = ($input.first().json || []);

const byCampaign = new Map();
for (const c of Array.isArray(campaigns) ? campaigns : [campaigns]) byCampaign.set(c.id, c);

const sentCounts = {};
for (const row of Array.isArray(sent) ? sent : []) {
  sentCounts[row.campaign_id] ??= { initial: 0, followup: 0 };
  if (row.kind === 'initial') sentCounts[row.campaign_id].initial += 1;
  else sentCounts[row.campaign_id].followup += 1;
}

const released = [];
const held = [];

for (const campaignId of new Set((Array.isArray(queued) ? queued : []).map((q) => q.campaign_id))) {
  const campaign = byCampaign.get(campaignId) || {};
  const limits = campaign.followups?.rate_limits ?? FOLLOWUP_DEFAULTS.rate_limits;
  const items = queued.filter((q) => q.campaign_id === campaignId);

  const initials = items.filter((i) => i.kind === 'initial');
  const followups = items.filter((i) => i.kind !== 'initial');

  const initialGate = applyDailyLimits(initials, {
    sentToday: sentCounts[campaignId]?.initial ?? 0,
    limit: campaign.outreach?.daily_outreach_target ?? limits.max_new_dms_per_day
  });
  const followupGate = applyDailyLimits(followups, {
    sentToday: sentCounts[campaignId]?.followup ?? 0,
    limit: limits.max_followups_per_day
  });

  const mode = campaign.outreach?.sending_mode ?? 'manual';
  for (const item of [...initialGate.release, ...followupGate.release]) {
    released.push({ ...item, send_mode: mode, min_seconds_between_sends: limits.min_seconds_between_sends ?? 45 });
  }
  held.push(...initialGate.held, ...followupGate.held);
}

if (!released.length) {
  return [{ json: { released: 0, held: held.length, note: 'Daily cap reached or nothing approved.', items: [] } }];
}
return released.map((item) => ({ json: { ...item, released_total: released.length, held_total: held.length } }));
`), { notes: 'Caps come from the campaign, falling back to config/followups.default.json. Overflow is held for the next window, never dropped.' }), { column: 4, row: 0 });

  const modeRoute = wf.add(switchNode('Sending Mode', '={{ $json.send_mode || "manual" }}', [
    { name: 'manual', value: 'manual' },
    { name: 'graph_api', value: 'graph_api' }
  ], { notes: 'manual is the default and the only compliant path for a first-touch DM.' }), { column: 5, row: 0 });

  const prepareManual = wf.add(code('Prepare Operator Work Items', `
// Everything the operator needs in one place: who, the profile link, the exact
// approved text, and the pacing to respect. The send itself is theirs; the
// console calls wf07 /mark-sent afterwards.
return $input.all().map((item) => {
  const row = item.json;
  return { json: {
    outreach_id: row.outreach_id,
    lead_id: row.lead_id,
    lead_ref: row.public_ref,
    business_name: row.business_name,
    instagram_handle: row.instagram_handle,
    profile_url: row.instagram_url || (row.instagram_handle ? 'https://www.instagram.com/' + row.instagram_handle + '/' : null),
    direct_url: row.instagram_handle ? 'https://www.instagram.com/direct/new/?username=' + row.instagram_handle : null,
    target_contact: row.target_contact,
    kind: row.kind,
    message: row.message_to_send,
    approved_by: row.approved_by,
    approved_at: row.approved_at,
    icp_score: row.icp_score,
    priority: row.priority,
    pacing_seconds: row.min_seconds_between_sends,
    instructions: 'Open the profile, paste the message, send it, then press "Mark as sent".'
  } };
});
`), { column: 6, row: 0 });

  const notify = wf.add(http('Notify Operator', {
    method: 'POST',
    url: '={{ $env.OPERATOR_WEBHOOK_URL || "https://example.invalid/noop" }}',
    body: '={{ JSON.stringify({ text: $json.released_total + " approved message(s) ready to send", items: $input.all().map(i => i.json) }) }}',
    continueOnFail: true,
    errorOutput: false,
    notes: 'Optional: Slack/email/anything. Leave OPERATOR_WEBHOOK_URL unset to skip - the console polls the send queue anyway.'
  }), { column: 7, row: 0 });

  const graphSend = wf.add(http('Send Via Instagram Graph API', {
    method: 'POST',
    url: '=https://graph.facebook.com/v21.0/{{ $env.IG_BUSINESS_ACCOUNT_ID }}/messages?access_token={{ $env.IG_PAGE_ACCESS_TOKEN }}',
    body: '={{ JSON.stringify({ recipient: { id: $json.recipient_igsid }, message: { text: $json.message_to_send } }) }}',
    notes: 'Only valid INSIDE an open conversation window - i.e. for replies to someone who messaged first. A first-touch DM has no recipient_igsid and is routed to the manual path instead.'
  }), { column: 6, row: 1 });

  const canSendViaApi = wf.add(switchNode('Conversation Already Open?', '={{ $json.recipient_igsid ? "open" : "cold" }}', [
    { name: 'open', value: 'open' },
    { name: 'cold', value: 'cold' }
  ], { notes: 'Without an open conversation the API cannot deliver a cold DM. The item falls back to a human.' }), { column: 5, row: 1 });

  const logSend = wf.add(rpc('Log Send', 'mark_outreach_sent',
    '={{ JSON.stringify({ p_outreach_id: $json.outreach_id, p_sent_by: "n8n:wf08", p_send_mode: "graph_api", p_external_message_id: $json.message_id ?? null }) }}'),
    { column: 7, row: 1 });

  const respondNow = wf.add(respond('Respond', '={{ { ok: true, released: $input.all().length } }}'), { column: 8, row: 0 });

  wf.connect(cron, campaign);
  wf.connect(onDemand, campaign);
  wf.chain(campaign, sentToday, queue, pace, modeRoute);
  wf.connect([modeRoute, 0], prepareManual);
  wf.connect(prepareManual, notify);
  wf.connect(notify, respondNow);
  wf.connect([modeRoute, 1], canSendViaApi);
  wf.connect([canSendViaApi, 0], graphSend);
  wf.connect([canSendViaApi, 1], prepareManual);
  wf.connect(graphSend, logSend);
  wf.connect([graphSend, 1], prepareManual);
  wf.connect(logSend, respondNow);

  return wf.toJSON();
}
