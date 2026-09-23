// ---------------------------------------------------------------------------
// Instagram discovery.
//
// Confidence is about PROVENANCE, not about how plausible a username looks:
//
//   HIGH      the company's own website links to the account
//   MEDIUM    the source spreadsheet supplied it, or the site linked several
//             accounts and one had to be chosen between them
//   LOW       a candidate derived from the company name - never asserted, only
//             offered for a human to check
//   NOT_FOUND nothing was found
//
// A username that merely resembles the company name is never promoted above LOW.
// ---------------------------------------------------------------------------
import { normalizeHandle, normalizeBusinessName, slug } from '../normalize.js';
import { nameSimilarity } from '../dedupe.js';

// Instagram paths that are not accounts.
const RESERVED = new Set([
  'p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'direct', 'tv', 'about',
  'developer', 'legal', 'privacy', 'terms', 'sharer', 'share', 'web', 'api', 'oauth',
  'help', 'press', 'blog', 'igtv', 'challenge', 'emails', 'invites'
]);

function candidateHandles(values = []) {
  const out = [];
  for (const value of values) {
    const handle = normalizeHandle(value);
    if (!handle || RESERVED.has(handle)) continue;
    if (handle.length < 3) continue;
    out.push(handle);
  }
  return [...new Set(out)];
}

/** How well a handle matches the business - used to choose between several. */
function affinity(handle, lead) {
  const name = normalizeBusinessName(lead.company_name) ?? '';
  const nameSlug = slug(name);
  const domainSlug = slug((lead.domain ?? '').split('.')[0]);
  const h = handle.replace(/[._]/g, '');
  let score = 0;
  if (domainSlug && (h === domainSlug || h.includes(domainSlug) || domainSlug.includes(h))) score += 3;
  if (nameSlug && (h === nameSlug || h.includes(nameSlug) || nameSlug.includes(h))) score += 2;
  score += nameSimilarity(handle.replace(/[._]/g, ' '), lead.company_name ?? '');
  return score;
}

/**
 * @param {object} lead
 * @param {object} evidence  from researchLead()
 * @returns {{ business_instagram, instagram_confidence, instagram_evidence,
 *             instagram_alternates, owner_name, owner_instagram,
 *             owner_instagram_confidence, owner_instagram_evidence }}
 */
export function discoverInstagram(lead, evidence = {}) {
  const fromSite = candidateHandles(evidence?.socials?.instagram ?? []);
  const fromFile = candidateHandles([lead.instagram].filter(Boolean));
  const sourceUrl = evidence?.pages_read?.[0]?.url ?? (lead.domain ? `https://${lead.domain}` : null);

  const result = {
    business_instagram: null,
    instagram_confidence: 'NOT_FOUND',
    instagram_evidence: null,
    instagram_alternates: [],
    owner_name: lead.contact_name ?? null,
    owner_instagram: null,
    owner_instagram_confidence: 'NOT_FOUND',
    owner_instagram_evidence: null
  };

  if (fromSite.length === 1) {
    result.business_instagram = fromSite[0];
    result.instagram_confidence = 'HIGH';
    result.instagram_evidence = `Linked from the company's own website (${sourceUrl}).`;
  } else if (fromSite.length > 1) {
    const ranked = [...fromSite].sort((a, b) => affinity(b, lead) - affinity(a, lead));
    const best = ranked[0];
    const clearWinner = affinity(best, lead) - affinity(ranked[1], lead) >= 1.5;
    result.business_instagram = best;
    result.instagram_confidence = clearWinner ? 'HIGH' : 'MEDIUM';
    result.instagram_evidence = clearWinner
      ? `Linked from the company's own website (${sourceUrl}); chosen over ${ranked.length - 1} other linked account(s) because it matches the company name and domain.`
      : `The website links ${ranked.length} Instagram accounts (${ranked.join(', ')}) and none clearly belongs to the business over the others. Needs a human to pick.`;
    result.instagram_alternates = ranked.slice(1);
  } else if (fromFile.length) {
    result.business_instagram = fromFile[0];
    result.instagram_confidence = 'MEDIUM';
    result.instagram_evidence = `Supplied in the source file ${lead.source_file} row ${lead.original_row}; not confirmed against the company's website.`;
    result.instagram_alternates = fromFile.slice(1);
  } else if (lead.domain) {
    // A guess, clearly labelled as one. It is not written to business_instagram.
    const guess = slug((lead.domain ?? '').split('.')[0]);
    if (guess.length >= 3) {
      result.instagram_confidence = 'LOW';
      result.instagram_evidence = `No Instagram link found on ${lead.domain} and none in the source file. "@${guess}" is a guess from the domain name and has NOT been verified - check it before using it.`;
      result.instagram_candidate = guess;
    }
  }

  if (result.instagram_confidence === 'NOT_FOUND' && !result.instagram_evidence) {
    result.instagram_evidence = lead.domain
      ? `No Instagram link found on the pages read from ${lead.domain}${evidence.website_reachable ? '' : ' (the site could not be read)'}, and none supplied in the source file.`
      : 'No website in the source file and no Instagram supplied, so there was nothing to search.';
  }

  // Owner account: only when a person is actually identified. Never inferred
  // from the business account, and never guessed from a name.
  if (result.owner_name) {
    const personal = candidateHandles(evidence?.socials?.instagram ?? [])
      .filter((h) => h !== result.business_instagram)
      .find((h) => nameSimilarity(h.replace(/[._]/g, ' '), result.owner_name) >= 0.6);
    if (personal) {
      result.owner_instagram = personal;
      result.owner_instagram_confidence = 'MEDIUM';
      result.owner_instagram_evidence = `Account "${personal}" is linked from the company website and resembles the contact name "${result.owner_name}". Not confirmed as that person.`;
    } else {
      result.owner_instagram_evidence = `Contact name "${result.owner_name}" is known, but no personal Instagram account was found in public sources.`;
    }
  } else {
    result.owner_instagram_evidence = 'No owner or contact name is available in the source file or on the website, so no personal account was searched for.';
  }

  return result;
}
