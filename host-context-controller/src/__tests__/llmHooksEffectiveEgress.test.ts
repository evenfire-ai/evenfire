import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import {
  type MockAppsApi,
  type MockCoreApi,
  type MockCustomApi,
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
import { config } from '../config'
import { HOOK_PODKEY_LABEL, MANAGED_BY_LABEL, MANAGED_BY_VALUE } from '../constants'
import { LlmHookReconciler, computePodKey, podKeyResourceName } from '../llmHookReconciler'
import { NetworkPolicyReconciler } from '../networkPolicyReconciler'
import type { HostCRD, LlmHookCRD } from '../types'

/**
 * N5 ("no implicit DNS") asserted at the level the invariant is actually stated:
 * a pod's EFFECTIVE egress, which is the union of every NetworkPolicy selecting
 * it — not one policy in isolation. `llmHookReconciler.test.ts` inspects the
 * per-pod-key policy alone, so it cannot see a namespace-wide policy handing the
 * same pod DNS. That blind spot is exactly how llm-hooks in `runtimeNamespaces`
 * granted every hook pod kube-system:53 while that test stayed green.
 *
 * Deliberately runs against the REAL config module: the point is the shipped
 * default, so re-adding llm-hooks to `runtimeNamespaces` (or any future infra
 * policy selecting hook pods) must fail here.
 */

const IMG = 'registry.example.com/hook@sha256:' + 'a'.repeat(64)

function makeHook(name: string, spec: Partial<LlmHookCRD['spec']> = {}): LlmHookCRD {
  return {
    name,
    namespace: config.llmHooksNamespace,
    generation: 1,
    spec: {
      target: { image: { ref: IMG, port: 8080 } },
      path: '/',
      lifecyclePoints: ['preCall'],
      ...spec,
    },
  }
}

function makeHostRef(name: string, hookIds: string[]): HostCRD {
  return {
    name,
    namespace: config.hostNamespace,
    spec: {
      host: name,
      contextRef: 'ctx',
      secretRef: 'secret',
      guardrails: { hooks: { preCall: hookIds.map(id => ({ id })) } },
    },
  }
}

/** The labels HCC stamps on a hook pod template (llmHookReconciler.podKeyLabels). */
function hookPodLabels(hook: LlmHookCRD): Record<string, string> {
  const podKey = computePodKey(hook)!
  return {
    app: podKeyResourceName(podKey),
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    [HOOK_PODKEY_LABEL]: podKey,
  }
}

/**
 * Does `selector` select a pod carrying `labels`? An empty selector selects every
 * pod in the namespace — the case that matters most here. matchExpressions is
 * unsupported on purpose: silently treating it as "no match" would under-report
 * reachable egress, so it throws instead.
 */
function selects(
  selector: k8s.V1LabelSelector | undefined,
  labels: Record<string, string>
): boolean {
  if (selector?.matchExpressions?.length) {
    throw new Error('matchExpressions selector is not modelled — extend selects() before using it')
  }
  const matchLabels = selector?.matchLabels
  if (!matchLabels || Object.keys(matchLabels).length === 0) return true
  return Object.entries(matchLabels).every(([k, v]) => labels[k] === v)
}

describe('llm-hooks effective pod egress (N5)', () => {
  let appsApi: MockAppsApi
  let coreApi: MockCoreApi
  let customApi: MockCustomApi
  let networkingApi: MockNetworkingApi
  let hooks: Map<string, LlmHookCRD>
  let hosts: Map<string, HostCRD>

  /** Every policy written into the llm-hooks namespace, by either reconciler. */
  function policiesInLlmHooksNamespace(): k8s.V1NetworkPolicy[] {
    const written = [
      ...networkingApi.createNamespacedNetworkPolicy.mock.calls,
      ...networkingApi.replaceNamespacedNetworkPolicy.mock.calls,
    ] as Array<[{ namespace?: string; body?: k8s.V1NetworkPolicy }]>
    return written
      .map(([arg]) => arg)
      .filter(arg => arg?.namespace === config.llmHooksNamespace && arg.body)
      .map(arg => arg.body!)
  }

  /** Policies from that set which actually select the given pod. */
  function policiesSelecting(labels: Record<string, string>): k8s.V1NetworkPolicy[] {
    return policiesInLlmHooksNamespace().filter(p => selects(p.spec?.podSelector, labels))
  }

  /** The egress rules a pod can actually use: the union across selecting policies. */
  function effectiveEgress(labels: Record<string, string>): k8s.V1NetworkPolicyEgressRule[] {
    return policiesSelecting(labels).flatMap(p =>
      p.spec?.policyTypes?.includes('Egress') ? (p.spec?.egress ?? []) : []
    )
  }

  async function reconcileAll(hook: LlmHookCRD): Promise<void> {
    const hookReconciler = new LlmHookReconciler({} as k8s.KubeConfig, hooks, hosts, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(customApi),
      networkingApi: asNetworkingApi(networkingApi),
    })
    const kc = {
      makeApiClient: (type: unknown) =>
        type === k8s.NetworkingV1Api ? asNetworkingApi(networkingApi) : asCustomApi(customApi),
    } as unknown as k8s.KubeConfig
    const netPolReconciler = new NetworkPolicyReconciler(kc, new Map())

    await hookReconciler.reconcile(hook)
    await netPolReconciler.ensureDefaultPolicies()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    appsApi = createMockAppsApi()
    coreApi = createMockCoreApi()
    customApi = createMockCustomApi()
    networkingApi = createMockNetworkingApi()
    customApi.getNamespacedCustomObjectStatus.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      status: { conditions: [] },
    })
    hooks = new Map()
    hosts = new Map()
  })

  it('leaves a pure responder pod with no egress at all — not even DNS', async () => {
    const responder = makeHook('resp')
    hooks.set('resp', responder)
    hosts.set('host-1', makeHostRef('host-1', ['resp']))

    await reconcileAll(responder)

    expect(effectiveEgress(hookPodLabels(responder))).toEqual([])
  })

  it('names no namespace-wide egress policy in llm-hooks', async () => {
    const responder = makeHook('resp')
    hooks.set('resp', responder)

    await reconcileAll(responder)

    // The failure mode this guards: allow-dns-egress-<ns> / allow-hcc-api-egress-<ns>
    // appear the moment llm-hooks is listed in runtimeNamespaces.
    const egressPolicyNames = policiesInLlmHooksNamespace()
      .filter(p => p.spec?.policyTypes?.includes('Egress'))
      .map(p => p.metadata?.name)
    expect(egressPolicyNames).not.toContain(`allow-dns-egress-${config.llmHooksNamespace}`)
    expect(egressPolicyNames).not.toContain(`allow-hcc-api-egress-${config.llmHooksNamespace}`)
  })

  // Positive control: without this, the two assertions above would also pass if
  // effectiveEgress() were simply blind to egress rules.
  it('does surface the egress a declaring hook is granted (scoped DNS + its target)', async () => {
    const dialer = makeHook('dialer', {
      target: {
        image: { ref: IMG, port: 8080, egressBindings: [{ cidr: '8.8.8.8/32', ports: [443] }] },
      },
    })
    hooks.set('dialer', dialer)

    await reconcileAll(dialer)

    const egress = effectiveEgress(hookPodLabels(dialer))
    expect(egress).not.toEqual([])
    // its declared target …
    expect(egress.some(r => r.to?.some(t => t.ipBlock?.cidr === '8.8.8.8/32'))).toBe(true)
    // … plus the scoped CoreDNS allow that resolving it requires.
    expect(egress.some(r => r.ports?.some(p => p.port === 53))).toBe(true)
  })
})
