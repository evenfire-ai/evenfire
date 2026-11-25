import type { LooseningItem, LooseningRule } from '@/lib/approvalLoosening'
import { CRON_MANAGE_CONDITIONS, WORKFLOW_TRIGGER_CONDITIONS } from '@/lib/approvalToolCatalog'
import type { ApprovalToolsDraft, FirstSavePolicy, LooseningItemSubject } from './types'

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
   * Whether a change loosens approval is not read from this field alone:
   * `lib/approvalLoosening` decides it (spec §6.6). Required → Default on a
   * Skip-default tool loosens too, and so does any change toward Skip on a
   * tool that asks by default, conditional ones included.
   */
  codeDefault: CodeDefault
  description: string
  /**
   * Operator-facing note on a Skip override of this tool: the title of the
   * read view's loosening mark. The mark and the dialog come from
   * `lib/approvalLoosening`, so a Required-default tool with no hint
   * (browser_open, browser_navigate, cron_manage, workflow_trigger) is still
   * marked and still confirmed. Only tools whose code default is `'required'`
   * carry one.
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

/** Spec §6.4: shown while the draft differs from the base. */
export const UNSAVED_CHANGES_TEXT = 'Unsaved changes'

/** Spec §6.6: the per-tool rows of an agent that has no approval settings of its own. */
export const CLUSTER_DEFAULT_TEXT = 'Set by the cluster default (not shown here).'

export const NO_OVERRIDES_TEXT =
  'No per-tool overrides configured. All tools use their built-in approval defaults.'

/**
 * Spec §6.2: what an explicit Required adds over the tool's own default. In
 * Auto, an admin's Required shows a card for every call of these tools
 * (`decideApproval`'s `admin_forced` cause), where their default lets
 * http_request run and sends shell commands to the model check.
 */
export const EXPLICIT_REQUIRED_NOTES: Readonly<Record<string, string>> = {
  shell_exec: 'Auto asks on every shell command',
  http_request: 'Auto asks on every HTTP request',
}

/** Spec §6.6, decision 4: the first save on an agent with no approval settings of its own. */
export const FIRST_SAVE_DIALOG_TITLE = 'Give this agent its own approval settings'
export const FIRST_SAVE_DIALOG_DESCRIPTION =
  'This agent has no approval settings of its own. This save gives it its own, with the policy you choose here.'
/** Spec §6.6's two sentences. */
export const FIRST_SAVE_NOTES: readonly string[] = [
  'The cluster rules stop applying for this agent and may have been stricter than the values shown.',
  'Channel approval cards may change their wording (with no approval settings anywhere, cards tell people to approve through the CLI).',
]
export const FIRST_SAVE_POLICY_LABEL = 'Who can approve from a channel'
/** PR A offers two; "Listed approvers only" arrives with PR B, which can add approvers. */
export const FIRST_SAVE_POLICY_OPTIONS: ReadonlyArray<{ value: FirstSavePolicy; label: string }> = [
  { value: 'channel_users', label: 'Any channel user' },
  { value: 'cli_only', label: 'Nobody (Desktop only)' },
]

/**
 * A save the write found looser than the admin confirmed (spec §6.4 step 6),
 * when the loosening dialog cannot ask again: the section has unmounted, shows
 * another agent, or the save's edit session is no longer the open one. Nothing
 * was written. The section shows it on the same agent; the tab's root toast
 * can use it elsewhere.
 */
export const RECONFIRM_NOT_SENT_MESSAGE =
  "The save was not sent: this agent's approval settings changed while it was saving, so its changes need confirming again. Make the changes again and save."

export const LOOSENING_DIALOG_TITLE = 'Confirm looser approval'
export const LOOSENING_DIALOG_DESCRIPTION =
  'This save loosens approval on this agent. Check each change before you save.'
export const LOOSENING_CONFIRM_LABEL = 'Save these changes'
export const LOOSENING_CANCEL_LABEL = 'Back to editing'

/** A loosening item's label when its path is the first save's policy. */
export const POLICY_ITEM_LABEL = 'Policy'

/** Spec §6.6: a custom row's tool has no known default here. */
const UNKNOWN_DEFAULT_TEXT =
  'As for every custom row, its default is not known here: calls may run without an approval card.'

/**
 * The same for a custom row named like an MCP server tool, in the words of
 * `CUSTOM_TOOL_HINT`: mcp-host decides an MCP server tool before it reads
 * overrides, and the section cannot tell whether the name is one.
 */
const MCP_NAME_UNKNOWN_DEFAULT_TEXT =
  'A row has no effect on an MCP server tool (names with __). If this names another tool, its default is not known here, as for every custom row: calls may run without an approval card.'

/** In Auto, what a tool's default does that its explicit Required did not. */
const DEFAULT_IN_AUTO_TEXT: Readonly<Record<string, string>> = {
  shell_exec:
    'Back to Default: in Auto, shell commands can run after a model check instead of asking every time.',
  http_request:
    'Back to Default: in Auto, HTTP requests run with no card instead of asking every time.',
}

/**
 * What each loosening rule (lib/approvalLoosening) lets happen without a
 * person, as the loosening dialog and the read view's mark say it.
 */
export const LOOSENING_RULE_TEXT: Readonly<
  Record<LooseningRule, (subject: LooseningItemSubject) => string>
> = {
  tool_to_skip: () => 'Set to Skip: calls can run without an approval card.',
  required_to_default: () =>
    'Back to Default, which never asks: calls can run without an approval card.',
  explicit_required_to_default_above_manual: ({ name }) =>
    DEFAULT_IN_AUTO_TEXT[name] ??
    'Back to Default: in Auto, calls can run without an approval card.',
  conditional_default_change: ({ conditions }) =>
    conditions
      ? `Back to Default, which does not always ask. ${conditions}`
      : 'Back to Default, which does not always ask.',
  // Only custom rows fall under this rule, so a name with `__` here is no
  // native tool: mcp-host's MCP naming (`isMcpToolName`).
  custom_row_unknown_default: ({ name, removed }) =>
    `${removed ? 'Required removed.' : 'Set to Skip.'} ${
      name.includes('__') ? MCP_NAME_UNKNOWN_DEFAULT_TEXT : UNKNOWN_DEFAULT_TEXT
    }`,
  policy_open_on_first_save: () =>
    'Any channel user can approve tool calls from a channel, and raise the mode where the channel allows it. The cluster default this replaces may have been stricter.',
}

const TOOLS_PATH_PREFIX = 'tools.'

/** A loosening item's label: the tool's name, or "Policy" for the first save's policy. */
export function looseningItemLabel(item: LooseningItem): string {
  return item.path.startsWith(TOOLS_PATH_PREFIX)
    ? item.path.slice(TOOLS_PATH_PREFIX.length)
    : POLICY_ITEM_LABEL
}

/** A loosening item's text, for the draft that holds the change. */
export function looseningItemText(item: LooseningItem, draft: ApprovalToolsDraft): string {
  const name = looseningItemLabel(item)
  return LOOSENING_RULE_TEXT[item.rule]({
    name,
    removed: !Object.hasOwn(draft, name),
    conditions: NATIVE_TOOLS.find(tool => tool.name === name)?.conditional?.conditions,
  })
}

/**
 * The hint under "Tool name" when adding a row for a tool with none in the
 * list. mcp-host decides an MCP server tool before it reads overrides
 * (`mcpApprovalGateController.ts`), so a row for one never takes effect.
 */
export const CUSTOM_TOOL_HINT =
  'For a tool with no row above. A row here has no effect on MCP server tools (names with __).'
