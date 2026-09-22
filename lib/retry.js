// ---------------------------------------------------------------------------
// Error classification, backoff and rate-limit handling.
// Used by every node that talks to an external service. The contract is simple:
// classify -> decide retry -> compute delay -> record. One failed lead never
// stops a campaign, and a rate limit pauses only the provider that raised it.
// ---------------------------------------------------------------------------

export const ERROR_TYPES = ['rate_limit', 'timeout', 'auth', 'validation', 'provider_error', 'ai_schema', 'network', 'unknown'];

const RETRYABLE = new Set(['rate_limit', 'timeout', 'provider_error', 'network', 'ai_schema']);

/** Map an HTTP status / thrown error onto one of ERROR_TYPES. */
export function classifyError(error = {}) {
  const status = error.status ?? error.httpCode ?? error.statusCode ?? error.response?.status ?? null;
  const message = String(error.message ?? error.error ?? error ?? '');

  if (status === 429) return 'rate_limit';
  if (status === 408 || /timeout|etimedout|esockettimedout|aborted/i.test(message)) return 'timeout';
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 || status === 422) return 'validation';
  if (status && status >= 500) return 'provider_error';
  if (/econnreset|enotfound|econnrefused|socket hang up|network/i.test(message)) return 'network';
  if (/schema|json|unexpected token|failed to parse/i.test(message)) return 'ai_schema';
  if (/rate limit|too many requests|quota/i.test(message)) return 'rate_limit';
  return 'unknown';
}

export function isRetryable(errorType) {
  return RETRYABLE.has(errorType);
}

/**
 * Exponential backoff with full jitter, honouring Retry-After when present.
 * 2s, 4s, 8s, 16s ... capped.
 */
export function backoffMs(attempt, { baseMs = 2000, capMs = 300000, retryAfterSeconds = null, jitter = true } = {}) {
  if (retryAfterSeconds != null && Number.isFinite(Number(retryAfterSeconds))) {
    return Math.min(capMs, Number(retryAfterSeconds) * 1000);
  }
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  if (!jitter) return exponential;
  return Math.floor(exponential / 2 + Math.random() * (exponential / 2));
}

export function retryAfterFrom(headers = {}) {
  const raw = headers['retry-after'] ?? headers['Retry-After'] ?? headers['x-ratelimit-reset-after'];
  if (raw == null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds;
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, Math.round((when - Date.now()) / 1000)) : null;
}

/**
 * Decision object for a failed item.
 * `dead_letter` means: stop retrying, keep the row in `errors`, carry on with
 * the rest of the batch.
 */
export function decideRetry({ error, attempt = 1, maxRetries = 3, headers = {} } = {}) {
  const errorType = classifyError(error);
  const retryable = isRetryable(errorType);
  const exhausted = attempt >= maxRetries;
  return {
    error_type: errorType,
    retryable,
    retry: retryable && !exhausted,
    dead_letter: !retryable || exhausted,
    delay_ms: retryable ? backoffMs(attempt, { retryAfterSeconds: retryAfterFrom(headers) }) : 0,
    attempt,
    max_retries: maxRetries,
    reason: !retryable
      ? `${errorType} is not retryable`
      : exhausted
        ? `retry budget exhausted after ${attempt} attempts`
        : `retrying after backoff`
  };
}

/** Wrap an async call with retries. Used by scripts; n8n uses its own node retry plus this classifier. */
export async function withRetry(fn, { maxRetries = 3, onRetry = null, sleep = defaultSleep } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const decision = decideRetry({ error, attempt, maxRetries, headers: error?.headers ?? {} });
      if (onRetry) onRetry(decision, error);
      if (!decision.retry) break;
      await sleep(decision.delay_ms);
    }
  }
  throw lastError;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Simple token-bucket guard so a workflow paces itself against a provider. */
export function rateLimiter({ perMinute = 60 } = {}) {
  const intervalMs = 60000 / perMinute;
  let nextAt = 0;
  return {
    async take(sleep = defaultSleep) {
      const now = Date.now();
      const wait = Math.max(0, nextAt - now);
      nextAt = Math.max(now, nextAt) + intervalMs;
      if (wait > 0) await sleep(wait);
      return wait;
    }
  };
}
