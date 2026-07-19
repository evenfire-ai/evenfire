import * as k8s from '@kubernetes/client-node'
import type { Informer } from '@kubernetes/client-node'
import type { InventorySnapshot, InventoryWorkload } from './contracts.js'

const STABLE_LABEL_ALLOWLIST = new Set([
  'app',
  'app.kubernetes.io/name',
  'app.kubernetes.io/component',
  'clerum.io/component',
  'clerum.io/managed-by',
])

const CPU_PATTERN = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,9}))?([num]?)$/
const MEMORY_PATTERN = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,9}))?([KMGT]i?|)$/
const MEMORY_MULTIPLIERS: Readonly<Record<string, bigint>> = {
  '': 1n,
  K: 1_000n,
  Ki: 1_024n,
  M: 1_000_000n,
  Mi: 1_048_576n,
  G: 1_000_000_000n,
  Gi: 1_073_741_824n,
  T: 1_000_000_000_000n,
  Ti: 1_099_511_627_776n,
}

export const DEFAULT_CONTROL_PLANE_INVENTORY_ALLOWLIST = [
  'control-api',
  'control-api-rpc-gateway',
  'control-ui',
  'host-context-controller',
  'host-context-controller-api-gateway',
  'nginx-workflow-approval-gateway',
  'trace-maintenance-worker',
  'workflow-recipes',
] as const

const DEFAULT_HCC_MANAGED_NAMESPACES = ['mcp-server'] as const
const DEFAULT_WRC_MANAGED_NAMESPACES = ['sandbox-recipes'] as const
const INVENTORY_NAMESPACES = new Set(['control-plane', 'mcp-server', 'sandbox-recipes'])

function parseCpuNanoCores(quantity: string): bigint {
  const match = CPU_PATTERN.exec(quantity)
  if (!match) throw new Error(`unsupported CPU quantity: ${quantity}`)
  const suffix = match[3]
  const fraction = match[2] ?? ''
  const scale = 10n ** BigInt(fraction.length)
  const decimalUnits = BigInt(`${match[1]}${fraction}`)
  const multiplier =
    suffix === 'n' ? 1n : suffix === 'u' ? 1_000n : suffix === 'm' ? 1_000_000n : 1_000_000_000n
  if ((decimalUnits * multiplier) % scale !== 0n)
    throw new Error(`CPU quantity is below nanocore precision: ${quantity}`)
  return (decimalUnits * multiplier) / scale
}

function parseMemoryBytes(quantity: string): bigint {
  const match = MEMORY_PATTERN.exec(quantity)
  if (!match) throw new Error(`unsupported memory quantity: ${quantity}`)
  const fraction = match[2] ?? ''
  const scale = 10n ** BigInt(fraction.length)
  const decimalUnits = BigInt(`${match[1]}${fraction}`)
  const bytes = decimalUnits * MEMORY_MULTIPLIERS[match[3]]!
  if (bytes % scale !== 0n) throw new Error(`memory quantity is below byte precision: ${quantity}`)
  return bytes / scale
}

function stableLabels(
  labels: Record<string, string> | undefined
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(labels ?? {})
      .filter(([key]) => STABLE_LABEL_ALLOWLIST.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
  )
}

export function deploymentToInventoryWorkload(deployment: k8s.V1Deployment): InventoryWorkload {
  const name = deployment.metadata?.name
  const namespace = deployment.metadata?.namespace
  if (!name || !namespace || !INVENTORY_NAMESPACES.has(namespace)) {
    throw new Error('inventory accepts named namespaced Deployments only')
  }

  let cpuRequestNanoCores = 0n
  let cpuLimitNanoCores = 0n
  let memoryRequestBytes = 0n
  let memoryLimitBytes = 0n
  for (const container of deployment.spec?.template.spec?.containers ?? []) {
    const requests = container.resources?.requests
    const limits = container.resources?.limits
    if (requests?.cpu) cpuRequestNanoCores += parseCpuNanoCores(requests.cpu)
    if (requests?.memory) memoryRequestBytes += parseMemoryBytes(requests.memory)
    if (limits?.cpu) cpuLimitNanoCores += parseCpuNanoCores(limits.cpu)
    if (limits?.memory) memoryLimitBytes += parseMemoryBytes(limits.memory)
  }

  const generation = deployment.metadata?.generation

  return {
    namespace: namespace as InventoryWorkload['namespace'],
    workloadKind: 'Deployment',
    workloadRef: name,
    kubernetesUid: deployment.metadata?.uid?.trim() || null,
    metadataGeneration:
      Number.isSafeInteger(generation) && Number(generation) >= 0 ? Number(generation) : null,
    desiredReplicas: Math.max(0, deployment.spec?.replicas ?? 1),
    observedReplicas: Math.max(0, deployment.status?.replicas ?? 0),
    readyReplicas: Math.max(0, deployment.status?.readyReplicas ?? 0),
    cpuRequestNanoCores,
    cpuLimitNanoCores,
    memoryRequestBytes,
    memoryLimitBytes,
    stableLabels: stableLabels(deployment.metadata?.labels),
  }
}

export interface DeploymentInventoryCache {
  start(): Promise<void>
  stop(): Promise<void>
  snapshot(now?: Date): InventorySnapshot
}

type DeploymentInformer = Informer<k8s.V1Deployment> & {
  list(namespace?: string): ReadonlyArray<k8s.V1Deployment>
}

export type DeploymentInventorySource = {
  namespace: string
  informer: DeploymentInformer
  include(deployment: k8s.V1Deployment): boolean
  requiredNames?: ReadonlySet<string>
}

function deploymentName(deployment: k8s.V1Deployment): string {
  return deployment.metadata?.name ?? ''
}

function deploymentNamespace(deployment: k8s.V1Deployment): string {
  return deployment.metadata?.namespace ?? ''
}

function managedBy(deployment: k8s.V1Deployment): string | undefined {
  return deployment.metadata?.labels?.['clerum.io/managed-by']
}

function deploymentKey(deployment: k8s.V1Deployment): string {
  return `${deploymentNamespace(deployment)}/${deploymentName(deployment)}`
}

export class AllowlistedDeploymentInventoryCache implements DeploymentInventoryCache {
  private readonly connected = new Map<string, boolean>()

  constructor(private readonly sources: readonly DeploymentInventorySource[]) {
    for (const source of sources) {
      this.connected.set(source.namespace, false)
      source.informer.on('connect', () => {
        this.connected.set(source.namespace, true)
      })
      source.informer.on('error', () => {
        this.connected.set(source.namespace, false)
      })
    }
  }

  static forControlPlane(
    informer: DeploymentInformer,
    allowlist: ReadonlySet<string>
  ): AllowlistedDeploymentInventoryCache {
    return new AllowlistedDeploymentInventoryCache([
      {
        namespace: 'control-plane',
        informer,
        requiredNames: allowlist,
        include: deployment => allowlist.has(deploymentName(deployment)),
      },
    ])
  }

  static forSources(
    sources: readonly DeploymentInventorySource[]
  ): AllowlistedDeploymentInventoryCache {
    return new AllowlistedDeploymentInventoryCache(sources)
  }

  private sourceDeployments(source: DeploymentInventorySource): ReadonlyArray<k8s.V1Deployment> {
    return source.informer
      .list(source.namespace)
      .filter(deployment => deploymentNamespace(deployment) === source.namespace)
      .filter(source.include)
      .sort((left, right) => deploymentKey(left).localeCompare(deploymentKey(right)))
  }

  private omittedRequiredWorkloads(
    source: DeploymentInventorySource,
    deployments: readonly k8s.V1Deployment[]
  ): string[] {
    if (!source.requiredNames) return []
    const observed = new Set(deployments.map(deploymentName))
    return [...source.requiredNames]
      .filter(name => !observed.has(name))
      .map(name => `${source.namespace}/${name}`)
      .sort()
  }

  private complete(omittedAllowlistedWorkloads: readonly string[]): boolean {
    return (
      omittedAllowlistedWorkloads.length === 0 &&
      this.sources.every(source => this.connected.get(source.namespace) === true)
    )
  }

  private resourceVersion(deployments: readonly k8s.V1Deployment[]): string {
    return deployments
      .map(
        deployment => `${deploymentKey(deployment)}@${deployment.metadata?.resourceVersion ?? ''}`
      )
      .sort()
      .join(':')
  }

  private workloads(deployments: readonly k8s.V1Deployment[]): InventoryWorkload[] {
    return deployments.map(deploymentToInventoryWorkload).sort((left, right) => {
      const namespace = left.namespace.localeCompare(right.namespace)
      return namespace === 0 ? left.workloadRef.localeCompare(right.workloadRef) : namespace
    })
  }

  async start(): Promise<void> {
    await Promise.all(this.sources.map(source => source.informer.start()))
  }

  async stop(): Promise<void> {
    for (const source of this.sources) {
      this.connected.set(source.namespace, false)
    }
    await Promise.all(this.sources.map(source => source.informer.stop()))
  }

  snapshot(now = new Date()): InventorySnapshot {
    const deploymentsBySource = this.sources.map(source => ({
      source,
      deployments: this.sourceDeployments(source),
    }))
    const deployments = deploymentsBySource.flatMap(entry => entry.deployments)
    const omittedAllowlistedWorkloads = deploymentsBySource.flatMap(entry =>
      this.omittedRequiredWorkloads(entry.source, entry.deployments)
    )

    return {
      observedAt: now.toISOString(),
      resourceVersion: this.resourceVersion(deployments),
      complete: this.complete(omittedAllowlistedWorkloads),
      workloads: this.workloads(deployments),
      omittedAllowlistedWorkloads,
    }
  }
}

function makeDeploymentInformer(
  kubeConfig: k8s.KubeConfig,
  appsApi: k8s.AppsV1Api,
  namespace: string
): DeploymentInformer {
  const path = `/apis/apps/v1/namespaces/${namespace}/deployments`
  return k8s.makeInformer<k8s.V1Deployment>(kubeConfig, path, () =>
    appsApi.listNamespacedDeployment({ namespace })
  ) as DeploymentInformer
}

function createManagedDeploymentSource(
  kubeConfig: k8s.KubeConfig,
  appsApi: k8s.AppsV1Api,
  namespace: string,
  managers: ReadonlySet<string>
): DeploymentInventorySource {
  return {
    namespace,
    informer: makeDeploymentInformer(kubeConfig, appsApi, namespace),
    include: deployment => managers.has(managedBy(deployment) ?? ''),
  }
}

export function createTraceMaintenanceInventoryCache(
  allowlist: readonly string[] = DEFAULT_CONTROL_PLANE_INVENTORY_ALLOWLIST
): DeploymentInventoryCache {
  const kubeConfig = new k8s.KubeConfig()
  kubeConfig.loadFromDefault()
  const appsApi = kubeConfig.makeApiClient(k8s.AppsV1Api)

  return AllowlistedDeploymentInventoryCache.forSources([
    {
      namespace: 'control-plane',
      informer: makeDeploymentInformer(kubeConfig, appsApi, 'control-plane'),
      requiredNames: new Set(allowlist),
      include: deployment => allowlist.includes(deploymentName(deployment)),
    },
    ...DEFAULT_HCC_MANAGED_NAMESPACES.map(namespace =>
      createManagedDeploymentSource(
        kubeConfig,
        appsApi,
        namespace,
        new Set(['host-context-controller'])
      )
    ),
    ...DEFAULT_WRC_MANAGED_NAMESPACES.map(namespace =>
      createManagedDeploymentSource(
        kubeConfig,
        appsApi,
        namespace,
        new Set(['wrc', 'workflow-recipes'])
      )
    ),
  ])
}

export function createControlPlaneInventoryCache(
  allowlist: readonly string[] = DEFAULT_CONTROL_PLANE_INVENTORY_ALLOWLIST
): DeploymentInventoryCache {
  return createTraceMaintenanceInventoryCache(allowlist)
}
