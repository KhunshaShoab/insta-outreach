// ---------------------------------------------------------------------------
// Getting structured JSON back out of a language model, reliably.
// The prompts all demand strict JSON, but a wrapper sentence or a fenced block
// still shows up occasionally. This module recovers the object, validates it
// against the schema, and tells the caller whether a retry is warranted -
// nothing downstream ever sees half-parsed data.
// ---------------------------------------------------------------------------
import { validate } from './validate.js';

/** Pull the first balanced JSON object/array out of a model response. */
export function extractJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  const raw = String(text).trim();

  const direct = tryParse(raw);
  if (direct !== undefined) return direct;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }

  const start = raw.search(/[{[]/);
  if (start === -1) return null;
  const opener = raw[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) {
        const parsed = tryParse(raw.slice(start, i + 1));
        if (parsed !== undefined) return parsed;
        break;
      }
    }
  }
  return null;
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Parse + validate a model response.
 * @returns {{ ok, data, errors, retry_prompt }}
 * `retry_prompt` is the exact correction to send back on a schema failure.
 */
export function parseAiJson(text, schema, { label = 'AI response' } = {}) {
  const data = extractJson(text);
  if (data === null) {
    return {
      ok: false,
      data: null,
      errors: [`${label}: no JSON object found in the response`],
      retry_prompt: 'Your previous response was not valid JSON. Return ONLY the JSON object described in the OUTPUT FORMAT section, with no prose, no markdown fence and no explanation.'
    };
  }
  if (!schema) return { ok: true, data, errors: [], retry_prompt: null };

  const { valid, errors } = validate(data, schema);
  if (valid) return { ok: true, data, errors: [], retry_prompt: null };

  return {
    ok: false,
    data,
    errors,
    retry_prompt:
      `Your previous response did not satisfy the required schema. Fix exactly these problems and return ONLY the corrected JSON object:\n` +
      errors.slice(0, 10).map((e) => `- ${e}`).join('\n')
  };
}

/** Deep-clone + drop undefined so the object is safe to store as jsonb. */
export function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}
