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
} from '../test/__fixtures__/testMocks'
import { HOOK_PODKEY_LABEL, HOST_LABEL, MANAGED_BY_LABEL, MANAGED_BY_VALUE } from './constants'
import {
  LlmHookReconciler,
  computePodKey,
  podKeyResourceName,
  referencedHookIds,
} from './llmHookReconciler'
import { HostCRD, LlmHookCRD } from './types'

vi.mock('./config', () => ({
  config: {
    devMode: false,
    port: 8081,
    namespace: 'mcp-server',
    controlPlaneNamespace: 'control-plane',
    hostNamespace: 'mcp-host',
    llmHooksNamespace: 'llm-hooks',
    mcpServerImagePullPolicy: 'IfNotPresent',
    runtimeNamespaces: ['mcp-server', 'mcp-host', 'llm-hooks'],
    minimalInfraNamespaces: [],
  },
}))

const IMG = 'registry.example.com/hook@sha256:' + 'a'.repeat(64)

function makeHook(overrides: Partial<LlmHookCRD> & { name: string }): LlmHookCRD {
  const { name, spec, ...rest } = overrides
  return {
    name,
    namespace: 'llm-hooks',
    generation: 1,
    spec: {
      target: { image: { ref: IMG, port: 8080 } },
      path: '/',
      lifecyclePoints: ['preCall'],
      ...spec,
    },
    ...rest,
  }
}

function makeHostRef(name: string, hookIds: string[]): HostCRD {
  return {
    name,
    namespace: 'mcp-host',
    spec: {
      host: name,
      contextRef: 'ctx',
      secretRef: 'secret',
      guardrails: { hooks: { preCall: hookIds.map(id => ({ id })) } },
    },
  }
}

/** Extract the Ready condition from the patchNamespacedCustomObjectStatus calls for a hook. */
function readyConditionFor(customApi: MockCustomApi, name: string) {
  for (let i = customApi.patchNamespacedCustomObjectStatus.mock.calls.length - 1; i >= 0; i--) {
    const arg = customApi.patchNamespacedCustomObjectStatus.mock.calls[i][0] as {
      name: string
      body: Array<{ op: string; path: string; value: unknown }>
    }
    if (arg.name !== name) continue
    const op = arg.body.find(o => o.path === '/status/conditions' || o.path === '/status')
    if (!op) continue
    const conditions = (
      op.path === '/status'
        ? (op.value as { conditions?: Array<Record<string, unknown>> }).conditions
        : (op.value as Array<Record<string, unknown>>)
    ) as Array<Record<string, unknown>> | undefined
    const ready = conditions?.find(c => c.type === 'Ready')
    if (ready) return ready
  }
  return undefined
}

function deploymentNames(appsApi: MockAppsApi): string[] {
  return appsApi.createNamespacedDeployment.mock.calls.map(
    c => (c[0] as { body: k8s.V1Deployment }).body.metadata?.name as string
  )
}

describe('LlmHookReconciler', () => {
  let appsApi: MockAppsApi
  let coreApi: MockCoreApi
  let customApi: MockCustomApi
  let networkingApi: MockNetworkingApi
  let hooks: Map<string, LlmHookCRD>
  let hosts: Map<string, HostCRD>
  let reconciler: LlmHookReconciler

  function build(): LlmHookReconciler {
    return new LlmHookReconciler({} as k8s.KubeConfig, hooks, hosts, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(customApi),
      networkingApi: asNetworkingApi(networkingApi),
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    appsApi = createMockAppsApi()
    coreApi = createMockCoreApi()
    customApi = createMockCustomApi()
    networkingApi = createMockNetworkingApi()
    // Status reads start with an empty conditions object (hasStatusObject true).
    customApi.getNamespacedCustomObjectStatus.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      status: { conditions: [] },
    })
    hooks = new Map()
    hosts = new Map()
    reconciler = build()
  })

  // ─── Pod-key hashing (§10) ─────────────────────────────────────────

  describe('computePodKey', () => {
    it('is identical for identical pod-level fields', () => {
      const a = makeHook({
        name: 'a',
        spec: {
          target: { image: { ref: IMG, port: 8080 } },
          path: '/a',
          lifecyclePoints: ['preCall'],
        },
      })
      const b = makeHook({
        name: 'b',
        spec: {
          target: { image: { ref: IMG, port: 8080 } },
          path: '/b',
          lifecyclePoints: ['moderate'],
        },
      })
      expect(computePodKey(a)).toBe(computePodKey(b))
    })

    it('does NOT depend on path, order, capabilities, failMode', () => {
      const base = makeHook({ name: 'base' })
      const other = makeHook({
        name: 'other',
        spec: {
          target: { image: { ref: IMG, port: 8080 } },
          path: '/deep/path',
          lifecyclePoints: ['onError'],
          order: 5,
          failMode: 'open',
          capabilities: ['may_deny'],
          config: { anything: true },
        },
      })
      expect(computePodKey(other)).toBe(computePodKey(base))
    })

    it('differs on envSecret, egressBindings, and addCapabilities', () => {
      const base = makeHook({ name: 'base' })
      const key = computePodKey(base)
      const diffSecret = makeHook({
        name: 's',
        spec: {
          target: { image: { ref: IMG, port: 8080, envSecret: 'creds' } },
          lifecyclePoints: ['preCall'],
        },
      })
      const diffEgress = makeHook({
        name: 'e',
        spec: {
          target: { image: { ref: IMG, port: 8080, egressBindings: [{ cidr: '8.8.8.8/32' }] } },
          lifecyclePoints: ['preCall'],
        },
      })
      const diffCaps = makeHook({
        name: 'c',
        spec: {
          target: {
            image: { ref: IMG, port: 8080, security: { addCapabilities: ['NET_BIND_SERVICE'] } },
          },
          lifecyclePoints: ['preCall'],
        },
      })
      expect(computePodKey(diffSecret)).not.toBe(key)
      expect(computePodKey(diffEgress)).not.toBe(key)
      expect(computePodKey(diffCaps)).not.toBe(key)
    })

    it('is null for service/remote targets', () => {
      const svc = makeHook({
        name: 'svc',
        spec: {
          target: { service: { name: 'x', namespace: 'y', port: 1 } },
          lifecyclePoints: ['preCall'],
        },
      })
      expect(computePodKey(svc)).toBeNull()
    })

    it('is stable regardless of egressBindings ordering', () => {
      const a = makeHook({
        name: 'a',
        spec: {
          target: {
            image: {
              ref: IMG,
              port: 8080,
              egressBindings: [{ cidr: '8.8.8.8/32' }, { cidr: '1.1.1.1/32' }],
            },
          },
          lifecyclePoints: ['preCall'],
        },
      })
      const b = makeHook({
        name: 'b',
        spec: {
          target: {
            image: {
              ref: IMG,
              port: 8080,
              egressBindings: [{ cidr: '1.1.1.1/32' }, { cidr: '8.8.8.8/32' }],
            },
          },
          lifecyclePoints: ['preCall'],
        },
      })
      expect(computePodKey(a)).toBe(computePodKey(b))
    })
  })

  // ─── Dedup (§10) ───────────────────────────────────────────────────

  it('co-locates two same-pod-key hooks on ONE Deployment/Service', async () => {
    const a = makeHook({
      name: 'a',
      spec: {
        target: { image: { ref: IMG, port: 8080 } },
        path: '/a',
        lifecyclePoints: ['preCall'],
      },
    })
    const b = makeHook({
      name: 'b',
      spec: {
        target: { image: { ref: IMG, port: 8080 } },
        path: '/b',
        lifecyclePoints: ['preCall'],
      },
    })
    hooks.set('a', a)
    hooks.set('b', b)
    await reconciler.reconcile(a)
    await reconciler.reconcile(b)

    const uniqueNames = new Set(deploymentNames(appsApi))
    expect(uniqueNames.size).toBe(1)
    expect([...uniqueNames][0]).toBe(podKeyResourceName(computePodKey(a)!))
  })

  it('distinct pod keys → two Deployments', async () => {
    const a = makeHook({
      name: 'a',
      spec: { target: { image: { ref: IMG, port: 8080 } }, lifecyclePoints: ['preCall'] },
    })
    const b = makeHook({
      name: 'b',
      spec: { target: { image: { ref: IMG, port: 9090 } }, lifecyclePoints: ['preCall'] },
    })
    hooks.set('a', a)
    hooks.set('b', b)
    await reconciler.reconcile(a)
    await reconciler.reconcile(b)
    expect(new Set(deploymentNames(appsApi)).size).toBe(2)
  })

  // ─── Path collision (§10) ──────────────────────────────────────────

  it('fails the path-collision loser closed while serving the winner', async () => {
    const a = makeHook({
      name: 'a',
      spec: {
        target: { image: { ref: IMG, port: 8080 } },
        path: '/dup',
        lifecyclePoints: ['preCall'],
      },
    })
    const b = makeHook({
      name: 'b',
      spec: {
        target: { image: { ref: IMG, port: 8080 } },
        path: '/dup',
        lifecyclePoints: ['preCall'],
      },
    })
    hooks.set('a', a)
    hooks.set('b', b)
    await reconciler.reconcile(a)

    // 'a' (first by sorted name) wins; 'b' loses.
    expect(readyConditionFor(customApi, 'a')?.reason).toBe('Ready')
    expect(readyConditionFor(customApi, 'b')?.status).toBe('False')
    expect(readyConditionFor(customApi, 'b')?.reason).toBe('DuplicatePath')
    // Workload still created for the winner.
    expect(appsApi.createNamespacedDeployment).toHaveBeenCalled()
  })

  // ─── Reference-counted GC (§10) ────────────────────────────────────

  it('keeps the workload when one of two co-tenants is deleted', async () => {
    const a = makeHook({
      name: 'a',
      spec: {
        target: { image: { ref: IMG, port: 8080 } },
        path: '/a',
        lifecyclePoints: ['preCall'],
      },
    })
    const b = makeHook({
      name: 'b',
      spec: {
        target: { image: { ref: IMG, port: 8080 } },
        path: '/b',
        lifecyclePoints: ['preCall'],
      },
    })
    hooks.set('a', a)
    hooks.set('b', b)
    const podKey = computePodKey(a)!

    // Delete 'a' — the watcher evicts it from the cache first.
    hooks.delete('a')
    await reconciler.reconcileDelete('a', podKey)

    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('deletes the workload when the last co-tenant is deleted (label-owned)', async () => {
    const a = makeHook({
      name: 'a',
      spec: { target: { image: { ref: IMG, port: 8080 } }, lifecyclePoints: ['preCall'] },
    })
    const podKey = computePodKey(a)!
    const name = podKeyResourceName(podKey)
    // Read returns HCC-owned labels for this pod key so the delete is authorized.
    const owned = {
      metadata: {
        resourceVersion: '1',
        labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE, [HOOK_PODKEY_LABEL]: podKey },
      },
    }
    appsApi.readNamespacedDeployment.mockResolvedValue(owned)
    coreApi.readNamespacedService.mockResolvedValue(owned)
    networkingApi.readNamespacedNetworkPolicy.mockResolvedValue(owned)

    // Last member gone.
    await reconciler.reconcileDelete('a', podKey)

    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ name, namespace: 'llm-hooks' })
    )
    expect(coreApi.deleteNamespacedService).toHaveBeenCalledWith(expect.objectContaining({ name }))
    expect(networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ name })
    )
  })

  it('does NOT delete a workload whose labels are not HCC-owned', async () => {
    const a = makeHook({
      name: 'a',
      spec: { target: { image: { ref: IMG, port: 8080 } }, lifecyclePoints: ['preCall'] },
    })
    const podKey = computePodKey(a)!
    appsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '1', labels: { [HOOK_PODKEY_LABEL]: 'other-key' } },
    })
    await reconciler.reconcileDelete('a', podKey)
    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('sweeps a label-orphaned workload with 0 members on full reconcile', async () => {
    const orphanKey = 'deadbeefdeadbeef'
    const orphanName = podKeyResourceName(orphanKey)
    appsApi.listNamespacedDeployment.mockResolvedValue({
      items: [
        {
          metadata: {
            name: orphanName,
            labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE, [HOOK_PODKEY_LABEL]: orphanKey },
          },
        },
      ],
    })
    const owned = {
      metadata: {
        resourceVersion: '1',
        labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE, [HOOK_PODKEY_LABEL]: orphanKey },
      },
    }
    appsApi.readNamespacedDeployment.mockResolvedValue(owned)
    coreApi.readNamespacedService.mockResolvedValue(owned)
    networkingApi.readNamespacedNetworkPolicy.mockResolvedValue(owned)

    await reconciler.fullReconcile([]) // no live hooks → orphan has 0 members

    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ name: orphanName })
    )
  })

  // ─── Concurrency (§10) ─────────────────────────────────────────────

  it('serializes concurrent reconciles of two CRs sharing a pod key', async () => {
    let inFlight = 0
    let maxInFlight = 0
    appsApi.createNamespacedDeployment.mockImplementation(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight--
      return {}
    })
    const a = makeHook({
      name: 'a',
      spec: {
        target: { image: { ref: IMG, port: 8080 } },
        path: '/a',
        lifecyclePoints: ['preCall'],
      },
    })
    const b = makeHook({
      name: 'b',
      spec: {
        target: { image: { ref: IMG, port: 8080 } },
        path: '/b',
        lifecyclePoints: ['preCall'],
      },
    })
    hooks.set('a', a)
    hooks.set('b', b)
    await Promise.all([reconciler.reconcile(a), reconciler.reconcile(b)])
    expect(maxInFlight).toBe(1)
  })

  it('image bump chains teardown of the old pod key and ensure of the new', async () => {
    const oldHook = makeHook({
      name: 'a',
      spec: { target: { image: { ref: IMG, port: 8080 } }, lifecyclePoints: ['preCall'] },
    })
    const oldKey = computePodKey(oldHook)!
    const newHook = makeHook({
      name: 'a',
      spec: { target: { image: { ref: IMG, port: 9090 } }, lifecyclePoints: ['preCall'] },
    })
    const newKey = computePodKey(newHook)!
    // Cache holds only the NEW hook after the MODIFIED event; old key has 0 members.
    hooks.set('a', newHook)
    const ownedOld = {
      metadata: {
        resourceVersion: '1',
        labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE, [HOOK_PODKEY_LABEL]: oldKey },
      },
    }
    appsApi.readNamespacedDeployment.mockResolvedValue(ownedOld)
    coreApi.readNamespacedService.mockResolvedValue(ownedOld)
    networkingApi.readNamespacedNetworkPolicy.mockResolvedValue(ownedOld)

    await reconciler.reconcile(newHook, oldKey)

    // Old pod key torn down…
    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ name: podKeyResourceName(oldKey) })
    )
    // …new pod key created.
    expect(deploymentNames(appsApi)).toContain(podKeyResourceName(newKey))
  })

  // ─── NetworkPolicy ingress reverse-index (§10) ─────────────────────

  it('NetworkPolicy ingress admits exactly the referencing Hosts', async () => {
    const a = makeHook({
      name: 'a',
      spec: { target: { image: { ref: IMG, port: 8080 } }, lifecyclePoints: ['preCall'] },
    })
    hooks.set('a', a)
    hosts.set('host-1', makeHostRef('host-1', ['a']))
    hosts.set('host-2', makeHostRef('host-2', ['other-hook'])) // does NOT reference 'a'

    await reconciler.reconcile(a)

    const npCall = networkingApi.createNamespacedNetworkPolicy.mock.calls.at(-1)![0] as {
      body: k8s.V1NetworkPolicy
    }
    const ingress = npCall.body.spec?.ingress ?? []
    const peers = (ingress[0]?._from ?? []) as Array<{
      podSelector?: { matchLabels?: Record<string, string> }
    }>
    const hostSelectors = peers.map(p => p.podSelector?.matchLabels?.[HOST_LABEL])
    expect(hostSelectors).toContain('host-1')
    expect(hostSelectors).not.toContain('host-2')
  })

  it('co-located members: NetworkPolicy label values are comma-free (member list is an annotation)', async () => {
    // Two hooks with the SAME image target share one pod key → one shared NP.
    const a = makeHook({
      name: 'a',
      spec: {
        target: { image: { ref: IMG, port: 8080 } },
        path: '/a',
        lifecyclePoints: ['preCall'],
      },
    })
    const b = makeHook({
      name: 'b',
      spec: {
        target: { image: { ref: IMG, port: 8080 } },
        path: '/b',
        lifecyclePoints: ['preCall'],
      },
    })
    hooks.set('a', a)
    hooks.set('b', b)
    await reconciler.reconcile(a)

    const npCall = networkingApi.createNamespacedNetworkPolicy.mock.calls.at(-1)![0] as {
      body: k8s.V1NetworkPolicy
    }
    // K8s label values may not contain commas; a comma-joined multi-member value
    // would 422 at the apiserver — the exact digest-dedup case.
    for (const value of Object.values(npCall.body.metadata?.labels ?? {})) {
      expect(value).not.toContain(',')
    }
    // The member list belongs in an annotation, where commas are valid.
    expect(npCall.body.metadata?.annotations?.['clerum.io/llmhook-members']).toBe('a,b')
  })

  it('re-reconciles NetworkPolicy ingress on a Host reference change (fan-out)', async () => {
    const a = makeHook({
      name: 'a',
      spec: { target: { image: { ref: IMG, port: 8080 } }, lifecyclePoints: ['preCall'] },
    })
    hooks.set('a', a)
    // Host newly references 'a'.
    hosts.set('host-1', makeHostRef('host-1', ['a']))

    await reconciler.reconcileNetworkPoliciesForHooks(['a'])

    expect(networkingApi.createNamespacedNetworkPolicy).toHaveBeenCalled()
    const npCall = networkingApi.createNamespacedNetworkPolicy.mock.calls.at(-1)![0] as {
      body: k8s.V1NetworkPolicy
    }
    const peers = (npCall.body.spec?.ingress?.[0]?._from ?? []) as Array<{
      podSelector?: { matchLabels?: Record<string, string> }
    }>
    expect(peers.map(p => p.podSelector?.matchLabels?.[HOST_LABEL])).toContain('host-1')
  })

  it('rejects an invalid (private-range) egress binding without exposing the workload', async () => {
    const a = makeHook({
      name: 'a',
      spec: {
        target: {
          image: { ref: IMG, port: 8080, egressBindings: [{ cidr: '10.0.0.0/8', ports: [443] }] },
        },
        lifecyclePoints: ['preCall'],
      },
    })
    hooks.set('a', a)
    await reconciler.reconcile(a)

    expect(readyConditionFor(customApi, 'a')?.status).toBe('False')
    expect(readyConditionFor(customApi, 'a')?.reason).toBe('InvalidEgress')
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('allows a valid public-CIDR egress binding as an Egress NetworkPolicy rule', async () => {
    const a = makeHook({
      name: 'a',
      spec: {
        target: {
          image: { ref: IMG, port: 8080, egressBindings: [{ cidr: '8.8.8.8/32', ports: [443] }] },
        },
        lifecyclePoints: ['preCall'],
      },
    })
    hooks.set('a', a)
    await reconciler.reconcile(a)

    const npCall = networkingApi.createNamespacedNetworkPolicy.mock.calls.at(-1)![0] as {
      body: k8s.V1NetworkPolicy
    }
    expect(npCall.body.spec?.egress?.[0]?.to?.[0]?.ipBlock?.cidr).toBe('8.8.8.8/32')
    expect(appsApi.createNamespacedDeployment).toHaveBeenCalled()
  })

  // ─── Secret gate ───────────────────────────────────────────────────

  it('fails closed with SecretNotFound when envSecret is missing', async () => {
    const a = makeHook({
      name: 'a',
      spec: {
        target: { image: { ref: IMG, port: 8080, envSecret: 'missing' } },
        lifecyclePoints: ['preCall'],
      },
    })
    hooks.set('a', a)
    coreApi.readNamespacedSecret.mockRejectedValue({ code: 404 })
    await reconciler.reconcile(a)

    expect(readyConditionFor(customApi, 'a')?.reason).toBe('SecretNotFound')
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  // ─── Status shape (§10) ────────────────────────────────────────────

  it('writes NoWorkload Ready=True for service/remote targets (nothing deployed)', async () => {
    const svc = makeHook({
      name: 'svc',
      spec: {
        target: { service: { name: 'x', namespace: 'y', port: 1 } },
        lifecyclePoints: ['preCall'],
      },
    })
    hooks.set('svc', svc)
    await reconciler.reconcile(svc)

    expect(readyConditionFor(customApi, 'svc')?.status).toBe('True')
    expect(readyConditionFor(customApi, 'svc')?.reason).toBe('NoWorkload')
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('writes conditions[] + observedDigest + readyReplicas for a ready image hook', async () => {
    const digest = 'sha256:' + 'b'.repeat(64)
    coreApi.listNamespacedPod.mockResolvedValue({
      items: [
        { status: { containerStatuses: [{ imageID: `docker.io/x@${digest}`, image: IMG }] } },
      ],
    })
    const a = makeHook({
      name: 'a',
      spec: { target: { image: { ref: IMG, port: 8080 } }, lifecyclePoints: ['preCall'] },
    })
    hooks.set('a', a)
    await reconciler.reconcile(a)

    const patch = customApi.patchNamespacedCustomObjectStatus.mock.calls.at(-1)![0] as {
      body: Array<{ op: string; path: string; value: unknown }>
    }
    const paths = patch.body.map(o => o.path)
    expect(paths).toContain('/status/conditions')
    expect(paths).toContain('/status/observedDigest')
    expect(paths).toContain('/status/readyReplicas')
    const digestOp = patch.body.find(o => o.path === '/status/observedDigest')
    expect(digestOp?.value).toBe(digest)
    expect(readyConditionFor(customApi, 'a')?.reason).toBe('Ready')
  })

  // ─── referencedHookIds helper ──────────────────────────────────────

  it('referencedHookIds collects ids across all guardrail phases', () => {
    const host: HostCRD = {
      name: 'h',
      namespace: 'mcp-host',
      spec: {
        host: 'h',
        contextRef: 'ctx',
        secretRef: 's',
        guardrails: {
          hooks: {
            preCall: [{ id: 'x' }],
            postCallSuccess: [{ id: 'y', digest: 'sha256:...' }],
            moderate: [{ id: 'x' }],
          },
        },
      },
    }
    expect(new Set(referencedHookIds(host))).toEqual(new Set(['x', 'y', 'x']))
    expect(referencedHookIds(undefined)).toEqual([])
  })
})
