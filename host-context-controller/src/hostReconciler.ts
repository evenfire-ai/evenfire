import * as k8s from '@kubernetes/client-node'
import { IntOrString } from '@kubernetes/client-node/dist/types.js'
import { createHash } from 'crypto'
import * as path from 'path'
import { config } from './config'
import { HOST_LABEL, MANAGED_BY_LABEL, MANAGED_BY_VALUE } from './constants'
import { mintHostGfsToken } from './gfsHostBinding'
import {
  SFS_LABEL,
  SFS_NAMESPACE_LABEL,
  WFC_APP_LABEL,
  sharedFileSystemHash,
} from './k8s/sharedFileSystemFactory'
import { hccLogger } from './logger'
import { issueMcpHostRuntimeTokens } from './mcpHostRuntimeTokenIssuerClient'
import {
  MCP_HOST_GFS_TOKEN_SECRET_KEY,
  MCP_HOST_RUNTIME_TOKEN_SECRET_ACCESS_KEY,
  MCP_HOST_RUNTIME_TOKEN_SECRET_CONTROL_KEY,
  MCP_HOST_RUNTIME_TOKEN_SECRET_REFRESH_KEY,
  buildMcpHostRuntimeTokenSecret,
  mcpHostRuntimeTokenSecretName,
} from './secretFactory'
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
 * Resolve the workflow-control scopes to mint into a Host's mcp-host control
 * token.
 *
 * A Host CR is always a FIRST-PARTY host (the mcp-host/standalone sentinel
 * binding) — third-party WorkflowRecipe coordinators are issued tokens through
 * a separate path, not this reconciler — so when a Host omits the
 * `workflowControl` block (or omits `scopes` within it) we default to the full
 * first-party scope set. Previously this was `?? []`, which silently minted a
 * scope-less, unusable control token for any Host created without the block
 * (e.g. via the Control UI): control-api then 403s `insufficient_scope` on the
 * provider-identity resolve, and mcp-host fail-closes channel workflow access on
 * every Telegram/Slack message.
 *
 * An EXPLICIT `scopes` array is honored exactly as declared — including an
 * explicit empty `[]`, which is an intentional opt-out from workflow access.
 */
export function resolveWorkflowControlScopes(
  workflowControl: HostWorkflowControlSpec | undefined
): HostWorkflowControlScope[] {
  if (!workflowControl || workflowControl.scopes === undefined) {
    return [...DEFAULT_FIRST_PARTY_WORKFLOW_CONTROL_SCOPES]
  }
  return workflowControl.scopes
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
const RUNTIME_TOKEN_HOST_BINDING_HASH_ANNOTATION = 'clerum.io/runtime-token-host-binding-hash'
const RUNTIME_TOKEN_SCOPE_HASH_ANNOTATION = 'clerum.io/runtime-token-scope-hash'
const RUNTIME_TOKEN_ISSUER_ANNOTATION = 'clerum.io/runtime-token-issuer'
const RUNTIME_TOKEN_AUDIENCE_ANNOTATION = 'clerum.io/runtime-token-audience'
const RUNTIME_TOKEN_SCHEMA_VERSION_ANNOTATION = 'clerum.io/runtime-token-schema-version'
const RUNTIME_TOKEN_ISSUER = 'control-api'
const RUNTIME_TOKEN_AUDIENCE = 'workflow-approvals'
const RUNTIME_TOKEN_SCHEMA_VERSION = '1'
// Deployments affected by the historical stringData/data hashing bug can carry
// the empty-payload revision. Roll them once so the pod template converges to
// the normalized persisted Secret revision.
const LEGACY_EMPTY_RUNTIME_TOKEN_REVISION = createHash('sha256')
  .update(JSON.stringify([]))
  .digest('hex')
const WORKFLOW_TOKEN_MOUNT_PATH = '/var/run/clerum/workflow-tokens'
const MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE_PATH = `${WORKFLOW_TOKEN_MOUNT_PATH}/${MCP_HOST_RUNTIME_TOKEN_SECRET_CONTROL_KEY}`
const MCP_HOST_RUNTIME_AUTH_STATE_PATH = '/var/run/clerum/workflow-auth'
const log = hccLogger.child({ module: 'host-reconciler' })

function throwCleanupFailures(failures: unknown[], message: string): void {
  if (failures.length > 0) {
    throw new AggregateError(failures, message)
  }
}

type HostReconcilerDeps = {
  appsApi?: k8s.AppsV1Api
  coreApi?: k8s.CoreV1Api
  networkingApi?: k8s.NetworkingV1Api
  rbacApi?: k8s.RbacAuthorizationV1Api
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
}

type HostSecretValidationResult =
  | { ok: true }
  | { ok: false; reason: 'SecretNotFound' | 'SecretAccessDenied' | 'ReadError'; message: string }

export class HostReconciler {
  private readonly appsApi: k8s.AppsV1Api
  private readonly coreApi: k8s.CoreV1Api
  private readonly networkingApi: k8s.NetworkingV1Api
  private readonly rbacApi: k8s.RbacAuthorizationV1Api
  private readonly statusMap: Map<string, HostRuntimeStatus> = new Map()
  private readonly readinessTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private resolveContextMounts: ResolveContextMountsFn
  private countCommunicationChannels: (hostName: string) => number
  private findCommunicationChannelsByHostRef: (host: string) => CommunicationChannelCRD[]
  private findCommunicationChannelsByCredentialsSecretName: (
    name: string
  ) => CommunicationChannelCRD[]
  // B2: whether the CC cache initial-list has completed. Defaults to false
  // (safe: preserves existing Deployment replicas until wired by McpServerWatcher).
  private ccCacheSyncedFn: () => boolean = () => false

  constructor(kc: k8s.KubeConfig, deps?: HostReconcilerDeps) {
    this.appsApi = deps?.appsApi || kc.makeApiClient(k8s.AppsV1Api)
    this.coreApi = deps?.coreApi || kc.makeApiClient(k8s.CoreV1Api)
    this.networkingApi = deps?.networkingApi || kc.makeApiClient(k8s.NetworkingV1Api)
    this.rbacApi = deps?.rbacApi || kc.makeApiClient(k8s.RbacAuthorizationV1Api)
    this.resolveContextMounts = deps?.resolveContextMounts ?? (async () => [])
    this.countCommunicationChannels = deps?.countCommunicationChannels ?? (() => 0)
    this.findCommunicationChannelsByHostRef = deps?.findCommunicationChannelsByHostRef ?? (() => [])
    this.findCommunicationChannelsByCredentialsSecretName =
      deps?.findCommunicationChannelsByCredentialsSecretName ?? (() => [])
    if (deps?.isCommunicationChannelCacheSynced) {
      this.ccCacheSyncedFn = deps.isCommunicationChannelCacheSynced
    }
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
          apiGroups: [''],
          resources: ['configmaps'],
          resourceNames: [`host-${host.name}-env`],
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

  private static runtimeTokenScopeHash(host: HostCRD): string {
    // Hash the EFFECTIVE (resolved) scopes — what actually gets minted into the
    // control token — so change-detection matches the default-fallback applied
    // at issuance (otherwise a null workflowControl hashes as [] while the token
    // carries the first-party defaults, and the two drift).
    return HostReconciler.shortHash(
      [...resolveWorkflowControlScopes(host.spec.workflowControl)].sort()
    )
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
    gfsTokenTtlSec: number
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
      [RUNTIME_TOKEN_SCOPE_HASH_ANNOTATION]: HostReconciler.runtimeTokenScopeHash(host),
      [RUNTIME_TOKEN_ISSUER_ANNOTATION]: RUNTIME_TOKEN_ISSUER,
      [RUNTIME_TOKEN_AUDIENCE_ANNOTATION]: RUNTIME_TOKEN_AUDIENCE,
      [RUNTIME_TOKEN_SCHEMA_VERSION_ANNOTATION]: RUNTIME_TOKEN_SCHEMA_VERSION,
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
    nowMs: number
  ): { refresh: boolean; rolloutRequired: boolean; reason: string } {
    const data = HostReconciler.runtimeTokenSecretData(secret)
    if (!data) return { refresh: true, rolloutRequired: false, reason: 'malformed_secret' }

    const annotations = secret.metadata?.annotations ?? {}
    const expectedHostBindingHash = HostReconciler.runtimeTokenHostBindingHash(host)
    const expectedScopeHash = HostReconciler.runtimeTokenScopeHash(host)
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

    const refreshBefore = Date.parse(annotations[RUNTIME_TOKEN_REFRESH_BEFORE_ANNOTATION] ?? '')
    if (!Number.isFinite(refreshBefore)) {
      return { refresh: true, rolloutRequired: false, reason: 'missing_refresh_metadata' }
    }
    if (nowMs >= refreshBefore) {
      return { refresh: true, rolloutRequired: false, reason: 'refresh_before_reached' }
    }
    const gfsRefreshBefore = Date.parse(annotations[GFS_TOKEN_REFRESH_BEFORE_ANNOTATION] ?? '')
    if (!Number.isFinite(gfsRefreshBefore)) {
      return { refresh: true, rolloutRequired: false, reason: 'missing_gfs_refresh_metadata' }
    }
    if (nowMs >= gfsRefreshBefore) {
      return { refresh: true, rolloutRequired: false, reason: 'gfs_refresh_before_reached' }
    }
    return { refresh: false, rolloutRequired: false, reason: 'current' }
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

  private async ensureMcpHostRuntimeTokenSecret(host: HostCRD): Promise<string> {
    let lastErr: unknown = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
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
        const nowMs = Date.now()
        let decision = existing
          ? HostReconciler.runtimeTokenRefreshDecision(host, existing, nowMs)
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

        if (existing && existingRevision && !decision.refresh) {
          return HostReconciler.shouldRollForRuntimeSecret(deployment, false)
            ? existingRevision
            : HostReconciler.deploymentRuntimeTokenRevision(deployment) || existingRevision
        }

        if (
          existing &&
          existingRevision &&
          decision.reason === 'refresh_before_reached' &&
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
          return HostReconciler.deploymentRuntimeTokenRevision(deployment) || existingRevision
        }

        const tokens = await issueMcpHostRuntimeTokens(
          host.name,
          resolveWorkflowControlScopes(host.spec.workflowControl)
        )
        const gfs = await mintHostGfsToken()
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
        body.metadata = {
          ...body.metadata,
          annotations: {
            ...(body.metadata?.annotations ?? {}),
            ...HostReconciler.runtimeTokenSecretAnnotations(
              host,
              tokens,
              revision,
              nowMs,
              gfs.expiresInSeconds
            ),
          },
        }

        if (!existing) {
          await this.coreApi.createNamespacedSecret({ namespace: host.namespace, body })
          log.info('created mcp-host-runtime-token Secret', {
            host: host.name,
            namespace: host.namespace,
            resourceName: name,
            reason: decision.reason,
          })
          return revision
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
        log.info('rotated mcp-host-runtime-token Secret', {
          host: host.name,
          namespace: host.namespace,
          resourceName: name,
          reason: decision.reason,
          rolloutRequired: HostReconciler.shouldRollForRuntimeSecret(
            deployment,
            decision.rolloutRequired
          ),
        })
        return HostReconciler.shouldRollForRuntimeSecret(deployment, decision.rolloutRequired)
          ? revision
          : HostReconciler.deploymentRuntimeTokenRevision(deployment) || revision
      } catch (err) {
        lastErr = err
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
    const timer = this.readinessTimers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.readinessTimers.delete(name)
    }
  }

  private pvcName(host: HostCRD): string {
    return `${host.name}-workspace`
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
        return
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
   * - On 409 from create, reads the existing Deployment, copies its
   *   resourceVersion, and replaces — UNLESS the existing Deployment is
   *   owned by a different host (clerum.io/host label mismatch), in which
   *   case skip and log.
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
        return
      }
      let existing: k8s.V1Deployment
      try {
        existing = await this.appsApi.readNamespacedDeployment({ name, namespace: ns })
      } catch (readErr) {
        console.error(`[HostReconciler] Failed to read channel-reader "${name}":`, readErr)
        return
      }
      const ownerHost = existing.metadata?.labels?.[HOST_LABEL]
      if (ownerHost && ownerHost !== host.name) {
        console.warn(
          `[HostReconciler] channel-reader "${name}" owned by host="${ownerHost}", skipping`
        )
        return
      }
      // B2: Rebuild with existingReplicas so the B2 gate in
      // buildChannelReaderDeployment can preserve the live replica count when
      // the CC cache is not yet synced (avoids scale-down during HCC restart).
      const existingReplicas = existing.spec?.replicas
      const desiredWithPreserve = this.buildChannelReaderDeployment(
        host,
        revision,
        existingReplicas
      )
      desiredWithPreserve.metadata!.resourceVersion = existing.metadata?.resourceVersion
      try {
        await this.appsApi.replaceNamespacedDeployment({
          name,
          namespace: ns,
          body: desiredWithPreserve,
        })
        console.log(`[HostReconciler] Updated channel-reader Deployment "${name}"`)
      } catch (replaceErr) {
        console.error(`[HostReconciler] Failed to update channel-reader "${name}":`, replaceErr)
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
    for (const hostName of affectedHosts) {
      await this.patchChannelReaderRevisionAnnotation(hostName)
    }
  }

  buildDeployment(
    host: HostCRD,
    mounts: ResolvedSfsMount[] = [],
    runtimeTokenRevision = ''
  ): k8s.V1Deployment {
    const labels: Record<string, string> = {
      app: host.name,
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      [HOST_LABEL]: host.name,
      [CONTEXT_LABEL]: host.spec.contextRef,
    }

    const isDesktop = !!(host.spec.desktop?.browser || host.spec.desktop?.x11)
    const image = isDesktop ? config.desktopImage : config.hostImage
    const resources = isDesktop ? config.desktopResources : config.hostResources

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

    // Startup probe — desktop image needs longer initial delay for s6 boot + XFCE + mcp-host launch
    const startupProbe = {
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
        replicas: 1,
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
            imagePullSecrets: config.hostImagePullSecretName
              ? [{ name: config.hostImagePullSecretName }]
              : undefined,
            containers: [
              {
                name: 'mcp-host',
                image,
                imagePullPolicy: config.hostImagePullPolicy,
                ports,
                envFrom: [{ configMapRef: { name: config.hostConfigMapName } }],
                env,
                volumeMounts: [
                  { name: 'workspace', mountPath: workspacePath },
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
                  initialDelaySeconds: 20,
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
    runtimeTokenRevision: string
  ): Promise<void> {
    const deployment = this.buildDeployment(host, mounts, runtimeTokenRevision)
    try {
      await this.appsApi.createNamespacedDeployment({
        namespace: host.namespace,
        body: deployment,
      })
      console.log(`[HostReconciler] Created Deployment "${host.name}"`)
    } catch (error) {
      if (getErrorCode(error) !== 409) {
        console.error(`[HostReconciler] Failed to create Deployment "${host.name}":`, error)
        return
      }
      try {
        await replaceWithConflictRetry({
          description: `Deployment "${host.name}"`,
          logPrefix: '[HostReconciler]',
          body: deployment,
          mergeExisting: preserveDeploymentAnnotations,
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

  async reconcile(host: HostCRD): Promise<void> {
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
      return
    }

    // Per-Host SA + Role + RoleBinding must exist BEFORE the Deployment,
    // otherwise the kubelet can't mount the SA token and the pod will
    // crash-loop until RBAC is created.
    await this.ensureHostServiceAccount(host)
    await this.ensureHostRole(host)
    await this.ensureHostRoleBinding(host)

    // Provision the mcp-host-runtime-token Secret BEFORE the Deployment so the
    // kubelet can mount it on first start. Issuance is fail-fast: 3-attempt
    // backoff, then the error is surfaced and the reconcile aborts.
    let runtimeTokenRevision = ''
    try {
      runtimeTokenRevision = await this.ensureMcpHostRuntimeTokenSecret(host)
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
      return
    }
    await this.ensurePvc(host)
    await this.ensureService(host)
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

    await this.ensureDeployment(host, mounts, runtimeTokenRevision)

    const ready = await this.checkDeploymentReady(host.name, host.namespace)
    // If any per-Host NP failed to apply, mark the host as degraded:
    // deployed remains true (the pod is in place), but ready=false +
    // a message that names the missing security boundary. Operators see
    // this in `kubectl get host ... -o yaml` under status.runtime.message.
    const baseMessage = ready ? 'Running' : 'Deployment created, waiting for pods to become ready'
    const message = npFailures.length
      ? `degraded — NetworkPolicy boundary missing (${npFailures.join('; ')})`
      : baseMessage
    this.setStatus(host.name, {
      deployed: true,
      ready: ready && npFailures.length === 0,
      message,
    })
    if (!ready) {
      this.pollReadiness(host.name, host.namespace)
    }

    // Materialize the per-Host channel-reader Deployment. The egress NP that
    // pins this pod to mcp-host has already been applied above. Failures
    // here do NOT block the mcp-host pod; they're surfaced via
    // HostRuntimeStatus.message.
    //
    // computeChannelReaderRevisionForHost re-throws on Secret read errors
    // other than 404 (RBAC drift, 503, etc.), so this catch handles a real
    // expected error path — not just defense in depth.
    let channelReaderError: string | undefined
    try {
      await this.reconcileChannelReaderService(host)
      await this.reconcileChannelReaderDeployment(host)
    } catch (err) {
      console.error(
        `[HostReconciler] reconcileChannelReaderDeployment failed for "${host.name}":`,
        err
      )
      channelReaderError = (err as Error).message
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
    if (channelReaderError) {
      // Overlay the reconcile error onto the status message so both signals
      // are visible (the deploy error may explain why the Deployment is missing).
      channelReaderStatus.message = `reconcile error: ${channelReaderError}`
      channelReaderStatus.ready = false
    }
    const prev = this.getStatus(host.name)
    this.setStatus(host.name, { ...prev, channelReader: channelReaderStatus })
  }

  async reconcileDelete(name: string, namespace: string): Promise<void> {
    await this.deleteHostRuntimeResources(name, namespace)
    this.clearStatus(name)
    this.desktopHosts.delete(name)
  }

  async fullReconcile(desiredHosts: HostCRD[]): Promise<void> {
    for (const host of desiredHosts) {
      await this.reconcile(host)
    }

    const existingDeployments = await this.listManagedHostDeployments()
    const desiredNames = new Set(desiredHosts.map(h => h.name))
    for (const deployment of existingDeployments) {
      const name = deployment.metadata?.name || ''
      const namespace = deployment.metadata?.namespace || config.hostNamespace
      if (!desiredNames.has(name)) {
        await this.deleteHostRuntimeResources(name, namespace)
      }
    }

    const knownHostNames = desiredHosts.map(h => h.name)
    await this.sweepOrphanChannelReaderResources(knownHostNames)
    await this.sweepOrphanHostNetworkPolicies(knownHostNames)
  }

  private async listManagedHostDeployments(): Promise<k8s.V1Deployment[]> {
    try {
      const response = await this.appsApi.listNamespacedDeployment({
        namespace: config.hostNamespace,
        labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
      })
      return (response.items || []).filter(item => item.metadata?.labels?.[HOST_LABEL])
    } catch (error) {
      console.error('[HostReconciler] Failed to list managed host deployments:', error)
      return []
    }
  }

  /**
   * Sweep orphan channel-reader resources from the channels namespace.
   * Lists Deployments and Secrets carrying our management labels, then
   * deletes those whose clerum.io/host label points at a Host that no
   * longer exists. Catches CRDs deleted while HCC was down (UI cascade
   * may have been skipped or interrupted).
   */
  private async sweepOrphanChannelReaderResources(knownHosts: string[]): Promise<void> {
    const known = new Set(knownHosts)
    const ns = config.channelsNamespace

    // Deployment sweep
    try {
      const list = await this.appsApi.listNamespacedDeployment({ namespace: ns })
      for (const dep of list.items ?? []) {
        const labels = dep.metadata?.labels ?? {}
        if (labels.app !== 'channel-reader') continue
        if (labels[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE) continue
        const host = labels[HOST_LABEL]
        if (!host || known.has(host)) continue
        const name = dep.metadata?.name
        if (!name) continue
        try {
          await this.appsApi.deleteNamespacedDeployment({
            name,
            namespace: ns,
          })
          console.log(`[HostReconciler] orphan sweep deleted Deployment ${name}`)
        } catch (err) {
          if (getErrorCode(err) !== 404) {
            console.warn(`[HostReconciler] orphan Deployment delete failed:`, err)
          }
        }
      }
    } catch (err) {
      console.warn('[HostReconciler] orphan Deployment sweep list failed:', err)
    }

    // Service sweep
    try {
      const list = await this.coreApi.listNamespacedService({ namespace: ns })
      for (const svc of list.items ?? []) {
        const labels = svc.metadata?.labels ?? {}
        if (labels.app !== 'channel-reader') continue
        if (labels[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE) continue
        const host = labels[HOST_LABEL]
        if (!host || known.has(host)) continue
        const name = svc.metadata?.name
        if (!name) continue
        try {
          await this.coreApi.deleteNamespacedService({
            name,
            namespace: ns,
          })
          console.log(`[HostReconciler] orphan sweep deleted Service ${name}`)
        } catch (err) {
          if (getErrorCode(err) !== 404) {
            console.warn(`[HostReconciler] orphan Service delete failed:`, err)
          }
        }
      }
    } catch (err) {
      console.warn('[HostReconciler] orphan Service sweep list failed:', err)
    }

    // Secret sweep — server-side label filter limits the list response to
    // Secrets HCC created. The channels-namespace Role grants `secrets: delete`
    // broadly because K8s RBAC has no resourceName wildcards, but the actual
    // operation here only ever sees managed Secrets, and the in-loop label
    // guard below is a defense-in-depth check against any future code path
    // that drops the labelSelector.
    const sweepLabelSelector = [
      `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
      'clerum.io/component=channel-reader',
    ].join(',')
    try {
      const list = await this.coreApi.listNamespacedSecret({
        namespace: ns,
        labelSelector: sweepLabelSelector,
      })
      for (const sec of list.items ?? []) {
        const labels = sec.metadata?.labels ?? {}
        // Belt-and-suspenders: re-verify the managed-by + component labels
        // even though the labelSelector should already have filtered them.
        // If a future bug drops the selector, this prevents an unscoped
        // delete sweep across the channels namespace.
        if (labels[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE) continue
        if (labels['clerum.io/component'] !== 'channel-reader') continue
        const host = labels[HOST_LABEL]
        if (!host || known.has(host)) continue
        const name = sec.metadata?.name
        if (!name) continue
        try {
          await this.coreApi.deleteNamespacedSecret({
            name,
            namespace: ns,
          })
          // Structured audit line — every Secret deletion HCC performs.
          // Operators tail this to monitor unexpected deletes.
          console.log(
            `[HostReconciler] AUDIT: orphan sweep deleted Secret name=${name} ns=${ns} host=${host}`
          )
        } catch (err) {
          if (getErrorCode(err) !== 404) {
            console.warn(`[HostReconciler] orphan Secret delete failed:`, err)
          }
        }
      }
    } catch (err) {
      console.warn('[HostReconciler] orphan Secret sweep list failed:', err)
    }
  }

  /**
   * Sweep orphan per-Host NetworkPolicies in both `channels` and `mcp-host`
   * namespaces. Lists NPs carrying our managed-by label, deletes those whose
   * clerum.io/host points at a Host that no longer exists.
   *
   * Filter is `clerum.io/managed-by=host-context-controller` — leaves the
   * static base policies (no managed-by label) untouched.
   */
  private async sweepOrphanHostNetworkPolicies(knownHosts: string[]): Promise<void> {
    const known = new Set(knownHosts)
    for (const ns of [config.channelsNamespace, config.hostNamespace, config.rpcProxyNamespace]) {
      try {
        const list = await this.networkingApi.listNamespacedNetworkPolicy({
          namespace: ns,
          labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
        })
        for (const np of list.items ?? []) {
          const labels = np.metadata?.labels ?? {}
          const host = labels[HOST_LABEL]
          if (!host || known.has(host)) continue
          const name = np.metadata?.name
          if (!name) continue
          try {
            await this.networkingApi.deleteNamespacedNetworkPolicy({ name, namespace: ns })
            console.log(`[HostReconciler] orphan sweep deleted NetworkPolicy ${name} in ${ns}`)
          } catch (err) {
            if (getErrorCode(err) !== 404) {
              console.warn(`[HostReconciler] orphan NP delete failed:`, err)
            }
          }
        }
      } catch (err) {
        console.warn(`[HostReconciler] orphan NP sweep list failed in ${ns}:`, err)
      }
    }
  }
}

function canonicalStringify(obj: Record<string, unknown>): string {
  const sorted = Object.keys(obj).sort()
  return JSON.stringify(sorted.map(k => [k, obj[k]]))
}
