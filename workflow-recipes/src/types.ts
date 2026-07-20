import type { LlmProviderId } from '@clerum/llm-providers'

// ─── WorkflowRecipe Phase (13-state machine) ────────────────────────────

/**
 * All 13 phases in the WorkflowRecipe lifecycle.
 * Source of truth: WORKLOADRECIPE-SPEC.md §12.1
 *
 * Terminal states: "deprecated", "rollback-failed"
 */
export type RecipePhase =
  | 'candidate'
  | 'pending-approval'
  | 'approved'
  | 'pending'
  | 'pending-operator-input'
  | 'deploying'
  | 'testing'
  | 'active'
  | 'degraded'
  | 'rolling-back'
  | 'failed'
  | 'deprecated'
  | 'rollback-failed'

/** Type guard for RecipePhase */
export function isRecipePhase(value: string): value is RecipePhase {
  const phases: RecipePhase[] = [
    'candidate',
    'pending-approval',
    'approved',
    'pending',
    'pending-operator-input',
    'deploying',
    'testing',
    'active',
    'degraded',
    'rolling-back',
    'failed',
    'deprecated',
    'rollback-failed',
  ]
  return phases.includes(value as RecipePhase)
}

// ─── Workload Types ─────────────────────────────────────────────────────

/**
 * Supported workload types.
 * Source of truth: WORKLOADRECIPE-SPEC.md §3.1
 */
export type WorkloadType = 'deployment' | 'statefulset' | 'cronjob' | 'job' | 'daemonset'

/** Type guard for WorkloadType */
export function isWorkloadType(value: string): value is WorkloadType {
  return ['deployment', 'statefulset', 'cronjob', 'job', 'daemonset'].includes(value)
}

// ─── Resource Types ─────────────────────────────────────────────────────

export type ResourceType = 'pvc' | 'secret' | 'configmap'

// ─── Security ───────────────────────────────────────────────────────────

/**
 * Security isolation levels.
 * Source of truth: WORKLOADRECIPE-SPEC.md §8
 */
export type SecurityIsolationLevel = 'minimal' | 'standard' | 'strict'

/**
 * Per-workload security overrides.
 * Allows specific workloads to run as a non-root UID while maintaining
 * the recipe-level isolation model.
 * Source of truth: GAP 15 (PHASE-9-PRE-PRODUCTION-HARDENING.md)
 */
export interface WorkloadSecurityOverrides {
  runAsUser?: number
  runAsGroup?: number
  fsGroup?: number
  addCapabilities?: string[]
  /** Opt-in root init container for non-distroless images and storage backends that do not honor fsGroup. */
  prepareVolumeOwnership?: boolean
}

// ─── Secret-Backed Environment Variables ─────────────────────────────────

/**
 * Mapping from a Secret key to an environment variable name.
 * Source of truth: WORKLOADRECIPE-SPEC.md §3.4.1
 */
export interface EnvSecretMapping {
  secretKey: string
  envVar: string
  optional?: boolean
}

/**
 * Batch secret mapping configuration.
 * References a Kubernetes Secret and maps multiple keys to environment variables.
 * Source of truth: WORKLOADRECIPE-SPEC.md §3.4.1
 */
export interface EnvSecretConfig {
  name: string
  keys: EnvSecretMapping[]
}

// ─── Workload Definitions (Discriminated Union) ─────────────────────────

export interface BaseWorkloadDef {
  id: string
  type: WorkloadType
  image: string
  imagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never'
  port?: number
  replicas?: number
  command?: string[]
  args?: string[]
  env?: Array<{ name: string; value?: string; valueFrom?: unknown }>
  envSecret?: EnvSecretConfig
  volumeMounts?: VolumeMount[]
  resources?: ResourceRequirements
  healthCheck?: HealthCheck
  dependsOn?: string[]
  includeWhen?: string
  transport?: TransportConfig
  egressBindings?: EgressBindingDef[]
  ownerReferences?: false // Set to false to skip ownerReferences (e.g., for cross-namespace resources)
  imagePullSecrets?: string[] // Docker registry secrets for private images
  security?: WorkloadSecurityOverrides // Per-workload security overrides (GAP 15)
  /**
   * Path B — oauthClient ids (from spec.oauthClients[], must be backgroundAccess)
   * this workload uses. Opting in mounts the recipe OAuth broker token and
   * grants egress to the control-api broker route. Spec §9.2.
   */
  oauthClientRefs?: string[]
}

export interface DeploymentDef extends BaseWorkloadDef {
  type: 'deployment'
}

export interface StatefulSetDef extends BaseWorkloadDef {
  type: 'statefulset'
  serviceName?: string
  volumeClaimTemplates?: VolumeClaimTemplate[]
}

export interface CronJobDef extends BaseWorkloadDef {
  type: 'cronjob'
  schedule: string
  timeZone?: string
}

export interface JobDef extends BaseWorkloadDef {
  type: 'job'
  backoffLimit?: number
}

export interface DaemonSetDef extends BaseWorkloadDef {
  type: 'daemonset'
}

export type WorkloadDef = DeploymentDef | StatefulSetDef | CronJobDef | JobDef | DaemonSetDef

// ─── Resource Definitions (Discriminated Union) ─────────────────────────

export interface PvcResourceDef {
  id: string
  type: 'pvc'
  storageClass?: string
  size: string
  accessMode?: string
}

export interface SecretResourceDef {
  id: string
  type: 'secret'
  data?: Record<string, string>
  generateKeys?: string[]
}

export interface ConfigMapResourceDef {
  id: string
  type: 'configmap'
  data: Record<string, string>
}

export type ResourceDef = PvcResourceDef | SecretResourceDef | ConfigMapResourceDef

// ─── Binding Definition ─────────────────────────────────────────────────

export interface BindingDef {
  from: string
  to: string
  port: number
  protocol?: 'TCP' | 'UDP'
}

// ─── Egress Binding Definition ──────────────────────────────────────────

export interface EgressBindingDef {
  egressClass?: 'exact-host' | 'public-web'
  dns?: string
  port?: number
  protocol?: 'TCP' | 'UDP'
}

// ─── Supporting Types ───────────────────────────────────────────────────

export interface TransportConfig {
  type: 'sse' | 'streamableHttp' | 'stdio'
  path?: string
}

export interface VolumeMount {
  name: string
  mountPath: string
  subPath?: string
  readOnly?: boolean
}

/**
 * VolumeClaimTemplate for StatefulSet workloads.
 * Defines PVC templates that are created per replica.
 * Source: Kubernetes StatefulSet volumeClaimTemplates
 */
export interface VolumeClaimTemplate {
  name: string
  storageClass: string
  accessMode: 'ReadWriteOnce' | 'ReadWriteMany' | 'ReadOnlyMany'
  size: string
}

export interface ResourceRequirements {
  requests?: { cpu?: string; memory?: string }
  limits?: { cpu?: string; memory?: string }
}

export interface HealthCheck {
  type: 'http' | 'tcp' | 'exec'
  path?: string
  port?: number
  command?: string[]
  initialDelaySeconds?: number
  periodSeconds?: number
  timeoutSeconds?: number
  failureThreshold?: number
}

export interface ComputedValue {
  name: string
  expression: string
}

export interface RecipeDependency {
  name: string
  namespace?: string
  cascadeRollback?: boolean
  maxWaitMinutes?: number
}

// ─── Webhooks (W1.1) ────────────────────────────────────────────────────

/**
 * Signature-verification scheme for an inbound webhook request.
 * One per webhook entry. Spec §7.
 */
export type WebhookVerificationScheme =
  | 'hmac-sha256-body'
  | 'hmac-sha256-timestamp-body'
  | 'jwt-bearer-jwks'
  | 'static-bearer'

/** Type guard for WebhookVerificationScheme. */
export function isWebhookVerificationScheme(value: string): value is WebhookVerificationScheme {
  return [
    'hmac-sha256-body',
    'hmac-sha256-timestamp-body',
    'jwt-bearer-jwks',
    'static-bearer',
  ].includes(value)
}

/** Reference to a Secret in the recipe's sandbox-recipes namespace. */
export interface WebhookSecretRef {
  name: string
  key: string
}

/**
 * Verification configuration. Field requirements are scheme-dependent
 * (W7/W9) and enforced by the CRD CEL rules at admission and again by
 * the WRC reconciler at reconcile time. The TypeScript shape uses
 * optionals because the CRD does — we don't pre-narrow here.
 */
export interface WebhookVerification {
  scheme: WebhookVerificationScheme
  secretRef?: WebhookSecretRef
  signatureHeader?: string
  signaturePrefix?: string
  signatureEncoding?: 'hex' | 'base64'
  /**
   * static-bearer only — HTTP header name to read the token from.
   * Defaults to `Authorization` when omitted. Custom headers
   * (e.g. `X-Telegram-Bot-Api-Secret-Token`) let providers that
   * authenticate via a non-Authorization header fit the scheme.
   */
  tokenHeader?: string
  /**
   * static-bearer only — string to strip from the front of the header
   * value before constant-time comparison. Defaults to `Bearer `
   * (with trailing space). Author-supplied empty string means "no
   * prefix" — the entire header value IS the token (Telegram style).
   */
  tokenPrefix?: string
  jwksUrl?: string
  issuer?: string
  audience?: string
  setupHandshake?: WebhookSetupHandshake
}

/**
 * Known-shape setup-handshake strategies. Each strategy has an exact request
 * shape that bypasses body-signature verification; anything else falls through
 * to the normal verifier. See spec §7.5.
 */
export type WebhookSetupHandshakeStrategy =
  | 'meta-hub-challenge'
  | 'slack-url-verification'
  | 'stripe-verify'

/** Type guard for WebhookSetupHandshakeStrategy. */
export function isWebhookSetupHandshakeStrategy(
  value: string
): value is WebhookSetupHandshakeStrategy {
  return ['meta-hub-challenge', 'slack-url-verification', 'stripe-verify'].includes(value)
}

/**
 * Setup-handshake config (opt-in per webhook). The strategy's matching request
 * shape is the only path that bypasses body-signature verification. Some
 * strategies (currently `meta-hub-challenge`) carry their own credential via
 * `secretRef` — the strategy's verify-token equivalent.
 */
export interface WebhookSetupHandshake {
  strategy: WebhookSetupHandshakeStrategy
  secretRef?: WebhookSecretRef
}

/** Replay-window config; required iff scheme is `hmac-sha256-timestamp-body` (W8). */
export interface WebhookReplay {
  timestampHeader: string
  toleranceSec: number
}

/**
 * Browser CORS policy for a webhook. Consumed by the front-door
 * webhook-proxy via control-api's registry endpoint; the per-recipe
 * gateway never sees this — CORS is enforced before forwarding.
 */
export interface WebhookCors {
  /** Exact origin strings (scheme + host + optional port, no trailing slash). */
  allowedOrigins?: string[]
}

/** A single webhook entry under `spec.webhooks[]`. */
export interface WebhookDef {
  id: string
  workloadRef: string
  path: string
  methods?: Array<'POST' | 'GET'>
  maxBodyBytes?: number
  verification: WebhookVerification
  replay?: WebhookReplay
  /**
   * When true, a missing or empty secretRef does NOT mark the recipe
   * degraded. The webhook is kept dormant by the gateway (responds with
   * 410 Gone + X-Clerum-Webhook-State: dormant) until the Secret/key is
   * created; the Secret watcher then triggers a reconcile that transitions
   * the entry to active. Default false (today's fail-closed behavior).
   */
  optional?: boolean
  cors?: WebhookCors
}

// ─── Sandbox UI ─────────────────────────────────────────────────────────

export interface SandboxUiInternalEgress {
  workloadRef: string
  port: number
}

/**
 * External egress entry — a DNS hostname (FQDN) which the WRC reconciler
 * resolves to one or more ipBlock rules at reconcile time and re-resolves
 * on a periodic tick. Static CIDR is intentionally not accepted: raw IPs
 * are unreviewable in PRs, freeze across vendor IP rotations, and can
 * silently authorize cloud-metadata or sibling-tenant ranges that the
 * RFC1918 carve-out doesn't trim (e.g. 169.254/16).
 */
export interface SandboxUiExternalEgress {
  fqdn: string
  port: number
  reason?: string
}

export interface SandboxUiEgress {
  internal?: SandboxUiInternalEgress[]
  external?: SandboxUiExternalEgress[]
}

export interface SandboxUiSpec {
  workloadRef: string
  port: number
  title?: string
  icon?: string
  defaultPath?: string
  egress?: SandboxUiEgress
}

// ─── Recipe OAuth (spec.oauthClients[]) ────────────────────────────────
// Two consumer shapes: the sandbox UI embed (foreground end-user OAuth) and
// background Path B workloads (backgroundAccess: true, referenced from
// workloads[].oauthClientRefs on non-MCP workloads). Either consumer alone is
// enough to justify an oauthClient — spec.ui is not required.

/**
 * Known-shape OAuth provider adapters baked into control-api. Adding a
 * provider is a control-api change — recipes cannot speak OAuth to
 * arbitrary endpoints. Spec §9.9 / Decision 20.
 */
export type OAuthProvider = 'salesforce' | 'slack' | 'notion' | 'microsoft-graph' | 'google'

export function isOAuthProvider(value: string): value is OAuthProvider {
  return ['salesforce', 'slack', 'notion', 'microsoft-graph', 'google'].includes(value)
}

/** Reference to a Secret in the recipe's sandbox-recipes namespace. */
export interface OAuthSecretRef {
  name: string
  key: string
}

/**
 * One OAuth provider the recipe needs to act-on-behalf-of the user. Tokens
 * are minted by control-api after the user completes the auth-code flow on
 * the platform-rooted callback URL, then delivered into the embed via the
 * `embed.onOauthCompleted` IPC. Refresh tokens stay platform-side; access
 * tokens are fetched at request time via the `/sandbox-ui/oauth/token`
 * helper.
 */
export interface OAuthClientDef {
  id: string
  provider: OAuthProvider
  clientIdRef: OAuthSecretRef
  clientSecretRef: OAuthSecretRef
  scopes?: string[]
  /**
   * When true, an operator may connect this client as a recipe-owned `service`
   * grant so background workloads can obtain provider tokens via the broker.
   * Path B, spec §7.
   */
  backgroundAccess?: boolean
}

// ─── Plugin Workload SDK ────────────────────────────────────────────────

/**
 * Capability declaration for the Plugin Workload SDK (spec §9, §13).
 * Recipes opt plugin workloads into two controlled side-effect channels:
 *
 *   - promptBridge: one-shot LLM call routed through the recipe's mcp-host.
 *   - clientNotifications: notification intent authorized by control-api,
 *     delivered by the Notification Service.
 *
 * The reconciler validates this block (see pluginWorkloadSdkValidator.ts)
 * and persists the validated capability to status.pluginWorkloadSdk so
 * control-api can read it at runtime. Wildcard `*` entries are rejected at
 * the CRD level — only explicit admin grants may use wildcards.
 */
export interface PluginWorkloadSdkSpec {
  promptBridge?: {
    allowedModels?: string[]
    maxOutputTokens?: number
    maxRequestsPerRun?: number
    /** Max total bytes across messages[].content. */
    maxRequestContentBytes?: number
    /** Max parallel promptBridge calls per workload; default 5. */
    maxConcurrentInvocations?: number
    /** Rate limit per workload; default 60. */
    maxInvocationsPerMinute?: number
    /** How long invocation results are queryable; default 24. */
    resultRetentionHours?: number
    /** Max attachments per request; default 0 (v1: no attachments). */
    maxAttachments?: number
    /** Max total bytes across attachments; default 0. */
    maxAttachmentBytes?: number
  }
  clientNotifications?: {
    allowedEventTypes: string[]
    allowedTargetRefs?: string[]
    allowedUserRefs?: boolean
    maxNotificationsPerRun?: number
    /** Rate limit per workload; default 120. */
    maxNotificationsPerMinute?: number
    /** Default 256. */
    maxTitleBytes?: number
    /** Default 4096. */
    maxBodyBytes?: number
    /** How long notification records are queryable; default 72. */
    resultRetentionHours?: number
  }
  /** Workload ids permitted to call; empty = all declared workloads. */
  allowedCallers?: string[]
  /** Regex for idempotency key format validation; default '^[a-zA-Z0-9_-]{1,128}$'. */
  idempotencyKeyPattern?: string
}

/** Snippet-scoped subset of the SDK capability (steps[].run.capabilities). */
export interface PluginWorkloadSdkSnippetConfig {
  promptBridge?: {
    allowedModels?: string[]
    maxOutputTokens?: number
  }
  clientNotifications?: {
    allowedEventTypes: string[]
    allowedTargetRefs?: string[]
    allowedUserRefs?: boolean
  }
}

/**
 * Validated capability projection persisted to status.pluginWorkloadSdk.
 * control-api reads this at runtime to know which SDK families a recipe
 * actually has active (vs merely declared in spec).
 */
export interface PluginWorkloadSdkCapabilityStatus {
  state: 'validated' | 'disabled'
  promptBridge: boolean
  clientNotifications: boolean
  message?: string
  validatedAt?: string
}

// ─── WorkflowRecipe CRD ─────────────────────────────────────────────────

export type WorkflowRecipeGfsScope =
  | 'gfs.read'
  | 'gfs.write'
  | 'gfs.delete'
  | 'gfs.manage_acl'
  | 'gfs.share'

export interface WorkflowRecipeGfsIntentSpec {
  publishTargets?: Array<{ drive: string; target: string }>
  mounts?: Array<{ drive: string; target: string; scopes: WorkflowRecipeGfsScope[] }>
}

export interface WorkflowRecipeSpec {
  description?: string
  contextRef?: string
  workloads?: WorkloadDef[]
  webhooks?: WebhookDef[]
  resources?: ResourceDef[]
  bindings?: BindingDef[]
  inputs?: Record<string, unknown>
  inputContract?: Record<string, unknown>
  activeProfile?: string
  profiles?: Record<string, Record<string, unknown>>
  computed?: ComputedValue[]
  security?: {
    isolationLevel?: SecurityIsolationLevel
  }
  runtimeEgress?: WorkflowRuntimeEgressSpec
  dependencies?: RecipeDependency[]
  dryRun?: boolean
  ui?: SandboxUiSpec
  oauthClients?: OAuthClientDef[]
  pluginWorkloadSdk?: PluginWorkloadSdkSpec
  gfs?: WorkflowRecipeGfsIntentSpec

  // ─── Workflow Fields (Stage 1) ─────────────────────────────────────
  coordinatorImage?: string
  agent?: {
    model: string
    provider: LlmProviderId
    secretRef?: { name: string; namespace?: string }
    soulRef?: {
      storageRef: {
        bucket: string
        key: string
        provider?: 's3' | 'gcs' | 'spaces' | 'minio'
        region?: string
        endpoint?: string
      }
    }
  }
  steps?: Array<{
    id: string
    instruction?: string
    run?: WorkflowSnippetRunSpec
    dependsOn?: string[]
    timeoutSeconds?: number
    backoffSeconds?: number
    maxRetries?: number
    agent?: {
      model?: string
      provider?: LlmProviderId
      soul?: string
    }
    mcpServers?: string[]
    allowedTools?: { include?: string[] }
    toolChoice?: 'auto' | 'none' | 'required'
    maxIterations?: number
    requiresApproval?: {
      target: { userId?: string; teamId?: string }
      message: string
      timeoutSeconds?: number
    }
  }>
  mcpServers?: Array<{
    id: string
    endpoint: string
    transport?: 'http' | 'stdio'
  }>
  output?: {
    destination?: 'configmap' | 'secret' | 'stdout' | 'pvc'
    name?: string
    namespace?: string
    claimName?: string
    format?: 'pdf' | 'xlsx' | 'json' | 'text' | 'html' | 'multi'
    storageSize?: string
  }

  // ─── Scheduling Fields (Stage 4 / legacy) ─────────────────────────
  scheduling?: {
    cron: string
    timezone?: string
    concurrencyPolicy?: 'Forbid' | 'Replace' | 'Allow'
    successfulHistoryLimit?: number
    failedHistoryLimit?: number
    suspend?: boolean
  }
  runRetention?: {
    maxRunDurationSeconds?: number
    ttlSecondsAfterFinished?: number
    successfulHistoryLimit?: number
    failedHistoryLimit?: number
  }

  // ─── Triggers (Phase 5 — DB-first) ────────────────────────────────
  // Plan §Fase 5: WRC reads spec.triggers.schedule and keeps the row
  // in workflow_schedules in sync. Both shapes coexist in the CRD
  // schema (R5–R8); reconciler prefers triggers.schedule, falls back
  // to legacy spec.scheduling.
  triggers?: {
    onDemand?: {
      allowedActors?: Array<'user' | 'autonomous' | 'scheduled'>
    }
    schedule?: {
      cron: string
      timezone?: string
      suspend?: boolean
    }
  }
}

export interface WorkflowSnippetRunSpec {
  type: 'snippet'
  language: 'typescript'
  code: string
  capabilities?: WorkflowSnippetCapabilities
}

export interface WorkflowRuntimeEgressSpec {
  http?: {
    egressClass?: 'exact-host' | 'public-web'
    allowedHosts?: string[]
  }
}

export interface WorkflowSnippetCapabilities {
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
  pluginWorkloadSdk?: PluginWorkloadSdkSnippetConfig
}

export interface WorkloadStatus {
  id: string
  type: WorkloadType
  phase: string
  message?: string
  ready?: boolean
}

export interface WorkflowRecipeStatus {
  phase: RecipePhase
  message?: string
  lastTransitionTime?: string
  workloads?: WorkloadStatus[]
  conditions?: StatusCondition[]

  // ─── Workload Instance Mapping (UUID naming) ────────────────────────
  /** Mapping of workload ID → K8s resource name (UUID-based). Persisted on first deploy. */
  workloadInstances?: Record<string, string>

  // ─── Resource Instance Mapping (UUID naming) ────────────────────────
  /**
   * Mapping of spec.resources[] ID (PVC/Secret/ConfigMap) → recipe-scoped K8s
   * resource name. Persisted on first deploy, mirroring workloadInstances, so
   * generic resource ids (e.g. "data", "credentials") cannot collide across
   * recipes in a shared namespace. See issue #571.
   */
  resourceInstances?: Record<string, string>

  // ─── Plugin Workload SDK ────────────────────────────────────────────
  /** Validated SDK capability projection — read by control-api at runtime. */
  pluginWorkloadSdk?: PluginWorkloadSdkCapabilityStatus

  // ─── Workflow Status (Stage 1) ─────────────────────────────────────
  workflowExecution?: {
    phase: string
    startedAt?: string
    completedAt?: string
    currentStep?: string
    attempt?: number
    message?: string
  }
  steps?: Array<{
    id: string
    phase: string
    startedAt?: string
    completedAt?: string
    output?: string
    error?: string
    executor?: 'agentic' | 'snippet' | 'custom'
    modelUsed?: string
    approvalBindingSha256?: string
    toolsCalled?: Array<{
      serverName: string
      toolName: string
      args?: Record<string, unknown>
      result?: unknown
      durationMs?: number
    }>
    toolsCalledTruncated?: boolean
  }>
}

export interface StatusCondition {
  type: string
  status: 'True' | 'False' | 'Unknown'
  lastTransitionTime: string
  reason?: string
  message?: string
}

export interface WorkflowRecipeCRD {
  apiVersion: 'clerum.io/v1alpha1'
  kind: 'WorkflowRecipe'
  metadata: {
    name: string
    namespace: string
    uid?: string
    resourceVersion?: string
    generation?: number
    creationTimestamp?: string
    annotations?: Record<string, string>
    labels?: Record<string, string>
    finalizers?: string[]
    deletionTimestamp?: string
    ownerReferences?: Array<{
      apiVersion?: string
      kind?: string
      name?: string
      uid?: string
      controller?: boolean
      blockOwnerDeletion?: boolean
    }>
  }
  spec: WorkflowRecipeSpec
  status?: WorkflowRecipeStatus
}

// ─── WorkflowRecipePolicy CRD (Phase 7) ────────────────────────────────

export interface WorkflowRecipePolicySpec {
  description?: string
  governance?: {
    requireApproval?: boolean
    maxWorkloadsPerRecipe?: number
    maxReplicasPerWorkload?: number
    allowedWorkloadTypes?: WorkloadType[]
    requiredSecurityLevel?: SecurityIsolationLevel
  }
  detection?: {
    enabled?: boolean
    scanOnDeploy?: boolean
    imageAllowlist?: string[]
    imageDenylist?: string[]
    allowedStorageClasses?: string[]
    maxResourceLimits?: { cpu?: string; memory?: string }
  }
  publication?: {
    registry?: string
    autoPublish?: boolean
    registries?: Array<{
      name: string
      url: string
      type: 'public' | 'private'
      ociBackend?: 'docr' | 'ghcr' | 'generic-oci'
      default?: boolean
      credentialsSecret?: string
    }>
  }
  deployment?: {
    autoPromoteAfterSeconds?: number
    rollbackOnFailure?: boolean
    maxConcurrentDeploys?: number
  }
  notification?: {
    channels?: string[]
    events?: ('deploy' | 'rollback' | 'failed' | 'deprecated')[]
  }
  deprecation?: {
    gracePeriodDays?: number
    autoDeprecateInactiveDays?: number
  }
}

export interface WorkflowRecipePolicyCRD {
  apiVersion: 'clerum.io/v1alpha1'
  kind: 'WorkflowRecipePolicy'
  metadata: {
    name: string
    namespace: string
  }
  spec: WorkflowRecipePolicySpec
}
