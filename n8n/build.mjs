#!/usr/bin/env node
// Generates n8n/workflows/*.json from n8n/src/*.mjs.
// Run: npm run build:n8n
// The generated files are committed so they can be imported into n8n directly,
// but they are OUTPUT - edit n8n/src/*.mjs (or lib/, or prompts/) and rebuild.
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'n8n/src');
const OUT = join(ROOT, 'n8n/workflows');

const VALID_NODE_TYPES = new Set([
  'n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.manualTrigger', 'n8n-nodes-base.webhook',
  'n8n-nodes-base.executeWorkflowTrigger', 'n8n-nodes-base.executeWorkflow', 'n8n-nodes-base.httpRequest',
  'n8n-nodes-base.code', 'n8n-nodes-base.if', 'n8n-nodes-base.switch', 'n8n-nodes-base.splitInBatches',
  'n8n-nodes-base.merge', 'n8n-nodes-base.noOp', 'n8n-nodes-base.set', 'n8n-nodes-base.respondToWebhook',
  'n8n-nodes-base.stickyNote', 'n8n-nodes-base.formTrigger', 'n8n-nodes-base.extractFromFile',
  'n8n-nodes-base.googleSheets', 'n8n-nodes-base.convertToFile'
]);

/** Structural checks that catch the mistakes hand-written workflow JSON makes. */
export function validateWorkflow(wf) {
  const errors = [];
  const names = new Set();
  const ids = new Set();

  if (!wf.name) errors.push('workflow has no name');
  if (!Array.isArray(wf.nodes) || !wf.nodes.length) errors.push(`${wf.name}: no nodes`);

  for (const node of wf.nodes ?? []) {
    if (names.has(node.name)) errors.push(`${wf.name}: duplicate node name "${node.name}"`);
    names.add(node.name);
    if (ids.has(node.id)) errors.push(`${wf.name}: duplicate node id on "${node.name}"`);
    ids.add(node.id);
    if (!VALID_NODE_TYPES.has(node.type)) errors.push(`${wf.name}: unknown node type "${node.type}" on "${node.name}"`);
    if (!Array.isArray(node.position) || node.position.length !== 2) errors.push(`${wf.name}: bad position on "${node.name}"`);

    if (node.type === 'n8n-nodes-base.code') {
      const source = node.parameters?.jsCode ?? '';
      if (!source.trim()) errors.push(`${wf.name}: empty Code node "${node.name}"`);
      try {
        // n8n wraps Code-node bodies in an async function, so top-level await
        // is legal there. Compile it the same way or valid code looks broken.
        // eslint-disable-next-line no-new-func
        new Function('$input', '$json', '$env', '$execution', `return (async () => {\n${source}\n})();`);
      } catch (error) {
        errors.push(`${wf.name}: Code node "${node.name}" does not parse: ${error.message}`);
      }
      // A node that embeds a prompt must actually render it. renderTemplate()
      // throws on a missing variable, so a half-filled prompt can never be sent
      // - but only if the node calls it.
      if (source.includes('const PROMPT = {') && !/renderPrompt\(|renderTemplate\(/.test(source)) {
        errors.push(`${wf.name}: "${node.name}" embeds a prompt but never renders it`);
      }
    }
  }

  for (const [from, outputs] of Object.entries(wf.connections ?? {})) {
    if (!names.has(from)) errors.push(`${wf.name}: connection from unknown node "${from}"`);
    for (const branch of outputs.main ?? []) {
      for (const link of branch ?? []) {
        if (!names.has(link.node)) errors.push(`${wf.name}: connection to unknown node "${link.node}" (from "${from}")`);
      }
    }
  }

  const triggerTypes = ['scheduleTrigger', 'manualTrigger', 'webhook', 'executeWorkflowTrigger', 'formTrigger'];
  const hasTrigger = (wf.nodes ?? []).some((n) => triggerTypes.some((t) => n.type.endsWith(t)));
  if (!hasTrigger) errors.push(`${wf.name}: no trigger node`);

  const reachable = new Set();
  const walk = (name) => {
    if (reachable.has(name)) return;
    reachable.add(name);
    for (const branch of wf.connections?.[name]?.main ?? []) {
      for (const link of branch ?? []) walk(link.node);
    }
  };
  for (const node of wf.nodes ?? []) {
    if (triggerTypes.some((t) => node.type.endsWith(t))) walk(node.name);
  }
  for (const node of wf.nodes ?? []) {
    if (!reachable.has(node.name) && node.type !== 'n8n-nodes-base.stickyNote') {
      errors.push(`${wf.name}: node "${node.name}" is unreachable from any trigger`);
    }
  }

  return errors;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const files = readdirSync(SRC).filter((f) => /^wf\d+.*\.mjs$/.test(f)).sort();
  const allErrors = [];
  const summary = [];

  for (const file of files) {
    const module = await import(pathToFileURL(join(SRC, file)).href);
    if (typeof module.build !== 'function') {
      allErrors.push(`${file}: does not export build()`);
      continue;
    }
    const wf = module.build();
    const errors = validateWorkflow(wf);
    allErrors.push(...errors);

    const target = join(OUT, `${wf.name}.json`);
    writeFileSync(target, `${JSON.stringify(wf, null, 2)}\n`);
    summary.push({
      workflow: wf.name,
      nodes: wf.nodes.length,
      code_nodes: wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code').length,
      ai_calls: wf.nodes.filter((n) => n.name.startsWith('Claude:')).length,
      errors: errors.length
    });
  }

  const width = Math.max(...summary.map((s) => s.workflow.length));
  for (const row of summary) {
    console.log(
      `${row.workflow.padEnd(width)}  ${String(row.nodes).padStart(3)} nodes  ` +
      `${String(row.code_nodes).padStart(2)} code  ${String(row.ai_calls).padStart(2)} AI  ` +
      (row.errors ? `${row.errors} PROBLEM(S)` : 'ok')
    );
  }

  if (allErrors.length) {
    console.error(`\n${allErrors.length} problem(s):`);
    for (const error of allErrors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`\n${summary.length} workflows written to n8n/workflows/`);
}

// Only build when run directly - importing this module (the linter does) must
// not write files.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
