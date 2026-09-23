# 14. V1 Lead Intelligence Engine

Attach a lead file, run one command, review a spreadsheet. Nothing is sent.

```
XLSX/CSV → normalize → deduplicate → relevance → research → Instagram
         → signals → score → classify → offer → DM → CSV + JSON → human review
```

The input files live outside this repository. They are attached per run and
passed by path, so the same pipeline runs on the next file without any change.

## Running it

```bash
# 1. Look at a file before processing it
node scripts/v1.mjs --inspect ~/Downloads/leads.xlsx

# 2. Process a first batch
node scripts/v1.mjs --file ~/Downloads/leads.xlsx --limit 15

# 3. Continue through the file in batches
node scripts/v1.mjs --file ~/Downloads/leads.xlsx --limit 50 --offset 15
```

| Flag | Meaning |
| --- | --- |
| `--file` | the XLSX or CSV to process |
| `--inspect` | describe the file and stop |
| `--limit` | how many leads this run (default 15) |
| `--offset` | skip the first N, for batching through a file |
| `--sheet` | force a sheet name; otherwise the lead sheet is detected |
| `--niche` | force the niche (`medspa`, `funeral`, `logistics`, `dental`, `generic`) |
| `--out` | output path without extension |
| `--mock-ai` | write placeholder DMs even when an API key is set |

Output: `<out>.csv` (opens in Excel, imports to Google Sheets) and `<out>.json`
(every signal and every piece of evidence).

Set `ANTHROPIC_API_KEY` to have Claude write the DMs. Without it the pipeline
still runs completely and the DM column is labelled placeholder text.

## The stages

**1. Ingest.** `lib/v1/xlsx.js` reads XLSX with no dependencies — a ZIP and XML
parser, verified cell-for-cell against openpyxl on 49,007 cells across the four
attached files. `lib/v1/ingest.js` maps whatever columns exist onto the V1
schema. Several headers can feed one field, which matters because scraped files
routinely carry an empty `name` beside a populated `Business Name`; the first
non-empty value wins. Unmapped columns are kept in `original_record`, and
`source_file` plus `original_row` make every lead traceable to its source row.

**2. Deduplicate.** Match priority is domain → website → company+city →
company+phone → company+email, with one correction the data forced. In the
attached funeral file 507 of 716 rows share a website: `dignitymemorial.com`
appears 24 times for 24 different funeral homes in different towns. Merging on
domain alone would have deleted 23 real businesses. So a domain match merges
only when the name or the city also agrees; otherwise the rows are recorded as
**related locations** — kept as separate leads, linked to each other, and
reported as a group.

**3. Relevance.** Scraped categories are unreliable, so each lead is checked
against the file's dominant niche using the **business name as well as** the
category. "Cameo College of Essential Beauty" and "Four Seasons Hotel Baltimore"
both carry the category "Medical spa" in the attached file; on evidence alone the
college scored 81 and would have been the top lead of the first batch. Off-niche
leads are flagged and kept out of the outreach batch, never deleted.

**4. Research.** `lib/v1/research.js` reads the company's own website — homepage,
contact, about, careers, faq — and records what is there: platform fingerprints
(Shopify, WooCommerce, HubSpot, Aesthetic Record, Calendly, …), click-to-call
links, call and booking language, contact channels, returns pages, careers
content, social links. Every finding carries the URL it came from.

Expect roughly 60–85% of sites to be readable. Small-business sites often sit
behind bot protection and return 403; that is recorded as a caveat signal and
caps the scores, rather than being treated as absence of evidence.

**5. Instagram discovery.** Confidence is about provenance, not plausibility:

| Confidence | Meaning |
| --- | --- |
| `HIGH` | the company's own website links to the account |
| `MEDIUM` | the spreadsheet supplied it, or several accounts were linked and one had to be chosen |
| `LOW` | a guess from the domain name — recorded as a candidate and **never** written to `business_instagram` |
| `NOT_FOUND` | nothing found |

A username that merely resembles the company name never rises above `LOW`.
`instagram.com/p`, `/reel`, `/explore` and similar paths are rejected as
non-accounts. An owner's personal account is only reported when a person is
actually named; it is never inferred from the business account.

**6. Opportunity signals.** Each signal has four parts:

```
signal          Phone is a prominent contact channel
evidence        12 click-to-call links across the 2 page(s) read.
interpretation  Phone appears to be an important way customers reach this business.
confidence      HIGH
source          https://glomedspa.com/
```

The separation is the point. `evidence` is what was observed; `interpretation`
is a reading of it and is always hedged — "may", "appears to", "normally". The
pipeline never produces "they are missing calls" or "their support team is
overwhelmed", because no website can show either, and a test asserts that no
interpretation contains that class of claim.

**7. Scoring.** Three scores, every point traceable:

- `customer_support_score` — e-commerce platform, catalogue size, returns policy,
  multiple channels, live chat in place, customer-facing hiring
- `ai_voice_score` — booking platform, call-to-action, click-to-call links,
  after-hours claims, appointment-led category, phone-heavy category
- `overall_score` — 60% the stronger service fit, 22% reachability (can this
  lead actually be contacted, and is there a confirmed Instagram account), 18%
  legitimacy (rating, reviews, does the site serve a page)

`score_reasons` records every component with its award and confidence. Two caps
apply: no website caps a service score at 45, an unreadable website at 55. A
high score built on four spreadsheet columns is a false positive dressed as a
finding.

Bands: `BEST` ≥80, `GOOD` ≥65, `REVIEW` ≥50, `BAD` <50 — configurable in
`config/v1.json`.

**8. Offer.** `CUSTOMER_SUPPORT`, `AI_VOICE`, `BOTH` or `NONE`. `BOTH` requires
each service to clear 55 **and** to have at least two independent medium-or-high
signals — one strong signal read two ways does not qualify. `NONE` is a normal
and frequently correct answer.

**9. DM.** Written only for `IN_NICHE` leads classified `BEST` or `GOOD` with a
recommended offer. `prompts/v1-instagram-dm.md` receives the signals and is
instructed to quote the `evidence` field and never the `interpretation` field,
because the interpretation is a guess and must not be stated to a prospect as
fact. The model returns a self-check; any failed check is flagged in
`pipeline_notes` for the reviewer.

## Review

Every row is written with `review_status = PENDING`. Open the CSV, read
`opportunity_signals`, `offer_reason` and the DM, then set the status to
`APPROVED`, `REJECTED` or `CONTACTED` yourself and send the message by hand.

The pipeline has no send capability. That is deliberate and is not a limitation
to be worked around: Instagram's API cannot start a conversation with someone who
has not messaged you first, and automating the app to do it risks the account.

## What the first tests found

Run on the four attached files, 10–15 leads each:

| File | Rows | Distinct | In niche | Sites read | Instagram found | Got an offer |
| --- | --- | --- | --- | --- | --- | --- |
| Ostnyx medspas | 1,101 | 1,034 | 96% | 14/15 | 14/15 | 10/15 |
| Funeral homes | 716 | 414 | 86% | 6/10 | **0/10** | 1/10 |
| Logistics USA | 1,543 | 1,497 | 92% | 8/10 | 4/10 | **0/10** |
| log_1 | 199 | — | — | — | — | — |

Three conclusions worth acting on:

- **Medspas work.** Appointment booking platforms, click-to-call links and
  booking CTAs are everywhere, which is exactly the AI voice receptionist case,
  and almost all of them link their Instagram from their own site.
- **Funeral homes do not use Instagram.** Not one account was found in ten. They
  may be good AI-voice prospects, but Instagram is the wrong channel to reach
  them on.
- **Logistics scored zero offers.** Freight and trucking firms publish neither
  e-commerce support signals nor booking or click-to-call CTAs; their customer
  contact runs through account managers. On the evidence, neither service fits.
- **log_1 is a subset of logistics-usa** — every one of its 196 names appears in
  the larger file. Processing it separately would duplicate work.

## Configuration

`config/v1.json` holds the bands, the overall weights, the offer thresholds, the
score caps, the research timeout and concurrency, the DM character limit and the
sender name. `lib/v1/relevance.js` holds the niche rules. Nothing about the
scoring or the thresholds is written into the pipeline code.

## Adding a niche

Add an entry to `NICHE_RULES` in `lib/v1/relevance.js` with an `expect` pattern
(anchor the start of each stem, not the end — `\btruck` matches "Trucking", while
`\btruck\b` does not). Signals and scoring are niche-independent and need no
change.
