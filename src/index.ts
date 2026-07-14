import { fetchAllThreads, fetchEnrichment } from "./plain.js";
import { toRow } from "./map.js";
import {
  detectAndValidateSchema,
  buildPersonResolver,
  loadExistingPages,
  archivePage,
  createPage,
  updatePage,
  isUnchanged,
} from "./notion.js";

async function main(): Promise<void> {
  // 0. Detect the board schema and refuse to run against an incompatible one.
  const schema = await detectAndValidateSchema();
  const resolver = await buildPersonResolver(schema);

  // 1. Pull all threads from Plain. Stateless full scan: Plain is the source
  //    of truth and the Notion diff below makes unchanged rows free.
  const threads = await fetchAllThreads();
  console.log(`[sync] fetched ${threads.length} thread(s) from Plain`);
  if (threads.length === 0) {
    console.log(`[sync] done — fetched 0, created 0, updated 0, skipped 0, failed 0`);
    return;
  }

  // 2. Enrich with customer name/email, channel, and status-changed-by.
  const enrichment = await fetchEnrichment(threads.map((t) => t.id));

  // 3. Load current Notion state once, keyed by Plain thread id
  //    (extracted from Thread Link).
  const existing = await loadExistingPages();
  console.log(`[sync] loaded ${existing.pages.size} existing Notion row(s)`);

  // Guard: a non-empty board where no row could be keyed means the join key
  // is broken — mass-creating would duplicate everything. Abort.
  if (existing.pages.size === 0 && existing.boardHasRows) {
    console.error(
      `[sync] board has rows but none have a readable Thread Link or Ticket ID — ` +
        `aborting instead of duplicating the board.`
    );
    process.exit(1);
  }

  // 3b. Archive duplicate rows (same thread id on multiple pages), keeping
  //     the oldest page for each.
  let archived = 0;
  for (const dup of existing.duplicates) {
    try {
      await archivePage(dup.pageId);
      archived++;
    } catch (err) {
      console.error(
        `[sync] failed to archive duplicate page ${dup.pageId}: ` +
          (err instanceof Error ? err.message : String(err))
      );
    }
  }
  if (archived > 0) console.log(`[sync] archived ${archived} duplicate row(s)`);

  // 4. Upsert. One bad ticket never aborts the run.
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const thread of threads) {
    try {
      const row = toRow(thread, enrichment.get(thread.id));
      const page = existing.pages.get(row.ticketId);
      if (!page) {
        await createPage(row, schema, resolver);
        created++;
      } else if (isUnchanged(page, row, schema, resolver)) {
        skipped++;
      } else {
        await updatePage(page.pageId, row, schema, resolver);
        updated++;
      }
    } catch (err) {
      failed++;
      console.error(
        `[sync] failed on thread ${thread.id} (${thread.ref}): ` +
          (err instanceof Error ? err.message : String(err))
      );
    }
  }

  console.log(
    `[sync] done — fetched ${threads.length}, created ${created}, ` +
      `updated ${updated}, skipped ${skipped}, failed ${failed}` +
      (archived ? `, archived ${archived} duplicate(s)` : "")
  );

  if (failed > 0 && failed === threads.length) {
    process.exit(1); // total failure — surface it to Railway
  }
}

main().catch((err) => {
  console.error(`[sync] fatal: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
