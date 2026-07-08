/**
 * Per-Step MCP Server Router.
 *
 * Manages MCP client connections for a single step execution.
 * Stateless between steps — connections opened at step start, closed at step end.
 *
 * Security invariant: per-step isolation — no connection reuse across steps.
 *
 * Source of truth: STAGE-2-STEP-EXECUTION-ENGINE.md §4.3–§4.4
 */
import Ajv, { type ValidateFunction } from 'ajv'
import {
  AllowedToolsConfig,
  InternalToolDefinition,
  StepMcpServerRef,
  ToolCallRecord,
} from './types'

// ─── Tool Definition (simplified from MCP SDK) ─────────────────────────

export interface ToolDefinition {
  name: string // prefixed: serverName__toolName
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface ToolResult {
  content: unknown
  isError?: boolean
}

// ─── Errors ─────────────────────────────────────────────────────────────

export class StepRouterConnectionError extends Error {
  failedServers: string[]
  constructor(failedServers: string[]) {
    super(`Failed to connect to MCP servers: ${failedServers.join(', ')}`)
    this.name = 'StepRouterConnectionError'
    this.failedServers = failedServers
  }
}

export class ToolDispatchError extends Error {
  toolName: string
  constructor(toolName: string) {
    super(`Unknown tool: '${toolName}' — no matching server prefix`)
    this.name = 'ToolDispatchError'
    this.toolName = toolName
  }
}

export class ToolArgsValidationError extends Error {
  toolName: string
  validationErrors: string
  constructor(toolName: string, validationErrors: string) {
    super(`Invalid arguments for '${toolName}': ${validationErrors}`)
    this.name = 'ToolArgsValidationError'
    this.toolName = toolName
    this.validationErrors = validationErrors
  }
}

// ─── MCP Client Interface (for DI/mocking) ─────────────────────────────

export interface McpClientConnection {
  connect(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<void>
  listTools(options?: {
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>>
  callTool(
    toolName: string,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<ToolResult>
  disconnect(): Promise<void>
}

export type McpClientFactory = (server: StepMcpServerRef) => McpClientConnection

// ─── StepMcpRouter ──────────────────────────────────────────────────────

export class StepMcpRouter {
  private connections = new Map<string, McpClientConnection>()
  private toolMap = new Map<string, { serverName: string; rawToolName: string }>()
  private internalToolMap = new Map<string, InternalToolDefinition>()
  private internalToolValidators = new Map<string, ValidateFunction>()
  private allTools: ToolDefinition[] = []
  private readonly clientFactory: McpClientFactory
  private readonly ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true })
  private outputDir = '/output'

  constructor(clientFactory: McpClientFactory) {
    this.clientFactory = clientFactory
  }

  /**
   * Register internal tools (clerum__*) that execute locally without MCP connection.
   * Must be called before connect() so they appear in getFilteredTools().
   *
   * The tool's `parameters` JSON Schema is compiled into an AJV validator that
   * runs before each dispatch. Bad LLM output (wrong type, missing required,
   * unknown enum value) is rejected before reaching `execute()`.
   */
  registerInternalTools(tools: InternalToolDefinition[], outputDir: string): void {
    this.outputDir = outputDir
    for (const tool of tools) {
      this.allTools.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      })
      this.internalToolMap.set(tool.name, tool)
      try {
        this.internalToolValidators.set(tool.name, this.ajv.compile(tool.parameters))
      } catch (err) {
        // Schema failed to compile — dispatch falls through to runtime arg type-checking.
        // Surface the failure so schema regressions don't pass silently.
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`[StepMcpRouter] AJV compile failed for '${tool.name}': ${message}`)
      }
      // Also register in toolMap for consistent dispatch
      this.toolMap.set(tool.name, {
        serverName: 'clerum',
        rawToolName: tool.name.replace('clerum__', ''),
      })
    }
  }

  /**
   * Connect to all servers declared for this step.
   * Throws StepRouterConnectionError if any server is unreachable.
   */
  async connect(
    servers: StepMcpServerRef[],
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<void> {
    if (servers.length === 0) return

    const failed: string[] = []
    for (const server of servers) {
      const client = this.clientFactory(server)
      try {
        await client.connect(options)
        this.connections.set(server.name, client)
      } catch {
        failed.push(server.name)
      }
    }

    if (failed.length > 0) {
      // Disconnect any that succeeded before throwing
      await this.disconnect()
      throw new StepRouterConnectionError(failed)
    }

    // Preserve internal tools registered before connect()
    const savedInternalTools = [...this.allTools.filter(t => this.internalToolMap.has(t.name))]
    const savedToolMapEntries = [...this.toolMap.entries()].filter(([k]) =>
      this.internalToolMap.has(k)
    )

    // Build tool index from all connected servers
    this.allTools = [...savedInternalTools]
    this.toolMap.clear()
    for (const [k, v] of savedToolMapEntries) this.toolMap.set(k, v)
    const listFailed: string[] = []
    for (const [serverName, client] of this.connections) {
      try {
        const tools = await client.listTools(options)
        for (const tool of tools) {
          const prefixed = `${serverName}__${tool.name}`
          this.allTools.push({
            name: prefixed,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })
          this.toolMap.set(prefixed, { serverName, rawToolName: tool.name })
        }
      } catch {
        listFailed.push(serverName)
      }
    }
    if (listFailed.length > 0) {
      await this.disconnect()
      throw new StepRouterConnectionError(listFailed)
    }
  }

  /**
   * Return merged tool list from all connected servers.
   * Filter to only tools in allowedTools.include (if non-empty).
   */
  getFilteredTools(allowedTools?: AllowedToolsConfig): ToolDefinition[] {
    const include = allowedTools?.include
    if (!include || include.length === 0) {
      return [...this.allTools]
    }
    const includeSet = new Set(include)
    return this.allTools.filter(t => includeSet.has(t.name))
  }

  /**
   * Dispatch a tool call to the correct server by tool name prefix.
   * Internal tools (clerum__*) are dispatched locally without MCP connection.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<{ result: ToolResult; record: ToolCallRecord }> {
    if (options.signal?.aborted) {
      const reason =
        typeof options.signal.reason === 'string' && options.signal.reason.trim()
          ? options.signal.reason
          : 'step-timeout'
      throw new Error(reason)
    }

    // Check internal tools first
    const internalTool = this.internalToolMap.get(toolName)
    if (internalTool) {
      // Validate args against the tool's JSON Schema before dispatch.
      // Failures come back as recoverable tool-error results (not thrown)
      // so the LLM can read the error and retry within the same step.
      const validator = this.internalToolValidators.get(toolName)
      if (validator && !validator(args)) {
        const errorText = this.ajv.errorsText(validator.errors, { separator: '; ' })
        const errorResult = {
          success: false,
          error: `Invalid arguments: ${errorText}`,
        }
        const record: ToolCallRecord = {
          serverName: 'clerum',
          toolName: toolName.replace('clerum__', ''),
          args,
          result: errorResult,
          durationMs: 0,
        }
        return {
          result: { content: errorResult, isError: true },
          record,
        }
      }
      const start = Date.now()
      const internalResult = await internalTool.execute(args, this.outputDir)
      const durationMs = Date.now() - start
      const record: ToolCallRecord = {
        serverName: 'clerum',
        toolName: toolName.replace('clerum__', ''),
        args,
        result: internalResult,
        durationMs,
      }
      return {
        result: { content: internalResult, isError: !internalResult.success },
        record,
      }
    }

    const entry = this.toolMap.get(toolName)
    if (!entry) throw new ToolDispatchError(toolName)

    const client = this.connections.get(entry.serverName)
    if (!client) throw new ToolDispatchError(toolName)

    const start = Date.now()
    const result = await client.callTool(entry.rawToolName, args, options)
    const durationMs = Date.now() - start

    const record: ToolCallRecord = {
      serverName: entry.serverName,
      toolName: entry.rawToolName,
      args,
      result: result.content,
      durationMs,
    }

    return { result, record }
  }

  /**
   * Disconnect all servers. Safe to call on unconnected router.
   */
  async disconnect(): Promise<void> {
    const disconnectPromises = [...this.connections.values()].map(client =>
      client.disconnect().catch(() => {
        /* swallow disconnect errors */
      })
    )
    await Promise.all(disconnectPromises)
    this.connections.clear()
    this.toolMap.clear()
    this.internalToolMap.clear()
    this.internalToolValidators.clear()
    this.allTools = []
  }
}
