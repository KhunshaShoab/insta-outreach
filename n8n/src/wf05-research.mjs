// WORKFLOW 5 - AI Business Research
// QUALIFIED -> RESEARCHED. Produces the brief the outreach writer opens with:
// what this business actually is, and two to four things that are true about it
// and worth mentioning.
import { workflow, schedule, subWorkflowTrigger, code, supabase, anthropic, ifNode, switchNode } from '../dsl.mjs';
import { withLib, promptConst, schemaConst } from '../bundle.mjs';
import { loadCampaign, claim, advance, classifyFailure, failLead } from './_shared.mjs';

export function build() {
  const wf = workflow('wf05-research', {
    description: 'Write a grounded research brief for each qualified lead.',
    tags: ['optiflow', 'ai', 'research']
  });

  const cron = wf.add(schedule('Every 20 Minutes', '*/20 6-20 * * 1-5'));
  const called = wf.add(subWorkflowTrigger('Called By Orchestrator'), { column: 0, row: 1 });
  const campaign = wf.add(loadCampaign(), { column: 1, row: 0 });
  wf.connect(cron, campaign);
  wf.connect(called, campaign);

  const claimed = wf.add(claim('QUALIFIED', { worker: 'wf05-research' }), { column: 2, row: 0 });

  const bandGate = wf.add(ifNode('In A Researched Band?', {
    left: '={{ ($(\'Load Campaign + Niche\').first().json.research?.only_for_bands ?? ["HIGH_PRIORITY","QUALIFIED"]).includes($json.icp_band) }}',
    operator: { type: 'boolean', operation: 'true', singleValue: true }
  }, { notes: 'REVIEW-band leads are not researched automatically - a human decides whether they are worth the tokens.' }), { column: 3, row: 0 });

  const fetchLead = wf.add(supabase('Fetch Lead Detail', {
    method: 'GET', path: 'v_leads_full', query: '?lead_id=eq.{{ $json.id }}&select=*'
  }), { column: 4, row: 0 });

  const holdForReview = wf.add(supabase('Hold For Manual Review', {
    method: 'PATCH', path: 'leads', query: '?id=eq.{{ $json.id }}',
    body: '={{ JSON.stringify({ status: "NEW", notes: "Held at REVIEW band - research skipped by campaign policy" }) }}',
    continueOnFail: true
  }), { column: 4, row: 1 });

  const buildPrompt = wf.add(code('Render Research Prompt', withLib(['lib/prompts.js', 'lib/normalize.js'], `
${promptConst('03-business-research.md', 'PROMPT')}

const campaign = $('Load Campaign + Niche').first().json;
const niche = campaign.niche || {};
const out = [];

for (const item of $input.all()) {
  const row = Array.isArray(item.json) ? item.json[0] : item.json;
  if (!row || !row.lead_id) continue;

  const lead = {
    business_name: row.business_name,
    instagram_handle: row.instagram_handle,
    ig_followers: row.ig_followers,
    ig_posts: row.ig_posts,
    bio: row.bio,
    website: row.website,
    website_description: row.website_description,
    category: row.niche_name,
    city: row.city,
    state: row.state,
    products_services: row.products_services || [],
    products_count: row.products_count,
    days_since_last_post: daysSince(row.ig_last_post_at),
    content_signals: row.content_signals || []
  };

  const rendered = renderPrompt(PROMPT, {
    lead, niche,
    qualification: {
      icp_score: row.icp_score,
      band: row.icp_band,
      reason: row.qualification_reason || 'not recorded',
      potential_pain_points: row.potential_pain_points || []
    },
    decision_maker: {
      target_contact: row.decision_maker,
      contact_role: row.decision_maker_title,
      why_this_person: row.decision_maker_reason
    }
  });

  out.push({ json: {
    lead_id: row.lead_id,
    campaign_id: row.campaign_id,
    prompt: rendered.prompt,
    model: campaign.research?.model || $env.ANTHROPIC_MODEL_HEAVY || 'claude-opus-5',
    max_tokens: rendered.max_tokens,
    temperature: rendered.temperature,
    prompt_version: rendered.version
  } });
}
return out;
`)), { column: 5, row: 0 });

  const claude = wf.add(anthropic('Claude: Research'), { column: 6, row: 0 });

  const parse = wf.add(code('Parse Research', withLib(['lib/json.js', 'lib/angles.js'], `
${schemaConst('research.schema.json', 'RESEARCH_SCHEMA')}

const campaign = $('Load Campaign + Niche').first().json;
const niche = campaign.niche || {};
const inputs = $('Render Research Prompt').all().map((i) => i.json);
const out = [];

for (const [index, item] of $input.all().entries()) {
  const context = inputs[index] ?? inputs[0];
  const text = (item.json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\\n');
  const parsed = parseAiJson(text, RESEARCH_SCHEMA, { label: 'research' });

  if (!parsed.ok) {
    out.push({ json: { ...context, needs_repair: true, repair_prompt: context.prompt + '\\n\\n' + parsed.retry_prompt, schema_errors: parsed.errors } });
    continue;
  }

  const research = parsed.data;
  // An angle the model invented is replaced by a deterministic pick rather than
  // failing the item - the message must never fall back to a generic pitch.
  const resolved = resolveAngle(niche, research.recommended_angle, { lead: {}, research, campaign });

  out.push({ json: {
    ...context,
    needs_repair: false,
    research,
    angle_id: resolved.angle?.id ?? null,
    angle_source: resolved.source,
    usage: item.json.usage || {},
    raw_response: text
  } });
}
return out;
`)), { column: 7, row: 0 });

  const repairGate = wf.add(switchNode('Valid Research?', '={{ $json.needs_repair ? "repair" : "ok" }}', [
    { name: 'ok', value: 'ok' },
    { name: 'repair', value: 'repair' }
  ]), { column: 8, row: 0 });

  const repair = wf.add(anthropic('Claude: Repair Research JSON', { promptField: '$json.repair_prompt', temperatureField: '0' }), { column: 8, row: 2 });

  const store = wf.add(supabase('Store Research Brief', {
    method: 'POST', path: 'research',
    body: `={{ JSON.stringify({
      lead_id: $json.lead_id,
      campaign_id: $json.campaign_id,
      business_summary: $json.research.business_summary,
      what_they_sell: $json.research.what_they_sell,
      who_their_customers_are: $json.research.who_their_customers_are,
      instagram_focus: $json.research.instagram_focus,
      business_model: $json.research.business_model,
      likely_decision_maker: $json.research.likely_decision_maker || {},
      cx_needs: $json.research.cx_needs,
      operational_pain_points: $json.research.operational_pain_points,
      specific_observations: $json.research.specific_observations,
      why_optiflow_relevant: $json.research.why_optiflow_relevant,
      recommended_service: $json.research.recommended_service,
      recommended_angle: $json.angle_id,
      confidence: $json.research.confidence,
      evidence: $json.research.evidence || [],
      model: $json.model,
      prompt_version: $json.prompt_version,
      raw_response: { text: $json.raw_response, angle_source: $json.angle_source }
    }) }}`
  }), { column: 9, row: 0 });

  const updateLead = wf.add(supabase('Update Lead Angle', {
    method: 'PATCH', path: 'leads', query: '?id=eq.{{ $json.lead_id }}',
    body: '={{ JSON.stringify({ outreach_angle: $json.angle_id, recommended_service: $json.research.recommended_service }) }}'
  }), { column: 10, row: 0 });

  const advanced = wf.add(advance('Advance To RESEARCHED', 'RESEARCHED', 'NEW', 'ai.research',
    '{ actor: "n8n:wf05", angle: $json.angle_id, confidence: $json.research.confidence }'), { column: 11, row: 0 });

  wf.chain(campaign, claimed, bandGate);
  wf.connect([bandGate, 0], fetchLead);
  wf.connect([bandGate, 1], holdForReview);
  wf.chain(fetchLead, buildPrompt, claude, parse, repairGate);
  wf.connect([repairGate, 0], store);
  wf.connect([repairGate, 1], repair);
  wf.connect(repair, parse);
  wf.chain(store, updateLead, advanced);

  const classify = wf.add(classifyFailure('wf05-research'), { column: 6, row: 3 });
  const fail = wf.add(failLead('wf05-research', 'Claude: Research'), { column: 7, row: 3 });
  wf.connect([claude, 1], classify);
  wf.connect(classify, fail);

  return wf.toJSON();
}
