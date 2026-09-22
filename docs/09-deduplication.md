# 9. Deduplication

The requirement: **never send the same business into the outreach queue twice.**

Three walls enforce it, each catching what the previous one cannot.

## Wall 1 — in-memory, inside a discovery batch

`lib/dedupe.js → dedupeBatch()` collapses a scraped batch before anything
touches the database. It matches on identity keys in priority order:

```
instagram_handle  →  website_domain  →  place_id  →  phone_e164  →  email  →  name_city
```

Two rules make this behave:

- **A conflict on a strong key means different businesses.** Two rows with
  different Instagram handles are never merged, however similar the names.
- **A name match only counts with a location match.** "Glow Medspa, Austin" and
  "Glow Medspa, Miami" stay separate. The name comparison blends edit distance
  with token overlap and requires 0.92 similarity plus the same city and state.

Names are normalised first (`normalizeBusinessName`): lowercased, punctuation
stripped, legal suffixes and filler removed, so `Glow Med Spa, LLC` and
`glow medspa` produce the same key.

### Merging comes before filtering

Duplicates are merged and *then* cleaned, not the other way round. A sparse
duplicate row often carries the handle or phone number that identifies a richer
copy, and the richer copy often carries the website the sparse one lacks.
`mergeLeads()` fills gaps without ever overwriting a known value with null, and
takes the larger of two follower counts because the bigger observation is the
more complete one.

## Wall 2 — the database, across batches and campaigns

`resolve_company()` is the single entry point for creating a company:

1. Look up every identity key in `company_identity_keys`, strongest first.
2. Fall back to the unique columns on `companies` itself.
3. Create the row only if nothing matched; otherwise merge the new facts into
   gaps.
4. Record **every** key now known, so a future hit on any of them resolves here.

That last step is what makes the system converge. A business first found by
Instagram handle and later by phone number is one company, because the first
discovery recorded the phone number too.

Backing it up, in the schema:

```sql
create unique index uq_companies_ig_handle on companies (instagram_handle) where instagram_handle is not null;
create unique index uq_companies_domain    on companies (website_domain)   where website_domain   is not null;
create unique index uq_companies_phone     on companies (phone_e164)       where phone_e164       is not null;
create unique index uq_companies_name_city on companies (name_normalized, coalesce(city,''), coalesce(state,''))
  where instagram_handle is null and website_domain is null;
```

Link-in-bio aggregators are never identity keys. `linktr.ee`, `beacons.ai`,
`bio.link`, booking platforms and social URLs are rejected by
`normalizeDomain()` — otherwise every brand using Linktree would merge into one
company.

## Wall 3 — the campaign

```sql
unique (campaign_id, company_id)
```

`upsert_lead()` is idempotent, so re-running discovery for a campaign creates no
new leads. The same business *can* exist in two campaigns — a Los Angeles medspa
belongs in both a California campaign and a nationwide one — and each lead is
scored and tracked independently.

To prevent that too, add the company to `suppressions` or set
`block_previously_contacted` in the campaign's hard gates.

## Suppression

Separate from deduplication, and stronger. `suppressions` holds opt-outs and
do-not-contact entries by handle, domain, email, phone or company id, and
`is_suppressed()` is checked in discovery **before a lead row is created**.

`opt_out(lead, reason)` marks the company suppressed, adds suppression rows for
its company id and handle, cancels every scheduled follow-up and moves the lead
to `NOT_INTERESTED` / `OPTED_OUT`. It applies to every current and future
campaign.

## Verifying it

```sql
-- companies reachable by more than one key (the merge working)
select c.name, count(*) as keys
from company_identity_keys k join companies c on c.id = k.company_id
group by c.name having count(*) > 2 order by 2 desc;

-- the same business in more than one campaign, which is allowed
select co.name, count(distinct l.campaign_id) as campaigns
from leads l join companies co on co.id = l.company_id
group by co.name having count(distinct l.campaign_id) > 1;

-- any business contacted twice inside one campaign - must return zero rows
select lead_id, count(*)
from outreach where kind = 'initial' and sent_at is not null
group by lead_id having count(*) > 1;
```

The last query returning rows would mean a real bug. `db/tests/lifecycle_test.sql`
covers the same ground: it discovers one business four different ways and
asserts that exactly one company and one lead exist afterwards.
