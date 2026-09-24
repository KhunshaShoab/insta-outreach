// ---------------------------------------------------------------------------
// Ingest: an attached XLSX or CSV -> V1 lead records.
//
// Column names are detected, not assumed, because every lead file arrives with
// different headers. The detection and row-mapping live in map-columns.js so
// they can also run inside an n8n Code node; this module adds file reading.
// ---------------------------------------------------------------------------
import { readXlsx, xlsxSheetNames } from './xlsx.js';
import { parseCsv } from '../providers/discovery.csv.js';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { COLUMN_ALIASES, detectColumns, mapRow } from './map-columns.js';

export { COLUMN_ALIASES, detectColumns, mapRow };

/** Read the file as { sheet, headers, rows }. CSV and XLSX both land here. */
export function readLeadFile(filePath, { sheet = null } = {}) {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.csv' || extension === '.tsv' || extension === '.txt') {
    const rows = parseCsv(readFileSync(filePath, 'utf8'));
    const headers = rows.length ? Object.keys(rows[0]) : [];
    return { sheet: null, sheetNames: [], headers, rows: rows.map((r, i) => ({ ...r, __row: i + 2 })) };
  }
  if (extension !== '.xlsx' && extension !== '.xlsm') {
    throw new Error(`Unsupported file type "${extension}". Attach a .xlsx or .csv file.`);
  }
  const names = xlsxSheetNames(filePath);
  // Lead files from scrapers usually carry admin sheets alongside the data.
  // Prefer a sheet that looks like the lead list.
  const preferred = sheet
    ?? names.find((n) => /^(leads?|data|sheet1|results)$/i.test(n))
    ?? names.find((n) => /lead/i.test(n))
    ?? names[0];
  const result = readXlsx(filePath, { sheet: preferred });
  return { ...result, sheetNames: names };
}

/**
 * Ingest a file.
 * @returns {{ file, sheet, sheetNames, headers, mapping, unmapped, leads, skipped }}
 */
export function ingestFile(filePath, { sheet = null, sourceLabel = null, limit = null } = {}) {
  const { sheet: usedSheet, sheetNames, headers, rows } = readLeadFile(filePath, { sheet });
  const { mapping, unmapped } = detectColumns(headers);

  if (!mapping.company_name) {
    throw new Error(
      `No column in "${basename(filePath)}" looks like a company name. ` +
      `Headers found: ${headers.join(', ')}. Add an alias to COLUMN_ALIASES in lib/v1/ingest.js.`
    );
  }

  const leads = [];
  const skipped = [];
  for (const row of rows) {
    const lead = mapRow(row, mapping, { sourceFile: basename(filePath), sourceLabel });
    if (!lead.company_name) {
      skipped.push({ row: row.__row, reason: 'no company name' });
      continue;
    }
    leads.push(lead);
    if (limit && leads.length >= limit) break;
  }

  return { file: basename(filePath), sheet: usedSheet, sheetNames, headers, mapping, unmapped, leads, skipped };
}
