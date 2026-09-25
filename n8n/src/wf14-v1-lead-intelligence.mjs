// WORKFLOW 14 - V1 Lead Intelligence Engine (n8n)
//
// Upload a lead file to a form, get back scored, researched, message-ready
// leads in a Google Sheet. This is the CLI in scripts/v1.mjs expressed as a
// workflow, sharing the same tested lib/v1 modules - the Code nodes are
// generated from that source, not retyped.
//
// It cannot send anything. The last step writes a spreadsheet for a human.
import {
  workflow, formTrigger, manualTrigger, extractFromFile, code, http, anthropic,
  ifNode, switchNode, splitInBatches, googleSheets, convertToFile, noop, sticky
} from '../dsl.mjs';
import { withLib, configConst, promptConst, schemaConst } from '../bundle.mjs';

export function build() {
  const wf = workflow('wf14-v1-lead-intelligence', {
    description: 'Upload a lead file: clean, deduplicate, find Instagram, score, classify and draft a message for each business. Nothing is sent.',
    tags: ['optiflow', 'v1', 'lead-intelligence']
  });

  // --- 1. input ------------------------------------------------------------
  const form = wf.add(formTrigger('Upload Lead File', {
    title: 'OptiFlow - Lead Intelligence',
    description: 'Attach an .xlsx or .csv lead list. You will get scored leads with a draft message in the review sheet. Nothing is sent to anyone.',
    fields: [
      { fieldLabel: 'Lead File', fieldType: 'file', acceptFileTypes: '.xlsx,.csv', multipleFiles: false, requiredField: true },
      { fieldLabel: 'How many leads this run', fieldType: 'number', requiredField: false, placeholder: '15' },
      { fieldLabel: 'Skip the first N leads', fieldType: 'number', requiredField: false, placeholder: '0' }
    ],
    notes: 'Open the production URL of this node and drag the file in. The two number fields let you work through a big file in batches.'
  }));

  const manual = wf.add(manualTrigger('Run Manually'), { column: 0, row: 1 });

  const detect = wf.add(code('Detect File Type', `
// The upload arrives as binary. Which extractor runs depends on the extension,
// so read it from the file name rather than trusting the browser's MIME type.
const item = $input.first();
const binary = item.binary ?? {};
const key = Object.keys(binary)[0];
if (!key) {
  throw new Error('No file was uploaded. Attach an .xlsx or .csv file and submit the form again.');
}
const fileName = binary[key].fileName ?? 'upload';
const extension = String(fileName).toLowerCase().split('.').pop();
if (!['xlsx', 'xlsm', 'csv', 'tsv'].includes(extension)) {
  throw new Error(\`Cannot read "\${fileName}". Upload an .xlsx or .csv file.\`);
}

const form = item.json ?? {};
return [{
  json: {
    file_name: fileName,
    binary_property: key,
    file_type: extension === 'csv' || extension === 'tsv' ? 'csv' : 'xlsx',
    limit: Number(form['How many leads this run'] ?? 15) || 15,
    offset: Number(form['Skip the first N leads'] ?? 0) || 0
  },
  binary
}];
`, { notes: 'Fails with a readable message rather than silently producing zero leads.' }), { column: 1, row: 0 });

  const route = wf.add(switchNode('Spreadsheet Or CSV', '={{ $json.file_type }}', [
    { name: 'xlsx', value: 'xlsx' },
    { name: 'csv', value: 'csv' }
  ]), { column: 2, row: 0 });

  const readXlsx = wf.add(extractFromFile('Read Spreadsheet', {
    operation: 'xlsx', binaryProperty: '={{ $json.binary_property }}',
    notes: 'Reads the first sheet. If your file keeps leads on a named sheet, set it in the node options.'
  }), { column: 3, row: 0 });

  const readCsv = wf.add(extractFromFile('Read CSV', {
    operation: 'csv', binaryProperty: '={{ $json.binary_property }}'
  }), { column: 3, row: 1 });

  // --- 2. clean, deduplicate, check relevance ------------------------------
  const clean = wf.add(code('Clean, Deduplicate, Check Niche', withLib(
    ['lib/v1/map-columns.js', 'lib/v1/dedupe.js', 'lib/v1/relevance.js', 'lib/v1/schema.js'], `
${configConst('config/v1.json', 'V1_CONFIG')}

// Every row the spreadsheet reader produced, whatever its column names.
const rows = $input.all().map((item, index) => ({ ...item.json, __row: index + 2 }));
if (!rows.length) throw new Error('The file was read but contained no rows.');

const meta = $('Detect File Type').first().json;
const headers = Object.keys(rows[0]).filter((k) => k !== '__row');
const { mapping, unmapped } = detectColumns(headers);
if (!mapping.company_name) {
  throw new Error(
    'No column in the file looks like a company name. Headers found: ' + headers.join(', ') +
    '. Rename the column to "Business Name" or "Company" and upload again.'
  );
}

// Map to the internal schema, keeping the original row for traceability.
const leads = [];
for (const row of rows) {
  const lead = mapRow(row, mapping, { sourceFile: meta.file_name, sourceLabel: 'n8n_upload' });
  if (lead.company_name) leads.push(lead);
}

// Merge before filtering: a sparse duplicate often carries the phone or website
// that identifies a richer copy of the same business.
const { unique, duplicates, groups } = dedupeLeads(leads);

// Scraped categories are unreliable, so relevance is checked against the file's
// own dominant niche, using the business NAME as well as the category.
const detectedNiche = detectNiche(unique);
// Relevance and exclusion are separate questions: a hotel is the wrong niche,
// an outsourcing company is a competitor. Both keep a lead out of outreach.
for (const lead of unique) Object.assign(lead, checkRelevance(lead, detectedNiche.niche), checkExclusion(lead));

// In-niche and best-documented leads first - a run should spend its website
// requests on leads that can actually produce evidence.
const nicheRank = { IN_NICHE: 0, UNCERTAIN: 1, OFF_NICHE: 2 };
const ranked = [...unique].sort((a, b) =>
  (a.excluded ? 1 : 0) - (b.excluded ? 1 : 0) ||
  nicheRank[a.niche_match] - nicheRank[b.niche_match] ||
  (b.domain ? 1 : 0) - (a.domain ? 1 : 0) ||
  (b.review_count ?? 0) - (a.review_count ?? 0)
);
const batch = ranked.slice(meta.offset, meta.offset + meta.limit);

const run = {
  file_name: meta.file_name,
  rows_read: rows.length,
  distinct: unique.length,
  merged: duplicates.length,
  shared_website_groups: groups.length,
  niche: detectedNiche.niche,
  niche_confidence: detectedNiche.confidence,
  in_niche: unique.filter((l) => l.niche_match === 'IN_NICHE').length,
  off_niche: unique.filter((l) => l.niche_match === 'OFF_NICHE').length,
  excluded: unique.filter((l) => l.excluded).length,
  batch_size: batch.length,
  unmapped_columns: unmapped
};

return batch.map((lead) => ({ json: { ...lead, _run: run } }));
`), { notes: 'One node covers cleaning, deduplication and the niche check because they share the same inlined modules. Deduplication never merges two businesses that only share a corporate website.' }),
    { column: 4, row: 0 });

  const anyLeads = wf.add(ifNode('Any Leads To Process?', {
    left: '={{ $json.company_name ? true : false }}',
    operator: { type: 'boolean', operation: 'true', singleValue: true }
  }), { column: 5, row: 0 });

  const nothing = wf.add(noop('Nothing To Process'), { column: 6, row: 2 });

  // --- 3. one lead at a time ----------------------------------------------
  const loop = wf.add(splitInBatches('For Each Lead', 1), { column: 6, row: 0 });

  const urls = wf.add(code('Build Page URLs', `
// Two requests per lead: the homepage, and the contact page where most phone
// and channel evidence lives. The CLI in scripts/v1.mjs also follows careers
// and FAQ links; this keeps the workflow graph simple.
const lead = $input.first().json;
if (!lead.domain) {
  return [{ json: { ...lead, _skip_fetch: true, _pages: [] } }];
}
return [
  { json: { ...lead, _page_url: 'https://' + lead.domain + '/', _page_label: 'homepage' } },
  { json: { ...lead, _page_url: 'https://' + lead.domain + '/contact', _page_label: 'contact' } }
];
`), { column: 7, row: 0 });

  const hasDomain = wf.add(ifNode('Has A Website?', {
    left: '={{ $json._skip_fetch ? false : true }}',
    operator: { type: 'boolean', operation: 'true', singleValue: true }
  }), { column: 8, row: 0 });

  const fetchPage = wf.add(http('Fetch Page', {
    method: 'GET',
    url: '={{ $json._page_url }}',
    headers: [
      { name: 'User-Agent', value: 'Mozilla/5.0 (compatible; OptiFlowResearchBot/1.0; +contact: ops@optiflow.example)' },
      { name: 'Accept', value: 'text/html,application/xhtml+xml' }
    ],
    timeout: 15000,
    retry: false,
    continueOnFail: true,
    errorOutput: false,
    notes: 'continueOnFail is deliberate: a small-business site behind bot protection returns 403, and that is recorded as a caveat rather than failing the lead. Expect 60-85% of sites to be readable.'
  }), { column: 9, row: 0 });

  const noFetch = wf.add(noop('Skip Fetch (No Website)'), { column: 9, row: 1 });

  // --- 4. evidence, Instagram, signals, score, offer ----------------------
  const analyse = wf.add(code('Extract Evidence, Score, Recommend', withLib(
    ['lib/v1/research.js', 'lib/v1/instagram.js', 'lib/v1/signals.js', 'lib/v1/score.js', 'lib/v1/offer.js', 'lib/v1/format.js', 'lib/v1/schema.js'], `
${configConst('config/v1.json', 'V1_CONFIG')}

// The lead being processed this pass of the loop.
const lead = $('For Each Lead').first().json;

// Whatever the fetches returned. A failed request still arrives here, with its
// status, because "the site could not be read" is itself evidence.
const pages = [];
for (const item of $input.all()) {
  const json = item.json ?? {};
  if (json._skip_fetch) continue;
  const html = typeof json.data === 'string' ? json.data
    : typeof json.body === 'string' ? json.body
    : typeof json === 'string' ? json : '';
  const status = json.error?.status ?? json.statusCode ?? (html ? 200 : null);
  pages.push({
    url: json._page_url ?? json.url ?? ('https://' + (lead.domain ?? 'unknown')),
    label: json._page_label ?? 'homepage',
    html,
    ok: Boolean(html) && (!status || status < 400),
    status,
    error: json.error?.message ?? null
  });
}

const evidence = pages.length ? extractEvidence(pages, { domain: lead.domain }) : createEvidence();
if (!lead.domain) evidence.notes = 'No website in the source file, so no website research was possible.';

const instagram = discoverInstagram(lead, evidence);
const signals = buildSignals(lead, evidence);
const scores = scoreLead(lead, { evidence, signals, instagram, bands: V1_CONFIG.bands });
const offer = recommendOffer(lead, { scores, signals });

// Only in-niche leads that scored well enough and have a service to lead with
// get a message written for them.
const wantsMessage =
  !lead.excluded &&
  lead.niche_match === 'IN_NICHE' &&
  (V1_CONFIG.research?.generate_dm_for_classifications ?? ['BEST', 'GOOD']).includes(scores.classification) &&
  (V1_CONFIG.research?.generate_dm_for_offers ?? ['CUSTOMER_SUPPORT', 'AI_VOICE', 'BOTH']).includes(offer.recommended_offer);

const service = V1_CONFIG.services[offer.recommended_offer === 'BOTH' ? 'AI_VOICE' : offer.recommended_offer]
  ?? V1_CONFIG.services.AI_VOICE;

return [{ json: {
  ...lead,
  ...scores,
  ...instagram,
  ...offer,
  lead_id: lead.source_file + ':' + lead.original_row,
  signals,
  opportunity_signals: formatSignals(signals),
  research_summary: researchSummary(lead, evidence),
  evidence_sources: (evidence.evidence_sources ?? []).join(' | '),
  website_reachable: evidence.website_reachable,
  review_status: V1_CONFIG.review?.default_status ?? 'PENDING',
  wants_message: wantsMessage,
  capability_line: service.capability_line,
  service_label: service.label,
  related_locations: (lead.related_locations ?? []).map((r) => r.company_name + ' (' + (r.city ?? '?') + ')').join(' | ')
} }];
`), { notes: 'The scoring, signal and Instagram-confidence rules are the inlined lib/v1 source, so they match the 40 tests that cover them.' }),
    { column: 10, row: 0 });

  const needsMessage = wf.add(ifNode('Write A Message?', {
    left: '={{ $json.wants_message }}',
    operator: { type: 'boolean', operation: 'true', singleValue: true }
  }, { notes: 'In-niche, BEST or GOOD, and a recommended offer. Everything else gets a stated reason instead of a message.' }), { column: 11, row: 0 });

  const renderPromptNode = wf.add(code('Render Message Prompt', withLib(['lib/prompts.js'], `
${promptConst('v1-instagram-dm.md', 'DM_PROMPT')}
${configConst('config/v1.json', 'V1_CONFIG')}

const lead = $input.first().json;

// The writer sees only signals that are not low confidence, so a weak guess
// cannot become the opening line of a real message.
const usable = (lead.signals ?? []).filter((s) => s.confidence !== 'LOW').slice(0, 6);

const rendered = renderPrompt(DM_PROMPT, {
  lead,
  instagram: {
    business_instagram: lead.business_instagram,
    owner_first_name: lead.owner_name ? String(lead.owner_name).split(' ')[0] : null
  },
  signals: usable,
  research_summary: lead.research_summary,
  offer: { recommended_offer: lead.recommended_offer, offer_reason: lead.offer_reason, capability_line: lead.capability_line },
  constraints: { max_chars: V1_CONFIG.outreach?.max_chars ?? 500 },
  sender: { name: $env.OPTIFLOW_SENDER_NAME || V1_CONFIG.outreach?.sender_name || 'Alex', company: V1_CONFIG.outreach?.sender_company || 'OptiFlow Solutions' }
});

return [{ json: { ...lead, prompt: rendered.prompt, model: $env.ANTHROPIC_MODEL_HEAVY || 'claude-opus-5', max_tokens: rendered.max_tokens, temperature: rendered.temperature, prompt_version: rendered.version } }];
`), { notes: 'Rendering throws if a required variable is missing, so a half-filled prompt is never sent to the model.' }), { column: 12, row: 0 });

  const claude = wf.add(anthropic('Claude: Write The Message'), { column: 13, row: 0 });

  const parseDm = wf.add(code('Parse Message', withLib(['lib/json.js', 'lib/v1/compose-dm.js'], `
${schemaConst('v1-dm.schema.json', 'DM_SCHEMA')}

const lead = $('Render Message Prompt').first().json;
const response = $input.first().json;
const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\\n');
const parsed = parseAiJson(text, DM_SCHEMA, { label: 'v1 dm' });

if (!parsed.ok) {
  // A message that cannot be validated is not shown as if it were fine - but an
  // empty cell on a qualified lead is worse, so it is composed from the same
  // evidence in code, and the note says which wrote it.
  const composed = composeDm(lead, { sender: { name: $env.OPTIFLOW_SENDER_NAME || 'Alex', company: 'OptiFlow Solutions' } });
  return [{ json: {
    ...lead,
    personalized_instagram_dm: composed.personalized_instagram_dm,
    dm_observation_used: composed.observation_used,
    dm_capability: composed.capability_mentioned,
    dm_written_by: 'template',
    pipeline_notes: 'Claude returned a message that did not validate (' + parsed.errors.slice(0, 2).join('; ') + '), so this was composed in code from the same evidence. ' + composed.why_this_message
  } }];
}

const data = parsed.data;
const failedChecks = Object.entries(data.self_check ?? {}).filter(([, v]) => v === false).map(([k]) => k);

return [{ json: {
  ...lead,
  personalized_instagram_dm: data.personalized_instagram_dm ?? '',
  dm_observation_used: data.observation_used ?? null,
  dm_capability: data.capability_mentioned ?? null,
  dm_written_by: 'claude',
  pipeline_notes: (data.why_this_message ?? '') +
    (failedChecks.length ? ' FLAGGED: the writer\\'s own checks failed (' + failedChecks.join(', ') + ') - read this one carefully before sending.' : '')
} }];
`)), { column: 14, row: 0 });

  const composeFallback = wf.add(code('Compose Message In Code', withLib(['lib/v1/compose-dm.js'], `
// The Claude node's error output lands here: a rate limit, a timeout, a missing
// credential. The lead qualified, so it gets a message composed from its own
// signals under the same rules, rather than an empty cell and a shrug.
const lead = $('Render Message Prompt').first().json;
const composed = composeDm(lead, { sender: { name: $env.OPTIFLOW_SENDER_NAME || 'Alex', company: 'OptiFlow Solutions' } });
const failed = Object.entries(composed.self_check).filter(([, v]) => v === false).map(([k]) => k);
return [{ json: {
  ...lead,
  personalized_instagram_dm: composed.personalized_instagram_dm,
  dm_observation_used: composed.observation_used,
  dm_capability: composed.capability_mentioned,
  dm_written_by: 'template',
  pipeline_notes: 'The Claude call did not complete, so this was composed in code from the same evidence. ' + composed.why_this_message +
    (failed.length ? ' FLAGGED: ' + failed.join(', ') + ' - read this one carefully.' : '')
} }];
`), { notes: 'A qualified lead never reaches the sheet with an empty message because a model call failed.' }), { column: 14, row: 1 });

  const noMessage = wf.add(code('Record Why No Message', `
const lead = $input.first().json;
const reason = lead.excluded
  ? lead.exclusion_reason
  : lead.niche_match !== 'IN_NICHE'
  ? 'No message: ' + lead.niche_match_reason
  : lead.recommended_offer === 'NONE'
    ? 'No message: the evidence does not support an approach. ' + lead.offer_reason
    : 'No message: classification ' + lead.classification + ' is below the threshold for outreach.';
return [{ json: { ...lead, personalized_instagram_dm: '', pipeline_notes: reason } }];
`, { notes: 'A skipped lead still reaches the sheet, with the reason. Nothing disappears silently.' }), { column: 12, row: 1 });

  const collect = wf.add(code('Shape Row For The Sheet', withLib(['lib/v1/schema.js'], `
// Exactly the columns in the review sheet, in order, so the Google Sheets node
// can map them automatically.
const lead = $input.first().json;
const row = {};
for (const field of OUTPUT_FIELDS) row[field] = lead[field] ?? '';
row.score_reasons = Array.isArray(lead.score_reasons) ? lead.score_reasons.join('\\n') : (lead.score_reasons ?? '');
row.evidence_sources = lead.evidence_sources ?? '';
return [{ json: row }];
`)), { column: 15, row: 0 });

  // --- 5. output ----------------------------------------------------------
  const sheet = wf.add(googleSheets('Append To Review Sheet', {
    documentId: '={{ $env.GOOGLE_SHEETS_SPREADSHEET_ID }}',
    sheetName: '={{ $env.GOOGLE_SHEETS_TAB || "Leads" }}',
    notes: 'Add a Google Sheets OAuth credential named "Google Sheets (OptiFlow)" and put the spreadsheet id in GOOGLE_SHEETS_SPREADSHEET_ID. The sheet\'s first row must hold the column names - run once and paste the header from the CSV if the sheet is empty. Disable this node to use the CSV download instead.'
  }), { column: 17, row: 0 });

  const csv = wf.add(convertToFile('Build CSV Download', {
    fileName: 'optiflow-leads.csv',
    notes: 'The same rows as a CSV, in case you would rather not connect Google Sheets.'
  }), { column: 17, row: 1 });

  const summary = wf.add(code('Run Summary', `
const rows = $input.all().map((i) => i.json);
const count = (field, value) => rows.filter((r) => r[field] === value).length;
return [{ json: {
  leads_processed: rows.length,
  best: count('classification', 'BEST'),
  good: count('classification', 'GOOD'),
  review: count('classification', 'REVIEW'),
  bad: count('classification', 'BAD'),
  instagram_high_confidence: count('instagram_confidence', 'HIGH'),
  instagram_not_found: count('instagram_confidence', 'NOT_FOUND'),
  ai_voice: count('recommended_offer', 'AI_VOICE'),
  customer_support: count('recommended_offer', 'CUSTOMER_SUPPORT'),
  both: count('recommended_offer', 'BOTH'),
  no_offer: count('recommended_offer', 'NONE'),
  messages_written: rows.filter((r) => r.personalized_instagram_dm).length,
  all_rows_pending_review: rows.every((r) => r.review_status === 'PENDING'),
  note: 'Nothing was sent. Open the review sheet, read the evidence, then send the messages you approve by hand.'
} }];
`), { column: 16, row: 0 });

  const note = wf.add(sticky('How To Use This', [
    '## V1 Lead Intelligence',
    '',
    '1. Open the **Upload Lead File** node and copy its production URL.',
    '2. Open that URL, attach your .xlsx or .csv, set how many leads to process.',
    '3. Results land in the Google Sheet (or the CSV, if you disable that node).',
    '',
    '**Required:** an *Anthropic API Key* header-auth credential.',
    '**Optional:** a *Google Sheets (OptiFlow)* OAuth credential.',
    '',
    'Every row is written `review_status = PENDING`.',
    'This workflow has no way to send an Instagram message - that stays manual.',
    '',
    'Start with 15 leads. Each lead makes 2 website requests and at most 1 Claude call.'
  ].join('\n'), { width: 460, height: 340 }), { column: 0, row: 3 });

  // --- wiring -------------------------------------------------------------
  wf.connect(form, detect);
  wf.connect(manual, detect);
  wf.chain(detect, route);
  wf.connect([route, 0], readXlsx);
  wf.connect([route, 1], readCsv);
  wf.connect(readXlsx, clean);
  wf.connect(readCsv, clean);
  wf.chain(clean, anyLeads);
  wf.connect([anyLeads, 0], loop);
  wf.connect([anyLeads, 1], nothing);

  wf.connect([loop, 1], urls);            // per-lead output
  wf.chain(urls, hasDomain);
  wf.connect([hasDomain, 0], fetchPage);
  wf.connect([hasDomain, 1], noFetch);
  wf.connect(fetchPage, analyse);
  wf.connect(noFetch, analyse);
  wf.chain(analyse, needsMessage);
  wf.connect([needsMessage, 0], renderPromptNode);
  wf.connect([needsMessage, 1], noMessage);
  wf.chain(renderPromptNode, claude, parseDm);
  wf.connect(parseDm, collect);
  wf.connect(noMessage, collect);
  // A model failure must not lose the lead: it still reaches the sheet.
  wf.connect([claude, 1], composeFallback);
  wf.chain(composeFallback, collect);
  wf.connect(collect, loop);              // next lead

  wf.connect([loop, 0], summary);         // loop finished
  wf.chain(summary, sheet);
  wf.connect(summary, csv);

  return wf.toJSON();
}
