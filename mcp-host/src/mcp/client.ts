/**
 * MCP Client - connects to a single MCP server.
 * Supports both SSE (legacy) and Streamable HTTP transports.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServerInfo, McpTool } from '../types'

const DEFAULT_MCP_TOOL_TIMEOUT_MS = 3_600_000
const DEFAULT_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS = 3_600_000
const MCP_TOOL_TIMEOUT_ENV = 'CLERUM_MCP_TOOL_TIMEOUT_MS'
const MCP_TOOL_MAX_TOTAL_TIMEOUT_ENV = 'CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS'

type SupportedMcpTransport = SSEClientTransport | StreamableHTTPClientTransport

export interface McpToolCallOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

interface McpSdkRequestOptions {
  timeout: number
  maxTotalTimeout: number
  signal?: AbortSignal
}

type McpProbeResult =
  | { ok: true; toolCount: number }
  | { ok: false; error: unknown; stale: boolean }

function readPositiveSafeIntegerEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return defaultValue
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive safe integer`)
  const value = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return value
}

function resolveMcpRequestTimeoutMs(callerTimeoutMs?: number): number {
  const configuredTimeoutMs = readPositiveSafeIntegerEnv(
    MCP_TOOL_TIMEOUT_ENV,
    DEFAULT_MCP_TOOL_TIMEOUT_MS
  )
  const configuredMaxTotalTimeoutMs = readPositiveSafeIntegerEnv(
    MCP_TOOL_MAX_TOTAL_TIMEOUT_ENV,
    DEFAULT_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS
  )
  if (
    configuredMaxTotalTimeoutMs < configuredTimeoutMs &&
    (callerTimeoutMs === undefined || callerTimeoutMs > configuredMaxTotalTimeoutMs)
  ) {
    throw new Error(
      `${MCP_TOOL_MAX_TOTAL_TIMEOUT_ENV} must be greater than or equal to ${MCP_TOOL_TIMEOUT_ENV}`
    )
  }
  if (callerTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(callerTimeoutMs) || callerTimeoutMs < 1) {
      throw new Error('caller MCP timeout must be a positive safe integer')
    }
    return Math.min(configuredTimeoutMs, configuredMaxTotalTimeoutMs, callerTimeoutMs)
  }
  return Math.min(configuredTimeoutMs, configuredMaxTotalTimeoutMs)
}

function ensureNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const reason =
    typeof signal.reason === 'string' && signal.reason.trim() ? signal.reason : 'aborted'
  throw new Error(reason)
}

function abortError(signal: AbortSignal | undefined, fallback: string): Error {
  const reason =
    typeof signal?.reason === 'string' && signal.reason.trim() ? signal.reason : fallback
  return new Error(reason)
}

function withRequestTimeout<T>(
  operation: Promise<T>,
  options: McpToolCallOptions,
  timeoutMessage: string
): Promise<T> {
  ensureNotAborted(options.signal)
  const timeoutMs = resolveMcpRequestTimeoutMs(options.timeoutMs)
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const resolveOnce = (value: T) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const rejectOnce = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onAbort = () => rejectOnce(abortError(options.signal, 'aborted'))
    const timer = setTimeout(
      () =>
        rejectOnce(new Error(options.timeoutMs !== undefined ? 'step-timeout' : timeoutMessage)),
      timeoutMs
    )
    options.signal?.addEventListener('abort', onAbort, { once: true })
    operation.then(resolveOnce, rejectOnce)
  })
}

function remainingBudgetMs(deadlineMs: number | undefined): number | undefined {
  if (deadlineMs === undefined) return undefined
  const remainingMs = deadlineMs - Date.now()
  if (remainingMs <= 0) throw new Error('step-timeout')
  return remainingMs
}

function requestOptions(
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined
): McpSdkRequestOptions {
  ensureNotAborted(signal)
  const timeout = resolveMcpRequestTimeoutMs(timeoutMs)
  return { timeout, maxTotalTimeout: timeout, ...(signal ? { signal } : {}) }
}

export class McpClient {
  private client: Client | null = null
  private transport: SupportedMcpTransport | null = null
  private serverConfig: McpServerInfo
  private authToken?: string
  private proxyUrl?: string
  private tools: McpTool[] = []
  private connected: boolean = false
  private reconnectPromise: Promise<void> | null = null
  private connectionEpoch = 0
  private retired = false
  private readonly transportCleanups = new WeakMap<SupportedMcpTransport, Promise<void>>()

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

  private lifecycleError(reason: 'closed' | 'superseded'): Error {
    return new Error(`MCP client ${this.name} is ${reason}`)
  }

  private ensureNotRetired(): void {
    if (this.retired) throw this.lifecycleError('closed')
  }

  private isCurrentConnection(
    epoch: number,
    client: Client,
    transport: SupportedMcpTransport
  ): boolean {
    return (
      !this.retired &&
      this.connectionEpoch === epoch &&
      this.client === client &&
      this.transport === transport
    )
  }

  private isCallCurrent(epoch: number, client: Client): boolean {
    return (
      !this.retired && this.connectionEpoch === epoch && this.client === client && this.connected
    )
  }

  private ensureCallCurrent(epoch: number, client: Client): void {
    if (this.isCallCurrent(epoch, client)) return
    throw this.lifecycleError(this.retired ? 'closed' : 'superseded')
  }

  private detachConnection(): () => Promise<void> {
    const transport = this.transport
    this.connectionEpoch += 1
    this.client = null
    this.transport = null
    this.connected = false
    this.tools = []

    // Start physical I/O revocation now. The cleanup lane owns only awaiting
    // this shared promise, so a saturated cleanup queue cannot leave an
    // authenticated transport active after local authority was revoked.
    const cleanup = transport ? this.closeCapturedTransport(transport) : Promise.resolve()
    return () => cleanup
  }

  private closeCapturedTransport(transport: SupportedMcpTransport): Promise<void> {
    const existingCleanup = this.transportCleanups.get(transport)
    if (existingCleanup) return existingCleanup

    let cleanup: Promise<void>
    try {
      // Both supported SDK transports abort their active I/O synchronously
      // inside close(). Invoke it before returning while sharing the resulting
      // cleanup across retirement and late connection continuations.
      cleanup = transport.close().catch(() => undefined)
    } catch {
      cleanup = Promise.resolve()
    }
    this.transportCleanups.set(transport, cleanup)
    return cleanup
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

  private createTransport(): SupportedMcpTransport {
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

    this.ensureNotRetired()
    const connectionEpoch = ++this.connectionEpoch
    const nextTransport = this.createTransport()
    const nextClient = new Client(
      {
        name: 'clerum-mcp-host',
        version: '1.0.0',
      },
      {
        capabilities: {},
      }
    )
    this.transport = nextTransport
    this.client = nextClient

    try {
      ensureNotAborted(options.signal)

      // MCP SDK Client.connect() does not currently accept request options.
      // Race it against the caller budget/signal so workflow setup cannot
      // outlive the step deadline if initialize hangs.
      await withRequestTimeout(
        nextClient.connect(nextTransport),
        options,
        'MCP SDK connect timeout'
      )
      if (!this.isCurrentConnection(connectionEpoch, nextClient, nextTransport)) {
        throw this.lifecycleError(this.retired ? 'closed' : 'superseded')
      }
      this.connected = true

      console.log(`[MCP:${this.name}] Connected successfully`)

      // Fetch available tools
      await this.refreshTools(options)
      if (!this.isCurrentConnection(connectionEpoch, nextClient, nextTransport)) {
        throw this.lifecycleError(this.retired ? 'closed' : 'superseded')
      }
    } catch (error) {
      console.error(`[MCP:${this.name}] Failed to connect:`, error)
      if (this.client === nextClient && this.transport === nextTransport) {
        this.connectionEpoch += 1
        this.client = null
        this.transport = null
        this.connected = false
        this.tools = []
      }
      await this.closeCapturedTransport(nextTransport)
      if (this.retired) throw this.lifecycleError('closed')
      throw error
    }
  }

  /**
   * Disconnect from the MCP server.
   */
  async disconnect(): Promise<void> {
    // Revoke local authority before close I/O. The SDK Client owns this same
    // transport and Client.close() only delegates to transport.close(); calling
    // both duplicates the close and can strand revocation behind a wrapper
    // promise. The two transports created above abort their EventSource/fetch
    // synchronously inside close(), and their onclose hook clears Client state.
    const cleanup = this.detachConnection()
    await cleanup()
    console.log(`[MCP:${this.name}] Disconnected`)
  }

  /**
   * Permanently revoke this client before scheduling transport cleanup.
   *
   * Unlike disconnect(), retirement cannot be followed by an internal
   * reconnect. Transport abort begins before this method returns; the returned
   * cleanup only awaits the shared close result, so bounded cleanup lanes do
   * not delay physical revocation.
   */
  retire(): () => Promise<void> {
    this.retired = true
    return this.detachConnection()
  }

  /**
   * Refresh the list of available tools from the server.
   */
  async refreshTools(options: McpToolCallOptions = {}): Promise<void> {
    if (!this.client || !this.connected) {
      console.warn(`[MCP:${this.name}] Not connected, cannot refresh tools`)
      return
    }

    const refreshClient = this.client
    const refreshEpoch = this.connectionEpoch
    const sdkRequestOptions = requestOptions(options.timeoutMs, options.signal)
    let response: Awaited<ReturnType<Client['listTools']>>
    try {
      response = await refreshClient.listTools(undefined, sdkRequestOptions)
    } catch (error) {
      this.ensureCallCurrent(refreshEpoch, refreshClient)
      console.error(`[MCP:${this.name}] Failed to list tools:`, error)
      this.tools = []
      throw error
    }

    this.ensureCallCurrent(refreshEpoch, refreshClient)
    this.tools = (response.tools || []).map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      serverName: this.name,
    }))

    console.log(`[MCP:${this.name}] Found ${this.tools.length} tool(s):`)
    for (const tool of this.tools) {
      console.log(`[MCP:${this.name}]   - ${tool.name}: ${tool.description || '(no description)'}`)
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
  async probeTools(options: McpToolCallOptions = {}): Promise<McpProbeResult> {
    if (!this.client || !this.connected) {
      return {
        ok: false,
        error: new Error(`${this.name} is not connected`),
        stale: false,
      }
    }
    const probeClient = this.client
    const probeEpoch = this.connectionEpoch
    try {
      const response = await probeClient.listTools(
        undefined,
        requestOptions(options.timeoutMs, options.signal)
      )
      this.ensureCallCurrent(probeEpoch, probeClient)
      const toolCount = (response.tools || []).length
      return { ok: true, toolCount }
    } catch (error) {
      if (!this.isCallCurrent(probeEpoch, probeClient)) {
        return {
          ok: false,
          error: this.lifecycleError(this.retired ? 'closed' : 'superseded'),
          stale: true,
        }
      }
      return { ok: false, error, stale: false }
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
    this.ensureNotRetired()
    if (this.reconnectPromise) {
      return this.reconnectPromise
    }
    this.reconnectPromise = (async () => {
      console.log(`[MCP:${this.name}] Reconnecting...`)
      await this.disconnect()
      this.ensureNotRetired()
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
    this.ensureNotRetired()
    const callClient = this.client
    const callEpoch = this.connectionEpoch

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
      const result = await callClient.callTool(
        {
          name: toolName,
          arguments: args,
        },
        undefined,
        callRequestOptions()
      )
      this.ensureCallCurrent(callEpoch, callClient)

      console.log(`[MCP:${this.name}] Tool result:`, JSON.stringify(result).substring(0, 200))
      return result
    } catch (error) {
      if (
        this.retired ||
        this.connectionEpoch !== callEpoch ||
        this.client !== callClient ||
        !this.connected
      ) {
        throw this.lifecycleError(this.retired ? 'closed' : 'superseded')
      }
      if (this.isSessionError(error)) {
        console.warn(`[MCP:${this.name}] Session lost, reconnecting and retrying after delay...`)
        try {
          // Brief delay before reconnect to avoid hammering the server
          const retryDelayMs = Math.min(1000, remainingBudgetMs(deadlineMs) ?? 1000)
          await new Promise(resolve => setTimeout(resolve, retryDelayMs))
          this.ensureCallCurrent(callEpoch, callClient)
          await this.reconnect({
            timeoutMs: remainingBudgetMs(deadlineMs),
            signal: options.signal,
          })
          ensureNotAborted(options.signal)
          const retryClient = this.client
          if (!retryClient || !this.connected) throw this.lifecycleError('superseded')
          const retryEpoch = this.connectionEpoch
          const result = await retryClient.callTool(
            {
              name: toolName,
              arguments: args,
            },
            undefined,
            callRequestOptions()
          )
          this.ensureCallCurrent(retryEpoch, retryClient)
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
