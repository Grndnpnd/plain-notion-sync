# plain-notion-sync

One-way daily mirror: Plain support threads → Notion ticket board.

Plain is the source of truth. Notion is a read-only view for visibility —
**manual edits to the 13 synced columns in Notion will be overwritten on the
next run.** Any *other* properties on the pages (e.g. relations to sprint
databases) are never touched.

## Columns synced

Ticket, Status, Completed Date, Assignee, Category, Channel, Customer,
Description, Due / SLA, Priority, Thread Link, Ticket ID, Eng Status.

Property names must match exactly — they're defined in one place,
`COLUMNS` in `src/map.ts`.

Accepted Notion property types (the sync detects and adapts at startup):

| Property | Accepted types |
|---|---|
| Ticket | Title |
| Status | Select, or Notion's native Status (its options must include every value the sync emits: Todo, In Progress, Waiting for Customer, New Reply, Snoozed, Done, Ignored — the API can't create status options, so add missing ones once by hand) |
| Assignee | Select, or People (Plain assignees are matched to workspace members by email, then by name; unmatched assignees stay blank and log a warning) |
| Category | Multi-select (recommended: every Plain label on the thread becomes a tag), or Select (first label only) |
| Channel, Priority, Eng Status | Select |
| Completed Date, Due / SLA | Date |
| Customer, Description | Text |
| Ticket ID | Text (filled with Plain's ticket number, e.g. T-363), or Notion's auto-numbered unique ID — in which case the sync never writes it and the numbers are Notion's row counter, unrelated to Plain's ticket numbers |
| Thread Link | URL |

**Join key:** rows are matched to Plain threads by the thread id embedded in
the Thread Link URL (with a Text Ticket ID as fallback). Don't hand-edit
Thread Link. If multiple pages share a thread id, the oldest is kept and the
rest are archived automatically.

## How it works

Stateless full scan — no database, no watermark, nothing to deploy besides
the service itself. Plain is the source of truth; every run:

1. Fetches all threads via the official `@team-plain/typescript-sdk`,
   cursor-paginated.
2. Enriches each thread with customer name/email and channel
   (`firstInboundMessageInfo.messageSource`) via one raw GraphQL query per
   batch of 50. If Plain's schema ever drifts, this degrades gracefully
   instead of failing the run.
3. Loads all existing Notion rows once, keyed on **Ticket ID** (the immutable
   join key — never edit it).
4. Upserts: create if missing, update if changed, **skip if identical**
   (idempotent — running twice in a row produces zero writes the second time).
   One bad ticket logs and continues; it never aborts the run.
5. Logs a one-line summary:
   `fetched N, created X, updated Y, skipped S, failed Z`.

Notion writes are throttled to ~3 req/s. Because unchanged rows are skipped,
a daily full scan stays fast after the first backfill — the steady-state cost
is Plain pagination reads plus one Notion table sweep. This also self-heals:
a missed or failed run is fully caught up by the next one.

## People-type Assignee and notifications

Writing a people property notifies the person added, same as being assigned
in the UI. With the idempotent diff this only happens when an assignment
actually changes — but the first run after switching Assignee to People
touches every row and notifies everyone at once. Warn the team first, or
keep Assignee as a Select.

## Assignee fallback

Plain unassigns a thread when it's marked done, recording the actor as
`statusChangedBy` instead. For Done threads with no assignee, the Assignee
column falls back to whoever marked it done, so completed tickets still show
who handled them.

## Category & Eng Status mapping

Both are looked up first as a Plain **thread field** by key, then as a
**label** by name prefix:

- Category: thread field key `category`, else a label like `Category: Billing` → `Billing`
- Eng Status: thread field key `eng_status`, else a label like `Eng: In Review` → `In Review`

Adjust via env vars (see `.env.example`) to match how your workspace actually
tags these.

## Due / SLA

Not populated in v1. Plain's SDK thread fragment doesn't expose SLA breach
timestamps; wiring this up needs a raw query against your workspace's SLA
configuration once confirmed the workspace uses tier-based SLAs. The column
is created/cleared but left empty until then.

## Run locally

```bash
npm install
cp .env.example .env   # fill in
npm run typecheck
npm start
```

## Deploy on Railway (daily cron)

1. New service from this repo.
2. Set the env vars from `.env.example` (four values, no database needed).
3. Service settings → **Cron Schedule**: `0 6 * * *` (06:00 UTC daily).
   Start command: `npm start`.
4. The process exits non-zero on total failure so Railway surfaces it.

## Explicitly out of scope (v1)

- Notion → Plain write-back (phase 2)
- Archiving Notion pages when threads are deleted in Plain
- Real-time webhooks
