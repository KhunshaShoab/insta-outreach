// ---------------------------------------------------------------------------
// Inlines lib/ modules and prompts/ files into n8n Code nodes.
//
// n8n Code nodes cannot `import` from the filesystem, so the usual choice is to
// paste logic into each node and watch the copies drift. Instead this bundler
// resolves the import graph, strips the module syntax and emits one prelude -
// meaning the code running in n8n is character-for-character the code the test
// suite exercises.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const IMPORT_RE = /^\s*import\s+(?:[\s\S]*?)\s+from\s+['"](\.[^'"]+)['"];?\s*$/gm;
// Any import at all, so a non-relative one can be reported instead of silently
// surviving into a Code node, where it throws "Cannot use import statement".
const ANY_IMPORT_RE = /^\s*import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"];?\s*$/gm;
const EXPORT_PREFIX_RE = /^export\s+(?=(const|let|var|function|async function|class)\b)/gm;
const EXPORT_STAR_RE = /^export\s+\*\s+from\s+['"][^'"]+['"];?\s*$/gm;

const cache = new Map();

function readModule(relativePath) {
  if (cache.has(relativePath)) return cache.get(relativePath);
  const source = readFileSync(join(ROOT, relativePath), 'utf8');
  const deps = [...source.matchAll(IMPORT_RE)].map((m) => normaliseDep(relativePath, m[1]));
  const entry = { path: relativePath, source, deps };
  cache.set(relativePath, entry);
  return entry;
}

function normaliseDep(fromPath, spec) {
  const dir = dirname(fromPath);
  const resolved = join(dir, spec).replace(/\\/g, '/');
  return resolved.startsWith('lib/') ? resolved : `lib/${basename(resolved)}`;
}

/** Depth-first topological order so a module never appears before its dependency. */
function collect(entryPaths) {
  const ordered = [];
  const seen = new Set();
  const visiting = new Set();

  const visit = (path) => {
    if (seen.has(path)) return;
    if (visiting.has(path)) throw new Error(`bundle: circular import at ${path}`);
    visiting.add(path);
    const entry = readModule(path);
    for (const dep of entry.deps) visit(dep);
    visiting.delete(path);
    seen.add(path);
    ordered.push(entry);
  };

  for (const path of entryPaths) visit(path);
  return ordered;
}

/**
 * Produce the prelude for a Code node.
 * @param {string[]} modules e.g. ['lib/normalize.js', 'lib/clean.js']
 */
export function bundle(modules) {
  const entries = collect(modules);

  for (const entry of entries) {
    const external = [...entry.source.matchAll(ANY_IMPORT_RE)]
      .map((m) => m[1])
      .filter((spec) => !spec.startsWith('.'));
    if (external.length) {
      throw new Error(
        `bundle: ${entry.path} imports ${external.join(', ')}, which cannot run inside an n8n Code node. ` +
        `Move the pure logic into a module with no external imports and inline that instead.`
      );
    }
  }

  const parts = entries.map((entry) => {
    const body = entry.source
      .replace(IMPORT_RE, '')
      .replace(EXPORT_STAR_RE, '')
      .replace(EXPORT_PREFIX_RE, '')
      .replace(/^export\s+\{[^}]*\};?\s*$/gm, '')
      .trim();
    return `// ---- ${entry.path} (generated from source - do not edit here) ----\n${body}`;
  });
  return `${parts.join('\n\n')}\n`;
}

/** Wrap node logic with the prelude it needs. */
export function withLib(modules, nodeCode) {
  return `${bundle(modules)}\n// ---- node logic ----\n${nodeCode.trim()}\n`;
}

/** Embed a prompt file as a JS constant, front matter parsed at build time. */
export function promptConst(file, constName) {
  const raw = readFileSync(join(ROOT, 'prompts', file), 'utf8');
  const end = raw.indexOf('\n---', 3);
  const metaBlock = raw.startsWith('---') && end !== -1 ? raw.slice(3, end) : '';
  const body = raw.startsWith('---') && end !== -1 ? raw.slice(end + 4).trim() : raw.trim();

  const meta = {};
  for (const line of metaBlock.split('\n')) {
    const match = line.match(/^\s*([a-z_]+)\s*:\s*(.+?)\s*$/i);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, '');
    meta[match[1]] = /^\d+(\.\d+)?$/.test(value) ? Number(value) : value === 'true' ? true : value === 'false' ? false : value;
  }
  return `const ${constName} = ${JSON.stringify({ meta, body }, null, 2)};`;
}

/** Embed a config file as a JS constant so a Code node has its rules inline. */
export function configConst(file, constName) {
  const json = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
  return `const ${constName} = ${JSON.stringify(json)};`;
}

/** Embed a JSON schema for in-node validation. */
export function schemaConst(file, constName) {
  return configConst(join('schemas', file), constName);
}
