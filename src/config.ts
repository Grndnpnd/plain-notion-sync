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

  // For a status-type Status column: map sync labels to board options when
  // the board doesn't have an option of that name. Format: "A=B;C=D".
  // Matching is case-insensitive, so capitalization differences never need
  // an alias.
  statusAliases: parseAliases(
    process.env.PLAIN_STATUS_ALIASES ?? "Snoozed=Waiting for Customer"
  ),
};

function parseAliases(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(";")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return out;
}
