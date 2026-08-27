import { serverNameOf } from '../../capabilities/toolCatalogTools'
import { McpManager } from '../../mcp/manager'
import { Tool, ToolRegistry } from '../interfaces'
import { Attachment, ToolDefinition, ToolOutput } from '../types'

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
    private readonly userId?: string
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
                provider: result.connectRequired.provider,
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
    private readonly userId?: string
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
    console.log(`[NewCore:ToolRegistry] MCP tools loaded: ${defs.length}`)
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
          this.userId
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
