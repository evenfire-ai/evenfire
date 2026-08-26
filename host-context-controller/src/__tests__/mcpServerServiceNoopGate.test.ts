import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import {
  type MockCoreApi,
  asAppsApi,
  asCoreApi,
  asCustomApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockCustomApi,
} from '../../test/__fixtures__/testMocks'
import { McpServerReconciler } from '../reconciler'
import type { McpServerCRD } from '../types'

function makeServer(): McpServerCRD {
  return {
    name: 'test-mcp',
    namespace: 'mcp-server',
    uid: 'uid-test-1234',
    spec: {
      contextRef: 'ctx1',
      image: 'my-mcp-server:v1',
      transport: { type: 'streamableHttp', port: 3000, url: 'http://test.mcp-server.svc:3000/mcp' },
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
      clusterIP: '10.96.30.8',
      clusterIPs: ['10.96.30.8'],
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
      resourceVersion: '12',
      uid: '33333333-4444-5555-6666-777777777777',
      creationTimestamp: new Date('2026-04-01T00:00:00.000Z'),
      generation: 1,
      managedFields: [{ manager: 'kube-apiserver', operation: 'Update' }],
      name: desired.metadata?.name,
      namespace: desired.metadata?.namespace,
      labels: desired.metadata?.labels,
      annotations: desired.metadata?.annotations,
      ownerReferences: desired.metadata?.ownerReferences,
    },
  }
}

function updatedServiceLogs(log: ReturnType<typeof vi.spyOn>, needle: string): string[] {
  return log.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.includes('Updated') && line.includes(needle))
}

describe('McpServer ensureService no-op gate', () => {
  let coreApi: MockCoreApi
  let reconciler: McpServerReconciler
  const server = makeServer()

  beforeEach(() => {
    coreApi = createMockCoreApi()
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      assumeInventoryAuthorityWhenUnconfigured: true,
      appsApi: asAppsApi(createMockAppsApi()),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(createMockCustomApi()),
    })
  })

  it('NOOP-MCPSVC-1 / LOG-SVC-1: equivalent Service skips replace and Updated logs', async () => {
    const desired = (reconciler as any).buildService(server) as k8s.V1Service
    coreApi.createNamespacedService.mockRejectedValue({ code: 409 })
    coreApi.readNamespacedService.mockResolvedValue(asApiserverService(desired))
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureService(server)
      expect(coreApi.replaceNamespacedService).not.toHaveBeenCalled()
      expect(updatedServiceLogs(log, 'Service "test-mcp"')).toEqual([])
    } finally {
      log.mockRestore()
    }
  })

  it('NOOP-MCPSVC-2 / LOG-SVC-2: port drift replaces once and logs once', async () => {
    const desired = (reconciler as any).buildService(server) as k8s.V1Service
    coreApi.createNamespacedService.mockRejectedValue({ code: 409 })
    coreApi.readNamespacedService.mockResolvedValue(asApiserverService(desired, { port: 4000 }))
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureService(server)
      expect(coreApi.replaceNamespacedService).toHaveBeenCalledOnce()
      expect(updatedServiceLogs(log, 'Service "test-mcp"')).toEqual([
        '[Reconciler] Updated Service "test-mcp"',
      ])
    } finally {
      log.mockRestore()
    }
  })

  it('GATE-MCP-1: drift plus isCurrent false skips replace after the gate', async () => {
    const desired = (reconciler as any).buildService(server) as k8s.V1Service
    coreApi.createNamespacedService.mockRejectedValue({ code: 409 })
    coreApi.readNamespacedService.mockResolvedValue(asApiserverService(desired, { port: 4000 }))
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)

    await (reconciler as any).ensureService(server, isCurrent)

    expect(coreApi.replaceNamespacedService).not.toHaveBeenCalled()
    expect(isCurrent).toHaveBeenCalled()
  })
})
