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
import { HostReconciler } from './hostReconciler'
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
  mintHostGfsToken: vi.fn().mockResolvedValue({
    token: 'gfs-runtime-value',
    expiresInSeconds: 300,
    subject: 'host:1st:mcp-host/standalone',
  }),
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
