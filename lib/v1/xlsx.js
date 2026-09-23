// ---------------------------------------------------------------------------
// Minimal XLSX reader. No dependencies.
//
// An .xlsx file is a ZIP containing XML. This reads the ZIP central directory,
// inflates only the three entries that matter (workbook, shared strings, the
// sheet itself) and yields rows of strings. That keeps this repo installable
// with nothing but Node, which matters because the person running it attaches a
// spreadsheet and expects it to work.
//
// Supports: deflate and stored entries, shared strings, inline strings, numbers,
// booleans, and date-formatted cells. Not supported: encrypted workbooks,
// ZIP64 archives above 4GB, and formulas (the cached value is read instead).
// ---------------------------------------------------------------------------
import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** Read the ZIP central directory and return { name -> Buffer } for wanted entries. */
function unzip(buffer, wanted) {
  // The end-of-central-directory record is at the tail, after an optional comment.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 65558; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('not a zip file (no end-of-central-directory record)');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const out = new Map();

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== SIG_CENTRAL) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (wanted(name)) {
      // Re-read the name and extra lengths from the local header: they can
      // differ from the central directory's, and the data starts after them.
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(start, start + compressedSize);
      out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

function decodeXml(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m]);
}

/** Shared strings table. Each <si> may hold several <t> runs that concatenate. */
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  for (const si of xml.match(/<si\b[\s\S]*?<\/si>|<si\s*\/>/g) ?? []) {
    const runs = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]));
    out.push(runs.join(''));
  }
  return out;
}

/** Excel serial date -> ISO date. Day 1 is 1900-01-01, with the 1900 leap-year bug. */
function serialToIso(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = Math.round((n - 25569) * 86400000);
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 19).replace('T', ' ');
}

/** Which style ids format their value as a date. */
function dateStyleIds(stylesXml) {
  if (!stylesXml) return new Set();
  const dateFormats = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
  for (const m of stylesXml.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    if (/[dmyhs]/i.test(m[2]) && !/^[#0.,%]+$/.test(m[2])) dateFormats.add(Number(m[1]));
  }
  const ids = new Set();
  const cellXfs = stylesXml.match(/<cellXfs[\s\S]*?<\/cellXfs>/)?.[0] ?? '';
  let index = 0;
  for (const xf of cellXfs.match(/<xf\b[^>]*\/?>/g) ?? []) {
    const numFmtId = Number(xf.match(/numFmtId="(\d+)"/)?.[1] ?? 0);
    if (dateFormats.has(numFmtId)) ids.add(index);
    index += 1;
  }
  return ids;
}

/** Column reference ("BC") -> zero-based index. */
function columnIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Read one sheet.
 * @returns {{ sheet: string, headers: string[], rows: object[], sheetNames: string[] }}
 */
export function readXlsx(filePath, { sheet = null } = {}) {
  const buffer = readFileSync(filePath);
  const entries = unzip(buffer, (name) =>
    name === 'xl/workbook.xml' ||
    name === 'xl/sharedStrings.xml' ||
    name === 'xl/styles.xml' ||
    name === 'xl/_rels/workbook.xml.rels' ||
    /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
  );

  const workbookXml = entries.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const relsXml = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const shared = parseSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf8'));
  const dateStyles = dateStyleIds(entries.get('xl/styles.xml')?.toString('utf8'));

  // Sheet name -> file, via the workbook's relationship ids.
  const relTargets = new Map();
  for (const m of relsXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    relTargets.set(m[1], m[2].replace(/^\/?xl\//, '').replace(/^\//, ''));
  }
  const sheets = [];
  for (const m of workbookXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const tag = m[0];
    const name = decodeXml(tag.match(/name="([^"]*)"/)?.[1] ?? '');
    const rid = tag.match(/r:id="([^"]+)"/)?.[1];
    const target = rid ? relTargets.get(rid) : null;
    sheets.push({ name, path: target ? `xl/${target}` : null });
  }
  // Fall back to positional sheet files when relationships are missing.
  const sheetFiles = [...entries.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  sheets.forEach((s, i) => { if (!s.path || !entries.has(s.path)) s.path = sheetFiles[i] ?? null; });

  const sheetNames = sheets.map((s) => s.name);
  const chosen = sheet
    ? sheets.find((s) => s.name.toLowerCase() === String(sheet).toLowerCase())
    : sheets[0];
  if (!chosen || !chosen.path || !entries.has(chosen.path)) {
    throw new Error(`sheet ${sheet ? `"${sheet}"` : '(first)'} not found. Available: ${sheetNames.join(', ')}`);
  }

  const sheetXml = entries.get(chosen.path).toString('utf8');
  const grid = [];

  // Tags are matched opening-tag-first, then closed by hand. A single regex with
  // `[^>]*` swallows the slash of a self-closing `<c r="D2"/>`, which makes an
  // empty cell absorb the next cells' values and silently shifts a whole row.
  const rowRe = /<row\b([^>]*?)(\/)?>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(sheetXml)) !== null) {
    const rowAttrs = rowMatch[1];
    const rowNumber = Number(rowAttrs.match(/\br="(\d+)"/)?.[1] ?? grid.length + 1);
    let rowBody = '';
    if (!rowMatch[2]) {
      const end = sheetXml.indexOf('</row>', rowRe.lastIndex);
      rowBody = end === -1 ? sheetXml.slice(rowRe.lastIndex) : sheetXml.slice(rowRe.lastIndex, end);
      rowRe.lastIndex = end === -1 ? sheetXml.length : end + 6;
    }

    const cells = [];
    let nextIndex = 0;
    const cellRe = /<c\b([^>]*?)(\/)?>/g;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowBody)) !== null) {
      const attrs = cellMatch[1];
      let body = '';
      if (!cellMatch[2]) {
        const end = rowBody.indexOf('</c>', cellRe.lastIndex);
        body = end === -1 ? rowBody.slice(cellRe.lastIndex) : rowBody.slice(cellRe.lastIndex, end);
        cellRe.lastIndex = end === -1 ? rowBody.length : end + 4;
      }
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const index = ref ? columnIndex(ref) : nextIndex;
      nextIndex = index + 1;
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] ?? 'n';
      const styleId = Number(attrs.match(/\bs="(\d+)"/)?.[1] ?? -1);

      let value = null;
      if (type === 'inlineStr') {
        value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('');
      } else {
        const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        if (raw !== undefined) {
          const decoded = decodeXml(raw);
          if (type === 's') value = shared[Number(decoded)] ?? '';
          else if (type === 'b') value = decoded === '1' ? 'TRUE' : 'FALSE';
          else if (type === 'str' || type === 'e') value = decoded;
          else value = dateStyles.has(styleId) ? (serialToIso(decoded) ?? decoded) : decoded;
        }
      }
      cells[index] = value === null || value === undefined ? '' : String(value).trim();
    }
    grid[rowNumber - 1] = cells;
  }

  // First non-empty row is the header.
  const headerIndex = grid.findIndex((r) => r && r.some((v) => v && v.trim()));
  if (headerIndex === -1) return { sheet: chosen.name, headers: [], rows: [], sheetNames };

  const headers = (grid[headerIndex] ?? []).map((h, i) => (h && h.trim()) || `column_${i + 1}`);
  const rows = [];
  for (let i = headerIndex + 1; i < grid.length; i += 1) {
    const cells = grid[i];
    if (!cells || !cells.some((v) => v && String(v).trim())) continue;
    const row = {};
    headers.forEach((h, c) => { row[h] = cells[c] ?? ''; });
    row.__row = i + 1;             // 1-based spreadsheet row, for traceability
    rows.push(row);
  }
  return { sheet: chosen.name, headers, rows, sheetNames };
}

/** Sheet names without reading any data. */
export function xlsxSheetNames(filePath) {
  return readXlsx(filePath).sheetNames;
}
