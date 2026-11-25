/**
 * Which tools mcp-host chat registers and whether each one shows an approval
 * card, derived from the producer fixture mcp-host records:
 * mcp-host/test/fixtures/wire/mcp-host-tool-approval.json (producer test
 * mcp-host/src/core/approval/__tests__/approvalProducerFixtures.test.ts).
 *
 * Production code cannot read a test fixture, so the derivation is committed
 * here. `__tests__/approvalToolCatalog.test.ts` re-derives it from the fixture
 * and fails when the two drift. Each tool is judged over the contexts where it
 * is registered: only true means `always`, only false means `never`, and both
 * means the answer depends on the context (`{ conditions }`).
 */

export type ApprovalToolAsks = 'always' | 'never' | { conditions: string }

export interface ApprovalToolCatalogEntry {
  name: string
  asks: ApprovalToolAsks
  /**
   * Set where the tool is registered only in some contexts and the never-ask
   * list must say so. The tool never asks wherever it is registered.
   */
  registeredWhen?: string
}

export const CRON_MANAGE_CONDITIONS =
  'Runs without a card on a stateless Host that has not allowed cron management, and in tasks fired by a schedule. Asks otherwise.'

export const WORKFLOW_TRIGGER_CONDITIONS =
  'Runs without a card from Telegram, Slack and Teams tasks, and in tasks fired by a schedule. Asks in an interactive Desktop chat.'

/**
 * Derived from `gfsDownloadStore` and `gfsScopes` only: an available store plus
 * `gfs.read`. Three more inputs turn the tool off (an unavailable store,
 * `tools.shell_exec` set to Skip, and no caller root); they are pinned in the
 * producer test, not recorded as contexts. Listing the tool where it may be
 * absent is the safe direction for a "still running without a card" list.
 */
export const GFS_DOWNLOAD_REGISTERED_WHEN =
  "Only where the Host's GFS download store is available and the agent holds gfs.read; never asks there."

export const APPROVAL_TOOL_CATALOG: ReadonlyArray<ApprovalToolCatalogEntry> = [
  { name: 'browser_click', asks: 'never' },
  { name: 'browser_get_content', asks: 'never' },
  { name: 'browser_navigate', asks: 'always' },
  { name: 'browser_open', asks: 'always' },
  { name: 'browser_screenshot', asks: 'never' },
  { name: 'browser_type', asks: 'never' },
  { name: 'clerum__attachment_read', asks: 'never' },
  { name: 'clerum__context_files_list', asks: 'never' },
  { name: 'clerum__context_files_read', asks: 'never' },
  { name: 'clerum__document_read', asks: 'never' },
  { name: 'clerum__generate_chart', asks: 'never' },
  { name: 'clerum__generate_dashboard', asks: 'never' },
  { name: 'clerum__generate_docx', asks: 'never' },
  { name: 'clerum__generate_markdown', asks: 'never' },
  { name: 'clerum__generate_pdf', asks: 'never' },
  { name: 'clerum__generate_pptx', asks: 'never' },
  { name: 'clerum__generate_xlsx', asks: 'never' },
  { name: 'clerum__get_capabilities', asks: 'never' },
  { name: 'clerum__gfs_accessible', asks: 'never' },
  { name: 'clerum__gfs_copy', asks: 'never' },
  { name: 'clerum__gfs_create_file', asks: 'never' },
  { name: 'clerum__gfs_create_folder', asks: 'never' },
  { name: 'clerum__gfs_download', asks: 'never', registeredWhen: GFS_DOWNLOAD_REGISTERED_WHEN },
  { name: 'clerum__gfs_list', asks: 'never' },
  { name: 'clerum__gfs_read', asks: 'never' },
  { name: 'clerum__gfs_rename', asks: 'never' },
  { name: 'clerum__gfs_resolve', asks: 'never' },
  { name: 'clerum__gfs_save_attachment', asks: 'never' },
  { name: 'clerum__gfs_stat', asks: 'never' },
  { name: 'clerum__gfs_write', asks: 'never' },
  { name: 'clerum__session_search', asks: 'never' },
  { name: 'clerum__spillover_read', asks: 'never' },
  { name: 'clerum__tool_call', asks: 'never' },
  { name: 'clerum__tool_describe', asks: 'never' },
  { name: 'clerum__tool_search', asks: 'never' },
  { name: 'cron_manage', asks: { conditions: CRON_MANAGE_CONDITIONS } },
  { name: 'desktop_click', asks: 'never' },
  { name: 'desktop_drag', asks: 'never' },
  { name: 'desktop_key', asks: 'never' },
  { name: 'desktop_mouse_move', asks: 'never' },
  { name: 'desktop_screenshot', asks: 'never' },
  { name: 'desktop_type', asks: 'never' },
  { name: 'file_read', asks: 'never' },
  { name: 'file_write', asks: 'never' },
  { name: 'http_request', asks: 'always' },
  { name: 'json_transform', asks: 'never' },
  { name: 'memory_read', asks: 'never' },
  { name: 'memory_search', asks: 'never' },
  { name: 'memory_tree', asks: 'never' },
  { name: 'memory_write', asks: 'never' },
  { name: 'shell_exec', asks: 'always' },
  { name: 'system_info', asks: 'never' },
  { name: 'workflow_health', asks: 'never' },
  { name: 'workflow_list', asks: 'never' },
  { name: 'workflow_result', asks: 'never' },
  { name: 'workflow_status', asks: 'never' },
  { name: 'workflow_trigger', asks: { conditions: WORKFLOW_TRIGGER_CONDITIONS } },
]

/**
 * `clerum__tool_call` is the tool-bridge: mcp-host rewrites a call to it into
 * its target tool before the approval gate, so its calls run under the target
 * tool's rule and it is never "a tool that runs without a card" on its own.
 */
const BRIDGE_TOOL = 'clerum__tool_call'

/**
 * Every tool chat registers that never shows a card wherever it is registered,
 * plus the tools whose answer varies (with their conditions text). Sorted by
 * name. Never lists the bridge tool.
 */
export function neverAskTools(): Array<{ name: string; conditions?: string }> {
  const result: Array<{ name: string; conditions?: string }> = []
  for (const entry of APPROVAL_TOOL_CATALOG) {
    if (entry.name === BRIDGE_TOOL || entry.asks === 'always') continue
    if (typeof entry.asks === 'object') {
      result.push({ name: entry.name, conditions: entry.asks.conditions })
    } else if (entry.registeredWhen !== undefined) {
      result.push({ name: entry.name, conditions: entry.registeredWhen })
    } else {
      result.push({ name: entry.name })
    }
  }
  return result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** Names whose stored per-tool override is `false` (Skip), sorted. */
export function skipOverrides(tools: Record<string, unknown> | undefined): string[] {
  if (!tools) return []
  return Object.keys(tools)
    .filter(name => tools[name] === false)
    .sort()
}
