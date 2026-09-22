// WORKFLOW 9 - Reply Detection, Logging & Classification
// An inbound message arrives (official webhook, or pasted into the console),
// gets matched to a lead, logged, and classified. Logging it is what cancels
// the follow-up sequence - a database trigger does that, so no bug in this
// workflow can leave a sequence running against someone who already replied.
import { workflow, webhook, respond, code, supabase, rpc, anthropic, switchNode, ifNode, executeWorkflow, noop } from '../dsl.mjs';
import { withLib, promptConst, schemaConst } from '../bundle.mjs';

export function build() {
  const wf = workflow('wf09-reply-processing', {
    description: 'Ingest, log and classify prospect replies.',
    tags: ['optiflow', 'replies', 'ai']
  });

  const verify = wf.add(webhook('Webhook Verification', 'optiflow/instagram/webhook', 'GET', {
    responseMode: 'responseNode',
    notes: 'Meta calls this once with hub.challenge when the subscription is created.'
  }), { column: 0, row: 3 });

  const verifyRespond = wf.add(code('Answer Challenge', `
const query = $input.first().json.query || {};
if (query['hub.verify_token'] !== $env.IG_WEBHOOK_VERIFY_TOKEN) {
  return [{ json: { error: 'bad_verify_token', http_status: 403 } }];
}
return [{ json: { challenge: query['hub.challenge'] } }];
`), { column: 1, row: 3 });
  const verifyOut = wf.add(respond('Respond Challenge', '={{ $json.challenge }}'), { column: 2, row: 3 });

  const hook = wf.add(webhook('Instagram Messages Webhook', 'optiflow/instagram/webhook', 'POST', {
    rawBody: true,
    notes: 'Official Instagram messages webhook for OUR professional account. Signed with the app secret.'
  }));
  const manualHook = wf.add(webhook('Manual Reply Entry', 'optiflow/reply/manual', 'POST', {
    notes: 'The operator pastes a reply they received. Identical downstream handling, so manual and API accounts behave the same.'
  }), { column: 0, row: 1 });

  const parse = wf.add(code('Verify + Parse Inbound', `
// WebCrypto rather than require('crypto'): this runs on a default n8n install
// without NODE_FUNCTION_ALLOW_BUILTIN being set.
const out = [];

async function verifySignature(rawBody, header) {
  if (!$env.IG_APP_SECRET || !header) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode($env.IG_APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const hex = Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const expected = encoder.encode('sha256=' + hex);
  const received = encoder.encode(String(header));
  if (expected.length !== received.length) return false;
  // Constant-time comparison: never leak how much of the signature matched.
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected[i] ^ received[i];
  return diff === 0;
}

for (const item of $input.all()) {
  const source = item.json.headers?.['x-hub-signature-256'] ? 'graph_webhook' : 'manual_entry';

  if (source === 'graph_webhook') {
    const raw = item.binary?.data ? Buffer.from(item.binary.data.data, 'base64').toString('utf8') : JSON.stringify(item.json.body ?? {});
    if (!(await verifySignature(raw, item.json.headers['x-hub-signature-256']))) {
      out.push({ json: { ok: false, error: 'invalid_signature', http_status: 401 } });
      continue;
    }
    const payload = item.json.body ?? JSON.parse(raw);
    for (const entry of payload.entry ?? []) {
      for (const event of entry.messaging ?? []) {
        if (!event.message || event.message.is_echo) continue;
        out.push({ json: {
          ok: true,
          source,
          external_message_id: event.message.mid ?? null,
          sender_igsid: event.sender?.id ?? null,
          recipient_igsid: event.recipient?.id ?? null,
          sender_handle: null,
          body: event.message.text ?? '',
          sent_at: event.timestamp ? new Date(Number(event.timestamp)).toISOString() : new Date().toISOString(),
          raw: event
        } });
      }
    }
  } else {
    const body = item.json.body ?? item.json;
    out.push({ json: {
      ok: true,
      source,
      external_message_id: body.external_message_id ?? null,
      sender_igsid: body.sender_igsid ?? null,
      sender_handle: (body.instagram_handle ?? body.sender_handle ?? '').replace(/^@/, '').toLowerCase() || null,
      lead_id: body.lead_id ?? null,
      body: body.body ?? body.message ?? '',
      sent_at: body.sent_at ?? new Date().toISOString(),
      raw: body
    } });
  }
}
return out.length ? out : [{ json: { ok: true, skipped: true, note: 'No message events in payload' } }];
`, { notes: 'A webhook whose signature does not verify is rejected outright.' }), { column: 1, row: 0 });

  const hasMessage = wf.add(ifNode('Is A Real Message?', {
    left: '={{ Boolean($json.ok && !$json.skipped && ($json.body || "").trim().length > 0) }}',
    operator: { type: 'boolean', operation: 'true', singleValue: true }
  }), { column: 2, row: 0 });

  const ignore = wf.add(noop('Ignore'), { column: 3, row: 2 });

  const matchLead = wf.add(supabase('Match To Lead', {
    method: 'GET',
    path: 'v_leads_full',
    query: '?select=*&or=(instagram_handle.eq.{{ $json.sender_handle }},lead_id.eq.{{ $json.lead_id || "00000000-0000-0000-0000-000000000000" }})&limit=1',
    notes: 'Matched by handle, or by the lead id the console supplies. An unmatched reply is kept as an orphan rather than discarded.'
  }), { column: 3, row: 0 });

  const ensureConversation = wf.add(supabase('Ensure Conversation', {
    method: 'POST',
    path: 'conversations',
    query: '?on_conflict=lead_id,channel',
    body: `={{ JSON.stringify({
      lead_id: ($json[0] ?? $json).lead_id,
      campaign_id: ($json[0] ?? $json).campaign_id,
      channel: 'instagram_dm',
      state: 'AWAITING_US'
    }) }}`,
    continueOnFail: true
  }), { column: 4, row: 0 });

  const logMessage = wf.add(supabase('Log Inbound Message', {
    method: 'POST',
    path: 'conversation_messages',
    body: `={{ JSON.stringify({
      conversation_id: ($json[0] ?? $json).id,
      lead_id: $('Match To Lead').item.json[0]?.lead_id ?? $('Match To Lead').item.json.lead_id,
      direction: 'inbound',
      body: $('Verify + Parse Inbound').item.json.body,
      sent_at: $('Verify + Parse Inbound').item.json.sent_at,
      external_message_id: $('Verify + Parse Inbound').item.json.external_message_id,
      sender_handle: $('Verify + Parse Inbound').item.json.sender_handle,
      raw: $('Verify + Parse Inbound').item.json.raw
    }) }}`,
    notes: 'THIS insert is what stops the sequence. The trg_conversation_messages_inbound trigger cancels every scheduled follow-up, clears next_followup_at and moves the lead to REPLIED - in the database, so it cannot be skipped.'
  }), { column: 5, row: 0 });

  const buildPrompt = wf.add(code('Render Classification Prompt', withLib(['lib/prompts.js'], `
${promptConst('07-reply-classification.md', 'PROMPT')}

const lead = $('Match To Lead').first().json;
const row = Array.isArray(lead) ? lead[0] : lead;
const inbound = $('Verify + Parse Inbound').first().json;
const logged = $input.first().json;
const message = Array.isArray(logged) ? logged[0] : logged;

const rendered = renderPrompt(PROMPT, {
  lead: { business_name: row?.business_name ?? 'unknown business', instagram_handle: row?.instagram_handle ?? 'unknown' },
  niche: { name: row?.niche_name ?? 'unknown' },
  research: { operational_pain_points: row?.potential_pain_points ?? [] },
  conversation: { messages: $('Conversation History').all().map((i) => i.json) },
  message: { body: inbound.body, sent_at: inbound.sent_at }
});

return [{ json: {
  lead_id: row?.lead_id ?? null,
  campaign_id: row?.campaign_id ?? null,
  conversation_id: message?.conversation_id ?? null,
  message_id: message?.id ?? null,
  message_body: inbound.body,
  prompt: rendered.prompt,
  model: $env.ANTHROPIC_MODEL || 'claude-sonnet-5',
  max_tokens: rendered.max_tokens,
  temperature: rendered.temperature,
  prompt_version: rendered.version
} }];
`)), { column: 7, row: 0 });

  const history = wf.add(supabase('Conversation History', {
    method: 'GET',
    path: 'conversation_messages',
    query: '?conversation_id=eq.{{ ($json[0] ?? $json).conversation_id }}&select=direction,body,sent_at&order=sent_at.asc&limit=40'
  }), { column: 6, row: 0 });

  const claude = wf.add(anthropic('Claude: Classify Reply'), { column: 8, row: 0 });

  const parseClass = wf.add(code('Parse Classification', withLib(['lib/json.js'], `
${schemaConst('reply-classification.schema.json', 'CLASSIFICATION_SCHEMA')}

const context = $('Render Classification Prompt').first().json;
const text = ($input.first().json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\\n');
const parsed = parseAiJson(text, CLASSIFICATION_SCHEMA, { label: 'reply classification' });

if (!parsed.ok) {
  // Classification failing must never leave the reply unhandled: fall back to
  // the safe reading - a human looks at it.
  return [{ json: {
    ...context,
    classification: 'unclear',
    intent: 'could not classify automatically',
    sentiment: 'neutral',
    urgency: 'medium',
    recommended_action: 'route_to_human',
    requires_human: true,
    stop_followups: true,
    suggested_stage: 'REPLIED',
    reasoning: 'Classifier returned an unusable response: ' + parsed.errors.slice(0, 3).join('; '),
    fallback: true
  } }];
}
return [{ json: { ...context, ...parsed.data, fallback: false, raw_response: text } }];
`), { notes: 'A classifier failure degrades to "unclear + route to human". It never leaves a reply unattended.' }), { column: 9, row: 0 });

  const storeClass = wf.add(supabase('Store Classification', {
    method: 'PATCH',
    path: 'conversation_messages',
    query: '?id=eq.{{ $json.message_id }}',
    body: `={{ JSON.stringify({
      classification: $json.classification,
      intent: $json.intent,
      sentiment: $json.sentiment,
      urgency: $json.urgency,
      objection_type: $json.objection_type ?? null,
      recommended_action: $json.recommended_action,
      classification_meta: { confidence: $json.confidence, reasoning: $json.reasoning, requires_human: $json.requires_human, fallback: $json.fallback, extracted: $json.extracted ?? {} },
      classified_at: new Date().toISOString()
    }) }}`
  }), { column: 10, row: 0 });

  const cancel = wf.add(rpc('Confirm Follow-ups Cancelled', 'cancel_followups',
    '={{ JSON.stringify({ p_lead_id: $json.lead_id, p_reason: "reply_received" }) }}',
    { notes: 'Belt and braces. The trigger already did this; calling it again is a no-op and makes the guarantee visible in the workflow.' }),
    { column: 11, row: 0 });

  const route = wf.add(switchNode('Route By Classification', '={{ $json.classification }}', [
    { name: 'opt_out', value: 'opt_out' },
    { name: 'not_interested', value: 'not_interested' },
    { name: 'maybe_later', value: 'maybe_later' },
    { name: 'auto_reply', value: 'auto_reply' }
  ], { notes: 'Everything else - interested, curious, question, pricing, objection, wrong person, unclear - goes to the response assistant.' }), { column: 12, row: 0 });

  const doOptOut = wf.add(rpc('Suppress Contact', 'opt_out',
    '={{ JSON.stringify({ p_lead_id: $json.lead_id, p_reason: "prospect_request" }) }}'), { column: 13, row: 0 });
  const markNo = wf.add(rpc('Mark Not Interested', 'set_lead_outcome',
    '={{ JSON.stringify({ p_lead_id: $json.lead_id, p_outcome: "NOT_INTERESTED", p_actor: "n8n:wf09", p_note: $json.intent }) }}'), { column: 13, row: 1 });
  const markNurture = wf.add(rpc('Move To Nurture', 'set_lead_outcome',
    '={{ JSON.stringify({ p_lead_id: $json.lead_id, p_outcome: "NURTURE", p_actor: "n8n:wf09", p_note: $json.intent }) }}'), { column: 13, row: 2 });
  const autoReply = wf.add(noop('Auto-reply: Do Nothing'), { column: 13, row: 3 });
  const assistant = wf.add(executeWorkflow('Run Response Assistant', 'wf10-response-assistant', {
    notes: 'Drafts a suggested reply for the operator. Still nothing is sent.'
  }), { column: 13, row: 4 });

  const ack = wf.add(respond('Acknowledge', '={{ { ok: true } }}'), { column: 14, row: 0 });

  wf.connect(verify, verifyRespond);
  wf.connect(verifyRespond, verifyOut);
  wf.connect(hook, parse);
  wf.connect(manualHook, parse);
  wf.connect(parse, hasMessage);
  wf.connect([hasMessage, 0], matchLead);
  wf.connect([hasMessage, 1], ignore);
  wf.chain(matchLead, ensureConversation, logMessage, history, buildPrompt, claude, parseClass, storeClass, cancel, route);
  wf.connect([route, 0], doOptOut);
  wf.connect([route, 1], markNo);
  wf.connect([route, 2], markNurture);
  wf.connect([route, 3], autoReply);
  wf.connect([route, 4], assistant);
  for (const node of [doOptOut, markNo, markNurture, autoReply, assistant]) wf.connect(node, ack);
  wf.connect(ignore, ack);

  return wf.toJSON();
}
