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
  return rbacApi.createNamespacedRole.mock.calls[0][0].body as k8s.V1Role
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
    let existing: k8s.V1Role | undefined
    rbacApi.readNamespacedRole.mockImplementation(() => {
      existing = asApiserverRole(desiredFromCreate(rbacApi))
      return Promise.resolve(existing)
    })
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureHostRole(host)
      expect(rbacApi.readNamespacedRole).toHaveBeenCalledOnce()
      expect(existing?.rules?.length).toBeGreaterThan(0)
      expect(Object.keys(existing!.rules![0] ?? {})).toEqual([
        'apiGroups',
        'resourceNames',
        'resources',
        'verbs',
      ])
      expect(desiredFromCreate(rbacApi).rules?.length).toBeGreaterThan(0)
      expect(rbacApi.replaceNamespacedRole).not.toHaveBeenCalled()
      expect(updatedRoleLogs(log, '"host-chatllm-config-reader"')).toEqual([])
    } finally {
      log.mockRestore()
    }
  })

  it('NOOP-ROLE-2: rotated secretRef still replaces once', async () => {
    rbacApi.createNamespacedRole.mockRejectedValue({ code: 409 })
    let existing: k8s.V1Role | undefined
    rbacApi.readNamespacedRole.mockImplementation(() => {
      const live = structuredClone(desiredFromCreate(rbacApi))
      const secretRule = live.rules?.find(
        (rule: k8s.V1PolicyRule) => rule.resources?.[0] === 'secrets' && rule.verbs?.includes('get')
      )
      secretRule!.resourceNames![0] = host.spec.secretRef
      existing = asApiserverRole(live)
      return Promise.resolve(existing)
    })
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureHostRole(makeHost('rotated-secret'))
      expect(existing?.rules?.length).toBeGreaterThan(0)
      expect(rbacApi.replaceNamespacedRole).toHaveBeenCalledOnce()
      expect(updatedRoleLogs(log, '"host-chatllm-config-reader"')).toEqual([
        '[HostReconciler] Updated Role "host-chatllm-config-reader"',
      ])
    } finally {
      log.mockRestore()
    }
  })

  it('NOOP-ROLE-3: extra live rule still replaces once', async () => {
    rbacApi.createNamespacedRole.mockRejectedValue({ code: 409 })
    let existing: k8s.V1Role | undefined
    rbacApi.readNamespacedRole.mockImplementation(() => {
      const live = structuredClone(desiredFromCreate(rbacApi))
      live.rules = [...(live.rules ?? []), { apiGroups: [''], resources: ['pods'], verbs: ['get'] }]
      existing = asApiserverRole(live)
      return Promise.resolve(existing)
    })
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureHostRole(host)
      expect(existing?.rules?.length).toBe((desiredFromCreate(rbacApi).rules?.length ?? 0) + 1)
      expect(rbacApi.replaceNamespacedRole).toHaveBeenCalledOnce()
      expect(updatedRoleLogs(log, '"host-chatllm-config-reader"')).toEqual([
        '[HostReconciler] Updated Role "host-chatllm-config-reader"',
      ])
    } finally {
      log.mockRestore()
    }
  })

  it('NOOP-ROLE-4: extra live secret verb still replaces once', async () => {
    rbacApi.createNamespacedRole.mockRejectedValue({ code: 409 })
    let existing: k8s.V1Role | undefined
    rbacApi.readNamespacedRole.mockImplementation(() => {
      const live = structuredClone(desiredFromCreate(rbacApi))
      const secretRule = live.rules?.find(
        (rule: k8s.V1PolicyRule) => rule.resources?.[0] === 'secrets' && rule.verbs?.includes('get')
      )
      secretRule!.verbs = [...(secretRule!.verbs ?? []), 'update']
      existing = asApiserverRole(live)
      return Promise.resolve(existing)
    })
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureHostRole(host)
      expect(existing?.rules?.some(rule => rule.verbs?.includes('update'))).toBe(true)
      expect(rbacApi.replaceNamespacedRole).toHaveBeenCalledOnce()
      expect(updatedRoleLogs(log, '"host-chatllm-config-reader"')).toEqual([
        '[HostReconciler] Updated Role "host-chatllm-config-reader"',
      ])
    } finally {
      log.mockRestore()
    }
  })
})
