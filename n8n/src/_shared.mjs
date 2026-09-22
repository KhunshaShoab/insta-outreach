// Shared node builders used by several workflows.
import { code, rpc, supabase, ifNode, noop } from '../dsl.mjs';
import { withLib, configConst } from '../bundle.mjs';

/** Resolve the campaign + niche for this run, whatever triggered it. */
export const loadCampaign = () => supabase('Load Campaign + Niche', {
  method: 'GET',
  path: 'campaigns',
  query: "?id=eq.{{ $json.campaign_id || $env.DEFAULT_CAMPAIGN_ID }}&select=*,niche:niches(*)",
  notes: 'One read per run. Campaign settings - ICP band, thresholds, daily targets, follow-up offsets - all come from here, never from node parameters.'
});

/** Claim a batch of leads at a stage. Safe to run in parallel with itself. */
export const claim = (stage, { name = `Claim ${stage} Leads`, limitExpr = '$json.batch_size || 25', worker } = {}) =>
  rpc(name, 'claim_leads', `={{ JSON.stringify({ p_campaign_id: $json.id || $json.campaign_id, p_stage: '${stage}', p_limit: ${limitExpr}, p_worker: '${worker}', p_stale_minutes: 20, p_max_retries: 3 }) }}`, {
    notes: `SELECT ... FOR UPDATE SKIP LOCKED, so parallel executions never hand the same lead to two workers. A claim older than 20 minutes is treated as abandoned and reissued, which is how a crashed run resumes instead of stranding leads at ${stage}.`
  });

/** Guard: stop cleanly when a claim returned nothing. */
export const haveWork = (name = 'Any Work?') => ifNode(name, {
  left: '={{ $json.id !== undefined || Array.isArray($json) ? true : false }}',
  operator: { type: 'boolean', operation: 'true', singleValue: true }
}, { notes: 'An empty claim is a normal outcome, not an error.' });

export const nothingToDo = (name = 'Nothing To Do') => noop(name);

/** Move a lead forward and stamp the step. */
export const advance = (name, toStage, status, step, detail = '{}') =>
  rpc(name, 'advance_lead', `={{ JSON.stringify({
    p_lead_id: $json.lead_id,
    p_to_stage: ${JSON.stringify(toStage)},
    p_status: ${JSON.stringify(status)},
    p_step: ${JSON.stringify(step)},
    p_detail: ${detail},
    p_execution_id: $execution.id
  }) }}`);

/** Record a failure without stopping the batch. */
export const failLead = (workflowName, nodeLabel) =>
  rpc('Record Failure', 'fail_lead', `={{ JSON.stringify({
    p_lead_id: $json.lead_id || null,
    p_workflow: ${JSON.stringify(workflowName)},
    p_error_type: $json.error_type || 'unknown',
    p_message: String($json.error_message || $json.error || 'unknown error').slice(0, 2000),
    p_node: ${JSON.stringify(nodeLabel)},
    p_provider: $json.provider || null,
    p_http_status: $json.http_status || null,
    p_payload: $json.payload || {},
    p_max_retries: 3,
    p_execution_id: $execution.id
  }) }}`, {
    continueOnFail: true,
    notes: 'The failed-item queue. The lead returns to its stage with an incremented retry count and an exponential backoff; the rest of the batch is unaffected.'
  });

/**
 * Classify whatever an upstream node threw, so the failure row is useful.
 * Shared by every workflow that talks to an external service.
 */
export const classifyFailure = (workflowName) => code('Classify Failure', withLib(['lib/retry.js'], `
const out = [];
for (const item of $input.all()) {
  const json = item.json || {};
  const error = json.error || json.$error || json;
  const status = error.status || error.httpCode || json.statusCode || null;
  const decision = decideRetry({
    error: { status, message: error.message || error.description || JSON.stringify(error).slice(0, 500) },
    attempt: (json.retry_count || 0) + 1,
    maxRetries: 3,
    headers: json.headers || {}
  });
  out.push({ json: {
    lead_id: json.lead_id ?? null,
    campaign_id: json.campaign_id ?? null,
    workflow: ${JSON.stringify(workflowName)},
    provider: json.provider ?? null,
    http_status: status,
    error_type: decision.error_type,
    error_message: error.message || String(error).slice(0, 500),
    retryable: decision.retryable,
    dead_letter: decision.dead_letter,
    delay_ms: decision.delay_ms,
    payload: { node: json.node ?? null, stage: json.stage ?? null }
  } });
}
return out;
`), { notes: 'Uses the same classifier as the test suite: 429 backs off, 5xx retries, 401/422 dead-letters immediately.' });

/** Write a workflow_runs row so progress survives a crash. */
export const startRun = (workflowName) => supabase('Start Run Record', {
  method: 'POST',
  path: 'workflow_runs',
  body: `={{ JSON.stringify({
    workflow: ${JSON.stringify(workflowName)},
    campaign_id: $json.id || $json.campaign_id,
    execution_id: $execution.id,
    status: 'RUNNING'
  }) }}`,
  notes: 'Resume bookkeeping: which workflow, which campaign, which execution, and how far it got.'
});

export const finishRun = (workflowName) => supabase('Finish Run Record', {
  method: 'PATCH',
  path: 'workflow_runs',
  query: '?execution_id=eq.{{ $execution.id }}&workflow=eq.' + encodeURIComponent(workflowName),
  body: `={{ JSON.stringify({
    status: $json.items_failed > 0 ? 'PARTIAL' : 'SUCCESS',
    items_in: $json.items_in || 0,
    items_ok: $json.items_ok || 0,
    items_failed: $json.items_failed || 0,
    cursor: $json.cursor || {},
    finished_at: new Date().toISOString()
  }) }}`,
  continueOnFail: true
});

/** Config constants every Code node that needs rules can inline. */
export const CONFIG = {
  cleaning: () => configConst('config/cleaning.json', 'CLEANING_RULES'),
  scoring: () => configConst('config/scoring.default.json', 'SCORING_PROFILE'),
  followups: () => configConst('config/followups.default.json', 'FOLLOWUP_DEFAULTS'),
  providers: () => configConst('config/providers.json', 'PROVIDERS')
};
