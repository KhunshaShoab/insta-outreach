// ---------------------------------------------------------------------------
// Deduplication.
// Two walls stop a business being contacted twice:
//   1. this module, in memory, inside a discovery batch;
//   2. resolve_company() + unique(campaign_id, company_id) in the database.
// Both use the same identity keys, in the same priority order.
// ---------------------------------------------------------------------------
import { normalizeBusinessName, normalizeHandle, normalizeDomain, normalizePhone, normalizeEmail } from './normalize.js';

export const KEY_PRIORITY = ['instagram_handle', 'website_domain', 'place_id', 'phone_e164', 'email', 'name_city'];

/** Every identity key a lead carries, strongest first. */
export function identityKeys(lead = {}) {
  const keys = [];
  const handle = normalizeHandle(lead.instagram_handle);
  const domain = normalizeDomain(lead.website_domain ?? lead.website);
  const phone = normalizePhone(lead.phone_e164 ?? lead.phone);
  const email = normalizeEmail(lead.email);
  const name = lead.name_normalized ?? normalizeBusinessName(lead.business_name);

  if (handle) keys.push({ key_type: 'instagram_handle', key_value: handle });
  if (domain) keys.push({ key_type: 'website_domain', key_value: domain });
  if (lead.place_id) keys.push({ key_type: 'place_id', key_value: String(lead.place_id) });
  if (phone) keys.push({ key_type: 'phone_e164', key_value: phone });
  if (email) keys.push({ key_type: 'email', key_value: email });
  if (name) {
    keys.push({
      key_type: 'name_city',
      key_value: `${name}|${(lead.city ?? '').toLowerCase()}|${(lead.state ?? '').toUpperCase()}`
    });
  }
  return keys;
}

/** Levenshtein distance, iterative, two-row. */
export function levenshtein(a = '', b = '') {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i += 1) {
    const cur = [i + 1];
    for (let j = 0; j < b.length; j += 1) {
      cur[j + 1] = Math.min(prev[j + 1] + 1, cur[j] + 1, prev[j] + (a[i] === b[j] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 0..1 similarity blending edit distance with token overlap. */
export function nameSimilarity(a, b) {
  const x = normalizeBusinessName(a);
  const y = normalizeBusinessName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const edit = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  const ta = new Set(x.split(' '));
  const tb = new Set(y.split(' '));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const jaccard = inter / (ta.size + tb.size - inter);
  return Math.max(0, Math.min(1, 0.5 * edit + 0.5 * jaccard));
}

/**
 * Do two leads describe the same business?
 * Strong keys decide on their own. A name match only counts when the location
 * agrees, so "Glow Medspa, Austin" never merges into "Glow Medspa, Miami".
 */
export function isLikelySame(a, b, { nameThreshold = 0.92 } = {}) {
  const ka = identityKeys(a);
  const kb = identityKeys(b);
  for (const type of KEY_PRIORITY) {
    if (type === 'name_city') continue;
    const va = ka.find((k) => k.key_type === type)?.key_value;
    const vb = kb.find((k) => k.key_type === type)?.key_value;
    if (va && vb) {
      if (va === vb) return { same: true, matched_on: type, confidence: 1 };
      if (type === 'instagram_handle' || type === 'website_domain') {
        // Conflicting strong keys mean these really are different businesses.
        return { same: false, matched_on: null, confidence: 0, conflict: type };
      }
    }
  }
  const sim = nameSimilarity(a.business_name, b.business_name);
  const sameCity = (a.city ?? '').toLowerCase() === (b.city ?? '').toLowerCase() && Boolean(a.city);
  const sameState = (a.state ?? '').toUpperCase() === (b.state ?? '').toUpperCase() && Boolean(a.state);
  if (sim >= nameThreshold && sameCity && sameState) {
    return { same: true, matched_on: 'name_city', confidence: sim };
  }
  return { same: false, matched_on: null, confidence: sim };
}

/**
 * Collapse a discovery batch.
 * Returns { unique, duplicates } where each duplicate records what it matched.
 * Records are merged field-by-field so the surviving row keeps the best value
 * from every copy (a handle from one source, a phone from another).
 */
export function dedupeBatch(leads = [], options = {}) {
  const index = new Map();       // key -> position in unique[]
  const unique = [];
  const duplicates = [];

  for (const lead of leads) {
    const keys = identityKeys(lead);
    let hitIndex = -1;
    let matchedOn = null;

    for (const type of KEY_PRIORITY) {
      const key = keys.find((k) => k.key_type === type);
      if (!key) continue;
      const found = index.get(`${key.key_type}:${key.key_value}`);
      if (found !== undefined) {
        hitIndex = found;
        matchedOn = key.key_type;
        break;
      }
    }

    if (hitIndex === -1) {
      // No exact key hit: fall back to fuzzy comparison against same-city rows.
      for (let i = 0; i < unique.length; i += 1) {
        const verdict = isLikelySame(unique[i], lead, options);
        if (verdict.same) {
          hitIndex = i;
          matchedOn = verdict.matched_on;
          break;
        }
      }
    }

    if (hitIndex === -1) {
      unique.push({ ...lead });
      const position = unique.length - 1;
      for (const key of keys) index.set(`${key.key_type}:${key.key_value}`, position);
    } else {
      duplicates.push({ lead, duplicate_of: unique[hitIndex], matched_on: matchedOn });
      unique[hitIndex] = mergeLeads(unique[hitIndex], lead);
      for (const key of identityKeys(unique[hitIndex])) {
        if (!index.has(`${key.key_type}:${key.key_value}`)) {
          index.set(`${key.key_type}:${key.key_value}`, hitIndex);
        }
      }
    }
  }

  return { unique, duplicates };
}

/** Gap-filling merge: never replace a known value with null, prefer richer lists. */
export function mergeLeads(base, incoming) {
  const out = { ...base };
  for (const [field, value] of Object.entries(incoming)) {
    if (value === null || value === undefined || value === '') continue;
    const current = out[field];
    if (current === null || current === undefined || current === '') {
      out[field] = value;
      continue;
    }
    if (Array.isArray(value) && Array.isArray(current)) {
      const merged = [...current];
      const seen = new Set(current.map((v) => String(v).toLowerCase()));
      for (const item of value) {
        const key = String(item).toLowerCase();
        if (!seen.has(key)) { seen.add(key); merged.push(item); }
      }
      out[field] = merged;
      continue;
    }
    if (typeof value === 'number' && typeof current === 'number') {
      // Counts: trust the larger, more complete observation.
      if (/^(ig_followers|ig_following|ig_posts|products_count)$/.test(field)) {
        out[field] = Math.max(current, value);
      }
      continue;
    }
    if (field === 'raw' && typeof value === 'object') {
      out.raw = { ...(current ?? {}), ...value };
    }
  }
  out.products_count = (out.products_services ?? []).length || out.products_count || null;
  return out;
}
