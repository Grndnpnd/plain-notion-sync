import { Client } from "@notionhq/client";
import { config } from "./config.js";
import { COLUMNS, toNotionProperties, type TicketRow } from "./map.js";

const notion = new Client({ auth: config.notionApiKey });

// ~3 req/s Notion rate limit — space requests ~350ms apart.
let lastRequestAt = 0;
async function throttle(): Promise<void> {
  const wait = lastRequestAt + 350 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

let dataSourceId: string | null = null;

/** Notion API v5: databases contain data sources; queries target the source. */
export async function resolveDataSourceId(): Promise<string> {
  if (dataSourceId) return dataSourceId;
  await throttle();
  const db: any = await notion.databases.retrieve({
    database_id: config.notionDatabaseId,
  });
  const sources = db.data_sources ?? [];
  if (!sources.length) {
    throw new Error("Notion database has no data sources — check NOTION_DATABASE_ID");
  }
  dataSourceId = sources[0].id as string;
  return dataSourceId;
}

// Expected Notion property type per column. Guards against silent failures:
// e.g. Notion's unique_id type silently ignores writes, which would break the
// Ticket ID join key and duplicate the whole board on every run.
const EXPECTED_TYPES: Record<string, string> = {
  [COLUMNS.ticket]: "title",
  [COLUMNS.status]: "select",
  [COLUMNS.completedDate]: "date",
  [COLUMNS.assignee]: "select",
  [COLUMNS.category]: "select",
  [COLUMNS.channel]: "select",
  [COLUMNS.customer]: "rich_text",
  [COLUMNS.description]: "rich_text",
  [COLUMNS.dueSla]: "date",
  [COLUMNS.priority]: "select",
  [COLUMNS.threadLink]: "url",
  [COLUMNS.ticketId]: "rich_text",
  [COLUMNS.engStatus]: "select",
};

/**
 * Verify every synced column exists on the data source with the right type.
 * Exits loudly on mismatch — writing to a wrong-typed property either errors
 * per-page or, worse, silently no-ops (unique_id), so we refuse to run.
 */
export async function validateSchema(): Promise<void> {
  const dsId = await resolveDataSourceId();
  await throttle();
  const ds: any = await notion.dataSources.retrieve({ data_source_id: dsId });
  const props: Record<string, any> = ds.properties ?? {};

  const problems: string[] = [];
  for (const [name, expected] of Object.entries(EXPECTED_TYPES)) {
    const prop = props[name];
    if (!prop) {
      problems.push(`missing property "${name}" (expected type: ${expected})`);
    } else if (prop.type !== expected) {
      problems.push(
        `property "${name}" is type "${prop.type}", expected "${expected}"` +
          ` — change it in Notion via the column menu > Edit property`
      );
    }
  }
  if (problems.length) {
    console.error(`[schema] Notion board schema mismatch:`);
    for (const p of problems) console.error(`[schema]  - ${p}`);
    console.error(`[schema] refusing to run until the board matches the README's property table.`);
    process.exit(1);
  }
}

interface ExistingPage {
  pageId: string;
  row: Partial<TicketRow>;
}

/**
 * Load ALL existing pages keyed by Ticket ID in one paginated sweep.
 * Far cheaper than one query per ticket, and gives us the current values
 * for idempotent diffing.
 */
export async function loadExistingPages(): Promise<
  Map<string, ExistingPage> & { boardHasRows: boolean }
> {
  const dsId = await resolveDataSourceId();
  const out = new Map<string, ExistingPage>() as Map<string, ExistingPage> & {
    boardHasRows: boolean;
  };
  out.boardHasRows = false;
  let cursor: string | undefined = undefined;

  for (;;) {
    await throttle();
    const res: any = await notion.dataSources.query({
      data_source_id: dsId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const page of res.results) {
      out.boardHasRows = true;
      const ticketId = plainTextOf(page.properties?.[COLUMNS.ticketId]);
      if (!ticketId) continue;
      out.set(ticketId, { pageId: page.id, row: extractRow(page.properties) });
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return out;
}

export async function createPage(row: TicketRow): Promise<void> {
  const dsId = await resolveDataSourceId();
  await throttle();
  await notion.pages.create({
    parent: { data_source_id: dsId } as any,
    properties: toNotionProperties(row) as any,
  });
}

export async function updatePage(pageId: string, row: TicketRow): Promise<void> {
  await throttle();
  await notion.pages.update({
    page_id: pageId,
    properties: toNotionProperties(row) as any,
  });
}

/** True if the existing page already matches the row (skip the write). */
export function isUnchanged(existing: Partial<TicketRow>, row: TicketRow): boolean {
  const textKeys: (keyof TicketRow)[] = [
    "ticket", "status", "assignee", "category", "channel",
    "customer", "description", "priority", "threadLink", "engStatus",
  ];
  const dateKeys: (keyof TicketRow)[] = ["completedDate", "dueSla"];
  return (
    textKeys.every((k) => normalize(existing[k]) === normalize(row[k])) &&
    dateKeys.every((k) => sameInstant(existing[k], row[k]))
  );
}

// Notion normalizes date strings (timezone formatting), so compare instants.
function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return normalize(a) === normalize(b);
  return ta === tb;
}

function normalize(v: string | null | undefined): string {
  return (v ?? "").trim();
}

// ---- Notion property value extraction (for diffing) ----

function plainTextOf(prop: any): string | null {
  if (!prop) return null;
  const arr = prop.rich_text ?? prop.title;
  if (!Array.isArray(arr)) return null;
  const s = arr.map((t: any) => t?.plain_text ?? "").join("");
  return s || null;
}

function selectOf(prop: any): string | null {
  return prop?.select?.name ?? null;
}

function dateOf(prop: any): string | null {
  return prop?.date?.start ?? null;
}

function urlOf(prop: any): string | null {
  return prop?.url ?? null;
}

function extractRow(props: any): Partial<TicketRow> {
  return {
    ticket: plainTextOf(props[COLUMNS.ticket]) ?? "",
    status: selectOf(props[COLUMNS.status]) ?? "",
    completedDate: dateOf(props[COLUMNS.completedDate]),
    assignee: selectOf(props[COLUMNS.assignee]),
    category: selectOf(props[COLUMNS.category]),
    channel: selectOf(props[COLUMNS.channel]),
    customer: plainTextOf(props[COLUMNS.customer]),
    description: plainTextOf(props[COLUMNS.description]),
    dueSla: dateOf(props[COLUMNS.dueSla]),
    priority: selectOf(props[COLUMNS.priority]) ?? "",
    threadLink: urlOf(props[COLUMNS.threadLink]) ?? undefined,
    engStatus: selectOf(props[COLUMNS.engStatus]),
  };
}
