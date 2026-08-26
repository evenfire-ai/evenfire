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

function asApiserverService(desired: k8s.V1Service, drift?: { port?: number }): k8s.V1Service {
  const ports = (desired.spec?.ports ?? []).map(port => ({
    protocol: 'TCP' as const,
    name: port.name,
    port: drift?.port ?? port.port,
    targetPort: port.targetPort,
  }))
  return {
    spec: {
      clusterIP: '10.96.40.2',
      clusterIPs: ['10.96.40.2'],
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
      resourceVersion: '4',
      uid: '44444444-5555-6666-7777-888888888888',
      creationTimestamp: '2026-04-01T00:00:00.000Z',
      generation: 1,
      managedFields: [{ manager: 'kube-apiserver', operation: 'Update' }],
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
