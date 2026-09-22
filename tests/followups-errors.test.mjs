import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule, shouldStopSequence, nextSendSlot, applyDailyLimits, offsetsFor, stepConfig } from '../lib/followups.js';
import { classifyError, decideRetry, backoffMs, isRetryable, retryAfterFrom, withRetry } from '../lib/retry.js';
import { resumeStage, nextStage, canAdvance, progressOf, workflowFor } from '../lib/stages.js';
import { campaign, followupDefaults } from './fixtures.mjs';

test('the sequence is built from the campaign day offsets', () => {
  const schedule = buildSchedule(new Date('2026-09-22T17:00:00Z'), campaign, followupDefaults);
  assert.equal(schedule.length, 3);
  assert.deepEqual(schedule.map((s) => s.kind), ['followup_1', 'followup_2', 'followup_3_final']);
  assert.deepEqual(schedule.map((s) => s.day_offset), [2, 5, 9]);
});

test('changing the campaign offsets changes the schedule with no code change', () => {
  const slow = { ...campaign, followups: { ...campaign.followups, day_offsets: [4, 11, 21] } };
  assert.deepEqual(buildSchedule(new Date('2026-09-22T17:00:00Z'), slow, followupDefaults).map((s) => s.day_offset), [4, 11, 21]);
  assert.deepEqual(offsetsFor(slow, followupDefaults), [4, 11, 21]);
});

test('follow-ups are disabled per campaign', () => {
  const off = { ...campaign, followups: { ...campaign.followups, enabled: false } };
  assert.deepEqual(buildSchedule(new Date(), off, followupDefaults), []);
});

test('due dates land inside the sending window', () => {
  // 2026-09-27 is a Sunday; +5 days from Tuesday must roll to Monday morning.
  const schedule = buildSchedule(new Date('2026-09-22T17:00:00Z'), campaign, followupDefaults);
  const second = new Date(schedule[1].due_at);
  assert.equal(second.getUTCDay(), 1, 'rolled to Monday');
  assert.ok(second.getUTCHours() >= 9 && second.getUTCHours() < 18);
});

test('an out-of-hours timestamp moves to the next open slot', () => {
  const window = { start_hour: 9, end_hour: 18, days: [1, 2, 3, 4, 5] };
  const lateNight = nextSendSlot(new Date('2026-09-23T03:00:00Z'), window);
  assert.equal(lateNight.getUTCHours(), 9);
  const saturday = nextSendSlot(new Date('2026-09-26T12:00:00Z'), window);
  assert.equal(saturday.getUTCDay(), 1);
});

test('a reply stops the sequence, by any of its signals', () => {
  assert.equal(shouldStopSequence({ replied_at: '2026-09-23T10:00:00Z' }).stop, true);
  assert.equal(shouldStopSequence({ status: 'INTERESTED' }).stop, true);
  assert.equal(shouldStopSequence({ stage: 'CONVERSATION' }).stop, true);
  assert.equal(shouldStopSequence({ status: 'OPTED_OUT' }).stop, true);
  assert.equal(shouldStopSequence({ suppressed: true }).stop, true);
  assert.equal(shouldStopSequence({ stage: 'DM_SENT', status: 'SENT' }).stop, false);
});

test('the daily cap holds back the overflow instead of dropping it', () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const { release, held, remaining } = applyDailyLimits(items, { sentToday: 12, limit: 30 });
  assert.equal(release.length, 18);
  assert.equal(held.length, 32);
  assert.equal(remaining, 18);
});

test('each follow-up step carries its own intent and length limit', () => {
  const step = stepConfig('followup_2', followupDefaults);
  assert.ok(step.intent.length > 20);
  assert.ok(step.max_chars > 0);
  assert.equal(stepConfig('followup_3_final', followupDefaults).final, true);
});

test('errors are classified from status codes and messages', () => {
  assert.equal(classifyError({ status: 429 }), 'rate_limit');
  assert.equal(classifyError({ status: 503 }), 'provider_error');
  assert.equal(classifyError({ status: 401 }), 'auth');
  assert.equal(classifyError({ status: 422 }), 'validation');
  assert.equal(classifyError({ message: 'ETIMEDOUT' }), 'timeout');
  assert.equal(classifyError({ message: 'socket hang up' }), 'network');
  assert.equal(classifyError({ message: 'failed to parse JSON schema' }), 'ai_schema');
});

test('auth and validation failures are not retried', () => {
  assert.equal(isRetryable('auth'), false);
  assert.equal(isRetryable('validation'), false);
  assert.equal(decideRetry({ error: { status: 401 } }).retry, false);
  assert.equal(decideRetry({ error: { status: 401 } }).dead_letter, true);
});

test('rate limits retry with backoff and honour Retry-After', () => {
  const decision = decideRetry({ error: { status: 429 }, attempt: 1, maxRetries: 3, headers: { 'retry-after': '30' } });
  assert.equal(decision.retry, true);
  assert.equal(decision.delay_ms, 30000);
  assert.ok(backoffMs(1, { jitter: false }) === 2000);
  assert.ok(backoffMs(4, { jitter: false }) === 16000);
  assert.ok(backoffMs(20, { jitter: false }) <= 300000, 'backoff is capped');
  assert.equal(retryAfterFrom({ 'retry-after': '12' }), 12);
});

test('the retry budget is finite and the item is dead-lettered after it', () => {
  const decision = decideRetry({ error: { status: 500 }, attempt: 3, maxRetries: 3 });
  assert.equal(decision.retry, false);
  assert.equal(decision.dead_letter, true);
  assert.match(decision.reason, /budget exhausted/);
});

test('withRetry gives up on a non-retryable error immediately', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls += 1; throw Object.assign(new Error('bad key'), { status: 401 }); }, { maxRetries: 3, sleep: async () => {} }));
  assert.equal(calls, 1);
});

test('withRetry recovers after a transient failure', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('boom'), { status: 503 });
    return 'ok';
  }, { maxRetries: 3, sleep: async () => {} });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('resume picks up at the first incomplete step', () => {
  assert.equal(resumeStage({}), 'CLEANED');
  assert.equal(resumeStage({ cleaned_at: 1 }), 'ENRICHED');
  assert.equal(resumeStage({ cleaned_at: 1, enriched_at: 1, qualified_at: 1, qualified: true }), 'RESEARCHED');
  assert.equal(resumeStage({ cleaned_at: 1, enriched_at: 1, qualified_at: 1, qualified: false }), null, 'a disqualified lead is not resumed');
  assert.equal(resumeStage({ cleaned_at: 1, enriched_at: 1, qualified_at: 1, qualified: true, researched_at: 1, message_generated_at: 1, approved_at: 1, first_sent_at: 1 }), null);
});

test('stages never move backwards', () => {
  assert.equal(nextStage('ENRICHED'), 'QUALIFIED');
  assert.equal(canAdvance('ENRICHED', 'QUALIFIED'), true);
  assert.equal(canAdvance('QUALIFIED', 'ENRICHED'), false);
  assert.equal(workflowFor('QUALIFIED'), 'wf05-research');
});

test('progress reads as a checklist', () => {
  const progress = progressOf({ discovered_at: 1, cleaned_at: 1, enriched_at: 1, qualified_at: 1, researched_at: 1, message_generated_at: 1 });
  assert.deepEqual(progress.filter((p) => p.done).map((p) => p.step), ['Scraped', 'Cleaned', 'Enriched', 'Qualified', 'AI Research', 'Message Generated']);
  assert.equal(progress.find((p) => p.step === 'Approved').done, false);
});
