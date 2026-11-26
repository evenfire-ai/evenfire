/**
 * The tool names mcp-host registers natively for chat (the keys of a Host's
 * `spec.approval.tools` that its approval gate can actually read). The Host
 * approval audit lists a change to one of these before any other tool key, so
 * a flood of unrelated keys cannot push a real loosening out of the audit line
 * or the durable summary (spec 2026-11-24-control-ui-approval-settings §6.8).
 *
 * mcp-host is not importable from this package, so the truth is its producer
 * fixture, `mcp-host/test/fixtures/wire/mcp-host-tool-approval.json`
 * (recorded by `src/core/approval/__tests__/approvalProducerFixtures.test.ts`).
 * `test/services.mcpHostNativeToolNames.test.ts` pins this list to it.
 */
export const MCP_HOST_NATIVE_TOOL_NAMES: readonly string[] = [
  'browser_click',
  'browser_get_content',
  'browser_navigate',
  'browser_open',
  'browser_screenshot',
  'browser_type',
  'clerum__attachment_read',
  'clerum__context_files_list',
  'clerum__context_files_read',
  'clerum__document_read',
  'clerum__generate_chart',
  'clerum__generate_dashboard',
  'clerum__generate_docx',
  'clerum__generate_markdown',
  'clerum__generate_pdf',
  'clerum__generate_pptx',
  'clerum__generate_xlsx',
  'clerum__get_capabilities',
  'clerum__gfs_accessible',
  'clerum__gfs_copy',
  'clerum__gfs_create_file',
  'clerum__gfs_create_folder',
  'clerum__gfs_download',
  'clerum__gfs_list',
  'clerum__gfs_read',
  'clerum__gfs_rename',
  'clerum__gfs_resolve',
  'clerum__gfs_save_attachment',
  'clerum__gfs_stat',
  'clerum__gfs_write',
  'clerum__session_search',
  'clerum__spillover_read',
  'clerum__tool_call',
  'clerum__tool_describe',
  'clerum__tool_search',
  'cron_manage',
  'desktop_click',
  'desktop_drag',
  'desktop_key',
  'desktop_mouse_move',
  'desktop_screenshot',
  'desktop_type',
  'file_read',
  'file_write',
  'http_request',
  'json_transform',
  'memory_read',
  'memory_search',
  'memory_tree',
  'memory_write',
  'shell_exec',
  'system_info',
  'workflow_health',
  'workflow_list',
  'workflow_result',
  'workflow_status',
  'workflow_trigger',
]

const NATIVE = new Set<string>(MCP_HOST_NATIVE_TOOL_NAMES)

export function isMcpHostNativeToolName(name: string): boolean {
  return NATIVE.has(name)
}
