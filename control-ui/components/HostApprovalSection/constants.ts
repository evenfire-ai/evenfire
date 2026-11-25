import { CRON_MANAGE_CONDITIONS, WORKFLOW_TRIGGER_CONDITIONS } from '@/lib/approvalToolCatalog'

export type CodeDefault = 'required' | 'skip'

export interface NativeToolMeta {
  name: string
  /**
   * The value of the tool's own `requiresApproval()` in mcp-host, as the
   * producer fixture records it (see `lib/approvalToolCatalog.ts`):
   *   - `'required'` (true): http_request, shell_exec, browser_open,
   *     browser_navigate, and cron_manage / workflow_trigger, which vary
   *     (see `conditional`) and are true in their usual case.
   *   - `'skip'` (false): every other registered tool.
   * The `isRisky` warning predicate fires only when the operator overrides
   * a `'required'`-default tool to Skip — that is the only direction that
   * actually loosens approval. Setting any tool to "Required" tightens
   * (or no-ops if the default is already required).
   */
  codeDefault: CodeDefault
  description: string
  /**
   * Operator-facing tooltip shown next to the warning icon when the override
   * loosens approval (state === 'skip' && codeDefault === 'required').
   * Only meaningful for tools whose code default is `'required'`.
   */
  riskHint?: string
  /**
   * Set where the tool's own approval value differs between contexts it is
   * registered in; `codeDefault` is then only the usual value and the
   * conditions say when it differs.
   */
  conditional?: { conditions: string }
  /** Registered only in Desktop chats (the Desktop tool set). */
  desktopOnly?: boolean
}

export const NATIVE_TOOLS: NativeToolMeta[] = [
  {
    name: 'browser_click',
    codeDefault: 'skip',
    description: 'Click an element in the Desktop browser.',
    desktopOnly: true,
  },
  {
    name: 'browser_get_content',
    codeDefault: 'skip',
    description: 'Read the content of the Desktop browser page.',
    desktopOnly: true,
  },
  {
    name: 'browser_navigate',
    codeDefault: 'required',
    description: 'Navigate the Desktop browser to a URL.',
    desktopOnly: true,
  },
  {
    name: 'browser_open',
    codeDefault: 'required',
    description: 'Open a page in the Desktop browser.',
    desktopOnly: true,
  },
  {
    name: 'browser_screenshot',
    codeDefault: 'skip',
    description: 'Take a screenshot of the Desktop browser page.',
    desktopOnly: true,
  },
  {
    name: 'browser_type',
    codeDefault: 'skip',
    description: 'Type text into the Desktop browser page.',
    desktopOnly: true,
  },
  {
    name: 'clerum__attachment_read',
    codeDefault: 'skip',
    description: 'Read a file attached to the chat message.',
  },
  {
    name: 'clerum__context_files_list',
    codeDefault: 'skip',
    description: 'List the files in the agent context-files mount.',
  },
  {
    name: 'clerum__context_files_read',
    codeDefault: 'skip',
    description: 'Read a file from the agent context-files mount.',
  },
  {
    name: 'clerum__document_read',
    codeDefault: 'skip',
    description: 'Read the text of a document (PDF, Word, Excel).',
  },
  {
    name: 'clerum__generate_chart',
    codeDefault: 'skip',
    description: 'Generate a chart from agent steps.',
  },
  {
    name: 'clerum__generate_dashboard',
    codeDefault: 'skip',
    description: 'Generate a dashboard from agent steps.',
  },
  {
    name: 'clerum__generate_docx',
    codeDefault: 'skip',
    description: 'Generate .docx output from agent steps.',
  },
  {
    name: 'clerum__generate_markdown',
    codeDefault: 'skip',
    description: 'Generate Markdown output from agent steps.',
  },
  {
    name: 'clerum__generate_pdf',
    codeDefault: 'skip',
    description: 'Generate PDF output from agent steps.',
  },
  {
    name: 'clerum__generate_pptx',
    codeDefault: 'skip',
    description: 'Generate .pptx output from agent steps.',
  },
  {
    name: 'clerum__generate_xlsx',
    codeDefault: 'skip',
    description: 'Generate .xlsx output from agent steps.',
  },
  {
    name: 'clerum__get_capabilities',
    codeDefault: 'skip',
    description: 'Describe what this agent can do.',
  },
  {
    name: 'clerum__gfs_accessible',
    codeDefault: 'skip',
    description: 'Check which GFS paths the agent can access.',
  },
  {
    name: 'clerum__gfs_copy',
    codeDefault: 'skip',
    description: 'Copy a file or folder in GFS.',
  },
  {
    name: 'clerum__gfs_create_file',
    codeDefault: 'skip',
    description: 'Create a file in GFS.',
  },
  {
    name: 'clerum__gfs_create_folder',
    codeDefault: 'skip',
    description: 'Create a folder in GFS.',
  },
  {
    name: 'clerum__gfs_download',
    codeDefault: 'skip',
    description: 'Download a GFS file into the agent workspace.',
  },
  {
    name: 'clerum__gfs_list',
    codeDefault: 'skip',
    description: 'List files and folders in GFS.',
  },
  {
    name: 'clerum__gfs_read',
    codeDefault: 'skip',
    description: 'Read a file from GFS.',
  },
  {
    name: 'clerum__gfs_rename',
    codeDefault: 'skip',
    description: 'Rename a file or folder in GFS.',
  },
  {
    name: 'clerum__gfs_resolve',
    codeDefault: 'skip',
    description: 'Resolve a GFS path or link to its target.',
  },
  {
    name: 'clerum__gfs_save_attachment',
    codeDefault: 'skip',
    description: 'Save a chat attachment into GFS.',
  },
  {
    name: 'clerum__gfs_stat',
    codeDefault: 'skip',
    description: 'Read GFS file or folder metadata.',
  },
  {
    name: 'clerum__gfs_write',
    codeDefault: 'skip',
    description: 'Write a file in GFS.',
  },
  {
    name: 'clerum__session_search',
    codeDefault: 'skip',
    description: 'Search the agent past chat sessions.',
  },
  {
    name: 'clerum__spillover_read',
    codeDefault: 'skip',
    description: 'Read the stored remainder of a long tool result.',
  },
  {
    name: 'clerum__tool_describe',
    codeDefault: 'skip',
    description: 'Describe an available tool and its inputs.',
  },
  {
    name: 'clerum__tool_search',
    codeDefault: 'skip',
    description: 'Search the available tools by keyword.',
  },
  {
    name: 'cron_manage',
    codeDefault: 'required',
    description: 'Create, list and change scheduled (cron) tasks.',
    conditional: { conditions: CRON_MANAGE_CONDITIONS },
  },
  {
    name: 'desktop_click',
    codeDefault: 'skip',
    description: 'Click on the Desktop screen.',
    desktopOnly: true,
  },
  {
    name: 'desktop_drag',
    codeDefault: 'skip',
    description: 'Drag on the Desktop screen.',
    desktopOnly: true,
  },
  {
    name: 'desktop_key',
    codeDefault: 'skip',
    description: 'Press keys on the Desktop.',
    desktopOnly: true,
  },
  {
    name: 'desktop_mouse_move',
    codeDefault: 'skip',
    description: 'Move the mouse on the Desktop screen.',
    desktopOnly: true,
  },
  {
    name: 'desktop_screenshot',
    codeDefault: 'skip',
    description: 'Take a screenshot of the Desktop screen.',
    desktopOnly: true,
  },
  {
    name: 'desktop_type',
    codeDefault: 'skip',
    description: 'Type text on the Desktop.',
    desktopOnly: true,
  },
  {
    name: 'file_read',
    codeDefault: 'skip',
    description: 'Read files in the agent workspace.',
  },
  {
    name: 'file_write',
    codeDefault: 'skip',
    description: 'Write files in the agent workspace.',
  },
  {
    name: 'http_request',
    codeDefault: 'required',
    description: 'Outbound HTTP requests (GET/POST/PUT/DELETE).',
    riskHint:
      'Skipping approval relies on CLERUM_HTTP_ALLOWLIST being set in the mcp-host ConfigMap. Confirm that gate before applying.',
  },
  {
    name: 'json_transform',
    codeDefault: 'skip',
    description: 'Transform JSON via JMESPath / jq-style queries.',
  },
  {
    name: 'memory_read',
    codeDefault: 'skip',
    description: 'Read an entry from the agent memory.',
  },
  {
    name: 'memory_search',
    codeDefault: 'skip',
    description: 'Search the agent memory.',
  },
  {
    name: 'memory_tree',
    codeDefault: 'skip',
    description: 'List the structure of the agent memory.',
  },
  {
    name: 'memory_write',
    codeDefault: 'skip',
    description: 'Write an entry to the agent memory.',
  },
  {
    name: 'shell_exec',
    codeDefault: 'required',
    description: 'Execute shell commands in the agent workspace.',
    riskHint:
      'Skipping approval allows arbitrary command execution. There is no allowlist analog for shell commands.',
  },
  {
    name: 'system_info',
    codeDefault: 'skip',
    description: 'Read OS / process metadata (CPU, memory, env).',
  },
  {
    name: 'workflow_health',
    codeDefault: 'skip',
    description: 'Check the health of the workflow service.',
  },
  {
    name: 'workflow_list',
    codeDefault: 'skip',
    description: 'List available workflows.',
  },
  {
    name: 'workflow_result',
    codeDefault: 'skip',
    description: 'Read the result of a workflow run.',
  },
  {
    name: 'workflow_status',
    codeDefault: 'skip',
    description: 'Read the status of a workflow run.',
  },
  {
    name: 'workflow_trigger',
    codeDefault: 'required',
    description: 'Start a workflow run.',
    conditional: { conditions: WORKFLOW_TRIGGER_CONDITIONS },
  },
]

/**
 * Registered tools that deliberately have no `NATIVE_TOOLS` row. The parity
 * test (`HostApprovalSection.toolParity.test.ts`) requires every tool mcp-host
 * chat registers to have a row or an entry here, with a reason.
 */
export const TOOL_PARITY_EXCLUSIONS: ReadonlyArray<{ name: string; reason: string }> = [
  {
    name: 'clerum__tool_call',
    reason:
      "mcp-host's tool-use loop rewrites a bridge call to its target tool before the approval gate (resolveBridgeCall in mcp-host/src/core/orchestration/toolUseLoopToolBatch.ts), so an override on this name never takes effect.",
  },
]
