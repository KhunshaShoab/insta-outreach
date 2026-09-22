// ---------------------------------------------------------------------------
// Prompt loading and rendering.
// Prompts live in prompts/*.md as plain text with front matter, so they can be
// reviewed and diffed like code. n8n/build.mjs inlines them into the workflow
// JSON at build time; Node tooling reads them from disk.
//
// Placeholders:
//   {{name}}        required string - rendering throws if it is missing
//   {{name?}}       optional - renders as "(not available)" when missing
//   {{json:name}}   pretty-printed JSON block
//   {{list:name}}   array rendered as "- item" lines
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\{\{\s*(json:|list:)?([a-zA-Z0-9_.]+)(\?)?\s*\}\}/g;

/** Split `---` front matter from the prompt body. */
export function parseFrontMatter(text) {
  const raw = String(text);
  if (!raw.startsWith('---')) return { meta: {}, body: raw.trim() };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: raw.trim() };

  const meta = {};
  for (const line of raw.slice(3, end).split('\n')) {
    const match = line.match(/^\s*([a-z_]+)\s*:\s*(.+?)\s*$/i);
    if (!match) continue;
    const [, key, value] = match;
    meta[key] = /^\d+(\.\d+)?$/.test(value) ? Number(value)
      : value === 'true' ? true
      : value === 'false' ? false
      : value.replace(/^["']|["']$/g, '');
  }
  return { meta, body: raw.slice(end + 4).trim() };
}

function lookup(vars, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), vars);
}

/** Fill a prompt template. Throws on a missing required variable. */
export function renderTemplate(template, vars = {}) {
  const missing = [];
  const out = String(template).replace(PLACEHOLDER, (_match, kind, name, optional) => {
    const value = lookup(vars, name);
    const absent = value === undefined || value === null || value === '';

    if (absent) {
      if (!optional) { missing.push(name); return ''; }
      return kind === 'json:' ? '{}' : kind === 'list:' ? '- (none)' : '(not available)';
    }
    if (kind === 'json:') return JSON.stringify(value, null, 2);
    if (kind === 'list:') {
      const items = Array.isArray(value) ? value : [value];
      return items.length ? items.map((v) => `- ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n') : '- (none)';
    }
    return Array.isArray(value) ? value.join(', ') : String(value);
  });

  if (missing.length) {
    throw new Error(`renderTemplate: missing required variables: ${[...new Set(missing)].join(', ')}`);
  }
  return out;
}

/** Variables a template expects, for validation and documentation. */
export function templateVariables(template) {
  const required = new Set();
  const optional = new Set();
  for (const match of String(template).matchAll(PLACEHOLDER)) {
    (match[3] ? optional : required).add(match[2]);
  }
  return { required: [...required], optional: [...optional] };
}

/**
 * Render a prompt from a registry entry.
 * @param {object} prompt { meta, body } as produced by parseFrontMatter
 */
export function renderPrompt(prompt, vars = {}) {
  const body = renderTemplate(prompt.body ?? prompt, vars);
  return {
    prompt: body,
    model: prompt.meta?.model ?? 'default',
    max_tokens: prompt.meta?.max_tokens ?? 2000,
    temperature: prompt.meta?.temperature ?? 0.2,
    schema_name: prompt.meta?.schema ?? null,
    version: prompt.meta?.version ?? '1'
  };
}
