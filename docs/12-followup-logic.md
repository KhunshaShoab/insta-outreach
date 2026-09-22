# 12. Follow-up logic

## The cadence

Default, from `config/followups.default.json`, overridable per campaign:

| Step | Day | Kind | Intent |
| --- | --- | --- | --- |
| 0 | 0 | initial | Open a conversation with one specific observation and one question. |
| 1 | +2 | `followup_1` | Short continuation. Re-approach the same idea in different words. Make replying take five seconds. |
| 2 | +5 | `followup_2` | Give them something new: how comparable businesses handle this, or a second observation about theirs. |
| 3 | +9 | `followup_3_final` | Close the loop respectfully. Acknowledge the timing may be wrong. Ask nothing that takes effort. |

Change the days per campaign:

```json
"followups": {
  "enabled": true,
  "day_offsets": [3, 6, 10],
  "send_window": { "start_hour": 9, "end_hour": 17, "days": [1,2,3,4,5] },
  "timezone": "America/Chicago",
  "require_human_approval": true,
  "rate_limits": { "max_new_dms_per_day": 25, "max_followups_per_day": 35 }
}
```

`npm run validate:config` rejects offsets that do not increase, a first
follow-up on day 0, and a send window whose start is not before its end.

Due dates are moved into the send window, so a step landing on a Sunday evening
goes out Monday morning instead.

## A reply stops everything

This is the guarantee that matters most, so it is enforced three times over.

**1. In the database.** Inserting any inbound message fires
`trg_conversation_messages_inbound`, which cancels every scheduled follow-up,
clears `next_followup_at`, moves the lead to `REPLIED` and marks the
conversation as awaiting us. No workflow bug can bypass it, because no workflow
is involved.

**2. In the queue.** `v_followups_due` excludes any lead with `replied_at` set
or a status in `REPLIED`, `INTERESTED`, `NOT_INTERESTED`, `NURTURE`, `CLOSED`,
`OPTED_OUT`.

**3. In code, before a token is spent.** Workflow 11's Reply Guard re-checks
each lead with `shouldStopSequence()` against a fresh read, then routes
stopped leads to `cancel_followups()` instead of the generator. Cheap, and the
cost of getting it wrong is messaging someone who already answered.

Cancelled steps are kept with `status = 'CANCELLED'` and a reason, so the audit
trail shows what would have gone out and why it did not.

The only exception is an automated away message: the classifier returns
`auto_reply`, which is the one classification that does not set
`stop_followups`. A vacation responder is not a reply from a person.

## Content

Each follow-up is generated against the real thread, including any human edit,
because the edited text is what the prospect actually read.

`prompts/06-followup-message.md` bans "just following up", "circling back",
"bumping this", "in case you missed it", "did you see my message", guilt,
pressure, meeting requests, service lists, emojis, and repeating the first
message's opening. Workflow 11 then checks the output against the same list and
flags anything that slips through, plus over-length messages and emojis.

Every follow-up must state `reason_for_this_followup` — what this message adds
that the last one did not. A follow-up that cannot answer that should not be
sent, and the prompt says so.

Follow-ups go through the same approval queue as first messages.

## Pacing

`applyDailyLimits()` releases only what the campaign allows — `max_new_dms_per_day`
and `max_followups_per_day`, counted against what was actually **sent** today,
not what was queued. Overflow is held for the next release window, never
dropped. The release workflow runs at 09:00, 11:00, 14:00 and 16:00 by default
and carries `min_seconds_between_sends` through to the operator's work item.

## After the final touch

No reply after step 3 means the lead moves to `NURTURE` with
`status = 'NO_RESPONSE'`. It is not deleted and not messaged again by this
sequence. `after_final.nurture_recheck_days` (90) is the interval at which a
nurture sweep can reconsider it — worth revisiting when the business has changed
or a new campaign fits it better.

Interested prospects move to `INTERESTED` and leave the automated path entirely;
from there the conversation is the operator's, assisted by workflow 10.

## Checking it

```sql
-- anyone with a pending follow-up who has already replied: must be empty
select l.public_ref, l.replied_at, f.step, f.due_at
from followups f join leads l on l.id = f.lead_id
where f.status = 'SCHEDULED' and l.replied_at is not null;

-- what is due today
select * from v_followups_due order by due_at;

-- how far the sequence usually gets before a reply
select followup_step, count(*)
from leads where replied_at is not null
group by 1 order by 1;
```

The first query returning rows would mean the guarantee is broken.
`db/tests/lifecycle_test.sql` asserts the same thing: it schedules three
follow-ups, inserts a reply, then checks that zero remain scheduled, three are
cancelled, and nothing is due.
