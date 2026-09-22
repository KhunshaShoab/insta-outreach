#!/usr/bin/env node
// Parse every JS/MJS file in the project. Catches the syntax errors that only
// show up when a module is first imported - including inside n8n Code nodes,
// which the build script checks separately.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'workflows']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (['.js', '.mjs'].includes(extname(entry))) out.push(full);
  }
  return out;
}

const SELF = fileURLToPath(import.meta.url);
const files = walk(ROOT).filter((f) => f !== SELF);   // importing itself would deadlock
const failures = [];

for (const file of files) {
  try {
    await import(pathToFileURL(file).href);
  } catch (error) {
    if (error instanceof SyntaxError) {
      failures.push(`${file.replace(ROOT + '/', '')}: ${error.message}`);
    } else if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(String(error.message))) {
      failures.push(`${file.replace(ROOT + '/', '')}: ${error.message}`);
    }
    // Other runtime errors (a module that needs env vars at import time) are
    // not syntax problems and are not this script's business.
  }
}

if (failures.length) {
  console.error(`${failures.length} file(s) failed to parse:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`${files.length} JavaScript files parse cleanly.`);
