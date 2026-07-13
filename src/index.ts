import { fetchAllThreads, fetchEnrichment } from "./plain.js";
import { toRow } from "./map.js";
import {
  loadExistingPages,
  createPage,
  updatePage,
  isUnchanged,
} from "./notion.js";

async function main(): Promise<void> {
  // 1. Pull all threads from Plain. Stateless full scan: Plain is the source
  //    of truth and the Notion diff below makes unchanged rows free, so no
  //    watermark or state store is needed.
  const threads = await fetchAllThreads();
  console.log(`[sync] fetched ${threads.length} thread(s) from Plain`);
  if (threads.length === 0) {
    console.log(`[sync] done — fetched 0, created 0, updated 0, skipped 0, failed 0`);
    return;
  }

  // 2. Enrich with customer name/email and channel.
  const enrichment = await fetchEnrichment(threads.map((t) => t.id));

  // 3. Load current Notion state once, keyed by Ticket ID.
  const existing = await loadExistingPages();
  console.log(`[sync] loaded ${existing.size} existing Notion row(s)`);

  // 4. Upsert. One bad ticket never aborts the run.
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const thread of threads) {
    try {
      const row = toRow(thread, enrichment.get(thread.id));
      const page = existing.get(row.ticketId);
      if (!page) {
        await createPage(row);
        created++;
      } else if (isUnchanged(page.row, row)) {
        skipped++;
      } else {
        await updatePage(page.pageId, row);
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
      `updated ${updated}, skipped ${skipped}, failed ${failed}`
  );

  if (failed > 0 && failed === threads.length) {
    process.exit(1); // total failure — surface it to Railway
  }
}

main().catch((err) => {
  console.error(`[sync] fatal: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
