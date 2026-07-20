import type { LlmProviderId } from '@clerum/llm-providers'
import type { RuntimeTokenProvider } from '../runtime-token-provider/provider'

export interface WorkflowConfig {
  workflowName: string
  namespace: string
  wrcUrl: string
  tokenProvider: RuntimeTokenProvider
  wrcTokenFile: string
  mcpHostUrl?: string
  mcpHostTokenFile?: string
  snippetRunnerUrl?: string
  snippetRunnerTokenFile?: string
  correlationId: string
  traceContext: WorkflowTraceContext
  signalPollIntervalMs: number
  restPort: number
  registryUrl?: string
  storageEndpoint?: string
}

/** Immutable workflow tracing identity reconstructed from the durable run id. */
export interface WorkflowTraceContext {
  origin: 'workflow_runtime'
  runId: string | null
  correlationId: string
}

export interface StepSpec {
  id: string
  instruction?: string
  dependsOn?: string[]
  timeoutSeconds?: number
  retries?: number
  backoffSeconds?: number
  agent?: AgentSpec
  mcpServers?: string[]
  tools?: ToolScope
  prompt?: PromptSpec
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
  }
  postgres?: {
    workloads?: string[]
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
    allowedHosts?: string[]
  }
}

export interface AgentSpec {
  model: string
  provider: LlmProviderId
}

export interface ToolScope {
  include?: string[]
  // exclude is not implemented in mcp-host — removed to avoid dead config (M-10)
}

export interface PromptSpec {
  template: string
  soul?: string
}

export interface WorkflowRecipeSpec {
  name: string
  namespace: string
  coordinatorImage?: string
  runtimeEgress?: RuntimeEgressSpec
  steps: StepSpec[]
  agent?: AgentSpec
  inputs?: Record<string, unknown>
  workloads?: Array<{
    id: string
    type: string
    port?: number
    serviceName?: string
    resourceName?: string
    host?: string
    namespace?: string
    transport?: { type: string; path?: string }
  }>
  mcpServers?: Array<{ id: string; endpoint: string; transport?: string }>
  output?: {
    destination?: string
    name?: string
    namespace?: string
    format?: string
    storageSize?: string
  }
  inputContract?: Record<string, unknown>
}

export type WorkflowPhase =
  | 'pending'
  | 'initializing'
  | 'running'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type StepPhase = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface Signal {
  type: 'pause' | 'resume' | 'cancel' | 'approval'
  requestId: string
  receivedAt: string
  payload?: Record<string, unknown>
}
