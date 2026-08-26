/**
 * Shared types for the MCP Host.
 */
import type { ApprovalConfig } from './core/extensions/approvalTypes'
import type { GuardrailsConfig } from './core/guardrails/config'
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
  /**
   * R5 — provider-fallback policy. RAW shape as delivered by the K8s API (the
   * CRD schema is owned by the separate CRD block; mcp-host only CONSUMES it).
   * Normalized via `parseLlmPolicy` before use — absent/malformed = no failover
   * = byte-identical to today. Kept loosely typed on purpose: the source of
   * truth for the parsed shape is `llm/failover/types.ts#LlmPolicy`.
   */
  llmPolicy?: RawLlmPolicy
  /**
   * T3a — per-host model subset. The operator's GLOBAL allowlist (the
   * `clerum-llm-allowed-models` ConfigMap) is the catalog; this flat array is
   * the subset THIS host offers (⊆ global). Absent/empty = the host offers the
   * full global allowlist (back-compat, additive). Consumed live-intersected
   * with the global allowlist by the R2 model endpoints — a pair here that is
   * NOT enabled in the global disappears (fail-closed). Read directly off the
   * CR like `spec.model`; hot-reloads with the rest of the spec.
   */
  allowedModels?: HostAllowedModel[]
  /**
   * Guardrails — the admin-authored `Host.spec.guardrails` block (spec §5).
   * mcp-host CONSUMES it; the CRD schema is owned by the CRD chart. Absent/empty
   * = no guardrails = byte-identical to today (no-config compatibility, spec §5).
   * Phase 1: only `rules` + `limits` are interpreted.
   */
  guardrails?: GuardrailsConfig
}

/**
 * One entry of the per-host model subset (`spec.allowedModels`). Flat
 * (provider, model) pair, matching the CRD schema in
 * `charts/clerum-crds/crds/host.yaml`.
 */
export interface HostAllowedModel {
  provider: string
  model: string
}

/**
 * The untyped-ish `spec.llmPolicy` object as it arrives from the Host CR (all
 * fields optional; validated + defaulted by `parseLlmPolicy`).
 */
export interface RawLlmPolicy {
  cooldownSeconds?: number
  triggerOn?: string[]
  fallbacks?: Array<{ provider?: string; model?: string; credentialSlot?: string }>
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
 * Credential values for a single provider, keyed by the registry slot
 * `dataKey` (e.g. `openai-api-key`, or the `aws-access-key-id` /
 * `aws-secret-access-key` pair for Bedrock). Multi-slot (R4): single-key
 * providers carry one entry; Bedrock carries two; Vertex one (its JSON).
 */
export type ProviderCredentials = Record<string, string>

/**
 * API credentials loaded from the LLM Secret, keyed by provider id (currently
 * `openai`, `claude`, `zai`, `bailian`, `vertex`, `bedrock`). Each value is a
 * per-provider {@link ProviderCredentials} bag so a provider that needs more
 * than one secret slot (Bedrock) is representable without a second transport.
 * Derived from the provider registry so the key set tracks the provider set.
 */
export type ApiKeys = Partial<Record<LlmProvider, ProviderCredentials>>

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
  port?: number
}

/**
 * McpServer authentication configuration.
 */
export interface McpServerAuth {
  type: 'none' | 'bearer' | 'basic' | 'apiKey' | 'oauth'
  secretRef?: string
  secretKey?: string
}

/**
 * OAuth broker configuration for an mcp-server (auth.type === 'oauth').
 *
 * Mirrors the separate `spec.oauth` block on the CRD (projected by HCC). Only
 * `grantScope` is strictly required for the mcp-host connection seam (dispatch
 * of the per-connection partition); the rest is carried for the token-provider
 * factory / diagnostics. `grantScope` defaults to 'user' when absent.
 */
export interface McpServerOAuth {
  id?: string
  provider?: string
  grantScope?: 'user' | 'context'
  scopes?: string[]
  backgroundAccess?: boolean
}

/**
 * Deployment status of an MCP server (reported by the skill-mapper operator).
 */
export interface McpServerStatus {
  /** Whether the Deployment resource exists in the cluster. */
  deployed: boolean
  /** Whether the Deployment has at least one ready replica. */
  ready: boolean
  /**
   * Whether ready/deployed came from a current-identity, current-generation
   * source. Explicit false means admission status is unknown and must not
   * revoke a live connection. Undefined preserves legacy producer semantics.
   */
  authoritative?: boolean
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
  /**
   * Present only for development/legacy in-process configuration. The HCC v2
   * Host inventory deliberately omits Context identity: HCC derives it from
   * the authenticated Host JWT and never returns it to the caller.
   */
  contextRef?: string
  transport: McpServerTransport
  /** Legacy development shape. HCC v2 returns only authRequired. */
  auth?: McpServerAuth
  /**
   * OAuth broker config; present iff auth.type === 'oauth'. Carries `grantScope`
   * so the manager can dispatch the per-connection partition (user vs shared).
   */
  oauth?: McpServerOAuth
  /** Whether the scoped HCC credential route must return a bearer. */
  authRequired?: boolean
  /**
   * Opaque HCC authority revision. It changes when the authorized server,
   * auth selector, or referenced Secret identity/resourceVersion changes.
   */
  credentialRevision?: string
  /**
   * Non-secret credential-mode policy emitted by the HCC v2 inventory. Drives the
   * token-provider dispatch in the mcp-host seam (mini-spec §3.2): `static` uses
   * the revision-locked getAuthToken route; `oauth-user`/`oauth-context` build a
   * broker provider. Absent → treated as `static` (fail-closed). It carries NO
   * authority (never contextRef/secretRef/token) — that is the invariant (I1)
   * keeping it on the policy side of the decoder's forbidden-metadata guard.
   */
  authKind?: 'static' | 'oauth-user' | 'oauth-context'
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
