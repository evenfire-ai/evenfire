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
  makeStubKc,
} from '../../test/__fixtures__/testMocks'
import { HostReconciler } from '../hostReconciler'
import type { HostCRD } from '../types'
import { asApiserverService, updatedServiceLogs } from './asApiserverService'

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
