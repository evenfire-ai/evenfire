import { beforeEach, describe, expect, it, vi } from 'vitest'
import { V1PolicyRule } from '@kubernetes/client-node'
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
  makeStubKc,
} from '../../test/__fixtures__/testMocks'
import { HOST_LABEL } from '../constants'
import { HostReconciler } from '../hostReconciler'
import type { HostCRD } from '../types'
import { asApiserverPolicyRule, asApiserverRole, updatedRoleLogs } from './asApiserverRole'

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

function secretGetRule(role: k8s.V1Role): k8s.V1PolicyRule {
  const rule = role.rules?.find(
    (entry: k8s.V1PolicyRule) => entry.resources?.[0] === 'secrets' && entry.verbs?.includes('get')
  )
  if (!rule) throw new Error('desired Role is missing the secrets get rule')
  return rule
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
      const authoredKeys = Object.keys(desiredFromCreate(rbacApi).rules![0] ?? {})
      const liveKeys = Object.keys(existing!.rules![0] ?? {})
      // Author order vs client-node attributeTypeMap — canonicalize must run.
      expect(authoredKeys).toEqual(['apiGroups', 'resources', 'resourceNames', 'verbs'])
      expect(liveKeys).toEqual(['apiGroups', 'resourceNames', 'resources', 'verbs'])
      expect(authoredKeys).not.toEqual(liveKeys)
      const authoredLabelKeys = Object.keys(desiredFromCreate(rbacApi).metadata?.labels ?? {})
      const liveLabelKeys = Object.keys(existing!.metadata?.labels ?? {})
      expect(authoredLabelKeys).not.toEqual(liveLabelKeys)
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
      secretGetRule(live).resourceNames![0] = host.spec.secretRef
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
      const secretRule = secretGetRule(live)
      secretRule.verbs = [...(secretRule.verbs ?? []), 'update']
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

  it('NOOP-ROLE-5: reordered live verbs replace once then converge', async () => {
    rbacApi.createNamespacedRole.mockRejectedValue({ code: 409 })
    let existing: k8s.V1Role | undefined
    let readPass = 0
    rbacApi.readNamespacedRole.mockImplementation(() => {
      readPass += 1
      if (readPass === 1) {
        const live = structuredClone(desiredFromCreate(rbacApi))
        secretGetRule(live).verbs = ['watch', 'get', 'list']
        existing = asApiserverRole(live)
        return Promise.resolve(existing)
      }
      const written = rbacApi.replaceNamespacedRole.mock.calls[0]?.[0].body as
        | k8s.V1Role
        | undefined
      if (!written) throw new Error('NOOP-ROLE-5: second read expected a written Role body')
      existing = asApiserverRole(structuredClone(written))
      return Promise.resolve(existing)
    })
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureHostRole(host)
      expect(secretGetRule(existing!).verbs).toEqual(['watch', 'get', 'list'])
      expect(rbacApi.replaceNamespacedRole).toHaveBeenCalledOnce()
      expect(updatedRoleLogs(log, '"host-chatllm-config-reader"')).toEqual([
        '[HostReconciler] Updated Role "host-chatllm-config-reader"',
      ])

      await (reconciler as any).ensureHostRole(host)
      expect(secretGetRule(existing!).verbs).toEqual(['get', 'watch', 'list'])
      expect(rbacApi.replaceNamespacedRole).toHaveBeenCalledOnce()
      expect(updatedRoleLogs(log, '"host-chatllm-config-reader"')).toEqual([
        '[HostReconciler] Updated Role "host-chatllm-config-reader"',
      ])
    } finally {
      log.mockRestore()
    }
  })

  it('NOOP-ROLE-6: tampered live host label still replaces once', async () => {
    rbacApi.createNamespacedRole.mockRejectedValue({ code: 409 })
    let existing: k8s.V1Role | undefined
    rbacApi.readNamespacedRole.mockImplementation(() => {
      existing = asApiserverRole(desiredFromCreate(rbacApi))
      existing.metadata!.labels![HOST_LABEL] = 'other-host'
      return Promise.resolve(existing)
    })
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureHostRole(host)
      expect(existing?.metadata?.labels?.[HOST_LABEL]).toBe('other-host')
      expect(rbacApi.replaceNamespacedRole).toHaveBeenCalledOnce()
      expect(updatedRoleLogs(log, '"host-chatllm-config-reader"')).toEqual([
        '[HostReconciler] Updated Role "host-chatllm-config-reader"',
      ])
    } finally {
      log.mockRestore()
    }
  })

  it('NOOP-ROLE-7: removed live rule still replaces once', async () => {
    rbacApi.createNamespacedRole.mockRejectedValue({ code: 409 })
    let existing: k8s.V1Role | undefined
    rbacApi.readNamespacedRole.mockImplementation(() => {
      const live = structuredClone(desiredFromCreate(rbacApi))
      live.rules = (live.rules ?? []).filter(rule => rule.resources?.[0] !== 'configmaps')
      existing = asApiserverRole(live)
      return Promise.resolve(existing)
    })
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureHostRole(host)
      expect(existing?.rules?.some(rule => rule.resources?.[0] === 'configmaps')).toBe(false)
      expect(rbacApi.replaceNamespacedRole).toHaveBeenCalledOnce()
      expect(updatedRoleLogs(log, '"host-chatllm-config-reader"')).toEqual([
        '[HostReconciler] Updated Role "host-chatllm-config-reader"',
      ])
    } finally {
      log.mockRestore()
    }
  })

  it('NOOP-ROLE-8: removed live secret resourceName still replaces once', async () => {
    rbacApi.createNamespacedRole.mockRejectedValue({ code: 409 })
    let existing: k8s.V1Role | undefined
    rbacApi.readNamespacedRole.mockImplementation(() => {
      const live = structuredClone(desiredFromCreate(rbacApi))
      const secretRule = secretGetRule(live)
      secretRule.resourceNames = (secretRule.resourceNames ?? []).filter((_, index) => index !== 1)
      existing = asApiserverRole(live)
      return Promise.resolve(existing)
    })
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureHostRole(host)
      expect(secretGetRule(existing!).resourceNames).toHaveLength(
        (secretGetRule(desiredFromCreate(rbacApi)).resourceNames?.length ?? 0) - 1
      )
      expect(rbacApi.replaceNamespacedRole).toHaveBeenCalledOnce()
      expect(updatedRoleLogs(log, '"host-chatllm-config-reader"')).toEqual([
        '[HostReconciler] Updated Role "host-chatllm-config-reader"',
      ])
    } finally {
      log.mockRestore()
    }
  })

  it('NOOP-ROLE-9: extra live admission label skips replace', async () => {
    rbacApi.createNamespacedRole.mockRejectedValue({ code: 409 })
    let existing: k8s.V1Role | undefined
    rbacApi.readNamespacedRole.mockImplementation(() => {
      existing = asApiserverRole(desiredFromCreate(rbacApi))
      existing.metadata!.labels!['argocd.argoproj.io/instance'] = 'clerum-dev'
      return Promise.resolve(existing)
    })
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureHostRole(host)
      expect(existing?.metadata?.labels?.['argocd.argoproj.io/instance']).toBe('clerum-dev')
      expect(rbacApi.replaceNamespacedRole).not.toHaveBeenCalled()
      expect(updatedRoleLogs(log, '"host-chatllm-config-reader"')).toEqual([])
    } finally {
      log.mockRestore()
    }
  })

  it('FIXTURE-ROLE-1: asApiserverPolicyRule follows V1PolicyRule.attributeTypeMap', () => {
    expect(V1PolicyRule.getAttributeTypeMap().map(entry => entry.name)).toEqual([
      'apiGroups',
      'nonResourceURLs',
      'resourceNames',
      'resources',
      'verbs',
    ])
    expect(
      Object.keys(
        asApiserverPolicyRule({
          apiGroups: [''],
          resources: ['secrets'],
          resourceNames: ['x'],
          verbs: ['get'],
        })
      )
    ).toEqual(['apiGroups', 'resourceNames', 'resources', 'verbs'])
  })
})
