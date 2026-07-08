/**
 * Pure builder functions for the per-SharedFileSystem resources HCC reconciles.
 *
 * Each builder takes a SharedFileSystemCRD plus a SharedFileSystemFactoryConfig
 * and returns a Kubernetes manifest. Builders never touch the cluster — that's
 * the reconciler's job. Keeping them pure makes the cross-product of
 * SharedFileSystemSpec options easy to unit-test.
 *
 * Resource naming (per docs/features/context-filesystem.md):
 *   PVC:           sfs-<hash>-files
 *   Legacy init Job (reaped): wfc-init-<hash>-*  (seeding is now the wfc initContainer)
 *   Deployment:    wfc-<hash>
 *   Service:       wfc-<hash>
 *   NetworkPolicy: wfc-<hash>-ingress, wfc-<hash>-egress
 *
 * The hash is the first 10 chars of sha256("<namespace>/<name>") of the
 * SharedFileSystem. SharedFileSystems always live in mcp-host in v1; the
 * namespace component keeps the hash forward-compatible if cross-namespace
 * SharedFileSystems ever land.
 */
import * as k8s from '@kubernetes/client-node'
import type { IntOrString } from '@kubernetes/client-node/dist/types.js'
import * as crypto from 'crypto'
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE } from '../constants'
import type { SharedFileSystemCRD, SharedFileSystemSpec } from '../types'

export const SFS_LABEL = 'clerum.io/sharedfilesystem'
export const SFS_NAMESPACE_LABEL = 'clerum.io/sharedfilesystem-namespace'
export const WFC_APP_LABEL = 'workspace-files-controller'
export const WFC_POLICY_TYPE = 'workspace-files'

/** Defaults applied when SharedFileSystemSpec leaves a field empty. */
export const DEFAULT_SFS_SIZE = '20Gi'
// #592: default to ReadWriteOnce. The wfc is single-replica and seeds the PVC
// via a root initContainer in the SAME pod, and consumer mcp-host pods co-locate
// with it via podAffinity, so RWO works on the RWO-only StorageClasses we run.
// Multi-node shared (ReadWriteMany) needs an RWX-capable StorageClass
// (NFS/Filestore/GCS-FUSE) and is deferred — set spec.accessModes explicitly
// when such a class exists.
export const DEFAULT_SFS_ACCESS_MODES: ReadonlyArray<string> = ['ReadWriteOnce']
export const DEFAULT_INIT_IMAGE = 'busybox:1.36'
export const DEFAULT_WFC_PORT = 8086
export const DEFAULT_RUN_AS_UID = 1000
export const DEFAULT_RUN_AS_GID = 1000
/** Canonical mount path inside the wfc container — wfc is per-SFS so one mount path. */
export const WFC_MOUNT_PATH = '/workspace'
/** Mirrors the SharedFileSystem CRD validation for spec.directories[] entries. */
export const SFS_DIRECTORY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/
/** Bounds mirrored by the CRD schema (maxItems / maxLength) — defense in depth. */
export const MAX_SFS_DIRECTORIES = 64
export const MAX_SFS_DIRECTORY_LENGTH = 255

export interface SharedFileSystemFactoryConfig {
  /** Namespace where mcp-host pods (and therefore the SharedFileSystem PVC) live. */
  hostNamespace: string
  /** Namespace where control-api lives (used to scope the ingress NetworkPolicy). */
  controlPlaneNamespace: string
  /** Image for the workspace-files-controller container. */
  wfcImage: string
  /** Image pull policy for the wfc image. */
  wfcImagePullPolicy: 'Always' | 'IfNotPresent' | 'Never'
  /** Optional image-pull secret name applied to the wfc pod (including its seeding init container). */
  wfcImagePullSecretName?: string
  /** Container port the wfc HTTP server listens on. */
  wfcPort: number
  /** Image used by the init container to lay out directories + ownership. */
  wfcInitImage: string
  /** Resource requests/limits for the wfc container. */
  wfcResources: {
    requests: { memory: string; cpu: string }
    limits: { memory: string; cpu: string }
  }
  /** ConfigMap that exposes the JWT public key under {@link wfcJwtPublicKeyConfigMapKey}. */
  wfcJwtPublicKeyConfigMapName: string
  /** Key inside the ConfigMap that holds the PEM-encoded RSA public key. */
  wfcJwtPublicKeyConfigMapKey: string
  /** Per-file upload cap (bytes), forwarded as WSF_MAX_UPLOAD_BYTES. */
  wfcMaxUploadBytes: number
  /** Max entries per directory listing, forwarded as WSF_MAX_LIST_ENTRIES. */
  wfcMaxListEntries: number
  /** Max path depth, forwarded as WSF_MAX_PATH_DEPTH. */
  wfcMaxPathDepth: number
}

/** Returns the short stable hash used in every per-SharedFileSystem resource name. */
export function sharedFileSystemHash(sfs: Pick<SharedFileSystemCRD, 'name' | 'namespace'>): string {
  return crypto
    .createHash('sha256')
    .update(`${sfs.namespace}/${sfs.name}`)
    .digest('hex')
    .slice(0, 10)
}

export function pvcName(sfs: Pick<SharedFileSystemCRD, 'name' | 'namespace'>): string {
  return `sfs-${sharedFileSystemHash(sfs)}-files`
}

export function wfcDeploymentName(sfs: Pick<SharedFileSystemCRD, 'name' | 'namespace'>): string {
  return `wfc-${sharedFileSystemHash(sfs)}`
}

export function wfcServiceName(sfs: Pick<SharedFileSystemCRD, 'name' | 'namespace'>): string {
  return wfcDeploymentName(sfs)
}

/**
 * Name prefix of the legacy per-SFS init Jobs (replaced by the controller's
 * initContainer). Used by the reconciler's cleanup to scope deletes to THIS
 * SFS's Jobs (paired with the `clerum.io/sharedfilesystem` label as a double
 * guard so a foreign Job sharing the label is never deleted).
 */
export function wfcInitJobNamePrefix(sfs: Pick<SharedFileSystemCRD, 'name' | 'namespace'>): string {
  return `wfc-init-${sharedFileSystemHash(sfs)}-`
}

export function wfcIngressPolicyName(sfs: Pick<SharedFileSystemCRD, 'name' | 'namespace'>): string {
  return `${wfcDeploymentName(sfs)}-ingress`
}

export function wfcEgressPolicyName(sfs: Pick<SharedFileSystemCRD, 'name' | 'namespace'>): string {
  return `${wfcDeploymentName(sfs)}-egress`
}

/** Returns the replica count for the wfc Deployment (always 1 in v1). */
export function wfcReplicas(_spec: SharedFileSystemSpec): number {
  return 1
}

function commonLabels(sfs: SharedFileSystemCRD): Record<string, string> {
  // v1 intentionally relies on reconcileDelete plus these labels for cleanup,
  // not Kubernetes ownerReferences. If HCC misses a delete event while down,
  // generated resources can persist until manual label-based cleanup runs.
  return {
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    [SFS_LABEL]: sfs.name,
    [SFS_NAMESPACE_LABEL]: sfs.namespace,
  }
}

function podSelectorLabels(sfs: SharedFileSystemCRD): Record<string, string> {
  return {
    app: WFC_APP_LABEL,
    [SFS_LABEL]: sfs.name,
    [SFS_NAMESPACE_LABEL]: sfs.namespace,
  }
}

function resolveAccessModes(spec: SharedFileSystemSpec): string[] {
  return spec.accessModes && spec.accessModes.length > 0
    ? [...spec.accessModes]
    : [...DEFAULT_SFS_ACCESS_MODES]
}

function resolveSize(spec: SharedFileSystemSpec): string {
  return spec.size && spec.size.length > 0 ? spec.size : DEFAULT_SFS_SIZE
}

function resolveSecurity(spec: SharedFileSystemSpec): {
  runAsUser: number
  runAsGroup: number
  fsGroup: number
} {
  const runAsUser = spec.security?.runAsUser ?? DEFAULT_RUN_AS_UID
  const runAsGroup = spec.security?.runAsGroup ?? DEFAULT_RUN_AS_GID
  const fsGroup = spec.security?.fsGroup ?? runAsGroup
  // Mirror the CRD `minimum: 1` server-side bound in code (defense in depth for
  // CLERUM_DEV_MODE / non-cluster paths that bypass API-server validation): the
  // serving container runs runAsNonRoot, so root identities must fail fast here.
  if (runAsUser < 1 || runAsGroup < 1 || fsGroup < 1) {
    throw new Error(
      'SharedFileSystem security runAsUser/runAsGroup/fsGroup must be >= 1 (root is not allowed)'
    )
  }
  return { runAsUser, runAsGroup, fsGroup }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function resolveDirectories(spec: SharedFileSystemSpec): string[] {
  const dirs = (spec.directories ?? []).filter(d => d.length > 0)
  if (dirs.length > MAX_SFS_DIRECTORIES) {
    throw new Error(
      `SharedFileSystem directories: ${dirs.length} entries exceeds the maximum of ${MAX_SFS_DIRECTORIES}`
    )
  }
  return dirs.map(d => {
    if (d.length > MAX_SFS_DIRECTORY_LENGTH) {
      throw new Error(
        `SharedFileSystem directory exceeds the maximum length of ${MAX_SFS_DIRECTORY_LENGTH} characters`
      )
    }
    if (!SFS_DIRECTORY_PATTERN.test(d)) {
      throw new Error(
        `SharedFileSystem directory "${d}" must be a relative path with alphanumeric, underscore, dot, and hyphen segments`
      )
    }
    return d
  })
}

/** Builds the SharedFileSystem PVC. */
export function buildPvc(
  sfs: SharedFileSystemCRD,
  config: SharedFileSystemFactoryConfig
): k8s.V1PersistentVolumeClaim {
  const annotations = sfs.spec.annotations ? { ...sfs.spec.annotations } : undefined

  const pvc: k8s.V1PersistentVolumeClaim = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: pvcName(sfs),
      namespace: config.hostNamespace,
      labels: commonLabels(sfs),
      annotations,
    },
    spec: {
      accessModes: resolveAccessModes(sfs.spec),
      resources: {
        requests: { storage: resolveSize(sfs.spec) },
      },
    },
  }

  if (sfs.spec.storageClassName !== undefined) {
    pvc.spec!.storageClassName = sfs.spec.storageClassName
  }

  return pvc
}

/**
 * Builds the seeding shell command run by the controller pod's root init
 * container (see {@link buildDeployment}). It lays out
 * {@link SharedFileSystemSpec.directories} and applies POSIX ownership.
 *
 * Because it runs as an initContainer it re-executes on every pod restart, so
 * the expensive recursive `chown` is guarded by a per-(uid:gid + directory-set)
 * sentinel: the O(n) walk runs once per identity-or-directory change, not on
 * every boot. `mkdir -p`
 * stays outside the guard (cheap, self-heals the directory layout). `chown -R`
 * is wrapped in `timeout` so a pathological large/slow mount CrashLoops visibly
 * instead of hanging the pod in `Init:0/1`.
 *
 * Only `spec.directories[]` reaches the shell; it is double-validated
 * (CRD `pattern` + {@link SFS_DIRECTORY_PATTERN}) and `shellQuote`d here.
 * `runAsUser`/`runAsGroup` are integers, not shell-interpolatable.
 */
export function buildSeedArgs(sfs: SharedFileSystemCRD): string {
  const sec = resolveSecurity(sfs.spec)
  const mountRoot = WFC_MOUNT_PATH
  const dirs = resolveDirectories(sfs.spec)
  const mkdirTargets =
    dirs.length === 0 ? [shellQuote(mountRoot)] : dirs.map(d => `${mountRoot}/${d}`).map(shellQuote)

  const mountRootQ = shellQuote(mountRoot)
  const sentinelQ = shellQuote(`${mountRoot}/.clerum-seeded`)
  // The sentinel CONTENT encodes uid:gid AND a hash of the directory set, so a
  // change to spec.security OR spec.directories re-triggers the recursive chown
  // exactly once (replicating the old generation-keyed init Job — otherwise a
  // newly-added directory, created root-owned by `mkdir -p`, would stay
  // unwritable by the non-root serving container). Plain restarts with an
  // unchanged spec skip the O(n) walk.
  // Canonicalise (dedup + sort) for the hash so reordering an identical
  // directory set does NOT change the sentinel (avoids a needless O(n) chown).
  // mkdirTargets above keep the original order.
  const dirHash = crypto
    .createHash('sha256')
    .update([...new Set(dirs)].sort().join('\n'))
    .digest('hex')
    .slice(0, 12)
  const wantQ = shellQuote(`${sec.runAsUser}:${sec.runAsGroup}:${dirHash}`)
  const mkdirCmd = `mkdir -p ${mkdirTargets.join(' ')}`
  const chownCmd = `timeout 300 chown -R ${sec.runAsUser}:${sec.runAsGroup} -- ${mountRootQ}`
  const chmodCmd = `chmod 0775 -- ${mountRootQ}`

  return [
    'set -e',
    mkdirCmd,
    `if [ "$(cat ${sentinelQ} 2>/dev/null || true)" != ${wantQ} ]; then ${chownCmd}; ${chmodCmd}; printf '%s' ${wantQ} > ${sentinelQ}; fi`,
  ].join('; ')
}

/** Builds the per-SharedFileSystem workspace-files-controller Deployment (one replica). */
export function buildDeployment(
  sfs: SharedFileSystemCRD,
  config: SharedFileSystemFactoryConfig
): k8s.V1Deployment {
  const sec = resolveSecurity(sfs.spec)
  const labels = commonLabels(sfs)
  const selector = podSelectorLabels(sfs)
  const port = config.wfcPort

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: wfcDeploymentName(sfs),
      namespace: config.hostNamespace,
      labels,
    },
    spec: {
      replicas: wfcReplicas(sfs.spec),
      strategy: {
        // RWX is fine with rolling, but RWO would deadlock — go with Recreate
        // so the auto-detected RWO path doesn't get stuck. Single replica
        // either way; a brief downtime on rollout is acceptable in v1.
        type: 'Recreate',
      },
      selector: { matchLabels: selector },
      template: {
        metadata: { labels: selector },
        spec: {
          automountServiceAccountToken: false,
          imagePullSecrets: config.wfcImagePullSecretName
            ? [{ name: config.wfcImagePullSecretName }]
            : undefined,
          securityContext: {
            runAsUser: sec.runAsUser,
            runAsGroup: sec.runAsGroup,
            runAsNonRoot: true,
            fsGroup: sec.fsGroup,
            // Skip the kubelet's recursive fsGroup ownership walk when the root
            // already matches — avoids a second O(n) pass on every mount on top
            // of the init container's own (sentinel-guarded) chown.
            fsGroupChangePolicy: 'OnRootMismatch',
            seccompProfile: { type: 'RuntimeDefault' },
          },
          // Seed + chown the PVC in the SAME pod as the controller. Same pod =>
          // same node => same RWO mount, by construction — no cross-node
          // Multi-Attach is possible (the bug this replaces). The kubelet runs
          // this to completion before the non-root serving container starts.
          initContainers: [
            {
              name: 'init',
              image: config.wfcInitImage,
              imagePullPolicy: 'IfNotPresent',
              command: ['sh', '-c'],
              args: [buildSeedArgs(sfs)],
              securityContext: {
                // Root + minimal caps to chown the freshly-mounted PVC root.
                // runAsNonRoot:false is container-scoped ONLY — it overrides the
                // pod-level runAsNonRoot:true for this init container without
                // weakening the serving container or the pod default.
                runAsUser: 0,
                runAsGroup: 0,
                runAsNonRoot: false,
                allowPrivilegeEscalation: false,
                privileged: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'], add: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'] },
                seccompProfile: { type: 'RuntimeDefault' },
              },
              volumeMounts: [{ name: 'workspace', mountPath: WFC_MOUNT_PATH }],
            },
          ],
          containers: [
            {
              name: 'workspace-files-controller',
              image: config.wfcImage,
              imagePullPolicy: config.wfcImagePullPolicy,
              ports: [{ name: 'http', containerPort: port, protocol: 'TCP' }],
              env: [
                { name: 'WSF_PORT', value: String(port) },
                { name: 'WSF_MOUNT_PATH', value: WFC_MOUNT_PATH },
                { name: 'WSF_SHARED_FILESYSTEM_NAME', value: sfs.name },
                { name: 'WSF_SHARED_FILESYSTEM_NAMESPACE', value: sfs.namespace },
                {
                  name: 'WSF_JWT_PUBLIC_KEY',
                  valueFrom: {
                    configMapKeyRef: {
                      name: config.wfcJwtPublicKeyConfigMapName,
                      key: config.wfcJwtPublicKeyConfigMapKey,
                    },
                  },
                },
                { name: 'WSF_MAX_UPLOAD_BYTES', value: String(config.wfcMaxUploadBytes) },
                { name: 'WSF_MAX_LIST_ENTRIES', value: String(config.wfcMaxListEntries) },
                { name: 'WSF_MAX_PATH_DEPTH', value: String(config.wfcMaxPathDepth) },
              ],
              volumeMounts: [{ name: 'workspace', mountPath: WFC_MOUNT_PATH }],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              startupProbe: {
                httpGet: { path: '/readyz', port: 'http' as IntOrString },
                initialDelaySeconds: 2,
                periodSeconds: 2,
                timeoutSeconds: 1,
                failureThreshold: 30,
              },
              livenessProbe: {
                httpGet: { path: '/healthz', port: 'http' as IntOrString },
                initialDelaySeconds: 10,
                periodSeconds: 30,
                timeoutSeconds: 2,
                failureThreshold: 3,
              },
              readinessProbe: {
                httpGet: { path: '/readyz', port: 'http' as IntOrString },
                initialDelaySeconds: 2,
                periodSeconds: 5,
                timeoutSeconds: 2,
                failureThreshold: 3,
              },
              resources: {
                requests: { ...config.wfcResources.requests },
                limits: { ...config.wfcResources.limits },
              },
            },
          ],
          volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: pvcName(sfs) } }],
        },
      },
    },
  }
}

/** Builds the per-SharedFileSystem ClusterIP Service. */
export function buildService(
  sfs: SharedFileSystemCRD,
  config: SharedFileSystemFactoryConfig
): k8s.V1Service {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: wfcServiceName(sfs),
      namespace: config.hostNamespace,
      labels: commonLabels(sfs),
    },
    spec: {
      type: 'ClusterIP',
      selector: podSelectorLabels(sfs),
      ports: [
        {
          name: 'http',
          port: config.wfcPort,
          targetPort: 'http' as IntOrString,
          protocol: 'TCP',
        },
      ],
    },
  }
}

/**
 * Allow ingress on the wfc port from control-api pods only. Defense in depth:
 * the Service URL is cluster-internal, but pinning the source pod selector
 * means a compromised mcp-host pod still can't reach the writable side of
 * the workspace.
 */
export function buildIngressNetworkPolicy(
  sfs: SharedFileSystemCRD,
  config: SharedFileSystemFactoryConfig
): k8s.V1NetworkPolicy {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: wfcIngressPolicyName(sfs),
      namespace: config.hostNamespace,
      labels: {
        ...commonLabels(sfs),
        'clerum.io/policy-type': WFC_POLICY_TYPE,
      },
    },
    spec: {
      podSelector: { matchLabels: podSelectorLabels(sfs) },
      policyTypes: ['Ingress'],
      ingress: [
        {
          _from: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': config.controlPlaneNamespace },
              },
              podSelector: { matchLabels: { app: 'control-api' } },
            },
          ],
          ports: [{ port: config.wfcPort, protocol: 'TCP' }],
        },
      ],
    },
  }
}

/**
 * Egress: DNS only. The wfc has no business calling external services or
 * other cluster-internal pods — it only reads/writes a mounted PVC.
 */
export function buildEgressNetworkPolicy(
  sfs: SharedFileSystemCRD,
  config: SharedFileSystemFactoryConfig
): k8s.V1NetworkPolicy {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: wfcEgressPolicyName(sfs),
      namespace: config.hostNamespace,
      labels: {
        ...commonLabels(sfs),
        'clerum.io/policy-type': WFC_POLICY_TYPE,
      },
    },
    spec: {
      podSelector: { matchLabels: podSelectorLabels(sfs) },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
              },
              podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
            },
          ],
          ports: [
            { port: 53, protocol: 'UDP' },
            { port: 53, protocol: 'TCP' },
          ],
        },
      ],
    },
  }
}
