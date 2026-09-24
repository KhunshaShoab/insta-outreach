// ---------------------------------------------------------------------------
// The V1 internal schema. Every input file, whatever its columns, is mapped
// onto this shape, and the original values are preserved alongside it so any
// lead can be traced back to the exact spreadsheet row it came from.
// ---------------------------------------------------------------------------

export const LEAD_FIELDS = [
  'company_name', 'website', 'domain', 'industry', 'category',
  'country', 'state', 'city', 'address', 'postal_code',
  'employees', 'revenue',
  'contact_name', 'first_name', 'last_name', 'job_title', 'email', 'phone',
  'linkedin', 'company_linkedin', 'facebook', 'twitter', 'instagram',
  'google_maps_url', 'rating', 'review_count',
  'company_description', 'technologies',
  'source', 'source_file', 'original_row'
];

/** The record written to the output sheet, in column order. */
export const OUTPUT_FIELDS = [
  'lead_id',
  'company_name', 'website', 'industry', 'country', 'state', 'city', 'employees',
  'overall_score', 'customer_support_score', 'ai_voice_score', 'classification',
  'business_instagram', 'instagram_confidence',
  'owner_name', 'owner_instagram', 'owner_instagram_confidence',
  'niche_match', 'niche_match_reason', 'excluded', 'exclusion_reason',
  'recommended_offer', 'offer_reason',
  'personalized_instagram_dm',
  'opportunity_signals',
  'research_summary',
  'evidence_sources',
  'phone', 'email', 'rating', 'review_count',
  'score_reasons',
  'review_status',
  'source_file', 'original_row',
  'duplicate_of', 'related_locations',
  'pipeline_notes'
];

export const REVIEW_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CONTACTED'];
export const CLASSIFICATIONS = ['BEST', 'GOOD', 'REVIEW', 'BAD'];
export const OFFERS = ['CUSTOMER_SUPPORT', 'AI_VOICE', 'BOTH', 'NONE'];
export const CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW', 'NOT_FOUND'];

/** Classification thresholds. Configurable in config/v1.json. */
export const DEFAULT_BANDS = [
  { label: 'BEST', min: 80 },
  { label: 'GOOD', min: 65 },
  { label: 'REVIEW', min: 50 },
  { label: 'BAD', min: 0 }
];

export function classify(score, bands = DEFAULT_BANDS) {
  for (const band of [...bands].sort((a, b) => b.min - a.min)) {
    if (score >= band.min) return band.label;
  }
  return 'BAD';
}

export function emptyLead() {
  return Object.fromEntries(LEAD_FIELDS.map((f) => [f, null]));
}
