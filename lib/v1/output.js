// ---------------------------------------------------------------------------
// Output: one CSV that opens directly in Excel or Google Sheets, plus the full
// JSON for anything downstream. CSV rather than XLSX on purpose - it imports
// into Sheets in two clicks and needs no library to write.
// ---------------------------------------------------------------------------
import { writeFileSync } from 'node:fs';
import { OUTPUT_FIELDS } from './schema.js';

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = Array.isArray(value) ? value.join(' | ') : String(value);
  // Excel and Sheets treat a leading =, +, - or @ as a formula.
  const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** Signals flattened into something readable in a spreadsheet cell. */
export function formatSignals(signals = []) {
  return signals
    .map((s, i) => `${i + 1}. [${s.confidence}] ${s.signal}\n   Evidence: ${s.evidence}\n   Interpretation: ${s.interpretation}\n   Source: ${s.source ?? 'n/a'}`)
    .join('\n');
}

export function toOutputRow(record) {
  const row = {};
  for (const field of OUTPUT_FIELDS) row[field] = record[field] ?? '';
  return row;
}

export function writeCsv(path, records) {
  const lines = [OUTPUT_FIELDS.map(csvCell).join(',')];
  for (const record of records) {
    const row = toOutputRow(record);
    lines.push(OUTPUT_FIELDS.map((f) => csvCell(row[f])).join(','));
  }
  // BOM so Excel opens UTF-8 correctly on Windows.
  writeFileSync(path, `﻿${lines.join('\r\n')}\r\n`, 'utf8');
  return { path, rows: records.length, columns: OUTPUT_FIELDS.length };
}

export function writeJson(path, payload) {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { path };
}

/** A compact console table for the run summary. */
export function reviewTable(records) {
  const head = ['#', 'Company', 'City', 'Sc', 'CS', 'AV', 'Class', 'Offer', 'Instagram', 'Conf'];
  const rows = records.map((r, i) => [
    String(i + 1),
    String(r.company_name ?? '').slice(0, 30),
    `${String(r.city ?? '').slice(0, 12)}, ${r.state ?? ''}`,
    String(r.overall_score ?? ''),
    String(r.customer_support_score ?? ''),
    String(r.ai_voice_score ?? ''),
    String(r.classification ?? ''),
    String(r.recommended_offer ?? ''),
    String(r.business_instagram ?? '-').slice(0, 26),
    String(r.instagram_confidence ?? '')
  ]);
  const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}
