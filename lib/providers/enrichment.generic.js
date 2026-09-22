// ---------------------------------------------------------------------------
// Template adapter for any other enrichment provider (Clearbit, Hunter, ...).
// Copy this file, fill in `endpoint` and `mapResponse`, then point
// config/providers.json at it. Nothing else in the system changes.
// ---------------------------------------------------------------------------
import { request } from './http.js';
import { classifyRole } from '../decision-maker.js';

export function create(env = {}, spec = {}) {
  const apiKey = env[spec.credentials?.[0] ?? 'GENERIC_ENRICHMENT_KEY'];
  const endpoint = env.GENERIC_ENRICHMENT_URL ?? spec.endpoint;

  return {
    async enrich(company, ctx = {}) {
      if (!endpoint) {
        return { provider: spec.name ?? 'generic', found: false, contacts: [], company: {}, reason: 'adapter not configured' };
      }
      const { data } = await request({
        url: `${endpoint}?domain=${encodeURIComponent(company.website_domain ?? '')}`,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        provider: spec.name ?? 'generic',
        operation: 'enrich',
        onCall: ctx.onCall
      });
      return mapResponse(data);
    }
  };
}

/** The only function a new provider has to write. */
export function mapResponse(data = {}) {
  const people = data.people ?? data.emails ?? [];
  return {
    provider: 'generic',
    found: people.length > 0,
    contacts: people.map((p) => ({
      full_name: p.name ?? [p.first_name, p.last_name].filter(Boolean).join(' ') || null,
      first_name: p.first_name ?? null,
      last_name: p.last_name ?? null,
      title: p.position ?? p.title ?? null,
      role_category: classifyRole(p.position ?? p.title),
      email: p.value ?? p.email ?? null,
      phone: p.phone_number ?? null,
      linkedin_url: p.linkedin ?? null,
      source: 'generic',
      source_confidence: Number(p.confidence ?? 50) / 100,
      raw: p
    })),
    company: { employee_count: data.organization?.employees ?? null, raw: data.organization ?? {} }
  };
}
