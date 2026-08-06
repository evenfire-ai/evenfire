/**
 * Pure builder functions for the cluster-wide Global File System (gfs) stack.
 *
 * Each builder takes a GlobalFileSystemCRD plus a GfsFactoryConfig and returns a
 * Kubernetes manifest. Builders never touch the cluster — that is the
 * reconciler's job. They are pure so the spec cross-product is easy to unit-test.
 *
 * This MIRRORS the SharedFileSystem factory's k8s-object SHAPE only; the gfs
 * SEMANTICS come from the gfs spec and differ deliberately:
 *   - TWO Deployments: a single RW writer + `readerReplicas` RO readers
 *     (SFS has one). Only gfsc mounts the volume; consumers use the HTTP broker.
 *   - Lives in the `gfs` namespace (SFS lives in mcp-host).
 *   - Egress = DNS + Postgres: gfsc re-checks the permission store on every op
 *     and fails closed if it is unreachable (SFS egress is DNS-only).
 *   - The writer's init container only PREPARES the opaque blob storage root
 *     (ownership). rootDirectories are materialized as gfs_resources rows by
 *     control-api (the governance plane owns the permission store), NOT here.
 *
 * Resource naming (singleton drive, fixed names so the Service URL is stable):
 *   PVC:           gfs-drive
 *   Deployments:   gfsc-writer, gfsc-reader
 *   Services:      gfsc, gfsc-writer
 *   NetworkPolicy: gfsc-ingress, gfsc-egress
 */
import * as k8s from '@kubernetes/client-node'
import type { IntOrString } from '@kubernetes/client-node/dist/types.js'
import { createHash } from 'node:crypto'
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE } from '../constants'
import type { GlobalFileSystemCRD, GlobalFileSystemSpec } from '../types'

export const GFS_LABEL = 'clerum.io/globalfilesystem'
export const GFS_APP_LABEL = 'gfs-controller'
export const GFS_POLICY_TYPE = 'gfs-controller'
export const GFS_TEMPLATE_HASH_ANNOTATION = 'clerum.io/gfsc-template-hash'

/** Defaults applied when GlobalFileSystemSpec leaves a field empty. */
export const DEFAULT_GFS_SIZE = '500Gi'
export const DEFAULT_GFS_ACCESS_MODES: ReadonlyArray<string> = ['ReadWriteOnce']
export const DEFAULT_GFS_STORAGE_CLASS = 'standard-rwo'
export const DEFAULT_INIT_IMAGE = 'busybox:1.36'
export const DEFAULT_GFSC_PORT = 8087
export const DEFAULT_READER_REPLICAS = 2
export const DEFAULT_RUN_AS_UID = 1000
export const DEFAULT_RUN_AS_GID = 1000
/** Canonical opaque blob-storage root inside the gfsc container. */
export const GFS_MOUNT_PATH = '/data/gfs'

export type GfscRole = 'writer' | 'reader'

export interface GfsFactoryConfig {
  /** Namespace the gfs stack lives in (the `gfs` namespace, NOT mcp-host). */
  gfsNamespace: string
  /** Namespace where control-api + the control-plane Postgres live. */
  controlPlaneNamespace: string
  /** Namespace where first-party mcp-host pods are provisioned. */
  firstPartyHostNamespace?: string
  /** Namespace where workflow recipe mcp-host pods are provisioned. */
  workflowRecipeNamespace?: string
  /** Pod label selector identifying the permission-store Postgres (egress target). */
  postgresPodLabels: Record<string, string>
  /** Postgres port (permission store). */
  postgresPort: number
  /** Image for the gfsc container. */
  gfscImage: string
  /** Image pull policy (reconciler-owned — never the CRD). */
  gfscImagePullPolicy: 'Always' | 'IfNotPresent' | 'Never'
  /** Optional image-pull secret applied to the gfsc pods + init container. */
  gfscImagePullSecretName?: string
  /** Optional PriorityClass for gfsc pods (must already exist in the cluster).
   * Reconciler-owned — never the CRD. Unset => no priorityClassName. */
  gfscPriorityClassName?: string
  /** Container port the gfsc HTTP server listens on. */
  gfscPort: number
  /** Image used by the writer's init container to prepare the storage prefix. */
  gfscInitImage: string
  /** Resource requests/limits for the gfsc container. */
  gfscResources: {
    requests: { memory: string; cpu: string }
    limits: { memory: string; cpu: string }
  }
  /** ConfigMap exposing the JWT public key gfsc verifies tokens with. */
  jwtPublicKeyConfigMapName: string
  jwtPublicKeyConfigMapKey: string
  /** Secret holding the permission-store connection string for the gfs_controller writer role. */
  pgSecretName: string
  pgSecretKey: string
  /** Secret holding the permission-store connection string for the gfs_controller_reader role. */
  readerPgSecretName: string
  readerPgSecretKey: string
  /** Drive name this gfsc serves (singleton 'main' in the core). */
  driveName: string
  /** Expected audience on inbound gfs access tokens. */
  tokenAudience: string
  /** Optional synchronous copy limits passed through verbatim to gfsc. */
  syncCopyMaxObjects?: string
  syncCopyMaxBytes?: string
  syncCopyTimeoutMs?: string
  /** Optional largest mutation body gfsc accepts (bytes), passed through to gfsc. */
  maxWriteBodyBytes?: string
  /** Optional kube-dns Service ClusterIP /32 for GKE NodeLocal DNS + Calico. */
  nodeLocalDnsCidr?: string
}

export function pvcName(_gfs: Pick<GlobalFileSystemCRD, 'name'>): string {
  return 'gfs-drive'
}

export function writerDeploymentName(_gfs: Pick<GlobalFileSystemCRD, 'name'>): string {
  return 'gfsc-writer'
}

export function readerDeploymentName(_gfs: Pick<GlobalFileSystemCRD, 'name'>): string {
  return 'gfsc-reader'
}

export function serviceName(_gfs: Pick<GlobalFileSystemCRD, 'name'>): string {
  return 'gfsc'
}

export function writerServiceName(_gfs: Pick<GlobalFileSystemCRD, 'name'>): string {
  return 'gfsc-writer'
}

export function ingressPolicyName(_gfs: Pick<GlobalFileSystemCRD, 'name'>): string {
  return 'gfsc-ingress'
}

export function egressPolicyName(_gfs: Pick<GlobalFileSystemCRD, 'name'>): string {
  return 'gfsc-egress'
}

export function serviceUrl(
  gfs: Pick<GlobalFileSystemCRD, 'name'>,
  config: GfsFactoryConfig
): string {
  return `http://${serviceName(gfs)}.${config.gfsNamespace}.svc.cluster.local:${config.gfscPort}`
}

export function writerServiceUrl(
  gfs: Pick<GlobalFileSystemCRD, 'name'>,
  config: GfsFactoryConfig
): string {
  return `http://${writerServiceName(gfs)}.${config.gfsNamespace}.svc.cluster.local:${config.gfscPort}`
}

/** Reader replica count (writer is always exactly 1). */
export function readerReplicas(spec: GlobalFileSystemSpec): number {
  const n = spec.readerReplicas
  if (n === undefined) return DEFAULT_READER_REPLICAS
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`GlobalFileSystem readerReplicas must be a non-negative integer, got ${n}`)
  }
  return n
}

function commonLabels(gfs: GlobalFileSystemCRD): Record<string, string> {
  return {
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    [GFS_LABEL]: gfs.name,
  }
}

function podSelectorLabels(role: GfscRole): Record<string, string> {
  return {
    app: GFS_APP_LABEL,
    'clerum.io/gfsc-role': role,
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        const next = (value as Record<string, unknown>)[key]
        if (next !== undefined) acc[key] = stableValue(next)
        return acc
      }, {})
  }
  return value
}

export function deploymentTemplateHash(role: GfscRole, template: k8s.V1PodTemplateSpec): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue({ role, template })))
    .digest('hex')
    .slice(0, 16)
}

function readerAffinity(): k8s.V1Affinity {
  return {
    podAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: [
        {
          labelSelector: {
            matchLabels: podSelectorLabels('writer'),
          },
          topologyKey: 'kubernetes.io/hostname',
        },
      ],
    },
  }
}

function resolveAccessModes(spec: GlobalFileSystemSpec): string[] {
  return spec.storage?.accessModes && spec.storage.accessModes.length > 0
    ? [...spec.storage.accessModes]
    : [...DEFAULT_GFS_ACCESS_MODES]
}

function resolveSize(spec: GlobalFileSystemSpec): string {
  return spec.storage?.size && spec.storage.size.length > 0 ? spec.storage.size : DEFAULT_GFS_SIZE
}

function resolveSecurity(spec: GlobalFileSystemSpec): {
  runAsUser: number
  runAsGroup: number
  fsGroup: number
} {
  const runAsUser = spec.security?.runAsUser ?? DEFAULT_RUN_AS_UID
  const fsGroup = spec.security?.fsGroup ?? runAsUser
  const runAsGroup = fsGroup
  // Mirror the CRD `minimum: 1` server-side bound (defense in depth for
  // dev/non-cluster paths that bypass API-server validation): the serving
  // container runs runAsNonRoot, so root identities must fail fast here.
  if (runAsUser < 1 || fsGroup < 1) {
    throw new Error(
      'GlobalFileSystem security runAsUser/fsGroup must be >= 1 (root is not allowed)'
    )
  }
  return { runAsUser, runAsGroup, fsGroup }
}

/** Builds the singleton gfs drive PVC. */
export function buildPvc(
  gfs: GlobalFileSystemCRD,
  config: GfsFactoryConfig
): k8s.V1PersistentVolumeClaim {
  const storageClassName =
    gfs.spec.storage?.storageClassName && gfs.spec.storage.storageClassName.length > 0
      ? gfs.spec.storage.storageClassName
      : DEFAULT_GFS_STORAGE_CLASS
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: pvcName(gfs),
      namespace: config.gfsNamespace,
      labels: commonLabels(gfs),
    },
    spec: {
      accessModes: resolveAccessModes(gfs.spec),
      storageClassName,
      resources: { requests: { storage: resolveSize(gfs.spec) } },
    },
  }
}

function gfscEnv(config: GfsFactoryConfig, role: GfscRole): k8s.V1EnvVar[] {
  const pgSecretName = role === 'writer' ? config.pgSecretName : config.readerPgSecretName
  const pgSecretKey = role === 'writer' ? config.pgSecretKey : config.readerPgSecretKey
  const passthroughEnvEntries: ReadonlyArray<readonly [string, string | undefined]> = [
    ['GFS_SYNC_COPY_MAX_OBJECTS', config.syncCopyMaxObjects],
    ['GFS_SYNC_COPY_MAX_BYTES', config.syncCopyMaxBytes],
    ['GFS_SYNC_COPY_TIMEOUT_MS', config.syncCopyTimeoutMs],
    ['GFS_MAX_WRITE_BODY_BYTES', config.maxWriteBodyBytes],
  ]
  const passthroughEnv = passthroughEnvEntries.flatMap(([name, value]): k8s.V1EnvVar[] =>
    value === undefined ? [] : [{ name, value }]
  )

  return [
    { name: 'GFS_PORT', value: String(config.gfscPort) },
    { name: 'GFS_STORAGE_PATH', value: GFS_MOUNT_PATH },
    { name: 'GFS_STORAGE_ROLE', value: role },
    { name: 'GFS_DRIVE_NAME', value: config.driveName },
    { name: 'GFS_TOKEN_AUDIENCE', value: config.tokenAudience },
    {
      name: 'GFS_JWT_PUBLIC_KEY',
      valueFrom: {
        configMapKeyRef: {
          name: config.jwtPublicKeyConfigMapName,
          key: config.jwtPublicKeyConfigMapKey,
        },
      },
    },
    {
      // Keep the reader and writer on their distinct least-privilege roles.
      name: 'GFS_PG_CONNECTION_STRING',
      valueFrom: {
        secretKeyRef: {
          name: pgSecretName,
          key: pgSecretKey,
        },
      },
    },
    ...passthroughEnv,
  ]
}

export function buildWriterInitArgs(gfs: GlobalFileSystemCRD): string {
  const sec = resolveSecurity(gfs.spec)
  const sentinel = `${GFS_MOUNT_PATH}/.clerum-gfs-owned`
  const marker = `${sec.runAsUser}:${sec.runAsGroup}`

  return [
    'set -e',
    `mkdir -p ${GFS_MOUNT_PATH}`,
    // UID/GID changes require a bounded recursive repair on existing drives.
    // The root init container creates the sentinel, so chown it separately.
    `if [ "$(cat ${sentinel} 2>/dev/null || true)" != "${marker}" ]; then timeout 900 chown -R ${sec.runAsUser}:${sec.runAsGroup} -- ${GFS_MOUNT_PATH}; chmod 0775 -- ${GFS_MOUNT_PATH}; printf '%s' "${marker}" > ${sentinel}; fi`,
    `chown ${sec.runAsUser}:${sec.runAsGroup} ${sentinel} 2>/dev/null || true`,
  ].join('; ')
}

/**
 * Build the gfsc writer (RW, 1 replica) or reader (RO, `readerReplicas`)
 * Deployment. The reconciler owns securityContext / imagePullPolicy — never the
 * CRD. The writer mounts the PVC read-write; readers mount it read-only. The
 * writer also prepares PVC ownership in the same pod before gfsc starts. This
 * keeps hostpath/minikube and CSI-backed RWO volumes writable by the non-root
 * serving container without adding a separate pod that could race the RWO mount.
 * `strategy: Recreate` matches the single RW writer under RWO (two RW mounts are
 * impossible). Readers use a bounded RollingUpdate so a credential/image change
 * does not deliberately remove every read endpoint at once.
 */
export function buildDeployment(
  gfs: GlobalFileSystemCRD,
  config: GfsFactoryConfig,
  role: GfscRole
): k8s.V1Deployment {
  const sec = resolveSecurity(gfs.spec)
  const labels = commonLabels(gfs)
  const selector = podSelectorLabels(role)
  const isWriter = role === 'writer'
  const name = isWriter ? writerDeploymentName(gfs) : readerDeploymentName(gfs)
  const replicas = isWriter ? 1 : readerReplicas(gfs.spec)
  const port = config.gfscPort

  const deployment: k8s.V1Deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: config.gfsNamespace, labels },
    spec: {
      replicas,
      strategy: isWriter
        ? { type: 'Recreate' }
        : { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
      selector: { matchLabels: selector },
      template: {
        metadata: { labels: selector },
        spec: {
          automountServiceAccountToken: false,
          affinity: isWriter ? undefined : readerAffinity(),
          // Reconciler-owned priority (omitted when unset). Protects the gfsc
          // writer's scheduling under contention; the class must exist in-cluster.
          priorityClassName: config.gfscPriorityClassName,
          imagePullSecrets: config.gfscImagePullSecretName
            ? [{ name: config.gfscImagePullSecretName }]
            : undefined,
          securityContext: {
            runAsUser: sec.runAsUser,
            runAsGroup: sec.runAsGroup,
            runAsNonRoot: true,
            fsGroup: sec.fsGroup,
            fsGroupChangePolicy: 'OnRootMismatch',
            seccompProfile: { type: 'RuntimeDefault' },
          },
          initContainers: isWriter
            ? [
                {
                  name: 'init',
                  image: config.gfscInitImage,
                  imagePullPolicy: 'IfNotPresent',
                  command: ['sh', '-c'],
                  args: [buildWriterInitArgs(gfs)],
                  securityContext: {
                    runAsUser: 0,
                    runAsGroup: 0,
                    runAsNonRoot: false,
                    allowPrivilegeEscalation: false,
                    privileged: false,
                    readOnlyRootFilesystem: true,
                    capabilities: { drop: ['ALL'], add: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'] },
                    seccompProfile: { type: 'RuntimeDefault' },
                  },
                  volumeMounts: [{ name: 'drive', mountPath: GFS_MOUNT_PATH }],
                },
              ]
            : undefined,
          containers: [
            {
              name: 'gfsc',
              image: config.gfscImage,
              imagePullPolicy: config.gfscImagePullPolicy,
              ports: [{ name: 'http', containerPort: port, protocol: 'TCP' }],
              env: gfscEnv(config, role),
              volumeMounts: [{ name: 'drive', mountPath: GFS_MOUNT_PATH, readOnly: !isWriter }],
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
                requests: { ...config.gfscResources.requests },
                limits: { ...config.gfscResources.limits },
              },
            },
          ],
          volumes: [{ name: 'drive', persistentVolumeClaim: { claimName: pvcName(gfs) } }],
        },
      },
    },
  }
  const template = deployment.spec?.template
  if (!template) {
    throw new Error(`GlobalFileSystem ${role} Deployment template is missing`)
  }
  const templateHash = deploymentTemplateHash(role, template)
  deployment.metadata = {
    ...deployment.metadata,
    annotations: {
      ...(deployment.metadata?.annotations ?? {}),
      [GFS_TEMPLATE_HASH_ANNOTATION]: templateHash,
    },
  }
  template.metadata = {
    ...template.metadata,
    annotations: {
      ...(template.metadata?.annotations ?? {}),
      [GFS_TEMPLATE_HASH_ANNOTATION]: templateHash,
    },
  }
  return deployment
}

export function pdbName(gfs: Pick<GlobalFileSystemCRD, 'name'>): string {
  return `${writerDeploymentName(gfs)}-pdb`
}

/**
 * PodDisruptionBudget for the single gfsc writer (plan P5-S02 SRE). minAvailable:1
 * protects the one RW writer from voluntary disruption (node drains); combined
 * with the writer's strategy:Recreate, a writer upgrade is a brief, bounded
 * write-downtime — never a second concurrent writer. Reconciler-owned: the CRD
 * declares intent, never the deployment shape.
 */
export function buildPodDisruptionBudget(
  gfs: GlobalFileSystemCRD,
  config: GfsFactoryConfig
): k8s.V1PodDisruptionBudget {
  return {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: { name: pdbName(gfs), namespace: config.gfsNamespace, labels: commonLabels(gfs) },
    spec: {
      minAvailable: 1,
      selector: { matchLabels: podSelectorLabels('writer') },
    },
  }
}

function buildClusterIpService(
  gfs: GlobalFileSystemCRD,
  config: GfsFactoryConfig,
  name: string,
  selector: Record<string, string>
): k8s.V1Service {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      namespace: config.gfsNamespace,
      labels: commonLabels(gfs),
    },
    spec: {
      type: 'ClusterIP',
      selector,
      ports: [
        { name: 'http', port: config.gfscPort, targetPort: 'http' as IntOrString, protocol: 'TCP' },
      ],
    },
  }
}

/** Builds the read/browse gfsc ClusterIP Service fronting writer + readers. */
export function buildService(gfs: GlobalFileSystemCRD, config: GfsFactoryConfig): k8s.V1Service {
  // Both writer and reader pods carry app=gfs-controller; this Service remains
  // the stable read endpoint and preserves the original serviceUrl contract.
  return buildClusterIpService(gfs, config, serviceName(gfs), { app: GFS_APP_LABEL })
}

/** Builds the write-only gfsc ClusterIP Service selecting the single writer pod. */
export function buildWriterService(
  gfs: GlobalFileSystemCRD,
  config: GfsFactoryConfig
): k8s.V1Service {
  return buildClusterIpService(gfs, config, writerServiceName(gfs), podSelectorLabels('writer'))
}

/**
 * Ingress: allow the gfsc port from the three GFS data-plane callers:
 * control-api (operator/end-user proxy), first-party mcp-host pods, and workflow
 * mcp-host pods. Authorization is still enforced by gfsc with the GFS JWT and
 * stored grants on every operation; NetworkPolicy only opens the transport path
 * for those provisioned runtime classes.
 */
export function buildIngressNetworkPolicy(
  gfs: GlobalFileSystemCRD,
  config: GfsFactoryConfig
): k8s.V1NetworkPolicy {
  const firstPartyHostNamespace = config.firstPartyHostNamespace ?? 'mcp-host'
  const workflowRecipeNamespace = config.workflowRecipeNamespace ?? 'sandbox-recipes'
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: ingressPolicyName(gfs),
      namespace: config.gfsNamespace,
      labels: { ...commonLabels(gfs), 'clerum.io/policy-type': GFS_POLICY_TYPE },
    },
    spec: {
      podSelector: { matchLabels: { app: GFS_APP_LABEL } },
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
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': firstPartyHostNamespace },
              },
              podSelector: {
                matchLabels: { 'clerum.io/managed-by': 'host-context-controller' },
              },
            },
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': workflowRecipeNamespace },
              },
              podSelector: {
                matchLabels: {
                  'clerum.io/managed-by': 'wrc',
                  'clerum.io/component': 'workflow-mcp-host',
                },
              },
            },
          ],
          ports: [{ port: config.gfscPort, protocol: 'TCP' }],
        },
      ],
    },
  }
}

/**
 * Egress: DNS + the permission-store Postgres. Unlike SFS (DNS-only), gfsc MUST
 * reach Postgres — it re-checks the permission store on every op and fails
 * closed (503) when the store is unreachable. No other egress is permitted.
 */
export function buildEgressNetworkPolicy(
  gfs: GlobalFileSystemCRD,
  config: GfsFactoryConfig
): k8s.V1NetworkPolicy {
  const egress: k8s.V1NetworkPolicyEgressRule[] = [
    {
      to: [
        {
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
          podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
        },
      ],
      ports: [
        { port: 53, protocol: 'UDP' },
        { port: 53, protocol: 'TCP' },
      ],
    },
  ]
  if (config.nodeLocalDnsCidr) {
    egress.push({
      to: [{ ipBlock: { cidr: config.nodeLocalDnsCidr } }],
      ports: [
        { port: 53, protocol: 'UDP' },
        { port: 53, protocol: 'TCP' },
      ],
    })
  }
  egress.push({
    to: [
      {
        namespaceSelector: {
          matchLabels: { 'kubernetes.io/metadata.name': config.controlPlaneNamespace },
        },
        podSelector: { matchLabels: config.postgresPodLabels },
      },
    ],
    ports: [{ port: config.postgresPort, protocol: 'TCP' }],
  })

  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: egressPolicyName(gfs),
      namespace: config.gfsNamespace,
      labels: { ...commonLabels(gfs), 'clerum.io/policy-type': GFS_POLICY_TYPE },
    },
    spec: {
      podSelector: { matchLabels: { app: GFS_APP_LABEL } },
      policyTypes: ['Egress'],
      egress,
    },
  }
}
