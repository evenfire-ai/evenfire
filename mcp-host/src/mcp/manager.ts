/**
 * MCP Manager - manages connections to multiple MCP servers.
 */
import { McpServerInfo, McpTool, ToolCallResult } from '../types'
import { McpClient, type McpToolCallOptions } from './client'
import { ServerStatusTracker } from './serverStatus'

export class McpManager {
  private clients: Map<string, McpClient> = new Map()
  private serverInfos: Map<string, McpServerInfo> = new Map()
  private toolToServerMap: Map<string, string> = new Map()
  private proxyUrl?: string
  private statusTracker: ServerStatusTracker

  constructor(proxyUrl?: string, statusTracker?: ServerStatusTracker) {
    this.proxyUrl = proxyUrl
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

  /**
   * Retain an admission failure for inventory/status reporting when failure
   * occurs before McpClient.connect (for example, auth-token discovery).
   */
  recordAdmissionFailure(serverConfig: McpServerInfo, error: unknown): void {
    this.serverInfos.set(serverConfig.name, serverConfig)
    this.statusTracker.markFailed(serverConfig.name, error)
  }

  /**
   * Add and connect to an MCP server.
   */
  async addServer(serverConfig: McpServerInfo, authToken?: string): Promise<void> {
    // Skip disabled servers — operator intent, not infra failure.
    if (!serverConfig.enabled) {
      console.log(`[McpManager] Skipping disabled server: ${serverConfig.name}`)
      this.serverInfos.set(serverConfig.name, serverConfig)
      this.statusTracker.markDisabled(serverConfig.name)
      return
    }

    // Explicitly non-authoritative readiness is a fail-closed admission
    // signal, not permission to open a new connection.
    if (serverConfig.status?.authoritative === false) {
      console.log(
        `[McpManager] Skipping server with non-authoritative readiness: ${serverConfig.name}`
      )
      this.serverInfos.set(serverConfig.name, serverConfig)
      this.statusTracker.markNotReady(serverConfig.name, serverConfig.status?.message)
      return
    }

    // Skip servers that aren't ready yet — transient infra, surfaced as not_ready.
    if (!serverConfig.status?.ready) {
      console.log(
        `[McpManager] Skipping server not ready: ${serverConfig.name} (${serverConfig.status?.message || 'unknown'})`
      )
      this.serverInfos.set(serverConfig.name, serverConfig)
      this.statusTracker.markNotReady(serverConfig.name, serverConfig.status?.message)
      return
    }

    // Check if already connected
    if (this.clients.has(serverConfig.name)) {
      console.log(`[McpManager] Server already connected: ${serverConfig.name}`)
      return
    }

    const client = new McpClient(serverConfig, authToken, this.proxyUrl)
    this.statusTracker.markConnecting(serverConfig.name)

    try {
      await client.connect()
      this.installConnectedClient(serverConfig, client)
      console.log(`[McpManager] Added server: ${serverConfig.name}`)
    } catch (error) {
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
  async replaceServer(serverConfig: McpServerInfo, authToken?: string): Promise<void> {
    const previousClient = this.clients.get(serverConfig.name)
    if (!previousClient) {
      await this.addServer(serverConfig, authToken)
      return
    }

    const candidate = new McpClient(serverConfig, authToken, this.proxyUrl)
    try {
      await candidate.connect()
    } catch (error) {
      await candidate.disconnect().catch(() => undefined)
      throw error
    }

    // Commit is synchronous: readers see either the complete previous
    // revision or the complete connected candidate, never a missing server.
    this.installConnectedClient(serverConfig, candidate)

    try {
      await previousClient.disconnect()
    } catch (cleanupError) {
      console.error(
        `[McpManager] Failed to retire previous server ${serverConfig.name}:`,
        cleanupError
      )
    }
    console.log(`[McpManager] Replaced server: ${serverConfig.name}`)
  }

  /**
   * Remove and disconnect from an MCP server.
   */
  async removeServer(serverName: string): Promise<void> {
    const client = this.clients.get(serverName)
    let disconnectError: unknown
    let disconnectFailed = false

    this.clearToolMappings(serverName)
    try {
      await client?.disconnect()
    } catch (error) {
      disconnectFailed = true
      disconnectError = error
    } finally {
      this.clients.delete(serverName)
      this.serverInfos.delete(serverName)
      this.statusTracker.remove(serverName)
    }

    console.log(`[McpManager] Removed server: ${serverName}`)
    if (disconnectFailed) {
      throw disconnectError
    }
  }

  /**
   * Disconnect from all MCP servers. Subsystem reset — per spec §4.5 this is
   * the one path that allows `connecting` to reappear afterwards.
   */
  async disconnectAll(): Promise<void> {
    const serverNames = [...this.clients.keys()]
    let firstError: unknown
    let cleanupFailed = false
    for (const name of serverNames) {
      try {
        await this.removeServer(name)
      } catch (error) {
        if (!cleanupFailed) firstError = error
        cleanupFailed = true
      }
    }
    this.toolToServerMap.clear()
    this.serverInfos.clear()
    this.statusTracker.reset()
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
   * Returns the number of servers probed.
   */
  async refreshAllServerStatus(): Promise<number> {
    const entries = [...this.clients.entries()]
    await Promise.all(
      entries.map(async ([name, client]) => {
        const result = await client.probeTools()
        if (result.ok) {
          this.statusTracker.updateToolCount(name, result.toolCount)
        } else {
          this.statusTracker.updateToolCount(name, 0, { refreshError: result.error })
        }
      })
    )
    return entries.length
  }

  /**
   * Get connected server names.
   */
  getConnectedServers(): string[] {
    return [...this.clients.keys()]
  }

  /**
   * Check if any servers are connected.
   */
  hasConnectedServers(): boolean {
    return this.clients.size > 0
  }
}
