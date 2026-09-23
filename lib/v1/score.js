// ---------------------------------------------------------------------------
// V1 scoring: customer_support_score, ai_voice_score, overall_score.
//
// Every point comes from a named piece of evidence and is recorded in
// score_reasons. Nothing scores because a company "looks good".
//
// A lead whose website could not be read is capped, because a high score built
// on four spreadsheet columns would be a false positive dressed as a finding.
// ---------------------------------------------------------------------------
import { classify, DEFAULT_BANDS } from './schema.js';
import { splitSignals } from './signals.js';

/** Points per signal. Confidence scales the award. */
const SUPPORT_POINTS = {
  'Sells online': 30,
  'Sizeable product catalogue': 15,
  'Published returns or refunds policy': 12,
  'Multiple customer contact channels': 14,
  'Live chat already in place': 14,
  'Help centre or customer service page': 10,
  'Customer-facing hiring': 20,
  'Actively hiring': 6,
  'High public review volume': 10
};

const VOICE_POINTS = {
  'Appointment booking in use': 26,
  'Call-to-action asks customers to phone': 22,
  'Phone is a prominent contact channel': 20,
  'After-hours availability advertised': 14,
  'Appointment-led customer journey': 14,
  'Appointment-based business category': 8,
  'Phone-heavy business category': 8,
  'Phone number published': 6,
  'High public review volume': 10
};

const CONFIDENCE_WEIGHT = { HIGH: 1, MEDIUM: 0.7, LOW: 0.4 };
const NO_WEBSITE_CAP = 45;      // nothing unverified reaches GOOD
const UNREADABLE_SITE_CAP = 55; // may reach REVIEW, never GOOD

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));

function scoreFrom(signals, table) {
  let total = 0;
  const reasons = [];
  for (const s of signals) {
    const points = table[s.signal];
    if (!points) continue;
    const award = points * (CONFIDENCE_WEIGHT[s.confidence] ?? 0.4);
    total += award;
    reasons.push(`${s.signal} (+${Math.round(award)}, ${s.confidence.toLowerCase()} confidence)`);
  }
  return { total, reasons };
}

/**
 * How reachable and how real the business looks. This is deliberately separate
 * from service fit: a perfect AI-voice prospect nobody can contact is not a
 * usable lead.
 */
function reachability(lead, instagram) {
  let score = 0;
  const reasons = [];
  if (lead.domain) { score += 25; reasons.push('website on file (+25)'); }
  if (lead.phone_e164) { score += 20; reasons.push('valid phone number (+20)'); }
  if (instagram?.instagram_confidence === 'HIGH') { score += 40; reasons.push('Instagram confirmed on the company website (+40)'); }
  else if (instagram?.instagram_confidence === 'MEDIUM') { score += 25; reasons.push('Instagram found but unconfirmed (+25)'); }
  else if (instagram?.instagram_confidence === 'LOW') { score += 5; reasons.push('Instagram is only a guess (+5)'); }
  else reasons.push('no Instagram account found (+0) - this lead cannot be reached on Instagram');
  if (lead.email) { score += 10; reasons.push('email on file (+10)'); }
  if (lead.contact_name) { score += 5; reasons.push('named contact on file (+5)'); }
  return { score: clamp(score), reasons };
}

function legitimacy(lead, evidence) {
  let score = 40;
  const reasons = [];
  if (lead.review_count != null) {
    if (lead.review_count >= 200) { score += 30; reasons.push(`${lead.review_count} reviews (+30)`); }
    else if (lead.review_count >= 50) { score += 20; reasons.push(`${lead.review_count} reviews (+20)`); }
    else if (lead.review_count >= 10) { score += 10; reasons.push(`${lead.review_count} reviews (+10)`); }
    else { score -= 10; reasons.push(`only ${lead.review_count} reviews (-10)`); }
  }
  if (lead.rating != null && lead.rating >= 4.0) { score += 15; reasons.push(`${lead.rating} star rating (+15)`); }
  else if (lead.rating != null && lead.rating < 3.0) { score -= 10; reasons.push(`${lead.rating} star rating (-10)`); }
  if (evidence?.website_reachable) { score += 15; reasons.push('website serves a readable page (+15)'); }
  return { score: clamp(score), reasons };
}

/**
 * @returns {{ overall_score, customer_support_score, ai_voice_score,
 *             classification, score_reasons, caps_applied }}
 */
export function scoreLead(lead, { evidence = {}, signals = [], instagram = null, bands = DEFAULT_BANDS } = {}) {
  const split = splitSignals(signals);
  const volume = signals.filter((s) => s.signal === 'High public review volume');

  const support = scoreFrom([...split.support, ...volume], SUPPORT_POINTS);
  const voice = scoreFrom([...split.voice, ...volume], VOICE_POINTS);
  const reach = reachability(lead, instagram);
  const legit = legitimacy(lead, evidence);

  let customerSupport = clamp(support.total);
  let aiVoice = clamp(voice.total);

  const caps = [];
  if (!lead.domain) {
    if (customerSupport > NO_WEBSITE_CAP) { customerSupport = NO_WEBSITE_CAP; caps.push(`customer support capped at ${NO_WEBSITE_CAP}: no website to verify anything against`); }
    if (aiVoice > NO_WEBSITE_CAP) { aiVoice = NO_WEBSITE_CAP; caps.push(`AI voice capped at ${NO_WEBSITE_CAP}: no website to verify anything against`); }
  } else if (!evidence.website_reachable) {
    if (customerSupport > UNREADABLE_SITE_CAP) { customerSupport = UNREADABLE_SITE_CAP; caps.push(`customer support capped at ${UNREADABLE_SITE_CAP}: the website could not be read`); }
    if (aiVoice > UNREADABLE_SITE_CAP) { aiVoice = UNREADABLE_SITE_CAP; caps.push(`AI voice capped at ${UNREADABLE_SITE_CAP}: the website could not be read`); }
  }

  // The stronger service drives the overall score; reachability and legitimacy
  // decide whether it is worth acting on.
  const best = Math.max(customerSupport, aiVoice);
  const overall = clamp(0.60 * best + 0.22 * reach.score + 0.18 * legit.score);

  const reasons = [
    `Best service fit: ${customerSupport >= aiVoice ? 'customer support' : 'AI voice'} at ${best}/100 (60% of overall).`,
    ...(support.reasons.length ? [`Customer support ${customerSupport}/100 from: ${support.reasons.join('; ')}.`] : ['Customer support 0/100: no e-commerce, multi-channel or support-hiring evidence found.']),
    ...(voice.reasons.length ? [`AI voice ${aiVoice}/100 from: ${voice.reasons.join('; ')}.`] : ['AI voice 0/100: no phone, booking or appointment evidence found.']),
    `Reachability ${reach.score}/100 (22% of overall): ${reach.reasons.join('; ')}.`,
    `Legitimacy ${legit.score}/100 (18% of overall): ${legit.reasons.join('; ') || 'no rating or review data'}.`,
    ...caps
  ];

  return {
    overall_score: overall,
    customer_support_score: customerSupport,
    ai_voice_score: aiVoice,
    classification: classify(overall, bands),
    score_reasons: reasons,
    caps_applied: caps
  };
}
