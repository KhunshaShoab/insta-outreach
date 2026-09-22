// End-to-end run of the logic layer: a CSV of raw rows goes in, approved-ready
// message drafts and a follow-up schedule come out. No network, no API keys -
// the mock AI adapter stands in for Claude so the whole path is exercised.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRawLead } from '../lib/normalize.js';
import { cleanLead } from '../lib/clean.js';
import { dedupeBatch } from '../lib/dedupe.js';
import { computeIcpScore, explainScore } from '../lib/scoring.js';
import { selectDecisionMaker } from '../lib/decision-maker.js';
import { resolveAngle } from '../lib/angles.js';
import { buildSchedule, shouldStopSequence } from '../lib/followups.js';
import { parseFrontMatter, renderPrompt } from '../lib/prompts.js';
import { validate } from '../lib/validate.js';
import { create as createMockAi } from '../lib/providers/ai.mock.js';
import { create as createCsvDiscovery, parseCsv } from '../lib/providers/discovery.csv.js';
import { ROOT, readJson, campaign, cleaningRules, scoringProfile, followupDefaults, nicheById } from './fixtures.mjs';

const niche = nicheById('medspas');
const ai = createMockAi({}, {});

const CSV = `business_name,instagram,website,city,state,phone,followers,posts,bio,products
Glow Med Spa LLC,@GlowMedSpa,https://glowmedspa.com,Los Angeles,California,(310) 555-1234,4200,430,"Botox, filler, laser. DM us for pricing.","Botox;Filler;Laser;HydraFacial"
Glow Medspa,glowmedspa,,Los Angeles,CA,,4100,,"duplicate of the row above",
Radiance Aesthetics,@radianceaesthetics,https://radianceaesthetics.com,San Diego,CA,(619) 555-9876,7800,210,"Medical spa in San Diego. Injectables and skin.","Botox;Dysport;Chemical peel"
Jessica Adams,@jess.adams,,Los Angeles,CA,,5400,220,"I'm a content creator and mom of two sharing my skincare journey",
PeakSupport BPO,@peaksupportbpo,https://peaksupportbpo.com,Los Angeles,CA,,3100,190,"Leading BPO and call center services for brands.","Customer support;Live chat"
Austin Glow Spa,@austinglowspa,https://austinglowspa.com,Austin,TX,(512) 555-2211,3300,150,"Medspa in Austin. Botox and filler.","Botox;Filler"
`;

function loadPrompt(file) {
  return parseFrontMatter(readFileSync(join(ROOT, 'prompts', file), 'utf8'));
}

test('a raw CSV batch runs the whole pipeline and only the right leads survive', async () => {
  // 1. DISCOVERY -------------------------------------------------------------
  const discovery = createCsvDiscovery({}, {});
  const rows = await discovery.discover(campaign, { rows: parseCsv(CSV) });
  assert.equal(rows.length, 6);

  // 2. NORMALISE + DEDUPLICATE ---------------------------------------------
  // Merging runs BEFORE filtering on purpose: a sparse duplicate row is often
  // rescued by a richer copy of the same business, and dropping it first would
  // throw away the handle or phone number that identifies it.
  const normalized = rows.map((row) => normalizeRawLead({
    ...row,
    products_services: row.products,
    ig_followers: row.followers,
    ig_posts: row.posts
  }));
  const { unique, duplicates } = dedupeBatch(normalized);
  assert.equal(duplicates.length, 1, 'the duplicated medspa collapses');
  assert.equal(duplicates[0].matched_on, 'instagram_handle');
  assert.equal(unique.length, 5);

  const merged = unique.find((l) => l.instagram_handle === 'glowmedspa');
  assert.equal(merged.website_domain, 'glowmedspa.com', 'the merged row keeps the website from the richer copy');
  assert.equal(merged.ig_followers, 4200, 'and the higher follower observation');

  // 3. CLEANING --------------------------------------------------------------
  const decisions = unique.map((lead) => ({ lead, ...cleanLead(lead, { campaign, niche, rules: cleaningRules }) }));
  const kept = decisions.filter((d) => d.keep);
  const dropped = decisions.filter((d) => !d.keep);

  const droppedReasons = Object.fromEntries(dropped.map((d) => [d.lead.business_name, d.reasons]));
  assert.ok(droppedReasons['Jessica Adams'].includes('personal_account'));
  assert.ok(droppedReasons['PeakSupport BPO'].includes('blocked_business_type'));
  assert.ok(droppedReasons['Austin Glow Spa'].includes('outside_target_location'));
  assert.equal(kept.length, 2, 'two distinct in-scope businesses survive');

  const glow = kept.map((d) => d.lead).find((l) => l.instagram_handle === 'glowmedspa');
  assert.ok(glow, 'the merged medspa survived cleaning');

  // 4. ENRICHMENT (simulated) + DECISION MAKER -------------------------------
  const contacts = [
    { full_name: 'Sarah Mitchell', title: 'Founder', email: 'sarah@glowmedspa.com', source_confidence: 0.9 },
    { full_name: 'Dana Reed', title: 'Front Office Manager', source_confidence: 0.6 }
  ];
  const dm = selectDecisionMaker(contacts, { employee_count: 8 });
  assert.equal(dm.contact.full_name, 'Sarah Mitchell');

  // 5. AI QUALIFICATION ------------------------------------------------------
  const qualPrompt = loadPrompt('01-qualification.md');
  const rendered = renderPrompt(qualPrompt, {
    campaign, niche,
    lead: { ...glow, flags: { niche_hits: ['medspa'] } },
    company: { company_size: '8', employee_count: 8 },
    contacts: contacts.map((c) => `${c.full_name} - ${c.title}`)
  });
  assert.ok(!rendered.prompt.includes('{{'));

  const { data: qual } = await ai.complete({ prompt: rendered.prompt, schema: readJson('schemas/qualification.schema.json') });
  assert.ok(validate(qual, readJson('schemas/qualification.schema.json')).valid);
  assert.equal(qual.disqualify, false);

  // 6. ICP SCORING -----------------------------------------------------------
  const scored = computeIcpScore({
    lead: { ...glow, days_since_last_post: 3, flags: { niche_hits: ['medspa', 'botox'] } },
    contact: dm.contact, campaign, profile: scoringProfile, ai: qual.ai_scores
  });
  assert.ok(scored.qualified, explainScore(scored));
  assert.ok(['HIGH_PRIORITY', 'QUALIFIED'].includes(scored.band));
  assert.match(explainScore(scored), /location_fit|niche_fit/);

  // 7. RESEARCH --------------------------------------------------------------
  const { data: research } = await ai.complete({ prompt: 'You are a business research analyst for OptiFlow Solutions.' });
  assert.ok(validate(research, readJson('schemas/research.schema.json')).valid);

  // 8. ANGLE + MESSAGE -------------------------------------------------------
  const angle = resolveAngle(niche, qual.recommended_outreach_angle, { lead: glow, research, campaign });
  assert.ok(niche.outreach_angles.some((a) => a.id === angle.angle.id));

  const messagePrompt = loadPrompt('05-outreach-message.md');
  const messageRendered = renderPrompt(messagePrompt, {
    lead: glow, niche, decision_maker: { address_as: 'Sarah', contact_role: 'Founder' },
    research: { ...research, recommended_service: research.recommended_service },
    angle: angle.angle, constraints: { max_chars: campaign.outreach.max_chars },
    sender: { name: 'Alex', company: 'OptiFlow Solutions' }
  });
  assert.ok(messageRendered.prompt.includes('Glow Med Spa'));
  assert.ok(messageRendered.prompt.includes('Sarah'));

  const { data: message } = await ai.complete({ prompt: 'You are the outreach writer for OptiFlow Solutions.' });
  assert.ok(validate(message, readJson('schemas/outreach-message.schema.json')).valid);
  assert.equal(message.variations.length, campaign.outreach.variations.length);
  for (const variation of message.variations) {
    assert.ok(variation.message.length <= campaign.outreach.max_chars);
  }

  // 9. FOLLOW-UP SCHEDULE ----------------------------------------------------
  const sentAt = new Date('2026-09-22T17:00:00Z');
  const schedule = buildSchedule(sentAt, campaign, followupDefaults);
  assert.equal(schedule.length, 3);
  assert.ok(new Date(schedule[0].due_at) > sentAt);

  // 10. A REPLY STOPS EVERYTHING --------------------------------------------
  const afterReply = shouldStopSequence({ replied_at: '2026-09-23T09:00:00Z', stage: 'REPLIED', status: 'REPLIED' });
  assert.equal(afterReply.stop, true);
  assert.equal(afterReply.reason, 'reply_received');
});

test('a lead that fails the campaign score threshold is not queued', () => {
  const weak = {
    business_name: 'Quiet Spa', instagram_handle: 'quietspa', city: 'Los Angeles', state: 'CA',
    ig_followers: 1100, products_count: 1, days_since_last_post: 180, website_domain: null,
    flags: { niche_hits: [] }
  };
  const result = computeIcpScore({
    lead: weak, contact: null, campaign, profile: scoringProfile,
    ai: { niche_fit: 50, business_quality: 40, website_quality: 20, cx_need: 35, outreach_potential: 30 }
  });
  assert.equal(result.qualified, false);
  assert.ok(result.icp_score < campaign.icp.min_icp_score);
});

test('the same business in two campaigns is scored independently', () => {
  const lead = { business_name: 'Glow', instagram_handle: 'glow', state: 'CA', city: 'Los Angeles', ig_followers: 4200, products_count: 5, days_since_last_post: 3, flags: { niche_hits: ['medspa'] } };
  const texas = readJson('config/campaigns/texas-dental.json');
  const inCa = computeIcpScore({ lead, contact: null, campaign, profile: scoringProfile, ai: { niche_fit: 90, business_quality: 80, website_quality: 70, cx_need: 80, outreach_potential: 80 } });
  const inTx = computeIcpScore({ lead, contact: null, campaign: texas, profile: scoringProfile, ai: { niche_fit: 90, business_quality: 80, website_quality: 70, cx_need: 80, outreach_potential: 80 } });
  assert.equal(inCa.qualified, true);
  assert.equal(inTx.qualified, false, 'a California business fails the Texas campaign geography gate');
  assert.ok(inTx.hard_gate_failures.includes('outside_target_state'));
});
