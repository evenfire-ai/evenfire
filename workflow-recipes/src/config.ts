/**
 * Workload Recipes Controller (WRC) configuration.
 * Follows the same env-config pattern as host-context-controller/src/config.ts
 */

export interface DbConfig {
  connectionString?: string
  host: string
  port: number
  user: string
  password: string
  database: string
  ssl: boolean
  poolMax: number
  instanceId: string
  leaderPollMs: number
  runPollMs: number
}

export type NetworkPolicyEnforcementMode = 'warn' | 'required'

export interface OperatorConfig {
  devMode: boolean
  port: number
  /**
   * Namespace for McpServer transport children that WRC renders for recipe
   * workloads with `transport`. This is not the WorkflowRecipe CRD namespace.
   */
  namespace: string
  /** WorkflowRecipe CRDs, coordinator pods, and recipe mcp-host pods live here. */
  sandboxNamespace: string
  /**
   * Namespace where sandbox UI workloads (referenced by `spec.ui.workloadRef`)
   * are deployed. Isolated from sandbox-recipes so NetworkPolicy enforcement
   * can scope rpc-proxy ingress to UI pods only.
   */
  sandboxUiNamespace: string
  hostNamespace: string
  /**
   * Base URL of the evenfire registry. Deliberately the SAME variable control-api reads
   * (`CLERUM_REGISTRY_URL`), because both services must agree on which images are ours:
   * control-api provisions the platform pull credential for those images, WRC attaches it.
   * A divergence here means recipe pods silently get no credential while MCP servers do.
   * Empty (the default) disables platform pull-secret injection entirely.
   */
  registryUrl: string
  selfName: string
  internalControlJwtWrcHmacSecret: string
  enableCustomCoordinatorImage: boolean
  enableSnippetRuntime: boolean
  /**
   * Master switch for the Plugin Workload SDK (promptBridge +
   * clientNotifications). When false the reconciler still accepts and
   * validates spec.pluginWorkloadSdk, but annotates the recipe status with
   * condition PluginWorkloadSdkCapability=False (feature flag off) and no
   * runtime capability is activated.
   */
  pluginWorkloadSdkEnabled: boolean
  maxWorkflowSteps: number
  workflowMaxWorkloadsPerRecipe: number
  workflowUiEgressInternalMaxItems: number
  allowedCoordinatorImagePrefixes: string[]
  requireCoordinatorImageDigest: boolean
  enableDeterministicMode: boolean
  /** Best-effort governed tracing to control-api. Default ON to preserve behavior. */
  governedTracingEnabled: boolean
  /** Image reference WRC injects into per-recipe webhook-gateway Deployments. */
  webhookGatewayImage: string
  /** Namespace label of webhook-proxy (used in per-recipe NetworkPolicies). */
  webhookIngressNamespace: string
  /** Namespace label of the Prometheus scraper (used in per-recipe NetworkPolicies). */
  monitoringNamespace: string
  /**
   * Namespace where control-api runs. Used in the per-recipe egress
   * NetworkPolicy that lets background-OAuth workloads reach the broker route.
   */
  controlPlaneNamespace: string
  workflowDefaultRunDurationSeconds: number
  workflowMaxRunDurationSeconds: number
  workflowStepOutputPreviewMaxChars: number
  runtimeTokenTtlSeconds: number
  runtimeTokenRefreshBeforeSeconds: number
  runtimeEgressDnsOverlapSeconds: number
  networkPolicyEnforcementMode: NetworkPolicyEnforcementMode
  networkPolicyEnforcementConfirmed: boolean
  workflowMaxSteps: number
  workflowStepDependsOnMaxItems: number
  workflowStepAllowedToolsMaxItems: number
  workflowStepMcpServersMaxItems: number
  workflowStatefulSetMaxReplicas: number
  workflowStatefulSetMaxVolumeClaimTemplates: number
  workflowStatefulSetMaxPvcPreflightChecks: number
  // Optional only for unit tests that exercise pure reconciler logic without
  // a live Postgres pool. Production and E2E use the DB-backed run pipeline.
  db?: DbConfig
}

export const DEFAULT_MAX_WORKFLOW_STEPS = 100
export const DEFAULT_MAX_WORKLOADS_PER_RECIPE = 25
export const DEFAULT_UI_EGRESS_INTERNAL_MAX_ITEMS = 25
export const DEFAULT_STATEFULSET_MAX_REPLICAS = 20
export const DEFAULT_STATEFULSET_MAX_VOLUME_CLAIM_TEMPLATES = 4
export const DEFAULT_WORKFLOW_DEFAULT_RUN_DURATION_SECONDS = 60 * 60
export const DEFAULT_WORKFLOW_MAX_RUN_DURATION_SECONDS = 24 * 60 * 60
export const DEFAULT_WORKFLOW_STEP_OUTPUT_PREVIEW_MAX_CHARS = 32 * 1024
export const MIN_WORKFLOW_STEP_OUTPUT_PREVIEW_MAX_CHARS = 1024
export const MAX_WORKFLOW_STEP_OUTPUT_PREVIEW_MAX_CHARS = 64 * 1024
export const DEFAULT_RUNTIME_TOKEN_TTL_SECONDS = 15 * 60
export const DEFAULT_RUNTIME_TOKEN_REFRESH_BEFORE_SECONDS = 5 * 60
export const DEFAULT_RUNTIME_EGRESS_DNS_OVERLAP_SECONDS = 5 * 60
export const MIN_RUNTIME_EGRESS_DNS_OVERLAP_SECONDS = 30
export const MAX_RUNTIME_EGRESS_DNS_OVERLAP_SECONDS = 60 * 60

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key]
  if (!value) return defaultValue
  return value.toLowerCase() === 'true' || value === '1'
}

function getEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key]
  if (!value) return defaultValue
  const parsed = parseInt(value, 10)
  if (isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid value for ${key}: "${value}" (must be a positive integer)`)
  }
  return parsed
}

function getEnvBoundedInt(key: string, defaultValue: number, maxValue: number): number {
  const value = process.env[key]
  if (!value) return defaultValue
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maxValue) {
    throw new Error(
      `Invalid value for ${key}: "${value}" (must be an integer between 1 and ${maxValue})`
    )
  }
  return parsed
}

function getEnvBoundedIntRange(
  key: string,
  defaultValue: number,
  minValue: number,
  maxValue: number
): number {
  const value = process.env[key]
  if (!value) return defaultValue
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minValue || parsed > maxValue) {
    throw new Error(
      `Invalid value for ${key}: "${value}" (must be an integer between ${minValue} and ${maxValue})`
    )
  }
  return parsed
}

function getEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue
}

function getEnvList(key: string): string[] {
  const value = process.env[key]
  if (!value) return []
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function getNetworkPolicyEnforcementMode(): NetworkPolicyEnforcementMode {
  const value = (process.env.CLERUM_NETWORK_POLICY_ENFORCEMENT_MODE ?? 'required').toLowerCase()
  if (value === 'warn' || value === 'required') return value
  throw new Error(
    `Invalid value for CLERUM_NETWORK_POLICY_ENFORCEMENT_MODE: "${value}" (must be "warn" or "required")`
  )
}

export function loadConfig(): OperatorConfig {
  const workflowMaxSteps = getEnvBoundedInt(
    'WRC_MAX_WORKFLOW_STEPS',
    getEnvBoundedInt(
      'CLERUM_WORKFLOW_MAX_STEPS',
      DEFAULT_MAX_WORKFLOW_STEPS,
      DEFAULT_MAX_WORKFLOW_STEPS
    ),
    DEFAULT_MAX_WORKFLOW_STEPS
  )
  const workflowMaxWorkloadsPerRecipe = getEnvBoundedInt(
    'CLERUM_WORKFLOW_MAX_WORKLOADS_PER_RECIPE',
    DEFAULT_MAX_WORKLOADS_PER_RECIPE,
    DEFAULT_MAX_WORKLOADS_PER_RECIPE
  )
  const workflowUiEgressInternalMaxItems = getEnvBoundedInt(
    'CLERUM_WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS',
    DEFAULT_UI_EGRESS_INTERNAL_MAX_ITEMS,
    DEFAULT_UI_EGRESS_INTERNAL_MAX_ITEMS
  )
  const workflowStatefulSetMaxReplicas = getEnvBoundedInt(
    'CLERUM_WORKFLOW_STATEFULSET_MAX_REPLICAS',
    DEFAULT_STATEFULSET_MAX_REPLICAS,
    DEFAULT_STATEFULSET_MAX_REPLICAS
  )
  const workflowStatefulSetMaxVolumeClaimTemplates = getEnvBoundedInt(
    'CLERUM_WORKFLOW_STATEFULSET_MAX_VOLUME_CLAIM_TEMPLATES',
    DEFAULT_STATEFULSET_MAX_VOLUME_CLAIM_TEMPLATES,
    DEFAULT_STATEFULSET_MAX_VOLUME_CLAIM_TEMPLATES
  )
  const workflowStatefulSetMaxPvcPreflightChecks =
    workflowStatefulSetMaxReplicas * workflowStatefulSetMaxVolumeClaimTemplates

  const workflowMaxRunDurationSeconds = getEnvBoundedInt(
    'WRC_WORKFLOW_MAX_RUN_DURATION_SECONDS',
    DEFAULT_WORKFLOW_MAX_RUN_DURATION_SECONDS,
    DEFAULT_WORKFLOW_MAX_RUN_DURATION_SECONDS
  )
  const workflowDefaultRunDurationSeconds = getEnvBoundedInt(
    'WRC_WORKFLOW_DEFAULT_RUN_DURATION_SECONDS',
    Math.min(DEFAULT_WORKFLOW_DEFAULT_RUN_DURATION_SECONDS, workflowMaxRunDurationSeconds),
    workflowMaxRunDurationSeconds
  )
  const runtimeTokenTtlSeconds = getEnvBoundedInt(
    'WRC_RUNTIME_TOKEN_TTL_SECONDS',
    DEFAULT_RUNTIME_TOKEN_TTL_SECONDS,
    DEFAULT_WORKFLOW_MAX_RUN_DURATION_SECONDS
  )
  const runtimeTokenRefreshBeforeSeconds = getEnvBoundedInt(
    'WRC_RUNTIME_TOKEN_REFRESH_BEFORE_SECONDS',
    DEFAULT_RUNTIME_TOKEN_REFRESH_BEFORE_SECONDS,
    runtimeTokenTtlSeconds
  )
  if (runtimeTokenRefreshBeforeSeconds >= runtimeTokenTtlSeconds) {
    throw new Error(
      'Invalid runtime token configuration: WRC_RUNTIME_TOKEN_REFRESH_BEFORE_SECONDS must be less than WRC_RUNTIME_TOKEN_TTL_SECONDS'
    )
  }

  const workflowStepOutputPreviewMaxChars = getEnvBoundedIntRange(
    'WRC_WORKFLOW_STEP_OUTPUT_PREVIEW_MAX_CHARS',
    DEFAULT_WORKFLOW_STEP_OUTPUT_PREVIEW_MAX_CHARS,
    MIN_WORKFLOW_STEP_OUTPUT_PREVIEW_MAX_CHARS,
    MAX_WORKFLOW_STEP_OUTPUT_PREVIEW_MAX_CHARS
  )
  const runtimeEgressDnsOverlapSeconds = getEnvBoundedIntRange(
    'WRC_RUNTIME_EGRESS_DNS_OVERLAP_SECONDS',
    DEFAULT_RUNTIME_EGRESS_DNS_OVERLAP_SECONDS,
    MIN_RUNTIME_EGRESS_DNS_OVERLAP_SECONDS,
    MAX_RUNTIME_EGRESS_DNS_OVERLAP_SECONDS
  )

  return {
    devMode: getEnvBool('CLERUM_DEV_MODE', false),
    port: getEnvInt('CLERUM_OPERATOR_PORT', 8082),
    namespace: getEnv('CLERUM_NAMESPACE', 'mcp-server'),
    sandboxNamespace: getEnv('CLERUM_SANDBOX_NAMESPACE', 'sandbox-recipes'),
    sandboxUiNamespace: getEnv('CLERUM_SANDBOX_UI_NAMESPACE', 'sandbox-ui'),
    hostNamespace: getEnv('CLERUM_HOST_NAMESPACE', 'mcp-host'),
    registryUrl: getEnv('CLERUM_REGISTRY_URL', ''),
    selfName: getEnv('CLERUM_OPERATOR_NAME', 'workflow-recipes'),
    internalControlJwtWrcHmacSecret: getEnv('INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET', ''),
    enableCustomCoordinatorImage: getEnvBool('WRC_ENABLE_CUSTOM_COORDINATOR_IMAGE', false),
    enableSnippetRuntime: getEnvBool('WRC_ENABLE_SNIPPET_RUNTIME', false),
    pluginWorkloadSdkEnabled: getEnvBool('PLUGIN_WORKLOAD_SDK_ENABLED', false),
    maxWorkflowSteps: workflowMaxSteps,
    workflowMaxWorkloadsPerRecipe,
    workflowUiEgressInternalMaxItems,
    workflowStatefulSetMaxReplicas,
    workflowStatefulSetMaxVolumeClaimTemplates,
    workflowStatefulSetMaxPvcPreflightChecks,
    allowedCoordinatorImagePrefixes: getEnvList('WRC_ALLOWED_COORDINATOR_IMAGE_PREFIXES'),
    requireCoordinatorImageDigest: getEnvBool('WRC_REQUIRE_COORDINATOR_IMAGE_DIGEST', true),
    enableDeterministicMode: getEnvBool('WRC_ENABLE_DETERMINISTIC', true),
    governedTracingEnabled: getEnvBool('GOVERNED_TRACING_ENABLED', true),
    webhookGatewayImage: getEnv('WRC_WEBHOOK_GATEWAY_IMAGE', 'clerum/webhook-gateway:latest'),
    webhookIngressNamespace: getEnv('WRC_WEBHOOK_INGRESS_NAMESPACE', 'webhook-ingress'),
    monitoringNamespace: getEnv('WRC_MONITORING_NAMESPACE', 'monitoring'),
    controlPlaneNamespace: getEnv('WRC_CONTROL_PLANE_NAMESPACE', 'control-plane'),
    workflowDefaultRunDurationSeconds,
    workflowMaxRunDurationSeconds,
    workflowStepOutputPreviewMaxChars,
    runtimeTokenTtlSeconds,
    runtimeTokenRefreshBeforeSeconds,
    runtimeEgressDnsOverlapSeconds,
    networkPolicyEnforcementMode: getNetworkPolicyEnforcementMode(),
    networkPolicyEnforcementConfirmed: getEnvBool(
      'CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED',
      false
    ),
    workflowMaxSteps,
    workflowStepDependsOnMaxItems: getEnvBoundedInt(
      'CLERUM_WORKFLOW_STEP_DEPENDS_ON_MAX_ITEMS',
      100,
      100
    ),
    workflowStepAllowedToolsMaxItems: getEnvBoundedInt(
      'CLERUM_WORKFLOW_STEP_ALLOWED_TOOLS_MAX_ITEMS',
      50,
      100
    ),
    // This env can only lower the limit; the WorkflowRecipe CRD hard ceiling stays at 20.
    workflowStepMcpServersMaxItems: getEnvBoundedInt(
      'CLERUM_WORKFLOW_STEP_MCP_SERVERS_MAX_ITEMS',
      20,
      20
    ),
    db: {
      connectionString: process.env.POSTGRES_CONNECTION_STRING?.trim() || undefined,
      host: getEnv('POSTGRES_HOST', 'control-postgres.control-plane.svc.cluster.local'),
      port: getEnvInt('POSTGRES_PORT', 5432),
      user: getEnv('POSTGRES_USER', 'clerum'),
      password: getEnv('POSTGRES_PASSWORD', ''),
      database: getEnv('POSTGRES_DB', 'clerum'),
      ssl: getEnvBool('POSTGRES_SSL', false),
      poolMax: getEnvInt('POSTGRES_POOL_MAX', 4),
      // Unique ID per WRC replica — ends up stamped in workflow_runs.owner_instance_id.
      // HOSTNAME is the K8s pod name (stable per replica), falling back to selfName for dev.
      instanceId: getEnv('WRC_INSTANCE_ID', process.env.HOSTNAME ?? 'wrc-local'),
      // Leader lock re-probe cadence when NOT the leader.
      leaderPollMs: getEnvInt('WRC_LEADER_POLL_MS', 10_000),
      // Fallback poll for runs (in case a NOTIFY is missed across reconnects).
      runPollMs: getEnvInt('WRC_RUN_POLL_MS', 30_000),
    },
  }
}
