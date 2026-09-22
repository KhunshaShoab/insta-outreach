// WORKFLOW 2 - Lead Cleaning & Deduplication
// SCRAPED -> CLEANED (or DISQUALIFIED with a stated reason).
// Nothing is deleted. A rejected lead keeps its row, its reason and its audit
// trail, so "why did we drop this business?" always has an answer.
import { workflow, schedule, subWorkflowTrigger, code, supabase, switchNode } from '../dsl.mjs';
import { withLib, configConst } from '../bundle.mjs';
import { loadCampaign, claim, advance, classifyFailure, failLead } from './_shared.mjs';

export function build() {
  const wf = workflow('wf02-clean-dedupe', {
    description: 'Normalise, filter and de-duplicate scraped leads.',
    tags: ['optiflow', 'cleaning']
  });

  const cron = wf.add(schedule('Every 15 Minutes', '*/15 6-20 * * 1-5'));
  const called = wf.add(subWorkflowTrigger('Called By Orchestrator'), { column: 0, row: 1 });

  const campaign = wf.add(loadCampaign(), { column: 1, row: 0 });
  wf.connect(cron, campaign);
  wf.connect(called, campaign);

  const claimed = wf.add(claim('SCRAPED', { worker: 'wf02-clean-dedupe' }), { column: 2, row: 0 });

  const fetchCompany = wf.add(supabase('Fetch Company Record', {
    method: 'GET',
    path: 'companies',
    query: '?id=eq.{{ $json.company_id }}&select=*',
    notes: 'One read per claimed lead. Swap for a single ?id=in.(...) read if batch sizes grow beyond a few hundred.'
  }), { column: 3, row: 0 });

  const clean = wf.add(code('Apply Cleaning Rules', withLib(['lib/normalize.js', 'lib/clean.js', 'lib/dedupe.js'], `
${configConst('config/cleaning.json', 'CLEANING_RULES')}

const campaign = $('Load Campaign + Niche').first().json;
const niche = campaign.niche || {};
const out = [];

for (const item of $input.all()) {
  const company = Array.isArray(item.json) ? item.json[0] : item.json;
  if (!company || !company.id) continue;

  const claimedLead = $('Claim SCRAPED Leads').all()
    .map((i) => i.json)
    .find((l) => l.company_id === company.id) || {};

  const lead = normalizeRawLead({
    ...company,
    business_name: company.name,
    ig_last_post_at: company.ig_last_post_at
  });
  lead.days_since_last_post = daysSince(company.ig_last_post_at);
  lead.previously_contacted = Boolean(company.suppressed);

  const decision = cleanLead(lead, { campaign, niche, rules: CLEANING_RULES });

  out.push({ json: {
    lead_id: claimedLead.id,
    company_id: company.id,
    campaign_id: campaign.id,
    keep: decision.keep,
    decision: decision.keep ? 'KEEP' : 'DROP',
    reasons: decision.reasons,
    flags: decision.flags,
    identity_keys: identityKeys(lead),
    lead: decision.lead
  } });
}
return out;
`), { notes: 'Rules come from config/cleaning.json, inlined at build time. Edit that file and rebuild to change what is filtered - no node edits.' }), { column: 4, row: 0 });

  const route = wf.add(switchNode('Keep or Drop', '={{ $json.decision }}', [
    { name: 'keep', value: 'KEEP' },
    { name: 'drop', value: 'DROP' }
  ]), { column: 5, row: 0 });

  const persistFlags = wf.add(supabase('Tag Company With Niche', {
    method: 'PATCH',
    path: 'companies',
    query: '?id=eq.{{ $json.company_id }}',
    body: `={{ JSON.stringify({ niche_id: $('Load Campaign + Niche').first().json.niche_id, business_model: $('Load Campaign + Niche').first().json.niche?.business_model }) }}`,
    continueOnFail: true,
    notes: 'Only the niche tagging. The cleaning flags travel on the advance_lead detail into the activity log - writing them here would overwrite companies.raw, which holds the provider payload.'
  }), { column: 6, row: 0 });

  const advanceKeep = wf.add(advance('Advance To CLEANED', 'CLEANED', 'NEW', 'clean.normalize_filter_dedupe',
    '{ actor: "n8n:wf02", flags: $json.flags }'), { column: 7, row: 0 });

  const markDropped = wf.add(supabase('Record Drop Reason', {
    method: 'PATCH',
    path: 'leads',
    query: '?id=eq.{{ $json.lead_id }}',
    body: '={{ JSON.stringify({ disqualified_reason: $json.reasons.join(", "), qualified: false, notes: "Dropped at cleaning: " + $json.reasons.join(", ") }) }}'
  }), { column: 6, row: 1 });

  const advanceDrop = wf.add(advance('Advance To DISQUALIFIED', 'DISQUALIFIED', 'CLOSED', 'clean.rejected',
    '{ actor: "n8n:wf02", reasons: $json.reasons }'), { column: 7, row: 1 });

  wf.chain(campaign, claimed, fetchCompany, clean, route);
  wf.connect([route, 0], persistFlags);
  wf.connect(persistFlags, advanceKeep);
  wf.connect([route, 1], markDropped);
  wf.connect(markDropped, advanceDrop);

  const classify = wf.add(classifyFailure('wf02-clean-dedupe'), { column: 4, row: 2 });
  const fail = wf.add(failLead('wf02-clean-dedupe', 'Apply Cleaning Rules'), { column: 5, row: 2 });
  wf.connect([fetchCompany, 1], classify);
  wf.connect(classify, fail);

  return wf.toJSON();
}
