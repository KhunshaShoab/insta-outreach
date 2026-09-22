// WORKFLOW 4 - AI Qualification + ICP Scoring
// ENRICHED -> QUALIFIED or DISQUALIFIED.
// The model supplies judgement sub-scores and a reason; the final 0-100 score
// is computed in code so it is reproducible and every point is explainable.
import { workflow, schedule, subWorkflowTrigger, code, supabase, anthropic, switchNode } from '../dsl.mjs';
import { withLib, configConst, promptConst, schemaConst } from '../bundle.mjs';
import { loadCampaign, claim, advance, classifyFailure, failLead } from './_shared.mjs';

export function build() {
  const wf = workflow('wf04-qualification', {
    description: 'Qualify enriched leads with Claude and compute the ICP score.',
    tags: ['optiflow', 'ai', 'qualification']
  });

  const cron = wf.add(schedule('Every 15 Minutes', '*/15 6-20 * * 1-5'));
  const called = wf.add(subWorkflowTrigger('Called By Orchestrator'), { column: 0, row: 1 });
  const campaign = wf.add(loadCampaign(), { column: 1, row: 0 });
  wf.connect(cron, campaign);
  wf.connect(called, campaign);

  const claimed = wf.add(claim('ENRICHED', { worker: 'wf04-qualification' }), { column: 2, row: 0 });

  const fetchLead = wf.add(supabase('Fetch Lead Detail', {
    method: 'GET',
    path: 'v_leads_full',
    query: '?lead_id=eq.{{ $json.id }}&select=*',
    notes: 'The flat view: company facts, the chosen decision maker and the campaign in one row.'
  }), { column: 3, row: 0 });

  const buildPrompt = wf.add(code('Render Qualification Prompt', withLib(['lib/prompts.js', 'lib/normalize.js'], `
${promptConst('01-qualification.md', 'PROMPT')}

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
    ig_is_business: row.ig_is_business,
    ig_is_private: row.ig_is_private,
    bio: row.bio,
    website: row.website,
    website_domain: row.website_domain,
    website_description: row.business_summary,
    category: row.niche_name,
    city: row.city,
    state: row.state,
    products_services: row.products_services || [],
    products_count: row.products_count,
    days_since_last_post: daysSince(row.ig_last_post_at)
  };

  const contacts = row.decision_maker
    ? [\`\${row.decision_maker} - \${row.decision_maker_title || 'role unknown'}\${row.decision_maker_email ? ' - ' + row.decision_maker_email : ''}\`]
    : [];

  const rendered = renderPrompt(PROMPT, {
    campaign, niche, lead,
    company: { company_size: row.company_size, employee_count: row.employee_count },
    contacts
  });

  out.push({ json: {
    lead_id: row.lead_id,
    campaign_id: row.campaign_id,
    company_id: row.company_id,
    lead,
    contact: row.decision_maker ? { full_name: row.decision_maker, title: row.decision_maker_title, role_category: row.decision_maker_role, email: row.decision_maker_email, linkedin_url: row.decision_maker_linkedin } : null,
    prompt: rendered.prompt,
    model: campaign.qualification?.model || $env.ANTHROPIC_MODEL || 'claude-sonnet-5',
    max_tokens: rendered.max_tokens,
    temperature: rendered.temperature,
    prompt_version: rendered.version
  } });
}
return out;
`), { notes: 'The prompt file prompts/01-qualification.md is inlined at build time. Rendering throws if a required variable is missing, so a half-filled prompt is never sent.' }), { column: 4, row: 0 });

  const claude = wf.add(anthropic('Claude: Qualify'), { column: 5, row: 0 });

  const parse = wf.add(code('Parse + Score', withLib(['lib/json.js', 'lib/scoring.js'], `
${schemaConst('qualification.schema.json', 'QUALIFICATION_SCHEMA')}
${configConst('config/scoring.default.json', 'SCORING_PROFILE')}

const campaign = $('Load Campaign + Niche').first().json;
const inputs = $('Render Qualification Prompt').all().map((i) => i.json);
const out = [];

for (const [index, item] of $input.all().entries()) {
  const context = inputs[index] ?? inputs[0];
  const response = item.json;
  const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\\n');
  const parsed = parseAiJson(text, QUALIFICATION_SCHEMA, { label: 'qualification' });

  if (!parsed.ok) {
    // Send the item down the repair path with the validator's own error list.
    out.push({ json: { ...context, needs_repair: true, repair_prompt: context.prompt + '\\n\\n' + parsed.retry_prompt, raw_response: text, schema_errors: parsed.errors } });
    continue;
  }

  const ai = parsed.data;
  const scored = computeIcpScore({
    lead: { ...context.lead, flags: { niche_hits: [] } },
    contact: context.contact,
    campaign,
    profile: SCORING_PROFILE,
    ai: ai.ai_scores
  });

  const disqualified = ai.disqualify || !scored.qualified;

  out.push({ json: {
    ...context,
    needs_repair: false,
    decision: disqualified ? 'DISQUALIFIED' : 'QUALIFIED',
    qualified: !disqualified,
    icp_score: scored.icp_score,
    icp_band: scored.band,
    priority: scored.priority,
    component_scores: scored.components,
    ai_scores: ai.ai_scores,
    hard_gate_failures: scored.hard_gate_failures,
    penalties: scored.penalties,
    reason: ai.reason,
    explanation: explainScore(scored),
    potential_pain_points: ai.potential_pain_points,
    recommended_service: ai.recommended_service,
    recommended_angle: ai.recommended_outreach_angle,
    decision_maker_found: ai.decision_maker_found,
    disqualify_reason: ai.disqualify ? ai.disqualify_reason : (scored.hard_gate_failures[0] || (scored.icp_score < (campaign.icp?.min_icp_score ?? 70) ? 'below_min_icp_score' : null)),
    usage: response.usage || {},
    raw_response: text
  } });
}
return out;
`), { notes: 'The model never returns the final score. computeIcpScore() blends its judgement with measured facts, so the same lead always scores the same and explainScore() can justify every point.' }), { column: 6, row: 0 });

  const repairGate = wf.add(switchNode('Valid Response?', '={{ $json.needs_repair ? "repair" : "ok" }}', [
    { name: 'ok', value: 'ok' },
    { name: 'repair', value: 'repair' }
  ]), { column: 7, row: 0 });

  const repair = wf.add(anthropic('Claude: Repair JSON', { promptField: '$json.repair_prompt', temperatureField: '0' }), { column: 7, row: 2 });

  const store = wf.add(supabase('Store Qualification Result', {
    method: 'POST',
    path: 'qualification_results',
    body: `={{ JSON.stringify({
      lead_id: $json.lead_id,
      campaign_id: $json.campaign_id,
      qualified: $json.qualified,
      icp_score: $json.icp_score,
      icp_band: $json.icp_band,
      priority: $json.priority,
      component_scores: $json.component_scores,
      ai_scores: $json.ai_scores,
      deterministic_scores: $json.component_scores,
      hard_gate_failures: $json.hard_gate_failures,
      reason: ($json.reason || '') + ' | ' + ($json.explanation || ''),
      potential_pain_points: $json.potential_pain_points,
      recommended_service: $json.recommended_service,
      recommended_angle: $json.recommended_angle,
      decision_maker_found: $json.decision_maker_found,
      model: $json.model,
      prompt_version: $json.prompt_version,
      tokens_in: $json.usage?.input_tokens ?? null,
      tokens_out: $json.usage?.output_tokens ?? null,
      scoring_profile_id: 'default',
      raw_response: { text: $json.raw_response }
    }) }}`,
    notes: 'Every run is kept. Re-qualifying a lead after a config change leaves the previous verdict in place for comparison.'
  }), { column: 8, row: 0 });

  const updateLead = wf.add(supabase('Update Lead Score', {
    method: 'PATCH',
    path: 'leads',
    query: '?id=eq.{{ $json.lead_id }}',
    body: `={{ JSON.stringify({
      icp_score: $json.icp_score,
      icp_band: $json.icp_band,
      priority: $json.priority,
      qualified: $json.qualified,
      recommended_service: $json.recommended_service,
      outreach_angle: $json.recommended_angle,
      disqualified_reason: $json.disqualify_reason
    }) }}`
  }), { column: 9, row: 0 });

  const route = wf.add(switchNode('Qualified?', '={{ $json.decision }}', [
    { name: 'qualified', value: 'QUALIFIED' },
    { name: 'disqualified', value: 'DISQUALIFIED' }
  ]), { column: 10, row: 0 });

  const advanceOk = wf.add(advance('Advance To QUALIFIED', 'QUALIFIED', 'NEW', 'ai.qualify',
    '{ actor: "n8n:wf04", icp_score: $json.icp_score, band: $json.icp_band }'), { column: 11, row: 0 });
  const advanceNo = wf.add(advance('Advance To DISQUALIFIED', 'DISQUALIFIED', 'CLOSED', 'ai.qualify',
    '{ actor: "n8n:wf04", reason: $json.disqualify_reason, icp_score: $json.icp_score }'), { column: 11, row: 1 });

  wf.chain(campaign, claimed, fetchLead, buildPrompt, claude, parse, repairGate);
  wf.connect([repairGate, 0], store);
  wf.connect([repairGate, 1], repair);
  wf.connect(repair, parse);              // one correction turn, then through the same parser
  wf.chain(store, updateLead, route);
  wf.connect([route, 0], advanceOk);
  wf.connect([route, 1], advanceNo);

  const classify = wf.add(classifyFailure('wf04-qualification'), { column: 5, row: 3 });
  const fail = wf.add(failLead('wf04-qualification', 'Claude: Qualify'), { column: 6, row: 3 });
  wf.connect([claude, 1], classify);
  wf.connect([fetchLead, 1], classify);
  wf.connect(classify, fail);

  return wf.toJSON();
}
