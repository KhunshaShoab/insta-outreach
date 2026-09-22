import test from 'node:test';
import assert from 'node:assert/strict';
import { computeIcpScore, scoreFollowers, scoreProducts, scoreActivity, bandFor, checkHardGates, explainScore } from '../lib/scoring.js';
import { scoringProfile, campaign, goodMedspa, founderContact, aiScores } from './fixtures.mjs';

test('followers inside the configured band score full marks and degrade outside it', () => {
  assert.equal(scoreFollowers({ ig_followers: 4200 }, campaign, scoringProfile).score, 100);
  assert.equal(scoreFollowers({ ig_followers: 1000 }, campaign, scoringProfile).score, 100);
  assert.equal(scoreFollowers({ ig_followers: 10000 }, campaign, scoringProfile).score, 100);
  assert.ok(scoreFollowers({ ig_followers: 15000 }, campaign, scoringProfile).score < 100);
  assert.equal(scoreFollowers({ ig_followers: 100 }, campaign, scoringProfile).score, 0);
  assert.equal(scoreFollowers({ ig_followers: null }, campaign, scoringProfile).score, 40);
});

test('the follower band comes from the campaign, not from code', () => {
  const wide = { ...campaign, icp: { ...campaign.icp, min_followers: 20000, max_followers: 100000 } };
  assert.equal(scoreFollowers({ ig_followers: 50000 }, wide, scoringProfile).score, 100);
  assert.ok(scoreFollowers({ ig_followers: 4200 }, wide, scoringProfile).score < 100);
});

test('product counts below the campaign minimum are penalised, not zeroed', () => {
  assert.equal(scoreProducts({ products_count: 1 }, campaign, scoringProfile).score, 25);
  assert.equal(scoreProducts({ products_count: 6 }, campaign, scoringProfile).score, 100);
  assert.equal(scoreProducts({ products_count: null }, campaign, scoringProfile).score, 50);
});

test('activity decays with time since the last post', () => {
  assert.equal(scoreActivity({ days_since_last_post: 3 }, scoringProfile).score, 100);
  assert.ok(scoreActivity({ days_since_last_post: 40 }, scoringProfile).score < 100);
  assert.ok(scoreActivity({ days_since_last_post: 200 }, scoringProfile).score <= 10);
});

test('a strong medspa lead qualifies as high priority', () => {
  const result = computeIcpScore({ lead: goodMedspa, contact: founderContact, campaign, profile: scoringProfile, ai: aiScores });
  assert.ok(result.icp_score >= 85, `score was ${result.icp_score}`);
  assert.equal(result.band, 'HIGH_PRIORITY');
  assert.equal(result.priority, 'high');
  assert.equal(result.qualified, true);
  assert.equal(result.hard_gate_failures.length, 0);
});

test('scoring is deterministic for identical inputs', () => {
  const a = computeIcpScore({ lead: goodMedspa, contact: founderContact, campaign, profile: scoringProfile, ai: aiScores });
  const b = computeIcpScore({ lead: goodMedspa, contact: founderContact, campaign, profile: scoringProfile, ai: aiScores });
  assert.equal(a.icp_score, b.icp_score);
  assert.deepEqual(a.components, b.components);
});

test('every component reports its weight, source and value', () => {
  const result = computeIcpScore({ lead: goodMedspa, contact: founderContact, campaign, profile: scoringProfile, ai: aiScores });
  for (const [name, component] of Object.entries(result.components)) {
    assert.ok(component.weight > 0, `${name} has no weight`);
    assert.ok(component.score >= 0 && component.score <= 100, `${name} out of range`);
    assert.ok(typeof component.source === 'string');
  }
  assert.match(explainScore(result), /ICP \d+\/100 \(HIGH_PRIORITY\)/);
});

test('a missing decision maker lowers the score but does not disqualify by default', () => {
  const result = computeIcpScore({ lead: goodMedspa, contact: null, campaign, profile: scoringProfile, ai: aiScores });
  assert.equal(result.hard_gate_failures.length, 0);
  assert.equal(result.qualified, true);
  assert.ok(result.components.decision_maker.score <= 20);
});

test('requiring a decision maker is a per-campaign switch', () => {
  const strict = { ...campaign, qualification: { ...campaign.qualification, hard_gate_overrides: { require_decision_maker: true } } };
  const result = computeIcpScore({ lead: goodMedspa, contact: null, campaign: strict, profile: scoringProfile, ai: aiScores });
  assert.ok(result.hard_gate_failures.includes('no_decision_maker'));
  assert.equal(result.band, 'NOT_QUALIFIED');
  assert.equal(result.qualified, false);
});

test('a hard gate failure forces NOT_QUALIFIED whatever the score', () => {
  const outOfState = { ...goodMedspa, state: 'TX' };
  const result = computeIcpScore({ lead: outOfState, contact: founderContact, campaign, profile: scoringProfile, ai: aiScores });
  assert.ok(result.hard_gate_failures.includes('outside_target_state'));
  assert.equal(result.qualified, false);
});

test('campaign weight overrides change the outcome', () => {
  const websiteHeavy = { ...campaign, qualification: { ...campaign.qualification, weight_overrides: { website_quality: 40 } } };
  const base = computeIcpScore({ lead: { ...goodMedspa, website_domain: null }, contact: founderContact, campaign, profile: scoringProfile, ai: aiScores });
  const heavy = computeIcpScore({ lead: { ...goodMedspa, website_domain: null }, contact: founderContact, campaign: websiteHeavy, profile: scoringProfile, ai: { ...aiScores, website_quality: 20 } });
  assert.ok(heavy.icp_score < base.icp_score, `${heavy.icp_score} should be below ${base.icp_score}`);
});

test('bands map to the configured thresholds', () => {
  assert.equal(bandFor(90, scoringProfile), 'HIGH_PRIORITY');
  assert.equal(bandFor(75, scoringProfile), 'QUALIFIED');
  assert.equal(bandFor(60, scoringProfile), 'REVIEW');
  assert.equal(bandFor(20, scoringProfile), 'NOT_QUALIFIED');
});

test('private accounts take the configured penalty', () => {
  const open = computeIcpScore({ lead: goodMedspa, contact: founderContact, campaign, profile: scoringProfile, ai: aiScores });
  const priv = computeIcpScore({ lead: { ...goodMedspa, ig_is_private: true }, contact: founderContact, campaign, profile: scoringProfile, ai: aiScores });
  assert.equal(open.icp_score - priv.icp_score, scoringProfile.penalties.private_account);
  assert.deepEqual(priv.penalties, [{ id: 'private_account', amount: 15 }]);
});

test('hard gates read from the profile and the campaign override together', () => {
  const failures = checkHardGates({ instagram_handle: null, state: 'CA' }, null, campaign, scoringProfile);
  assert.ok(failures.includes('no_instagram'));
});
