import { config } from "./config.js";
import type { PlainThread, ThreadEnrichment } from "./plain.js";

// Notion column names — must match the database properties exactly.
export const COLUMNS = {
  ticket: "Ticket",
  status: "Status",
  completedDate: "Completed Date",
  assignee: "Assignee",
  category: "Category",
  channel: "Channel",
  customer: "Customer",
  description: "Description",
  dueSla: "Due / SLA",
  priority: "Priority",
  threadLink: "Thread Link",
  ticketId: "Ticket ID",
  engStatus: "Eng Status",
} as const;

/** Detected board schema — the writer adapts to these. */
export interface BoardSchema {
  statusType: "select" | "status";
  assigneeType: "select" | "people";
  categoryType: "select" | "multi_select";
  ticketIdWritable: boolean; // false when the column is Notion's unique_id
  // status-type only: sync label -> exact board option name (resolved at
  // startup via case-insensitive matching and PLAIN_STATUS_ALIASES).
  statusMap: Record<string, string>;
}

/** Every status value the sync can emit (needed to validate status-type options). */
export const STATUS_LABELS = [
  "Todo",
  "In Progress",
  "Waiting for Customer",
  "New Reply",
  "Snoozed",
  "Done",
  "Ignored",
] as const;

const PRIORITY_LABELS: Record<number, string> = {
  0: "Urgent",
  1: "High",
  2: "Normal",
  3: "Low",
};

const CHANNEL_LABELS: Record<string, string> = {
  EMAIL: "Email",
  CHAT: "Chat",
  SLACK: "Slack",
  MS_TEAMS: "MS Teams",
  API: "API",
};

/** Human-readable status from status + statusDetail. */
function statusLabel(thread: PlainThread): string {
  const detail = thread.statusDetail?.__typename ?? "";
  const map: Record<string, string> = {
    ThreadStatusDetailCreated: "Todo",
    ThreadStatusDetailNewReply: "New Reply",
    ThreadStatusDetailInProgress: "In Progress",
    ThreadStatusDetailWaitingForCustomer: "Waiting for Customer",
    ThreadStatusDetailWaitingForDuration: "Snoozed",
    ThreadStatusDetailSnoozed: "Snoozed",
    ThreadStatusDetailDoneManuallySet: "Done",
    ThreadStatusDetailDoneAutomaticallySet: "Done",
    ThreadStatusDetailIgnored: "Ignored",
    ThreadStatusDetailThreadDiscussionResolved: "Done",
  };
  if (detail in map) return map[detail];
  const s = String(thread.status);
  const fallback: Record<string, string> = {
    TODO: "Todo",
    SNOOZED: "Snoozed",
    DONE: "Done",
  };
  return fallback[s] ?? "Todo";
}

/** All label names matching a prefix (stripped), plus a thread-field value. */
function categoriesFor(thread: PlainThread): string[] {
  const out: string[] = [];
  const field = thread.threadFields.find(
    (f) => f.key === config.categoryFieldKey
  );
  if (field?.stringValue) out.push(field.stringValue);
  for (const l of thread.labels) {
    if (!l.labelType.name.startsWith(config.categoryLabelPrefix)) continue;
    const name = l.labelType.name.slice(config.categoryLabelPrefix.length).trim();
    if (name) out.push(name);
  }
  return [...new Set(out)];
}

/** Pull a value from thread fields by key, else from labels by name prefix. */
function fieldOrLabel(
  thread: PlainThread,
  fieldKey: string,
  labelPrefix: string
): string | null {
  const field = thread.threadFields.find((f) => f.key === fieldKey);
  if (field?.stringValue) return field.stringValue;
  if (field?.booleanValue !== null && field?.booleanValue !== undefined) {
    return String(field.booleanValue);
  }
  const label = thread.labels.find((l) =>
    l.labelType.name.startsWith(labelPrefix)
  );
  if (label) return label.labelType.name.slice(labelPrefix.length).trim();
  return null;
}

/** ALL values: thread field (if set) plus every label matching the prefix. */
function fieldAndLabels(
  thread: PlainThread,
  fieldKey: string,
  labelPrefix: string
): string[] {
  const out: string[] = [];
  const field = thread.threadFields.find((f) => f.key === fieldKey);
  if (field?.stringValue) out.push(field.stringValue);
  for (const l of thread.labels) {
    if (!l.labelType.name.startsWith(labelPrefix)) continue;
    const v = l.labelType.name.slice(labelPrefix.length).trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

function threadUrl(threadId: string): string {
  return config.threadUrlTemplate
    .replace("{workspaceId}", config.plainWorkspaceId)
    .replace("{threadId}", threadId);
}

/** Extract a Plain thread id (th_...) from a Thread Link URL. */
export function threadIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/th_[A-Za-z0-9]+/);
  return m ? m[0] : null;
}

/**
 * Plain-value view of a ticket row. Used both to build Notion properties and
 * to diff against the existing page for idempotent updates.
 */
export interface TicketRow {
  ticket: string;
  status: string;
  completedDate: string | null; // ISO date
  assignee: string | null; // display name
  assigneeEmail: string | null; // used for people-property matching
  categories: string[];
  channel: string | null;
  customer: string | null;
  description: string | null;
  dueSla: string | null; // ISO date — not populated in v1 (see README)
  priority: string;
  threadLink: string;
  ticketId: string; // Plain thread id (join key)
  ticketRef: string; // Plain's human-facing ticket number, e.g. T-363
  engStatus: string | null;
}

export function toRow(
  thread: PlainThread,
  enrich: ThreadEnrichment | undefined
): TicketRow {
  const isDone = String(thread.status) === "DONE";

  // Plain unassigns the thread when it's marked done, but records who did it.
  // Fall back to that actor so completed tickets still show who handled them.
  const assigned =
    thread.assignedTo && "fullName" in thread.assignedTo
      ? thread.assignedTo
      : null;
  const assignee =
    assigned?.fullName ?? (isDone ? enrich?.statusChangedByName ?? null : null);
  const assigneeEmail =
    (assigned && "email" in assigned ? assigned.email : null) ??
    (isDone ? enrich?.statusChangedByEmail ?? null : null);

  const rawChannel = enrich?.channel ?? null;
  const description = (thread.previewText ?? thread.description ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

  return {
    ticket: thread.title || thread.ref,
    status: statusLabel(thread),
    completedDate: isDone ? thread.statusChangedAt.iso8601 : null,
    assignee,
    assigneeEmail,
    categories: categoriesFor(thread),
    channel: rawChannel ? CHANNEL_LABELS[rawChannel] ?? rawChannel : null,
    customer: enrich?.customerName ?? enrich?.customerEmail ?? null,
    description: description || null,
    dueSla: null,
    priority: PRIORITY_LABELS[thread.priority] ?? `P${thread.priority}`,
    threadLink: threadUrl(thread.id),
    ticketId: thread.id,
    ticketRef: thread.ref,
    engStatus: fieldOrLabel(
      thread,
      config.engStatusFieldKey,
      config.engStatusLabelPrefix
    ),
  };
}

/**
 * Build the Notion properties payload for a row, adapted to the board schema.
 * `resolvePersonId` maps a row's assignee to a Notion user id (people mode).
 */
export function toNotionProperties(
  row: TicketRow,
  schema: BoardSchema,
  resolvePersonId: (row: TicketRow) => string | null
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    [COLUMNS.ticket]: {
      title: [{ text: { content: row.ticket.slice(0, 2000) } }],
    },
    [COLUMNS.completedDate]: row.completedDate
      ? { date: { start: row.completedDate } }
      : { date: null },

    [COLUMNS.channel]: row.channel
      ? { select: { name: sanitizeSelect(row.channel) } }
      : { select: null },
    [COLUMNS.customer]: {
      rich_text: row.customer
        ? [{ text: { content: row.customer.slice(0, 2000) } }]
        : [],
    },
    [COLUMNS.description]: {
      rich_text: row.description
        ? [{ text: { content: row.description } }]
        : [],
    },
    [COLUMNS.dueSla]: row.dueSla
      ? { date: { start: row.dueSla } }
      : { date: null },
    [COLUMNS.priority]: { select: { name: row.priority } },
    [COLUMNS.threadLink]: { url: row.threadLink },
    [COLUMNS.engStatus]: row.engStatus
      ? { select: { name: sanitizeSelect(row.engStatus) } }
      : { select: null },
  };

  props[COLUMNS.category] =
    schema.categoryType === "multi_select"
      ? {
          multi_select: row.categories.map((c) => ({
            name: sanitizeSelect(c),
          })),
        }
      : row.categories.length
        ? { select: { name: sanitizeSelect(row.categories[0]) } }
        : { select: null };

  props[COLUMNS.category] =
    schema.categoryType === "multi_select"
      ? {
          multi_select: row.categories.map((c) => ({
            name: sanitizeSelect(c),
          })),
        }
      : row.categories.length
        ? { select: { name: sanitizeSelect(row.categories[0]) } }
        : { select: null };

  props[COLUMNS.status] =
    schema.statusType === "status"
      ? { status: { name: schema.statusMap[row.status] ?? row.status } }
      : { select: { name: row.status } };

  if (schema.assigneeType === "people") {
    const personId = resolvePersonId(row);
    props[COLUMNS.assignee] = { people: personId ? [{ id: personId }] : [] };
  } else {
    props[COLUMNS.assignee] = row.assignee
      ? { select: { name: sanitizeSelect(row.assignee) } }
      : { select: null };
  }

  if (schema.ticketIdWritable) {
    // Write Plain's human-facing ticket number (T-363), not the opaque
    // thread id — the join key lives in Thread Link.
    props[COLUMNS.ticketId] = {
      rich_text: [{ text: { content: row.ticketRef } }],
    };
  }
  // unique_id Ticket ID: Notion auto-numbers it; the API can't write it.

  return props;
}

// Notion select option names can't contain commas.
function sanitizeSelect(name: string): string {
  return name.replace(/,/g, " ").trim().slice(0, 100);
}
