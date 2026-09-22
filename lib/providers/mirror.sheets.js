// ---------------------------------------------------------------------------
// Optional mirror: Google Sheets.
// One-way. The database stays the source of truth; the sheet is a convenience
// view for people who prefer a grid. Rows are keyed by lead id so a re-run
// updates in place instead of appending duplicates.
// ---------------------------------------------------------------------------
import { request } from './http.js';

export const COLUMNS = [
  'Lead ID', 'Business Name', 'Instagram', 'Website', 'Niche', 'State', 'City',
  'Followers', 'Products/Services', 'Founder / Decision Maker', 'Decision Maker Role',
  'Email', 'Phone', 'ICP Score', 'Qualification', 'Pain Point', 'Recommended Service',
  'Outreach Angle', 'Generated Message', 'Message Status', 'Response Status',
  'Follow-up Date', 'Notes', 'Campaign', '_lead_uuid'
];

export function create(env = {}) {
  const spreadsheetId = env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const tab = env.GOOGLE_SHEETS_TAB ?? 'Qualified Leads';
  const token = env.GOOGLE_SHEETS_ACCESS_TOKEN;   // n8n supplies this via its Google credential
  const base = 'https://sheets.googleapis.com/v4/spreadsheets';

  function rowFrom(record) {
    return COLUMNS.map((col) => {
      const value = record[col];
      if (value === null || value === undefined) return '';
      return Array.isArray(value) ? value.join(' | ') : String(value);
    });
  }

  return {
    columns: COLUMNS,
    rowFrom,

    /**
     * Upsert by the _lead_uuid column: read the key column, update matching
     * rows, append the rest.
     */
    async upsertRows(records = [], ctx = {}) {
      if (!records.length) return { updated: 0, appended: 0 };
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const keyColumn = String.fromCharCode(65 + COLUMNS.indexOf('_lead_uuid'));

      const existing = await request({
        url: `${base}/${spreadsheetId}/values/${encodeURIComponent(tab)}!${keyColumn}:${keyColumn}`,
        headers,
        provider: 'google_sheets',
        operation: 'read_keys',
        onCall: ctx.onCall
      }).then((r) => (r.data?.values ?? []).map((v) => v[0]));

      const updates = [];
      const appends = [];
      for (const record of records) {
        const index = existing.indexOf(record._lead_uuid);
        if (index === -1) appends.push(rowFrom(record));
        else updates.push({ range: `${tab}!A${index + 1}`, values: [rowFrom(record)] });
      }

      if (updates.length) {
        await request({
          url: `${base}/${spreadsheetId}/values:batchUpdate`,
          method: 'POST',
          headers,
          body: { valueInputOption: 'RAW', data: updates },
          provider: 'google_sheets',
          operation: 'batch_update',
          onCall: ctx.onCall
        });
      }
      if (appends.length) {
        await request({
          url: `${base}/${spreadsheetId}/values/${encodeURIComponent(tab)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
          method: 'POST',
          headers,
          body: { values: appends },
          provider: 'google_sheets',
          operation: 'append',
          onCall: ctx.onCall
        });
      }
      return { updated: updates.length, appended: appends.length };
    }
  };
}
