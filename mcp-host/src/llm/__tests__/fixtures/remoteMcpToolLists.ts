/**
 * Captured fixtures — real `tools/list` results of two hosted remote MCP servers.
 *
 * Captured on 2026-11-11 (local; timestamps below are UTC) against the live
 * servers, NOT hand-authored: a tool name the real server cannot publish would
 * make the wire-name tests prove nothing. Generated from the raw capture by a
 * script; only `name` and the length of `description` are kept (no schemas,
 * no description text).
 *
 * Method (Streamable HTTP, paginated until no `nextCursor`):
 *   POST initialize → notifications/initialized → tools/list
 *   POST https://mcp.notion.com/mcp
 *   POST https://mcp.atlassian.com/v2/mcp
 *
 * Captured through an OAuth user grant in the dev cluster; token never stored.
 */

export interface CapturedTool {
  readonly name: string
  readonly descriptionLength: number
}

// https://mcp.notion.com/mcp — captured 2026-11-12T01:53:30.794Z, protocol 2025-06-18, 77 tools
export const NOTION_TOOLS: readonly CapturedTool[] = [
  { name: 'notion-search', descriptionLength: 1775 },
  { name: 'notion-memory-search', descriptionLength: 380 },
  { name: 'notion-get-tool-access', descriptionLength: 1380 },
  { name: 'notion-fetch', descriptionLength: 1800 },
  { name: 'notion-create-attachment', descriptionLength: 1598 },
  { name: 'notion-create-file-upload', descriptionLength: 880 },
  { name: 'notion-download-attachment', descriptionLength: 843 },
  { name: 'notion-get-file-download-urls', descriptionLength: 674 },
  { name: 'notion-create-pages', descriptionLength: 1945 },
  { name: 'notion-update-page', descriptionLength: 1984 },
  { name: 'notion-delete-pages', descriptionLength: 556 },
  { name: 'notion-delete-databases', descriptionLength: 614 },
  { name: 'notion-restore-pages', descriptionLength: 340 },
  { name: 'notion-convert-page-to-skill', descriptionLength: 262 },
  { name: 'notion-upload-skill', descriptionLength: 1229 },
  { name: 'notion-download-skill', descriptionLength: 247 },
  { name: 'notion-get-enabled-skills', descriptionLength: 294 },
  { name: 'notion-update-skill-settings', descriptionLength: 240 },
  { name: 'notion-complete-mcp-setup', descriptionLength: 114 },
  { name: 'notion-move-pages', descriptionLength: 146 },
  { name: 'notion-duplicate-page', descriptionLength: 431 },
  { name: 'notion-create-database', descriptionLength: 1859 },
  { name: 'notion-create-folder', descriptionLength: 438 },
  { name: 'notion-update-folder', descriptionLength: 556 },
  { name: 'notion-update-data-source', descriptionLength: 1316 },
  { name: 'notion-create-comment', descriptionLength: 1892 },
  { name: 'notion-get-comments', descriptionLength: 1965 },
  { name: 'notion-update-comment', descriptionLength: 281 },
  { name: 'notion-delete-comment', descriptionLength: 298 },
  { name: 'notion-set-discussion-resolved', descriptionLength: 300 },
  { name: 'notion-set-comment-reaction', descriptionLength: 165 },
  { name: 'notion-create-suggested-edit', descriptionLength: 364 },
  { name: 'notion-get-suggested-edit', descriptionLength: 297 },
  { name: 'notion-resolve-suggested-edit', descriptionLength: 332 },
  { name: 'notion-get-async-task', descriptionLength: 578 },
  { name: 'notion-get-teams', descriptionLength: 409 },
  { name: 'notion-get-groups', descriptionLength: 667 },
  { name: 'notion-get-users', descriptionLength: 590 },
  { name: 'notion-query-data-sources', descriptionLength: 2000 },
  { name: 'notion-query-multiple-data-sources', descriptionLength: 1166 },
  { name: 'notion-query-meeting-notes', descriptionLength: 1365 },
  { name: 'notion-list-private-pages', descriptionLength: 317 },
  { name: 'notion-list-shared-pages', descriptionLength: 310 },
  { name: 'notion-list-favorite-pages', descriptionLength: 199 },
  { name: 'notion-list-recent-pages', descriptionLength: 406 },
  { name: 'notion-search-agents', descriptionLength: 474 },
  { name: 'notion-search-sessions', descriptionLength: 345 },
  { name: 'notion-query-sessions', descriptionLength: 315 },
  { name: 'notion-spawn-session', descriptionLength: 244 },
  { name: 'notion-get-session-status', descriptionLength: 208 },
  { name: 'notion-wait-session', descriptionLength: 203 },
  { name: 'notion-stop-session', descriptionLength: 187 },
  { name: 'notion-send-message-to-session', descriptionLength: 202 },
  { name: 'notion-list-session-events', descriptionLength: 199 },
  { name: 'notion-read-session-event', descriptionLength: 206 },
  { name: 'notion-create-view', descriptionLength: 726 },
  { name: 'notion-update-view', descriptionLength: 1949 },
  { name: 'notion-get-version-changes', descriptionLength: 813 },
  { name: 'notion-view-version', descriptionLength: 603 },
  { name: 'notion-restore-version', descriptionLength: 880 },
  { name: 'notion-list-page-backlinks', descriptionLength: 215 },
  { name: 'notion-get-sidebar-tabs', descriptionLength: 391 },
  { name: 'notion-update-sidebar-tabs', descriptionLength: 1050 },
  { name: 'notion-update-page-favorites', descriptionLength: 724 },
  { name: 'notion-calendar-list-calendars', descriptionLength: 130 },
  { name: 'notion-calendar-list-events', descriptionLength: 155 },
  { name: 'notion-calendar-list-coworkers-events', descriptionLength: 163 },
  { name: 'notion-calendar-list-calendar-resources', descriptionLength: 247 },
  { name: 'notion-calendar-list-contacts', descriptionLength: 152 },
  { name: 'notion-calendar-create-events', descriptionLength: 159 },
  { name: 'notion-calendar-update-events', descriptionLength: 158 },
  { name: 'notion-calendar-cancel-events', descriptionLength: 193 },
  { name: 'notion-get-self', descriptionLength: 224 },
  { name: 'notion-link-meeting-note-to-calendar-event', descriptionLength: 418 },
  { name: 'notion-convert-to-meetings-database', descriptionLength: 292 },
  { name: 'notion-create-meeting-note', descriptionLength: 835 },
  { name: 'notion-get-setup-guide', descriptionLength: 233 },
]

// https://mcp.atlassian.com/v2/mcp — captured 2026-11-12T02:10:58.590Z, protocol 2025-06-18, 26 tools
export const ATLASSIAN_TOOLS: readonly CapturedTool[] = [
  { name: 'getAccessibleAtlassianResources', descriptionLength: 196 },
  { name: 'atlassianUserInfo', descriptionLength: 41 },
  { name: 'getConfluenceContent', descriptionLength: 172 },
  { name: 'createConfluenceContent', descriptionLength: 1422 },
  { name: 'updateConfluenceContent', descriptionLength: 2358 },
  { name: 'searchConfluence', descriptionLength: 34 },
  { name: 'getJiraIssue', descriptionLength: 291 },
  { name: 'listJiraIssueComments', descriptionLength: 695 },
  { name: 'searchJiraIssuesUsingJql', descriptionLength: 446 },
  { name: 'createJiraIssue', descriptionLength: 522 },
  { name: 'editJiraIssue', descriptionLength: 837 },
  { name: 'transitionJiraIssue', descriptionLength: 430 },
  { name: 'addOrEditJiraIssueComment', descriptionLength: 303 },
  { name: 'getLoomObjectsContent', descriptionLength: 322 },
  { name: 'getGraphContext', descriptionLength: 942 },
  { name: 'getGraphObject', descriptionLength: 166 },
  { name: 'addGraphContext', descriptionLength: 216 },
  { name: 'getCollaborators', descriptionLength: 430 },
  { name: 'getPeopleInfo', descriptionLength: 939 },
  { name: 'getWorkActivity', descriptionLength: 472 },
  { name: 'getWorkPortfolio', descriptionLength: 403 },
  { name: 'discover', descriptionLength: 701 },
  { name: 'executeRead', descriptionLength: 923 },
  { name: 'executeWrite', descriptionLength: 962 },
  { name: 'executeDestructive', descriptionLength: 964 },
  { name: 'search', descriptionLength: 344 },
]
