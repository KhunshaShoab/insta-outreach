// ---------------------------------------------------------------------------
// Column detection and row mapping - the pure half of ingestion.
//
// Separate from ingest.js because this module has no filesystem imports, which
// is what lets n8n/build.mjs inline it into an n8n Code node. ingest.js adds
// the file reading on top for the CLI.
// ---------------------------------------------------------------------------
import {
  cleanBusinessName, normalizeBusinessName, normalizeHandle, normalizeUrl,
  normalizeDomain, normalizePhone, normalizeEmail, normalizeState, normalizeCity,
  parseCount, toProductList
} from '../normalize.js';
import { emptyLead } from './schema.js';

// Every alias is compared after lowercasing and collapsing punctuation, so
// "Business Name", "business_name" and "BUSINESS-NAME" all match.
export const COLUMN_ALIASES = {
  company_name: ['company', 'business', 'business name', 'company name', 'name', 'organisation', 'organization', 'practice', 'practice name', 'account name', 'dba'],
  website: ['website', 'url', 'web', 'site', 'web address', 'homepage', 'website url', 'company website', 'domain', 'company domain'],
  industry: ['industry', 'sector', 'vertical', 'niche'],
  category: ['category', 'type', 'business type', 'primary category', 'categories'],
  keywords: ['keywords', 'tags', 'search keywords'],
  country: ['country', 'country code'],
  state: ['state', 'province', 'region', 'state province'],
  city: ['city', 'town', 'locality'],
  address: ['address', 'street', 'street address', 'full address', 'location', 'formatted address', 'company raw address', 'company street address'],
  postal_code: ['zip', 'zipcode', 'zip code', 'postal', 'postal code', 'postcode', 'company postal code'],
  employees: ['employees', 'employee count', 'employees count', 'headcount', 'company size', 'staff', 'num employees'],
  revenue: ['revenue', 'annual revenue', 'turnover', 'company annual revenue', 'company annual revenue clean'],
  founded_year: ['founded', 'founded year', 'company founded year', 'year founded'],
  contact_name: ['contact', 'contact name', 'full name', 'owner', 'owner name', 'decision maker'],
  first_name: ['first name', 'firstname', 'given name'],
  last_name: ['last name', 'lastname', 'surname', 'family name'],
  job_title: ['job title', 'position', 'role', 'designation', 'headline'],
  seniority: ['seniority', 'seniority level'],
  department: ['department', 'departments', 'function'],
  email: ['email', 'e mail', 'email address', 'contact email', 'work email', 'primary email'],
  phone: ['phone', 'phone number', 'telephone', 'tel', 'contact number', 'primary phone', 'company phone number', 'company phone'],
  linkedin: ['linkedin', 'linkedin url', 'linkedin profile', 'personal linkedin'],
  company_linkedin: ['company linkedin', 'linkedin company', 'company linkedin url'],
  facebook: ['facebook', 'facebook url', 'fb', 'company facebook'],
  twitter: ['twitter', 'twitter url', 'x', 'x url', 'company twitter'],
  instagram: ['instagram', 'instagram url', 'instagram handle', 'ig', 'ig handle', 'company instagram'],
  google_maps_url: ['google maps', 'google maps url', 'maps url', 'gmb url', 'google url'],
  rating: ['rating', 'stars', 'average rating', 'google rating'],
  review_count: ['review count', 'reviews', 'number of reviews', 'total reviews', 'review total'],
  company_description: ['description', 'about', 'company description', 'summary', 'bio', 'notes', 'snippet', 'company short description', 'company seo description'],
  technologies: ['technologies', 'tech', 'tech stack', 'technology', 'company technologies'],
  // The business's own location, which is not always where the contact sits.
  company_city: ['company city'],
  company_state: ['company state'],
  company_country: ['company country']
};

// Columns deliberately left unmapped. A person's mobile number and personal
// email address are not what a cold business approach should use, so they are
// not carried into the pipeline even when a file supplies them.
export const DELIBERATELY_IGNORED = ['mobile number', 'personal email', 'person photo', 'person id', 'company id', 'company logo', 'company linkedin uid'];

const squash = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Map headers onto V1 fields. Several headers may feed one field, in the order
 * they appear - the first non-empty value wins at read time.
 */
export function detectColumns(headers) {
  const mapping = {};
  const matched = new Set();

  // "Title" means the place name in a Google Maps export and the person's job
  // title in a CRM export. If the file names the company some other way, Title
  // is a job title - otherwise it is the company name.
  const hasCompanyColumn = headers.some((h) =>
    ['company', 'business', 'business name', 'company name', 'account name', 'organisation', 'organization'].includes(squash(h))
  );
  const titleField = hasCompanyColumn ? 'job_title' : 'company_name';

  const ignored = [];
  for (const header of headers) {
    const key = squash(header);
    if (!key) continue;
    if (DELIBERATELY_IGNORED.includes(key)) { ignored.push(header); continue; }
    if (key === 'title') {
      (mapping[titleField] ??= []).push(header);
      matched.add(header);
      continue;
    }
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.includes(key)) {
        (mapping[field] ??= []).push(header);
        matched.add(header);
        break;
      }
    }
  }
  const ignoredSet = new Set(ignored);
  return {
    mapping,
    ignored,
    unmapped: headers.filter((h) => h && !matched.has(h) && !ignoredSet.has(h))
  };
}

/** Map one raw row onto the V1 schema. */
export function mapRow(row, mapping, { sourceFile, sourceLabel }) {
  const pick = (field) => {
    for (const header of mapping[field] ?? []) {
      const value = row[header];
      if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
    }
    return null;
  };

  const lead = emptyLead();
  const rawName = pick('company_name');
  lead.company_name = cleanBusinessName(rawName);
  lead.name_normalized = normalizeBusinessName(rawName);
  lead.website = normalizeUrl(pick('website'));
  lead.domain = normalizeDomain(lead.website);
  lead.industry = pick('industry');
  lead.category = pick('category');
  // The company's location wins over the contact's: a courier in Calgary with
  // an owner living in London, Ontario is a Calgary business.
  lead.country = pick('company_country') ?? pick('country') ?? 'US';
  const rawState = pick('company_state') ?? pick('state');
  lead.state = normalizeState(rawState) ?? rawState;
  lead.city = normalizeCity(pick('company_city') ?? pick('city'));
  lead.contact_city = normalizeCity(pick('city'));
  lead.address = pick('address');
  lead.postal_code = (pick('postal_code') ?? '').replace(/\.0$/, '') || null;
  lead.employees = parseCount(pick('employees'));
  lead.revenue = pick('revenue');
  lead.contact_name = pick('contact_name');
  lead.first_name = pick('first_name');
  lead.last_name = pick('last_name');
  lead.job_title = pick('job_title');
  lead.email = normalizeEmail(pick('email'));
  lead.phone = pick('phone');
  lead.phone_e164 = normalizePhone(pick('phone'));
  lead.linkedin = normalizeUrl(pick('linkedin'));
  lead.company_linkedin = normalizeUrl(pick('company_linkedin'));
  lead.facebook = normalizeUrl(pick('facebook'));
  lead.twitter = normalizeUrl(pick('twitter'));
  lead.instagram = normalizeHandle(pick('instagram'));
  lead.google_maps_url = normalizeUrl(pick('google_maps_url'));
  const ratingRaw = pick('rating');   // Number(null) is 0, so check for absence first
  lead.rating = ratingRaw !== null && Number.isFinite(Number(ratingRaw)) ? Number(ratingRaw) : null;
  lead.review_count = parseCount(pick('review_count'));
  lead.company_description = pick('company_description');
  lead.technologies = toProductList(pick('technologies'));
  lead.keywords = toProductList(pick('keywords'));
  lead.seniority = pick('seniority');
  lead.department = pick('department');
  lead.founded_year = pick('founded_year');

  lead.source = sourceLabel ?? 'attached_file';
  lead.source_file = sourceFile;
  lead.original_row = row.__row ?? null;
  // Nothing from the original row is discarded.
  lead.original_record = Object.fromEntries(
    Object.entries(row).filter(([k, v]) => k !== '__row' && v !== null && String(v).trim() !== '')
  );
  return lead;
}

