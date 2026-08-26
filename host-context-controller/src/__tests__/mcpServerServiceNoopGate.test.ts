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
import { asApiserverService, updatedServiceLogs } from './asApiserverService'

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
