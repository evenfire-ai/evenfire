/**
 * Shared types for the Skill Mapper.
 */
import type { LlmProviderId } from '@clerum/llm-providers'

/**
 * McpServer transport configuration.
 */
export interface McpServerTransport {
  type: 'sse' | 'streamableHttp' | 'stdio'
  url?: string
  port?: number
}

/**
 * Reference to a key within a Kubernetes Secret.
 */
export interface McpServerSecretRef {
  name: string
  key: string
}

/**
 * OAuth broker configuration for an mcp-server (auth.type === 'oauth').
 *
 * Present iff `spec.auth.type === 'oauth'`. control-api owns the OAuth flow and
 * resolves tokens per connection just-in-time; HCC does NOT mount the token as
 * env (invariant O4 stays intact — this type only lets the controller type the
 * discriminator; the runtime token carril is mcp-host's, not HCC's).
 */
export interface McpServerOAuth {
  id: string
  // Full control-api adapter set — must mirror the mcpserver.yaml `oauth.provider`
  // enum, control-api `providers.ts` `OAuthProvider`, and workflow-recipes
  // `OAuthProvider`. U2 (spec 06) added monday/clickup/vercel.
  provider:
    | 'salesforce'
    | 'slack'
    | 'notion'
    | 'microsoft-graph'
    | 'google'
    | 'monday'
    | 'clickup'
    | 'vercel'
  clientIdRef: McpServerSecretRef
  clientSecretRef: McpServerSecretRef
  scopes?: string[]
  backgroundAccess?: boolean
  grantScope?: 'user' | 'context'
}

/**
 * McpServer authentication configuration.
 */
export interface McpServerAuth {
  type: 'none' | 'bearer' | 'basic' | 'apiKey' | 'oauth'
  secretRef?: string
  secretKey?: string
}

/**
 * A single environment variable (name/value pair).
 */
export interface McpServerEnvVar {
  name: string
  value: string
}

/**
 * Mapping from a secret key to an environment variable name.
 */
export interface McpServerSecretKeyMapping {
  secretKey: string
  envVar: string
}

/**
 * Secret-backed environment variables configuration.
 */
export interface McpServerEnvSecret {
  name: string
  keys: McpServerSecretKeyMapping[]
}

/**
 * McpServer operational configuration.
 */
export interface McpServerConfig {
  readOnly?: boolean
  loggers?: string
  telemetry?: 'enabled' | 'disabled'
}

/**
 * Maps CRD fields to env var names specific to each MCP server image.
 * The reconciler reads structured CRD fields and sets the named env vars.
 */
export interface McpServerEnvMapping {
  transport?: string
  httpHost?: string
  httpPort?: string
  healthCheckHost?: string
  healthCheckPort?: string
  readOnly?: string
  loggers?: string
  telemetry?: string
}

/**
 * McpServer health check configuration.
 */
export interface McpServerHealthCheck {
  port?: number
}

/**
 * McpServer resource requests/limits.
 */
export interface McpServerResources {
  requests?: { memory?: string; cpu?: string }
  limits?: { memory?: string; cpu?: string }
}

/**
 * External egress binding — allows an MCP server to reach an external API.
 */
export interface EgressBinding {
  egressClass?: 'exact-host' | 'public-web'
  dns?: string
  cidr?: string
  port?: number
  protocol?: 'TCP' | 'UDP'
}

/**
 * McpServer CRD spec.
 */
export interface McpServerSecurityContext {
  runAsUser?: number
  runAsGroup?: number
  fsGroup?: number
  addCapabilities?: string[]
}

export interface McpServerSpec {
  // Ownership contract:
  // - managed:true or omitted => HCC owns the runtime.
  // - managed:false => WRC owns the runtime; HCC only exposes discovery/status.
  contextRef: string
  description?: string
  image: string
  imagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never'
  // Codex P2 fix (PR #101): K8s LocalObjectReference shape, not raw strings.
  // Producers (mcpDelegation, registry install) normalize to objects at the CRD
  // write boundary so HCC consumes this directly without double-wrapping.
  imagePullSecrets?: Array<{ name: string }>
  command?: string[]
  args?: string[]
  transport: McpServerTransport
  auth?: McpServerAuth
  // OAuth broker config; present iff auth.type === 'oauth'. Typing only — HCC
  // does NOT mount the resolved token as env (O4 stays intact).
  oauth?: McpServerOAuth
  serverConfig?: McpServerConfig
  envMapping?: McpServerEnvMapping
  env?: McpServerEnvVar[]
  envSecret?: McpServerEnvSecret
  healthCheck?: McpServerHealthCheck
  resources?: McpServerResources
  security?: McpServerSecurityContext
  enabled?: boolean
  managed?: boolean
  egressBindings?: EgressBinding[]
  /** Remote MCP server config. When present, HCC creates an nginx egress proxy instead of deploying the vendor image. */
  // Codex P1 fix (PR #101): authHeaders enables forwarding credential secrets
  // as upstream Authorization/API-key headers on proxied requests. Values use
  // ${ENV_VAR} placeholders interpolated at pod startup by nginx's official
  // /etc/nginx/templates/ envsubst pattern (env vars sourced from envSecret).
  remote?: {
    baseUrl: string
    authHeaders?: Array<{ header: string; valueTemplate: string }>
  }
}

/**
 * McpServer CRD (full internal representation used by the reconciler).
 */
export interface McpServerCRD {
  name: string
  namespace: string
  uid?: string
  generation?: number
  annotations?: Record<string, string>
  labels?: Record<string, string>
  spec: McpServerSpec
  status?: McpServerCrdStatus
}

export interface McpServerCondition {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason?: string
  message?: string
  lastTransitionTime?: string
  observedGeneration?: number
}

export interface McpServerResolvedEgressIP {
  dns: string
  ips: string[]
  resolvedAt: string
}

export interface McpServerCrdStatus {
  resolvedEgressIPs?: McpServerResolvedEgressIP[]
  conditions?: McpServerCondition[]
}

// ─── SharedFileSystem CRD ──────────────────────────────────────────────────

/**
 * POSIX identity applied to the SharedFileSystem PVC by the controller's root
 * init container and inherited by the per-SFS workspace-files-controller pod.
 */
export interface SharedFileSystemSecurity {
  runAsUser?: number
  runAsGroup?: number
  fsGroup?: number
}

/**
 * SharedFileSystem CRD spec. Always lives in the mcp-host namespace.
 */
export interface SharedFileSystemSpec {
  size?: string
  storageClassName?: string
  accessModes?: string[]
  annotations?: Record<string, string>
  directories?: string[]
  security?: SharedFileSystemSecurity
  /** Default true. When false, HCC deletes the PVC when the SharedFileSystem is removed. */
  retainOnDelete?: boolean
}

export type SharedFileSystemPhase =
  | 'Provisioning'
  | 'Initializing'
  | 'Ready'
  | 'Degraded'
  | 'Failed'

export interface SharedFileSystemCondition {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason?: string
  message?: string
  lastTransitionTime?: string
}

export interface SharedFileSystemStatus {
  phase?: SharedFileSystemPhase
  pvcName?: string
  capacity?: string
  storageClassName?: string
  serviceName?: string
  mountedByContexts?: { namespace: string; name: string }[]
  conditions?: SharedFileSystemCondition[]
}

export interface SharedFileSystemCRD {
  name: string
  namespace: string
  spec: SharedFileSystemSpec
  status?: SharedFileSystemStatus
}

// ─── GlobalFileSystem CRD ────────────────────────────────────────────────────
//
// The single cluster-wide governed drive (gfs). DISTINCT from SharedFileSystem:
// gfs is one broker-mediated drive (gfsc writer + reader replicas + permission
// store) in the `gfs` namespace, NOT a per-team RO workspace. Mirrors the SFS
// CRD shape only; the semantics come from the gfs spec.

export interface GlobalFileSystemStorage {
  /** PVC requested storage, e.g. "500Gi". */
  size?: string
  /** v1: standard-rwo (RWO). RWX is a deferred escalation. */
  storageClassName?: string
  /** Defaults to ["ReadWriteOnce"] in v1. */
  accessModes?: string[]
}

export interface GlobalFileSystemLayout {
  /**
   * Absolute seed paths (e.g. "/org", "/system/published-workflow-artifacts").
   * Materialized as gfs_resources rows by control-api (the governance plane owns
   * the permission store — CC6), NOT by the reconciler/init container.
   */
  rootDirectories?: string[]
}

export interface GlobalFileSystemSecurity {
  runAsUser?: number
  fsGroup?: number
}

export interface GlobalFileSystemSpec {
  storage?: GlobalFileSystemStorage
  layout?: GlobalFileSystemLayout
  security?: GlobalFileSystemSecurity
  /** Read-only reader replicas. Default 2. The writer is always exactly 1. */
  readerReplicas?: number
  /** Default true. When false, HCC deletes the PVC when the gfs is removed. */
  retainOnDelete?: boolean
}

export type GlobalFileSystemPhase =
  | 'Provisioning'
  | 'Initializing'
  | 'Ready'
  | 'Degraded'
  | 'Failed'

export interface GlobalFileSystemCondition {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason?: string
  message?: string
  lastTransitionTime?: string
}

export interface GlobalFileSystemStatus {
  phase?: GlobalFileSystemPhase
  pvcName?: string
  serviceName?: string
  /** In-cluster base URL of the gfsc Service, e.g. http://gfsc.gfs.svc.cluster.local:8087. */
  serviceUrl?: string
  conditions?: GlobalFileSystemCondition[]
}

export interface GlobalFileSystemCRD {
  name: string
  namespace: string
  spec: GlobalFileSystemSpec
  status?: GlobalFileSystemStatus
}

// ─── Context CRD ────────────────────────────────────────────────────────────

/**
 * Reference from a Context to a SharedFileSystem. SharedFileSystems always
 * live in the mcp-host namespace in v1; the namespace field is reserved for
 * forward compat.
 */
export interface ContextSharedFileSystemRef {
  name: string
  mountPath: string
}

export type ContextSharedFileSystemPhase = 'Resolving' | 'Mounted' | 'MissingTarget' | 'Failed'

export interface ContextSharedFileSystemStatus {
  name: string
  mountPath: string
  phase: ContextSharedFileSystemPhase
  pvcName?: string
  message?: string
}

/**
 * Context CRD spec — defines which MCP servers a host can access and which
 * SharedFileSystems should be mounted RO into mcp-host pods that use it.
 */
export interface ContextSpec {
  contextId: string
  description?: string
  /** List of McpServer names accessible within this context. */
  mcpServers: string[]
  /** Optional SharedFileSystem references (multi-mount). */
  sharedFileSystems?: ContextSharedFileSystemRef[]
}

export interface ContextStatus {
  sharedFileSystems?: ContextSharedFileSystemStatus[]
}

/**
 * Context CRD.
 */
export interface ContextCRD {
  name: string
  namespace: string
  spec: ContextSpec
  status?: ContextStatus
}

// ─── Host CRD ───────────────────────────────────────────────────────────────

export interface HostModelSpec {
  provider?: LlmProviderId
  name?: string
}

export interface HostDesktopSpec {
  browser?: boolean
  x11?: boolean
}

export interface HostLifecycleSpec {
  /**
   * Enable the stateless agent lifecycle: mcp-host persists session state to
   * SQLite on the workspace PVC and HCC may scale the Deployment to 0 while
   * status.lifecycle.state is `suspended`. Default false.
   */
  stateless?: boolean
}

export type HostWorkflowControlScope =
  | 'workflow:list'
  | 'workflow:read'
  | 'workflow:trigger'
  | 'workflow:approval:resolve'
  | 'workflow:approval:decide'

export interface HostWorkflowControlSpec {
  scopes?: HostWorkflowControlScope[]
}

export interface HostSpec {
  host: string
  contextRef: string
  secretRef: string
  channels?: string[]
  model?: HostModelSpec
  approval?: Record<string, unknown>
  desktop?: HostDesktopSpec
  lifecycle?: HostLifecycleSpec
  workflowControl?: HostWorkflowControlSpec
}

export type HostLifecycleState = 'active' | 'draining' | 'suspended'

export interface HostCondition {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason?: string
  message?: string
  lastTransitionTime?: string
}

/**
 * Durable lifecycle state persisted in the Host status subresource. HCC
 * derives Deployment replicas from `state` on every reconcile, so a suspended
 * Host survives HCC restarts and periodic resyncs (the state lives in the
 * CRD, not in HCC memory).
 */
export interface HostLifecycleStatus {
  state: HostLifecycleState
  /**
   * Highest observed Host generation whose wake trigger has been handled.
   * Written by the mcp-host runtime; HCC only preserves it across writes.
   */
  wakeHandledGeneration: number
  /** Human-readable explanation when the stateless request was rejected. */
  reason?: string
}

export interface HostCrdStatus {
  lifecycle?: HostLifecycleStatus
  conditions?: HostCondition[]
}

export interface HostCRD {
  name: string
  namespace: string
  generation?: number
  /**
   * metadata.uid — the Kubernetes-assigned stable identity of THIS Host object.
   * A same-name Host deleted and recreated gets a fresh uid, so uid (not name or
   * generation) is what distinguishes a genuine deletion from a same-name
   * recreation on every destructive path (#827). Undefined for snapshots that
   * predate uid capture; identity fences treat "unknown" conservatively.
   */
  uid?: string
  /**
   * metadata.resourceVersion of the CR at the time it was read. Preserved by
   * readFreshHost so the heartbeat-path status writers can pass it back as an
   * optimistic-concurrency precondition: a stale write is rejected 409 and
   * retried against a fresh read. Undefined for watch-cache snapshots that
   * never carried it -- those writers read fresh before writing.
   */
  resourceVersion?: string
  /**
   * Host CR metadata annotations. Carries the control-api-projected
   * `clerum.io/wake-requested` monotonic wake generation consumed by the
   * HCC wake fast-path (Stage 4.3).
   */
  annotations?: Record<string, string>
  spec: HostSpec
  status?: HostCrdStatus
}

// ─── CommunicationChannel CRD ──────────────────────────────────────────────
//
// HCC only inspects `spec.hostRef` to count CCs per Host (see #281). The full
// CC schema (telegram[], email[], slack[] adapter configs) is owned by the
// per-Host channel-reader pod's own CC watch and never enters HCC's model.

export interface CommunicationChannelSpec {
  hostRef: string
  credentialsSecretRef?: { name: string }
}

export interface CommunicationChannelCRD {
  name: string
  namespace: string
  spec: CommunicationChannelSpec
}

export interface HostChannelReaderStatus {
  /** True when the host has ≥1 CommunicationChannel. */
  expected: boolean
  /** True when the channel-reader Deployment exists and has ≥1 ready replica. */
  ready: boolean
  /** Human-readable status message for the channel-reader component. */
  message?: string
}

export interface HostRuntimeStatus {
  deployed: boolean
  ready: boolean
  message?: string
  /** Readiness status of the per-Host channel-reader Deployment. Populated best-effort; absent until the first reconcile that reaches the channel-reader step. */
  channelReader?: HostChannelReaderStatus
}

// ─── API Response Types ─────────────────────────────────────────────────────
// These types represent what the skill-mapper returns to consumers (mcp-host).
// They intentionally strip deployment internals (image, envMapping, envSecret,
// resources, healthCheck, serverConfig) and add operator-known status info.

/**
 * Deployment status of an MCP server, known only by the skill-mapper operator.
 */
export interface McpServerStatus {
  /** Whether the Deployment resource exists in the cluster. */
  deployed: boolean
  /** Whether the Deployment has at least one ready replica. */
  ready: boolean
  /** Human-readable status message. */
  message?: string
}

/**
 * Curated MCP server info for API consumers (mcp-host).
 * Contains only what a client needs to connect to the server,
 * plus deployment status that only the operator knows.
 */
export interface McpServerInfo {
  name: string
  description?: string
  contextRef: string
  transport: McpServerTransport
  auth?: McpServerAuth
  enabled: boolean
  status: McpServerStatus
}

/**
 * API response for listing McpServers.
 */
export interface McpServersResponse {
  servers: McpServerInfo[]
  contextRef: string
  timestamp: string
}

/**
 * API error response.
 */
export interface ErrorResponse {
  error: string
  message: string
}
