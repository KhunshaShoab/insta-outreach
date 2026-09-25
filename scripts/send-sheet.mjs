#!/usr/bin/env node
// Turn a finished run into the short sheet you actually send from.
//
// The full output carries 40 columns because a reviewer sometimes needs the
// evidence, the score reasons and the provenance. Nobody sends from 40 columns.
// This writes the rows that earned a message, best first, with the six columns
// needed to open Instagram and paste - plus a tick box for what has gone out.
//
//   node scripts/send-sheet.mjs out/medspas-complete.json
//   node scripts/send-sheet.mjs out/medspas-complete.json --out out/send-list.csv
//   node scripts/send-sheet.mjs out/medspas-complete.json --min-score 75
import { readFileSync, writeFileSync } from 'node:fs';
import { csvCell } from '../lib/v1/format.js';

const COLUMNS = [
  ['sent', () => ''],
  ['instagram_url', (l) => (l.business_instagram ? `https://instagram.com/${l.business_instagram}` : '')],
  // No leading "@": a cell starting with it is a formula to Excel and Sheets, so
  // the CSV writer escapes it and a stray apostrophe shows up in the column.
  ['handle', (l) => l.business_instagram || 'NOT FOUND - find it or skip'],
  ['company_name', (l) => l.company_name],
  ['city_state', (l) => [l.city, l.state].filter(Boolean).join(', ')],
  ['score', (l) => l.overall_score],
  ['fit', (l) => l.classification],
  ['offer', (l) => l.recommended_offer],
  ['message', (l) => l.personalized_instagram_dm],
  ['written_by', (l) => l.dm_written_by ?? ''],
  ['handle_confidence', (l) => l.instagram_confidence]
];

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};

function main() {
  const source = process.argv[2];
  if (!source || source.startsWith('--')) {
    console.error('Usage: node scripts/send-sheet.mjs <run.json> [--out path.csv] [--min-score 0]');
    process.exit(1);
  }

  const minScore = Number(arg('min-score', 0));
  const out = arg('out', source.replace(/\.json$/, '-send-list.csv'));
  const run = JSON.parse(readFileSync(source, 'utf8'));

  const rows = run.leads
    .filter((l) => l.personalized_instagram_dm && l.overall_score >= minScore)
    .sort((a, b) => b.overall_score - a.overall_score);

  const lines = [COLUMNS.map(([name]) => csvCell(name)).join(',')];
  for (const lead of rows) lines.push(COLUMNS.map(([, read]) => csvCell(read(lead))).join(','));
  // BOM so Excel opens UTF-8 correctly on Windows.
  writeFileSync(out, `﻿${lines.join('\r\n')}\r\n`, 'utf8');

  const missing = rows.filter((l) => !l.business_instagram).length;
  const byClass = {};
  for (const l of rows) byClass[l.classification] = (byClass[l.classification] ?? 0) + 1;

  console.log(`\n${out}`);
  console.log(`  ${rows.length} message(s) ready, best score first`);
  console.log(`  ${Object.entries(byClass).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (missing) console.log(`  ${missing} row(s) have no Instagram handle - find it by hand or drop the lead`);
  console.log(`  tick the "sent" column as you go; nothing here has been sent\n`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main();
