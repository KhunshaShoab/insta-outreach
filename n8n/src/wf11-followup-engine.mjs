// WORKFLOW 11 - Follow-up Engine
// Due follow-ups -> drafted -> approval queue. The guard runs twice on purpose:
// the view already excludes replied leads, and the code checks again before a
// single token is spent. A prospect who answered never receives a follow-up.
import { workflow, schedule, code, supabase, anthropic, rpc, switchNode, ifNode, noop } from '../dsl.mjs';
import { withLib, promptConst, schemaConst, configConst } from '../bundle.mjs';
import { classifyFailure, failLead } from './_shared.mjs';

export function build() {
  const wf = workflow('wf11-followup-engine', {
    description: 'Generate due follow-ups, stop the sequence on any reply, and close the loop after the final touch.',
    tags: ['optiflow', 'followups']
  });

  const cron = wf.add(schedule('Twice Daily', '0 9,14 * * 1-5'));

  const due = wf.add(supabase('Read Follow-ups Due', {
    method: 'GET',
    path: 'v_followups_due',
    query: '?select=*&limit=100',
    notes: 'The view already excludes leads with replied_at set or a terminal status. This is the first of two guards.'
  }), { column: 1, row: 0 });

  const guard = wf.add(code('Reply Guard', withLib(['lib/followups.js'], `
// Second guard, in code, against a stale read: re-check the lead's own state
// before anything is generated. Cheap, and the cost of being wrong is messaging
// someone who already answered.
const out = [];
for (const item of $input.all()) {
  const rows = Array.isArray(item.json) ? item.json : [item.json];
  for (const row of rows) {
    if (!row || !row.followup_id) continue;
    const verdict = shouldStopSequence({
      replied_at: row.replied_at ?? null,
      status: row.status,
      stage: row.stage,
      suppressed: row.suppressed ?? false
    });
    out.push({ json: { ...row, stop: verdict.stop, stop_reason: verdict.reason } });
  }
}
return out;
`)), { column: 2, row: 0 });

  const route = wf.add(switchNode('Still Waiting?', '={{ $json.stop ? "stop" : "send" }}', [
    { name: 'send', value: 'send' },
    { name: 'stop', value: 'stop' }
  ]), { column: 3, row: 0 });

  const cancel = wf.add(rpc('Cancel Sequence', 'cancel_followups',
    '={{ JSON.stringify({ p_lead_id: $json.lead_id, p_reason: $json.stop_reason || "reply_received" }) }}'),
    { column: 4, row: 2 });

  const claimStep = wf.add(supabase('Claim Follow-up Step', {
    method: 'PATCH',
    path: 'followups',
    query: '?id=eq.{{ $json.followup_id }}&status=eq.SCHEDULED',
    body: '={{ JSON.stringify({ status: "GENERATING", generated_at: new Date().toISOString() }) }}',
    notes: 'The status filter makes this a claim: a parallel run PATCHing the same row gets zero rows back and skips it.'
  }), { column: 4, row: 0 });

  const context = wf.add(supabase('Load Thread + Research', {
    method: 'GET',
    path: 'outreach',
    query: '?lead_id=eq.{{ $(\'Reply Guard\').item.json.lead_id }}&select=kind,variation,message,final_message,sent_at,outreach_angle,personalisation&order=created_at.asc'
  }), { column: 5, row: 0 });

  const brief = wf.add(supabase('Load Research Brief', {
    method: 'GET',
    path: 'research',
    query: '?lead_id=eq.{{ $(\'Reply Guard\').item.json.lead_id }}&select=*&order=created_at.desc&limit=1',
    continueOnFail: true
  }), { column: 6, row: 0 });

  const buildPrompt = wf.add(code('Render Follow-up Prompt', withLib(['lib/prompts.js', 'lib/followups.js'], `
${promptConst('06-followup-message.md', 'PROMPT')}
${configConst('config/followups.default.json', 'FOLLOWUP_DEFAULTS')}

const row = $('Reply Guard').first().json;
const history = $('Load Thread + Research').all().map((i) => i.json).flat().filter(Boolean);
const briefRaw = $input.first().json;
const research = (Array.isArray(briefRaw) ? briefRaw[0] : briefRaw) || {};
const step = stepConfig(row.kind, FOLLOWUP_DEFAULTS) || { kind: row.kind, label: row.kind, intent: 'Continue the conversation with something new.', max_chars: 400 };

const lastSent = history.filter((m) => m.sent_at).sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))[0];
const daysSinceLast = lastSent ? Math.max(0, Math.round((Date.now() - new Date(lastSent.sent_at)) / 86400000)) : null;

const rendered = renderPrompt(PROMPT, {
  lead: { business_name: row.business_name, instagram_handle: row.instagram_handle },
  decision_maker: { address_as: row.target_contact ? String(row.target_contact).split(' ')[0] : null },
  niche: { name: research.business_model ?? 'their niche' },
  history: {
    messages: history.map((m) => ({ kind: m.kind, sent_at: m.sent_at, message: m.final_message || m.message })),
    personalisation_used: (history[0]?.personalisation ?? []).join('; ') || null
  },
  angle: { label: history[0]?.outreach_angle ?? research.recommended_angle ?? 'general', id: history[0]?.outreach_angle ?? 'general' },
  research: {
    business_summary: research.business_summary ?? 'No research brief available.',
    specific_observations: research.specific_observations ?? [],
    operational_pain_points: research.operational_pain_points ?? [],
    recommended_service: research.recommended_service ?? 'customer support'
  },
  step: {
    kind: step.kind,
    label: step.label,
    intent: step.intent,
    max_chars: step.max_chars ?? 400,
    final: Boolean(step.final),
    days_since_last: daysSinceLast ?? 'unknown'
  }
});

return [{ json: {
  followup_id: row.followup_id,
  lead_id: row.lead_id,
  campaign_id: row.campaign_id,
  step: row.step,
  kind: row.kind,
  max_chars: step.max_chars ?? 400,
  is_final: Boolean(step.final),
  prompt: rendered.prompt,
  model: $env.ANTHROPIC_MODEL_HEAVY || 'claude-opus-5',
  max_tokens: rendered.max_tokens,
  temperature: rendered.temperature,
  prompt_version: rendered.version
} }];
`), { notes: 'Each step has its own intent and length limit, from config/followups.default.json. The prompt receives the real thread, including any human edit, because that is what the prospect actually read.' }), { column: 7, row: 0 });

  const claude = wf.add(anthropic('Claude: Write Follow-up'), { column: 8, row: 0 });

  const parse = wf.add(code('Parse + Check Follow-up', withLib(['lib/json.js'], `
${schemaConst('followup-message.schema.json', 'FOLLOWUP_SCHEMA')}

const LAZY = ['just following up', 'following up on', 'circling back', 'bumping this', 'in case you missed', 'did you see my'];
const context = $('Render Follow-up Prompt').first().json;
const text = ($input.first().json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\\n');
const parsed = parseAiJson(text, FOLLOWUP_SCHEMA, { label: 'follow-up' });

if (!parsed.ok) {
  return [{ json: { ...context, ok: false, errors: parsed.errors } }];
}

const message = String(parsed.data.message).trim();
const lower = message.toLowerCase();
const issues = [
  ...(LAZY.filter((p) => lower.includes(p)).map((p) => 'lazy_phrase:' + p)),
  ...(message.length > context.max_chars ? ['over_max_chars'] : []),
  ...(/[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}]/u.test(message) ? ['emoji_in_followup'] : [])
];

return [{ json: {
  ...context,
  ok: true,
  message,
  char_count: message.length,
  reason: parsed.data.reason_for_this_followup,
  references: parsed.data.references ?? [],
  review_flags: issues,
  raw_response: text
} }];
`), { notes: 'A follow-up that reduces to "just following up" is flagged before a human ever sees it.' }), { column: 9, row: 0 });

  const queueDraft = wf.add(supabase('Queue Follow-up For Approval', {
    method: 'POST',
    path: 'outreach',
    body: `={{ JSON.stringify({
      lead_id: $json.lead_id,
      campaign_id: $json.campaign_id,
      company_id: $('Reply Guard').item.json.company_id ?? null,
      kind: $json.kind,
      followup_step: $json.step,
      channel: 'instagram_dm',
      variation: 'conversational',
      message: $json.message,
      char_count: $json.char_count,
      outreach_angle: $('Reply Guard').item.json.outreach_angle ?? null,
      personalisation: $json.references,
      status: 'PENDING_REVIEW',
      model: $json.model,
      prompt_version: $json.prompt_version,
      notes: ($json.review_flags || []).length ? 'Review flags: ' + $json.review_flags.join(', ') : $json.reason
    }) }}`,
    notes: 'Follow-ups go through the same human approval queue as first messages - campaign setting followups.require_human_approval.'
  }), { column: 10, row: 0 });

  const linkFollowup = wf.add(supabase('Link Draft To Step', {
    method: 'PATCH',
    path: 'followups',
    query: '?id=eq.{{ $(\'Parse + Check Follow-up\').item.json.followup_id }}',
    body: '={{ JSON.stringify({ status: "PENDING_REVIEW", outreach_id: ($json[0] ?? $json).id }) }}'
  }), { column: 11, row: 0 });

  const finalCheck = wf.add(ifNode('Was That The Final Touch?', {
    left: '={{ Boolean($(\'Parse + Check Follow-up\').item.json.is_final) }}',
    operator: { type: 'boolean', operation: 'true', singleValue: true }
  }), { column: 12, row: 0 });

  const toNurture = wf.add(rpc('Move To Nurture', 'set_lead_outcome',
    '={{ JSON.stringify({ p_lead_id: $(\'Parse + Check Follow-up\').item.json.lead_id, p_outcome: "NURTURE", p_actor: "n8n:wf11", p_note: "Sequence completed without a reply" }) }}',
    { notes: 'After the final touch the lead moves to NURTURE for a later recheck - it is not deleted and not messaged again by this sequence.' }),
    { column: 13, row: 0 });

  const done = wf.add(noop('Done'), { column: 13, row: 1 });

  wf.chain(cron, due, guard, route);
  wf.connect([route, 0], claimStep);
  wf.connect([route, 1], cancel);
  wf.chain(claimStep, context, brief, buildPrompt, claude, parse, queueDraft, linkFollowup, finalCheck);
  wf.connect([finalCheck, 0], toNurture);
  wf.connect([finalCheck, 1], done);

  const classify = wf.add(classifyFailure('wf11-followup-engine'), { column: 8, row: 3 });
  const fail = wf.add(failLead('wf11-followup-engine', 'Claude: Write Follow-up'), { column: 9, row: 3 });
  wf.connect([claude, 1], classify);
  wf.connect(classify, fail);

  return wf.toJSON();
}
