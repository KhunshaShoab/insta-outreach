// Checks on the generated n8n workflows: structure, and the guarantees the
// system is supposed to make (nothing sends without a human, replies stop
// sequences, every external call has a retry and an error path).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateWorkflow } from '../n8n/build.mjs';
import { ROOT } from './fixtures.mjs';

const DIR = join(ROOT, 'n8n/workflows');
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const workflows = files.map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')));
const byName = Object.fromEntries(workflows.map((w) => [w.name, w]));

const EXPECTED = [
  'wf01-lead-discovery', 'wf02-clean-dedupe', 'wf03-enrichment', 'wf04-qualification',
  'wf05-research', 'wf06-outreach-generation', 'wf07-approval-queue', 'wf08-outreach-log',
  'wf09-reply-processing', 'wf10-response-assistant', 'wf11-followup-engine',
  'wf12-analytics', 'wf13-orchestrator', 'wf14-v1-lead-intelligence'
];

const codeNodes = (wf) => wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code');
const httpNodes = (wf) => wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
const bodyOf = (node) => JSON.stringify(node.parameters ?? {});

test('all fourteen workflows are generated', () => {
  assert.deepEqual(workflows.map((w) => w.name), EXPECTED);
});

test('every workflow is structurally valid', () => {
  for (const wf of workflows) {
    assert.deepEqual(validateWorkflow(wf), [], `${wf.name} failed validation`);
  }
});

test('every Code node parses and its inlined lib prelude executes', () => {
  for (const wf of workflows) {
    for (const node of codeNodes(wf)) {
      const source = node.parameters.jsCode;
      // n8n runs Code-node bodies inside an async function; compile them the
      // same way so top-level await is treated as valid, which it is there.
      assert.doesNotThrow(
        () => new Function('$input', '$json', '$env', '$execution', `return (async () => {\n${source}\n})();`),
        `${wf.name}/${node.name} does not parse`
      );
      // Where lib/ source was inlined, run the prelude on its own: it must be
      // executable in isolation, which is what proves the bundle is complete.
      const parts = source.split('// ---- node logic ----');
      if (parts.length > 1) {
        assert.doesNotThrow(() => new Function(`${parts[0]}\nreturn true;`)(), `${wf.name}/${node.name} prelude does not execute`);
      }
    }
  }
});

test('the inlined lib code is identical to the tested source', () => {
  const normalize = readFileSync(join(ROOT, 'lib/normalize.js'), 'utf8');
  const marker = normalize.match(/export function normalizeBusinessName[\s\S]{0,200}/)[0].replace(/^export /, '');
  const clean = byName['wf02-clean-dedupe'];
  const node = codeNodes(clean).find((n) => n.name === 'Apply Cleaning Rules');
  assert.ok(node.parameters.jsCode.includes(marker.slice(0, 120)), 'the bundled source drifted from lib/normalize.js');
});

test('every external call retries and has somewhere to send a failure', () => {
  for (const wf of workflows) {
    for (const node of httpNodes(wf)) {
      assert.ok(node.retryOnFail || node.onError, `${wf.name}/${node.name} has neither retry nor an error path`);
      assert.ok(node.parameters.options?.timeout > 0, `${wf.name}/${node.name} has no timeout`);
    }
  }
});

test('every Claude call has a timeout long enough for a real response', () => {
  for (const wf of workflows) {
    for (const node of wf.nodes.filter((n) => n.name.startsWith('Claude:'))) {
      assert.ok(node.parameters.options.timeout >= 60000, `${wf.name}/${node.name} timeout too short`);
      assert.equal(node.retryOnFail, true);
      assert.equal(node.onError, 'continueErrorOutput');
    }
  }
});

test('generated messages enter the queue as PENDING_REVIEW, never as sent', () => {
  for (const name of ['wf06-outreach-generation', 'wf11-followup-engine']) {
    const wf = byName[name];
    const insert = wf.nodes.find((n) => /Queue .*Approval/i.test(n.name));
    assert.ok(insert, `${name} does not queue a draft`);
    assert.match(bodyOf(insert), /PENDING_REVIEW/);
    assert.doesNotMatch(bodyOf(insert), /'SENT'|"SENT"/);
  }
});

test('only the approval and release workflows can mark a message as sent', () => {
  const senders = workflows.filter((wf) => JSON.stringify(wf).includes('mark_outreach_sent')).map((wf) => wf.name);
  assert.deepEqual(senders.sort(), ['wf07-approval-queue', 'wf08-outreach-log']);
});

test('no workflow can approve its own draft', () => {
  const approvers = workflows.filter((wf) => JSON.stringify(wf).includes('approve_outreach')).map((wf) => wf.name);
  assert.deepEqual(approvers, ['wf07-approval-queue'], 'approval must only happen through the human API');
});

test('the approval API requires an operator identity', () => {
  const validate = codeNodes(byName['wf07-approval-queue']).find((n) => n.name === 'Validate Request');
  assert.match(validate.parameters.jsCode, /missing_operator/);
  assert.match(validate.parameters.jsCode, /x-operator/);
});

test('the release workflow refuses to cold-DM through the API', () => {
  const wf = byName['wf08-outreach-log'];
  const gate = wf.nodes.find((n) => n.name === 'Conversation Already Open?');
  assert.ok(gate, 'there must be a gate between the API sender and a cold DM');
  const manual = wf.nodes.find((n) => n.name === 'Prepare Operator Work Items');
  const coldBranch = wf.connections['Conversation Already Open?'].main[1];
  assert.equal(coldBranch[0].node, manual.name, 'a cold DM must fall back to a human');
});

test('an inbound reply is logged before anything else happens to it', () => {
  const wf = byName['wf09-reply-processing'];
  const log = wf.nodes.find((n) => n.name === 'Log Inbound Message');
  assert.ok(log, 'replies must be logged');
  assert.match(log.notes, /cancels every scheduled follow-up/i);
  // The classification path runs after the insert that fires the trigger.
  const chain = JSON.stringify(wf.connections['Log Inbound Message']);
  assert.match(chain, /Conversation History/);
});

test('the webhook verifies its signature before trusting a payload', () => {
  const parse = codeNodes(byName['wf09-reply-processing']).find((n) => n.name === 'Verify + Parse Inbound');
  assert.match(parse.parameters.jsCode, /crypto\.subtle\.sign/, 'the payload must be HMAC-verified');
  assert.match(parse.parameters.jsCode, /diff \|= expected\[i\] \^ received\[i\]/, 'the comparison must be constant-time');
  assert.match(parse.parameters.jsCode, /invalid_signature/);
  const withoutComments = parse.parameters.jsCode.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(withoutComments, /require\(/, 'must run on a default n8n install without extra builtins enabled');
});

test('the follow-up engine checks for a reply twice before generating anything', () => {
  const wf = byName['wf11-followup-engine'];
  const view = wf.nodes.find((n) => n.name === 'Read Follow-ups Due');
  assert.match(view.parameters.url, /v_followups_due/);
  const guard = codeNodes(wf).find((n) => n.name === 'Reply Guard');
  assert.match(guard.parameters.jsCode, /shouldStopSequence/);
  // The guard sits between the queue read and the first Claude call.
  const order = wf.connections['Reply Guard'].main[0][0].node;
  assert.equal(order, 'Still Waiting?');
});

test('the orchestrator isolates each stage so one failure cannot stop a campaign', () => {
  const wf = byName['wf13-orchestrator'];
  const stages = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.executeWorkflow');
  assert.ok(stages.length >= 8, 'the orchestrator should call every pipeline stage');
  for (const stage of stages) {
    assert.equal(stage.onError, 'continueRegularOutput', `${stage.name} would stop the whole run on failure`);
  }
});

test('the orchestrator runs the stages in pipeline order', () => {
  const wf = byName['wf13-orchestrator'];
  const order = ['1. Discovery', '2. Clean + Dedupe', '3. Enrichment', '4. Qualification', '5. Research', '6. Outreach Generation', '8. Release Approved', '11. Follow-ups'];
  for (let i = 0; i < order.length - 1; i += 1) {
    const next = wf.connections[order[i]].main[0][0].node;
    assert.equal(next, order[i + 1], `${order[i]} should hand off to ${order[i + 1]}`);
  }
});

test('the daily report never asks the model to recalculate the numbers', () => {
  const prepare = codeNodes(byName['wf12-analytics']).find((n) => n.name === 'Prepare Report Input');
  assert.match(prepare.parameters.jsCode, /ranking_metric: null/);
  assert.match(prepare.parameters.jsCode, /const rate = /);
});

test('no credential value is baked into a generated workflow', () => {
  const blob = JSON.stringify(workflows);
  assert.doesNotMatch(blob, /sk-ant-/, 'an API key leaked into the workflow JSON');
  assert.doesNotMatch(blob, /apify_api_[A-Za-z0-9]/);
  assert.doesNotMatch(blob, /eyJhbGciOi/, 'a JWT leaked into the workflow JSON');
  for (const key of ['ANTHROPIC_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'APIFY_TOKEN', 'APOLLO_API_KEY']) {
    assert.ok(blob.includes(`$env.${key}`), `${key} should be read from the environment`);
  }
});

test('the V1 workflow stands alone and shares no campaign-engine state', () => {
  const wf = byName['wf14-v1-lead-intelligence'];
  const blob = JSON.stringify(wf);
  assert.ok(!blob.includes('claim_leads'), 'V1 does not touch the campaign pipeline');
  assert.ok(!blob.includes('advance_lead'), 'V1 has no lead stage machine');
  assert.ok(blob.includes('review_status'), 'V1 still marks every row for human review');
});

test('every workflow that claims leads uses the locking claim function', () => {
  for (const name of ['wf02-clean-dedupe', 'wf03-enrichment', 'wf04-qualification', 'wf05-research', 'wf06-outreach-generation']) {
    const wf = byName[name];
    const claimNode = wf.nodes.find((n) => n.name.startsWith('Claim '));
    assert.ok(claimNode, `${name} has no claim node`);
    assert.match(claimNode.parameters.url, /rpc\/claim_leads/);
    assert.match(claimNode.parameters.jsonBody, /p_stale_minutes/, `${name} must recover abandoned claims`);
  }
});

test('qualification scores niche fit from the stored cleaning flags', () => {
  const clean = byName['wf02-clean-dedupe'];
  const store = clean.nodes.find((n) => n.name === 'Store Cleaning Flags');
  assert.ok(store, 'cleaning must persist its flags');
  assert.match(bodyOf(store), /cleaning_flags/);

  const qualify = codeNodes(byName['wf04-qualification']).find((n) => n.name === 'Parse + Score');
  assert.match(qualify.parameters.jsCode, /flags: context\.cleaning_flags/);
  assert.doesNotMatch(
    qualify.parameters.jsCode,
    /flags: \{ niche_hits: \[\] \}/,
    'an empty placeholder would score every lead blind on niche fit'
  );
});
