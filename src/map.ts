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
  // Fall back to top-level status.
  const s = String(thread.status);
  return s.charAt(0) + s.slice(1).toLowerCase(); // TODO -> Todo, DONE -> Done
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

function threadUrl(threadId: string): string {
  return config.threadUrlTemplate
    .replace("{workspaceId}", config.plainWorkspaceId)
    .replace("{threadId}", threadId);
}

/**
 * Plain-value view of a ticket row. Used both to build Notion properties and
 * to diff against the existing page for idempotent updates.
 */
export interface TicketRow {
  ticket: string;
  status: string;
  completedDate: string | null; // ISO date
  assignee: string | null;
  category: string | null;
  channel: string | null;
  customer: string | null;
  description: string | null;
  dueSla: string | null; // ISO date — not populated in v1 (see README)
  priority: string;
  threadLink: string;
  ticketId: string;
  engStatus: string | null;
}

export function toRow(
  thread: PlainThread,
  enrich: ThreadEnrichment | undefined
): TicketRow {
  const isDone = String(thread.status) === "DONE";
  // Plain unassigns the thread when it's marked done, but records who did it.
  // Fall back to that actor so completed tickets still show who handled them.
  const assignee =
    (thread.assignedTo && "fullName" in thread.assignedTo
      ? thread.assignedTo.fullName
      : null) ?? (isDone ? enrich?.statusChangedByName ?? null : null);

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
    category: fieldOrLabel(
      thread,
      config.categoryFieldKey,
      config.categoryLabelPrefix
    ),
    channel: rawChannel ? CHANNEL_LABELS[rawChannel] ?? rawChannel : null,
    customer: enrich?.customerName ?? enrich?.customerEmail ?? null,
    description: description || null,
    dueSla: null,
    priority: PRIORITY_LABELS[thread.priority] ?? `P${thread.priority}`,
    threadLink: threadUrl(thread.id),
    ticketId: thread.id,
    engStatus: fieldOrLabel(
      thread,
      config.engStatusFieldKey,
      config.engStatusLabelPrefix
    ),
  };
}

/** Build the Notion properties payload for a row. Only the 13 owned columns. */
export function toNotionProperties(row: TicketRow): Record<string, unknown> {
  const props: Record<string, unknown> = {
    [COLUMNS.ticket]: {
      title: [{ text: { content: row.ticket.slice(0, 2000) } }],
    },
    [COLUMNS.status]: { select: { name: row.status } },
    [COLUMNS.completedDate]: row.completedDate
      ? { date: { start: row.completedDate } }
      : { date: null },
    [COLUMNS.assignee]: row.assignee
      ? { select: { name: sanitizeSelect(row.assignee) } }
      : { select: null },
    [COLUMNS.category]: row.category
      ? { select: { name: sanitizeSelect(row.category) } }
      : { select: null },
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
    [COLUMNS.ticketId]: {
      rich_text: [{ text: { content: row.ticketId } }],
    },
    [COLUMNS.engStatus]: row.engStatus
      ? { select: { name: sanitizeSelect(row.engStatus) } }
      : { select: null },
  };
  return props;
}

// Notion select option names can't contain commas.
function sanitizeSelect(name: string): string {
  return name.replace(/,/g, " ").trim().slice(0, 100);
}
