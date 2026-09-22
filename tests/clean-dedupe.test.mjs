import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanLead, personalAccountScore, nicheMatch, locationMatch } from '../lib/clean.js';
import { identityKeys, dedupeBatch, isLikelySame, nameSimilarity, mergeLeads } from '../lib/dedupe.js';
import { cleaningRules, campaign, nicheById, goodMedspa, personalAccount, competitor } from './fixtures.mjs';

const medspa = nicheById('medspas');

test('a well-formed in-niche lead survives cleaning', () => {
  const result = cleanLead(goodMedspa, { campaign, niche: medspa, rules: cleaningRules });
  assert.equal(result.keep, true, result.reasons.join(','));
  assert.ok(result.flags.niche_hits.length > 0);
});

test('personal accounts are filtered out with a stated reason', () => {
  const score = personalAccountScore(personalAccount, cleaningRules);
  assert.ok(score.score >= cleaningRules.personal_account_signals.threshold, `score was ${score.score}`);
  const result = cleanLead(personalAccount, { campaign, niche: medspa, rules: cleaningRules });
  assert.equal(result.keep, false);
  assert.ok(result.reasons.includes('personal_account'));
});

test('competitors and agencies are blocked', () => {
  const result = cleanLead(competitor, { campaign, niche: medspa, rules: cleaningRules });
  assert.equal(result.keep, false);
  assert.ok(result.reasons.includes('blocked_business_type'));
  assert.ok(result.flags.blocked_terms.includes('bpo'));
});

test('leads outside the target state are dropped', () => {
  const texan = { ...goodMedspa, state: 'TX', city: 'Austin' };
  const result = cleanLead(texan, { campaign, niche: medspa, rules: cleaningRules });
  assert.equal(result.keep, false);
  assert.ok(result.reasons.includes('outside_target_location'));
});

test('a lead in the right state but an unlisted city is kept and flagged', () => {
  const result = locationMatch({ state: 'CA', city: 'Fresno' }, campaign, cleaningRules);
  assert.equal(result.matched, true);
  assert.equal(result.soft, true);
});

test('negative niche keywords drop a lead even when positives match', () => {
  const consultant = { ...goodMedspa, bio: 'Medspa consultant helping clinics with botox marketing' };
  const match = nicheMatch(consultant, medspa, cleaningRules);
  assert.equal(match.matched, false);
  assert.ok(match.negatives.length > 0);
});

test('absolute follower bounds reject obvious non-prospects', () => {
  const tiny = cleanLead({ ...goodMedspa, ig_followers: 120 }, { campaign, niche: medspa, rules: cleaningRules });
  assert.ok(tiny.reasons.includes('below_absolute_min_followers'));
  const huge = cleanLead({ ...goodMedspa, ig_followers: 900000 }, { campaign, niche: medspa, rules: cleaningRules });
  assert.ok(huge.reasons.includes('above_absolute_max_followers'));
});

test('identity keys come out in priority order', () => {
  const keys = identityKeys(goodMedspa).map((k) => k.key_type);
  assert.deepEqual(keys, ['instagram_handle', 'website_domain', 'phone_e164', 'email', 'name_city']);
});

test('the same business discovered three ways collapses to one row', () => {
  const batch = [
    { business_name: 'Glow Med Spa LLC', instagram_handle: 'glowmedspa', city: 'Los Angeles', state: 'CA', ig_followers: 4200 },
    { business_name: 'Glow Medspa', website: 'https://glowmedspa.com', city: 'Los Angeles', state: 'CA', phone: '(310) 555-1234' },
    { business_name: 'Glow Med Spa', instagram_handle: 'GlowMedSpa', products_services: ['Botox', 'Filler'] }
  ];
  const { unique, duplicates } = dedupeBatch(batch);
  assert.equal(unique.length, 1);
  assert.equal(duplicates.length, 2);
  // the surviving row keeps the best value from every copy
  assert.equal(unique[0].instagram_handle, 'glowmedspa');
  assert.equal(unique[0].website, 'https://glowmedspa.com');
  assert.equal(unique[0].ig_followers, 4200);
  assert.deepEqual(unique[0].products_services, ['Botox', 'Filler']);
});

test('different businesses with similar names are not merged', () => {
  const batch = [
    { business_name: 'Glow Medspa', instagram_handle: 'glowmedspa_la', city: 'Los Angeles', state: 'CA' },
    { business_name: 'Glow Medspa', instagram_handle: 'glowmedspa_mia', city: 'Miami', state: 'FL' }
  ];
  const { unique } = dedupeBatch(batch);
  assert.equal(unique.length, 2);
});

test('conflicting strong keys mean different businesses', () => {
  const verdict = isLikelySame(
    { business_name: 'Glow Medspa', instagram_handle: 'glow_la' },
    { business_name: 'Glow Medspa', instagram_handle: 'glow_sd' }
  );
  assert.equal(verdict.same, false);
  assert.equal(verdict.conflict, 'instagram_handle');
});

test('same name and same city with no strong keys is treated as a duplicate', () => {
  const verdict = isLikelySame(
    { business_name: 'Glow Med Spa LLC', city: 'Los Angeles', state: 'CA' },
    { business_name: 'Glow Medspa', city: 'Los Angeles', state: 'CA' }
  );
  assert.equal(verdict.same, true);
  assert.equal(verdict.matched_on, 'name_city');
});

test('name similarity separates near-misses from matches', () => {
  assert.ok(nameSimilarity('Glow Med Spa LLC', 'Glow Medspa') > 0.9);
  assert.ok(nameSimilarity('Glow Medspa', 'Radiance Medspa') < 0.6);
});

test('merging never overwrites a known value with nothing', () => {
  const merged = mergeLeads(
    { business_name: 'Glow', email: 'a@b.com', ig_followers: 4200, products_services: ['Botox'] },
    { business_name: 'Glow', email: null, ig_followers: 4000, products_services: ['Filler'], website: 'https://x.com' }
  );
  assert.equal(merged.email, 'a@b.com');
  assert.equal(merged.ig_followers, 4200);
  assert.equal(merged.website, 'https://x.com');
  assert.deepEqual(merged.products_services, ['Botox', 'Filler']);
});

test('a two-word brand name is not mistaken for a person', () => {
  const sparse = { business_name: 'Glow Medspa', instagram_handle: 'glowmedspa', city: 'Los Angeles', state: 'CA', ig_followers: 4100, ig_posts: 120 };
  const score = personalAccountScore(sparse, cleaningRules);
  assert.ok(!score.signals.includes('name_looks_personal'), 'business words in the name rule out a person');
  const person = personalAccountScore({ business_name: 'Jessica Adams', ig_is_business: false }, cleaningRules);
  assert.ok(person.signals.includes('name_looks_personal'));
});
