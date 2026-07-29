/**
 * Client for communicating with the Context Mapper service.
 *
 * The Context Mapper provides McpServer CRDs via REST API, so mcp-host
 * doesn't need direct K8s access to McpServer resources.
 */
import { config } from './config'
import { McpServerInfo } from './types'

export interface McpServersResponse {
  servers: McpServerInfo[]
  contextRef: string
  timestamp: string
}

export interface AuthTokenResponse {
  token: string | null
  message?: string
}

/**
 * Context Mapper client.
 */
export class ContextMapperClient {
  private baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '') // Remove trailing slash
  }

  /**
   * Health check.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/ready`)
      return response.ok
    } catch (error) {
      console.error('[ContextMapper] Health check failed:', error)
      return false
    }
  }

  /**
   * List all McpServers.
   */
  async listAllServers(): Promise<McpServerInfo[]> {
    try {
      console.log('[ContextMapper] Fetching all McpServers')

      const response = await fetch(`${this.baseUrl}/api/v1/mcpservers`)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = (await response.json()) as McpServersResponse
      console.log(`[ContextMapper] Found ${data.servers.length} McpServer(s)`)
      return data.servers
    } catch (error) {
      console.error('[ContextMapper] Failed to list servers:', error)
      return []
    }
  }

  /**
   * List McpServers by contextRef.
   * Rejects unavailable or invalid responses so callers cannot confuse a
   * failed discovery request with an authoritative empty inventory.
   */
  async listServersByContext(contextRef: string): Promise<McpServerInfo[]> {
    console.log(`[ContextMapper] Fetching McpServers for context: ${contextRef}`)

    const response = await fetch(
      `${this.baseUrl}/api/v1/mcpservers/context/${encodeURIComponent(contextRef)}`
    )

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const data = (await response.json()) as McpServersResponse
    console.log(
      `[ContextMapper] Found ${data.servers.length} McpServer(s) for context ${contextRef}`
    )
    console.log(`[ContextMapper] Response:`, JSON.stringify(data, null, 2))
    return data.servers
  }

  /**
   * Get auth token for an McpServer.
   */
  async getAuthToken(serverName: string): Promise<string | undefined> {
    console.log(`[ContextMapper] Fetching auth token for server: ${serverName}`)

    const response = await fetch(
      `${this.baseUrl}/api/v1/mcpservers/${encodeURIComponent(serverName)}/auth`
    )

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const data = (await response.json()) as AuthTokenResponse

    if (data.token) {
      console.log(`[ContextMapper] Found auth token for server: ${serverName}`)
      return data.token
    }

    console.log(`[ContextMapper] No auth token for server: ${serverName}`)
    return undefined
  }

  /**
   * Poll for changes to McpServers.
   * Returns only authoritative snapshots. Transport and HTTP failures reject
   * so callers preserve their last known fleet instead of treating an
   * unavailable controller as an authoritative empty inventory.
   */
  async pollServers(contextRef: string): Promise<{ servers: McpServerInfo[]; timestamp: string }> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/mcpservers/context/${encodeURIComponent(contextRef)}`
    )

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const data = (await response.json()) as McpServersResponse
    return { servers: data.servers, timestamp: data.timestamp }
  }
}

// Default client instance (configured from environment)
let defaultClient: ContextMapperClient | null = null

export function getContextMapperClient(): ContextMapperClient {
  if (!defaultClient) {
    defaultClient = new ContextMapperClient(config.contextMapperUrl)
  }
  return defaultClient
}
