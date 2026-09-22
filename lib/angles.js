// ---------------------------------------------------------------------------
// Outreach angle selection.
// Each niche ships its own angle list (config/niches.json). The AI picks one
// and justifies it; this module validates that choice against the niche and
// provides a deterministic fallback so a bad model response can never produce
// a generic "we are a leading BPO" message.
// ---------------------------------------------------------------------------

/** All angles defined for a niche. */
export function anglesFor(niche) {
  return (niche?.outreach_angles ?? []).map((a) => ({ ...a }));
}

export function angleById(niche, id) {
  return anglesFor(niche).find((a) => a.id === id) ?? null;
}

/**
 * Deterministic pick, used as the fallback and as a sanity check on the AI.
 * Signals come from the enriched lead and the research brief.
 */
export function pickAngle(niche, { lead = {}, research = {}, campaign = {} } = {}) {
  const override = campaign?.outreach?.angle_override;
  if (override) {
    const forced = angleById(niche, override);
    if (forced) return { angle: forced, reason: 'campaign angle_override', source: 'campaign' };
  }

  const angles = anglesFor(niche);
  if (!angles.length) return { angle: null, reason: 'niche has no angles configured', source: 'none' };

  const text = [
    lead.bio, lead.website_description, lead.category,
    ...(lead.products_services ?? []),
    research.business_summary, research.instagram_focus,
    ...(research.operational_pain_points ?? []).map((p) => (typeof p === 'string' ? p : p?.pain ?? '')),
    ...(research.cx_needs ?? []).map((p) => (typeof p === 'string' ? p : p?.need ?? ''))
  ].filter(Boolean).join(' ').toLowerCase();

  const scored = angles.map((angle) => {
    let score = 0;
    const words = `${angle.label} ${angle.hook} ${angle.when ?? ''}`.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 4);
    for (const w of new Set(words)) if (text.includes(w)) score += 1;
    // Angle-specific signals that matter more than word overlap.
    if (angle.id === 'after_hours' && /after hours|24\/7|weekend|evening|closed/.test(text)) score += 3;
    if (angle.id === 'speed_to_lead' && /dm (us|for)|message us|inquir|pricing/.test(text)) score += 3;
    if (angle.id === 'order_questions' && /order|shipping|tracking|delivery/.test(text)) score += 3;
    if (angle.id === 'sizing_questions' && /size|sizing|fit|measurement/.test(text)) score += 3;
    if (angle.id === 'returns' && /return|exchange|refund/.test(text)) score += 3;
    if (angle.id === 'technical_questions' && /setup|troubleshoot|firmware|app|install|compatib/.test(text)) score += 3;
    if (angle.id === 'warranty' && /warranty|rma|repair|after[- ]sales/.test(text)) score += 3;
    if (angle.id === 'growth_support' && /growing|scal|launch|drop|sold out|restock/.test(text)) score += 2;
    return { angle, score };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best.score) {
    return { angle: angles[0], reason: 'no strong signal - defaulted to the niche primary angle', source: 'default' };
  }
  return { angle: best.angle, reason: `matched ${best.score} signal(s) in the business profile`, source: 'signals' };
}

/**
 * Validate an AI-chosen angle. Returns the angle to actually use.
 * An unknown id never breaks the run - it falls back to the deterministic pick.
 */
export function resolveAngle(niche, aiAngleId, context) {
  const fromAi = aiAngleId ? angleById(niche, aiAngleId) : null;
  if (fromAi) return { angle: fromAi, reason: 'selected by the qualification/research step', source: 'ai' };
  const fallback = pickAngle(niche, context);
  return { ...fallback, source: aiAngleId ? 'fallback_unknown_ai_angle' : fallback.source, rejected_ai_angle: aiAngleId ?? null };
}
