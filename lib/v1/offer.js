// ---------------------------------------------------------------------------
// Which OptiFlow service to lead with.
//
// BOTH requires independent evidence for each service, not one strong signal
// read two ways. NONE is a valid and frequently correct answer.
// ---------------------------------------------------------------------------
import { splitSignals } from './signals.js';

const MIN_FIT = 45;          // below this, a service is not worth leading with
const BOTH_MIN = 55;         // both services must clear this for BOTH
const BOTH_MIN_SIGNALS = 2;  // and each needs at least this many real signals

const strong = (signals) => signals.filter((s) => s.confidence === 'HIGH' || s.confidence === 'MEDIUM');

/**
 * @returns {{ recommended_offer, offer_reason }}
 */
export function recommendOffer(lead, { scores, signals = [] }) {
  const split = splitSignals(signals);
  const voiceStrong = strong(split.voice);
  const supportStrong = strong(split.support);
  const cs = scores.customer_support_score;
  const av = scores.ai_voice_score;

  const cite = (list, n = 2) => list.slice(0, n).map((s) => s.signal.toLowerCase()).join(' and ');

  if (cs >= BOTH_MIN && av >= BOTH_MIN &&
      supportStrong.length >= BOTH_MIN_SIGNALS && voiceStrong.length >= BOTH_MIN_SIGNALS) {
    return {
      recommended_offer: 'BOTH',
      offer_reason: `Independent evidence for each service: ${cite(supportStrong)} point to support volume (${cs}/100), while ${cite(voiceStrong)} point to phone and appointment workload (${av}/100).`
    };
  }

  if (cs >= MIN_FIT && cs > av) {
    return {
      recommended_offer: 'CUSTOMER_SUPPORT',
      offer_reason: supportStrong.length
        ? `${cite(supportStrong)} indicate customer-support volume (${cs}/100 vs ${av}/100 for AI voice).`
        : `Customer support scores higher (${cs}/100 vs ${av}/100), though the supporting evidence is low confidence.`
    };
  }

  if (av >= MIN_FIT && av >= cs) {
    return {
      recommended_offer: 'AI_VOICE',
      offer_reason: voiceStrong.length
        ? `${cite(voiceStrong)} indicate a phone and appointment led operation (${av}/100 vs ${cs}/100 for customer support).`
        : `AI voice scores higher (${av}/100 vs ${cs}/100), though the supporting evidence is low confidence.`
    };
  }

  const why = split.caveats.length
    ? split.caveats[0].evidence
    : `neither service clears the ${MIN_FIT}/100 evidence threshold (customer support ${cs}, AI voice ${av})`;
  return {
    recommended_offer: 'NONE',
    offer_reason: `No service recommended: ${why}. Nothing here justifies an approach yet.`
  };
}
