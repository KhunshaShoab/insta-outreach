// WORKFLOW 10 - AI Response Assistant
// A reply has been classified; this drafts what to say back. The draft goes to
// the operator with Use / Edit / Regenerate / Ignore. Nothing is ever sent from
// here - pricing, objections and anything sensitive are explicitly flagged for
// a person.
import { workflow, schedule, subWorkflowTrigger, code, supabase, anthropic, ifNode, http, noop } from '../dsl.mjs';
import { withLib, promptConst, schemaConst } from '../bundle.mjs';
import { classifyFailure, failLead } from './_shared.mjs';

export function build() {
  const wf = workflow('wf10-response-assistant', {
    description: 'Draft a suggested reply for every inbound message, for a human to use or edit.',
    tags: ['optiflow', 'ai', 'conversations']
  });

  const called = wf.add(subWorkflowTrigger('Called After Classification'));
  const sweep = wf.add(schedule('Sweep Open Conversations', '0 */2 * * *'), { column: 0, row: 1 });

  const openConversations = wf.add(supabase('Find Conversations Awaiting Us', {
    method: 'GET',
    path: 'v_conversations_open',
    query: '?select=*&state=eq.AWAITING_US&suggestion_status=is.null&limit=25',
    notes: 'Catches anything the event path missed - a webhook retry, a restart mid-run.'
  }), { column: 1, row: 1 });

  const loadContext = wf.add(supabase('Load Conversation Context', {
    method: 'GET',
    path: 'v_conversations_open',
    query: '?lead_id=eq.{{ $json.lead_id }}&select=*&limit=1'
  }), { column: 1, row: 0 });

  const history = wf.add(supabase('Load Full Thread', {
    method: 'GET',
    path: 'conversation_messages',
    query: '?conversation_id=eq.{{ ($json[0] ?? $json).conversation_id }}&select=direction,body,sent_at,classification&order=sent_at.asc&limit=50'
  }), { column: 2, row: 0 });

  const research = wf.add(supabase('Load Research Brief', {
    method: 'GET',
    path: 'research',
    query: '?lead_id=eq.{{ $(\'Load Conversation Context\').item.json[0]?.lead_id }}&select=*&order=created_at.desc&limit=1',
    continueOnFail: true
  }), { column: 3, row: 0 });

  const buildPrompt = wf.add(code('Render Response Prompt', withLib(['lib/prompts.js'], `
${promptConst('08-suggested-response.md', 'PROMPT')}

// Only facts OptiFlow can actually stand behind reach the model. Anything not
// in here, the prompt is told to write around rather than invent.
const COMPANY_FACTS = {
  company: 'OptiFlow Solutions',
  what_we_do: 'BPO and customer-experience outsourcing: customer support, email, live chat, phone, e-commerce support, order management, social media support, back-office, lead generation, outbound calling and CX automation.',
  engagement_shapes: ['dedicated agents', 'shared coverage', 'after-hours and weekend coverage', '24/7 coverage'],
  pricing_policy: 'Pricing depends on volume, hours of coverage and the channels involved. No figure is quoted without a person approving it.',
  claims_policy: 'No client names, metrics, guarantees or turnaround promises unless they appear in this object.',
  reference_clients: [],
  published_metrics: []
};

const context = $('Load Conversation Context').first().json;
const row = Array.isArray(context) ? context[0] : context;
const thread = $('Load Full Thread').all().map((i) => i.json).flat();
const briefRaw = $input.first().json;
const brief = (Array.isArray(briefRaw) ? briefRaw[0] : briefRaw) || {};
const latest = [...thread].reverse().find((m) => m.direction === 'inbound') || { body: row?.last_inbound_message ?? '' };

const rendered = renderPrompt(PROMPT, {
  lead: { business_name: row?.business_name ?? 'this business', instagram_handle: row?.instagram_handle ?? 'unknown', icp_score: row?.icp_score },
  niche: { name: brief.business_model ?? 'unknown', business_model: brief.business_model ?? 'unknown' },
  decision_maker: { address_as: null },
  research: {
    business_summary: brief.business_summary ?? 'No research brief available.',
    operational_pain_points: brief.operational_pain_points ?? [],
    recommended_service: brief.recommended_service ?? 'customer support',
    why_optiflow_relevant: brief.why_optiflow_relevant ?? 'Not recorded.'
  },
  angle: { label: brief.recommended_angle ?? 'general' },
  conversation: { messages: thread },
  message: { body: latest.body },
  classification: {
    classification: row?.classification ?? 'unclear',
    intent: row?.intent ?? 'unknown',
    sentiment: row?.sentiment ?? 'neutral',
    urgency: row?.urgency ?? 'medium',
    objection_type: row?.objection_type,
    recommended_action: row?.recommended_action ?? 'continue_conversation'
  },
  company_facts: COMPANY_FACTS
});

return [{ json: {
  lead_id: row?.lead_id,
  conversation_id: row?.conversation_id,
  in_reply_to: latest.id ?? null,
  classification: row?.classification ?? 'unclear',
  prompt: rendered.prompt,
  model: $env.ANTHROPIC_MODEL_HEAVY || 'claude-opus-5',
  max_tokens: rendered.max_tokens,
  temperature: rendered.temperature,
  prompt_version: rendered.version
} }];
`), { notes: 'company_facts is the only source of claims. Empty arrays there mean the model has no client names or metrics to quote, and the prompt tells it to write around the gap and flag it.' }), { column: 4, row: 0 });

  const claude = wf.add(anthropic('Claude: Draft Reply'), { column: 5, row: 0 });

  const parse = wf.add(code('Parse Suggestion', withLib(['lib/json.js'], `
${schemaConst('suggested-response.schema.json', 'RESPONSE_SCHEMA')}

const context = $('Render Response Prompt').first().json;
const text = ($input.first().json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\\n');
const parsed = parseAiJson(text, RESPONSE_SCHEMA, { label: 'suggested response' });

if (!parsed.ok) {
  return [{ json: { ...context, ok: false, errors: parsed.errors, suggestion: null, requires_human_review: true } }];
}

const data = parsed.data;
// Sensitive categories always go to a person regardless of what the model said.
const alwaysHuman = ['pricing', 'objection', 'opt_out', 'wrong_person', 'not_interested'];
const requiresHuman = data.requires_human_review || alwaysHuman.includes(context.classification);

return [{ json: {
  ...context,
  ok: true,
  suggestion: data.suggested_response,
  reason: data.reason,
  next_action: data.next_action,
  alternatives: data.alternatives ?? [],
  requires_human_review: requiresHuman,
  flags: data.flags ?? [],
  raw_response: text
} }];
`)), { column: 6, row: 0 });

  const store = wf.add(supabase('Store Suggested Response', {
    method: 'POST',
    path: 'suggested_responses',
    body: `={{ JSON.stringify({
      conversation_id: $json.conversation_id,
      lead_id: $json.lead_id,
      in_reply_to: $json.in_reply_to,
      suggestion: $json.suggestion || 'Could not draft a reply automatically - please write this one.',
      reason: $json.reason || ($json.errors || []).join('; '),
      next_action: $json.next_action || 'route_to_human',
      alternatives: $json.alternatives || [],
      status: 'PENDING_REVIEW',
      model: $json.model,
      prompt_version: $json.prompt_version,
      raw_response: { text: $json.raw_response ?? null, flags: $json.flags ?? [] }
    }) }}`,
    notes: 'Status PENDING_REVIEW. The console offers Use / Edit / Regenerate / Ignore; sending is a separate, human act.'
  }), { column: 7, row: 0 });

  const needsHuman = wf.add(ifNode('Needs A Person Now?', {
    left: '={{ Boolean($(\'Parse Suggestion\').item.json.requires_human_review) }}',
    operator: { type: 'boolean', operation: 'true', singleValue: true }
  }), { column: 8, row: 0 });

  const notify = wf.add(http('Alert Operator', {
    method: 'POST',
    url: '={{ $env.OPERATOR_WEBHOOK_URL || "https://example.invalid/noop" }}',
    body: '={{ JSON.stringify({ text: "Reply needs a person: " + ($(\'Parse Suggestion\').item.json.classification || "unknown"), lead_id: $(\'Parse Suggestion\').item.json.lead_id }) }}',
    continueOnFail: true,
    errorOutput: false
  }), { column: 9, row: 0 });

  const done = wf.add(noop('Queued For Review'), { column: 9, row: 1 });

  wf.connect(called, loadContext);
  wf.connect(sweep, openConversations);
  wf.connect(openConversations, loadContext);
  wf.chain(loadContext, history, research, buildPrompt, claude, parse, store, needsHuman);
  wf.connect([needsHuman, 0], notify);
  wf.connect([needsHuman, 1], done);

  const classify = wf.add(classifyFailure('wf10-response-assistant'), { column: 5, row: 2 });
  const fail = wf.add(failLead('wf10-response-assistant', 'Claude: Draft Reply'), { column: 6, row: 2 });
  wf.connect([claude, 1], classify);
  wf.connect(classify, fail);

  return wf.toJSON();
}
