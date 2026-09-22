// WORKFLOW 3 - Lead Enrichment
// CLEANED -> ENRICHED. Finds the people behind the business and picks the one
// to address. A provider miss never discards a lead: the fallback runs, and a
// business with no named contact still goes to outreach addressed to the
// account itself.
import { workflow, schedule, subWorkflowTrigger, code, supabase, ifNode, http, noop } from '../dsl.mjs';
import { withLib } from '../bundle.mjs';
import { loadCampaign, claim, advance, classifyFailure, failLead } from './_shared.mjs';

export function build() {
  const wf = workflow('wf03-enrichment', {
    description: 'Enrich cleaned leads with company and contact data, then choose the decision maker.',
    tags: ['optiflow', 'enrichment']
  });

  const cron = wf.add(schedule('Every 15 Minutes', '*/15 6-20 * * 1-5'));
  const called = wf.add(subWorkflowTrigger('Called By Orchestrator'), { column: 0, row: 1 });
  const campaign = wf.add(loadCampaign(), { column: 1, row: 0 });
  wf.connect(cron, campaign);
  wf.connect(called, campaign);

  const claimed = wf.add(claim('CLEANED', { worker: 'wf03-enrichment' }), { column: 2, row: 0 });

  const fetchCompany = wf.add(supabase('Fetch Company Record', {
    method: 'GET', path: 'companies', query: '?id=eq.{{ $json.company_id }}&select=*'
  }), { column: 3, row: 0 });

  const prepare = wf.add(code('Prepare Enrichment Input', `
const campaign = $('Load Campaign + Niche').first().json;
const claimed = $('Claim CLEANED Leads').all().map((i) => i.json);
return $input.all().map((item) => {
  const company = Array.isArray(item.json) ? item.json[0] : item.json;
  const lead = claimed.find((l) => l.company_id === company.id) || {};
  return { json: {
    lead_id: lead.id,
    company_id: company.id,
    campaign_id: campaign.id,
    name: company.name,
    website_domain: company.website_domain,
    instagram_handle: company.instagram_handle,
    city: company.city,
    state: company.state,
    skip_provider: Boolean(campaign.enrichment?.skip_if_contact_present && company.email && company.linkedin_url)
  } };
});
`), { column: 4, row: 0 });

  const hasDomain = wf.add(ifNode('Domain Available?', {
    left: '={{ Boolean($json.website_domain) }}',
    operator: { type: 'boolean', operation: 'true', singleValue: true }
  }, { notes: 'Apollo searches on a domain. Without one, go straight to the fallback rather than burning a credit.' }), { column: 5, row: 0 });

  const apollo = wf.add(http('Enrich (Apollo)', {
    method: 'POST',
    url: 'https://api.apollo.io/api/v1/mixed_people/search',
    headers: [
      { name: 'x-api-key', value: '={{ $env.APOLLO_API_KEY }}' },
      { name: 'Content-Type', value: 'application/json' }
    ],
    body: `={{ JSON.stringify({
      q_organization_domains: [$json.website_domain],
      person_titles: ['founder','co-founder','owner','ceo','president','head of operations','operations manager','customer experience','customer support','marketing director'],
      page: 1,
      per_page: 10
    }) }}`,
    notes: 'Replaceable: config/providers.json capability "enrichment". The fallback chain is declared there, not hard-coded here.'
  }), { column: 6, row: 0 });

  const websiteFallback = wf.add(http('Enrich (Website Fallback)', {
    method: 'GET',
    url: '=https://{{ $json.website_domain || "example.invalid" }}/about',
    headers: [{ name: 'User-Agent', value: 'OptiFlowResearchBot/1.0' }],
    timeout: 15000,
    continueOnFail: true,
    notes: 'Runs when the paid provider finds nobody. This is what keeps founder-led businesses - the best prospects - in the pipeline.'
  }), { column: 6, row: 1 });

  const merge = wf.add(code('Merge Contacts + Pick Decision Maker', withLib(['lib/decision-maker.js', 'lib/normalize.js'], `
const prepared = $('Prepare Enrichment Input').all().map((i) => i.json);
const out = [];

function fromApollo(payload) {
  const people = payload?.people ?? payload?.contacts ?? [];
  return people.map((p) => ({
    full_name: p.name ?? ([p.first_name, p.last_name].filter(Boolean).join(' ') || null),
    first_name: p.first_name ?? null,
    last_name: p.last_name ?? null,
    title: p.title ?? null,
    role_category: classifyRole(p.title),
    seniority: p.seniority ?? null,
    email: p.email && !/email_not_unlocked/i.test(p.email) ? normalizeEmail(p.email) : null,
    phone: p.phone_numbers?.[0]?.sanitized_number ?? null,
    linkedin_url: p.linkedin_url ?? null,
    source: 'apollo',
    source_confidence: p.email ? 0.9 : 0.7
  })).filter((c) => c.full_name || c.title);
}

function fromHtml(html) {
  if (typeof html !== 'string') return [];
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ');
  const found = [];
  const re = /([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){1,2})\\s*[,|\\-\\u2013]\\s*((?:founder|co-?founder|owner|ceo|president|director|head of [a-z ]+|manager)[a-z ]*)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    found.push({
      full_name: m[1].trim(), first_name: m[1].trim().split(' ')[0], title: m[2].trim(),
      role_category: classifyRole(m[2]), source: 'website_scrape', source_confidence: 0.55
    });
  }
  return found;
}

for (const [index, item] of $input.all().entries()) {
  const context = prepared[index] ?? prepared[0] ?? {};
  const payload = item.json;
  const contacts = [...fromApollo(payload), ...fromHtml(payload?.data ?? payload?.body ?? payload)];

  const company = {
    employee_count: payload?.people?.[0]?.organization?.estimated_num_employees ?? null,
    company_size: null,
    business_model: $('Load Campaign + Niche').first().json.niche?.business_model ?? null
  };

  const chosen = selectDecisionMaker(contacts, company);

  out.push({ json: {
    lead_id: context.lead_id,
    company_id: context.company_id,
    campaign_id: context.campaign_id,
    contacts,
    contacts_found: contacts.length,
    employee_count: company.employee_count,
    decision_maker: chosen.contact,
    decision_maker_reason: chosen.why,
    decision_maker_confidence: chosen.confidence,
    // A lead with no contact is NOT dropped - it continues with what is known.
    keep_without_contact: true
  } });
}
return out;
`), { notes: 'Ranks contacts by company size: founder/owner for small businesses, the person who owns the support queue for larger ones.' }), { column: 7, row: 0 });

  const storeContacts = wf.add(supabase('Store Contacts', {
    method: 'POST',
    path: 'contacts',
    query: '?on_conflict=company_id,email',
    body: `={{ JSON.stringify(($json.contacts || []).map((c) => ({
      company_id: $json.company_id,
      full_name: c.full_name, first_name: c.first_name, last_name: c.last_name,
      title: c.title, role_category: c.role_category, seniority: c.seniority,
      email: c.email, phone: c.phone, linkedin_url: c.linkedin_url,
      source: c.source, source_confidence: c.source_confidence,
      is_primary_target: Boolean($json.decision_maker && c.full_name === $json.decision_maker.full_name),
      target_reason: (c.full_name === $json.decision_maker?.full_name) ? $json.decision_maker_reason : null
    }))) }}`,
    continueOnFail: true,
    notes: 'Upsert on (company_id, email). Contacts without an email are inserted once per run and de-duplicated by the partial unique index.'
  }), { column: 8, row: 0 });

  const linkContact = wf.add(supabase('Link Decision Maker To Lead', {
    method: 'PATCH',
    path: 'leads',
    query: '?id=eq.{{ $json.lead_id }}',
    body: `={{ JSON.stringify({ contact_id: ($('Store Contacts').item.json || []).find((c) => c.is_primary_target)?.id ?? null }) }}`,
    continueOnFail: true
  }), { column: 9, row: 0 });

  const advanced = wf.add(advance('Advance To ENRICHED', 'ENRICHED', 'NEW', 'enrich.contacts',
    '{ actor: "n8n:wf03", contacts_found: $json.contacts_found, decision_maker: $json.decision_maker?.full_name ?? null }'), { column: 10, row: 0 });

  wf.chain(campaign, claimed, fetchCompany, prepare, hasDomain);
  wf.connect([hasDomain, 0], apollo);
  wf.connect([hasDomain, 1], websiteFallback);
  wf.connect(apollo, merge);
  wf.connect(websiteFallback, merge);
  wf.chain(merge, storeContacts, linkContact, advanced);

  // A provider failure must not lose the lead: fall through to the website path.
  wf.connect([apollo, 1], websiteFallback);

  const classify = wf.add(classifyFailure('wf03-enrichment'), { column: 8, row: 2 });
  const fail = wf.add(failLead('wf03-enrichment', 'Enrich (Apollo)'), { column: 9, row: 2 });
  wf.connect([fetchCompany, 1], classify);
  wf.connect(classify, fail);

  return wf.toJSON();
}
