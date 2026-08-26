/**
 * MCP Client - connects to a single MCP server.
 * Supports both SSE (legacy) and Streamable HTTP transports.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
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
import { extractStructuredHttpStatus, isAuthError } from './serverStatus'

export type { McpToolCallOptions } from './requestOptions'

type SupportedMcpTransport = SSEClientTransport | StreamableHTTPClientTransport

/**
 * Resolves the Bearer token for a connection just-in-time. `resolve()` is the
 * normal path (return a cached-then-fetched token, honoring expiry); `refresh()`
 * FORCES a fresh exchange (used after a live 401). A provider whose `resolve()`
 * returns undefined yields a token-less connection — the catalog "representative"
 * connection for an oauth server relies on this (connects without Authorization).
 */
export interface McpTokenProvider {
  resolve(): Promise<string | undefined>
  refresh(): Promise<string | undefined>
}

/**
 * A token provider that always yields the same static token (or none). Preserves
 * today's behavior for static (secretRef) servers and dev/workflow callers that
 * pass a plain token string.
 */
export function staticTokenProvider(token?: string): McpTokenProvider {
  return {
    resolve: async () => token,
    refresh: async () => token,
  }
}

/**
 * Terminal auth failure surfaced by a live tool call. Thrown when a 403 arrives
 * (insufficient scope — no retry) or a 401 survives one forced-refresh retry.
 * The manager evicts the affected per-user partition on this error.
 */
export class McpAuthError extends Error {
  readonly status: number
  constructor(serverName: string, status: number) {
    super(`MCP server ${serverName} auth failed (${status})`)
    this.name = 'McpAuthError'
    this.status = status
  }
}

interface McpCallRecovery {
  sourceEpoch: number
  sourceClient: Client
  targetEpoch?: number
  targetClient?: Client
  promise: Promise<void>
}

export class McpClient {
  private client: Client | null = null
  private transport: SupportedMcpTransport | null = null
  private serverConfig: McpServerInfo
  private tokenProvider?: McpTokenProvider
  /** Token resolved for the CURRENT connection, re-read on every (re)connect. */
  private currentAuthToken?: string
  private proxyUrl?: string
  private tools: McpTool[] = []
  private connected: boolean = false
  private reconnectPromise: Promise<void> | null = null
  private reconnectCallRecovery: McpCallRecovery | null = null
  private connectionEpoch = 0
  private retired = false
  private readonly retirementController = new AbortController()
  private readonly transportCleanups = new WeakMap<SupportedMcpTransport, Promise<void>>()

  constructor(serverConfig: McpServerInfo, tokenProvider?: McpTokenProvider, proxyUrl?: string) {
    this.serverConfig = serverConfig
    this.tokenProvider = tokenProvider
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

    // currentAuthToken is resolved per (re)connect in connect() below; a
    // representative (token-less) connection leaves it undefined → no header.
    if (this.currentAuthToken) {
      headers['Authorization'] = `Bearer ${this.currentAuthToken}`
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
    // Per-connection JIT token resolution (spec §6): the SDK bakes the
    // Authorization header once at transport-build time, so the token is
    // re-read here on EVERY (re)connect right before createTransport. A 401
    // recovery path forces a fresh exchange via tokenProvider.refresh() before
    // reconnecting, so this resolve() then returns the refreshed token.
    //
    // Only await when a provider exists, so the token-less path stays fully
    // synchronous up to the SDK connect (preserves abort/timeout ordering).
    if (this.tokenProvider) {
      this.currentAuthToken = await this.tokenProvider.resolve()
      ensureNotAborted(options.signal)
    } else {
      this.currentAuthToken = undefined
    }
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
    // The credential is no longer authoritative once this client is detached.
    // Clear the retained value synchronously before asynchronous transport
    // cleanup so a retired object cannot keep the old bearer alive in memory.
    this.currentAuthToken = undefined
    this.retirementController.abort(this.lifecycleError('closed'))
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
  async probeTools(
    options: McpToolCallOptions = {}
  ): Promise<
    | { ok: true; toolCount: number; outputSchemaCount: number }
    | { ok: false; error: unknown; stale: boolean }
  > {
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
      // Deliberately use the validated raw request instead of Client.listTools().
      // The SDK convenience method compiles output schemas and mutates task/output
      // metadata caches, which must remain owned by connection and explicit refresh.
      const response = await probeClient.request(
        { method: 'tools/list', params: undefined },
        ListToolsResultSchema,
        requestOptions(options.timeoutMs, options.signal)
      )
      // Preserve connection-epoch staleness: a probe that resolved against a
      // superseded/retired connection must not report counts for it.
      this.ensureCallCurrent(probeEpoch, probeClient)
      return {
        ok: true,
        toolCount: response.tools.length,
        outputSchemaCount: response.tools.filter(tool => tool.outputSchema !== undefined).length,
      }
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
    // A caller-independent reconnect supersedes any completed session
    // recovery. Calls from that older source must not adopt this connection.
    this.reconnectCallRecovery = null
    await this.startReconnect(options)
  }

  private async startReconnect(options: McpToolCallOptions): Promise<void> {
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
   * Join a session recovery only when it was started by another call from the
   * exact same connection. An unrelated reconnect or replacement must keep
   * stale calls fenced off. The completed source-to-target marker also lets a
   * slower peer adopt a recovery that finished before its retry delay elapsed.
   * Each joining caller retains its own budget and abort signal.
   */
  private async reconnectForCall(
    callEpoch: number,
    callClient: Client,
    options: McpToolCallOptions
  ): Promise<void> {
    this.ensureNotRetired()
    const existingRecovery = this.reconnectCallRecovery
    if (
      existingRecovery?.sourceEpoch === callEpoch &&
      existingRecovery.sourceClient === callClient
    ) {
      await this.waitForCallRecovery(existingRecovery, options)
      return
    }

    if (this.reconnectPromise) {
      throw this.lifecycleError('superseded')
    }

    this.ensureCallCurrent(callEpoch, callClient)
    const recovery: McpCallRecovery = {
      sourceEpoch: callEpoch,
      sourceClient: callClient,
      promise: Promise.resolve(),
    }
    recovery.promise = (async () => {
      try {
        // Recovery belongs to the connection lifecycle, not to whichever
        // affected call happens to win the race. Callers independently bound
        // their wait below without cancelling recovery for healthier peers.
        await this.startReconnect({})
        const targetClient = this.client
        const targetEpoch = this.connectionEpoch
        if (!targetClient) throw this.lifecycleError('superseded')
        this.ensureCallCurrent(targetEpoch, targetClient)
        if (this.reconnectCallRecovery !== recovery) {
          throw this.lifecycleError(this.retired ? 'closed' : 'superseded')
        }
        recovery.targetEpoch = targetEpoch
        recovery.targetClient = targetClient
      } catch (error) {
        if (this.reconnectCallRecovery === recovery) {
          this.reconnectCallRecovery = null
        }
        throw error
      }
    })()
    this.reconnectCallRecovery = recovery
    await this.waitForCallRecovery(recovery, options)
  }

  private async waitForCallRecovery(
    recovery: McpCallRecovery,
    options: McpToolCallOptions
  ): Promise<void> {
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.retirementController.signal])
      : this.retirementController.signal
    await withRequestTimeout(recovery.promise, { ...options, signal }, 'MCP reconnect timeout')
    const { targetEpoch, targetClient } = recovery
    if (
      targetEpoch === undefined ||
      !targetClient ||
      !this.isCallCurrent(targetEpoch, targetClient)
    ) {
      throw this.lifecycleError(this.retired ? 'closed' : 'superseded')
    }
  }

  private canAdoptCallRecovery(callEpoch: number, callClient: Client): boolean {
    const recovery = this.reconnectCallRecovery
    if (recovery?.sourceEpoch !== callEpoch || recovery.sourceClient !== callClient) {
      return false
    }
    if (recovery.targetEpoch === undefined && !recovery.targetClient) return true
    if (recovery.targetEpoch === undefined || !recovery.targetClient) return false
    return this.isCallCurrent(recovery.targetEpoch, recovery.targetClient)
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
      // Strict auth detection FIRST: only a structured 401/403 counts, never the
      // message regex (which would read '320' out of a JSON-RPC -32003 code).
      const authError = isAuthError(error)
      const sessionError = !authError && this.isSessionError(error)
      if (this.retired) {
        throw this.lifecycleError('closed')
      }
      const callCurrent = this.isCallCurrent(callEpoch, callClient)
      if (!callCurrent && (!sessionError || !this.canAdoptCallRecovery(callEpoch, callClient))) {
        // Auth recovery requires the call to still be current — a superseded
        // call never enters the refresh/retry path (it falls through here).
        throw this.lifecycleError('superseded')
      }
      if (authError) {
        const status = extractStructuredHttpStatus(error)
        // 403 (insufficient scope) is terminal — never enter the refresh retry.
        if (status === 403) {
          console.warn(`[MCP:${this.name}] Tool call rejected (403, insufficient scope) — terminal`)
          throw new McpAuthError(this.name, 403)
        }
        // 401: force a fresh token exchange, reconnect through the SAME fencing
        // as session recovery, and retry exactly once. A second 401 is terminal.
        console.warn(
          `[MCP:${this.name}] Tool call auth failed (401), refreshing token, retrying once...`
        )
        try {
          await this.tokenProvider?.refresh()
          ensureNotAborted(options.signal)
          await this.reconnectForCall(callEpoch, callClient, {
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
            `[MCP:${this.name}] Tool result (after auth refresh):`,
            JSON.stringify(result).substring(0, 200)
          )
          return result
        } catch (retryError) {
          if (isAuthError(retryError)) {
            // Second auth failure — terminal (auth_failed), evict upstream. No loop.
            const retryStatus = extractStructuredHttpStatus(retryError) ?? 401
            console.error(
              `[MCP:${this.name}] Tool call auth failed again (${retryStatus}) — terminal`
            )
            throw new McpAuthError(this.name, retryStatus)
          }
          console.error(`[MCP:${this.name}] Tool call failed after auth refresh:`, retryError)
          throw retryError
        }
      }
      if (sessionError) {
        console.warn(`[MCP:${this.name}] Session lost, reconnecting and retrying after delay...`)
        try {
          // Brief delay before reconnect to avoid hammering the server
          const retryDelayMs = Math.min(1000, remainingBudgetMs(deadlineMs) ?? 1000)
          await new Promise(resolve => setTimeout(resolve, retryDelayMs))
          ensureNotAborted(options.signal)
          await this.reconnectForCall(callEpoch, callClient, {
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
