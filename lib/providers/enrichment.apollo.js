// ---------------------------------------------------------------------------
// Enrichment adapter: Apollo.
// Finds the people behind a business. A miss is never fatal - the chain in
// config/providers.json falls through to website scraping, and a lead with no
// named contact still goes to outreach addressed to the business.
// ---------------------------------------------------------------------------
import { request } from './http.js';
import { classifyRole } from '../decision-maker.js';

const BASE = 'https://api.apollo.io/api/v1';

const TITLE_QUERY = [
  'founder', 'co-founder', 'owner', 'ceo', 'president',
  'head of operations', 'operations manager', 'director of operations',
  'customer experience', 'customer support', 'customer service manager',
  'marketing director', 'head of marketing'
];

export function create(env = {}) {
  const apiKey = env.APOLLO_API_KEY;
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apiKey };

  return {
    /**
     * @param {object} company { name, website_domain, city, state }
     * @returns {Promise<{ contacts, company, provider, found }>}
     */
    async enrich(company, ctx = {}) {
      if (!company?.website_domain && !company?.name) {
        return { provider: 'apollo', found: false, contacts: [], company: {}, reason: 'no domain or name to search on' };
      }

      const payload = {
        page: 1,
        per_page: ctx.perPage ?? 10,
        person_titles: ctx.titles ?? TITLE_QUERY,
        ...(company.website_domain
          ? { q_organization_domains: [company.website_domain] }
          : { q_organization_name: company.name })
      };

      const { data } = await request({
        url: `${BASE}/mixed_people/search`,
        method: 'POST',
        headers,
        body: payload,
        provider: 'apollo',
        operation: 'people_search',
        onCall: ctx.onCall,
        timeoutMs: ctx.timeoutMs ?? 30000,
        maxRetries: ctx.maxRetries ?? 3
      });

      const people = data?.people ?? data?.contacts ?? [];
      const org = people[0]?.organization ?? data?.organizations?.[0] ?? {};

      return {
        provider: 'apollo',
        found: people.length > 0,
        contacts: people.map((p) => ({
          full_name: p.name ?? ([p.first_name, p.last_name].filter(Boolean).join(' ') || null),
          first_name: p.first_name ?? null,
          last_name: p.last_name ?? null,
          title: p.title ?? null,
          role_category: classifyRole(p.title),
          seniority: p.seniority ?? null,
          email: p.email && !/email_not_unlocked/i.test(p.email) ? p.email : null,
          phone: p.phone_numbers?.[0]?.sanitized_number ?? null,
          linkedin_url: p.linkedin_url ?? null,
          instagram_handle: null,
          source: 'apollo',
          source_confidence: p.email ? 0.9 : 0.7,
          raw: p
        })),
        company: {
          employee_count: org.estimated_num_employees ?? null,
          company_size: org.estimated_num_employees ? String(org.estimated_num_employees) : null,
          linkedin_url: org.linkedin_url ?? null,
          facebook_url: org.facebook_url ?? null,
          website_description: org.short_description ?? null,
          industry: org.industry ?? null,
          raw: org
        }
      };
    }
  };
}
