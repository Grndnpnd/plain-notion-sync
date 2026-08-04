/**
 * Probe a single Plain thread and dump where its data actually lives.
 *
 * Usage:  npm run probe -- th_01ABC...        (thread id)
 *         npm run probe -- T-512              (ticket ref)
 *
 * Prints: thread fields (key/type/value), labels, and the first inbound
 * timeline entry's shape. Use this to find which key a form field like
 * "X Handle" lands in before wiring it to a Notion column.
 */
import { PlainClient } from "@team-plain/typescript-sdk";
import { config } from "./config.js";
import { fetchAllThreads } from "./plain.js";

const client = new PlainClient({ apiKey: config.plainApiKey });

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: npm run probe -- <thread-id|ticket-ref>");
    process.exit(1);
  }

  // Resolve a ref (T-512) to a thread id by scanning; ids are used directly.
  let threadId = arg;
  if (!arg.startsWith("th_")) {
    console.log(`[probe] resolving ref ${arg} ...`);
    const threads = await fetchAllThreads();
    const match = threads.find((t) => t.ref === arg);
    if (!match) {
      console.error(`[probe] no thread with ref ${arg}`);
      process.exit(1);
    }
    threadId = match.id;
    console.log(`[probe] ${arg} -> ${threadId}`);

    console.log(`\n=== THREAD FIELDS (from SDK fragment) ===`);
    if (!match.threadFields.length) console.log("(none)");
    for (const f of match.threadFields) {
      console.log(
        `  key=${f.key}  type=${f.type}  string=${JSON.stringify(
          f.stringValue
        )}  bool=${f.booleanValue}`
      );
    }
    console.log(`\n=== LABELS ===`);
    for (const l of match.labels) console.log(`  ${l.labelType.name}`);
    console.log(`\n=== PREVIEW TEXT ===\n${match.previewText ?? "(none)"}`);
  }

  // Raw query: thread fields plus the first few timeline entries, so we can
  // see whether a form submission arrives as fields or as message content.
  // Entry variants are requested defensively; unsupported ones are dropped
  // by retrying with a smaller selection.
  const variants = [
    `query probe($id: ID!) {
       thread(threadId: $id) {
         id
         title
         threadFields { key type stringValue booleanValue }
         timelineEntries(first: 5) {
           edges { node {
             id
             timestamp { iso8601 }
             entry {
               __typename
               ... on EmailEntry { subject textContent }
               ... on ChatEntry { text }
               ... on CustomEntry { title components { __typename } }
             }
           } }
         }
       }
     }`,
    `query probe($id: ID!) {
       thread(threadId: $id) {
         id
         title
         threadFields { key type stringValue booleanValue }
       }
     }`,
  ];

  for (let i = 0; i < variants.length; i++) {
    const res = await client.rawRequest({
      query: variants[i],
      variables: { id: threadId },
    });
    if (res.error) {
      console.warn(`[probe] variant ${i} failed: ${res.error.message}`);
      continue;
    }
    console.log(`\n=== RAW THREAD (variant ${i}) ===`);
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }
  console.error("[probe] all variants failed");
  process.exit(1);
}

main().catch((err) => {
  console.error(`[probe] fatal: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
