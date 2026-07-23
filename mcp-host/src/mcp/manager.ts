/**
 * MCP Manager - manages connections to multiple MCP servers.
 */
import { McpServerInfo, McpTool, ToolCallResult } from '../types'
import { McpClient, type McpToolCallOptions } from './client'
import { ServerStatusTracker } from './serverStatus'

export interface McpStatusRefreshSummary {
  serverCount: number
  succeeded: number
  failed: number
  toolCount: number
  outputSchemaCount: number
  aborted: boolean
}

function deriveProbeSignal(roundSignal: AbortSignal | undefined): AbortSignal {
  const probeController = new AbortController()
  return roundSignal
    ? AbortSignal.any([roundSignal, probeController.signal])
    : probeController.signal
}

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

  /**
   * Add and connect to an MCP server.
   */
  async addServer(serverConfig: McpServerInfo, authToken?: string): Promise<void> {
    // Skip disabled servers — operator intent, not infra failure.
    if (!serverConfig.enabled) {
      console.log(`[McpManager] Skipping disabled server: ${serverConfig.name}`)
      this.statusTracker.markDisabled(serverConfig.name)
      return
    }

    // Skip servers that aren't ready yet — transient infra, surfaced as not_ready.
    if (!serverConfig.status?.ready) {
      console.log(
        `[McpManager] Skipping server not ready: ${serverConfig.name} (${serverConfig.status?.message || 'unknown'})`
      )
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
      this.clients.set(serverConfig.name, client)
      this.serverInfos.set(serverConfig.name, serverConfig)

      // Register tools from this server
      for (const tool of client.availableTools) {
        const fullToolName = `${serverConfig.name}__${tool.name}`
        this.toolToServerMap.set(fullToolName, serverConfig.name)
      }

      // tools/list has succeeded at least once → state becomes connected (spec §4.4).
      this.statusTracker.markConnected(serverConfig.name, client.availableTools.length)
      console.log(`[McpManager] Added server: ${serverConfig.name}`)
    } catch (error) {
      console.error(`[McpManager] Failed to add server ${serverConfig.name}:`, error)
      this.statusTracker.markFailed(serverConfig.name, error)
      // Don't throw - allow other servers to connect
    }
  }

  /**
   * Remove and disconnect from an MCP server.
   */
  async removeServer(serverName: string): Promise<void> {
    const client = this.clients.get(serverName)
    if (!client) {
      return
    }

    // Remove tool mappings
    for (const [toolName, server] of this.toolToServerMap.entries()) {
      if (server === serverName) {
        this.toolToServerMap.delete(toolName)
      }
    }

    await client.disconnect()
    this.clients.delete(serverName)
    this.serverInfos.delete(serverName)
    this.statusTracker.remove(serverName)
    console.log(`[McpManager] Removed server: ${serverName}`)
  }

  /**
   * Disconnect from all MCP servers. Subsystem reset — per spec §4.5 this is
   * the one path that allows `connecting` to reappear afterwards.
   */
  async disconnectAll(): Promise<void> {
    const serverNames = [...this.clients.keys()]
    for (const name of serverNames) {
      await this.removeServer(name)
    }
    this.toolToServerMap.clear()
    this.serverInfos.clear()
    this.statusTracker.reset()
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
            result: await client.probeTools({
              timeoutMs: options.timeoutMs,
              signal: deriveProbeSignal(options.signal),
            }),
          }
        } catch (error) {
          return { name, result: { ok: false as const, error } }
        }
      })
    )
    const succeeded = results.filter(({ result }) => result.ok).length
    const summary: McpStatusRefreshSummary = {
      serverCount: entries.length,
      succeeded,
      failed: entries.length - succeeded,
      toolCount: results.reduce(
        (total, { result }) => total + (result.ok ? result.toolCount : 0),
        0
      ),
      outputSchemaCount: results.reduce(
        (total, { result }) => total + (result.ok ? result.outputSchemaCount : 0),
        0
      ),
      aborted: options.signal?.aborted === true,
    }
    if (summary.aborted) return summary

    for (const { name, result } of results) {
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
   * Check if any servers are connected.
   */
  hasConnectedServers(): boolean {
    return this.clients.size > 0
  }
}
