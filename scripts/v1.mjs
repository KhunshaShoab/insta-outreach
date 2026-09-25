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
import { composeDm } from '../lib/v1/compose-dm.js';
import { parseFrontMatter, renderPrompt } from '../lib/prompts.js';
import { create as createAnthropic } from '../lib/providers/ai.anthropic.js';

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
  // Without a key the composer writes the messages instead, so no mock provider
  // is needed - `ai` is only ever reached on the real path.
  const ai = useRealAi
    ? createAnthropic(process.env, { models: { default: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5', heavy: process.env.ANTHROPIC_MODEL_HEAVY ?? 'claude-opus-5' } })
    : null;

  console.log(`\nOptiFlow Lead Intelligence Engine - V1`);
  console.log('='.repeat(78));
  console.log(`Input     ${basename(file)}${sheet ? ` (sheet "${sheet}")` : ''}`);
  console.log(`Batch     ${limit} lead(s)${offset ? `, skipping the first ${offset}` : ''}`);
  console.log(`DM writer ${useRealAi ? `Claude (${process.env.ANTHROPIC_MODEL_HEAVY ?? 'claude-opus-5'})` : 'template composer - no ANTHROPIC_API_KEY set, so messages are built in code from each lead\'s evidence'}`);

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
  const concurrency = Number(arg('concurrency', config.research?.concurrency ?? 4));
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
  // A pool rather than lockstep slices: on a long run one site that sits out its
  // full timeout would otherwise stall every other lead in its slice.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, async () => {
    for (let i = next++; i < batch.length; i = next++) {
      try {
        records.push(await processLead(batch[i], i));
      } catch (error) {
        // One unreadable lead must not end the run: keep the row, say why.
        done += 1;
        records.push({
          lead_id: `${batch[i].source_file}:${batch[i].original_row}`,
          ...batch[i],
          overall_score: 0, customer_support_score: 0, ai_voice_score: 0,
          classification: 'REVIEW', instagram_confidence: 'NOT_FOUND',
          recommended_offer: 'NONE', signals: [], opportunity_signals: '',
          research_summary: `Processing failed: ${error.message.slice(0, 200)}`,
          evidence_sources: [], evidence: { website_reachable: false },
          review_status: config.review?.default_status ?? 'PENDING',
          duplicate_of: '', related_locations: '', _index: i
        });
      }
    }
  }));
  process.stdout.write('\n');
  records.sort((a, b) => a._index - b._index);
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

    // No API key means no Claude. Composing the message in code from the same
    // signals beats shipping a placeholder, and it is honest about what wrote it.
    if (!useRealAi) {
      const composed = composeDm(record, {
        sender: { name: config.outreach?.sender_name ?? 'Alex', company: config.outreach?.sender_company ?? 'OptiFlow Solutions' },
        maxChars: config.outreach?.max_chars ?? 500
      });
      record.personalized_instagram_dm = composed.personalized_instagram_dm;
      record.dm_observation_used = composed.observation_used;
      record.dm_capability = composed.capability_mentioned;
      record.dm_self_check = composed.self_check;
      record.dm_written_by = 'template';
      record.pipeline_notes = `${composed.why_this_message} Composed in code (lib/v1/compose-dm.js) under the rules in prompts/v1-instagram-dm.md, because no ANTHROPIC_API_KEY is set in the run environment - edit freely before sending.`;
      const failedChecks = Object.entries(composed.self_check).filter(([, v]) => v === false).map(([k]) => k);
      if (failedChecks.length) record.pipeline_notes += ` FLAGGED: ${failedChecks.join(', ')} - read this one carefully.`;
      continue;
    }

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
      const parsed = { ok: true, data: response.data };
      record.dm_written_by = 'claude';

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
      dm_writer: useRealAi ? 'claude' : 'template',
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
    console.log(`Messages were composed in code from each lead's evidence, because no`);
    console.log(`ANTHROPIC_API_KEY is set. To have Claude rewrite them without re-reading`);
    console.log(`any website: ANTHROPIC_API_KEY=... node scripts/v1.mjs --recompose ${outBase}.json\n`);
  }
}

/**
 * Rewrite the messages in a finished run from its saved evidence.
 *
 * Research is the expensive half - 2,000-odd page fetches for a full list - and
 * the evidence it produced is already in the JSON. This regenerates only the
 * message column, so adding an API key later costs nothing but the model calls.
 */
async function recompose(jsonPath) {
  const config = readJson('config/v1.json');
  const saved = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const dmPrompt = parseFrontMatter(readFileSync(join(ROOT, 'prompts/v1-instagram-dm.md'), 'utf8'));
  const useRealAi = Boolean(process.env.ANTHROPIC_API_KEY) && !flag('mock-ai');
  const ai = useRealAi
    ? createAnthropic(process.env, { models: { default: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5', heavy: process.env.ANTHROPIC_MODEL_HEAVY ?? 'claude-opus-5' } })
    : null;
  const sender = { name: config.outreach?.sender_name ?? 'Alex', company: config.outreach?.sender_company ?? 'OptiFlow Solutions' };
  const maxChars = config.outreach?.max_chars ?? 500;

  const wantsDm = (r) =>
    !r.excluded &&
    r.niche_match === 'IN_NICHE' &&
    (config.research?.generate_dm_for_classifications ?? ['BEST', 'GOOD']).includes(r.classification) &&
    (config.research?.generate_dm_for_offers ?? ['CUSTOMER_SUPPORT', 'AI_VOICE', 'BOTH']).includes(r.recommended_offer);

  const targets = saved.leads.filter(wantsDm);
  console.log(`\nRecomposing ${targets.length} message(s) from ${basename(jsonPath)}`);
  console.log(`Writer: ${useRealAi ? `Claude (${process.env.ANTHROPIC_MODEL_HEAVY ?? 'claude-opus-5'})` : 'template composer (no ANTHROPIC_API_KEY)'}\n`);

  let n = 0;
  for (const record of saved.leads) {
    if (!wantsDm(record)) continue;
    n += 1;
    process.stdout.write(`\r  ${n}/${targets.length}`);
    const service = config.services[record.recommended_offer === 'BOTH' ? 'AI_VOICE' : record.recommended_offer] ?? config.services.AI_VOICE;

    if (!useRealAi) {
      const composed = composeDm(record, { sender, maxChars });
      record.personalized_instagram_dm = composed.personalized_instagram_dm;
      record.dm_observation_used = composed.observation_used;
      record.dm_capability = composed.capability_mentioned;
      record.dm_self_check = composed.self_check;
      record.dm_written_by = 'template';
      record.pipeline_notes = `${composed.why_this_message} Composed in code (lib/v1/compose-dm.js) under the rules in prompts/v1-instagram-dm.md, because no ANTHROPIC_API_KEY is set in the run environment - edit freely before sending.`;
      const failed = Object.entries(composed.self_check).filter(([, v]) => v === false).map(([k]) => k);
      if (failed.length) record.pipeline_notes += ` FLAGGED: ${failed.join(', ')} - read this one carefully.`;
      continue;
    }

    try {
      const rendered = renderPrompt(dmPrompt, {
        lead: record,
        instagram: { business_instagram: record.business_instagram, owner_first_name: record.owner_name ? String(record.owner_name).split(' ')[0] : null },
        signals: (record.signals ?? []).filter((s) => s.confidence !== 'LOW').slice(0, 6),
        research_summary: record.research_summary,
        offer: { ...record, capability_line: service.capability_line },
        constraints: { max_chars: maxChars },
        sender
      });
      const response = await ai.complete({ prompt: rendered.prompt, model: 'heavy', maxTokens: rendered.max_tokens, temperature: rendered.temperature });
      record.personalized_instagram_dm = response.data.personalized_instagram_dm ?? '';
      record.dm_observation_used = response.data.observation_used ?? null;
      record.dm_capability = response.data.capability_mentioned ?? null;
      record.dm_self_check = response.data.self_check ?? {};
      record.dm_written_by = 'claude';
      record.pipeline_notes = response.data.why_this_message ?? '';
      const failed = Object.entries(record.dm_self_check).filter(([, v]) => v === false).map(([k]) => k);
      if (failed.length) record.pipeline_notes += ` FLAGGED: the writer's own checks failed (${failed.join(', ')}) - read this one carefully.`;
    } catch (error) {
      // Fall back rather than leave the row empty; the note says which wrote it.
      const composed = composeDm(record, { sender, maxChars });
      record.personalized_instagram_dm = composed.personalized_instagram_dm;
      record.dm_self_check = composed.self_check;
      record.dm_written_by = 'template';
      record.pipeline_notes = `Claude call failed (${error.message.slice(0, 120)}), so this was composed in code from the same evidence. ${composed.why_this_message}`;
    }
  }
  process.stdout.write('\n');

  saved.run.dm_writer = useRealAi ? 'claude' : 'template';
  saved.run.recomposed_at = new Date().toISOString();
  writeJson(jsonPath, saved);
  const csvPath = jsonPath.replace(/\.json$/, '.csv');
  writeCsv(csvPath, saved.leads);
  console.log(`\nRewrote:\n  ${csvPath}\n  ${jsonPath}\n`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const recomposeTarget = arg('recompose');
  if (recomposeTarget) await recompose(recomposeTarget);
  else await main();
}
