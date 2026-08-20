/**
 * Configuration settings loaded from environment variables.
 */
import type { ApprovalConfig } from './core/extensions/approvalTypes'
import type { GuardrailsConfig } from './core/guardrails/config'
import { NativeToolConfig } from './core/interfaces'
import { ALL_PROVIDERS, type LlmProvider, descriptorFor, isLlmProvider } from './llm/registryCore'
import { HostSpec, McpServerInfo, MemoryConfig, ModelConfig, PersonalizationConfig } from './types'

/** Route families projected by WRC into a recipe-bound mcp-host. */
export const PLUGIN_WORKLOAD_SDK_CAPABILITIES = ['promptBridge', 'clientNotifications'] as const
export type PluginWorkloadSdkCapability = (typeof PLUGIN_WORKLOAD_SDK_CAPABILITIES)[number]

/**
 * Parse the WRC capability projection without silently accepting typos. An
 * empty/missing value is intentionally an empty set so the SDK activation gate
 * fails closed rather than exposing a broader route surface than the recipe.
 */
export function parsePluginWorkloadSdkCapabilities(
  raw: string | undefined
): PluginWorkloadSdkCapability[] {
  if (!raw?.trim()) return []
  const declared = raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  const known = new Set<string>(PLUGIN_WORKLOAD_SDK_CAPABILITIES)
  const unknown = declared.filter(value => !known.has(value))
  if (unknown.length > 0) {
    throw new Error(
      `PLUGIN_WORKLOAD_SDK_CAPABILITIES contains unsupported value(s): ${unknown.join(', ')}`
    )
  }
  return PLUGIN_WORKLOAD_SDK_CAPABILITIES.filter(capability => declared.includes(capability))
}

export interface Config {
  // Dev mode - if true, reads config from env vars instead of K8s
  devMode: boolean

  // Dev mode config (parsed from CLERUM_HOST_CONFIG or built from env vars)
  devHostConfig?: HostSpec

  // Host name - used to find the Host CRD in production mode
  hostName: string

  // Kubernetes namespace
  namespace: string

  // Namespace where installed LlmHook workloads/Services live (spec §8.2). The
  // guardrail hook resolver derives in-cluster endpoints against this namespace.
  llmHooksNamespace: string

  // Name of the operator-managed LLM allowlist ConfigMap watched by the
  // ConfigStore (R3). Configurable so canary/test namespaces can point at a
  // differently-named artifact; default matches the control-api writer.
  llmAllowlistConfigMapName: string

  // Dev mode: Model configuration from env vars
  devModelProvider?: LlmProvider
  devModelName?: string

  // Dev mode: MCP servers (parsed from CLERUM_MCP_SERVERS JSON)
  devMcpServers?: McpServerInfo[]

  // MCP Proxy mode (default: false — direct connection to MCP servers)
  mcpProxyEnabled: boolean

  // MCP Proxy URL (only used when mcpProxyEnabled is true)
  mcpProxyUrl: string

  // RPC Server port
  serverPort: number

  // Context Mapper URL (for fetching McpServers)
  contextMapperUrl: string

  // Context Mapper poll interval in ms (for production mode)
  contextMapperPollInterval: number

  // Maximum time an already-published MCP fleet may survive without a fresh,
  // authenticated HCC inventory snapshot.
  hccAuthorityMaxStalenessMs: number

  // MCP server health heartbeat interval in ms. mcp-host periodically
  // tools/list's each connected server to keep observedAt fresh and detect
  // silent failures. Must stay well under the desktop's 120s stale threshold.
  mcpStatusHeartbeatInterval: number

  // Per-heartbeat round budget. A stalled MCP server must not retain the
  // scheduler in-flight forever or cause overlapping rounds.
  mcpStatusHeartbeatTimeoutMs: number

  // Agent configuration
  agentTaskDelay: number
  agentMaxTaskDuration: number
  agentMaxToolCallsPerTask: number
  agentMaxQueueSize: number
  agentApprovalTimeout: number
  // T2.1 — TTL for persisted pending approval rows (rows live in SQLite until
  // a human resolves them; this caps how long an unresolved row survives a
  // pod restart). Default 7d. Independent from `agentApprovalTimeout`
  // (in-flight wait) and `spilloverTtlMs` (blob retention).
  pendingApprovalTtlMs: number

  // Approval system (default ON; tools advertise requiresApproval()).
  enableApproval: boolean
  // Dev-mode approval config parsed from CLERUM_APPROVAL_CONFIG; in prod the
  // values come from the Host CRD.
  approvalConfig?: ApprovalConfig
  // Dev-mode guardrails config parsed from CLERUM_GUARDRAILS_CONFIG (spec §5); in
  // prod the block comes from the Host CRD. Absent = no guardrails = today.
  guardrailsConfig?: GuardrailsConfig

  // Nudge controller (default OFF).
  enableNudge: boolean
  nudgeMaxIterations: number

  // Context compaction: max token budget for the context window (default 100k)
  contextMaxTokens: number

  // P.2 — Tokenizer dry-run + offline knobs.
  tokenizerDryrun: boolean
  tokenizerOffline: boolean

  // T1.4 — Anti-thrash for `PressureContextManager`.
  compactionIneffectiveRatio: number
  compactionIneffectiveMaxRun: number

  // T1.2 — Pre-pruning before the LLM call. `compactionPrePruneEnabled` is
  // the master flag (default false during rollout); the four per-pass toggles
  // exist for granular rollback.
  compactionPrePruneEnabled: boolean
  compactionPrePruneDedup: boolean
  compactionPrePruneOneLine: boolean
  compactionPrePruneJsonTruncate: boolean
  compactionPrePruneStripMedia: boolean
  compactionPrePruneMaxArgsBytes: number
  compactionPrePruneSummaryTokens: number
  compactionPrePruneProtectedTailTurns: number

  // T1.1 — Structured summary template. Default OFF; flipped per-Host once
  // the goldens prove parity / quality improvement in staging.
  compactionStructuredSummary: boolean

  // T2.2 — System-prompt cache flag (Anthropic prompt caching, tiered system
  // prompt with <turn-context> moved to the user message).
  promptCacheEnabled: boolean

  // F1 (dynamic-tool-loading) — Gates the dynamic-tool-loading bridge; default
  // OFF; set true per-host to enable; see
  // `.specs/dynamic-tool-loading/plan-hermes-bridge.es.md`.
  dynamicToolsEnabled: boolean
  // F1 (dynamic-tool-loading) — Minimum deferrable (MCP) tool count above which
  // the bridge activates when enabled; small hosts stay on passthrough.
  dynamicToolsThreshold: number

  // T1.5 — Tool-result spillover. Master flag + threshold + TTL + GC period.
  // When `toolSpilloverEnabled` is true the host wires a `SpilloverStorage`
  // and TaskExecutor passes it to every loop; otherwise the loop ships
  // inline content the way it did pre-T1.5.
  toolSpilloverEnabled: boolean
  toolSpilloverThresholdBytes: number
  spilloverTtlMs: number
  spilloverGcIntervalMs: number

  // T2.1 — Conversation store backend selector and tuning knobs.
  sessionStoreMode: 'memory' | 'sqlite' | 'dual'
  /** Raw (lowercased) CLERUM_SESSION_STORE value, BEFORE the recognized-value
   *  check. The stateless-lifecycle boot guard aborts on an unrecognized raw
   *  value instead of accepting the silent 'memory' fallback (D3 §1.3b). */
  sessionStoreModeRaw: string
  sessionDbPath: string
  /** D3 §1.2 — PVC-backed directory for state.db (CLERUM_SESSION_DB_DIR).
   *  When set, state.db lives at `${sessionDbDir}/state.db` and takes
   *  precedence over the workspace-derived path. */
  sessionDbDir: string
  /** D3 §1.1 — stateless agent lifecycle (CLERUM_STATELESS_LIFECYCLE).
   *  Activates the durability barrier and the fail-loud boot guard. */
  statelessLifecycle: boolean
  /** Stage 3 — push heartbeat cadence in ms
   *  (CLERUM_STATELESS_HEARTBEAT_INTERVAL_MS, default 30000). An explicitly
   *  set non-positive-integer value fails config load loudly. */
  statelessHeartbeatIntervalMs: number
  /** Stage 3 — pod UID from the Kubernetes downward API (CLERUM_POD_UID).
   *  HCC injects it via `fieldRef: metadata.uid` on stateless Hosts; empty
   *  when not injected (StatelessHeartbeat fails loud at construction). */
  podUid: string
  /** D3 §1.1 — explicit durability-barrier opt-in for always-on Hosts
   *  (CLERUM_DB_BARRIER_MODE=full). */
  dbBarrierModeFull: boolean
  conversationCacheSize: number
  sessionTtlDays: number
  dbWorkerHeartbeatMs: number
  dbPersistSyncTimeoutMs: number
  dbPersistAsyncTimeoutMs: number
  dbCheckpointEveryWrites: number
  dbWalSizeAlarmBytes: number

  // T3.1 — Session search (clerum__session_search tool + REST endpoint).
  // Master flag defaults OFF until staging soak confirms cross-user isolation.
  // Retention controls the boot-time sweep of closed sessions; in-flight
  // sessions are NEVER pruned (see T3.1-session-search.md §8).
  sessionSearchEnabled: boolean
  searchRetentionDays: number

  // Native tool configuration
  nativeTool: NativeToolConfig

  // Attachment delivery configuration
  enableResponseAttachments: boolean
  attachmentMaxCount: number
  attachmentMaxBytes: number
  activityBufferSize: number
  activityMaxEventBytes: number

  // Memory (workspace) configuration.
  memory: MemoryConfig

  // Personalization configuration.
  personalization: PersonalizationConfig

  // Token budgets (P1) — pre-task budget check against control-api. Default OFF;
  // the whole check path (BudgetClient construction + SessionProcessor wiring)
  // is gated on this flag, and the check is fail-open (§0.2).
  budgetsEnabled: boolean

  // Governed tracing defaults ON; false skips best-effort tracing reporter wiring.
  governedTracingEnabled: boolean
  approvalPromptHistoryEnabled: boolean
  approvalPromptHistoryMaxBytes: number

  // Canonical process runtime. `workflowEnabled` is retained as a derived
  // compatibility view for code that only needs the workflow yes/no answer;
  // startup dispatch MUST use `runtimeKind` so sdk-only can never fall through
  // to the standalone host.
  runtimeKind: 'standalone' | 'workflow' | 'sdk-only'
  // Workflow mode — derived from runtimeKind, never independently trusted.
  workflowEnabled: boolean
  workflowRecipeName: string
  userApprovalRequestRecipeName: string
  userApprovalRequestRecipeNamespace: string
  workflowMaxIterations: number

  // Auth configuration
  enableAuth: boolean
  authJwtPublicKey: string
  authJwtIssuer: string
  authJwtAudience: string
  wrcPublicKey: string

  // mcpHost runtime JWTs for workflow approval gating (optional; non-workflow mcp-hosts skip this)
  // Also reused for LLM usage reporting → control-api via the same nginx gateway and JWT.
  mcpHostRuntimeAccessToken?: string
  mcpHostRuntimeRefreshToken?: string
  mcpHostGatewayUrl?: string
  mcpHostWorkflowControlToken?: string
  mcpHostWorkflowControlTokenFile?: string

  // ─── Plugin Workload SDK (promptBridge + clientNotifications) ──────
  // The server starts only when the namespace-bound activation gate passes
  // (flag + runtime JWT recipeNamespace + downward-API pod namespace, all
  // fail-closed — see pluginWorkloadSdk/server/sdkServer.ts).
  pluginWorkloadSdkEnabled: boolean
  /** Exact capability families declared by WRC for this recipe-bound host. */
  pluginWorkloadSdkCapabilities: PluginWorkloadSdkCapability[]
  pluginWorkloadSdkRuntimeMode: 'workflow' | 'sdk-only'
  pluginWorkloadSdkPort: number
  /** Pod namespace via Kubernetes downward API (defense-in-depth). */
  podNamespace: string
  /** Overrides mcpHostGatewayUrl for SDK → control-api calls when set. */
  pluginWorkloadSdkGatewayUrl?: string
  /** WRC endpoint that redeems one signed prompt target ticket per attempt. */
  pluginWorkloadSdkCredentialBrokerUrl: string
  /** Recipe-scoped shared token workloads present to the SDK server. @deprecated use tokensDir */
  pluginWorkloadSdkWorkloadToken?: string
  /** Dev-only caller binding when using a single legacy workload token env var. */
  pluginWorkloadSdkBoundCallerRef?: string
  /** Directory of per-caller token files mounted from the recipe Secret. */
  pluginWorkloadSdkWorkloadTokensDir?: string
  pluginWorkloadSdkPromptTimeoutSeconds: number
  pluginWorkloadSdkMaxConnections: number
  pluginWorkloadSdkMaxConnectionsPerWorkload: number
  pluginWorkloadSdkMaxRpmPerWorkload: number
  pluginWorkloadSdkMaxLlmResponseBytes: number
}

function getEnv(key: string, defaultValue?: string): string | undefined {
  return process.env[key] ?? defaultValue
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key]
  if (!value) return defaultValue
  return value.toLowerCase() === 'true' || value === '1'
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key]
  if (!value) return defaultValue
  const parsed = parseInt(value, 10)
  // Guard against NaN and non-positive values — fall back to the default.
  // Warn only when the value was actually set but invalid, so a typo'd env var
  // is visible in logs rather than silently ignored.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[config] ${key}=${value} is not a valid positive integer; using default ${defaultValue}`
    )
    return defaultValue
  }
  return parsed
}

export type McpHostRuntimeKind = 'standalone' | 'workflow' | 'sdk-only'

/**
 * Resolve the one authoritative startup kind from the two historical env
 * signals. Explicit SDK/runtime mode and CLERUM_WORKFLOW_ENABLED must agree;
 * contradictory combinations fail at config load instead of silently
 * exposing workflow or standalone routes from an sdk-only Pod.
 */
export function resolveMcpHostRuntimeKind(input: {
  workflowEnabled: boolean
  pluginWorkloadSdkRuntimeMode?: string
}): McpHostRuntimeKind {
  const rawMode = input.pluginWorkloadSdkRuntimeMode?.trim()
  if (!rawMode) return input.workflowEnabled ? 'workflow' : 'standalone'
  if (rawMode !== 'workflow' && rawMode !== 'sdk-only') {
    throw new Error(
      `Invalid PLUGIN_WORKLOAD_SDK_RUNTIME_MODE="${rawMode}"; expected workflow or sdk-only`
    )
  }
  if (rawMode === 'workflow' && !input.workflowEnabled) {
    throw new Error(
      'Contradictory mcp-host runtime configuration: PLUGIN_WORKLOAD_SDK_RUNTIME_MODE=workflow requires CLERUM_WORKFLOW_ENABLED=true'
    )
  }
  if (rawMode === 'sdk-only' && input.workflowEnabled) {
    throw new Error(
      'Contradictory mcp-host runtime configuration: PLUGIN_WORKLOAD_SDK_RUNTIME_MODE=sdk-only requires CLERUM_WORKFLOW_ENABLED=false'
    )
  }
  return rawMode
}

/**
 * Stage 3 (stateless-agents) — parse CLERUM_STATELESS_HEARTBEAT_INTERVAL_MS.
 *
 * Fail loud: an explicitly-set but non-positive-integer value THROWS at
 * config load time (same posture as CLERUM_DB_BARRIER_MODE). A silent
 * getEnvNumber-style fallback would let a typo'd cadence drive HCC's
 * suspend decisions. Unset / empty returns the 30s default.
 */
export function parseStatelessHeartbeatIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 30_000
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `[Config] CLERUM_STATELESS_HEARTBEAT_INTERVAL_MS='${raw}' is not a positive integer`
    )
  }
  return parsed
}

/**
 * Parse an MCP status-heartbeat duration. These values participate in the
 * liveness scheduler, so an explicit typo must fail at boot rather than turn
 * into an unbounded timer or a silent fallback.
 */
export function parseMcpStatusHeartbeatDuration(
  name: string,
  raw: string | undefined,
  defaultValue: number
): number {
  if (raw === undefined || raw.trim() === '') return defaultValue
  if (!/^\d+$/.test(raw)) {
    throw new Error(`[Config] ${name}='${raw}' is not a positive safe integer`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`[Config] ${name}='${raw}' is not a positive safe integer`)
  }
  return value
}

/**
 * Parse CLERUM_HOST_CONFIG JSON for dev mode.
 */
function parseDevHostConfig(): HostSpec | undefined {
  const configJson = process.env.CLERUM_HOST_CONFIG
  if (!configJson) {
    return undefined
  }

  try {
    const parsed = JSON.parse(configJson) as HostSpec
    console.log('[Config] Parsed dev host config from CLERUM_HOST_CONFIG:')
    console.log('[Config]   host:', parsed.host)
    console.log('[Config]   contextRef:', parsed.contextRef)
    console.log('[Config]   secretRef:', parsed.secretRef)
    console.log(
      '[Config]   model:',
      parsed.model ? `${parsed.model.provider}/${parsed.model.name}` : 'not set'
    )
    return parsed
  } catch (error) {
    console.error('[Config] Failed to parse CLERUM_HOST_CONFIG:', error)
    return undefined
  }
}

/**
 * Build dev host config from individual environment variables. The default
 * model per provider comes straight from the registry descriptor.
 */
function getDefaultModel(provider: LlmProvider): string {
  return descriptorFor(provider).defaultModel
}

function buildDevHostConfig(provider?: LlmProvider, modelName?: string): HostSpec {
  const model: ModelConfig | undefined = provider
    ? {
        provider,
        name: modelName || getDefaultModel(provider),
      }
    : undefined

  console.log('[Config] Built dev host config from env vars:')
  console.log(
    '[Config]   model:',
    model ? `${model.provider}/${model.name}` : 'will auto-detect from API keys'
  )

  return {
    host: 'dev-host',
    contextRef: 'dev-context',
    secretRef: 'dev-secret',
    model,
  }
}

const devMode = getEnvBool('CLERUM_DEV_MODE', false)
const configuredWorkflowEnabled = getEnvBool('CLERUM_WORKFLOW_ENABLED', false)
const configuredRuntimeKind = resolveMcpHostRuntimeKind({
  workflowEnabled: configuredWorkflowEnabled,
  pluginWorkloadSdkRuntimeMode: getEnv('PLUGIN_WORKLOAD_SDK_RUNTIME_MODE'),
})

// Raw CLERUM_MODEL_PROVIDER env var. NOT validated here: this runs at module top
// level (imported very early, in prod too), so a stray/invalid value must never
// throw on import. Validation is deferred to the dev-only path via
// resolveDevModelProvider().
const rawDevModelProvider = getEnv('CLERUM_MODEL_PROVIDER')
const devModelName = getEnv('CLERUM_MODEL_NAME')

/**
 * Narrow a raw CLERUM_MODEL_PROVIDER value to an `LlmProvider`.
 *
 * Fail-closed: an explicitly-set but unknown provider THROWS rather than
 * dropping to undefined. Dropping it would silently fall through to API-key
 * auto-detection — routing to a different provider and ignoring
 * CLERUM_MODEL_NAME, a provider-boundary regression. An ABSENT value returns
 * undefined (auto-detection is the intended fallback there).
 *
 * MUST only be called from the dev-only path (after the devMode guard) so it
 * never throws at module top level in prod.
 */
export function resolveDevModelProvider(raw: string | undefined): LlmProvider | undefined {
  if (!raw) return undefined
  if (!isLlmProvider(raw)) {
    throw new Error(
      `Invalid CLERUM_MODEL_PROVIDER '${raw}'. Valid providers: ${ALL_PROVIDERS.join(', ')}`
    )
  }
  return raw
}

/**
 * Keep the poll cadence strictly inside the authority-retention window.
 *
 * A cadence at or above the staleness ceiling guarantees that a healthy fleet
 * can be revoked before the next authoritative poll arrives. Failing startup
 * closed is safer than silently widening the retention window or allowing a
 * deployment to flap forever after every successful reconnect.
 */
export function validateHccAuthorityTiming(
  contextMapperPollIntervalMs: number,
  hccAuthorityMaxStalenessMs: number
): void {
  if (
    Number.isFinite(contextMapperPollIntervalMs) &&
    Number.isFinite(hccAuthorityMaxStalenessMs) &&
    contextMapperPollIntervalMs >= hccAuthorityMaxStalenessMs
  ) {
    throw new Error(
      `CLERUM_CONTEXT_MAPPER_POLL_INTERVAL (${contextMapperPollIntervalMs}ms) must be less than HCC_AUTHORITY_MAX_STALENESS_MS (${hccAuthorityMaxStalenessMs}ms)`
    )
  }
}

// In dev mode, try CLERUM_HOST_CONFIG first, then fall back to building from env vars
function getDevHostConfig(): HostSpec | undefined {
  if (!devMode) return undefined

  const fromJson = parseDevHostConfig()
  if (fromJson) return fromJson

  return buildDevHostConfig(resolveDevModelProvider(rawDevModelProvider), devModelName)
}

/**
 * Parse CLERUM_MCP_SERVERS JSON for dev mode.
 * Format: [{"name": "...", "spec": {"contextRef": "...", "transport": {...}}}]
 */
function parseDevMcpServers(): McpServerInfo[] | undefined {
  const serversJson = process.env.CLERUM_MCP_SERVERS
  if (!serversJson) {
    return undefined
  }

  try {
    const parsed = JSON.parse(serversJson) as McpServerInfo[]
    console.log(`[Config] Parsed ${parsed.length} dev MCP server(s) from CLERUM_MCP_SERVERS`)
    for (const server of parsed) {
      console.log(`[Config]   - ${server.name}: ${server.transport.url}`)
    }
    return parsed
  } catch (error) {
    console.error('[Config] Failed to parse CLERUM_MCP_SERVERS:', error)
    return undefined
  }
}

/**
 * Parse CLERUM_APPROVAL_CONFIG JSON for dev mode.
 * Format: {"defaultPolicy":"designated_approvers","channels":{"telegram":{"enabled":true,"approvers":["123"]}}}
 */
/** Parse CLERUM_GUARDRAILS_CONFIG JSON for dev mode (the `Host.spec.guardrails` block, spec §5). */
function parseGuardrailsConfig(): GuardrailsConfig | undefined {
  const configJson = process.env.CLERUM_GUARDRAILS_CONFIG
  if (!configJson) return undefined
  try {
    const parsed = JSON.parse(configJson) as GuardrailsConfig
    console.log('[Config] Parsed guardrails config from CLERUM_GUARDRAILS_CONFIG:', {
      rules: parsed.rules?.length ?? 0,
    })
    return parsed
  } catch (error) {
    console.error('[Config] Failed to parse CLERUM_GUARDRAILS_CONFIG:', error)
    return undefined
  }
}

function parseApprovalConfig(): ApprovalConfig | undefined {
  const configJson = process.env.CLERUM_APPROVAL_CONFIG
  if (!configJson) {
    return undefined
  }

  try {
    const parsed = JSON.parse(configJson) as ApprovalConfig
    console.log('[Config] Parsed approval config from CLERUM_APPROVAL_CONFIG:')
    console.log('[Config]   defaultPolicy:', parsed.defaultPolicy)
    console.log('[Config]   channels:', Object.keys(parsed.channels || {}))
    return parsed
  } catch (error) {
    console.error('[Config] Failed to parse CLERUM_APPROVAL_CONFIG:', error)
    return undefined
  }
}

function parseApprovalPromptHistoryMaxBytes(raw: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) return Number.NaN
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 1_024 && value <= 32_768 ? value : Number.NaN
}

const contextMapperPollInterval = parseInt(
  getEnv('CLERUM_CONTEXT_MAPPER_POLL_INTERVAL', '30000')!,
  10
)
// Fail-closed window for an UNREACHABLE HCC (5xx / transport failures only).
// It is bounded so a revoked-but-unconfirmable authority cannot linger forever,
// yet generous enough to survive a normal HCC `Recreate` rollout (measured ~77s
// in clerum-dev, with a startupProbe budget of up to 120s) without tearing down
// the whole MCP fleet and aborting in-flight tool calls.
//
// Crucially, this window ONLY governs the `unavailable` failure class. Identity /
// authorization failures (401/403 — Host UID change, revoked grant) revoke
// immediately on the next reachable call and are NOT gated by this value, and a
// grant change while HCC is healthy is applied by the next successful poll. So
// raising this ceiling does not delay any real authority revocation and does not
// widen the NP-08 credential-disclosure surface (which lives entirely in HCC's
// per-request authorization). See issue #425.
//
// Operators may lower it, or raise it up to HCC_AUTHORITY_MAX_STALENESS_CEILING_MS
// for slower-starting clusters. The minikube e2e lane pins 60000 explicitly so the
// revoke-on-staleness scenario stays fast and deterministic.
const HCC_AUTHORITY_MAX_STALENESS_CEILING_MS = 600_000 // 10 min hard upper bound
const hccAuthorityMaxStalenessMs = Math.min(
  getEnvNumber('HCC_AUTHORITY_MAX_STALENESS_MS', 180_000),
  HCC_AUTHORITY_MAX_STALENESS_CEILING_MS
)

// Dev mode does not retain a Kubernetes-authoritative MCP fleet, so the
// production polling/staleness relationship is intentionally not required for
// local fixture runs. Every cluster-mode process must satisfy it at startup.
if (!devMode) validateHccAuthorityTiming(contextMapperPollInterval, hccAuthorityMaxStalenessMs)

export const config: Config = {
  devMode,
  devHostConfig: getDevHostConfig(),

  // Host name (required in production mode)
  hostName:
    process.env.CLERUM_HOST_NAME ||
    (devMode || process.env.NODE_ENV !== 'production'
      ? 'dev-host'
      : (() => {
          throw new Error('Missing required environment variable: CLERUM_HOST_NAME')
        })()),

  // Kubernetes namespace
  namespace: getEnv('CLERUM_NAMESPACE', 'default')!,

  // Namespace where installed LlmHook workloads/Services live (spec §8.2).
  llmHooksNamespace: getEnv('CLERUM_LLM_HOOKS_NAMESPACE', 'llm-hooks')!,

  // LLM allowlist ConfigMap name (R3). CROSS-SERVICE CONTRACT: the default
  // (`clerum-llm-allowed-models`) is the CM produced by control-api
  // (control-api/src/services/llmAllowedModelsConfigMap.ts) and also read by WRC
  // (workflow-recipes/src/workflow/modelConfigHandler.ts). The env override is a
  // canary/test knob for THIS mcp-host only — pointing it at a CM control-api does
  // not write breaks the allowlist seam (the Host then sees no allowed models).
  llmAllowlistConfigMapName: getEnv('CLERUM_LLM_ALLOWED_MODELS_CM', 'clerum-llm-allowed-models')!,

  // Dev mode model config. Provider is validated (and only resolved) in dev mode;
  // resolveDevModelProvider fail-closes on a set-but-invalid value.
  devModelProvider: devMode ? resolveDevModelProvider(rawDevModelProvider) : undefined,
  devModelName,

  // Dev mode MCP servers
  devMcpServers: devMode ? parseDevMcpServers() : undefined,

  // MCP Proxy: feature flag + URL (default: off, direct connection to each MCP server)
  mcpProxyEnabled: getEnvBool('MCP_PROXY_ENABLED', false),
  mcpProxyUrl: getEnv(
    'MCP_PROXY_URL',
    devMode ? 'http://localhost:8083' : 'http://mcp-proxy.mcp-server.svc.cluster.local:8083'
  )!,

  // RPC Server port
  serverPort: parseInt(getEnv('CLERUM_SERVER_PORT', '8080')!, 10),

  // Host Context Controller URL (defaults based on mode)
  contextMapperUrl: getEnv(
    'CLERUM_CONTEXT_MAPPER_URL',
    devMode
      ? 'http://localhost:8081'
      : 'http://host-context-controller-api-gateway.control-plane.svc.cluster.local:8081'
  )!,

  // Context Mapper poll interval (default 30 seconds)
  contextMapperPollInterval,

  // Bound transient HCC/Kubernetes authority outages. Identity failures revoke
  // immediately; 5xx/transport failures may preserve the last good fleet only
  // within this finite window.
  hccAuthorityMaxStalenessMs,

  // MCP status heartbeat. Defaults to 30 seconds so a single missed tick does
  // not trip desktop staleness.
  mcpStatusHeartbeatInterval: parseMcpStatusHeartbeatDuration(
    'CLERUM_MCP_STATUS_HEARTBEAT_INTERVAL',
    getEnv('CLERUM_MCP_STATUS_HEARTBEAT_INTERVAL'),
    30_000
  ),
  mcpStatusHeartbeatTimeoutMs: parseMcpStatusHeartbeatDuration(
    'CLERUM_MCP_STATUS_HEARTBEAT_TIMEOUT_MS',
    getEnv('CLERUM_MCP_STATUS_HEARTBEAT_TIMEOUT_MS'),
    25_000
  ),

  // Agent configuration
  agentTaskDelay: parseInt(getEnv('CLERUM_AGENT_TASK_DELAY', '100')!, 10),
  agentMaxTaskDuration: parseInt(getEnv('CLERUM_AGENT_MAX_TASK_DURATION', '1800000')!, 10),
  agentMaxToolCallsPerTask: parseInt(getEnv('CLERUM_AGENT_MAX_TOOL_CALLS', '50')!, 10),
  agentMaxQueueSize: parseInt(getEnv('CLERUM_AGENT_MAX_QUEUE_SIZE', '100')!, 10),
  // 0 = disabled (default): an unresolved approval never auto-denies in memory,
  // so the request stays available no matter how long the human takes. A
  // suspended session only blocks its OWN session's next tasks (it frees the
  // global concurrency slot in SessionProcessor), and the durable pending row is
  // still bounded by `pendingApprovalTtlMs` (7d) + the boot-time reaper.
  agentApprovalTimeout: parseInt(getEnv('CLERUM_APPROVAL_TIMEOUT', '0')!, 10),
  pendingApprovalTtlMs:
    parseInt(getEnv('CLERUM_PENDING_APPROVAL_TTL_HOURS', '168')!, 10) * 3600 * 1000, // 7d default

  // Workflow step iteration limit — max LLM↔tool rounds per step before forced wrap-up.
  // Override per step via CRD spec.steps[].maxIterations. Default 50.
  workflowMaxIterations: parseInt(getEnv('CLERUM_WORKFLOW_MAX_ITERATIONS', '50')!, 10),

  // Approval system (default ON; tools advertise requiresApproval()).
  enableApproval: getEnvBool('CLERUM_ENABLE_APPROVAL', true),
  // Dev-mode override; in prod the values come from the Host CRD.
  approvalConfig: parseApprovalConfig(),
  guardrailsConfig: parseGuardrailsConfig(),

  // Nudge controller (default OFF).
  enableNudge: getEnvBool('CLERUM_ENABLE_NUDGE', false),
  nudgeMaxIterations: parseInt(getEnv('CLERUM_NUDGE_MAX_ITERATIONS', '3')!, 10),

  // Context compaction: max token budget (default 100k, configurable via CLERUM_CONTEXT_MAX_TOKENS)
  //
  // IronClaw invariant #1 (P.3 §4.1): compaction is skipped while a session
  // has `pending_approval`. The token-budget threshold is not relaxed — the
  // loop simply emits `compaction:skipped` and lets the snapshot survive
  // verbatim. The session unblocks once the user approves/denies.
  //
  // Approval timeouts and the new `approval_expired` route are INDEPENDENT
  // failure modes (P.3 §4.4):
  //   - `AgentConfig.approvalTimeout` ticks from registerApproval; on expiry
  //     the executor is auto-denied with `reason='approval_timeout'`.
  //   - `approval_expired` fires only on resume, when a spillover ref in the
  //     snapshot is gone. The user clicked Approve in time — the underlying
  //     data simply no longer exists. T1.5 will add CLERUM_SPILLOVER_TTL_HOURS
  //     to govern that lifetime.
  contextMaxTokens: parseInt(getEnv('CLERUM_CONTEXT_MAX_TOKENS', '100000')!, 10),

  // P.2 — Tokenizer dry-run. When true (default during the bake-week), the
  // PressureContextManager computes both the heuristic and the real counter
  // values for every decision, but USES the heuristic to choose the tier.
  // Provides observability via `clerum_tokenizer_dryrun_delta` /
  // `clerum_tokenizer_dryrun_tier_mismatch_total` without changing behavior.
  // Flip to false (default after recalibration) once the new thresholds land.
  tokenizerDryrun: getEnvBool('CLERUM_TOKENIZER_DRYRUN', true),
  // When true the AnthropicTokenCounter skips its network call and returns the
  // heuristic upper bound instead.
  //
  // Defaults to TRUE so the default config makes ZERO network calls on the hot
  // path (legacy/safe). With offline=false + dryRun=true, `computePressure`
  // would fire a real `beta.messages.countTokens` round-trip on EVERY manage()
  // (~2×/loop iteration) for Claude hosts — added latency + rate-limit pressure
  // purely to compute a dry-run delta that does not change the tier decision.
  // Operators flip this to false deliberately for the recalibration bake-week,
  // accepting the network cost while watching the rate-limit metric.
  tokenizerOffline: getEnvBool('CLERUM_TOKENIZER_OFFLINE', true),

  // T1.4 — Anti-thrash. If a compaction reduces tokens by less than this
  // fraction (`ratio = post/pre > 0.9` ≈ ≤10% saved), it counts as ineffective.
  // After `compactionIneffectiveMaxRun` consecutive ineffective compactions
  // the PressureContextManager stops compacting until the task ends, leaving
  // the existing task-level budgets to wrap things up cleanly. Defaults match
  // Hermes (`.specs/mcp-hermes/1-diagnostic-hermes.md` §8 / §13).
  compactionIneffectiveRatio: parseFloat(getEnv('CLERUM_COMPACTION_INEFFECTIVE_RATIO', '0.9')!),
  compactionIneffectiveMaxRun: parseInt(getEnv('CLERUM_COMPACTION_INEFFECTIVE_MAX_RUN', '2')!, 10),

  // T1.2 — Pre-pruning. Master flag defaults OFF; flipped per-Host once
  // staging metrics confirm the savings ratio. Per-pass toggles default ON so
  // operators can flip them all at once with the master. See
  // `.specs/mcp-hermes/implementation-plans/T1.2-pre-pruning.md` §9.
  compactionPrePruneEnabled: getEnvBool('CLERUM_COMPACTION_PRE_PRUNE', false),
  compactionPrePruneDedup: getEnvBool('CLERUM_COMPACTION_PRE_PRUNE_DEDUP', true),
  compactionPrePruneOneLine: getEnvBool('CLERUM_COMPACTION_PRE_PRUNE_ONE_LINE', true),
  compactionPrePruneJsonTruncate: getEnvBool('CLERUM_COMPACTION_PRE_PRUNE_JSON_TRUNC', true),
  compactionPrePruneStripMedia: getEnvBool('CLERUM_COMPACTION_PRE_PRUNE_STRIP_MEDIA', true),
  compactionPrePruneMaxArgsBytes: parseInt(
    getEnv('CLERUM_COMPACTION_PRE_PRUNE_TRUNCATE_BYTES', '4096')!,
    10
  ),
  compactionPrePruneSummaryTokens: parseInt(
    getEnv('CLERUM_COMPACTION_PRE_PRUNE_SUMMARY_TOKENS', '200')!,
    10
  ),
  compactionPrePruneProtectedTailTurns: parseInt(
    getEnv('CLERUM_COMPACTION_PROTECTED_TAIL_TURNS', '3')!,
    10
  ),

  // T1.1 — Structured summary template. Default OFF until staging confirms
  // parse-ok rate ≥ 80% on the LLM in use.
  compactionStructuredSummary: getEnvBool('CLERUM_COMPACTION_STRUCTURED_SUMMARY', false),

  // T2.2 — System-prompt cache. ENABLED by default since 2026-06-23 (was OFF
  // pending an Anthropic canary that never ran; shipped on + monitored instead).
  // ROLLBACK: set CLERUM_PROMPT_CACHE_ENABLED=false (per-process env, no code
  // change) on any host if a regression is observed.
  // When ON, `TaskExecutor.buildLoopConfig` builds tiered `SystemPromptParts`
  // via `PromptCache.getOrBuild`, plumbs them through `ReasoningPort` and
  // `LlmPortAdapter`, and the Anthropic provider emits `cache_control`. For
  // providers without explicit cache markers (OpenAI / ZAI / Bailian) the
  // parts are concatenated back into a single `system` string (no native
  // caching, but the tiered build path is used uniformly).
  promptCacheEnabled: getEnvBool('CLERUM_PROMPT_CACHE_ENABLED', true),

  // F1 (dynamic-tool-loading) — Gates the dynamic-tool-loading bridge; default
  // OFF; set true per-host to enable; see
  // `.specs/dynamic-tool-loading/plan-hermes-bridge.es.md`.
  dynamicToolsEnabled: getEnvBool('CLERUM_DYNAMIC_TOOLS_ENABLED', false),
  // F1 (dynamic-tool-loading) — Minimum deferrable (MCP) tool count above which
  // the bridge activates when enabled; small hosts stay on passthrough.
  dynamicToolsThreshold: getEnvNumber('CLERUM_DYNAMIC_TOOLS_THRESHOLD', 60),

  // T2.1 — Conversation store backend selector.
  //
  //   - `memory`: legacy InMemoryConversationStore (no durability). Default
  //     so the canary rollout can opt in per Host.
  //   - `sqlite`: SqliteConversationStore (RAM + worker thread + state.db).
  //   - `dual`: both stores live, reads from RAM, writes apply to both —
  //     for one-week parity validation (`clerum_conversation_store_parity_total`).
  //
  // See `.specs/mcp-hermes/implementation-plans/T2.1-sqlite-store.md` §10.
  sessionStoreMode: (() => {
    const raw = (getEnv('CLERUM_SESSION_STORE', 'memory') || 'memory').toLowerCase()
    if (raw === 'memory' || raw === 'sqlite' || raw === 'dual') {
      return raw as 'memory' | 'sqlite' | 'dual'
    }
    console.warn(
      `[Config] CLERUM_SESSION_STORE='${raw}' is not recognized — falling back to 'memory'`
    )
    return 'memory' as const
  })(),
  sessionStoreModeRaw: (getEnv('CLERUM_SESSION_STORE', 'memory') || 'memory').toLowerCase(),
  sessionDbPath: getEnv('CLERUM_SESSION_DB_PATH', '') || '',
  sessionDbDir: getEnv('CLERUM_SESSION_DB_DIR', '') || '',
  statelessLifecycle: getEnvBool('CLERUM_STATELESS_LIFECYCLE', false),
  statelessHeartbeatIntervalMs: parseStatelessHeartbeatIntervalMs(
    getEnv('CLERUM_STATELESS_HEARTBEAT_INTERVAL_MS')
  ),
  // Stage 3 — Kubernetes downward API pod UID. Empty when the operator has
  // not injected it; StatelessHeartbeat fails loud at construction when the
  // stateless lifecycle needs it.
  podUid: getEnv('CLERUM_POD_UID', '') || '',
  // D3 §1.1 — explicit env opt-in for the fsync barrier on always-on Hosts.
  // Accepted values: '' (unset), 'normal', 'full'. Anything else is a config
  // error and fails loud at load time — a typo must not silently disable the
  // durability the operator asked for.
  dbBarrierModeFull: (() => {
    const raw = (getEnv('CLERUM_DB_BARRIER_MODE', '') || '').toLowerCase()
    if (raw === '' || raw === 'normal') return false
    if (raw === 'full') return true
    throw new Error(
      `[Config] CLERUM_DB_BARRIER_MODE='${raw}' is not recognized (expected 'full' or 'normal')`
    )
  })(),
  conversationCacheSize: parseInt(getEnv('CLERUM_CONVERSATION_CACHE_SIZE', '200')!, 10),
  sessionTtlDays: parseInt(getEnv('CLERUM_SESSION_TTL_DAYS', '90')!, 10),
  dbWorkerHeartbeatMs: parseInt(getEnv('CLERUM_DB_WORKER_HEARTBEAT_MS', '5000')!, 10),
  dbPersistSyncTimeoutMs: parseInt(getEnv('CLERUM_DB_PERSIST_SYNC_TIMEOUT_MS', '2000')!, 10),
  dbPersistAsyncTimeoutMs: parseInt(getEnv('CLERUM_DB_PERSIST_ASYNC_TIMEOUT_MS', '5000')!, 10),
  dbCheckpointEveryWrites: parseInt(getEnv('CLERUM_DB_CHECKPOINT_EVERY_WRITES', '100')!, 10),
  dbWalSizeAlarmBytes: parseInt(getEnv('CLERUM_DB_WAL_SIZE_ALARM_BYTES', '52428800')!, 10),

  // T3.1 — `clerum__session_search` tool + REST. Default OFF: must be flipped
  // on per-Host once staging soak validates cross-user isolation (test #18).
  // Retention controls the boot-only sweep; defaults to 90 days per spec §8.
  sessionSearchEnabled: getEnvBool('CLERUM_SESSION_SEARCH_ENABLED', false),
  searchRetentionDays: parseInt(getEnv('CLERUM_SEARCH_RETENTION_DAYS', '90')!, 10),

  // T1.5 — Tool-result spillover. Master flag defaults ON (the feature is
  // backward-safe: outputs under the threshold are unchanged). Set to false
  // to disable persistence entirely; the loop falls back to the pre-T1.5
  // path (full content inline).
  toolSpilloverEnabled: getEnvBool('CLERUM_TOOL_SPILLOVER_ENABLED', true),
  toolSpilloverThresholdBytes: parseInt(getEnv('CLERUM_TOOL_SPILLOVER_THRESHOLD', '8192')!, 10),
  // TTL window for persisted blobs. Default 168h = 1 week. The resolver
  // double-checks the TTL on load even when GC hasn't pruned yet.
  spilloverTtlMs: parseInt(getEnv('CLERUM_SPILLOVER_TTL_HOURS', '168')!, 10) * 3600 * 1000,
  // Periodic sweep. `0` disables the timer; the lazy boot sweep still runs.
  spilloverGcIntervalMs:
    parseInt(getEnv('CLERUM_SPILLOVER_GC_INTERVAL_MINUTES', '60')!, 10) * 60 * 1000,

  // Native tool configuration
  nativeTool: {
    workspacePath: process.env.CLERUM_WORKSPACE_PATH || process.cwd(),
    shellTimeout: parseInt(getEnv('CLERUM_SHELL_TIMEOUT', '600000')!, 10),
    toolTimeout: parseInt(getEnv('CLERUM_TOOL_TIMEOUT', '660000')!, 10),
    toolProgressInterval: parseInt(getEnv('CLERUM_TOOL_PROGRESS_INTERVAL_MS', '30000')!, 10),
    httpAllowlist: (process.env.CLERUM_HTTP_ALLOWLIST || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    envAllowlist: (process.env.CLERUM_ENV_ALLOWLIST || 'PATH,HOME,USER,SHELL,LANG,TERM')
      .split(',')
      .map(s => s.trim()),
    memoryMaxSize: parseInt(getEnv('CLERUM_MEMORY_MAX_SIZE', '1048576')!, 10),
    // Cron×stateless: mirrors the top-level statelessLifecycle flag so the
    // native tool registry (which only receives NativeToolConfig) can steer
    // the cron_manage stateless notice.
    statelessLifecycle: getEnvBool('CLERUM_STATELESS_LIFECYCLE', false),
  },

  // Attachment delivery
  enableResponseAttachments: getEnvBool('CLERUM_ENABLE_RESPONSE_ATTACHMENTS', true),
  attachmentMaxCount: parseInt(getEnv('CLERUM_ATTACHMENT_MAX_COUNT', '3')!, 10),
  attachmentMaxBytes: parseInt(getEnv('CLERUM_ATTACHMENT_MAX_BYTES', '52428800')!, 10),
  activityBufferSize: parseInt(getEnv('MCP_HOST_ACTIVITY_BUFFER_SIZE', '1000')!, 10),
  activityMaxEventBytes: parseInt(getEnv('MCP_HOST_ACTIVITY_MAX_EVENT_BYTES', '2048')!, 10),

  // Memory (workspace) — CLERUM_MEMORY_ENABLED, CLERUM_MEMORY_WORKSPACE_PATH.
  memory: {
    enabled: getEnvBool('CLERUM_MEMORY_ENABLED', false),
    workspacePath: getEnv('CLERUM_MEMORY_WORKSPACE_PATH', devMode ? './workspace' : '/workspace'),
  },

  // Token budgets (P1)
  budgetsEnabled: getEnvBool('CLERUM_BUDGETS_ENABLED', false),

  // Governed tracing
  governedTracingEnabled: getEnvBool('GOVERNED_TRACING_ENABLED', true),
  approvalPromptHistoryEnabled: process.env.TRACING_APPROVAL_PROMPT_HISTORY_ENABLED === 'true',
  approvalPromptHistoryMaxBytes: parseApprovalPromptHistoryMaxBytes(
    getEnv('TRACING_APPROVAL_PROMPT_HISTORY_MAX_BYTES', '16384')!
  ),

  // Canonical runtime mode. Keep the boolean derived from the discriminant so
  // downstream code cannot observe an impossible sdk-only+workflow pairing.
  runtimeKind: configuredRuntimeKind,
  workflowEnabled: configuredRuntimeKind === 'workflow',
  workflowRecipeName: getEnv('CLERUM_WORKFLOW_RECIPE', '')!,
  userApprovalRequestRecipeName: getEnv('CLERUM_WORKFLOW_APPROVAL_RECIPE', '')!,
  userApprovalRequestRecipeNamespace: getEnv(
    'CLERUM_WORKFLOW_APPROVAL_RECIPE_NAMESPACE',
    'mcp-host'
  )!,

  // Auth configuration
  enableAuth: getEnvBool('CLERUM_ENABLE_AUTH', true),
  authJwtPublicKey: (getEnv('CLERUM_AUTH_JWT_PUBLIC_KEY', '') || '').replace(/\\n/g, '\n'),
  authJwtIssuer: getEnv('CLERUM_AUTH_JWT_ISSUER', 'control-api')!,
  // Audience must be "rpc-proxy"; control-api stamps that value onto every
  // issued RPC token.
  authJwtAudience: getEnv('CLERUM_AUTH_JWT_AUDIENCE', 'rpc-proxy')!,

  // Verifies workflow-mode tokens (iss: clerum-wrc); separate signer from authJwtPublicKey.
  wrcPublicKey: (getEnv('WRC_PUBLIC_KEY_PEM', '') || '').replace(/\\n/g, '\n'),

  // mcpHost runtime JWTs for workflow approval gating
  mcpHostRuntimeAccessToken: getEnv('MCP_HOST_RUNTIME_ACCESS_TOKEN', ''),
  mcpHostRuntimeRefreshToken: getEnv('MCP_HOST_RUNTIME_REFRESH_TOKEN', ''),
  mcpHostGatewayUrl: getEnv('MCP_HOST_GATEWAY_URL', ''),
  mcpHostWorkflowControlToken: getEnv('MCP_HOST_WORKFLOW_CONTROL_TOKEN', ''),
  mcpHostWorkflowControlTokenFile: getEnv('MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE', ''),

  // Plugin Workload SDK (plan §3.5 config table)
  pluginWorkloadSdkEnabled: getEnvBool('PLUGIN_WORKLOAD_SDK_ENABLED', false),
  pluginWorkloadSdkCapabilities: parsePluginWorkloadSdkCapabilities(
    getEnv('PLUGIN_WORKLOAD_SDK_CAPABILITIES', '')
  ),
  // Workflow is the backwards-compatible SDK mode for workflow/standalone
  // processes; WRC explicitly sets sdk-only on the stepless adapter.
  pluginWorkloadSdkRuntimeMode: configuredRuntimeKind === 'sdk-only' ? 'sdk-only' : 'workflow',
  pluginWorkloadSdkPort: parseInt(getEnv('MCP_HOST_PLUGIN_SDK_PORT', '8099')!, 10),
  podNamespace: getEnv('MCP_HOST_POD_NAMESPACE', '')!,
  pluginWorkloadSdkGatewayUrl: getEnv('CONTROL_API_GATEWAY_URL', ''),
  pluginWorkloadSdkCredentialBrokerUrl: getEnv('CLERUM_WRC_URL', '') ?? '',
  pluginWorkloadSdkWorkloadToken: getEnv('PLUGIN_WORKLOAD_SDK_WORKLOAD_TOKEN', ''),
  pluginWorkloadSdkBoundCallerRef: getEnv('PLUGIN_WORKLOAD_SDK_BOUND_CALLER_REF', ''),
  pluginWorkloadSdkWorkloadTokensDir: getEnv('PLUGIN_WORKLOAD_SDK_WORKLOAD_TOKENS_DIR', ''),
  pluginWorkloadSdkPromptTimeoutSeconds: parseInt(
    getEnv('PLUGIN_WORKLOAD_SDK_PROMPT_TIMEOUT_SECONDS', '120')!,
    10
  ),
  pluginWorkloadSdkMaxConnections: parseInt(
    getEnv('PLUGIN_WORKLOAD_SDK_MAX_CONNECTIONS', '100')!,
    10
  ),
  pluginWorkloadSdkMaxConnectionsPerWorkload: parseInt(
    getEnv('PLUGIN_WORKLOAD_SDK_MAX_CONNECTIONS_PER_WORKLOAD', '10')!,
    10
  ),
  pluginWorkloadSdkMaxRpmPerWorkload: parseInt(
    getEnv('PLUGIN_WORKLOAD_SDK_MAX_RPM_PER_WORKLOAD', '100')!,
    10
  ),
  pluginWorkloadSdkMaxLlmResponseBytes: parseInt(
    getEnv('PLUGIN_WORKLOAD_SDK_MAX_LLM_RESPONSE_BYTES', String(1024 * 1024))!,
    10
  ),

  // Personalization — CLERUM_PERSONALIZATION_ENABLED, CLERUM_IDENTITY_SEED (JSON).
  personalization: (() => {
    const enabled = getEnvBool('CLERUM_PERSONALIZATION_ENABLED', false)
    const seedJson = getEnv('CLERUM_IDENTITY_SEED')
    let seed: Omit<PersonalizationConfig, 'enabled'> = {}
    if (seedJson) {
      try {
        seed = JSON.parse(seedJson) as Omit<PersonalizationConfig, 'enabled'>
      } catch {
        console.error('[Config] Failed to parse CLERUM_IDENTITY_SEED')
      }
    }
    return { enabled, ...seed }
  })(),
}
