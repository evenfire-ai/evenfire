import * as k8s from '@kubernetes/client-node'
import { IntOrString } from '@kubernetes/client-node/dist/types.js'
import { createHash, randomUUID } from 'crypto'
import * as path from 'path'
import type { AdministrativeOutcomeReporter } from './administrativeOutcomeReporter'
import { config } from './config'
import { HOST_LABEL, MANAGED_BY_LABEL, MANAGED_BY_VALUE } from './constants'
import { mintHostGfsToken } from './gfsHostBinding'
import { GFS_HOST_SCOPES } from './gfsHostPolicy'
import { makeExpectedHostGfsSubject } from './gfsHostSubject'
import type {
  HccInfrastructureTelemetryPayload,
  InfrastructureTelemetryReporter,
} from './infrastructureTelemetryReporter'
import { makeHostK8sApiClient } from './k8s/hostK8sApiClient'
import {
  SFS_LABEL,
  SFS_NAMESPACE_LABEL,
  WFC_APP_LABEL,
  sharedFileSystemHash,
} from './k8s/sharedFileSystemFactory'
import { hccLogger } from './logger'
import { issueMcpHostRuntimeTokens } from './mcpHostRuntimeTokenIssuerClient'
import {
  hostCleanupDeferredTotal,
  hostDeleteCleanupTotal,
  hostReconcileDurationSeconds,
  hostReconcileInFlight,
  hostReconcileQueueWaitSeconds,
} from './metrics'
import {
  MCP_HOST_GFS_TOKEN_SECRET_KEY,
  MCP_HOST_RUNTIME_TOKEN_SECRET_ACCESS_KEY,
  MCP_HOST_RUNTIME_TOKEN_SECRET_CONTROL_KEY,
  MCP_HOST_RUNTIME_TOKEN_SECRET_REFRESH_KEY,
  buildMcpHostRuntimeTokenSecret,
  mcpHostRuntimeTokenSecretName,
} from './secretFactory'
import {
  buildWorkspaceLayoutInitContainer,
  decodeJwtExpMs,
  effectiveRotateBeforeMs,
  resolveStatelessImagePullPolicy,
} from './statelessDeployment'
import { EffectiveHostLifecycle, SuspendFromHeartbeatOutcome } from './statelessLifecycle.types'
import { StatelessLifecycleExecutor } from './statelessLifecycleExecutor'
import {
  CommunicationChannelCRD,
  HostCRD,
  HostChannelReaderStatus,
  HostRuntimeStatus,
  HostWorkflowControlScope,
  HostWorkflowControlSpec,
} from './types'
import {
  applyNetworkPolicy,
  getErrorCode,
  preserveDeploymentAnnotations,
  preserveServiceAssignedFields,
  replaceWithConflictRetry,
} from './utils'

export type { EffectiveHostLifecycle } from './statelessLifecycle.types'

const HOST_GROUP = 'clerum.io'
const HOST_VERSION = 'v1alpha1'
const HOST_PLURAL = 'hosts'

/**
 * Lane label for a Host reconcile, used only for low-cardinality telemetry:
 * `urgent` (a direct watch ADDED/MODIFIED/DELETED/wake event), `retry` (a
 * bounded watch-reconcile retry), or `fleet` (a bounded background full/
 * lifecycle worker). Never a host name, user, or team.
 */
export type HostReconcileSource = 'urgent' | 'retry' | 'fleet'

/** Immutable Host watch authority snapshot captured at a full-pass boundary. */
export type HostWatchAuthoritySnapshot = { known: boolean; generation: number }

/**
 * The exact §13.2 destructive-cleanup predicate. Deletion of an orphan Host's
 * owned bundle is permitted ONLY when watch authority is known, the watch
 * generation captured at pass start still matches the current generation, the
 * current cache omits the Host, AND a fresh authoritative read confirmed a 404.
 * Any weaker evidence defers.
 */
export function destructiveCleanupAllowed(input: {
  watchAuthorityKnown: boolean
  capturedWatchGeneration: number
  currentWatchGeneration: number
  currentCacheOmitsHost: boolean
  freshAuthoritativeRead: 'confirmed404' | 'present' | 'error'
}): boolean {
  return (
    input.watchAuthorityKnown &&
    input.capturedWatchGeneration === input.currentWatchGeneration &&
    input.currentCacheOmitsHost &&
    input.freshAuthoritativeRead === 'confirmed404'
  )
}

/**
 * Dependency-free bounded worker pool. Dispatches `keys` across at most
 * `concurrency` lanes; each lane pulls the next key, runs `worker`, and
 * collects (never swallows) failures so aggregation stays complete. Lane
 * startup is ordered so the first `concurrency` keys begin in input order.
 */
async function runBoundedHostWorkers(
  keys: string[],
  concurrency: number,
  worker: (key: string) => Promise<void>
): Promise<unknown[]> {
  const failures: unknown[] = []
  if (keys.length === 0) return failures
  let cursor = 0
  const runLane = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= keys.length) return
      try {
        await worker(keys[index])
      } catch (error) {
        failures.push(error)
      }
    }
  }
  const lanes = Math.max(1, Math.min(concurrency, keys.length))
  const runners: Promise<void>[] = []
  for (let i = 0; i < lanes; i += 1) runners.push(runLane())
  await Promise.all(runners)
  return failures
}

/** A managed resource considered for orphan cleanup, keyed by owning Host. */
type CleanupCandidate = { owner: string | undefined; kind: string; name: string }

/**
 * The workflow-control scopes a first-party Host's mcp-host control token needs
 * for the full channel-workflow surface (list/read/trigger + the Telegram/Slack
 * provider-identity resolve + approval decide). Matches the canonical Host
 * overlay instances (deploy/overlays/<env>/instances/host.yaml).
 */
export const DEFAULT_FIRST_PARTY_WORKFLOW_CONTROL_SCOPES: HostWorkflowControlScope[] = [
  'workflow:list',
  'workflow:read',
  'workflow:trigger',
  'workflow:approval:resolve',
  'workflow:approval:decide',
]

/**
 * Resolve the workflow-control scopes declared by a Host.
 *
 * Existing channel-bearing Hosts historically omitted workflowControl while
 * still needing the first-party workflow approval surface. Preserve that
 * server-side default only when the entire block is absent and channel ingress
 * is present. An explicit `scopes` array is honored exactly as declared,
 * including `[]` as an intentional opt-out from workflow access.
 */
export function resolveWorkflowControlScopes(
  workflowControl: HostWorkflowControlSpec | undefined,
  options: { hasChannelIngress?: boolean } = {}
): HostWorkflowControlScope[] {
  if (workflowControl?.scopes !== undefined) {
    return [...workflowControl.scopes]
  }
  if (!workflowControl && options.hasChannelIngress === true) {
    return [...DEFAULT_FIRST_PARTY_WORKFLOW_CONTROL_SCOPES]
  }
  return []
}

/**
 * One SharedFileSystem mount injected into a Host's mcp-host Deployment.
 * The PVC is mounted RO at the requested path; mcp-host's built-in
 * clerum__context_files_* tools read CLERUM_CONTEXT_FILES_MOUNTS to learn
 * what's mounted where.
 */
export interface ResolvedSfsMount {
  /** SharedFileSystem.metadata.name (also the JWT `sharedFileSystem` claim). */
  name: string
  /** SharedFileSystem.metadata.namespace — always mcp-host in v1. */
  namespace: string
  /** PVC name that the per-SFS wfc and the Host both mount. */
  pvcName: string
  /** Path inside the mcp-host container where the PVC is mounted (RO). */
  mountPath: string
}

export type ResolveContextMountsFn = (host: HostCRD) => Promise<ResolvedSfsMount[]>

const CONTEXT_LABEL = 'clerum.io/context'
const CONTEXT_MOUNT_PATH_PATTERN = /^\/[a-zA-Z0-9_.][a-zA-Z0-9_.\/-]*$/
const RUNTIME_TOKEN_REVISION_ANNOTATION = 'clerum.io/runtime-token-revision'
const RUNTIME_TOKEN_SECRET_REVISION_ANNOTATION = 'clerum.io/runtime-token-secret-revision'
const RUNTIME_TOKEN_ISSUED_AT_ANNOTATION = 'clerum.io/runtime-token-issued-at'
const RUNTIME_TOKEN_REFRESH_EXPIRES_AT_ANNOTATION = 'clerum.io/runtime-token-refresh-expires-at'
const RUNTIME_TOKEN_REFRESH_BEFORE_ANNOTATION = 'clerum.io/runtime-token-refresh-before'
const GFS_TOKEN_EXPIRES_AT_ANNOTATION = 'clerum.io/gfs-token-expires-at'
const GFS_TOKEN_REFRESH_BEFORE_ANNOTATION = 'clerum.io/gfs-token-refresh-before'
const GFS_TOKEN_EXPECTED_SUBJECT_ANNOTATION = 'clerum.io/gfs-token-expected-subject'
const GFS_TOKEN_CAPABILITY_SET_HASH_ANNOTATION = 'clerum.io/gfs-token-capability-set-hash'
const GFS_TOKEN_HOST_UID_ANNOTATION = 'clerum.io/gfs-token-host-uid'
const GFS_TOKEN_HOST_GENERATION_ANNOTATION = 'clerum.io/gfs-token-host-generation'
const RUNTIME_TOKEN_HOST_BINDING_HASH_ANNOTATION = 'clerum.io/runtime-token-host-binding-hash'
const RUNTIME_TOKEN_SCOPE_HASH_ANNOTATION = 'clerum.io/runtime-token-scope-hash'
const RUNTIME_TOKEN_ISSUER_ANNOTATION = 'clerum.io/runtime-token-issuer'
const RUNTIME_TOKEN_AUDIENCE_ANNOTATION = 'clerum.io/runtime-token-audience'
const RUNTIME_TOKEN_SCHEMA_VERSION_ANNOTATION = 'clerum.io/runtime-token-schema-version'
const RUNTIME_TOKEN_BOOTSTRAP_STATE_ANNOTATION = 'clerum.io/runtime-token-bootstrap-state'
const RUNTIME_TOKEN_ROLLOUT_REQUIRED_ANNOTATION = 'clerum.io/runtime-token-rollout-required'
const RUNTIME_TOKEN_ISSUER = 'control-api'
const RUNTIME_TOKEN_AUDIENCE = 'workflow-approvals'
// v2 binds the GFS token to the concrete Host CRD instead of the historical
// fleet-wide `mcp-host/standalone` sentinel. The version change makes existing
// Secrets fail the contract check so HCC rotates them and rolls each Host.
const RUNTIME_TOKEN_SCHEMA_VERSION = '2'
const RUNTIME_TOKEN_BOOTSTRAP_STATE_FRESH = 'fresh'
const RUNTIME_TOKEN_BOOTSTRAP_STATE_CONSUMED = 'consumed'
// Deployments affected by the historical stringData/data hashing bug can carry
// the empty-payload revision. Roll them once so the pod template converges to
// the normalized persisted Secret revision.
const LEGACY_EMPTY_RUNTIME_TOKEN_REVISION = createHash('sha256')
  .update(JSON.stringify([]))
  .digest('hex')
const WORKFLOW_TOKEN_MOUNT_PATH = '/var/run/clerum/workflow-tokens'
const MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE_PATH = `${WORKFLOW_TOKEN_MOUNT_PATH}/${MCP_HOST_RUNTIME_TOKEN_SECRET_CONTROL_KEY}`
const MCP_HOST_RUNTIME_AUTH_STATE_PATH = '/var/run/clerum/workflow-auth'
// ─── Stateless lifecycle (Stage 2) ─────────────────────────────────────────
/** Durable session-state dir, mounted from the workspace PVC's state/ subPath. */
const STATE_MOUNT_PATH = '/var/lib/clerum/state'
const log = hccLogger.child({ module: 'host-reconciler' })

function throwCleanupFailures(failures: unknown[], message: string): void {
  if (failures.length > 0) {
    throw new AggregateError(failures, message)
  }
}

export class HostFleetReconcileError extends AggregateError {
  constructor(
    readonly hostFailures: unknown[],
    readonly cleanupFailures: unknown[],
    message = 'Host fleet reconciliation completed with errors'
  ) {
    super([...hostFailures, ...cleanupFailures], message)
    this.name = 'HostFleetReconcileError'
  }
}

type HostReconcilerDeps = {
  appsApi?: k8s.AppsV1Api
  coreApi?: k8s.CoreV1Api
  networkingApi?: k8s.NetworkingV1Api
  rbacApi?: k8s.RbacAuthorizationV1Api
  customApi?: k8s.CustomObjectsApi
  /** Injectable clock so tests get deterministic condition lastTransitionTime. */
  now?: () => Date
  /** Stable per-enqueue identity; the reporter reuses it for transport retries. */
  newTelemetryOccurrenceId?: () => string
  /**
   * Resolve which SharedFileSystem PVCs to mount into a Host's mcp-host
   * Deployment. The default (no override) returns []. Production wires this
   * up from the McpServerWatcher in k8sClient.ts so it can read the Context
   * referenced by the Host without HostReconciler needing direct K8s access
   * to non-Host CRDs.
   */
  resolveContextMounts?: ResolveContextMountsFn
  /**
   * Count CommunicationChannels referencing this Host. Used by
   * `buildChannelReaderDeployment` to compute `spec.replicas`
   * (0 when no CCs, 1 when 1+). Wired by `McpServerWatcher` from
   * its `communicationChannels` cache. Default returns 0 — Hosts
   * without a wired counter scale to replicas=0.
   */
  countCommunicationChannels?: (hostName: string) => number
  /**
   * Find every CommunicationChannel whose `spec.hostRef` equals the given
   * host name. Used by `patchChannelReaderRevisionAnnotation` to discover
   * which Secret(s) a host depends on. Wired by `McpServerWatcher` from
   * its `communicationChannels` cache.
   */
  findCommunicationChannelsByHostRef?: (host: string) => CommunicationChannelCRD[]
  /**
   * Find every CommunicationChannel whose `spec.credentialsSecretRef.name`
   * equals the given Secret name. Used by the Secret informer (Task 9) to
   * route rotation events to the affected hosts. Wired by
   * `McpServerWatcher` from its `communicationChannels` cache.
   */
  findCommunicationChannelsByCredentialsSecretName?: (name: string) => CommunicationChannelCRD[]
  /**
   * B2: Returns true once the McpServerWatcher has completed its CC
   * initial-list startup block. HostReconciler uses this to avoid
   * scaling an existing channel-reader Deployment to 0 when the cache
   * is still empty (e.g. during startup or after a CC-load failure).
   * Default returns false — safe: preserves existing replicas until wired.
   */
  isCommunicationChannelCacheSynced?: () => boolean
  infrastructureTelemetryReporter?: InfrastructureTelemetryReporter
  administrativeOutcomeReporter?: AdministrativeOutcomeReporter
}

type HostSecretValidationResult =
  | { ok: true }
  | { ok: false; reason: 'SecretNotFound' | 'SecretAccessDenied' | 'ReadError'; message: string }

type BootstrapOptions = {
  forceFreshForWake?: boolean
  targetSuspended?: boolean
}

type RuntimeTokenProvision = {
  revision: string
  scopeHash: string
}

type GfsTokenLifecycleEvidence = {
  gfs_subject: string
  gfs_outcome: 'minted' | 'rotated' | 'reused' | 'failed'
  gfs_old_host_uid?: string
  gfs_new_host_uid?: string
}

type DeploymentMutationState = {
  lifecycle: EffectiveHostLifecycle
  runtimeTokenRevision: string
}

export class HostReconciler {
  private readonly appsApi: k8s.AppsV1Api
  private readonly coreApi: k8s.CoreV1Api
  private readonly networkingApi: k8s.NetworkingV1Api
  private readonly rbacApi: k8s.RbacAuthorizationV1Api
  /**
   * Lazily constructed (see the `customApi` getter): only lifecycle-enabled
   * Hosts touch the CustomObjects API, and existing tests construct the
   * reconciler with a bare KubeConfig stub that cannot makeApiClient.
   */
  private customApiInstance: k8s.CustomObjectsApi | undefined
  private readonly kubeConfig: k8s.KubeConfig
  private readonly now: () => Date
  private readonly newTelemetryOccurrenceId: () => string
  private readonly statusMap: Map<string, HostRuntimeStatus> = new Map()
  private readonly readinessTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  /**
   * host.name → image whose pull-policy refusal was already error-logged.
   * The periodic resync rebuilds the Deployment forever; the operator needs
   * the error once per distinct misconfigured image (the durable condition
   * carries the long-lived signal).
   */
  private readonly pullPolicyRejectionLogged: Map<string, string> = new Map()
  /**
   * Stateless lifecycle execution (Stages 2–6), extracted to
   * StatelessLifecycleExecutor: reconcile-time assessment + durable status
   * writes, the heartbeat suspend/drain executors, the wake fast-path, and
   * the per-host reconcile serialization chain.
   */
  private readonly lifecycle: StatelessLifecycleExecutor
  private resolveContextMounts: ResolveContextMountsFn
  private countCommunicationChannels: (hostName: string) => number
  private findCommunicationChannelsByHostRef: (host: string) => CommunicationChannelCRD[]
  private findCommunicationChannelsByCredentialsSecretName: (
    name: string
  ) => CommunicationChannelCRD[]
  private readonly infrastructureTelemetryReporter?: InfrastructureTelemetryReporter
  private readonly administrativeOutcomeReporter?: AdministrativeOutcomeReporter
  private readonly gfsTokenLifecycleEvidence = new Map<string, GfsTokenLifecycleEvidence>()
  // B2: whether the CC cache initial-list has completed. Defaults to false
  // (safe: preserves existing Deployment replicas until wired by McpServerWatcher).
  private ccCacheSyncedFn: () => boolean = () => false
  /**
   * Resolve the current cached Host object by name. Wired by McpServerWatcher
   * from its live Host cache so a fleet worker reconciles the freshest spec and
   * so orphan cleanup compares candidates with the CURRENT inventory rather than
   * the pass snapshot. `null` (unwired) means callers fall back to the pass
   * snapshot for reconcile, and cleanup stays fail-closed (authority unknown).
   */
  private resolveCurrentHost: ((name: string) => HostCRD | undefined) | null = null
  /**
   * Snapshot the current Host watch authority + generation. Wired by
   * McpServerWatcher. Default is fail-closed (unknown) so orphan cleanup never
   * runs until the real authority getter is installed.
   */
  private hostWatchAuthority: () => HostWatchAuthoritySnapshot = () => ({
    known: false,
    generation: 0,
  })

  constructor(kc: k8s.KubeConfig, deps?: HostReconcilerDeps) {
    this.appsApi =
      deps?.appsApi ?? makeHostK8sApiClient(kc, k8s.AppsV1Api, config.hostK8sRequestTimeoutMs)
    this.coreApi =
      deps?.coreApi ?? makeHostK8sApiClient(kc, k8s.CoreV1Api, config.hostK8sRequestTimeoutMs)
    this.networkingApi =
      deps?.networkingApi ??
      makeHostK8sApiClient(kc, k8s.NetworkingV1Api, config.hostK8sRequestTimeoutMs)
    this.rbacApi =
      deps?.rbacApi ??
      makeHostK8sApiClient(kc, k8s.RbacAuthorizationV1Api, config.hostK8sRequestTimeoutMs)
    this.kubeConfig = kc
    this.customApiInstance = deps?.customApi
    this.now = deps?.now ?? (() => new Date())
    this.newTelemetryOccurrenceId = deps?.newTelemetryOccurrenceId ?? randomUUID
    this.resolveContextMounts = deps?.resolveContextMounts ?? (async () => [])
    this.countCommunicationChannels = deps?.countCommunicationChannels ?? (() => 0)
    this.findCommunicationChannelsByHostRef = deps?.findCommunicationChannelsByHostRef ?? (() => [])
    this.findCommunicationChannelsByCredentialsSecretName =
      deps?.findCommunicationChannelsByCredentialsSecretName ?? (() => [])
    this.infrastructureTelemetryReporter = deps?.infrastructureTelemetryReporter
    this.administrativeOutcomeReporter = deps?.administrativeOutcomeReporter
    if (deps?.isCommunicationChannelCacheSynced) {
      this.ccCacheSyncedFn = deps.isCommunicationChannelCacheSynced
    }
    this.lifecycle = new StatelessLifecycleExecutor({
      appsApi: this.appsApi,
      coreApi: this.coreApi,
      getCustomApi: () => this.customApi,
      now: this.now,
      countCommunicationChannels: hostName => this.countCommunicationChannels(hostName),
      isCommunicationChannelCacheSynced: () => this.ccCacheSyncedFn(),
      reconcileCore: host => this.reconcileCore(host),
      onLifecycleStatusCommitted: (host, lifecycle) => {
        const occurredAt = this.now().toISOString()
        this.infrastructureTelemetryReporter?.enqueueHealthTransition({
          sourceEventId: `hcc-health-transition:${this.newTelemetryOccurrenceId()}`,
          occurredAt,
          hostLookupReference: {
            name: host.name,
            namespace: host.namespace,
            ...(host.generation !== undefined ? { generation: host.generation } : {}),
          },
          payload: { transition: `lifecycle:${lifecycle.state}`, state: lifecycle.state },
        })
      },
    })
  }

  /** CustomObjects API client for Host /status writes (lazily constructed). */
  private get customApi(): k8s.CustomObjectsApi {
    if (!this.customApiInstance) {
      this.customApiInstance = makeHostK8sApiClient(
        this.kubeConfig,
        k8s.CustomObjectsApi,
        config.hostK8sRequestTimeoutMs
      )
    }
    return this.customApiInstance
  }

  /**
   * Late-bound setter so the McpServerWatcher (which owns both the Context
   * and SharedFileSystem caches) can wire up the mount resolver after this
   * reconciler is constructed.
   */
  setResolveContextMounts(fn: ResolveContextMountsFn): void {
    this.resolveContextMounts = fn
  }

  /**
   * Late-bound setter so the McpServerWatcher (which owns the
   * communicationChannels cache) can wire up the counter after this
   * reconciler is constructed. Pattern mirrors setResolveContextMounts.
   */
  setCountCommunicationChannels(fn: (hostName: string) => number): void {
    this.countCommunicationChannels = fn
  }

  /**
   * B2: Late-bound setter so McpServerWatcher can wire up the CC cache-sync
   * flag after this reconciler is constructed. Pattern mirrors
   * setCountCommunicationChannels.
   */
  setIsCommunicationChannelCacheSynced(fn: () => boolean): void {
    this.ccCacheSyncedFn = fn
  }

  /**
   * Late-bound setter for the live Host cache resolver. A fleet worker resolves
   * the current cached Host at execution time (skipping absent/superseded
   * entries), and orphan cleanup uses it to compare candidates with the CURRENT
   * inventory. Wired by McpServerWatcher from its `hosts` cache.
   */
  setResolveCurrentHost(fn: (name: string) => HostCRD | undefined): void {
    this.resolveCurrentHost = fn
  }

  /**
   * Late-bound setter for the Host watch authority/generation snapshot. Wired by
   * McpServerWatcher so orphan cleanup can require known authority and a stable
   * watch generation before deleting anything.
   */
  setHostWatchAuthority(fn: () => HostWatchAuthoritySnapshot): void {
    this.hostWatchAuthority = fn
  }

  /**
   * Late-bound setter for the host-ref lookup used by
   * `patchChannelReaderRevisionAnnotation` to discover Secret(s) referenced
   * by a host's CCs. Wired by `McpServerWatcher` from its
   * `communicationChannels` cache. Pattern mirrors setCountCommunicationChannels.
   */
  setFindCommunicationChannelsByHostRef(fn: (host: string) => CommunicationChannelCRD[]): void {
    this.findCommunicationChannelsByHostRef = fn
  }

  /**
   * Late-bound setter for the Secret-name lookup used by the Secret
   * informer (Task 9) to route rotation events to the affected hosts.
   * Wired by `McpServerWatcher` from its `communicationChannels` cache.
   */
  setFindCommunicationChannelsByCredentialsSecretName(
    fn: (name: string) => CommunicationChannelCRD[]
  ): void {
    this.findCommunicationChannelsByCredentialsSecretName = fn
  }

  /**
   * Volume name used by both the volumes[] entry and each volumeMounts[]
   * entry that references it. Stable per (sfs.name, sfs.namespace) so a
   * Deployment template diff only flips when the SFS list changes — not
   * when the same set is reordered.
   */
  static contextMountVolumeName(sfs: { name: string; namespace: string }): string {
    return `ctxfs-${sharedFileSystemHash(sfs)}`
  }

  static contextMountPathRejectionReason(
    mountPath: string,
    reservedMountPaths: string[]
  ): string | null {
    const normalizedMountPath = HostReconciler.normalizeContextMountPath(mountPath)
    if (!normalizedMountPath) {
      return (
        'mountPath must be an absolute POSIX path matching ' + CONTEXT_MOUNT_PATH_PATTERN.source
      )
    }

    const reserved = new Set(
      reservedMountPaths
        .map(HostReconciler.normalizeContainerMountPath)
        .filter((path): path is string => Boolean(path))
    )
    if (reserved.has(normalizedMountPath)) {
      return `mountPath conflicts with reserved Host mount "${normalizedMountPath}"`
    }

    return null
  }

  private static normalizeContextMountPath(mountPath: string): string | null {
    if (
      !CONTEXT_MOUNT_PATH_PATTERN.test(mountPath) ||
      mountPath.split('/').some(segment => segment === '..')
    ) {
      return null
    }
    return HostReconciler.normalizeContainerMountPath(mountPath)
  }

  private static normalizeContainerMountPath(mountPath: string): string | null {
    if (!mountPath.startsWith('/') || mountPath.includes('\\') || mountPath.includes('\0')) {
      return null
    }
    const normalized = path.posix.normalize(mountPath)
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
  }

  // ─── Per-Host RBAC scaffolding ────────────────────────────────────────

  /** Per-Host ServiceAccount name. */
  private hostSaName(host: HostCRD): string {
    return `host-${host.name}-sa`
  }

  /** Per-Host RBAC Role + RoleBinding name (shared between the two). */
  private hostRoleName(host: HostCRD): string {
    return `host-${host.name}-config-reader`
  }

  private rbacLabels(host: HostCRD): Record<string, string> {
    return {
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      [HOST_LABEL]: host.name,
    }
  }

  private isHccOwnedHostResource(
    resource: { metadata?: { labels?: Record<string, string> } },
    hostName: string
  ): boolean {
    const labels = resource.metadata?.labels ?? {}
    return labels[MANAGED_BY_LABEL] === MANAGED_BY_VALUE && labels[HOST_LABEL] === hostName
  }

  private async deleteIfHccOwned<T extends { metadata?: { labels?: Record<string, string> } }>(
    kind: string,
    name: string,
    namespace: string,
    hostName: string,
    read: () => Promise<T>,
    remove: () => Promise<unknown>
  ): Promise<void> {
    let resource: T
    try {
      resource = await read()
    } catch (error) {
      if (getErrorCode(error) === 404) return
      console.error(`[HostReconciler] Failed to read ${kind} "${name}" ownership:`, error)
      throw error
    }

    if (!this.isHccOwnedHostResource(resource, hostName)) {
      console.warn(
        `[HostReconciler] Skipping ${kind} "${name}" delete - not HCC-owned for Host "${hostName}"`
      )
      return
    }

    try {
      await remove()
      console.log(`[HostReconciler] Deleted ${kind} "${name}" in ${namespace}`)
    } catch (error) {
      if (getErrorCode(error) !== 404) {
        console.error(`[HostReconciler] Failed to delete ${kind} "${name}":`, error)
        throw error
      }
    }
  }

  /**
   * Ensure a per-Host ServiceAccount exists. Idempotent.
   */
  private async ensureHostServiceAccount(host: HostCRD): Promise<void> {
    const name = this.hostSaName(host)
    const body: k8s.V1ServiceAccount = {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name, namespace: host.namespace, labels: this.rbacLabels(host) },
    }
    try {
      await this.coreApi.createNamespacedServiceAccount({ namespace: host.namespace, body })
      console.log(`[HostReconciler] Created ServiceAccount "${name}"`)
    } catch (err) {
      if (getErrorCode(err) === 409) return // already exists; SA itself has no spec to update
      console.error(`[HostReconciler] Failed to ensure ServiceAccount "${name}":`, err)
    }
  }

  /**
   * Per-Host Role granting `get/watch/list` ONLY on this Host's resources
   * (Host CRD, env ConfigMap/Secret, LLM Secret named in spec.secretRef).
   * On secretRef change the resourceNames are rewritten so Host A can never
   * read Host B's Secret.
   */
  private async ensureHostRole(host: HostCRD): Promise<void> {
    const name = this.hostRoleName(host)
    const body: k8s.V1Role = {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: { name, namespace: host.namespace, labels: this.rbacLabels(host) },
      rules: [
        {
          apiGroups: ['clerum.io'],
          resources: ['hosts'],
          resourceNames: [host.name],
          verbs: ['get', 'watch', 'list'],
        },
        {
          // Per-Host env ConfigMap + the cluster-wide R3 allowlist ConfigMap
          // (clerum-llm-allowed-models). The allowlist is a single shared object
          // materialized by control-api; every Host may read it. resourceNames
          // are rewritten on every reconcile, so this propagates to existing Roles.
          apiGroups: [''],
          resources: ['configmaps'],
          resourceNames: [`host-${host.name}-env`, 'clerum-llm-allowed-models'],
          verbs: ['get', 'watch', 'list'],
        },
        {
          // READ-ONLY on the mcp-host-runtime-token Secret: granting write here would
          // let the pod rotate its own credentials (privilege escalation).
          // Writes happen via HCC's own ServiceAccount.
          apiGroups: [''],
          resources: ['secrets'],
          resourceNames: [
            host.spec.secretRef,
            `host-${host.name}-env-secret`,
            mcpHostRuntimeTokenSecretName(host),
          ],
          verbs: ['get', 'watch', 'list'],
        },
      ],
    }
    try {
      await this.rbacApi.createNamespacedRole({ namespace: host.namespace, body })
      console.log(`[HostReconciler] Created Role "${name}"`)
      return
    } catch (err) {
      if (getErrorCode(err) !== 409) {
        console.error(`[HostReconciler] Failed to create Role "${name}":`, err)
        return
      }
    }
    // Already exists — replace to pick up rotated secretRef / new resourceNames.
    try {
      const existing = await this.rbacApi.readNamespacedRole({ name, namespace: host.namespace })
      body.metadata!.resourceVersion = existing.metadata?.resourceVersion
      await this.rbacApi.replaceNamespacedRole({ name, namespace: host.namespace, body })
      console.log(`[HostReconciler] Updated Role "${name}"`)
    } catch (err) {
      console.error(`[HostReconciler] Failed to update Role "${name}":`, err)
    }
  }

  /**
   * Ensure a per-Host RoleBinding binding the per-Host Role to the per-Host SA.
   */
  private async ensureHostRoleBinding(host: HostCRD): Promise<void> {
    const name = this.hostRoleName(host)
    const body: k8s.V1RoleBinding = {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name, namespace: host.namespace, labels: this.rbacLabels(host) },
      subjects: [
        {
          kind: 'ServiceAccount',
          name: this.hostSaName(host),
          namespace: host.namespace,
        },
      ],
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'Role',
        name,
      },
    }
    try {
      await this.rbacApi.createNamespacedRoleBinding({ namespace: host.namespace, body })
      console.log(`[HostReconciler] Created RoleBinding "${name}"`)
    } catch (err) {
      if (getErrorCode(err) === 409) return
      console.error(`[HostReconciler] Failed to ensure RoleBinding "${name}":`, err)
    }
  }

  /**
   * Ensures the mcp-host-runtime-token Secret for a 1st-party mcp-host pod.
   * Throws after 3 failed attempts (1s/2s/4s); the Host stays unready
   * until the cause is fixed.
   */
  private static runtimeTokenSecretRevision(data: Record<string, string> | undefined): string {
    const canonical = JSON.stringify(
      Object.entries(data ?? {}).sort(([left], [right]) => left.localeCompare(right))
    )
    return createHash('sha256').update(canonical).digest('hex')
  }

  private static secretDataForKeys(
    secret: Pick<k8s.V1Secret, 'data' | 'stringData'>,
    keys: string[]
  ): Record<string, string> | null {
    if (secret.data && keys.every(key => typeof secret.data?.[key] === 'string')) {
      return Object.fromEntries(keys.map(key => [key, secret.data![key]]))
    }
    if (secret.stringData && keys.every(key => typeof secret.stringData?.[key] === 'string')) {
      return Object.fromEntries(
        keys.map(key => [key, Buffer.from(secret.stringData![key], 'utf8').toString('base64')])
      )
    }
    return null
  }

  private static runtimeTokenSecretData(
    secret: Pick<k8s.V1Secret, 'data' | 'stringData'>
  ): Record<string, string> | null {
    return HostReconciler.secretDataForKeys(secret, [
      MCP_HOST_RUNTIME_TOKEN_SECRET_ACCESS_KEY,
      MCP_HOST_RUNTIME_TOKEN_SECRET_REFRESH_KEY,
      MCP_HOST_RUNTIME_TOKEN_SECRET_CONTROL_KEY,
      MCP_HOST_GFS_TOKEN_SECRET_KEY,
    ])
  }

  private static runtimeTokenSecretRevisionFromSecret(
    secret: Pick<k8s.V1Secret, 'data' | 'stringData'>
  ): string | null {
    const data = HostReconciler.runtimeTokenSecretData(secret)
    return data ? HostReconciler.runtimeTokenSecretRevision(data) : null
  }

  private static shortHash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex')
  }

  private static runtimeTokenHostBindingHash(host: HostCRD): string {
    return HostReconciler.shortHash({ namespace: host.namespace, host: host.name })
  }

  private static runtimeTokenScopeHash(host: HostCRD, hasChannelIngress = false): string {
    // Hash the EFFECTIVE (resolved) scopes — what actually gets minted into the
    // control token — so change-detection matches the default-fallback applied
    // at issuance (otherwise a null workflowControl hashes as [] while the token
    // carries the first-party defaults, and the two drift).
    return HostReconciler.shortHash(
      [...resolveWorkflowControlScopes(host.spec.workflowControl, { hasChannelIngress })].sort()
    )
  }

  private static gfsCapabilitySetHash(): string {
    return HostReconciler.shortHash([...GFS_HOST_SCOPES].sort())
  }

  private static gfsLifecycleEvidenceKey(host: Pick<HostCRD, 'namespace' | 'name'>): string {
    return `${host.namespace}/${host.name}`
  }

  private static effectiveBootstrapRefreshBeforeSec(refreshTtlSec: number): number {
    const configured = Math.max(0, config.mcpHostBootstrapRefreshBeforeSec ?? 0)
    const resyncFloor = Math.max(0, config.hostResyncIntervalSec ?? 0) * 3
    const requested = Math.max(configured, resyncFloor)
    if (refreshTtlSec <= 1) return 0
    return Math.min(requested, refreshTtlSec - 1)
  }

  private static runtimeTokenSecretAnnotations(
    host: HostCRD,
    tokens: Awaited<ReturnType<typeof issueMcpHostRuntimeTokens>>,
    secretRevision: string,
    nowMs: number,
    gfsTokenTtlSec: number,
    hasChannelIngress = false,
    preservedHostUid?: string
  ): Record<string, string> {
    const refreshTtlSec = Number.isFinite(tokens.refreshExpiresInSeconds)
      ? Math.max(0, tokens.refreshExpiresInSeconds)
      : 0
    const refreshExpiresAtMs = nowMs + refreshTtlSec * 1000
    const refreshBeforeSec = HostReconciler.effectiveBootstrapRefreshBeforeSec(refreshTtlSec)
    const refreshBeforeMs = refreshTtlSec > 0 ? refreshExpiresAtMs - refreshBeforeSec * 1000 : nowMs
    const annotations: Record<string, string> = {
      [RUNTIME_TOKEN_SECRET_REVISION_ANNOTATION]: secretRevision,
      [RUNTIME_TOKEN_ISSUED_AT_ANNOTATION]: new Date(nowMs).toISOString(),
      [RUNTIME_TOKEN_REFRESH_EXPIRES_AT_ANNOTATION]: new Date(refreshExpiresAtMs).toISOString(),
      [RUNTIME_TOKEN_REFRESH_BEFORE_ANNOTATION]: new Date(refreshBeforeMs).toISOString(),
      [RUNTIME_TOKEN_HOST_BINDING_HASH_ANNOTATION]:
        HostReconciler.runtimeTokenHostBindingHash(host),
      [RUNTIME_TOKEN_SCOPE_HASH_ANNOTATION]: HostReconciler.runtimeTokenScopeHash(
        host,
        hasChannelIngress
      ),
      [RUNTIME_TOKEN_ISSUER_ANNOTATION]: RUNTIME_TOKEN_ISSUER,
      [RUNTIME_TOKEN_AUDIENCE_ANNOTATION]: RUNTIME_TOKEN_AUDIENCE,
      [RUNTIME_TOKEN_SCHEMA_VERSION_ANNOTATION]: RUNTIME_TOKEN_SCHEMA_VERSION,
      [GFS_TOKEN_EXPECTED_SUBJECT_ANNOTATION]:
        makeExpectedHostGfsSubject(host.namespace, host.name) ?? '',
      [GFS_TOKEN_CAPABILITY_SET_HASH_ANNOTATION]: HostReconciler.gfsCapabilitySetHash(),
    }
    const hostUid = host.uid ?? preservedHostUid
    if (hostUid) annotations[GFS_TOKEN_HOST_UID_ANNOTATION] = hostUid
    if (host.generation !== undefined) {
      annotations[GFS_TOKEN_HOST_GENERATION_ANNOTATION] = String(host.generation)
    }
    const gfsTtlSec = Number.isFinite(gfsTokenTtlSec) ? Math.max(0, gfsTokenTtlSec) : 0
    if (gfsTtlSec > 0) {
      const gfsExpiresAtMs = nowMs + gfsTtlSec * 1000
      const gfsRefreshBeforeSec = HostReconciler.effectiveBootstrapRefreshBeforeSec(gfsTtlSec)
      annotations[GFS_TOKEN_EXPIRES_AT_ANNOTATION] = new Date(gfsExpiresAtMs).toISOString()
      annotations[GFS_TOKEN_REFRESH_BEFORE_ANNOTATION] = new Date(
        gfsExpiresAtMs - gfsRefreshBeforeSec * 1000
      ).toISOString()
    }
    return annotations
  }

  private static runtimeTokenRefreshDecision(
    host: HostCRD,
    secret: k8s.V1Secret,
    nowMs: number,
    hasChannelIngress = false
  ): { refresh: boolean; rolloutRequired: boolean; reason: string; refreshTokenExpMs?: number } {
    const labels = secret.metadata?.labels ?? {}
    if (labels[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE || labels[HOST_LABEL] !== host.name) {
      // Reuse is only safe for Secrets HCC itself wrote for this Host. A
      // foreign or unlabeled Secret is replaced with a freshly issued,
      // HCC-owned one, and the pod rolls onto the trusted material.
      return { refresh: true, rolloutRequired: true, reason: 'not_hcc_owned' }
    }

    const data = HostReconciler.runtimeTokenSecretData(secret)
    if (!data) return { refresh: true, rolloutRequired: false, reason: 'malformed_secret' }

    const annotations = secret.metadata?.annotations ?? {}
    const expectedHostBindingHash = HostReconciler.runtimeTokenHostBindingHash(host)
    const expectedScopeHash = HostReconciler.runtimeTokenScopeHash(host, hasChannelIngress)
    const hasContractMetadata =
      RUNTIME_TOKEN_HOST_BINDING_HASH_ANNOTATION in annotations ||
      RUNTIME_TOKEN_SCOPE_HASH_ANNOTATION in annotations ||
      RUNTIME_TOKEN_ISSUER_ANNOTATION in annotations ||
      RUNTIME_TOKEN_AUDIENCE_ANNOTATION in annotations ||
      RUNTIME_TOKEN_SCHEMA_VERSION_ANNOTATION in annotations
    if (!hasContractMetadata) {
      return { refresh: true, rolloutRequired: false, reason: 'missing_refresh_metadata' }
    }
    const contractChanged =
      annotations[RUNTIME_TOKEN_HOST_BINDING_HASH_ANNOTATION] !== expectedHostBindingHash ||
      annotations[RUNTIME_TOKEN_SCOPE_HASH_ANNOTATION] !== expectedScopeHash ||
      annotations[RUNTIME_TOKEN_ISSUER_ANNOTATION] !== RUNTIME_TOKEN_ISSUER ||
      annotations[RUNTIME_TOKEN_AUDIENCE_ANNOTATION] !== RUNTIME_TOKEN_AUDIENCE ||
      annotations[RUNTIME_TOKEN_SCHEMA_VERSION_ANNOTATION] !== RUNTIME_TOKEN_SCHEMA_VERSION
    if (contractChanged) {
      return { refresh: true, rolloutRequired: true, reason: 'contract_changed' }
    }

    const expectedGfsSubject = makeExpectedHostGfsSubject(host.namespace, host.name)
    if (!expectedGfsSubject) {
      return { refresh: true, rolloutRequired: true, reason: 'invalid_gfs_subject' }
    }
    if (annotations[GFS_TOKEN_EXPECTED_SUBJECT_ANNOTATION] !== expectedGfsSubject) {
      return { refresh: true, rolloutRequired: true, reason: 'gfs_subject_changed' }
    }
    if (
      annotations[GFS_TOKEN_CAPABILITY_SET_HASH_ANNOTATION] !==
      HostReconciler.gfsCapabilitySetHash()
    ) {
      return { refresh: true, rolloutRequired: true, reason: 'gfs_capability_set_changed' }
    }
    if (host.uid && annotations[GFS_TOKEN_HOST_UID_ANNOTATION] !== host.uid) {
      return { refresh: true, rolloutRequired: true, reason: 'gfs_host_uid_changed' }
    }

    // Scheduling cross-check against the refresh token's REAL expiry. The
    // `exp` claim is decoded from the JWT payload WITHOUT signature
    // verification -- HCC must never verify third-party tokens (that is
    // control-api's job); parsing `exp` to schedule rotation is metadata
    // inspection, not verification. Fail toward a fresh token when the claim
    // cannot be parsed.
    const refreshTokenExpMs = decodeJwtExpMs(
      Buffer.from(data[MCP_HOST_RUNTIME_TOKEN_SECRET_REFRESH_KEY], 'base64').toString('utf8')
    )
    if (refreshTokenExpMs === null) {
      return { refresh: true, rolloutRequired: false, reason: 'unparsable_refresh_token' }
    }
    const issuedAtMs = Date.parse(annotations[RUNTIME_TOKEN_ISSUED_AT_ANNOTATION] ?? '')
    const rotateBeforeMs = effectiveRotateBeforeMs(
      refreshTokenExpMs,
      Number.isFinite(issuedAtMs) ? issuedAtMs : null
    )
    if (nowMs >= refreshTokenExpMs - rotateBeforeMs) {
      return {
        refresh: true,
        rolloutRequired: false,
        reason: 'refresh_token_near_expiry',
        refreshTokenExpMs,
      }
    }

    const refreshBefore = Date.parse(annotations[RUNTIME_TOKEN_REFRESH_BEFORE_ANNOTATION] ?? '')
    if (!Number.isFinite(refreshBefore)) {
      return { refresh: true, rolloutRequired: false, reason: 'missing_refresh_metadata' }
    }
    if (nowMs >= refreshBefore) {
      return {
        refresh: true,
        rolloutRequired: false,
        reason: 'refresh_before_reached',
        refreshTokenExpMs,
      }
    }
    const gfsRefreshBefore = Date.parse(annotations[GFS_TOKEN_REFRESH_BEFORE_ANNOTATION] ?? '')
    if (!Number.isFinite(gfsRefreshBefore)) {
      return { refresh: true, rolloutRequired: false, reason: 'missing_gfs_refresh_metadata' }
    }
    if (nowMs >= gfsRefreshBefore) {
      return { refresh: true, rolloutRequired: false, reason: 'gfs_refresh_before_reached' }
    }
    return { refresh: false, rolloutRequired: false, reason: 'current', refreshTokenExpMs }
  }

  private async readHostDeploymentOrNull(host: HostCRD): Promise<k8s.V1Deployment | null> {
    try {
      return await this.appsApi.readNamespacedDeployment({
        name: host.name,
        namespace: host.namespace,
      })
    } catch (err) {
      if (getErrorCode(err) === 404) return null
      throw err
    }
  }

  private static deploymentRuntimeTokenRevision(deployment: k8s.V1Deployment | null): string {
    return (
      deployment?.spec?.template?.metadata?.annotations?.[RUNTIME_TOKEN_REVISION_ANNOTATION] ?? ''
    )
  }

  private static deploymentReady(deployment: k8s.V1Deployment | null): boolean {
    return (deployment?.status?.readyReplicas ?? 0) > 0
  }

  /**
   * True when this reconcile will (re)start a pod that reads the
   * mcp-host-runtime-token Secret fresh at boot -- a missing Deployment, a
   * Deployment scaled to 0 (the wake / scale 0->1 path), or a Deployment with
   * no Ready replica (a pod is (re)starting). In every such case the booting
   * pod bootstraps its refresh token from the Secret env-var material, so that
   * material MUST be freshly minted and un-revoked.
   *
   * The mcp-host runtime refresh token is single-use-rotating: control-api
   * revokes the prior JTI on every successful refresh. Once a running pod has
   * rotated, the copy still sitting in this HCC-owned Secret is REVOKED.
   * Reusing it (because its decoded exp is far out) hands a booting pod a
   * revoked refresh token -- it can never refresh its 300s access token,
   * readiness 503s forever, and the pod never becomes Ready. Reuse is only
   * safe for a pod that stays up and never re-reads the Secret (it uses its
   * in-memory rotated tokens), which is exactly deploymentReady && replicas>=1.
   */
  private static deploymentNeedsFreshBootstrap(
    deployment: k8s.V1Deployment | null,
    currentRevision: string,
    bootstrapIsFresh: boolean,
    options: BootstrapOptions
  ): boolean {
    if (options.forceFreshForWake || !deployment) return true
    // This reconcile will converge the Deployment to zero, so no Pod will
    // consume the stored material before the next verified wake.
    if (options.targetSuspended === true) return false
    if ((deployment.spec?.replicas ?? 1) === 0) return true
    if (HostReconciler.deploymentReady(deployment)) return false
    return (
      !bootstrapIsFresh ||
      HostReconciler.deploymentRuntimeTokenRevision(deployment) !== currentRevision
    )
  }

  private static shouldRollForRuntimeSecret(
    deployment: k8s.V1Deployment | null,
    force: boolean
  ): boolean {
    if (!deployment) return true
    if (force) return true
    if (!HostReconciler.deploymentReady(deployment)) return true
    const revision = HostReconciler.deploymentRuntimeTokenRevision(deployment)
    if (!revision) return true
    return revision === LEGACY_EMPTY_RUNTIME_TOKEN_REVISION
  }

  private static hasFreshBootstrapSecretNewerThanHealthyDeployment(
    secret: k8s.V1Secret,
    secretRevision: string,
    deployment: k8s.V1Deployment | null,
    nowMs: number
  ): boolean {
    if (!HostReconciler.deploymentReady(deployment)) return false
    const deploymentRevision = HostReconciler.deploymentRuntimeTokenRevision(deployment)
    if (!deploymentRevision || deploymentRevision === secretRevision) return false
    const refreshExpiresAt = Date.parse(
      secret.metadata?.annotations?.[RUNTIME_TOKEN_REFRESH_EXPIRES_AT_ANNOTATION] ?? ''
    )
    return Number.isFinite(refreshExpiresAt) && nowMs < refreshExpiresAt
  }

  private static deploymentRestartedAfterRuntimeSecretIssued(
    secret: k8s.V1Secret,
    deployment: k8s.V1Deployment | null
  ): boolean {
    const restartedAt = Date.parse(
      deployment?.spec?.template?.metadata?.annotations?.['kubectl.kubernetes.io/restartedAt'] ?? ''
    )
    if (!Number.isFinite(restartedAt)) return false

    const issuedAt = Date.parse(
      secret.metadata?.annotations?.[RUNTIME_TOKEN_ISSUED_AT_ANNOTATION] ?? ''
    )
    return Number.isFinite(issuedAt) && restartedAt > issuedAt
  }

  private hasChannelIngress(host: HostCRD): boolean {
    return (host.spec.channels?.length ?? 0) > 0 || this.countCommunicationChannels(host.name) > 0
  }

  private resolveWorkflowControlScopesForHost(
    host: HostCRD,
    hasChannelIngress = this.hasChannelIngress(host)
  ): HostWorkflowControlScope[] {
    const scopes = resolveWorkflowControlScopes(host.spec.workflowControl, { hasChannelIngress })
    if (hasChannelIngress && scopes.length === 0) {
      log.warn('channel-bearing Host resolved with no workflow-control scopes', {
        host: host.name,
        namespace: host.namespace,
      })
    }
    return scopes
  }

  private async ensureMcpHostRuntimeTokenSecret(
    host: HostCRD,
    options: BootstrapOptions = {}
  ): Promise<RuntimeTokenProvision> {
    let lastErr: unknown = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const expectedGfsSubject = makeExpectedHostGfsSubject(host.namespace, host.name)
        if (!expectedGfsSubject) {
          throw new Error('Host GFS token provisioning requires a trusted namespace and name')
        }
        const name = mcpHostRuntimeTokenSecretName(host)
        let existing: k8s.V1Secret | null = null
        try {
          existing = await this.coreApi.readNamespacedSecret({ name, namespace: host.namespace })
        } catch (err) {
          if (getErrorCode(err) !== 404) throw err
        }
        const deployment = await this.readHostDeploymentOrNull(host)
        const existingRevision = existing
          ? HostReconciler.runtimeTokenSecretRevisionFromSecret(existing)
          : null
        const bootstrapIsFresh =
          existing?.metadata?.annotations?.[RUNTIME_TOKEN_BOOTSTRAP_STATE_ANNOTATION] ===
          RUNTIME_TOKEN_BOOTSTRAP_STATE_FRESH
        const nowMs = Date.now()
        const hasChannelIngress = this.hasChannelIngress(host)
        const scopeHash = HostReconciler.runtimeTokenScopeHash(host, hasChannelIngress)
        let decision: {
          refresh: boolean
          rolloutRequired: boolean
          reason: string
          refreshTokenExpMs?: number
        } = existing
          ? HostReconciler.runtimeTokenRefreshDecision(host, existing, nowMs, hasChannelIngress)
          : { refresh: true, rolloutRequired: false, reason: 'missing_secret' }
        if (
          existing &&
          HostReconciler.deploymentRestartedAfterRuntimeSecretIssued(existing, deployment)
        ) {
          // A manual restart after the runtime Secret was issued starts pods with
          // env-var bootstrap tokens from that older Secret. Force a re-issue and
          // rollout so every restarted pod observes a fresh, unconsumed token pair.
          decision = {
            refresh: true,
            rolloutRequired: true,
            reason: 'deployment_restarted_after_secret_issued',
          }
        }

        // Revoked-on-wake guard: the mcp-host runtime refresh token is
        // single-use-rotating (control-api revokes the prior JTI on every
        // refresh). A pod that is about to boot -- wake (scale 0->1), missing
        // Deployment, or a not-Ready (re)starting pod -- reads its bootstrap
        // refresh token from THIS Secret. If the pre-suspend pod already
        // rotated, the copy in the Secret is REVOKED, so an exp-based "reuse"
        // hands the booting pod a dead token and readiness 503s forever. When
        // a new pod will consume the Secret, force a fresh mint + rollout even
        // though the decoded exp is far out. Reuse stays correct only for a
        // running, Ready pod that never re-reads the Secret (churn fix).
        if (
          existingRevision &&
          decision.refresh === false &&
          HostReconciler.deploymentNeedsFreshBootstrap(
            deployment,
            existingRevision,
            bootstrapIsFresh,
            options
          )
        ) {
          decision = {
            refresh: true,
            rolloutRequired: true,
            reason: 'fresh_mint_for_booting_pod',
            ...(decision.refreshTokenExpMs !== undefined
              ? { refreshTokenExpMs: decision.refreshTokenExpMs }
              : {}),
          }
        }

        if (existing && existingRevision && !decision.refresh) {
          const deploymentRevision = HostReconciler.deploymentRuntimeTokenRevision(deployment)
          const rolloutMarker =
            existing.metadata?.annotations?.[RUNTIME_TOKEN_ROLLOUT_REQUIRED_ANNOTATION]
          const rolloutPending =
            rolloutMarker === 'true' ||
            (rolloutMarker === undefined &&
              bootstrapIsFresh &&
              deploymentRevision !== '' &&
              deploymentRevision !== existingRevision)
          const annotationUpdates: Record<string, string> = {}
          if (
            host.generation !== undefined &&
            existing.metadata?.annotations?.[GFS_TOKEN_HOST_GENERATION_ANNOTATION] !==
              String(host.generation)
          ) {
            annotationUpdates[GFS_TOKEN_HOST_GENERATION_ANNOTATION] = String(host.generation)
          }
          if (
            bootstrapIsFresh &&
            HostReconciler.deploymentReady(deployment) &&
            deploymentRevision === existingRevision
          ) {
            annotationUpdates[RUNTIME_TOKEN_BOOTSTRAP_STATE_ANNOTATION] =
              RUNTIME_TOKEN_BOOTSTRAP_STATE_CONSUMED
            annotationUpdates[RUNTIME_TOKEN_ROLLOUT_REQUIRED_ANNOTATION] = 'false'
          }
          if (Object.keys(annotationUpdates).length > 0) {
            await this.coreApi.replaceNamespacedSecret({
              name,
              namespace: host.namespace,
              body: {
                ...existing,
                metadata: {
                  ...existing.metadata,
                  annotations: {
                    ...(existing.metadata?.annotations ?? {}),
                    ...annotationUpdates,
                  },
                },
              },
            })
          }
          const refreshExpInHours =
            typeof decision.refreshTokenExpMs === 'number'
              ? Math.round(((decision.refreshTokenExpMs - nowMs) / 3_600_000) * 10) / 10
              : null
          log.info('reusing mcp-host-runtime-token Secret', {
            host: host.name,
            namespace: host.namespace,
            resourceName: name,
            refreshExpInHours,
          })
          this.gfsTokenLifecycleEvidence.set(HostReconciler.gfsLifecycleEvidenceKey(host), {
            gfs_subject: expectedGfsSubject,
            gfs_outcome: 'reused',
            ...(host.uid ? { gfs_new_host_uid: host.uid } : {}),
          })
          const selectedRevision =
            rolloutPending || HostReconciler.shouldRollForRuntimeSecret(deployment, false)
              ? existingRevision
              : deploymentRevision || existingRevision
          return {
            revision: selectedRevision,
            scopeHash,
          }
        }

        if (
          existing &&
          existingRevision &&
          (decision.reason === 'refresh_before_reached' ||
            decision.reason === 'refresh_token_near_expiry') &&
          HostReconciler.hasFreshBootstrapSecretNewerThanHealthyDeployment(
            existing,
            existingRevision,
            deployment,
            nowMs
          )
        ) {
          log.info('preserved fresh mcp-host-runtime-token Secret for healthy deployment', {
            host: host.name,
            namespace: host.namespace,
            resourceName: name,
            reason: decision.reason,
          })
          return {
            revision: HostReconciler.deploymentRuntimeTokenRevision(deployment) || existingRevision,
            scopeHash,
          }
        }

        const tokens = await issueMcpHostRuntimeTokens(
          host.name,
          this.resolveWorkflowControlScopesForHost(host, hasChannelIngress)
        )
        const gfs = await mintHostGfsToken({ name: host.name, namespace: host.namespace })
        const body = buildMcpHostRuntimeTokenSecret(
          host,
          tokens.accessToken,
          tokens.refreshToken,
          tokens.mcpHostControlToken,
          gfs.token
        )
        const revision = HostReconciler.runtimeTokenSecretRevisionFromSecret(body)
        if (!revision) {
          throw new Error('mcp-host-runtime-token Secret body missing required credential keys')
        }
        const rolloutRequired =
          !existing ||
          HostReconciler.shouldRollForRuntimeSecret(deployment, decision.rolloutRequired)
        body.metadata = {
          ...body.metadata,
          annotations: {
            ...(body.metadata?.annotations ?? {}),
            ...HostReconciler.runtimeTokenSecretAnnotations(
              host,
              tokens,
              revision,
              nowMs,
              gfs.expiresInSeconds,
              hasChannelIngress,
              existing?.metadata?.annotations?.[GFS_TOKEN_HOST_UID_ANNOTATION]
            ),
            [RUNTIME_TOKEN_BOOTSTRAP_STATE_ANNOTATION]: RUNTIME_TOKEN_BOOTSTRAP_STATE_FRESH,
            [RUNTIME_TOKEN_ROLLOUT_REQUIRED_ANNOTATION]: rolloutRequired ? 'true' : 'false',
          },
        }

        if (!existing) {
          await this.coreApi.createNamespacedSecret({ namespace: host.namespace, body })
          this.gfsTokenLifecycleEvidence.set(HostReconciler.gfsLifecycleEvidenceKey(host), {
            gfs_subject: expectedGfsSubject,
            gfs_outcome: 'minted',
            ...(host.uid ? { gfs_new_host_uid: host.uid } : {}),
          })
          log.info('created mcp-host-runtime-token Secret', {
            host: host.name,
            namespace: host.namespace,
            resourceName: name,
            reason: decision.reason,
          })
          return { revision, scopeHash }
        }

        const replaceBody = {
          ...body,
          metadata: {
            ...body.metadata,
            resourceVersion: existing.metadata?.resourceVersion,
          },
        }
        await this.coreApi.replaceNamespacedSecret({
          name,
          namespace: host.namespace,
          body: replaceBody,
        })
        const oldHostUid = existing.metadata?.annotations?.[GFS_TOKEN_HOST_UID_ANNOTATION]
        this.gfsTokenLifecycleEvidence.set(HostReconciler.gfsLifecycleEvidenceKey(host), {
          gfs_subject: expectedGfsSubject,
          gfs_outcome: 'rotated',
          ...(oldHostUid ? { gfs_old_host_uid: oldHostUid } : {}),
          ...(host.uid ? { gfs_new_host_uid: host.uid } : {}),
        })
        log.info('rotated mcp-host-runtime-token Secret', {
          host: host.name,
          namespace: host.namespace,
          resourceName: name,
          reason: decision.reason,
          rolloutRequired,
        })
        return {
          revision: rolloutRequired
            ? revision
            : HostReconciler.deploymentRuntimeTokenRevision(deployment) || revision,
          scopeHash,
        }
      } catch (err) {
        lastErr = err
        const subject = makeExpectedHostGfsSubject(host.namespace, host.name)
        if (subject) {
          this.gfsTokenLifecycleEvidence.set(HostReconciler.gfsLifecycleEvidenceKey(host), {
            gfs_subject: subject,
            gfs_outcome: 'failed',
            ...(host.uid ? { gfs_new_host_uid: host.uid } : {}),
          })
        }
        if (err instanceof Error && err.name === 'GfsHostTokenValidationError') break
        const delayMs = 1000 * Math.pow(2, attempt - 1)
        log.error('mcp-host-runtime-token Secret attempt failed', {
          host: host.name,
          namespace: host.namespace,
          attempt,
          maxAttempts: 3,
          error: String(err),
        })
        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, delayMs))
        }
      }
    }
    throw new Error(
      `Failed to ensure mcp-host-runtime-token Secret for host "${host.name}" after 3 attempts: ${String(lastErr)}`
    )
  }

  private async provisionRuntimeTokenRevision(
    host: HostCRD,
    options: BootstrapOptions
  ): Promise<RuntimeTokenProvision> {
    try {
      return await this.ensureMcpHostRuntimeTokenSecret(host, options)
    } catch (err) {
      console.error(
        `[HostReconciler] mcpHost runtime token provisioning failed for host "${host.name}":`,
        err
      )
      this.setStatus(host.name, {
        deployed: false,
        ready: false,
        message: 'mcpHost runtime token provisioning failed',
      })
      throw err
    }
  }

  /**
   * Delete per-Host RBAC. Called from reconcileDelete. 404s are swallowed.
   */
  private async deleteHostRbac(name: string, namespace: string): Promise<void> {
    const saName = `host-${name}-sa`
    const roleName = `host-${name}-config-reader`
    const failures: unknown[] = []
    for (const cleanup of [
      () =>
        this.deleteIfHccOwned(
          'RoleBinding',
          roleName,
          namespace,
          name,
          () => this.rbacApi.readNamespacedRoleBinding({ name: roleName, namespace }),
          () => this.rbacApi.deleteNamespacedRoleBinding({ name: roleName, namespace })
        ),
      () =>
        this.deleteIfHccOwned(
          'Role',
          roleName,
          namespace,
          name,
          () => this.rbacApi.readNamespacedRole({ name: roleName, namespace }),
          () => this.rbacApi.deleteNamespacedRole({ name: roleName, namespace })
        ),
      () =>
        this.deleteIfHccOwned(
          'ServiceAccount',
          saName,
          namespace,
          name,
          () => this.coreApi.readNamespacedServiceAccount({ name: saName, namespace }),
          () => this.coreApi.deleteNamespacedServiceAccount({ name: saName, namespace })
        ),
    ]) {
      try {
        await cleanup()
      } catch (err) {
        failures.push(err)
      }
    }
    throwCleanupFailures(failures, `Failed to delete RBAC for Host "${name}"`)
  }

  private async deleteMcpHostRuntimeTokenSecret(name: string, namespace: string): Promise<void> {
    const secretName = `host-${name}-mcp-host-runtime-tokens`
    try {
      const secret = await this.coreApi.readNamespacedSecret({ name: secretName, namespace })
      const labels = secret.metadata?.labels ?? {}
      if (labels[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE || labels[HOST_LABEL] !== name) {
        console.warn(
          `[HostReconciler] Skipping Secret "${secretName}" delete — not HCC-owned for Host "${name}"`
        )
        return
      }
      await this.coreApi.deleteNamespacedSecret({ name: secretName, namespace })
    } catch (err) {
      if (getErrorCode(err) !== 404) {
        console.error(
          `[HostReconciler] Failed to delete runtime token Secret "${secretName}":`,
          err
        )
        throw err
      }
    }
  }

  private async deleteLegacyChannelReaderRuntimeAuth(name: string): Promise<void> {
    const suffix = ['mcp', 'host', 'runtime', 'auth'].join('-')
    const nameToDelete = `channel-reader-${name}-${suffix}`
    try {
      const obj = await this.coreApi.readNamespacedSecret({
        name: nameToDelete,
        namespace: config.channelsNamespace,
      })
      const labels = obj.metadata?.labels ?? {}
      const owned =
        labels[MANAGED_BY_LABEL] === MANAGED_BY_VALUE &&
        labels[HOST_LABEL] === name &&
        labels['clerum.io/component'] === 'channel-reader' &&
        labels['clerum.io/secret-purpose'] === suffix
      if (!owned) {
        console.warn(
          `[HostReconciler] Skipping legacy runtime auth cleanup for "${nameToDelete}" because labels do not prove HCC ownership`
        )
        return
      }
      await this.coreApi.deleteNamespacedSecret({
        name: nameToDelete,
        namespace: config.channelsNamespace,
      })
    } catch (err) {
      if (getErrorCode(err) !== 404) {
        console.error(
          `[HostReconciler] Failed legacy runtime auth cleanup for "${nameToDelete}":`,
          err
        )
        throw err
      }
    }
  }

  getStatus(name: string): HostRuntimeStatus {
    return (
      this.statusMap.get(name) ?? { deployed: false, ready: false, message: 'Not reconciled yet' }
    )
  }

  /**
   * Track which hosts have desktop enabled.
   * Updated during reconcile, cleared during reconcileDelete.
   */
  private readonly desktopHosts: Set<string> = new Set()

  hasDesktop(hostRef: string): boolean {
    return this.desktopHosts.has(hostRef)
  }

  private setStatus(name: string, status: HostRuntimeStatus): void {
    this.statusMap.set(name, status)
  }

  private clearStatus(name: string): void {
    this.statusMap.delete(name)
    this.lifecycle.clearHost(name)
    const timer = this.readinessTimers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.readinessTimers.delete(name)
    }
  }

  private hostLookupReference(host: HostCRD): {
    name: string
    namespace: string
    generation?: number
  } {
    return {
      name: host.name,
      namespace: host.namespace,
      ...(host.generation !== undefined ? { generation: host.generation } : {}),
    }
  }

  private enqueueHostTelemetry(
    host: HostCRD,
    telemetryType: 'lifecycle_transition' | 'reconcile_outcome' | 'controller_error',
    reasonCode: string,
    payload: HccInfrastructureTelemetryPayload
  ): void {
    const occurredAt = this.now().toISOString()
    const eventPayload = {
      resource_class: 'Host',
      reason_code: reasonCode,
      ...payload,
    }
    if (telemetryType === 'reconcile_outcome') {
      this.infrastructureTelemetryReporter?.enqueue({
        occurredAt,
        telemetryType,
        hostLookupReference: this.hostLookupReference(host),
        payload: eventPayload,
      })
      return
    }
    this.infrastructureTelemetryReporter?.enqueue({
      sourceEventId: `hcc-${telemetryType}:${this.newTelemetryOccurrenceId()}`,
      occurredAt,
      telemetryType,
      hostLookupReference: this.hostLookupReference(host),
      payload: eventPayload,
    })
  }

  private enqueueControllerError(host: HostCRD, reasonCode: string, error: unknown): void {
    this.enqueueHostTelemetry(host, 'controller_error', reasonCode, {
      status: 'failed',
      error_class: error instanceof Error ? error.name : typeof error,
    })
    this.enqueueAdministrativeOutcome(host, 'failed', reasonCode)
  }

  private enqueueReconcileOutcome(host: HostCRD): void {
    const status = this.getStatus(host.name)
    const succeeded = status.deployed && status.ready
    this.enqueueHostTelemetry(host, 'reconcile_outcome', succeeded ? 'ready' : 'not_ready', {
      status: succeeded ? 'succeeded' : 'failed',
      phase: status.deployed ? 'deployed' : 'not_deployed',
      state: status.ready ? 'ready' : 'not_ready',
      ...(this.gfsTokenLifecycleEvidence.get(HostReconciler.gfsLifecycleEvidenceKey(host)) ?? {}),
    })
    this.gfsTokenLifecycleEvidence.delete(HostReconciler.gfsLifecycleEvidenceKey(host))
    if (succeeded) this.enqueueAdministrativeOutcome(host, 'succeeded', 'reconciled')
  }

  private enqueueAdministrativeOutcome(
    host: HostCRD,
    outcome: 'succeeded' | 'failed',
    reasonCode: string
  ): void {
    const operationId = host.annotations?.['clerum.io/administrative-intent-id']
    if (!operationId || host.generation === undefined) return
    this.administrativeOutcomeReporter?.enqueueHostOutcome({
      sourceEventId: `hcc-admin-outcome:${operationId}:${host.generation}:${outcome}`,
      occurredAt: this.now().toISOString(),
      hostRef: { name: host.name, namespace: host.namespace, generation: host.generation },
      outcome,
      reasonCode,
    })
  }

  private pvcName(host: HostCRD): string {
    return `${host.name}-workspace`
  }

  // ─── Stateless lifecycle (Stage 2) ──────────────────────────────────
  //
  // Assessment, durable status writes, the heartbeat executors
  // (StatelessLifecycleReconcilerPort), the wake fast-path, and the
  // per-host serialization chain live in StatelessLifecycleExecutor
  // (statelessLifecycleExecutor.ts). The methods below are thin delegates
  // so external callers keep their HostReconciler entry points.

  /** Public view of the synchronous effective-lifecycle derivation. */
  getEffectiveLifecycle(host: HostCRD): EffectiveHostLifecycle {
    return this.lifecycle.getEffectiveLifecycle(host)
  }

  /** Public view of the clerum.io/wake-requested generation parser. */
  getWakeRequestedGeneration(host: HostCRD): number {
    return this.lifecycle.getWakeRequestedGeneration(host)
  }

  /** FRESH GET (not the watch cache) of a Host — see StatelessLifecycleExecutor. */
  async readFreshHost(host: HostCRD): Promise<HostCRD> {
    return this.lifecycle.readFreshHost(host)
  }

  /**
   * Suspend a stateless Host after the drained report — see
   * StatelessLifecycleExecutor. `entryWakeHandledGeneration` is the AP-1
   * generation epoch captured by the tracker when the suspend was decided.
   */
  async suspendHostFromHeartbeat(
    host: HostCRD,
    reason: string,
    entryWakeHandledGeneration: number
  ): Promise<SuspendFromHeartbeatOutcome> {
    return this.lifecycle.suspendHostFromHeartbeat(host, reason, entryWakeHandledGeneration)
  }

  /** Publish the D8 suspend-blocked reason — see StatelessLifecycleExecutor. */
  async publishSuspendBlockedReason(host: HostCRD, reason: string): Promise<void> {
    return this.lifecycle.publishSuspendBlockedReason(host, reason)
  }

  /**
   * Persist the tracker's drain decision durably — see
   * StatelessLifecycleExecutor. `entryWakeHandledGeneration` is the AP-1
   * generation epoch the tracker captured when the drain was decided.
   */
  async markHostDrainingFromHeartbeat(
    host: HostCRD,
    entryWakeHandledGeneration: number
  ): Promise<void> {
    return this.lifecycle.markHostDrainingFromHeartbeat(host, entryWakeHandledGeneration)
  }

  /** Tracker-side cancel-drain — see StatelessLifecycleExecutor. */
  async markHostActiveFromHeartbeat(host: HostCRD): Promise<void> {
    return this.lifecycle.markHostActiveFromHeartbeat(host)
  }

  /** Resolve a Host pod's creationTimestamp by pod UID (max-uptime ceiling). */
  async findPodCreationTimestamp(host: HostCRD, podUid: string): Promise<Date | null> {
    return this.lifecycle.findPodCreationTimestamp(host, podUid)
  }

  /**
   * Pull policy applied to this stateless Host's pod (Stage 6, W5). The
   * operator's resolved policy is preserved (never overridden to an
   * unpullable Always for a node-local image). When IfNotPresent is used with
   * a mutable image, the stale-cached-image-on-wake risk is warned once per
   * (host, image) and carried durably by the StatelessPullPolicyRejected
   * condition (assessLifecycle) — operator-visible, non-breaking.
   */
  private statelessImagePullPolicyForHost(
    host: HostCRD,
    image: string
  ): 'Always' | 'IfNotPresent' | 'Never' {
    const resolution = resolveStatelessImagePullPolicy(image)
    if (resolution.mutableImageRisk === undefined) {
      this.pullPolicyRejectionLogged.delete(host.name)
      return resolution.policy
    }
    if (this.pullPolicyRejectionLogged.get(host.name) !== image) {
      this.pullPolicyRejectionLogged.set(host.name, image)
      console.warn(
        `[HostReconciler] Stateless Host "${host.name}" runs imagePullPolicy=${resolution.policy} with mutable image "${image}" (no @sha256: digest, tag not sha-<gitsha>): a node with a stale cached image serves old code on wake. Pin an immutable reference to eliminate the risk.`
      )
    }
    return resolution.policy
  }

  async validateHostSecret(host: HostCRD): Promise<HostSecretValidationResult> {
    try {
      await this.coreApi.readNamespacedSecret({
        namespace: host.namespace,
        name: host.spec.secretRef,
      })
      return { ok: true }
    } catch (error) {
      const code = getErrorCode(error)
      if (code === 404) {
        const message = `Secret "${host.spec.secretRef}" not found in namespace "${host.namespace}"`
        console.error(`[HostReconciler] ${message}. Host "${host.name}" will not be deployed.`)
        return { ok: false, reason: 'SecretNotFound', message }
      }
      if (code === 401 || code === 403) {
        const message =
          `Access denied reading Secret "${host.spec.secretRef}" in namespace "${host.namespace}" ` +
          `(K8s API ${code})`
        console.error(`[HostReconciler] ${message}. Host "${host.name}" will be failed closed.`)
        return { ok: false, reason: 'SecretAccessDenied', message }
      }
      const message = `Failed to validate Secret "${host.spec.secretRef}" for host "${host.name}"`
      console.error(`[HostReconciler] ${message}:`, error)
      return { ok: false, reason: 'ReadError', message }
    }
  }

  private buildPvc(host: HostCRD): k8s.V1PersistentVolumeClaim {
    const pvcName = this.pvcName(host)
    return {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: pvcName,
        namespace: host.namespace,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [HOST_LABEL]: host.name,
        },
      },
      spec: {
        storageClassName: config.hostWorkspaceStorageClassName,
        accessModes: ['ReadWriteOnce'],
        resources: {
          requests: {
            storage: config.hostWorkspaceStorageSize,
          },
        },
      },
    }
  }

  /**
   * Build the per-Host channel-reader Deployment manifest. Mirrors the static
   * deploy/base/channels/channel-reader.yaml shape, but per-Host:
   *   - name      = channel-reader-<host>
   *   - namespace = config.channelsNamespace
   *   - env       = CLERUM_HOST_REF=<host>
   *   - annotation clerum.io/credentials-revision=<sha256> when provided
   *
   * `secretRevision` is sha256(canonicalJSON(secret.data)); empty string
   * means "no Secret yet — boot with optional envFrom; SecretInformer will
   * patch the annotation later, triggering a roll".
   */
  private buildChannelReaderDeployment(
    host: HostCRD,
    secretRevision: string,
    existingReplicas?: number
  ): k8s.V1Deployment {
    const name = `channel-reader-${host.name}`
    const annotations: Record<string, string> = {}
    if (secretRevision) {
      annotations['clerum.io/credentials-revision'] = secretRevision
    }
    // CRITICAL: app.kubernetes.io/name MUST be unique per Host.
    //
    // The legacy static Deployment in deploy/base/channels/channel-reader.yaml
    // uses selector.matchLabels: app.kubernetes.io/name=channel-reader. K8s
    // Deployment selectors match supersets, so if per-Host pods carried the
    // plain "channel-reader" value, the static Deployment's ReplicaSet would
    // try to adopt them and delete N-1 every reconcile to converge on its
    // single-replica goal — producing a hot loop where per-Host Deployments
    // recreate pods that the static one immediately deletes.
    //
    // Per the K8s recommended-labels semantics, each per-Host Deployment is
    // a distinct application instance, so the unique-per-Host value is
    // appropriate. Coexistence with the static Deployment during migration
    // works correctly. The static Deployment will be retired in a follow-up.
    const appKubernetesName = `channel-reader-${host.name}`
    const labels = {
      app: 'channel-reader',
      'app.kubernetes.io/name': appKubernetesName,
      'app.kubernetes.io/part-of': 'clerum',
      [HOST_LABEL]: host.name,
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    }
    // Pods carry the managed-by label so the per-Host NetworkPolicies can
    // require it in their podSelectors and refuse to apply to pods spoofed
    // into the channels namespace by another controller. Note: NOT included
    // in `selector.matchLabels` below — Deployment selectors are immutable
    // after create, so adding it there would require delete+recreate of
    // existing per-Host Deployments. Pod-template labels are mutable; new
    // pods on the next rollout get the label, NetworkPolicies match.
    const podLabels = {
      app: 'channel-reader',
      'app.kubernetes.io/name': appKubernetesName,
      'app.kubernetes.io/part-of': 'clerum',
      [HOST_LABEL]: host.name,
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    }
    // Replica count is driven by CommunicationChannel count for this Host (#281):
    // 0 CCs → no pod runs (saves ~128Mi RAM on idle Hosts); 1+ CCs → one pod
    // polls. McpServerWatcher injects the counter via setCountCommunicationChannels;
    // the default returns 0, so any Host whose counter hasn't been wired up
    // scales to 0 (safe — Telegram polling halts but no resource leak).
    //
    // B2 — guard against spurious scale-to-0 during startup:
    // If the CC cache has NOT finished its initial list (ccCacheSyncedFn returns
    // false) AND we know the existing Deployment already has replicas=N, preserve
    // those replicas rather than forcing them to 0. This prevents a restart of
    // HCC from momentarily killing a live channel-reader before the CC cache is
    // populated. Once the cache is synced the normal ccCount logic takes over.
    const ccCount = this.countCommunicationChannels(host.name)
    const cacheIsSynced = this.ccCacheSyncedFn()
    const desiredReplicas =
      !cacheIsSynced && existingReplicas !== undefined ? existingReplicas : ccCount > 0 ? 1 : 0
    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace: config.channelsNamespace, labels },
      spec: {
        replicas: desiredReplicas,
        selector: { matchLabels: { app: 'channel-reader', [HOST_LABEL]: host.name } },
        template: {
          metadata: {
            labels: podLabels,
            ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
          },
          spec: {
            serviceAccountName: 'clerum-channel-reader',
            containers: [
              {
                name: 'channel-reader',
                image: config.channelReaderImage,
                imagePullPolicy: config.channelReaderImagePullPolicy,
                ports: [
                  {
                    name: 'handoff',
                    containerPort: config.channelReaderHandoffPort,
                    protocol: 'TCP',
                  },
                ],
                envFrom: [{ configMapRef: { name: 'clerum-channel-reader-config' } }],
                env: [
                  { name: 'CLERUM_HOST_REF', value: host.name },
                  // Inject the pod's own namespace via the downward API so the
                  // channel-reader always discovers CommunicationChannels and
                  // credential Secrets in its own namespace (channels-<slug>
                  // under MCC, or "channels" in the default stack). This explicit
                  // env wins over any envFrom ConfigMap value, making the
                  // namespace correct by construction regardless of the ConfigMap.
                  {
                    name: 'CLERUM_NAMESPACE',
                    valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } },
                  },
                  // The mcp-host Service (buildService) is named host.name in
                  // host.namespace (mcp-host-<slug> under MCC), type ClusterIP,
                  // exposing the `http` port = config.hostPort. The channel-reader
                  // lives in channels-<slug>, so the URL MUST cross namespaces and
                  // use host.namespace — not config.channelsNamespace.
                  {
                    name: 'CLERUM_MCP_HOST_URL',
                    value: `http://${host.name}.${host.namespace}.svc.cluster.local:${config.hostPort}`,
                  },
                  {
                    name: 'CLERUM_CHANNEL_READER_HANDOFF_TOKEN',
                    valueFrom: {
                      secretKeyRef: {
                        name: 'workflow-approval-request-reader-credentials',
                        key: 'channel-reader-handoff-token',
                        optional: true,
                      },
                    },
                  },
                ],
                resources: {
                  requests: { cpu: '50m', memory: '128Mi' },
                  limits: { cpu: '200m', memory: '256Mi' },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  runAsNonRoot: true,
                  runAsUser: 1000,
                  runAsGroup: 1000,
                  // Restricted-PSA-compliant: MCC shared-tenant namespaces
                  // (channels-<slug>) enforce the `restricted` PodSecurity
                  // standard, which requires capabilities.drop=[ALL] and
                  // seccompProfile=RuntimeDefault.
                  capabilities: { drop: ['ALL'] },
                  seccompProfile: { type: 'RuntimeDefault' },
                },
              },
            ],
          },
        },
      },
    }
  }

  private buildChannelReaderService(host: HostCRD): k8s.V1Service {
    const name = `channel-reader-${host.name}`
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name,
        namespace: config.channelsNamespace,
        labels: {
          app: 'channel-reader',
          'app.kubernetes.io/name': name,
          'app.kubernetes.io/part-of': 'clerum',
          [HOST_LABEL]: host.name,
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
        },
      },
      spec: {
        type: 'ClusterIP',
        selector: {
          app: 'channel-reader',
          [HOST_LABEL]: host.name,
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
        },
        ports: [
          {
            name: 'handoff',
            port: config.channelReaderHandoffPort,
            targetPort: 'handoff' as IntOrString,
            protocol: 'TCP',
          },
        ],
      },
    }
  }

  private async reconcileChannelReaderService(host: HostCRD): Promise<void> {
    const name = `channel-reader-${host.name}`
    const ns = config.channelsNamespace
    const service = this.buildChannelReaderService(host)

    try {
      await this.coreApi.createNamespacedService({
        namespace: ns,
        body: service,
      })
      console.log(`[HostReconciler] Created channel-reader Service "${name}"`)
    } catch (err) {
      if (getErrorCode(err) !== 409) {
        console.error(`[HostReconciler] Failed to create channel-reader Service "${name}":`, err)
        throw err
      }
      try {
        await replaceWithConflictRetry({
          description: `channel-reader Service "${name}"`,
          logPrefix: '[HostReconciler]',
          body: service,
          mergeExisting: preserveServiceAssignedFields,
          read: () => this.coreApi.readNamespacedService({ name, namespace: ns }),
          replace: body =>
            this.coreApi.replaceNamespacedService({
              name,
              namespace: ns,
              body,
            }),
        })
        console.log(`[HostReconciler] Updated channel-reader Service "${name}"`)
      } catch (replaceErr) {
        console.error(
          `[HostReconciler] Failed to update channel-reader Service "${name}":`,
          replaceErr
        )
        throw replaceErr
      }
    }
  }

  /**
   * Idempotent reconcile of the per-Host channel-reader Deployment. Mirrors
   * the PVC create-or-replace pattern at hostReconciler.ts:497-519.
   *
   * - Reads existing per-host credentials Secret to seed the
   *   clerum.io/credentials-revision pod template annotation, so the initial
   *   pod boots with the right hash and doesn't get rolled twice when
   *   SecretInformer fires later.
   * - On 409 from create, compares a fresh, server-normalized Deployment and
   *   replaces only meaningful drift. Conflict retries rebuild against the
   *   latest live replica count. A Deployment owned by a different host is
   *   never overwritten.
   */
  private async reconcileChannelReaderDeployment(host: HostCRD): Promise<void> {
    const name = `channel-reader-${host.name}`
    const ns = config.channelsNamespace

    const revision = await this.computeChannelReaderRevisionForHost(host.name)
    const desired = this.buildChannelReaderDeployment(host, revision)

    try {
      await this.appsApi.createNamespacedDeployment({ namespace: ns, body: desired })
      console.log(`[HostReconciler] Created channel-reader Deployment "${name}"`)
    } catch (err) {
      if (getErrorCode(err) !== 409) {
        console.error(`[HostReconciler] Failed to create channel-reader "${name}":`, err)
        throw err
      }
      let existing: k8s.V1Deployment
      try {
        existing = await this.appsApi.readNamespacedDeployment({ name, namespace: ns })
      } catch (readErr) {
        if (getErrorCode(readErr) === 404) {
          console.warn(
            `[HostReconciler] channel-reader "${name}" disappeared after create conflict; treating the reconcile as a transient failure`
          )
          throw readErr
        }
        console.error(`[HostReconciler] Failed to read channel-reader "${name}":`, readErr)
        throw readErr
      }
      const ownerHost = existing.metadata?.labels?.[HOST_LABEL]
      if (ownerHost && ownerHost !== host.name) {
        console.warn(
          `[HostReconciler] channel-reader "${name}" owned by host="${ownerHost}", skipping`
        )
        return
      }
      try {
        await replaceWithConflictRetry({
          description: `channel-reader Deployment "${name}"`,
          logPrefix: '[HostReconciler]',
          // B2: rebuild against each fresh read so an unsynced CC cache
          // preserves the live replica count even after a 409 retry.
          body: this.buildChannelReaderDeployment(host, revision, existing.spec?.replicas),
          read: () => this.appsApi.readNamespacedDeployment({ name, namespace: ns }),
          replace: body =>
            this.appsApi.replaceNamespacedDeployment({
              name,
              namespace: ns,
              body,
            }),
          mergeExisting: (_body, fresh) => {
            const desiredWithLiveReplicas = this.buildChannelReaderDeployment(
              host,
              revision,
              fresh.spec?.replicas
            )
            desiredWithLiveReplicas.metadata = {
              ...desiredWithLiveReplicas.metadata,
              resourceVersion: fresh.metadata?.resourceVersion,
            }
            return preserveChannelReaderDeploymentAnnotations(desiredWithLiveReplicas, fresh)
          },
          isUpToDate: (next, fresh) => {
            const freshOwnerHost = fresh.metadata?.labels?.[HOST_LABEL]
            // Never replace an object whose ownership changed during a retry.
            if (freshOwnerHost && freshOwnerHost !== host.name) return true
            return deploymentMatchesDesired(next, fresh)
          },
        })
      } catch (replaceErr) {
        console.error(`[HostReconciler] Failed to update channel-reader "${name}":`, replaceErr)
        throw replaceErr
      }
    }
  }

  /**
   * Patch the `clerum.io/credentials-revision` annotation on the per-Host
   * channel-reader Deployment so K8s rolls the pod. Revision = sha256 of
   * the host's credentials Secret content (empty when no per-CC Secret
   * resolves yet). Idempotent on unchanged input — patches the same value
   * are no-ops at the K8s layer.
   *
   * Strategic-merge-patch preserves any other annotations on the pod
   * template. 404 on the Deployment is benign (no per-Host pod for that
   * host yet — McpServerWatcher's fullReconcile will create one when the
   * Host CRD is present).
   */
  async patchChannelReaderRevisionAnnotation(hostName: string): Promise<void> {
    const depName = `channel-reader-${hostName}`
    try {
      const revision = await this.computeChannelReaderRevisionForHost(hostName)
      const patchBody = {
        spec: {
          template: {
            metadata: {
              annotations: { 'clerum.io/credentials-revision': revision },
            },
          },
        },
      }
      await this.appsApi.patchNamespacedDeployment(
        { name: depName, namespace: config.channelsNamespace, body: patchBody },
        {
          middleware: [
            k8s.setHeaderMiddleware('Content-Type', 'application/strategic-merge-patch+json'),
          ],
        }
      )
      console.log(
        `[HostReconciler] Patched ${depName} credentials-revision=${revision || '(empty)'}`
      )
    } catch (err) {
      if (getErrorCode(err) === 404) return
      console.error(`[HostReconciler] Failed to reconcile ${depName} revision:`, err)
    }
  }

  /**
   * Compute the revision for a host by hashing the data of the Secret(s)
   * referenced by all CCs that resolve to this host. Used by
   * patchChannelReaderRevisionAnnotation. Returns '' when no Secret is
   * resolvable yet.
   *
   * Wiring: a `findCommunicationChannelsByHostRef` dependency is injected
   * via setFindCommunicationChannelsByHostRef from McpServerWatcher.
   */
  private async computeChannelReaderRevisionForHost(hostName: string): Promise<string> {
    const ccs = this.findCommunicationChannelsByHostRef(hostName)
    const secretNames = new Set<string>()
    for (const cc of ccs) {
      if (cc.spec.credentialsSecretRef?.name) secretNames.add(cc.spec.credentialsSecretRef.name)
    }
    if (secretNames.size === 0) return ''

    const sortedNames = [...secretNames].sort()
    const combined: Record<string, Record<string, string>> = {}
    for (const name of sortedNames) {
      try {
        const secret = await this.coreApi.readNamespacedSecret({
          name,
          namespace: config.channelsNamespace,
        })
        combined[name] = (secret.data ?? {}) as Record<string, string>
      } catch (err) {
        if (getErrorCode(err) === 404) continue
        throw err
      }
    }
    const canonical = canonicalStringify(combined)
    return createHash('sha256').update(canonical).digest('hex')
  }

  /**
   * Called by the channels-namespace SecretInformer (started in main.ts) on
   * Secret rotation events. Looks up which CommunicationChannels reference
   * the rotated Secret via `findCommunicationChannelsByCredentialsSecretName`
   * (CC cache reverse-map), collects the affected hosts, and patches each
   * host's channel-reader Deployment annotation exactly once via
   * `patchChannelReaderRevisionAnnotation`.
   *
   * Cross-namespace events are skipped early — only Secrets in the
   * configured channelsNamespace are interesting (this avoids spurious
   * cache lookups when the informer fires for unrelated Secrets).
   *
   * A single Secret can map to multiple hosts (operators can share a
   * Secret across CCs of different Hosts via raw YAML); each affected host
   * is patched once even if it owns multiple CCs that reference the same
   * Secret.
   *
   * When no CC references the Secret, this is a no-op — the Secret is
   * either orphaned or owned by a different subsystem.
   *
   * Per-host error handling lives in `patchChannelReaderRevisionAnnotation`
   * (swallows Deployment 404 / Secret 404, logs others). This method does
   * NOT throw, so the SecretInformer event loop continues regardless of
   * per-host failures.
   */
  async reconcileChannelReaderRevision(secretName: string, secretNamespace: string): Promise<void> {
    if (secretNamespace !== config.channelsNamespace) return

    const affectedCCs = this.findCommunicationChannelsByCredentialsSecretName(secretName)
    if (affectedCCs.length === 0) return

    const affectedHosts = new Set<string>(affectedCCs.map(cc => cc.spec.hostRef))
    // Addendum 2: each affected Host patches only its own `channel-reader-<host>`
    // Deployment annotation — a disjoint, order-independent, idempotent write set
    // per Host (§10.4 inventory). Fan out through the bounded worker pool
    // (reusing HCC_HOST_FULL_RECONCILE_CONCURRENCY) so a shared credentials-Secret
    // change touching many Hosts is not head-of-line blocked, while never issuing
    // an unbounded burst at the K8s API. patchChannelReaderRevisionAnnotation
    // still swallows its own per-Host errors, so this method continues not to
    // throw (runBoundedHostWorkers never rethrows).
    await runBoundedHostWorkers(
      Array.from(affectedHosts),
      config.hostFullReconcileConcurrency,
      hostName => this.patchChannelReaderRevisionAnnotation(hostName)
    )
  }

  buildDeployment(
    host: HostCRD,
    mounts: ResolvedSfsMount[] = [],
    runtimeTokenRevision = '',
    lifecycle?: EffectiveHostLifecycle
  ): k8s.V1Deployment {
    const labels: Record<string, string> = {
      app: host.name,
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      [HOST_LABEL]: host.name,
      [CONTEXT_LABEL]: host.spec.contextRef,
    }

    const isDesktop = !!(host.spec.desktop?.browser || host.spec.desktop?.x11)
    // reconcile() passes the full async lifecycle assessment; direct callers
    // (and tests) fall back to the synchronously derivable view.
    const effectiveLifecycle = lifecycle ?? this.lifecycle.effectiveLifecycleFromCache(host)
    const isStateless = effectiveLifecycle.stateless
    const image = isDesktop ? config.desktopImage : config.hostImage
    const resources = isDesktop ? config.desktopResources : config.hostResources
    // Stage 6 (W5): stateless pods may override the pull policy (guarded —
    // see resolveStatelessImagePullPolicy). Non-stateless pods keep the
    // global policy so their manifest stays byte-identical.
    const imagePullPolicy = isStateless
      ? this.statelessImagePullPolicyForHost(host, image)
      : config.hostImagePullPolicy

    // Ports
    const ports: Array<{ name: string; containerPort: number; protocol: string }> = [
      { name: 'http', containerPort: config.hostPort, protocol: 'TCP' },
    ]
    if (isDesktop) {
      ports.push({ name: 'desktop', containerPort: config.desktopPort, protocol: 'TCP' })
    }

    // When desktop is enabled, mount the workspace at /config/workspace so the
    // XFCE user (abc, UID 1001) can browse the same files the agent writes to.
    const workspacePath = isDesktop ? '/config/workspace' : config.hostWorkspacePath
    const reservedMountPaths = [
      workspacePath,
      '/tmp',
      WORKFLOW_TOKEN_MOUNT_PATH,
      MCP_HOST_RUNTIME_AUTH_STATE_PATH,
      ...(isStateless ? [STATE_MOUNT_PATH] : []),
    ]
    const contextMounts = mounts.filter(m => {
      const reason = HostReconciler.contextMountPathRejectionReason(m.mountPath, reservedMountPaths)
      if (reason) {
        log.warn('Skipping invalid SharedFileSystem context mount', {
          host: host.name,
          sharedFileSystem: m.name,
          mountPath: m.mountPath,
          reason,
        })
        return false
      }
      return true
    })

    // Env
    const env: k8s.V1EnvVar[] = [
      { name: 'CLERUM_HOST_NAME', value: host.name },
      {
        name: 'CLERUM_NAMESPACE',
        valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } },
      },
      { name: 'CLERUM_WORKSPACE_PATH', value: workspacePath },
      // Changing spec.secretRef changes the pod template and rolls the host.
      { name: 'CLERUM_LLM_SECRET_REF', value: host.spec.secretRef },
      // mcpHost runtime token env vars. Names match WRC's podFactory.ts so mcp-host
      // sees the same shape regardless of which controller provisioned it.
      {
        name: 'MCP_HOST_RUNTIME_ACCESS_TOKEN',
        valueFrom: {
          secretKeyRef: {
            name: mcpHostRuntimeTokenSecretName(host),
            key: MCP_HOST_RUNTIME_TOKEN_SECRET_ACCESS_KEY,
          },
        },
      },
      {
        name: 'MCP_HOST_RUNTIME_REFRESH_TOKEN',
        valueFrom: {
          secretKeyRef: {
            name: mcpHostRuntimeTokenSecretName(host),
            key: MCP_HOST_RUNTIME_TOKEN_SECRET_REFRESH_KEY,
          },
        },
      },
      {
        name: 'MCP_HOST_WORKFLOW_CONTROL_TOKEN',
        valueFrom: {
          secretKeyRef: {
            name: mcpHostRuntimeTokenSecretName(host),
            key: MCP_HOST_RUNTIME_TOKEN_SECRET_CONTROL_KEY,
          },
        },
      },
      {
        name: 'MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE',
        value: MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE_PATH,
      },
      {
        name: 'MCP_HOST_RUNTIME_AUTH_STATE_DIR',
        value: MCP_HOST_RUNTIME_AUTH_STATE_PATH,
      },
      { name: 'MCP_HOST_GATEWAY_URL', value: config.mcpHostGatewayUrl },
    ]
    if (isStateless) {
      env.push(
        { name: 'CLERUM_STATELESS_LIFECYCLE', value: 'true' },
        { name: 'CLERUM_SESSION_STORE', value: 'sqlite' },
        { name: 'CLERUM_SESSION_DB_DIR', value: STATE_MOUNT_PATH },
        // Stage 3: the heartbeat emitter requires its own pod UID so HCC
        // can discard heartbeats from stale pods after a wake.
        {
          name: 'CLERUM_POD_UID',
          valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } },
        }
      )
    }
    if (isDesktop) {
      env.push(
        { name: 'CLERUM_DESKTOP_X11', value: String(host.spec.desktop?.x11 ?? false) },
        { name: 'CLERUM_DESKTOP_BROWSER', value: String(host.spec.desktop?.browser ?? false) },
        { name: 'PUID', value: '1001' },
        { name: 'PGID', value: '1001' },
        { name: 'TZ', value: 'UTC' },
        { name: 'CUSTOM_PORT', value: String(config.desktopPort) }
      )
    }
    if (contextMounts.length > 0) {
      // Sort by name for stable JSON ordering across reconciles — otherwise a
      // map iteration reorder would flip the env value and trigger an unnecessary
      // pod restart.
      const sorted = [...contextMounts].sort((a, b) => a.name.localeCompare(b.name))
      env.push({
        name: 'CLERUM_CONTEXT_FILES_MOUNTS',
        value: JSON.stringify(
          sorted.map(m => ({
            name: m.name,
            namespace: m.namespace,
            mountPath: m.mountPath,
            pvcName: m.pvcName,
          }))
        ),
      })
    }
    const podAnnotations: Record<string, string> = {}
    if (runtimeTokenRevision) {
      podAnnotations[RUNTIME_TOKEN_REVISION_ANNOTATION] = runtimeTokenRevision
    }

    // Security context — desktop needs runAsNonRoot: false for s6-overlay init,
    // which is fundamentally incompatible with the `restricted` PodSecurity
    // standard. Desktop Hosts therefore won't schedule in MCC shared-tenant
    // namespaces under restricted PSA — a separate known limitation, out of
    // scope here. Non-desktop hosts emit a restricted-PSA-compliant pod-level
    // securityContext so the ReplicaSet schedules in restricted namespaces.
    const securityContext = isDesktop
      ? { runAsNonRoot: false, seccompProfile: { type: 'RuntimeDefault' }, fsGroup: 1001 }
      : {
          runAsNonRoot: true,
          // UID/GID 1001 matches the mcp-host image's baked-in `nodejs` user
          // (Dockerfile / .slim / .full all create it at 1001). Running as the
          // image user keeps the running UID aligned with the workspace PVC
          // ownership written by prior rolls — re-rolling existing 1st-party
          // hosts (chatllm, etc.) does not hit EACCES on workspace/memory file
          // rewrites. fsGroup stays 1001 so fresh-PVC tenants still work.
          runAsUser: 1001,
          runAsGroup: 1001,
          fsGroup: 1001,
          seccompProfile: { type: 'RuntimeDefault' },
        }

    // Startup probe — desktop image needs longer initial delay for s6 boot + XFCE + mcp-host launch.
    // Stateless wake-budget tuning (Stage 6, W7): a woken pod should turn
    // Ready as soon as it can answer, so the stateless startup probe drops
    // the initial delay and polls every 2s. The total startup allowance is
    // preserved: non-stateless allows 10 + 5s × 60 = 310s, stateless allows
    // 0 + 2s × 155 = 310s (stateless is never desktop — assessLifecycle
    // rejects spec.desktop). Non-stateless pods keep the exact legacy probe.
    const startupProbe = isStateless
      ? {
          httpGet: { path: '/v1/runtime/live', port: 'http' as IntOrString },
          initialDelaySeconds: 0,
          periodSeconds: 2,
          timeoutSeconds: 2,
          failureThreshold: 155,
        }
      : {
          httpGet: { path: '/v1/runtime/live', port: 'http' as IntOrString },
          initialDelaySeconds: isDesktop ? 30 : 10,
          periodSeconds: 5,
          timeoutSeconds: 2,
          failureThreshold: isDesktop ? 120 : 60,
        }

    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: host.name,
        namespace: host.namespace,
        labels,
      },
      spec: {
        // A suspended stateless Host scales to 0 on EVERY reconcile path
        // (event + resync): the state lives in the CRD status, so neither a
        // routine reconcile nor an HCC restart resurrects it.
        replicas: isStateless && effectiveLifecycle.state === 'suspended' ? 0 : 1,
        strategy: {
          type: 'RollingUpdate',
          rollingUpdate: {
            maxSurge: 0,
            maxUnavailable: 1,
          },
        },
        selector: {
          matchLabels: { app: host.name },
        },
        template: {
          metadata: {
            labels,
            ...(Object.keys(podAnnotations).length > 0 ? { annotations: podAnnotations } : {}),
          },
          spec: {
            // Per-Host ServiceAccount provisioned by
            // ensureHostServiceAccount() — bound to a narrow Role that lets
            // mcp-host watch only its own Host CRD, env CM/Secret, and LLM
            // Secret.
            serviceAccountName: this.hostSaName(host),
            // A stateless Host may be recreated after a user interaction.
            // Give only that on-demand workload the interactive class so its
            // wake can preempt explicitly lower-priority batch work. Keep
            // stateful Hosts unclassed at the default service-equivalent
            // priority to preserve their existing PodSpec.
            ...(isStateless ? { priorityClassName: 'clerum-interactive-host' } : {}),
            imagePullSecrets: config.hostImagePullSecretName
              ? [{ name: config.hostImagePullSecretName }]
              : undefined,
            // Stage 1.2: stateless Hosts migrate the workspace PVC to the
            // dual-subPath layout before mcp-host starts. Non-stateless pods
            // keep the pre-stateless shape untouched.
            ...(isStateless
              ? { initContainers: [buildWorkspaceLayoutInitContainer(image, imagePullPolicy)] }
              : {}),
            containers: [
              {
                name: 'mcp-host',
                image,
                imagePullPolicy,
                ports,
                envFrom: [{ configMapRef: { name: config.hostConfigMapName } }],
                env,
                volumeMounts: [
                  ...(isStateless
                    ? [
                        // Same PVC mounted twice: workspace/ at the workspace
                        // path, state/ at the durable session-state dir.
                        { name: 'workspace', mountPath: workspacePath, subPath: 'workspace' },
                        { name: 'workspace', mountPath: STATE_MOUNT_PATH, subPath: 'state' },
                      ]
                    : [{ name: 'workspace', mountPath: workspacePath }]),
                  {
                    name: 'mcp-host-runtime-tokens',
                    mountPath: WORKFLOW_TOKEN_MOUNT_PATH,
                    readOnly: true,
                  },
                  { name: 'workflow-auth-state', mountPath: MCP_HOST_RUNTIME_AUTH_STATE_PATH },
                  { name: 'tmp', mountPath: '/tmp' },
                  ...contextMounts.map(m => ({
                    name: HostReconciler.contextMountVolumeName(m),
                    mountPath: m.mountPath,
                    readOnly: true,
                  })),
                ],
                startupProbe,
                livenessProbe: {
                  httpGet: { path: '/v1/runtime/live', port: 'http' as IntOrString },
                  initialDelaySeconds: 45,
                  periodSeconds: 30,
                  timeoutSeconds: 2,
                  failureThreshold: 3,
                },
                readinessProbe: {
                  httpGet: { path: '/v1/runtime/health', port: 'http' as IntOrString },
                  // Stateless (Stage 6, W7): the startup probe already gates
                  // readiness checks until the pod is live, so the fixed 20s
                  // readiness delay only pads the wake budget — drop it.
                  initialDelaySeconds: isStateless ? 0 : 20,
                  periodSeconds: 10,
                  timeoutSeconds: 2,
                  failureThreshold: 6,
                },
                resources: {
                  requests: {
                    memory: resources.requests.memory,
                    cpu: resources.requests.cpu,
                  },
                  limits: {
                    memory: resources.limits.memory,
                    cpu: resources.limits.cpu,
                  },
                },
                // Restricted-PSA-compliant container securityContext. MCC
                // shared-tenant namespaces (mcp-host-<slug>) enforce the
                // `restricted` PodSecurity standard; without these fields the
                // ReplicaSet gets FailedCreate and never schedules a pod.
                // readOnlyRootFilesystem is intentionally NOT set — mcp-host
                // writes outside its mounted /tmp + workspace volumes and
                // restricted PSA does not require it.
                securityContext: {
                  allowPrivilegeEscalation: false,
                  runAsNonRoot: true,
                  // UID/GID 1001 = the image's baked-in `nodejs` user. Must
                  // match the pod-level securityContext above and the existing
                  // workspace PVC ownership so re-rolls don't EACCES.
                  runAsUser: 1001,
                  runAsGroup: 1001,
                  capabilities: { drop: ['ALL'] },
                  seccompProfile: { type: 'RuntimeDefault' },
                },
              },
            ],
            securityContext,
            // #592: co-locate the mcp-host pod on the same node as each mounted
            // SharedFileSystem's wfc pod. The SFS PVC is RWO, so the RW writer
            // (wfc) and these RO consumers must share a node. Mounts are gated on
            // the SFS PVC being Bound (resolveContextMounts → isMountable); under
            // WaitForFirstConsumer a Bound PVC means the wfc (first consumer) was
            // already scheduled, so its affinity target exists. Limit: a Host
            // mounting 2+ SFS whose wfc landed on different nodes is unschedulable
            // (surfaced as Degraded) — that case needs RWX (deferred) and is not
            // used today (Contexts mount 0-1 SFS).
            //
            // LATENT (see issue #602 — RWX is not enabled on any cluster today):
            // this podAffinity is UNCONDITIONAL — it applies to every mount
            // regardless of access mode. If RWX is ever enabled and a Host mounts
            // an explicit ReadWriteMany SFS, this `required` hostname affinity
            // would still force its RO consumers onto the wfc's single node,
            // defeating RWX's multi-node-reader benefit. It is harmless today: no
            // RWX StorageClass exists on dev/prod, so an RWX PVC never binds →
            // the isMountable (PVC-Bound) gate keeps it out of contextMounts → it
            // never reaches this affinity. WHEN RWX lands: plumb the access mode
            // into ResolvedSfsMount and apply this term only to RWO mounts (RWX
            // mounts must get NO podAffinity). Do NOT add that conditioning now —
            // it would be untestable without an RWX StorageClass. See #602.
            ...(contextMounts.length > 0
              ? {
                  affinity: {
                    podAffinity: {
                      requiredDuringSchedulingIgnoredDuringExecution: contextMounts.map(m => ({
                        labelSelector: {
                          matchLabels: {
                            app: WFC_APP_LABEL,
                            [SFS_LABEL]: m.name,
                            [SFS_NAMESPACE_LABEL]: m.namespace,
                          },
                        },
                        topologyKey: 'kubernetes.io/hostname',
                      })),
                    },
                  },
                }
              : {}),
            volumes: [
              { name: 'workspace', persistentVolumeClaim: { claimName: this.pvcName(host) } },
              {
                name: 'mcp-host-runtime-tokens',
                secret: { secretName: mcpHostRuntimeTokenSecretName(host) },
              },
              { name: 'workflow-auth-state', emptyDir: { sizeLimit: '16Mi' } },
              { name: 'tmp', emptyDir: {} },
              ...contextMounts.map(m => ({
                name: HostReconciler.contextMountVolumeName(m),
                persistentVolumeClaim: { claimName: m.pvcName, readOnly: true },
              })),
            ],
          },
        },
      },
    }
  }

  private buildService(host: HostCRD): k8s.V1Service {
    const isDesktop = !!(host.spec.desktop?.browser || host.spec.desktop?.x11)

    const ports: Array<{ name: string; port: number; targetPort: IntOrString; protocol: string }> =
      [
        {
          name: 'http',
          port: config.hostPort,
          targetPort: 'http' as IntOrString,
          protocol: 'TCP',
        },
      ]

    if (isDesktop) {
      ports.push({
        name: 'desktop',
        port: config.desktopPort,
        targetPort: 'desktop' as IntOrString,
        protocol: 'TCP',
      })
    }

    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: host.name,
        namespace: host.namespace,
        labels: {
          app: host.name,
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [HOST_LABEL]: host.name,
        },
      },
      spec: {
        type: 'ClusterIP',
        selector: { app: host.name },
        ports,
      },
    }
  }

  private async checkDeploymentReady(name: string, namespace: string): Promise<boolean> {
    try {
      const deployment = await this.appsApi.readNamespacedDeployment({ name, namespace })
      return (deployment.status?.readyReplicas ?? 0) > 0
    } catch {
      return false
    }
  }

  /**
   * Best-effort read of the per-Host channel-reader Deployment status.
   * Never throws — a read failure returns a degraded status so the caller
   * can surface it without blocking mcp-host reconcile.
   */
  private async checkChannelReaderStatus(
    hostName: string,
    ccCount: number
  ): Promise<HostChannelReaderStatus> {
    const depName = `channel-reader-${hostName}`
    const ns = config.channelsNamespace
    const expected = ccCount > 0

    try {
      const dep = await this.appsApi.readNamespacedDeployment({ name: depName, namespace: ns })
      const readyReplicas = dep.status?.readyReplicas ?? 0
      const desiredReplicas = dep.spec?.replicas ?? 0
      const ready = readyReplicas >= 1

      if (!expected) {
        // No CCs — Deployment may legitimately be scaled to 0.
        return {
          expected: false,
          ready: desiredReplicas > 0 && ready,
          message:
            desiredReplicas > 0 && ready
              ? 'Running (no CommunicationChannels)'
              : 'Scaled to 0 (no CommunicationChannels)',
        }
      }

      return {
        expected: true,
        ready,
        message: ready ? 'Running' : 'Deployment exists but no ready replicas',
      }
    } catch (err) {
      const code = getErrorCode(err)
      if (code === 404) {
        return {
          expected,
          ready: false,
          message: expected ? 'Deployment not found' : 'Not deployed (no CommunicationChannels)',
        }
      }
      // Unknown error — surface it but don't throw.
      console.warn(
        `[HostReconciler] Failed to read channel-reader Deployment "${depName}" for status:`,
        err
      )
      return {
        expected,
        ready: false,
        message: `Status read error: ${(err as Error).message}`,
      }
    }
  }

  private pollReadiness(
    name: string,
    namespace: string,
    intervalMs = 5000,
    maxAttempts = 12
  ): void {
    const existing = this.readinessTimers.get(name)
    if (existing) {
      clearTimeout(existing)
      this.readinessTimers.delete(name)
    }

    let attempts = 0

    const poll = async () => {
      attempts++
      const ready = await this.checkDeploymentReady(name, namespace)
      if (ready) {
        this.setStatus(name, { deployed: true, ready: true, message: 'Running' })
        this.readinessTimers.delete(name)
        return
      }
      if (attempts >= maxAttempts) {
        this.readinessTimers.delete(name)
        return
      }
      const timer = setTimeout(poll, intervalMs)
      this.readinessTimers.set(name, timer)
    }

    const timer = setTimeout(poll, intervalMs)
    this.readinessTimers.set(name, timer)
  }

  private async ensurePvc(host: HostCRD): Promise<void> {
    const pvc = this.buildPvc(host)
    const name = this.pvcName(host)
    try {
      await this.coreApi.createNamespacedPersistentVolumeClaim({
        namespace: host.namespace,
        body: pvc,
      })
      console.log(`[HostReconciler] Created PVC "${name}"`)
    } catch (error) {
      if (getErrorCode(error) === 409) {
        try {
          const existing = await this.coreApi.readNamespacedPersistentVolumeClaim({
            namespace: host.namespace,
            name,
          })
          if (existing.spec?.volumeName) {
            return
          }
          pvc.metadata!.resourceVersion = existing.metadata?.resourceVersion
          await this.coreApi.replaceNamespacedPersistentVolumeClaim({
            namespace: host.namespace,
            name,
            body: pvc,
          })
          console.log(`[HostReconciler] Updated PVC "${name}"`)
        } catch (updateError) {
          console.error(`[HostReconciler] Failed to update PVC "${name}":`, updateError)
        }
      } else {
        console.error(`[HostReconciler] Failed to create PVC "${name}":`, error)
      }
    }
  }

  private async ensureService(host: HostCRD): Promise<void> {
    const service = this.buildService(host)
    try {
      await this.coreApi.createNamespacedService({
        namespace: host.namespace,
        body: service,
      })
      console.log(`[HostReconciler] Created Service "${host.name}"`)
    } catch (error) {
      if (getErrorCode(error) === 409) {
        try {
          await replaceWithConflictRetry({
            description: `Service "${host.name}"`,
            logPrefix: '[HostReconciler]',
            body: service,
            mergeExisting: preserveServiceAssignedFields,
            read: () =>
              this.coreApi.readNamespacedService({
                namespace: host.namespace,
                name: host.name,
              }),
            replace: body =>
              this.coreApi.replaceNamespacedService({
                namespace: host.namespace,
                name: host.name,
                body,
              }),
          })
          console.log(`[HostReconciler] Updated Service "${host.name}"`)
        } catch (updateError) {
          console.error(`[HostReconciler] Failed to update Service "${host.name}":`, updateError)
        }
      } else {
        console.error(`[HostReconciler] Failed to create Service "${host.name}":`, error)
      }
    }
  }

  private async ensureDeployment(
    host: HostCRD,
    mounts: ResolvedSfsMount[],
    runtimeTokenRevision: string,
    lifecycle?: EffectiveHostLifecycle,
    resolveStateBeforeMutation?: () => Promise<DeploymentMutationState>
  ): Promise<void> {
    const buildDesiredDeployment = async (): Promise<k8s.V1Deployment> => {
      const state = resolveStateBeforeMutation ? await resolveStateBeforeMutation() : null
      return this.buildDeployment(
        host,
        mounts,
        state?.runtimeTokenRevision ?? runtimeTokenRevision,
        state?.lifecycle ?? lifecycle
      )
    }
    const deployment = await buildDesiredDeployment()
    try {
      await this.appsApi.createNamespacedDeployment({
        namespace: host.namespace,
        body: deployment,
      })
      console.log(`[HostReconciler] Created Deployment "${host.name}"`)
    } catch (error) {
      if (getErrorCode(error) !== 409) {
        console.error(`[HostReconciler] Failed to create Deployment "${host.name}":`, error)
        throw error
      }
      try {
        await replaceWithConflictRetry({
          description: `Deployment "${host.name}"`,
          logPrefix: '[HostReconciler]',
          body: deployment,
          resolveBody: buildDesiredDeployment,
          mergeExisting: preserveDeploymentAnnotations,
          isUpToDate: deploymentMatchesDesired,
          read: () =>
            this.appsApi.readNamespacedDeployment({
              namespace: host.namespace,
              name: host.name,
            }),
          replace: body =>
            this.appsApi.replaceNamespacedDeployment({
              namespace: host.namespace,
              name: host.name,
              body,
            }),
        })
      } catch (updateError) {
        console.error(`[HostReconciler] Failed to update Deployment "${host.name}":`, updateError)
        throw updateError
      }
    }
  }

  private async deleteRuntimeResources(name: string, namespace: string): Promise<void> {
    const failures: unknown[] = []

    // Desktop NetworkPolicy is created idempotently in ensureDesktopNetworkPolicy;
    // attempt deletion unconditionally so non-desktop hosts (no policy) just hit 404.
    // Kept for backward-compatible cleanup of policies created before rpc-proxy
    // host egress became per-Host.
    const desktopPolicyName = `allow-rpc-proxy-desktop-${name}`
    for (const cleanup of [
      () =>
        this.deleteIfHccOwned(
          'Deployment',
          name,
          namespace,
          name,
          () => this.appsApi.readNamespacedDeployment({ name, namespace }),
          () => this.appsApi.deleteNamespacedDeployment({ name, namespace })
        ),
      () =>
        this.deleteIfHccOwned(
          'Service',
          name,
          namespace,
          name,
          () => this.coreApi.readNamespacedService({ name, namespace }),
          () => this.coreApi.deleteNamespacedService({ name, namespace })
        ),
      () =>
        this.deleteIfHccOwned(
          'NetworkPolicy',
          desktopPolicyName,
          namespace,
          name,
          () =>
            this.networkingApi.readNamespacedNetworkPolicy({ name: desktopPolicyName, namespace }),
          () =>
            this.networkingApi.deleteNamespacedNetworkPolicy({ name: desktopPolicyName, namespace })
        ),
    ]) {
      try {
        await cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    throwCleanupFailures(
      failures,
      `Failed to delete runtime Kubernetes resources for Host "${name}"`
    )
  }

  private async deleteWorkspacePvc(name: string, namespace: string): Promise<void> {
    const pvcName = `${name}-workspace`
    await this.deleteIfHccOwned(
      'PersistentVolumeClaim',
      pvcName,
      namespace,
      name,
      () => this.coreApi.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace }),
      () => this.coreApi.deleteNamespacedPersistentVolumeClaim({ name: pvcName, namespace })
    )
  }

  private async deleteResources(
    name: string,
    namespace: string,
    options: { deleteWorkspacePvc?: boolean } = {}
  ): Promise<void> {
    const failures: unknown[] = []
    const cleanups = [() => this.deleteRuntimeResources(name, namespace)]
    if (options.deleteWorkspacePvc ?? true) {
      cleanups.push(() => this.deleteWorkspacePvc(name, namespace))
    }
    for (const cleanup of cleanups) {
      try {
        await cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    throwCleanupFailures(failures, `Failed to delete Kubernetes resources for Host "${name}"`)
  }

  /**
   * Cascade delete the per-Host channel-reader Deployment in the channels
   * namespace. 404 is swallowed (already gone); non-404 errors abort cleanup
   * so revocation retries instead of silently leaving a reader alive.
   */
  private async deleteChannelReaderDeployment(name: string): Promise<void> {
    const depName = `channel-reader-${name}`
    await this.deleteIfHccOwned(
      'Deployment',
      depName,
      config.channelsNamespace,
      name,
      () =>
        this.appsApi.readNamespacedDeployment({
          name: depName,
          namespace: config.channelsNamespace,
        }),
      () =>
        this.appsApi.deleteNamespacedDeployment({
          name: depName,
          namespace: config.channelsNamespace,
        })
    )
  }

  private async deleteChannelReaderService(name: string): Promise<void> {
    const serviceName = `channel-reader-${name}`
    await this.deleteIfHccOwned(
      'Service',
      serviceName,
      config.channelsNamespace,
      name,
      () =>
        this.coreApi.readNamespacedService({
          name: serviceName,
          namespace: config.channelsNamespace,
        }),
      () =>
        this.coreApi.deleteNamespacedService({
          name: serviceName,
          namespace: config.channelsNamespace,
        })
    )
  }

  /**
   * One-shot startup sweep: delete the legacy static `clerum-channel-reader`
   * Deployment in the channels namespace if it still exists.
   *
   * The legacy static Deployment was the only channel-reader before the
   * per-Host pattern landed. Per-Host Deployments now own that role
   * (channel-reader-<host>). With both alive, the two pods compete on the
   * same Telegram bot token's getUpdates long-poll and Telegram returns
   * 409 Conflict to whichever loses — empirical evidence on minikube +
   * example-dev is captured in #273.
   *
   * Idempotent on every HCC startup: 404 means already gone (the steady
   * state we want), so we log nothing. A successful delete emits an
   * `AUDIT:` line for operator monitoring. Other errors are logged but
   * NOT thrown — startup continues so per-Host reconciles still run.
   *
   * Public so main.ts can call it once at boot, before the reconcile
   * loop starts (preventing the brief window where both pods could
   * poll concurrently).
   */
  async sweepLegacyStaticChannelReader(): Promise<void> {
    const depName = 'clerum-channel-reader'
    const ns = config.channelsNamespace
    try {
      await this.appsApi.deleteNamespacedDeployment({ name: depName, namespace: ns })
      // Structured audit line — operators tail this to confirm the legacy
      // pod is gone post-deploy. Mirrors the format used by
      // sweepOrphanChannelReaderResources for consistency.
      console.log(
        `[HostReconciler] AUDIT: legacy-sweep deleted Deployment name=${depName} ns=${ns}`
      )
    } catch (err) {
      const code = getErrorCode(err)
      if (code === 404) return // already gone — steady state, no log
      console.error(`[HostReconciler] legacy-sweep failed to delete "${depName}" in "${ns}":`, err)
    }
  }

  private async ensureDesktopNetworkPolicy(host: HostCRD): Promise<void> {
    const isDesktop = !!(host.spec.desktop?.browser || host.spec.desktop?.x11)
    if (!isDesktop) return

    const policyName = `allow-rpc-proxy-desktop-${host.name}`
    const policy: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: policyName,
        namespace: host.namespace,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [HOST_LABEL]: host.name,
          'clerum.io/policy-type': 'desktop-ingress',
        },
      },
      spec: {
        podSelector: { matchLabels: { app: host.name } },
        policyTypes: ['Ingress'],
        ingress: [
          {
            _from: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': config.rpcProxyNamespace },
                },
                podSelector: { matchLabels: { app: 'rpc-proxy' } },
              },
            ],
            ports: [{ port: config.desktopPort, protocol: 'TCP' }],
          },
        ],
      },
    }

    try {
      await applyNetworkPolicy(
        this.networkingApi,
        policyName,
        host.namespace,
        policy,
        '[HostReconciler]'
      )
    } catch (error) {
      console.error(
        `[HostReconciler] Failed to ensure desktop NetworkPolicy "${policyName}":`,
        error
      )
    }
  }

  /**
   * Per-Host rpc-proxy egress policy. Pins rpc-proxy traffic to exactly one
   * mcp-host pod instead of relying on namespace-wide rpc-proxy -> mcp-host
   * egress. Desktop hosts also expose the desktop service port through the
   * same host-scoped egress boundary.
   */
  private async ensureRpcProxyHostEgressNetworkPolicy(host: HostCRD): Promise<void> {
    const isDesktop = !!(host.spec.desktop?.browser || host.spec.desktop?.x11)
    const policyName = `rpc-proxy-${host.name}-egress-mcp-host`
    const ports: k8s.V1NetworkPolicyPort[] = [{ port: config.hostPort, protocol: 'TCP' }]
    if (isDesktop) {
      ports.push({ port: config.desktopPort, protocol: 'TCP' })
    }
    const policy: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: policyName,
        namespace: config.rpcProxyNamespace,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [HOST_LABEL]: host.name,
          'clerum.io/policy-type': 'rpc-proxy-host-egress',
        },
      },
      spec: {
        podSelector: { matchLabels: { app: 'rpc-proxy' } },
        policyTypes: ['Egress'],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': host.namespace },
                },
                podSelector: {
                  matchLabels: {
                    [HOST_LABEL]: host.name,
                    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
                  },
                },
              },
            ],
            ports,
          },
        ],
      },
    }

    await applyNetworkPolicy(
      this.networkingApi,
      policyName,
      config.rpcProxyNamespace,
      policy,
      '[HostReconciler]'
    )
  }

  /**
   * Per-Host channel-reader egress policy. Pins channel-reader-<host> pods to
   * its bound mcp-host on :8080. Provider approvals and verification continue
   * through mcp-host; channel-reader must not reach control-api gateways.
   */
  private async ensureChannelReaderEgressNetworkPolicy(host: HostCRD): Promise<void> {
    const policyName = `channel-reader-${host.name}-egress`
    const policy: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: policyName,
        namespace: config.channelsNamespace,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [HOST_LABEL]: host.name,
          'clerum.io/policy-type': 'channel-reader-egress',
        },
      },
      spec: {
        podSelector: {
          matchLabels: {
            app: 'channel-reader',
            [HOST_LABEL]: host.name,
            [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          },
        },
        policyTypes: ['Egress'],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': config.hostNamespace },
                },
                podSelector: {
                  matchLabels: { [HOST_LABEL]: host.name },
                },
              },
            ],
            ports: [{ port: config.hostPort, protocol: 'TCP' }],
          },
        ],
      },
    }

    // Re-throw on failure: per-Host NPs are one half of the
    // channel-reader security boundary. Route-level JWT auth is the other
    // half, so an NP apply error still MUST surface in HostRuntimeStatus
    // rather than be silently swallowed.
    await applyNetworkPolicy(
      this.networkingApi,
      policyName,
      config.channelsNamespace,
      policy,
      '[HostReconciler]'
    )
  }

  /**
   * Per-Host workflow-approval-reader egress policy. Slack interactive callbacks
   * are verified by control-api against a CommunicationChannel, then forwarded
   * to that channel's bound Host for the authoritative provider-decision path.
   */
  private async ensureWorkflowApprovalReaderHostEgressNetworkPolicy(host: HostCRD): Promise<void> {
    const policyName = `workflow-approval-reader-${host.name}-egress-mcp-host`
    const policy: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: policyName,
        namespace: config.channelsNamespace,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [HOST_LABEL]: host.name,
          'clerum.io/policy-type': 'workflow-approval-reader-host-egress',
        },
      },
      spec: {
        podSelector: {
          matchLabels: { 'app.kubernetes.io/name': 'workflow-approval-request-reader' },
        },
        policyTypes: ['Egress'],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': host.namespace },
                },
                podSelector: {
                  matchLabels: {
                    [HOST_LABEL]: host.name,
                    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
                  },
                },
              },
            ],
            ports: [{ port: config.hostPort, protocol: 'TCP' }],
          },
        ],
      },
    }

    await applyNetworkPolicy(
      this.networkingApi,
      policyName,
      config.channelsNamespace,
      policy,
      '[HostReconciler]'
    )
  }

  /**
   * Per-Host mcp-host ingress policy for channel-reader. Pins mcp-host-<host>
   * pod ingress on :8080 to ONLY accept connections from channel-reader-<host>
   * pods (label match).
   */
  private async ensureMcpHostIngressNetworkPolicy(host: HostCRD): Promise<void> {
    const policyName = `mcp-host-${host.name}-ingress-channel-reader`
    const policy: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: policyName,
        namespace: host.namespace,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [HOST_LABEL]: host.name,
          'clerum.io/policy-type': 'channel-reader-ingress',
        },
      },
      spec: {
        podSelector: {
          matchLabels: {
            [HOST_LABEL]: host.name,
            [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          },
        },
        policyTypes: ['Ingress'],
        ingress: [
          {
            _from: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': config.channelsNamespace },
                },
                podSelector: {
                  matchLabels: {
                    app: 'channel-reader',
                    [HOST_LABEL]: host.name,
                    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
                  },
                },
              },
            ],
            ports: [{ port: config.hostPort, protocol: 'TCP' }],
          },
        ],
      },
    }

    // Re-throw on failure: per-Host NPs are one half of the
    // channel-reader↔mcp-host security boundary. Route-level JWT auth is
    // the other half, so an apply error MUST surface in HostRuntimeStatus
    // rather than be silently swallowed.
    await applyNetworkPolicy(
      this.networkingApi,
      policyName,
      host.namespace,
      policy,
      '[HostReconciler]'
    )
  }

  /**
   * Per-Host mcp-host ingress policy for workflow-approval-reader. This is the
   * provider webhook counterpart to channel-reader ingress and stays pinned to
   * the Host resolved from the verified CommunicationChannel target.
   */
  private async ensureWorkflowApprovalReaderMcpHostIngressNetworkPolicy(
    host: HostCRD
  ): Promise<void> {
    const policyName = `mcp-host-${host.name}-ingress-workflow-approval-reader`
    const policy: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: policyName,
        namespace: host.namespace,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [HOST_LABEL]: host.name,
          'clerum.io/policy-type': 'workflow-approval-reader-host-ingress',
        },
      },
      spec: {
        podSelector: {
          matchLabels: {
            [HOST_LABEL]: host.name,
            [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          },
        },
        policyTypes: ['Ingress'],
        ingress: [
          {
            _from: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': config.channelsNamespace },
                },
                podSelector: {
                  matchLabels: {
                    'app.kubernetes.io/name': 'workflow-approval-request-reader',
                  },
                },
              },
            ],
            ports: [{ port: config.hostPort, protocol: 'TCP' }],
          },
        ],
      },
    }

    await applyNetworkPolicy(
      this.networkingApi,
      policyName,
      host.namespace,
      policy,
      '[HostReconciler]'
    )
  }

  /**
   * Per-Host mcp-host ingress policy for rpc-proxy. This replaces the legacy
   * namespace-wide mcp-host ingress rule for rpc-proxy. Desktop hosts include
   * the desktop port, but only for the selected Host pod.
   */
  private async ensureRpcProxyMcpHostIngressNetworkPolicy(host: HostCRD): Promise<void> {
    const isDesktop = !!(host.spec.desktop?.browser || host.spec.desktop?.x11)
    const policyName = `mcp-host-${host.name}-ingress-rpc-proxy`
    const ports: k8s.V1NetworkPolicyPort[] = [{ port: config.hostPort, protocol: 'TCP' }]
    if (isDesktop) {
      ports.push({ port: config.desktopPort, protocol: 'TCP' })
    }
    const policy: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: policyName,
        namespace: host.namespace,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [HOST_LABEL]: host.name,
          'clerum.io/policy-type': 'rpc-proxy-host-ingress',
        },
      },
      spec: {
        podSelector: {
          matchLabels: {
            [HOST_LABEL]: host.name,
            [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          },
        },
        policyTypes: ['Ingress'],
        ingress: [
          {
            _from: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': config.rpcProxyNamespace },
                },
                podSelector: { matchLabels: { app: 'rpc-proxy' } },
              },
            ],
            ports,
          },
        ],
      },
    }

    await applyNetworkPolicy(
      this.networkingApi,
      policyName,
      host.namespace,
      policy,
      '[HostReconciler]'
    )
  }

  /**
   * Per-Host mcp-host egress to gfsc. The runtime token grants authority; this
   * NetworkPolicy only opens the required transport lane from the selected Host
   * pod to the governed GFS controller service.
   */
  private async ensureMcpHostGfsEgressNetworkPolicy(host: HostCRD): Promise<void> {
    const target = { namespace: config.gfsNamespace, port: config.gfscPort }
    const policyName = `mcp-host-${host.name}-egress-gfs`
    const policy: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: policyName,
        namespace: host.namespace,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [HOST_LABEL]: host.name,
          'clerum.io/policy-type': 'gfs-egress',
        },
      },
      spec: {
        podSelector: {
          matchLabels: {
            [HOST_LABEL]: host.name,
            [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          },
        },
        policyTypes: ['Egress'],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': target.namespace },
                },
                podSelector: {
                  matchLabels: { app: 'gfs-controller' },
                },
              },
            ],
            ports: [{ port: target.port, protocol: 'TCP' }],
          },
        ],
      },
    }

    await applyNetworkPolicy(
      this.networkingApi,
      policyName,
      host.namespace,
      policy,
      '[HostReconciler]'
    )
  }

  /**
   * Delete per-Host NetworkPolicies created by this reconciler.
   * 404-tolerant — safe to call even if NPs were never created or already gone.
   */
  private async deleteHostNetworkPolicies(name: string, namespace: string): Promise<void> {
    const failures: unknown[] = []
    const policies = [
      { name: `mcp-host-${name}-ingress-channel-reader`, namespace },
      { name: `mcp-host-${name}-ingress-workflow-approval-reader`, namespace },
      { name: `mcp-host-${name}-ingress-rpc-proxy`, namespace },
      { name: `mcp-host-${name}-egress-gfs`, namespace },
      { name: `channel-reader-${name}-egress`, namespace: config.channelsNamespace },
      {
        name: `workflow-approval-reader-${name}-egress-mcp-host`,
        namespace: config.channelsNamespace,
      },
      { name: `rpc-proxy-${name}-egress-mcp-host`, namespace: config.rpcProxyNamespace },
    ]
    for (const policy of policies) {
      try {
        await this.deleteIfHccOwned(
          'NetworkPolicy',
          policy.name,
          policy.namespace,
          name,
          () =>
            this.networkingApi.readNamespacedNetworkPolicy({
              name: policy.name,
              namespace: policy.namespace,
            }),
          () =>
            this.networkingApi.deleteNamespacedNetworkPolicy({
              name: policy.name,
              namespace: policy.namespace,
            })
        )
      } catch (error) {
        failures.push(error)
      }
    }
    throwCleanupFailures(failures, `Failed to delete NetworkPolicies for Host "${name}"`)
  }

  private async deleteHostRuntimeResources(
    name: string,
    namespace: string,
    options: { deleteWorkspacePvc?: boolean } = {}
  ): Promise<void> {
    const failures: unknown[] = []
    for (const cleanup of [
      () => this.deleteResources(name, namespace, options),
      () => this.deleteHostRbac(name, namespace),
      () => this.deleteMcpHostRuntimeTokenSecret(name, namespace),
      () => this.deleteLegacyChannelReaderRuntimeAuth(name),
      () => this.deleteChannelReaderService(name),
      () => this.deleteChannelReaderDeployment(name),
      () => this.deleteHostNetworkPolicies(name, namespace),
    ]) {
      try {
        await cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    throwCleanupFailures(failures, `Failed to delete runtime resources for Host "${name}"`)
  }

  async reconcile(host: HostCRD, source: HostReconcileSource = 'urgent'): Promise<void> {
    const dispatchedAt = Date.now()
    return this.lifecycle.serializeByHost(host.name, async () => {
      const admittedAt = Date.now()
      hostReconcileInFlight.inc({ lane: source })
      try {
        await this.reconcileCore(host)
        this.enqueueReconcileOutcome(host)
        this.observeReconcileLatency(source, 'success', dispatchedAt, admittedAt)
      } catch (error) {
        this.enqueueControllerError(host, 'reconcile_exception', error)
        this.enqueueReconcileOutcome(host)
        this.observeReconcileLatency(source, 'error', dispatchedAt, admittedAt)
        throw error
      } finally {
        hostReconcileInFlight.dec({ lane: source })
      }
    })
  }

  private observeReconcileLatency(
    source: HostReconcileSource,
    outcome: 'success' | 'error',
    dispatchedAt: number,
    admittedAt: number
  ): void {
    hostReconcileQueueWaitSeconds.observe(
      { lane: source, outcome },
      Math.max(0, admittedAt - dispatchedAt) / 1000
    )
    hostReconcileDurationSeconds.observe(
      { source, outcome },
      Math.max(0, Date.now() - admittedAt) / 1000
    )
  }

  private async reconcileCore(host: HostCRD): Promise<void> {
    // Wake fast-path (Stage 4.3) BEFORE the heavy reconcile body: reconciles
    // are serialized PER HOST (serializeByHost), so a pending wake for THIS
    // Host must not wait behind token issuance, NetworkPolicies or the
    // channel-reader work below in this same chain. Other Hosts no longer gate
    // it — the process-wide convergence tail was removed. The periodic resync
    // funnels through this same method, so a watch event dropped on disconnect
    // is recovered here.
    const forceFreshForWake = (await this.lifecycle.handleWakeFastPath(host)) === true

    // Track whether this host has desktop enabled
    const isDesktop = !!(host.spec.desktop?.browser || host.spec.desktop?.x11)
    if (isDesktop) {
      this.desktopHosts.add(host.name)
    } else {
      this.desktopHosts.delete(host.name)
    }

    const secretResult = await this.validateHostSecret(host)
    if (!secretResult.ok) {
      if (
        secretResult.reason === 'SecretNotFound' ||
        secretResult.reason === 'SecretAccessDenied'
      ) {
        await this.deleteHostRuntimeResources(host.name, host.namespace, {
          deleteWorkspacePvc: false,
        })
      } else {
        console.warn(
          `[HostReconciler] Preserving existing runtime for "${host.name}" after transient Secret read failure`
        )
      }
      this.setStatus(host.name, {
        deployed: false,
        ready: false,
        message: secretResult.message,
      })
      this.enqueueControllerError(host, secretResult.reason, new Error(secretResult.message))
      return
    }

    // Per-Host SA + Role + RoleBinding must exist BEFORE the Deployment,
    // otherwise the kubelet can't mount the SA token and the pod will
    // crash-loop until RBAC is created.
    await this.ensureHostServiceAccount(host)
    await this.ensureHostRole(host)
    await this.ensureHostRoleBinding(host)

    let mounts: ResolvedSfsMount[] = []
    try {
      mounts = await this.resolveContextMounts(host)
    } catch (err) {
      // A failure to resolve mounts should not block the rest of the Host
      // reconciliation — the pod will still come up without the SFS mounts,
      // and a subsequent reconcile (Context update or SFS becoming Ready)
      // will inject them.
      console.error(`[HostReconciler] Failed to resolve context mounts for "${host.name}":`, err)
    }
    // Stateless lifecycle (Stage 2): assess enable/reject and persist the
    // durable state to the Host status subresource BEFORE building the
    // Deployment, so replicas derive from the same assessment.
    let lifecycle = await this.lifecycle.assessLifecycle(host, mounts)
    // Drained-pre-scale guard (Stage 4.3): a pending wake must abort the
    // suspension IMMEDIATELY before replicas:0 derives from this assessment
    // — see StatelessLifecycleExecutor.resolveWakeBeforeScaleDown. A null
    // result means the fresh guard read failed: skip the scale-down this
    // pass (the periodic resync retries) rather than scaling to 0 on stale
    // data.
    const guardedLifecycle = await this.lifecycle.resolveWakeBeforeScaleDown(host, lifecycle)
    if (guardedLifecycle === null) {
      return
    }
    lifecycle = guardedLifecycle
    const lifecycleStatusCommitted = await this.lifecycle.writeLifecycleStatusToCluster(
      host,
      lifecycle
    )
    if (lifecycleStatusCommitted) {
      this.enqueueHostTelemetry(host, 'lifecycle_transition', lifecycle.effective.state, {
        status: 'committed',
        transition: `lifecycle:${lifecycle.effective.state}`,
        state: lifecycle.effective.state,
        phase: lifecycle.effective.stateless ? 'stateless' : 'stateful',
        summary: lifecycle.lifecycle.reason,
      })
    }

    await this.ensurePvc(host)
    await this.ensureService(host)

    // NetworkPolicies before Deployments. Calico/Cilium evaluate egress and
    // ingress against the policies that exist when the connection is opened,
    // so any pod created before its policy comes up runs briefly with the
    // namespace's deny-all default. The channel-reader path is fail-closed
    // (deny-all blocks message delivery), but creating the policy first
    // makes rollout deterministic and avoids transient readiness failures.
    //
    // The per-Host NPs are the network boundary for this direct runtime hop.
    // Route-level edge context and ownership checks remain the application
    // boundary. An NP apply failure means the network boundary is missing, so
    // surface it via HostRuntimeStatus instead of swallowing it.
    const npFailures: string[] = []
    try {
      await this.ensureMcpHostIngressNetworkPolicy(host)
      await this.ensureMcpHostGfsEgressNetworkPolicy(host)
      await this.ensureWorkflowApprovalReaderMcpHostIngressNetworkPolicy(host)
    } catch (err) {
      console.error(`[HostReconciler] Failed to ensure mcp-host NP for "${host.name}":`, err)
      npFailures.push(`mcp-host NP: ${(err as Error).message}`)
    }
    try {
      await this.ensureRpcProxyMcpHostIngressNetworkPolicy(host)
      await this.ensureRpcProxyHostEgressNetworkPolicy(host)
    } catch (err) {
      console.error(`[HostReconciler] Failed to ensure rpc-proxy host NP for "${host.name}":`, err)
      npFailures.push(`rpc-proxy NP: ${(err as Error).message}`)
    }
    await this.ensureDesktopNetworkPolicy(host)
    try {
      await this.ensureChannelReaderEgressNetworkPolicy(host)
      await this.ensureWorkflowApprovalReaderHostEgressNetworkPolicy(host)
    } catch (err) {
      console.error(`[HostReconciler] Failed to ensure channels egress NP for "${host.name}":`, err)
      npFailures.push(`egress NP: ${(err as Error).message}`)
    }

    // Resolve policy once before bootstrap so token scopes and wake/suspend
    // decisions use the latest channel state already observed.
    const bootstrapLifecycle = this.lifecycle.enforceCommunicationChannelPolicyBeforeDeployment(
      host.name,
      lifecycle
    )
    if (bootstrapLifecycle !== lifecycle) {
      lifecycle = bootstrapLifecycle
      await this.lifecycle.writeLifecycleStatusToCluster(host, lifecycle)
    }

    // Bootstrap captures the scope contract used for issuance. The Deployment
    // guard below compares that contract with the live channel cache after this
    // potentially slow I/O and before every create/replace attempt.
    let runtimeTokenProvision = await this.provisionRuntimeTokenRevision(host, {
      forceFreshForWake,
      targetSuspended: lifecycle.effective.stateless && lifecycle.effective.state === 'suspended',
    })

    // replaceWithConflictRetry may wait and re-read after a 409, so each body is
    // rebuilt from a stable lifecycle plus token-scope pair before mutation.
    const resolveDeploymentLifecycle = async (): Promise<EffectiveHostLifecycle> => {
      const deploymentLifecycle = this.lifecycle.enforceCommunicationChannelPolicyBeforeDeployment(
        host.name,
        lifecycle
      )
      if (deploymentLifecycle !== lifecycle) {
        lifecycle = deploymentLifecycle
        await this.lifecycle.writeLifecycleStatusToCluster(host, lifecycle)
      }
      return lifecycle.effective
    }

    const ensureCurrentRuntimeTokenScope = async (): Promise<void> => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const currentScopeHash = HostReconciler.runtimeTokenScopeHash(
          host,
          this.hasChannelIngress(host)
        )
        if (runtimeTokenProvision.scopeHash === currentScopeHash) return

        runtimeTokenProvision = await this.provisionRuntimeTokenRevision(host, {
          forceFreshForWake: false,
          targetSuspended:
            lifecycle.effective.stateless && lifecycle.effective.state === 'suspended',
        })
        const postProvisionScopeHash = HostReconciler.runtimeTokenScopeHash(
          host,
          this.hasChannelIngress(host)
        )
        if (runtimeTokenProvision.scopeHash === postProvisionScopeHash) return

        log.warn('CommunicationChannel scope contract changed during token provisioning', {
          host: host.name,
          namespace: host.namespace,
          attempt,
        })
      }
      throw new Error(
        `CommunicationChannel scope contract did not stabilize before Deployment mutation for host "${host.name}"`
      )
    }

    const resolveDeploymentState = async (): Promise<DeploymentMutationState> => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await resolveDeploymentLifecycle()
        await ensureCurrentRuntimeTokenScope()
        const effective = await resolveDeploymentLifecycle()
        const currentScopeHash = HostReconciler.runtimeTokenScopeHash(
          host,
          this.hasChannelIngress(host)
        )
        if (runtimeTokenProvision.scopeHash === currentScopeHash) {
          return {
            lifecycle: effective,
            runtimeTokenRevision: runtimeTokenProvision.revision,
          }
        }
        log.warn('CommunicationChannel scope contract changed before Deployment mutation', {
          host: host.name,
          namespace: host.namespace,
          attempt,
        })
      }
      throw new Error(
        `CommunicationChannel lifecycle and token scope did not stabilize before Deployment mutation for host "${host.name}"`
      )
    }

    await this.ensureDeployment(
      host,
      mounts,
      runtimeTokenProvision.revision,
      lifecycle.effective,
      resolveDeploymentState
    )

    const suspended = lifecycle.effective.stateless && lifecycle.effective.state === 'suspended'
    if (suspended) {
      this.lifecycle.recordSuspendedApplied(host.name)
    } else {
      this.lifecycle.markHostNotSuspended(host.name)
    }
    const ready = suspended ? false : await this.checkDeploymentReady(host.name, host.namespace)
    // If any per-Host NP failed to apply, mark the host as degraded:
    // deployed remains true (the pod is in place), but ready=false +
    // a message that names the missing security boundary. Operators see
    // this in `kubectl get host ... -o yaml` under status.runtime.message.
    const baseMessage = suspended
      ? 'Suspended (stateless lifecycle, replicas=0)'
      : ready
        ? 'Running'
        : 'Deployment created, waiting for pods to become ready'
    const message = npFailures.length
      ? `degraded — NetworkPolicy boundary missing (${npFailures.join('; ')})`
      : baseMessage
    this.setStatus(host.name, {
      deployed: true,
      ready: ready && npFailures.length === 0,
      message,
    })
    if (!ready && !suspended) {
      this.pollReadiness(host.name, host.namespace)
    }

    // Materialize the per-Host channel-reader Deployment. The egress NP that
    // pins this pod to mcp-host has already been applied above. A failure does
    // not remove the converged mcp-host pod, but it rejects this reconcile so
    // the caller can retry and is surfaced in HostRuntimeStatus.
    //
    // computeChannelReaderRevisionForHost re-throws on Secret read errors
    // other than 404 (RBAC drift, 503, etc.), so this catch handles a real
    // expected error path — not just defense in depth.
    const channelReaderFailures: unknown[] = []
    for (const reconcileResource of [
      () => this.reconcileChannelReaderService(host),
      () => this.reconcileChannelReaderDeployment(host),
    ]) {
      try {
        await reconcileResource()
      } catch (err) {
        channelReaderFailures.push(err)
      }
    }
    const channelReaderError = channelReaderFailures
      .map(error => (error instanceof Error ? error.message : String(error)))
      .join('; ')
    if (channelReaderError) {
      const prev = this.getStatus(host.name)
      this.setStatus(host.name, {
        ...prev,
        message: `channel-reader: ${channelReaderError}`,
      })
    }

    // Surface channel-reader Deployment readiness in HostRuntimeStatus.
    // Best-effort — checkChannelReaderStatus never throws.
    const ccCount = this.countCommunicationChannels(host.name)
    const channelReaderStatus = await this.checkChannelReaderStatus(host.name, ccCount)
    if (channelReaderFailures.length > 0) {
      // Overlay the reconcile error onto the status message so both signals
      // are visible (the deploy error may explain why the Deployment is missing).
      channelReaderStatus.message = `reconcile error: ${channelReaderError}`
      channelReaderStatus.ready = false
      this.enqueueControllerError(
        host,
        'channel_reader_reconcile_failed',
        new Error(channelReaderError)
      )
    }
    const prev = this.getStatus(host.name)
    this.setStatus(host.name, { ...prev, channelReader: channelReaderStatus })
    throwCleanupFailures(
      channelReaderFailures,
      `Failed to converge channel-reader resources for Host "${host.name}"`
    )
  }

  /**
   * Delete a Host's runtime bundle.
   *
   * `opts.skipIf` is an OPTIONAL fence evaluated INSIDE the per-Host serializer,
   * immediately before anything destructive runs. Callers whose "this Host is
   * gone" decision was made BEFORE admission (the watch-recovery diff, which
   * compares LIST-time names) pass it so a same-name Host recreated during the
   * admission window is not wiped: the recreation's ADDED sets the cache and
   * enters this Host's chain FIRST, its reconcile rebuilds the bundle, and only
   * then does the stale delete reach the front of the strict-FIFO queue.
   * Ownership labels cannot discriminate here — the rebuilt bundle carries
   * identical `clerum.io/host` + managed-by labels — and no uid is available on
   * that path, so cache presence at admission is the correct fence. This
   * mirrors the F2/#827 in-serializer re-check in collectHostCleanupFailures.
   *
   * Callers that omit `opts` keep the previous unconditional behavior exactly.
   */
  async reconcileDelete(
    name: string,
    namespace: string,
    opts?: { skipIf?: () => boolean }
  ): Promise<void> {
    // A DELETED event must not race an in-flight create/update for the same
    // Host: route it through the same per-Host serializer as reconcile(). The
    // global convergence tail no longer provides this ordering.
    await this.lifecycle.serializeByHost(name, async () => {
      if (opts?.skipIf?.()) {
        // Same vocabulary the watch path already reports for this condition
        // (reconcileHostWatchEvent), so the skip is observable, not silent.
        hostDeleteCleanupTotal.inc({ outcome: 'superseded' })
        return
      }
      await this.deleteHostRuntimeResources(name, namespace)
      this.clearStatus(name)
      this.desktopHosts.delete(name)
    })
  }

  /**
   * Reconcile the fleet with bounded cross-Host concurrency. Dispatches Host
   * KEYS (not stale object snapshots): each worker resolves the CURRENT cached
   * Host at execution time and skips entries the cache no longer holds
   * (superseded by a delete/newer event). Failures are aggregated completely.
   */
  private async collectHostReconcileFailures(
    desiredHosts: HostCRD[],
    source: HostReconcileSource
  ): Promise<unknown[]> {
    const snapshotByName = new Map(desiredHosts.map(h => [h.name, h]))
    const resolve = this.resolveCurrentHost ?? ((name: string) => snapshotByName.get(name))
    const keys = desiredHosts.map(h => h.name)
    return runBoundedHostWorkers(keys, config.hostFullReconcileConcurrency, async name => {
      const host = resolve(name)
      if (!host) return // absent/superseded since the pass captured its snapshot
      try {
        await this.reconcile(host, source)
      } catch (error) {
        console.error(`[HostReconciler] Fleet reconcile failed for Host "${name}":`, error)
        throw error
      }
    })
  }

  /**
   * Orphan cleanup with the §10.5 authority contract (replaces the accidental
   * safety the removed global tail used to provide):
   *  - runs only with known watch authority and the SAME generation captured at
   *    pass start;
   *  - compares candidates with the CURRENT cache, not the pass snapshot;
   *  - groups candidates by owning logical Host from ownership labels; a
   *    candidate with no derivable owner is NEVER deleted (deferred + recorded);
   *  - performs ONE fresh authoritative Host read per orphan Host; a confirmed
   *    404 (while authority stays valid) authorizes deleting that Host's entire
   *    owned bundle INSIDE the Host's per-Host serializer;
   *  - defers (with a bounded reason) on unknown authority, generation drift,
   *    watch loss, a present read, or a failed read.
   */
  private async collectHostCleanupFailures(
    capturedAuthority: HostWatchAuthoritySnapshot
  ): Promise<unknown[]> {
    const failures: unknown[] = []
    const authorityValid = (): boolean => {
      const current = this.hostWatchAuthority()
      return (
        capturedAuthority.known &&
        current.known &&
        capturedAuthority.generation === current.generation
      )
    }

    if (!authorityValid()) {
      const current = this.hostWatchAuthority()
      const reason =
        !capturedAuthority.known || !current.known ? 'authority_unknown' : 'generation_changed'
      hostCleanupDeferredTotal.inc({ reason })
      console.warn(`[HostReconciler] Deferring orphan cleanup: ${reason}`)
      return failures
    }

    let candidates: CleanupCandidate[]
    try {
      candidates = await this.gatherCleanupCandidates(failures)
    } catch (error) {
      failures.push(error)
      return failures
    }

    const cacheHasHost = (name: string): boolean =>
      this.resolveCurrentHost ? this.resolveCurrentHost(name) !== undefined : false

    const orphanHosts = new Set<string>()
    for (const candidate of candidates) {
      if (!candidate.owner) {
        // Never delete a resource whose owning Host cannot be derived.
        hostCleanupDeferredTotal.inc({ reason: 'no_owner_label' })
        console.warn(
          `[HostReconciler] Deferring orphan candidate ${candidate.kind}/${candidate.name}: no derivable owning Host`
        )
        continue
      }
      if (cacheHasHost(candidate.owner)) continue // still present → retain
      orphanHosts.add(candidate.owner)
    }

    // §10.5 destructive cleanup runs per orphan logical Host. Each Host's owned
    // write set is disjoint (§10.4 inventory) and each destructive bundle runs
    // inside that Host's own `serializeByHost` chain, so distinct orphan Hosts
    // are provably independent. Addendum 2: dispatch them through the same
    // bounded worker pool as the fleet (reusing HCC_HOST_FULL_RECONCILE_CONCURRENCY)
    // instead of a serial `for … await` — never an unbounded fan-out at the K8s
    // API. Same-Host ordering is still guaranteed by serializeByHost, and delete
    // failures still aggregate completely because runBoundedHostWorkers collects
    // every lane's throw.
    const cleanupFailures = await runBoundedHostWorkers(
      Array.from(orphanHosts),
      config.hostFullReconcileConcurrency,
      async hostName => {
        if (!authorityValid()) {
          hostCleanupDeferredTotal.inc({ reason: 'watch_lost' })
          console.warn(
            `[HostReconciler] Deferring orphan cleanup for "${hostName}": watch authority lost`
          )
          return
        }
        const presence = await this.readHostPresence(hostName)
        if (presence === 'present') return // reappeared → retain
        if (presence === 'error') {
          hostCleanupDeferredTotal.inc({ reason: 'fresh_read_failed' })
          return
        }
        if (
          !destructiveCleanupAllowed({
            watchAuthorityKnown: this.hostWatchAuthority().known,
            capturedWatchGeneration: capturedAuthority.generation,
            currentWatchGeneration: this.hostWatchAuthority().generation,
            currentCacheOmitsHost: !cacheHasHost(hostName),
            // Derived, not hardcoded. `presence` is provably 'absent' here (the
            // 'present' and 'error' branches returned above), so this evaluates
            // to the identical literal and the runtime behavior is unchanged.
            // Deriving it makes the mapping total: if readHostPresence ever
            // grows a fourth outcome, the else-branch type stops satisfying
            // freshAuthoritativeRead's union and the compiler rejects it —
            // instead of silently labelling a non-404 read as 'confirmed404'
            // in a value that is DECISIONAL (a conjunct of
            // destructiveCleanupAllowed, :94-95), not telemetry.
            freshAuthoritativeRead: presence === 'absent' ? 'confirmed404' : presence,
          })
        ) {
          hostCleanupDeferredTotal.inc({ reason: 'watch_lost' })
          return
        }
        try {
          await this.lifecycle.serializeByHost(hostName, async () => {
            // F2 / #827 TOCTOU: a same-name Host recreated between the fresh read
            // above and admission into this serializer updates the current cache
            // (its ADDED event sets the cache before its reconcile runs, and that
            // reconcile serializes ahead of this delete). Re-check the current
            // cache INSIDE the serializer so a just-recreated Host's bundle is
            // never deleted by this stale cleanup.
            if (cacheHasHost(hostName)) {
              hostCleanupDeferredTotal.inc({ reason: 'recreated' })
              return
            }
            await this.deleteHostRuntimeResources(hostName, config.hostNamespace)
          })
        } catch (error) {
          console.error(
            `[HostReconciler] Fleet cleanup failed for orphan Host "${hostName}":`,
            error
          )
          throw error
        }
      }
    )
    failures.push(...cleanupFailures)
    return failures
  }

  /**
   * List every managed resource that could be an orphan and derive its owning
   * logical Host from ownership labels. List failures are collected into
   * `listFailures` (reported by the caller) so a partial discovery still cleans
   * what it could confidently attribute. Candidates never drive a delete on
   * their own — the caller applies the fresh-read authority gate.
   */
  private async gatherCleanupCandidates(listFailures: unknown[]): Promise<CleanupCandidate[]> {
    const candidates: CleanupCandidate[] = []
    const pushOwner = (kind: string, name: string | undefined, owner: string | undefined): void => {
      if (!name) return
      candidates.push({ kind, name, owner })
    }

    try {
      for (const deployment of await this.listManagedHostDeployments()) {
        pushOwner(
          'Deployment',
          deployment.metadata?.name,
          deployment.metadata?.labels?.[HOST_LABEL]
        )
      }
    } catch (error) {
      console.error('[HostReconciler] Failed to list managed host deployments:', error)
      listFailures.push(error)
    }

    const channelsNs = config.channelsNamespace
    const managed = (labels: Record<string, string> | undefined): boolean =>
      labels?.[MANAGED_BY_LABEL] === MANAGED_BY_VALUE
    try {
      const list = await this.appsApi.listNamespacedDeployment({ namespace: channelsNs })
      for (const dep of list.items ?? []) {
        const labels = dep.metadata?.labels
        if (labels?.app !== 'channel-reader' || !managed(labels)) continue
        pushOwner('ChannelReaderDeployment', dep.metadata?.name, labels[HOST_LABEL])
      }
    } catch (error) {
      console.warn('[HostReconciler] channel-reader Deployment candidate list failed:', error)
      listFailures.push(error)
    }
    try {
      const list = await this.coreApi.listNamespacedService({ namespace: channelsNs })
      for (const svc of list.items ?? []) {
        const labels = svc.metadata?.labels
        if (labels?.app !== 'channel-reader' || !managed(labels)) continue
        pushOwner('ChannelReaderService', svc.metadata?.name, labels[HOST_LABEL])
      }
    } catch (error) {
      console.warn('[HostReconciler] channel-reader Service candidate list failed:', error)
      listFailures.push(error)
    }
    try {
      const list = await this.coreApi.listNamespacedSecret({
        namespace: channelsNs,
        labelSelector: [
          `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
          'clerum.io/component=channel-reader',
        ].join(','),
      })
      for (const sec of list.items ?? []) {
        const labels = sec.metadata?.labels
        if (!managed(labels) || labels?.['clerum.io/component'] !== 'channel-reader') continue
        pushOwner('ChannelReaderSecret', sec.metadata?.name, labels[HOST_LABEL])
      }
    } catch (error) {
      console.warn('[HostReconciler] channel-reader Secret candidate list failed:', error)
      listFailures.push(error)
    }

    // #827 (Addendum 4 item 4): partial-leftover discovery. A bundle whose
    // Deployment — and even its NetworkPolicies — are already gone must still be
    // discovered from ANY surviving owned resource. List every owned kind HCC
    // writes in the host namespace by ownership label and derive the owner from
    // clerum.io/host; a candidate without a derivable owner is never deleted by
    // the caller (§10.5).
    const hostNs = config.hostNamespace
    const managedSelector = `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`
    const gatherOwnedKind = async (
      kind: string,
      list: () => Promise<{
        items?: Array<{ metadata?: { name?: string; labels?: Record<string, string> } }>
      }>
    ): Promise<void> => {
      try {
        const res = await list()
        for (const item of res.items ?? []) {
          if (!managed(item.metadata?.labels)) continue
          pushOwner(kind, item.metadata?.name, item.metadata?.labels?.[HOST_LABEL])
        }
      } catch (error) {
        console.warn(`[HostReconciler] ${kind} candidate list failed in ${hostNs}:`, error)
        listFailures.push(error)
      }
    }
    await gatherOwnedKind('Service', () =>
      this.coreApi.listNamespacedService({ namespace: hostNs, labelSelector: managedSelector })
    )
    await gatherOwnedKind('PersistentVolumeClaim', () =>
      this.coreApi.listNamespacedPersistentVolumeClaim({
        namespace: hostNs,
        labelSelector: managedSelector,
      })
    )
    await gatherOwnedKind('ServiceAccount', () =>
      this.coreApi.listNamespacedServiceAccount({
        namespace: hostNs,
        labelSelector: managedSelector,
      })
    )
    await gatherOwnedKind('Secret', () =>
      this.coreApi.listNamespacedSecret({ namespace: hostNs, labelSelector: managedSelector })
    )
    await gatherOwnedKind('Role', () =>
      this.rbacApi.listNamespacedRole({ namespace: hostNs, labelSelector: managedSelector })
    )
    await gatherOwnedKind('RoleBinding', () =>
      this.rbacApi.listNamespacedRoleBinding({ namespace: hostNs, labelSelector: managedSelector })
    )

    for (const ns of [config.channelsNamespace, config.hostNamespace, config.rpcProxyNamespace]) {
      try {
        const list = await this.networkingApi.listNamespacedNetworkPolicy({
          namespace: ns,
          labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
        })
        for (const np of list.items ?? []) {
          pushOwner('NetworkPolicy', np.metadata?.name, np.metadata?.labels?.[HOST_LABEL])
        }
      } catch (error) {
        console.warn(`[HostReconciler] NetworkPolicy candidate list failed in ${ns}:`, error)
        listFailures.push(error)
      }
    }

    return candidates
  }

  /**
   * One fresh authoritative Host read. `absent` is a confirmed 404 (the Host is
   * genuinely gone). `present` means the Host reappeared. `error` (timeout,
   * forbidden, 5xx) is deliberately NOT surfaced as a pass failure — the caller
   * defers with a bounded reason, matching the §13.2 cleanup matrix.
   */
  private async readHostPresence(name: string): Promise<'absent' | 'present' | 'error'> {
    try {
      await this.customApi.getNamespacedCustomObject({
        group: HOST_GROUP,
        version: HOST_VERSION,
        namespace: config.hostNamespace,
        plural: HOST_PLURAL,
        name,
      })
      return 'present'
    } catch (error) {
      if (getErrorCode(error) === 404) return 'absent'
      console.warn(`[HostReconciler] Fresh authoritative read for orphan "${name}" failed:`, error)
      return 'error'
    }
  }

  async reconcileHosts(desiredHosts: HostCRD[]): Promise<void> {
    const hostFailures = await this.collectHostReconcileFailures(desiredHosts, 'fleet')
    if (hostFailures.length > 0) {
      throw new HostFleetReconcileError(hostFailures, [])
    }
  }

  async fullReconcile(desiredHosts: HostCRD[]): Promise<void> {
    // Capture watch authority + generation at pass start (§10.5 step 1) so
    // cleanup can prove nothing shifted underneath it before deleting.
    const capturedAuthority = this.hostWatchAuthority()
    const hostFailures = await this.collectHostReconcileFailures(desiredHosts, 'fleet')
    // Cleanup runs only after every fleet worker has settled.
    const cleanupFailures = await this.collectHostCleanupFailures(capturedAuthority)
    if (hostFailures.length > 0 || cleanupFailures.length > 0) {
      throw new HostFleetReconcileError(hostFailures, cleanupFailures)
    }
  }

  private async listManagedHostDeployments(): Promise<k8s.V1Deployment[]> {
    const response = await this.appsApi.listNamespacedDeployment({
      namespace: config.hostNamespace,
      labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
    })
    return (response.items || []).filter(item => item.metadata?.labels?.[HOST_LABEL])
  }
}

function canonicalStringify(obj: Record<string, unknown>): string {
  const sorted = Object.keys(obj).sort()
  return JSON.stringify(sorted.map(k => [k, obj[k]]))
}

/**
 * Kubernetes persists server metadata and defaulted Deployment/PodSpec fields
 * that HCC does not author. Remove only those known fields before comparing
 * the objects; every HCC-authored field stays exact so an intentional removal
 * or change still causes a rollout. Keep this allowlist conservative: an
 * unknown admission mutation must compare as drift rather than be silently
 * ignored. Pod-template annotations are merged by preserveDeploymentAnnotations
 * before this comparison.
 */
function deploymentMatchesDesired(desired: k8s.V1Deployment, existing: k8s.V1Deployment): boolean {
  return (
    JSON.stringify(normalizeDeploymentForComparison(desired)) ===
    JSON.stringify(normalizeDeploymentForComparison(existing))
  )
}

/**
 * Preserve operational annotations without retaining the channel-reader
 * revision when HCC intentionally omits it from the desired pod template.
 * That annotation is controller-owned and must be cleared when no backing
 * CommunicationChannel Secret is resolvable.
 */
function preserveChannelReaderDeploymentAnnotations(
  desired: k8s.V1Deployment,
  existing: k8s.V1Deployment
): k8s.V1Deployment {
  const preserved = preserveDeploymentAnnotations(desired, existing)
  const desiredAnnotations = desired.spec?.template?.metadata?.annotations
  if (desiredAnnotations?.['clerum.io/credentials-revision'] !== undefined) return preserved

  const spec = preserved.spec
  const template = spec?.template
  if (!spec || !template) return preserved

  const annotations = { ...(template.metadata?.annotations ?? {}) }
  delete annotations['clerum.io/credentials-revision']
  return {
    ...preserved,
    spec: {
      ...spec,
      template: {
        ...template,
        metadata: {
          ...template.metadata,
          annotations: Object.keys(annotations).length > 0 ? annotations : undefined,
        },
      },
    },
  }
}

function normalizeDeploymentForComparison(deployment: k8s.V1Deployment): unknown {
  const normalized = structuredClone(deployment)
  delete normalized.status
  delete normalized.metadata?.resourceVersion
  delete normalized.metadata?.uid
  delete normalized.metadata?.generation
  delete normalized.metadata?.creationTimestamp
  delete normalized.metadata?.managedFields
  delete normalized.metadata?.selfLink

  const spec = normalized.spec
  if (spec) {
    if (spec.progressDeadlineSeconds === 600) delete spec.progressDeadlineSeconds
    if (spec.revisionHistoryLimit === 10) delete spec.revisionHistoryLimit
    if (spec.minReadySeconds === 0) delete spec.minReadySeconds
    if (spec.paused === false) delete spec.paused
    if (
      spec.strategy?.type === 'RollingUpdate' &&
      spec.strategy.rollingUpdate?.maxSurge === '25%' &&
      spec.strategy.rollingUpdate.maxUnavailable === '25%'
    ) {
      delete spec.strategy
    }
    const template = spec.template
    if (template) {
      delete template.metadata?.creationTimestamp

      const podSpec = template.spec
      if (podSpec) {
        if (podSpec.restartPolicy === 'Always') delete podSpec.restartPolicy
        if (podSpec.dnsPolicy === 'ClusterFirst') delete podSpec.dnsPolicy
        if (podSpec.schedulerName === 'default-scheduler') delete podSpec.schedulerName
        if (podSpec.terminationGracePeriodSeconds === 30)
          delete podSpec.terminationGracePeriodSeconds
        if (podSpec.enableServiceLinks === true) delete podSpec.enableServiceLinks
        if (podSpec.preemptionPolicy === 'PreemptLowerPriority') delete podSpec.preemptionPolicy
        if (podSpec.serviceAccount === podSpec.serviceAccountName) delete podSpec.serviceAccount
        if (Object.keys(podSpec.securityContext ?? {}).length === 0) delete podSpec.securityContext
        for (const container of [
          ...(podSpec.initContainers ?? []),
          ...(podSpec.containers ?? []),
        ]) {
          normalizeContainerDefaults(container)
        }
        for (const volume of podSpec.volumes ?? []) normalizeVolumeDefaults(volume)
      }
    }
  }

  return normalizeDeploymentValue(normalized)
}

function normalizeContainerDefaults(container: k8s.V1Container): void {
  if (container.terminationMessagePath === '/dev/termination-log') {
    delete container.terminationMessagePath
  }
  if (container.terminationMessagePolicy === 'File') delete container.terminationMessagePolicy
  for (const probe of [container.startupProbe, container.livenessProbe, container.readinessProbe]) {
    if (!probe) continue
    if (probe.initialDelaySeconds === 0) delete probe.initialDelaySeconds
    if (probe.successThreshold === 1) delete probe.successThreshold
    if (probe.httpGet?.scheme === 'HTTP') delete probe.httpGet.scheme
  }
  for (const env of container.env ?? []) {
    if (env.valueFrom?.fieldRef?.apiVersion === 'v1') {
      delete env.valueFrom.fieldRef.apiVersion
    }
  }
}

function normalizeVolumeDefaults(volume: k8s.V1Volume): void {
  if (volume.secret?.defaultMode === 420) delete volume.secret.defaultMode
  if (volume.secret?.optional === false) delete volume.secret.optional
  if (volume.configMap?.defaultMode === 420) delete volume.configMap.defaultMode
  if (volume.configMap?.optional === false) delete volume.configMap.optional
  if (volume.downwardAPI?.defaultMode === 420) delete volume.downwardAPI.defaultMode
  if (volume.projected?.defaultMode === 420) delete volume.projected.defaultMode
  if (volume.persistentVolumeClaim?.readOnly === false) {
    delete volume.persistentVolumeClaim.readOnly
  }
}

function normalizeDeploymentValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeDeploymentValue)
  if (!isDeploymentObject(value)) return value

  const normalized: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const entry = value[key]
    if (entry !== undefined) normalized[key] = normalizeDeploymentValue(entry)
  }
  return normalized
}

function isDeploymentObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
