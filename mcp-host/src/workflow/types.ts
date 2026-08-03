/**
 * Workflow request/response types for mcp-host workflow mode.
 *
 * Source of truth: STAGE-2-STEP-EXECUTION-ENGINE.md §4.3–§4.7
 */
import type { LlmProvider } from '../llm/registryCore'

// ─── MCP Server Reference (per-step) ───────────────────────────────────

export interface StepMcpServerRef {
  name: string
  url: string
  authToken?: string
}

// ─── Tool Scoping ───────────────────────────────────────────────────────

export interface AllowedToolsConfig {
  include?: string[] // if present and non-empty: ONLY these tools exposed
}

// ─── Execute Step ───────────────────────────────────────────────────────

export interface ApprovalTarget {
  userId?: string
  teamId?: string
}

export interface ApprovalRequest {
  target: ApprovalTarget
  message: string
  timeoutSeconds?: number
}

export interface ExecuteStepRequest {
  stepId: string
  instruction: string
  mcpServers?: StepMcpServerRef[]
  allowedTools?: AllowedToolsConfig
  toolChoice?: 'auto' | 'none' | 'required'
  maxIterations?: number
  timeoutSeconds?: number
  contextVars?: Record<string, string>
  approvalBindingProof?: string
  requiresApproval?: ApprovalRequest
}

export interface ExecuteStepResponse {
  stepId: string
  status: 'completed' | 'failed'
  output?: string
  error?: string
  toolsCalled?: ToolCallRecord[]
  tokensUsed?: TokenUsage
  completedAt?: string
  durationMs: number
}

export interface ToolCallRecord {
  serverName: string
  toolName: string
  args: Record<string, unknown>
  result: unknown
  durationMs: number
}

export interface TokenUsage {
  input: number
  output: number
  total: number
}

// ─── Configure ──────────────────────────────────────────────────────────

export interface ConfigureRequest {
  // Wire input — still validated at runtime with `isLlmProvider` before use
  // (the payload is decoded as `unknown`, so this type is descriptive, not a
  // trust boundary).
  provider?: LlmProvider
  model?: string
  apiKey?: string
  /** Kubernetes Secret name only, never the secret key or value. */
  llmSecretName?: string
  soulContent?: string
  /**
   * Provider-fallback (R5 F6). Ordered failover policy for the step. The WRC
   * secret broker resolves each fallback's credential slot and forwards it here
   * (RESOLVED `apiKey` per entry) — the mono-value `apiKey` above can only carry
   * the primary (spec §3-R4.4). Absent = no failover = today's behaviour.
   * Parsed defensively by `parseWorkflowLlmPolicy` (payload is `unknown`).
   */
  llmPolicy?: {
    cooldownSeconds?: number
    triggerOn?: string[]
    fallbacks?: Array<{
      provider: string
      model: string
      apiKey: string
      llmSecretName?: string
    }>
  }
}

export interface ConfigureResponse {
  configured: boolean
  provider?: string
  model?: string
  /**
   * Version of the identity-only Plugin Workload SDK bootstrap contract. This
   * is intentionally present only on the SDK bootstrap response; workflow
   * `/configure` remains on its legacy response shape.
   */
  contractVersion?: 2
  ready?: boolean
  /** Pod/protocol identity is ready even while operator policy is pending. */
  policyReady?: boolean
  policyState?: string
  policyReason?: string
  policyRevision?: number
  policyHash?: string
  defaultTargetRef?: string
  defaultProvider?: string
  defaultModel?: string
  message?: string
}

/** Public identity handshake for a stepless Plugin Workload SDK host. */
export interface PluginWorkloadSdkBootstrapRequest {
  provider?: LlmProvider
  model?: string
}

// ─── Internal Tools (clerum__*) ──────────────────────────────────────

export interface ArtifactMetadata {
  name: string
  format: 'md' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'png' | 'svg' | 'html'
  path: string
  sizeBytes: number
  createdAt: string
}

export interface InternalToolResult {
  success: boolean
  artifact?: ArtifactMetadata
  /**
   * Optional text payload for tools that return data instead of (or in
   * addition to) a file artifact. The native-tool adapter prefers this
   * over the auto-generated "File generated: …" message when present.
   * Used by query-style internal tools such as clerum__get_capabilities.
   */
  content?: string
  error?: string
}

export interface InternalToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, outputDir: string) => Promise<InternalToolResult>
}
