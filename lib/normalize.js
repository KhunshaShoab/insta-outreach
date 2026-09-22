// ---------------------------------------------------------------------------
// Normalisation primitives.
// Everything that turns messy scraped text into a comparable value lives here.
// Pure functions only - no I/O - so the same code runs in tests, in n8n Code
// nodes (inlined by n8n/build.mjs) and in scripts.
// ---------------------------------------------------------------------------

export const US_STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY'
};

const STATE_CODES = new Set(Object.values(US_STATES));

// Legal-entity and decorative suffixes that must not make two rows look different.
const NAME_NOISE = [
  'llc', 'l l c', 'inc', 'inc.', 'incorporated', 'corp', 'corporation', 'co',
  'company', 'ltd', 'limited', 'plc', 'pllc', 'pc', 'pa', 'dds', 'md', 'dmd',
  'the', 'official', 'shop', 'store', 'usa', 'us'
];

export function stripDiacritics(value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function collapseWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Display-safe business name: trimmed, de-emojied, single-spaced. */
export function cleanBusinessName(value) {
  if (!value) return null;
  const cleaned = collapseWhitespace(
    stripDiacritics(value)
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ')
      .replace(/[|•·–—]+/g, ' ')
  );
  return cleaned || null;
}

/**
 * Comparison key for a business name. Lowercase, no punctuation, no legal
 * suffixes, no filler words. "Glow Med Spa, LLC" and "glow medspa" collapse to
 * the same key, which is what the dedupe layer matches on.
 */
export function normalizeBusinessName(value) {
  const base = cleanBusinessName(value);
  if (!base) return null;
  const tokens = base
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !NAME_NOISE.includes(t));
  // "med spa" -> "medspa", "hair salon" -> "hairsalon" is too aggressive; only
  // collapse the two-token forms that are genuinely written both ways.
  const joined = tokens.join(' ')
    .replace(/\bmed spa\b/g, 'medspa')
    .replace(/\bday spa\b/g, 'dayspa')
    .replace(/\be commerce\b/g, 'ecommerce');
  return joined || null;
}

/** Instagram handle without @, url wrapper, query string or trailing slash. */
export function normalizeHandle(value) {
  if (!value) return null;
  let handle = String(value).trim();
  const urlMatch = handle.match(/instagram\.com\/([^/?#]+)/i);
  if (urlMatch) handle = urlMatch[1];
  handle = handle.replace(/^@+/, '').replace(/\/+$/, '').split('?')[0].trim().toLowerCase();
  if (!handle) return null;
  // Instagram handles: letters, numbers, periods, underscores, max 30 chars.
  if (!/^[a-z0-9._]{1,30}$/.test(handle)) return null;
  const reserved = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'direct', 'tv']);
  if (reserved.has(handle)) return null;
  return handle;
}

export function instagramUrl(handle) {
  const h = normalizeHandle(handle);
  return h ? `https://www.instagram.com/${h}/` : null;
}

/** Absolute, lowercase-host URL with tracking parameters removed. */
export function normalizeUrl(value) {
  if (!value) return null;
  let raw = String(value).trim();
  if (!raw || raw === '-' || raw.toLowerCase() === 'n/a') return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname)) return null;
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_|ref|source)/i.test(key)) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.hostname}${path}${url.search}`;
}

// Link-in-bio aggregators are not a website - they must never become a dedupe key.
const AGGREGATOR_DOMAINS = new Set([
  'linktr.ee', 'link.tree', 'beacons.ai', 'bio.link', 'linkin.bio', 'msha.ke',
  'taplink.cc', 'lnk.bio', 'solo.to', 'campsite.bio', 'linkpop.com', 'many.link',
  'instagram.com', 'facebook.com', 'm.facebook.com', 'business.facebook.com',
  'tiktok.com', 'youtube.com', 'twitter.com', 'x.com', 'wa.me', 'api.whatsapp.com',
  'g.page', 'goo.gl', 'maps.google.com', 'yelp.com', 'booksy.com', 'vagaro.com',
  'square.site', 'squareup.com', 'calendly.com', 'sites.google.com'
]);

export function isAggregatorDomain(domain) {
  if (!domain) return false;
  const d = String(domain).toLowerCase().replace(/^www\./, '');
  return AGGREGATOR_DOMAINS.has(d);
}

/** Registrable-ish domain: host without www, aggregators rejected. */
export function normalizeDomain(value) {
  const url = normalizeUrl(value);
  if (!url) return null;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  if (isAggregatorDomain(host)) return null;
  return host;
}

/** US phone to E.164. Anything that is not a plausible US number returns null. */
export function normalizePhone(value, defaultCountry = '1') {
  if (!value) return null;
  const raw = String(value);
  if (/ext|x\d{3,}/i.test(raw) === false && raw.trim().startsWith('+')) {
    const intl = raw.replace(/[^\d+]/g, '');
    if (/^\+\d{8,15}$/.test(intl)) return intl;
  }
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  let national = digits;
  if (national.length === 11 && national.startsWith('1')) national = national.slice(1);
  if (national.length !== 10) return null;
  if (/^[01]/.test(national)) return null;              // invalid NANP area code
  if (/^(\d)\1{9}$/.test(national)) return null;        // 5555555555 style junk
  return `+${defaultCountry}${national}`;
}

export function normalizeEmail(value) {
  if (!value) return null;
  const email = String(value).trim().toLowerCase().replace(/^mailto:/, '');
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) return null;
  const local = email.split('@')[0];
  if (/^(noreply|no-reply|donotreply|postmaster|abuse|privacy)$/.test(local)) return null;
  return email;
}

/** Accepts "California", "california", "CA", "Calif." -> "CA". */
export function normalizeState(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const upper = raw.toUpperCase();
  if (STATE_CODES.has(upper)) return upper;
  const key = stripDiacritics(raw).toLowerCase().replace(/[^a-z\s]/g, '').trim();
  if (US_STATES[key]) return US_STATES[key];
  const prefix = Object.keys(US_STATES).find((name) => name.startsWith(key) && key.length >= 4);
  return prefix ? US_STATES[prefix] : null;
}

export function normalizeCity(value) {
  if (!value) return null;
  const city = collapseWhitespace(stripDiacritics(value).replace(/[^\p{L}\s.'-]/gu, ' '));
  if (!city || city.length < 2) return null;
  return city
    .toLowerCase()
    .split(' ')
    .map((w) => (w.length > 2 || /^(st|ft)$/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

export function slug(value) {
  return stripDiacritics(String(value ?? ''))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 40);
}

/** "12.3k" / "1,234" / "2.1M" -> integer. */
export function parseCount(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;
  const raw = String(value).trim().toLowerCase().replace(/,/g, '').replace(/\s/g, '');
  const match = raw.match(/^([\d.]+)([km])?$/);
  if (!match) return null;
  const n = Number.parseFloat(match[1]);
  if (!Number.isFinite(n)) return null;
  const mult = match[2] === 'k' ? 1e3 : match[2] === 'm' ? 1e6 : 1;
  return Math.round(n * mult);
}

export function toIsoDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function daysSince(value, now = new Date()) {
  const iso = toIsoDate(value);
  if (!iso) return null;
  return Math.floor((now.getTime() - new Date(iso).getTime()) / 86400000);
}

/**
 * Normalise a raw discovery row into the canonical lead shape every downstream
 * step expects. Unknown provider fields are kept under `raw`.
 */
export function normalizeRawLead(raw = {}) {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = k.split('.').reduce((o, part) => (o == null ? o : o[part]), raw);
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  };

  const name = cleanBusinessName(pick('business_name', 'name', 'title', 'fullName', 'ownerFullName'));
  const handle = normalizeHandle(pick('instagram_handle', 'username', 'instagram', 'instagramUrl', 'instagram_url'));
  const website = normalizeUrl(pick('website', 'url', 'externalUrl', 'external_url', 'site'));
  const domain = normalizeDomain(website);
  const state = normalizeState(pick('state', 'region', 'administrativeArea', 'address.state'));
  const city = normalizeCity(pick('city', 'locality', 'address.city'));
  const products = toProductList(pick('products_services', 'products', 'services', 'menu', 'categories'));

  return {
    business_name: name,
    name_normalized: normalizeBusinessName(name),
    instagram_handle: handle,
    instagram_url: instagramUrl(handle) ?? normalizeUrl(pick('instagram_url', 'instagramUrl')),
    website,
    website_domain: domain,
    email: normalizeEmail(pick('email', 'emails.0', 'contact_email')),
    phone: pick('phone', 'phoneNumber', 'phone_number', 'telephone'),
    phone_e164: normalizePhone(pick('phone', 'phoneNumber', 'phone_number', 'telephone')),
    country: pick('country', 'countryCode') ?? 'US',
    state,
    city,
    postal_code: pick('postal_code', 'postalCode', 'zip'),
    address: pick('address', 'formattedAddress', 'street'),
    latitude: numberOrNull(pick('latitude', 'location.lat', 'lat')),
    longitude: numberOrNull(pick('longitude', 'location.lng', 'lng')),
    category: pick('category', 'categoryName', 'businessCategoryName', 'business_category'),
    bio: pick('bio', 'biography', 'description'),
    website_description: pick('website_description', 'meta_description'),
    products_services: products,
    products_count: products.length || parseCount(pick('products_count', 'productsCount')),
    ig_followers: parseCount(pick('ig_followers', 'followersCount', 'followers', 'follower_count')),
    ig_following: parseCount(pick('ig_following', 'followsCount', 'following')),
    ig_posts: parseCount(pick('ig_posts', 'postsCount', 'posts', 'media_count')),
    ig_is_business: boolOrNull(pick('ig_is_business', 'isBusinessAccount', 'is_business_account')),
    ig_is_private: boolOrNull(pick('ig_is_private', 'private', 'is_private')),
    ig_is_verified: boolOrNull(pick('ig_is_verified', 'verified', 'is_verified')),
    ig_last_post_at: toIsoDate(pick('ig_last_post_at', 'latestPostDate', 'last_post_at')),
    ig_external_url: normalizeUrl(pick('externalUrl', 'external_url', 'bio_link')),
    place_id: pick('place_id', 'placeId', 'fid'),
    source: pick('source', '_source') ?? 'unknown',
    source_search_term: pick('search_term', 'searchString', 'query'),
    raw
  };
}

function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function boolOrNull(v) {
  if (v === true || v === false) return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

/** Products/services arrive as arrays, comma strings or objects. */
export function toProductList(value) {
  if (!value) return [];
  let items = [];
  if (Array.isArray(value)) items = value;
  else if (typeof value === 'string') items = value.split(/[,;|\n]/);
  else if (typeof value === 'object') items = Object.values(value);
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const label = collapseWhitespace(
      typeof item === 'string' ? item : (item?.name ?? item?.title ?? item?.label ?? '')
    );
    if (!label || label.length < 2 || label.length > 120) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}
