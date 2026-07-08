import {
  ConfigLoader,
  McpHostClient,
  McpHostNotConfiguredError,
  type Signal,
  SignalPoller,
  StatusReporter,
  StepCoordinator,
  type StepPhase,
  type WorkflowStateRef,
  createServer,
  initLogger,
  requireRuntimeToken,
  safeEqual,
  start,
  stop,
} from '@clerum/workflow-runtime-core'

// Re-exports
export { ConfigLoader } from './config-loader/loader'
export { SignalPoller } from './signal-poller/poller'
export { StepCoordinator } from './coordinator/step-coordinator'
export { StatusReporter } from './status-reporter/client'
export { McpHostClient } from './mcp-host-client/client'
export { renderPrompt } from './injection/prompt'
export { loadSoul } from './injection/soul'
export { requestModelInjection } from './injection/model'
export {
  createFileRuntimeTokenProvider,
  createStaticRuntimeTokenProvider,
  requireRuntimeToken,
} from './runtime-token-provider/provider'
export { withRetry, computeBackoff } from './coordinator/retry'
export { emitLog, initLogger } from './status-reporter/logger'
export { createServer, start, stop, safeEqual } from './rest-server/server'
export { CycleDetectedError, WorkflowSDKInitError, McpHostNotConfiguredError } from './errors'
export type {
  WorkflowConfig,
  WorkflowRecipeSpec,
  StepSpec,
  AgentSpec,
  ToolScope,
  PromptSpec,
  WorkflowPhase,
  StepPhase,
  Signal,
} from './config-loader/types'
export type {
  AgentStepRequest,
  AgentStepResult,
  StepMcpServerRef,
  AllowedToolsConfig,
} from './mcp-host-client/types'
export type { StepContext, StepExecutor } from './coordinator/step-coordinator'
export type { WorkflowStateRef } from './rest-server/server'
export type { RetryOptions } from './coordinator/retry'
export type { PromptContext } from './injection/prompt'
export type { SignalCallback } from './signal-poller/poller'
export type { RuntimeTokenProvider } from './runtime-token-provider/provider'

// Registry connection interfaces. Concrete clients live outside the SDK core.
export type { RegistryClient } from './registry/client'
export type {
  RegistryRecipe,
  ArtifactManifest,
  PushRecipeRequest,
  PushRecipeResponse,
  SearchParams,
  SearchResult,
} from './registry/types'

interface SDKComponents {
  config: ConfigLoader
  signals: SignalPoller
  coordinator: StepCoordinator
  status: StatusReporter
  mcpHost: McpHostClient | null
  server: ReturnType<typeof createServer>
  stateRef: WorkflowStateRef
}

export class WorkflowSDK {
  readonly config: ConfigLoader
  readonly signals: SignalPoller
  readonly coordinator: StepCoordinator
  readonly status: StatusReporter
  readonly mcpHost: McpHostClient | null
  private readonly serverRef: ReturnType<typeof createServer>
  private readonly stateRef: WorkflowStateRef

  private constructor(c: SDKComponents) {
    this.config = c.config
    this.signals = c.signals
    this.coordinator = c.coordinator
    this.status = c.status
    this.mcpHost = c.mcpHost
    this.serverRef = c.server
    this.stateRef = c.stateRef
  }

  static async fromEnvironment(): Promise<WorkflowSDK> {
    const config = new ConfigLoader()
    const cfg = config.getConfig()

    initLogger(cfg.correlationId, cfg.workflowName)

    const wrcOpts = {
      wrcUrl: cfg.wrcUrl,
      workflowName: cfg.workflowName,
      tokenProvider: cfg.tokenProvider,
    }
    const signals = new SignalPoller({ ...wrcOpts, intervalMs: cfg.signalPollIntervalMs })
    const status = new StatusReporter(wrcOpts)
    const coordinator = new StepCoordinator()

    const mcpHost =
      cfg.mcpHostUrl && cfg.tokenProvider.getMcpHostToken
        ? new McpHostClient(cfg.mcpHostUrl, cfg.tokenProvider)
        : null

    const stateRef: WorkflowStateRef = {
      phase: 'pending',
      steps: {},
      workflowName: cfg.workflowName,
    }
    const server = createServer(
      stateRef,
      (signal: Signal) => signals.pushSignal(signal),
      async (token: string) => {
        const currentToken = await requireRuntimeToken(
          cfg.tokenProvider,
          'getWrcToken',
          'WRC_TOKEN_FILE'
        )
        return safeEqual(token, currentToken)
      }
    )
    await start(server, cfg.restPort)

    return new WorkflowSDK({ config, signals, coordinator, status, mcpHost, server, stateRef })
  }

  requireMcpHost(): McpHostClient {
    if (!this.mcpHost) throw new McpHostNotConfiguredError()
    return this.mcpHost
  }

  updatePhase(phase: WorkflowStateRef['phase']): void {
    this.stateRef.phase = phase
  }

  updateStepState(stepId: string, state: { phase: StepPhase; output?: unknown }): void {
    this.stateRef.steps[stepId] = state
  }

  async shutdown(): Promise<void> {
    this.signals.stop()
    await stop(this.serverRef)
  }
}
