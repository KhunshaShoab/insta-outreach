# 13. Operations

## Setting it up

```bash
git clone <repo> && cd insta-outreach
cp .env.example .env            # fill in the keys you have

npm run check                   # lint, build the workflows, run 105 tests
npm run validate:config         # check the campaign and niche configuration
```

**1. Database.** Point `psql` at a fresh Postgres or Supabase project:

```bash
for f in db/migrations/*.sql db/seed/0001_seed.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
node scripts/load-config.mjs --sql | psql "$DATABASE_URL"     # niches + campaigns
```

Verify with `scripts/db-test.sh` against a scratch database — it applies
everything and runs the 36-assertion lifecycle test.

**2. n8n.** Create two HTTP Header Auth credentials, named exactly
**Supabase Service Role** and **Anthropic API Key**. Set the environment
variables from `.env.example` on the n8n instance. Then import each file in
`n8n/workflows/`.

**3. Console.** Open `apps/approval-console/index.html`, press Settings, enter
the n8n base URL, the Supabase URL, the **anon** key and your name.

**4. Dry run, before spending anything.** Switch discovery to the CSV adapter
in `config/providers.json` and the AI capability to `mock`, then run the
pipeline against a handful of rows. Every stage exercises, nothing is scraped
and no tokens are spent.

## Starting a campaign

1. Copy `config/campaigns/california-medspas.json` and edit it: id, name, niche,
   states, cities, follower band, minimum products, `min_icp_score`, daily
   targets, follow-up days.
2. `npm run validate:config`.
3. `node scripts/load-config.mjs --apply` (or `--sql | psql`).
4. Set `status` to `active`.

Nothing else. No code changes, no workflow edits.

To add a niche, append an object to `config/niches.json` with keywords, negative
keywords, search terms, ICP rules, pain points, recommended services and at
least three outreach angles. The validator enforces the minimum.

## The daily run

| Time | What happens | Who |
| --- | --- | --- |
| 06:00 | Discovery for each active campaign | automatic |
| every 15 min | Clean → enrich → qualify → research → generate | automatic |
| 09:00, 11:00, 14:00, 16:00 | Approved messages released within the daily cap | automatic |
| through the day | **Review the queue. Approve, edit or reject.** | you |
| through the day | **Send approved DMs in Instagram, mark them sent.** | you |
| 09:00, 14:00 | Due follow-ups drafted into the queue | automatic |
| on reply | Reply logged, sequence stopped, classified, reply drafted | automatic |
| through the day | **Review suggested replies, send, set outcomes.** | you |
| 18:00 | Daily report | automatic |

Your part is the reviewing and the sending. Everything before and after is not.

A realistic daily shape for one campaign at the default settings: about 100
businesses discovered, 30-45 surviving cleaning and qualification, 30 messages
approved and sent, follow-ups on top. The caps exist so a backlog turns into a
longer queue rather than a burst of activity on one account.

## The daily report

```bash
node scripts/daily-report.mjs                 # today, all campaigns
node scripts/daily-report.mjs 2026-09-21 ca-medspas
node scripts/daily-report.mjs --rank-by=reply_rate
```

Workflow 12 produces the same figures at 18:00 and can post them to
`OPERATOR_WEBHOOK_URL`.

It reports: leads discovered, enriched, evaluated and qualified; the
qualification rate; messages generated, approved and sent; replies and reply
rate; positive replies; follow-ups due; interested, nurture and not-interested
totals; open errors. Then reply rates by niche, by state and by outreach angle,
the reply categories seen, and the objections seen.

**It does not name a best niche, state or angle.** It shows the measured rates
and marks any segment with fewer than 20 sends as too small to read, because a
4% reply rate from 3 replies out of 71 is a number, and "pet brands are our best
niche" from the same data is a guess. Pass `--rank-by=<metric>` when you want an
ordering, and it will say which metric it used.

## Reading the numbers honestly

| Measure | What it actually tells you | The trap |
| --- | --- | --- |
| Qualification rate | Whether discovery is finding the right businesses | A very high rate usually means the ICP is too loose, not that discovery is excellent |
| Reply rate | Whether the messages land | Needs 100+ sends per segment before it means anything |
| Positive reply rate | Whether they land with the right people | More stable than the raw reply rate |
| By angle | Which framing resonates | The angle is confounded with the niche; compare within one niche |
| By variation | Conversational vs professional vs concise | Human edits are recorded as `custom`, so the model does not get credit for a rewrite |

Give a change at least a week and a few hundred sends before concluding
anything from it.

## Routine checks

```sql
-- is anything stuck?
select stage, status, count(*) from leads group by 1, 2 order by 3 desc;

-- open errors by provider
select provider, error_type, count(*) from errors where not resolved group by 1, 2;

-- approval backlog
select campaign_id, count(*) from v_approval_queue group by 1;

-- the guarantee: nobody who replied still has a follow-up scheduled
select count(*) from followups f join leads l on l.id = f.lead_id
where f.status = 'SCHEDULED' and l.replied_at is not null;   -- must be 0
```

## Changing something safely

| Change | Where | Then |
| --- | --- | --- |
| Follower band, score threshold, cities, follow-up days | `config/campaigns/*.json` | `validate:config`, `load-config --apply` |
| Scoring weights or bands | `config/scoring.default.json` | same; re-qualify leads by moving them back to `ENRICHED` |
| Filtering rules | `config/cleaning.json` | `npm run build:n8n` (inlined into wf02) |
| A prompt | `prompts/*.md`, bump its version | `npm test && npm run build:n8n` |
| A provider | `config/providers.json` + an adapter | `npm test` |
| Pipeline logic | `lib/*.js` | `npm run check`, then re-import the affected workflows |
| A workflow | `n8n/src/*.mjs` | `npm run build:n8n`, re-import |

Never edit `n8n/workflows/*.json` directly. It is build output; the next build
overwrites it.

## Things worth knowing before they surprise you

- **Discovery is the expensive stage.** Test with the CSV adapter.
- **Enrichment misses founders constantly.** That is expected, and a lead
  without a named contact is still worth messaging.
- **The first week's reply rate is noise.** Resist tuning on it.
- **An edited message is recorded as `custom`.** If most approvals involve edits,
  the prompt needs work — that signal is in `v_performance_by_variation`.
- **Opt-outs are permanent and global.** There is no undo, deliberately.
