import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import {
  type MockRbacApi,
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
import { asApiserverRole, updatedRoleLogs } from './asApiserverRole'

function makeStubKc(): k8s.KubeConfig {
  const stub = new Proxy({}, { get: () => vi.fn() })
  return { makeApiClient: () => stub } as unknown as k8s.KubeConfig
}

function makeHost(secretRef = 'secret'): HostCRD {
  return {
    name: 'chatllm',
    namespace: 'mcp-host',
    uid: 'chatllm-uid',
    spec: {
      host: 'chatllm',
      contextRef: 'ctx',
      secretRef,
    },
  }
}

function desiredFromCreate(rbacApi: MockRbacApi): k8s.V1Role {
  const body = rbacApi.createNamespacedRole.mock.calls[0][0].body as k8s.V1Role
  expect(body.rules?.length).toBeGreaterThan(0)
  return body
}

describe('Host ensureHostRole no-op gate', () => {
  let rbacApi: MockRbacApi
  let reconciler: HostReconciler
  const host = makeHost()

  beforeEach(() => {
    rbacApi = createMockRbacApi()
    reconciler = new HostReconciler(makeStubKc(), {
      coreApi: asCoreApi(createMockCoreApi()),
      appsApi: asAppsApi(createMockAppsApi()),
      networkingApi: asNetworkingApi(createMockNetworkingApi()),
      rbacApi: asRbacApi(rbacApi),
      customApi: asCustomApi(createMockCustomApi()),
    })
  })

  it('CREATE-ROLE-1: successful create never reads or replaces', async () => {
    await (reconciler as any).ensureHostRole(host)
    expect(rbacApi.createNamespacedRole).toHaveBeenCalledOnce()
    expect(rbacApi.readNamespacedRole).not.toHaveBeenCalled()
    expect(rbacApi.replaceNamespacedRole).not.toHaveBeenCalled()
  })

  it('NOOP-ROLE-1: apiserver-shaped Role with shuffled label keys skips replace', async () => {
    rbacApi.createNamespacedRole.mockRejectedValue({ code: 409 })
    rbacApi.readNamespacedRole.mockImplementation(() => {
      const existing = asApiserverRole(desiredFromCreate(rbacApi))
      expect(existing.rules?.length).toBeGreaterThan(0)
      return Promise.resolve(existing)
    })
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureHostRole(host)
      expect(rbacApi.replaceNamespacedRole).not.toHaveBeenCalled()
      expect(updatedRoleLogs(log, '"host-chatllm-config-reader"')).toEqual([])
    } finally {
      log.mockRestore()
    }
  })

  it('NOOP-ROLE-2: rotated secretRef still replaces once', async () => {
    rbacApi.createNamespacedRole.mockRejectedValue({ code: 409 })
    rbacApi.readNamespacedRole.mockImplementation(() => {
      const live = structuredClone(desiredFromCreate(rbacApi))
      const secretRule = live.rules?.find(
        (rule: k8s.V1PolicyRule) => rule.resources?.[0] === 'secrets' && rule.verbs?.includes('get')
      )
      expect(secretRule?.resourceNames?.[0]).toBe('rotated-secret')
      secretRule!.resourceNames![0] = host.spec.secretRef
      const existing = asApiserverRole(live)
      expect(existing.rules?.length).toBeGreaterThan(0)
      return Promise.resolve(existing)
    })
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureHostRole(makeHost('rotated-secret'))
      expect(rbacApi.replaceNamespacedRole).toHaveBeenCalledOnce()
      expect(updatedRoleLogs(log, '"host-chatllm-config-reader"')).toEqual([
        '[HostReconciler] Updated Role "host-chatllm-config-reader"',
      ])
    } finally {
      log.mockRestore()
    }
  })
})
