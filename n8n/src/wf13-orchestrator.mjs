// WORKFLOW 13 - Master Orchestrator
// Runs the pipeline stages for every active campaign, in order, with each stage
// isolated. A stage that fails is recorded and the run continues - a single bad
// lead or a provider outage must never stop a campaign.
import { workflow, schedule, webhook, respond, code, supabase, executeWorkflow, splitInBatches, ifNode, noop } from '../dsl.mjs';
import { withLib } from '../bundle.mjs';

export function build() {
  const wf = workflow('wf13-orchestrator', {
    description: 'Campaign settings -> discovery -> cleaning -> enrichment -> qualification -> research -> outreach generation -> approval -> release -> follow-ups.',
    tags: ['optiflow', 'orchestrator']
  });

  const cron = wf.add(schedule('Pipeline Tick', '*/15 6-20 * * 1-5'));
  const kick = wf.add(webhook('Run Now', 'optiflow/run', 'POST', {
    notes: 'Body: { campaign_id?, stages?: ["discovery","clean",...] }. Omit both to run every active campaign end to end.'
  }), { column: 0, row: 1 });

  const campaigns = wf.add(supabase('Load Active Campaigns', {
    method: 'GET',
    path: 'campaigns',
    query: '?status=eq.active&select=*&order=created_at.asc'
  }), { column: 1, row: 0 });

  const plan = wf.add(code('Plan This Tick', withLib(['lib/stages.js'], `
// Discovery is expensive and rate-limited, so it runs on its own schedule;
// every other stage runs on every tick and simply finds nothing to do when the
// queue at that stage is empty.
const body = $('Run Now').isExecuted ? ($('Run Now').first().json.body ?? {}) : {};
const rows = $input.first().json;
const campaigns = Array.isArray(rows) ? rows : [rows];
const selected = body.campaign_id ? campaigns.filter((c) => c.id === body.campaign_id) : campaigns;

const hour = new Date().getUTCHours();
const out = [];

for (const campaign of selected) {
  if (!campaign || !campaign.id) continue;
  const discoveryHour = Number((campaign.schedule?.discovery_cron ?? '0 6 * * 1-5').split(' ')[1]) || 6;
  const stages = body.stages ?? [
    ...(hour === discoveryHour ? ['discovery'] : []),
    'clean', 'enrich', 'qualify', 'research', 'generate', 'release', 'followups'
  ];

  out.push({ json: {
    campaign_id: campaign.id,
    campaign_name: campaign.name,
    batch_size: body.batch_size ?? 25,
    stages,
    pipeline: PIPELINE,
    tick_started_at: new Date().toISOString()
  } });
}

if (!out.length) return [{ json: { campaign_id: null, stages: [], note: 'No active campaigns' } }];
return out;
`), { notes: 'Stage selection is data, not wiring: pass { stages: ["qualify"] } to the webhook to re-run one stage for one campaign.' }), { column: 2, row: 0 });

  const anyCampaign = wf.add(ifNode('Any Active Campaign?', {
    left: '={{ Boolean($json.campaign_id) }}',
    operator: { type: 'boolean', operation: 'true', singleValue: true }
  }), { column: 3, row: 0 });

  const idle = wf.add(noop('Nothing To Run'), { column: 4, row: 2 });
  const perCampaign = wf.add(splitInBatches('For Each Campaign', 1), { column: 4, row: 0 });

  const discovery = wf.add(executeWorkflow('1. Discovery', 'wf01-lead-discovery'), { column: 5, row: 0 });
  const clean = wf.add(executeWorkflow('2. Clean + Dedupe', 'wf02-clean-dedupe'), { column: 6, row: 0 });
  const enrich = wf.add(executeWorkflow('3. Enrichment', 'wf03-enrichment'), { column: 7, row: 0 });
  const qualify = wf.add(executeWorkflow('4. Qualification', 'wf04-qualification'), { column: 8, row: 0 });
  const research = wf.add(executeWorkflow('5. Research', 'wf05-research'), { column: 9, row: 0 });
  const generate = wf.add(executeWorkflow('6. Outreach Generation', 'wf06-outreach-generation'), { column: 10, row: 0 });
  const release = wf.add(executeWorkflow('8. Release Approved', 'wf08-outreach-log'), { column: 11, row: 0 });
  const followups = wf.add(executeWorkflow('11. Follow-ups', 'wf11-followup-engine'), { column: 12, row: 0 });

  const record = wf.add(code('Record Tick Outcome', `
// Each Execute Workflow node continues on failure, so this sees whatever each
// stage produced - success or the error it reported.
const stages = ['1. Discovery','2. Clean + Dedupe','3. Enrichment','4. Qualification','5. Research','6. Outreach Generation','8. Release Approved','11. Follow-ups'];
const results = [];
let failed = 0;

for (const name of stages) {
  let outcome = { stage: name, ran: false, ok: null, error: null };
  try {
    const node = $(name);
    if (node.isExecuted) {
      const first = node.first().json ?? {};
      outcome = { stage: name, ran: true, ok: !first.error, error: first.error ? String(first.error).slice(0, 300) : null };
      if (first.error) failed += 1;
    }
  } catch (error) {
    outcome = { stage: name, ran: false, ok: false, error: String(error.message ?? error).slice(0, 300) };
    failed += 1;
  }
  results.push(outcome);
}

const context = $('Plan This Tick').first().json;
return [{ json: {
  workflow: 'wf13-orchestrator',
  campaign_id: context.campaign_id,
  execution_id: $execution.id,
  status: failed ? 'PARTIAL' : 'SUCCESS',
  items_in: results.length,
  items_ok: results.filter((r) => r.ok).length,
  items_failed: failed,
  cursor: { stages: results, tick_started_at: context.tick_started_at },
  finished_at: new Date().toISOString()
} }];
`), { column: 13, row: 0 });

  const persist = wf.add(supabase('Store Run Record', {
    method: 'POST',
    path: 'workflow_runs',
    body: `={{ JSON.stringify({
      workflow: $json.workflow,
      campaign_id: $json.campaign_id,
      execution_id: $json.execution_id,
      status: $json.status,
      items_in: $json.items_in,
      items_ok: $json.items_ok,
      items_failed: $json.items_failed,
      cursor: $json.cursor,
      finished_at: $json.finished_at
    }) }}`,
    continueOnFail: true,
    notes: 'Resume evidence: which stages ran, which failed, and where the tick stopped.'
  }), { column: 14, row: 0 });

  const answer = wf.add(respond('Respond', '={{ { ok: true, status: $json.status, stages: $json.cursor.stages } }}'), { column: 15, row: 0 });

  wf.connect(cron, campaigns);
  wf.connect(kick, campaigns);
  wf.chain(campaigns, plan, anyCampaign);
  wf.connect([anyCampaign, 0], perCampaign);
  wf.connect([anyCampaign, 1], idle);
  wf.connect([perCampaign, 1], discovery);
  wf.chain(discovery, clean, enrich, qualify, research, generate, release, followups);
  wf.connect(followups, perCampaign);          // next campaign
  wf.connect([perCampaign, 0], record);        // all campaigns done
  wf.chain(record, persist, answer);

  return wf.toJSON();
}
