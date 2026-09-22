#!/usr/bin/env node
// Check config/ before it reaches the database or a campaign run.
// Catches the mistakes that would otherwise show up as an empty queue at 6am:
// a campaign pointing at a niche that does not exist, a follower band that can
// never match, an angle override that was renamed, a threshold above every band.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

export function validateConfig() {
  const problems = [];
  const warnings = [];

  const niches = read('config/niches.json').niches;
  const scoring = read('config/scoring.default.json');
  const followups = read('config/followups.default.json');
  const cleaning = read('config/cleaning.json');
  const providers = read('config/providers.json');
  const campaigns = readdirSync(join(ROOT, 'config/campaigns'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, config: read(join('config/campaigns', f)) }));

  // --- niches ---
  const nicheIds = new Set();
  for (const niche of niches) {
    if (nicheIds.has(niche.id)) problems.push(`niches: duplicate id "${niche.id}"`);
    nicheIds.add(niche.id);
    if (!niche.search_terms?.length) problems.push(`niche ${niche.id}: no search terms - discovery would find nothing`);
    if (!niche.outreach_angles?.length) problems.push(`niche ${niche.id}: no outreach angles - messages would fall back to a generic pitch`);
    if (!niche.keywords?.length) problems.push(`niche ${niche.id}: no keywords - the cleaning stage cannot confirm the niche`);
    const rules = niche.icp_rules ?? {};
    if (rules.min_followers != null && rules.max_followers != null && rules.min_followers > rules.max_followers) {
      problems.push(`niche ${niche.id}: min_followers is above max_followers`);
    }
    for (const angle of niche.outreach_angles ?? []) {
      if (!angle.id || !angle.hook) problems.push(`niche ${niche.id}: angle "${angle.id ?? '?'}" needs an id and a hook`);
    }
    const overlap = (niche.keywords ?? []).filter((k) => (niche.negative_keywords ?? []).includes(k));
    if (overlap.length) problems.push(`niche ${niche.id}: "${overlap.join(', ')}" is both a keyword and a negative keyword`);
  }

  // --- scoring ---
  const weightTotal = Object.values(scoring.weights ?? {}).reduce((a, b) => a + b, 0);
  if (!weightTotal) problems.push('scoring: all weights are zero');
  const bands = [...(scoring.bands ?? [])].sort((a, b) => b.min_score - a.min_score);
  if (!bands.length) problems.push('scoring: no bands defined');
  if (bands.length && bands[bands.length - 1].min_score !== 0) {
    warnings.push('scoring: the lowest band does not start at 0, so some scores fall into no band');
  }
  for (const [name] of Object.entries(scoring.weights ?? {})) {
    if (!scoring.sources?.[name]) warnings.push(`scoring: weight "${name}" has no source declared (defaults to deterministic)`);
  }

  // --- campaigns ---
  for (const { file, config } of campaigns) {
    const label = `campaign ${file}`;
    if (!config.id) problems.push(`${label}: no id`);
    if (!nicheIds.has(config.niche_id)) problems.push(`${label}: niche_id "${config.niche_id}" does not exist in config/niches.json`);

    const icp = config.icp ?? {};
    if (icp.min_followers > icp.max_followers) problems.push(`${label}: min_followers is above max_followers`);
    if (icp.min_followers < (scoring.hard_gates?.min_followers_absolute ?? 0)) {
      warnings.push(`${label}: min_followers (${icp.min_followers}) is below the absolute hard gate (${scoring.hard_gates.min_followers_absolute}) - the gate wins`);
    }
    if (icp.max_followers > (scoring.hard_gates?.max_followers_absolute ?? Infinity)) {
      warnings.push(`${label}: max_followers is above the absolute hard gate - the gate wins`);
    }
    const highestBand = bands[0]?.min_score ?? 100;
    if (icp.min_icp_score > highestBand) {
      problems.push(`${label}: min_icp_score ${icp.min_icp_score} is above the highest band threshold ${highestBand} - nothing could ever qualify`);
    }
    for (const band of icp.queue_bands ?? []) {
      if (!bands.some((b) => b.label === band)) problems.push(`${label}: queue_bands references unknown band "${band}"`);
    }
    if (!config.targeting?.states?.length && !config.targeting?.cities?.length) {
      problems.push(`${label}: no target states or cities`);
    }

    const niche = niches.find((n) => n.id === config.niche_id);
    const override = config.outreach?.angle_override;
    if (override && niche && !niche.outreach_angles.some((a) => a.id === override)) {
      problems.push(`${label}: angle_override "${override}" is not an angle of niche "${niche.id}"`);
    }

    const offsets = config.followups?.day_offsets ?? [];
    if (config.followups?.enabled !== false) {
      if (!offsets.length) warnings.push(`${label}: follow-ups are enabled but no day_offsets are set`);
      if (offsets.some((d, i) => i > 0 && d <= offsets[i - 1])) {
        problems.push(`${label}: follow-up day_offsets must increase - got [${offsets.join(', ')}]`);
      }
      if (offsets.length > 3) warnings.push(`${label}: ${offsets.length} follow-ups configured, but only 3 step kinds exist - extras are ignored`);
      if (offsets[0] === 0) problems.push(`${label}: the first follow-up cannot be on day 0 - that is the initial DM`);
    }

    const window = config.followups?.send_window;
    if (window && window.start_hour >= window.end_hour) {
      problems.push(`${label}: send_window start_hour is not before end_hour`);
    }

    if (config.outreach?.require_human_approval === false) {
      warnings.push(`${label}: human approval is switched OFF - messages would be released without review`);
    }
    if (config.outreach?.sending_mode === 'graph_api') {
      warnings.push(`${label}: sending_mode is graph_api. The Instagram Messaging API cannot start a conversation, so first-touch DMs still fall back to a human.`);
    }
    for (const variation of config.outreach?.variations ?? []) {
      if (!['conversational', 'professional', 'concise'].includes(variation)) {
        problems.push(`${label}: unknown message variation "${variation}"`);
      }
    }
    if (config.mirror?.sheets_enabled && !config.mirror?.spreadsheet_id && !process.env.GOOGLE_SHEETS_SPREADSHEET_ID) {
      warnings.push(`${label}: the Sheets mirror is on but no spreadsheet_id is set here or in the environment`);
    }
  }

  // --- providers ---
  for (const [capability, spec] of Object.entries(providers.capabilities ?? {})) {
    if (!spec.adapters?.[spec.active]) {
      problems.push(`providers: capability "${capability}" is set to "${spec.active}", which has no adapter`);
    }
    for (const fallback of spec.fallback ?? []) {
      if (!spec.adapters?.[fallback]) problems.push(`providers: "${capability}" fallback "${fallback}" has no adapter`);
    }
  }

  // --- cleaning + follow-up defaults ---
  if (!cleaning.blocked_keywords?.terms?.length) warnings.push('cleaning: no blocked keywords - competitors and agencies would pass through');
  if (followups.stop_on_reply !== true) problems.push('followups: stop_on_reply must be true');
  for (const status of ['REPLIED', 'INTERESTED', 'NOT_INTERESTED', 'OPTED_OUT']) {
    if (!followups.stop_on_statuses?.includes(status)) problems.push(`followups: stop_on_statuses is missing "${status}"`);
  }

  return { problems, warnings, counts: { niches: niches.length, campaigns: campaigns.length } };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { problems, warnings, counts } = validateConfig();
  console.log(`Checked ${counts.niches} niches and ${counts.campaigns} campaigns.`);
  for (const warning of warnings) console.log(`  warning: ${warning}`);
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('Configuration is consistent.');
}
