import { config } from "./config.js";
import { fetchThreadsUpdatedSince, fetchEnrichment } from "./plain.js";
import { toRow } from "./map.js";
import {
  loadExistingPages,
  createPage,
  updatePage,
  isUnchanged,
} from "./notion.js";
import { getLastSyncedAt, setLastSyncedAt } from "./state.js";

async function main(): Promise<void> {
  const runStartedAt = new Date().toISOString();

  // 1. Determine the incremental window (with overlap buffer).
  const last = await getLastSyncedAt();
  let since: string | null = null;
  if (last) {
    const t = Date.parse(last) - config.overlapMinutes * 60_000;
    since = new Date(t).toISOString();
  }
  console.log(
    since
      ? `[sync] incremental run — threads updated since ${since}`
      : `[sync] first run — full backfill`
  );

  // 2. Pull threads from Plain.
  const threads = await fetchThreadsUpdatedSince(since);
  console.log(`[sync] fetched ${threads.length} thread(s) from Plain`);
  if (threads.length === 0) {
    await setLastSyncedAt(runStartedAt);
    console.log(`[sync] done — fetched 0, created 0, updated 0, skipped 0, failed 0`);
    return;
  }

  // 3. Enrich with customer name/email and channel.
  const enrichment = await fetchEnrichment(threads.map((t) => t.id));

  // 4. Load current Notion state once, keyed by Ticket ID.
  const existing = await loadExistingPages();
  console.log(`[sync] loaded ${existing.size} existing Notion row(s)`);

  // 5. Upsert. One bad ticket never aborts the run.
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

  // 6. Persist watermark only if the run wasn't a total failure.
  if (failed < threads.length) {
    await setLastSyncedAt(runStartedAt);
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
