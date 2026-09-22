# 3. n8n workflow map

Thirteen workflows, one responsibility each. Nothing is a monolith, so a change
to reply handling cannot break discovery, and a failure in enrichment cannot
stop qualification.

```
                       ┌──────────────────────────┐
                       │ 13 Master Orchestrator   │  every 15 min, per campaign
                       └────────────┬─────────────┘
                                    │ runs, in order, each isolated
   ┌───────────┬───────────┬────────┴────┬───────────┬───────────┬──────────┐
   ▼           ▼           ▼             ▼           ▼           ▼          ▼
┌──────┐  ┌────────┐  ┌─────────┐  ┌──────────┐ ┌────────┐ ┌─────────┐ ┌────────┐
│ 01   │  │ 02     │  │ 03      │  │ 04       │ │ 05     │ │ 06      │ │ 08     │
│ find │→ │ clean  │→ │ enrich  │→ │ qualify  │→│research│→│ write   │→│ release│
└──────┘  └────────┘  └─────────┘  └──────────┘ └────────┘ └────┬────┘ └───┬────┘
SCRAPED    CLEANED      ENRICHED     QUALIFIED   RESEARCHED      │          │
                                                                 ▼          ▼
                                                        ┌─────────────┐  human
                                                        │ 07 approval │  sends
                                                        │    API      │  the DM
                                                        └──────┬──────┘
                                                               │ marks it sent
                                                               ▼
                                                          ┌─────────┐
                                                          │ DM_SENT │
                                                          └────┬────┘
                                        reply ◀───────────────┤
                                          │                    │ no reply
                                          ▼                    ▼
                                   ┌─────────────┐      ┌──────────────┐
                                   │ 09 reply    │      │ 11 follow-up │ day 2/5/9
                                   │ processing  │      │ engine       │
                                   └──────┬──────┘      └──────┬───────┘
                                          │                    │ drafts → 07
                                          ▼                    ▼
                                   ┌─────────────┐      ┌──────────────┐
                                   │ 10 response │      │  NURTURE     │
                                   │ assistant   │      └──────────────┘
                                   └──────┬──────┘
                                          ▼
                              INTERESTED / NURTURE / NOT_INTERESTED

                       ┌──────────────────────────┐
                       │ 12 Analytics + report    │  daily 18:00
                       └──────────────────────────┘
```

## What each workflow owns

| # | Workflow | Trigger | Reads | Writes | Leaves the lead at |
| --- | --- | --- | --- | --- | --- |
| 01 | `wf01-lead-discovery` | cron 06:00 weekdays, or the orchestrator | campaign + niche | `companies`, `company_identity_keys`, `leads` | `SCRAPED` |
| 02 | `wf02-clean-dedupe` | every 15 min | `SCRAPED` leads | cleaning flags, drop reasons | `CLEANED` or `DISQUALIFIED` |
| 03 | `wf03-enrichment` | every 15 min | `CLEANED` leads | `contacts`, `leads.contact_id` | `ENRICHED` |
| 04 | `wf04-qualification` | every 15 min | `ENRICHED` leads | `qualification_results`, lead score and band | `QUALIFIED` or `DISQUALIFIED` |
| 05 | `wf05-research` | every 20 min | `QUALIFIED` leads in a researched band | `research` | `RESEARCHED` |
| 06 | `wf06-outreach-generation` | every 20 min | `RESEARCHED` leads | `outreach` (PENDING_REVIEW) | `PENDING_APPROVAL` |
| 07 | `wf07-approval-queue` | webhook | the approval queue | approvals, rejections, sends, outcomes | `READY_FOR_OUTREACH` → `DM_SENT` |
| 08 | `wf08-outreach-log` | cron 09/11/14/16 | `v_send_queue` | releases within the daily cap, logs API sends | `DM_SENT` |
| 09 | `wf09-reply-processing` | webhook | inbound messages | `conversation_messages` + classification | `REPLIED` |
| 10 | `wf10-response-assistant` | called by 09, plus a 2-hourly sweep | the thread + research | `suggested_responses` | `CONVERSATION` |
| 11 | `wf11-followup-engine` | cron 09:00 and 14:00 | `v_followups_due` | follow-up drafts (PENDING_REVIEW) | unchanged, or `NURTURE` after the final touch |
| 12 | `wf12-analytics` | cron 18:00, or on demand | every metric view | `daily_metrics`, optional Sheets mirror | unchanged |
| 13 | `wf13-orchestrator` | every 15 min | active campaigns | `workflow_runs` | drives 01→06, 08, 11 |

## How they hand over

There is no queue between workflows and no message bus. The handover is the
lead's `stage` column:

1. A workflow calls `claim_leads(campaign, stage, limit, worker)`.
2. It does its work.
3. It calls `advance_lead(lead, next_stage, …)` or `fail_lead(…)`.

That has three consequences worth stating:

- **Running a workflow twice is safe.** The second run claims what the first
  did not finish.
- **A workflow can be replaced independently.** Anything that claims at a stage
  and advances past it fits.
- **Nothing is lost when n8n restarts.** Claims expire after 20 minutes and the
  lead is handed out again.

## The orchestrator's tick

Discovery is expensive and rate-limited, so it runs once a day on its own hour.
Every other stage runs on every tick and simply finds nothing to do when its
queue is empty.

Each stage is an Execute Workflow node with `continueOnFail`. A stage that
throws is recorded in `workflow_runs.cursor` and the tick carries on — one
provider outage cannot stop a campaign.

To re-run one stage for one campaign:

```bash
curl -X POST https://n8n.example.com/webhook/optiflow/run \
  -H 'content-type: application/json' \
  -d '{"campaign_id":"ca-medspas","stages":["qualify"]}'
```

## Importing

```bash
npm run build:n8n          # regenerate n8n/workflows/*.json
```

Then import each file in n8n (Workflows → Import from File). Two credentials
must exist first, with these exact names:

- **Supabase Service Role** — HTTP Header Auth
- **Anthropic API Key** — HTTP Header Auth

Everything else comes from environment variables listed in `.env.example`.

Do not edit the JSON by hand. Edit `n8n/src/*.mjs` and rebuild — the build
validates the result and the test suite checks the guarantees.
