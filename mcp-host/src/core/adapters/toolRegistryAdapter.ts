import { serverNameOf } from '../../capabilities/toolCatalogTools'
import { logger } from '../../logger'
import { McpManager } from '../../mcp/manager'
import { Tool, ToolRegistry } from '../interfaces'
import { Attachment, ToolDefinition, ToolOutput, ValidationResult } from '../types'
import {
  BoundedJsonError,
  type SchemaValidationFailure,
  boundedJson,
  validateBoundedSchema,
} from './boundedSchemaValidation'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseImageContentPart(
  item: Record<string, unknown>,
  sourceTool: string
): Attachment | null {
  const type = item.type
  if (type !== 'image') return null

  const mimeType = item.mimeType
  if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') return null

  const data = item.data
  if (typeof data !== 'string' || data.length === 0) return null

  return {
    id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    kind: 'image',
    mimeType: mimeType as 'image/jpeg' | 'image/png',
    encoding: 'base64',
    dataBase64: data,
    filename: typeof item.filename === 'string' ? item.filename : undefined,
    caption: typeof item.caption === 'string' ? item.caption : undefined,
    width: typeof item.width === 'number' ? item.width : undefined,
    height: typeof item.height === 'number' ? item.height : undefined,
    sourceTool,
  }
}

function extractMcpContent(
  resultBody: unknown,
  sourceTool: string
): {
  textParts: string[]
  attachments: Attachment[]
} {
  const textParts: string[] = []
  const attachments: Attachment[] = []

  const resultRecord = asRecord(resultBody)
  const content = resultRecord?.content
  const contentItems = Array.isArray(content) ? content : []

  for (const item of contentItems) {
    const rec = asRecord(item)
    if (!rec) continue

    if (rec.type === 'text' && typeof rec.text === 'string') {
      textParts.push(rec.text)
      continue
    }

    const image = parseImageContentPart(rec, sourceTool)
    if (image) {
      attachments.push(image)
    }
  }

  return { textParts, attachments }
}

/**
 * Wraps an MCP tool (from McpManager) as a spec Tool.
 *
 * MCP tools default to: requiresSanitization=true, requiresApproval=false.
 * Tool names preserve the serverName__toolName convention (Risk 4.8).
 */
class McpToolAdapter implements Tool {
  // One bounded successful pair per adapter avoids re-running Ajv after approval.
  // Every use still serializes the live schema and arguments and checks freshness.
  private validated?: { schemaJson: string; paramsJson: string }

  constructor(
    private readonly fullName: string,
    private readonly desc: string,
    private readonly schema: Record<string, unknown>,
    private readonly mcpManager: McpManager,
    /**
     * Authoritative server name from `McpTool.serverName` (set by the MCP client
     * at connect). Carried explicitly because `traceDescriptor()` feeds the
     * tool-lane guardrail identity that `server=` rules match on — see below.
     */
    private readonly serverName: string,
    private readonly userId: string | undefined,
    private readonly strictValidation: boolean
  ) {}

  name() {
    return this.fullName
  }
  description() {
    return this.desc
  }
  parametersSchema() {
    return this.schema
  }
  requiresSanitization() {
    return true
  }
  requiresApproval() {
    return false
  }
  private liveTool() {
    return this.mcpManager
      .getAllTools()
      .find(tool => tool.name === this.fullName && serverNameOf(tool) === this.serverName)
  }

  private validationFailure(
    code: SchemaValidationFailure | 'tool_changed' | 'input_invalid'
  ): ValidationResult {
    const messages = {
      input_limit:
        'MCP validation input exceeds the supported size limit; reduce the request size.',
      input_invalid:
        'MCP schema or arguments are not supported bounded JSON; check their structure and size.',
      queue_full: 'MCP validation is busy; retry shortly.',
      timeout: 'MCP validation exceeded its time limit; retry or simplify the request.',
      unsupported_schema:
        'This MCP schema dialect or asynchronous schema is unsupported by local validation; ask the server owner to update it.',
      invalid_schema:
        'The MCP schema could not be compiled locally; ask the server owner to correct it.',
      invalid_arguments: 'Arguments do not match the current MCP schema; correct the arguments.',
      worker_failure:
        'MCP validation could not complete; retry and contact the administrator if it persists.',
      tool_changed:
        'The MCP tool or arguments changed during validation; retry with the current tool definition.',
    }
    logger.warn({ component: 'ToolRegistry', validationFailure: code }, 'MCP validation rejected')
    return { is_valid: false, errors: [messages[code]] }
  }

  private async validateCurrent(params: Record<string, unknown>) {
    const live = this.liveTool()
    try {
      if (!live || !asRecord(live.inputSchema)) {
        this.validated = undefined
        return { result: this.validationFailure('tool_changed') }
      }
      const schemaJson = boundedJson(live.inputSchema)
      const paramsJson = boundedJson(params)
      if (this.validated?.schemaJson !== schemaJson || this.validated?.paramsJson !== paramsJson) {
        this.validated = undefined
        let failure: SchemaValidationFailure = 'worker_failure'
        if (
          !(await validateBoundedSchema(schemaJson, paramsJson, code => {
            failure = code
          }))
        )
          return { result: this.validationFailure(failure) }
        this.validated = { schemaJson, paramsJson }
      }
      return { result: { is_valid: true, errors: [] } as ValidationResult, schemaJson, paramsJson }
    } catch (error) {
      // Never include raw schemas, arguments or validator diagnostics in errors.
      this.validated = undefined
      return {
        result: this.validationFailure(
          error instanceof BoundedJsonError ? error.failure : 'input_invalid'
        ),
      }
    }
  }

  private validationStillCurrent(
    checked: Awaited<ReturnType<McpToolAdapter['validateCurrent']>>,
    params: Record<string, unknown>
  ): boolean {
    try {
      const live = this.liveTool()
      return (
        checked.result.is_valid &&
        !!live &&
        boundedJson(live.inputSchema) === checked.schemaJson &&
        boundedJson(params) === checked.paramsJson
      )
    } catch {
      return false
    }
  }

  async validateParams(params: Record<string, unknown>): Promise<ValidationResult> {
    if (!this.strictValidation) return { is_valid: true, errors: [] }
    const checked = await this.validateCurrent(params)
    if (!checked.result.is_valid) return checked.result
    return this.validationStillCurrent(checked, params)
      ? checked.result
      : this.validationFailure('tool_changed')
  }
  traceDescriptor() {
    // `sourceRef` is the tool-lane guardrail's `server` identity (provenance.ts),
    // so a `server=` deny rule matches on THIS value. It used to be sliced off the
    // display name at the first `__`, which is a guess: a server whose own name
    // contains `__` derives truncated, the rule then fails to match, and a deny
    // that does not match lets the call through. Registration hands over the
    // registry's own `serverName` instead — the same value `serverNameOf` uses in
    // the tool catalog.
    return {
      kind: 'mcp_server_tool' as const,
      sourceRef: this.serverName || null,
    }
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const startTime = Date.now()
    try {
      // An approval may have been suspended with an older adapter/schema.
      // Resolve the live schema again immediately before manager dispatch.
      const checked = this.strictValidation ? await this.validateCurrent(params) : undefined
      // No await between the freshness check and manager dispatch: catalog or
      // argument changes during worker evaluation cannot authorize this call.
      if (checked && !this.validationStillCurrent(checked, params)) {
        return {
          content: (checked.result.is_valid
            ? this.validationFailure('tool_changed')
            : checked.result
          ).errors.join(' '),
          duration_ms: Date.now() - startTime,
          is_error: true,
        }
      }
      // Principal binding (PR #319 C2/H1): the broker grant subject is ALWAYS
      // `this.userId` — the authenticated task sender baked in at construction
      // (taskExecutor threads `task.sourceMessage.sender`, itself bound to the
      // rpc-proxy edge `auth.sub` in handleMessageRoute). `params` is model /
      // tool-arg data and is forwarded as the call payload only; it can NEVER
      // become the identity, so a `userId` field inside `params` cannot spoof
      // another user's broker token.
      const result = await this.mcpManager.callTool(this.fullName, params, {
        userId: this.userId,
      })
      const { textParts, attachments } = extractMcpContent(result.result, this.fullName)

      let content: string
      if (textParts.length > 0) {
        content = textParts.join('\n')
      } else if (attachments.length > 0) {
        content = `Generated ${attachments.length} JPEG attachment(s).`
      } else {
        content = typeof result.result === 'string' ? result.result : JSON.stringify(result.result)
      }

      return {
        content,
        duration_ms: Date.now() - startTime,
        is_error: result.isError,
        attachments: attachments.length > 0 ? attachments : undefined,
        // U5 — map the typed reactive-consent marker to `metadata.connect_required`
        // on the SUCCESS path (the manager never lets the McpAuthError throw reach
        // the catch below — that route would be dead code). The tool-use loop and
        // resume path read this to raise a durable `connect_required` suspension.
        metadata: result.connectRequired
          ? {
              connect_required: {
                mcpServerName: result.connectRequired.mcpServerName,
              },
            }
          : undefined,
      }
    } catch (err) {
      return {
        content: `MCP tool execution failed: ${(err as Error).message}`,
        duration_ms: Date.now() - startTime,
        is_error: true,
      }
    }
  }
}

/**
 * Wraps McpManager as a ToolRegistry.
 *
 * Risk 4.7: Converts provider-specific tool formats to generic ToolDefinition[].
 * Risk 4.8: Preserves serverName__toolName naming convention.
 */
export class McpToolRegistryAdapter implements ToolRegistry {
  private tools = new Map<string, Tool>()

  /**
   * @param userId caller identity (authenticated session `sender`) threaded to
   *   `manager.callTool` so oauth grantScope='user' tools dispatch to the
   *   caller's per-user partition. A fresh adapter is built per turn, so it
   *   always carries exactly one userId.
   */
  constructor(
    private readonly mcpManager: McpManager,
    private readonly userId?: string,
    // Codex bridge dispatch promises local, bounded schema validation. Other
    // providers retain their existing MCP server-side validation contract.
    private readonly options: { strictValidation?: boolean } = {}
  ) {
    this.refresh()
  }

  get(name: string): Tool | null {
    return this.tools.get(name) ?? null
  }

  listDefinitions(): ToolDefinition[] {
    this.refresh() // Re-read from McpManager on every call
    const defs = Array.from(this.tools.values()).map(t => ({
      name: t.name(),
      description: t.description(),
      parameters: t.parametersSchema(),
    }))
    logger.info({ component: 'ToolRegistry', toolCount: defs.length }, 'MCP tools loaded')
    return defs
  }

  register(_tool: Tool): void {
    // MCP tools are registered via McpManager, not here
    throw new Error('Cannot register tools directly on McpToolRegistryAdapter')
  }

  /**
   * Rebuild tool map from McpManager.
   * Called on every listDefinitions() to support hot-registration
   * (Risk 4.6: tool refresh per iteration).
   */
  private refresh(): void {
    this.tools.clear()
    // getAllTools() returns names already prefixed as serverName__toolName, and
    // preserves the authoritative `serverName` alongside it. `serverNameOf` reads
    // that field and only falls back to parsing the prefix when it is absent.
    const allTools = this.mcpManager.getAllTools()
    for (const mcpTool of allTools) {
      this.tools.set(
        mcpTool.name,
        new McpToolAdapter(
          mcpTool.name,
          mcpTool.description || '',
          mcpTool.inputSchema || {},
          this.mcpManager,
          serverNameOf(mcpTool),
          this.userId,
          this.options.strictValidation === true
        )
      )
    }
  }
}

/**
 * Merges native tools (plain names) with MCP tools (prefixed names).
 *
 * Resolution order: native first (Risk 3.5.6).
 * In practice, no collision is possible because MCP tools use
 * the serverName__ prefix and native tools use plain names.
 */
export class CompositeToolRegistry implements ToolRegistry {
  constructor(
    private readonly nativeRegistry: ToolRegistry,
    private readonly mcpRegistry: ToolRegistry
  ) {}

  get(name: string): Tool | null {
    // Native first (Risk 3.5.6)
    return this.nativeRegistry.get(name) ?? this.mcpRegistry.get(name)
  }

  getNative(name: string): Tool | null {
    return this.nativeRegistry.get(name)
  }

  listDefinitions(): ToolDefinition[] {
    return [...this.nativeRegistry.listDefinitions(), ...this.mcpRegistry.listDefinitions()]
  }

  register(tool: Tool): void {
    // New tools go to native registry by default
    this.nativeRegistry.register(tool)
  }
}
