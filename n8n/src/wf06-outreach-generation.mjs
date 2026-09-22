// WORKFLOW 6 - Personalised Outreach Generation
// RESEARCHED -> MESSAGE_GENERATED. Produces three variations, checks them
// against the rules that make a DM look automated, and queues them for a human.
// Nothing here can send anything.
import { workflow, schedule, subWorkflowTrigger, code, supabase, anthropic, switchNode } from '../dsl.mjs';
import { withLib, promptConst, schemaConst } from '../bundle.mjs';
import { loadCampaign, claim, advance, classifyFailure, failLead } from './_shared.mjs';

export function build() {
  const wf = workflow('wf06-outreach-generation', {
    description: 'Generate personalised Instagram DM variations for researched leads.',
    tags: ['optiflow', 'ai', 'outreach']
  });

  const cron = wf.add(schedule('Every 20 Minutes', '*/20 6-20 * * 1-5'));
  const called = wf.add(subWorkflowTrigger('Called By Orchestrator'), { column: 0, row: 1 });
  const campaign = wf.add(loadCampaign(), { column: 1, row: 0 });
  wf.connect(cron, campaign);
  wf.connect(called, campaign);

  const claimed = wf.add(claim('RESEARCHED', { worker: 'wf06-outreach-generation' }), { column: 2, row: 0 });

  const fetchContext = wf.add(supabase('Fetch Lead + Research', {
    method: 'GET',
    path: 'v_leads_full',
    query: '?lead_id=eq.{{ $json.id }}&select=*'
  }), { column: 3, row: 0 });

  const fetchResearch = wf.add(supabase('Fetch Research Brief', {
    method: 'GET',
    path: 'research',
    query: '?lead_id=eq.{{ $json[0].lead_id || $json.lead_id }}&select=*&order=created_at.desc&limit=1'
  }), { column: 4, row: 0 });

  const buildPrompt = wf.add(code('Render Outreach Prompt', withLib(['lib/prompts.js', 'lib/angles.js'], `
${promptConst('05-outreach-message.md', 'PROMPT')}

const campaign = $('Load Campaign + Niche').first().json;
const niche = campaign.niche || {};
const leads = $('Fetch Lead + Research').all().map((i) => Array.isArray(i.json) ? i.json[0] : i.json);
const out = [];

for (const [index, item] of $input.all().entries()) {
  const research = (Array.isArray(item.json) ? item.json[0] : item.json) || {};
  const row = leads[index] || leads[0];
  if (!row || !row.lead_id) continue;

  const resolved = resolveAngle(niche, research.recommended_angle || row.outreach_angle, {
    lead: { bio: row.bio, products_services: row.products_services },
    research,
    campaign
  });
  const angle = resolved.angle || { id: 'general', label: 'General', hook: 'how they currently handle inbound customer questions' };

  const rendered = renderPrompt(PROMPT, {
    lead: {
      business_name: row.business_name,
      instagram_handle: row.instagram_handle,
      city: row.city,
      state: row.state
    },
    niche,
    decision_maker: {
      address_as: row.decision_maker ? String(row.decision_maker).split(' ')[0] : null,
      contact_role: row.decision_maker_title
    },
    research: {
      business_summary: research.business_summary || row.business_summary || 'No research brief available.',
      what_they_sell: research.what_they_sell,
      instagram_focus: research.instagram_focus,
      specific_observations: research.specific_observations || [],
      operational_pain_points: research.operational_pain_points || [],
      cx_needs: research.cx_needs || [],
      recommended_service: research.recommended_service || row.recommended_service,
      why_optiflow_relevant: research.why_optiflow_relevant || 'Not recorded.'
    },
    angle,
    constraints: { max_chars: campaign.outreach?.max_chars ?? 500 },
    sender: { name: $env.OPTIFLOW_SENDER_NAME || 'Alex', company: 'OptiFlow Solutions' }
  });

  out.push({ json: {
    lead_id: row.lead_id,
    campaign_id: row.campaign_id,
    company_id: row.company_id,
    contact_id: row.contact_id ?? null,
    angle_id: angle.id,
    angle_source: resolved.source,
    max_chars: campaign.outreach?.max_chars ?? 500,
    wanted_variations: campaign.outreach?.variations ?? ['conversational', 'professional', 'concise'],
    default_variation: campaign.outreach?.default_variation ?? 'conversational',
    prompt: rendered.prompt,
    model: campaign.outreach?.model || $env.ANTHROPIC_MODEL_HEAVY || 'claude-opus-5',
    max_tokens: rendered.max_tokens,
    temperature: rendered.temperature,
    prompt_version: rendered.version
  } });
}
return out;
`)), { column: 5, row: 0 });

  const claude = wf.add(anthropic('Claude: Write DM Variations'), { column: 6, row: 0 });

  const guard = wf.add(code('Parse + Guardrails', withLib(['lib/json.js'], `
${schemaConst('outreach-message.schema.json', 'MESSAGE_SCHEMA')}

// Rules the model is told about in the prompt AND checked against here.
// The prompt is instruction; this is enforcement.
const BANNED = [
  'leading bpo', 'we are a leading', 'hope this message finds you well',
  'i wanted to reach out', 'love your page', 'love your feed', 'your content is amazing',
  'crushing it', 'i have been following', "i've been following", 'in today',
  'synergy', 'leverage your', 'streamline your operations', 'solutions provider',
  'quick call', 'when are you free', 'let me know asap', 'book a call',
  'best regards', 'dear sir', 'dear madam', 'to whom it may concern'
];

const inputs = $('Render Outreach Prompt').all().map((i) => i.json);
const out = [];

for (const [index, item] of $input.all().entries()) {
  const context = inputs[index] ?? inputs[0];
  const text = (item.json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\\n');
  const parsed = parseAiJson(text, MESSAGE_SCHEMA, { label: 'outreach message' });

  if (!parsed.ok) {
    out.push({ json: { ...context, needs_repair: true, repair_prompt: context.prompt + '\\n\\n' + parsed.retry_prompt, schema_errors: parsed.errors } });
    continue;
  }

  const data = parsed.data;
  const checked = data.variations.map((v) => {
    const message = String(v.message || '').trim();
    const lower = message.toLowerCase();
    const bannedHits = BANNED.filter((phrase) => lower.includes(phrase));
    const emojiCount = (message.match(/[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}]/gu) || []).length;
    const questionCount = (message.match(/\\?/g) || []).length;
    return {
      variation: v.variation,
      message,
      char_count: message.length,
      issues: [
        ...(bannedHits.length ? ['banned_phrase:' + bannedHits.join('|')] : []),
        ...(message.length > context.max_chars ? ['over_max_chars'] : []),
        ...(emojiCount > 1 ? ['too_many_emojis'] : []),
        ...(questionCount === 0 ? ['no_question'] : []),
        ...(questionCount > 2 ? ['too_many_questions'] : [])
      ]
    };
  });

  const clean = checked.filter((v) => v.issues.length === 0);
  const recommended = clean.find((v) => v.variation === data.recommended_variation)
    ?? clean.find((v) => v.variation === context.default_variation)
    ?? clean[0]
    ?? checked[0];

  out.push({ json: {
    ...context,
    needs_repair: false,
    variations: checked,
    rejected_variations: checked.filter((v) => v.issues.length > 0),
    chosen_variation: recommended.variation,
    message: recommended.message,
    char_count: recommended.char_count,
    // A draft with issues still reaches the human - flagged, not silently sent
    // and not silently dropped. The reviewer decides.
    review_flags: recommended.issues,
    personalisation: data.personalisation_used || [],
    self_check: data.self_check || {},
    usage: item.json.usage || {},
    raw_response: text
  } });
}
return out;
`), { notes: 'Character limits, banned phrases, emoji count and question count are enforced in code. A flagged draft still reaches the reviewer - it is never sent automatically and never silently discarded.' }), { column: 7, row: 0 });

  const repairGate = wf.add(switchNode('Valid Message?', '={{ $json.needs_repair ? "repair" : "ok" }}', [
    { name: 'ok', value: 'ok' },
    { name: 'repair', value: 'repair' }
  ]), { column: 8, row: 0 });

  const repair = wf.add(anthropic('Claude: Repair Message JSON', { promptField: '$json.repair_prompt', temperatureField: '0' }), { column: 8, row: 2 });

  const store = wf.add(supabase('Queue Draft For Approval', {
    method: 'POST', path: 'outreach',
    body: `={{ JSON.stringify({
      lead_id: $json.lead_id,
      campaign_id: $json.campaign_id,
      company_id: $json.company_id,
      contact_id: $json.contact_id,
      kind: 'initial',
      followup_step: 0,
      channel: 'instagram_dm',
      variation: $json.chosen_variation,
      variations: $json.variations,
      message: $json.message,
      char_count: $json.char_count,
      outreach_angle: $json.angle_id,
      personalisation: $json.personalisation,
      status: 'PENDING_REVIEW',
      model: $json.model,
      prompt_version: $json.prompt_version,
      notes: ($json.review_flags || []).length ? 'Review flags: ' + $json.review_flags.join(', ') : null
    }) }}`,
    notes: 'Status PENDING_REVIEW. There is no path from this workflow to a sent message - approval is a separate, human step.'
  }), { column: 9, row: 0 });

  const advanced = wf.add(advance('Advance To PENDING_APPROVAL', 'PENDING_APPROVAL', 'PENDING_REVIEW', 'outreach.generate',
    '{ actor: "n8n:wf06", variation: $json.chosen_variation, angle: $json.angle_id, flags: $json.review_flags }'), { column: 10, row: 0 });

  wf.chain(campaign, claimed, fetchContext, fetchResearch, buildPrompt, claude, guard, repairGate);
  wf.connect([repairGate, 0], store);
  wf.connect([repairGate, 1], repair);
  wf.connect(repair, guard);
  wf.connect(store, advanced);

  const classify = wf.add(classifyFailure('wf06-outreach-generation'), { column: 6, row: 3 });
  const fail = wf.add(failLead('wf06-outreach-generation', 'Claude: Write DM Variations'), { column: 7, row: 3 });
  wf.connect([claude, 1], classify);
  wf.connect(classify, fail);

  return wf.toJSON();
}
