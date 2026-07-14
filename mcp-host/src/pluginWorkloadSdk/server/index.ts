import { randomUUID } from 'crypto'
import type { Config } from '../../config'
import { ALL_PROVIDERS, descriptorFor, isLlmProvider } from '../../llm/registryCore'
import type { ApiKeys, ModelConfig } from '../../types'
import type { UsageReporter } from '../../usage/usageReporter'
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
    // Registry-driven: collect each provider's dev key by its env var name.
    const keys: ApiKeys = {}
    for (const p of ALL_PROVIDERS) {
      const value = process.env[descriptorFor(p).envName]
      if (value) keys[p] = value
    }
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
      usageReporter.enqueue({
        request_id: randomUUID(),
        ts: new Date().toISOString(),
        host_ref: runtimeAuth?.hostRef ?? binding.hostRef,
        context_ref: null,
        team_id: null,
        provider,
        model: usage.model,
        llm_secret_name: null,
        source_kind: 'workflow',
        user_id: null,
        sender: usage.callerRef,
        channel_type: null,
        recipe_name: binding.recipeName,
        cron_job_id: null,
        task_id: null,
        iteration: null,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
      })
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
