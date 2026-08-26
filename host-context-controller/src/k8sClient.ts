/**
 * Kubernetes client for watching McpServer CRDs.
 * Also provides a dev mode provider for local testing.
 *
 * In production, the McpServerWatcher:
 *  1. Watches McpServer CRDs for changes
 *  2. Maintains an in-memory cache for the REST API
 *  3. Triggers the reconciler to create/update/delete Deployments + Services
 */
import * as k8s from '@kubernetes/client-node'
import {
  type AdministrativeOutcomeReporter,
  createAdministrativeOutcomeReporter,
} from './administrativeOutcomeReporter'
import { BindingDef, BindingPolicyReconciler } from './bindingPolicyReconciler'
import { config } from './config'
import {
  ExternalEgressConvergenceCoordinator,
  type ExternalEgressRetryHandle,
  type ExternalEgressWatchEventType,
} from './externalEgressConvergenceCoordinator'
import { gfsDefaultFactoryConfig } from './gfsConfig'
import { GfsReconciler } from './gfsReconciler'
import { ControlApiGfsSeedClient } from './gfsSeedClient'
import {
  type HostFleetReconcileMode,
  type HostFleetReconcileRequest,
  HostFleetScheduler,
} from './hostFleetScheduler'
import {
  HostFleetReconcileError,
  type HostReconcileSource,
  HostReconciler,
  type ResolvedSfsMount,
} from './hostReconciler'
import {
  type InfrastructureTelemetryReporter,
  createInfrastructureTelemetryReporter,
} from './infrastructureTelemetryReporter'
import { K8sGfsApi } from './k8s/gfsK8sApi'
import { makeHostK8sApiClient } from './k8s/hostK8sApiClient'
import { pvcName as sfsPvcName } from './k8s/sharedFileSystemFactory'
import { LlmHookReconciler, computePodKey, referencedHookIds } from './llmHookReconciler'
import type {
  AuthorityContext,
  AuthorityHost,
  AuthorityMcpServer,
  AuthoritySecret,
  AuthoritySecretMetadata,
  McpAuthorizationStore,
} from './mcpAuthorization'
import {
  confirmAuthoritativeMcpServerAbsence,
  isMcpServerStatusOnlyUpdate,
  sameMcpServerDesiredRevision,
} from './mcpServerSafety'
import {
  hostDeleteCleanupTotal,
  hostFleetRequestsTotal,
  hostWatchRecoverySeconds,
  initialConvergenceEffectsDroppedTotal,
  initialConvergenceLastSuccessTimestampSeconds,
  initialConvergencePassDurationSeconds,
  initialConvergencePassResultsTotal,
  initialConvergenceRetriesTotal,
  initialConvergenceSwallowedTotal,
} from './metrics'
import {
  DESIRED_NETWORKPOLICY_INVENTORY_CHANGED_MESSAGE,
  NetworkPolicyReconciler,
  sameContextDesiredRevision,
} from './networkPolicyReconciler'
import type { ReadinessInventoryDetail } from './readinessGate'
import { McpServerReconciler } from './reconciler'
import { SharedFileSystemReconciler } from './sharedFileSystemReconciler'
import {
  CommunicationChannelCRD,
  ContextCRD,
  ContextSpec,
  GlobalFileSystemCRD,
  GlobalFileSystemSpec,
  HostCRD,
  HostSpec,
  LlmHookCRD,
  LlmHookSpec,
  McpServerCRD,
  McpServerInfo,
  McpServerSpec,
  SharedFileSystemCRD,
  SharedFileSystemSpec,
} from './types'
import { getErrorCode } from './utils'

// Only initialize K8s client if not in dev mode
let customObjectsApi: k8s.CustomObjectsApi | null = null
let hostCustomObjectsApi: k8s.CustomObjectsApi | null = null
let coreApi: k8s.CoreV1Api | null = null
let kc: k8s.KubeConfig | null = null

if (!config.devMode) {
  kc = new k8s.KubeConfig()
  kc.loadFromDefault()
  customObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi)
  hostCustomObjectsApi = makeHostK8sApiClient(
    kc,
    k8s.CustomObjectsApi,
    config.hostK8sRequestTimeoutMs
  )
  coreApi = kc.makeApiClient(k8s.CoreV1Api)
}

/**
 * Return the shared KubeConfig used by production clients (null in dev mode).
 * Exposed so auxiliary watchers (e.g. SecretInformer) can reuse the same config.
 */
export function getKubeConfig(): k8s.KubeConfig | null {
  return kc
}

const GROUP = 'clerum.io'
const VERSION = 'v1alpha1'
const PLURAL_MCPSERVERS = 'mcpservers'
const PLURAL_CONTEXTS = 'contexts'
const PLURAL_HOSTS = 'hosts'
const PLURAL_SHAREDFILESYSTEMS = 'sharedfilesystems'
const PLURAL_GLOBALFILESYSTEMS = 'globalfilesystems'
const PLURAL_COMMUNICATIONCHANNELS = 'communicationchannels'
const PLURAL_LLMHOOKS = 'llmhooks'
// Before readiness was decoupled, a failed initial McpServer or NetworkPolicy
// sweep made provider.start() fail and Kubernetes restarted HCC. These retries
// retain that convergence guarantee now that the sweeps run in the background.
const INITIAL_CONVERGENCE_RETRY_DELAYS_MS = [5000, 15000, 30000, 60000, 300000]

const COMMUNICATION_CHANNEL_CACHE_RECOVERY_RETRY_MS = 5000
// Retry-after-failure pacing for the three hardened inventory lanes
// (McpServer/Context/Host) is exponential with full jitter, mirroring the
// client-go reflector standard. During a long apiserver outage (a GKE zonal
// control-plane upgrade: minutes of every watch down and every re-LIST
// failing) a fixed interval hammers the recovering apiserver, and — worse —
// the HCC's ~3-6 streams synchronize after a simultaneous cut and hit it in
// phase. delay = min(BASE * 2^(failures-1), CAP), then FULL jitter
// (random() * delay; AWS-style full jitter maximizes de-correlation across
// the streams, which is exactly the goal) floored at MIN so jitter can never
// reintroduce a 0-delay busy-loop. A successful recovery resets the ladder.
const WATCH_RECOVERY_BACKOFF_BASE_MS = 1000
const WATCH_RECOVERY_BACKOFF_CAP_MS = 30000
const WATCH_RECOVERY_BACKOFF_MIN_MS = WATCH_RECOVERY_BACKOFF_BASE_MS / 2
// Anti-busy-loop floor for IMMEDIATE watch-close recovery. The first re-LIST
// after an isolated watch close runs immediately (sub-second readiness blip
// instead of the old fixed ~5.5s), but a close arriving within this floor of
// the last successful recovery is demoted onto the paced retry timer above so
// a degraded apiserver churning its watches is never hammered with
// back-to-back LISTs.
const WATCH_CLOSE_RECOVERY_FLOOR_MS = 1000
const HOST_WATCH_RECONCILE_RETRY_DELAYS_MS = [5000, 15000, 30000]
// Wake-pending Hosts get immediate per-Host admission after watch recovery
// (§10.2 step 7) rather than waiting for the background fleet pass.
const WAKE_REQUESTED_ANNOTATION = 'clerum.io/wake-requested'

/**
 * Next retry-after-failure delay for a hardened inventory lane. `retryAfterMs`
 * (from an HTTP 429 Retry-After, i.e. GKE API Priority & Fairness telling us
 * exactly when to come back) overrides the computed backoff, clamped into
 * [MIN, CAP] so a throttled lane can neither busy-loop nor stall for an hour
 * on a pathological header while readiness is failing closed.
 */
function computeWatchRecoveryRetryDelayMs(
  consecutiveFailures: number,
  retryAfterMs?: number
): number {
  if (retryAfterMs !== undefined) {
    return Math.min(
      Math.max(retryAfterMs, WATCH_RECOVERY_BACKOFF_MIN_MS),
      WATCH_RECOVERY_BACKOFF_CAP_MS
    )
  }
  const attempt = Math.max(1, consecutiveFailures)
  const computed = Math.min(
    WATCH_RECOVERY_BACKOFF_BASE_MS * 2 ** (attempt - 1),
    WATCH_RECOVERY_BACKOFF_CAP_MS
  )
  return Math.max(WATCH_RECOVERY_BACKOFF_MIN_MS, Math.random() * computed)
}

/**
 * Extract Retry-After (milliseconds) from an HTTP 429 error. The
 * @kubernetes/client-node ApiException carries the response headers as a
 * plain string map; header-name casing is transport-dependent, so the lookup
 * is case-insensitive. Only the delta-seconds form is honored — the HTTP-date
 * form is not parsed (APF emits delta-seconds; a date would need clock-skew
 * handling for marginal value) and falls through to the computed backoff.
 */
function getRetryAfterMs(error: unknown): number | undefined {
  if (getErrorCode(error) !== 429) return undefined
  const headers = (error as { headers?: unknown }).headers
  if (headers === null || typeof headers !== 'object') return undefined
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'retry-after') continue
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    return undefined
  }
  return undefined
}

type CommunicationChannelSnapshot = {
  channels: CommunicationChannelCRD[]
  resourceVersion?: string
}

type McpServerSnapshot = {
  servers: McpServerCRD[]
  resourceVersion?: string
}

type ContextSnapshot = {
  contexts: ContextCRD[]
  resourceVersion?: string
}

type HostSnapshot = {
  hosts: HostCRD[]
  resourceVersion?: string
}

type HostInventoryRecoveryCause = 'cold-start' | 'watch-recovery'
type HostWatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED'
type InitialConvergenceLane = 'McpServer' | 'NetworkPolicy'
type InitialConvergencePassResult =
  | 'certified'
  | 'aborted-authority'
  | 'deferred-unsynced'
  | 'aborted-bump'
  | 'failed'

function observeInitialNetworkPolicyPass(
  startedAtMs: number,
  result: InitialConvergencePassResult
): void {
  const seconds = Math.max(0, (Date.now() - startedAtMs) / 1000)
  initialConvergencePassResultsTotal.inc({ lane: 'NetworkPolicy', result })
  initialConvergencePassDurationSeconds.observe({ lane: 'NetworkPolicy', result }, seconds)
}

type NetworkPolicySafetyCertificate = {
  // VESTIGIAL — retained for record shape only, never read in any decision.
  // The certificate is identified SOLELY by content revision (the PR #382 fix);
  // the generation fields survive as diagnostics and MUST NOT gate readiness
  // (reading them would reintroduce the channel-identity livelock).
  contextGeneration: number
  serverGeneration: number
  contextRevision: number
  serverRevision: number
}

type ActiveInitialConvergenceRun = {
  trailingRequested: boolean
  promise: Promise<void>
}

type HostInventoryRecoveryRequest = {
  convergenceReason: string
  ccLifecycleGeneration?: number
  cause: HostInventoryRecoveryCause
}

type ActiveHostInventoryRecovery = {
  request: HostInventoryRecoveryRequest
  promise: Promise<HostCRD[]>
}

function mergeHostInventoryRecoveryRequest(
  target: HostInventoryRecoveryRequest,
  requested: HostInventoryRecoveryRequest
): void {
  // Cold start is the stronger admission mode: its snapshot is consumed only
  // by the bounded full pass, whereas watch recovery also dispatches urgent
  // per-Host work. Preserve that mode when either joined caller requires it.
  if (requested.cause === 'cold-start' || target.cause !== 'cold-start') {
    target.convergenceReason = requested.convergenceReason
  }
  if (target.cause === 'cold-start' || requested.cause === 'cold-start') {
    target.cause = 'cold-start'
  }
  if (requested.ccLifecycleGeneration !== undefined) {
    target.ccLifecycleGeneration =
      target.ccLifecycleGeneration === undefined
        ? requested.ccLifecycleGeneration
        : Math.max(target.ccLifecycleGeneration, requested.ccLifecycleGeneration)
  }
}

/**
 * Serializes a reconciliation domain without turning a rejected operation into
 * a permanent queue failure. Kubernetes Watch invokes async callbacks without
 * awaiting the preceding callback, while a full reconciliation can delete
 * orphaned resources owned by the same domain. A single ordered effect stream
 * therefore makes a later watch event the final writer after an older sweep.
 */
class SerializedReconciliationQueue {
  private tail: Promise<void> = Promise.resolve()

  enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.tail.then(work)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

type KeyedReconciliationQueue = {
  queue: SerializedReconciliationQueue
  references: number
}

type McpServerWatchObject = {
  metadata: {
    name: string
    namespace?: string
    uid?: string
    generation?: number
    annotations?: Record<string, string>
    labels?: Record<string, string>
  }
  spec: McpServerSpec
  status?: McpServerCRD['status']
}

/**
 * Interface for McpServer providers (K8s or Dev).
 */
export interface McpServerProvider {
  /** Get all cached CRDs (internal use). */
  getAllServers(): McpServerCRD[]
  /** Get curated server info for all servers (API consumers). */
  getAllServerInfos(): McpServerInfo[]
  /** Get curated server info filtered by context (API consumers). Reads the Context CRD to determine allowed servers. */
  getServerInfosByContext(contextRef: string): Promise<McpServerInfo[]>
  /** Set callback for when servers change. */
  onChange(callback: () => void): void
  start(): Promise<void>
  stop(): Promise<void>
}

/**
 * List all McpServer CRDs in the namespace.
 */
async function listMcpServerSnapshot(): Promise<McpServerSnapshot> {
  if (!customObjectsApi) {
    throw new Error('K8s client not initialized - are you in dev mode?')
  }

  try {
    console.log(`[K8s] Listing all McpServers in namespace ${config.namespace}`)

    const response = await customObjectsApi.listNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: config.namespace,
      plural: PLURAL_MCPSERVERS,
    })

    const list = response as {
      metadata?: { resourceVersion?: string }
      items: Array<{
        metadata: {
          name: string
          namespace?: string
          uid?: string
          generation?: number
          annotations?: Record<string, string>
          labels?: Record<string, string>
        }
        spec: McpServerSpec
        status?: McpServerCRD['status']
      }>
    }

    const servers = list.items.map(item => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace || config.namespace,
      uid: item.metadata.uid,
      generation: item.metadata.generation,
      annotations: item.metadata.annotations,
      labels: item.metadata.labels,
      spec: item.spec,
      status: item.status,
    }))

    console.log(`[K8s] Found ${servers.length} McpServer(s)`)
    return { servers, resourceVersion: list.metadata?.resourceVersion }
  } catch (error) {
    console.error('[K8s] Failed to list McpServers:', error)
    throw error
  }
}

export async function listAllMcpServers(): Promise<McpServerCRD[]> {
  return (await listMcpServerSnapshot()).servers
}

/**
 * List all Context CRDs in the namespace.
 */
async function listContextSnapshot(): Promise<ContextSnapshot> {
  if (!customObjectsApi) {
    throw new Error('K8s client not initialized - are you in dev mode?')
  }

  try {
    console.log(`[K8s] Listing all Contexts in namespace ${config.namespace}`)

    const response = await customObjectsApi.listNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: config.namespace,
      plural: PLURAL_CONTEXTS,
    })

    const list = response as {
      metadata?: { resourceVersion?: string }
      items: Array<{
        metadata: {
          name: string
          namespace?: string
          uid?: string
          generation?: number
        }
        spec: ContextSpec
      }>
    }

    const contexts = list.items.map(item => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace || config.namespace,
      uid: item.metadata.uid,
      generation: item.metadata.generation,
      spec: item.spec,
    }))

    console.log(`[K8s] Found ${contexts.length} Context(s)`)
    return { contexts, resourceVersion: list.metadata?.resourceVersion }
  } catch (error) {
    console.error('[K8s] Failed to list Contexts:', error)
    throw error
  }
}

export async function listAllContexts(): Promise<ContextCRD[]> {
  return (await listContextSnapshot()).contexts
}

/**
 * List all Host CRDs in host namespace.
 */
async function listHostSnapshot(): Promise<HostSnapshot> {
  if (!hostCustomObjectsApi) {
    throw new Error('K8s client not initialized - are you in dev mode?')
  }

  try {
    console.log(`[K8s] Listing all Hosts in namespace ${config.hostNamespace}`)

    const response = await hostCustomObjectsApi.listNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: config.hostNamespace,
      plural: PLURAL_HOSTS,
    })

    const list = response as {
      metadata?: { resourceVersion?: string }
      items: Array<{
        metadata: {
          name: string
          namespace?: string
          uid?: string
          generation?: number
          resourceVersion?: string
          annotations?: Record<string, string>
        }
        spec: HostSpec
        status?: HostCRD['status']
      }>
    }

    const hosts = list.items.map(item => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace || config.hostNamespace,
      uid: item.metadata.uid,
      generation: item.metadata.generation,
      resourceVersion: item.metadata.resourceVersion,
      annotations: item.metadata.annotations,
      spec: item.spec,
      status: item.status,
    }))

    console.log(`[K8s] Found ${hosts.length} Host(s)`)
    return { hosts, resourceVersion: list.metadata?.resourceVersion }
  } catch (error) {
    console.error('[K8s] Failed to list Hosts:', error)
    throw error
  }
}

export async function listAllHosts(): Promise<HostCRD[]> {
  return (await listHostSnapshot()).hosts
}

/**
 * List all SharedFileSystem CRDs in the mcp-host namespace (the only namespace
 * SharedFileSystems are allowed to live in, per CRD validation).
 */
export async function listAllSharedFileSystems(): Promise<SharedFileSystemCRD[]> {
  if (!hostCustomObjectsApi) {
    throw new Error('K8s client not initialized - are you in dev mode?')
  }
  try {
    console.log(`[K8s] Listing all SharedFileSystems in namespace ${config.hostNamespace}`)
    // Deadline-bearing client, like listHostSnapshot: the cold-start Host fleet
    // pass waits on this inventory, so an apiserver that never answers would
    // otherwise strand the fleet behind an already-certified readiness — and
    // leave the SharedFileSystem watch, which starts after this await, dead.
    const response = await hostCustomObjectsApi.listNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: config.hostNamespace,
      plural: PLURAL_SHAREDFILESYSTEMS,
    })
    const list = response as {
      items: Array<{
        metadata: { name: string; namespace?: string }
        spec: SharedFileSystemSpec
      }>
    }
    const sfses = list.items.map(item => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace || config.hostNamespace,
      spec: item.spec,
    }))
    console.log(`[K8s] Found ${sfses.length} SharedFileSystem(s)`)
    return sfses
  } catch (error) {
    console.error('[K8s] Failed to list SharedFileSystems:', error)
    throw error
  }
}

/**
 * List the GlobalFileSystem CRDs in the gfs namespace. gfs is a cluster
 * singleton (one governed drive); this lists 0 or 1 in the core.
 */
export async function listAllGlobalFileSystems(): Promise<GlobalFileSystemCRD[]> {
  if (!customObjectsApi) {
    throw new Error('K8s client not initialized - are you in dev mode?')
  }
  const namespace = gfsDefaultFactoryConfig().gfsNamespace
  try {
    const response = await customObjectsApi.listNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace,
      plural: PLURAL_GLOBALFILESYSTEMS,
    })
    const list = response as {
      items: Array<{
        metadata: { name: string; namespace?: string }
        spec: GlobalFileSystemSpec
        status?: GlobalFileSystemCRD['status']
      }>
    }
    return list.items.map(item => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace || namespace,
      spec: item.spec,
      status: item.status,
    }))
  } catch (error) {
    console.error('[K8s] Failed to list GlobalFileSystems:', error)
    throw error
  }
}

/**
 * List all CommunicationChannel CRDs in the channels namespace.
 *
 * HCC reads only spec.hostRef to count CCs per Host (#281).
 * The per-Host channel-reader pod's own watch handles full CC config
 * (telegram[], email[], slack[]).
 */
export async function listAllCommunicationChannels(): Promise<CommunicationChannelCRD[]> {
  return (await listCommunicationChannelSnapshot()).channels
}

/**
 * List a complete CommunicationChannel snapshot together with the resource
 * version from which a watch can continue. The snapshot and watch must be
 * paired: a raw watch alone cannot prove that the cache contains channels
 * created before the controller connected.
 */
async function listCommunicationChannelSnapshot(): Promise<CommunicationChannelSnapshot> {
  if (!customObjectsApi) {
    throw new Error('K8s client not initialized - are you in dev mode?')
  }
  try {
    console.log(`[K8s] Listing all CommunicationChannels in namespace ${config.channelsNamespace}`)
    const response = await customObjectsApi.listNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: config.channelsNamespace,
      plural: PLURAL_COMMUNICATIONCHANNELS,
    })
    const list = response as {
      metadata?: { resourceVersion?: string }
      items: Array<{
        metadata: { name: string; namespace?: string }
        spec: { hostRef: string; credentialsSecretRef?: { name: string } }
      }>
    }
    const ccs = list.items.map(item => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace || config.channelsNamespace,
      spec: {
        hostRef: item.spec.hostRef,
        ...(item.spec.credentialsSecretRef?.name
          ? { credentialsSecretRef: { name: item.spec.credentialsSecretRef.name } }
          : {}),
      },
    }))
    console.log(`[K8s] Found ${ccs.length} CommunicationChannel(s)`)
    return { channels: ccs, resourceVersion: list.metadata?.resourceVersion }
  } catch (error) {
    console.error('[K8s] Failed to list CommunicationChannels:', error)
    throw error
  }
}

/**
 * List all LlmHook CRDs in the llm-hooks namespace.
 */
export async function listAllLlmHooks(): Promise<LlmHookCRD[]> {
  if (!customObjectsApi) {
    throw new Error('K8s client not initialized - are you in dev mode?')
  }
  try {
    console.log(`[K8s] Listing all LlmHooks in namespace ${config.llmHooksNamespace}`)
    const response = await customObjectsApi.listNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: config.llmHooksNamespace,
      plural: PLURAL_LLMHOOKS,
    })
    const list = response as {
      items: Array<{
        metadata: {
          name: string
          namespace?: string
          uid?: string
          generation?: number
          annotations?: Record<string, string>
          labels?: Record<string, string>
        }
        spec: LlmHookSpec
        status?: LlmHookCRD['status']
      }>
    }
    const hooks = list.items.map(item => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace || config.llmHooksNamespace,
      uid: item.metadata.uid,
      generation: item.metadata.generation,
      annotations: item.metadata.annotations,
      labels: item.metadata.labels,
      spec: item.spec,
      status: item.status,
    }))
    console.log(`[K8s] Found ${hooks.length} LlmHook(s)`)
    return hooks
  } catch (error) {
    console.error('[K8s] Failed to list LlmHooks:', error)
    throw error
  }
}

/**
 * Read a Context CRD by contextId.
 * Returns the allowed McpServer names, or null if not found.
 */
export async function getContext(contextId: string): Promise<ContextCRD | null> {
  if (!customObjectsApi) {
    throw new Error('K8s client not initialized - are you in dev mode?')
  }

  try {
    console.log(`[K8s] Reading Context CRD: ${contextId}`)

    const response = await customObjectsApi.getNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: config.namespace,
      plural: PLURAL_CONTEXTS,
      name: contextId,
    })

    const obj = response as {
      metadata: { name: string; namespace?: string }
      spec: ContextSpec
    }

    return {
      name: obj.metadata.name,
      namespace: obj.metadata.namespace || config.namespace,
      spec: obj.spec,
    }
  } catch (error) {
    if (getErrorCode(error) === 404) {
      console.warn(`[K8s] Context CRD not found: ${contextId}`)
      return null
    }
    console.error(`[K8s] Failed to read Context CRD:`, error)
    throw error
  }
}

/**
 * McpServer watcher - watches for changes to McpServer CRDs and
 * triggers the reconciler to manage Deployments + Services.
 */
export class McpServerWatcher implements McpServerProvider {
  private watch: k8s.Watch
  private mcpWatchRequest: { abort: () => void } | null = null
  private ctxWatchRequest: { abort: () => void } | null = null
  private hostWatchRequest: { abort: () => void } | null = null
  private sfsWatchRequest: { abort: () => void } | null = null
  private gfsWatchRequest: { abort: () => void } | null = null
  private ccWatchRequest: { abort: () => void } | null = null
  private llmHookWatchRequest: { abort: () => void } | null = null
  private servers: Map<string, McpServerCRD> = new Map()
  private hosts: Map<string, HostCRD> = new Map()
  private contexts: Map<string, ContextCRD> = new Map()
  private sharedFileSystems: Map<string, SharedFileSystemCRD> = new Map()
  private globalFileSystems: Map<string, GlobalFileSystemCRD> = new Map()
  private communicationChannels: Map<string, CommunicationChannelCRD> = new Map()
  private llmHooks: Map<string, LlmHookCRD> = new Map()
  private mcpWatchGeneration = 0
  private contextWatchGeneration = 0
  private mcpServerDesiredRevision = 0
  private contextDesiredRevision = 0
  private hostDesiredRevision = 0
  // Readiness covers authoritative revocation, not additive fleet completion.
  // Generations bind the completed safety sweep to the exact LIST -> WATCH
  // pair that supplied its absence decisions. A recovered watch invalidates
  // this marker until the new inventory's orphan-allow sweep completes.
  // Sentinel -1 = "no authoritative revocation has certified yet". A real
  // desired revision starts at 0, so the readiness gate stays closed until the
  // first recordNetworkPolicySafetyCertificate writes a real revision here —
  // the startup role the (now removed) generation equalities used to play.
  private networkPolicyRevocationContextRevision = -1
  private networkPolicyRevocationServerRevision = -1
  private mcpServerCacheSynced = false
  private contextCacheSynced = false
  private mcpServerCacheRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  private contextCacheRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  private mcpServerCacheRecoveryInFlight: Promise<boolean> | null = null
  private contextCacheRecoveryInFlight: Promise<boolean> | null = null
  // Instant (Date.now) at which the last SUCCESSFUL recovery re-established
  // each inventory watch. attempt*CacheRecovery compares against these to
  // apply WATCH_CLOSE_RECOVERY_FLOOR_MS: a close spaced beyond the floor gets
  // an immediate re-LIST; a burst close within it falls back to the timer.
  private lastMcpServerWatchRecoveryAt = Number.NEGATIVE_INFINITY
  private lastContextWatchRecoveryAt = Number.NEGATIVE_INFINITY
  private lastHostWatchRecoveryAt = Number.NEGATIVE_INFINITY
  // Consecutive recovery FAILURES per hardened lane, driving the exponential
  // backoff ladder in schedule*CacheRecovery. Reset to 0 by every successful
  // recovery so an isolated later close starts again at the base delay. The
  // paired retryAfterMs (captured from an HTTP 429 Retry-After) overrides the
  // computed delay for exactly the next scheduled retry.
  private mcpServerWatchRecoveryFailures = 0
  private mcpServerWatchRecoveryRetryAfterMs: number | undefined
  private contextWatchRecoveryFailures = 0
  private contextWatchRecoveryRetryAfterMs: number | undefined
  private hostWatchRecoveryFailures = 0
  private hostWatchRecoveryRetryAfterMs: number | undefined
  // A watch callback can still settle after its stream reports completion.
  // Host reconciles change the mcp-host pod template, so stale callbacks must
  // never replay an older Host spec after a replacement watch is active.
  private hostWatchGeneration = 0
  // Event revisions fence async retries within the current resourceVersion-
  // continuing stream. Watch generation fences callbacks from retired streams.
  private hostWatchRevision = 0
  private readonly latestHostWatchEventRevisions = new Map<string, number>()
  private readonly hostWatchRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly hostWatchRetryAttempts = new Map<string, number>()
  private hostCacheSynced = false
  private hostCacheRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  private sfsWatchRestartTimer: ReturnType<typeof setTimeout> | null = null
  private gfsWatchRestartTimer: ReturnType<typeof setTimeout> | null = null
  // Host watch LIST-to-WATCH recovery is a dedicated, deduplicated operation
  // (§10.2). Concurrent recovery signals reuse the in-flight promise so exactly
  // one LIST + WATCH is installed. Independent per-Host events no longer share a
  // process-wide convergence tail — they enter the per-Host serializer directly.
  private hostRecoveryInFlight: ActiveHostInventoryRecovery | null = null
  private hostCacheRecoveryIntent: HostInventoryRecoveryRequest | null = null
  // Only the cold-start Host fleet pass waits for the initial SFS inventory.
  // The inventory itself remains asynchronous with respect to provider.start
  // and NetworkPolicy readiness certification.
  private initialHostFleetSfsInventory: Promise<boolean> | null = null
  // B2: tracks whether the CC snapshot is paired with a continuing watch.
  // Set to true only while a complete snapshot is paired with a live watch;
  // used by HostReconciler to make fail-closed lifecycle decisions.
  private ccCacheSynced = false
  private ccWatchGeneration = 0
  private ccCacheRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  private ccCacheRecoveryInFlight: Promise<boolean> | null = null
  private readonly hostFleetScheduler = new HostFleetScheduler({
    perform: request => this.performHostFleetReconcile(request),
    recordRequest: result => hostFleetRequestsTotal.inc({ result }),
  })
  private get ccLifecycleGeneration(): number {
    return this.hostFleetScheduler.currentLifecycleGeneration
  }
  private get ccAppliedLifecycleGeneration(): number {
    return this.hostFleetScheduler.appliedLifecycleGeneration
  }
  private hostResyncInFlight: Promise<void> | null = null
  private changeCallback?: () => void
  private stopped = false
  private reconciler: McpServerReconciler
  private hostReconciler: HostReconciler
  private netPolReconciler: NetworkPolicyReconciler
  private llmHookReconciler: LlmHookReconciler
  private bindingReconciler: BindingPolicyReconciler
  private sharedFileSystemReconciler: SharedFileSystemReconciler
  private gfsReconciler: GfsReconciler
  private readonly infrastructureTelemetryReporter?: InfrastructureTelemetryReporter
  private readonly administrativeOutcomeReporter?: AdministrativeOutcomeReporter
  private readonly externalEgressCoordinator = new ExternalEgressConvergenceCoordinator({
    listServers: () => [...this.servers.values()],
    getCurrentServer: name => this.servers.get(name),
    inventoryAuthoritative: () => !this.stopped && this.mcpServerCacheSynced,
    sameDesiredRevision: sameMcpServerDesiredRevision,
    enqueue: (server, work) => this.enqueueMcpServerReconciliation(server, work),
    mutate: (type, server, options) => this.performExternalEgressMutation(type, server, options),
    replay: (type, server, retry) =>
      this.reconcileMcpServerWatchEvent(type, server, this.mcpWatchGeneration, retry),
    externalEgressRefreshMinTtlMs: () => this.netPolReconciler.externalEgressRefreshMinTtlMs,
  })
  private readonly initialConvergenceRetryTimers = new Map<
    InitialConvergenceLane,
    ReturnType<typeof setTimeout>
  >()
  private readonly initialConvergenceRetryAttempts = new Map<InitialConvergenceLane, number>()
  private readonly initialConvergenceRuns = new Map<
    InitialConvergenceLane,
    ActiveInitialConvergenceRun
  >()
  // Every resource effect serializes by resource identity, so one slow fleet
  // member cannot block unrelated live events while same-resource updates
  // still retain last-writer ordering.
  private readonly mcpServerReconciliationQueues = new Map<string, KeyedReconciliationQueue>()
  private readonly contextReconciliationQueues = new Map<string, KeyedReconciliationQueue>()
  private readonly sharedFileSystemReconciliationQueues = new Map<
    string,
    KeyedReconciliationQueue
  >()
  private readonly globalFileSystemReconciliationQueues = new Map<
    string,
    KeyedReconciliationQueue
  >()
  private sharedFileSystemCacheRevision = 0
  private globalFileSystemCacheRevision = 0
  // Periodic resync timer: K8s watches can drop events on long disconnects;
  // running fullReconcile every N minutes guarantees mcp-host-runtime-token Secret
  // rotation eventually catches up even after a missed MODIFIED event.
  // Disabled when interval <= 0 (tests).
  private resyncTimer: ReturnType<typeof setInterval> | null = null
  // Periodic SharedFileSystem resync (#592): the SFS watch fires only on SFS CRD
  // changes, not on PVC binding / wfc pod readiness, so a SharedFileSystem that
  // reported Initializing/Degraded needs a periodic re-reconcile to converge to a
  // truthful Ready. Disabled when interval <= 0 (tests).
  private sfsResyncTimer: ReturnType<typeof setInterval> | null = null
  // Periodic LlmHook resync: drives the reference-counted orphan sweep and
  // readiness convergence when the watch drops events (guardrails phase-4 §3).
  private llmHookResyncTimer: ReturnType<typeof setInterval> | null = null
  // Periodic GlobalFileSystem resync: like SFS, the gfs watch fires only on the
  // CRD changing — not on the gfsc writer Deployment becoming Available — so a
  // GlobalFileSystem stuck at Initializing converges to Ready (and seeds its
  // root directories) once the writer is up. Disabled when interval <= 0 (tests).
  private gfsResyncTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    if (!kc) {
      throw new Error('K8s client not initialized - are you in dev mode?')
    }
    this.watch = new k8s.Watch(kc)
    this.reconciler = new McpServerReconciler(kc)
    this.reconciler.setInventoryAuthority(() => ({
      known: this.mcpServerCacheSynced,
      generation: this.mcpWatchGeneration,
    }))
    this.reconciler.setResolveCurrentServer(name => this.servers.get(name))
    const infrastructureTelemetryReporter = config.controlApiBaseUrl
      ? createInfrastructureTelemetryReporter(config.governedTracingEnabled, {
          baseUrl: config.controlApiBaseUrl,
        })
      : undefined
    const administrativeOutcomeReporter = config.controlApiBaseUrl
      ? createAdministrativeOutcomeReporter(config.governedTracingEnabled, {
          baseUrl: config.controlApiBaseUrl,
        })
      : undefined
    this.infrastructureTelemetryReporter = infrastructureTelemetryReporter
    this.administrativeOutcomeReporter = administrativeOutcomeReporter
    this.hostReconciler = new HostReconciler(kc, {
      infrastructureTelemetryReporter: this.infrastructureTelemetryReporter,
      administrativeOutcomeReporter: this.administrativeOutcomeReporter,
    })
    this.netPolReconciler = new NetworkPolicyReconciler(kc, this.servers)
    // LlmHook reconciler shares the live hook + host caches so it can recompute
    // pod-key member sets and the Host→LlmHook reverse index on every reconcile.
    this.llmHookReconciler = new LlmHookReconciler(kc, this.llmHooks, this.hosts)
    this.bindingReconciler = new BindingPolicyReconciler(kc, config.namespace)
    this.sharedFileSystemReconciler = new SharedFileSystemReconciler(kc)
    // gfs (Global File System) — DISTINCT from SharedFileSystem. The reconcile
    // logic (GfsReconciler) is K8s-agnostic; K8sGfsApi is the real cluster
    // binding. Env-driven factory config (gfs namespace, gfsc image, etc.).
    this.gfsReconciler = new GfsReconciler(
      new K8sGfsApi(
        kc.makeApiClient(k8s.CoreV1Api),
        kc.makeApiClient(k8s.AppsV1Api),
        kc.makeApiClient(k8s.NetworkingV1Api),
        kc.makeApiClient(k8s.PolicyV1Api),
        kc.makeApiClient(k8s.CustomObjectsApi)
      ),
      gfsDefaultFactoryConfig(),
      new ControlApiGfsSeedClient()
    )
    // Wire the cross-CRD lookup the HostReconciler needs to mount each
    // referenced SharedFileSystem RO into the per-Host mcp-host pod.
    this.hostReconciler.setResolveContextMounts(host => this.resolveContextMounts(host))
    // Wire the oauth-server probe the HostReconciler uses to gate the
    // derive-only `oauth:user-token` runtime scope: true iff the Host's Context
    // fronts an enabled `auth.type: oauth` mcp-server. Reuses the same
    // Context-scoped allow-list projection as mcp-host discovery.
    this.hostReconciler.setHostFrontsOAuthServer(host => this.hostFrontsOAuthServer(host))
    // #281: HostReconciler drives channel-reader Deployment replicas from
    // the CC count below, populated by the CommunicationChannel watch
    // (see startCommunicationChannelWatch).
    this.hostReconciler.setCountCommunicationChannels(host => this.countCommunicationChannels(host))
    // B2: Wire the CC cache-sync flag so HostReconciler can gate replica
    // scale-down on whether the initial CC list has completed.
    this.hostReconciler.setIsCommunicationChannelCacheSynced(() =>
      this.isCommunicationChannelCacheSynced()
    )
    // A fleet worker resolves the freshest cached Host at execution (skipping
    // entries a delete/newer event has since removed), and orphan cleanup
    // compares candidates with the CURRENT inventory rather than a pass snapshot.
    this.hostReconciler.setResolveCurrentHost(name => this.hosts.get(name))
    // H2: reflect committed lifecycle outcomes onto the CURRENT cache entry —
    // but never onto a same-name recreation. uid === undefined fails closed
    // (production watch objects always carry uid).
    this.hostReconciler.setReflectHostOutcome((name, uid, apply) => {
      const cached = this.hosts.get(name)
      if (!cached || uid === undefined || cached.uid !== uid) return
      apply(cached)
    })
    // Orphan cleanup requires known watch authority and a stable watch
    // generation; expose both so cleanup fail-closes while authority is unknown
    // or the watch has been retired mid-pass.
    this.hostReconciler.setHostWatchAuthority(() => ({
      known: this.hostCacheSynced,
      generation: this.hostWatchGeneration,
    }))
    this.hostReconciler.setHostMutationAuthority(() => ({
      known: this.hostCacheSynced && this.contextCacheSynced,
      hostRevision: this.hostDesiredRevision,
      contextRevision: this.contextDesiredRevision,
    }))
    this.hostReconciler.setResolveHostMutationDependencies(host => {
      const context = this.contexts.get(host.spec.contextRef)
      // Lease desired semantics, not cache-object identity or observed status.
      // Kubernetes watch events replace objects and status-only changes may
      // legitimately advance resourceVersion without changing Host inputs.
      const desiredRevision = <T extends { name: string; namespace: string; spec: unknown }>(
        resource: T | undefined
      ) =>
        resource
          ? { name: resource.name, namespace: resource.namespace, spec: resource.spec }
          : undefined
      const dependencies: unknown[] = [
        desiredRevision(context),
        this.ccCacheSynced,
        this.ccWatchGeneration,
      ]
      for (const ref of context?.spec.sharedFileSystems ?? []) {
        const sfs = this.sharedFileSystems.get(ref.name)
        dependencies.push(
          desiredRevision(sfs),
          sfs ? this.sharedFileSystemReconciler.isMountable(sfs) : false
        )
      }
      const channels = this.findCommunicationChannelsByHostRef(host.name).sort((a, b) =>
        a.name.localeCompare(b.name)
      )
      dependencies.push(...channels.map(channel => desiredRevision(channel)))
      return dependencies
    })
    // Per-CC credentials Secret migration: HostReconciler computes the
    // channel-reader credentials-revision annotation by hashing the Secret(s)
    // referenced by all CCs of a host. Wire both finders so
    // patchChannelReaderRevisionAnnotation (CC events) and
    // reconcileChannelReaderRevision (Secret rotation events) can look up
    // affected hosts from our in-process CC cache.
    this.hostReconciler.setFindCommunicationChannelsByHostRef(host =>
      this.findCommunicationChannelsByHostRef(host)
    )
    this.hostReconciler.setFindCommunicationChannelsByCredentialsSecretName(name =>
      this.findCommunicationChannelsByCredentialsSecretName(name)
    )
    // SFS status.mountedByContexts is computed by the SFS reconciler at
    // every reconcile by asking us which Contexts currently reference it.
    this.sharedFileSystemReconciler.setListContextRefs(sfsName =>
      this.contextsReferencingSfs(sfsName)
    )
  }

  /**
   * B2: Returns true while the CC cache is backed by a complete snapshot and
   * its resourceVersion-continuing watch. HostReconciler gates scale-down and
   * stateless eligibility on this flag.
   */
  isCommunicationChannelCacheSynced(): boolean {
    return this.ccCacheSynced
  }

  /**
   * Readiness authority covers the inventories that back HCC discovery,
   * Context policy decisions, and Host API/runtime ownership. Communication
   * Channel loss is intentionally excluded: that subsystem already fails safe
   * by preserving replicas and disabling stateless suspension until recovery.
   * SFS/GFS retain their established eventual-resync contract.
   */
  getReadinessInventoryDetail(): ReadinessInventoryDetail {
    return {
      stopped: this.stopped,
      mcpServerCacheSynced: this.mcpServerCacheSynced,
      contextCacheSynced: this.contextCacheSynced,
      hostCacheSynced: this.hostCacheSynced,
      safetyInventoryCertified: this.netPolReconciler.hasCertifiedSafetyInventory(),
      contextRevisionAligned:
        this.networkPolicyRevocationContextRevision === this.contextDesiredRevision,
      serverRevisionAligned:
        this.networkPolicyRevocationServerRevision === this.mcpServerDesiredRevision,
    }
  }

  isReadinessInventoryAuthoritative(): boolean {
    const detail = this.getReadinessInventoryDetail()
    return (
      !detail.stopped &&
      detail.mcpServerCacheSynced &&
      detail.contextCacheSynced &&
      detail.hostCacheSynced &&
      // Certification is pinned to CONTENT identity (the desired-revision
      // counters), not CHANNEL identity (the watch-generation counters). A
      // "Premature close" reconnect re-LISTs the same inventory and bumps the
      // generation without changing desired state; gating readiness on the
      // generation there livelocked the certificate forever under sustained GKE
      // watch-churn (the clerum-dev incident) while the underlying safety
      // decision stayed valid. The revision only moves when the diffing snapshot
      // installer observes a real desired-state change, so a same-content
      // reconnect no longer re-closes the gate, while a genuine change still
      // forces re-certification. Losing a delete fence bumps no revision, so
      // hasCertifiedSafetyInventory() remains the fence for that one failure
      // mode that no equality below can see.
      detail.safetyInventoryCertified &&
      detail.contextRevisionAligned &&
      detail.serverRevisionAligned
    )
  }

  /**
   * Host-managed runtime mutation requires a LIST snapshot paired with its
   * continuing WATCH. This narrower predicate is also used by non-HTTP effect
   * producers while the broader readiness predicate additionally covers
   * McpServer and Context discovery authority.
   */
  isHostInventoryAuthoritative(): boolean {
    return !this.stopped && this.hostCacheSynced
  }

  /**
   * Host runtime state is derived from both the Host and Context inventories:
   * Context owns the SharedFileSystem mount set rendered into each Host pod.
   * Mutation must therefore stop when either LIST -> WATCH pair is unavailable.
   */
  private isHostEffectInventoryAuthoritative(): boolean {
    return this.isHostInventoryAuthoritative() && this.contextCacheSynced
  }

  /**
   * Fail closed at every Host-effect admission boundary while recovery owns
   * inventory authority. Preserve the reason/generation in the retry intent so
   * the successful LIST -> WATCH recovery's full pass applies the deferred
   * effect from current state instead of acting on the stale cache.
   */
  private admitHostDependentEffects(
    convergenceReason: string,
    ccLifecycleGeneration?: number
  ): boolean {
    if (this.isHostEffectInventoryAuthoritative()) return true
    if (!this.stopped && !this.hostCacheSynced) {
      this.scheduleHostCacheRecovery({
        convergenceReason,
        ccLifecycleGeneration,
        cause: 'watch-recovery',
      })
    }
    return false
  }

  private retireMcpServerWatch(expectedGeneration?: number): boolean {
    if (expectedGeneration !== undefined && expectedGeneration !== this.mcpWatchGeneration) {
      return false
    }
    this.mcpServerCacheSynced = false
    this.mcpWatchGeneration += 1
    this.mcpWatchRequest?.abort()
    this.mcpWatchRequest = null
    return true
  }

  private retireContextWatch(expectedGeneration?: number): boolean {
    if (expectedGeneration !== undefined && expectedGeneration !== this.contextWatchGeneration) {
      return false
    }
    this.contextCacheSynced = false
    this.contextWatchGeneration += 1
    this.ctxWatchRequest?.abort()
    this.ctxWatchRequest = null
    return true
  }

  private async enqueueKeyedReconciliation(
    queues: Map<string, KeyedReconciliationQueue>,
    key: string,
    work: () => Promise<void>
  ): Promise<void> {
    let entry = queues.get(key)
    if (!entry) {
      entry = { queue: new SerializedReconciliationQueue(), references: 0 }
      queues.set(key, entry)
    }
    entry.references++
    try {
      await entry.queue.enqueue(async () => {
        if (this.stopped) return
        await work()
      })
    } finally {
      entry.references--
      if (entry.references === 0 && queues.get(key) === entry) queues.delete(key)
    }
  }

  private enqueueMcpServerReconciliation(
    server: Pick<McpServerCRD, 'name' | 'namespace'>,
    work: () => Promise<void>
  ): Promise<void> {
    return this.enqueueKeyedReconciliation(
      this.mcpServerReconciliationQueues,
      `${server.namespace}/${server.name}`,
      work
    )
  }

  private enqueueContextReconciliation(
    contextId: string,
    work: () => Promise<void>
  ): Promise<void> {
    return this.enqueueKeyedReconciliation(this.contextReconciliationQueues, contextId, work)
  }

  private enqueueContextIdentityReconciliation(
    contextIds: string[],
    work: () => Promise<void>
  ): Promise<void> {
    const keys = [...new Set(contextIds)].sort()
    const enter = (index: number): Promise<void> => {
      const key = keys[index]
      if (!key) return work()
      return this.enqueueContextReconciliation(key, () => enter(index + 1))
    }
    return enter(0)
  }

  private hasMcpServerInventoryAuthority(watchGeneration: number): boolean {
    return this.mcpServerCacheSynced && this.mcpWatchGeneration === watchGeneration
  }

  private hasContextInventoryAuthority(watchGeneration: number): boolean {
    return this.contextCacheSynced && this.contextWatchGeneration === watchGeneration
  }

  private async mcpServerAbsentForDelete(
    name: string,
    namespace: string,
    watchGeneration: number
  ): Promise<boolean> {
    if (!customObjectsApi) return false
    return confirmAuthoritativeMcpServerAbsence({
      inventoryAuthoritative: () => this.hasMcpServerInventoryAuthority(watchGeneration),
      resolveCurrent: () => this.servers.get(name),
      readCurrent: () =>
        customObjectsApi.getNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace,
          plural: PLURAL_MCPSERVERS,
          name,
        }),
    })
  }

  private async authorizeMcpServerDeleteOrRetry(
    server: McpServerCRD,
    watchGeneration: number
  ): Promise<boolean> {
    try {
      const authorized = await this.mcpServerAbsentForDelete(
        server.name,
        server.namespace,
        watchGeneration
      )
      if (!authorized && !this.hasMcpServerInventoryAuthority(watchGeneration)) {
        console.warn(
          `[K8s] McpServer inventory authority changed while deleting ${server.name}; ` +
            'full cleanup deferred until retry'
        )
        this.scheduleExternalEgressRetry('DELETED', server)
        this.changeCallback?.()
      }
      return authorized
    } catch (error) {
      console.error(
        `[K8s] Authoritative absence check failed for deleted McpServer ${server.name}; ` +
          'cleanup blocked until retry:',
        error
      )
      this.scheduleExternalEgressRetry('DELETED', server)
      this.changeCallback?.()
      return false
    }
  }

  private async contextAbsentForDelete(
    name: string,
    namespace: string,
    watchGeneration: number
  ): Promise<boolean> {
    if (
      !this.contextCacheSynced ||
      this.contextWatchGeneration !== watchGeneration ||
      this.contexts.has(name) ||
      !customObjectsApi
    ) {
      return false
    }
    try {
      await customObjectsApi.getNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace,
        plural: PLURAL_CONTEXTS,
        name,
      })
      return false
    } catch (error: unknown) {
      if (getErrorCode(error) !== 404) throw error
    }
    return (
      this.contextCacheSynced &&
      this.contextWatchGeneration === watchGeneration &&
      !this.contexts.has(name)
    )
  }

  private async contextIdAbsentForDelete(
    contextId: string,
    watchGeneration: number
  ): Promise<boolean> {
    const inventoryAuthoritative = () =>
      this.contextCacheSynced && this.contextWatchGeneration === watchGeneration
    const resolveCurrent = () =>
      [...this.contexts.values()].find(context => context.spec.contextId === contextId)
    if (!customObjectsApi || !inventoryAuthoritative() || resolveCurrent()) return false

    const response = (await customObjectsApi.listNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: config.namespace,
      plural: PLURAL_CONTEXTS,
    })) as { items?: Array<{ spec?: { contextId?: string } }> }
    if ((response.items ?? []).some(context => context.spec?.contextId === contextId)) return false

    return inventoryAuthoritative() && !resolveCurrent()
  }

  private enqueueSharedFileSystemReconciliation(
    name: string,
    work: () => Promise<void>
  ): Promise<void> {
    return this.enqueueKeyedReconciliation(this.sharedFileSystemReconciliationQueues, name, work)
  }

  private enqueueGlobalFileSystemReconciliation(
    name: string,
    work: () => Promise<void>
  ): Promise<void> {
    return this.enqueueKeyedReconciliation(this.globalFileSystemReconciliationQueues, name, work)
  }

  /**
   * Fleet passes acquire every selected object lane in stable order. This
   * preserves their snapshot-wide ordering without making two unrelated live
   * watch events wait behind one another.
   */
  private enqueueKeyedFleetReconciliation(
    queues: Map<string, KeyedReconciliationQueue>,
    keys: string[],
    work: () => Promise<void>
  ): Promise<void> {
    const orderedKeys = [...new Set(keys)].sort()
    const enter = (index: number): Promise<void> => {
      const key = orderedKeys[index]
      if (!key) return work()
      return this.enqueueKeyedReconciliation(queues, key, () => enter(index + 1))
    }
    return enter(0)
  }

  private enqueueSharedFileSystemFleetReconciliation(
    names: string[],
    work: () => Promise<void>
  ): Promise<void> {
    return this.enqueueKeyedFleetReconciliation(
      this.sharedFileSystemReconciliationQueues,
      names,
      work
    )
  }

  private enqueueGlobalFileSystemFleetReconciliation(
    names: string[],
    work: () => Promise<void>
  ): Promise<void> {
    return this.enqueueKeyedFleetReconciliation(
      this.globalFileSystemReconciliationQueues,
      names,
      work
    )
  }

  private requireInventoryResourceVersion(
    kind: 'McpServer' | 'Context',
    resourceVersion: string | undefined
  ): string {
    if (!resourceVersion) {
      throw new Error(`${kind} snapshot missing resourceVersion`)
    }
    return resourceVersion
  }

  // A re-LIST after a watch reconnect ("Premature close") reinstalls the whole
  // cache. Diff the incoming snapshot against the current cache BEFORE replacing
  // it and bump the desired revision iff the desired state actually changed
  // (an add, a removal, or a spec change under the canonical comparator). This
  // is the counterpart to the watch-event revision bump: it makes the desired
  // revision a monotonic CONTENT identity that survives channel loss, so the
  // safety certificate can gate on content instead of the churning generation.
  // Same-content reconnect → no bump → certification survives the churn. Real
  // change carried by the re-LIST → bump → forced re-certification (fail-closed).
  private mcpServerSnapshotChangesDesiredState(snapshot: McpServerSnapshot): boolean {
    if (snapshot.servers.length !== this.servers.size) return true
    for (const server of snapshot.servers) {
      const previous = this.servers.get(server.name)
      if (previous === undefined || !sameMcpServerDesiredRevision(previous, server)) {
        return true
      }
    }
    return false
  }

  private installMcpServerSnapshot(snapshot: McpServerSnapshot): void {
    if (this.mcpServerSnapshotChangesDesiredState(snapshot)) {
      this.mcpServerDesiredRevision += 1
    }
    this.servers.clear()
    for (const server of snapshot.servers) {
      this.servers.set(server.name, server)
    }
  }

  private contextSnapshotChangesDesiredState(snapshot: ContextSnapshot): boolean {
    if (snapshot.contexts.length !== this.contexts.size) return true
    for (const context of snapshot.contexts) {
      const previous = this.contexts.get(context.name)
      if (previous === undefined || !sameContextDesiredRevision(previous, context)) {
        return true
      }
    }
    return false
  }

  private installContextSnapshot(snapshot: ContextSnapshot): void {
    if (this.contextSnapshotChangesDesiredState(snapshot)) {
      this.contextDesiredRevision += 1
    }
    this.contexts.clear()
    for (const context of snapshot.contexts) {
      this.contexts.set(context.name, context)
    }
  }

  private async restartMcpServerWatch(snapshot: McpServerSnapshot): Promise<number> {
    const resourceVersion = this.requireInventoryResourceVersion(
      'McpServer',
      snapshot.resourceVersion
    )
    this.mcpServerCacheSynced = false
    this.installMcpServerSnapshot(snapshot)
    const watchGeneration = await this.startMcpServerWatch(resourceVersion)
    if (
      this.stopped ||
      watchGeneration !== this.mcpWatchGeneration ||
      this.mcpWatchRequest === null
    ) {
      throw new Error('McpServer snapshot could not be paired with an active watch')
    }
    this.mcpServerCacheSynced = true
    return watchGeneration
  }

  private async restartContextWatch(snapshot: ContextSnapshot): Promise<number> {
    const resourceVersion = this.requireInventoryResourceVersion(
      'Context',
      snapshot.resourceVersion
    )
    this.contextCacheSynced = false
    this.installContextSnapshot(snapshot)
    const watchGeneration = await this.startContextWatch(resourceVersion)
    if (
      this.stopped ||
      watchGeneration !== this.contextWatchGeneration ||
      this.ctxWatchRequest === null
    ) {
      throw new Error('Context snapshot could not be paired with an active watch')
    }
    this.contextCacheSynced = true
    return watchGeneration
  }

  private recoverMcpServerInventoryAndWatch(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false)
    if (this.mcpServerCacheRecoveryInFlight) return this.mcpServerCacheRecoveryInFlight

    const recovery = (async () => {
      try {
        const snapshot = await listMcpServerSnapshot()
        if (this.stopped) return false
        await this.restartMcpServerWatch(snapshot)
        if (this.stopped) return false
        this.lastMcpServerWatchRecoveryAt = Date.now()
        this.mcpServerWatchRecoveryFailures = 0
        this.mcpServerWatchRecoveryRetryAfterMs = undefined
        this.changeCallback?.()
        if (this.contextCacheSynced) {
          void this.runInitialNetworkPolicyConvergence()
        }
        return true
      } catch (error) {
        this.mcpServerCacheSynced = false
        this.mcpServerWatchRecoveryFailures += 1
        this.mcpServerWatchRecoveryRetryAfterMs = getRetryAfterMs(error)
        console.error('[K8s] McpServer cache recovery failed:', error)
        return false
      }
    })()

    this.mcpServerCacheRecoveryInFlight = recovery
    void recovery.finally(() => {
      if (this.mcpServerCacheRecoveryInFlight === recovery) {
        this.mcpServerCacheRecoveryInFlight = null
      }
    })
    return recovery
  }

  private recoverContextInventoryAndWatch(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false)
    if (this.contextCacheRecoveryInFlight) return this.contextCacheRecoveryInFlight

    const recovery = (async () => {
      try {
        const snapshot = await listContextSnapshot()
        if (this.stopped) return false
        await this.restartContextWatch(snapshot)
        if (this.stopped) return false
        this.lastContextWatchRecoveryAt = Date.now()
        this.contextWatchRecoveryFailures = 0
        this.contextWatchRecoveryRetryAfterMs = undefined
        this.hostFleetScheduler.bumpInputRevision()
        void this.runInitialNetworkPolicyConvergence()
        void this.runInitialSharedFileSystemConvergence()
        if (this.hostCacheSynced) {
          const pendingCcLifecycleGeneration =
            this.ccLifecycleGeneration > this.ccAppliedLifecycleGeneration
              ? this.ccLifecycleGeneration
              : undefined
          void this.requestHostFleetReconcile(
            'Context cache recovery',
            pendingCcLifecycleGeneration,
            'full'
          )
        }
        return true
      } catch (error) {
        this.contextCacheSynced = false
        this.contextWatchRecoveryFailures += 1
        this.contextWatchRecoveryRetryAfterMs = getRetryAfterMs(error)
        console.error('[K8s] Context cache recovery failed:', error)
        return false
      }
    })()

    this.contextCacheRecoveryInFlight = recovery
    void recovery.finally(() => {
      if (this.contextCacheRecoveryInFlight === recovery) {
        this.contextCacheRecoveryInFlight = null
      }
    })
    return recovery
  }

  /**
   * One recovery attempt NOW (immediate re-LIST on watch close), with the
   * jittered exponential-backoff timer kept purely as retry-after-failure
   * pacing. The anti-busy-loop floor demotes a close that arrives within
   * WATCH_CLOSE_RECOVERY_FLOOR_MS of the last successful recovery back onto
   * the paced timer. Dedup against concurrent attempts lives in
   * recoverMcpServerInventoryAndWatch (mcpServerCacheRecoveryInFlight).
   */
  private attemptMcpServerCacheRecovery(): void {
    if (this.stopped) return
    if (Date.now() - this.lastMcpServerWatchRecoveryAt < WATCH_CLOSE_RECOVERY_FLOOR_MS) {
      this.scheduleMcpServerCacheRecovery()
      return
    }
    void this.recoverMcpServerInventoryAndWatch().then(recovered => {
      if (!recovered) this.scheduleMcpServerCacheRecovery()
    })
  }

  /** Context analogue of attemptMcpServerCacheRecovery. */
  private attemptContextCacheRecovery(): void {
    if (this.stopped) return
    if (Date.now() - this.lastContextWatchRecoveryAt < WATCH_CLOSE_RECOVERY_FLOOR_MS) {
      this.scheduleContextCacheRecovery()
      return
    }
    void this.recoverContextInventoryAndWatch().then(recovered => {
      if (!recovered) this.scheduleContextCacheRecovery()
    })
  }

  /**
   * Host analogue: one attempt NOW unless inside the floor. The retry re-arm
   * on failure lives in performHostInventoryRecovery (scheduleHostCacheRecovery
   * before rethrow) and the intent/in-flight merge lives in
   * recoverHostInventoryAndWatch, so this helper only decides immediate vs
   * paced.
   */
  private attemptHostCacheRecovery(): void {
    if (this.stopped) return
    if (Date.now() - this.lastHostWatchRecoveryAt < WATCH_CLOSE_RECOVERY_FLOOR_MS) {
      this.scheduleHostCacheRecovery()
      return
    }
    void this.recoverHostInventoryAndWatch().catch(() => undefined)
  }

  private scheduleMcpServerCacheRecovery(): void {
    if (this.stopped || this.mcpServerCacheRecoveryTimer) return
    const delayMs = computeWatchRecoveryRetryDelayMs(
      this.mcpServerWatchRecoveryFailures,
      this.mcpServerWatchRecoveryRetryAfterMs
    )
    // Retry-After applies to exactly the retry it throttled; the next failure
    // recaptures it (or falls back to the backoff ladder).
    this.mcpServerWatchRecoveryRetryAfterMs = undefined
    this.mcpServerCacheRecoveryTimer = setTimeout(() => {
      this.mcpServerCacheRecoveryTimer = null
      this.attemptMcpServerCacheRecovery()
    }, delayMs)
  }

  private scheduleContextCacheRecovery(): void {
    if (this.stopped || this.contextCacheRecoveryTimer) return
    const delayMs = computeWatchRecoveryRetryDelayMs(
      this.contextWatchRecoveryFailures,
      this.contextWatchRecoveryRetryAfterMs
    )
    this.contextWatchRecoveryRetryAfterMs = undefined
    this.contextCacheRecoveryTimer = setTimeout(() => {
      this.contextCacheRecoveryTimer = null
      this.attemptContextCacheRecovery()
    }, delayMs)
  }

  private installCommunicationChannelSnapshot(snapshot: CommunicationChannelSnapshot): void {
    this.communicationChannels.clear()
    for (const channel of snapshot.channels) {
      this.communicationChannels.set(channel.name, channel)
    }
  }

  private beginCommunicationChannelLifecycleTransition(): number {
    return this.hostFleetScheduler.beginLifecycleTransition()
  }

  private markCommunicationChannelLifecycleApplied(generation: number): void {
    this.hostFleetScheduler.markLifecycleApplied(generation)
  }

  private scheduleCommunicationChannelFleetRetry(request: HostFleetReconcileRequest): void {
    this.hostFleetScheduler.scheduleLifecycleRetry(request)
  }

  /**
   * Rebuild the channel cache from an authoritative list after startup or watch
   * recovery. Until the paired watch is connected, keep stateless eligibility
   * fail-closed; a partial stream cannot prove there are no channels.
   */
  private async recoverCommunicationChannelCache(): Promise<boolean> {
    if (this.stopped) return false
    if (this.ccCacheRecoveryInFlight) return this.ccCacheRecoveryInFlight
    if (this.ccCacheRecoveryTimer) {
      clearTimeout(this.ccCacheRecoveryTimer)
      this.ccCacheRecoveryTimer = null
    }

    const recovery = (async (): Promise<boolean> => {
      this.ccCacheSynced = false
      try {
        const snapshot = await listCommunicationChannelSnapshot()
        if (this.stopped) return false
        const watchGeneration = await this.restartCommunicationChannelWatch(snapshot)
        if (
          this.stopped ||
          watchGeneration !== this.ccWatchGeneration ||
          this.ccWatchRequest === null
        ) {
          return false
        }
        this.ccCacheSynced = true
        const lifecycleGeneration = this.beginCommunicationChannelLifecycleTransition()
        console.log(
          `[K8s] Recovered ${snapshot.channels.length} CommunicationChannel(s) into cache ` +
            '(ccCacheSynced=true)'
        )
        void this.requestHostFleetReconcile('CommunicationChannel recovery', lifecycleGeneration)
        return true
      } catch (error) {
        console.error(
          '[K8s] CommunicationChannel cache recovery failed; stateless lifecycle remains held active:',
          error
        )
        return false
      }
    })()

    this.ccCacheRecoveryInFlight = recovery
    try {
      return await recovery
    } finally {
      if (this.ccCacheRecoveryInFlight === recovery) {
        this.ccCacheRecoveryInFlight = null
      }
      if (!this.stopped && !this.ccCacheSynced) {
        this.scheduleCommunicationChannelCacheRecovery()
      }
    }
  }

  private scheduleCommunicationChannelCacheRecovery(): void {
    if (this.stopped || this.ccCacheRecoveryTimer) return
    this.ccCacheRecoveryTimer = setTimeout(() => {
      this.ccCacheRecoveryTimer = null
      void this.recoverCommunicationChannelCache()
    }, COMMUNICATION_CHANNEL_CACHE_RECOVERY_RETRY_MS)
  }

  private clearAllHostWatchRetries(): void {
    for (const timer of this.hostWatchRetryTimers.values()) clearTimeout(timer)
    this.hostWatchRetryTimers.clear()
    this.hostWatchRetryAttempts.clear()
    this.latestHostWatchEventRevisions.clear()
  }

  private retireHostWatch(): void {
    this.hostCacheSynced = false
    this.hostWatchGeneration += 1
    if (this.hostWatchRequest) {
      this.hostWatchRequest.abort()
      this.hostWatchRequest = null
    }
    this.clearAllHostWatchRetries()
  }

  // Host content identity for the diffing installer and the watch-event bump.
  // Kubernetes bumps metadata.generation only on a spec change (not on the
  // status writes HCC itself makes), and the uid distinguishes a delete+recreate
  // of the same name. Same (uid, generation) = same desired Host state.
  // SCOPE: unlike the McpServer/Context comparators (which hash spec+labels+
  // annotations), this is blind to Host annotations/labels — correct today
  // because no Host annotation/label is load-bearing for a mutation (the wake
  // annotation drives dispatch, not template content). If a Host annotation or
  // label ever becomes mutation-relevant, extend this to hash it, or a
  // reconnect that re-LISTs an unchanged (uid, generation) would skip the bump.
  private sameHostDesiredRevision(previous: HostCRD, current: HostCRD): boolean {
    return previous.uid === current.uid && previous.generation === current.generation
  }

  private hostSnapshotChangesDesiredState(snapshot: HostSnapshot): boolean {
    if (snapshot.hosts.length !== this.hosts.size) return true
    for (const host of snapshot.hosts) {
      const previous = this.hosts.get(host.name)
      if (previous === undefined || !this.sameHostDesiredRevision(previous, host)) return true
    }
    return false
  }

  private installHostSnapshot(snapshot: HostSnapshot): void {
    // Same diffing rule as the Context/McpServer installers: a Premature-close
    // reconnect that re-LISTs the identical Host inventory leaves hostDesiredRevision
    // untouched, so the Host mutation-authority fence no longer starves every
    // queued reconcile with HostInventoryAuthorityUnavailableError under churn.
    if (this.hostSnapshotChangesDesiredState(snapshot)) this.hostDesiredRevision += 1
    this.hosts.clear()
    for (const host of snapshot.hosts) this.hosts.set(host.name, host)
  }

  /**
   * Dedicated, deduplicated Host watch LIST-to-WATCH recovery (§10.2). Watch
   * authority recovers independently of the background fleet convergence pass:
   * concurrent recovery signals reuse the in-flight promise so exactly one LIST
   * + WATCH is installed, and authority is declared known ONLY after the WATCH
   * is established. On success it enqueues discovered new/changed/wake-pending
   * Hosts through their per-Host chains (step 7) and requests — without awaiting
   * — a coalesced background full pass (step 8).
   */
  private recoverHostInventoryAndWatch(
    convergenceReason = 'Host watch recovery convergence',
    ccLifecycleGeneration?: number,
    cause: HostInventoryRecoveryCause = 'watch-recovery'
  ): Promise<HostCRD[]> {
    if (this.stopped) return Promise.resolve([])
    const requested = { convergenceReason, ccLifecycleGeneration, cause }
    // A scheduled retry and an immediate caller are two entrances to the same
    // monotonic recovery intent. Adopt the pending request before choosing or
    // joining the active operation so a direct recovery cannot erase a stronger
    // cold-start cause or newer lifecycle generation when it cancels the timer.
    const request = this.hostCacheRecoveryIntent
      ? { ...this.hostCacheRecoveryIntent }
      : { ...requested }
    if (this.hostCacheRecoveryIntent) {
      mergeHostInventoryRecoveryRequest(request, requested)
      this.hostCacheRecoveryIntent = null
      if (this.hostCacheRecoveryTimer) {
        clearTimeout(this.hostCacheRecoveryTimer)
        this.hostCacheRecoveryTimer = null
      }
    }
    if (this.hostRecoveryInFlight) {
      mergeHostInventoryRecoveryRequest(this.hostRecoveryInFlight.request, request)
      return this.hostRecoveryInFlight.promise
    }
    const recovery = this.performHostInventoryRecovery(request)
    const active = { request, promise: recovery }
    this.hostRecoveryInFlight = active
    const clear = (): void => {
      if (this.hostRecoveryInFlight === active) this.hostRecoveryInFlight = null
    }
    void recovery.then(clear, clear)
    return recovery
  }

  private async performHostInventoryRecovery(
    request: HostInventoryRecoveryRequest
  ): Promise<HostCRD[]> {
    const startedAt = Date.now()
    // Capture the pre-recovery inventory so step 7 can distinguish genuinely
    // new/changed Hosts from ones the fleet pass will converge anyway.
    const previousNames = new Set(this.hosts.keys())
    const previousGenerations = new Map<string, number | undefined>(
      [...this.hosts.values()].map(host => [host.name, host.generation])
    )
    // #827: capture identities so recovery can tell a same-name recreation from
    // a genuine disappearance and reconcile the former rather than delete it.
    const previousUids = new Map<string, string | undefined>(
      [...this.hosts.values()].map(host => [host.name, host.uid])
    )
    this.retireHostWatch()
    try {
      const listStartedAt = Date.now()
      const snapshot = await listHostSnapshot()
      if (this.stopped) return []
      if (!snapshot.resourceVersion) {
        throw new Error('Host snapshot missing resourceVersion')
      }
      hostWatchRecoverySeconds.observe(
        { phase: 'list', outcome: 'success' },
        (Date.now() - listStartedAt) / 1000
      )
      this.installHostSnapshot(snapshot)
      const watchStartedAt = Date.now()
      const watchGeneration = await this.startHostWatch(snapshot.resourceVersion)
      if (
        this.stopped ||
        watchGeneration !== this.hostWatchGeneration ||
        this.hostWatchRequest === null
      ) {
        throw new Error('Host snapshot could not be paired with an active watch')
      }
      // Authority is known ONLY after the WATCH is installed.
      this.hostCacheSynced = true
      this.lastHostWatchRecoveryAt = Date.now()
      this.hostWatchRecoveryFailures = 0
      this.hostWatchRecoveryRetryAfterMs = undefined
      hostWatchRecoverySeconds.observe(
        { phase: 'watch', outcome: 'success' },
        (Date.now() - watchStartedAt) / 1000
      )
      hostWatchRecoverySeconds.observe(
        { phase: 'total', outcome: 'success' },
        (Date.now() - startedAt) / 1000
      )
      // Effect producers can discover newer work while LIST/WATCH recovery is
      // already in flight. Fold that scheduled intent into this successful
      // operation before cancelling its timer so no lifecycle generation,
      // convergence reason, or stronger cold-start cause is discarded.
      if (this.hostCacheRecoveryIntent) {
        mergeHostInventoryRecoveryRequest(request, this.hostCacheRecoveryIntent)
      }
      if (this.hostCacheRecoveryTimer) {
        clearTimeout(this.hostCacheRecoveryTimer)
        this.hostCacheRecoveryTimer = null
      }
      this.hostCacheRecoveryIntent = null
      if (request.cause === 'watch-recovery') {
        this.enqueueRecoveredUrgentHosts(
          snapshot.hosts,
          previousNames,
          previousGenerations,
          previousUids
        )
        // Addendum 4 (#827): a Host present before recovery and absent from the
        // fresh authoritative snapshot genuinely disappeared. Enqueue an immediate
        // per-Host delete cleanup so a DELETE lost to watch retirement is never
        // silently dropped.
        this.enqueueRecoveredHostDeletes(snapshot.hosts, previousNames)
      }
      // Request a coalesced background full pass, but do NOT await it before
      // declaring watch recovery complete. The cold-start pass alone waits for
      // the concurrent SFS LIST: otherwise it can write every Host template
      // without its declared mounts, then immediately roll the fleet again
      // when SFS discovery finishes. NetworkPolicy readiness and start() stay
      // independent from that finite inventory request.
      const requestFleetPass = () => {
        if (this.stopped) return
        void this.requestHostFleetReconcile(
          request.convergenceReason,
          request.ccLifecycleGeneration,
          'full'
        )
      }
      const initialSfsInventory =
        request.cause === 'cold-start' ? this.initialHostFleetSfsInventory : null
      if (initialSfsInventory) {
        // Waiting for the inventory is deliberate: a Host fleet pass without it
        // writes mount-less templates and immediately rerolls the whole fleet.
        // The wait cannot strand the fleet, because the LIST underneath runs on
        // the deadline-bearing client: an apiserver that never answers aborts
        // the request, `startSharedFileSystemInventoryAndWatch` logs and
        // resolves false, and this settles. One path, one pass.
        void initialSfsInventory.then(() => requestFleetPass())
      } else {
        requestFleetPass()
      }
      return snapshot.hosts
    } catch (error) {
      // Keep authority unknown, record the failure, and use the existing
      // bounded retry policy.
      this.hostCacheSynced = false
      hostWatchRecoverySeconds.observe(
        { phase: 'total', outcome: 'failure' },
        (Date.now() - startedAt) / 1000
      )
      if (!this.stopped) {
        this.hostWatchRecoveryFailures += 1
        this.hostWatchRecoveryRetryAfterMs = getRetryAfterMs(error)
        console.error('[K8s] Host watch recovery failed:', error)
        this.scheduleHostCacheRecovery(request)
      }
      throw error
    }
  }

  /**
   * §10.2 step 7: give genuinely new, changed, or wake-pending Hosts immediate
   * per-Host admission after recovery rather than waiting for the background
   * fleet pass. Each dispatch resolves the CURRENT cached Host at execution and
   * enters that Host's serializer, so it is ordered against any concurrent watch
   * event for the same Host.
   */
  private enqueueRecoveredUrgentHosts(
    hosts: HostCRD[],
    previousNames: Set<string>,
    previousGenerations: Map<string, number | undefined>,
    previousUids: Map<string, string | undefined>
  ): void {
    for (const host of hosts) {
      const isNew = !previousNames.has(host.name)
      const previousGeneration = previousGenerations.get(host.name)
      const changed =
        previousGeneration !== undefined &&
        host.generation !== undefined &&
        host.generation !== previousGeneration
      // #827: a same-name Host recreated during the watch gap carries a fresh
      // uid; its generation may even reset to 1 and look "unchanged", so an
      // identity change is itself urgent work.
      const previousUid = previousUids.get(host.name)
      const recreated =
        previousUid !== undefined && host.uid !== undefined && host.uid !== previousUid
      const wakePending = host.annotations?.[WAKE_REQUESTED_ANNOTATION] !== undefined
      if (!isNew && !changed && !recreated && !wakePending) continue
      void this.dispatchUrgentHostReconcile(host.name)
    }
  }

  private async dispatchUrgentHostReconcile(name: string): Promise<void> {
    if (this.stopped) return
    if (!this.admitHostDependentEffects('Recovered urgent Host convergence')) return
    const host = this.hosts.get(name)
    if (!host) return
    try {
      await this.hostReconciler.reconcile(host, 'urgent')
    } catch (error) {
      console.error(`[K8s] Urgent Host reconcile failed for "${name}":`, error)
    }
  }

  /**
   * §10.2 + Addendum 4 (#827): a Host present in the pre-recovery inventory but
   * ABSENT from the fresh authoritative snapshot has genuinely disappeared. An
   * accepted DELETED event invalidated when the watch retired is thereby
   * replaced by this authoritative absence check and never silently lost. Each
   * confirmed deletion is dispatched IMMEDIATELY through its own per-Host chain
   * (reconcileDelete serializes internally) — never queued behind other Hosts'
   * convergence; the compensating full-pass sweep remains only a safety net. A
   * same-name recreation is present in the snapshot by name and so is never in
   * the disappeared set (it is reconciled by enqueueRecoveredUrgentHosts).
   */
  private enqueueRecoveredHostDeletes(hosts: HostCRD[], previousNames: Set<string>): void {
    const snapshotNames = new Set(hosts.map(host => host.name))
    for (const name of previousNames) {
      if (snapshotNames.has(name)) continue // still present (or recreated) → not a disappearance
      hostDeleteCleanupTotal.inc({ outcome: 'queued' })
      void this.dispatchRecoveredHostDelete(name)
    }
  }

  private async dispatchRecoveredHostDelete(name: string): Promise<void> {
    if (this.stopped) return
    if (!this.admitHostDependentEffects('Recovered Host deletion convergence')) return
    // The fresh authoritative LIST already confirmed absence and the cache no
    // longer holds this Host, so cleanup is authorized. Route it through the
    // per-Host serializer (reconcileDelete → serializeByHost) so an older
    // in-flight reconcile for the same Host cannot recreate its resources after
    // cleanup.
    hostDeleteCleanupTotal.inc({ outcome: 'confirmed' })
    try {
      // F2/#827 TOCTOU parity: absence was resolved at LIST time, but the
      // recreation's ADDED can be delivered while the watch replays from the
      // snapshot's resourceVersion — that callback sets `this.hosts`
      // SYNCHRONOUSLY and enters this Host's chain FIRST, while this
      // fire-and-forget dispatch queues the delete SECOND. serializeByHost is
      // strict FIFO, so without this fence the rebuilt bundle (workspace PVC,
      // per-Host RBAC, runtime-token Secret, channel-reader resources,
      // NetworkPolicies) would be created and then wiped. Ownership labels
      // cannot discriminate — the rebuilt bundle carries identical labels — and
      // a name absent from the snapshot has no uid to compare, so live-cache
      // presence AT ADMISSION is the fence, exactly as in the F2 orphan sweep.
      await this.hostReconciler.reconcileDelete(name, config.hostNamespace, {
        skipIf: () => this.hosts.has(name),
      })
      hostDeleteCleanupTotal.inc({ outcome: 'completed' })
    } catch (error) {
      hostDeleteCleanupTotal.inc({ outcome: 'retried' })
      console.error(
        `[K8s] Recovered Host delete cleanup failed for "${name}"; the safety-net sweep will retry:`,
        error
      )
    }
  }

  private scheduleHostCacheRecovery(
    requested: HostInventoryRecoveryRequest = {
      convergenceReason: 'Host watch recovery convergence',
      cause: 'watch-recovery',
    }
  ): void {
    if (this.stopped) return
    if (this.hostCacheRecoveryIntent) {
      mergeHostInventoryRecoveryRequest(this.hostCacheRecoveryIntent, requested)
    } else {
      this.hostCacheRecoveryIntent = { ...requested }
    }
    if (this.hostCacheRecoveryTimer) return
    const delayMs = computeWatchRecoveryRetryDelayMs(
      this.hostWatchRecoveryFailures,
      this.hostWatchRecoveryRetryAfterMs
    )
    this.hostWatchRecoveryRetryAfterMs = undefined
    this.hostCacheRecoveryTimer = setTimeout(() => {
      this.hostCacheRecoveryTimer = null
      const request = this.hostCacheRecoveryIntent ?? requested
      this.hostCacheRecoveryIntent = null
      // Watch recovery is an independent operation, no longer coupled to a full
      // fleet pass. Recovery itself requests the background convergence pass.
      void this.recoverHostInventoryAndWatch(
        request.convergenceReason,
        request.ccLifecycleGeneration,
        request.cause
      ).catch(() => undefined)
    }, delayMs)
  }

  private isCurrentHostWatchEvent(
    type: HostWatchEventType,
    host: HostCRD,
    eventRevision: number
  ): boolean {
    if (this.latestHostWatchEventRevisions.get(host.name) !== eventRevision) return false
    if (type === 'DELETED') return !this.hosts.has(host.name)
    const current = this.hosts.get(host.name)
    if (!current) return false
    // #827 identity fence: a same-name Host that was deleted and recreated
    // carries a fresh metadata.uid. If the cache already holds a DIFFERENT
    // identity for this name, this event describes a superseded object and must
    // not act on the current one. uid complements (never replaces) the
    // generation fence below and the §10.5 fresh read on the cleanup path.
    if (current.uid !== undefined && host.uid !== undefined && current.uid !== host.uid) {
      return false
    }
    if (current.generation === undefined || host.generation === undefined) return true
    return current.generation <= host.generation
  }

  private clearHostWatchRetry(name: string): void {
    const timer = this.hostWatchRetryTimers.get(name)
    if (timer) clearTimeout(timer)
    this.hostWatchRetryTimers.delete(name)
    this.hostWatchRetryAttempts.delete(name)
  }

  private completeHostWatchEvent(name: string, eventRevision: number): void {
    if (this.latestHostWatchEventRevisions.get(name) !== eventRevision) return
    this.clearHostWatchRetry(name)
    this.latestHostWatchEventRevisions.delete(name)
  }

  private async reconcileHostWatchEvent(
    type: HostWatchEventType,
    host: HostCRD,
    eventRevision: number,
    source: HostReconcileSource = 'urgent'
  ): Promise<void> {
    if (this.stopped) return
    if (!this.admitHostDependentEffects('Host watch event convergence')) return
    if (!this.isCurrentHostWatchEvent(type, host, eventRevision)) {
      // #827: a DELETE that is no longer current because the cache now holds a
      // (recreated) same-name Host is a superseded delete — record it and do
      // NOT delete the new identity's resources.
      if (type === 'DELETED' && this.hosts.has(host.name)) {
        hostDeleteCleanupTotal.inc({ outcome: 'superseded' })
      }
      return
    }
    if (type === 'DELETED') {
      await this.hostReconciler.reconcileDelete(host.name, host.namespace)
    } else {
      await this.hostReconciler.reconcile(host, source)
    }
  }

  private scheduleHostWatchReconcileRetry(
    type: HostWatchEventType,
    host: HostCRD,
    eventRevision: number
  ): void {
    if (
      this.stopped ||
      !this.isCurrentHostWatchEvent(type, host, eventRevision) ||
      this.hostWatchRetryTimers.has(host.name)
    ) {
      return
    }
    const attempt = (this.hostWatchRetryAttempts.get(host.name) ?? 0) + 1
    const retryDelay = HOST_WATCH_RECONCILE_RETRY_DELAYS_MS[attempt - 1]
    if (retryDelay === undefined) {
      console.error(
        `[K8s] Host watch reconciliation retry exhausted for ${host.name} after ${HOST_WATCH_RECONCILE_RETRY_DELAYS_MS.length} attempts`
      )
      this.completeHostWatchEvent(host.name, eventRevision)
      return
    }

    this.hostWatchRetryAttempts.set(host.name, attempt)
    console.warn(
      `[K8s] Scheduling Host watch reconciliation retry ${attempt}/${HOST_WATCH_RECONCILE_RETRY_DELAYS_MS.length} ` +
        `for ${host.name} in ${retryDelay}ms`
    )
    const timer = setTimeout(() => {
      this.hostWatchRetryTimers.delete(host.name)
      void this.retryHostWatchReconcile(type, host, eventRevision)
    }, retryDelay)
    this.hostWatchRetryTimers.set(host.name, timer)
  }

  private async retryHostWatchReconcile(
    type: HostWatchEventType,
    host: HostCRD,
    eventRevision: number
  ): Promise<void> {
    if (this.stopped || !this.isCurrentHostWatchEvent(type, host, eventRevision)) {
      this.completeHostWatchEvent(host.name, eventRevision)
      return
    }
    try {
      // F1: a retry is a distinct reconcile lane from first-attempt load — an
      // operator must be able to tell a retry storm from fresh admission.
      await this.reconcileHostWatchEvent(type, host, eventRevision, 'retry')
      this.completeHostWatchEvent(host.name, eventRevision)
    } catch (error) {
      console.error(`[K8s] Host watch reconciliation retry failed for ${host.name}:`, error)
      this.scheduleHostWatchReconcileRetry(type, host, eventRevision)
    }
  }

  private performHostFleetReconcile(request: HostFleetReconcileRequest): Promise<void> {
    return this.performHostFleetReconcileOnce(request)
  }

  private async performHostFleetReconcileOnce(request: HostFleetReconcileRequest): Promise<void> {
    if (this.stopped) return
    const { reason, mode, ccLifecycleGeneration } = request
    if (
      mode === 'lifecycle' &&
      ccLifecycleGeneration !== undefined &&
      ccLifecycleGeneration !== this.ccLifecycleGeneration
    ) {
      return
    }
    try {
      // Watch authority recovers as an independent, deduplicated operation. A
      // fleet pass only needs to ensure the LIST -> WATCH is established when
      // continuity was lost; it never drives the watch restart on every pass
      // (that would re-LIST forever). Recovery, once synced, requests its own
      // background convergence pass.
      if (!this.hostCacheSynced) {
        await this.recoverHostInventoryAndWatch()
        if (this.stopped) return
      }
      if (!this.isHostEffectInventoryAuthoritative()) return
      // Reconcile the CURRENT cache. Fleet workers dispatch Host keys and
      // resolve the freshest cached spec at execution (see collectHostReconcile
      // Failures); only fullReconcile runs the authority-gated orphan cleanup.
      const hosts = [...this.hosts.values()]
      if (mode === 'full') {
        console.log(`[K8s] Reconciling ${hosts.length} Host(s) after ${reason}`)
        await this.hostReconciler.fullReconcile(hosts)
      } else {
        if (
          this.stopped ||
          (ccLifecycleGeneration !== undefined &&
            ccLifecycleGeneration !== this.ccLifecycleGeneration)
        ) {
          return
        }
        console.log(`[K8s] Reconciling ${hosts.length} Host(s) for lifecycle after ${reason}`)
        await this.hostReconciler.reconcileHosts(hosts)
      }
      if (!this.stopped) {
        if (ccLifecycleGeneration !== undefined) {
          this.markCommunicationChannelLifecycleApplied(ccLifecycleGeneration)
        }
        console.log(`[K8s] Completed Host reconciliation after ${reason}`)
      }
    } catch (error) {
      hostFleetRequestsTotal.inc({ result: 'failed' })
      console.error(`[K8s] Host reconciliation after ${reason} failed:`, error)
      if (!this.stopped && ccLifecycleGeneration !== undefined) {
        if (error instanceof HostFleetReconcileError && error.hostFailures.length === 0) {
          this.markCommunicationChannelLifecycleApplied(ccLifecycleGeneration)
        } else {
          // Retry Host convergence without coupling the lifecycle ladder to
          // orphan cleanup. A later periodic full pass retries cleanup work.
          this.scheduleCommunicationChannelFleetRetry({
            ...request,
            mode: error instanceof HostFleetReconcileError ? 'lifecycle' : request.mode,
          })
        }
      }
    } finally {
      // The paired watch can end while fullReconcile is still active. Its
      // timer may then be coalesced into this same pass, so every exit must
      // re-arm recovery while inventory continuity remains unknown.
      if (!this.stopped && !this.hostCacheSynced) {
        this.scheduleHostCacheRecovery()
      }
    }
  }

  /**
   * Cache transitions, periodic resyncs, and retries can request a fleet pass
   * concurrently. Generic and covered same-generation requests reuse existing
   * work; a full inventory pass queues behind lifecycle-only work when needed.
   * Only the latest newer lifecycle generation may occupy one trailing slot.
   * Each caller waits only for the pass that covers its request, so startup
   * cannot be extended forever by a sustained retry stream.
   */
  private requestHostFleetReconcile(
    reason: string,
    ccLifecycleGeneration?: number,
    mode?: HostFleetReconcileMode
  ): Promise<void> {
    return this.hostFleetScheduler.request(reason, ccLifecycleGeneration, mode)
  }

  private contextsReferencingSfs(sfsName: string): Array<{ namespace: string; name: string }> {
    const out: Array<{ namespace: string; name: string }> = []
    for (const ctx of this.contexts.values()) {
      if (ctx.spec.sharedFileSystems?.some(r => r.name === sfsName)) {
        out.push({ namespace: ctx.namespace, name: ctx.name })
      }
    }
    return out
  }

  /**
   * Count CommunicationChannels whose spec.hostRef matches the given host name.
   *
   * Wired into HostReconciler via setCountCommunicationChannels so
   * buildChannelReaderDeployment can drive per-Host channel-reader Deployment
   * replicas based on whether the Host has any active channels (#281).
   *
   * Returns 0 for unknown hosts — safe fallback when:
   *   - CC ADDED event arrives before its Host CRD is in HCC's cache (race;
   *     fullReconcile will catch up on next cycle).
   *   - Host has genuinely no CCs (the intended scale-to-0 case).
   */
  countCommunicationChannels(hostName: string): number {
    let n = 0
    for (const cc of this.communicationChannels.values()) {
      if (cc.spec.hostRef === hostName) n++
    }
    return n
  }

  /**
   * Return all CCs whose spec.credentialsSecretRef.name matches the given
   * Secret name. Used by HCC's channels-ns SecretInformer to find which
   * per-Host channel-reader Deployments to annotation-roll on rotation.
   * Order undefined; callers must sort if they care.
   */
  findCommunicationChannelsByCredentialsSecretName(name: string): CommunicationChannelCRD[] {
    const out: CommunicationChannelCRD[] = []
    for (const cc of this.communicationChannels.values()) {
      if (cc.spec.credentialsSecretRef?.name === name) out.push(cc)
    }
    return out
  }

  /**
   * Return all CCs whose spec.hostRef matches. Used by the CC informer
   * handler to figure out which channel-reader Deployment to annotation-roll
   * on rebind (old host) AND newly-arrived CC (new host).
   */
  findCommunicationChannelsByHostRef(hostRef: string): CommunicationChannelCRD[] {
    const out: CommunicationChannelCRD[] = []
    for (const cc of this.communicationChannels.values()) {
      if (cc.spec.hostRef === hostRef) out.push(cc)
    }
    return out
  }

  private reconcileSharedFileSystemsReferencedByContext(
    prevContext: ContextCRD | undefined,
    nextContext: ContextCRD | undefined,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    const names = [
      ...(prevContext?.spec.sharedFileSystems ?? []).map(ref => ref.name),
      ...(nextContext?.spec.sharedFileSystems ?? []).map(ref => ref.name),
    ]
    return this.enqueueSharedFileSystemFleetReconciliation(names, async () => {
      if (!isCurrent()) return
      await this.reconcileSharedFileSystemsReferencedByContextCore(
        prevContext,
        nextContext,
        isCurrent
      )
    })
  }

  private async reconcileSharedFileSystemsReferencedByContextCore(
    prevContext: ContextCRD | undefined,
    nextContext: ContextCRD | undefined,
    isCurrent: () => boolean
  ): Promise<void> {
    const names = new Set<string>()
    for (const r of prevContext?.spec.sharedFileSystems ?? []) names.add(r.name)
    for (const r of nextContext?.spec.sharedFileSystems ?? []) names.add(r.name)
    for (const name of names) {
      if (!isCurrent()) return
      const sfs = this.sharedFileSystems.get(name)
      if (!sfs) continue
      try {
        await this.sharedFileSystemReconciler.reconcile(sfs)
      } catch (err) {
        console.error(`[K8s] SFS re-reconcile after Context change failed for "${name}":`, err)
      }
    }
  }

  /**
   * Find every Host whose Context declares a reference to the given
   * SharedFileSystem and trigger a fresh reconcile so the mcp-host
   * Deployment template picks up (or drops) the volume + volumeMount.
   */
  private async reconcileHostsReferencingSfs(sfsName: string): Promise<void> {
    if (!this.admitHostDependentEffects(`SharedFileSystem "${sfsName}" Host convergence`)) {
      return
    }
    const affectedContexts = new Set<string>()
    for (const ctx of this.contexts.values()) {
      if (ctx.spec.sharedFileSystems?.some(r => r.name === sfsName)) {
        affectedContexts.add(ctx.name)
      }
    }
    if (affectedContexts.size === 0) return
    for (const host of this.hosts.values()) {
      if (!affectedContexts.has(host.spec.contextRef)) continue
      try {
        await this.hostReconciler.reconcile(host)
      } catch (err) {
        console.error(`[K8s] Host re-reconcile failed for "${host.name}":`, err)
      }
    }
  }

  /**
   * Reconcile Hosts affected by a Context change only while the Host cache is
   * authoritative. A recovery full pass consumes the current Context cache, so
   * deferral loses no effect and never acts on an unpaired Host LIST.
   */
  private async reconcileHostsReferencingContext(
    contextName: string,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    if (!isCurrent()) return
    if (!this.admitHostDependentEffects(`Context "${contextName}" Host convergence`)) return
    for (const host of this.hosts.values()) {
      if (!isCurrent()) return
      if (host.spec.contextRef !== contextName) continue
      await this.hostReconciler.reconcile(host)
    }
  }

  /**
   * Re-reconcile the Host whose name matches the given hostRef. Called by the
   * CommunicationChannel watch handler so per-Host channel-reader Deployment
   * replicas converge to the new CC count (#281).
   *
   * No-op when the Host is unknown (CC arrived before Host CRD, or for a
   * Host that has been deleted). The next fullReconcile recovers.
   *
   * Errors are logged and reported as `false` so the watch remains alive while
   * its caller schedules bounded fleet convergence.
   */
  private async reconcileHostsReferencingCC(hostRef: string): Promise<boolean> {
    if (!this.admitHostDependentEffects(`CommunicationChannel Host "${hostRef}" convergence`)) {
      return false
    }
    const host = this.hosts.get(hostRef)
    if (!host) return true
    try {
      await this.hostReconciler.reconcile(host)
      return true
    } catch (err) {
      console.error(`[K8s] Host re-reconcile after CC change failed for "${host.name}":`, err)
      return false
    }
  }

  /**
   * Resolve `host.spec.contextRef → context.spec.sharedFileSystems[] →
   * SharedFileSystem PVC name` from the in-process informer caches. Returns
   * one entry per SharedFileSystem ref the Context declares; entries with
   * no matching SharedFileSystem CRD are skipped (and logged) so the pod
   * can still come up while the operator catches up.
   */
  /**
   * True iff the Host's referenced Context fronts at least one ENABLED
   * `auth.type: oauth` mcp-server. HostReconciler uses this to gate the
   * derive-only `oauth:user-token` runtime scope. Reads the same
   * Context-scoped allow-list projection (`getServerInfosByContext`, which
   * already filters to enabled + allowed servers) that mcp-host discovery uses,
   * so HCC does not need a second cross-CRD read path. HostReconciler wraps this
   * call in a fail-closed guard, so a thrown read there yields no oauth scope.
   */
  private async hostFrontsOAuthServer(host: HostCRD): Promise<boolean> {
    const servers = await this.getServerInfosByContext(host.spec.contextRef)
    return servers.some(server => server.enabled && server.auth?.type === 'oauth')
  }

  private async resolveContextMounts(host: HostCRD): Promise<ResolvedSfsMount[]> {
    const context = this.contexts.get(host.spec.contextRef)
    const refs = context?.spec.sharedFileSystems ?? []
    if (refs.length === 0) return []
    const out: ResolvedSfsMount[] = []
    for (const ref of refs) {
      const sfs = this.sharedFileSystems.get(ref.name)
      if (!sfs) {
        console.warn(
          `[K8s] Context "${host.spec.contextRef}" references SharedFileSystem ` +
            `"${ref.name}" which is not yet known to HCC; skipping mount for now`
        )
        continue
      }
      // #592: only mount once the SFS PVC is Bound (the volume is provisioned and
      // its node is determined). Under WaitForFirstConsumer a Bound PVC means the
      // wfc — the first consumer — has already been scheduled, so the podAffinity
      // term (added in buildDeployment) has a target node and the RWO mount is
      // valid from the co-located node; mounting before the PVC binds would leave
      // the mcp-host Pending or risk a cross-node mount failure.
      //
      // Gating on Bound — NOT on phase==='Ready' — is deliberate: the mcp-host
      // mounts the PVC directly read-only and never talks to the wfc HTTP server,
      // so a transient wfc restart (readyReplicas→0, phase flips to Initializing/
      // Degraded while the PVC stays Bound) must NOT rip the mount out of a
      // running consumer pod. The mount is therefore RETAINED across wfc blips and
      // only dropped when the volume is genuinely unusable (PVC not Bound) or the
      // Context stops referencing the SFS. The not-mountable→mountable transition
      // re-reconciles the Host (reconcileHostsReferencingSfs / periodic resync).
      if (
        !this.sharedFileSystemReconciler.isMountable({ name: sfs.name, namespace: sfs.namespace })
      ) {
        const phase = this.sharedFileSystemReconciler.getStatus({
          name: sfs.name,
          namespace: sfs.namespace,
        }).phase
        console.log(
          `[K8s] SharedFileSystem "${ref.name}" PVC is not Bound yet (phase=${phase ?? 'unknown'}); ` +
            `deferring RO mount for Host "${host.name}" until the volume binds`
        )
        continue
      }
      out.push({
        name: sfs.name,
        namespace: sfs.namespace,
        pvcName: sfsPvcName(sfs),
        mountPath: ref.mountPath,
      })
    }
    return out
  }

  /**
   * Get the SharedFileSystem reconciler — exposed so the host reconciler
   * (when it lands in the next commit) can resolve PVC names by SFS name
   * without a fresh K8s round-trip.
   */
  getSharedFileSystemReconciler(): SharedFileSystemReconciler {
    return this.sharedFileSystemReconciler
  }

  /**
   * Get the host reconciler (for server-level desktop checks).
   */
  getHostReconciler(): HostReconciler {
    return this.hostReconciler
  }

  /**
   * Look up a cached Host CRD by name (Stage 3: the stateless lifecycle
   * tracker resolves the heartbeat's hostRef through this).
   */
  getHost(name: string): HostCRD | undefined {
    if (!this.isHostInventoryAuthoritative()) return undefined
    return this.hosts.get(name)
  }

  /**
   * Route channel credentials-Secret events through the same Host authority
   * boundary as watch, Context, SFS, and heartbeat effects.
   */
  async reconcileChannelReaderRevision(secretName: string, secretNamespace: string): Promise<void> {
    const convergenceReason = `CommunicationChannel Secret "${secretNamespace}/${secretName}" Host convergence`
    if (!this.ccCacheSynced) {
      console.warn(
        `[K8s] Deferring ${convergenceReason}; CommunicationChannel cache is not authoritative`
      )
      return
    }
    if (!this.admitHostDependentEffects(convergenceReason)) {
      return
    }
    await this.hostReconciler.reconcileChannelReaderRevision(secretName, secretNamespace)
  }

  /**
   * Trigger a reconcile for any cached McpServer whose `envSecret.name`
   * matches the given Secret. Used by SecretInformer to react to Secret
   * lifecycle changes (create/update/delete) without waiting for a CRD
   * event.
   */
  async reconcileByEnvSecret(secretName: string, secretNamespace: string): Promise<void> {
    const inventoryGeneration = this.mcpWatchGeneration
    if (!this.hasMcpServerInventoryAuthority(inventoryGeneration)) return
    const selected = [...this.servers.values()].filter(
      server => server.namespace === secretNamespace && server.spec.envSecret?.name === secretName
    )
    await Promise.all(
      selected.map(server =>
        this.enqueueMcpServerReconciliation(server, async () => {
          if (!this.hasMcpServerInventoryAuthority(inventoryGeneration)) return
          const current = this.servers.get(server.name)
          if (
            !current ||
            current.namespace !== secretNamespace ||
            current.spec.envSecret?.name !== secretName
          ) {
            return
          }
          try {
            console.log(
              `[K8s] Re-reconciling McpServer "${current.name}" after Secret "${secretName}" change`
            )
            await this.reconciler.reconcile(current, {
              isCurrent: () => {
                if (!this.hasMcpServerInventoryAuthority(inventoryGeneration)) return false
                const latest = this.servers.get(current.name)
                return (
                  latest !== undefined &&
                  latest.namespace === secretNamespace &&
                  latest.spec.envSecret?.name === secretName &&
                  sameMcpServerDesiredRevision(current, latest)
                )
              },
            })
          } catch (err) {
            console.error(`[K8s] Secret-triggered reconcile failed for "${current.name}":`, err)
          }
        })
      )
    )
  }

  /**
   * Trigger a reconcile for any cached image `LlmHook` whose `envSecret` matches
   * the changed Secret (spec §8.2). A rotation (same name, new contents) leaves
   * the pod key unchanged but re-stamps the credentials-revision on the pod
   * template → rolling restart onto the new credential — mirroring
   * `reconcileByEnvSecret` for McpServer. Driven by the llm-hooks SecretInformer.
   */
  async reconcileLlmHookByEnvSecret(secretName: string, secretNamespace: string): Promise<void> {
    if (secretNamespace !== config.llmHooksNamespace) return
    for (const hook of this.llmHooks.values()) {
      if (hook.spec.target?.image?.envSecret !== secretName) continue
      try {
        console.log(
          `[K8s] Re-reconciling LlmHook "${hook.name}" after Secret "${secretName}" change`
        )
        // Pod key is unchanged by a contents-only rotation, so pass it as the
        // previous key (no stale-workload teardown) — the reconcile re-stamps the
        // credentials-revision and rolls the shared pod.
        await this.llmHookReconciler.reconcile(hook, computePodKey(hook))
      } catch (err) {
        console.error(`[K8s] Secret-triggered LlmHook reconcile failed for "${hook.name}":`, err)
      }
    }
  }

  /**
   * Get all cached servers.
   */
  getAllServers(): McpServerCRD[] {
    return [...this.servers.values()]
  }

  /**
   * Convert a CRD into curated McpServerInfo (strips deployment internals, adds status).
   */
  private toServerInfo(server: McpServerCRD): McpServerInfo {
    // Managed stdio servers are deployed with the stdio-bridge sidecar, which
    // exposes StreamableHTTP on the transport port. Report streamableHttp to
    // mcp-host so it uses the correct client transport to connect.
    const transport = { ...server.spec.transport }
    if (transport.type === 'stdio' && server.spec.managed !== false) {
      transport.type = 'streamableHttp'
    }
    return {
      name: server.name,
      description: server.spec.description,
      contextRef: server.spec.contextRef,
      transport,
      auth: server.spec.auth,
      // Project the OAuth block (grantScope etc.) verbatim so mcp-host can
      // dispatch the per-connection partition. Token is NEVER mounted (O4).
      oauth: server.spec.oauth,
      enabled: server.spec.enabled !== false,
      status: this.reconciler.getStatus(server),
    }
  }

  /**
   * Get curated server info for all servers (for API consumers).
   */
  getAllServerInfos(): McpServerInfo[] {
    return this.getAllServers().map(s => this.toServerInfo(s))
  }

  /**
   * Get curated server info filtered by context (for API consumers).
   * Reads the Context CRD to determine which McpServers are allowed.
   */
  async getServerInfosByContext(contextRef: string): Promise<McpServerInfo[]> {
    const context = await getContext(contextRef)

    if (!context) {
      console.warn(`[Provider] Context "${contextRef}" not found — returning no servers`)
      return []
    }

    const allowedNames = new Set(context.spec.mcpServers)
    console.log(
      `[Provider] Context "${contextRef}" allows servers: [${context.spec.mcpServers.join(', ')}]`
    )

    return this.getAllServers()
      .filter(s => allowedNames.has(s.name) && s.spec.enabled !== false)
      .map(s => this.toServerInfo(s))
  }

  /**
   * Set callback for when servers change.
   */
  onChange(callback: () => void): void {
    this.changeCallback = callback
  }

  /**
   * Start watching for changes and run initial reconciliation.
   */
  async start(): Promise<void> {
    // L0/L1 isolation and removal of legacy permissive policies are mandatory
    // bootstrap barriers. They are a fixed-size safety operation, independent
    // of fleet size, and must succeed before HCC can watch or reconcile runtimes.
    await this.netPolReconciler.ensureDefaultPolicies()

    // Discovery and policy caches become authoritative only when each complete
    // LIST snapshot is paired with a watch continuing from its opaque collection
    // resourceVersion. Full fleet convergence happens later in the background.
    // A transient LIST/WATCH failure on either inventory must not kill the
    // retry that restart*Watch already armed (it sets *CacheSynced=false before
    // it can throw). Mirror the Host lane below: log, keep the flag false, and
    // schedule in-process recovery. The HTTP server stays live, dynamic
    // readiness stays 503, and recovery promotes readiness only after a fresh
    // LIST is paired with its continuing WATCH.
    try {
      const initialServerSnapshot = await listMcpServerSnapshot()
      await this.restartMcpServerWatch(initialServerSnapshot)
    } catch (error) {
      this.mcpServerCacheSynced = false
      console.error(
        '[K8s] Initial McpServer inventory is unavailable; HCC remains unready while in-process recovery continues:',
        error
      )
    }
    if (!this.mcpServerCacheSynced) {
      this.scheduleMcpServerCacheRecovery()
    }

    try {
      const initialContextSnapshot = await listContextSnapshot()
      await this.restartContextWatch(initialContextSnapshot)
    } catch (error) {
      this.contextCacheSynced = false
      console.error(
        '[K8s] Initial Context inventory is unavailable; HCC remains unready while in-process recovery continues:',
        error
      )
    }
    if (!this.contextCacheSynced) {
      this.scheduleContextCacheRecovery()
    }

    // Host templates resolve Context SharedFileSystem references from this
    // cache. Inventory is therefore a fixed startup boundary, not part of the
    // unbounded SFS reconciliation fleet: letting the first Host pass run
    // without it writes mount-less templates and immediately rolls the entire
    // Host fleet a second time once discovery catches up.
    const initialSharedFileSystemInventory = this.startSharedFileSystemInventoryAndWatch()
    this.initialHostFleetSfsInventory = initialSharedFileSystemInventory

    // ── CommunicationChannel snapshot + watch — MUST complete before Host fullReconcile ──
    // A stateless Host may suspend only after this controller has a complete
    // CommunicationChannel snapshot and a watch continuing from that snapshot's
    // resourceVersion. A raw watch cannot prove it saw pre-existing channels.
    let initialCCSnapshot: CommunicationChannelSnapshot | undefined
    try {
      initialCCSnapshot = await listCommunicationChannelSnapshot()
      this.installCommunicationChannelSnapshot(initialCCSnapshot)
    } catch (error) {
      console.error(
        '[K8s] CommunicationChannel initial load failed; ccCacheSynced remains false ' +
          '(B2 preserves channel-reader replicas and holds stateless lifecycle active):',
        error
      )
    }
    try {
      const watchGeneration = await this.startCommunicationChannelWatch(
        initialCCSnapshot?.resourceVersion
      )
      if (
        initialCCSnapshot?.resourceVersion &&
        watchGeneration === this.ccWatchGeneration &&
        this.ccWatchRequest !== null
      ) {
        this.ccCacheSynced = true
        console.log(
          `[K8s] Loaded ${initialCCSnapshot.channels.length} CommunicationChannel(s) into cache ` +
            '(ccCacheSynced=true)'
        )
      } else if (initialCCSnapshot) {
        console.error(
          '[K8s] CommunicationChannel snapshot could not be paired with an active watch; ' +
            'ccCacheSynced remains false'
        )
      }
    } catch (error) {
      this.ccCacheSynced = false
      console.error(
        '[K8s] CommunicationChannel watch failed to start; ccCacheSynced remains false:',
        error
      )
    }
    if (!this.ccCacheSynced) {
      this.scheduleCommunicationChannelCacheRecovery()
    }

    console.log(
      `[K8s] Starting initial Host background convergence... (ccCacheSynced=${this.ccCacheSynced})`
    )
    const initialLifecycleGeneration =
      this.ccLifecycleGeneration === 0
        ? this.beginCommunicationChannelLifecycleTransition()
        : this.ccLifecycleGeneration
    try {
      await this.recoverHostInventoryAndWatch(
        'initial Host reconciliation',
        initialLifecycleGeneration,
        'cold-start'
      )
    } catch (error) {
      // Host inventory is an essential readiness authority, but a transient
      // LIST/WATCH failure must not kill the retry that recovery just armed.
      // Continue startup with hostCacheSynced=false: the HTTP server stays live,
      // dynamic readiness remains 503, and recovery promotes readiness only
      // after a fresh LIST is paired with its continuing WATCH.
      console.warn(
        '[K8s] Initial Host inventory is unavailable; HCC remains unready while in-process recovery continues:',
        error
      )
    }

    // ── LlmHook initial load + reconciliation (guardrails phase-4) ──
    // Runs AFTER the Host cache is populated so the shared hook pods' NetworkPolicy
    // ingress reflects the current Host→LlmHook reverse index on the first pass.
    // The GFS lane and the four pre-existing watches moved to dev's per-resource
    // background lanes (startGlobalFileSystemBackgroundLane and friends); only the
    // LlmHook lane is new here, so only it survives this merge.
    try {
      const initialHooks = await listAllLlmHooks()
      for (const hook of initialHooks) {
        this.llmHooks.set(hook.name, hook)
      }
      console.log('[K8s] Running initial LlmHook reconciliation...')
      await this.llmHookReconciler.fullReconcile(initialHooks)
    } catch (error) {
      console.error(
        '[K8s] Skipping initial LlmHook reconciliation because discovery failed:',
        error
      )
    }
    await this.startLlmHookWatch()

    const resyncSec = config.hostResyncIntervalSec
    if (resyncSec > 0) {
      this.resyncTimer = setInterval(() => {
        void this.runHostResync()
      }, resyncSec * 1000)
      console.log(`[K8s] Host periodic resync enabled (every ${resyncSec}s)`)
    } else {
      console.warn(
        '[K8s] Host periodic resync disabled; runtime-auth degraded mcp-host pods will not self-heal through controller-driven rollout unless another Host event triggers reconciliation.'
      )
    }

    const sfsResyncSec = config.sfsResyncIntervalSec
    if (sfsResyncSec > 0) {
      this.sfsResyncTimer = setInterval(() => {
        void this.runSfsResync()
      }, sfsResyncSec * 1000)
      console.log(`[K8s] SharedFileSystem periodic resync enabled (every ${sfsResyncSec}s)`)
    } else {
      console.warn(
        '[K8s] SharedFileSystem periodic resync disabled; a SharedFileSystem stuck in Initializing/Degraded will not auto-recover to Ready until another SFS event triggers reconciliation (#592).'
      )
    }

    const llmHookResyncSec = config.llmHookResyncIntervalSec
    if (llmHookResyncSec > 0) {
      this.llmHookResyncTimer = setInterval(() => {
        void this.runLlmHookResync()
      }, llmHookResyncSec * 1000)
      console.log(`[K8s] LlmHook periodic resync enabled (every ${llmHookResyncSec}s)`)
    } else {
      console.warn(
        '[K8s] LlmHook periodic resync disabled; label-orphaned hook workloads will not be swept until another LlmHook event triggers reconciliation.'
      )
    }

    const gfsResyncSec = config.gfsResyncIntervalSec
    if (gfsResyncSec > 0) {
      this.gfsResyncTimer = setInterval(() => {
        void this.runGfsResync()
      }, gfsResyncSec * 1000)
      console.log(`[K8s] GlobalFileSystem periodic resync enabled (every ${gfsResyncSec}s)`)
    } else {
      console.warn(
        '[K8s] GlobalFileSystem periodic resync disabled; a GlobalFileSystem stuck in Initializing will not auto-recover to Ready (nor seed its root directories) until another gfs event triggers reconciliation.'
      )
    }

    const externalEgressResyncSec = config.externalEgressResyncIntervalSec
    // #205 delegates external-egress periodic resync to the convergence
    // coordinator. Its runResyncCore drives reconcileExternalEgress, so the
    // #299 sliding-window accumulation still converges on DNS rotation between
    // McpServer events. The coordinator owns cadence with a self-rescheduling
    // timer that advances to <= observed TTL/2 (H2, issue #299), bounded by the
    // configured floor.
    this.externalEgressCoordinator.startPeriodicResync(
      externalEgressResyncSec,
      config.externalEgressRefreshFloorSec
    )

    // Full convergence is observable and retains each lane's existing retry or
    // periodic-resync contract, but it no longer extends provider.start().
    // NetworkPolicy safety starts first and launches McpServer convergence from
    // its certification callback, before additive policy convergence completes.
    // This prevents the startup egress refresh from racing or undoing the safety
    // pass while keeping readiness independent from both additive fleets.
    void this.runInitialNetworkPolicyConvergence()
    void initialSharedFileSystemInventory.then(inventoryComplete => {
      if (inventoryComplete && !this.stopped) {
        void this.runInitialSharedFileSystemConvergence()
      }
    })
    void this.startGlobalFileSystemBackgroundLane()
  }

  private async startSharedFileSystemInventoryAndWatch(): Promise<boolean> {
    let inventoryComplete = false
    try {
      const initialSfses = await listAllSharedFileSystems()
      inventoryComplete = true
      for (const sfs of initialSfses) this.sharedFileSystems.set(sfs.name, sfs)
    } catch (error) {
      console.error(
        '[K8s] Skipping initial SharedFileSystem background convergence because discovery failed:',
        error
      )
    }
    // The cold-start Host fleet pass gates on this promise, so it must settle on
    // the inventory alone. `k8s.Watch` carries no transport deadline — the
    // client builds `AbortSignal.any([controller, timeout])` and then overwrites
    // it with the bare controller — so awaiting the watch start here would
    // re-strand the fleet behind an already-certified readiness, which is the
    // exact failure bounding the LIST was meant to close.
    void this.startSharedFileSystemWatch().catch(error => {
      console.error('[K8s] SharedFileSystem background watch failed to start:', error)
      this.scheduleSharedFileSystemWatchRestart(5000)
    })
    if (inventoryComplete && !this.stopped) {
      return true
    }
    return false
  }

  private async startGlobalFileSystemBackgroundLane(): Promise<void> {
    let inventoryComplete = false
    try {
      const initialGfses = await listAllGlobalFileSystems()
      inventoryComplete = true
      for (const gfs of initialGfses) this.globalFileSystems.set(gfs.name, gfs)
    } catch (error) {
      console.error(
        '[K8s] Skipping initial GlobalFileSystem background convergence because discovery failed:',
        error
      )
    }
    try {
      await this.startGlobalFileSystemWatch()
    } catch (error) {
      console.error('[K8s] GlobalFileSystem background watch failed to start:', error)
      this.scheduleGlobalFileSystemWatchRestart(5000)
    }
    if (inventoryComplete && !this.stopped) {
      void this.runInitialGlobalFileSystemConvergence()
    }
  }

  private runInitialMcpServerConvergence(): Promise<void> {
    return this.runInitialConvergence('McpServer')
  }

  private currentNetworkPolicySafetyCertificate(): NetworkPolicySafetyCertificate | null {
    if (
      this.stopped ||
      !this.contextCacheSynced ||
      !this.mcpServerCacheSynced ||
      !this.netPolReconciler.hasCertifiedSafetyInventory() ||
      // Content identity, not channel identity — see isReadinessInventoryAuthoritative.
      this.networkPolicyRevocationContextRevision !== this.contextDesiredRevision ||
      this.networkPolicyRevocationServerRevision !== this.mcpServerDesiredRevision
    ) {
      return null
    }
    return {
      contextGeneration: this.contextWatchGeneration,
      serverGeneration: this.mcpWatchGeneration,
      contextRevision: this.contextDesiredRevision,
      serverRevision: this.mcpServerDesiredRevision,
    }
  }

  private recordNetworkPolicySafetyCertificate(
    certificate: NetworkPolicySafetyCertificate
  ): boolean {
    if (
      this.stopped ||
      !this.contextCacheSynced ||
      !this.mcpServerCacheSynced ||
      // Content identity, not channel identity — a Premature-close reconnect
      // that re-LISTs the same inventory must not invalidate this certificate.
      this.contextDesiredRevision !== certificate.contextRevision ||
      this.mcpServerDesiredRevision !== certificate.serverRevision
    ) {
      return false
    }
    this.networkPolicyRevocationContextRevision = certificate.contextRevision
    this.networkPolicyRevocationServerRevision = certificate.serverRevision
    return true
  }

  private isNetworkPolicySafetyCertificateCurrent(
    certificate: NetworkPolicySafetyCertificate
  ): boolean {
    const current = this.currentNetworkPolicySafetyCertificate()
    return (
      current !== null &&
      // Content identity, not channel identity — see isReadinessInventoryAuthoritative.
      current.contextRevision === certificate.contextRevision &&
      current.serverRevision === certificate.serverRevision
    )
  }

  private async runInitialMcpServerConvergenceCore(): Promise<void> {
    const safetyCertificate = this.currentNetworkPolicySafetyCertificate()
    if (safetyCertificate === null) return
    const inventoryGeneration = this.mcpWatchGeneration
    const inventoryAuthoritative = () =>
      this.hasMcpServerInventoryAuthority(inventoryGeneration) &&
      this.isNetworkPolicySafetyCertificateCurrent(safetyCertificate)
    try {
      const initialServers = [...this.servers.values()]
      const initialExternalEgressGates = this.externalEgressCoordinator.prepareStartupGates(
        initialServers,
        inventoryAuthoritative
      )
      if (this.stopped) return
      console.log('[K8s] Running initial McpServer background reconciliation...')
      await this.reconciler.fullReconcile(initialServers, {
        runEffect: async (serverName, work) => {
          const selected = this.servers.get(serverName)
          const laneOwner = selected ?? {
            name: serverName,
            namespace: config.namespace,
          }
          if (!(await initialExternalEgressGates.waitFor(laneOwner))) return
          if (!inventoryAuthoritative()) return
          await this.enqueueMcpServerReconciliation(laneOwner, async () => {
            if (!inventoryAuthoritative()) return
            await work()
          })
        },
      })
      if (!inventoryAuthoritative()) return
      initialConvergenceLastSuccessTimestampSeconds.set({ lane: 'McpServer' }, Date.now() / 1000)
      this.clearInitialConvergenceRetry('McpServer')
    } catch (error) {
      console.error('[K8s] Initial McpServer background reconciliation failed:', error)
      this.scheduleInitialConvergenceRetry('McpServer')
    }
  }

  private runInitialNetworkPolicyConvergence(): Promise<void> {
    return this.runInitialConvergence('NetworkPolicy')
  }

  private runInitialConvergence(lane: InitialConvergenceLane): Promise<void> {
    const active = this.initialConvergenceRuns.get(lane)
    if (active) {
      active.trailingRequested = true
      return active.promise
    }

    const run: ActiveInitialConvergenceRun = {
      trailingRequested: false,
      promise: Promise.resolve(),
    }
    this.initialConvergenceRuns.set(lane, run)
    run.promise = Promise.resolve()
      .then(async () => {
        do {
          run.trailingRequested = false
          if (lane === 'McpServer') {
            await this.runInitialMcpServerConvergenceCore()
          } else {
            await this.runInitialNetworkPolicyConvergenceCore()
          }
        } while (!this.stopped && run.trailingRequested)
        // Retire the active slot synchronously before this promise settles.
        // A request arriving in the following settlement microtask must start
        // a new run instead of attaching to a pass whose loop already exited.
        if (this.initialConvergenceRuns.get(lane) === run) {
          this.initialConvergenceRuns.delete(lane)
        }
      })
      .finally(() => {
        // Errors bypass the normal retirement above.
        if (this.initialConvergenceRuns.get(lane) === run) {
          this.initialConvergenceRuns.delete(lane)
        }
      })
    return run.promise
  }

  private async runInitialNetworkPolicyConvergenceCore(): Promise<void> {
    // A NetworkPolicy full pass combines authoritative Context/McpServer allow
    // revocation with additive Context policy effects. External egress
    // creation and DNS refresh have one separate owner: the startup/resync
    // coordinator. Running safety from a partial inventory would be neither a
    // full convergence nor safe evidence of success. Recovery of either
    // missing LIST -> WATCH pair schedules a fresh current-cache pass.
    const startedAtMs = Date.now()
    if (!this.contextCacheSynced || !this.mcpServerCacheSynced) {
      const unsynced = [
        !this.contextCacheSynced ? 'Context' : undefined,
        !this.mcpServerCacheSynced ? 'McpServer' : undefined,
      ]
        .filter((name): name is string => name !== undefined)
        .join(' and ')
      console.warn(
        `[K8s] NetworkPolicy convergence request deferred: caches unsynced (${unsynced})`
      )
      initialConvergenceSwallowedTotal.inc({ lane: 'NetworkPolicy', sink: 'unsynced' })
      observeInitialNetworkPolicyPass(startedAtMs, 'deferred-unsynced')
      this.scheduleInitialConvergenceRetry('NetworkPolicy')
      return
    }
    let authoritativeRevocationCompleted = false
    try {
      const initialContexts = [...this.contexts.values()]
      const initialServers = [...this.servers.values()]
      const contextInventoryGeneration = this.contextWatchGeneration
      const serverInventoryGeneration = this.mcpWatchGeneration
      const safetyCertificate: NetworkPolicySafetyCertificate = {
        contextGeneration: contextInventoryGeneration,
        serverGeneration: serverInventoryGeneration,
        contextRevision: this.contextDesiredRevision,
        serverRevision: this.mcpServerDesiredRevision,
      }
      const serverInventoryComplete = this.mcpServerCacheSynced
      const contextInventoryAuthoritative = () =>
        this.hasContextInventoryAuthority(contextInventoryGeneration)
      const serverInventoryAuthoritative = () =>
        this.hasMcpServerInventoryAuthority(serverInventoryGeneration)
      console.log('[K8s] Running initial NetworkPolicy background reconciliation...')
      await this.netPolReconciler.fullReconcile(initialContexts, initialServers, {
        serverInventoryComplete,
        ensureDefaults: false,
        contextInventoryAuthoritative,
        serverInventoryAuthoritative,
        runContextEffect: (contextId, work) =>
          this.enqueueContextReconciliation(contextId, async () => {
            if (!contextInventoryAuthoritative() || !serverInventoryAuthoritative()) {
              initialConvergenceEffectsDroppedTotal.inc({
                lane: 'NetworkPolicy',
                kind: 'context',
              })
              return
            }
            await work()
          }),
        runServerEffect: (serverName, work) => {
          const selected = this.servers.get(serverName)
          return this.enqueueMcpServerReconciliation(
            selected ?? { name: serverName, namespace: config.namespace },
            async () => {
              if (!serverInventoryAuthoritative()) {
                initialConvergenceEffectsDroppedTotal.inc({
                  lane: 'NetworkPolicy',
                  kind: 'server',
                })
                return
              }
              await work()
            }
          )
        },
        resolveCurrentContext: name => this.contexts.get(name),
        resolveCurrentContextById: contextId =>
          [...this.contexts.values()].find(context => context.spec.contextId === contextId),
        resolveCurrentServer: name => this.servers.get(name),
        contextDesiredRevision: () => this.contextDesiredRevision,
        serverDesiredRevision: () => this.mcpServerDesiredRevision,
        // B3 piece-2: queue an additive recreation for every server whose
        // external-egress allow the authoritative pass revoked — fired at the
        // deletion, so an abort/throw cannot strand a revoked-but-desired allow.
        // The coordinator maps against the current cache (absent → DELETED, no
        // recreate) and rebuilds from the current spec with fresh DNS.
        onExternalEgressRevoked: server =>
          this.externalEgressCoordinator.scheduleRetry('MODIFIED', server),
        onAuthoritativeRevocationComplete: () => {
          if (!this.recordNetworkPolicySafetyCertificate(safetyCertificate)) return
          authoritativeRevocationCompleted = true
          // Start runtime convergence at the safety boundary, before this full
          // pass enters additive Context work. Startup egress gates may now
          // preserve only policies certified by this exact authoritative
          // inventory generation.
          void this.runInitialMcpServerConvergence()
        },
      })
      if (!contextInventoryAuthoritative() || !serverInventoryAuthoritative()) {
        console.warn('[K8s] pass ended without certifying: inventory authority lost')
        initialConvergenceSwallowedTotal.inc({ lane: 'NetworkPolicy', sink: 'authority-lost' })
        observeInitialNetworkPolicyPass(startedAtMs, 'aborted-authority')
        this.scheduleInitialConvergenceRetry('NetworkPolicy')
        return
      }
      initialConvergenceLastSuccessTimestampSeconds.set(
        { lane: 'NetworkPolicy' },
        Date.now() / 1000
      )
      this.clearInitialConvergenceRetry('NetworkPolicy')
      observeInitialNetworkPolicyPass(startedAtMs, 'certified')
    } catch (error) {
      console.error(
        authoritativeRevocationCompleted
          ? '[K8s] Initial NetworkPolicy post-certification additive reconciliation failed:'
          : '[K8s] Initial NetworkPolicy background reconciliation failed:',
        error
      )
      const abortedBump =
        error instanceof Error && error.message === DESIRED_NETWORKPOLICY_INVENTORY_CHANGED_MESSAGE
      observeInitialNetworkPolicyPass(startedAtMs, abortedBump ? 'aborted-bump' : 'failed')
      this.scheduleInitialConvergenceRetry('NetworkPolicy')
    }
  }

  private clearInitialConvergenceRetry(lane: InitialConvergenceLane): void {
    const timer = this.initialConvergenceRetryTimers.get(lane)
    if (timer) {
      clearTimeout(timer)
      this.initialConvergenceRetryTimers.delete(lane)
    }
    this.initialConvergenceRetryAttempts.delete(lane)
  }

  private scheduleInitialConvergenceRetry(lane: InitialConvergenceLane): void {
    if (this.stopped || this.initialConvergenceRetryTimers.has(lane)) return

    const attempt = (this.initialConvergenceRetryAttempts.get(lane) ?? 0) + 1
    const delayMs =
      INITIAL_CONVERGENCE_RETRY_DELAYS_MS[
        Math.min(attempt - 1, INITIAL_CONVERGENCE_RETRY_DELAYS_MS.length - 1)
      ]
    this.initialConvergenceRetryAttempts.set(lane, attempt)
    initialConvergenceRetriesTotal.inc({ lane })
    console.warn(
      `[K8s] Scheduling initial ${lane} background convergence retry ${attempt} in ${delayMs}ms`
    )

    const timer = setTimeout(() => {
      this.initialConvergenceRetryTimers.delete(lane)
      if (this.stopped) return
      if (lane === 'McpServer') {
        void this.runInitialMcpServerConvergence()
        return
      }
      void this.runInitialNetworkPolicyConvergence()
    }, delayMs)
    this.initialConvergenceRetryTimers.set(lane, timer)
  }

  private runInitialSharedFileSystemConvergence(): Promise<void> {
    const names = [...this.sharedFileSystems.keys()]
    return this.enqueueSharedFileSystemFleetReconciliation(names, () =>
      this.runInitialSharedFileSystemConvergenceCore()
    )
  }

  private async runInitialSharedFileSystemConvergenceCore(): Promise<void> {
    try {
      const initialSfses = [...this.sharedFileSystems.values()]
      console.log('[K8s] Running initial SharedFileSystem background reconciliation...')
      await this.sharedFileSystemReconciler.fullReconcile(initialSfses)
    } catch (error) {
      console.error('[K8s] Initial SharedFileSystem background reconciliation failed:', error)
    }
  }

  private runInitialGlobalFileSystemConvergence(): Promise<void> {
    const names = [...this.globalFileSystems.keys()]
    return this.enqueueGlobalFileSystemFleetReconciliation(names, () =>
      this.runInitialGlobalFileSystemConvergenceCore()
    )
  }

  private async runInitialGlobalFileSystemConvergenceCore(): Promise<void> {
    try {
      const initialGfses = [...this.globalFileSystems.values()]
      console.log('[K8s] Running initial GlobalFileSystem background reconciliation...')
      await this.gfsReconciler.fullReconcile(initialGfses)
    } catch (error) {
      console.error('[K8s] Initial GlobalFileSystem background reconciliation failed:', error)
    }
  }

  /**
   * Start watching SharedFileSystem CRDs in the mcp-host namespace.
   */
  private async startSharedFileSystemWatch(): Promise<void> {
    const path = `/apis/${GROUP}/${VERSION}/namespaces/${config.hostNamespace}/${PLURAL_SHAREDFILESYSTEMS}`
    console.log(`[K8s] Starting SharedFileSystem watch`)

    const watchCallback = async (
      type: string,
      apiObj: { metadata: { name: string; namespace?: string }; spec: SharedFileSystemSpec }
    ) => {
      const sfs: SharedFileSystemCRD = {
        name: apiObj.metadata.name,
        namespace: apiObj.metadata.namespace || config.hostNamespace,
        spec: apiObj.spec,
      }

      console.log(`[K8s] SharedFileSystem watch event: ${type} for ${sfs.name}`)

      if (type === 'ADDED' || type === 'MODIFIED') {
        this.sharedFileSystems.set(sfs.name, sfs)
      } else if (type === 'DELETED') {
        this.sharedFileSystems.delete(sfs.name)
      }
      this.sharedFileSystemCacheRevision += 1

      await this.enqueueSharedFileSystemReconciliation(sfs.name, async () => {
        try {
          if (type === 'ADDED' || type === 'MODIFIED') {
            await this.sharedFileSystemReconciler.reconcile(sfs)
          } else if (type === 'DELETED') {
            await this.sharedFileSystemReconciler.reconcileDelete(sfs.name, sfs.namespace, sfs.spec)
          }
        } catch (error) {
          console.error(`[K8s] SharedFileSystem reconciliation failed for ${sfs.name}:`, error)
        }

        // Re-reconcile any Host whose Context references this SharedFileSystem.
        // ADDED/MODIFIED: pick up the now-resolvable mount; DELETED: drop it on
        // the next mcp-host pod template diff so the pod stops failing to mount.
        try {
          await this.reconcileHostsReferencingSfs(sfs.name)
        } catch (error) {
          console.error(
            `[K8s] Failed to re-reconcile Hosts referencing SharedFileSystem ${sfs.name}:`,
            error
          )
        }
      })
    }

    const doneCallback = (err: Error | null) => {
      if (this.stopped) return
      this.sfsWatchRequest = null
      if (err) {
        console.error('[K8s] SharedFileSystem watch error:', err)
      }
      console.log('[K8s] SharedFileSystem watch ended, restarting...')
      this.scheduleSharedFileSystemWatchRestart(err ? 5000 : 1000)
    }

    this.sfsWatchRequest = await this.watch.watch(path, {}, watchCallback, doneCallback)
  }

  private scheduleSharedFileSystemWatchRestart(delayMs: number): void {
    if (this.stopped || this.sfsWatchRestartTimer) return
    this.sfsWatchRestartTimer = setTimeout(() => {
      this.sfsWatchRestartTimer = null
      if (this.stopped) return
      void this.startSharedFileSystemWatch().catch(error => {
        console.error('[K8s] SharedFileSystem background watch restart failed:', error)
        this.scheduleSharedFileSystemWatchRestart(5000)
      })
    }, delayMs)
  }

  /**
   * Watch the GlobalFileSystem singleton (gfs). ADDED/MODIFIED → reconcile the
   * drive stack; DELETED → tear it down (respecting retainOnDelete). DISTINCT
   * from the SharedFileSystem watch — gfs lives in its own namespace and has no
   * Context cross-reference.
   */
  private async startGlobalFileSystemWatch(): Promise<void> {
    const namespace = gfsDefaultFactoryConfig().gfsNamespace
    const path = `/apis/${GROUP}/${VERSION}/namespaces/${namespace}/${PLURAL_GLOBALFILESYSTEMS}`
    console.log(`[K8s] Starting GlobalFileSystem watch`)

    const watchCallback = async (
      type: string,
      apiObj: {
        metadata: { name: string; namespace?: string }
        spec: GlobalFileSystemSpec
        status?: GlobalFileSystemCRD['status']
      }
    ) => {
      const gfs: GlobalFileSystemCRD = {
        name: apiObj.metadata.name,
        namespace: apiObj.metadata.namespace || namespace,
        spec: apiObj.spec,
        status: apiObj.status,
      }
      console.log(`[K8s] GlobalFileSystem watch event: ${type} for ${gfs.name}`)
      if (type === 'ADDED' || type === 'MODIFIED') {
        this.globalFileSystems.set(gfs.name, gfs)
      } else if (type === 'DELETED') {
        this.globalFileSystems.delete(gfs.name)
      }
      this.globalFileSystemCacheRevision += 1
      await this.enqueueGlobalFileSystemReconciliation(gfs.name, async () => {
        try {
          if (type === 'ADDED' || type === 'MODIFIED') {
            await this.gfsReconciler.reconcile(gfs)
          } else if (type === 'DELETED') {
            await this.gfsReconciler.reconcileDelete(gfs)
          }
        } catch (error) {
          console.error(`[K8s] GlobalFileSystem reconciliation failed for ${gfs.name}:`, error)
        }
      })
    }

    const doneCallback = (err: Error | null) => {
      if (this.stopped) return
      this.gfsWatchRequest = null
      if (err) {
        console.error('[K8s] GlobalFileSystem watch error:', err)
      }
      console.log('[K8s] GlobalFileSystem watch ended, restarting...')
      this.scheduleGlobalFileSystemWatchRestart(err ? 5000 : 1000)
    }

    this.gfsWatchRequest = await this.watch.watch(path, {}, watchCallback, doneCallback)
  }

  private scheduleGlobalFileSystemWatchRestart(delayMs: number): void {
    if (this.stopped || this.gfsWatchRestartTimer) return
    this.gfsWatchRestartTimer = setTimeout(() => {
      this.gfsWatchRestartTimer = null
      if (this.stopped) return
      void this.startGlobalFileSystemWatch().catch(error => {
        console.error('[K8s] GlobalFileSystem background watch restart failed:', error)
        this.scheduleGlobalFileSystemWatchRestart(5000)
      })
    }, delayMs)
  }

  /**
   * Extracted so unit tests can invoke the handler without spinning up a real
   * K8s watch. Production calls this from `startCommunicationChannelWatch` and
   * wires it into `this.watch.watch(...)`.
   */
  private getCommunicationChannelWatchCallback(): (
    type: string,
    apiObj: {
      metadata: { name: string; namespace?: string }
      spec: { hostRef: string; credentialsSecretRef?: { name: string } }
    }
  ) => Promise<void> {
    return async (type, apiObj) => {
      const cc: CommunicationChannelCRD = {
        name: apiObj.metadata.name,
        namespace: apiObj.metadata.namespace || config.channelsNamespace,
        spec: {
          hostRef: apiObj.spec.hostRef,
          ...(apiObj.spec.credentialsSecretRef?.name
            ? { credentialsSecretRef: { name: apiObj.spec.credentialsSecretRef.name } }
            : {}),
        },
      }

      console.log(`[K8s] CommunicationChannel watch event: ${type} for ${cc.name}`)

      // Track the previous hostRef to handle MODIFIED-with-hostRef-change
      // (R5 in the spec): both old and new Hosts must be re-reconciled.
      const previous = this.communicationChannels.get(cc.name)
      const previousHostRef = previous?.spec.hostRef

      if (type === 'ADDED' || type === 'MODIFIED') {
        this.communicationChannels.set(cc.name, cc)
      } else if (type === 'DELETED') {
        this.communicationChannels.delete(cc.name)
      } else {
        // BOOKMARK or unknown — nothing to reconcile.
        return
      }

      // Reconcile the affected Host(s). For MODIFIED with hostRef change,
      // reconcile both. Duplicate reconciles for the same hostRef are
      // collapsed via a Set. reconcileHostsReferencingCC is no-throw and
      // reports failures so the watch loop stays alive while recovery is queued.
      //
      // Additionally patch the per-Host channel-reader Deployment's
      // credentials-revision annotation so the pod rolls when its CC set
      // (or any referenced credentials Secret) changes. Order between the
      // two calls doesn't matter — both end up patching the same Deployment
      // and patches are idempotent.
      const affectedHostRefs = new Set<string>([cc.spec.hostRef])
      if (previousHostRef && previousHostRef !== cc.spec.hostRef) {
        affectedHostRefs.add(previousHostRef)
      }
      if (!this.isHostInventoryAuthoritative()) {
        const lifecycleGeneration = this.beginCommunicationChannelLifecycleTransition()
        this.admitHostDependentEffects(
          'CommunicationChannel event Host convergence',
          lifecycleGeneration
        )
        return
      }
      let needsFleetRetry = false
      for (const hostRef of affectedHostRefs) {
        if (!(await this.reconcileHostsReferencingCC(hostRef))) {
          needsFleetRetry = true
        }
        try {
          await this.hostReconciler.patchChannelReaderRevisionAnnotation(hostRef)
        } catch (err) {
          console.error(
            `[K8s] channel-reader revision patch after CC change failed for "${hostRef}":`,
            err
          )
          needsFleetRetry = true
        }
      }
      if (needsFleetRetry) {
        const lifecycleGeneration = this.beginCommunicationChannelLifecycleTransition()
        void this.requestHostFleetReconcile(
          'CommunicationChannel event convergence fallback',
          lifecycleGeneration,
          'lifecycle'
        )
      }
    }
  }

  /**
   * Start watching CommunicationChannel CRDs in the channels namespace.
   *
   * Drives per-Host channel-reader Deployment replicas via
   * HostReconciler.countCommunicationChannels (#281). Mirrors the
   * SharedFileSystem watch — auto-restart on disconnect.
   */
  private async startCommunicationChannelWatch(resourceVersion?: string): Promise<number> {
    const watchGeneration = ++this.ccWatchGeneration
    await this.openCommunicationChannelWatch(resourceVersion, watchGeneration)
    return watchGeneration
  }

  private async restartCommunicationChannelWatch(
    snapshot: CommunicationChannelSnapshot
  ): Promise<number> {
    if (!snapshot.resourceVersion) {
      throw new Error('CommunicationChannel snapshot missing resourceVersion')
    }
    const watchGeneration = ++this.ccWatchGeneration
    if (this.ccWatchRequest) {
      this.ccWatchRequest.abort()
      this.ccWatchRequest = null
    }
    this.installCommunicationChannelSnapshot(snapshot)
    await this.openCommunicationChannelWatch(snapshot.resourceVersion, watchGeneration)
    return watchGeneration
  }

  private async openCommunicationChannelWatch(
    resourceVersion: string | undefined,
    watchGeneration: number
  ): Promise<void> {
    const path = `/apis/${GROUP}/${VERSION}/namespaces/${config.channelsNamespace}/${PLURAL_COMMUNICATIONCHANNELS}`
    console.log(`[K8s] Starting CommunicationChannel watch`)

    let watchEnded = false
    const applyWatchEvent = this.getCommunicationChannelWatchCallback()
    const watchCallback = async (
      type: string,
      apiObj: {
        metadata: { name: string; namespace?: string }
        spec: { hostRef: string; credentialsSecretRef?: { name: string } }
      }
    ) => {
      if (watchEnded || this.stopped || watchGeneration !== this.ccWatchGeneration) return
      await applyWatchEvent(type, apiObj)
    }

    const doneCallback = (err: Error | null) => {
      if (watchEnded || this.stopped || watchGeneration !== this.ccWatchGeneration) return
      watchEnded = true
      this.ccWatchRequest = null
      this.ccCacheSynced = false
      const lifecycleGeneration = this.beginCommunicationChannelLifecycleTransition()
      if (err) {
        console.error('[K8s] CommunicationChannel watch error:', err)
      }
      console.log(
        '[K8s] CommunicationChannel watch ended; holding stateless lifecycle active until snapshot recovery'
      )
      void this.requestHostFleetReconcile(
        'CommunicationChannel watch interruption',
        lifecycleGeneration
      )
      this.scheduleCommunicationChannelCacheRecovery()
    }

    const request = await this.watch.watch(
      path,
      resourceVersion ? { resourceVersion } : {},
      watchCallback,
      doneCallback
    )
    if (this.stopped || watchGeneration !== this.ccWatchGeneration || watchEnded) {
      request.abort()
      if (!this.stopped && watchGeneration === this.ccWatchGeneration && watchEnded) {
        throw new Error('CommunicationChannel watch ended before request initialization completed')
      }
      return
    }
    this.ccWatchRequest = request
  }

  private runHostResync(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.hostResyncInFlight) return this.hostResyncInFlight

    const run = this.performHostResync()
    this.hostResyncInFlight = run
    const settle = () => {
      if (this.hostResyncInFlight === run) this.hostResyncInFlight = null
    }
    void run.then(settle, settle)
    return run
  }

  private async performHostResync(): Promise<void> {
    if (!this.ccCacheSynced) {
      await this.recoverCommunicationChannelCache()
      return
    }
    const pendingLifecycleGeneration =
      this.ccLifecycleGeneration !== this.ccAppliedLifecycleGeneration
        ? this.ccLifecycleGeneration
        : undefined
    if (pendingLifecycleGeneration !== undefined) {
      await this.requestHostFleetReconcile(
        'Periodic lifecycle convergence',
        pendingLifecycleGeneration,
        'lifecycle'
      )
      if (this.ccAppliedLifecycleGeneration !== pendingLifecycleGeneration) return
    }
    await this.requestHostFleetReconcile('Periodic resync', undefined, 'full')
  }

  /**
   * Periodic SharedFileSystem resync (#592). The SFS watch only fires on SFS CRD
   * changes, not on the PVC binding or the wfc pod becoming Ready. Re-running
   * fullReconcile every N seconds lets a SharedFileSystem that reported
   * Initializing/Degraded (PVC still binding under WaitForFirstConsumer, or the
   * wfc pod still starting) transition to a truthful Ready once the volume binds
   * and the pod serves — without waiting for an unrelated SFS event.
   */
  /**
   * Periodic GlobalFileSystem re-reconcile. The gfs watch only fires on the CRD
   * changing, so a GlobalFileSystem that reported Initializing (writer not yet
   * Available at first reconcile) needs this to converge to Ready and to run its
   * one-time root-directory seed once the writer is up. Idempotent; per-item
   * failures are logged by fullReconcile, never thrown.
   */
  private async runGfsResync(): Promise<void> {
    if (this.stopped) return
    try {
      const cacheRevisionAtListStart = this.globalFileSystemCacheRevision
      const gfses = await listAllGlobalFileSystems()
      const names = [
        ...this.globalFileSystems.keys(),
        ...gfses.map(globalFileSystem => globalFileSystem.name),
      ]
      return this.enqueueGlobalFileSystemFleetReconciliation(names, () =>
        this.runGfsResyncCore(gfses, cacheRevisionAtListStart)
      )
    } catch (err) {
      console.error(
        `[K8s] GlobalFileSystem periodic resync failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  private async runGfsResyncCore(
    listedGfses?: GlobalFileSystemCRD[],
    listedAtCacheRevision?: number
  ): Promise<void> {
    if (this.stopped) return
    try {
      const cacheRevisionAtListStart = listedAtCacheRevision ?? this.globalFileSystemCacheRevision
      const gfses = listedGfses ?? (await listAllGlobalFileSystems())
      let reconcileInventory: GlobalFileSystemCRD[]
      if (cacheRevisionAtListStart === this.globalFileSystemCacheRevision) {
        this.globalFileSystems.clear()
        for (const gfs of gfses) this.globalFileSystems.set(gfs.name, gfs)
        reconcileInventory = gfses
      } else {
        reconcileInventory = [...this.globalFileSystems.values()]
      }
      await this.gfsReconciler.fullReconcile(reconcileInventory)
    } catch (err) {
      console.error(
        `[K8s] GlobalFileSystem periodic resync failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  private async runSfsResync(): Promise<void> {
    if (this.stopped) return
    try {
      const cacheRevisionAtListStart = this.sharedFileSystemCacheRevision
      const sfses = await listAllSharedFileSystems()
      const names = [
        ...this.sharedFileSystems.keys(),
        ...sfses.map(sharedFileSystem => sharedFileSystem.name),
      ]
      return this.enqueueSharedFileSystemFleetReconciliation(names, () =>
        this.runSfsResyncCore(sfses, cacheRevisionAtListStart)
      )
    } catch (error) {
      console.error('[K8s] Periodic SharedFileSystem resync failed:', error)
    }
  }

  private async runSfsResyncCore(
    listedSfses?: SharedFileSystemCRD[],
    listedAtCacheRevision?: number
  ): Promise<void> {
    if (this.stopped) return
    try {
      const cacheRevisionAtListStart = listedAtCacheRevision ?? this.sharedFileSystemCacheRevision
      const sfses = listedSfses ?? (await listAllSharedFileSystems())
      let reconcileInventory: SharedFileSystemCRD[]
      if (cacheRevisionAtListStart === this.sharedFileSystemCacheRevision) {
        this.sharedFileSystems.clear()
        for (const sfs of sfses) this.sharedFileSystems.set(sfs.name, sfs)
        reconcileInventory = sfses
      } else {
        reconcileInventory = [...this.sharedFileSystems.values()]
      }

      // Capture each SFS's mountability (PVC Bound) BEFORE reconciling so we can
      // detect a flip. resolveContextMounts() injects the RO mount + podAffinity
      // only while the SFS is mountable, so a mountable⇄not-mountable flip changes
      // the mount set of every consuming mcp-host pod. (Keyed on mountability, NOT
      // on phase==='Ready': a transient wfc readiness dip while the PVC stays
      // Bound must NOT re-roll consumers — see resolveContextMounts.)
      const wasMountable = new Map<string, boolean>()
      for (const sfs of reconcileInventory) {
        wasMountable.set(sfs.name, this.sharedFileSystemReconciler.isMountable(sfs))
      }

      await this.sharedFileSystemReconciler.fullReconcile(reconcileInventory)

      // #592 gap fix: heal the consuming mcp-host Deployments on a mountability
      // flip — inject the mount + affinity once the PVC binds, or drop it if the
      // volume becomes genuinely unusable. This does NOT rely on the status-
      // subresource MODIFIED self-event, which the apiserver suppresses for a
      // no-op patch and which our dirty check makes even less likely to fire — so
      // an already-Bound SFS picked up on HCC restart still re-injects its mount
      // within one resync interval instead of waiting for the (much longer) Host
      // resync.
      for (const sfs of reconcileInventory) {
        const nowMountable = this.sharedFileSystemReconciler.isMountable(sfs)
        if (nowMountable !== (wasMountable.get(sfs.name) ?? false)) {
          await this.reconcileHostsReferencingSfs(sfs.name)
        }
      }
    } catch (error) {
      console.error('[K8s] Periodic SharedFileSystem resync failed:', error)
    }
  }

  /**
   * Start watching McpServer CRDs.
   */
  private getMcpServerWatchCallback(
    watchGeneration = this.mcpWatchGeneration
  ): (type: string, apiObj: McpServerWatchObject) => Promise<void> {
    return async (type, apiObj) => {
      if (this.stopped || watchGeneration !== this.mcpWatchGeneration) return
      const server: McpServerCRD = {
        name: apiObj.metadata.name,
        namespace: apiObj.metadata.namespace || config.namespace,
        uid: apiObj.metadata.uid,
        generation: apiObj.metadata.generation,
        annotations: apiObj.metadata.annotations,
        labels: apiObj.metadata.labels,
        spec: apiObj.spec,
        status: apiObj.status,
      }

      console.log(`[K8s] McpServer watch event: ${type} for ${server.name}`)

      const previous = this.servers.get(server.name)

      // Update cache
      let desiredStateChanged = false
      if (type === 'ADDED' || type === 'MODIFIED') {
        desiredStateChanged =
          previous === undefined || !sameMcpServerDesiredRevision(previous, server)
        this.servers.set(server.name, server)
      } else if (type === 'DELETED') {
        if (!previous?.uid || !server.uid || previous.uid === server.uid) {
          desiredStateChanged = this.servers.delete(server.name)
        }
      }
      if (desiredStateChanged) {
        this.mcpServerDesiredRevision += 1
        void this.runInitialNetworkPolicyConvergence()
      }

      // HCC writes McpServer status during reconciliation. Those writes emit
      // MODIFIED events but do not change the desired runtime or policy state.
      // Suppress that self-induced work while still publishing the fresh status
      // through discovery. Any UID/spec/annotation/label change remains live.
      if (type === 'MODIFIED' && previous && isMcpServerStatusOnlyUpdate(previous, server)) {
        this.changeCallback?.()
        return
      }

      await this.enqueueMcpServerReconciliation(server, () =>
        this.reconcileMcpServerWatchEvent(
          type as ExternalEgressWatchEventType,
          server,
          watchGeneration
        )
      )
    }
  }

  private async reconcileMcpServerWatchEvent(
    type: ExternalEgressWatchEventType,
    server: McpServerCRD,
    watchGeneration: number,
    retry?: ExternalEgressRetryHandle
  ): Promise<void> {
    if (this.stopped || watchGeneration !== this.mcpWatchGeneration) return
    if (retry && !retry.isCurrent()) return
    if (retry && !this.hasMcpServerInventoryAuthority(watchGeneration)) {
      this.scheduleExternalEgressRetry(type, server)
      return
    }
    const current = this.servers.get(server.name)
    if (type === 'DELETED') {
      // A same-name recreation may already be accepted while this callback
      // waits for its per-server effect. The newer identity owns the key.
      if (current) return
    } else {
      if (!current || current.namespace !== server.namespace) return
      server = current
    }
    const deleteAllowed = () =>
      this.mcpServerAbsentForDelete(server.name, server.namespace, watchGeneration)
    const contextInventoryGeneration = this.contextWatchGeneration
    const contextPolicyInventoryIsCurrent = (): boolean =>
      this.mcpServerWatchEffectIsCurrent(server, watchGeneration) &&
      this.hasContextInventoryAuthority(contextInventoryGeneration)

    // External egress is part of the workload's pre-start contract. Reconcile
    // it before HCC creates or updates any managed runtime Deployment so a
    // stdio MCP with egressBindings cannot start before ExternalEgressReady.
    let retryCompletion: ExternalEgressRetryHandle | undefined
    if (type === 'ADDED' || type === 'MODIFIED') {
      try {
        retryCompletion = await this.runExternalEgressOnce(type, server, {
          retry,
          isCurrent: () =>
            this.mcpServerWatchEffectIsCurrent(server, watchGeneration) &&
            (!retry || this.hasMcpServerInventoryAuthority(watchGeneration)),
        })
      } catch (error) {
        console.error(
          `[K8s] External egress reconciliation failed for ${server.name}; runtime reconciliation blocked:`,
          error
        )
        this.scheduleExternalEgressRetry(type, server)
        this.changeCallback?.()
        return
      }
    } else {
      if (!(await this.authorizeMcpServerDeleteOrRetry(server, watchGeneration))) return
      try {
        retryCompletion = await this.runExternalEgressOnce(type, server, {
          deleteAllowed,
          retry,
          isCurrent: () =>
            !this.stopped &&
            watchGeneration === this.mcpWatchGeneration &&
            (!retry || this.hasMcpServerInventoryAuthority(watchGeneration)),
        })
      } catch (error) {
        console.error(
          `[K8s] External egress reconciliation failed for ${server.name}; runtime reconciliation blocked:`,
          error
        )
        this.scheduleExternalEgressRetry(type, server)
        this.changeCallback?.()
        return
      }
    }

    if (type === 'ADDED' || type === 'MODIFIED') {
      if (retry && !this.hasMcpServerInventoryAuthority(watchGeneration)) {
        this.scheduleExternalEgressRetry(type, server)
        return
      }
      if (!this.mcpServerWatchEffectIsCurrent(server, watchGeneration)) return
      server = this.servers.get(server.name)!
    } else if (!(await this.authorizeMcpServerDeleteOrRetry(server, watchGeneration))) {
      return
    }

    // Trigger deployment reconciliation.
    try {
      if (type === 'ADDED' || type === 'MODIFIED') {
        const currentServer = server
        await this.reconciler.reconcile(currentServer, {
          isCurrent: () => this.mcpServerWatchEffectIsCurrent(currentServer, watchGeneration),
        })
      } else if (type === 'DELETED') {
        await this.reconciler.reconcileDelete(server.name, server.namespace)
      }
    } catch (error) {
      console.error(`[K8s] Reconciliation failed for ${server.name}:`, error)
      this.scheduleExternalEgressRetry(type, server)
      this.changeCallback?.()
      return
    }

    if (type === 'ADDED' || type === 'MODIFIED') {
      if (!this.mcpServerWatchEffectIsCurrent(server, watchGeneration)) return
      server = this.servers.get(server.name)!
    } else if (!(await this.authorizeMcpServerDeleteOrRetry(server, watchGeneration))) {
      return
    }

    // Trigger binding policy reconciliation (L3 ingress/egress).
    try {
      if (type === 'ADDED' || type === 'MODIFIED') {
        const bindingsJson = server.annotations?.['clerum.io/recipe-bindings']
        if (bindingsJson) {
          const bindings: BindingDef[] = JSON.parse(bindingsJson)
          const recipeName = server.labels?.['clerum.io/recipe'] ?? server.name
          const mcpWorkloadName = server.labels?.['clerum.io/workload'] ?? server.name
          const bindingServer = server
          await this.bindingReconciler.reconcileBindings(
            recipeName,
            bindings,
            mcpWorkloadName,
            bindingServer.name,
            {
              isCurrent: () => this.mcpServerWatchEffectIsCurrent(bindingServer, watchGeneration),
            }
          )
          if (!this.mcpServerWatchEffectIsCurrent(server, watchGeneration)) return
          server = this.servers.get(server.name)!
        }
        // Re-reconcile cached Contexts after the server cache is populated.
        for (const selectedContext of this.contexts.values()) {
          if (!this.mcpServerWatchEffectIsCurrent(server, watchGeneration)) return
          if (!selectedContext.spec.mcpServers?.includes(server.name)) continue
          const selectedContextId = selectedContext.spec.contextId
          console.log(
            `[K8s] Re-reconciling context "${selectedContext.name}" after McpServer "${server.name}" cached`
          )
          await this.enqueueContextReconciliation(selectedContextId, async () => {
            if (!this.mcpServerWatchEffectIsCurrent(server, watchGeneration)) return
            const currentContext = this.contexts.get(selectedContext.name)
            if (
              currentContext?.spec.contextId !== selectedContextId ||
              !currentContext.spec.mcpServers?.includes(server.name)
            ) {
              return
            }
            await this.netPolReconciler.reconcileContext(currentContext, {
              isCurrent: () =>
                contextPolicyInventoryIsCurrent() &&
                this.contexts.get(currentContext.name) === currentContext,
            })
          })
        }
      } else if (type === 'DELETED') {
        const recipeName = server.labels?.['clerum.io/recipe'] ?? server.name
        await this.bindingReconciler.cleanupBindings(recipeName, { deleteAllowed })
      }
    } catch (error) {
      console.error(`[K8s] Binding/egress reconciliation failed for ${server.name}:`, error)
      this.scheduleExternalEgressRetry(type, server)
      this.changeCallback?.()
      return
    }

    retryCompletion?.complete()
    this.changeCallback?.()
  }

  private async startMcpServerWatch(resourceVersion: string): Promise<number> {
    this.requireInventoryResourceVersion('McpServer', resourceVersion)
    const path = `/apis/${GROUP}/${VERSION}/namespaces/${config.namespace}/${PLURAL_MCPSERVERS}`
    console.log(`[K8s] Starting McpServer watch`)
    const watchGeneration = ++this.mcpWatchGeneration
    if (this.mcpWatchRequest) {
      this.mcpWatchRequest.abort()
      this.mcpWatchRequest = null
    }
    let watchEnded = false

    const watchCallback = this.getMcpServerWatchCallback(watchGeneration)

    const doneCallback = (err: Error | null) => {
      if (watchEnded) return
      watchEnded = true
      if (this.stopped || watchGeneration !== this.mcpWatchGeneration) return
      if (!this.retireMcpServerWatch(watchGeneration)) return
      if (err) {
        console.error('[K8s] McpServer watch error:', err)
      }
      console.log('[K8s] McpServer watch ended; recovering authoritative inventory...')
      this.attemptMcpServerCacheRecovery()
    }

    const request = await this.watch.watch(path, { resourceVersion }, watchCallback, doneCallback)
    if (this.stopped || watchGeneration !== this.mcpWatchGeneration || watchEnded) {
      request.abort()
      return watchGeneration
    }
    this.mcpWatchRequest = request
    return watchGeneration
  }

  private mcpServerWatchEffectIsCurrent(expected: McpServerCRD, watchGeneration: number): boolean {
    if (this.stopped || watchGeneration !== this.mcpWatchGeneration) return false
    const current = this.servers.get(expected.name)
    return current !== undefined && sameMcpServerDesiredRevision(expected, current)
  }

  private runExternalEgressOnce(
    type: ExternalEgressWatchEventType,
    server: McpServerCRD,
    options: {
      deleteAllowed?: () => Promise<boolean>
      retry?: ExternalEgressRetryHandle
      isCurrent?: () => boolean
    } = {}
  ): Promise<ExternalEgressRetryHandle | undefined> {
    return this.externalEgressCoordinator.reconcile(type, server, options)
  }

  private scheduleExternalEgressRetry(type: string, server: McpServerCRD): void {
    this.externalEgressCoordinator.scheduleRetry(type, server)
  }

  private async performExternalEgressMutation(
    type: ExternalEgressWatchEventType,
    server: McpServerCRD,
    options: {
      deleteAllowed?: () => Promise<boolean>
      isCurrent: () => boolean
    }
  ): Promise<void> {
    if (type === 'DELETED') {
      const deleteAllowed = async (): Promise<boolean> => {
        if (!options.isCurrent()) return false
        if (options.deleteAllowed && !(await options.deleteAllowed())) return false
        return options.isCurrent()
      }
      await this.netPolReconciler.cleanupExternalEgress(
        server.name,
        server.namespace,
        undefined,
        deleteAllowed
      )
      return
    }
    await this.netPolReconciler.reconcileExternalEgress(server, {
      isCurrent: options.isCurrent,
    })
  }

  private getLlmHookWatchCallback(): (
    type: string,
    apiObj: {
      metadata: {
        name: string
        namespace?: string
        uid?: string
        generation?: number
        annotations?: Record<string, string>
        labels?: Record<string, string>
      }
      spec: LlmHookSpec
      status?: LlmHookCRD['status']
    }
  ) => Promise<void> {
    return async (type, apiObj) => {
      const hook: LlmHookCRD = {
        name: apiObj.metadata.name,
        namespace: apiObj.metadata.namespace || config.llmHooksNamespace,
        uid: apiObj.metadata.uid,
        generation: apiObj.metadata.generation,
        annotations: apiObj.metadata.annotations,
        labels: apiObj.metadata.labels,
        spec: apiObj.spec,
        status: apiObj.status,
      }

      console.log(`[K8s] LlmHook watch event: ${type} for ${hook.name}`)

      // Compute the pod key the CR had BEFORE this event so an image bump can
      // chain teardown of the old pod key with ensure of the new one (§4), and
      // a delete can GC the workload the CR was a member of.
      const previous = this.llmHooks.get(hook.name)
      const previousPodKey = previous ? computePodKey(previous) : null

      if (type === 'ADDED' || type === 'MODIFIED') {
        this.llmHooks.set(hook.name, hook)
      } else if (type === 'DELETED') {
        this.llmHooks.delete(hook.name)
      }

      try {
        if (type === 'ADDED' || type === 'MODIFIED') {
          await this.llmHookReconciler.reconcile(hook, previousPodKey)
        } else if (type === 'DELETED') {
          await this.llmHookReconciler.reconcileDelete(hook.name, previousPodKey)
        }
      } catch (error) {
        console.error(`[K8s] LlmHook reconciliation failed for ${hook.name}:`, error)
      }
    }
  }

  /**
   * Start watching LlmHook CRDs in the llm-hooks namespace.
   */
  private async startLlmHookWatch(): Promise<void> {
    const path = `/apis/${GROUP}/${VERSION}/namespaces/${config.llmHooksNamespace}/${PLURAL_LLMHOOKS}`
    console.log(`[K8s] Starting LlmHook watch`)

    const watchCallback = this.getLlmHookWatchCallback()

    const doneCallback = (err: Error | null) => {
      if (this.stopped) return
      if (err) {
        console.error('[K8s] LlmHook watch error:', err)
      }
      console.log('[K8s] LlmHook watch ended, restarting...')
      setTimeout(() => this.startLlmHookWatch(), err ? 5000 : 1000)
    }

    this.llmHookWatchRequest = await this.watch.watch(path, {}, watchCallback, doneCallback)
  }

  /** Periodic LlmHook resync: full reconcile drives the orphan sweep (§3). */
  private async runLlmHookResync(): Promise<void> {
    if (this.stopped) return
    try {
      await this.llmHookReconciler.fullReconcile([...this.llmHooks.values()])
    } catch (error) {
      console.error('[K8s] LlmHook periodic resync failed:', error)
    }
  }

  /**
   * Start watching Context CRDs for NetworkPolicy reconciliation.
   */
  private async startContextWatch(resourceVersion: string): Promise<number> {
    this.requireInventoryResourceVersion('Context', resourceVersion)
    const path = `/apis/${GROUP}/${VERSION}/namespaces/${config.namespace}/${PLURAL_CONTEXTS}`
    console.log(`[K8s] Starting Context watch`)
    const watchGeneration = ++this.contextWatchGeneration
    if (this.ctxWatchRequest) {
      this.ctxWatchRequest.abort()
      this.ctxWatchRequest = null
    }
    let watchEnded = false

    const watchCallback = async (
      type: string,
      apiObj: {
        metadata: {
          name: string
          namespace?: string
          uid?: string
          generation?: number
        }
        spec: ContextSpec
      }
    ) => {
      if (this.stopped || watchGeneration !== this.contextWatchGeneration) return
      const context: ContextCRD = {
        name: apiObj.metadata.name,
        namespace: apiObj.metadata.namespace || config.namespace,
        uid: apiObj.metadata.uid,
        generation: apiObj.metadata.generation,
        spec: apiObj.spec,
      }

      console.log(`[K8s] Context watch event: ${type} for ${context.name}`)

      // Capture the previous spec before mutating the cache so we can
      // re-reconcile any SFS that *was* referenced but is no longer.
      const previous = this.contexts.get(context.name)
      // A scoped Context delta may replace only a prior, fully authoritative
      // safety certificate. Capturing it before this event changes desired
      // state proves there was no outstanding Context or McpServer revocation
      // work that the scoped reconciliation could accidentally certify.
      const previousSafetyCertificate = this.currentNetworkPolicySafetyCertificate()

      // Cache the context for cross-resource re-reconciliation
      let desiredStateChanged = false
      let deltaSafetyCertificate: NetworkPolicySafetyCertificate | undefined
      if (type === 'ADDED' || type === 'MODIFIED') {
        desiredStateChanged =
          previous === undefined || !sameContextDesiredRevision(previous, context)
        this.contexts.set(context.name, context)
      } else if (type === 'DELETED') {
        desiredStateChanged = this.contexts.delete(context.name)
      }
      if (desiredStateChanged) {
        this.contextDesiredRevision += 1
        // A same-identity Context MODIFIED event can complete its own stale
        // allow revocation below. Once that exact delta is current, it is safe
        // to restore readiness without waiting for an older pass's additive
        // fleet. Deletes and identity changes remain fail-closed until the
        // authoritative full pass certifies their broader cleanup.
        if (
          type === 'MODIFIED' &&
          previous?.uid === context.uid &&
          previous?.spec.contextId === context.spec.contextId &&
          previousSafetyCertificate !== null
        ) {
          deltaSafetyCertificate = {
            contextGeneration: previousSafetyCertificate.contextGeneration,
            serverGeneration: previousSafetyCertificate.serverGeneration,
            contextRevision: this.contextDesiredRevision,
            serverRevision: previousSafetyCertificate.serverRevision,
          }
        }
        void this.runInitialNetworkPolicyConvergence()
      }

      // Re-reconcile every SFS this Context referenced before or after the
      // change so SharedFileSystem.status.mountedByContexts stays in sync
      // without waiting for an SFS-level event.
      const nextForSfs = type === 'DELETED' ? undefined : context
      const contextInventoryAuthoritative = () => this.hasContextInventoryAuthority(watchGeneration)
      const serverInventoryGeneration = this.mcpWatchGeneration
      void this.reconcileSharedFileSystemsReferencedByContext(
        previous,
        nextForSfs,
        contextInventoryAuthoritative
      )

      const previousContextId = previous?.spec.contextId
      const effectContextIds =
        previousContextId && previousContextId !== context.spec.contextId
          ? [previousContextId, context.spec.contextId]
          : [context.spec.contextId]
      await this.enqueueContextIdentityReconciliation(effectContextIds, async () => {
        if (this.stopped || watchGeneration !== this.contextWatchGeneration) return

        try {
          if (previousContextId && previousContextId !== context.spec.contextId) {
            const oldIdDeleteAllowed = () =>
              this.contextIdAbsentForDelete(previousContextId, watchGeneration)
            if (await oldIdDeleteAllowed()) {
              await this.netPolReconciler.reconcileDeleteContext(
                previousContextId,
                oldIdDeleteAllowed
              )
            }
          }

          if (this.stopped || watchGeneration !== this.contextWatchGeneration) return
          const current = this.contexts.get(context.name)
          if (type === 'DELETED') {
            if (current) return
          } else if (current?.spec.contextId !== context.spec.contextId) {
            return
          }
          if (type === 'ADDED' || type === 'MODIFIED') {
            const selectedContext = current!
            // A scoped delta may only replace the safety certificate when its
            // own stale-allow revocation ran to completion — `reconcileContext`
            // aborts mid-pass whenever its authority fence breaks — and when
            // the last authoritative pass certified its namespace-wide
            // inventory, which a label-scoped delta cannot vouch for.
            // `deltaSafetyCertificate` is only ever built for MODIFIED, so this
            // is the one branch where it can be recorded.
            const scopedRevocationCompleted = await this.netPolReconciler.reconcileContext(
              selectedContext,
              {
                isCurrent: () =>
                  contextInventoryAuthoritative() &&
                  this.hasMcpServerInventoryAuthority(serverInventoryGeneration) &&
                  this.contexts.get(selectedContext.name) === selectedContext,
                // Only opt in when there is a certificate to withhold. Without
                // one the result below is discarded, so a reported lost fence
                // would vanish: no throw to reach the retry, and the recovery
                // in the desired-state branch does not run for an event that
                // did not move the revision.
                honorsLostFence: deltaSafetyCertificate !== undefined,
              }
            )
            if (deltaSafetyCertificate && scopedRevocationCompleted) {
              if (this.netPolReconciler.hasCertifiedSafetyInventory()) {
                this.recordNetworkPolicySafetyCertificate(deltaSafetyCertificate)
              } else {
                console.warn(
                  `[K8s] Not certifying the scoped delta for context "${context.spec.contextId}": the last authoritative safety pass ended without certifying its namespace-wide inventory`
                )
              }
            }
          } else if (type === 'DELETED') {
            const deleteAllowed = () =>
              this.contextAbsentForDelete(context.name, context.namespace, watchGeneration)
            if (!(await deleteAllowed())) return
            await this.netPolReconciler.reconcileDeleteContext(
              context.spec.contextId,
              deleteAllowed
            )
          }
        } catch (error) {
          console.error(
            `[K8s] NetworkPolicy reconciliation failed for context ${context.name}:`,
            error
          )
          void this.runInitialNetworkPolicyConvergence()
          return
        }

        if (this.stopped || watchGeneration !== this.contextWatchGeneration) return
        // Re-reconcile any Host that points at this Context so that changes to
        // spec.sharedFileSystems[] propagate into the mcp-host pod template.
        try {
          await this.reconcileHostsReferencingContext(context.name, contextInventoryAuthoritative)
        } catch (error) {
          console.error(
            `[K8s] Host re-reconcile after Context "${context.name}" change failed:`,
            error
          )
        }
      })
    }

    const doneCallback = (err: Error | null) => {
      if (watchEnded) return
      watchEnded = true
      if (this.stopped || watchGeneration !== this.contextWatchGeneration) return
      if (!this.retireContextWatch(watchGeneration)) return
      if (err) {
        console.error('[K8s] Context watch error:', err)
      }
      console.log('[K8s] Context watch ended; recovering authoritative inventory...')
      this.attemptContextCacheRecovery()
    }

    const request = await this.watch.watch(path, { resourceVersion }, watchCallback, doneCallback)
    if (this.stopped || watchGeneration !== this.contextWatchGeneration || watchEnded) {
      request.abort()
      return watchGeneration
    }
    this.ctxWatchRequest = request
    return watchGeneration
  }

  /**
   * Start watching Host CRDs for runtime reconciliation.
   */
  private async startHostWatch(resourceVersion: string): Promise<number> {
    if (!resourceVersion) {
      throw new Error('Host watch requires a snapshot resourceVersion')
    }
    const path = `/apis/${GROUP}/${VERSION}/namespaces/${config.hostNamespace}/${PLURAL_HOSTS}`
    const watchGeneration = ++this.hostWatchGeneration
    if (this.hostWatchRequest) {
      this.hostWatchRequest.abort()
      this.hostWatchRequest = null
    }
    console.log(`[K8s] Starting Host watch`)
    let watchEnded = false

    const watchCallback = async (
      type: string,
      apiObj: {
        metadata: {
          name: string
          namespace?: string
          uid?: string
          generation?: number
          resourceVersion?: string
          annotations?: Record<string, string>
        }
        spec: HostSpec
        status?: HostCRD['status']
      }
    ) => {
      if (watchEnded || this.stopped || watchGeneration !== this.hostWatchGeneration) return
      const host: HostCRD = {
        name: apiObj.metadata.name,
        namespace: apiObj.metadata.namespace || config.hostNamespace,
        uid: apiObj.metadata.uid,
        generation: apiObj.metadata.generation,
        resourceVersion: apiObj.metadata.resourceVersion,
        annotations: apiObj.metadata.annotations,
        spec: apiObj.spec,
        status: apiObj.status,
      }

      console.log(`[K8s] Host watch event: ${type} for ${host.name}`)

      if (type !== 'ADDED' && type !== 'MODIFIED' && type !== 'DELETED') return
      const eventType: HostWatchEventType = type
      this.clearHostWatchRetry(host.name)
      const eventRevision = ++this.hostWatchRevision
      this.latestHostWatchEventRevisions.set(host.name, eventRevision)
      // Advance hostDesiredRevision only on a real desired-state change (the
      // content identity the mutation-authority fence reads), separate from the
      // per-event hostWatchRevision counter above.
      const previousHost = this.hosts.get(host.name)
      let hostDesiredStateChanged = false
      // Same pre-event snapshot, aliased for the Host→LlmHook reverse index: a
      // removed reference must re-reconcile the (now smaller) NetworkPolicy
      // ingress set for the affected hook pod keys.
      const previousHostForHooks = previousHost
      if (eventType === 'ADDED' || eventType === 'MODIFIED') {
        hostDesiredStateChanged =
          previousHost === undefined || !this.sameHostDesiredRevision(previousHost, host)
        this.hosts.set(host.name, host)
      } else {
        hostDesiredStateChanged = this.hosts.delete(host.name)
      }
      if (hostDesiredStateChanged) this.hostDesiredRevision += 1

      try {
        // Direct dispatch (§10.3): reconcileHostWatchEvent enters the per-Host
        // serializer inside reconcile()/reconcileDelete(). The removed
        // process-wide convergence tail no longer gates independent Hosts.
        await this.reconcileHostWatchEvent(eventType, host, eventRevision)
        this.completeHostWatchEvent(host.name, eventRevision)
      } catch (error) {
        console.error(`[K8s] Host reconciliation failed for ${host.name}:`, error)
        this.scheduleHostWatchReconcileRetry(eventType, host, eventRevision)
      }

      // Fan out to the LlmHook NetworkPolicy ingress (§5): re-reconcile the hook
      // pod keys this Host references now (or referenced before), so ingress
      // admits exactly the current set of mcp-hosts.
      const affectedHookIds = new Set<string>([
        ...referencedHookIds(previousHostForHooks),
        ...(eventType === 'DELETED' ? [] : referencedHookIds(host)),
      ])
      if (affectedHookIds.size > 0) {
        try {
          await this.llmHookReconciler.reconcileNetworkPoliciesForHooks([...affectedHookIds])
        } catch (error) {
          console.error(
            `[K8s] LlmHook NetworkPolicy fan-out after Host "${host.name}" change failed:`,
            error
          )
        }
      }

      // Keep this Host's scoped egress-to-hooks policy in sync with its CURRENT
      // references (N1/N7) — in particular the "dropped the last hook reference"
      // case, where the policy must be removed. On DELETE the Host reconciler's
      // deleteHostNetworkPolicies removes it by name.
      if (eventType !== 'DELETED') {
        try {
          await this.llmHookReconciler.reconcileHostEgress(host)
        } catch (error) {
          console.error(`[K8s] Host egress-to-hooks reconcile for "${host.name}" failed:`, error)
        }
      }
    }

    const doneCallback = (err: Error | null) => {
      if (watchEnded || this.stopped || watchGeneration !== this.hostWatchGeneration) return
      watchEnded = true
      this.hostWatchRequest = null
      this.hostCacheSynced = false
      this.hostWatchGeneration += 1
      this.clearAllHostWatchRetries()
      if (err) {
        console.error('[K8s] Host watch error:', err)
      }
      console.log('[K8s] Host watch ended; rebuilding the Host snapshot before watch recovery')
      this.attemptHostCacheRecovery()
    }

    const request = await this.watch.watch(path, { resourceVersion }, watchCallback, doneCallback)
    if (this.stopped || watchGeneration !== this.hostWatchGeneration || watchEnded) {
      request.abort()
      if (!this.stopped && watchGeneration !== this.hostWatchGeneration && watchEnded) {
        throw new Error('Host watch ended before request initialization completed')
      }
      return watchGeneration
    }
    this.hostWatchRequest = request
    return watchGeneration
  }

  /**
   * Stop all watches.
   */
  async stop(): Promise<void> {
    this.stopped = true
    this.externalEgressCoordinator.stop()
    this.retireMcpServerWatch()
    this.retireContextWatch()
    this.ccCacheSynced = false
    this.hostCacheSynced = false
    this.hostWatchGeneration += 1
    this.ccWatchGeneration += 1
    this.hostFleetScheduler.stop()
    if (this.ccCacheRecoveryTimer) {
      clearTimeout(this.ccCacheRecoveryTimer)
      this.ccCacheRecoveryTimer = null
    }
    if (this.hostCacheRecoveryTimer) {
      clearTimeout(this.hostCacheRecoveryTimer)
      this.hostCacheRecoveryTimer = null
    }
    if (this.sfsWatchRestartTimer) {
      clearTimeout(this.sfsWatchRestartTimer)
      this.sfsWatchRestartTimer = null
    }
    if (this.gfsWatchRestartTimer) {
      clearTimeout(this.gfsWatchRestartTimer)
      this.gfsWatchRestartTimer = null
    }
    this.hostCacheRecoveryIntent = null
    if (this.mcpServerCacheRecoveryTimer) {
      clearTimeout(this.mcpServerCacheRecoveryTimer)
      this.mcpServerCacheRecoveryTimer = null
    }
    if (this.contextCacheRecoveryTimer) {
      clearTimeout(this.contextCacheRecoveryTimer)
      this.contextCacheRecoveryTimer = null
    }
    this.clearAllHostWatchRetries()
    if (this.resyncTimer) {
      clearInterval(this.resyncTimer)
      this.resyncTimer = null
    }
    if (this.sfsResyncTimer) {
      clearInterval(this.sfsResyncTimer)
      this.sfsResyncTimer = null
    }
    if (this.llmHookResyncTimer) {
      clearInterval(this.llmHookResyncTimer)
      this.llmHookResyncTimer = null
    }
    if (this.gfsResyncTimer) {
      clearInterval(this.gfsResyncTimer)
      this.gfsResyncTimer = null
    }
    for (const timer of this.initialConvergenceRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.initialConvergenceRetryTimers.clear()
    this.initialConvergenceRetryAttempts.clear()
    if (this.mcpWatchRequest) {
      console.log('[K8s] Stopping McpServer watch')
      this.mcpWatchRequest.abort()
      this.mcpWatchRequest = null
    }
    if (this.ctxWatchRequest) {
      console.log('[K8s] Stopping Context watch')
      this.ctxWatchRequest.abort()
      this.ctxWatchRequest = null
    }
    if (this.hostWatchRequest) {
      console.log('[K8s] Stopping Host watch')
      this.hostWatchRequest.abort()
      this.hostWatchRequest = null
    }
    if (this.sfsWatchRequest) {
      console.log('[K8s] Stopping SharedFileSystem watch')
      this.sfsWatchRequest.abort()
      this.sfsWatchRequest = null
    }
    if (this.gfsWatchRequest) {
      console.log('[K8s] Stopping GlobalFileSystem watch')
      this.gfsWatchRequest.abort()
      this.gfsWatchRequest = null
    }
    if (this.ccWatchRequest) {
      console.log('[K8s] Stopping CommunicationChannel watch')
      this.ccWatchRequest.abort()
      this.ccWatchRequest = null
    }
    if (this.llmHookWatchRequest) {
      console.log('[K8s] Stopping LlmHook watch')
      this.llmHookWatchRequest.abort()
      this.llmHookWatchRequest = null
    }
    await Promise.allSettled([
      this.infrastructureTelemetryReporter?.stop(),
      this.administrativeOutcomeReporter?.stop(),
    ])
  }
}

/**
 * Dev mode McpServer provider - uses servers from environment variable.
 * No reconciliation in dev mode (no K8s Deployments, Services, or NetworkPolicies).
 *
 * Context-based filtering mirrors production behaviour:
 *   - If CLERUM_CONTEXTS is set, getServerInfosByContext reads those contexts
 *     and returns only the servers listed in the matching context's mcpServers list.
 *   - If CLERUM_CONTEXTS is NOT set, it falls back to matching by contextRef on the server.
 */
export class DevMcpServerProvider implements McpServerProvider {
  private servers: Map<string, McpServerCRD> = new Map()
  private contexts: Map<string, ContextCRD> = new Map()
  private changeCallback?: () => void

  getAllServers(): McpServerCRD[] {
    return [...this.servers.values()]
  }

  private toServerInfo(server: McpServerCRD): McpServerInfo {
    return {
      name: server.name,
      description: server.spec.description,
      contextRef: server.spec.contextRef,
      transport: server.spec.transport,
      auth: server.spec.auth,
      enabled: server.spec.enabled !== false,
      status: { deployed: true, ready: true, message: 'Dev mode' },
    }
  }

  getAllServerInfos(): McpServerInfo[] {
    return this.getAllServers().map(s => this.toServerInfo(s))
  }

  /**
   * Get servers for a context.
   * If CLERUM_CONTEXTS was provided, uses the context's mcpServers allow-list
   * (mirrors production behaviour). Otherwise falls back to contextRef matching.
   */
  async getServerInfosByContext(contextRef: string): Promise<McpServerInfo[]> {
    const context = this.contexts.get(contextRef)

    if (context) {
      // Production-like behaviour: filter by the Context's mcpServers list
      const allowedNames = new Set(context.spec.mcpServers)
      console.log(
        `[Dev] Context "${contextRef}" allows servers: [${context.spec.mcpServers.join(', ')}]`
      )

      return this.getAllServers()
        .filter(s => allowedNames.has(s.name) && s.spec.enabled !== false)
        .map(s => this.toServerInfo(s))
    }

    if (this.contexts.size > 0) {
      // Contexts are loaded but this one doesn't exist — return empty
      console.warn(`[Dev] Context "${contextRef}" not found — returning no servers`)
      return []
    }

    // Fallback: no contexts loaded, filter by contextRef on the server
    console.log(`[Dev] No CLERUM_CONTEXTS set — falling back to contextRef matching`)
    return this.getAllServers()
      .filter(s => s.spec.contextRef === contextRef && s.spec.enabled !== false)
      .map(s => this.toServerInfo(s))
  }

  onChange(callback: () => void): void {
    this.changeCallback = callback
  }

  async start(): Promise<void> {
    // Load MCP servers
    console.log(`[Dev] Loading MCP servers from CLERUM_MCP_SERVERS`)

    for (const server of config.devMcpServers) {
      const serverWithNamespace: McpServerCRD = {
        ...server,
        namespace: server.namespace || 'dev',
      }
      this.servers.set(server.name, serverWithNamespace)
      console.log(`[Dev] Loaded server: ${server.name} (context: ${server.spec.contextRef})`)
    }

    console.log(`[Dev] Loaded ${this.servers.size} MCP server(s)`)

    // Load contexts
    if (config.devContexts.length > 0) {
      console.log(`[Dev] Loading Contexts from CLERUM_CONTEXTS`)
      for (const ctx of config.devContexts) {
        this.contexts.set(ctx.spec.contextId, ctx)
        console.log(
          `[Dev] Loaded context: ${ctx.name} → mcpServers=[${ctx.spec.mcpServers.join(', ')}]`
        )
      }
      console.log(`[Dev] Loaded ${this.contexts.size} Context(s)`)
    } else {
      console.log(
        `[Dev] No CLERUM_CONTEXTS set — context filtering will fall back to contextRef matching`
      )
    }
  }

  async stop(): Promise<void> {
    console.log('[Dev] Stopping dev provider')
  }

  /** Add a server dynamically (useful for testing). */
  addServer(server: McpServerCRD): void {
    this.servers.set(server.name, server)
    this.changeCallback?.()
  }

  /** Remove a server dynamically (useful for testing). */
  removeServer(name: string): void {
    this.servers.delete(name)
    this.changeCallback?.()
  }

  /** Add a context dynamically (useful for testing). */
  addContext(context: ContextCRD): void {
    this.contexts.set(context.spec.contextId, context)
    this.changeCallback?.()
  }

  /** Remove a context dynamically (useful for testing). */
  removeContext(contextId: string): void {
    this.contexts.delete(contextId)
    this.changeCallback?.()
  }
}

/**
 * Create the appropriate provider based on mode.
 */
export function createMcpServerProvider(): McpServerProvider {
  if (config.devMode) {
    console.log('[Provider] Creating dev mode provider')
    return new DevMcpServerProvider()
  } else {
    console.log('[Provider] Creating K8s watcher provider (with reconciler)')
    return new McpServerWatcher()
  }
}

function authorizationMetadata(metadata: {
  uid?: string
  resourceVersion?: string
  deletionTimestamp?: string | Date
}): { uid: string; resourceVersion: string; deletionTimestamp?: string } {
  return {
    uid: metadata.uid ?? '',
    resourceVersion: metadata.resourceVersion ?? '',
    ...(metadata.deletionTimestamp
      ? { deletionTimestamp: new Date(metadata.deletionTimestamp).toISOString() }
      : {}),
  }
}

export function isMcpAuthorizationNotFound(error: unknown): boolean {
  return getErrorCode(error) === 404
}

/**
 * Live Kubernetes authority used only by the protected v2 Host MCP routes.
 * Reads are deliberately not served from watch caches: every successful
 * credential operation is fenced against current object UIDs/resourceVersions.
 */
export function createMcpAuthorizationStore(provider: McpServerProvider): McpAuthorizationStore {
  if (config.devMode || !customObjectsApi || !hostCustomObjectsApi || !coreApi) {
    return {
      async readHost() {
        return null
      },
      async readContext() {
        return null
      },
      async readMcpServer() {
        return null
      },
      async readSecretMetadata() {
        return null
      },
      async readSecret() {
        return null
      },
    }
  }

  return {
    async readHost(name: string): Promise<AuthorityHost | null> {
      try {
        const object = (await hostCustomObjectsApi!.getNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace: config.hostNamespace,
          plural: PLURAL_HOSTS,
          name,
        })) as {
          metadata: {
            name: string
            namespace?: string
            uid?: string
            resourceVersion?: string
            deletionTimestamp?: string
          }
          spec: HostSpec
        }
        return {
          name: object.metadata.name,
          namespace: object.metadata.namespace ?? config.hostNamespace,
          metadata: authorizationMetadata(object.metadata),
          contextRef: object.spec.contextRef,
        }
      } catch (error) {
        if (isMcpAuthorizationNotFound(error)) return null
        throw error
      }
    },

    async readContext(name: string): Promise<AuthorityContext | null> {
      try {
        const object = (await customObjectsApi!.getNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace: config.namespace,
          plural: PLURAL_CONTEXTS,
          name,
        })) as {
          metadata: {
            name: string
            namespace?: string
            uid?: string
            resourceVersion?: string
            deletionTimestamp?: string
          }
          spec: ContextSpec
        }
        return {
          name: object.metadata.name,
          namespace: object.metadata.namespace ?? config.namespace,
          metadata: authorizationMetadata(object.metadata),
          mcpServers: [...object.spec.mcpServers],
        }
      } catch (error) {
        if (isMcpAuthorizationNotFound(error)) return null
        throw error
      }
    },

    async readMcpServer(name: string): Promise<AuthorityMcpServer | null> {
      try {
        const object = (await customObjectsApi!.getNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace: config.namespace,
          plural: PLURAL_MCPSERVERS,
          name,
        })) as McpServerWatchObject & {
          metadata: McpServerWatchObject['metadata'] & {
            resourceVersion?: string
            deletionTimestamp?: string
          }
        }
        const status = provider.getAllServerInfos().find(server => server.name === name)
          ?.status ?? {
          deployed: false,
          ready: false,
        }
        return {
          name: object.metadata.name,
          namespace: object.metadata.namespace ?? config.namespace,
          metadata: authorizationMetadata(object.metadata),
          description: object.spec.description,
          transport: { ...object.spec.transport },
          auth: object.spec.auth ? { ...object.spec.auth } : undefined,
          // grantScope drives the inventory authKind derivation (mini-spec 10 §3.1).
          oauth: object.spec.oauth ? { ...object.spec.oauth } : undefined,
          enabled: object.spec.enabled !== false,
          status,
        }
      } catch (error) {
        if (isMcpAuthorizationNotFound(error)) return null
        throw error
      }
    },

    async readSecretMetadata(name: string): Promise<AuthoritySecretMetadata | null> {
      try {
        // CoreV1Api returns a Secret object, but this boundary intentionally
        // drops `data` immediately. Inventory authorization can therefore use
        // UID/resourceVersion without making credential bytes available to the
        // service layer or its DTO/logging path.
        const object = await coreApi!.readNamespacedSecret({ name, namespace: config.namespace })
        return {
          name: object.metadata?.name ?? name,
          namespace: object.metadata?.namespace ?? config.namespace,
          metadata: authorizationMetadata({
            uid: object.metadata?.uid,
            resourceVersion: object.metadata?.resourceVersion,
            deletionTimestamp: object.metadata?.deletionTimestamp,
          }),
        }
      } catch (error) {
        if (isMcpAuthorizationNotFound(error)) return null
        throw error
      }
    },

    async readSecret(name: string): Promise<AuthoritySecret | null> {
      try {
        const object = await coreApi!.readNamespacedSecret({ name, namespace: config.namespace })
        return {
          name: object.metadata?.name ?? name,
          namespace: object.metadata?.namespace ?? config.namespace,
          metadata: authorizationMetadata({
            uid: object.metadata?.uid,
            resourceVersion: object.metadata?.resourceVersion,
            deletionTimestamp: object.metadata?.deletionTimestamp,
          }),
          data: { ...(object.data ?? {}) },
        }
      } catch (error) {
        if (isMcpAuthorizationNotFound(error)) return null
        throw error
      }
    },
  }
}
