import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import {
  asAppsApi,
  asCoreApi,
  asNetworkingApi,
  asRbacApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockNetworkingApi,
  createMockRbacApi,
} from '../test/__fixtures__/testMocks'
import { HostFleetReconcileError, HostReconciler } from './hostReconciler'
import { HostK8sRequestTimeoutError } from './k8s/hostK8sApiClient'
import { HostCRD } from './types'

vi.mock('./config', () => ({
  config: {
    hostNamespace: 'mcp-host',
    hostWorkspaceStorageClassName: 'standard',
    hostWorkspaceStorageSize: '1Gi',
    hostWorkspacePath: '/workspace',
    hostImage: 'clerum/mcp-host:test',
    desktopImage: 'clerum/mcp-host-desktop:test',
    hostImagePullPolicy: 'IfNotPresent',
    hostImagePullSecretName: '',
    hostPort: 8080,
    gfsNamespace: 'gfs',
    gfscPort: 8087,
    desktopPort: 3000,
    rpcProxyNamespace: 'rpc-proxy',
    channelsNamespace: 'channels',
    hostK8sRequestTimeoutMs: 30_000,
    mcpHostGatewayUrl: 'http://mcp-host-gateway',
    hostResources: {
      requests: { memory: '128Mi', cpu: '50m' },
      limits: { memory: '256Mi', cpu: '200m' },
    },
    desktopResources: {
      requests: { memory: '256Mi', cpu: '100m' },
      limits: { memory: '512Mi', cpu: '500m' },
    },
  },
}))

vi.mock('./gfsHostBinding', () => ({
  mintHostGfsToken: vi
    .fn()
    .mockImplementation(async ({ name, namespace }: { name: string; namespace: string }) => ({
      token: 'gfs-runtime-value',
      expiresInSeconds: 300,
      subject: `host:1st:${namespace}/${name}`,
    })),
}))

function makeHost(overrides: Partial<HostCRD['spec']> & { name?: string } = {}): HostCRD {
  const { name, ...specOverrides } = overrides
  return {
    name: name ?? 'chatllm',
    namespace: 'mcp-host',
    spec: {
      host: name ?? 'chatllm',
      contextRef: 'ctx1',
      secretRef: 'llm-secret',
      ...specOverrides,
    },
  }
}

function hccOwnedHostResource(hostName = 'chatllm') {
  return {
    metadata: {
      labels: {
        'clerum.io/managed-by': 'host-context-controller',
        'clerum.io/host': hostName,
      },
      resourceVersion: '1',
    },
  }
}

describe('HostReconciler secret fail-closed cleanup', () => {
  const appsApi = createMockAppsApi()
  const coreApi = createMockCoreApi()
  const networkingApi = createMockNetworkingApi()
  const rbacApi = createMockRbacApi()
  let reconciler: HostReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    reconciler = new HostReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      networkingApi: asNetworkingApi(networkingApi),
      rbacApi: asRbacApi(rbacApi),
    })
  })

  it('removes runtime endpoints and RBAC on missing Host secret but preserves PVC', async () => {
    const missing = new Error('missing') as Error & { code?: number }
    missing.code = 404
    coreApi.readNamespacedSecret.mockRejectedValueOnce(missing).mockResolvedValueOnce({
      metadata: {
        labels: {
          'clerum.io/managed-by': 'host-context-controller',
          'clerum.io/host': 'chatllm',
        },
      },
    })
    appsApi.readNamespacedDeployment.mockResolvedValue(hccOwnedHostResource())
    coreApi.readNamespacedService.mockResolvedValue(hccOwnedHostResource())
    networkingApi.readNamespacedNetworkPolicy.mockResolvedValue(hccOwnedHostResource())
    rbacApi.readNamespacedRoleBinding.mockResolvedValue(hccOwnedHostResource())
    rbacApi.readNamespacedRole.mockResolvedValue(hccOwnedHostResource())
    coreApi.readNamespacedServiceAccount.mockResolvedValue(hccOwnedHostResource())

    await reconciler.reconcile(makeHost({ name: 'chatllm' }))

    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
      name: 'chatllm',
      namespace: 'mcp-host',
    })
    expect(coreApi.deleteNamespacedService).toHaveBeenCalledWith({
      name: 'chatllm',
      namespace: 'mcp-host',
    })
    expect(rbacApi.deleteNamespacedRole).toHaveBeenCalled()
    expect(coreApi.deleteNamespacedSecret).toHaveBeenCalledWith({
      name: 'host-chatllm-mcp-host-runtime-tokens',
      namespace: 'mcp-host',
    })
    expect(coreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
  })

  it('does not delete host resources missing HCC ownership labels', async () => {
    const missing = new Error('missing') as Error & { code?: number }
    missing.code = 404
    coreApi.readNamespacedSecret.mockRejectedValueOnce(missing).mockResolvedValueOnce({
      metadata: {
        labels: {
          'clerum.io/managed-by': 'host-context-controller',
          'clerum.io/host': 'chatllm',
        },
      },
    })
    const userOwned = { metadata: { labels: { 'clerum.io/managed-by': 'user' } } }
    appsApi.readNamespacedDeployment.mockResolvedValue(userOwned)
    coreApi.readNamespacedService.mockResolvedValue(userOwned)
    networkingApi.readNamespacedNetworkPolicy.mockResolvedValue(userOwned)
    rbacApi.readNamespacedRoleBinding.mockResolvedValue(userOwned)
    rbacApi.readNamespacedRole.mockResolvedValue(userOwned)
    coreApi.readNamespacedServiceAccount.mockResolvedValue(userOwned)

    await reconciler.reconcile(makeHost({ name: 'chatllm' }))

    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(coreApi.deleteNamespacedService).not.toHaveBeenCalled()
    expect(networkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(rbacApi.deleteNamespacedRoleBinding).not.toHaveBeenCalled()
    expect(rbacApi.deleteNamespacedRole).not.toHaveBeenCalled()
    expect(coreApi.deleteNamespacedServiceAccount).not.toHaveBeenCalled()
  })

  it('preserves existing runtime on transient Host secret read error', async () => {
    const err = new Error('api unavailable') as Error & { code?: number }
    err.code = 500
    coreApi.readNamespacedSecret.mockRejectedValueOnce(err)

    await reconciler.reconcile(makeHost({ name: 'chatllm' }))

    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(coreApi.deleteNamespacedService).not.toHaveBeenCalled()
    expect(coreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
  })
})

describe('HostReconciler Kubernetes request deadline wiring', () => {
  it('wraps every default finite Kubernetes client, including lazy CustomObjects', async () => {
    const rawClients = Array.from({ length: 5 }, () => ({
      probe: vi.fn(async (_request: unknown, _options?: unknown) => ({})),
    }))
    const pendingClients = [...rawClients]
    const kubeConfig = {
      makeApiClient: vi.fn(() => pendingClients.shift()),
    } as unknown as k8s.KubeConfig
    const reconciler = new HostReconciler(kubeConfig)
    const internals = reconciler as unknown as {
      appsApi: { probe(request: unknown): Promise<unknown> }
      coreApi: { probe(request: unknown): Promise<unknown> }
      networkingApi: { probe(request: unknown): Promise<unknown> }
      rbacApi: { probe(request: unknown): Promise<unknown> }
      customApi: { probe(request: unknown): Promise<unknown> }
    }

    for (const client of [
      internals.appsApi,
      internals.coreApi,
      internals.networkingApi,
      internals.rbacApi,
      internals.customApi,
    ]) {
      await client.probe({})
    }

    expect(kubeConfig.makeApiClient).toHaveBeenCalledTimes(5)
    for (const rawClient of rawClients) {
      expect(rawClient.probe).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          middleware: [expect.objectContaining({ pre: expect.any(Function) })],
          middlewareMergeStrategy: 'append',
        })
      )
    }
  })
})

describe('HostReconciler fleet failure isolation', () => {
  it('continues reconciling later Hosts and runs orphan sweeps after one Host fails', async () => {
    const reconciler = new HostReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(createMockAppsApi()),
      coreApi: asCoreApi(createMockCoreApi()),
      networkingApi: asNetworkingApi(createMockNetworkingApi()),
      rbacApi: asRbacApi(createMockRbacApi()),
    })
    const internals = reconciler as unknown as {
      listManagedHostDeployments(): Promise<k8s.V1Deployment[]>
      sweepOrphanChannelReaderResources(hosts: string[]): Promise<void>
      sweepOrphanHostNetworkPolicies(hosts: string[]): Promise<void>
    }
    const firstFailure = new Error('first Host failed')
    const reconcile = vi.spyOn(reconciler, 'reconcile').mockImplementation(async host => {
      if (host.name === 'host-a') throw firstFailure
    })
    vi.spyOn(internals, 'listManagedHostDeployments').mockResolvedValue([])
    const channelSweep = vi
      .spyOn(internals, 'sweepOrphanChannelReaderResources')
      .mockResolvedValue()
    const networkPolicySweep = vi
      .spyOn(internals, 'sweepOrphanHostNetworkPolicies')
      .mockResolvedValue()

    let thrown: unknown
    try {
      await reconciler.fullReconcile([makeHost({ name: 'host-a' }), makeHost({ name: 'host-b' })])
    } catch (error) {
      thrown = error
    }

    expect(reconcile.mock.calls.map(([host]) => host.name)).toEqual(['host-a', 'host-b'])
    expect(channelSweep).toHaveBeenCalledWith(['host-a', 'host-b'])
    expect(networkPolicySweep).toHaveBeenCalledWith(['host-a', 'host-b'])
    expect(thrown).toBeInstanceOf(AggregateError)
    expect(thrown).toBeInstanceOf(HostFleetReconcileError)
    expect((thrown as HostFleetReconcileError).hostFailures).toEqual([firstFailure])
    expect((thrown as HostFleetReconcileError).cleanupFailures).toEqual([])
    expect((thrown as AggregateError).errors).toContain(firstFailure)
  })

  it('continues with Host B when Host A reaches its Kubernetes request deadline', async () => {
    const reconciler = new HostReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(createMockAppsApi()),
      coreApi: asCoreApi(createMockCoreApi()),
      networkingApi: asNetworkingApi(createMockNetworkingApi()),
      rbacApi: asRbacApi(createMockRbacApi()),
    })
    const internals = reconciler as unknown as {
      listManagedHostDeployments(): Promise<k8s.V1Deployment[]>
      sweepOrphanChannelReaderResources(hosts: string[]): Promise<void>
      sweepOrphanHostNetworkPolicies(hosts: string[]): Promise<void>
    }
    const timeout = new HostK8sRequestTimeoutError('AppsV1Api.readNamespacedDeployment', 30_000)
    const reconcile = vi.spyOn(reconciler, 'reconcile').mockImplementation(async host => {
      if (host.name === 'host-a') throw timeout
    })
    vi.spyOn(internals, 'listManagedHostDeployments').mockResolvedValue([])
    vi.spyOn(internals, 'sweepOrphanChannelReaderResources').mockResolvedValue()
    vi.spyOn(internals, 'sweepOrphanHostNetworkPolicies').mockResolvedValue()

    let thrown: unknown
    try {
      await reconciler.fullReconcile([makeHost({ name: 'host-a' }), makeHost({ name: 'host-b' })])
    } catch (error) {
      thrown = error
    }

    expect(reconcile.mock.calls.map(([host]) => host.name)).toEqual(['host-a', 'host-b'])
    expect(thrown).toBeInstanceOf(HostFleetReconcileError)
    expect((thrown as HostFleetReconcileError).hostFailures).toEqual([timeout])
  })

  it('reports inventory and both sweep failures after every phase has run', async () => {
    const reconciler = new HostReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(createMockAppsApi()),
      coreApi: asCoreApi(createMockCoreApi()),
      networkingApi: asNetworkingApi(createMockNetworkingApi()),
      rbacApi: asRbacApi(createMockRbacApi()),
    })
    const internals = reconciler as unknown as {
      listManagedHostDeployments(): Promise<k8s.V1Deployment[]>
      sweepOrphanChannelReaderResources(hosts: string[]): Promise<void>
      sweepOrphanHostNetworkPolicies(hosts: string[]): Promise<void>
    }
    const inventoryFailure = new Error('Host Deployment inventory failed')
    const channelSweepFailure = new Error('channel-reader sweep failed')
    const networkPolicySweepFailure = new Error('NetworkPolicy sweep failed')
    vi.spyOn(reconciler, 'reconcile').mockResolvedValue()
    vi.spyOn(internals, 'listManagedHostDeployments').mockRejectedValue(inventoryFailure)
    const channelSweep = vi
      .spyOn(internals, 'sweepOrphanChannelReaderResources')
      .mockRejectedValue(channelSweepFailure)
    const networkPolicySweep = vi
      .spyOn(internals, 'sweepOrphanHostNetworkPolicies')
      .mockRejectedValue(networkPolicySweepFailure)

    let thrown: unknown
    try {
      await reconciler.fullReconcile([makeHost({ name: 'host-a' })])
    } catch (error) {
      thrown = error
    }

    expect(channelSweep).toHaveBeenCalledWith(['host-a'])
    expect(networkPolicySweep).toHaveBeenCalledWith(['host-a'])
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as HostFleetReconcileError).hostFailures).toEqual([])
    expect((thrown as HostFleetReconcileError).cleanupFailures).toEqual([
      inventoryFailure,
      channelSweepFailure,
      networkPolicySweepFailure,
    ])
    expect((thrown as AggregateError).errors).toEqual([
      inventoryFailure,
      channelSweepFailure,
      networkPolicySweepFailure,
    ])
  })

  it('preserves simultaneous Host and cleanup failures after every phase has run', async () => {
    const reconciler = new HostReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(createMockAppsApi()),
      coreApi: asCoreApi(createMockCoreApi()),
      networkingApi: asNetworkingApi(createMockNetworkingApi()),
      rbacApi: asRbacApi(createMockRbacApi()),
    })
    const internals = reconciler as unknown as {
      listManagedHostDeployments(): Promise<k8s.V1Deployment[]>
      sweepOrphanChannelReaderResources(hosts: string[]): Promise<void>
      sweepOrphanHostNetworkPolicies(hosts: string[]): Promise<void>
    }
    const hostFailure = new Error('Host deployment failed')
    const cleanupFailure = new Error('Host inventory failed')
    const reconcile = vi.spyOn(reconciler, 'reconcile').mockImplementation(async host => {
      if (host.name === 'host-a') throw hostFailure
    })
    vi.spyOn(internals, 'listManagedHostDeployments').mockRejectedValue(cleanupFailure)
    const channelSweep = vi
      .spyOn(internals, 'sweepOrphanChannelReaderResources')
      .mockResolvedValue()
    const networkPolicySweep = vi
      .spyOn(internals, 'sweepOrphanHostNetworkPolicies')
      .mockResolvedValue()

    let thrown: unknown
    try {
      await reconciler.fullReconcile([makeHost({ name: 'host-a' }), makeHost({ name: 'host-b' })])
    } catch (error) {
      thrown = error
    }

    expect(reconcile.mock.calls.map(([host]) => host.name)).toEqual(['host-a', 'host-b'])
    expect(channelSweep).toHaveBeenCalledWith(['host-a', 'host-b'])
    expect(networkPolicySweep).toHaveBeenCalledWith(['host-a', 'host-b'])
    expect(thrown).toBeInstanceOf(HostFleetReconcileError)
    expect((thrown as HostFleetReconcileError).hostFailures).toEqual([hostFailure])
    expect((thrown as HostFleetReconcileError).cleanupFailures).toEqual([cleanupFailure])
    expect((thrown as AggregateError).errors).toEqual([hostFailure, cleanupFailure])
  })

  it('continues orphan cleanup and preserves nested sweep failures in the fleet error', async () => {
    const reconciler = new HostReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(createMockAppsApi()),
      coreApi: asCoreApi(createMockCoreApi()),
      networkingApi: asNetworkingApi(createMockNetworkingApi()),
      rbacApi: asRbacApi(createMockRbacApi()),
    })
    const internals = reconciler as unknown as {
      listManagedHostDeployments(): Promise<k8s.V1Deployment[]>
      deleteHostRuntimeResources(name: string, namespace: string): Promise<void>
      sweepOrphanChannelReaderResources(hosts: string[]): Promise<void>
      sweepOrphanHostNetworkPolicies(hosts: string[]): Promise<void>
    }
    const firstOrphanFailure = new Error('first orphan cleanup failed')
    const channelListFailure = new Error('channel-reader list failed')
    const channelDeleteFailure = new Error('channel-reader delete failed')
    const networkListFailure = new Error('NetworkPolicy list failed')
    const channelSweepFailure = new AggregateError(
      [channelListFailure, channelDeleteFailure],
      'channel-reader sweep failed'
    )
    const networkSweepFailure = new AggregateError(
      [networkListFailure],
      'NetworkPolicy sweep failed'
    )
    vi.spyOn(internals, 'listManagedHostDeployments').mockResolvedValue([
      { metadata: { name: 'orphan-a', namespace: 'mcp-host' } } as k8s.V1Deployment,
      { metadata: { name: 'orphan-b', namespace: 'mcp-host' } } as k8s.V1Deployment,
    ])
    const deleteRuntime = vi
      .spyOn(internals, 'deleteHostRuntimeResources')
      .mockRejectedValueOnce(firstOrphanFailure)
      .mockResolvedValueOnce()
    const channelSweep = vi
      .spyOn(internals, 'sweepOrphanChannelReaderResources')
      .mockRejectedValue(channelSweepFailure)
    const networkPolicySweep = vi
      .spyOn(internals, 'sweepOrphanHostNetworkPolicies')
      .mockRejectedValue(networkSweepFailure)

    let thrown: unknown
    try {
      await reconciler.fullReconcile([])
    } catch (error) {
      thrown = error
    }

    expect(deleteRuntime.mock.calls.map(([name]) => name)).toEqual(['orphan-a', 'orphan-b'])
    expect(channelSweep).toHaveBeenCalledWith([])
    expect(networkPolicySweep).toHaveBeenCalledWith([])
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([
      firstOrphanFailure,
      channelSweepFailure,
      networkSweepFailure,
    ])
    expect(channelSweepFailure.errors).toEqual([channelListFailure, channelDeleteFailure])
    expect(networkSweepFailure.errors).toEqual([networkListFailure])
  })

  it('continues every channel-reader resource sweep and aggregates non-404 failures', async () => {
    const deploymentListFailure = new Error('Deployment list failed')
    const serviceDeleteFailure = new Error('Service delete failed')
    const secretListFailure = new Error('Secret list failed')
    const appsApi = createMockAppsApi()
    appsApi.listNamespacedDeployment.mockRejectedValue(deploymentListFailure)
    const coreApi = Object.assign(createMockCoreApi(), {
      listNamespacedService: vi.fn().mockResolvedValue({
        items: [
          {
            metadata: {
              name: 'channel-reader-orphan',
              labels: {
                app: 'channel-reader',
                'clerum.io/managed-by': 'host-context-controller',
                'clerum.io/host': 'orphan',
              },
            },
          },
        ],
      }),
    })
    coreApi.deleteNamespacedService.mockRejectedValue(serviceDeleteFailure)
    coreApi.listNamespacedSecret.mockRejectedValue(secretListFailure)
    const reconciler = new HostReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      networkingApi: asNetworkingApi(createMockNetworkingApi()),
      rbacApi: asRbacApi(createMockRbacApi()),
    })
    const internals = reconciler as unknown as {
      sweepOrphanChannelReaderResources(hosts: string[]): Promise<void>
    }

    let thrown: unknown
    try {
      await internals.sweepOrphanChannelReaderResources([])
    } catch (error) {
      thrown = error
    }

    expect(coreApi.listNamespacedService).toHaveBeenCalled()
    expect(coreApi.deleteNamespacedService).toHaveBeenCalled()
    expect(coreApi.listNamespacedSecret).toHaveBeenCalled()
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([
      deploymentListFailure,
      serviceDeleteFailure,
      secretListFailure,
    ])
  })

  it('continues NetworkPolicy namespaces and aggregates list and delete failures', async () => {
    const listFailure = new Error('channels NetworkPolicy list failed')
    const deleteFailure = new Error('mcp-host NetworkPolicy delete failed')
    const networkingApi = createMockNetworkingApi()
    networkingApi.listNamespacedNetworkPolicy
      .mockRejectedValueOnce(listFailure)
      .mockResolvedValueOnce({
        items: [
          {
            metadata: {
              name: 'mcp-host-orphan-egress',
              labels: { 'clerum.io/host': 'orphan' },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ items: [] })
    networkingApi.deleteNamespacedNetworkPolicy.mockRejectedValue(deleteFailure)
    const reconciler = new HostReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(createMockAppsApi()),
      coreApi: asCoreApi(createMockCoreApi()),
      networkingApi: asNetworkingApi(networkingApi),
      rbacApi: asRbacApi(createMockRbacApi()),
    })
    const internals = reconciler as unknown as {
      sweepOrphanHostNetworkPolicies(hosts: string[]): Promise<void>
    }

    let thrown: unknown
    try {
      await internals.sweepOrphanHostNetworkPolicies([])
    } catch (error) {
      thrown = error
    }

    expect(networkingApi.listNamespacedNetworkPolicy).toHaveBeenCalledTimes(3)
    expect(networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([listFailure, deleteFailure])
  })
})
