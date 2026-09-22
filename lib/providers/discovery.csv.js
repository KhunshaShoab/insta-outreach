// ---------------------------------------------------------------------------
// Discovery adapter: CSV / JSON import.
// Runs the whole pipeline against a file you already have - useful for testing
// every downstream stage without spending a cent on scraping, and for importing
// a list someone hands you.
// ---------------------------------------------------------------------------

export function create(env = {}, spec = {}) {
  return {
    async discover(campaign, ctx = {}) {
      const rows = ctx.rows ?? spec.rows ?? [];
      const parsed = typeof rows === 'string' ? parseCsv(rows) : rows;
      return parsed.map((row) => ({ ...row, source: 'csv_import', search_term: ctx.label ?? 'manual import' }));
    }
  };
}

/** Minimal RFC-4180-ish CSV parser (quoted fields, embedded commas/newlines). */
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];

  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((cell) => cell.trim()))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}
