/**
 * MCP Manager - manages connections to multiple MCP servers.
 */
import { McpServerInfo, McpTool, ToolCallResult } from '../types'
import { McpClient, type McpToolCallOptions } from './client'
import type { McpProxyHostAuthorization } from './proxyAuth'
import { ServerStatusTracker } from './serverStatus'

export interface McpStatusRefreshSummary {
  serverCount: number
  succeeded: number
  failed: number
  toolCount: number
  outputSchemaCount: number
  aborted: boolean
}

export type McpAdmissionOutcome = 'applied' | 'stale'
export interface McpAdmissionControl {
  isCurrent?: () => boolean
  onCommit?: () => void
  scheduleCleanup?: (cleanup: McpDetachedServerCleanup) => void
}
export type McpDetachedServerCleanup = () => Promise<void>

interface PendingAdmission {
  attempt: symbol
  client: McpClient
}

interface ClientRetirement {
  cleanup: McpDetachedServerCleanup
  claimed: boolean
}

export class McpManager {
  private clients: Map<string, McpClient> = new Map()
  private serverInfos: Map<string, McpServerInfo> = new Map()
  private toolToServerMap: Map<string, string> = new Map()
  private pendingAdmissions: Map<string, PendingAdmission> = new Map()
  private clientRetirements = new WeakMap<McpClient, ClientRetirement>()
  private lifecycleEpoch = 0
  private closed = false
  private proxyUrl?: string
  private proxyHostAuthorization?: McpProxyHostAuthorization
  private statusTracker: ServerStatusTracker

  constructor(
    proxyUrl?: string,
    statusTracker?: ServerStatusTracker,
    proxyHostAuthorization?: McpProxyHostAuthorization
  ) {
    this.proxyUrl = proxyUrl
    this.proxyHostAuthorization = proxyHostAuthorization
    this.statusTracker = statusTracker ?? new ServerStatusTracker()
    if (proxyUrl) {
      console.log(`[McpManager] Proxy mode enabled: ${proxyUrl}`)
    }
  }

  /**
   * The shared status tracker. Exposed so higher layers (status endpoint,
   * background heartbeat) can read snapshots and touch entries.
   */
  get status(): ServerStatusTracker {
    return this.statusTracker
  }

  private clearToolMappings(serverName: string): void {
    for (const [toolName, server] of this.toolToServerMap.entries()) {
      if (server === serverName) {
        this.toolToServerMap.delete(toolName)
      }
    }
  }

  private installConnectedClient(serverConfig: McpServerInfo, client: McpClient): void {
    this.clearToolMappings(serverConfig.name)
    this.clients.set(serverConfig.name, client)
    this.serverInfos.set(serverConfig.name, serverConfig)

    for (const tool of client.availableTools) {
      const fullToolName = `${serverConfig.name}__${tool.name}`
      this.toolToServerMap.set(fullToolName, serverConfig.name)
    }

    this.statusTracker.markConnected(serverConfig.name, client.availableTools.length)
  }

  private claimClientCleanup(client: McpClient): McpDetachedServerCleanup | undefined {
    let retirement = this.clientRetirements.get(client)
    if (!retirement) {
      const cleanupClient = client.retire()
      let cleanupPromise: Promise<void> | undefined
      retirement = {
        claimed: false,
        cleanup: () => {
          if (!cleanupPromise) {
            try {
              cleanupPromise = Promise.resolve(cleanupClient())
            } catch (error) {
              cleanupPromise = Promise.reject(error)
            }
          }
          return cleanupPromise
        },
      }
      this.clientRetirements.set(client, retirement)
    }
    if (retirement.claimed) return undefined
    retirement.claimed = true
    return retirement.cleanup
  }

  private scheduleClientCleanup(client: McpClient, control: McpAdmissionControl): Promise<void> {
    const cleanup = this.claimClientCleanup(client)
    if (!cleanup) return Promise.resolve()
    if (control.scheduleCleanup) {
      control.scheduleCleanup(cleanup)
      return Promise.resolve()
    }
    return cleanup().catch(() => undefined)
  }

  /**
   * Retain an admission failure for inventory/status reporting when failure
   * occurs before McpClient.connect (for example, auth-token discovery).
   */
  recordAdmissionFailure(serverConfig: McpServerInfo, error: unknown): void {
    if (this.closed) return
    this.serverInfos.set(serverConfig.name, serverConfig)
    this.statusTracker.markFailed(serverConfig.name, error)
  }

  /**
   * Add and connect to an MCP server.
   */
  async addServer(
    serverConfig: McpServerInfo,
    authToken?: string,
    control: McpAdmissionControl = {}
  ): Promise<McpAdmissionOutcome> {
    const admissionLifecycleEpoch = this.lifecycleEpoch
    const externalIsCurrent = control.isCurrent ?? (() => true)
    const isCurrent = (): boolean =>
      !this.closed && this.lifecycleEpoch === admissionLifecycleEpoch && externalIsCurrent()
    if (!isCurrent()) return 'stale'

    // Skip disabled servers — operator intent, not infra failure.
    if (!serverConfig.enabled) {
      console.log(`[McpManager] Skipping disabled server: ${serverConfig.name}`)
      this.serverInfos.set(serverConfig.name, serverConfig)
      this.statusTracker.markDisabled(serverConfig.name)
      control.onCommit?.()
      return 'applied'
    }

    // Explicitly non-authoritative readiness is a fail-closed admission
    // signal, not permission to open a new connection.
    if (serverConfig.status?.authoritative === false) {
      console.log(
        `[McpManager] Skipping server with non-authoritative readiness: ${serverConfig.name}`
      )
      this.serverInfos.set(serverConfig.name, serverConfig)
      this.statusTracker.markNotReady(serverConfig.name, serverConfig.status?.message)
      control.onCommit?.()
      return 'applied'
    }

    // Skip servers that aren't ready yet — transient infra, surfaced as not_ready.
    if (!serverConfig.status?.ready) {
      console.log(
        `[McpManager] Skipping server not ready: ${serverConfig.name} (${serverConfig.status?.message || 'unknown'})`
      )
      this.serverInfos.set(serverConfig.name, serverConfig)
      this.statusTracker.markNotReady(serverConfig.name, serverConfig.status?.message)
      control.onCommit?.()
      return 'applied'
    }

    // Check if already connected
    if (this.clients.has(serverConfig.name)) {
      const installed = this.serverInfos.get(serverConfig.name)
      if (installed && JSON.stringify(installed) === JSON.stringify(serverConfig)) {
        console.log(`[McpManager] Server already connected: ${serverConfig.name}`)
        control.onCommit?.()
        return 'applied'
      }
      return this.replaceServer(serverConfig, authToken, control)
    }

    const client = new McpClient(
      serverConfig,
      authToken,
      this.proxyUrl,
      this.proxyHostAuthorization
    )
    const attempt = Symbol(serverConfig.name)
    this.pendingAdmissions.set(serverConfig.name, { attempt, client })
    this.statusTracker.markConnecting(serverConfig.name)

    try {
      await client.connect()
      if (!isCurrent() || this.pendingAdmissions.get(serverConfig.name)?.attempt !== attempt) {
        await this.scheduleClientCleanup(client, control)
        this.discardPendingAdmission(serverConfig.name, attempt)
        return 'stale'
      }
      this.pendingAdmissions.delete(serverConfig.name)
      this.installConnectedClient(serverConfig, client)
      control.onCommit?.()
      console.log(`[McpManager] Added server: ${serverConfig.name}`)
      return 'applied'
    } catch (error) {
      if (!isCurrent() || this.pendingAdmissions.get(serverConfig.name)?.attempt !== attempt) {
        await this.scheduleClientCleanup(client, control)
        this.discardPendingAdmission(serverConfig.name, attempt)
        return 'stale'
      }
      this.pendingAdmissions.delete(serverConfig.name)
      console.error(`[McpManager] Failed to add server ${serverConfig.name}:`, error)
      this.recordAdmissionFailure(serverConfig, error)
      // Surface the failed admission so callers can leave this server's
      // revision retryable while continuing to publish healthy peers.
      throw error
    }
  }

  /**
   * Connect a ready desired revision before committing it over the current
   * connection. A candidate failure leaves the previous client, tools,
   * serverInfo, and connected status untouched.
   */
  async replaceServer(
    serverConfig: McpServerInfo,
    authToken?: string,
    control: McpAdmissionControl = {}
  ): Promise<McpAdmissionOutcome> {
    const admissionLifecycleEpoch = this.lifecycleEpoch
    const externalIsCurrent = control.isCurrent ?? (() => true)
    const isCurrent = (): boolean =>
      !this.closed && this.lifecycleEpoch === admissionLifecycleEpoch && externalIsCurrent()
    if (!isCurrent()) return 'stale'

    const previousClient = this.clients.get(serverConfig.name)
    if (!previousClient) {
      return this.addServer(serverConfig, authToken, control)
    }

    const candidate = new McpClient(
      serverConfig,
      authToken,
      this.proxyUrl,
      this.proxyHostAuthorization
    )
    const attempt = Symbol(serverConfig.name)
    this.pendingAdmissions.set(serverConfig.name, { attempt, client: candidate })
    try {
      await candidate.connect()
    } catch (error) {
      await this.scheduleClientCleanup(candidate, control)
      if (!isCurrent() || this.pendingAdmissions.get(serverConfig.name)?.attempt !== attempt) {
        this.discardPendingAdmission(serverConfig.name, attempt)
        return 'stale'
      }
      this.pendingAdmissions.delete(serverConfig.name)
      throw error
    }

    if (!isCurrent() || this.pendingAdmissions.get(serverConfig.name)?.attempt !== attempt) {
      await this.scheduleClientCleanup(candidate, control)
      this.discardPendingAdmission(serverConfig.name, attempt)
      return 'stale'
    }
    this.pendingAdmissions.delete(serverConfig.name)

    // Commit is synchronous: readers see either the complete previous
    // revision or the complete connected candidate, never a missing server.
    this.installConnectedClient(serverConfig, candidate)
    control.onCommit?.()

    await this.scheduleClientCleanup(previousClient, control)
    console.log(`[McpManager] Replaced server: ${serverConfig.name}`)
    return 'applied'
  }

  /**
   * Revoke an MCP server synchronously, returning bounded async cleanup.
   *
   * Callers can detach every server in an authoritative revocation snapshot
   * before awaiting any potentially slow disconnect. This makes tools and
   * status fail closed immediately without creating an unbounded cleanup burst.
   */
  detachServer(serverName: string): McpDetachedServerCleanup {
    const pending = this.pendingAdmissions.get(serverName)
    const clients = new Set(
      [this.clients.get(serverName), pending?.client].filter(
        (client): client is McpClient => client !== undefined
      )
    )
    const cleanups = [...clients]
      .map(client => this.claimClientCleanup(client))
      .filter((cleanup): cleanup is McpDetachedServerCleanup => cleanup !== undefined)

    this.clearToolMappings(serverName)
    this.clients.delete(serverName)
    this.serverInfos.delete(serverName)
    this.pendingAdmissions.delete(serverName)
    this.statusTracker.remove(serverName)

    return async () => {
      await this.runDetachedCleanups(cleanups)
      console.log(`[McpManager] Removed server: ${serverName}`)
    }
  }

  /**
   * Remove and disconnect from an MCP server.
   */
  async removeServer(serverName: string): Promise<void> {
    await this.detachServer(serverName)()
  }

  /**
   * Disconnect from all MCP servers. Subsystem reset — per spec §4.5 this is
   * the one path that allows `connecting` to reappear afterwards.
   */
  async disconnectAll(): Promise<void> {
    await this.runDetachedCleanups(this.detachAllServers())
  }

  /**
   * Permanently close this manager. Unlike disconnectAll(), a closed manager
   * cannot be authorized again by a delayed poll or direct admission.
   */
  async close(scheduleCleanup?: (cleanup: McpDetachedServerCleanup) => void): Promise<void> {
    if (this.closed) return
    this.closed = true
    const cleanups = this.detachAllServers()
    if (scheduleCleanup) {
      for (const cleanup of cleanups) {
        scheduleCleanup(cleanup)
      }
      return
    }
    await this.runDetachedCleanups(cleanups)
  }

  private detachAllServers(): McpDetachedServerCleanup[] {
    this.lifecycleEpoch += 1
    const serverNames = [...new Set([...this.clients.keys(), ...this.pendingAdmissions.keys()])]
    const cleanups = serverNames.map(name => this.detachServer(name))
    this.toolToServerMap.clear()
    this.serverInfos.clear()
    this.pendingAdmissions.clear()
    this.statusTracker.reset()
    return cleanups
  }

  private async runDetachedCleanups(cleanups: McpDetachedServerCleanup[]): Promise<void> {
    let firstError: unknown
    let cleanupFailed = false
    for (const cleanup of cleanups) {
      try {
        await cleanup()
      } catch (error) {
        if (!cleanupFailed) firstError = error
        cleanupFailed = true
      }
    }
    if (cleanupFailed) {
      throw firstError
    }
  }

  /**
   * Get all available tools from all connected servers.
   * Tool names are prefixed with server name to avoid conflicts.
   */
  getAllTools(): McpTool[] {
    const allTools: McpTool[] = []

    for (const client of this.clients.values()) {
      for (const tool of client.availableTools) {
        // Prefix tool name with server name for uniqueness
        allTools.push({
          ...tool,
          name: `${client.name}__${tool.name}`,
        })
      }
    }

    return allTools
  }

  /**
   * Build a description of all connected MCP servers and their tools.
   * Used to give the LLM full context about its available capabilities.
   */
  describeCapabilities(): string {
    if (this.clients.size === 0) {
      return 'No MCP servers are currently connected. You cannot use any tools.'
    }

    const sections: string[] = []

    for (const [serverName, client] of this.clients.entries()) {
      const info = this.serverInfos.get(serverName)
      const description = info?.description || 'No description available.'
      const tools = client.availableTools

      let section = `### ${serverName}\n${description}`

      if (tools.length > 0) {
        section += `\n\nTools (${tools.length}):`
        for (const tool of tools) {
          const toolDesc = tool.description ? ` — ${tool.description}` : ''
          section += `\n- ${serverName}__${tool.name}${toolDesc}`
        }
      } else {
        section += '\n\nNo tools available from this server.'
      }

      sections.push(section)
    }

    return `## Available MCP Servers\n\nYou have access to ${this.clients.size} MCP server(s) with ${this.getAllTools().length} tool(s) total.\nAlways use the full tool name (serverName__toolName) when calling tools.\n\n${sections.join('\n\n')}`
  }

  /**
   * Call a tool by its full name (serverName__toolName).
   */
  async callTool(
    fullToolName: string,
    args: Record<string, unknown>,
    options: McpToolCallOptions = {}
  ): Promise<ToolCallResult> {
    // Parse server name and tool name
    const parts = fullToolName.split('__')
    if (parts.length !== 2) {
      return {
        toolName: fullToolName,
        result: { error: `Invalid tool name format: ${fullToolName}` },
        isError: true,
      }
    }

    const [serverName, toolName] = parts
    const client = this.clients.get(serverName)

    if (!client) {
      return {
        toolName: fullToolName,
        result: { error: `MCP server not found: ${serverName}` },
        isError: true,
      }
    }

    try {
      const result = await client.callTool(toolName, args, options)
      return {
        toolName: fullToolName,
        result,
        isError: false,
      }
    } catch (error) {
      return {
        toolName: fullToolName,
        result: { error: error instanceof Error ? error.message : 'Unknown error' },
        isError: true,
      }
    }
  }

  /**
   * Probe every connected server's tool list and update the status tracker.
   * Called by the background heartbeat to keep `observedAt` fresh and to
   * classify refresh failures (spec §4.5 — stay connected, attach reason).
   *
   * Probes a stable client snapshot. State is written only after every probe
   * settles; an aborted round never mutates the last known server status.
   */
  async refreshAllServerStatus(options: McpToolCallOptions = {}): Promise<McpStatusRefreshSummary> {
    const entries = [...this.clients.entries()]
    if (options.signal?.aborted) {
      return {
        serverCount: entries.length,
        succeeded: 0,
        failed: 0,
        toolCount: 0,
        outputSchemaCount: 0,
        aborted: true,
      }
    }

    const results = await Promise.all(
      entries.map(async ([name, client]) => {
        try {
          return {
            name,
            client,
            // Probes share the round's abort signal directly: the heartbeat owns
            // round-level cancellation and no per-probe cancellation capability
            // exists, so wrapping the signal would only fake a seam.
            result: await client.probeTools({
              timeoutMs: options.timeoutMs,
              signal: options.signal,
            }),
          }
        } catch (error) {
          return { name, client, result: { ok: false as const, error, stale: false } }
        }
      })
    )
    // A probe only counts toward the round's tally when its result is
    // authoritative for the currently-installed client: never a client swapped
    // out mid-round, never a stale-error probe that raced a reconnect. This is
    // the same predicate the status commit below uses, so summary.succeeded /
    // summary.failed match what was written — a benign mid-round swap can't
    // inflate `failed` and flip the run's outcome on the series #148 watches.
    const committed = results.filter(
      ({ name, client, result }) =>
        this.clients.get(name) === client && !(!result.ok && result.stale)
    )
    const succeeded = committed.filter(({ result }) => result.ok).length
    const summary: McpStatusRefreshSummary = {
      serverCount: entries.length,
      succeeded,
      failed: committed.length - succeeded,
      toolCount: committed.reduce(
        (total, { result }) => total + (result.ok ? result.toolCount : 0),
        0
      ),
      outputSchemaCount: committed.reduce(
        (total, { result }) => total + (result.ok ? result.outputSchemaCount : 0),
        0
      ),
      aborted: options.signal?.aborted === true,
    }
    if (summary.aborted) return summary

    for (const { name, result } of committed) {
      if (result.ok) {
        this.statusTracker.updateToolCount(name, result.toolCount)
      } else {
        this.statusTracker.updateToolCount(name, 0, { refreshError: result.error })
      }
    }
    return summary
  }

  /**
   * Get connected server names.
   */
  getConnectedServers(): string[] {
    return [...this.clients.keys()]
  }

  /**
   * Get every server represented in manager inventory, including disabled,
   * not-ready, and failed-admission entries that have no connected client.
   */
  getKnownServers(): string[] {
    return [...new Set([...this.serverInfos.keys(), ...this.pendingAdmissions.keys()])]
  }

  private discardPendingAdmission(serverName: string, attempt: symbol): void {
    if (this.pendingAdmissions.get(serverName)?.attempt !== attempt) return
    this.pendingAdmissions.delete(serverName)
    if (!this.clients.has(serverName) && !this.serverInfos.has(serverName)) {
      this.statusTracker.remove(serverName)
    }
  }

  /**
   * Check if any servers are connected.
   */
  hasConnectedServers(): boolean {
    return this.clients.size > 0
  }
}
