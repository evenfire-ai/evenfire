export type CodeDefault = 'required' | 'skip'

export interface NativeToolMeta {
  name: string
  /**
   * Resolved value of the tool class's hard-coded `requiresApproval()` in
   * mcp-host. Verified against `mcp-host/src/core/tools/*.ts` —
   *   - `'required'` (true): http_request, shell_exec
   *   - `'skip'` (false): everything else, including all clerum__* output
   *     tools (registered via InternalToolAdapter) and the file/json/system
   *     tools.
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
}

export const NATIVE_TOOLS: NativeToolMeta[] = [
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
    name: 'clerum__generate_xlsx',
    codeDefault: 'skip',
    description: 'Generate .xlsx output from agent steps.',
  },
  {
    name: 'clerum__list_workflows',
    codeDefault: 'skip',
    description: 'List available marketplace recipes.',
  },
  {
    name: 'clerum__trigger_workflow',
    codeDefault: 'skip',
    description: 'Trigger a plugin by name.',
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
]
