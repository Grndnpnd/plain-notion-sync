import { PlainClient, ThreadsSortField, SortDirection } from "@team-plain/typescript-sdk";
import type { ThreadPartsFragment } from "@team-plain/typescript-sdk";
import { config } from "./config.js";

export type PlainThread = ThreadPartsFragment;

export interface ThreadEnrichment {
  customerName: string | null;
  customerEmail: string | null;
  channel: string | null; // EMAIL | CHAT | SLACK | MS_TEAMS | API
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
 * The SDK's thread fragment only includes customer.id, and channel lives on
 * firstInboundMessageInfo which the fragment omits. Fetch both via one raw
 * query per batch of thread IDs. Degrades gracefully: if the query fails
 * (schema drift), we retry without the message-info field, and if that also
 * fails we return empty enrichment and log once.
 */
export async function fetchEnrichment(
  threadIds: string[]
): Promise<Map<string, ThreadEnrichment>> {
  const out = new Map<string, ThreadEnrichment>();
  const BATCH = 50;

  const fullQuery = `
    query enrich($filters: ThreadsFilter, $first: Int) {
      threads(filters: $filters, first: $first) {
        edges { node {
          id
          customer { fullName email { email } }
          firstInboundMessageInfo { messageSource }
        } }
      }
    }`;
  const minimalQuery = `
    query enrich($filters: ThreadsFilter, $first: Int) {
      threads(filters: $filters, first: $first) {
        edges { node {
          id
          customer { fullName email { email } }
        } }
      }
    }`;

  let query = fullQuery;
  let warned = false;

  for (let i = 0; i < threadIds.length; i += BATCH) {
    const ids = threadIds.slice(i, i + BATCH);
    const variables = { filters: { threadIds: ids }, first: BATCH };

    let res = await client.rawRequest({ query, variables });
    if (res.error && query === fullQuery) {
      // Retry this and all subsequent batches without message info.
      query = minimalQuery;
      if (!warned) {
        console.warn(
          `[enrich] full query failed (${res.error.message}); ` +
            `falling back without channel info`
        );
        warned = true;
      }
      res = await client.rawRequest({ query, variables });
    }
    if (res.error) {
      console.warn(`[enrich] batch failed: ${res.error.message}`);
      continue;
    }

    const edges =
      (res.data as any)?.threads?.edges ?? [];
    for (const edge of edges) {
      const n = edge?.node;
      if (!n?.id) continue;
      out.set(n.id, {
        customerName: n.customer?.fullName ?? null,
        customerEmail: n.customer?.email?.email ?? null,
        channel: n.firstInboundMessageInfo?.messageSource ?? null,
      });
    }
  }
  return out;
}
