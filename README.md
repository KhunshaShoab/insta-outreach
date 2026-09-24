# OptiFlow Instagram Outbound Engine

An AI-assisted Instagram prospecting and outreach system for OptiFlow Solutions,
a BPO and customer-experience outsourcing company.

It finds businesses that plausibly need customer support help, works out whether
they are worth talking to and why, works out what to say to each one
specifically, and hands a person a message to send.

```
DISCOVER → CLEAN → DEDUPE → ENRICH → QUALIFY → SCORE → DECISION MAKER
  → RESEARCH → PERSONALISE → HUMAN APPROVAL → SEND → REPLY → CLASSIFY
  → ASSIST → FOLLOW UP → NURTURE / INTERESTED / NOT INTERESTED
```

There is no call flow, no voice agent and no appointment handling. This is an
Instagram outbound system.

## The two things worth knowing first

**The ICP score is computed in code, not by the model.** Claude returns
judgement sub-scores — business quality, likely CX need, outreach potential,
niche fit, website quality — and `lib/scoring.js` blends them with measured
facts (follower band, product count, location, activity, decision-maker
availability) using configured weights. Two identical leads always score
identically, and `explainScore()` can justify every point. A score nobody can
explain is not worth having.

**Nothing is sent automatically.** The official Instagram Messaging API cannot
start a conversation with someone who has not messaged you first, and this
system does not try to route around that: no browser automation, no rate-limit
evasion, no fake accounts. Generated messages enter a queue as
`PENDING_REVIEW`; a person reviews, edits and sends them, and the system records
what was sent. Replies come in through the official webhook or are pasted into
the console, and both take the identical downstream path.

What *is* automated is the expensive part: finding, qualifying, researching,
personalising, queueing, tracking, following up and analysing.

## Two ways to use this

**V1 Lead Intelligence Engine** - you have a lead list and want qualified,
researched, message-ready leads in a spreadsheet. One command, no database, no
n8n, no accounts beyond an optional Claude key:

Either import `n8n/workflows/wf14-v1-lead-intelligence.json` and upload the file
to a form, or run it from the command line:

```bash
node scripts/v1.mjs --inspect ~/Downloads/leads.xlsx   # what is in the file
node scripts/v1.mjs --file ~/Downloads/leads.xlsx --limit 15
```

It reads the file, deduplicates, checks each business is really in your niche,
reads their websites, finds their Instagram, scores them for customer-support
and AI-voice fit with the evidence attached, recommends one service or none, and
writes a DM for the ones that earn it. Everything lands in a CSV with
`review_status = PENDING`. See [docs/14](docs/14-v1-lead-intelligence.md).

**The full campaign engine** - continuous discovery, an approval queue, reply
handling and follow-up sequences, orchestrated in n8n:

```bash
npm run check              # lint, build the 13 workflows, run the test suite
npm run validate:config    # check campaigns and niches are consistent
scripts/db-test.sh         # apply the schema to a scratch DB and run the lifecycle test
```

Full setup is in [docs/13-operations.md](docs/13-operations.md).

## Layout

```
config/       niches, campaigns, scoring, cleaning rules, follow-up cadence,
              provider registry, V1 settings  ← no ICP value lives elsewhere
lib/v1/       V1 engine: dependency-free XLSX reader, ingest, dedupe,
              relevance, website research, Instagram discovery, signals,
              scoring, offer recommendation, CSV output
lib/          pure logic: normalise, dedupe, score, rank contacts, pick angles,
              schedule follow-ups, classify errors, render prompts, validate JSON
lib/providers/ swappable adapters: Apify, Apollo, website scrape, Claude, mock,
              Supabase, Postgres, Sheets, Instagram (manual + Graph API), CSV
prompts/      the ten production prompts, with ROLE / INPUT / TASK / RULES /
              OUTPUT / SCHEMA / EDGE CASES
schemas/      the JSON contract for every AI output
db/           migrations, views, functions, RLS, and a 36-assertion lifecycle test
n8n/src/      workflow definitions
n8n/workflows/ generated, importable workflow JSON
apps/         the operator console (single file, no build step)
scripts/      lint, build docs, load config, validate config, daily report, db test
tests/        105 tests
docs/         thirteen documents, indexed in docs/README.md
```

## How the pieces fit

The database is the source of truth and the handover point. A workflow claims
leads at a stage with `claim_leads()` (`FOR UPDATE SKIP LOCKED`, with abandoned
claims reissued after 20 minutes), does its work, and calls `advance_lead()` or
`fail_lead()`. That is why running a workflow twice is safe, why a crash resumes
instead of restarting, and why any stage can be replaced independently.

The n8n Code nodes do not contain copies of the logic. `npm run build:n8n`
inlines the `lib/` source and the prompt files into them, so the code running in
production is the code the test suite exercises. `tests/workflows.test.mjs` then
asserts on the generated JSON that the guarantees still hold — only the approval
API can approve a message, only it and the release workflow can mark one sent,
the reply webhook verifies its signature, the follow-up engine checks for a
reply before spending a token, and no credential is baked into the output.

## Configuration, not code

Everything the brief called "must be configurable" is a JSON file:

| Want to change | Edit |
| --- | --- |
| Follower band, minimum products, ICP threshold, target states and cities | `config/campaigns/*.json` |
| Scoring weights, curves, bands, hard gates, penalties | `config/scoring.default.json` |
| Niches: keywords, search terms, pain points, outreach angles | `config/niches.json` |
| What gets filtered out (personal accounts, competitors, agencies) | `config/cleaning.json` |
| Follow-up days, send windows, daily caps | `config/followups.default.json` or the campaign |
| Which scraper, enrichment provider, model, datastore or mirror | `config/providers.json` |

Then `npm run validate:config` and `node scripts/load-config.mjs --apply`.

Ships with 15 niches (medspas, dental clinics, pet brands, women's bags, home
robots, comfort wear, and nine more), three example campaigns, and an initial
ICP of 1,000-10,000 followers with more than two products or services — every
value of which is overridable per campaign.

## Status

| Layer | State |
| --- | --- |
| Database schema, views, functions, RLS | Applied and tested on PostgreSQL 16; 36 lifecycle assertions pass |
| Logic layer | 105 tests pass, including an end-to-end run from raw CSV rows to approval-ready drafts |
| n8n workflows | 13 generated and validated; import and add credentials to run |
| Prompts and schemas | 10 prompts, 11 schemas, structurally enforced by tests |
| Operator console | Functional against a live database and the approval API |
| Live provider calls | Not exercised here — no API keys in this environment. The adapters are written against each provider's documented API and every response passes through the same validation and error handling as the tested paths. |

## Documentation

Start with [docs/01-architecture.md](docs/01-architecture.md), or jump to the
[index](docs/README.md).
