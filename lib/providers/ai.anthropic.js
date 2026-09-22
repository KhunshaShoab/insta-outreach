// ---------------------------------------------------------------------------
// AI adapter: Anthropic Messages API.
// Every call is "prompt in, validated JSON out". On a schema failure it sends
// the validator's own error list back once - that single correction turn fixes
// nearly every malformed response and keeps bad data out of the database.
// ---------------------------------------------------------------------------
import { request } from './http.js';
import { parseAiJson } from '../json.js';

const BASE = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export function create(env = {}, spec = {}) {
  const apiKey = env.ANTHROPIC_API_KEY;
  const models = {
    default: env.ANTHROPIC_MODEL ?? spec?.models?.default ?? 'claude-sonnet-5',
    heavy: env.ANTHROPIC_MODEL_HEAVY ?? spec?.models?.heavy ?? 'claude-opus-5'
  };

  async function call(messages, { model, maxTokens, system, temperature, ctx = {} }) {
    const started = Date.now();
    const { data } = await request({
      url: BASE,
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION, 'Content-Type': 'application/json' },
      body: {
        model,
        max_tokens: maxTokens,
        temperature,
        ...(system ? { system } : {}),
        messages
      },
      timeoutMs: ctx.timeoutMs ?? 120000,
      maxRetries: ctx.maxRetries ?? 3,
      provider: 'anthropic',
      operation: model,
      onCall: ctx.onCall
    });
    return {
      text: (data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
      usage: data?.usage ?? {},
      stop_reason: data?.stop_reason,
      latency_ms: Date.now() - started,
      model
    };
  }

  return {
    /**
     * @param {object} options
     *   prompt     the rendered prompt (prompts/*.md with variables filled in)
     *   system     optional system prompt
     *   schema     JSON schema the response must satisfy
     *   model      'default' | 'heavy' | an explicit model id
     *   maxTokens, temperature, ctx
     * @returns {{ data, raw, usage, model, latency_ms, repaired }}
     */
    async complete({ prompt, system = null, schema = null, model = 'default', maxTokens = 2000, temperature = 0.2, ctx = {} } = {}) {
      const modelId = models[model] ?? model;
      const messages = [{ role: 'user', content: prompt }];

      let response = await call(messages, { model: modelId, maxTokens, system, temperature, ctx });
      let parsed = parseAiJson(response.text, schema);

      if (!parsed.ok) {
        // One correction turn, carrying the exact validation errors.
        messages.push({ role: 'assistant', content: response.text });
        messages.push({ role: 'user', content: parsed.retry_prompt });
        const retry = await call(messages, { model: modelId, maxTokens, system, temperature: 0, ctx });
        const retryParsed = parseAiJson(retry.text, schema);
        if (retryParsed.ok) {
          return { data: retryParsed.data, raw: retry.text, usage: retry.usage, model: modelId, latency_ms: response.latency_ms + retry.latency_ms, repaired: true };
        }
        const error = new Error(`Anthropic response failed schema validation twice: ${retryParsed.errors.slice(0, 5).join('; ')}`);
        error.name = 'SchemaValidationError';
        error.errors = retryParsed.errors;
        error.raw = retry.text;
        throw error;
      }

      return { data: parsed.data, raw: response.text, usage: response.usage, model: modelId, latency_ms: response.latency_ms, repaired: false };
    }
  };
}
