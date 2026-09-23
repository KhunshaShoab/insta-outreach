#!/usr/bin/env node
// Import a list you already have into the pipeline.
//
//   node scripts/import-leads.mjs medspas.csv ca-medspas            # inspect only
//   node scripts/import-leads.mjs medspas.csv ca-medspas --apply    # write to the database
//
// Column names are auto-detected, so your file does not have to match a
// template. The inspection pass tells you the one thing that decides whether
// this list is usable as-is: how many rows carry an Instagram handle.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRawLead } from '../lib/normalize.js';
import { dedupeBatch } from '../lib/dedupe.js';
import { cleanLead } from '../lib/clean.js';
import { parseCsv } from '../lib/providers/discovery.csv.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

// Header aliases seen in the wild. Matching is case- and punctuation-insensitive.
const ALIASES = {
  business_name: ['business name', 'name', 'company', 'company name', 'business', 'title', 'practice', 'practice name', 'medspa', 'clinic name'],
  instagram_handle: ['instagram', 'instagram handle', 'instagram url', 'ig', 'ig handle', 'handle', 'username', 'social', 'instagram link'],
  website: ['website', 'url', 'web', 'site', 'domain', 'web address', 'homepage'],
  email: ['email', 'e mail', 'email address', 'contact email'],
  phone: ['phone', 'phone number', 'telephone', 'tel', 'contact number', 'mobile'],
  city: ['city', 'town', 'locality'],
  state: ['state', 'province', 'region', 'st'],
  address: ['address', 'street', 'street address', 'full address', 'location'],
  postal_code: ['zip', 'zipcode', 'zip code', 'postal', 'postal code'],
  category: ['category', 'type', 'business type', 'industry', 'niche'],
  bio: ['bio', 'description', 'about', 'summary'],
  ig_followers: ['followers', 'follower count', 'ig followers', 'instagram followers'],
  ig_posts: ['posts', 'post count', 'ig posts'],
  products_services: ['products', 'services', 'treatments', 'menu', 'offerings']
};

const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function detectColumns(headers) {
  const map = {};
  const unmatched = [];
  for (const header of headers) {
    const key = squash(header);
    const field = Object.entries(ALIASES).find(([, names]) => names.includes(key))?.[0];
    if (field && !map[field]) map[field] = header;
    else unmatched.push(header);
  }
  return { map, unmatched };
}

async function main() {
  const [, , file, campaignId, ...rest] = process.argv;
  const apply = rest.includes('--apply');

  if (!file) {
    console.error('Usage: node scripts/import-leads.mjs <file.csv> <campaign-id> [--apply]');
    process.exit(1);
  }

  const campaigns = read('config/campaigns/california-medspas.json');
  const campaign = campaignId
    ? [read('config/campaigns/california-medspas.json'), read('config/campaigns/texas-dental.json'), read('config/campaigns/florida-pet-brands.json')].find((c) => c.id === campaignId)
    : campaigns;
  if (!campaign) {
    console.error(`No campaign "${campaignId}" found in config/campaigns/.`);
    process.exit(1);
  }
  const niche = read('config/niches.json').niches.find((n) => n.id === campaign.niche_id);
  const cleaning = read('config/cleaning.json');

  const raw = parseCsv(readFileSync(file, 'utf8'));
  if (!raw.length) {
    console.error('No rows found. Is it a CSV with a header row?');
    process.exit(1);
  }

  const { map, unmatched } = detectColumns(Object.keys(raw[0]));

  console.log(`\nImporting ${file} into campaign "${campaign.id}" (${niche.name})`);
  console.log('='.repeat(70));
  console.log('\nColumns detected');
  for (const [field, header] of Object.entries(map)) {
    console.log(`  ${field.padEnd(20)} <- "${header}"`);
  }
  if (unmatched.length) console.log(`  ignored: ${unmatched.join(', ')}`);
  for (const required of ['business_name']) {
    if (!map[required]) {
      console.error(`\nNo column matched "${required}". Rename a column or add it to ALIASES in this script.`);
      process.exit(1);
    }
  }

  // Map to the canonical shape.
  const normalised = raw.map((row) => normalizeRawLead({
    business_name: row[map.business_name],
    instagram_handle: map.instagram_handle ? row[map.instagram_handle] : null,
    website: map.website ? row[map.website] : null,
    email: map.email ? row[map.email] : null,
    phone: map.phone ? row[map.phone] : null,
    city: map.city ? row[map.city] : null,
    state: map.state ? row[map.state] : null,
    address: map.address ? row[map.address] : null,
    postal_code: map.postal_code ? row[map.postal_code] : null,
    category: map.category ? row[map.category] : null,
    bio: map.bio ? row[map.bio] : null,
    ig_followers: map.ig_followers ? row[map.ig_followers] : null,
    ig_posts: map.ig_posts ? row[map.ig_posts] : null,
    products_services: map.products_services ? row[map.products_services] : null,
    source: 'imported_list',
    search_term: file.split('/').pop()
  }));

  const { unique, duplicates } = dedupeBatch(normalised);

  const withHandle = unique.filter((l) => l.instagram_handle).length;
  const withFollowers = unique.filter((l) => l.ig_followers != null).length;
  const withSite = unique.filter((l) => l.website_domain).length;
  const byState = {};
  for (const l of unique) byState[l.state ?? 'unknown'] = (byState[l.state ?? 'unknown'] ?? 0) + 1;

  console.log('\nWhat is in the list');
  console.log(`  ${raw.length} rows, ${unique.length} distinct businesses, ${duplicates.length} duplicate(s) merged`);
  console.log(`  ${withHandle} have an Instagram handle   (${Math.round(withHandle / unique.length * 100)}%)`);
  console.log(`  ${withFollowers} have a follower count     (${Math.round(withFollowers / unique.length * 100)}%)`);
  console.log(`  ${withSite} have a website            (${Math.round(withSite / unique.length * 100)}%)`);
  console.log(`  states: ${Object.entries(byState).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, n]) => `${s} ${n}`).join(', ')}`);

  // The decisive check: without a handle there is nobody to message, and
  // without a follower count the ICP band cannot be applied.
  if (withHandle < unique.length * 0.5) {
    console.log('\n  >> Most rows have no Instagram handle. This list cannot be messaged as-is.');
    console.log('     You need an Instagram lookup step to find the handle for each business');
    console.log('     before outreach. See docs/05-integrations.md, capability "instagram_profile".');
  }
  if (withFollowers < unique.length * 0.5) {
    console.log('\n  >> Most rows have no follower count, which is the ICP gate (1k-10k).');
    console.log('     Until it is filled in, follower_fit scores as "unknown" (40/100) and');
    console.log('     businesses outside your band will reach the queue. Run the Instagram');
    console.log('     profile lookup first, or widen the band deliberately.');
  }

  // How many would survive this campaign's rules today.
  const decisions = unique.map((lead) => cleanLead(lead, { campaign, niche, rules: cleaning }));
  const keep = decisions.filter((d) => d.keep).length;
  const reasons = {};
  for (const d of decisions.filter((x) => !x.keep)) {
    for (const r of d.reasons) reasons[r] = (reasons[r] ?? 0) + 1;
  }

  console.log(`\nAgainst campaign "${campaign.id}" rules right now`);
  console.log(`  ${keep} would pass cleaning, ${unique.length - keep} would be dropped`);
  for (const [reason, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)}  ${reason}`);
  }
  if (reasons.outside_target_location) {
    console.log(`\n  Note: this campaign targets ${campaign.targeting.states.join(', ')} only.`);
    console.log('  A 50-state list needs one campaign per state or region - see below.');
  }

  if (!apply) {
    console.log('\nNothing was written. Re-run with --apply to import.\n');
    return;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('\n--apply needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.');
    process.exit(1);
  }

  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const rpc = async (fn, args) => {
    const response = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers, body: JSON.stringify(args)
    });
    if (!response.ok) throw new Error(`${fn}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    return response.json();
  };

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const lead of unique) {
    try {
      // Same deduplication path discovery uses, so importing twice is safe and
      // a business already in the database is reused rather than duplicated.
      const company = await rpc('resolve_company', {
        p_name: lead.business_name,
        p_name_normalized: lead.name_normalized,
        p_instagram_handle: lead.instagram_handle,
        p_website_domain: lead.website_domain,
        p_phone_e164: lead.phone_e164,
        p_email: lead.email,
        p_city: lead.city,
        p_state: lead.state,
        p_place_id: null,
        p_attrs: lead
      });
      const companyRow = Array.isArray(company) ? company[0] : company;

      const suppressed = await rpc('is_suppressed', { p_company_id: companyRow.id });
      if (suppressed === true) { skipped += 1; continue; }

      await rpc('upsert_lead', {
        p_campaign_id: campaign.id,
        p_company_id: companyRow.id,
        p_source: 'imported_list',
        p_search_term: file.split('/').pop()
      });
      imported += 1;
      if (imported % 100 === 0) console.log(`  ${imported} imported...`);
    } catch (error) {
      failed += 1;
      if (failed <= 5) console.error(`  failed: ${lead.business_name} - ${error.message}`);
    }
  }

  console.log(`\nImported ${imported}, skipped ${skipped} (suppressed), failed ${failed}.`);
  console.log('They are at stage SCRAPED. Workflow 02 picks them up from there.\n');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  await main();
}
