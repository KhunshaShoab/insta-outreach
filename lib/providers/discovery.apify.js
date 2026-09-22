// ---------------------------------------------------------------------------
// Discovery adapter: Apify.
// Runs a search-term x location matrix through an actor, waits for the dataset
// and returns RawLead rows. Swap this file out for any other scraper - the rest
// of the pipeline only knows the RawLead shape (see lib/normalize.js).
// ---------------------------------------------------------------------------
import { request } from './http.js';
import { buildSearchTerms } from '../search-terms.js';

const BASE = 'https://api.apify.com/v2';

export function create(env = {}, spec = {}) {
  const token = env.APIFY_TOKEN;
  const actors = {
    maps: env[spec?.actors?.maps ?? 'APIFY_GOOGLE_MAPS_ACTOR'] ?? 'compass~crawler-google-places',
    instagram_profile: env[spec?.actors?.instagram_profile ?? 'APIFY_INSTAGRAM_PROFILE_ACTOR'] ?? 'apify~instagram-profile-scraper',
    instagram_search: env[spec?.actors?.instagram_search ?? 'APIFY_INSTAGRAM_SEARCH_ACTOR'] ?? 'apify~instagram-search-scraper'
  };

  async function runActor(actorId, input, { onCall, timeoutMs = 300000 } = {}) {
    const { data } = await request({
      url: `${BASE}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${token}&timeout=${Math.floor(timeoutMs / 1000)}`,
      method: 'POST',
      body: input,
      timeoutMs,
      provider: 'apify',
      operation: actorId,
      onCall
    });
    return Array.isArray(data) ? data : [];
  }

  return {
    /**
     * @param {object} campaign  campaign config
     * @param {object} ctx       { niche, onCall, limit }
     * @returns {Promise<Array>} RawLead rows (pass each through normalizeRawLead)
     */
    async discover(campaign, ctx = {}) {
      const niche = ctx.niche ?? {};
      const terms = buildSearchTerms(campaign, niche);
      const perTerm = campaign?.discovery?.max_results_per_search_term ?? 50;
      const sources = campaign?.discovery?.sources ?? ['google_maps'];
      const out = [];

      for (const term of terms) {
        if (ctx.limit && out.length >= ctx.limit) break;

        if (sources.includes('google_maps')) {
          const rows = await runActor(actors.maps, {
            searchStringsArray: [term.query],
            locationQuery: term.location,
            maxCrawledPlacesPerSearch: perTerm,
            language: 'en',
            skipClosedPlaces: true,
            scrapeContacts: true
          }, ctx);
          for (const row of rows) {
            out.push({
              ...row,
              business_name: row.title,
              instagram_handle: pickInstagram(row),
              website: row.website,
              city: row.city,
              state: row.state,
              phone: row.phone,
              category: row.categoryName,
              place_id: row.placeId ?? row.fid,
              products_services: row.categories ?? [],
              source: 'google_maps',
              search_term: term.query
            });
          }
        }

        if (sources.includes('instagram_search')) {
          const rows = await runActor(actors.instagram_search, {
            search: term.query,
            searchType: 'user',
            searchLimit: perTerm
          }, ctx);
          for (const row of rows) {
            out.push({
              ...row,
              business_name: row.fullName ?? row.username,
              instagram_handle: row.username,
              source: 'instagram_search',
              search_term: term.query
            });
          }
        }
      }
      return ctx.limit ? out.slice(0, ctx.limit) : out;
    },

    /** Public profile facts for a handle: followers, posts, bio, category. */
    async fetchProfile(handle, ctx = {}) {
      const rows = await runActor(actors.instagram_profile, { usernames: [handle] }, ctx);
      const row = rows[0];
      if (!row) return null;
      return {
        instagram_handle: row.username,
        business_name: row.fullName,
        bio: row.biography,
        ig_followers: row.followersCount,
        ig_following: row.followsCount,
        ig_posts: row.postsCount,
        ig_is_business: row.isBusinessAccount,
        ig_is_private: row.private,
        ig_is_verified: row.verified,
        ig_external_url: row.externalUrl,
        category: row.businessCategoryName,
        ig_last_post_at: row.latestPosts?.[0]?.timestamp ?? null,
        raw: row
      };
    }
  };
}

function pickInstagram(row) {
  const direct = row.instagram ?? row.instagramUrl;
  if (direct) return direct;
  const profiles = row.socialProfiles ?? row.socialMedia ?? [];
  const found = (Array.isArray(profiles) ? profiles : Object.values(profiles))
    .map(String)
    .find((v) => /instagram\.com/i.test(v));
  return found ?? null;
}
