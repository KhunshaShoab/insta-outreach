# 1. System architecture

OptiFlow's Instagram outbound engine. It finds businesses, works out whether
they are worth talking to, works out what to say, and hands a person a message
to send. It does not send anything by itself.

```
                    ┌──────────────────────────────────────────────┐
                    │  config/  (niches, campaigns, scoring, rules) │
                    │  - the only place ICP values are defined      │
                    └───────────────────────┬──────────────────────┘
                                            │ scripts/load-config.mjs
                                            ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  PostgreSQL / Supabase - the source of truth                            │
  │  campaigns · niches · companies · contacts · leads · qualification       │
  │  research · outreach · conversations · followups · activities · errors   │
  │  + claim/advance/dedupe/approve functions and the reply-stop trigger     │
  └───┬─────────────────────────────────────────────────────────────────┬───┘
      │ every workflow reads and writes here                            │
      ▼                                                                 ▼
  ┌──────────────────────────────────────────┐        ┌────────────────────────────┐
  │  n8n - 13 modular workflows              │        │  Operator console          │
  │                                          │        │  (apps/approval-console)   │
  │  01 discovery      08 release + logging   │◀──────▶│  review · edit · approve   │
  │  02 clean/dedupe   09 reply processing    │        │  send · outcomes           │
  │  03 enrichment     10 response assistant  │        └────────────────────────────┘
  │  04 qualification  11 follow-up engine    │
  │  05 research       12 analytics           │
  │  06 generation     13 orchestrator        │
  │  07 approval API                          │
  └───┬───────────────┬──────────────┬────────┘
      │               │              │
      ▼               ▼              ▼
  ┌────────┐   ┌────────────┐   ┌──────────────────┐
  │ Apify  │   │  Apollo    │   │  Claude          │
  │ (or    │   │  (+ site   │   │  qualification,  │
  │ any    │   │  fallback) │   │  research, DMs,  │
  │ scraper│   │            │   │  replies         │
  └────────┘   └────────────┘   └──────────────────┘
                                          │
                                          ▼
                              ┌────────────────────────┐
                              │ Instagram              │
                              │ · cold DMs: human-sent │
                              │ · replies: webhook or  │
                              │   pasted in by hand    │
                              └────────────────────────┘
```

## The pipeline

```
SCRAPED → CLEANED → ENRICHED → QUALIFIED → RESEARCHED → MESSAGE_GENERATED
  → PENDING_APPROVAL → READY_FOR_OUTREACH → DM_SENT → REPLIED → CONVERSATION
  → INTERESTED / NURTURE / NOT_INTERESTED → CLOSED
```

Leads that fail cleaning or qualification go to `DISQUALIFIED` with a stated
reason. Nothing is deleted, so "why did we drop this business?" always has an
answer.

There are no call, voice or appointment stages. This is an Instagram outbound
system.

## Four layers, and why they are separate

**Configuration (`config/`)** — niches, campaigns, scoring weights, cleaning
rules, follow-up cadence, provider choice. No ICP value is written in code.
Changing the follower band, the score threshold, the follow-up days or the
target cities is a JSON edit plus `npm run validate:config`.

**Logic (`lib/`)** — pure functions: normalisation, deduplication, ICP scoring,
decision-maker ranking, angle selection, follow-up scheduling, error
classification, prompt rendering, JSON-schema validation. No I/O, so it is
testable, and it is tested (105 tests). The n8n build inlines this source into
the Code nodes, so the code running in production is the code under test rather
than a copy that drifts.

**Orchestration (`n8n/`)** — thirteen workflows, each responsible for one stage.
They are generated from `n8n/src/*.mjs` by `npm run build:n8n`, which also
validates the result: no orphan nodes, no dangling connections, every Code node
parses, every external call has a timeout and an error path.

**Data (`db/`)** — the schema, the views the console and the reports read, and
the functions that make the workflows safe to re-run: `claim_leads` with
`FOR UPDATE SKIP LOCKED`, `advance_lead` that never moves a lead backwards,
`resolve_company` that collapses duplicates, and a trigger that cancels the
entire follow-up sequence the moment a prospect replies.

## Where the AI sits, and where it does not

Claude does eleven jobs: qualification judgement, business research, pain-point
identification, decision-maker selection, angle selection, DM writing, follow-up
writing, reply classification, suggested replies, and conversation analysis.
Every call returns JSON validated against a schema in `schemas/`; a malformed
response gets one correction turn carrying the validator's own error list, and
if that fails the item is dead-lettered rather than half-parsed.

Two things the model is deliberately not allowed to do:

- **It does not compute the ICP score.** It returns judgement sub-scores
  (business quality, CX need, outreach potential, niche fit, website quality).
  `lib/scoring.js` blends those with measured facts — follower band, product
  count, location, activity, decision-maker availability — using configured
  weights. Two identical leads always score identically, and `explainScore()`
  can justify every point. Scores that cannot be explained are not worth having.
- **It does not send anything.** Generated messages enter the queue as
  `PENDING_REVIEW`. Only the approval API can approve one, and only a person
  operating it can mark one sent.

## Instagram, stated plainly

The official Instagram Messaging API cannot start a conversation with someone
who has not messaged you first. That is the platform's rule, not a limitation
of this system, and nothing here tries to work around it: no fake accounts, no
rate-limit evasion, no CAPTCHA handling, no automation of the login surface.

So the split is:

| Action | How it works here |
| --- | --- |
| First-touch DM | A person sends it, from the console's send queue, in Instagram. The system gives them the profile link and the approved text, then records the send. |
| Reply inside an open conversation | Official Graph API, where the account is eligible; otherwise also human-sent. |
| Receiving replies | The official messages webhook (HMAC-verified), or pasted into the console. Both paths produce identical rows, so downstream handling is the same. |

What is automated is the expensive part: finding, qualifying, researching,
personalising, queueing, tracking, following up and analysing.

## Replacing a provider

`config/providers.json` maps each capability to an adapter in `lib/providers/`.
Change `active`, implement the capability's interface, done — no workflow
rewiring:

| Capability | Default | Interface |
| --- | --- | --- |
| discovery | apify | `discover(campaign, ctx) -> RawLead[]` |
| instagram_profile | apify | `fetchProfile(handle, ctx) -> IgProfile` |
| enrichment | apollo, falling back to website scrape | `enrich(company, ctx) -> EnrichmentResult` |
| ai | anthropic | `complete({ prompt, schema, model }) -> object` |
| datastore | supabase | Postgres over REST or a direct connection |
| mirror | google_sheets (off by default) | `upsertRows(rows, ctx)` |
| instagram_messaging | manual | `send(threadRef, message, ctx)` |
| reply_ingest | manual | `parseWebhook(payload) -> InboundMessage[]` |

`RawLead` is the only contract a replacement scraper has to satisfy, and
`lib/normalize.js` is forgiving about field names — see
`schemas/raw-lead.schema.json`.

## Reading order

| Document | What it covers |
| --- | --- |
| [02 Database schema](02-database-schema.md) | Tables, views, functions |
| [03 Workflow map](03-workflow-map.md) | What each workflow owns and how they hand over |
| [04 Node-by-node](04-node-by-node.md) | Generated reference for every node |
| [05 Integrations](05-integrations.md) | API requirements, credentials, Instagram specifics |
| [06 Prompts](06-prompts.md) | The eleven AI jobs and how prompts are rendered |
| [07 JSON schemas](07-json-schemas.md) | Every AI output contract |
| [08 Error handling](08-error-handling.md) | Retries, backoff, the failed-item queue |
| [09 Deduplication](09-deduplication.md) | How a business is only ever contacted once |
| [10 Resume and progress](10-resume-and-progress.md) | Crash recovery and per-lead progress |
| [11 Human approval](11-human-approval.md) | The control surface |
| [12 Follow-up logic](12-followup-logic.md) | Cadence, content rules, the reply-stop guarantee |
| [13 Operations](13-operations.md) | Setup, the daily run, the daily report |
