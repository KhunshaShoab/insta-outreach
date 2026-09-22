// ---------------------------------------------------------------------------
// Search-term expansion: campaign targeting x niche search terms.
// "{city}" and "{state}" placeholders in config/niches.json are filled here, so
// adding a city to a campaign immediately widens discovery with no code change.
// ---------------------------------------------------------------------------
import { slug, US_STATES } from './normalize.js';

const STATE_NAMES = Object.fromEntries(Object.entries(US_STATES).map(([name, code]) => [code, titleCase(name)]));

function titleCase(value) {
  return String(value).replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * @returns [{ query, location, city, state, niche_id }]
 */
export function buildSearchTerms(campaign, niche) {
  const templates = campaign?.discovery?.search_terms_override ?? niche?.search_terms ?? [];
  const states = campaign?.targeting?.states ?? [];
  const cities = campaign?.targeting?.cities ?? [];
  const out = [];
  const seen = new Set();

  const push = (query, location, city, state) => {
    const key = `${query}|${location}`.toLowerCase();
    if (seen.has(key) || !query.trim()) return;
    seen.add(key);
    out.push({ query: query.trim(), location, city, state, niche_id: niche?.id ?? null });
  };

  for (const template of templates) {
    const needsCity = template.includes('{city}');
    const needsState = template.includes('{state}');

    if (needsCity && cities.length) {
      for (const city of cities) {
        const state = states[0] ?? '';
        push(fill(template, { city, state }), `${city}, ${state || 'US'}`, city, state);
      }
    } else if (needsState && states.length) {
      for (const state of states) {
        push(fill(template, { city: '', state: STATE_NAMES[state] ?? state }), STATE_NAMES[state] ?? state, null, state);
      }
    } else if (cities.length) {
      for (const city of cities) {
        push(fill(template, { city, state: states[0] ?? '' }), `${city}, ${states[0] ?? 'US'}`, city, states[0] ?? null);
      }
    } else {
      push(fill(template, { city: '', state: '' }), states.map((s) => STATE_NAMES[s] ?? s).join(', ') || 'United States', null, states[0] ?? null);
    }
  }
  return out;
}

function fill(template, { city, state }) {
  return template
    .replace(/\{city_slug\}/g, slug(city))
    .replace(/\{state_slug\}/g, slug(state))
    .replace(/\{city\}/g, city ?? '')
    .replace(/\{state\}/g, state ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Instagram hashtag list for a campaign (used by the instagram_search source). */
export function buildHashtags(campaign, niche) {
  const cities = campaign?.targeting?.cities ?? [];
  const out = new Set();
  for (const tag of niche?.instagram_hashtags ?? []) {
    if (tag.includes('{city_slug}')) {
      for (const city of cities) out.add(fill(tag, { city, state: '' }));
    } else {
      out.add(tag);
    }
  }
  return [...out];
}
