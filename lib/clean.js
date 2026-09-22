// ---------------------------------------------------------------------------
// Cleaning stage: decide whether a normalised lead belongs in the campaign at
// all, and why. Every rejection carries a machine-readable reason so nothing
// disappears silently - the reason lands on leads.disqualified_reason and in
// the activity log.
// ---------------------------------------------------------------------------
import { normalizeBusinessName, isAggregatorDomain, daysSince } from './normalize.js';

const PERSON_NAME_RE = /^[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+$/;

// Words that make a two-word name a business name rather than a person's name.
// "Glow Medspa" and "Radiance Aesthetics" must not read as people.
const BUSINESS_NAME_WORDS = /\b(spa|medspa|salon|clinic|dental|dentistry|studio|shop|store|boutique|brand|co|company|collective|labs?|works|supply|goods|apparel|wear|beauty|aesthetics?|skin|smile|care|health|wellness|fitness|gym|pet|pets|home|robotics|tech|bags?|jewel\w*|watch\w*|eyewear|auto|motors|outfitters)\b/i;

function textOf(lead, field) {
  const value = lead?.[field];
  if (Array.isArray(value)) return value.join(' ');
  return value == null ? '' : String(value);
}

function haystack(lead, fields) {
  return fields.map((f) => textOf(lead, f)).join(' \n ').toLowerCase();
}

function matchesAny(text, terms) {
  const hits = [];
  for (const term of terms ?? []) {
    const t = String(term).toLowerCase().trim();
    if (!t) continue;
    const re = new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    if (re.test(text)) hits.push(t);
  }
  return hits;
}

/** Personal-account score. Returns { score, signals[] }. */
export function personalAccountScore(lead, rules) {
  const cfg = rules?.personal_account_signals;
  if (!cfg) return { score: 0, signals: [] };
  const signals = [];
  let score = 0;

  for (const signal of cfg.signals ?? []) {
    let hit = false;
    if (signal.pattern) {
      const text = textOf(lead, signal.field ?? 'bio').toLowerCase();
      hit = new RegExp(signal.pattern, 'i').test(text);
    } else {
      switch (signal.check) {
        case 'no_website_no_category_no_products':
          hit = !lead.website_domain && !lead.category && (lead.products_services ?? []).length === 0;
          break;
        case 'ig_is_business_false':
          hit = lead.ig_is_business === false;
          break;
        case 'name_is_person_name': {
          const name = String(lead.business_name ?? '').trim();
          // A business word anywhere in the name settles it - so does a match
          // against the niche's own keywords, checked by the caller via flags.
          hit = PERSON_NAME_RE.test(name) && !BUSINESS_NAME_WORDS.test(name);
          break;
        }
        case 'ig_is_private':
          hit = lead.ig_is_private === true;
          break;
        case 'aggregator_link_only':
          hit = !lead.website_domain && isAggregatorDomain(lead.ig_external_url);
          break;
        default:
          hit = false;
      }
    }
    if (hit) {
      score += signal.weight ?? 1;
      signals.push(signal.id);
    }
  }
  return { score, signals };
}

/** Does the lead look like it belongs to this niche? */
export function nicheMatch(lead, niche, rules) {
  const cfg = rules?.niche_match ?? { min_keyword_hits: 1, fields: ['business_name', 'bio', 'category'] };
  const text = haystack(lead, cfg.fields ?? []);
  const negatives = matchesAny(text, niche?.negative_keywords ?? []);
  const positives = matchesAny(text, niche?.keywords ?? []);
  const categoryHit = Boolean(
    lead.category && (niche?.keywords ?? []).some((k) => String(lead.category).toLowerCase().includes(String(k).toLowerCase()))
  );
  const hits = categoryHit && !positives.length ? [String(lead.category).toLowerCase()] : positives;
  return {
    matched: hits.length >= (cfg.min_keyword_hits ?? 1) && !(cfg.negative_keyword_drops && negatives.length),
    hits,
    negatives
  };
}

/** Is the lead inside the campaign's geography? */
export function locationMatch(lead, campaign, rules) {
  const targeting = campaign?.targeting ?? {};
  const states = (targeting.states ?? []).map((s) => String(s).toUpperCase());
  const cities = (targeting.cities ?? []).map((c) => String(c).toLowerCase());
  const excluded = (targeting.exclude_cities ?? []).map((c) => String(c).toLowerCase());
  const cfg = rules?.location ?? {};

  const leadState = lead.state ? String(lead.state).toUpperCase() : null;
  const leadCity = lead.city ? String(lead.city).toLowerCase() : null;

  if (leadCity && excluded.includes(leadCity)) return { matched: false, reason: 'city_excluded' };

  if (!leadState) {
    if (leadCity && cities.includes(leadCity) && cfg.allow_unknown_state_if_city_matches !== false) {
      return { matched: true, reason: 'city_match_state_unknown' };
    }
    if (cfg.allow_unknown_location_for_ecommerce && campaign?._niche?.business_model === 'ecommerce_brand') {
      return { matched: true, reason: 'unknown_location_allowed_for_ecommerce' };
    }
    return { matched: false, reason: 'location_unknown' };
  }

  if (states.length && !states.includes(leadState)) return { matched: false, reason: 'state_outside_target' };
  if (cities.length && leadCity && !cities.includes(leadCity)) {
    // Inside the right state but a city we did not ask for: keep it, flag it.
    return { matched: true, reason: 'state_match_city_outside_list', soft: true };
  }
  return { matched: true, reason: 'state_match' };
}

/**
 * Main entry point. Returns a decision object; the caller writes it to the DB.
 *   { keep, reasons[], flags{}, lead }
 */
export function cleanLead(lead, { campaign = {}, niche = null, rules = {}, now = new Date() } = {}) {
  const reasons = [];
  const flags = {};
  const bounds = rules.absolute_bounds ?? {};

  const name = lead.business_name;
  if (!name) reasons.push('missing_business_name');
  if (name && bounds.max_name_length && name.length > bounds.max_name_length) reasons.push('name_too_long');

  const requiresIg = campaign?.icp?.require_instagram !== false;
  if (requiresIg && !lead.instagram_handle) reasons.push('missing_instagram');

  // Absolute follower/activity sanity bounds (campaign ICP bounds are scored later).
  const followers = lead.ig_followers;
  if (followers != null) {
    if (bounds.min_followers != null && followers < bounds.min_followers) reasons.push('below_absolute_min_followers');
    if (bounds.max_followers != null && followers > bounds.max_followers) reasons.push('above_absolute_max_followers');
  }
  if (bounds.min_posts != null && lead.ig_posts != null && lead.ig_posts < bounds.min_posts) {
    reasons.push('too_few_posts');
  }
  if (
    bounds.max_following_to_followers_ratio &&
    lead.ig_following && followers && followers > 0 &&
    lead.ig_following / followers > bounds.max_following_to_followers_ratio
  ) {
    flags.follow_ratio_suspicious = true;
  }

  // Competitors, agencies, info-products.
  const blockText = haystack(lead, ['business_name', 'bio', 'category', 'website_description']);
  const blocked = matchesAny(blockText, rules.blocked_keywords?.terms ?? []);
  if (blocked.length) {
    reasons.push('blocked_business_type');
    flags.blocked_terms = blocked;
  }

  const fanHits = (rules.fan_account_markers?.patterns ?? []).filter((p) => new RegExp(p, 'i').test(blockText));
  if (fanHits.length) reasons.push('fan_or_parody_account');

  const resellerHits = (rules.reseller_markers?.patterns ?? []).filter((p) => new RegExp(p, 'i').test(blockText));
  if (resellerHits.length) flags.suspected_reseller = true;

  // Personal accounts.
  const personal = personalAccountScore(lead, rules);
  flags.personal_score = personal.score;
  flags.personal_signals = personal.signals;
  if (personal.score >= (rules.personal_account_signals?.threshold ?? 3)) reasons.push('personal_account');

  // Niche.
  if (niche) {
    const match = nicheMatch(lead, niche, rules);
    flags.niche_hits = match.hits;
    flags.niche_negatives = match.negatives;
    if (!match.matched) reasons.push(match.negatives.length ? 'niche_negative_keyword' : 'outside_target_niche');
  }

  // Location.
  const loc = locationMatch(lead, { ...campaign, _niche: niche }, rules);
  flags.location_reason = loc.reason;
  if (!loc.matched) reasons.push('outside_target_location');
  if (loc.soft) flags.city_outside_list = true;

  // Freshness (soft signal only - scoring decides how much it costs).
  const age = daysSince(lead.ig_last_post_at, now);
  if (age != null) flags.days_since_last_post = age;

  return {
    keep: reasons.length === 0,
    reasons,
    flags,
    lead: { ...lead, name_normalized: lead.name_normalized ?? normalizeBusinessName(lead.business_name) }
  };
}
