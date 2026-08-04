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

  // Map Plain assignees that don't auto-match to Notion members (people-type
  // Assignee only). Keys are the Plain name or email exactly as the sync
  // logs them; values are the Notion member's email or display name.
  // Format: "igor@bankr.bot=Igor Petrov;AI agent=Frenchie"
  assigneeAliases: parseAliases(process.env.PLAIN_ASSIGNEE_ALIASES ?? ""),

  // X / Twitter handle from the support request form. Tried as thread-field
  // keys in order, then as a labelled line in the first message body.
  // Run `npm run probe -- <thread-ref>` on a form-submitted thread to see
  // which key it actually uses, then set this.
  xHandleFieldKeys: (
    process.env.PLAIN_X_HANDLE_FIELD_KEYS ??
    "x_handle,twitter_handle,x_account,handle,x"
  )
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean),

  // Label text preceding the handle in a form-submission message body.
  // Matched case-insensitively; everything up to end of line is the value.
  xHandleBodyLabel:
    process.env.PLAIN_X_HANDLE_BODY_LABEL ?? "X Handle / Project X Handle",
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
