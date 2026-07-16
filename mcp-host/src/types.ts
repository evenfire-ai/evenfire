/**
 * Shared types for the MCP Host.
 */
import type { ApprovalConfig } from './core/extensions/approvalTypes'
import type { LlmProvider } from './llm/registryCore'

/**
 * Model configuration.
 */
export interface ModelConfig {
  provider: LlmProvider
  name: string
}

/** Phase 7–8: Workspace memory configuration. */
export interface MemoryConfig {
  enabled: boolean
  workspacePath?: string // default: /workspace (prod) or ./workspace (dev)
}

/** Phase 7–8: Identity & personalization configuration. */
export interface PersonalizationConfig {
  enabled: boolean
  identity?: string // seed content for IDENTITY.md
  soul?: string // seed content for SOUL.md
  agents?: string // seed content for AGENTS.md
  user?: string // seed content for USER.md
}

/** Phase 9: Heartbeat configuration. */
export interface HeartbeatConfig {
  enabled: boolean
  interval?: string // cron expression, e.g. "*/30 * * * *"
  maxFailures?: number
  notifyChannel?: 'telegram' | 'email' | 'slack' | 'teams'
  notifyChannelId?: string
  notifyUserId?: string
}

/**
 * Host CRD spec.
 */
export interface HostSpec {
  host: string
  contextRef: string
  secretRef: string
  channels?: string[]
  model?: ModelConfig
  /** Phase 6: Tool approval configuration. */
  approval?: ApprovalConfig
  /** Phase 7–8: Workspace memory. */
  memory?: MemoryConfig
  /** Phase 7–8: Identity & personalization. */
  personalization?: PersonalizationConfig
  /** Phase 9: Heartbeat. */
  heartbeat?: HeartbeatConfig
}

/**
 * Host CRD.
 */
export interface HostCRD {
  name: string
  namespace: string
  spec: HostSpec
}

/**
 * API keys loaded from secret, keyed by provider id (currently `openai`,
 * `claude`, `zai`, `bailian`). Derived from the provider registry so the set of
 * keys tracks the set of providers automatically.
 */
export type ApiKeys = Partial<Record<LlmProvider, string>>

// ─── MCP Server Info (from skill-mapper API) ────────────────────────────────
// These types match the curated response from the skill-mapper.
// They contain only what the mcp-host needs to connect to MCP servers,
// plus deployment status that only the operator knows.

/**
 * McpServer transport configuration.
 */
export interface McpServerTransport {
  type: 'sse' | 'streamableHttp' | 'stdio'
  url?: string
}

/**
 * McpServer authentication configuration.
 */
export interface McpServerAuth {
  type: 'none' | 'bearer' | 'basic' | 'apiKey'
  secretRef?: string
  secretKey?: string
}

/**
 * Deployment status of an MCP server (reported by the skill-mapper operator).
 */
export interface McpServerStatus {
  /** Whether the Deployment resource exists in the cluster. */
  deployed: boolean
  /** Whether the Deployment has at least one ready replica. */
  ready: boolean
  /** Human-readable status message. */
  message?: string
}

/**
 * MCP server info as provided by the skill-mapper API.
 * Contains only what the mcp-host needs to discover and connect to servers.
 */
export interface McpServerInfo {
  name: string
  description?: string
  contextRef: string
  transport: McpServerTransport
  auth?: McpServerAuth
  enabled: boolean
  status: McpServerStatus
}

/**
 * Tool definition from MCP server.
 */
export interface McpTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  serverName: string // Which MCP server this tool belongs to
}

/**
 * Tool call result.
 */
export interface ToolCallResult {
  toolName: string
  result: unknown
  isError: boolean
}
