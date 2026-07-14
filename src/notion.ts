import { Client } from "@notionhq/client";
import { config } from "./config.js";
import {
  COLUMNS,
  STATUS_LABELS,
  threadIdFromUrl,
  type BoardSchema,
  type TicketRow,
} from "./map.js";

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

// Accepted Notion types per column. Where several are listed, the writer
// adapts (see BoardSchema). unique_id Ticket ID is accepted but never
// written — Notion auto-numbers it and the API can't set it.
const ACCEPTED_TYPES: Record<string, string[]> = {
  [COLUMNS.ticket]: ["title"],
  [COLUMNS.status]: ["select", "status"],
  [COLUMNS.completedDate]: ["date"],
  [COLUMNS.assignee]: ["select", "people"],
  [COLUMNS.category]: ["select"],
  [COLUMNS.channel]: ["select"],
  [COLUMNS.customer]: ["rich_text"],
  [COLUMNS.description]: ["rich_text"],
  [COLUMNS.dueSla]: ["date"],
  [COLUMNS.priority]: ["select"],
  [COLUMNS.threadLink]: ["url"],
  [COLUMNS.ticketId]: ["rich_text", "unique_id"],
  [COLUMNS.engStatus]: ["select"],
};

/**
 * Verify every synced column exists with a supported type, and detect which
 * variant the board uses. For a status-type Status, also verify every value
 * the sync emits exists as an option (the API can't create status options).
 */
export async function detectAndValidateSchema(): Promise<BoardSchema> {
  const dsId = await resolveDataSourceId();
  await throttle();
  const ds: any = await notion.dataSources.retrieve({ data_source_id: dsId });
  const props: Record<string, any> = ds.properties ?? {};

  const problems: string[] = [];
  for (const [name, accepted] of Object.entries(ACCEPTED_TYPES)) {
    const prop = props[name];
    if (!prop) {
      problems.push(`missing property "${name}" (accepted: ${accepted.join(" or ")})`);
    } else if (!accepted.includes(prop.type)) {
      problems.push(
        `property "${name}" is type "${prop.type}", accepted: ${accepted.join(" or ")}`
      );
    }
  }

  const statusType = props[COLUMNS.status]?.type === "status" ? "status" : "select";
  const statusMap: Record<string, string> = {};
  if (statusType === "status") {
    const options: string[] = (props[COLUMNS.status]?.status?.options ?? []).map(
      (o: any) => o.name
    );
    const byLower = new Map(options.map((o) => [o.toLowerCase(), o]));
    const resolve = (label: string): string | null =>
      byLower.get(label.toLowerCase()) ?? null;

    const unresolved: string[] = [];
    for (const label of STATUS_LABELS) {
      const direct = resolve(label);
      if (direct) {
        statusMap[label] = direct;
        continue;
      }
      const alias = config.statusAliases[label];
      const viaAlias = alias ? resolve(alias) : null;
      if (viaAlias) {
        statusMap[label] = viaAlias;
        continue;
      }
      unresolved.push(label);
    }
    for (const [label, target] of Object.entries(statusMap)) {
      if (label !== target) console.log(`[schema] status "${label}" -> board option "${target}"`);
    }
    if (unresolved.length) {
      problems.push(
        `Status is a status-type property with no option matching: ` +
          unresolved.map((m) => `"${m}"`).join(", ") +
          ` (case-insensitive). Either add the option(s) in Notion, or map ` +
          `them to existing options via PLAIN_STATUS_ALIASES, e.g. ` +
          `PLAIN_STATUS_ALIASES="${unresolved[0]}=Todo"`
      );
    }
  }

  if (problems.length) {
    console.error(`[schema] Notion board schema mismatch:`);
    for (const p of problems) console.error(`[schema]  - ${p}`);
    console.error(`[schema] refusing to run until the board is compatible.`);
    process.exit(1);
  }

  const schema: BoardSchema = {
    statusType,
    assigneeType: props[COLUMNS.assignee]?.type === "people" ? "people" : "select",
    ticketIdWritable: props[COLUMNS.ticketId]?.type === "rich_text",
    statusMap,
  };
  console.log(
    `[schema] ok — status: ${schema.statusType}, assignee: ${schema.assigneeType}, ` +
      `ticket id ${schema.ticketIdWritable ? "written" : "auto-numbered (join via Thread Link)"}`
  );
  return schema;
}

// ---- Workspace users (for people-type Assignee) ----

export interface PersonResolver {
  resolve: (row: TicketRow) => string | null;
}

/**
 * Load workspace members and return a resolver matching Plain assignees to
 * Notion user ids — by email first, then by full name (case-insensitive).
 * Unmatched assignees log once and stay empty on the board.
 */
export async function buildPersonResolver(
  schema: BoardSchema
): Promise<PersonResolver> {
  if (schema.assigneeType !== "people") {
    return { resolve: () => null };
  }
  const byEmail = new Map<string, string>();
  const byName = new Map<string, string>();
  let cursor: string | undefined = undefined;

  for (;;) {
    await throttle();
    const res: any = await notion.users.list({
      start_cursor: cursor,
      page_size: 100,
    });
    for (const u of res.results) {
      if (u.type !== "person") continue;
      if (u.person?.email) byEmail.set(u.person.email.toLowerCase(), u.id);
      if (u.name) byName.set(u.name.toLowerCase(), u.id);
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  console.log(`[users] loaded ${byName.size} workspace member(s) for assignee matching`);

  const warned = new Set<string>();
  return {
    resolve: (row: TicketRow) => {
      if (!row.assignee && !row.assigneeEmail) return null;
      const id =
        (row.assigneeEmail && byEmail.get(row.assigneeEmail.toLowerCase())) ||
        (row.assignee && byName.get(row.assignee.toLowerCase())) ||
        null;
      if (!id) {
        const key = row.assignee ?? row.assigneeEmail ?? "";
        if (!warned.has(key)) {
          warned.add(key);
          console.warn(
            `[users] no Notion member matches Plain assignee "${key}" — leaving blank`
          );
        }
      }
      return id;
    },
  };
}

// ---- Existing pages ----

interface ExistingPage {
  pageId: string;
  createdTime: string;
  row: Partial<TicketRow>;
  assigneePersonId: string | null; // people mode: current person on the page
}

export interface ExistingPages {
  pages: Map<string, ExistingPage>; // keyed by Plain thread id
  boardHasRows: boolean;
  duplicates: ExistingPage[]; // extra pages sharing a thread id (newest kept out)
}

/**
 * Load ALL existing pages in one paginated sweep, keyed by the Plain thread
 * id extracted from the Thread Link URL (falling back to a rich_text
 * Ticket ID). When several pages share a thread id, the oldest is kept and
 * the rest are reported as duplicates for archiving.
 */
export async function loadExistingPages(): Promise<ExistingPages> {
  const dsId = await resolveDataSourceId();
  const pages = new Map<string, ExistingPage>();
  const duplicates: ExistingPage[] = [];
  let boardHasRows = false;
  let cursor: string | undefined = undefined;

  for (;;) {
    await throttle();
    const res: any = await notion.dataSources.query({
      data_source_id: dsId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const page of res.results) {
      boardHasRows = true;
      const legacyId = plainTextOf(page.properties?.[COLUMNS.ticketId]);
      const key =
        threadIdFromUrl(urlOf(page.properties?.[COLUMNS.threadLink])) ??
        (legacyId?.startsWith("th_") ? legacyId : null);
      if (!key) continue;
      const entry: ExistingPage = {
        pageId: page.id,
        createdTime: page.created_time,
        row: extractRow(page.properties),
        assigneePersonId:
          page.properties?.[COLUMNS.assignee]?.people?.[0]?.id ?? null,
      };
      const existing = pages.get(key);
      if (!existing) {
        pages.set(key, entry);
      } else if (entry.createdTime < existing.createdTime) {
        duplicates.push(existing);
        pages.set(key, entry);
      } else {
        duplicates.push(entry);
      }
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return { pages, boardHasRows, duplicates };
}

/** Archive a page (used to clean up duplicate rows). */
export async function archivePage(pageId: string): Promise<void> {
  await throttle();
  await notion.pages.update({ page_id: pageId, archived: true });
}

export async function createPage(
  row: TicketRow,
  schema: BoardSchema,
  resolver: PersonResolver
): Promise<void> {
  const dsId = await resolveDataSourceId();
  const { toNotionProperties } = await import("./map.js");
  await throttle();
  await notion.pages.create({
    parent: { data_source_id: dsId } as any,
    properties: toNotionProperties(row, schema, resolver.resolve) as any,
  });
}

export async function updatePage(
  pageId: string,
  row: TicketRow,
  schema: BoardSchema,
  resolver: PersonResolver
): Promise<void> {
  const { toNotionProperties } = await import("./map.js");
  await throttle();
  await notion.pages.update({
    page_id: pageId,
    properties: toNotionProperties(row, schema, resolver.resolve) as any,
  });
}

/** True if the existing page already matches the row (skip the write). */
export function isUnchanged(
  existing: ExistingPage,
  row: TicketRow,
  schema: BoardSchema,
  resolver: PersonResolver
): boolean {
  const textKeys: (keyof TicketRow)[] = [
    "ticket", "category", "channel",
    "customer", "description", "priority", "threadLink", "engStatus",
  ];
  const dateKeys: (keyof TicketRow)[] = ["completedDate", "dueSla"];

  const assigneeMatches =
    schema.assigneeType === "people"
      ? (existing.assigneePersonId ?? null) === resolver.resolve(row)
      : normalize(existing.row.assignee) === normalize(row.assignee);

  const ticketIdMatches =
    !schema.ticketIdWritable ||
    normalize(existing.row.ticketRef) === normalize(row.ticketRef);

  // Status is compared on the value actually written to the board.
  const targetStatus =
    schema.statusType === "status"
      ? schema.statusMap[row.status] ?? row.status
      : row.status;
  const statusMatches = normalize(existing.row.status) === normalize(targetStatus);

  return (
    assigneeMatches &&
    statusMatches &&
    ticketIdMatches &&
    textKeys.every((k) =>
      normalize(existing.row[k] as string | null | undefined) ===
      normalize(row[k] as string | null)
    ) &&
    dateKeys.every((k) =>
      sameInstant(
        existing.row[k] as string | null | undefined,
        row[k] as string | null
      )
    )
  );
}

function normalize(v: string | null | undefined): string {
  return (v ?? "").trim();
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

// ---- Notion property value extraction (for diffing) ----

function plainTextOf(prop: any): string | null {
  if (!prop) return null;
  const arr = prop.rich_text ?? prop.title;
  if (!Array.isArray(arr)) return null;
  const s = arr.map((t: any) => t?.plain_text ?? "").join("");
  return s || null;
}

function selectOf(prop: any): string | null {
  return prop?.select?.name ?? prop?.status?.name ?? null;
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
    ticketRef: plainTextOf(props[COLUMNS.ticketId]) ?? undefined,
    threadLink: urlOf(props[COLUMNS.threadLink]) ?? undefined,
    engStatus: selectOf(props[COLUMNS.engStatus]),
  };
}
