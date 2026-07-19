import { randomUUID } from 'crypto'
import type { Config } from '../../config'
import { apiKeysFromEnv } from '../../llm'
import { isLlmProvider } from '../../llm/registryCore'
import type { ApiKeys, ModelConfig } from '../../types'
import type { LlmUsageEvent, UsageReporter } from '../../usage/usageReporter'
import { getJwtRuntimeBinding } from '../../workflow/mcpHostRuntimeJwt'
import { type McpHostRuntimeAuth, refreshWithRecovery } from '../../workflow/userApprovalRequester'
import { ClientNotificationsHandler } from '../clientNotifications/handler'
import { CircuitBreaker } from '../domain/circuitBreaker'
import { recordCircuitBreakerState } from '../metrics'
import { PluginWorkloadSdkControlApiClient } from '../promptBridge/controlApiClient'
import { PromptBridgeHandler } from '../promptBridge/handler'
import { LlmBridge, type LlmBridgeContext } from '../promptBridge/llmBridge'
import { PluginWorkloadSdkServer, shouldStartPluginWorkloadSdk } from './sdkServer'
import {
  loadWorkloadTokenRegistryFromDir,
  loadWorkloadTokenRegistryFromPair,
} from './workloadTokenRegistry'

export { shouldStartPluginWorkloadSdk } from './sdkServer'

const WORKFLOW_RECIPE_NAMESPACE = 'sandbox-recipes'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function nonEmptyMetadataString(
  metadata: Record<string, unknown> | undefined,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = metadata?.[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return null
}

function workflowRunIdFromExecutionId(value: string | null): string | null {
  const runId = value?.split(':', 1)[0]?.trim() ?? ''
  return UUID_RE.test(runId) ? runId.toLowerCase() : null
}

export function buildPromptBridgeUsageEvent(input: {
  binding: { hostRef: string; recipeNamespace: string; recipeName: string }
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  callerRef: string
  metadata?: Record<string, unknown>
}): LlmUsageEvent | null {
  const isWorkflowRecipe = input.binding.recipeNamespace === WORKFLOW_RECIPE_NAMESPACE
  if (!isWorkflowRecipe) {
    return {
      request_id: randomUUID(),
      ts: new Date().toISOString(),
      run_id: null,
      host_ref: input.binding.hostRef,
      context_ref: null,
      team_id: null,
      provider: input.provider,
      model: input.model,
      llm_secret_name: null,
      source_kind: 'desktop',
      user_id: null,
      sender: input.callerRef,
      channel_type: 'plugin_workload_sdk',
      recipe_name: null,
      cron_job_id: null,
      task_id: null,
      iteration: null,
      input_tokens: input.inputTokens,
      output_tokens: input.outputTokens,
    }
  }

  const executionId = nonEmptyMetadataString(input.metadata, [
    'workflowExecutionId',
    'workflow.executionId',
    'taskId',
  ])
  const explicitRunId = nonEmptyMetadataString(input.metadata, ['workflowRunId', 'workflow.runId'])
  const runId =
    (explicitRunId && UUID_RE.test(explicitRunId) ? explicitRunId.toLowerCase() : null) ??
    workflowRunIdFromExecutionId(executionId)
  const llmSecretName = nonEmptyMetadataString(input.metadata, ['llmSecretName', 'llm_secret_name'])
  if (!runId || !executionId || !executionId.toLowerCase().startsWith(runId) || !llmSecretName) {
    return null
  }

  return {
    request_id: randomUUID(),
    ts: new Date().toISOString(),
    run_id: runId,
    host_ref: input.binding.hostRef,
    context_ref: null,
    team_id: nonEmptyMetadataString(input.metadata, ['workflowTeamId', 'workflow.teamId']),
    provider: input.provider,
    model: input.model,
    llm_secret_name: llmSecretName,
    source_kind: 'workflow',
    user_id: nonEmptyMetadataString(input.metadata, ['workflowUserId', 'workflow.userId']),
    sender: input.callerRef,
    channel_type: 'plugin_workload_sdk',
    recipe_name: input.binding.recipeName,
    cron_job_id: null,
    task_id: executionId,
    iteration: null,
    input_tokens: input.inputTokens,
    output_tokens: input.outputTokens,
  }
}

/**
 * Composition root (plan §3.5): evaluates the namespace-bound activation
 * gate and, when it passes, wires the SDK server from mcp-host config +
 * the live runtime auth (whose accessToken rotates in place via the
 * proactive refresh scheduler).
 *
 * Returns null when the gate fails — the mcp-host continues normal
 * operation without the SDK, logging the structured reason.
 */
export function maybeCreatePluginWorkloadSdkServer(
  config: Config,
  runtimeAuth: McpHostRuntimeAuth | null,
  opts: {
    /**
     * Live LLM binding source. Workflow-mode mcp-hosts receive their API
     * key via POST /configure (never env), so main.ts wires this to the
     * WorkflowService onLlmConfigured holder. Falls back to env-derived
     * keys for dev usage.
     */
    getLlmContext?: () => LlmBridgeContext | null
    /**
     * Usage reporting (plan §5.6): when wired, every successful
     * promptBridge call ships one LlmUsageEvent (source_kind='workflow')
     * so SDK spend lands in usage_events alongside step executions.
     */
    usageReporter?: UsageReporter | null
  } = {}
): PluginWorkloadSdkServer | null {
  const gate = shouldStartPluginWorkloadSdk({
    pluginWorkloadSdkEnabled: config.pluginWorkloadSdkEnabled,
    mcpHostRuntimeAccessToken: runtimeAuth?.accessToken ?? config.mcpHostRuntimeAccessToken ?? '',
    podNamespace: config.podNamespace ?? '',
  })
  if (!gate.start) {
    console.log(
      `[PluginWorkloadSdk] SDK server NOT started: ${gate.reason}. This mcp-host is not eligible for the Plugin Workload SDK.`
    )
    return null
  }

  const accessToken = runtimeAuth?.accessToken ?? config.mcpHostRuntimeAccessToken ?? ''
  const binding = getJwtRuntimeBinding(accessToken)
  if (!binding) {
    console.error(
      '[PluginWorkloadSdk] SDK server NOT started: could not extract runtime binding from access token'
    )
    return null
  }

  const gatewayUrl = config.pluginWorkloadSdkGatewayUrl || config.mcpHostGatewayUrl
  if (!gatewayUrl) {
    console.error(
      '[PluginWorkloadSdk] SDK server NOT started: CONTROL_API_GATEWAY_URL / MCP_HOST_GATEWAY_URL is not set'
    )
    return null
  }
  let workloadTokens: Map<string, string> | null = null
  const tokensDir = config.pluginWorkloadSdkWorkloadTokensDir?.trim()
  if (tokensDir) {
    // Loaded once at server startup from the mounted Secret volume. Adding or
    // removing callers requires WRC to sync the Secret and restart the mcp-host
    // pod so the registry is rebuilt.
    workloadTokens = loadWorkloadTokenRegistryFromDir(tokensDir)
  } else if (config.pluginWorkloadSdkWorkloadToken?.trim()) {
    const boundCaller = config.pluginWorkloadSdkBoundCallerRef?.trim()
    if (!boundCaller) {
      console.error(
        '[PluginWorkloadSdk] SDK server NOT started: PLUGIN_WORKLOAD_SDK_BOUND_CALLER_REF is required when using a single PLUGIN_WORKLOAD_SDK_WORKLOAD_TOKEN'
      )
      return null
    }
    workloadTokens = loadWorkloadTokenRegistryFromPair(
      config.pluginWorkloadSdkWorkloadToken,
      boundCaller
    )
  }
  if (!workloadTokens || workloadTokens.size === 0) {
    console.error(
      '[PluginWorkloadSdk] SDK server NOT started: no workload token registry loaded (set PLUGIN_WORKLOAD_SDK_WORKLOAD_TOKENS_DIR or legacy token + bound caller)'
    )
    return null
  }

  // Capture into a const so the refresh closure narrows to non-null. When the
  // runtime auth chain is absent (dev/env-token mode) there is nothing to
  // refresh, so the client keeps its boot token and surfaces 401s as before.
  const refreshAuth = runtimeAuth
  const controlApiClient = new PluginWorkloadSdkControlApiClient({
    baseUrl: gatewayUrl,
    getAccessToken: () => runtimeAuth?.accessToken ?? config.mcpHostRuntimeAccessToken ?? '',
    ...(refreshAuth ? { refreshOnUnauthorized: () => refreshWithRecovery(refreshAuth) } : {}),
    breaker: new CircuitBreaker({
      onStateChange: open => recordCircuitBreakerState('control-api', open),
    }),
  })
  recordCircuitBreakerState('control-api', false)

  // OQ-2: the provider bound to this mcp-host is the single source of truth.
  // promptBridge may select a model within it but never the provider. The set
  // of known providers is the registry's `ALL_PROVIDERS`.
  const envLlmContext = (): LlmBridgeContext | null => {
    const rawProvider = config.devModelProvider ?? 'openai'
    let provider: ModelConfig['provider']
    if (isLlmProvider(rawProvider)) {
      provider = rawProvider
    } else {
      console.warn(
        `[PluginWorkloadSdk] Unknown devModelProvider '${rawProvider}', falling back to 'openai'`
      )
      provider = 'openai'
    }
    // Registry-driven & multi-slot (R4): collect each provider's dev
    // credential slots from the env (a provider is included only when all its
    // required slots are present).
    const keys: ApiKeys = apiKeysFromEnv()
    const defaultModel = config.devModelName ?? ''
    if (!defaultModel) return null
    return { keys, provider, defaultModel }
  }
  const getLlmContext = (): LlmBridgeContext | null => opts.getLlmContext?.() ?? envLlmContext()

  const llmBridge = new LlmBridge(getLlmContext, {
    maxResponseBytes: config.pluginWorkloadSdkMaxLlmResponseBytes,
    breaker: new CircuitBreaker({
      onStateChange: open => recordCircuitBreakerState('llm-provider', open),
    }),
  })
  recordCircuitBreakerState('llm-provider', false)

  const usageReporter = opts.usageReporter ?? null
  const promptBridgeHandler = new PromptBridgeHandler({
    controlApiClient,
    llmBridge,
    recipeNamespace: binding.recipeNamespace,
    recipeName: binding.recipeName,
    promptTimeoutMs: config.pluginWorkloadSdkPromptTimeoutSeconds * 1000,
    resolveDefaultModel: () => getLlmContext()?.defaultModel ?? null,
    onUsage: usage => {
      if (!usageReporter) return
      const provider = getLlmContext()?.provider ?? 'unknown'
      const event = buildPromptBridgeUsageEvent({
        binding: {
          hostRef: runtimeAuth?.hostRef ?? binding.hostRef,
          recipeNamespace: binding.recipeNamespace,
          recipeName: binding.recipeName,
        },
        provider,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        callerRef: usage.callerRef,
        metadata: usage.metadata,
      })
      if (event) usageReporter.enqueue(event)
    },
  })

  const clientNotificationsHandler = new ClientNotificationsHandler({
    controlApiClient,
    recipeNamespace: binding.recipeNamespace,
    recipeName: binding.recipeName,
  })

  return new PluginWorkloadSdkServer({
    port: config.pluginWorkloadSdkPort,
    recipeName: binding.recipeName,
    workloadTokens,
    promptBridgeHandler,
    clientNotificationsHandler,
    maxConnections: config.pluginWorkloadSdkMaxConnections,
    maxRequestsPerMinutePerWorkload: config.pluginWorkloadSdkMaxRpmPerWorkload,
    maxConcurrentPerWorkload: config.pluginWorkloadSdkMaxConnectionsPerWorkload,
    // Re-validate the rotating runtime token on every request: the boot-time
    // gate is one-shot, but refreshed tokens could in theory carry a drifted
    // binding. Fail closed instead of trusting the boot decision forever.
    getRuntimeBinding: () =>
      getJwtRuntimeBinding(runtimeAuth?.accessToken ?? config.mcpHostRuntimeAccessToken ?? ''),
  })
}
