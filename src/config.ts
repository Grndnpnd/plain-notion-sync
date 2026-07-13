function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

export const config = {
  plainApiKey: required("PLAIN_API_KEY"),
  notionApiKey: required("NOTION_API_KEY"),
  notionDatabaseId: required("NOTION_DATABASE_ID"),
  redisUrl: process.env.REDIS_URL ?? "",

  // Used only to build Thread Link URLs. Find it in any Plain app URL.
  plainWorkspaceId: required("PLAIN_WORKSPACE_ID"),
  threadUrlTemplate:
    process.env.PLAIN_THREAD_URL_TEMPLATE ??
    "https://app.plain.com/workspace/{workspaceId}/thread/{threadId}",

  // Where Category and Eng Status live in your Plain workspace.
  // Each is tried as a thread-field key first, then as a label-type name prefix
  // (e.g. a label named "Category: Billing" -> "Billing").
  categoryFieldKey: process.env.PLAIN_CATEGORY_FIELD_KEY ?? "category",
  categoryLabelPrefix: process.env.PLAIN_CATEGORY_LABEL_PREFIX ?? "Category:",
  engStatusFieldKey: process.env.PLAIN_ENG_STATUS_FIELD_KEY ?? "eng_status",
  engStatusLabelPrefix: process.env.PLAIN_ENG_STATUS_LABEL_PREFIX ?? "Eng:",

  // Overlap buffer (minutes) subtracted from last_synced_at to avoid missing
  // threads updated while a previous run was in flight.
  overlapMinutes: Number(process.env.SYNC_OVERLAP_MINUTES ?? "60"),
};
