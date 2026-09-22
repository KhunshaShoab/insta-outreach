// ---------------------------------------------------------------------------
// Discovery adapter: any HTTP endpoint.
// The escape hatch for replacing Apify with your own scraper, a different
// vendor, or an internal service. POST in the campaign + search terms, get back
// rows in the RawLead shape.
// ---------------------------------------------------------------------------
import { request } from './http.js';
import { buildSearchTerms } from '../search-terms.js';

export function create(env = {}, spec = {}) {
  const url = env.DISCOVERY_HTTP_URL ?? spec.url;
  const token = env.DISCOVERY_HTTP_TOKEN;

  return {
    async discover(campaign, ctx = {}) {
      if (!url) throw new Error('discovery.http: DISCOVERY_HTTP_URL is not set');
      const { data } = await request({
        url,
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: {
          campaign_id: campaign.id,
          niche: ctx.niche?.id ?? campaign.niche_id,
          targeting: campaign.targeting,
          search_terms: buildSearchTerms(campaign, ctx.niche ?? {}),
          limit: ctx.limit ?? campaign?.discovery?.daily_lead_target ?? 100
        },
        timeoutMs: ctx.timeoutMs ?? 120000,
        provider: 'discovery_http',
        operation: 'discover',
        onCall: ctx.onCall
      });
      const rows = Array.isArray(data) ? data : data?.results ?? data?.items ?? [];
      return rows.map((row) => ({ ...row, source: row.source ?? 'custom_http' }));
    }
  };
}
