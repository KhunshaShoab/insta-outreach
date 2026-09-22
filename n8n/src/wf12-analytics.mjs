// WORKFLOW 12 - Analytics, Daily Report & Optional Sheets Mirror
// Counts come from the database; the model only writes the narrative, and is
// told not to declare a winner. Small samples are reported as small samples.
import { workflow, schedule, webhook, respond, code, supabase, rpc, anthropic, ifNode, http, noop } from '../dsl.mjs';
import { withLib, promptConst, schemaConst } from '../bundle.mjs';

export function build() {
  const wf = workflow('wf12-analytics', {
    description: 'Daily metrics, narrative report and the optional Google Sheets mirror.',
    tags: ['optiflow', 'reporting']
  });

  const cron = wf.add(schedule('Daily Report', '0 18 * * *'));
  const onDemand = wf.add(webhook('Report On Demand', 'optiflow/report', 'GET'), { column: 0, row: 1 });

  const campaigns = wf.add(supabase('Load Active Campaigns', {
    method: 'GET', path: 'campaigns', query: '?status=eq.active&select=id,name,mirror'
  }), { column: 1, row: 0 });

  const metrics = wf.add(rpc('Compute Daily Metrics', 'daily_report',
    '={{ JSON.stringify({ p_day: new Date().toISOString().slice(0,10), p_campaign_id: null }) }}',
    { notes: 'One SQL function returns every counter plus the niche/state/angle breakdowns. The model never recalculates them.' }),
    { column: 2, row: 0 });

  const prepare = wf.add(code('Prepare Report Input', withLib(['lib/prompts.js'], `
${promptConst('10-daily-report.md', 'PROMPT')}

const raw = $input.first().json;
const metrics = Array.isArray(raw) ? raw[0] : raw;
const campaigns = ($('Load Active Campaigns').first().json || []);

// Derived rates, computed here so the model is handed finished numbers.
const rate = (numerator, denominator) => denominator ? Math.round((numerator / denominator) * 1000) / 10 : null;
const summary = {
  ...metrics,
  qualification_rate: rate(metrics.leads_qualified, metrics.leads_evaluated),
  reply_rate: rate(metrics.replies, metrics.messages_sent),
  positive_reply_rate: rate(metrics.positive_replies, metrics.messages_sent),
  approval_rate: rate(metrics.messages_approved, metrics.messages_generated),
  // No ranking_metric is set, so the prompt is not permitted to name a winner.
  ranking_metric: null
};

const rendered = renderPrompt(PROMPT, {
  report: {
    day: metrics.day,
    campaigns: (Array.isArray(campaigns) ? campaigns : [campaigns]).map((c) => c.name).join(', ') || 'all',
    metrics: summary,
    by_niche: metrics.by_niche ?? [],
    by_state: metrics.by_state ?? [],
    by_angle: metrics.by_angle ?? [],
    reply_categories: metrics.reply_categories ?? [],
    objections: metrics.objections ?? [],
    errors: { open: metrics.errors_open ?? 0 }
  }
});

return [{ json: {
  day: metrics.day,
  metrics: summary,
  breakdowns: {
    by_niche: metrics.by_niche ?? [],
    by_state: metrics.by_state ?? [],
    by_angle: metrics.by_angle ?? [],
    reply_categories: metrics.reply_categories ?? [],
    objections: metrics.objections ?? []
  },
  prompt: rendered.prompt,
  model: $env.ANTHROPIC_MODEL || 'claude-sonnet-5',
  max_tokens: rendered.max_tokens,
  temperature: rendered.temperature
} }];
`), { notes: 'ranking_metric stays null unless the operator picks one, which is what stops the report inventing a "best niche" from three replies.' }), { column: 3, row: 0 });

  const claude = wf.add(anthropic('Claude: Write Narrative'), { column: 4, row: 0 });

  const parse = wf.add(code('Parse Narrative', withLib(['lib/json.js'], `
${schemaConst('daily-report-summary.schema.json', 'REPORT_SCHEMA')}

const context = $('Prepare Report Input').first().json;
const text = ($input.first().json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\\n');
const parsed = parseAiJson(text, REPORT_SCHEMA, { label: 'daily report' });

// The numbers stand on their own. If the narrative fails, the report still goes
// out with the measured figures.
const narrative = parsed.ok ? parsed.data : {
  headline: 'Narrative unavailable - figures below are unaffected.',
  observations: [],
  attention: [{ issue: 'report_narrative_failed', detail: (parsed.errors || []).slice(0, 3).join('; '), suggested_action: 'Check the model response in the execution log.' }]
};

return [{ json: { ...context, narrative } }];
`)), { column: 5, row: 0 });

  const store = wf.add(supabase('Store Daily Metrics', {
    method: 'POST',
    path: 'daily_metrics',
    query: '?on_conflict=day,campaign_id',
    body: `={{ JSON.stringify({
      day: $json.day,
      campaign_id: null,
      metrics: { ...$json.metrics, breakdowns: $json.breakdowns, narrative: $json.narrative }
    }) }}`,
    continueOnFail: true
  }), { column: 6, row: 0 });

  const format = wf.add(code('Format Report', `
const row = $('Parse Narrative').first().json;
const m = row.metrics;
const n = row.narrative;
const line = (label, value) => label + ': ' + (value ?? 0);
const pct = (value) => value === null || value === undefined ? 'n/a' : value + '%';

const text = [
  'OptiFlow Instagram Outreach - ' + row.day,
  '',
  n.headline,
  '',
  line('Leads discovered', m.leads_discovered),
  line('Leads enriched', m.leads_enriched),
  line('Qualified', m.leads_qualified),
  'Qualification rate: ' + pct(m.qualification_rate),
  line('Messages generated', m.messages_generated),
  line('Messages approved', m.messages_approved),
  line('Messages sent', m.messages_sent),
  line('Replies', m.replies),
  'Reply rate: ' + pct(m.reply_rate),
  line('Positive replies', m.positive_replies),
  'Positive reply rate: ' + pct(m.positive_reply_rate),
  line('Follow-ups due', m.followups_due),
  line('Interested', m.interested_total),
  line('Nurture', m.nurture_total),
  line('Not interested', m.not_interested_total),
  line('Open errors', m.errors_open),
  '',
  'Measured by niche (reply rate - sample size in brackets):',
  ...(row.breakdowns.by_niche || []).map((x) => '  ' + (x.niche_id ?? 'unknown') + ': ' + pct(x.reply_rate) + ' (' + (x.sent ?? 0) + ' sent)'),
  '',
  'Measured by state:',
  ...(row.breakdowns.by_state || []).map((x) => '  ' + (x.state ?? 'unknown') + ': ' + pct(x.reply_rate) + ' (' + (x.sent ?? 0) + ' sent)'),
  '',
  'Measured by outreach angle:',
  ...(row.breakdowns.by_angle || []).map((x) => '  ' + (x.outreach_angle ?? 'unknown') + ': ' + pct(x.reply_rate) + ' (' + (x.sent ?? 0) + ' sent)'),
  '',
  ...(n.segments_too_small_to_read?.length ? ['Too little data to read yet: ' + n.segments_too_small_to_read.join(', '), ''] : []),
  ...(n.observations?.length ? ['Observations:', ...n.observations.map((o) => '  - ' + o), ''] : []),
  ...(n.questions_seen?.length ? ['Common questions:', ...n.questions_seen.map((q) => '  - ' + q.theme + ' (' + q.count + ')'), ''] : []),
  ...(n.objections_seen?.length ? ['Common objections:', ...n.objections_seen.map((o) => '  - ' + o.theme + ' (' + o.count + ')'), ''] : []),
  ...(n.attention?.length ? ['Needs attention:', ...n.attention.map((a) => '  - ' + a.issue + ': ' + (a.detail ?? '') + ' -> ' + (a.suggested_action ?? '')), ''] : [])
].join('\\n');

return [{ json: { ...row, report_text: text } }];
`), { column: 7, row: 0 });

  const deliver = wf.add(http('Deliver Report', {
    method: 'POST',
    url: '={{ $env.OPERATOR_WEBHOOK_URL || "https://example.invalid/noop" }}',
    body: '={{ JSON.stringify({ text: $json.report_text }) }}',
    continueOnFail: true,
    errorOutput: false
  }), { column: 8, row: 0 });

  const respondNow = wf.add(respond('Respond', '={{ { ok: true, day: $json.day, report: $json.report_text, metrics: $json.metrics } }}'), { column: 9, row: 0 });

  // --- optional Sheets mirror ---
  const mirrorGate = wf.add(ifNode('Sheets Mirror Enabled?', {
    left: '={{ String($env.SHEETS_ENABLED).toLowerCase() === "true" }}',
    operator: { type: 'boolean', operation: 'true', singleValue: true }
  }, { notes: 'Off by default. The database is the source of truth; the sheet is a read-only convenience view.' }), { column: 6, row: 1 });

  const exportRows = wf.add(supabase('Read Sheets Export View', {
    method: 'GET',
    path: 'v_sheets_export',
    query: '?select=*&limit=1000',
    notes: 'The view defines the exact column set, so the sheet layout lives in SQL rather than in a node.'
  }), { column: 7, row: 1 });

  const pushSheet = wf.add(http('Push To Google Sheets', {
    method: 'POST',
    url: '=https://sheets.googleapis.com/v4/spreadsheets/{{ $env.GOOGLE_SHEETS_SPREADSHEET_ID }}/values/{{ $env.GOOGLE_SHEETS_TAB }}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
    headers: [{ name: 'Authorization', value: '=Bearer {{ $env.GOOGLE_SHEETS_ACCESS_TOKEN }}' }],
    body: '={{ JSON.stringify({ values: $input.all().map(i => Object.values(i.json)) }) }}',
    continueOnFail: true,
    notes: 'Replace with the n8n Google Sheets node if you prefer its OAuth handling - config/providers.json capability "mirror".'
  }), { column: 8, row: 1 });

  const noMirror = wf.add(noop('Mirror Disabled'), { column: 7, row: 2 });

  wf.connect(cron, campaigns);
  wf.connect(onDemand, campaigns);
  wf.chain(campaigns, metrics, prepare, claude, parse, store, format, deliver, respondNow);
  wf.connect(store, mirrorGate);
  wf.connect([mirrorGate, 0], exportRows);
  wf.connect(exportRows, pushSheet);
  wf.connect([mirrorGate, 1], noMirror);

  return wf.toJSON();
}
