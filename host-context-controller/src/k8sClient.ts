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
import { gfsDefaultFactoryConfig } from './gfsConfig'
import { GfsReconciler } from './gfsReconciler'
import { ControlApiGfsSeedClient } from './gfsSeedClient'
import {
  HostFleetReconcileError,
  HostReconciler,
  type HostReconcileSource,
  type ResolvedSfsMount,
} from './hostReconciler'
import {
  hostDeleteCleanupTotal,
  hostFleetRequestsTotal,
  hostWatchRecoverySeconds,
} from './metrics'
import {
  type InfrastructureTelemetryReporter,
  createInfrastructureTelemetryReporter,
} from './infrastructureTelemetryReporter'
import { K8sGfsApi } from './k8s/gfsK8sApi'
import { makeHostK8sApiClient } from './k8s/hostK8sApiClient'
import { pvcName as sfsPvcName } from './k8s/sharedFileSystemFactory'
import { NetworkPolicyReconciler } from './networkPolicyReconciler'
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
  McpServerCRD,
  McpServerInfo,
  McpServerSpec,
  SharedFileSystemCRD,
  SharedFileSystemSpec,
} from './types'

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
const EXTERNAL_EGRESS_RETRY_DELAYS_MS = [5000, 15000, 30000]
const EXTERNAL_EGRESS_RESYNC_MAX_CONCURRENCY = 10
const EXTERNAL_EGRESS_RESYNC_JITTER_MS = 5000
const COMMUNICATION_CHANNEL_CACHE_RECOVERY_RETRY_MS = 5000
const COMMUNICATION_CHANNEL_FLEET_RETRY_DELAYS_MS = [5000, 15000, 30000, 60000, 300000]
const HOST_CACHE_RECOVERY_RETRY_MS = 5000
const HOST_WATCH_RECONCILE_RETRY_DELAYS_MS = [5000, 15000, 30000]
// Wake-pending Hosts get immediate per-Host admission after watch recovery
// (§10.2 step 7) rather than waiting for the background fleet pass.
const WAKE_REQUESTED_ANNOTATION = 'clerum.io/wake-requested'

type CommunicationChannelSnapshot = {
  channels: CommunicationChannelCRD[]
  resourceVersion?: string
}

type HostSnapshot = {
  hosts: HostCRD[]
  resourceVersion?: string
}

type HostFleetReconcileMode = 'full' | 'lifecycle'
type HostWatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED'

type HostFleetReconcileRequest = {
  reason: string
  mode: HostFleetReconcileMode
  ccLifecycleGeneration?: number
}

type PendingHostFleetReconcile = HostFleetReconcileRequest & {
  promise: Promise<void>
  resolve: () => void
}

type ActiveHostFleetReconcile = HostFleetReconcileRequest & { promise: Promise<void> }

function hostFleetRequestCovers(
  active: HostFleetReconcileRequest,
  requested: HostFleetReconcileRequest
): boolean {
  const modeCovered = active.mode === 'full' || requested.mode === 'lifecycle'
  if (!modeCovered) return false
  if (requested.ccLifecycleGeneration === undefined) return true
  return active.ccLifecycleGeneration === requested.ccLifecycleGeneration
}

function mergeHostFleetRequests(
  pending: HostFleetReconcileRequest,
  requested: HostFleetReconcileRequest
): HostFleetReconcileRequest {
  const pendingGeneration = pending.ccLifecycleGeneration
  const requestedGeneration = requested.ccLifecycleGeneration
  return {
    reason: requested.reason,
    mode: pending.mode === 'full' || requested.mode === 'full' ? 'full' : 'lifecycle',
    ccLifecycleGeneration:
      pendingGeneration === undefined
        ? requestedGeneration
        : requestedGeneration === undefined
          ? pendingGeneration
          : Math.max(pendingGeneration, requestedGeneration),
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
  /** Get auth token for a server from K8s secret. */
  getAuthToken(serverName: string): Promise<string | undefined>
  /** Set callback for when servers change. */
  onChange(callback: () => void): void
  start(): Promise<void>
  stop(): Promise<void>
}

/**
 * List all McpServer CRDs in the namespace.
 */
export async function listAllMcpServers(): Promise<McpServerCRD[]> {
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
    return servers
  } catch (error) {
    console.error('[K8s] Failed to list McpServers:', error)
    throw error
  }
}

/**
 * List all Context CRDs in the namespace.
 */
export async function listAllContexts(): Promise<ContextCRD[]> {
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
      items: Array<{
        metadata: { name: string; namespace?: string }
        spec: ContextSpec
      }>
    }

    const contexts = list.items.map(item => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace || config.namespace,
      spec: item.spec,
    }))

    console.log(`[K8s] Found ${contexts.length} Context(s)`)
    return contexts
  } catch (error) {
    console.error('[K8s] Failed to list Contexts:', error)
    throw error
  }
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
 * Get auth token from a secret.
 */
export async function getAuthToken(
  secretRef: string,
  secretKey?: string
): Promise<string | undefined> {
  if (!coreApi) {
    throw new Error('K8s client not initialized - are you in dev mode?')
  }

  try {
    console.log(`[K8s] Getting auth token from secret: ${secretRef}`)

    const response = await coreApi.readNamespacedSecret({
      name: secretRef,
      namespace: config.namespace,
    })

    const data = response.data || {}

    // Try the specified key, or common key names
    const keys = secretKey ? [secretKey] : ['token', 'api-key', 'apiKey', 'password']

    for (const key of keys) {
      if (data[key]) {
        const token = Buffer.from(data[key], 'base64').toString('utf-8')
        console.log(`[K8s] Found auth token in secret (key: ${key})`)
        return token
      }
    }

    console.warn(`[K8s] No auth token found in secret ${secretRef}`)
    return undefined
  } catch (error) {
    if ((error as { response?: { statusCode?: number } }).response?.statusCode === 404) {
      console.warn(`[K8s] Secret not found: ${secretRef}`)
      return undefined
    }
    console.error(`[K8s] Failed to get auth token:`, error)
    return undefined
  }
}

/**
 * List all SharedFileSystem CRDs in the mcp-host namespace (the only namespace
 * SharedFileSystems are allowed to live in, per CRD validation).
 */
export async function listAllSharedFileSystems(): Promise<SharedFileSystemCRD[]> {
  if (!customObjectsApi) {
    throw new Error('K8s client not initialized - are you in dev mode?')
  }
  try {
    console.log(`[K8s] Listing all SharedFileSystems in namespace ${config.hostNamespace}`)
    const response = await customObjectsApi.listNamespacedCustomObject({
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
      items: Array<{ metadata: { name: string; namespace?: string }; spec: GlobalFileSystemSpec }>
    }
    return list.items.map(item => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace || namespace,
      spec: item.spec,
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
    const code =
      (error as { code?: number; response?: { statusCode?: number } }).code ??
      (error as { response?: { statusCode?: number } }).response?.statusCode
    if (code === 404) {
      console.warn(`[K8s] Context CRD not found: ${contextId}`)
      return null
    }
    console.error(`[K8s] Failed to read Context CRD:`, error)
    return null
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
  private servers: Map<string, McpServerCRD> = new Map()
  private hosts: Map<string, HostCRD> = new Map()
  private contexts: Map<string, ContextCRD> = new Map()
  private sharedFileSystems: Map<string, SharedFileSystemCRD> = new Map()
  private communicationChannels: Map<string, CommunicationChannelCRD> = new Map()
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
  // Host watch LIST-to-WATCH recovery is a dedicated, deduplicated operation
  // (§10.2). Concurrent recovery signals reuse the in-flight promise so exactly
  // one LIST + WATCH is installed. Independent per-Host events no longer share a
  // process-wide convergence tail — they enter the per-Host serializer directly.
  private hostRecoveryInFlight: Promise<HostCRD[]> | null = null
  // B2: tracks whether the CC snapshot is paired with a continuing watch.
  // Set to true only while a complete snapshot is paired with a live watch;
  // used by HostReconciler to make fail-closed lifecycle decisions.
  private ccCacheSynced = false
  private ccWatchGeneration = 0
  private ccCacheRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  private ccCacheRecoveryInFlight: Promise<boolean> | null = null
  private ccLifecycleGeneration = 0
  private ccAppliedLifecycleGeneration = -1
  private ccFleetRetryTimer: ReturnType<typeof setTimeout> | null = null
  private ccFleetRetryAttempt = 0
  private hostFleetReconcileInFlight: ActiveHostFleetReconcile | null = null
  private hostFleetReconcilePending: PendingHostFleetReconcile | null = null
  private resolveHostFleetShutdown: () => void = () => {}
  private readonly hostFleetShutdown = new Promise<void>(resolve => {
    this.resolveHostFleetShutdown = resolve
  })
  private hostResyncInFlight: Promise<void> | null = null
  private changeCallback?: () => void
  private stopped = false
  private reconciler: McpServerReconciler
  private hostReconciler: HostReconciler
  private netPolReconciler: NetworkPolicyReconciler
  private bindingReconciler: BindingPolicyReconciler
  private sharedFileSystemReconciler: SharedFileSystemReconciler
  private gfsReconciler: GfsReconciler
  private readonly infrastructureTelemetryReporter?: InfrastructureTelemetryReporter
  private readonly administrativeOutcomeReporter?: AdministrativeOutcomeReporter
  private readonly externalEgressRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly externalEgressRetryAttempts = new Map<string, number>()
  private readonly externalEgressInFlight = new Map<string, Promise<void>>()
  // Periodic resync timer: K8s watches can drop events on long disconnects;
  // running fullReconcile every N minutes guarantees mcp-host-runtime-token Secret
  // rotation eventually catches up even after a missed MODIFIED event.
  // Disabled when interval <= 0 (tests).
  private resyncTimer: ReturnType<typeof setInterval> | null = null
  private externalEgressResyncTimer: ReturnType<typeof setInterval> | null = null
  // Periodic SharedFileSystem resync (#592): the SFS watch fires only on SFS CRD
  // changes, not on PVC binding / wfc pod readiness, so a SharedFileSystem that
  // reported Initializing/Degraded needs a periodic re-reconcile to converge to a
  // truthful Ready. Disabled when interval <= 0 (tests).
  private sfsResyncTimer: ReturnType<typeof setInterval> | null = null
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
    // Orphan cleanup requires known watch authority and a stable watch
    // generation; expose both so cleanup fail-closes while authority is unknown
    // or the watch has been retired mid-pass.
    this.hostReconciler.setHostWatchAuthority(() => ({
      known: this.hostCacheSynced,
      generation: this.hostWatchGeneration,
    }))
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

  private installCommunicationChannelSnapshot(snapshot: CommunicationChannelSnapshot): void {
    this.communicationChannels.clear()
    for (const channel of snapshot.channels) {
      this.communicationChannels.set(channel.name, channel)
    }
  }

  private beginCommunicationChannelLifecycleTransition(): number {
    this.ccLifecycleGeneration += 1
    this.ccFleetRetryAttempt = 0
    if (this.ccFleetRetryTimer) {
      clearTimeout(this.ccFleetRetryTimer)
      this.ccFleetRetryTimer = null
    }
    return this.ccLifecycleGeneration
  }

  private markCommunicationChannelLifecycleApplied(generation: number): void {
    if (generation !== this.ccLifecycleGeneration) return
    this.ccAppliedLifecycleGeneration = generation
    this.ccFleetRetryAttempt = 0
    if (this.ccFleetRetryTimer) {
      clearTimeout(this.ccFleetRetryTimer)
      this.ccFleetRetryTimer = null
    }
  }

  private scheduleCommunicationChannelFleetRetry(request: HostFleetReconcileRequest): void {
    const generation = request.ccLifecycleGeneration
    if (generation === undefined) return
    if (
      this.stopped ||
      generation !== this.ccLifecycleGeneration ||
      generation === this.ccAppliedLifecycleGeneration ||
      this.ccFleetRetryTimer
    ) {
      return
    }
    const delayIndex = Math.min(
      this.ccFleetRetryAttempt,
      COMMUNICATION_CHANNEL_FLEET_RETRY_DELAYS_MS.length - 1
    )
    const retryDelay = COMMUNICATION_CHANNEL_FLEET_RETRY_DELAYS_MS[delayIndex]
    this.ccFleetRetryAttempt += 1
    this.ccFleetRetryTimer = setTimeout(() => {
      this.ccFleetRetryTimer = null
      if (
        this.stopped ||
        generation !== this.ccLifecycleGeneration ||
        generation === this.ccAppliedLifecycleGeneration
      ) {
        return
      }
      void this.requestHostFleetReconcile(
        'CommunicationChannel lifecycle convergence retry',
        generation,
        request.mode
      )
    }, retryDelay)
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

  private installHostSnapshot(snapshot: HostSnapshot): void {
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
  private recoverHostInventoryAndWatch(): Promise<HostCRD[]> {
    if (this.stopped) return Promise.resolve([])
    if (this.hostRecoveryInFlight) return this.hostRecoveryInFlight
    const recovery = this.performHostInventoryRecovery()
    this.hostRecoveryInFlight = recovery
    const clear = (): void => {
      if (this.hostRecoveryInFlight === recovery) this.hostRecoveryInFlight = null
    }
    void recovery.then(clear, clear)
    return recovery
  }

  private async performHostInventoryRecovery(): Promise<HostCRD[]> {
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
      hostWatchRecoverySeconds.observe(
        { phase: 'watch', outcome: 'success' },
        (Date.now() - watchStartedAt) / 1000
      )
      hostWatchRecoverySeconds.observe(
        { phase: 'total', outcome: 'success' },
        (Date.now() - startedAt) / 1000
      )
      if (this.hostCacheRecoveryTimer) {
        clearTimeout(this.hostCacheRecoveryTimer)
        this.hostCacheRecoveryTimer = null
      }
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
      // Request a coalesced background full pass, but do NOT await it before
      // declaring watch recovery complete.
      void this.requestHostFleetReconcile('Host watch recovery convergence', undefined, 'full')
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
        console.error('[K8s] Host watch recovery failed:', error)
        this.scheduleHostCacheRecovery()
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
    // The fresh authoritative LIST already confirmed absence and the cache no
    // longer holds this Host, so cleanup is authorized. Route it through the
    // per-Host serializer (reconcileDelete → serializeByHost) so an older
    // in-flight reconcile for the same Host cannot recreate its resources after
    // cleanup.
    hostDeleteCleanupTotal.inc({ outcome: 'confirmed' })
    try {
      await this.hostReconciler.reconcileDelete(name, config.hostNamespace)
      hostDeleteCleanupTotal.inc({ outcome: 'completed' })
    } catch (error) {
      hostDeleteCleanupTotal.inc({ outcome: 'retried' })
      console.error(
        `[K8s] Recovered Host delete cleanup failed for "${name}"; the safety-net sweep will retry:`,
        error
      )
    }
  }

  private scheduleHostCacheRecovery(): void {
    if (this.stopped || this.hostCacheRecoveryTimer) return
    this.hostCacheRecoveryTimer = setTimeout(() => {
      this.hostCacheRecoveryTimer = null
      // Watch recovery is an independent operation, no longer coupled to a full
      // fleet pass. Recovery itself requests the background convergence pass.
      void this.recoverHostInventoryAndWatch().catch(() => undefined)
    }, HOST_CACHE_RECOVERY_RETRY_MS)
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
    if (this.stopped) return Promise.resolve()
    const requestMode = mode ?? (ccLifecycleGeneration === undefined ? 'full' : 'lifecycle')
    if (
      ccLifecycleGeneration !== undefined &&
      (ccLifecycleGeneration !== this.ccLifecycleGeneration ||
        (requestMode === 'lifecycle' &&
          ccLifecycleGeneration === this.ccAppliedLifecycleGeneration))
    ) {
      return Promise.resolve()
    }

    const request: HostFleetReconcileRequest = {
      reason,
      mode: requestMode,
      ccLifecycleGeneration,
    }
    const active = this.hostFleetReconcileInFlight
    if (!active) {
      hostFleetRequestsTotal.inc({ result: 'started' })
      return this.waitForHostFleetOrShutdown(this.startHostFleetReconcile(request))
    }
    if (hostFleetRequestCovers(active, request)) {
      hostFleetRequestsTotal.inc({ result: 'coalesced' })
      return this.waitForHostFleetOrShutdown(active.promise)
    }

    if (!this.hostFleetReconcilePending) {
      let resolve!: () => void
      const promise = new Promise<void>(resolvePromise => {
        resolve = resolvePromise
      })
      this.hostFleetReconcilePending = {
        ...request,
        promise,
        resolve,
      }
    } else {
      const merged = mergeHostFleetRequests(this.hostFleetReconcilePending, request)
      this.hostFleetReconcilePending.reason = merged.reason
      this.hostFleetReconcilePending.mode = merged.mode
      this.hostFleetReconcilePending.ccLifecycleGeneration = merged.ccLifecycleGeneration
    }
    // The request did not start its own pass; it is queued behind the active one.
    hostFleetRequestsTotal.inc({ result: 'coalesced' })
    return this.waitForHostFleetOrShutdown(this.hostFleetReconcilePending.promise)
  }

  private waitForHostFleetOrShutdown(coverage: Promise<void>): Promise<void> {
    return Promise.race([coverage, this.hostFleetShutdown])
  }

  private startHostFleetReconcile(request: HostFleetReconcileRequest): Promise<void> {
    const promise = this.performHostFleetReconcile(request)
    const active: ActiveHostFleetReconcile = { ...request, promise }
    this.hostFleetReconcileInFlight = active

    const settle = () => {
      if (this.hostFleetReconcileInFlight !== active) return
      this.hostFleetReconcileInFlight = null
      const pending = this.hostFleetReconcilePending
      this.hostFleetReconcilePending = null
      if (!pending) return
      if (this.stopped) {
        pending.resolve()
        return
      }
      hostFleetRequestsTotal.inc({ result: 'trailing' })
      const trailing = this.startHostFleetReconcile(pending)
      void trailing.then(pending.resolve, pending.resolve)
    }
    void promise.then(settle, settle)
    return promise
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

  private async reconcileSharedFileSystemsReferencedByContext(
    prevContext: ContextCRD | undefined,
    nextContext: ContextCRD | undefined
  ): Promise<void> {
    const names = new Set<string>()
    for (const r of prevContext?.spec.sharedFileSystems ?? []) names.add(r.name)
    for (const r of nextContext?.spec.sharedFileSystems ?? []) names.add(r.name)
    for (const name of names) {
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
    return this.hosts.get(name)
  }

  /**
   * Trigger a reconcile for any cached McpServer whose `envSecret.name`
   * matches the given Secret. Used by SecretInformer to react to Secret
   * lifecycle changes (create/update/delete) without waiting for a CRD
   * event.
   */
  async reconcileByEnvSecret(secretName: string, secretNamespace: string): Promise<void> {
    for (const server of this.servers.values()) {
      if (server.namespace !== secretNamespace) continue
      if (server.spec.envSecret?.name !== secretName) continue
      try {
        console.log(
          `[K8s] Re-reconciling McpServer "${server.name}" after Secret "${secretName}" change`
        )
        await this.reconciler.reconcile(server)
      } catch (err) {
        console.error(`[K8s] Secret-triggered reconcile failed for "${server.name}":`, err)
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
      enabled: server.spec.enabled !== false,
      status: this.reconciler.getStatus(server.name),
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
   * Get auth token for a server from K8s secret.
   */
  async getAuthToken(serverName: string): Promise<string | undefined> {
    const server = this.servers.get(serverName)
    if (!server?.spec.auth?.secretRef) {
      return undefined
    }
    return getAuthToken(server.spec.auth.secretRef, server.spec.auth.secretKey)
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
    let initialServers: McpServerCRD[] = []
    let serverInventoryComplete = false
    try {
      initialServers = await listAllMcpServers()
      serverInventoryComplete = true
      for (const server of initialServers) {
        this.servers.set(server.name, server)
      }
    } catch (error) {
      console.error(
        '[K8s] Skipping initial McpServer full reconciliation because server discovery failed:',
        error
      )
    }

    // Ensure baseline network policies exist even if initial Context discovery fails.
    try {
      await this.netPolReconciler.ensureDefaultPolicies()
    } catch (error) {
      console.error('[K8s] Failed to ensure default NetworkPolicies before startup:', error)
    }

    let initialExternalEgressFailures = new Set<string>()
    if (serverInventoryComplete) {
      initialExternalEgressFailures =
        await this.reconcileInitialExternalEgressBeforeRuntime(initialServers)
    }

    // Full McpServer reconciliation (Deployments + Services). Servers with
    // egressBindings are reconciled only after their external egress policies
    // have converged, matching the ADDED/MODIFIED watch-event contract.
    if (serverInventoryComplete) {
      const runtimeServers = initialServers.filter(
        server => !initialExternalEgressFailures.has(this.externalEgressRetryKey(server))
      )
      console.log('[K8s] Running initial full reconciliation...')
      await this.reconciler.fullReconcile(runtimeServers)
    }

    try {
      const initialContexts = await listAllContexts()
      for (const context of initialContexts) {
        this.contexts.set(context.name, context)
      }
      console.log('[K8s] Running initial NetworkPolicy reconciliation...')
      await this.netPolReconciler.fullReconcile(initialContexts, initialServers, {
        serverInventoryComplete,
        ensureDefaults: false,
      })
    } catch (error) {
      console.error(
        '[K8s] Skipping initial NetworkPolicy reconciliation because context discovery failed:',
        error
      )
    }

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
      `[K8s] Running initial Host reconciliation... (ccCacheSynced=${this.ccCacheSynced})`
    )
    const initialLifecycleGeneration =
      this.ccLifecycleGeneration === 0
        ? this.beginCommunicationChannelLifecycleTransition()
        : this.ccLifecycleGeneration
    await this.requestHostFleetReconcile(
      'initial Host reconciliation',
      initialLifecycleGeneration,
      'full'
    )

    // ── SharedFileSystem initial load + reconciliation ──
    try {
      const initialSfses = await listAllSharedFileSystems()
      for (const sfs of initialSfses) {
        this.sharedFileSystems.set(sfs.name, sfs)
      }
      console.log('[K8s] Running initial SharedFileSystem reconciliation...')
      await this.sharedFileSystemReconciler.fullReconcile(initialSfses)
    } catch (error) {
      console.error(
        '[K8s] Skipping initial SharedFileSystem reconciliation because discovery failed:',
        error
      )
    }

    // ── GlobalFileSystem (gfs) initial load + reconciliation ──
    // gfs is a cluster singleton (DISTINCT from SharedFileSystem). A failed
    // discovery (e.g. the CRD not installed yet) is skipped, not fatal — the
    // next HCC restart / resync retries. Live updates land via the watch
    // (follow-up); the deploy applies the singleton before HCC reconciles it.
    try {
      const initialGfses = await listAllGlobalFileSystems()
      console.log('[K8s] Running initial GlobalFileSystem reconciliation...')
      await this.gfsReconciler.fullReconcile(initialGfses)
    } catch (error) {
      console.error(
        '[K8s] Skipping initial GlobalFileSystem reconciliation because discovery failed:',
        error
      )
    }

    await this.startMcpServerWatch()
    await this.startContextWatch()
    await this.startSharedFileSystemWatch()
    await this.startGlobalFileSystemWatch()

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
    if (externalEgressResyncSec > 0) {
      this.externalEgressResyncTimer = setInterval(() => {
        void this.runExternalEgressResync()
      }, externalEgressResyncSec * 1000)
      console.log(
        `[K8s] External egress periodic DNS resync enabled (every ${externalEgressResyncSec}s)`
      )
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
    }

    const doneCallback = (err: Error | null) => {
      if (this.stopped) return
      if (err) {
        console.error('[K8s] SharedFileSystem watch error:', err)
      }
      console.log('[K8s] SharedFileSystem watch ended, restarting...')
      setTimeout(() => this.startSharedFileSystemWatch(), err ? 5000 : 1000)
    }

    this.sfsWatchRequest = await this.watch.watch(path, {}, watchCallback, doneCallback)
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
      apiObj: { metadata: { name: string; namespace?: string }; spec: GlobalFileSystemSpec }
    ) => {
      const gfs: GlobalFileSystemCRD = {
        name: apiObj.metadata.name,
        namespace: apiObj.metadata.namespace || namespace,
        spec: apiObj.spec,
      }
      console.log(`[K8s] GlobalFileSystem watch event: ${type} for ${gfs.name}`)
      try {
        if (type === 'ADDED' || type === 'MODIFIED') {
          await this.gfsReconciler.reconcile(gfs)
        } else if (type === 'DELETED') {
          await this.gfsReconciler.reconcileDelete(gfs)
        }
      } catch (error) {
        console.error(`[K8s] GlobalFileSystem reconciliation failed for ${gfs.name}:`, error)
      }
    }

    const doneCallback = (err: Error | null) => {
      if (this.stopped) return
      if (err) {
        console.error('[K8s] GlobalFileSystem watch error:', err)
      }
      console.log('[K8s] GlobalFileSystem watch ended, restarting...')
      setTimeout(() => this.startGlobalFileSystemWatch(), err ? 5000 : 1000)
    }

    this.gfsWatchRequest = await this.watch.watch(path, {}, watchCallback, doneCallback)
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
      const gfses = await listAllGlobalFileSystems()
      await this.gfsReconciler.fullReconcile(gfses)
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
      const sfses = await listAllSharedFileSystems()
      this.sharedFileSystems.clear()
      for (const sfs of sfses) this.sharedFileSystems.set(sfs.name, sfs)

      // Capture each SFS's mountability (PVC Bound) BEFORE reconciling so we can
      // detect a flip. resolveContextMounts() injects the RO mount + podAffinity
      // only while the SFS is mountable, so a mountable⇄not-mountable flip changes
      // the mount set of every consuming mcp-host pod. (Keyed on mountability, NOT
      // on phase==='Ready': a transient wfc readiness dip while the PVC stays
      // Bound must NOT re-roll consumers — see resolveContextMounts.)
      const wasMountable = new Map<string, boolean>()
      for (const sfs of sfses) {
        wasMountable.set(sfs.name, this.sharedFileSystemReconciler.isMountable(sfs))
      }

      await this.sharedFileSystemReconciler.fullReconcile(sfses)

      // #592 gap fix: heal the consuming mcp-host Deployments on a mountability
      // flip — inject the mount + affinity once the PVC binds, or drop it if the
      // volume becomes genuinely unusable. This does NOT rely on the status-
      // subresource MODIFIED self-event, which the apiserver suppresses for a
      // no-op patch and which our dirty check makes even less likely to fire — so
      // an already-Bound SFS picked up on HCC restart still re-injects its mount
      // within one resync interval instead of waiting for the (much longer) Host
      // resync.
      for (const sfs of sfses) {
        const nowMountable = this.sharedFileSystemReconciler.isMountable(sfs)
        if (nowMountable !== (wasMountable.get(sfs.name) ?? false)) {
          await this.reconcileHostsReferencingSfs(sfs.name)
        }
      }
    } catch (error) {
      console.error('[K8s] Periodic SharedFileSystem resync failed:', error)
    }
  }

  private async runExternalEgressResync(): Promise<void> {
    if (this.stopped) return
    const servers = [...this.servers.values()]
      .filter(server => (server.spec.egressBindings?.length ?? 0) > 0)
      .sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`))

    if (servers.length === 0) return

    console.log(`[K8s] Periodic external egress DNS resync: ${servers.length} McpServer(s)`)
    let index = 0
    const workers = Array.from(
      { length: Math.min(EXTERNAL_EGRESS_RESYNC_MAX_CONCURRENCY, servers.length) },
      async () => {
        while (!this.stopped) {
          const server = servers[index++]
          if (!server) return
          const key = this.externalEgressRetryKey(server)
          if (this.externalEgressInFlight.has(key)) {
            console.log(`[K8s] Skipping external egress resync for ${key}; reconcile in flight`)
            continue
          }
          if (this.externalEgressRetryTimers.has(key)) {
            console.log(`[K8s] Skipping external egress resync for ${key}; retry already scheduled`)
            continue
          }
          const jitterMs = Math.floor(Math.random() * EXTERNAL_EGRESS_RESYNC_JITTER_MS)
          if (jitterMs > 0) await delay(jitterMs)
          try {
            await this.runExternalEgressOnce('MODIFIED', server)
          } catch (error) {
            console.error(`[K8s] External egress periodic resync failed for ${key}:`, error)
            this.scheduleExternalEgressRetry('MODIFIED', server)
          }
        }
      }
    )
    await Promise.all(workers)
  }

  private async reconcileInitialExternalEgressBeforeRuntime(
    servers: McpServerCRD[]
  ): Promise<Set<string>> {
    const failures = new Set<string>()
    const serversWithExternalEgress = servers
      .filter(server => (server.spec.egressBindings?.length ?? 0) > 0)
      .sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`))

    if (serversWithExternalEgress.length === 0) return failures

    console.log(
      `[K8s] Reconciling external egress before startup runtime reconciliation for ` +
        `${serversWithExternalEgress.length} McpServer(s)`
    )

    for (const server of serversWithExternalEgress) {
      const key = this.externalEgressRetryKey(server)
      try {
        await this.runExternalEgressOnce('MODIFIED', server)
      } catch (error) {
        failures.add(key)
        console.error(
          `[K8s] Initial external egress reconciliation failed for ${key}; ` +
            'runtime reconciliation will stay blocked until retry succeeds:',
          error
        )
        this.scheduleExternalEgressRetry('MODIFIED', server)
      }
    }

    return failures
  }

  /**
   * Start watching McpServer CRDs.
   */
  private getMcpServerWatchCallback(): (
    type: string,
    apiObj: McpServerWatchObject
  ) => Promise<void> {
    return async (type, apiObj) => {
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

      // Update cache
      if (type === 'ADDED' || type === 'MODIFIED') {
        this.servers.set(server.name, server)
      } else if (type === 'DELETED') {
        this.servers.delete(server.name)
      }

      // External egress is part of the workload's pre-start contract. Reconcile
      // it before HCC creates or updates any managed runtime Deployment so a
      // stdio MCP with egressBindings cannot start before ExternalEgressReady.
      if (type === 'ADDED' || type === 'MODIFIED') {
        try {
          await this.runExternalEgressOnce(type, server)
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

      // Trigger deployment reconciliation
      try {
        if (type === 'ADDED' || type === 'MODIFIED') {
          await this.reconciler.reconcile(server)
        } else if (type === 'DELETED') {
          await this.reconciler.reconcileDelete(server.name, server.namespace)
        }
      } catch (error) {
        console.error(`[K8s] Reconciliation failed for ${server.name}:`, error)
        if (
          (type === 'ADDED' || type === 'MODIFIED') &&
          (server.spec.egressBindings?.length ?? 0) > 0
        ) {
          this.scheduleExternalEgressRetry(type, server)
        }
      }

      // Trigger binding policy reconciliation (L3 ingress/egress)
      try {
        if (type === 'ADDED' || type === 'MODIFIED') {
          const bindingsJson = server.annotations?.['clerum.io/recipe-bindings']
          if (bindingsJson) {
            const bindings: BindingDef[] = JSON.parse(bindingsJson)
            const recipeName = server.labels?.['clerum.io/recipe'] ?? server.name
            const mcpWorkloadName = server.labels?.['clerum.io/workload'] ?? server.name
            await this.bindingReconciler.reconcileBindings(
              recipeName,
              bindings,
              mcpWorkloadName,
              server.name
            )
          }
          // Re-reconcile any cached Context that references this server.
          // Fixes race condition where Context MODIFIED arrives before
          // the McpServer ADDED event populates the cache.
          for (const ctx of this.contexts.values()) {
            if (ctx.spec.mcpServers?.includes(server.name)) {
              console.log(
                `[K8s] Re-reconciling context "${ctx.name}" after McpServer "${server.name}" cached`
              )
              await this.netPolReconciler.reconcileContext(ctx)
            }
          }
        } else if (type === 'DELETED') {
          const recipeName = server.labels?.['clerum.io/recipe'] ?? server.name
          await this.bindingReconciler.cleanupBindings(recipeName)
          await this.runExternalEgressOnce(type, server)
        }
      } catch (error) {
        console.error(`[K8s] Binding/egress reconciliation failed for ${server.name}:`, error)
        if (type === 'ADDED' || type === 'MODIFIED' || type === 'DELETED') {
          this.scheduleExternalEgressRetry(type, server)
        }
      }

      // Notify listeners
      this.changeCallback?.()
    }
  }

  private async startMcpServerWatch(): Promise<void> {
    const path = `/apis/${GROUP}/${VERSION}/namespaces/${config.namespace}/${PLURAL_MCPSERVERS}`
    console.log(`[K8s] Starting McpServer watch`)

    const watchCallback = this.getMcpServerWatchCallback()

    const doneCallback = (err: Error | null) => {
      if (this.stopped) return
      if (err) {
        console.error('[K8s] McpServer watch error:', err)
      }
      console.log('[K8s] McpServer watch ended, restarting...')
      setTimeout(() => this.startMcpServerWatch(), err ? 5000 : 1000)
    }

    this.mcpWatchRequest = await this.watch.watch(path, {}, watchCallback, doneCallback)
  }

  private externalEgressRetryKey(server: Pick<McpServerCRD, 'name' | 'namespace'>): string {
    return `${server.namespace}/${server.name}`
  }

  private async runExternalEgressOnce(
    type: string,
    server: McpServerCRD,
    options: { clearRetryOnSuccess?: boolean } = {}
  ): Promise<void> {
    const clearRetryOnSuccess = options.clearRetryOnSuccess ?? true
    const key = this.externalEgressRetryKey(server)
    const existing = this.externalEgressInFlight.get(key)
    if (existing) {
      console.warn(`[K8s] Waiting for external egress reconcile for ${key}; already in flight`)
      await existing
    }

    const run = (async () => {
      if (type === 'DELETED') {
        await this.netPolReconciler.cleanupExternalEgress(server.name, server.namespace)
      } else {
        await this.netPolReconciler.reconcileExternalEgress(server)
      }
    })()
    this.externalEgressInFlight.set(key, run)
    try {
      await run
      if (clearRetryOnSuccess) {
        this.clearExternalEgressRetry(server)
      }
    } finally {
      if (this.externalEgressInFlight.get(key) === run) {
        this.externalEgressInFlight.delete(key)
      }
    }
  }

  private clearExternalEgressRetry(server: Pick<McpServerCRD, 'name' | 'namespace'>): void {
    const key = this.externalEgressRetryKey(server)
    const timer = this.externalEgressRetryTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.externalEgressRetryTimers.delete(key)
    }
    this.externalEgressRetryAttempts.delete(key)
  }

  private scheduleExternalEgressRetry(type: string, server: McpServerCRD): void {
    if (type !== 'ADDED' && type !== 'MODIFIED' && type !== 'DELETED') return
    if (this.stopped) return

    const key = this.externalEgressRetryKey(server)
    if (this.externalEgressRetryTimers.has(key)) return

    const attempt = (this.externalEgressRetryAttempts.get(key) ?? 0) + 1
    const delayMs = EXTERNAL_EGRESS_RETRY_DELAYS_MS[attempt - 1]
    if (!delayMs) {
      console.error(
        `[K8s] External egress retry exhausted for McpServer "${server.name}" in namespace "${server.namespace}"`
      )
      return
    }

    this.externalEgressRetryAttempts.set(key, attempt)
    console.warn(
      `[K8s] Scheduling external egress retry ${attempt}/${EXTERNAL_EGRESS_RETRY_DELAYS_MS.length} ` +
        `for McpServer "${server.name}" in ${delayMs}ms`
    )

    const timer = setTimeout(() => {
      this.externalEgressRetryTimers.delete(key)
      void this.retryExternalEgress(type, server)
    }, delayMs)
    this.externalEgressRetryTimers.set(key, timer)
  }

  private async retryExternalEgress(type: string, server: McpServerCRD): Promise<void> {
    if (this.stopped) return
    try {
      if (type === 'DELETED') {
        await this.runExternalEgressOnce(type, server)
      } else {
        const current = this.servers.get(server.name)
        if (!current || current.namespace !== server.namespace) {
          this.clearExternalEgressRetry(server)
          return
        }
        await this.runExternalEgressOnce(type, current, { clearRetryOnSuccess: false })
        try {
          await this.reconciler.reconcile(current)
          this.clearExternalEgressRetry(current)
        } catch (error) {
          console.error(
            `[K8s] Runtime reconciliation after external egress retry failed for ${server.name}:`,
            error
          )
          this.scheduleExternalEgressRetry(type, current)
        }
      }
    } catch (error) {
      console.error(`[K8s] External egress retry failed for ${server.name}:`, error)
      this.scheduleExternalEgressRetry(type, server)
    }
  }

  /**
   * Start watching Context CRDs for NetworkPolicy reconciliation.
   */
  private async startContextWatch(): Promise<void> {
    const path = `/apis/${GROUP}/${VERSION}/namespaces/${config.namespace}/${PLURAL_CONTEXTS}`
    console.log(`[K8s] Starting Context watch`)

    const watchCallback = async (
      type: string,
      apiObj: { metadata: { name: string; namespace?: string }; spec: ContextSpec }
    ) => {
      const context: ContextCRD = {
        name: apiObj.metadata.name,
        namespace: apiObj.metadata.namespace || config.namespace,
        spec: apiObj.spec,
      }

      console.log(`[K8s] Context watch event: ${type} for ${context.name}`)

      // Capture the previous spec before mutating the cache so we can
      // re-reconcile any SFS that *was* referenced but is no longer.
      const previous = this.contexts.get(context.name)

      // Cache the context for cross-resource re-reconciliation
      if (type === 'ADDED' || type === 'MODIFIED') {
        this.contexts.set(context.name, context)
      } else if (type === 'DELETED') {
        this.contexts.delete(context.name)
      }

      // Re-reconcile every SFS this Context referenced before or after the
      // change so SharedFileSystem.status.mountedByContexts stays in sync
      // without waiting for an SFS-level event.
      const nextForSfs = type === 'DELETED' ? undefined : context
      void this.reconcileSharedFileSystemsReferencedByContext(previous, nextForSfs)

      try {
        if (type === 'ADDED' || type === 'MODIFIED') {
          await this.netPolReconciler.reconcileContext(context)
        } else if (type === 'DELETED') {
          await this.netPolReconciler.reconcileDeleteContext(context.spec.contextId)
        }
      } catch (error) {
        console.error(
          `[K8s] NetworkPolicy reconciliation failed for context ${context.name}:`,
          error
        )
      }

      // Re-reconcile any Host that points at this Context so that changes to
      // spec.sharedFileSystems[] propagate into the mcp-host pod template.
      try {
        for (const host of this.hosts.values()) {
          if (host.spec.contextRef !== context.name) continue
          await this.hostReconciler.reconcile(host)
        }
      } catch (error) {
        console.error(
          `[K8s] Host re-reconcile after Context "${context.name}" change failed:`,
          error
        )
      }
    }

    const doneCallback = (err: Error | null) => {
      if (this.stopped) return
      if (err) {
        console.error('[K8s] Context watch error:', err)
      }
      console.log('[K8s] Context watch ended, restarting...')
      setTimeout(() => this.startContextWatch(), err ? 5000 : 1000)
    }

    this.ctxWatchRequest = await this.watch.watch(path, {}, watchCallback, doneCallback)
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
      if (eventType === 'ADDED' || eventType === 'MODIFIED') {
        this.hosts.set(host.name, host)
      } else {
        this.hosts.delete(host.name)
      }

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
      this.scheduleHostCacheRecovery()
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
    this.ccCacheSynced = false
    this.hostCacheSynced = false
    this.hostWatchGeneration += 1
    this.ccWatchGeneration += 1
    this.resolveHostFleetShutdown()
    this.hostFleetReconcilePending?.resolve()
    this.hostFleetReconcilePending = null
    if (this.ccCacheRecoveryTimer) {
      clearTimeout(this.ccCacheRecoveryTimer)
      this.ccCacheRecoveryTimer = null
    }
    if (this.ccFleetRetryTimer) {
      clearTimeout(this.ccFleetRetryTimer)
      this.ccFleetRetryTimer = null
    }
    if (this.hostCacheRecoveryTimer) {
      clearTimeout(this.hostCacheRecoveryTimer)
      this.hostCacheRecoveryTimer = null
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
    if (this.gfsResyncTimer) {
      clearInterval(this.gfsResyncTimer)
      this.gfsResyncTimer = null
    }
    if (this.externalEgressResyncTimer) {
      clearInterval(this.externalEgressResyncTimer)
      this.externalEgressResyncTimer = null
    }
    for (const timer of this.externalEgressRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.externalEgressRetryTimers.clear()
    this.externalEgressRetryAttempts.clear()
    this.externalEgressInFlight.clear()
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
  private authTokens: Map<string, string>
  private changeCallback?: () => void

  constructor() {
    this.authTokens = config.devAuthTokens
  }

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

  async getAuthToken(serverName: string): Promise<string | undefined> {
    return this.authTokens.get(serverName)
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

  /** Set auth token for a server (useful for testing). */
  setAuthToken(serverName: string, token: string): void {
    this.authTokens.set(serverName, token)
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
