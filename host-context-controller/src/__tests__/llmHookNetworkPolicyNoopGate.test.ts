import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import {
  type MockCoreApi,
  type MockNetworkingApi,
  asAppsApi,
  asCoreApi,
  asCustomApi,
  asNetworkingApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockCustomApi,
  createMockNetworkingApi,
} from '../../test/__fixtures__/testMocks'
import { updatedLogs } from '../../test/__fixtures__/updatedLogs'
import {
  HOST_LABEL,
  LLMHOOK_LABEL,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  POLICY_TYPE_LABEL,
} from '../constants'
import { LlmHookReconciler, computePodKey, serviceTargetNpName } from '../llmHookReconciler'
import type { HostCRD, LlmHookCRD } from '../types'
import { asApiserverNetworkPolicy, updatedPolicyLogs } from './asApiserverNetworkPolicy'

vi.mock('../config', () => ({
  config: {
    llmHooksNamespace: 'llm-hooks',
    hostNamespace: 'mcp-host',
    mcpServerImagePullPolicy: 'IfNotPresent',
  },
}))

const IMG = 'registry.example.com/hook@sha256:' + 'a'.repeat(64)

function makeImageHook(): LlmHookCRD {
  return {
    name: 'pre-hook',
    namespace: 'llm-hooks',
    generation: 1,
    spec: {
      target: { image: { ref: IMG, port: 8080 } },
      path: '/',
      lifecyclePoints: ['preCall'],
    },
  }
}

function makeServiceHook(): LlmHookCRD {
  return {
    name: 'svc-hook',
    namespace: 'llm-hooks',
    generation: 1,
    spec: {
      target: { service: { name: 'hook-svc', namespace: 'llm-hooks', port: 8080 } },
      path: '/',
      lifecyclePoints: ['preCall'],
    },
  }
}

function makeHost(hookId: string): HostCRD {
  return {
    name: 'chatllm',
    namespace: 'mcp-host',
    spec: {
      host: 'chatllm',
      contextRef: 'ctx',
      secretRef: 'secret',
      guardrails: { hooks: { preCall: [{ id: hookId }] } },
    },
  }
}

describe('LlmHook NetworkPolicy no-op gate', () => {
  let networkingApi: MockNetworkingApi
  let coreApi: MockCoreApi
  let reconciler: LlmHookReconciler
  let hooks: Map<string, LlmHookCRD>
  let hosts: Map<string, HostCRD>

  beforeEach(() => {
    networkingApi = createMockNetworkingApi()
    coreApi = createMockCoreApi()
    hooks = new Map()
    hosts = new Map()
    reconciler = new LlmHookReconciler({} as k8s.KubeConfig, hooks, hosts, {
      appsApi: asAppsApi(createMockAppsApi()),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(createMockCustomApi()),
      networkingApi: asNetworkingApi(networkingApi),
    })
    networkingApi.createNamespacedNetworkPolicy.mockRejectedValue({ code: 409 })
  })

  it('NOOP-LLMNP-1: image-hook policy (caller :811) skips replace', async () => {
    const hook = makeImageHook()
    const podKey = computePodKey(hook)!
    const desired = (reconciler as any).buildNetworkPolicy(
      podKey,
      [hook],
      []
    ) as k8s.V1NetworkPolicy
    networkingApi.readNamespacedNetworkPolicy.mockResolvedValue(asApiserverNetworkPolicy(desired))
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureNetworkPolicy(podKey, [hook], [])
      expect(networkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(updatedPolicyLogs(log, `NetworkPolicy "${desired.metadata?.name}"`)).toEqual([])
    } finally {
      log.mockRestore()
    }
  })

  it('NOOP-LLMNP-2: service-target policy (caller :889) skips replace', async () => {
    const hook = makeServiceHook()
    coreApi.readNamespacedService.mockResolvedValue({
      spec: { selector: { app: 'hook-svc' } },
    })
    const desired: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: serviceTargetNpName(hook.name),
        namespace: 'llm-hooks',
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [POLICY_TYPE_LABEL]: 'service-hook-ingress',
          [LLMHOOK_LABEL]: hook.name,
        },
      },
      spec: {
        podSelector: { matchLabels: { app: 'hook-svc' } },
        policyTypes: ['Ingress'],
        ingress: [],
      },
    }
    networkingApi.readNamespacedNetworkPolicy.mockResolvedValue(asApiserverNetworkPolicy(desired))
    await (reconciler as any).ensureServiceTargetNetworkPolicy(hook)
    expect(networkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('NOOP-LLMNP-3: host-egress policy (caller :964) skips replace', async () => {
    const hook = makeImageHook()
    const host = makeHost(hook.name)
    hooks.set(hook.name, hook)
    hosts.set(host.name, host)
    const rules = (await (reconciler as any).buildHostEgressRules(
      host
    )) as k8s.V1NetworkPolicyEgressRule[]
    expect(rules.length).toBeGreaterThan(0)
    const desired: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: `mcp-host-${host.name}-egress-llm-hooks`,
        namespace: 'mcp-host',
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [HOST_LABEL]: host.name,
          [POLICY_TYPE_LABEL]: 'llm-hooks-egress',
        },
      },
      spec: {
        podSelector: {
          matchLabels: { [HOST_LABEL]: host.name, [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
        },
        policyTypes: ['Egress'],
        egress: rules,
      },
    }
    networkingApi.readNamespacedNetworkPolicy.mockResolvedValue(asApiserverNetworkPolicy(desired))
    await (reconciler as any).ensureHostEgressNetworkPolicy(host)
    expect(networkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('WRITE-LLMNP-1: added egress rule replaces once', async () => {
    const hook = makeImageHook()
    const podKey = computePodKey(hook)!
    const empty = (reconciler as any).buildNetworkPolicy(podKey, [hook], []) as k8s.V1NetworkPolicy
    networkingApi.readNamespacedNetworkPolicy.mockResolvedValue(asApiserverNetworkPolicy(empty))
    const extra: k8s.V1NetworkPolicyEgressRule[] = [
      { to: [{ ipBlock: { cidr: '1.2.3.4/32' } }], ports: [{ port: 443, protocol: 'TCP' }] },
    ]
    const log = vi.spyOn(console, 'log')
    try {
      await (reconciler as any).ensureNetworkPolicy(podKey, [hook], extra)
      expect(networkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledOnce()
      expect(updatedLogs(log, 'Updated', 'NetworkPolicy')).toEqual([
        `[LlmHook] Updated NetworkPolicy "${empty.metadata?.name}"`,
      ])
    } finally {
      log.mockRestore()
    }
  })
})
