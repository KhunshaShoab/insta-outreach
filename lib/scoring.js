// ---------------------------------------------------------------------------
// ICP scoring.
// The final 0-100 score is computed HERE, not by the model. The AI contributes
// judgement sub-scores (business quality, CX need, outreach potential and its
// read on niche/website fit); everything measurable is computed from the data.
// Same inputs always produce the same score, and every point is traceable to a
// named component - no meaningless numbers.
// ---------------------------------------------------------------------------

/** Linear interpolation clamped to [0, 100]. */
function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function lerp(value, fromLow, fromHigh, toLow, toHigh) {
  if (fromHigh === fromLow) return toHigh;
  const t = (value - fromLow) / (fromHigh - fromLow);
  return toLow + t * (toHigh - toLow);
}

export function scoreLocation(lead, campaign) {
  const states = (campaign?.targeting?.states ?? []).map((s) => s.toUpperCase());
  const cities = (campaign?.targeting?.cities ?? []).map((c) => c.toLowerCase());
  const state = lead.state ? String(lead.state).toUpperCase() : null;
  const city = lead.city ? String(lead.city).toLowerCase() : null;
  if (!state && !city) return { score: 30, note: 'location unknown' };
  if (states.length && state && !states.includes(state)) return { score: 0, note: `state ${state} outside target` };
  if (cities.length && city && cities.includes(city)) return { score: 100, note: `target city ${lead.city}` };
  if (states.length && state && states.includes(state)) {
    return { score: cities.length ? 80 : 100, note: cities.length ? `in ${state}, outside the named city list` : `in ${state}` };
  }
  return { score: 60, note: 'partial location match' };
}

export function scoreFollowers(lead, campaign, profile) {
  const curve = profile?.follower_curve ?? {};
  const idealMin = campaign?.icp?.min_followers ?? curve.ideal_min ?? 1000;
  const idealMax = campaign?.icp?.max_followers ?? curve.ideal_max ?? 10000;
  const softMin = curve.soft_min ?? Math.max(0, idealMin / 2);
  const softMax = curve.soft_max ?? idealMax * 2.5;
  const f = lead.ig_followers;

  if (f == null) return { score: 40, note: 'follower count unknown' };
  if (f >= idealMin && f <= idealMax) return { score: 100, note: `${f} followers, inside ${idealMin}-${idealMax}` };
  if (f < idealMin) {
    if (f < softMin) return { score: curve.below_soft_min_score ?? 0, note: `${f} followers, below the floor` };
    return { score: clamp(lerp(f, softMin, idealMin, 30, 95)), note: `${f} followers, just under target` };
  }
  if (f > softMax) return { score: curve.above_soft_max_score ?? 20, note: `${f} followers, well above target` };
  return { score: clamp(lerp(f, idealMax, softMax, 95, 35)), note: `${f} followers, above target` };
}

export function scoreProducts(lead, campaign, profile) {
  const curve = profile?.products_curve ?? {};
  const minRequired = campaign?.icp?.min_products_services ?? curve.min_required ?? 2;
  const full = curve.full_credit_at ?? 6;
  const count = lead.products_count ?? (lead.products_services ?? []).length ?? null;

  if (!count) return { score: curve.unknown_score ?? 50, note: 'product/service count unknown' };
  if (count < minRequired) return { score: curve.below_min_score ?? 25, note: `${count} products/services, below the ${minRequired} minimum` };
  if (count >= full) return { score: 100, note: `${count} products/services` };
  return { score: clamp(lerp(count, minRequired, full, 70, 100)), note: `${count} products/services` };
}

export function scoreActivity(lead, profile) {
  const curve = profile?.activity_curve ?? {};
  const days = lead.days_since_last_post ?? null;
  if (days == null) return { score: curve.unknown_score ?? 50, note: 'last post date unknown' };
  const fresh = curve.fresh_days ?? 14;
  const ok = curve.acceptable_days ?? 45;
  const stale = curve.stale_days ?? 120;
  if (days <= fresh) return { score: 100, note: `posted ${days} days ago` };
  if (days <= ok) return { score: clamp(lerp(days, fresh, ok, 100, 70)), note: `posted ${days} days ago` };
  if (days <= stale) return { score: clamp(lerp(days, ok, stale, 70, 20)), note: `quiet for ${days} days` };
  return { score: 10, note: `inactive for ${days} days` };
}

export function scoreDecisionMaker(contact, profile) {
  const table = profile?.decision_maker_scores ?? {};
  if (!contact || !contact.full_name) {
    if (contact?.role_category && contact.role_category !== 'unknown') {
      return { score: table.role_only ?? 45, note: `role known (${contact.role_category}), no name` };
    }
    return { score: table.none ?? 20, note: 'no decision maker identified' };
  }
  const hasRole = Boolean(contact.title || (contact.role_category && contact.role_category !== 'unknown'));
  const hasContact = Boolean(contact.email || contact.linkedin_url || contact.phone || contact.instagram_handle);
  if (hasRole && hasContact) return { score: table.named_with_role_and_contact ?? 100, note: `${contact.full_name}, ${contact.title ?? contact.role_category}, reachable` };
  if (hasRole) return { score: table.named_with_role ?? 85, note: `${contact.full_name}, ${contact.title ?? contact.role_category}` };
  return { score: table.named_only ?? 65, note: `${contact.full_name}, role unclear` };
}

export function scoreWebsite(lead) {
  if (!lead.website_domain) return { score: 30, note: 'no website found' };
  let score = 70;
  const notes = ['website present'];
  if ((lead.products_services ?? []).length >= 2) { score += 15; notes.push('product/service list readable'); }
  if (lead.website_description) { score += 10; notes.push('description available'); }
  if (lead.email) { score += 5; notes.push('contact email published'); }
  return { score: clamp(score), note: notes.join(', ') };
}

/** Blend a deterministic value with the AI's read of the same dimension. */
function blend(spec, deterministic, ai) {
  if (spec === 'deterministic' || ai == null) return deterministic ?? 50;
  if (spec === 'ai') return ai ?? deterministic ?? 50;
  const match = /^blend:([\d.]+)\/([\d.]+)$/.exec(spec ?? '');
  if (!match) return deterministic ?? ai ?? 50;
  const [, dw, aw] = match;
  return Number(dw) * (deterministic ?? ai ?? 50) + Number(aw) * (ai ?? deterministic ?? 50);
}

export function bandFor(score, profile) {
  const bands = [...(profile?.bands ?? [])].sort((a, b) => b.min_score - a.min_score);
  for (const band of bands) if (score >= band.min_score) return band.label;
  return 'NOT_QUALIFIED';
}

/** Hard gates. A failure forces NOT_QUALIFIED whatever the score says. */
export function checkHardGates(lead, contact, campaign, profile) {
  const gates = { ...(profile?.hard_gates ?? {}), ...(campaign?.qualification?.hard_gate_overrides ?? {}) };
  const failures = [];
  if (gates.require_instagram && !lead.instagram_handle) failures.push('no_instagram');
  if (gates.require_website && !lead.website_domain) failures.push('no_website');
  if (gates.require_business_account && lead.ig_is_business === false) failures.push('not_a_business_account');
  if (gates.require_decision_maker && !contact?.full_name) failures.push('no_decision_maker');
  if (gates.require_in_target_state) {
    const states = (campaign?.targeting?.states ?? []).map((s) => s.toUpperCase());
    if (states.length && lead.state && !states.includes(String(lead.state).toUpperCase())) failures.push('outside_target_state');
  }
  if (gates.min_followers_absolute != null && lead.ig_followers != null && lead.ig_followers < gates.min_followers_absolute) {
    failures.push('below_absolute_min_followers');
  }
  if (gates.max_followers_absolute != null && lead.ig_followers != null && lead.ig_followers > gates.max_followers_absolute) {
    failures.push('above_absolute_max_followers');
  }
  if (gates.block_personal_accounts && lead.flags?.personal_account) failures.push('personal_account');
  if (gates.block_agencies_and_competitors && lead.flags?.blocked_terms?.length) failures.push('blocked_business_type');
  if (gates.block_previously_contacted && lead.previously_contacted) failures.push('previously_contacted');
  return failures;
}

/**
 * Compute the ICP score.
 *
 * @param {object} input
 *   lead      normalised + enriched lead
 *   contact   chosen decision maker (may be null)
 *   campaign  campaign config
 *   profile   scoring profile (config/scoring.default.json)
 *   ai        the model's sub-scores, 0-100:
 *             { niche_fit, business_quality, website_quality, cx_need, outreach_potential }
 * @returns {{ icp_score, band, priority, qualified, components, hard_gate_failures, penalties }}
 */
export function computeIcpScore({ lead = {}, contact = null, campaign = {}, profile = {}, ai = {} } = {}) {
  const weights = { ...(profile.weights ?? {}), ...(campaign?.qualification?.weight_overrides ?? {}) };
  const sources = profile.sources ?? {};

  const deterministic = {
    location_fit: scoreLocation(lead, campaign),
    follower_fit: scoreFollowers(lead, campaign, profile),
    products_fit: scoreProducts(lead, campaign, profile),
    instagram_activity: scoreActivity(lead, profile),
    website_quality: scoreWebsite(lead),
    decision_maker: scoreDecisionMaker(contact, profile),
    niche_fit: { score: lead.flags?.niche_hits?.length ? 100 : 50, note: lead.flags?.niche_hits?.length ? `keyword hits: ${lead.flags.niche_hits.join(', ')}` : 'no direct keyword hit' }
  };

  const components = {};
  let weighted = 0;
  let totalWeight = 0;

  for (const [name, weight] of Object.entries(weights)) {
    if (!weight) continue;
    const det = deterministic[name]?.score ?? null;
    const aiScore = typeof ai?.[name] === 'number' ? clamp(ai[name]) : null;
    const value = clamp(blend(sources[name], det, aiScore));
    components[name] = {
      weight,
      score: Math.round(value),
      source: sources[name] ?? 'deterministic',
      deterministic: det == null ? null : Math.round(det),
      ai: aiScore,
      note: deterministic[name]?.note ?? null
    };
    weighted += value * weight;
    totalWeight += weight;
  }

  let raw = totalWeight ? weighted / totalWeight : 0;

  // Penalties are subtracted after weighting so they read clearly in the audit.
  const penalties = [];
  const table = profile.penalties ?? {};
  if (lead.ig_is_private && table.private_account) penalties.push(['private_account', table.private_account]);
  if (lead.flags?.suspected_reseller && table.suspected_reseller) penalties.push(['suspected_reseller', table.suspected_reseller]);
  if (!lead.website_domain && table.no_website) penalties.push(['no_website', table.no_website]);
  if (!lead.email && !lead.phone_e164 && table.no_email_and_no_phone) penalties.push(['no_email_and_no_phone', table.no_email_and_no_phone]);
  for (const [, amount] of penalties) raw -= amount;

  const score = Math.round(clamp(raw));
  const hardGateFailures = checkHardGates(lead, contact, campaign, profile);
  const band = hardGateFailures.length ? 'NOT_QUALIFIED' : bandFor(score, profile);
  const minScore = campaign?.icp?.min_icp_score ?? 70;
  const queueBands = campaign?.icp?.queue_bands ?? ['HIGH_PRIORITY', 'QUALIFIED'];

  return {
    icp_score: score,
    band,
    priority: (profile.priority_map ?? {})[band] ?? 'none',
    qualified: !hardGateFailures.length && score >= minScore && queueBands.includes(band),
    components,
    penalties: penalties.map(([id, amount]) => ({ id, amount })),
    hard_gate_failures: hardGateFailures
  };
}

/** Human-readable breakdown, written into qualification_results.reason. */
export function explainScore(result) {
  const parts = Object.entries(result.components)
    .sort((a, b) => b[1].weight * b[1].score - a[1].weight * a[1].score)
    .map(([name, c]) => `${name} ${c.score}/100 (weight ${c.weight}${c.note ? `, ${c.note}` : ''})`);
  const penalty = result.penalties.length ? ` Penalties: ${result.penalties.map((p) => `${p.id} -${p.amount}`).join(', ')}.` : '';
  const gates = result.hard_gate_failures.length ? ` Hard gate failures: ${result.hard_gate_failures.join(', ')}.` : '';
  return `ICP ${result.icp_score}/100 (${result.band}). ${parts.join('; ')}.${penalty}${gates}`;
}
