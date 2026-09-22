# 2. Database schema

PostgreSQL 14+ (Supabase-compatible). Apply in order:

```
db/migrations/0001_schema.sql     tables, indexes, constraints
db/migrations/0002_views.sql      queues, progress, analytics, the Sheets export
db/migrations/0003_functions.sql  claiming, transitions, dedupe, follow-ups, triggers
db/migrations/0004_rls.sql        row level security and grants
db/seed/0001_seed.sql             the default scoring profile
db/seed/0002_config.generated.sql niches and campaigns (from scripts/load-config.mjs)
```

`scripts/db-test.sh` applies all of it to a scratch database and runs
`db/tests/lifecycle_test.sql`, which walks a lead from discovery to opt-out and
asserts 36 behaviours along the way.

## Tables

### Configuration

| Table | Purpose |
| --- | --- |
| `niches` | Keywords, negative keywords, search terms, hashtags, ICP rules, pain points, recommended services and outreach angles. Mirrored from `config/niches.json`. |
| `scoring_profiles` | Weights, curves, bands, hard gates and penalties. |
| `campaigns` | One row per campaign: targeting, ICP, discovery, enrichment, qualification, research, outreach, follow-ups, mirror and schedule, each a JSONB block matching the campaign file. |

Stages and statuses live in `lead_stages` and `lead_statuses` rather than enums,
so the pipeline can gain a stage without an `ALTER TYPE` on a live database.

### The business and the people

| Table | Purpose |
| --- | --- |
| `companies` | One row per real-world business — the deduplication anchor. A business found by three campaigns is one company row and three leads. |
| `company_identity_keys` | Every key a company was ever matched on (`instagram_handle`, `website_domain`, `phone_e164`, `email`, `place_id`, `name_city`). A later hit on any of them resolves to the same row. |
| `contacts` | People found during enrichment, with role category, source and confidence. One `is_primary_target` per company, enforced by a partial unique index. |

Deduplication is enforced by partial unique indexes on `instagram_handle`,
`website_domain` and `phone_e164`, plus `(name_normalized, city, state)` for
businesses that have none of those.

### The pipeline

| Table | Purpose |
| --- | --- |
| `leads` | One company inside one campaign. Carries `stage`, `status`, `icp_score`, `icp_band`, the per-step timestamps, `retry_count`, `last_error` and `next_followup_at`. `public_ref` is the human-friendly "Lead 182". `unique (campaign_id, company_id)` is the second dedupe wall. |
| `qualification_results` | Every qualification run, kept. Component scores with their weights and sources, the AI's raw sub-scores, hard-gate failures, the reason, pain points, recommended service and angle, model, prompt version and token usage. |
| `research` | The business brief: summary, what they sell, customers, Instagram focus, CX needs, operational pain points, the specific observations that fuel personalisation, why OptiFlow is relevant, confidence and evidence. |
| `outreach` | One row per message drafted, approved or sent — initial and follow-ups. Holds all generated variations, the human edit, the final text, status, approver, send mode and external id. |
| `conversations` / `conversation_messages` | The thread. Inbound rows carry the classification, intent, sentiment, urgency, objection type and recommended action. |
| `suggested_responses` | Draft replies with reason, next action and alternatives, and whether the operator used, edited, regenerated or ignored them. |
| `followups` | The scheduled sequence: step, kind, due date, status. Cancelled rows are kept for audit. |

### Operations

| Table | Purpose |
| --- | --- |
| `activities` | Append-only audit log of every transition and decision, with actor (`system`, `n8n:<workflow>`, `user:<email>`). |
| `errors` | The failed-item queue: workflow, node, provider, error type, HTTP status, payload, retry count and `next_retry_at`. |
| `suppressions` | Opt-outs and do-not-contact, by handle, domain, email, phone or company. Checked before a lead is created. |
| `provider_calls` | Per-call accounting: provider, operation, latency, units, cost. |
| `workflow_runs` | Resume bookkeeping: which workflow, which campaign, which execution, items in/ok/failed, and a cursor. |
| `daily_metrics` | Daily snapshots written by the reporting workflow. |

## Views

| View | Used by |
| --- | --- |
| `v_leads_full` | The flat lead row: company, contact, qualification, research and latest message in one select. |
| `v_approval_queue` | The approval console. Ordered by priority then ICP score, and it carries the research brief and pain points so the reviewer does not have to open another tab. |
| `v_send_queue` | Approved and not yet sent. |
| `v_followups_due` | Due follow-ups, already excluding anyone who replied or reached a terminal status. |
| `v_conversations_open` | Threads waiting on us, with the last inbound message, its classification and the latest suggestion. |
| `v_lead_progress` | The per-lead checklist: scraped, cleaned, enriched, qualified, researched, generated, approved, sent, replied. |
| `v_campaign_funnel` | Counts and rates per campaign. |
| `v_performance_by_niche` / `_by_state` / `_by_angle` / `_by_variation` | Measured reply and positive-reply rates. No ranking is applied - the caller chooses. |
| `v_reply_categories`, `v_objections` | What prospects actually said, grouped. |
| `v_daily_report` | Today's figures per active campaign. |
| `v_sheets_export` | Exactly the columns the optional Google Sheets mirror writes. |

## Functions

| Function | What it guarantees |
| --- | --- |
| `claim_leads(campaign, stage, limit, worker, stale_minutes, max_retries)` | Hands each lead to exactly one worker via `FOR UPDATE SKIP LOCKED`. A claim older than `stale_minutes` is reissued, so a crashed execution resumes rather than stranding leads. |
| `advance_lead(lead, to_stage, status, step, detail, execution)` | Moves a lead forward, stamps the step timestamp, clears the error state and logs the transition. Never moves a lead backwards. |
| `fail_lead(...)` | Increments the retry count, writes an `errors` row with an exponential `next_retry_at` (2s, 4s, 8s… capped at an hour) and logs it. The batch continues. |
| `resolve_company(...)` | The deduplication entry point. Matches on any identity key, strongest first; merges new facts into gaps without overwriting known values; records every key seen. |
| `upsert_lead(campaign, company, source, term)` | Idempotent lead creation. |
| `is_suppressed(company)` | Opt-out check, run before a lead is created. |
| `schedule_followups(lead, from)` | Builds the sequence from the campaign's `day_offsets`. Called once, when the initial DM is marked sent. |
| `cancel_followups(lead, reason)` | Cancels every scheduled step and rejects unsent follow-up drafts. |
| `mark_outreach_sent(...)` | Idempotent. Opens the conversation, logs the outbound message, advances the lead and schedules the sequence on the first send. |
| `approve_outreach(id, by, edited)` / `reject_outreach(...)` | The human decisions. An edited message is stored as the `custom` variation so reporting does not credit the model for a human's rewrite. |
| `set_lead_outcome(lead, outcome, actor, note)` | INTERESTED / NURTURE / NOT_INTERESTED / CLOSED, cancelling follow-ups where that applies. |
| `opt_out(lead, reason)` | Permanent suppression across every current and future campaign. |
| `daily_report(day, campaign)` | Every counter plus the niche/state/angle breakdowns, as one JSON object. |

### The rule the database enforces itself

```sql
create trigger trg_conversation_messages_inbound
  after insert on conversation_messages
  for each row execute function trg_inbound_message();
```

Inserting an inbound message cancels every scheduled follow-up, clears
`next_followup_at`, moves the lead to `REPLIED` and marks the conversation as
awaiting us. It lives in the database because a bug in a workflow must not be
able to message someone who already answered.

## Row level security

The service role (n8n, the reporting job) bypasses RLS. Console operators
authenticate as `authenticated` and can read the pipeline but may only write the
things a human is supposed to decide: approve, reject, mark sent, set an
outcome, opt out, and add notes. `anon` gets nothing.

Never give the console the service-role key. It uses the anon key and RLS.
