#!/usr/bin/env node
// Run the whole logic pipeline against a CSV, with no network, no API keys and
// no database. Discovery comes from the file; Claude is replaced by the mock
// adapter. Every other step is the real code.
//
//   node scripts/dry-run.mjs                          # built-in sample rows
//   node scripts/dry-run.mjs leads.csv ca-medspas     # your file, your campaign
//
// Use it to see what a campaign's rules would actually do - which businesses
// survive cleaning, what they score and why - before spending anything.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRawLead } from '../lib/normalize.js';
import { cleanLead } from '../lib/clean.js';
import { dedupeBatch } from '../lib/dedupe.js';
import { computeIcpScore, explainScore } from '../lib/scoring.js';
import { selectDecisionMaker } from '../lib/decision-maker.js';
import { resolveAngle } from '../lib/angles.js';
import { buildSchedule } from '../lib/followups.js';
import { parseFrontMatter, renderPrompt } from '../lib/prompts.js';
import { validate } from '../lib/validate.js';
import { parseCsv } from '../lib/providers/discovery.csv.js';
import { create as createMockAi } from '../lib/providers/ai.mock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const prompt = (file) => parseFrontMatter(readFileSync(join(ROOT, 'prompts', file), 'utf8'));

const SAMPLE = `business_name,instagram,website,city,state,phone,followers,posts,bio,products
Glow Med Spa LLC,@GlowMedSpa,https://glowmedspa.com,Los Angeles,California,(310) 555-1234,4200,430,"Botox, filler, laser. DM us for pricing.","Botox;Filler;Laser;HydraFacial"
Glow Medspa,glowmedspa,,Los Angeles,CA,,4100,,duplicate of the row above,
Radiance Aesthetics,@radianceaesthetics,https://radianceaesthetics.com,San Diego,CA,(619) 555-9876,7800,210,"Medical spa. Injectables and skin.","Botox;Dysport;Peel"
Jessica Adams,@jess.adams,,Los Angeles,CA,,5400,220,"I'm a content creator and mom of two sharing my skincare journey",
PeakSupport BPO,@peaksupportbpo,https://peaksupportbpo.com,Los Angeles,CA,,3100,190,"Leading BPO and call center services.","Customer support;Live chat"
Austin Glow Spa,@austinglowspa,https://austinglowspa.com,Austin,TX,(512) 555-2211,3300,150,"Medspa in Austin.","Botox;Filler"
Tiny New Clinic,@tinynewclinic,https://tinynewclinic.com,Irvine,CA,,640,12,"New medspa in Irvine. Botox.","Botox"
`;

async function main() {
  const [, , fileArg, campaignArg] = process.argv;
  const campaignId = campaignArg ?? 'ca-medspas';

  const campaignFile = readdirSync(join(ROOT, 'config/campaigns'))
    .map((f) => ({ f, c: read(join('config/campaigns', f)) }))
    .find(({ c }) => c.id === campaignId);
  if (!campaignFile) {
    console.error(`No campaign "${campaignId}" in config/campaigns/. Available: ${readdirSync(join(ROOT, 'config/campaigns')).join(', ')}`);
    process.exit(1);
  }

  const campaign = campaignFile.c;
  const niche = read('config/niches.json').niches.find((n) => n.id === campaign.niche_id);
  const scoring = read('config/scoring.default.json');
  const cleaning = read('config/cleaning.json');
  const followupDefaults = read('config/followups.default.json');
  const ai = createMockAi({}, {});

  const csv = fileArg
    ? (existsSync(fileArg) ? readFileSync(fileArg, 'utf8') : (console.error(`No such file: ${fileArg}`), process.exit(1)))
    : SAMPLE;

  console.log(`\nDry run - ${campaign.name} (${campaign.id})`);
  console.log(`Niche: ${niche.name} | States: ${campaign.targeting.states.join(', ')} | ` +
              `Followers ${campaign.icp.min_followers}-${campaign.icp.max_followers} | ` +
              `Min products ${campaign.icp.min_products_services} | Min ICP ${campaign.icp.min_icp_score}`);
  console.log(`Source: ${fileArg ?? 'built-in sample rows'}\n${'='.repeat(72)}`);

  // 1-2. Normalise, then merge duplicates before filtering.
  const rows = parseCsv(csv);
  const normalised = rows.map((row) => normalizeRawLead({
    ...row, products_services: row.products, ig_followers: row.followers, ig_posts: row.posts
  }));
  const { unique, duplicates } = dedupeBatch(normalised);

  console.log(`\nDISCOVERY   ${rows.length} rows in`);
  console.log(`DEDUPE      ${unique.length} distinct businesses, ${duplicates.length} duplicate(s) merged`);
  for (const dup of duplicates) {
    console.log(`            "${dup.lead.business_name}" merged into "${dup.duplicate_of.business_name}" on ${dup.matched_on}`);
  }

  // 3. Cleaning.
  const decisions = unique.map((lead) => ({ lead, ...cleanLead(lead, { campaign, niche, rules: cleaning }) }));
  const kept = decisions.filter((d) => d.keep);
  console.log(`\nCLEANING    ${kept.length} kept, ${decisions.length - kept.length} dropped`);
  for (const d of decisions.filter((x) => !x.keep)) {
    console.log(`            DROP  ${d.lead.business_name.padEnd(24)} ${d.reasons.join(', ')}`);
  }

  // 4-8. Everything downstream, per surviving lead.
  const queued = [];
  for (const { lead, flags } of kept) {
    // Enrichment is stubbed here - the point of the dry run is the rules, not
    // the provider. A lead with no contact is kept on purpose.
    const contacts = lead.instagram_handle === 'glowmedspa'
      ? [{ full_name: 'Sarah Mitchell', title: 'Founder', email: 'sarah@glowmedspa.com', source_confidence: 0.9 }]
      : [];
    const dm = selectDecisionMaker(contacts, { ig_followers: lead.ig_followers });

    const { data: qual } = await ai.complete({ prompt: 'You are an ICP qualification analyst for OptiFlow Solutions.' });
    const scored = computeIcpScore({
      lead: { ...lead, days_since_last_post: 5, flags },
      contact: dm.contact, campaign, profile: scoring, ai: qual.ai_scores
    });

    console.log(`\n${'-'.repeat(72)}\n${lead.business_name}  (@${lead.instagram_handle})`);
    console.log(`  ICP ${scored.icp_score}/100  ${scored.band}  ${scored.qualified ? 'QUALIFIED' : 'NOT QUALIFIED'}`);
    const top = Object.entries(scored.components).sort((a, b) => b[1].weight * b[1].score - a[1].weight * a[1].score).slice(0, 4);
    for (const [name, c] of top) {
      console.log(`    ${name.padEnd(20)} ${String(c.score).padStart(3)}/100  weight ${String(c.weight).padStart(2)}  ${c.note ?? c.source}`);
    }
    if (scored.hard_gate_failures.length) console.log(`    hard gates failed: ${scored.hard_gate_failures.join(', ')}`);
    if (scored.penalties.length) console.log(`    penalties: ${scored.penalties.map((p) => `${p.id} -${p.amount}`).join(', ')}`);
    console.log(`    decision maker: ${dm.contact?.full_name ?? 'none found (lead continues)'}`);

    if (!scored.qualified) continue;

    const { data: research } = await ai.complete({ prompt: 'You are a business research analyst for OptiFlow Solutions.' });
    const angle = resolveAngle(niche, qual.recommended_outreach_angle, { lead, research, campaign });

    // Render the real outreach prompt so a missing variable surfaces here.
    renderPrompt(prompt('05-outreach-message.md'), {
      lead, niche,
      decision_maker: { address_as: dm.contact?.first_name ?? null, contact_role: dm.contact?.title },
      research: { ...research, recommended_service: research.recommended_service },
      angle: angle.angle,
      constraints: { max_chars: campaign.outreach.max_chars },
      sender: { name: process.env.OPTIFLOW_SENDER_NAME ?? 'Alex', company: 'OptiFlow Solutions' }
    });

    const { data: message } = await ai.complete({ prompt: 'You are the outreach writer for OptiFlow Solutions.' });
    const schemaOk = validate(message, read('schemas/outreach-message.schema.json')).valid;

    console.log(`    angle: ${angle.angle.id} (${angle.source})`);
    console.log(`    service: ${research.recommended_service}`);
    console.log(`    message variations: ${message.variations.length}, schema ${schemaOk ? 'ok' : 'INVALID'}`);
    console.log(`    -> would enter the approval queue as PENDING_REVIEW`);
    queued.push(lead);
  }

  const schedule = buildSchedule(new Date(), campaign, followupDefaults);
  console.log(`\n${'='.repeat(72)}`);
  console.log(`\nWOULD QUEUE  ${queued.length} message(s) for human review`);
  console.log(`FOLLOW-UPS   ${schedule.map((s) => `${s.kind} on day ${s.day_offset}`).join(', ')}`);
  console.log(`SENT         0 - nothing is sent by this system without a person\n`);
  console.log('Mock AI responses stand in for Claude, so the wording above is placeholder text.');
  console.log('The filtering, scoring, angle selection and prompt rendering are the real code.\n');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  await main();
}
