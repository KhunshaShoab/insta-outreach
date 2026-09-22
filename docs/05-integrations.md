# 5. Integrations and API requirements

Every external service is behind an adapter in `lib/providers/` and selected in
`config/providers.json`. This document is what you need to sign up for, what
each integration is used for, and what it costs you in reliability terms.

## Credentials

| Variable | Used by | Notes |
| --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | every workflow | Server-side only. Never in the console. |
| `SUPABASE_ANON_KEY` | the operator console | Combined with row level security. |
| `ANTHROPIC_API_KEY` | workflows 04, 05, 06, 09, 10, 11, 12 | One key, several models. |
| `ANTHROPIC_MODEL`, `ANTHROPIC_MODEL_HEAVY` | as above | Default and heavy model ids. Research, DM writing and replies use the heavy one. |
| `APIFY_TOKEN` + actor ids | workflow 01 | Replaceable. |
| `APOLLO_API_KEY` | workflow 03 | Optional — the website fallback runs without it. |
| `IG_APP_ID`, `IG_APP_SECRET`, `IG_PAGE_ACCESS_TOKEN`, `IG_BUSINESS_ACCOUNT_ID`, `IG_WEBHOOK_VERIFY_TOKEN` | workflow 09, optionally 08 | Only for receiving replies and replying inside an open conversation. |
| `GOOGLE_SHEETS_*`, `SHEETS_ENABLED` | workflow 12 | Off by default. |
| `OPERATOR_WEBHOOK_URL` | workflows 08, 10, 12 | Optional Slack/email notification. Unset means no notifications; the console polls anyway. |
| `N8N_WEBHOOK_SECRET` | the approval API | Put header auth in front of the webhook endpoints. |

In n8n, create two HTTP Header Auth credentials with these exact names, because
the generated workflows reference them by name:

- **Supabase Service Role** — header `Authorization: Bearer <service role key>`
- **Anthropic API Key** — header `x-api-key: <key>`

## Instagram — read this before planning around it

**The official Instagram Messaging API cannot initiate a conversation.** It can
only reply to someone who messaged your professional account first, inside the
platform's messaging window. There is no compliant API path for a cold
prospecting DM.

This system therefore does not automate first-touch sending, and does not try to
route around the restriction. There is no browser automation, no session
replay, no CAPTCHA handling, no rate-limit evasion and no fake-account support.
Asking for those would mean building something designed to evade platform
enforcement, which this project does not do.

What it does instead:

| Need | Mechanism |
| --- | --- |
| Send a first DM | The operator opens the send queue, copies the approved text, opens the profile link, sends it in Instagram, and presses **Mark as sent**. The system records who sent it, when, and schedules the follow-up sequence. |
| Receive replies | Official messages webhook (`POST /webhook/optiflow/instagram/webhook`), HMAC-verified with your app secret. Without API access, the operator pastes the reply into the console and it takes the identical path. |
| Reply in an open conversation | Graph API, when `INSTAGRAM_MODE=graph_api` and the inbound message gave you an IGSID. Workflow 08 checks for that and routes back to a human when it is absent. |
| Pace sending | `config/followups.default.json → rate_limits` and the campaign's `daily_outreach_target`. The release workflow will not hand an operator more than the cap, and holds the overflow for the next window. |

### Setting up the webhook (optional)

1. Instagram Professional account linked to a Facebook Page.
2. A Meta app with `instagram_manage_messages` and `pages_messaging`.
3. Subscribe the Page to the `messages` webhook field, pointing at
   `https://<n8n>/webhook/optiflow/instagram/webhook`.
4. Set `IG_WEBHOOK_VERIFY_TOKEN` to whatever you entered in the app; the GET
   branch of workflow 09 answers the `hub.challenge`.
5. Set `IG_APP_SECRET`. Workflow 09 HMAC-verifies every payload with a
   constant-time comparison and rejects anything that fails.

Without any of this, set `INSTAGRAM_MODE=manual` and use the console. Every
downstream stage behaves identically.

## Discovery (Apify, or anything else)

Workflow 01 posts a search term to an actor and normalises whatever comes back.
The default is a Google Maps places actor, which suits local-service niches
(medspas, dental, salons). For product brands, add `instagram_search` to the
campaign's `discovery.sources`.

Costs are controlled by the campaign, not the code: `daily_lead_target` and
`max_results_per_search_term`, divided across the expanded search terms.

**Replacing it:** implement `discover(campaign, ctx) -> RawLead[]`, point
`config/providers.json → capabilities.discovery.active` at it, and change the
one HTTP node in workflow 01. `RawLead` is forgiving — `lib/normalize.js` maps
common field name variants, and `schemas/raw-lead.schema.json` is the contract.
`lib/providers/discovery.csv.js` lets you run the entire pipeline from a CSV
with no scraping spend at all, which is the cheapest way to test a change.

## Enrichment (Apollo, plus the site fallback)

Workflow 03 searches Apollo by domain for the roles that matter, then ranks the
results by company size (`lib/decision-maker.js`). If there is no domain, or
Apollo returns nothing, or Apollo errors, the workflow falls through to reading
the business's own About/Team/Contact pages.

**A missing contact never discards a lead.** Founder-led businesses — the best
prospects in this ICP — are frequently invisible to enrichment providers. The
lead continues and the DM addresses the account directly.

## Claude

| Workflow | Prompt | Model | Roughly |
| --- | --- | --- | --- |
| 04 qualification | `01-qualification.md` | default | 1 call per lead |
| 05 research | `03-business-research.md` | heavy | 1 call per qualified lead |
| 06 outreach | `05-outreach-message.md` | heavy | 1 call per lead, 3 variations |
| 09 reply classification | `07-reply-classification.md` | default | 1 call per inbound message |
| 10 response assistant | `08-suggested-response.md` | heavy | 1 call per inbound message |
| 11 follow-up | `06-followup-message.md` | heavy | 1 call per due follow-up |
| 12 report narrative | `10-daily-report.md` | default | 1 call per day |

Every call demands strict JSON validated against `schemas/`. On a schema
failure the workflow sends one correction turn carrying the validator's own
error list; if that fails the item is dead-lettered with the raw response
attached. Nothing downstream ever sees a partially parsed object.

To use a different model provider, implement
`complete({ prompt, schema, model, maxTokens })` and point the `ai` capability
at it. The prompts and schemas are provider-neutral.

## Google Sheets (optional)

Off unless `SHEETS_ENABLED=true`. Workflow 12 reads `v_sheets_export` — the view
defines the column set, so the sheet layout lives in SQL — and appends or
updates rows keyed by lead id.

The sheet is a convenience view. The database stays the source of truth; nothing
reads back from the sheet.

## Rate limits and cost control

- Every HTTP node has a timeout and up to three retries with exponential
  backoff; `Retry-After` is honoured where a provider sends it.
- `provider_calls` records each call's latency and cost so spend is attributable
  per campaign.
- Daily caps live in the campaign; the release workflow enforces them against
  what was actually sent, not what was queued.
- `errors` is a real queue with `next_retry_at`, not a log. A transient outage
  means work resumes; it does not mean leads are lost.
