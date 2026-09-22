import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDecisionMaker, classifyRole, isSmallBusiness } from '../lib/decision-maker.js';
import { pickAngle, resolveAngle, angleById } from '../lib/angles.js';
import { nicheById, goodMedspa, campaign } from './fixtures.mjs';

const medspa = nicheById('medspas');
const petBrands = nicheById('pet_brands');

test('titles map onto role categories', () => {
  assert.equal(classifyRole('Founder & CEO'), 'founder');
  assert.equal(classifyRole('Co-Founder'), 'co_founder');
  assert.equal(classifyRole('Head of Operations'), 'head_of_operations');
  assert.equal(classifyRole('Customer Experience Director'), 'cx_director');
  assert.equal(classifyRole('Patient Coordinator'), 'support_manager');
  assert.equal(classifyRole('Software Engineer'), 'other');
  assert.equal(classifyRole(null), 'unknown');
});

test('company size drives which role is targeted', () => {
  assert.equal(isSmallBusiness({ employee_count: 8 }), true);
  assert.equal(isSmallBusiness({ employee_count: 400 }), false);
  assert.equal(isSmallBusiness({ ig_followers: 4200 }), true, 'no size signal falls back to the follower band');
});

test('small businesses target the founder', () => {
  const result = selectDecisionMaker([
    { full_name: 'Dana Reed', title: 'Marketing Manager', source_confidence: 0.9 },
    { full_name: 'Sarah Mitchell', title: 'Founder', email: 'sarah@x.com', source_confidence: 0.9 }
  ], { employee_count: 6 });
  assert.equal(result.contact.full_name, 'Sarah Mitchell');
  assert.equal(result.role, 'founder');
  assert.match(result.why, /founder\/owner is normally the person/i);
});

test('larger businesses target the person who owns the support queue', () => {
  const result = selectDecisionMaker([
    { full_name: 'Sarah Mitchell', title: 'Founder', source_confidence: 0.9 },
    { full_name: 'Alex Kim', title: 'Head of Operations', email: 'alex@x.com', source_confidence: 0.9 }
  ], { employee_count: 300 });
  assert.equal(result.contact.full_name, 'Alex Kim');
  assert.equal(result.role, 'head_of_operations');
});

test('contactability breaks ties within the same role', () => {
  const result = selectDecisionMaker([
    { full_name: 'A Person', title: 'Founder', source_confidence: 0.8 },
    { full_name: 'B Person', title: 'Founder', email: 'b@x.com', linkedin_url: 'https://li/b', source_confidence: 0.8 }
  ], { employee_count: 5 });
  assert.equal(result.contact.full_name, 'B Person');
});

test('no contacts is a normal outcome, not a failure', () => {
  const result = selectDecisionMaker([], { employee_count: 5 });
  assert.equal(result.contact, null);
  assert.equal(result.confidence, 0);
  assert.match(result.why, /without using a name/i);
});

test('the decision-maker rationale avoids gendered pronouns', () => {
  const result = selectDecisionMaker([{ full_name: 'Sarah Mitchell', title: 'Founder', email: 's@x.com' }], { employee_count: 4 });
  assert.doesNotMatch(result.why, /\b(he|she|his|her|hers|him)\b/i);
});

test('angles are picked from the niche, never invented', () => {
  const { angle } = pickAngle(medspa, { lead: goodMedspa, research: {}, campaign });
  assert.ok(medspa.outreach_angles.some((a) => a.id === angle.id));
});

test('signals steer the angle: a DM-for-pricing bio picks speed to lead', () => {
  const { angle } = pickAngle(medspa, {
    lead: { bio: 'DM us for pricing and availability' },
    research: { operational_pain_points: ['Pricing inquiries answered slowly'] },
    campaign
  });
  assert.equal(angle.id, 'speed_to_lead');
});

test('an e-commerce brand with shipping pain picks the order angle', () => {
  const { angle } = pickAngle(petBrands, {
    lead: { bio: 'Free shipping on all orders' },
    research: { operational_pain_points: ['Where is my order questions from customers', 'Shipping delays'] },
    campaign
  });
  assert.equal(angle.id, 'order_questions');
});

test('a campaign angle override wins', () => {
  const forced = { ...campaign, outreach: { ...campaign.outreach, angle_override: 'after_hours' } };
  const { angle, source } = pickAngle(medspa, { lead: goodMedspa, research: {}, campaign: forced });
  assert.equal(angle.id, 'after_hours');
  assert.equal(source, 'campaign');
});

test('an unknown AI angle falls back instead of breaking the run', () => {
  const resolved = resolveAngle(medspa, 'totally_made_up_angle', { lead: goodMedspa, research: {}, campaign });
  assert.ok(angleById(medspa, resolved.angle.id));
  assert.equal(resolved.rejected_ai_angle, 'totally_made_up_angle');
  assert.equal(resolved.source, 'fallback_unknown_ai_angle');
});

test('a valid AI angle is honoured', () => {
  const resolved = resolveAngle(medspa, 'after_hours', { lead: goodMedspa, research: {}, campaign });
  assert.equal(resolved.angle.id, 'after_hours');
  assert.equal(resolved.source, 'ai');
});

test('every niche ships at least three angles and real pain points', async () => {
  const { readFile } = await import('node:fs/promises');
  const { niches } = JSON.parse(await readFile(new URL('../config/niches.json', import.meta.url), 'utf8'));
  for (const niche of niches) {
    assert.ok(niche.outreach_angles.length >= 3, `${niche.id} has too few angles`);
    assert.ok(niche.pain_points.length >= 3, `${niche.id} has too few pain points`);
    assert.ok(niche.recommended_services.length >= 3, `${niche.id} has too few services`);
    assert.ok(niche.search_terms.length >= 2, `${niche.id} has too few search terms`);
    const ids = niche.outreach_angles.map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length, `${niche.id} has duplicate angle ids`);
  }
});
