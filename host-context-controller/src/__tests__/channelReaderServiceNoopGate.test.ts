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
      clusterIP: '10.96.20.4',
      clusterIPs: ['10.96.20.4'],
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
      resourceVersion: '1783416',
      uid: '22222222-3333-4444-5555-666666666666',
      creationTimestamp: new Date('2026-04-01T00:00:00.000Z'),
      generation: 1,
      managedFields: [{ manager: 'kube-apiserver', operation: 'Update' }],
      selfLink: '/api/v1/namespaces/channels/services/channel-reader-chatllm',
      name: desired.metadata?.name,
      namespace: desired.metadata?.namespace,
      labels: desired.metadata?.labels,
      annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}' },
    },
  }
}

function updatedServiceLogs(log: ReturnType<typeof vi.spyOn>, needle: string): string[] {
  return log.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.includes('Updated') && line.includes(needle))
}

describe('channel-reader Service no-op gate', () => {
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

  it('NOOP-CRS-1 / LOG-SVC-1: equivalent named targetPort handoff skips replace', async () => {
    const desired = (reconciler as any).buildChannelReaderService(host) as k8s.V1Service
    expect(desired.spec?.ports?.[0]?.targetPort).toBe('handoff')
    coreApi.createNamespacedService.mockRejectedValue({ code: 409 })
    coreApi.readNamespacedService.mockResolvedValue(asApiserverService(desired))
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).reconcileChannelReaderService(host)
      expect(coreApi.replaceNamespacedService).not.toHaveBeenCalled()
      expect(updatedServiceLogs(log, 'channel-reader Service "channel-reader-chatllm"')).toEqual([])
    } finally {
      log.mockRestore()
    }
  })

  it('NOOP-CRS-2 / LOG-SVC-2: port drift replaces once and logs once', async () => {
    const desired = (reconciler as any).buildChannelReaderService(host) as k8s.V1Service
    coreApi.createNamespacedService.mockRejectedValue({ code: 409 })
    coreApi.readNamespacedService.mockResolvedValue(asApiserverService(desired, { port: 8100 }))
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).reconcileChannelReaderService(host)
      expect(coreApi.replaceNamespacedService).toHaveBeenCalledOnce()
      expect(updatedServiceLogs(log, 'channel-reader Service "channel-reader-chatllm"')).toEqual([
        '[HostReconciler] Updated channel-reader Service "channel-reader-chatllm"',
      ])
    } finally {
      log.mockRestore()
    }
  })
})
