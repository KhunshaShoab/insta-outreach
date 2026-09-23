// ---------------------------------------------------------------------------
// V1 deduplication.
//
// Match priority, as specified:
//   1. exact domain   2. normalised website   3. company + city
//   4. company + phone   5. company + email
//
// With one correction the data forced. In the attached funeral-home file, 507
// of 716 rows share a website with another row: legacyalaska.com appears 26
// times, dignitymemorial.com 24 times. Those are chains and directories, not
// duplicates - 26 distinct funeral homes in different towns share one corporate
// site. Merging on domain alone would silently delete 25 real businesses.
//
// So a domain match merges only when the location or the name also agrees.
// Otherwise the rows are recorded as RELATED LOCATIONS: kept as separate leads,
// linked to each other, and flagged so a reviewer can see the group.
// ---------------------------------------------------------------------------
import { normalizeBusinessName, normalizeDomain, normalizePhone, normalizeEmail } from '../normalize.js';
import { nameSimilarity } from '../dedupe.js';

const NAME_MERGE_THRESHOLD = 0.90;

function keyOf(lead) {
  return {
    domain: lead.domain ?? normalizeDomain(lead.website),
    website: lead.website ? String(lead.website).toLowerCase().replace(/\/+$/, '') : null,
    name: lead.name_normalized ?? normalizeBusinessName(lead.company_name),
    city: lead.city ? String(lead.city).toLowerCase() : null,
    state: lead.state ? String(lead.state).toUpperCase() : null,
    phone: lead.phone_e164 ?? normalizePhone(lead.phone),
    email: lead.email ? normalizeEmail(lead.email) : null
  };
}

/**
 * Decide the relationship between two leads.
 * @returns {{ verdict: 'duplicate'|'related_location'|'distinct', matched_on, reason }}
 */
export function compareLeads(a, b) {
  const x = keyOf(a);
  const y = keyOf(b);
  const sameName = Boolean(x.name && y.name && x.name === y.name);
  const similarName = x.name && y.name ? nameSimilarity(a.company_name, b.company_name) >= NAME_MERGE_THRESHOLD : false;
  const sameCity = Boolean(x.city && y.city && x.city === y.city && x.state === y.state);

  // 1 + 2. Same website or domain.
  if (x.domain && y.domain && x.domain === y.domain) {
    if (x.website && y.website && x.website === y.website && (sameName || similarName || sameCity)) {
      return { verdict: 'duplicate', matched_on: 'website', reason: 'identical website and the name or city agrees' };
    }
    if (sameName || similarName) {
      return { verdict: 'duplicate', matched_on: 'domain+name', reason: 'same domain and the same business name' };
    }
    if (sameCity) {
      return { verdict: 'duplicate', matched_on: 'domain+city', reason: 'same domain in the same city' };
    }
    // A shared corporate or directory site across different names and towns.
    return {
      verdict: 'related_location',
      matched_on: 'domain',
      reason: 'shares a website but the name and city differ - likely separate locations under one brand'
    };
  }

  // 3. Company + city.
  if ((sameName || similarName) && sameCity) {
    return { verdict: 'duplicate', matched_on: 'company+city', reason: 'same business name in the same city' };
  }

  // 4. Company + phone.
  if ((sameName || similarName) && x.phone && y.phone && x.phone === y.phone) {
    return { verdict: 'duplicate', matched_on: 'company+phone', reason: 'same business name and phone number' };
  }

  // A shared phone with different names is a switchboard or an answering
  // service, not proof of one business.
  if (x.phone && y.phone && x.phone === y.phone && !sameName && !similarName) {
    return { verdict: 'related_location', matched_on: 'phone', reason: 'shares a phone number with a differently named business' };
  }

  // 5. Company + email.
  if ((sameName || similarName) && x.email && y.email && x.email === y.email) {
    return { verdict: 'duplicate', matched_on: 'company+email', reason: 'same business name and email address' };
  }

  return { verdict: 'distinct', matched_on: null, reason: null };
}

/** Prefer the record with more usable information when merging. */
function completeness(lead) {
  const fields = ['website', 'phone_e164', 'email', 'address', 'city', 'state', 'rating', 'review_count', 'instagram', 'company_description'];
  return fields.reduce((n, f) => n + (lead[f] ? 1 : 0), 0);
}

/**
 * Deduplicate a batch.
 * @returns {{ unique, duplicates, groups }}
 *   unique      - the leads to carry forward, each with duplicate_of/related_locations
 *   duplicates  - dropped rows, each pointing at the row it merged into
 *   groups      - related-location clusters, kept as separate leads
 */
export function dedupeLeads(leads = []) {
  const unique = [];
  const duplicates = [];
  const byDomain = new Map();
  const byNameCity = new Map();
  const byPhone = new Map();

  for (const lead of leads) {
    const k = keyOf(lead);
    // Only leads that could plausibly match are compared, rather than all pairs.
    const candidateIndexes = new Set([
      ...(k.domain ? byDomain.get(k.domain) ?? [] : []),
      ...(k.name && k.city ? byNameCity.get(`${k.name}|${k.city}`) ?? [] : []),
      ...(k.phone ? byPhone.get(k.phone) ?? [] : [])
    ]);

    let merged = false;
    const related = [];

    for (const index of candidateIndexes) {
      const { verdict, matched_on, reason } = compareLeads(unique[index], lead);
      if (verdict === 'duplicate') {
        const keeper = completeness(lead) > completeness(unique[index]) ? lead : unique[index];
        const loser = keeper === lead ? unique[index] : lead;
        // Fill the keeper's gaps from the loser; never overwrite a known value.
        for (const [field, value] of Object.entries(loser)) {
          if (value !== null && value !== undefined && value !== '' &&
              (keeper[field] === null || keeper[field] === undefined || keeper[field] === '')) {
            keeper[field] = value;
          }
        }
        keeper.merged_from = [...(keeper.merged_from ?? []), {
          source_file: loser.source_file, original_row: loser.original_row,
          company_name: loser.company_name, matched_on, reason
        }];
        unique[index] = keeper;
        duplicates.push({
          company_name: lead.company_name, source_file: lead.source_file, original_row: lead.original_row,
          duplicate_of: { source_file: unique[index].source_file, original_row: unique[index].original_row, company_name: unique[index].company_name },
          matched_on, reason
        });
        merged = true;
        break;
      }
      if (verdict === 'related_location') {
        related.push({ index, matched_on, reason });
      }
    }

    if (merged) continue;

    lead.related_locations = related.map(({ index, matched_on, reason }) => ({
      company_name: unique[index].company_name, city: unique[index].city,
      original_row: unique[index].original_row, matched_on, reason
    }));
    unique.push(lead);
    const position = unique.length - 1;
    // Link the group both ways so a reviewer sees it from either end.
    for (const { index, matched_on, reason } of related) {
      (unique[index].related_locations ??= []).push({
        company_name: lead.company_name, city: lead.city,
        original_row: lead.original_row, matched_on, reason
      });
    }
    if (k.domain) (byDomain.get(k.domain) ?? byDomain.set(k.domain, []).get(k.domain)).push(position);
    if (k.name && k.city) {
      const key = `${k.name}|${k.city}`;
      (byNameCity.get(key) ?? byNameCity.set(key, []).get(key)).push(position);
    }
    if (k.phone) (byPhone.get(k.phone) ?? byPhone.set(k.phone, []).get(k.phone)).push(position);
  }

  const groups = [...byDomain.entries()]
    .filter(([, positions]) => positions.length > 1)
    .map(([domain, positions]) => ({
      domain,
      count: positions.length,
      members: positions.map((p) => ({ company_name: unique[p].company_name, city: unique[p].city, state: unique[p].state }))
    }))
    .sort((a, b) => b.count - a.count);

  return { unique, duplicates, groups };
}
