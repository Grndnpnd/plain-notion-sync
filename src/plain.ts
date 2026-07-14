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
  const variants: string[] = [
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
      });
    }
  }
  return out;
}
