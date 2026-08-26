import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import {
  type MockCoreApi,
  asAppsApi,
  asCoreApi,
  asCustomApi,
  asNetworkingApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockCustomApi,
  createMockNetworkingApi,
} from '../../test/__fixtures__/testMocks'
import { config } from '../config'
import { LlmHookReconciler, computePodKey } from '../llmHookReconciler'
import type { HostCRD, LlmHookCRD } from '../types'
import { asApiserverService, updatedServiceLogs } from './asApiserverService'

const IMG = 'registry.example.com/hook@sha256:' + 'a'.repeat(64)

function makeHook(): LlmHookCRD {
  return {
    name: 'pre-hook',
    namespace: config.llmHooksNamespace,
    generation: 1,
    spec: {
      target: { image: { ref: IMG, port: 8080 } },
      path: '/',
      lifecyclePoints: ['preCall'],
    },
  }
}

describe('LlmHook ensureService no-op gate', () => {
  let coreApi: MockCoreApi
  let reconciler: LlmHookReconciler
  const hook = makeHook()
  const podKey = computePodKey(hook)!
  const port = hook.spec.target.image!.port

  beforeEach(() => {
    coreApi = createMockCoreApi()
    reconciler = new LlmHookReconciler(
      {} as k8s.KubeConfig,
      new Map<string, LlmHookCRD>(),
      new Map<string, HostCRD>(),
      {
        appsApi: asAppsApi(createMockAppsApi()),
        coreApi: asCoreApi(coreApi),
        customApi: asCustomApi(createMockCustomApi()),
        networkingApi: asNetworkingApi(createMockNetworkingApi()),
      }
    )
  })

  it('NOOP-LLMSVC-1 / LOG-SVC-1: equivalent Service skips replace and Updated logs', async () => {
    const desired = (reconciler as any).buildService(podKey, port) as k8s.V1Service
    coreApi.createNamespacedService.mockRejectedValue({ code: 409 })
    coreApi.readNamespacedService.mockResolvedValue(asApiserverService(desired))
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureService(podKey, port)
      expect(coreApi.replaceNamespacedService).not.toHaveBeenCalled()
      expect(updatedServiceLogs(log, `Service "${desired.metadata?.name}"`)).toEqual([])
    } finally {
      log.mockRestore()
    }
  })

  it('NOOP-LLMSVC-2 / LOG-SVC-2: port drift replaces once and logs once', async () => {
    const desired = (reconciler as any).buildService(podKey, port) as k8s.V1Service
    coreApi.createNamespacedService.mockRejectedValue({ code: 409 })
    coreApi.readNamespacedService.mockResolvedValue(asApiserverService(desired, { port: 9090 }))
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureService(podKey, port)
      expect(coreApi.replaceNamespacedService).toHaveBeenCalledOnce()
      expect(updatedServiceLogs(log, `Service "${desired.metadata?.name}"`)).toEqual([
        `[LlmHook] Updated Service "${desired.metadata?.name}"`,
      ])
    } finally {
      log.mockRestore()
    }
  })
})
