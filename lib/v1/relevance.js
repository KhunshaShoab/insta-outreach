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

// Businesses OptiFlow must not pitch, for two different reasons:
//   competitor - they sell what OptiFlow sells
//   reseller   - they would resell rather than buy, or they are an intermediary
// This came out of a real run: a Canadian list produced "CXAi Inc." as the
// second-best lead, and six rows in the "Outsourcing/offshoring" industry.
// Recommending customer-support outsourcing to an outsourcing company is not a
// near miss, it is an embarrassment.
export const EXCLUSIONS = [
  { kind: 'competitor', label: 'sells what OptiFlow sells', re: /(\b(bpo|business process outsourc\w*|call cent(er|re)|contact cent(er|re)|answering service|outsourc\w*|offshor\w*|virtual assistant|customer experience (platform|software|solutions|ai)|cx ?(ai|platform|software|solutions)|helpdesk software|help desk software|live chat (software|platform)|conversational ai|ai receptionist|ai (phone|calling|voice) agent)\b|voice ?ai\b)/i },
  // Includes the industry strings CRM exports use, which name the sector without
  // the word "agency" - "Marketing & Advertising", "IT Services", and so on.
  { kind: 'reseller', label: 'would resell rather than buy', re: /\b(marketing agency|digital agency|advertising agency|ad agency|creative agency|branding agency|seo agency|growth agency|smma|marketing (and|&) advertising|web (design|development|dev)? ?(agency|lab|studio|works)|software (agency|house|development company)|it (services|consulting|consultancy)|information technology (and|&) services|management consult\w*|staffing|recruit\w*( (agency|firm))?|lead generation agency|design studio)\b/i },
  { kind: 'not_a_business', label: 'not a business with customers to support', re: /\b(business coach|sales coach|online course|masterclass|bootcamp|affiliate marketing|mlm|network marketing|crypto|forex|nft|trading signals)\b/i }
];

/**
 * Should this business be excluded from outreach entirely?
 * Checked across the name, industry, keywords and the company's own description,
 * because a CRM export states the industry outright.
 */
export function checkExclusion(lead) {
  const haystack = [
    lead.company_name, lead.industry, lead.category,
    ...(Array.isArray(lead.keywords) ? lead.keywords : []),
    lead.company_description
  ].filter(Boolean).join(' ');

  for (const rule of EXCLUSIONS) {
    const hit = haystack.match(rule.re);
    if (hit) {
      return {
        excluded: true,
        exclusion_kind: rule.kind,
        exclusion_reason: `Excluded (${rule.kind}): "${hit[0]}" appears in this business's own name, industry or description, so it ${rule.label}.`
      };
    }
  }
  return { excluded: false, exclusion_kind: null, exclusion_reason: null };
}

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
    const text = lead.industry
      ? `${lead.category ?? ''} ${lead.industry}`
      : `${lead.category ?? ''} ${(Array.isArray(lead.keywords) ? lead.keywords : []).join(' ')}`;
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

  // A CRM export states the industry outright, and that beats everything else.
  // Keyword tags are too loose to decide on: an e-commerce brand's keywords
  // routinely include "shipping" and "delivery" without it being a courier,
  // which put six software companies at the top of a logistics batch before
  // this rule existed. Keywords only get a say when there is no industry.
  const haystack = lead.industry
    ? `${name} ${category}`
    : [name, category, ...(Array.isArray(lead.keywords) ? lead.keywords : []), lead.company_description ?? ''].join(' ');

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
