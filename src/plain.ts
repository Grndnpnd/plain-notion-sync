import { PlainClient, ThreadsSortField, SortDirection } from "@team-plain/typescript-sdk";
import type { ThreadPartsFragment } from "@team-plain/typescript-sdk";
import { config } from "./config.js";

export type PlainThread = ThreadPartsFragment;

export interface ThreadEnrichment {
  customerName: string | null;
  customerEmail: string | null;
  channel: string | null; // EMAIL | CHAT | SLACK | MS_TEAMS | API
  statusChangedByName: string | null; // e.g. who marked the thread done
  statusChangedByEmail: string | null;
  firstMessageText: string | null; // full first-message body (form submissions)
}

const client = new PlainClient({ apiKey: config.plainApiKey });

const PAGE_SIZE = 50;

/** Fetch all threads with cursor pagination. Stateless — full scan each run. */
export async function fetchAllThreads(): Promise<PlainThread[]> {
  const threads: PlainThread[] = [];
  let after: string | undefined = undefined;

  for (;;) {
    const res = await client.getThreads({
      first: PAGE_SIZE,
      after,
      sortBy: { field: ThreadsSortField.CreatedAt, direction: SortDirection.Asc },
    });
    if (res.error) {
      throw new Error(`Plain getThreads failed: ${res.error.message}`);
    }
    threads.push(...res.data.threads);
    if (!res.data.pageInfo.hasNextPage || !res.data.pageInfo.endCursor) break;
    after = res.data.pageInfo.endCursor;
  }
  return threads;
}

/**
 * The SDK's thread fragment only includes customer.id, and several useful
 * fields (channel, who changed the status) live outside it. Fetch them via
 * one raw query per batch of thread IDs. Degrades gracefully: query variants
 * are tried richest-first, so if Plain's schema ever drifts we fall back to
 * a simpler variant instead of failing the run.
 */
export async function fetchEnrichment(
  threadIds: string[]
): Promise<Map<string, ThreadEnrichment>> {
  const out = new Map<string, ThreadEnrichment>();
  const BATCH = 50;

  const node = (extra: string) => `
    query enrich($filters: ThreadsFilter, $first: Int) {
      threads(filters: $filters, first: $first) {
        edges { node {
          id
          customer { fullName email { email } }
          ${extra}
        } }
      }
    }`;

  // Richest first; on failure, drop to the next variant for the rest of the run.
  // Form submissions may arrive as a structured CustomEntry rather than an
  // email/chat message, so ask for component text too. Richest variant first;
  // the tiering below falls back if a shape isn't in this workspace's schema.
  const timelineRich = `
    timelineEntries(last: 8) {
      edges { node {
        timestamp { iso8601 }
        entry {
        __typename
        ... on EmailEntry { textContent }
        ... on ChatEntry { text }
        ... on CustomEntry {
          title
          components {
            __typename
            ... on ComponentText { text }
            ... on ComponentCopyButton { copyButtonValue copyButtonTooltipLabel }
            ... on ComponentRow {
              rowMainContent { __typename ... on ComponentText { text } }
              rowAsideContent { __typename ... on ComponentText { text } }
            }
          }
        }
      } } }
    }`;

  const timelineBasic = `
    timelineEntries(last: 8) {
      edges { node {
        timestamp { iso8601 }
        entry {
          __typename
          ... on EmailEntry { textContent }
          ... on ChatEntry { text }
        }
      } }
    }`;

  const variants: string[] = [
    node(`firstInboundMessageInfo { messageSource }
          statusChangedBy {
            ... on UserActor { user { fullName email } }
            ... on MachineUserActor { machineUser { fullName } }
          }
          ${timelineRich}`),
    node(`firstInboundMessageInfo { messageSource }
          statusChangedBy {
            ... on UserActor { user { fullName email } }
            ... on MachineUserActor { machineUser { fullName } }
          }
          ${timelineBasic}`),
    node(`firstInboundMessageInfo { messageSource }
          statusChangedBy {
            ... on UserActor { user { fullName email } }
            ... on MachineUserActor { machineUser { fullName } }
          }`),
    node(`firstInboundMessageInfo { messageSource }`),
    node(``),
  ];
  let variant = 0;

  for (let i = 0; i < threadIds.length; i += BATCH) {
    const ids = threadIds.slice(i, i + BATCH);
    const variables = { filters: { threadIds: ids }, first: BATCH };

    let res = await client.rawRequest({ query: variants[variant], variables });
    while (res.error && variant < variants.length - 1) {
      console.warn(
        `[enrich] query variant ${variant} failed (${res.error.message}); ` +
          `falling back to a simpler variant`
      );
      variant++;
      res = await client.rawRequest({ query: variants[variant], variables });
    }
    if (res.error) {
      console.warn(`[enrich] batch failed: ${res.error.message}`);
      continue;
    }

    const edges = (res.data as any)?.threads?.edges ?? [];
    for (const edge of edges) {
      const n = edge?.node;
      if (!n?.id) continue;
      out.set(n.id, {
        customerName: n.customer?.fullName ?? null,
        customerEmail: n.customer?.email?.email ?? null,
        channel: n.firstInboundMessageInfo?.messageSource ?? null,
        statusChangedByName:
          n.statusChangedBy?.user?.fullName ??
          n.statusChangedBy?.machineUser?.fullName ??
          null,
        statusChangedByEmail: n.statusChangedBy?.user?.email ?? null,
        firstMessageText: firstMessageTextOf(n),
      });
    }
  }
  return out;
}

/**
 * Flatten a timeline entry into searchable text, whatever its shape.
 * Email/chat bodies come back as one string; structured form submissions
 * come back as nested components, so walk the object and collect every
 * text-bearing leaf in document order. Shape-agnostic on purpose: Plain can
 * render forms as custom entries and the field layout varies by workspace.
 */
const TEXT_KEYS = new Set([
  "textContent",
  "text",
  "title",
  "copyButtonValue",
  "copyButtonTooltipLabel",
]);

function collectText(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    for (const v of value) collectText(v, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "__typename") continue;
    if (typeof v === "string") {
      if (TEXT_KEYS.has(k) && v.trim()) out.push(v.trim());
    } else {
      collectText(v, out, depth + 1);
    }
  }
}

/**
 * Text of the EARLIEST timeline entry that carries any, else null.
 *
 * Plain returns timeline entries newest-first and interleaves metadata
 * entries (label/status/priority changes), so neither "the first edge" nor
 * "the newest" is the original message. Sort by timestamp ascending and take
 * the oldest text-bearing entry — that's the form submission / first inbound
 * message regardless of how much automation churn sits on top of it.
 */
function firstMessageTextOf(node: any): string | null {
  const edges = node?.timelineEntries?.edges ?? [];
  const candidates: { ts: string; text: string }[] = [];
  for (const e of edges) {
    const parts: string[] = [];
    collectText(e?.node?.entry, parts);
    const joined = parts.join("\n").trim();
    if (joined) {
      candidates.push({ ts: e?.node?.timestamp?.iso8601 ?? "", text: joined });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.ts.localeCompare(b.ts));
  return candidates[0].text;
}
