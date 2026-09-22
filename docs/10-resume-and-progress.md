# 10. Resume and progress

A workflow failing must never restart a campaign. Progress is stored per lead,
so recovery means continuing, not repeating.

## Every lead knows where it is

```sql
select stage, status, last_completed_step, retry_count, last_error, last_execution_id
from leads where public_ref = 182;
```

| Column | Meaning |
| --- | --- |
| `stage` | Where the lead is in the pipeline |
| `status` | `NEW`, `PROCESSING`, `ERROR`, `PENDING_REVIEW`, `APPROVED`, `SENT`, … |
| `last_completed_step` | The specific step that last succeeded, e.g. `enrich.contacts` |
| `retry_count` | Consecutive failures at the current stage |
| `last_error`, `last_error_at` | The most recent failure |
| `last_execution_id` | The n8n execution that last touched it |
| per-step timestamps | `cleaned_at`, `enriched_at`, `qualified_at`, `researched_at`, `message_generated_at`, `approved_at`, `first_sent_at`, `replied_at` |

`v_lead_progress` turns that into the checklist:

```
Lead 182
  Scraped           ✓
  Cleaned           ✓
  Enriched          ✓
  Qualified         ✓   (ICP 89, HIGH_PRIORITY)
  AI Research       ✓
  Message Generated ✓
  Approved          ·   ← waiting on a human
  Sent              ·
  Replied           ·
```

## Claiming, and how a crash recovers

```sql
select * from claim_leads('ca-medspas', 'ENRICHED', 25, 'wf04-qualification', 20, 3);
```

- `FOR UPDATE SKIP LOCKED` means two parallel executions never receive the same
  lead.
- Claimed leads are set to `PROCESSING` with `claimed_by` and `claimed_at`.
- **A claim older than `p_stale_minutes` (20) is treated as abandoned and
  reissued.** This is the crash recovery: n8n dies mid-batch, and twenty minutes
  later those leads are picked up by the next tick. No manual intervention, no
  lost leads, no restart of the campaign.
- Leads whose `retry_count` exceeds `p_max_retries` are not handed out again;
  they wait for a person.

## The resume point is derived, not trusted

`lib/stages.js → resumeStage(lead)` computes where a lead should continue from
its timestamps rather than its `status` column:

```js
resumeStage({})                                             // 'CLEANED'
resumeStage({ cleaned_at: t })                              // 'ENRICHED'
resumeStage({ cleaned_at: t, enriched_at: t, qualified_at: t, qualified: true })
                                                            // 'RESEARCHED'
resumeStage({ ..., qualified: false })                      // null - do not resume
```

Timestamps only exist when the work actually finished. A status column can be
left stale by a crash; a timestamp cannot be set by one.

## Stages never move backwards

`advance_lead()` compares positions in `lead_stages` and refuses to rewind. A
workflow that runs late — advancing a lead to `CLEANED` after another already
moved it to `ENRICHED` — is a no-op rather than a corruption.

The same guarantee is in `lib/stages.js → canAdvance()` for the code path.

## Run-level bookkeeping

`workflow_runs` records each execution: workflow, campaign, execution id,
status (`RUNNING` / `SUCCESS` / `PARTIAL` / `FAILED`), items in, ok and failed,
and a `cursor` JSON blob. The orchestrator stores per-stage outcomes there, so
after a bad night you can see exactly which stage failed and for which campaign:

```sql
select workflow, status, items_ok, items_failed, cursor->'stages'
from workflow_runs
where started_at > now() - interval '1 day'
order by started_at desc;
```

Discovery also records a cursor (`last_search_term`, `term_index`), so a partial
discovery run tells you how far through the search-term matrix it got.

## Re-running deliberately

Because every step is idempotent, redoing work is just moving the stage back:

```sql
-- re-qualify one lead after a scoring change (the old verdict is kept)
update leads set stage = 'ENRICHED', status = 'NEW', retry_count = 0, qualified_at = null
where id = '...';

-- regenerate a message the reviewer did not like: the console's Reject
-- (regenerate) button does exactly this
select reject_outreach('<outreach id>', 'user:ops@optiflow.test', 'too generic', true);

-- re-run one stage for one campaign
-- POST /webhook/optiflow/run  {"campaign_id":"ca-medspas","stages":["qualify"]}
```

Nothing is overwritten: `qualification_results`, `research` and `outreach` keep
every prior row, each stamped with its model and prompt version.

## The one thing that is never resumed

A sent message. `mark_outreach_sent()` is idempotent and returns the existing
row rather than sending again, and `unique(lead_id, kind)` on `outreach` (for
non-rejected rows) means a second initial DM cannot be created for a lead. The
worst outcome of a crash is a message that was sent but not recorded — which
the operator fixes with "Mark as sent" — never a prospect messaged twice.
