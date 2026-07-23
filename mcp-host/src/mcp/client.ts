/**
 * MCP Client - connects to a single MCP server.
 * Supports both SSE (legacy) and Streamable HTTP transports.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { McpServerInfo, McpTool } from '../types'
import {
  type McpToolCallOptions,
  ensureNotAborted,
  remainingBudgetMs,
  requestOptions,
  resolveMcpRequestTimeoutMs,
  withRequestTimeout,
} from './requestOptions'

export type { McpToolCallOptions } from './requestOptions'

export class McpClient {
  private client: Client | null = null
  private transport: Transport | null = null
  private serverConfig: McpServerInfo
  private authToken?: string
  private proxyUrl?: string
  private tools: McpTool[] = []
  private connected: boolean = false
  private reconnectPromise: Promise<void> | null = null

  constructor(serverConfig: McpServerInfo, authToken?: string, proxyUrl?: string) {
    this.serverConfig = serverConfig
    this.authToken = authToken
    this.proxyUrl = proxyUrl
  }

  get name(): string {
    return this.serverConfig.name
  }

  get isConnected(): boolean {
    return this.connected
  }

  get availableTools(): McpTool[] {
    return this.tools
  }

  /**
   * Create the appropriate transport based on server configuration.
   */
  private resolveUrl(): string {
    const { transport } = this.serverConfig
    if (this.proxyUrl) {
      const url = `${this.proxyUrl}/servers/${this.serverConfig.name}/mcp`
      console.log(`[MCP:${this.name}] Using proxy URL: ${url}`)
      return url
    }
    return transport.url || `http://${this.serverConfig.name}.mcp-server.svc.cluster.local:3000/mcp`
  }

  private createTransport(): Transport {
    const { transport } = this.serverConfig
    const headers: Record<string, string> = {}

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`
    }

    const targetUrl = this.resolveUrl()

    if (this.proxyUrl || transport.type === 'streamableHttp') {
      console.log(`[MCP:${this.name}] Using Streamable HTTP transport`)
      return new StreamableHTTPClientTransport(new URL(targetUrl), {
        requestInit: {
          headers,
        },
      })
    }

    // Default to SSE (legacy) transport
    console.log(`[MCP:${this.name}] Using SSE transport`)
    return new SSEClientTransport(new URL(targetUrl), {
      requestInit: {
        headers,
      },
    })
  }

  /**
   * Connect to the MCP server.
   */
  async connect(options: McpToolCallOptions = {}): Promise<void> {
    const { transport } = this.serverConfig

    console.log(`[MCP:${this.name}] Connecting to ${transport.url} (${transport.type})...`)

    try {
      ensureNotAborted(options.signal)
      this.transport = this.createTransport()

      // Create MCP client
      this.client = new Client(
        {
          name: 'clerum-mcp-host',
          version: '1.0.0',
        },
        {
          capabilities: {},
        }
      )

      // MCP SDK Client.connect() does not currently accept request options.
      // Race it against the caller budget/signal so workflow setup cannot
      // outlive the step deadline if initialize hangs.
      await withRequestTimeout(
        this.client.connect(this.transport),
        options,
        'MCP SDK connect timeout'
      )
      this.connected = true

      console.log(`[MCP:${this.name}] Connected successfully`)

      // Fetch available tools
      await this.refreshTools(options)
    } catch (error) {
      console.error(`[MCP:${this.name}] Failed to connect:`, error)
      this.connected = false
      await this.disconnect().catch(() => undefined)
      throw error
    }
  }

  /**
   * Disconnect from the MCP server.
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close()
      } catch {
        // Ignore close errors
      }
      this.client = null
    }
    if (this.transport) {
      try {
        await this.transport.close()
      } catch {
        // Ignore close errors
      }
      this.transport = null
    }
    this.connected = false
    this.tools = []
    console.log(`[MCP:${this.name}] Disconnected`)
  }

  /**
   * Refresh the list of available tools from the server.
   */
  async refreshTools(options: McpToolCallOptions = {}): Promise<void> {
    if (!this.client || !this.connected) {
      console.warn(`[MCP:${this.name}] Not connected, cannot refresh tools`)
      return
    }

    const sdkRequestOptions = requestOptions(options.timeoutMs, options.signal)
    try {
      const response = await this.client.listTools(undefined, sdkRequestOptions)
      this.tools = (response.tools || []).map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
        serverName: this.name,
      }))

      console.log(`[MCP:${this.name}] Found ${this.tools.length} tool(s):`)
      for (const tool of this.tools) {
        console.log(
          `[MCP:${this.name}]   - ${tool.name}: ${tool.description || '(no description)'}`
        )
      }
    } catch (error) {
      console.error(`[MCP:${this.name}] Failed to list tools:`, error)
      this.tools = []
      throw error
    }
  }

  /**
   * Fetch the current tool list from the server and return the refreshed cache.
   * Workflow-mode step routing uses this method so tools/list failures remain
   * visible to the per-step connection gate instead of becoming an empty cache.
   */
  async listTools(options: McpToolCallOptions = {}): Promise<McpTool[]> {
    await this.refreshTools(options)
    return this.availableTools
  }

  /**
   * Probe the server with a fresh tools/list call. Surfaces the raw error so
   * the health tracker can classify it (auth_failed / upstream_5xx / etc).
   *
   * Unlike refreshTools(), this does NOT mutate `this.tools` on failure, so a
   * transient probe error during a heartbeat doesn't clobber the last known
   * tool list.
   */
  async probeTools(
    options: McpToolCallOptions = {}
  ): Promise<
    { ok: true; toolCount: number; outputSchemaCount: number } | { ok: false; error: unknown }
  > {
    if (!this.client || !this.connected) {
      return { ok: false, error: new Error(`${this.name} is not connected`) }
    }
    try {
      // Deliberately use the validated raw request instead of Client.listTools().
      // The SDK convenience method compiles output schemas and mutates task/output
      // metadata caches, which must remain owned by connection and explicit refresh.
      const response = await this.client.request(
        { method: 'tools/list', params: undefined },
        ListToolsResultSchema,
        requestOptions(options.timeoutMs, options.signal)
      )
      return {
        ok: true,
        toolCount: response.tools.length,
        outputSchemaCount: response.tools.filter(tool => tool.outputSchema !== undefined).length,
      }
    } catch (error) {
      return { ok: false, error }
    }
  }

  /**
   * Detect if an error is a stale session error (server pod restarted).
   * Known error codes/messages:
   *   -32003  "session not found"  — server lost the session
   *   -32000  "Server not initialized" — server restarted, client's session is stale
   */
  private isSessionError(error: unknown): boolean {
    // Check structured error properties first (more reliable)
    if (error && typeof error === 'object') {
      const code = (error as Record<string, unknown>).code
      if (code === -32003 || code === -32000) return true
    }
    // Fall back to string matching for wrapped/stringified errors
    const msg = String(error)
    return (
      msg.includes('session not found') ||
      msg.includes('Server not initialized') ||
      msg.includes('-32003') ||
      msg.includes('-32000')
    )
  }

  /**
   * Reconnect by tearing down the existing client/transport and creating new ones.
   */
  async reconnect(options: McpToolCallOptions = {}): Promise<void> {
    if (this.reconnectPromise) {
      return this.reconnectPromise
    }
    this.reconnectPromise = (async () => {
      console.log(`[MCP:${this.name}] Reconnecting...`)
      await this.disconnect()
      await this.connect(options)
    })()
    try {
      await this.reconnectPromise
    } finally {
      this.reconnectPromise = null
    }
  }

  /**
   * Call a tool on the MCP server.
   * On session errors (e.g. server pod restarted), reconnects and retries once.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    options: McpToolCallOptions = {}
  ): Promise<unknown> {
    if (!this.client || !this.connected) {
      throw new Error(`MCP server ${this.name} is not connected`)
    }

    console.log(`[MCP:${this.name}] Calling tool: ${toolName}`)
    console.log(`[MCP:${this.name}]   Args:`, JSON.stringify(args).substring(0, 200))
    ensureNotAborted(options.signal)
    const deadlineMs =
      options.timeoutMs !== undefined
        ? Date.now() + resolveMcpRequestTimeoutMs(options.timeoutMs)
        : undefined
    const callRequestOptions = () => requestOptions(remainingBudgetMs(deadlineMs), options.signal)

    try {
      ensureNotAborted(options.signal)
      const result = await this.client.callTool(
        {
          name: toolName,
          arguments: args,
        },
        undefined,
        callRequestOptions()
      )

      console.log(`[MCP:${this.name}] Tool result:`, JSON.stringify(result).substring(0, 200))
      return result
    } catch (error) {
      if (this.isSessionError(error)) {
        console.warn(`[MCP:${this.name}] Session lost, reconnecting and retrying after delay...`)
        try {
          // Brief delay before reconnect to avoid hammering the server
          const retryDelayMs = Math.min(1000, remainingBudgetMs(deadlineMs) ?? 1000)
          await new Promise(resolve => setTimeout(resolve, retryDelayMs))
          await this.reconnect({
            timeoutMs: remainingBudgetMs(deadlineMs),
            signal: options.signal,
          })
          ensureNotAborted(options.signal)
          const result = await this.client!.callTool(
            {
              name: toolName,
              arguments: args,
            },
            undefined,
            callRequestOptions()
          )
          console.log(
            `[MCP:${this.name}] Tool result (after reconnect):`,
            JSON.stringify(result).substring(0, 200)
          )
          return result
        } catch (retryError) {
          console.error(`[MCP:${this.name}] Tool call failed after reconnect:`, retryError)
          throw retryError
        }
      }
      console.error(`[MCP:${this.name}] Tool call failed:`, error)
      throw error
    }
  }
}
