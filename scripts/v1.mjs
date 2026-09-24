#!/usr/bin/env node
// OptiFlow Lead Intelligence Engine - V1
//
// Attach a lead file, run it, review the output. Nothing is sent.
//
//   node scripts/v1.mjs --inspect <file.xlsx>
//   node scripts/v1.mjs --file <file.xlsx> --limit 15
//   node scripts/v1.mjs --file <file.xlsx> --limit 15 --sheet Leads --out out/run1
//
// Stages: ingest -> deduplicate -> research -> Instagram -> signals -> score
//         -> classify -> offer -> DM -> CSV + JSON -> human review.
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestFile, readLeadFile, detectColumns } from '../lib/v1/ingest.js';
import { dedupeLeads } from '../lib/v1/dedupe.js';
import { researchLead, researchSummary } from '../lib/v1/research.js';
import { discoverInstagram } from '../lib/v1/instagram.js';
import { buildSignals } from '../lib/v1/signals.js';
import { scoreLead } from '../lib/v1/score.js';
import { recommendOffer } from '../lib/v1/offer.js';
import { detectNiche, checkRelevance, checkExclusion, NICHE_RULES } from '../lib/v1/relevance.js';
import { writeCsv, writeJson, reviewTable, formatSignals } from '../lib/v1/output.js';
import { parseFrontMatter, renderPrompt } from '../lib/prompts.js';
import { parseAiJson } from '../lib/json.js';
import { create as createAnthropic } from '../lib/providers/ai.anthropic.js';
import { create as createMockAi } from '../lib/providers/ai.mock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) return process.argv[index + 1];
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.split('=').slice(1).join('=') : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

/** Stage 0: describe a file without processing it. */
function inspect(filePath) {
  const { sheet, sheetNames, headers, rows } = readLeadFile(filePath);
  const { mapping, unmapped } = detectColumns(headers);
  console.log(`\n${basename(filePath)}`);
  console.log(`  sheets: ${sheetNames.length ? sheetNames.join(', ') : 'n/a'}  (using "${sheet ?? 'csv'}")`);
  console.log(`  rows:   ${rows.length}`);
  console.log(`  columns mapped to the V1 schema:`);
  for (const [field, cols] of Object.entries(mapping)) console.log(`    ${field.padEnd(20)} <- ${cols.join(' / ')}`);
  if (unmapped.length) console.log(`  not mapped: ${unmapped.join(', ')}`);

  const { leads } = ingestFile(filePath);
  const { unique, duplicates, groups } = dedupeLeads(leads);
  const has = (f) => unique.filter((l) => l[f]).length;
  const pct = (n) => `${Math.round((n / Math.max(unique.length, 1)) * 100)}%`;
  console.log(`\n  after deduplication: ${unique.length} distinct businesses (${duplicates.length} merged)`);
  console.log(`    website   ${String(has('domain')).padStart(5)}  ${pct(has('domain'))}`);
  console.log(`    phone     ${String(has('phone_e164')).padStart(5)}  ${pct(has('phone_e164'))}`);
  console.log(`    email     ${String(has('email')).padStart(5)}  ${pct(has('email'))}`);
  console.log(`    instagram ${String(has('instagram')).padStart(5)}  ${pct(has('instagram'))}`);
  console.log(`    contact   ${String(has('contact_name')).padStart(5)}  ${pct(has('contact_name'))}`);
  if (groups.length) {
    console.log(`\n  ${groups.length} shared-website group(s) kept as separate locations, largest first:`);
    for (const g of groups.slice(0, 5)) console.log(`    ${g.domain} - ${g.count} businesses (${g.members.slice(0, 2).map((m) => m.company_name).join(', ')}...)`);
  }
  console.log('');
}

async function main() {
  if (flag('inspect')) {
    const file = arg('inspect') ?? arg('file');
    if (!file) { console.error('Usage: node scripts/v1.mjs --inspect <file.xlsx>'); process.exit(1); }
    inspect(file);
    return;
  }

  const file = arg('file');
  if (!file || !existsSync(file)) {
    console.error('Usage: node scripts/v1.mjs --file <file.xlsx|csv> [--limit 15] [--sheet Leads] [--out out/run1]');
    console.error('       node scripts/v1.mjs --inspect <file.xlsx>');
    process.exit(1);
  }

  const config = readJson('config/v1.json');
  const limit = Number(arg('limit', 15));
  const sheet = arg('sheet');
  const outBase = arg('out', join('out', `v1-${basename(file).replace(/\.[^.]+$/, '')}-${new Date().toISOString().slice(0, 10)}`));
  const offset = Number(arg('offset', 0));
  const dmPrompt = parseFrontMatter(readFileSync(join(ROOT, 'prompts/v1-instagram-dm.md'), 'utf8'));

  const useRealAi = Boolean(process.env.ANTHROPIC_API_KEY) && !flag('mock-ai');
  const ai = useRealAi
    ? createAnthropic(process.env, { models: { default: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5', heavy: process.env.ANTHROPIC_MODEL_HEAVY ?? 'claude-opus-5' } })
    : createMockAi({}, {});

  console.log(`\nOptiFlow Lead Intelligence Engine - V1`);
  console.log('='.repeat(78));
  console.log(`Input     ${basename(file)}${sheet ? ` (sheet "${sheet}")` : ''}`);
  console.log(`Batch     ${limit} lead(s)${offset ? `, skipping the first ${offset}` : ''}`);
  console.log(`DM writer ${useRealAi ? `Claude (${process.env.ANTHROPIC_MODEL_HEAVY ?? 'claude-opus-5'})` : 'MOCK - no ANTHROPIC_API_KEY set, so DM text is placeholder'}`);

  // --- 1. ingest -----------------------------------------------------------
  const ingested = ingestFile(file, { sheet });
  console.log(`\n[1/9] Ingest        ${ingested.leads.length} rows read from "${ingested.sheet ?? 'csv'}"`);

  // --- 2. deduplicate ------------------------------------------------------
  const { unique, duplicates, groups } = dedupeLeads(ingested.leads);
  console.log(`[2/9] Deduplicate   ${unique.length} distinct, ${duplicates.length} merged, ${groups.length} shared-website group(s) kept separate`);

  // --- 3. relevance --------------------------------------------------------
  // Scraped categories are unreliable, so each lead is checked against the
  // file's own dominant niche before it can reach the outreach batch.
  const nicheOverride = arg('niche');
  const detected = nicheOverride ? { niche: nicheOverride, confidence: 'HIGH', matched: 0 } : detectNiche(unique);
  const nicheRule = NICHE_RULES[detected.niche] ?? NICHE_RULES.generic;
  for (const lead of unique) Object.assign(lead, checkRelevance(lead, detected.niche), checkExclusion(lead));
  const offNiche = unique.filter((l) => l.niche_match === 'OFF_NICHE').length;
  const uncertain = unique.filter((l) => l.niche_match === 'UNCERTAIN').length;
  const excluded = unique.filter((l) => l.excluded).length;
  console.log(`[3/9] Relevance     niche "${detected.niche}" (${nicheRule.label}, ${detected.confidence.toLowerCase()} confidence): ${unique.length - offNiche - uncertain} in niche, ${uncertain} uncertain, ${offNiche} off niche`);
  console.log(`      Excluded      ${excluded} competitor(s) / agency(s) / reseller(s) that must not be pitched`);

  // Best-documented, in-niche leads first: a first test should exercise the
  // whole pipeline, and an off-niche row with no website exercises very little.
  const nicheRank = { IN_NICHE: 0, UNCERTAIN: 1, OFF_NICHE: 2 };
  const ranked = [...unique].sort((a, b) =>
    (a.excluded ? 1 : 0) - (b.excluded ? 1 : 0) ||
    nicheRank[a.niche_match] - nicheRank[b.niche_match] ||
    (b.domain ? 1 : 0) - (a.domain ? 1 : 0) ||
    (b.review_count ?? 0) - (a.review_count ?? 0)
  );
  const batch = ranked.slice(offset, offset + limit);
  console.log(`[4/9] Batch         ${batch.length} lead(s) selected (in niche, then website, then review volume)`);

  // --- 4-7. research, Instagram, signals, score, offer ---------------------
  const concurrency = Number(config.research?.concurrency ?? 4);
  const records = [];
  let done = 0;

  async function processLead(lead, index) {
    const evidence = await researchLead(lead, { timeoutMs: config.research?.timeout_ms ?? 15000 });
    const instagram = discoverInstagram(lead, evidence);
    const signals = buildSignals(lead, evidence);
    const scores = scoreLead(lead, { evidence, signals, instagram, bands: config.bands });
    const offer = recommendOffer(lead, { scores, signals });

    done += 1;
    process.stdout.write(`\r      research      ${done}/${batch.length} sites checked`);

    return {
      lead_id: `${lead.source_file}:${lead.original_row}`,
      ...lead,
      ...scores,
      ...instagram,
      ...offer,
      signals,
      opportunity_signals: formatSignals(signals),
      research_summary: researchSummary(lead, evidence),
      evidence_sources: evidence.evidence_sources ?? [],
      evidence,
      review_status: config.review?.default_status ?? 'PENDING',
      duplicate_of: '',
      related_locations: (lead.related_locations ?? []).map((r) => `${r.company_name} (${r.city ?? '?'})`).join(' | '),
      _index: index
    };
  }

  console.log(`[5/9] Research      reading websites, ${concurrency} at a time`);
  for (let i = 0; i < batch.length; i += concurrency) {
    const slice = batch.slice(i, i + concurrency);
    const results = await Promise.all(slice.map((lead, j) => processLead(lead, i + j)));
    records.push(...results);
  }
  process.stdout.write('\n');
  const reachable = records.filter((r) => r.evidence.website_reachable).length;
  const igFound = records.filter((r) => r.business_instagram).length;
  console.log(`      ${reachable}/${records.length} websites readable, ${igFound} Instagram account(s) identified`);

  console.log(`[6/9] Signals       ${records.reduce((n, r) => n + r.signals.length, 0)} evidence-backed signal(s) across the batch`);
  const byClass = {};
  for (const r of records) byClass[r.classification] = (byClass[r.classification] ?? 0) + 1;
  console.log(`[7/9] Score         ${Object.entries(byClass).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const byOffer = {};
  for (const r of records) byOffer[r.recommended_offer] = (byOffer[r.recommended_offer] ?? 0) + 1;
  console.log(`[8/9] Offer         ${Object.entries(byOffer).map(([k, v]) => `${k} ${v}`).join(', ')}`);

  // --- 8. DM, only where the evidence supports an approach -----------------
  const wantsDm = (r) =>
    !r.excluded &&
    r.niche_match === 'IN_NICHE' &&
    (config.research?.generate_dm_for_classifications ?? ['BEST', 'GOOD']).includes(r.classification) &&
    (config.research?.generate_dm_for_offers ?? ['CUSTOMER_SUPPORT', 'AI_VOICE', 'BOTH']).includes(r.recommended_offer);

  const dmTargets = records.filter(wantsDm);
  console.log(`[9/9] DM            writing ${dmTargets.length} message(s) (BEST/GOOD with a recommended offer only)`);

  for (const record of records) {
    if (!wantsDm(record)) {
      record.personalized_instagram_dm = '';
      record.pipeline_notes = record.excluded
        ? record.exclusion_reason
        : record.niche_match !== 'IN_NICHE'
        ? `No DM written: ${record.niche_match_reason}`
        : record.recommended_offer === 'NONE'
          ? 'No DM written: the evidence does not support an approach.'
          : `No DM written: classification ${record.classification} is below the threshold for outreach.`;
      continue;
    }
    const service = config.services[record.recommended_offer === 'BOTH' ? 'AI_VOICE' : record.recommended_offer]
      ?? config.services.AI_VOICE;
    try {
      const rendered = renderPrompt(dmPrompt, {
        lead: record,
        instagram: {
          business_instagram: record.business_instagram,
          owner_first_name: record.owner_name ? String(record.owner_name).split(' ')[0] : null
        },
        signals: record.signals.filter((s) => s.confidence !== 'LOW').slice(0, 6),
        research_summary: record.research_summary,
        offer: { ...record, capability_line: service.capability_line },
        constraints: { max_chars: config.outreach?.max_chars ?? 500 },
        sender: { name: config.outreach?.sender_name ?? 'Alex', company: config.outreach?.sender_company ?? 'OptiFlow Solutions' }
      });

      const response = await ai.complete({
        prompt: rendered.prompt,
        model: 'heavy',
        maxTokens: rendered.max_tokens,
        temperature: rendered.temperature
      });
      const parsed = useRealAi
        ? { ok: true, data: response.data }
        : parseAiJson(JSON.stringify({
            personalized_instagram_dm: `[MOCK - no API key] Would open with: "${record.signals[0]?.evidence?.slice(0, 90) ?? 'no evidence'}" and offer ${service.label}.`,
            char_count: 0,
            observation_used: record.signals[0]?.evidence ?? null,
            capability_mentioned: service.label,
            why_this_message: `Mock output. With an API key this is written by Claude from the ${record.signals.filter((s) => s.confidence !== 'LOW').length} non-low-confidence signal(s).`,
            self_check: { opens_with_verified_observation: true, no_invented_facts: true, no_assumed_pain: true, one_capability_only: true, ends_with_question: true, under_max_chars: true }
          }), null);

      record.personalized_instagram_dm = parsed.data.personalized_instagram_dm ?? '';
      record.dm_observation_used = parsed.data.observation_used ?? null;
      record.dm_capability = parsed.data.capability_mentioned ?? null;
      record.dm_self_check = parsed.data.self_check ?? {};
      record.pipeline_notes = parsed.data.why_this_message ?? '';
      const failed = Object.entries(record.dm_self_check).filter(([, v]) => v === false).map(([k]) => k);
      if (failed.length) record.pipeline_notes += ` FLAGGED: the writer's own checks failed (${failed.join(', ')}) - read this one carefully.`;
    } catch (error) {
      record.personalized_instagram_dm = '';
      record.pipeline_notes = `DM generation failed: ${error.message.slice(0, 200)}`;
    }
  }

  // --- output --------------------------------------------------------------
  mkdirSync(dirname(join(ROOT, `${outBase}.csv`)), { recursive: true });
  const csvPath = join(ROOT, `${outBase}.csv`);
  const jsonPath = join(ROOT, `${outBase}.json`);
  const ordered = [...records].sort((a, b) => b.overall_score - a.overall_score);

  writeCsv(csvPath, ordered);
  writeJson(jsonPath, {
    run: {
      at: new Date().toISOString(),
      input_file: basename(file),
      sheet: ingested.sheet,
      rows_read: ingested.leads.length,
      distinct_after_dedupe: unique.length,
      merged: duplicates.length,
      batch_size: batch.length,
      niche: detected,
      dm_writer: useRealAi ? 'claude' : 'mock',
      config: { bands: config.bands, offer_thresholds: config.offer_thresholds, score_caps: config.score_caps }
    },
    leads: ordered.map(({ evidence, signals, original_record, ...rest }) => ({ ...rest, signals, evidence, original_record })),
    duplicates,
    shared_website_groups: groups
  });

  console.log(`\n${reviewTable(ordered)}\n`);
  console.log(`Wrote ${ordered.length} lead(s):`);
  console.log(`  ${csvPath.replace(`${ROOT}/`, '')}   <- open in Excel or import to Google Sheets`);
  console.log(`  ${jsonPath.replace(`${ROOT}/`, '')}  <- full evidence for every lead`);
  console.log(`\nAll rows are review_status=PENDING. Nothing has been sent, and this`);
  console.log(`pipeline has no way to send anything.\n`);
  if (!useRealAi) {
    console.log(`DM text is placeholder: set ANTHROPIC_API_KEY and re-run to have Claude`);
    console.log(`write the messages from the evidence above.\n`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  await main();
}
