import { type Mock, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'

type MockK8sResource = Record<string, unknown>
type MockApiMethod = Mock<(...args: any[]) => any>

export type MockAppsApi = {
  createNamespacedDeployment: MockApiMethod
  readNamespacedDeployment: MockApiMethod
  replaceNamespacedDeployment: MockApiMethod
  patchNamespacedDeployment: MockApiMethod
  deleteNamespacedDeployment: MockApiMethod
  listNamespacedDeployment: MockApiMethod
}

export type MockCoreApi = {
  createNamespacedService: MockApiMethod
  readNamespacedService: MockApiMethod
  listNamespacedService: MockApiMethod
  replaceNamespacedService: MockApiMethod
  deleteNamespacedService: MockApiMethod
  readNamespacedSecret: MockApiMethod
  listNamespacedSecret: MockApiMethod
  createNamespacedSecret: MockApiMethod
  replaceNamespacedSecret: MockApiMethod
  patchNamespacedSecret: MockApiMethod
  deleteNamespacedSecret: MockApiMethod
  createNamespacedPersistentVolumeClaim: MockApiMethod
  readNamespacedPersistentVolumeClaim: MockApiMethod
  replaceNamespacedPersistentVolumeClaim: MockApiMethod
  deleteNamespacedPersistentVolumeClaim: MockApiMethod
  createNamespacedConfigMap: MockApiMethod
  readNamespacedConfigMap: MockApiMethod
  replaceNamespacedConfigMap: MockApiMethod
  deleteNamespacedConfigMap: MockApiMethod
  createNamespacedServiceAccount: MockApiMethod
  readNamespacedServiceAccount: MockApiMethod
  deleteNamespacedServiceAccount: MockApiMethod
  listNamespacedServiceAccount: MockApiMethod
  listNamespacedPersistentVolumeClaim: MockApiMethod
  listNamespacedPod: MockApiMethod
}

export type MockCustomApi = {
  patchNamespacedCustomObject: MockApiMethod
  patchNamespacedCustomObjectStatus: MockApiMethod
  createNamespacedCustomObject: MockApiMethod
  getNamespacedCustomObject: MockApiMethod
  getNamespacedCustomObjectStatus: MockApiMethod
  replaceNamespacedCustomObject: MockApiMethod
  deleteNamespacedCustomObject: MockApiMethod
}

export type MockNetworkingApi = {
  createNamespacedNetworkPolicy: MockApiMethod
  readNamespacedNetworkPolicy: MockApiMethod
  replaceNamespacedNetworkPolicy: MockApiMethod
  deleteNamespacedNetworkPolicy: MockApiMethod
  listNamespacedNetworkPolicy: MockApiMethod
}

export type MockRbacApi = {
  createNamespacedRole: MockApiMethod
  readNamespacedRole: MockApiMethod
  replaceNamespacedRole: MockApiMethod
  deleteNamespacedRole: MockApiMethod
  createNamespacedRoleBinding: MockApiMethod
  readNamespacedRoleBinding: MockApiMethod
  deleteNamespacedRoleBinding: MockApiMethod
  listNamespacedRole: MockApiMethod
  listNamespacedRoleBinding: MockApiMethod
}

function hostNameFromResourceName(name = ''): string {
  if (name.startsWith('channel-reader-') && name.endsWith('-egress')) {
    return name.replace(/^channel-reader-/, '').replace(/-egress$/, '')
  }
  if (name.startsWith('channel-reader-') && name.endsWith('-mcp-host-runtime-auth')) {
    return name.replace(/^channel-reader-/, '').replace(/-mcp-host-runtime-auth$/, '')
  }
  if (name.startsWith('channel-reader-')) {
    return name.replace(/^channel-reader-/, '')
  }
  if (name.startsWith('allow-rpc-proxy-desktop-')) {
    return name.replace(/^allow-rpc-proxy-desktop-/, '')
  }
  if (name.startsWith('mcp-host-') && name.endsWith('-ingress-channel-reader')) {
    return name.replace(/^mcp-host-/, '').replace(/-ingress-channel-reader$/, '')
  }
  if (name.startsWith('mcp-host-') && name.endsWith('-ingress-rpc-proxy')) {
    return name.replace(/^mcp-host-/, '').replace(/-ingress-rpc-proxy$/, '')
  }
  if (name.startsWith('mcp-host-') && name.endsWith('-egress-gfs')) {
    return name.replace(/^mcp-host-/, '').replace(/-egress-gfs$/, '')
  }
  if (name.startsWith('rpc-proxy-') && name.endsWith('-egress-mcp-host')) {
    return name.replace(/^rpc-proxy-/, '').replace(/-egress-mcp-host$/, '')
  }
  if (name.startsWith('host-') && name.endsWith('-mcp-host-runtime-tokens')) {
    return name.replace(/^host-/, '').replace(/-mcp-host-runtime-tokens$/, '')
  }
  if (name.startsWith('host-') && name.endsWith('-config-reader')) {
    return name.replace(/^host-/, '').replace(/-config-reader$/, '')
  }
  if (name.startsWith('host-') && name.endsWith('-sa')) {
    return name.replace(/^host-/, '').replace(/-sa$/, '')
  }
  if (name.endsWith('-workspace')) {
    return name.replace(/-workspace$/, '')
  }
  return name
}

function hccOwnedLabels(name = ''): Record<string, string> {
  const owner = hostNameFromResourceName(name)
  const labels: Record<string, string> = {
    'clerum.io/managed-by': 'host-context-controller',
    'clerum.io/host': owner,
    'clerum.io/mcpserver': name,
  }
  if (name.startsWith('channel-reader-') && name.endsWith('-mcp-host-runtime-auth')) {
    labels['clerum.io/component'] = 'channel-reader'
    labels['clerum.io/secret-purpose'] = 'mcp-host-runtime-auth'
  }
  return labels
}

export function createMockAppsApi(): MockAppsApi {
  return {
    createNamespacedDeployment: vi.fn().mockResolvedValue({}),
    readNamespacedDeployment: vi.fn(({ name }: { name?: string } = {}) =>
      Promise.resolve({
        status: { readyReplicas: 1 },
        metadata: { resourceVersion: '1', labels: hccOwnedLabels(name) },
      } as MockK8sResource)
    ),
    replaceNamespacedDeployment: vi.fn().mockResolvedValue({}),
    patchNamespacedDeployment: vi.fn().mockResolvedValue({}),
    deleteNamespacedDeployment: vi.fn().mockResolvedValue({}),
    listNamespacedDeployment: vi.fn().mockResolvedValue({ items: [] }),
  }
}

export function createMockCoreApi(): MockCoreApi {
  return {
    createNamespacedService: vi.fn().mockResolvedValue({}),
    readNamespacedService: vi.fn(({ name }: { name?: string } = {}) =>
      Promise.resolve({
        metadata: { resourceVersion: '1', labels: hccOwnedLabels(name) },
        spec: { clusterIP: '10.0.0.1' },
      } as MockK8sResource)
    ),
    listNamespacedService: vi.fn().mockResolvedValue({ items: [] }),
    replaceNamespacedService: vi.fn().mockResolvedValue({}),
    deleteNamespacedService: vi.fn().mockResolvedValue({}),
    readNamespacedSecret: vi.fn(({ name }: { name?: string } = {}) =>
      Promise.resolve({
        metadata: { resourceVersion: '1', labels: hccOwnedLabels(name) },
        data: {},
      } as MockK8sResource)
    ),
    listNamespacedSecret: vi.fn().mockResolvedValue({ items: [] }),
    // HCC creates the per-host `host-${name}-mcp-host-runtime-tokens` Secret each
    // reconcile (read+create on first run, read+replace on rotations).
    createNamespacedSecret: vi.fn().mockResolvedValue({}),
    replaceNamespacedSecret: vi.fn().mockResolvedValue({}),
    patchNamespacedSecret: vi.fn().mockResolvedValue({}),
    deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
    createNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
    readNamespacedPersistentVolumeClaim: vi.fn(({ name }: { name?: string } = {}) =>
      Promise.resolve({
        metadata: { resourceVersion: '1', labels: hccOwnedLabels(name) },
      } as MockK8sResource)
    ),
    replaceNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
    deleteNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
    createNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    readNamespacedConfigMap: vi
      .fn()
      .mockResolvedValue({ metadata: { resourceVersion: '1' }, data: {} } as MockK8sResource),
    replaceNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    deleteNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    // Per-Host ServiceAccount (lives on CoreV1Api)
    createNamespacedServiceAccount: vi.fn().mockResolvedValue({}),
    readNamespacedServiceAccount: vi.fn(({ name }: { name?: string } = {}) =>
      Promise.resolve({
        metadata: { resourceVersion: '1', labels: hccOwnedLabels(name) },
      } as MockK8sResource)
    ),
    deleteNamespacedServiceAccount: vi.fn().mockResolvedValue({}),
    // #827 partial-leftover discovery lists these owned kinds by ownership label.
    listNamespacedServiceAccount: vi.fn().mockResolvedValue({ items: [] }),
    listNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({ items: [] }),
    // wfc pod node-placement lookup for the stateless SFS co-location check.
    listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
  }
}

export function createMockCustomApi(): MockCustomApi {
  return {
    patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    getNamespacedCustomObject: vi.fn().mockResolvedValue({
      metadata: { name: 'stateless-host', namespace: 'mcp-host' },
      spec: {
        host: 'stateless-host',
        contextRef: 'context-a',
        secretRef: 'host-secret',
        lifecycle: { stateless: true },
      },
      status: { lifecycle: { state: 'suspended', wakeHandledGeneration: 0 } },
    }),
    getNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({ status: { conditions: [] } }),
    replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  }
}

export function createMockNetworkingApi(): MockNetworkingApi {
  return {
    createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    // name + uid + resourceVersion because that is what a real apiserver read
    // returns, and the NetworkPolicy safety mutations (safetyPolicyIdentity)
    // refuse to act on a partial identity — a delete keyed on name alone could
    // hit a policy recreated between the read and the write.
    readNamespacedNetworkPolicy: vi.fn(({ name }: { name?: string } = {}) =>
      Promise.resolve({
        metadata: {
          name,
          uid: `uid-${name ?? 'unnamed'}`,
          resourceVersion: '1',
          labels: hccOwnedLabels(name),
        },
      } as MockK8sResource)
    ),
    replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    listNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ items: [] }),
  }
}

export function createMockRbacApi(): MockRbacApi {
  return {
    createNamespacedRole: vi.fn().mockResolvedValue({}),
    readNamespacedRole: vi.fn(({ name }: { name?: string } = {}) =>
      Promise.resolve({
        metadata: { resourceVersion: '1', labels: hccOwnedLabels(name) },
      } as MockK8sResource)
    ),
    replaceNamespacedRole: vi.fn().mockResolvedValue({}),
    deleteNamespacedRole: vi.fn().mockResolvedValue({}),
    createNamespacedRoleBinding: vi.fn().mockResolvedValue({}),
    readNamespacedRoleBinding: vi.fn(({ name }: { name?: string } = {}) =>
      Promise.resolve({
        metadata: { resourceVersion: '1', labels: hccOwnedLabels(name) },
      } as MockK8sResource)
    ),
    deleteNamespacedRoleBinding: vi.fn().mockResolvedValue({}),
    // #827 partial-leftover discovery lists RBAC by ownership label.
    listNamespacedRole: vi.fn().mockResolvedValue({ items: [] }),
    listNamespacedRoleBinding: vi.fn().mockResolvedValue({ items: [] }),
  }
}

export function asAppsApi(mock: MockAppsApi): k8s.AppsV1Api {
  return mock as unknown as k8s.AppsV1Api
}

export function asCoreApi(mock: MockCoreApi): k8s.CoreV1Api {
  return mock as unknown as k8s.CoreV1Api
}

export function asCustomApi(mock: MockCustomApi): k8s.CustomObjectsApi {
  return mock as unknown as k8s.CustomObjectsApi
}

export function asNetworkingApi(mock: MockNetworkingApi): k8s.NetworkingV1Api {
  return mock as unknown as k8s.NetworkingV1Api
}

export function asRbacApi(mock: MockRbacApi): k8s.RbacAuthorizationV1Api {
  return mock as unknown as k8s.RbacAuthorizationV1Api
}
