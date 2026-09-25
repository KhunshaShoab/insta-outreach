// Tests for the V1 lead intelligence pipeline. No network: research evidence is
// supplied as fixtures so the scoring, signal and offer logic is tested directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readXlsx } from '../lib/v1/xlsx.js';
import { detectColumns, mapRow, ingestFile } from '../lib/v1/ingest.js';
import { dedupeLeads, compareLeads } from '../lib/v1/dedupe.js';
import { buildSignals, splitSignals } from '../lib/v1/signals.js';
import { scoreLead } from '../lib/v1/score.js';
import { recommendOffer } from '../lib/v1/offer.js';
import { discoverInstagram } from '../lib/v1/instagram.js';
import { checkRelevance, detectNiche } from '../lib/v1/relevance.js';
import { extractEvidence } from '../lib/v1/research.js';
import { writeCsv, formatSignals } from '../lib/v1/output.js';
import { classify } from '../lib/v1/schema.js';
import { ROOT } from './fixtures.mjs';

// The attached spreadsheets live outside the repo. Tests that need them skip
// cleanly when they are absent, so the suite still passes on a fresh clone.
const UPLOADS = '/root/.claude/uploads/c024dea2-8e1d-5b15-ad5b-89359a0fa4cc';
const MEDSPA_FILE = join(UPLOADS, 'edef5bf2-Ostnyx_Leads_Ready.xlsx');
const FUNERAL_FILE = join(UPLOADS, '62dfd19e-Funeral_Homes_Database.xlsx');
const haveUploads = existsSync(MEDSPA_FILE);

/** A website-research fixture: a phone-and-appointment led clinic. */
const voiceEvidence = {
  website_reachable: true,
  pages_read: [{ url: 'https://clinic.example/', label: 'homepage' }],
  pages_failed: [],
  technologies: ['Aesthetic Record'],
  ecommerce: { detected: false, signals: [], product_links: 0, has_cart: false, has_returns_page: false },
  support: { channels: ['phone', 'email'], chat_widget: null, help_center: false, contact_form: false, emails: [], mailto_count: 1 },
  phone: { tel_links: 9, call_to_action: true, cta_examples: ['Call us today to book'], numbers: [] },
  booking: { detected: true, platform: 'Aesthetic Record', call_to_action: true, cta_examples: ['Book now'] },
  hiring: { page_found: false, support_roles: false, examples: [] },
  after_hours: { mentioned: false, examples: [] },
  socials: { instagram: ['clinicexample'] },
  meta: { title: 'Clinic Example' },
  evidence_sources: ['https://clinic.example/']
};

/** A website-research fixture: an online store with a staffed chat channel. */
const supportEvidence = {
  ...voiceEvidence,
  technologies: ['Shopify', 'Gorgias'],
  ecommerce: { detected: true, signals: ['Shopify detected on https://shop.example/'], product_links: 24, has_cart: true, has_returns_page: true },
  support: { channels: ['live chat', 'email', 'phone', 'returns/refunds policy'], chat_widget: 'Gorgias', help_center: true, contact_form: true, emails: [], mailto_count: 2 },
  phone: { tel_links: 0, call_to_action: false, cta_examples: [], numbers: [] },
  booking: { detected: false, platform: null, call_to_action: false, cta_examples: [] },
  hiring: { page_found: true, support_roles: true, examples: ['now hiring customer support representative'] }
};

const clinic = {
  company_name: 'Clinic Example', name_normalized: 'clinic example', domain: 'clinic.example',
  website: 'https://clinic.example', city: 'Austin', state: 'TX', category: 'Medical spa',
  phone_e164: '+15125550000', rating: 4.8, review_count: 320,
  source_file: 'test.xlsx', original_row: 2
};

// --- the XLSX reader -------------------------------------------------------

test('the XLSX reader handles self-closing empty cells without shifting a row', () => {
  // A row like <c r="C2"/><c r="D2" t="s"><v>7</v></c> must not let the empty
  // cell absorb the next cell's value. This was a real bug.
  if (!haveUploads) { console.log('    (skipped: attached files not present)'); return; }
  const { headers, rows } = readXlsx(join(UPLOADS, 'b2ff913f-logistics-usa.xlsx'), { sheet: 'Sheet1' });
  assert.deepEqual(headers, ['Business Name', 'Category', 'Phone', 'Website', 'City', 'State']);
  const first = rows[0];
  assert.equal(first['Business Name'], 'The Mail Room');
  assert.equal(first.Phone, '(928) 377-3233');
  assert.equal(first.Website, '', 'an empty cell must stay empty, not inherit the next value');
  assert.equal(first.State, 'Arizona');
});

test('the XLSX reader finds the lead sheet among admin sheets', () => {
  if (!haveUploads) return;
  const result = readXlsx(MEDSPA_FILE, { sheet: 'Leads' });
  assert.ok(result.sheetNames.includes('Settings'));
  assert.ok(result.sheetNames.includes('Dashboard'));
  assert.equal(result.sheet, 'Leads');
  assert.equal(result.rows.length, 1101);
  assert.equal(result.rows[0].__row, 2, 'the spreadsheet row number is preserved');
});

// --- ingest ----------------------------------------------------------------

test('columns are detected whatever they are called', () => {
  const { mapping } = detectColumns(['Company Name', 'Web Address', 'Phone Number', 'ZIP Code', 'Reviews', 'Nonsense']);
  assert.deepEqual(mapping.company_name, ['Company Name']);
  assert.deepEqual(mapping.website, ['Web Address']);
  assert.deepEqual(mapping.phone, ['Phone Number']);
  assert.deepEqual(mapping.postal_code, ['ZIP Code']);
  assert.deepEqual(mapping.review_count, ['Reviews']);
});

test('two columns for one field are both collected, and the filled one wins', () => {
  // The attached funeral file has an empty `name` beside a populated
  // `Business Name`, and an empty `phone` beside a populated `Phone`.
  const { mapping } = detectColumns(['name', 'Business Name', 'phone', 'Phone']);
  assert.deepEqual(mapping.company_name, ['Business Name', 'name'].sort((a, b) => mapping.company_name.indexOf(a) - mapping.company_name.indexOf(b)));
  const lead = mapRow(
    { name: '', 'Business Name': 'Anchorage Funeral Home', phone: '', Phone: '(907) 345-2244', __row: 2 },
    mapping, { sourceFile: 'f.xlsx' }
  );
  assert.equal(lead.company_name, 'Anchorage Funeral Home');
  assert.equal(lead.phone_e164, '+19073452244');
});

test('the original row is preserved so a lead can be traced back', () => {
  const { mapping } = detectColumns(['Company', 'Website', 'Secret Internal Code']);
  const lead = mapRow({ Company: 'Acme', Website: 'acme.com', 'Secret Internal Code': 'XYZ-9', __row: 41 }, mapping, { sourceFile: 'leads.xlsx' });
  assert.equal(lead.source_file, 'leads.xlsx');
  assert.equal(lead.original_row, 41);
  assert.equal(lead.original_record['Secret Internal Code'], 'XYZ-9', 'unmapped columns are kept, not discarded');
});

test('a file with no recognisable company-name column fails loudly', () => {
  if (!haveUploads) return;
  // Settings is a key/value sheet, not a lead list.
  assert.throws(() => ingestFile(MEDSPA_FILE, { sheet: 'Settings' }), /company name/i);
});

// --- deduplication ---------------------------------------------------------

test('a shared corporate website does not merge separate locations', () => {
  // dignitymemorial.com appears 24 times in the attached funeral file, for 24
  // different funeral homes in different towns. Merging on domain alone would
  // silently delete 23 real businesses.
  const a = { company_name: 'Phoenix Memorial Park', name_normalized: 'phoenix memorial park', domain: 'dignitymemorial.com', city: 'Phoenix', state: 'AZ' };
  const b = { company_name: 'Valley of the Sun Mortuary', name_normalized: 'valley of the sun mortuary', domain: 'dignitymemorial.com', city: 'Chandler', state: 'AZ' };
  const verdict = compareLeads(a, b);
  assert.equal(verdict.verdict, 'related_location');
  assert.equal(verdict.matched_on, 'domain');
});

test('the same business twice on one domain does merge', () => {
  const a = { company_name: 'Glo Medspa', name_normalized: 'glo medspa', domain: 'glomedspa.com', city: 'Wilmington', state: 'NC' };
  const b = { company_name: 'Glo MedSpa', name_normalized: 'glo medspa', domain: 'glomedspa.com', city: 'Wilmington', state: 'NC' };
  assert.equal(compareLeads(a, b).verdict, 'duplicate');
});

test('a shared phone number with different names is not a duplicate', () => {
  const a = { company_name: 'North Clinic', name_normalized: 'north clinic', phone_e164: '+15125550000' };
  const b = { company_name: 'South Clinic', name_normalized: 'south clinic', phone_e164: '+15125550000' };
  const verdict = compareLeads(a, b);
  assert.equal(verdict.verdict, 'related_location');
  assert.equal(verdict.matched_on, 'phone');
});

test('related locations are linked in both directions and kept as separate leads', () => {
  const { unique, groups } = dedupeLeads([
    { company_name: 'A Funeral Home', name_normalized: 'a funeral home', domain: 'chain.com', city: 'Denver', state: 'CO', source_file: 'f', original_row: 2 },
    { company_name: 'B Mortuary', name_normalized: 'b mortuary', domain: 'chain.com', city: 'Boulder', state: 'CO', source_file: 'f', original_row: 3 }
  ]);
  assert.equal(unique.length, 2);
  assert.equal(unique[0].related_locations.length, 1);
  assert.equal(unique[1].related_locations.length, 1);
  assert.equal(groups[0].count, 2);
});

test('merging keeps the richer record and records what it absorbed', () => {
  const { unique, duplicates } = dedupeLeads([
    { company_name: 'Acme Spa', name_normalized: 'acme spa', domain: 'acme.com', website: 'https://acme.com', city: 'Reno', state: 'NV', source_file: 'f', original_row: 2 },
    { company_name: 'Acme Spa', name_normalized: 'acme spa', domain: 'acme.com', website: 'https://acme.com', city: 'Reno', state: 'NV', phone_e164: '+17755550000', review_count: 90, rating: 4.6, source_file: 'f', original_row: 3 }
  ]);
  assert.equal(unique.length, 1);
  assert.equal(duplicates.length, 1);
  assert.equal(unique[0].phone_e164, '+17755550000', 'the surviving row gained the phone number');
  assert.equal(unique[0].merged_from.length, 1);
  assert.equal(unique[0].merged_from[0].original_row, 2);
});

test('deduplication on the real funeral file keeps the chains apart', () => {
  if (!existsSync(FUNERAL_FILE)) return;
  const { leads } = ingestFile(FUNERAL_FILE);
  const { unique, groups } = dedupeLeads(leads);
  assert.ok(unique.length > 350, `expected the chains to survive, got ${unique.length} from ${leads.length}`);
  const chain = groups.find((g) => g.domain === 'dignitymemorial.com');
  assert.ok(chain && chain.count > 1, 'the shared-domain chain should be reported as a group');
});

// --- relevance -------------------------------------------------------------

test('a beauty college is rejected even when the file calls it a medical spa', () => {
  const result = checkRelevance({ company_name: 'Cameo College of Essential Beauty', category: 'Medical spa' }, 'medspa');
  assert.equal(result.niche_match, 'OFF_NICHE');
  assert.equal(result.detected_type, 'education');
  assert.match(result.niche_match_reason, /the name is the more reliable field/);
});

test('hotels and resorts are rejected from a medspa list', () => {
  for (const name of ['Four Seasons Hotel Baltimore', 'Great Wolf Lodge Kansas City', 'The Umstead Hotel and Spa']) {
    assert.equal(checkRelevance({ company_name: name, category: 'Spa' }, 'medspa').niche_match, 'OFF_NICHE', name);
  }
});

test('a genuine medspa passes', () => {
  assert.equal(checkRelevance({ company_name: 'Glo Medspa - Wilmington', category: 'Medical spa' }, 'medspa').niche_match, 'IN_NICHE');
  assert.equal(checkRelevance({ company_name: 'Revived Medical Aesthetics', category: 'Medical spa' }, 'medspa').niche_match, 'IN_NICHE');
});

test('a German pizza chain is rejected from a logistics list', () => {
  assert.equal(checkRelevance({ company_name: 'Freddy Fresh Pizza Riesa', category: 'Pizza delivery' }, 'logistics').niche_match, 'OFF_NICHE');
  assert.equal(checkRelevance({ company_name: 'BC Logistics LLC', category: 'Freight forwarding service' }, 'logistics').niche_match, 'IN_NICHE');
});

test('the niche is detected from the file rather than assumed', () => {
  const medspas = Array.from({ length: 10 }, () => ({ category: 'Medical spa' }));
  assert.equal(detectNiche(medspas).niche, 'medspa');
  assert.equal(detectNiche(Array.from({ length: 10 }, () => ({ category: 'Trucking company' }))).niche, 'logistics');
  assert.equal(detectNiche([{ category: 'Bakery' }, { category: 'Florist' }]).niche, 'generic');
});

// --- signals ---------------------------------------------------------------

test('signals separate evidence from interpretation, and never assert a problem', () => {
  const signals = buildSignals(clinic, voiceEvidence);
  assert.ok(signals.length >= 3);
  for (const s of signals) {
    assert.ok(s.signal && s.evidence && s.interpretation, 'every signal needs all three parts');
    assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(s.confidence));
    // The forbidden shape: asserting a deficiency nobody measured.
    assert.doesNotMatch(
      `${s.interpretation}`,
      /\b(overwhelmed|missing calls|losing (leads|customers|money)|too slow|struggling|cannot cope|understaffed)\b/i,
      `interpretation asserts an unmeasured problem: ${s.interpretation}`
    );
  }
});

test('interpretations are hedged, not stated as fact', () => {
  const signals = buildSignals(clinic, voiceEvidence);
  const hedged = signals.filter((s) => /\b(may|appears|suggests|tends to|normally|usually|proxy|indicates?)\b/i.test(s.interpretation));
  assert.ok(hedged.length >= signals.length - 2, 'most interpretations should be explicitly tentative');
});

test('an unreadable website becomes a stated caveat, not silence', () => {
  const signals = buildSignals(clinic, {
    website_reachable: false, pages_read: [], pages_failed: [{ url: 'https://clinic.example/', status: 403 }],
    phone: {}, booking: {}, support: {}, ecommerce: {}, hiring: {}, after_hours: {}, socials: {}, meta: {}
  });
  const caveat = signals.find((s) => s.signal === 'Website could not be read');
  assert.ok(caveat);
  assert.equal(caveat.confidence, 'HIGH');
  assert.match(caveat.interpretation, /provisional/i);
});

test('signals are attributed to the right service', () => {
  const split = splitSignals(buildSignals(clinic, supportEvidence));
  assert.ok(split.support.some((s) => s.signal === 'Sells online'));
  assert.ok(split.support.some((s) => s.signal === 'Live chat already in place'));
  assert.ok(!split.voice.some((s) => s.signal === 'Sells online'));
});

// --- scoring ---------------------------------------------------------------

test('a phone-and-appointment clinic scores AI voice above customer support', () => {
  const signals = buildSignals(clinic, voiceEvidence);
  const ig = discoverInstagram(clinic, voiceEvidence);
  const scores = scoreLead(clinic, { evidence: voiceEvidence, signals, instagram: ig });
  assert.ok(scores.ai_voice_score > scores.customer_support_score);
  assert.ok(scores.overall_score >= 65, `expected GOOD or better, got ${scores.overall_score}`);
  assert.ok(scores.score_reasons.join(' ').includes('click-to-call') || scores.score_reasons.join(' ').includes('Phone is a prominent'));
});

test('an online store with staffed chat scores customer support above AI voice', () => {
  const shop = { ...clinic, category: 'Online store' };
  const signals = buildSignals(shop, supportEvidence);
  const scores = scoreLead(shop, { evidence: supportEvidence, signals, instagram: discoverInstagram(shop, supportEvidence) });
  assert.ok(scores.customer_support_score > scores.ai_voice_score);
});

test('every score carries its reasons', () => {
  const signals = buildSignals(clinic, voiceEvidence);
  const scores = scoreLead(clinic, { evidence: voiceEvidence, signals, instagram: discoverInstagram(clinic, voiceEvidence) });
  assert.ok(scores.score_reasons.length >= 4);
  assert.ok(scores.score_reasons.some((r) => r.includes('Reachability')));
  assert.ok(scores.score_reasons.some((r) => r.includes('Legitimacy')));
});

test('a lead with no website cannot reach GOOD on spreadsheet fields alone', () => {
  // Even with 5,000 reviews and a perfect rating, four spreadsheet columns are
  // not enough evidence to call something a good prospect.
  const thin = { ...clinic, domain: null, website: null, review_count: 5000, rating: 5 };
  const signals = buildSignals(thin, {});
  const scores = scoreLead(thin, { evidence: {}, signals, instagram: discoverInstagram(thin, {}) });
  assert.ok(scores.customer_support_score <= 45, `got ${scores.customer_support_score}`);
  assert.ok(scores.ai_voice_score <= 45, `got ${scores.ai_voice_score}`);
  assert.ok(!['BEST', 'GOOD'].includes(scores.classification), `got ${scores.classification}`);
  assert.ok(signals.some((s) => s.signal === 'No website on file'));
});

test('the no-website cap holds even if the signals were somehow strong', () => {
  // A guard rather than a live path: with no website there is normally nothing
  // to build a high score from. It exists so that stays true if signal
  // extraction later learns to read other sources.
  const thin = { ...clinic, domain: null, website: null };
  const strongSignals = [
    { signal: 'Sells online', confidence: 'HIGH', evidence: 'x', interpretation: 'y' },
    { signal: 'Live chat already in place', confidence: 'HIGH', evidence: 'x', interpretation: 'y' },
    { signal: 'Customer-facing hiring', confidence: 'HIGH', evidence: 'x', interpretation: 'y' },
    { signal: 'Appointment booking in use', confidence: 'HIGH', evidence: 'x', interpretation: 'y' },
    { signal: 'Phone is a prominent contact channel', confidence: 'HIGH', evidence: 'x', interpretation: 'y' },
    { signal: 'Call-to-action asks customers to phone', confidence: 'HIGH', evidence: 'x', interpretation: 'y' }
  ];
  const scores = scoreLead(thin, { evidence: {}, signals: strongSignals, instagram: { instagram_confidence: 'NOT_FOUND' } });
  assert.equal(scores.customer_support_score, 45);
  assert.equal(scores.ai_voice_score, 45);
  assert.equal(scores.caps_applied.length, 2);
  assert.match(scores.caps_applied[0], /no website to verify/);
});

test('an unreadable website caps the service scores below GOOD', () => {
  const signals = buildSignals(clinic, { website_reachable: false, pages_failed: [{ status: 403 }], phone: {}, booking: {}, support: {}, ecommerce: {}, hiring: {}, after_hours: {}, socials: {}, meta: {} });
  const scores = scoreLead(clinic, { evidence: { website_reachable: false, pages_failed: [{ status: 403 }] }, signals, instagram: { instagram_confidence: 'NOT_FOUND' } });
  assert.ok(scores.customer_support_score <= 55);
  assert.ok(scores.ai_voice_score <= 55);
});

test('classification uses the configured bands', () => {
  assert.equal(classify(85), 'BEST');
  assert.equal(classify(70), 'GOOD');
  assert.equal(classify(55), 'REVIEW');
  assert.equal(classify(20), 'BAD');
});

// --- offer -----------------------------------------------------------------

test('BOTH needs independent evidence for each service', () => {
  const oneSided = recommendOffer(clinic, {
    scores: { customer_support_score: 70, ai_voice_score: 70 },
    signals: [{ signal: 'Phone is a prominent contact channel', confidence: 'HIGH' }]
  });
  assert.notEqual(oneSided.recommended_offer, 'BOTH', 'one signal must not justify both services');

  const twoSided = recommendOffer(clinic, {
    scores: { customer_support_score: 65, ai_voice_score: 70 },
    signals: [
      { signal: 'Sells online', confidence: 'HIGH' },
      { signal: 'Live chat already in place', confidence: 'HIGH' },
      { signal: 'Phone is a prominent contact channel', confidence: 'HIGH' },
      { signal: 'Appointment booking in use', confidence: 'HIGH' }
    ]
  });
  assert.equal(twoSided.recommended_offer, 'BOTH');
});

test('NONE is returned when the evidence does not support an approach', () => {
  const result = recommendOffer(clinic, {
    scores: { customer_support_score: 10, ai_voice_score: 20 },
    signals: [{ signal: 'No website on file', confidence: 'HIGH', evidence: 'No website value in f.xlsx row 9' }]
  });
  assert.equal(result.recommended_offer, 'NONE');
  assert.match(result.offer_reason, /No service recommended/);
});

test('the offer reason names the evidence it rests on', () => {
  const signals = buildSignals(clinic, voiceEvidence);
  const scores = scoreLead(clinic, { evidence: voiceEvidence, signals, instagram: discoverInstagram(clinic, voiceEvidence) });
  const offer = recommendOffer(clinic, { scores, signals });
  assert.equal(offer.recommended_offer, 'AI_VOICE');
  assert.match(offer.offer_reason, /phone|appointment|booking/i);
});

// --- Instagram -------------------------------------------------------------

test('a link on the company website is HIGH confidence', () => {
  const result = discoverInstagram(clinic, voiceEvidence);
  assert.equal(result.business_instagram, 'clinicexample');
  assert.equal(result.instagram_confidence, 'HIGH');
  assert.match(result.instagram_evidence, /own website/);
});

test('a handle from the spreadsheet is MEDIUM, not HIGH', () => {
  const result = discoverInstagram({ ...clinic, instagram: '@clinicexample' }, { socials: {}, pages_read: [] });
  assert.equal(result.instagram_confidence, 'MEDIUM');
  assert.match(result.instagram_evidence, /not confirmed/i);
});

test('a name-based guess is LOW and is never written to business_instagram', () => {
  const result = discoverInstagram(clinic, { socials: {}, pages_read: [], website_reachable: false });
  assert.equal(result.instagram_confidence, 'LOW');
  assert.equal(result.business_instagram, null, 'a guess must not be presented as the account');
  assert.match(result.instagram_evidence, /NOT been verified/);
});

test('instagram.com paths that are not accounts are rejected', () => {
  const result = discoverInstagram(clinic, { socials: { instagram: ['p', 'reel', 'explore'] }, pages_read: [] });
  assert.equal(result.business_instagram, null);
});

test('several linked accounts with no clear winner drops to MEDIUM and says why', () => {
  const result = discoverInstagram(clinic, { ...voiceEvidence, socials: { instagram: ['someagency', 'anotherbrand'] } });
  assert.equal(result.instagram_confidence, 'MEDIUM');
  assert.match(result.instagram_evidence, /none clearly belongs/);
  assert.ok(result.instagram_alternates.length >= 1);
});

test('no owner name means no owner account is guessed', () => {
  const result = discoverInstagram(clinic, voiceEvidence);
  assert.equal(result.owner_instagram, null);
  assert.equal(result.owner_instagram_confidence, 'NOT_FOUND');
  assert.match(result.owner_instagram_evidence, /no owner or contact name/i);
});

// --- output ----------------------------------------------------------------

test('the CSV neutralises spreadsheet formula injection', () => {
  const path = join(ROOT, 'out', 'test-csv-guard.csv');
  writeCsv(path, [{ company_name: '=HYPERLINK("http://evil","click")', overall_score: 50 }]);
  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes("'=HYPERLINK"), 'a leading = must be escaped so Excel does not execute it');
  rmSync(path, { force: true });
});

test('signals are written in a form a human can read in a cell', () => {
  const text = formatSignals(buildSignals(clinic, voiceEvidence));
  assert.match(text, /1\. \[HIGH\]/);
  assert.match(text, /Evidence:/);
  assert.match(text, /Interpretation:/);
});

// --- the prompt ------------------------------------------------------------

test('the DM prompt forbids asserting a problem the evidence cannot show', () => {
  const body = readFileSync(join(ROOT, 'prompts/v1-instagram-dm.md'), 'utf8').toLowerCase();
  for (const banned of ['missing calls', 'overwhelmed', 'losing', 'i hope this message finds you well', 'list of services']) {
    assert.ok(body.includes(banned), `the DM prompt should ban "${banned}"`);
  }
  assert.ok(body.includes('quote or paraphrase the'), 'the prompt must tie the message to the evidence field');
  assert.ok(body.includes('interpretation'), 'the prompt must distinguish evidence from interpretation');
});

// --- exclusions ------------------------------------------------------------

test('a competitor is excluded, not pitched', async () => {
  const { checkExclusion } = await import('../lib/v1/relevance.js');
  // This is the real case: a Canadian list put "CXAi Inc." second-best, and the
  // file held six rows whose stated industry was "Outsourcing/offshoring".
  const cx = checkExclusion({ company_name: 'CXAi Inc.', industry: 'Information Technology & Services', keywords: ['customer experience ai', 'cx platform'] });
  assert.equal(cx.excluded, true);
  assert.equal(cx.exclusion_kind, 'competitor');

  const bpo = checkExclusion({ company_name: 'Acme Ltd', industry: 'Outsourcing/offshoring' });
  assert.equal(bpo.excluded, true);
  assert.equal(bpo.exclusion_kind, 'competitor');

  for (const name of ['PeakSupport BPO', 'Nova Call Center', 'Answering Service Pros', 'VoiceAI Receptionist Co']) {
    assert.equal(checkExclusion({ company_name: name }).excluded, true, name);
  }
});

test('an agency that would resell rather than buy is excluded', async () => {
  const { checkExclusion } = await import('../lib/v1/relevance.js');
  for (const lead of [
    { company_name: 'DAASH WEB LAB', industry: 'Marketing & Advertising' },
    { company_name: 'Bright Ideas', industry: 'Management Consulting' },
    { company_name: 'Hire Fast', industry: 'Staffing & Recruiting' }
  ]) {
    const result = checkExclusion(lead);
    assert.equal(result.excluded, true, lead.company_name);
    assert.equal(result.exclusion_kind, 'reseller');
  }
});

test('a genuine prospect is not excluded', async () => {
  const { checkExclusion } = await import('../lib/v1/relevance.js');
  for (const lead of [
    { company_name: 'Glo Medspa', industry: 'Health, Wellness & Fitness', category: 'Medical spa' },
    { company_name: 'Simply Delivery', industry: 'Package/freight Delivery', keywords: ['courier', 'food delivery'] },
    { company_name: 'Anchorage Funeral Home', category: 'Funeral home' }
  ]) {
    assert.equal(checkExclusion(lead).excluded, false, lead.company_name);
  }
});

test('the exclusion reason quotes the words that triggered it', async () => {
  const { checkExclusion } = await import('../lib/v1/relevance.js');
  const result = checkExclusion({ company_name: 'X', industry: 'Outsourcing/offshoring' });
  assert.match(result.exclusion_reason, /"outsourcing"/i);
  assert.match(result.exclusion_reason, /sells what OptiFlow sells/);
});

test('a stated industry outranks loose keyword tags', async () => {
  const { checkRelevance } = await import('../lib/v1/relevance.js');
  // An e-commerce brand's keywords routinely include "shipping" and "delivery".
  // Before this rule, six software companies topped a logistics batch.
  const softwareCo = {
    company_name: 'BudSense', industry: 'Information Technology & Services',
    keywords: ['shipping', 'delivery', 'distribution', 'software']
  };
  assert.notEqual(checkRelevance(softwareCo, 'logistics').niche_match, 'IN_NICHE');

  const courier = { company_name: 'Simply Delivery', industry: 'Package/freight Delivery', keywords: ['courier'] };
  assert.equal(checkRelevance(courier, 'logistics').niche_match, 'IN_NICHE');

  // With no industry column, keywords are all there is, so they still count.
  const noIndustry = { company_name: 'Acme Freight', keywords: ['freight forwarding', 'trucking'] };
  assert.equal(checkRelevance(noIndustry, 'logistics').niche_match, 'IN_NICHE');
});

test('a person\'s mobile number and personal email are deliberately not ingested', async () => {
  const { detectColumns, DELIBERATELY_IGNORED } = await import('../lib/v1/map-columns.js');
  const { mapping, unmapped } = detectColumns(['Company Name', 'Email', 'Mobile Number', 'Personal Email']);
  assert.ok(!Object.values(mapping).flat().includes('Mobile Number'));
  assert.ok(!Object.values(mapping).flat().includes('Personal Email'));
  assert.ok(!unmapped.includes('Mobile Number'), 'ignored on purpose, not merely unrecognised');
  assert.ok(DELIBERATELY_IGNORED.includes('mobile number'));
});

test('"Title" is the job title when the file also names the company', async () => {
  const { detectColumns } = await import('../lib/v1/map-columns.js');
  // Apollo-style export: Title is the person's role.
  const crm = detectColumns(['Company Name', 'Full Name', 'Title']);
  assert.deepEqual(crm.mapping.job_title, ['Title']);
  assert.deepEqual(crm.mapping.company_name, ['Company Name']);

  // Google Maps export: Title is the place name.
  const maps = detectColumns(['title', 'Category', 'Phone']);
  assert.deepEqual(maps.mapping.company_name, ['title']);
  assert.equal(maps.mapping.job_title, undefined);
});

test('the company location wins over the contact location', async () => {
  const { detectColumns, mapRow } = await import('../lib/v1/map-columns.js');
  const { mapping } = detectColumns(['Company Name', 'City', 'State', 'Company City', 'Company State']);
  // A courier in Calgary whose owner lives in London, Ontario is a Calgary business.
  const lead = mapRow(
    { 'Company Name': 'Simply Delivery', City: 'London', State: 'Ontario', 'Company City': 'Calgary', 'Company State': 'Alberta', __row: 2 },
    mapping, { sourceFile: 'canada.xlsx' }
  );
  assert.equal(lead.city, 'Calgary');
  assert.equal(lead.state, 'Alberta');
  assert.equal(lead.contact_city, 'London', 'the contact location is kept, not discarded');
});

// --- after-hours detection -------------------------------------------------
// A medspa's aftercare page is full of "24 hours", and the coverage verbs had no
// word boundaries, so "steam rooms" matched `team` and "typically" matched
// `call`. Treatment recovery text was being read as advertised phone coverage,
// which lifted the AI voice score on leads that advertise no such thing.
const page = (text) => extractEvidence(
  [{ url: 'https://example.com/', label: 'homepage', ok: true, status: 200, html: `<html><body><p>${text}</p></body></html>` }],
  { domain: 'example.com' }
);

test('after-hours coverage is not read from aftercare or recovery text', () => {
  const quiet = [
    'Avoid strenuous activity, steam rooms and saunas, and other facial treatments for at least 24 hours.',
    'Patients can typically return to their everyday schedule in only 24 hours after a session.',
    'Most swelling settles within 24 hours and results appear over 4-10 days.',
    'Access your financing portal online 24/7 to review your payment plan.',
    'To accommodate all of our clients, please provide at least 24 hours notice to cancel.',
    'We will contact you within the next 24 hours if you call us or fill out the form.',
    'Book Online 24/7 with our self-service booking.'
  ];
  for (const text of quiet) {
    assert.equal(page(text).after_hours.mentioned, false, `fired on: ${text}`);
  }
});

test('genuinely advertised after-hours coverage still registers', () => {
  const fires = [
    'Our team answers calls 24/7, so you always reach a person.',
    'We run an after-hours answering service for urgent questions.',
    'Monday to Friday 9:00 AM - 5:00 PM. Saturday and Sunday: Open 24 hours.'
  ];
  for (const text of fires) {
    const evidence = page(text);
    assert.equal(evidence.after_hours.mentioned, true, `missed: ${text}`);
    assert.ok(evidence.after_hours.examples[0], 'no example quoted');
  }
});
