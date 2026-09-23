// ---------------------------------------------------------------------------
// Niche relevance.
//
// Google Maps exports mislabel businesses constantly. In the attached medspa
// file, "Cameo College of Essential Beauty" (a cosmetology school with 2,403
// reviews) and "Four Seasons Hotel Baltimore" both carry the category "Medical
// spa" / "Spa". On evidence alone the college scores well - schools really do
// run phone-heavy receptions - but it is not the business OptiFlow is selling
// to, and it would have been the top lead of the batch.
//
// So relevance is judged separately from evidence, and from the NAME as well as
// the category, because the category is the field that is wrong.
//
// Off-niche leads are not deleted. They are flagged, kept out of the outreach
// batch, and left in the output with the reason, so nothing is lost silently.
// ---------------------------------------------------------------------------

/** Business types that masquerade as other niches in scraped data. */
export const TYPE_PATTERNS = [
  { type: 'education', re: /\b(college|institute|academy|school|universit|training cent(er|re)|cosmetolog)/i },
  { type: 'hospitality', re: /\b(hotel|resort|inn|lodge|motel|suites|bed and breakfast|b&b|casino|campground|rv park)\b/i },
  { type: 'restaurant', re: /\b(restaurant|pizza|sushi|cafe|coffee|bakery|bar and grill|taqueria|diner|brewery|takeaway)\b/i },
  { type: 'retail_chain', re: /\b(walmart|target|costco|cvs|walgreens|kroger|amazon|fedex|ups store|dollar general)\b/i },
  { type: 'government', re: /\b(city of|county of|state government|department of|municipal|dmv|post office)\b/i },
  { type: 'association', re: /\b(association|federation|society|council|chamber of commerce|board of|directors association)\b/i },
  { type: 'healthcare_other', re: /\b(hospital|emergency room|urgent care|pharmacy|laborator|imaging cent(er|re)|nursing home)\b/i },
  { type: 'religious', re: /\b(church|chapel|temple|mosque|synagogue|parish|ministry)\b/i },
  { type: 'real_estate', re: /\b(apartments?|condos?|realty|property management|storage unit)/i }
];

/** Which types are acceptable for a given target niche. */
export const NICHE_RULES = {
  medspa: {
    label: 'Medspa / aesthetics clinic',
    expect: /\b(med ?spa|medical spa|aesthet|skin|laser|derma|injectab|botox|filler|wellness|rejuven|beaut(y|ies) (bar|lounge|clinic)|body contour)/i,
    allow_types: [],
    note: 'A medspa is a clinic that performs treatments. Schools that teach them and hotels that contain one are different businesses.'
  },
  funeral: {
    label: 'Funeral home / cremation provider',
    expect: /\b(funeral|cremat|mortuar|memorial (chapel|park)|burial|cemeter)/i,
    allow_types: [],
    note: 'Associations and state boards appear in these scrapes and are not operators.'
  },
  logistics: {
    label: 'Logistics / freight / trucking operator',
    expect: /\b(logistic|freight|truck|courier|transport|delivery|dispatch|cargo|warehous|distribution|shipping|3pl|moving|haul)/i,
    allow_types: [],
    note: 'Mailbox rental, self-storage and restaurant delivery brands are commonly scraped into logistics lists.'
  },
  dental: {
    label: 'Dental practice',
    expect: /\b(dental|dentist|orthodont|endodont|periodont|oral surgery|smile)/i,
    allow_types: []
  },
  generic: { label: 'Any business', expect: /./, allow_types: TYPE_PATTERNS.map((t) => t.type) }
};

/** Guess the file's intended niche from the categories it is dominated by. */
export function detectNiche(leads = []) {
  const counts = {};
  for (const lead of leads) {
    const text = `${lead.category ?? ''} ${lead.industry ?? ''}`;
    for (const [niche, rule] of Object.entries(NICHE_RULES)) {
      if (niche === 'generic') continue;
      if (rule.expect.test(text)) counts[niche] = (counts[niche] ?? 0) + 1;
    }
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < leads.length * 0.3) return { niche: 'generic', confidence: 'LOW', matched: best?.[1] ?? 0 };
  return { niche: best[0], confidence: best[1] > leads.length * 0.6 ? 'HIGH' : 'MEDIUM', matched: best[1] };
}

/**
 * @returns {{ niche_match, niche_match_reason, detected_type }}
 *   niche_match: 'IN_NICHE' | 'OFF_NICHE' | 'UNCERTAIN'
 */
export function checkRelevance(lead, nicheKey = 'generic') {
  const rule = NICHE_RULES[nicheKey] ?? NICHE_RULES.generic;
  const name = lead.company_name ?? '';
  const category = `${lead.category ?? ''} ${lead.industry ?? ''}`.trim();
  const haystack = `${name} ${category}`;

  // The name is checked first and wins, because it is the field a scraper does
  // not get to invent.
  const wrongType = TYPE_PATTERNS.find((t) => t.re.test(name) && !rule.allow_types.includes(t.type));
  if (wrongType) {
    return {
      niche_match: 'OFF_NICHE',
      detected_type: wrongType.type,
      niche_match_reason: `The business name "${name}" identifies this as ${wrongType.type.replace('_', ' ')}, not ${rule.label.toLowerCase()}. The source file's category ("${lead.category ?? 'none'}") disagrees, and the name is the more reliable field.`
    };
  }

  const categoryType = TYPE_PATTERNS.find((t) => t.re.test(category) && !rule.allow_types.includes(t.type));
  if (categoryType) {
    return {
      niche_match: 'OFF_NICHE',
      detected_type: categoryType.type,
      niche_match_reason: `The source file's own category "${lead.category}" is ${categoryType.type.replace('_', ' ')}, not ${rule.label.toLowerCase()}.`
    };
  }

  if (rule.expect.test(haystack)) {
    return {
      niche_match: 'IN_NICHE',
      detected_type: nicheKey,
      niche_match_reason: `Name or category matches ${rule.label.toLowerCase()}.`
    };
  }

  return {
    niche_match: 'UNCERTAIN',
    detected_type: null,
    niche_match_reason: `Neither the name "${name}" nor the category "${lead.category ?? 'none'}" confirms this is ${rule.label.toLowerCase()}. Worth a human glance before any approach.`
  };
}
