import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontMatter, renderTemplate, renderPrompt, templateVariables } from '../lib/prompts.js';
import { validate } from '../lib/validate.js';
import { parseAiJson, extractJson } from '../lib/json.js';
import { create as createMockAi } from '../lib/providers/ai.mock.js';
import { ROOT, readJson, campaign, nicheById, goodMedspa, founderContact } from './fixtures.mjs';

const PROMPT_DIR = join(ROOT, 'prompts');
const files = readdirSync(PROMPT_DIR).filter((f) => f.endsWith('.md'));
const medspa = nicheById('medspas');

const SCHEMA_FILES = {
  qualification: 'qualification.schema.json',
  decision_maker: 'decision-maker.schema.json',
  research: 'research.schema.json',
  outreach_angle: 'outreach-angle.schema.json',
  outreach_message: 'outreach-message.schema.json',
  followup_message: 'followup-message.schema.json',
  reply_classification: 'reply-classification.schema.json',
  suggested_response: 'suggested-response.schema.json',
  conversation_analysis: 'conversation-analysis.schema.json',
  daily_report_summary: 'daily-report-summary.schema.json'
};

test('every prompt has complete front matter and the required sections', () => {
  assert.equal(files.length, 10, 'expected ten production prompts');
  for (const file of files) {
    const { meta, body } = parseFrontMatter(readFileSync(join(PROMPT_DIR, file), 'utf8'));
    assert.ok(meta.id, `${file}: missing id`);
    assert.ok(meta.version, `${file}: missing version`);
    assert.ok(meta.schema, `${file}: missing schema`);
    assert.ok(typeof meta.max_tokens === 'number', `${file}: missing max_tokens`);
    for (const section of ['ROLE', 'INPUT', 'TASK', 'OUTPUT FORMAT', 'JSON SCHEMA', 'EDGE CASES']) {
      assert.ok(body.includes(section), `${file}: missing the ${section} section`);
    }
    assert.ok(/Return ONLY a JSON object/i.test(body), `${file}: does not demand strict JSON`);
    assert.ok(body.length > 800, `${file}: too thin to be production-ready`);
  }
});

test('each prompt names a schema that exists in schemas/', () => {
  for (const file of files) {
    const { meta } = parseFrontMatter(readFileSync(join(PROMPT_DIR, file), 'utf8'));
    const schemaFile = SCHEMA_FILES[meta.schema];
    assert.ok(schemaFile, `${file}: schema "${meta.schema}" is not mapped`);
    const schema = readJson(join('schemas', schemaFile));
    assert.equal(schema.type, 'object');
    assert.ok(Array.isArray(schema.required) && schema.required.length > 0);
  }
});

test('the qualification prompt renders with real campaign data', () => {
  const { meta, body } = parseFrontMatter(readFileSync(join(PROMPT_DIR, '01-qualification.md'), 'utf8'));
  const rendered = renderPrompt({ meta, body }, {
    campaign, niche: medspa, lead: goodMedspa, company: { company_size: '8', employee_count: 8 },
    contacts: [`${founderContact.full_name} - ${founderContact.title}`]
  });
  assert.ok(rendered.prompt.includes('Glow Med Spa'));
  assert.ok(rendered.prompt.includes('California Medspa Outreach'));
  assert.ok(rendered.prompt.includes('- Botox'));
  assert.ok(!rendered.prompt.includes('{{'), 'no unfilled placeholders');
  assert.equal(rendered.schema_name, 'qualification');
});

test('a missing required variable fails loudly instead of sending a broken prompt', () => {
  assert.throws(
    () => renderTemplate('Business: {{lead.business_name}} in {{lead.city}}', { lead: {} }),
    /missing required variables: lead.business_name, lead.city/
  );
});

test('optional placeholders degrade gracefully', () => {
  const out = renderTemplate('Website: {{lead.website?}} | Bio: {{lead.bio?}}', { lead: {} });
  assert.equal(out, 'Website: (not available) | Bio: (not available)');
});

test('list and json placeholders render readable blocks', () => {
  assert.equal(renderTemplate('{{list:items}}', { items: ['a', 'b'] }), '- a\n- b');
  assert.equal(renderTemplate('{{list:items}}', { items: [] }), '- (none)');
  assert.equal(renderTemplate('{{json:obj}}', { obj: { a: 1 } }), '{\n  "a": 1\n}');
});

test('templateVariables documents what each prompt needs', () => {
  const { body } = parseFrontMatter(readFileSync(join(PROMPT_DIR, '05-outreach-message.md'), 'utf8'));
  const vars = templateVariables(body);
  assert.ok(vars.required.includes('lead.business_name'));
  assert.ok(vars.required.includes('angle.hook'));
  assert.ok(vars.optional.includes('decision_maker.address_as'));
});

test('the outreach prompt forbids the phrases that make a DM look automated', () => {
  const body = readFileSync(join(PROMPT_DIR, '05-outreach-message.md'), 'utf8');
  for (const banned of ['leading BPO', 'love your page', 'hope this message finds you well', 'list of services']) {
    assert.ok(body.toLowerCase().includes(banned.toLowerCase()), `outreach prompt should ban "${banned}"`);
  }
});

test('the follow-up prompt forbids empty follow-ups', () => {
  const body = readFileSync(join(PROMPT_DIR, '06-followup-message.md'), 'utf8').toLowerCase();
  for (const banned of ['just following up', 'circling back', 'bumping this']) {
    assert.ok(body.includes(banned), `follow-up prompt should ban "${banned}"`);
  }
});

test('the reply classifier covers every category the database accepts', () => {
  const body = readFileSync(join(PROMPT_DIR, '07-reply-classification.md'), 'utf8');
  for (const category of ['interested', 'curious', 'question', 'wants_details', 'pricing', 'positive',
    'maybe_later', 'not_interested', 'wrong_person', 'objection', 'unclear', 'opt_out']) {
    assert.ok(body.includes(category), `classifier is missing "${category}"`);
  }
});

test('the daily report prompt refuses to declare a winner unprompted', () => {
  const body = readFileSync(join(PROMPT_DIR, '10-daily-report.md'), 'utf8');
  assert.ok(/Do not declare a "best"/i.test(body));
  assert.ok(/ranking_metric/.test(body), 'ranking is only allowed when the operator picks a metric');
});

test('mock AI responses satisfy their schemas', async () => {
  const ai = createMockAi({}, {});
  const cases = [
    ['ICP qualification analyst', 'qualification'],
    ['decision-maker', 'decision_maker'],
    ['research analyst', 'research'],
    ['outreach angle selector', 'outreach_angle'],
    ['outreach writer', 'outreach_message'],
    ['follow-up writer', 'followup_message'],
    ['reply classification analyst', 'reply_classification'],
    ['response assistant', 'suggested_response'],
    ['conversation analysis engine', 'conversation_analysis'],
    ['daily report writer', 'daily_report_summary']
  ];
  for (const [marker, schemaKey] of cases) {
    const { data, mock_kind } = await ai.complete({ prompt: `You are the ${marker} for OptiFlow.` });
    assert.equal(mock_kind, schemaKey, `mock did not recognise the ${schemaKey} prompt`);
    const schema = readJson(join('schemas', SCHEMA_FILES[schemaKey]));
    const { valid, errors } = validate(data, schema);
    assert.ok(valid, `${schemaKey}: ${errors.join('; ')}`);
  }
});

test('malformed model output is recovered or rejected, never half-parsed', () => {
  const schema = readJson('schemas/reply-classification.schema.json');
  const good = JSON.stringify({
    classification: 'interested', intent: 'wants details', sentiment: 'positive', urgency: 'high',
    recommended_action: 'continue_conversation', stop_followups: true, requires_human: false, suggested_stage: 'REPLIED'
  });

  assert.equal(parseAiJson(good, schema).ok, true);
  assert.equal(parseAiJson('```json\n' + good + '\n```', schema).ok, true, 'fenced JSON is recovered');
  assert.equal(parseAiJson('Sure! Here is the result:\n' + good, schema).ok, true, 'a preamble is stripped');

  const noJson = parseAiJson('I cannot help with that.', schema);
  assert.equal(noJson.ok, false);
  assert.match(noJson.retry_prompt, /Return ONLY the JSON object/);

  const wrongEnum = parseAiJson(JSON.stringify({ ...JSON.parse(good), classification: 'very_interested' }), schema);
  assert.equal(wrongEnum.ok, false);
  assert.match(wrongEnum.retry_prompt, /classification/);

  assert.equal(extractJson('{"nested":{"a":[1,2,{"b":"}"}]}}').nested.a[2].b, '}', 'braces inside strings do not confuse the extractor');
});
