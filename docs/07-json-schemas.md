# 7. JSON schemas for AI output

Every Claude call in this system returns JSON validated against a schema in
`schemas/`. The validator (`lib/validate.js`) is a dependency-free draft-07
subset, which matters because it has to run inside an n8n Code node where npm
packages are not available.

## The contract

```
prompt  →  Claude  →  extractJson()  →  validate()  →  ok?
                                            │
                                            └─ no → one correction turn carrying
                                                    the validator's error list
                                                    → still bad? dead-letter the
                                                      item with the raw response
```

`lib/json.js → parseAiJson(text, schema)` returns
`{ ok, data, errors, retry_prompt }`. It recovers JSON from a fenced block or a
preamble, and its balanced-brace scan is string-aware so a `}` inside a message
body does not truncate the object. Nothing downstream ever receives a partially
parsed result.

## The schemas

| Schema | Produced by | Required fields |
| --- | --- | --- |
| `qualification.schema.json` | wf04 | `ai_scores` (five 0-100 judgements), `reason`, `potential_pain_points`, `recommended_service`, `recommended_outreach_angle`, `decision_maker_found`, `disqualify` |
| `decision-maker.schema.json` | wf03 / prompt 02 | `target_contact` (nullable), `contact_role`, `role_category` (enum), `why_this_person`, `confidence` |
| `research.schema.json` | wf05 | `business_summary`, `what_they_sell`, `cx_needs`, `operational_pain_points`, `specific_observations`, `why_optiflow_relevant`, `recommended_service`, `recommended_angle`, `confidence` |
| `outreach-angle.schema.json` | prompt 04 | `angle_id`, `why_this_angle`, `confidence` |
| `outreach-message.schema.json` | wf06 | `variations[]` (2-3, each with an enum variation and a message of 20-900 chars), `recommended_variation`, `outreach_angle`, `personalisation_used`, `self_check` |
| `followup-message.schema.json` | wf11 | `message`, `reason_for_this_followup`, `self_check` |
| `reply-classification.schema.json` | wf09 | `classification` (13 values), `intent`, `sentiment`, `urgency`, `recommended_action`, `stop_followups`, `requires_human`, `suggested_stage` |
| `suggested-response.schema.json` | wf10 | `suggested_response`, `reason`, `next_action`, `requires_human_review` |
| `conversation-analysis.schema.json` | prompt 09 | `summary`, `current_state`, `recommended_stage`, `recommended_next_step` |
| `daily-report-summary.schema.json` | wf12 | `headline`, `observations` |
| `raw-lead.schema.json` | any discovery provider | `business_name` or `instagram_handle` |

## Worked example — qualification

Input (abridged): a Los Angeles medspa, 4,200 followers, five treatments listed,
a founder found by enrichment, bio reading "DM us for pricing".

```json
{
  "ai_scores": {
    "niche_fit": 95,
    "business_quality": 82,
    "website_quality": 78,
    "cx_need": 88,
    "outreach_potential": 90
  },
  "reason": "Single-location medical spa with five named treatments and an active posting cadence. The bio routes pricing enquiries to DMs while the clinic runs appointments all day, which is exactly the volume that goes unanswered. A founder is listed publicly.",
  "potential_pain_points": [
    "Pricing DMs arriving faster than the front desk can answer them",
    "Enquiries landing after the posted 6pm close with no coverage",
    "No visible follow-up on consultations that did not book"
  ],
  "recommended_service": "Lead response / speed-to-lead support",
  "recommended_outreach_angle": "speed_to_lead",
  "decision_maker_found": true,
  "confidence": 0.85,
  "disqualify": false,
  "disqualify_reason": null
}
```

The workflow then computes the score itself:

```json
{
  "icp_score": 89,
  "icp_band": "HIGH_PRIORITY",
  "priority": "high",
  "qualified": true,
  "components": {
    "location_fit":       { "weight": 14, "score": 100, "source": "deterministic", "note": "target city Los Angeles" },
    "niche_fit":          { "weight": 15, "score": 77,  "source": "blend:0.4/0.6", "deterministic": 50, "ai": 95 },
    "follower_fit":       { "weight": 12, "score": 100, "source": "deterministic", "note": "4200 followers, inside 1000-10000" },
    "products_fit":       { "weight": 10, "score": 93,  "source": "deterministic", "note": "5 products/services" },
    "business_quality":   { "weight": 12, "score": 82,  "source": "ai" },
    "instagram_activity": { "weight": 8,  "score": 100, "source": "deterministic", "note": "posted 3 days ago" },
    "website_quality":    { "weight": 5,  "score": 89,  "source": "blend:0.5/0.5" },
    "decision_maker":     { "weight": 8,  "score": 100, "source": "deterministic", "note": "Sarah Mitchell, Founder, reachable" },
    "cx_need":            { "weight": 10, "score": 88,  "source": "ai" },
    "outreach_potential": { "weight": 6,  "score": 90,  "source": "ai" }
  },
  "penalties": [],
  "hard_gate_failures": []
}
```

Both objects are stored on `qualification_results`, so months later you can see
not just that a lead scored 89 but which components produced it and which of
them was the model's opinion rather than a measured fact.

## Adding a schema

1. Write `schemas/<name>.schema.json` using the supported keywords: `type`,
   `enum`, `const`, `required`, `properties`, `items`, `additionalProperties`,
   `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `minItems`,
   `maxItems`, `uniqueItems`.
2. Reference it in the prompt's front matter (`schema: <name>`).
3. Map it in `tests/prompts.test.mjs → SCHEMA_FILES`, which makes the test suite
   enforce the prompt/schema pairing.
4. Inline it in the workflow's parser node with `schemaConst()`.

Keep `additionalProperties: false` on the objects you control. A model that adds
a field you did not ask for is telling you the prompt is ambiguous.
