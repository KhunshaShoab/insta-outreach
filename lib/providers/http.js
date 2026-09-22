// ---------------------------------------------------------------------------
// One HTTP helper for every adapter: timeout, retry classification, rate-limit
// awareness and call accounting. Adapters never call fetch directly, so adding
// a new provider means implementing an interface, not re-solving retries.
// ---------------------------------------------------------------------------
import { decideRetry } from '../retry.js';

export class ProviderError extends Error {
  constructor(message, { status = null, provider = null, operation = null, body = null, headers = {} } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.provider = provider;
    this.operation = operation;
    this.body = body;
    this.headers = headers;
  }
}

/**
 * @param {object} options
 *   url, method, headers, body, timeoutMs, maxRetries, provider, operation,
 *   onCall  - called once per attempt with { provider, operation, ok, http_status, latency_ms }
 *             (wire this to the provider_calls table)
 */
export async function request({
  url,
  method = 'GET',
  headers = {},
  body = null,
  timeoutMs = 30000,
  maxRetries = 3,
  provider = 'unknown',
  operation = 'request',
  onCall = null,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms))
} = {}) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await fetchImpl(url, {
        method,
        headers: body && !headers['Content-Type'] ? { 'Content-Type': 'application/json', ...headers } : headers,
        body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        signal: controller.signal
      });
      const latency = Date.now() - startedAt;
      const responseHeaders = Object.fromEntries(response.headers ?? []);
      const text = await response.text();
      const parsed = text ? safeJson(text) : null;

      if (onCall) onCall({ provider, operation, ok: response.ok, http_status: response.status, latency_ms: latency });

      if (!response.ok) {
        throw new ProviderError(
          `${provider}.${operation} failed with HTTP ${response.status}: ${String(text).slice(0, 400)}`,
          { status: response.status, provider, operation, body: parsed ?? text, headers: responseHeaders }
        );
      }
      return { data: parsed ?? text, status: response.status, headers: responseHeaders, latency_ms: latency };
    } catch (error) {
      lastError = error;
      if (onCall && !(error instanceof ProviderError)) {
        onCall({ provider, operation, ok: false, http_status: null, latency_ms: Date.now() - startedAt, error: String(error.message ?? error) });
      }
      const decision = decideRetry({ error, attempt, maxRetries, headers: error?.headers ?? {} });
      if (!decision.retry) {
        lastError.decision = decision;
        break;
      }
      await sleep(decision.delay_ms);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
