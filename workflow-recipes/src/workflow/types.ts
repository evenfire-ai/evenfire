/**
 * Workflow-specific TypeScript interfaces for Clerum Runtime.
 */
import type { LlmProviderId } from '@clerum/llm-providers'

// ─── Workflow Phases (7 values) ─────────────────────────────────────────

export type WorkflowPhase =
  | 'pending'
  | 'initializing'
  | 'running'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'cancelled'

export function isTerminalWorkflowPhase(phase: WorkflowPhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled'
}

// ─── Step Phases (5 values) ─────────────────────────────────────────────

export type StepPhase = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export function isTerminalStepPhase(phase: StepPhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'skipped'
}

// ─── CRD Spec Extensions ────────────────────────────────────────────────

export interface AgentSpec {
  model: string
  provider: LlmProviderId
  secretRef?: {
    name: string
    namespace?: string // default: control-plane
  }
  soulRef?: {
    storageRef: {
      bucket: string
      key: string
      provider?: 's3' | 'gcs' | 'spaces' | 'minio'
    }
  }
}

export interface StepSpec {
  id: string
  instruction?: string
  dependsOn?: string[]
  timeoutSeconds?: number // default: 300
  backoffSeconds?: number // default: 30
  maxRetries?: number // default: 2, max: 5
  agent?: { model?: string; provider?: LlmProviderId; soul?: string }
  mcpServers?: string[]
  toolChoice?: 'auto' | 'none' | 'required'
  run?: SnippetRunSpec
}

export interface SnippetRunSpec {
  type: 'snippet'
  language: 'typescript'
  code: string
  capabilities?: SnippetCapabilities
}

export interface SnippetCapabilities {
  http?: {
    egressClass?: 'exact-host' | 'public-web'
    allowedHosts?: string[]
  }
  secrets?: Array<{
    alias: string
    secretRef: {
      name: string
      key: string
    }
  }>
  mongo?: {
    workloads?: string[]
    access?: 'read' | 'readWrite'
  }
  postgres?: {
    workloads?: string[]
    access?: 'read' | 'readWrite'
  }
  mcp?: {
    servers?: string[]
    allowedTools?: {
      include?: string[]
    }
  }
  artifacts?: {
    maxCount?: number
  }
}

export interface RuntimeEgressSpec {
  http?: {
    egressClass?: 'exact-host' | 'public-web'
    allowedHosts?: string[]
  }
}

export interface McpServerRef {
  id: string
  endpoint?: string // optional — auto-computed for workloads with transport
  transport?: 'http' | 'stdio' // default: http
}

export interface OutputSpec {
  destination?: 'configmap' | 'secret' | 'stdout' | 'pvc' // default: stdout
  name?: string
  namespace?: string // default: sandbox-recipes
  claimName?: string // existing output PVC in sandbox-recipes; WRC will not create/delete it
  format?: 'pdf' | 'xlsx' | 'json' | 'text' | 'html' | 'multi' // used with pvc
  storageSize?: string // e.g. "256Mi", "1Gi"
}

export interface ArtifactStatus {
  name: string
  format: string
  sizeBytes: number
  path: string
  createdAt: string
}

// ─── CRD Status Extensions ──────────────────────────────────────────────

export interface WorkflowExecutionStatus {
  phase: WorkflowPhase
  startedAt?: string
  completedAt?: string
  currentStep?: string
  attempt?: number // 0-3
  message?: string
  // Runtime execution metadata.
  correlationId?: string
  coordinatorPodName?: string
  agentPodName?: string
  duration?: number // seconds
  totalToolCalls?: number
  tokensUsed?: {
    input: number
    output: number
    total: number
  }
}

export interface ToolCallRecord {
  serverName: string
  toolName: string
  args: Record<string, unknown>
  result: unknown
  durationMs: number
}

export interface StepStatus {
  id: string
  phase: StepPhase
  startedAt?: string
  completedAt?: string
  /** Bounded status preview only. Full generated files must be run artifacts under /output. */
  output?: string
  outputTruncated?: boolean
  outputLength?: number
  outputPreviewMaxChars?: number
  error?: string
  executor?: 'agentic' | 'snippet' | 'custom'
  approvalBindingSha256?: string
  // Tool call tracing metadata.
  toolsCalled?: ToolCallRecord[]
  toolsCalledTruncated?: boolean
}

// ─── Scheduling Spec ───────────────────────────────────────────────────

export interface SchedulingSpec {
  cron: string
  timezone?: string
  concurrencyPolicy?: 'Forbid' | 'Replace' | 'Allow'
  successfulHistoryLimit?: number
  failedHistoryLimit?: number
  suspend?: boolean
}

// ─── Workflow Config ────────────────────────────────────────────────────

export interface WorkflowConfig {
  coordinatorImage: string
  mcpHostImage: string
  artifactReaderImage?: string
  snippetRunnerImage?: string
  wrcEndpoint: string
  sandboxNamespace: string
  /** Namespace where MCP workloads are deployed (e.g. "mcp-server"). */
  mcpServerNamespace: string
  /** Image pull policy for workflow pods. "Never" for minikube, "Always" for production. */
  imagePullPolicy: 'Always' | 'IfNotPresent' | 'Never'
  enableCustomCoordinatorImage?: boolean
  enableSnippetRuntime?: boolean
  /** Plugin Workload SDK master switch (PLUGIN_WORKLOAD_SDK_ENABLED). */
  pluginWorkloadSdkEnabled?: boolean
  maxWorkflowSteps: number
  allowedCoordinatorImagePrefixes?: string[]
  requireCoordinatorImageDigest?: boolean
  enableDeterministicMode?: boolean
  workflowDefaultRunDurationSeconds: number
  workflowMaxRunDurationSeconds: number
  runtimeTokenTtlSeconds: number
  runtimeTokenRefreshBeforeSeconds: number
  runtimeEgressDnsOverlapSeconds?: number
  networkPolicyEnforcementMode?: 'warn' | 'required'
  networkPolicyEnforcementConfirmed?: boolean
  workflowMaxWorkloadsPerRecipe: number
  workflowUiEgressInternalMaxItems: number
  workflowMaxSteps: number
  workflowStepDependsOnMaxItems: number
  workflowStepAllowedToolsMaxItems: number
  workflowStepMcpServersMaxItems: number
  workflowStatefulSetMaxReplicas: number
  workflowStatefulSetMaxVolumeClaimTemplates: number
  workflowStatefulSetMaxPvcPreflightChecks: number
}

// ─── Recipe Classification ──────────────────────────────────────────────

export type RecipeClassification =
  | 'only-workloads'
  | 'workflow-agentic'
  | 'workflow-snippet'
  | 'workflow-custom'
