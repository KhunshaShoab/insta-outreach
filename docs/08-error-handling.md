# 8. Error handling

The operating rule: **one failed lead must never stop a campaign.** Everything
below follows from that.

## Four layers

**1. The node.** Every HTTP node has a timeout and up to three retries with a
wait between them. That covers a blip.

**2. Classification.** `lib/retry.js → classifyError()` turns a status code or
a thrown error into one of eight types, and decides whether retrying is
sensible at all:

| Type | From | Retried? |
| --- | --- | --- |
| `rate_limit` | 429, "quota", "too many requests" | yes, honouring `Retry-After` |
| `timeout` | 408, `ETIMEDOUT`, aborted | yes |
| `provider_error` | 5xx | yes |
| `network` | `ECONNRESET`, `ENOTFOUND`, socket hang up | yes |
| `ai_schema` | response failed schema validation | yes, once, as a correction turn |
| `auth` | 401, 403 | **no** — retrying a bad key wastes the budget |
| `validation` | 400, 422 | **no** — the request is wrong, not unlucky |
| `unknown` | anything else | no |

Backoff is exponential with full jitter: 2s, 4s, 8s, 16s… capped at five
minutes, or whatever `Retry-After` says.

**3. The failed-item queue.** When the retries are spent, `fail_lead()` writes
an `errors` row with the workflow, node, provider, error type, HTTP status,
payload, retry count and an exponential `next_retry_at`. The lead returns to
its stage with `status = 'ERROR'` and an incremented `retry_count`, and the
batch carries on.

`claim_leads` picks up `ERROR` leads again on the next tick, until
`retry_count` passes the workflow's maximum. After that the lead sits in the
queue for a human — visible, not lost.

**4. Stage isolation.** Each Execute Workflow node in the orchestrator has
`continueOnFail`. A stage that dies is recorded in `workflow_runs.cursor` and
the tick moves on.

## What fails, and what happens

| Failure | Result |
| --- | --- |
| Apify actor times out on one search term | That term's error is logged; the loop continues with the next term. Leads already created are unaffected. |
| Apollo returns 429 | Node retries with backoff; on exhaustion the lead falls through to the website fallback, which is wired as the failure path. |
| Apollo finds nobody | Not an error. The website fallback runs, and the lead proceeds without a named contact. |
| Claude returns prose instead of JSON | The parser builds a correction turn from the validator's error list and re-asks once at temperature 0. |
| Claude fails schema validation twice | The item is dead-lettered with the raw response in `errors.payload`. Nothing partial is written. |
| Reply classification fails | It degrades to `unclear` + `route_to_human` + `requires_human: true`. A reply is never left unattended because a model call failed. |
| The report narrative fails | The report still goes out with the measured figures; the failure appears under `attention`. |
| Instagram webhook signature does not verify | Rejected with 401. Nothing is written. |
| n8n restarts mid-batch | Claims older than 20 minutes are reissued; `resumeStage()` derives the true resume point from timestamps. |
| A whole provider is down | Its stage fails for the tick, other stages keep running, and `errors` shows one provider dominating. |

## Watching it

```sql
-- open errors by type and provider, last 24h
select workflow, provider, error_type, count(*), max(created_at)
from errors
where not resolved and created_at > now() - interval '24 hours'
group by 1, 2, 3
order by count(*) desc;

-- leads stuck at a stage with retries burned
select stage, count(*), max(retry_count) as worst
from leads
where status = 'ERROR'
group by stage;

-- what a specific lead has been through
select created_at, action, detail
from activities
where lead_id = '...'
order by created_at;
```

`errors_open` is on the daily report, and the report prompt is told to put an
error spike first under `attention`, naming the dominant error type and the
provider.

## Re-running work

Everything is idempotent, so the recovery procedure is simply to run it again:

```sql
-- re-qualify a lead after changing the scoring config
update leads set stage = 'ENRICHED', status = 'NEW', retry_count = 0 where id = '...';

-- release a whole stage's stuck items
update leads set status = 'NEW', retry_count = 0
where campaign_id = 'ca-medspas' and status = 'ERROR' and stage = 'QUALIFIED';

-- mark an error row handled
update errors set resolved = true, resolved_at = now(), resolution = 'provider quota raised'
where id = 123;
```

Re-qualifying keeps the previous `qualification_results` row, so you can compare
the verdict before and after a config change instead of guessing.

## What is not handled automatically, on purpose

- **A bad API key** is not retried. It fails fast and loudly.
- **A schema failure after one repair** is not retried forever. Two failures
  mean the prompt or the schema needs a human.
- **An opt-out** is never retried, softened or re-queued. It suppresses the
  business permanently.
