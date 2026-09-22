// WORKFLOW 1 - Campaign / Lead Discovery
// Campaign settings -> search terms -> scraper -> normalised rows -> companies
// and leads at stage SCRAPED. Idempotent: rerunning it re-resolves the same
// businesses to the same company rows instead of creating duplicates.
import { workflow, schedule, subWorkflowTrigger, code, rpc, supabase, ifNode, splitInBatches, http, noop } from '../dsl.mjs';
import { withLib } from '../bundle.mjs';
import { loadCampaign, startRun, finishRun, classifyFailure, failLead } from './_shared.mjs';

export function build() {
  const wf = workflow('wf01-lead-discovery', {
    description: 'Discover businesses for a campaign and land them at stage SCRAPED.',
    tags: ['optiflow', 'discovery']
  });

  const cron = wf.add(schedule('Daily Discovery', '0 6 * * 1-5'));
  wf.newRow();
  const called = wf.add(subWorkflowTrigger('Called By Orchestrator'), { column: 0, row: 1 });
  wf.newRow();

  const campaign = wf.add(loadCampaign(), { column: 1, row: 0 });
  wf.connect(cron, campaign);
  wf.connect(called, campaign);

  const run = wf.add(startRun('wf01-lead-discovery'), { column: 2, row: 0 });

  const terms = wf.add(code('Build Search Terms', withLib(['lib/search-terms.js'], `
// Campaign targeting x the niche's search templates. Adding a city to the
// campaign widens discovery with no change here.
const campaign = $('Load Campaign + Niche').first().json;
const niche = campaign.niche || {};
const terms = buildSearchTerms(campaign, niche);
const hashtags = buildHashtags(campaign, niche);
const dailyTarget = campaign.discovery?.daily_lead_target ?? 100;
const perTerm = campaign.discovery?.max_results_per_search_term ?? 50;

return terms.map((term, index) => ({ json: {
  campaign_id: campaign.id,
  campaign,
  niche,
  term_index: index,
  term_total: terms.length,
  query: term.query,
  location: term.location,
  city: term.city,
  state: term.state,
  hashtags,
  per_term_limit: Math.min(perTerm, Math.ceil(dailyTarget / Math.max(1, terms.length)) * 2),
  sources: campaign.discovery?.sources ?? ['google_maps']
} }));
`), { notes: 'Each output item is one search term. The per-term limit is derived from the campaign daily target so a wide city list does not blow the budget.' }), { column: 3, row: 0 });

  const batches = wf.add(splitInBatches('For Each Search Term', 1), { column: 4, row: 0 });

  const scrape = wf.add(http('Run Scraper (Apify)', {
    method: 'POST',
    url: '=https://api.apify.com/v2/acts/{{ $env.APIFY_GOOGLE_MAPS_ACTOR }}/run-sync-get-dataset-items?token={{ $env.APIFY_TOKEN }}&timeout=300',
    body: `={{ JSON.stringify({
      searchStringsArray: [$json.query],
      locationQuery: $json.location,
      maxCrawledPlacesPerSearch: $json.per_term_limit,
      language: 'en',
      skipClosedPlaces: true,
      scrapeContacts: true
    }) }}`,
    timeout: 300000,
    notes: 'Replaceable. Any endpoint that returns rows lib/normalize.js can read works here - see config/providers.json capability "discovery" and lib/providers/discovery.*.js.'
  }), { column: 5, row: 0 });

  const normalise = wf.add(code('Normalise + Dedupe Batch', withLib(['lib/normalize.js', 'lib/dedupe.js'], `
// Merge before filtering: a sparse duplicate often carries the handle or phone
// that identifies a richer copy, so collapsing first loses nothing.
const term = $('For Each Search Term').first().json;
const rows = $input.all().map((i) => i.json).flatMap((r) => Array.isArray(r) ? r : [r]);

const normalised = rows
  .filter((row) => row && (row.title || row.name || row.username || row.business_name))
  .map((row) => normalizeRawLead({
    ...row,
    business_name: row.business_name ?? row.title ?? row.name ?? row.fullName,
    instagram_handle: row.instagram_handle ?? row.instagram ?? row.instagramUrl ?? row.username,
    category: row.category ?? row.categoryName,
    products_services: row.products_services ?? row.categories,
    place_id: row.place_id ?? row.placeId ?? row.fid,
    city: row.city ?? term.city,
    state: row.state ?? term.state,
    source: row.source ?? 'google_maps',
    search_term: term.query
  }));

const { unique, duplicates } = dedupeBatch(normalised);

return unique.map((lead) => ({ json: {
  campaign_id: term.campaign_id,
  lead,
  identity_keys: identityKeys(lead),
  batch_stats: { scraped: rows.length, normalised: normalised.length, unique: unique.length, in_batch_duplicates: duplicates.length },
  search_term: term.query
} }));
`), { notes: 'In-memory deduplication. The database is the second wall - resolve_company() matches on the same identity keys.' }), { column: 6, row: 0 });

  const resolve = wf.add(rpc('Resolve Company (dedupe)', 'resolve_company', `={{ JSON.stringify({
    p_name: $json.lead.business_name,
    p_name_normalized: $json.lead.name_normalized,
    p_instagram_handle: $json.lead.instagram_handle,
    p_website_domain: $json.lead.website_domain,
    p_phone_e164: $json.lead.phone_e164,
    p_email: $json.lead.email,
    p_city: $json.lead.city,
    p_state: $json.lead.state,
    p_place_id: $json.lead.place_id,
    p_attrs: $json.lead
  }) }}`, {
    notes: 'Returns the existing company when any identity key matches, otherwise creates one. Every key seen is recorded, so a later hit on ANY of them lands on the same row.'
  }), { column: 7, row: 0 });

  const suppressed = wf.add(rpc('Suppressed?', 'is_suppressed', '={{ JSON.stringify({ p_company_id: $json.id }) }}', {
    notes: 'Opt-outs and do-not-contact are checked before a lead is ever created.'
  }), { column: 8, row: 0 });

  const gate = wf.add(ifNode('Not Suppressed', {
    left: '={{ $json === false || $json.is_suppressed === false }}',
    operator: { type: 'boolean', operation: 'true', singleValue: true }
  }), { column: 9, row: 0 });

  const upsert = wf.add(rpc('Create Lead (SCRAPED)', 'upsert_lead', `={{ JSON.stringify({
    p_campaign_id: $('Normalise + Dedupe Batch').item.json.campaign_id,
    p_company_id: $('Resolve Company (dedupe)').item.json.id,
    p_source: $('Normalise + Dedupe Batch').item.json.lead.source,
    p_search_term: $('Normalise + Dedupe Batch').item.json.search_term
  }) }}`, {
    notes: 'unique(campaign_id, company_id) guarantees a business is never queued twice inside one campaign.'
  }), { column: 10, row: 0 });

  const skip = wf.add(noop('Skip Suppressed'), { column: 10, row: 1 });

  const summarise = wf.add(code('Summarise Batch', `
const items = $input.all();
const stats = $('Normalise + Dedupe Batch').all().map((i) => i.json.batch_stats).pop() || {};
return [{ json: {
  campaign_id: $('Load Campaign + Niche').first().json.id,
  items_in: stats.scraped || 0,
  items_ok: items.length,
  items_failed: 0,
  cursor: { last_search_term: $('For Each Search Term').first().json.query, term_index: $('For Each Search Term').first().json.term_index }
} }];
`), { column: 11, row: 0 });

  const finish = wf.add(finishRun('wf01-lead-discovery'), { column: 12, row: 0 });

  wf.chain(campaign, run, terms, batches);
  wf.connect([batches, 1], scrape);          // batch output
  wf.chain(scrape, normalise, resolve, suppressed, gate);
  wf.connect([gate, 0], upsert);
  wf.connect([gate, 1], skip);
  wf.connect(upsert, batches);               // loop back for the next search term
  wf.connect(skip, batches);
  wf.connect([batches, 0], summarise);       // done output
  wf.connect(summarise, finish);

  // Error path
  wf.newRow();
  const classify = wf.add(classifyFailure('wf01-lead-discovery'), { column: 6, row: 2 });
  const record = wf.add(supabase('Log Discovery Error', {
    method: 'POST', path: 'errors',
    body: `={{ JSON.stringify({ campaign_id: $json.campaign_id, workflow: $json.workflow, node: 'Run Scraper (Apify)', error_type: $json.error_type, message: $json.error_message, http_status: $json.http_status, payload: $json.payload, execution_id: $execution.id, next_retry_at: new Date(Date.now() + ($json.delay_ms || 60000)).toISOString() }) }}`,
    continueOnFail: true
  }), { column: 7, row: 2 });
  wf.connect([scrape, 1], classify);   // the node's error output
  wf.connect(classify, record);
  wf.connect(record, batches);

  return wf.toJSON();
}
