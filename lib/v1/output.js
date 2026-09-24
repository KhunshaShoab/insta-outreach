// ---------------------------------------------------------------------------
// Output: one CSV that opens directly in Excel or Google Sheets, plus the full
// JSON for anything downstream. CSV rather than XLSX on purpose - it imports
// into Sheets in two clicks and needs no library to write.
//
// The pure formatting lives in format.js so n8n can share it.
// ---------------------------------------------------------------------------
import { writeFileSync } from 'node:fs';
import { OUTPUT_FIELDS } from './schema.js';
import { csvCell, formatSignals, toOutputRow, reviewTable } from './format.js';

export { formatSignals, toOutputRow, reviewTable };

export function writeCsv(path, records) {
  const lines = [OUTPUT_FIELDS.map(csvCell).join(',')];
  for (const record of records) {
    const row = toOutputRow(record);
    lines.push(OUTPUT_FIELDS.map((f) => csvCell(row[f])).join(','));
  }
  // BOM so Excel opens UTF-8 correctly on Windows.
  writeFileSync(path, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
  return { path, rows: records.length, columns: OUTPUT_FIELDS.length };
}

export function writeJson(path, payload) {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { path };
}
