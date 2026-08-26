import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import {
  type MockCoreApi,
  asAppsApi,
  asCoreApi,
  asCustomApi,
  asNetworkingApi,
  asRbacApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockCustomApi,
  createMockNetworkingApi,
  createMockRbacApi,
} from '../../test/__fixtures__/testMocks'
import { HostReconciler } from '../hostReconciler'
import type { HostCRD } from '../types'

function makeStubKc(): k8s.KubeConfig {
  const stub = new Proxy({}, { get: () => vi.fn() })
  return { makeApiClient: () => stub } as unknown as k8s.KubeConfig
}

function makeHost(): HostCRD {
  return {
    name: 'chatllm',
    namespace: 'mcp-host',
    uid: 'chatllm-uid',
    spec: {
      host: 'chatllm',
      contextRef: 'ctx',
      secretRef: 'secret',
    },
  }
}

function asApiserverService(desired: k8s.V1Service, drift?: { port?: number }): k8s.V1Service {
  const ports = (desired.spec?.ports ?? []).map(port => ({
    protocol: 'TCP' as const,
    name: port.name,
    port: drift?.port ?? port.port,
    targetPort: port.targetPort,
  }))
  return {
    spec: {
      clusterIP: '10.96.14.7',
      clusterIPs: ['10.96.14.7'],
      type: 'ClusterIP',
      sessionAffinity: 'None',
      internalTrafficPolicy: 'Cluster',
      ipFamilyPolicy: 'SingleStack',
      ipFamilies: ['IPv4'],
      selector: desired.spec?.selector,
      ports,
    },
    status: { loadBalancer: {} },
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      resourceVersion: '1776125',
      uid: '11111111-2222-3333-4444-555555555555',
      creationTimestamp: '2026-04-01T00:00:00.000Z',
      generation: 1,
      managedFields: [{ manager: 'kube-apiserver', operation: 'Update' }],
      selfLink: '/api/v1/namespaces/mcp-host/services/chatllm',
      name: desired.metadata?.name,
      namespace: desired.metadata?.namespace,
      labels: desired.metadata?.labels,
      annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}' },
    },
  }
}

function updatedServiceLogs(log: ReturnType<typeof vi.spyOn>, needle: string): string[] {
  return log.mock.calls
    .map(call => String(call[0]))
    .filter(line => line.includes('Updated') && line.includes(needle))
}

describe('Host ensureService no-op gate', () => {
  let coreApi: MockCoreApi
  let reconciler: HostReconciler
  const host = makeHost()

  beforeEach(() => {
    coreApi = createMockCoreApi()
    reconciler = new HostReconciler(makeStubKc(), {
      coreApi: asCoreApi(coreApi),
      appsApi: asAppsApi(createMockAppsApi()),
      networkingApi: asNetworkingApi(createMockNetworkingApi()),
      rbacApi: asRbacApi(createMockRbacApi()),
      customApi: asCustomApi(createMockCustomApi()),
    })
  })

  it('CREATE-SVC-1: successful create never reads or replaces', async () => {
    await (reconciler as any).ensureService(host)
    expect(coreApi.createNamespacedService).toHaveBeenCalledOnce()
    expect(coreApi.readNamespacedService).not.toHaveBeenCalled()
    expect(coreApi.replaceNamespacedService).not.toHaveBeenCalled()
  })

  it('NOOP-SVC-1 / LOG-SVC-1: equivalent Service skips replace and Updated logs', async () => {
    const desired = (reconciler as any).buildService(host) as k8s.V1Service
    coreApi.createNamespacedService.mockRejectedValue({ code: 409 })
    coreApi.readNamespacedService.mockResolvedValue(asApiserverService(desired))
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureService(host)
      expect(coreApi.replaceNamespacedService).not.toHaveBeenCalled()
      expect(updatedServiceLogs(log, 'Service "chatllm"')).toEqual([])
    } finally {
      log.mockRestore()
    }
  })

  it('NOOP-SVC-2 / LOG-SVC-2: port drift replaces once and logs once', async () => {
    const desired = (reconciler as any).buildService(host) as k8s.V1Service
    coreApi.createNamespacedService.mockRejectedValue({ code: 409 })
    coreApi.readNamespacedService.mockResolvedValue(asApiserverService(desired, { port: 9090 }))
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureService(host)
      expect(coreApi.replaceNamespacedService).toHaveBeenCalledOnce()
      expect(updatedServiceLogs(log, 'Service "chatllm"')).toEqual([
        '[HostReconciler] Updated Service "chatllm"',
      ])
    } finally {
      log.mockRestore()
    }
  })
})
