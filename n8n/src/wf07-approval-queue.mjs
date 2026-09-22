// WORKFLOW 7 - Human Approval Queue
// The API behind the approval console. Every message a prospect ever receives
// passes through one of these endpoints, operated by a person:
//   GET  /queue        what is waiting for review
//   POST /approve      approve as written, or with an edit
//   POST /reject       reject, optionally sending the lead back for a rewrite
//   POST /mark-sent    record that a human actually sent it in Instagram
//   POST /outcome      set INTERESTED / NURTURE / NOT_INTERESTED / CLOSED
//   POST /opt-out      permanent suppression
import { workflow, webhook, respond, code, supabase, rpc, switchNode } from '../dsl.mjs';
import { withLib } from '../bundle.mjs';

export function build() {
  const wf = workflow('wf07-approval-queue', {
    description: 'Human approval API: review, edit, approve, reject, mark as sent.',
    tags: ['optiflow', 'approval', 'human-in-the-loop']
  });

  const hook = wf.add(webhook('Console API', 'optiflow/approval/:action', 'POST', {
    notes: 'Protect with n8n header auth. The console sends the operator identity in x-operator; it is recorded on every decision.'
  }));

  const queueHook = wf.add(webhook('Queue API', 'optiflow/queue', 'GET', {
    notes: 'Returns the approval queue, highest priority and ICP score first.'
  }), { column: 0, row: 1 });

  const validate = wf.add(code('Validate Request', `
// Reject anything that is not one of the six known actions, and require the
// operator identity - an approval with no name attached is not an approval.
const ALLOWED = ['approve', 'reject', 'mark-sent', 'outcome', 'opt-out', 'regenerate'];
const out = [];

for (const item of $input.all()) {
  const body = item.json.body ?? item.json;
  const action = (item.json.params?.action ?? body.action ?? '').toLowerCase();
  const operator = item.json.headers?.['x-operator'] ?? body.operator ?? null;

  if (!ALLOWED.includes(action)) {
    out.push({ json: { ok: false, error: 'unknown_action', action, allowed: ALLOWED, http_status: 400 } });
    continue;
  }
  if (!operator) {
    out.push({ json: { ok: false, error: 'missing_operator', detail: 'Send the reviewer identity in the x-operator header.', http_status: 400 } });
    continue;
  }
  if (['approve', 'reject', 'mark-sent', 'regenerate'].includes(action) && !body.outreach_id) {
    out.push({ json: { ok: false, error: 'missing_outreach_id', http_status: 400 } });
    continue;
  }
  if (['outcome', 'opt-out'].includes(action) && !body.lead_id) {
    out.push({ json: { ok: false, error: 'missing_lead_id', http_status: 400 } });
    continue;
  }

  out.push({ json: {
    ok: true,
    action,
    operator: String(operator).startsWith('user:') ? operator : 'user:' + operator,
    outreach_id: body.outreach_id ?? null,
    lead_id: body.lead_id ?? null,
    edited_message: body.edited_message ?? null,
    reason: body.reason ?? null,
    outcome: body.outcome ?? null,
    note: body.note ?? null,
    send_mode: body.send_mode ?? 'manual',
    external_message_id: body.external_message_id ?? null,
    regenerate: body.regenerate !== false
  } });
}
return out;
`), { column: 1, row: 0 });

  const route = wf.add(switchNode('Route Action', '={{ $json.ok ? $json.action : "invalid" }}', [
    { name: 'approve', value: 'approve' },
    { name: 'reject', value: 'reject' },
    { name: 'mark-sent', value: 'mark-sent' },
    { name: 'outcome', value: 'outcome' },
    { name: 'opt-out', value: 'opt-out' },
    { name: 'regenerate', value: 'regenerate' },
    { name: 'invalid', value: 'invalid' }
  ]), { column: 2, row: 0 });

  const approve = wf.add(rpc('Approve', 'approve_outreach',
    '={{ JSON.stringify({ p_outreach_id: $json.outreach_id, p_approved_by: $json.operator, p_edited_message: $json.edited_message }) }}',
    { notes: 'Sets APPROVED, stores the edit as the final text, and releases the lead to READY_FOR_OUTREACH. An edited message is recorded as the "custom" variation so reporting does not credit the model.' }),
    { column: 3, row: 0 });

  const reject = wf.add(rpc('Reject', 'reject_outreach',
    '={{ JSON.stringify({ p_outreach_id: $json.outreach_id, p_rejected_by: $json.operator, p_reason: $json.reason, p_regenerate: $json.regenerate }) }}',
    { notes: 'With regenerate=true the lead returns to RESEARCHED and workflow 6 writes a new draft.' }),
    { column: 3, row: 1 });

  const markSent = wf.add(rpc('Mark As Sent', 'mark_outreach_sent',
    '={{ JSON.stringify({ p_outreach_id: $json.outreach_id, p_sent_by: $json.operator, p_send_mode: $json.send_mode, p_external_message_id: $json.external_message_id }) }}',
    { notes: 'Called after a human has actually sent the DM in Instagram. Opens the conversation, logs the outbound message and schedules the follow-up sequence. Idempotent.' }),
    { column: 3, row: 2 });

  const outcome = wf.add(rpc('Set Outcome', 'set_lead_outcome',
    '={{ JSON.stringify({ p_lead_id: $json.lead_id, p_outcome: $json.outcome, p_actor: $json.operator, p_note: $json.note }) }}'),
    { column: 3, row: 3 });

  const optOut = wf.add(rpc('Opt Out', 'opt_out',
    '={{ JSON.stringify({ p_lead_id: $json.lead_id, p_reason: $json.reason || "prospect_request" }) }}',
    { notes: 'Permanent suppression across every current and future campaign.' }),
    { column: 3, row: 4 });

  const regenerate = wf.add(rpc('Send Back For Rewrite', 'reject_outreach',
    '={{ JSON.stringify({ p_outreach_id: $json.outreach_id, p_rejected_by: $json.operator, p_reason: $json.reason || "regenerate requested", p_regenerate: true }) }}'),
    { column: 3, row: 5 });

  const readQueue = wf.add(supabase('Read Approval Queue', {
    method: 'GET',
    path: 'v_approval_queue',
    query: '?select=*&limit={{ $json.query?.limit || 50 }}',
    notes: 'Ordered by priority then ICP score. The view carries the research brief and the pain points so the reviewer can judge without opening another tab.'
  }), { column: 1, row: 1 });

  const okResponse = wf.add(respond('Respond OK', '={{ { ok: true, action: $(\'Validate Request\').item.json.action, result: $json } }}'), { column: 4, row: 0 });
  const queueResponse = wf.add(respond('Respond Queue', '={{ { ok: true, count: Array.isArray($json) ? $json.length : 0, items: $json } }}'), { column: 2, row: 1 });
  const badRequest = wf.add(respond('Respond Bad Request', '={{ { ok: false, error: $json.error, detail: $json.detail ?? null } }}', 400), { column: 3, row: 6 });

  wf.connect(hook, validate);
  wf.connect(validate, route);
  wf.connect([route, 0], approve);
  wf.connect([route, 1], reject);
  wf.connect([route, 2], markSent);
  wf.connect([route, 3], outcome);
  wf.connect([route, 4], optOut);
  wf.connect([route, 5], regenerate);
  wf.connect([route, 6], badRequest);
  for (const node of [approve, reject, markSent, outcome, optOut, regenerate]) wf.connect(node, okResponse);

  wf.connect(queueHook, readQueue);
  wf.connect(readQueue, queueResponse);

  return wf.toJSON();
}
