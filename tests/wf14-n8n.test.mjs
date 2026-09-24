// Executes the generated n8n workflow's Code nodes against real data.
//
// Generating valid JSON is not the same as the workflow working. This harness
// runs each Code node the way n8n does - inside an async function with $input,
// $(), $env and $execution - and feeds real rows through the chain, so a break
// is caught here rather than after an import into n8n.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures.mjs';

const WORKFLOW = JSON.parse(readFileSync(join(ROOT, 'n8n/workflows/wf14-v1-lead-intelligence.json'), 'utf8'));
const nodeByName = Object.fromEntries(WORKFLOW.nodes.map((n) => [n.name, n]));

const UPLOADS = '/root/.claude/uploads/c024dea2-8e1d-5b15-ad5b-89359a0fa4cc';
const MEDSPA_FILE = join(UPLOADS, 'edef5bf2-Ostnyx_Leads_Ready.xlsx');

/**
 * Run a Code node the way n8n runs it.
 * @param {string} name      node name in the workflow
 * @param {Array}  items     the node's input items
 * @param {object} upstream  { 'Node Name': items } for $('Node Name')
 */
async function runCodeNode(name, items, upstream = {}, env = {}) {
  const node = nodeByName[name];
  assert.ok(node, `no node named "${name}" in the workflow`);
  assert.equal(node.type, 'n8n-nodes-base.code', `"${name}" is not a Code node`);

  const wrap = (list) => ({
    all: () => list,
    first: () => list[0],
    last: () => list[list.length - 1],
    item: list[0]
  });

  const $input = wrap(items);
  const $ = (nodeName) => {
    const found = upstream[nodeName];
    assert.ok(found, `the node asked for $('${nodeName}'), which the test did not supply`);
    return wrap(found);
  };
  const $env = env;
  const $execution = { id: 'test-execution' };

  const fn = new Function('$input', '$', '$env', '$execution', '$json',
    `return (async () => {\n${node.parameters.jsCode}\n})();`);
  return fn($input, $, $env, $execution, items[0]?.json);
}

test('the workflow has the stages the brief asked for, in order', () => {
  const names = WORKFLOW.nodes.map((n) => n.name);
  for (const expected of [
    'Upload Lead File', 'Detect File Type', 'Read Spreadsheet', 'Read CSV',
    'Clean, Deduplicate, Check Niche', 'For Each Lead', 'Fetch Page',
    'Extract Evidence, Score, Recommend', 'Write A Message?',
    'Render Message Prompt', 'Claude: Write The Message', 'Parse Message',
    'Shape Row For The Sheet', 'Append To Review Sheet'
  ]) {
    assert.ok(names.includes(expected), `missing node: ${expected}`);
  }
});

test('the workflow cannot send an Instagram message', () => {
  const blob = JSON.stringify(WORKFLOW).toLowerCase();
  assert.ok(!blob.includes('graph.facebook.com'), 'no Instagram send endpoint may appear');
  assert.ok(!blob.includes('mark_outreach_sent'), 'V1 does not mark anything as sent');
  assert.ok(!blob.includes('instagram.com/direct'), 'no direct-message endpoint');
});

test('every lead reaches the output sheet, including the skipped ones', () => {
  // Both branches of the message decision converge on the row shaper, so a
  // lead that gets no message still lands in the sheet with its reason.
  const connections = WORKFLOW.connections;
  assert.equal(connections['Parse Message'].main[0][0].node, 'Shape Row For The Sheet');
  assert.equal(connections['Record Why No Message'].main[0][0].node, 'Shape Row For The Sheet');
  // And a Claude failure routes to the same place rather than dropping the lead.
  assert.equal(connections['Claude: Write The Message'].main[1][0].node, 'Record Why No Message');
});

test('Detect File Type reads the extension and rejects anything else', async () => {
  const xlsx = await runCodeNode('Detect File Type', [{
    json: { 'How many leads this run': 20, 'Skip the first N leads': 5 },
    binary: { Lead_File: { fileName: 'medspas.xlsx', mimeType: 'application/octet-stream' } }
  }]);
  assert.equal(xlsx[0].json.file_type, 'xlsx');
  assert.equal(xlsx[0].json.limit, 20);
  assert.equal(xlsx[0].json.offset, 5);
  assert.equal(xlsx[0].json.binary_property, 'Lead_File');

  const csv = await runCodeNode('Detect File Type', [{
    json: {}, binary: { Lead_File: { fileName: 'leads.CSV' } }
  }]);
  assert.equal(csv[0].json.file_type, 'csv');
  assert.equal(csv[0].json.limit, 15, 'an empty field falls back to the default');

  await assert.rejects(
    () => runCodeNode('Detect File Type', [{ json: {}, binary: { f: { fileName: 'notes.pdf' } } }]),
    /Upload an \.xlsx or \.csv/
  );
  await assert.rejects(
    () => runCodeNode('Detect File Type', [{ json: {} }]),
    /No file was uploaded/
  );
});

test('the cleaning node turns real spreadsheet rows into a ranked batch', async () => {
  if (!existsSync(MEDSPA_FILE)) { console.log('    (skipped: attached file not present)'); return; }
  // Rows exactly as n8n's Extract From File node would emit them.
  const { readXlsx } = await import('../lib/v1/xlsx.js');
  const { rows } = readXlsx(MEDSPA_FILE, { sheet: 'Leads' });
  const items = rows.slice(0, 300).map((r) => {
    const { __row, ...rest } = r;
    return { json: rest };
  });

  const out = await runCodeNode('Clean, Deduplicate, Check Niche', items, {
    'Detect File Type': [{ json: { file_name: 'medspas.xlsx', limit: 10, offset: 0 } }]
  });

  assert.equal(out.length, 10, 'the batch respects the limit from the form');
  const run = out[0].json._run;
  assert.equal(run.rows_read, 300);
  assert.ok(run.distinct < 300, 'duplicates were merged');
  assert.equal(run.niche, 'medspa', 'the niche is detected from the file');
  assert.ok(run.in_niche > 0);

  for (const item of out) {
    assert.ok(item.json.company_name, 'every lead has a name');
    assert.ok(item.json.source_file, 'every lead records its source file');
    assert.ok(item.json.original_row, 'every lead records its source row');
    assert.ok(['IN_NICHE', 'UNCERTAIN', 'OFF_NICHE'].includes(item.json.niche_match));
  }
  assert.equal(out[0].json.niche_match, 'IN_NICHE', 'in-niche leads are processed first');
});

test('the cleaning node fails with a readable message when the columns are wrong', async () => {
  await assert.rejects(
    () => runCodeNode('Clean, Deduplicate, Check Niche',
      [{ json: { Foo: 'a', Bar: 'b' } }],
      { 'Detect File Type': [{ json: { file_name: 'x.xlsx', limit: 5, offset: 0 } }] }),
    /No column in the file looks like a company name/
  );
});

test('Build Page URLs asks for two pages, or none when there is no website', async () => {
  const withSite = await runCodeNode('Build Page URLs', [{ json: { company_name: 'A', domain: 'example.com' } }]);
  assert.equal(withSite.length, 2);
  assert.deepEqual(withSite.map((i) => i.json._page_label), ['homepage', 'contact']);
  assert.equal(withSite[0].json._page_url, 'https://example.com/');

  const without = await runCodeNode('Build Page URLs', [{ json: { company_name: 'B', domain: null } }]);
  assert.equal(without.length, 1);
  assert.equal(without[0].json._skip_fetch, true);
});

test('the analysis node scores a real fetched page and finds the Instagram account', async () => {
  const lead = {
    company_name: 'Nova Aesthetics and Medical Wellness', name_normalized: 'nova aesthetics and medical wellness',
    domain: 'novaaestheticswellness.com', website: 'https://novaaestheticswellness.com',
    city: 'Conway', state: 'AR', category: 'Medical spa', phone_e164: '+15012054443',
    rating: 5, review_count: 408, niche_match: 'IN_NICHE', niche_match_reason: 'matches',
    source_file: 'medspas.xlsx', original_row: 3
  };
  // A real page body, so the extractor is tested against real markup.
  const html = `<html><head><title>Nova Aesthetics</title></head><body>
    <a href="tel:+15012054443">Call us</a><a href="tel:+15012054443">Call</a><a href="tel:+15012054443">Call now</a>
    <p>Call us today to schedule your consultation.</p>
    <a href="https://www.aestheticrecord.com/booking/nova">Book now</a>
    <a href="https://www.instagram.com/novaaestheticsmedicalwellness/">Instagram</a>
    <a href="mailto:hello@novaaestheticswellness.com">Email</a></body></html>`;

  const out = await runCodeNode('Extract Evidence, Score, Recommend',
    [{ json: { ...lead, _page_url: 'https://novaaestheticswellness.com/', _page_label: 'homepage', data: html } }],
    { 'For Each Lead': [{ json: lead }] });

  const r = out[0].json;
  assert.equal(r.business_instagram, 'novaaestheticsmedicalwellness');
  assert.equal(r.instagram_confidence, 'HIGH');
  assert.ok(r.ai_voice_score > r.customer_support_score, 'phone and booking evidence favours AI voice');
  assert.ok(['BEST', 'GOOD'].includes(r.classification), `expected a good classification, got ${r.classification}`);
  assert.equal(r.recommended_offer, 'AI_VOICE');
  assert.equal(r.review_status, 'PENDING');
  assert.equal(r.wants_message, true);
  assert.ok(r.opportunity_signals.includes('Evidence:'), 'signals are rendered for the sheet');
  assert.ok(r.opportunity_signals.includes('Interpretation:'));
  assert.ok(Array.isArray(r.signals) && r.signals.length >= 3);
  assert.ok(r.lead_id.endsWith(':3'), 'the lead id carries the source row');
});

test('a blocked website becomes a caveat and a capped score, not a silent zero', async () => {
  const lead = {
    company_name: 'Nirvana Med Spa', name_normalized: 'nirvana med spa', domain: 'nirvana-medspa.com',
    city: 'Little Rock', state: 'AR', category: 'Medical spa', rating: 4.7, review_count: 201,
    niche_match: 'IN_NICHE', niche_match_reason: 'matches', source_file: 'm.xlsx', original_row: 2
  };
  const out = await runCodeNode('Extract Evidence, Score, Recommend',
    [{ json: { ...lead, _page_url: 'https://nirvana-medspa.com/', _page_label: 'homepage', data: '', error: { status: 403 } } }],
    { 'For Each Lead': [{ json: lead }] });

  const r = out[0].json;
  assert.equal(r.website_reachable, false);
  assert.ok(r.opportunity_signals.includes('Website could not be read'));
  assert.ok(r.ai_voice_score <= 55, 'an unreadable site caps the score');
  assert.equal(r.wants_message, false, 'no message is written on no evidence');
});

test('a lead with no website still produces a row', async () => {
  const lead = {
    company_name: 'No Site Spa', name_normalized: 'no site spa', domain: null, category: 'Medical spa',
    niche_match: 'IN_NICHE', niche_match_reason: 'matches', source_file: 'm.xlsx', original_row: 9
  };
  const out = await runCodeNode('Extract Evidence, Score, Recommend',
    [{ json: { ...lead, _skip_fetch: true } }],
    { 'For Each Lead': [{ json: lead }] });
  assert.equal(out.length, 1);
  assert.ok(out[0].json.opportunity_signals.includes('No website on file'));
  assert.equal(out[0].json.wants_message, false);
});

test('the prompt renders with the real evidence and no unfilled placeholders', async () => {
  const lead = {
    company_name: 'Glo Medspa', business_instagram: 'glomedspa', category: 'Medical spa',
    city: 'Wilmington', state: 'NC', website: 'https://glomedspa.com', rating: 4.9, review_count: 1229,
    recommended_offer: 'AI_VOICE', offer_reason: 'phone and booking evidence',
    capability_line: 'an AI receptionist that answers inbound calls',
    research_summary: 'Read 2 pages. 12 click-to-call links.',
    owner_name: null,
    signals: [
      { signal: 'Phone is a prominent contact channel', evidence: '12 click-to-call links', interpretation: 'Phone appears important.', confidence: 'HIGH', source: 'https://glomedspa.com/' },
      { signal: 'Weak thing', evidence: 'category only', interpretation: 'maybe', confidence: 'LOW', source: 'file' }
    ]
  };
  const out = await runCodeNode('Render Message Prompt', [{ json: lead }], {}, { OPTIFLOW_SENDER_NAME: 'Alex' });
  const { prompt } = out[0].json;
  assert.ok(prompt.includes('Glo Medspa'));
  assert.ok(prompt.includes('12 click-to-call links'));
  assert.ok(!prompt.includes('{{'), 'no placeholder may survive rendering');
  assert.ok(!prompt.includes('Weak thing'), 'low-confidence signals are withheld from the writer');
  assert.ok(out[0].json.model);
});

test('a malformed model reply produces a stated reason, never a fake message', async () => {
  const lead = { company_name: 'X', prompt: 'p' };
  const out = await runCodeNode('Parse Message',
    [{ json: { content: [{ type: 'text', text: 'Sure! Here is a lovely message for you.' }] } }],
    { 'Render Message Prompt': [{ json: lead }] });
  assert.equal(out[0].json.personalized_instagram_dm, '');
  assert.match(out[0].json.pipeline_notes, /could not be generated in a valid form/);
});

test('a valid model reply is carried through, and failed self-checks are flagged', async () => {
  const good = {
    personalized_instagram_dm: 'Saw the 12 click-to-call links on your site. How do you handle the calls when the rooms are full?',
    char_count: 101, observation_used: '12 click-to-call links', capability_mentioned: 'AI receptionist',
    why_this_message: 'Phone-led operation.',
    self_check: { opens_with_verified_observation: true, no_invented_facts: true, no_assumed_pain: true, one_capability_only: true, ends_with_question: true, under_max_chars: true }
  };
  const ok = await runCodeNode('Parse Message',
    [{ json: { content: [{ type: 'text', text: JSON.stringify(good) }] } }],
    { 'Render Message Prompt': [{ json: { company_name: 'X' } }] });
  assert.match(ok[0].json.personalized_instagram_dm, /click-to-call/);
  assert.ok(!ok[0].json.pipeline_notes.includes('FLAGGED'));

  const flagged = await runCodeNode('Parse Message',
    [{ json: { content: [{ type: 'text', text: JSON.stringify({ ...good, self_check: { ...good.self_check, no_assumed_pain: false } }) }] } }],
    { 'Render Message Prompt': [{ json: { company_name: 'X' } }] });
  assert.match(flagged[0].json.pipeline_notes, /FLAGGED.*no_assumed_pain/);
});

test('a skipped lead records why, in words a person can act on', async () => {
  const offNiche = await runCodeNode('Record Why No Message', [{
    json: { company_name: 'Four Seasons Hotel', niche_match: 'OFF_NICHE', niche_match_reason: 'The business name identifies this as hospitality.' }
  }]);
  assert.match(offNiche[0].json.pipeline_notes, /hospitality/);

  const noOffer = await runCodeNode('Record Why No Message', [{
    json: { company_name: 'X', niche_match: 'IN_NICHE', recommended_offer: 'NONE', offer_reason: 'no evidence', classification: 'BAD' }
  }]);
  assert.match(noOffer[0].json.pipeline_notes, /evidence does not support an approach/);
  assert.equal(noOffer[0].json.personalized_instagram_dm, '');
});

test('the sheet row carries every output column, with the scoring rationale', async () => {
  const { OUTPUT_FIELDS } = await import('../lib/v1/schema.js');
  const out = await runCodeNode('Shape Row For The Sheet', [{
    json: {
      company_name: 'Glo Medspa', overall_score: 81, classification: 'BEST',
      score_reasons: ['reason one', 'reason two'], evidence_sources: 'https://glomedspa.com/',
      review_status: 'PENDING', extra_internal_field: 'should not appear'
    }
  }]);
  const row = out[0].json;
  assert.deepEqual(Object.keys(row).sort(), [...OUTPUT_FIELDS].sort(), 'exactly the output columns');
  assert.equal(row.score_reasons, 'reason one\nreason two', 'reasons are readable in a cell');
  assert.equal(row.review_status, 'PENDING');
});

test('the run summary counts what a person needs to see', async () => {
  const rows = [
    { classification: 'BEST', instagram_confidence: 'HIGH', recommended_offer: 'AI_VOICE', personalized_instagram_dm: 'hi', review_status: 'PENDING' },
    { classification: 'GOOD', instagram_confidence: 'HIGH', recommended_offer: 'BOTH', personalized_instagram_dm: 'hi', review_status: 'PENDING' },
    { classification: 'BAD', instagram_confidence: 'NOT_FOUND', recommended_offer: 'NONE', personalized_instagram_dm: '', review_status: 'PENDING' }
  ].map((json) => ({ json }));
  const out = await runCodeNode('Run Summary', rows);
  const s = out[0].json;
  assert.equal(s.leads_processed, 3);
  assert.equal(s.best, 1);
  assert.equal(s.good, 1);
  assert.equal(s.bad, 1);
  assert.equal(s.messages_written, 2);
  assert.equal(s.instagram_high_confidence, 2);
  assert.equal(s.all_rows_pending_review, true);
  assert.match(s.note, /Nothing was sent/);
});
