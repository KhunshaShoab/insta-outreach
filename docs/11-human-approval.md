# 11. Human approval

Automation does the research and the preparation. A person controls the
communication. That is not a slogan here — it is enforced in four places.

## Where the boundary is

| Enforced by | What it guarantees |
| --- | --- |
| Workflow 06 and 11 | Drafts can only be inserted with `status = 'PENDING_REVIEW'`. Neither workflow contains a path to a sent message. |
| `approve_outreach()` | Only updates rows in `DRAFT` or `PENDING_REVIEW`, and raises otherwise. |
| Workflow 07 | The only workflow that can call `approve_outreach`, and it rejects any request without an operator identity. |
| `tests/workflows.test.mjs` | Asserts on the generated JSON that only wf07 can approve, and only wf07 and wf08 can mark something sent. A future edit that breaks the boundary fails the build. |

## The flow

```
qualified lead → AI research → AI message (3 variations)
      ↓
  OUTREACH QUEUE  (status PENDING_REVIEW)
      ↓
  human review in the console
      ↓
  ┌────────────┬─────────────┬────────────────┬──────────┐
  │  Approve   │  Approve    │   Regenerate   │  Reject  │
  │  as-is     │  with edit  │  (back to 06)  │          │
  └─────┬──────┴──────┬──────┴────────────────┴──────────┘
        ▼             ▼
      status APPROVED, lead READY_FOR_OUTREACH
        ↓
  send queue → the operator sends it in Instagram → Mark as sent
        ↓
  mark_outreach_sent(): conversation opened, message logged,
                        lead DM_SENT, follow-ups scheduled
```

## The API (workflow 07)

`POST /webhook/optiflow/approval/:action`, with the reviewer's identity in an
`x-operator` header. Put n8n header auth in front of it.

| Action | Body | Effect |
| --- | --- | --- |
| `approve` | `{ outreach_id, edited_message? }` | `APPROVED`; the edit becomes the final text and the variation is recorded as `custom`. Lead → `READY_FOR_OUTREACH`. |
| `reject` | `{ outreach_id, reason, regenerate:false }` | `REJECTED`, reason recorded, follow-ups cancelled. |
| `regenerate` | `{ outreach_id, reason }` | Rejects the draft and sends the lead back to `RESEARCHED`, so workflow 06 writes a new one. |
| `mark-sent` | `{ outreach_id, send_mode, external_message_id? }` | Records the send. Idempotent. |
| `outcome` | `{ lead_id, outcome, note? }` | `INTERESTED` / `NURTURE` / `NOT_INTERESTED` / `CLOSED`. |
| `opt-out` | `{ lead_id, reason? }` | Permanent suppression everywhere. |

`GET /webhook/optiflow/queue` returns the queue.

Requests missing an operator, an id, or naming an unknown action are rejected
with 400 before anything is written. An approval with nobody's name on it is
not an approval.

## The console

`apps/approval-console/index.html` — one file, no build step, no dependencies.
Open it locally or serve it from anywhere; point it at your n8n instance and
Supabase in Settings (stored in that browser only, and it uses the anon key, not
the service role).

**Approval queue.** Ordered by priority then ICP score. Each card shows the
business, ICP band, the target contact and why that person, all three message
variations as switchable buttons, an editable textarea with a character
counter, and — behind a disclosure — the research summary, the observations the
writer had, the pain points and the qualification reason. Drafts the guardrails
flagged are marked "needs a look" with the reason.

**Ready to send.** The approved text, a copy button, a link to the profile and
to a new DM. The operator sends it in Instagram and presses **Mark as sent**,
which schedules the follow-up sequence from that moment.

**Conversations.** What the prospect said, its classification, urgency, and the
suggested reply. Copy it, send it, then set the outcome. Opt-out suppresses the
business permanently.

**Dashboard.** Today's measured figures, with per-niche, per-state and
per-angle reply rates shown as measurements rather than a ranking, and segments
under 20 sends flagged as too small to read.

Keyboard: `r` refresh, `a` approve the first card.

## What always needs a person

Beyond first messages and follow-ups, the reply classifier sets
`requires_human: true`, and the response assistant preserves it, for:

- pricing of any kind — the assistant may not state a figure that is not in the
  workflow's `company_facts` object, and that object ships with no numbers;
- objections;
- opt-out requests, which are never given a rebuttal;
- wrong-person redirects;
- not-interested replies;
- anything the model flagged as needing a fact it did not have.

## Turning approval off

`campaign.outreach.require_human_approval` exists, and
`scripts/validate-config.mjs` prints a warning when it is set to false, because
it removes the only barrier between a generated message and a real prospect.
The workflows still write drafts as `PENDING_REVIEW`; disabling approval means
building an auto-approve step of your own. That is a deliberate speed bump.
