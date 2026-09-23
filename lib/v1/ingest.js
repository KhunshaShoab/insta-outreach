// ---------------------------------------------------------------------------
// Ingest: an attached XLSX or CSV -> V1 lead records.
//
// Column names are detected, not assumed, because every lead file arrives with
// different headers. Files also commonly carry TWO columns for the same thing
// (an empty `name` beside a populated `Business Name`), so each field collects
// every candidate column and takes the first non-empty value.
// ---------------------------------------------------------------------------
import { readXlsx, xlsxSheetNames } from './xlsx.js';
import { parseCsv } from '../providers/discovery.csv.js';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import {
  cleanBusinessName, normalizeBusinessName, normalizeHandle, normalizeUrl,
  normalizeDomain, normalizePhone, normalizeEmail, normalizeState, normalizeCity,
  parseCount, toProductList
} from '../normalize.js';
import { emptyLead } from './schema.js';

// Every alias is compared after lowercasing and collapsing punctuation, so
// "Business Name", "business_name" and "BUSINESS-NAME" all match.
export const COLUMN_ALIASES = {
  company_name: ['company', 'business', 'business name', 'company name', 'name', 'organisation', 'organization', 'practice', 'practice name', 'account name', 'title', 'dba'],
  website: ['website', 'url', 'web', 'site', 'web address', 'homepage', 'website url', 'company website', 'domain'],
  industry: ['industry', 'sector', 'vertical', 'niche'],
  category: ['category', 'type', 'business type', 'primary category', 'categories'],
  country: ['country', 'country code'],
  state: ['state', 'province', 'region', 'state province'],
  city: ['city', 'town', 'locality'],
  address: ['address', 'street', 'street address', 'full address', 'location', 'formatted address'],
  postal_code: ['zip', 'zipcode', 'zip code', 'postal', 'postal code', 'postcode'],
  employees: ['employees', 'employee count', 'headcount', 'company size', 'staff', 'num employees'],
  revenue: ['revenue', 'annual revenue', 'turnover'],
  contact_name: ['contact', 'contact name', 'full name', 'owner', 'owner name', 'decision maker'],
  first_name: ['first name', 'firstname', 'given name'],
  last_name: ['last name', 'lastname', 'surname', 'family name'],
  job_title: ['title', 'job title', 'position', 'role', 'designation'],
  email: ['email', 'e mail', 'email address', 'contact email', 'work email', 'primary email'],
  phone: ['phone', 'phone number', 'telephone', 'tel', 'mobile', 'contact number', 'primary phone'],
  linkedin: ['linkedin', 'linkedin url', 'linkedin profile', 'personal linkedin'],
  company_linkedin: ['company linkedin', 'linkedin company', 'company linkedin url'],
  facebook: ['facebook', 'facebook url', 'fb'],
  twitter: ['twitter', 'twitter url', 'x', 'x url'],
  instagram: ['instagram', 'instagram url', 'instagram handle', 'ig', 'ig handle'],
  google_maps_url: ['google maps', 'google maps url', 'maps url', 'gmb url', 'google url'],
  rating: ['rating', 'stars', 'average rating', 'google rating'],
  review_count: ['review count', 'reviews', 'number of reviews', 'total reviews', 'review total'],
  company_description: ['description', 'about', 'company description', 'summary', 'bio', 'notes', 'snippet'],
  technologies: ['technologies', 'tech', 'tech stack', 'technology']
};

const squash = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Map headers onto V1 fields. Several headers may feed one field, in the order
 * they appear - the first non-empty value wins at read time.
 */
export function detectColumns(headers) {
  const mapping = {};
  const matched = new Set();
  for (const header of headers) {
    const key = squash(header);
    if (!key) continue;
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.includes(key)) {
        (mapping[field] ??= []).push(header);
        matched.add(header);
        break;
      }
    }
  }
  return { mapping, unmapped: headers.filter((h) => h && !matched.has(h)) };
}

/** Read the file as { sheet, headers, rows }. CSV and XLSX both land here. */
export function readLeadFile(filePath, { sheet = null } = {}) {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.csv' || extension === '.tsv' || extension === '.txt') {
    const rows = parseCsv(readFileSync(filePath, 'utf8'));
    const headers = rows.length ? Object.keys(rows[0]) : [];
    return { sheet: null, sheetNames: [], headers, rows: rows.map((r, i) => ({ ...r, __row: i + 2 })) };
  }
  if (extension !== '.xlsx' && extension !== '.xlsm') {
    throw new Error(`Unsupported file type "${extension}". Attach a .xlsx or .csv file.`);
  }
  const names = xlsxSheetNames(filePath);
  // Lead files from scrapers usually carry admin sheets alongside the data.
  // Prefer a sheet that looks like the lead list.
  const preferred = sheet
    ?? names.find((n) => /^(leads?|data|sheet1|results)$/i.test(n))
    ?? names.find((n) => /lead/i.test(n))
    ?? names[0];
  const result = readXlsx(filePath, { sheet: preferred });
  return { ...result, sheetNames: names };
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
  lead.country = pick('country') ?? 'US';
  lead.state = normalizeState(pick('state')) ?? pick('state');
  lead.city = normalizeCity(pick('city'));
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

  lead.source = sourceLabel ?? 'attached_file';
  lead.source_file = sourceFile;
  lead.original_row = row.__row ?? null;
  // Nothing from the original row is discarded.
  lead.original_record = Object.fromEntries(
    Object.entries(row).filter(([k, v]) => k !== '__row' && v !== null && String(v).trim() !== '')
  );
  return lead;
}

/**
 * Ingest a file.
 * @returns {{ file, sheet, sheetNames, headers, mapping, unmapped, leads, skipped }}
 */
export function ingestFile(filePath, { sheet = null, sourceLabel = null, limit = null } = {}) {
  const { sheet: usedSheet, sheetNames, headers, rows } = readLeadFile(filePath, { sheet });
  const { mapping, unmapped } = detectColumns(headers);

  if (!mapping.company_name) {
    throw new Error(
      `No column in "${basename(filePath)}" looks like a company name. ` +
      `Headers found: ${headers.join(', ')}. Add an alias to COLUMN_ALIASES in lib/v1/ingest.js.`
    );
  }

  const leads = [];
  const skipped = [];
  for (const row of rows) {
    const lead = mapRow(row, mapping, { sourceFile: basename(filePath), sourceLabel });
    if (!lead.company_name) {
      skipped.push({ row: row.__row, reason: 'no company name' });
      continue;
    }
    leads.push(lead);
    if (limit && leads.length >= limit) break;
  }

  return { file: basename(filePath), sheet: usedSheet, sheetNames, headers, mapping, unmapped, leads, skipped };
}
