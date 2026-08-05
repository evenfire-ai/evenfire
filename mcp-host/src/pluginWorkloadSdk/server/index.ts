import { randomUUID } from 'crypto'
import type { Config } from '../../config'
import type { LlmUsageEvent, UsageReporter } from '../../usage/usageReporter'
import { getJwtRuntimeBinding } from '../../workflow/mcpHostRuntimeJwt'
import { type McpHostRuntimeAuth, refreshWithRecovery } from '../../workflow/userApprovalRequester'
import { ClientNotificationsHandler } from '../clientNotifications/handler'
import { CircuitBreaker } from '../domain/circuitBreaker'
import { recordCircuitBreakerState } from '../metrics'
import { PluginWorkloadSdkControlApiClient } from '../promptBridge/controlApiClient'
import { PluginWorkloadSdkCredentialBrokerClient } from '../promptBridge/credentialBrokerClient'
import { PromptBridgeHandler } from '../promptBridge/handler'
import { LlmBridge } from '../promptBridge/llmBridge'
import {
  PluginWorkloadSdkServer,
  checkLiveRuntimeBinding,
  shouldStartPluginWorkloadSdk,
} from './sdkServer'
import {
  loadWorkloadTokenRegistryFromDir,
  loadWorkloadTokenRegistryFromPair,
} from './workloadTokenRegistry'

export { shouldStartPluginWorkloadSdk } from './sdkServer'

const WORKFLOW_RECIPE_NAMESPACE = 'sandbox-recipes'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export type PluginWorkloadSdkRuntimeMode = 'workflow' | 'sdk-only'

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
  runtimeMode?: PluginWorkloadSdkRuntimeMode
  invocationId?: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  callerRef: string
  promptBridgeMetadata?: {
    targetRef: string
    credentialSlot: string
    fallbackUsed: boolean
    attemptCount: number
    attemptGeneration?: number
    providerAttemptId?: string
    providerAttemptIndex?: number
  }
  metadata?: Record<string, unknown>
}): LlmUsageEvent | null {
  // Explicit runtime mode is authoritative for recipe-bound hosts. The
  // namespace fallback remains only for older non-recipe callers that do not
  // yet inject the mode into their pod.
  const isSdkOnly = input.runtimeMode === 'sdk-only'
  const isWorkflowRecipe = input.runtimeMode
    ? input.runtimeMode === 'workflow'
    : input.binding.recipeNamespace === WORKFLOW_RECIPE_NAMESPACE
  if (!isWorkflowRecipe && !isSdkOnly) {
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
      ...(input.promptBridgeMetadata
        ? {
            prompt_bridge_metadata: {
              invocation_id: input.invocationId,
              target_ref: input.promptBridgeMetadata.targetRef,
              credential_slot: input.promptBridgeMetadata.credentialSlot,
              fallback_used: input.promptBridgeMetadata.fallbackUsed,
              attempt_count: input.promptBridgeMetadata.attemptCount,
              ...(input.promptBridgeMetadata.attemptGeneration !== undefined
                ? { attempt_generation: input.promptBridgeMetadata.attemptGeneration }
                : {}),
              ...(input.promptBridgeMetadata.providerAttemptId
                ? { provider_attempt_id: input.promptBridgeMetadata.providerAttemptId }
                : {}),
              ...(input.promptBridgeMetadata.providerAttemptIndex !== undefined
                ? { provider_attempt_index: input.promptBridgeMetadata.providerAttemptIndex }
                : {}),
            },
          }
        : {}),
    }
  }
  if (isSdkOnly) {
    const invocationId = input.invocationId?.trim() ?? ''
    if (!UUID_RE.test(invocationId)) return null
    return {
      request_id: randomUUID(),
      ts: new Date().toISOString(),
      run_id: null,
      host_ref: input.binding.hostRef,
      context_ref: null,
      team_id: null,
      provider: input.provider,
      model: input.model,
      source_kind: 'plugin_workload_sdk',
      user_id: null,
      sender: input.callerRef,
      channel_type: 'plugin_workload_sdk',
      recipe_name: input.binding.recipeName,
      cron_job_id: null,
      task_id: null,
      iteration: null,
      input_tokens: input.inputTokens,
      output_tokens: input.outputTokens,
      llm_secret_name: input.metadata?.llmSecretName ? String(input.metadata.llmSecretName) : null,
      ...(input.promptBridgeMetadata
        ? {
            prompt_bridge_metadata: {
              invocation_id: invocationId,
              target_ref: input.promptBridgeMetadata.targetRef,
              credential_slot: input.promptBridgeMetadata.credentialSlot,
              fallback_used: input.promptBridgeMetadata.fallbackUsed,
              attempt_count: input.promptBridgeMetadata.attemptCount,
              attempt_generation: input.promptBridgeMetadata.attemptGeneration,
              provider_attempt_id: input.promptBridgeMetadata.providerAttemptId,
              provider_attempt_index: input.promptBridgeMetadata.providerAttemptIndex,
            },
          }
        : {}),
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
  if (input.promptBridgeMetadata && !UUID_RE.test(input.invocationId?.trim() ?? '')) {
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
    ...(input.promptBridgeMetadata
      ? {
          prompt_bridge_metadata: {
            invocation_id: input.invocationId!.trim(),
            target_ref: input.promptBridgeMetadata.targetRef,
            credential_slot: input.promptBridgeMetadata.credentialSlot,
            fallback_used: input.promptBridgeMetadata.fallbackUsed,
            attempt_count: input.promptBridgeMetadata.attemptCount,
            ...(input.promptBridgeMetadata.attemptGeneration !== undefined
              ? { attempt_generation: input.promptBridgeMetadata.attemptGeneration }
              : {}),
            ...(input.promptBridgeMetadata.providerAttemptId
              ? { provider_attempt_id: input.promptBridgeMetadata.providerAttemptId }
              : {}),
            ...(input.promptBridgeMetadata.providerAttemptIndex !== undefined
              ? { provider_attempt_index: input.promptBridgeMetadata.providerAttemptIndex }
              : {}),
          },
        }
      : {}),
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
     * Live public LLM binding source. Workflow-mode mcp-hosts receive their
     * provider/model via POST /configure (credentials never cross this
     * callback), so main.ts wires this to the WorkflowService holder. A
     * missing binding keeps promptBridge fail-closed until configure is ready.
     */
    getLlmContext?: () => {
      provider: string
      defaultModel: string
    } | null
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
    pluginWorkloadSdkCapabilities: config.pluginWorkloadSdkCapabilities,
    mcpHostRuntimeAccessToken: runtimeAuth?.accessToken ?? config.mcpHostRuntimeAccessToken ?? '',
    podNamespace: config.podNamespace ?? '',
    pluginWorkloadSdkCredentialBrokerUrl: config.pluginWorkloadSdkCredentialBrokerUrl,
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

  const capabilities = new Set(config.pluginWorkloadSdkCapabilities)
  let promptBridgeHandler: PromptBridgeHandler | undefined
  if (capabilities.has('promptBridge')) {
    // The provider broker is a promptBridge dependency only. A notification-
    // only recipe must be able to start without CLERUM_WRC_URL or any LLM
    // client, while promptBridge remains fail-closed when the broker is absent.
    if (!config.pluginWorkloadSdkCredentialBrokerUrl.trim()) {
      console.error(
        '[PluginWorkloadSdk] SDK server NOT started: CLERUM_WRC_URL is required for promptBridge'
      )
      return null
    }
    const credentialBroker = new PluginWorkloadSdkCredentialBrokerClient({
      baseUrl: config.pluginWorkloadSdkCredentialBrokerUrl,
      recipeNamespace: binding.recipeNamespace,
      recipeName: binding.recipeName,
      getAccessToken: () => runtimeAuth?.accessToken ?? config.mcpHostRuntimeAccessToken ?? '',
    })
    const llmBridge = new LlmBridge(credentialBroker, {
      maxResponseBytes: config.pluginWorkloadSdkMaxLlmResponseBytes,
      createBreaker: target =>
        new CircuitBreaker({
          onStateChange: open =>
            recordCircuitBreakerState(`llm-provider:${target.targetRef}`, open),
        }),
    })

    const usageReporter = opts.usageReporter ?? null
    promptBridgeHandler = new PromptBridgeHandler({
      controlApiClient,
      llmBridge,
      recipeNamespace: binding.recipeNamespace,
      recipeName: binding.recipeName,
      promptTimeoutMs: config.pluginWorkloadSdkPromptTimeoutSeconds * 1000,
      getBootstrapTarget: opts.getLlmContext
        ? () => {
            const context = opts.getLlmContext?.()
            if (!context) return null
            return { provider: context.provider, model: context.defaultModel }
          }
        : undefined,
      finalizePromptBridge:
        config.pluginWorkloadSdkRuntimeMode === 'sdk-only'
          ? input =>
              controlApiClient.finalizePromptBridge({
                recipeNamespace: binding.recipeNamespace,
                recipeName: binding.recipeName,
                ...input,
              })
          : undefined,
      onUsage: usage => {
        if (!usageReporter) return
        const event = buildPromptBridgeUsageEvent({
          binding: {
            hostRef: runtimeAuth?.hostRef ?? binding.hostRef,
            recipeNamespace: binding.recipeNamespace,
            recipeName: binding.recipeName,
          },
          provider: usage.provider,
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          callerRef: usage.callerRef,
          promptBridgeMetadata: {
            targetRef: usage.servedTarget.targetRef,
            credentialSlot: usage.servedTarget.credentialSlot,
            fallbackUsed: usage.fallbackUsed,
            attemptCount: usage.attemptCount,
            attemptGeneration: usage.attemptGeneration,
            providerAttemptId: usage.providerAttemptId,
            providerAttemptIndex: usage.providerAttemptIndex,
          },
          runtimeMode: config.pluginWorkloadSdkRuntimeMode === 'sdk-only' ? 'sdk-only' : 'workflow',
          invocationId: usage.invocationId,
          metadata: { ...usage.metadata, llmSecretName: usage.llmSecretName },
        })
        if (event) usageReporter.enqueue(event)
      },
    })
  }

  const clientNotificationsHandler = capabilities.has('clientNotifications')
    ? new ClientNotificationsHandler({
        controlApiClient,
        recipeNamespace: binding.recipeNamespace,
        recipeName: binding.recipeName,
      })
    : undefined

  const getRuntimeBinding = () =>
    getJwtRuntimeBinding(runtimeAuth?.accessToken ?? config.mcpHostRuntimeAccessToken ?? '')
  const readiness = () => {
    const liveBinding = getRuntimeBinding()
    const reason = liveBinding
      ? checkLiveRuntimeBinding(liveBinding, binding.recipeName)
      : 'runtime token has no decodable recipe binding'
    if (reason) return { ready: false, reason }
    if (capabilities.has('promptBridge') && !opts.getLlmContext?.()) {
      return { ready: false, reason: 'promptBridge provider identity has not been brokered' }
    }
    return { ready: true }
  }

  return new PluginWorkloadSdkServer({
    port: config.pluginWorkloadSdkPort,
    recipeName: binding.recipeName,
    capabilities: config.pluginWorkloadSdkCapabilities,
    workloadTokens,
    promptBridgeHandler,
    clientNotificationsHandler,
    readiness,
    maxConnections: config.pluginWorkloadSdkMaxConnections,
    maxRequestsPerMinutePerWorkload: config.pluginWorkloadSdkMaxRpmPerWorkload,
    maxConcurrentPerWorkload: config.pluginWorkloadSdkMaxConnectionsPerWorkload,
    verifyClientNotificationsBootstrap: () => controlApiClient.verifyClientNotificationsBootstrap(),
    // Re-validate the rotating runtime token on every request: the boot-time
    // gate is one-shot, but refreshed tokens could in theory carry a drifted
    // binding. Fail closed instead of trusting the boot decision forever.
    getRuntimeBinding,
  })
}
