import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import type { RecordWithTtl } from 'node:dns'
import * as dns from 'node:dns/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { asApiserverNetworkPolicy } from './__tests__/asApiserverNetworkPolicy'
import { confirmAuthoritativeMcpServerAbsence } from './mcpServerSafety'
import {
  networkPolicySafetyPassDurationSeconds,
  networkPolicySafetyPassPoliciesTotal,
} from './metrics'
import {
  DESIRED_NETWORKPOLICY_INVENTORY_CHANGED_MESSAGE,
  NetworkPolicyReconciler,
  PUBLIC_EGRESS_EXCEPT_CIDRS,
  sameContextDesiredRevision,
} from './networkPolicyReconciler'
import { ContextCRD, McpServerCRD } from './types'

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

vi.mock('./mcpServerSafety', async () => {
  const actual = await vi.importActual<typeof import('./mcpServerSafety')>('./mcpServerSafety')
  return {
    ...actual,
    confirmAuthoritativeMcpServerAbsence: vi.fn(actual.confirmAuthoritativeMcpServerAbsence),
  }
})

// resolve4({ ttl: true }) returns RecordWithTtl[]; `rec` builds that shape and
// `resolve4Mock` sidesteps the string[]/RecordWithTtl[] overload inference.
const rec = (...ips: string[]): RecordWithTtl[] => ips.map(address => ({ address, ttl: 300 }))
const resolve4Mock = vi.mocked(dns.resolve4) as unknown as Mock

// Mock config
vi.mock('./config', () => ({
  config: {
    namespace: 'mcp-server',
    controlPlaneNamespace: 'control-plane',
    hostNamespace: 'mcp-host',
    rpcProxyNamespace: 'rpc-proxy',
    port: 8081,
    runtimeNamespaces: ['mcp-server', 'mcp-host', 'sandbox-recipes', 'rpc-proxy'],
    k8sApiCidrs: [],
    externalEgressDnsResolveTimeoutMs: 5_000,
    // #299 sliding-window knobs read by reconcileExternalEgress.
    externalEgressOverlapSec: 300,
    externalEgressMaxEntries: 128,
  },
}))

// Mock dns. Production now calls resolve4(host, { ttl: true }) for the #299
// sliding window, so the resolver returns RecordWithTtl[] ({ address, ttl }),
// not string[]. `rec()` builds that shape; `resolve4Mock` is the loosely-typed
// mock accessor (resolve4's overloads otherwise infer the string[] return).
vi.mock('node:dns/promises', () => ({
  resolve4: vi.fn().mockResolvedValue([
    { address: '1.2.3.4', ttl: 300 },
    { address: '5.6.7.8', ttl: 300 },
  ]),
}))

vi.mock('./metrics', () => ({
  networkPolicySafetyPassDurationSeconds: { observe: vi.fn() },
  networkPolicySafetyPassPoliciesTotal: { inc: vi.fn() },
}))

function makeMockNetworkingApi() {
  return {
    createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    readNamespacedNetworkPolicy: vi.fn().mockImplementation(async ({ name }) => {
      if (
        name === 'allow-desktop-egress-rpc-proxy' ||
        name === 'allow-rpc-proxy-to-managed-mcp-servers'
      ) {
        throw Object.assign(new Error('not found'), { code: 404 })
      }
      return { metadata: { resourceVersion: '1' } }
    }),
    replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    listNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ items: [] }),
    deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
  }
}

function makeMockCustomApi() {
  return {
    getNamespacedCustomObject: vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('not found'), { code: 404 })),
    listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    getNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({
      metadata: {
        generation: 7,
        resourceVersion: 'status-rv-default',
      },
      status: {},
    }),
    patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
  }
}

function makeReconciler(
  mockApi: ReturnType<typeof makeMockNetworkingApi>,
  serverCache?: Map<string, McpServerCRD>,
  mockCustomApi: ReturnType<typeof makeMockCustomApi> = makeMockCustomApi()
): NetworkPolicyReconciler {
  const kc = new k8s.KubeConfig()
  kc.loadFromOptions({
    clusters: [{ name: 'test', server: 'https://test' }],
    users: [{ name: 'test' }],
    contexts: [{ name: 'test', cluster: 'test', user: 'test' }],
    currentContext: 'test',
  })
  const cache = serverCache ?? new Map()
  const reconciler = new NetworkPolicyReconciler(kc, cache)
  const listedPolicies = new Map<string, k8s.V1NetworkPolicy>()
  const networkingApi = {
    ...mockApi,
    listNamespacedNetworkPolicy: async (args: { namespace: string }) => {
      const response = await mockApi.listNamespacedNetworkPolicy(args)
      const items = (response.items ?? []).map((policy: k8s.V1NetworkPolicy, index: number) => {
        const name = policy.metadata?.name ?? `unnamed-${index}`
        const materialized = {
          ...policy,
          metadata: {
            ...policy.metadata,
            name,
            namespace: policy.metadata?.namespace ?? args.namespace,
            uid: policy.metadata?.uid ?? `${args.namespace}:${name}:uid`,
            resourceVersion: policy.metadata?.resourceVersion ?? '1',
          },
        }
        listedPolicies.set(`${args.namespace}/${name}`, materialized)
        return materialized
      })
      return { ...response, items }
    },
    readNamespacedNetworkPolicy: async (args: { name: string; namespace: string }) => {
      const response = await mockApi.readNamespacedNetworkPolicy(args)
      const listed = listedPolicies.get(`${args.namespace}/${args.name}`)
      return {
        ...listed,
        ...response,
        metadata: {
          ...listed?.metadata,
          ...response.metadata,
          name: response.metadata?.name ?? listed?.metadata?.name ?? args.name,
          namespace: response.metadata?.namespace ?? listed?.metadata?.namespace ?? args.namespace,
          uid:
            response.metadata?.uid ?? listed?.metadata?.uid ?? `${args.namespace}:${args.name}:uid`,
          resourceVersion:
            response.metadata?.resourceVersion ?? listed?.metadata?.resourceVersion ?? '1',
        },
      }
    },
  }
  ;(reconciler as unknown as { networkingApi: unknown }).networkingApi = networkingApi
  ;(reconciler as unknown as { customApi: unknown }).customApi = mockCustomApi
  return reconciler
}

describe('NetworkPolicyReconciler Codex boundary', () => {
  it('does not derive Codex scope or proxy egress - that belongs to HostReconciler', () => {
    const source = readFileSync(join(__dirname, 'networkPolicyReconciler.ts'), 'utf8')
    expect(source).not.toContain('llm:codex:execute')
    expect(source).not.toContain('codex-llm-proxy')
    expect(source).not.toContain('codex-proxy-egress')
  })
})

describe('NetworkPolicyReconciler', () => {
  let mockApi: ReturnType<typeof makeMockNetworkingApi>
  let mockCustomApi: ReturnType<typeof makeMockCustomApi>
  let reconciler: NetworkPolicyReconciler

  beforeEach(() => {
    vi.useRealTimers()
    mockApi = makeMockNetworkingApi()
    mockCustomApi = makeMockCustomApi()
    reconciler = makeReconciler(mockApi, undefined, mockCustomApi)
    vi.clearAllMocks()
    resolve4Mock.mockResolvedValue(rec('1.2.3.4', '5.6.7.8'))
  })

  it('compares Context desired revisions canonically and fences identity changes', () => {
    const expected: ContextCRD = {
      name: 'default',
      namespace: 'mcp-server',
      uid: 'context-uid',
      generation: 7,
      spec: {
        contextId: 'default',
        mcpServers: ['alpha'],
        sharedFileSystems: [{ name: 'workspace', mountPath: '/workspace' }],
      },
    }
    const reordered: ContextCRD = {
      namespace: 'mcp-server',
      name: 'default',
      generation: 7,
      uid: 'context-uid',
      spec: {
        sharedFileSystems: [{ mountPath: '/workspace', name: 'workspace' }],
        mcpServers: ['alpha'],
        contextId: 'default',
      },
    }

    expect(sameContextDesiredRevision(expected, reordered)).toBe(true)
    expect(sameContextDesiredRevision(expected, { ...reordered, uid: 'replacement-uid' })).toBe(
      false
    )
    expect(sameContextDesiredRevision(expected, { ...reordered, generation: 8 })).toBe(false)
  })

  it('records the authoritative safety-pass inventory, completed revocations, and duration', async () => {
    mockApi.listNamespacedNetworkPolicy
      .mockResolvedValueOnce({
        items: [
          {
            metadata: {
              name: 'orphan-context',
              labels: { 'clerum.io/context': 'missing-context' },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          {
            metadata: {
              name: 'orphan-host-egress',
              labels: { 'clerum.io/context': 'missing-context' },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          {
            metadata: {
              name: 'orphan-rpc-egress',
              labels: { 'clerum.io/context': 'missing-context' },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          {
            metadata: {
              name: 'orphan-external-egress',
              labels: { 'clerum.io/mcpserver': 'missing-server' },
            },
          },
        ],
      })
    const complete = vi.fn()

    await reconciler.fullReconcile([], [], {
      ensureDefaults: false,
      onAuthoritativeRevocationComplete: complete,
    })

    expect(complete).toHaveBeenCalledOnce()
    expect(networkPolicySafetyPassPoliciesTotal.inc).toHaveBeenCalledWith(
      { operation: 'listed' },
      4
    )
    expect(networkPolicySafetyPassPoliciesTotal.inc).toHaveBeenCalledWith(
      { operation: 'revoked' },
      4
    )
    expect(networkPolicySafetyPassDurationSeconds.observe).toHaveBeenCalledWith(
      { outcome: 'completed' },
      expect.any(Number)
    )
    expect(networkPolicySafetyPassDurationSeconds.observe).toHaveBeenCalledTimes(1)
  })

  describe('public egress blocklist parity', () => {
    it('keeps the HCC and WRC IPv4 exclusion lists in sync', () => {
      const wrcFactory = readFileSync(
        join(process.cwd(), '..', 'workflow-recipes', 'src', 'workflow', 'networkPolicyFactory.ts'),
        'utf8'
      )
      const match = wrcFactory.match(
        /export const PUBLIC_HTTP_EGRESS_EXCEPT_CIDRS = \[([\s\S]*?)\]/
      )
      expect(match).toBeTruthy()
      const wrcCidrs = [...match![1].matchAll(/'([^']+)'/g)].map(item => item[1])

      expect([...PUBLIC_EGRESS_EXCEPT_CIDRS].sort()).toEqual([...wrcCidrs].sort())
    })
  })

  // ─── L0: Default Deny ──────────────────────────────────────────────

  describe('L0 — ensureDefaultDeny', () => {
    it('creates deny-all policies in every runtime namespace', async () => {
      await reconciler.ensureDefaultPolicies()

      const denyPolicies = mockApi.createNamespacedNetworkPolicy.mock.calls.filter(
        (call: unknown[]) => {
          const arg = call[0] as { body: { metadata: { labels: Record<string, string> } } }
          return arg.body.metadata.labels['clerum.io/policy-type'] === 'default-deny'
        }
      )
      expect(denyPolicies.length).toBe(4) // mcp-server, mcp-host, sandbox-recipes, rpc-proxy
    })

    it('includes both Ingress and Egress in policyTypes', async () => {
      await reconciler.ensureDefaultPolicies()

      const denyPolicy = mockApi.createNamespacedNetworkPolicy.mock.calls.find(
        (call: unknown[]) => {
          const arg = call[0] as { body: { metadata: { name: string } } }
          return arg.body.metadata.name.startsWith('deny-all-')
        }
      )
      expect(denyPolicy).toBeDefined()
      const spec = (denyPolicy![0] as { body: { spec: { policyTypes: string[] } } }).body.spec
      expect(spec.policyTypes).toEqual(['Ingress', 'Egress'])
    })

    it('uses empty podSelector (selects all pods)', async () => {
      await reconciler.ensureDefaultPolicies()

      const denyPolicy = mockApi.createNamespacedNetworkPolicy.mock.calls.find(
        (call: unknown[]) => {
          const arg = call[0] as { body: { metadata: { name: string } } }
          return arg.body.metadata.name.startsWith('deny-all-')
        }
      )
      const spec = (denyPolicy![0] as { body: { spec: { podSelector: object } } }).body.spec
      expect(spec.podSelector).toEqual({})
    })
  })

  // ─── L1: Infrastructure Policies ───────────────────────────────────

  describe('L1 — ensureInfrastructurePolicies', () => {
    it.each([
      ['deny-all-mcp-server', 'default-deny'],
      ['allow-dns-egress-mcp-server', 'infrastructure'],
      ['allow-hcc-api-egress-mcp-server', 'infrastructure'],
      ['allow-k8s-api-egress-mcp-server', 'infrastructure'],
    ])(
      'refuses to adopt a foreign policy that collides with %s',
      async (targetName, policyType) => {
        mockApi.createNamespacedNetworkPolicy.mockImplementation(
          async ({ body }: { body: k8s.V1NetworkPolicy }) => {
            if (body.metadata?.name === targetName) {
              throw Object.assign(new Error('already exists'), { code: 409 })
            }
            return {}
          }
        )
        mockApi.readNamespacedNetworkPolicy.mockImplementation(async ({ name, namespace }) => {
          if (
            name === 'allow-desktop-egress-rpc-proxy' ||
            name === 'allow-rpc-proxy-to-managed-mcp-servers'
          ) {
            throw Object.assign(new Error('not found'), { code: 404 })
          }
          return {
            metadata: {
              name,
              namespace,
              uid: 'foreign-baseline-uid',
              resourceVersion: '7',
              labels: {
                'clerum.io/managed-by': 'foreign-controller',
                'clerum.io/policy-type': policyType,
              },
            },
          }
        })

        await expect(reconciler.ensureDefaultPolicies()).rejects.toThrow(/ownership/i)
        expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
          expect.objectContaining({ name: targetName })
        )
      }
    )

    it('creates DNS egress policies in every runtime namespace', async () => {
      await reconciler.ensureDefaultPolicies()

      const dnsPolicies = mockApi.createNamespacedNetworkPolicy.mock.calls.filter(
        (call: unknown[]) => {
          const arg = call[0] as { body: { metadata: { name: string } } }
          return arg.body.metadata.name.startsWith('allow-dns-egress-')
        }
      )
      expect(dnsPolicies.length).toBe(4)
    })

    it('DNS egress targets kube-system on port 53 UDP+TCP', async () => {
      await reconciler.ensureDefaultPolicies()

      const dnsPolicy = mockApi.createNamespacedNetworkPolicy.mock.calls.find((call: unknown[]) => {
        const arg = call[0] as { body: { metadata: { name: string } } }
        return arg.body.metadata.name === 'allow-dns-egress-mcp-server'
      })
      expect(dnsPolicy).toBeDefined()
      const spec = (
        dnsPolicy![0] as {
          body: { spec: { egress: Array<{ ports: Array<{ port: number; protocol: string }> }> } }
        }
      ).body.spec
      const ports = spec.egress[0].ports
      expect(ports).toContainEqual({ port: 53, protocol: 'UDP' })
      expect(ports).toContainEqual({ port: 53, protocol: 'TCP' })
    })

    it('creates HCC API egress policies', async () => {
      await reconciler.ensureDefaultPolicies()

      const hccPolicies = mockApi.createNamespacedNetworkPolicy.mock.calls.filter(
        (call: unknown[]) => {
          const arg = call[0] as { body: { metadata: { name: string } } }
          return arg.body.metadata.name.startsWith('allow-hcc-api-egress-')
        }
      )
      expect(hccPolicies.length).toBe(4)
      for (const call of hccPolicies) {
        const policy = (
          call[0] as {
            body: {
              spec: {
                egress: Array<{
                  to: Array<{
                    namespaceSelector: { matchLabels: Record<string, string> }
                    podSelector: { matchLabels: Record<string, string> }
                  }>
                }>
              }
            }
          }
        ).body
        expect(policy.spec.egress[0].to[0]).toEqual({
          namespaceSelector: {
            matchLabels: { 'kubernetes.io/metadata.name': 'control-plane' },
          },
          podSelector: {
            matchLabels: { app: 'host-context-controller-api-gateway' },
          },
        })
      }
    })

    it('creates K8s API egress policies', async () => {
      await reconciler.ensureDefaultPolicies()

      const k8sPolicies = mockApi.createNamespacedNetworkPolicy.mock.calls.filter(
        (call: unknown[]) => {
          const arg = call[0] as { body: { metadata: { name: string } } }
          return arg.body.metadata.name.startsWith('allow-k8s-api-egress-')
        }
      )
      expect(k8sPolicies.length).toBe(4)
    })

    it('scopes HCC API egress to the platform pods that need it', async () => {
      await reconciler.ensureDefaultPolicies()

      const policyByName = new Map(
        mockApi.createNamespacedNetworkPolicy.mock.calls.map((call: unknown[]) => {
          const arg = call[0] as {
            body: { metadata: { name: string }; spec: { podSelector: unknown } }
          }
          return [arg.body.metadata.name, arg.body.spec.podSelector]
        })
      )

      expect(policyByName.get('allow-hcc-api-egress-mcp-server')).toEqual({
        matchLabels: { app: 'mcp-proxy' },
      })
      expect(policyByName.get('allow-hcc-api-egress-sandbox-recipes')).toEqual({
        matchLabels: { 'clerum.io/component': 'workflow-mcp-host' },
      })
      expect(policyByName.get('allow-hcc-api-egress-rpc-proxy')).toEqual({
        matchLabels: { app: 'rpc-proxy' },
      })
    })

    it('routes HCC API egress policies to the control-plane gateway', async () => {
      await reconciler.ensureDefaultPolicies()

      const hccPolicies = mockApi.createNamespacedNetworkPolicy.mock.calls
        .map((call: unknown[]) => {
          const arg = call[0] as { body: k8s.V1NetworkPolicy }
          return arg.body
        })
        .filter(policy => policy.metadata?.name?.startsWith('allow-hcc-api-egress-'))

      expect(hccPolicies).toHaveLength(4)
      for (const policy of hccPolicies) {
        const target = policy.spec!.egress![0].to![0]
        expect(target.namespaceSelector!.matchLabels!['kubernetes.io/metadata.name']).toBe(
          'control-plane'
        )
        expect(target.podSelector!.matchLabels!.app).toBe('host-context-controller-api-gateway')
      }
    })

    it('does not grant Kubernetes API egress to runtime workload namespaces by default', async () => {
      await reconciler.ensureDefaultPolicies()

      const policyByName = new Map(
        mockApi.createNamespacedNetworkPolicy.mock.calls.map((call: unknown[]) => {
          const arg = call[0] as {
            body: { metadata: { name: string }; spec: { podSelector: unknown } }
          }
          return [arg.body.metadata.name, arg.body.spec.podSelector]
        })
      )

      expect(policyByName.get('allow-k8s-api-egress-mcp-server')).toEqual({
        matchLabels: { 'clerum.io/k8s-api-egress': 'true' },
      })
      expect(policyByName.get('allow-k8s-api-egress-sandbox-recipes')).toEqual({
        matchLabels: { 'clerum.io/k8s-api-egress': 'true' },
      })
      expect(policyByName.get('allow-k8s-api-egress-rpc-proxy')).toEqual({
        matchLabels: { 'clerum.io/k8s-api-egress': 'true' },
      })
    })

    it('infrastructure policies have correct policy-type label', async () => {
      await reconciler.ensureDefaultPolicies()

      const infraPolicies = mockApi.createNamespacedNetworkPolicy.mock.calls.filter(
        (call: unknown[]) => {
          const arg = call[0] as { body: { metadata: { labels: Record<string, string> } } }
          return arg.body.metadata.labels['clerum.io/policy-type'] === 'infrastructure'
        }
      )
      // 4 namespaces × 3 infra policies = 12
      expect(infraPolicies.length).toBe(12)
    })

    it('removes legacy static policies now replaced by generated scoped policies', async () => {
      mockApi.readNamespacedNetworkPolicy.mockImplementation(async ({ name, namespace }) => ({
        metadata: {
          name,
          namespace,
          uid: `${name}-uid`,
          resourceVersion: '7',
          labels: {
            'clerum.io/managed-by': 'host-context-controller',
          },
        },
      }))

      await reconciler.ensureDefaultPolicies()

      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        namespace: 'rpc-proxy',
        name: 'allow-desktop-egress-rpc-proxy',
        body: {
          preconditions: {
            uid: 'allow-desktop-egress-rpc-proxy-uid',
            resourceVersion: '7',
          },
        },
      })
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        namespace: 'mcp-server',
        name: 'allow-rpc-proxy-to-managed-mcp-servers',
        body: {
          preconditions: {
            uid: 'allow-rpc-proxy-to-managed-mcp-servers-uid',
            resourceVersion: '7',
          },
        },
      })
    })

    it.each([
      ['rpc-proxy', 'allow-desktop-egress-rpc-proxy'],
      ['mcp-server', 'allow-rpc-proxy-to-managed-mcp-servers'],
    ])('refuses to delete a foreign legacy policy %s/%s', async (targetNamespace, targetName) => {
      mockApi.readNamespacedNetworkPolicy.mockImplementation(async ({ name, namespace }) => {
        if (name !== targetName) {
          throw Object.assign(new Error('not found'), { code: 404 })
        }
        return {
          metadata: {
            name,
            namespace,
            uid: 'foreign-legacy-uid',
            resourceVersion: '7',
            labels: {
              'clerum.io/managed-by': 'foreign-controller',
            },
          },
        }
      })

      await expect(reconciler.ensureDefaultPolicies()).rejects.toThrow(/ownership/i)
      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
        expect.objectContaining({ namespace: targetNamespace, name: targetName })
      )
    })

    it.each([
      ['rpc-proxy', 'allow-desktop-egress-rpc-proxy'],
      ['mcp-server', 'allow-rpc-proxy-to-managed-mcp-servers'],
    ])(
      'propagates an identity conflict deleting legacy policy %s/%s',
      async (targetNamespace, targetName) => {
        mockApi.readNamespacedNetworkPolicy.mockImplementation(async ({ name, namespace }) => {
          if (name !== targetName) {
            throw Object.assign(new Error('not found'), { code: 404 })
          }
          return {
            metadata: {
              name,
              namespace,
              uid: 'legacy-policy-uid',
              resourceVersion: '7',
              labels: {
                'clerum.io/managed-by': 'host-context-controller',
              },
            },
          }
        })
        const conflict = Object.assign(new Error('identity changed'), { code: 409 })
        mockApi.deleteNamespacedNetworkPolicy.mockImplementation(async ({ name, namespace }) => {
          if (name === targetName && namespace === targetNamespace) throw conflict
          return {}
        })

        await expect(reconciler.ensureDefaultPolicies()).rejects.toBe(conflict)
      }
    )
  })

  // ─── L1: Allow API ─────────────────────────────────────────────────

  describe('L1 — ensureAllowContextMapperApi', () => {
    it('updates the existing HCC-owned allow-api policy without requiring Context owner labels', async () => {
      mockApi.createNamespacedNetworkPolicy.mockImplementation(
        async ({ body }: { body: k8s.V1NetworkPolicy }) => {
          if (body.metadata?.name === 'allow-host-context-controller-api') {
            throw Object.assign(new Error('already exists'), { code: 409 })
          }
          return {}
        }
      )
      mockApi.readNamespacedNetworkPolicy.mockImplementation(async ({ name, namespace }) => ({
        metadata: {
          name,
          namespace,
          uid: 'existing-default-policy-uid',
          resourceVersion: '7',
          labels: {
            'clerum.io/managed-by': 'host-context-controller',
            'clerum.io/policy-type': 'allow-api',
          },
        },
      }))

      await expect(reconciler.ensureDefaultPolicies()).resolves.toBeUndefined()
      expect(mockApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'allow-host-context-controller-api',
          namespace: 'mcp-server',
        })
      )
    })

    it('refuses to adopt a foreign policy that collides with the allow-api policy name', async () => {
      mockApi.createNamespacedNetworkPolicy.mockImplementation(
        async ({ body }: { body: k8s.V1NetworkPolicy }) => {
          if (body.metadata?.name === 'allow-host-context-controller-api') {
            throw Object.assign(new Error('already exists'), { code: 409 })
          }
          return {}
        }
      )
      mockApi.readNamespacedNetworkPolicy.mockResolvedValue({
        metadata: {
          name: 'allow-host-context-controller-api',
          namespace: 'mcp-server',
          uid: 'foreign-default-policy-uid',
          resourceVersion: '7',
          labels: {
            'clerum.io/managed-by': 'foreign-controller',
            'clerum.io/policy-type': 'allow-api',
          },
        },
      })

      await expect(reconciler.ensureDefaultPolicies()).rejects.toThrow(/ownership/i)
      expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('revalidates allow-api ownership after a replace conflict', async () => {
      mockApi.createNamespacedNetworkPolicy.mockImplementation(
        async ({ body }: { body: k8s.V1NetworkPolicy }) => {
          if (body.metadata?.name === 'allow-host-context-controller-api') {
            throw Object.assign(new Error('already exists'), { code: 409 })
          }
          return {}
        }
      )
      mockApi.readNamespacedNetworkPolicy
        .mockResolvedValueOnce({
          metadata: {
            name: 'allow-host-context-controller-api',
            namespace: 'mcp-server',
            uid: 'owned-uid',
            resourceVersion: '7',
            labels: {
              'clerum.io/managed-by': 'host-context-controller',
              'clerum.io/policy-type': 'allow-api',
            },
          },
        })
        .mockResolvedValueOnce({
          metadata: {
            name: 'allow-host-context-controller-api',
            namespace: 'mcp-server',
            uid: 'foreign-uid',
            resourceVersion: '8',
            labels: {
              'clerum.io/managed-by': 'foreign-controller',
              'clerum.io/policy-type': 'allow-api',
            },
          },
        })
      mockApi.replaceNamespacedNetworkPolicy.mockRejectedValueOnce(
        Object.assign(new Error('conflict'), { code: 409 })
      )

      await expect(reconciler.ensureDefaultPolicies()).rejects.toThrow(/ownership/i)
      expect(mockApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    })

    it('creates allow-api ingress policy using _from (K8s client convention)', async () => {
      await reconciler.ensureDefaultPolicies()

      const apiPolicy = mockApi.createNamespacedNetworkPolicy.mock.calls.find((call: unknown[]) => {
        const arg = call[0] as { body: { metadata: { name: string } } }
        return arg.body.metadata.name === 'allow-host-context-controller-api'
      })
      expect(apiPolicy).toBeDefined()
      const spec = (apiPolicy![0] as { body: { spec: Record<string, unknown> } }).body.spec
      expect(spec.policyTypes).toEqual(['Ingress'])
      // _from is correct — K8s client ObjectSerializer maps _from → from
      const ingress = spec.ingress as Array<{ _from?: unknown[] }>
      expect(ingress[0]._from).toBeDefined()
    })
  })

  // ─── L2: Context-Based Policies ────────────────────────────────────

  describe('L2 — reconcileContext', () => {
    it('refuses to adopt a foreign policy that collides with a live Context policy name', async () => {
      const server: McpServerCRD = {
        name: 'mongo',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'mongo:latest',
          transport: { type: 'streamableHttp', port: 3000 },
        },
      }
      const rec = makeReconciler(mockApi, new Map([[server.name, server]]))
      const context: ContextCRD = {
        name: 'dev',
        namespace: 'mcp-server',
        spec: { contextId: 'dev', mcpServers: [server.name] },
      }
      mockApi.createNamespacedNetworkPolicy.mockRejectedValueOnce(
        Object.assign(new Error('already exists'), { code: 409 })
      )
      mockApi.readNamespacedNetworkPolicy.mockResolvedValueOnce({
        metadata: {
          name: 'ctx-dev-mongo',
          namespace: 'mcp-server',
          uid: 'foreign-uid',
          resourceVersion: '7',
          labels: {
            'clerum.io/managed-by': 'foreign-controller',
            'clerum.io/policy-type': 'context-allow',
            'clerum.io/context': 'dev',
            'clerum.io/mcpserver': 'mongo',
          },
        },
      })

      await expect(rec.reconcileContext(context, { isCurrent: () => true })).rejects.toThrow(
        /ownership/i
      )
      expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('refuses to replace an HCC Context policy owned by a different Context/server pair', async () => {
      const server: McpServerCRD = {
        name: 'b-c',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'a',
          image: 'mongo:latest',
          transport: { type: 'streamableHttp', port: 3000 },
        },
      }
      const rec = makeReconciler(mockApi, new Map([[server.name, server]]))
      const context: ContextCRD = {
        name: 'a',
        namespace: 'mcp-server',
        spec: { contextId: 'a', mcpServers: ['b-c'] },
      }
      mockApi.createNamespacedNetworkPolicy.mockRejectedValueOnce(
        Object.assign(new Error('already exists'), { code: 409 })
      )
      mockApi.readNamespacedNetworkPolicy.mockResolvedValueOnce({
        metadata: {
          name: 'ctx-a-b-c',
          namespace: 'mcp-server',
          uid: 'other-hcc-owner-uid',
          resourceVersion: '7',
          labels: {
            'clerum.io/managed-by': 'host-context-controller',
            'clerum.io/policy-type': 'context-allow',
            'clerum.io/context': 'a-b',
            'clerum.io/mcpserver': 'c',
          },
        },
      })

      await expect(rec.reconcileContext(context, { isCurrent: () => true })).rejects.toThrow(
        /ownership/i
      )
      expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('creates context-allow ingress policy per server in mcp-server namespace', async () => {
      const cache = new Map<string, McpServerCRD>()
      cache.set('mongo', {
        name: 'mongo',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'mongo:latest',
          transport: { type: 'streamableHttp', url: 'http://mongo:3000', port: 3000 },
        },
      })

      const rec = makeReconciler(mockApi, cache)
      const context: ContextCRD = {
        name: 'dev',
        namespace: 'mcp-server',
        spec: { contextId: 'dev', mcpServers: ['mongo'] },
      }

      await rec.reconcileContext(context, { isCurrent: () => true })

      // First call: ingress in mcp-server namespace
      const ingressCall = mockApi.createNamespacedNetworkPolicy.mock.calls[0][0] as {
        body: {
          metadata: { labels: Record<string, string>; namespace: string }
          spec: {
            policyTypes: string[]
            ingress: Array<{
              _from: Array<{
                namespaceSelector: { matchLabels: Record<string, string> }
                podSelector: { matchLabels: Record<string, string> }
              }>
            }>
          }
        }
      }
      expect(ingressCall.body.metadata.labels['clerum.io/policy-type']).toBe('context-allow')
      expect(ingressCall.body.spec.policyTypes).toEqual(['Ingress'])
      expect(ingressCall.body.spec.ingress[0]._from).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'mcp-host' } },
            podSelector: {
              matchLabels: {
                'clerum.io/managed-by': 'host-context-controller',
                'clerum.io/context': 'dev',
              },
            },
          }),
          expect.objectContaining({
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'rpc-proxy' } },
            podSelector: { matchLabels: { app: 'rpc-proxy' } },
          }),
          expect.objectContaining({
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'mcp-server' } },
            podSelector: { matchLabels: { app: 'mcp-proxy' } },
          }),
        ])
      )
    })

    it('retains the ingress policy it just replaced when the authoritative server port changes', async () => {
      const oldServer: McpServerCRD = {
        name: 'mongo',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'mongo:latest',
          transport: { type: 'streamableHttp', port: 3000 },
        },
      }
      const cache = new Map([[oldServer.name, oldServer]])
      const rec = makeReconciler(mockApi, cache)
      const context: ContextCRD = {
        name: 'dev',
        namespace: 'mcp-server',
        spec: { contextId: 'dev', mcpServers: [oldServer.name] },
      }

      await rec.reconcileContext(context, { isCurrent: () => true })
      const livePolicies = new Map(
        mockApi.createNamespacedNetworkPolicy.mock.calls.map(call => {
          const policy = (call[0] as { body: k8s.V1NetworkPolicy }).body
          return [`${policy.metadata?.namespace}/${policy.metadata?.name}`, policy]
        })
      )

      vi.clearAllMocks()
      cache.set(oldServer.name, {
        ...oldServer,
        generation: 2,
        spec: {
          ...oldServer.spec,
          transport: { type: 'streamableHttp', port: 4000 },
        },
      })
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace }: { namespace?: string }) => ({
          items: [...livePolicies.values()].filter(
            policy => policy.metadata?.namespace === namespace
          ),
        })
      )
      mockApi.createNamespacedNetworkPolicy.mockImplementation(async ({ namespace, body }) => {
        livePolicies.set(`${namespace}/${body.metadata?.name}`, body)
        return {}
      })
      mockApi.replaceNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, name, body }) => {
          livePolicies.set(`${namespace}/${name}`, body)
          return {}
        }
      )
      // The delete mock MUST remove from livePolicies, or the port-4000
      // assertion below survives a spurious deletion and the test passes with
      // the bug reinjected (R3-H7).
      mockApi.deleteNamespacedNetworkPolicy.mockImplementation(async ({ namespace, name }) => {
        livePolicies.delete(`${namespace}/${name}`)
        return {}
      })

      await rec.reconcileContext(context, { isCurrent: () => true })

      // Filter the real calls by name+namespace: the production delete always
      // carries `preconditions`, so `not.toHaveBeenCalledWith({name,namespace})`
      // never matched any call and was vacuously true (R3-H7).
      const deletedCtxDevMongo = mockApi.deleteNamespacedNetworkPolicy.mock.calls.some(
        call =>
          (call[0] as { name?: string; namespace?: string })?.name === 'ctx-dev-mongo' &&
          (call[0] as { name?: string; namespace?: string })?.namespace === 'mcp-server'
      )
      expect(deletedCtxDevMongo).toBe(false)
      const ingress = livePolicies.get('mcp-server/ctx-dev-mongo')
      expect(ingress?.spec?.ingress?.[0]?.ports).toEqual([expect.objectContaining({ port: 4000 })])
    })

    it('stops remaining policy mutations after its combined authority lease is retired', async () => {
      const cache = new Map<string, McpServerCRD>()
      cache.set('mongo', {
        name: 'mongo',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'mongo:latest',
          transport: { type: 'streamableHttp', port: 3000 },
        },
      })
      const firstCreateStarted = deferred()
      const releaseFirstCreate = deferred()
      mockApi.createNamespacedNetworkPolicy.mockImplementationOnce(async () => {
        firstCreateStarted.resolve(undefined)
        await releaseFirstCreate.promise
        return {}
      })
      const rec = makeReconciler(mockApi, cache)
      let contextGeneration = 4
      let serverGeneration = 8
      const capturedContextGeneration = contextGeneration
      const capturedServerGeneration = serverGeneration
      const context: ContextCRD = {
        name: 'dev',
        namespace: 'mcp-server',
        spec: { contextId: 'dev', mcpServers: ['mongo'] },
      }

      const reconcile = rec.reconcileContext(context, {
        isCurrent: () =>
          contextGeneration === capturedContextGeneration &&
          serverGeneration === capturedServerGeneration,
      })
      await firstCreateStarted.promise

      contextGeneration = 6
      serverGeneration = 10
      releaseFirstCreate.resolve(undefined)
      await reconcile

      expect(mockApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('does not mutate a Context policy from a mixed McpServer cache revision', async () => {
      const cache = new Map<string, McpServerCRD>()
      cache.set('mongo', {
        name: 'mongo',
        namespace: 'mcp-server',
        uid: 'mongo-uid',
        generation: 1,
        spec: {
          contextRef: 'dev',
          image: 'mongo:old',
          transport: { type: 'streamableHttp', port: 3000 },
        },
      })
      const firstCreateStarted = deferred()
      const releaseFirstCreate = deferred()
      mockApi.createNamespacedNetworkPolicy.mockImplementationOnce(async () => {
        firstCreateStarted.resolve(undefined)
        await releaseFirstCreate.promise
        return {}
      })
      const rec = makeReconciler(mockApi, cache)
      const context: ContextCRD = {
        name: 'dev',
        namespace: 'mcp-server',
        spec: { contextId: 'dev', mcpServers: ['mongo'] },
      }

      const reconcile = rec.reconcileContext(context, { isCurrent: () => true })
      await firstCreateStarted.promise
      cache.set('mongo', {
        name: 'mongo',
        namespace: 'mcp-server',
        uid: 'mongo-uid',
        generation: 2,
        spec: {
          contextRef: 'dev',
          image: 'mongo:new',
          transport: { type: 'streamableHttp', port: 4000 },
        },
      })
      releaseFirstCreate.resolve(undefined)
      await reconcile

      expect(mockApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('continues a Context policy pass across a status-only McpServer replacement', async () => {
      const cache = new Map<string, McpServerCRD>()
      const selected: McpServerCRD = {
        name: 'mongo',
        namespace: 'mcp-server',
        uid: 'mongo-uid',
        generation: 1,
        spec: {
          contextRef: 'dev',
          image: 'mongo:stable',
          transport: { type: 'streamableHttp', port: 3000 },
        },
        status: { conditions: [{ type: 'Ready', status: 'False' }] },
      }
      cache.set(selected.name, selected)
      const firstCreateStarted = deferred()
      const releaseFirstCreate = deferred()
      mockApi.createNamespacedNetworkPolicy.mockImplementationOnce(async () => {
        firstCreateStarted.resolve(undefined)
        await releaseFirstCreate.promise
        return {}
      })
      const rec = makeReconciler(mockApi, cache)
      const context: ContextCRD = {
        name: 'dev',
        namespace: 'mcp-server',
        spec: { contextId: 'dev', mcpServers: ['mongo'] },
      }

      const reconcile = rec.reconcileContext(context, { isCurrent: () => true })
      await firstCreateStarted.promise
      cache.set(selected.name, {
        ...selected,
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      })
      releaseFirstCreate.resolve(undefined)
      await reconcile

      expect(mockApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(3)
    })

    it('does not adopt an McpServer that appeared after Context selection', async () => {
      const cache = new Map<string, McpServerCRD>()
      const inventoryListed = deferred()
      const releaseInventory = deferred<{ items: k8s.V1NetworkPolicy[] }>()
      mockApi.listNamespacedNetworkPolicy.mockImplementationOnce(async () => {
        inventoryListed.resolve(undefined)
        return releaseInventory.promise
      })
      const rec = makeReconciler(mockApi, cache)
      const context: ContextCRD = {
        name: 'dev',
        namespace: 'mcp-server',
        spec: { contextId: 'dev', mcpServers: ['late-server'] },
      }

      const reconcile = rec.reconcileContext(context, { isCurrent: () => true })
      await inventoryListed.promise
      cache.set('late-server', {
        name: 'late-server',
        namespace: 'mcp-server',
        uid: 'late-server-uid',
        generation: 1,
        spec: {
          contextRef: 'dev',
          image: 'late-server:new',
          transport: { type: 'streamableHttp', port: 3000 },
        },
      })
      releaseInventory.resolve({ items: [] })
      await reconcile

      expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('creates L2 egress counterpart in mcp-host namespace (bidirectional)', async () => {
      const cache = new Map<string, McpServerCRD>()
      cache.set('mongo', {
        name: 'mongo',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'mongo:latest',
          transport: { type: 'streamableHttp', url: 'http://mongo:3000', port: 3000 },
        },
      })

      const rec = makeReconciler(mockApi, cache)
      const context: ContextCRD = {
        name: 'dev',
        namespace: 'mcp-server',
        spec: { contextId: 'dev', mcpServers: ['mongo'] },
      }

      await rec.reconcileContext(context, { isCurrent: () => true })

      // Three calls: L2 ingress (mcp-server), L2 egress (mcp-host), L2 rpc-proxy egress (rpc-proxy)
      expect(mockApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(3)
      const egressCall = mockApi.createNamespacedNetworkPolicy.mock.calls[1][0] as {
        namespace: string
        body: {
          metadata: { name: string; namespace: string; labels: Record<string, string> }
          spec: {
            podSelector: { matchLabels: Record<string, string> }
            policyTypes: string[]
            egress: Array<{
              to: Array<{
                namespaceSelector: { matchLabels: Record<string, string> }
                podSelector: { matchLabels: Record<string, string> }
              }>
              ports: Array<{ port: number }>
            }>
          }
        }
      }
      expect(egressCall.namespace).toBe('mcp-host')
      expect(egressCall.body.metadata.name).toBe('ctx-dev-mongo-egress')
      expect(egressCall.body.metadata.labels['clerum.io/policy-type']).toBe('context-allow')
      expect(egressCall.body.spec.policyTypes).toEqual(['Egress'])
      expect(egressCall.body.spec.podSelector.matchLabels).toMatchObject({
        'clerum.io/managed-by': 'host-context-controller',
        'clerum.io/context': 'dev',
      })
      // Egress targets mcp-server namespace + specific server pod
      const egressRule = egressCall.body.spec.egress[0]
      expect(egressRule.to[0].namespaceSelector.matchLabels['kubernetes.io/metadata.name']).toBe(
        'mcp-server'
      )
      expect(egressRule.to[0].podSelector.matchLabels['clerum.io/mcpserver']).toBe('mongo')
      expect(egressRule.ports[0].port).toBe(3000)
    })

    it('scopes L2 mcp-host egress by Context CRD name, not namespace-wide selector', async () => {
      const cache = new Map<string, McpServerCRD>()
      cache.set('mongo', {
        name: 'mongo',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'ctx-name',
          image: 'mongo:latest',
          transport: { type: 'streamableHttp', url: 'http://mongo:3000', port: 3000 },
        },
      })

      const rec = makeReconciler(mockApi, cache)
      const context: ContextCRD = {
        name: 'ctx-name',
        namespace: 'mcp-server',
        spec: { contextId: 'ctx-id', mcpServers: ['mongo'] },
      }

      await rec.reconcileContext(context, { isCurrent: () => true })

      const egressCall = mockApi.createNamespacedNetworkPolicy.mock.calls[1][0] as {
        body: {
          metadata: { labels: Record<string, string> }
          spec: { podSelector: { matchLabels: Record<string, string> } }
        }
      }
      expect(egressCall.body.metadata.labels['clerum.io/context']).toBe('ctx-id')
      expect(egressCall.body.spec.podSelector.matchLabels).toMatchObject({
        'clerum.io/managed-by': 'host-context-controller',
        'clerum.io/context': 'ctx-name',
      })
    })

    it('creates L2 rpc-proxy egress to one MCP server instead of relying on static namespace egress', async () => {
      const cache = new Map<string, McpServerCRD>()
      cache.set('mongo', {
        name: 'mongo',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'mongo:latest',
          transport: { type: 'streamableHttp', url: 'http://mongo:3000', port: 3000 },
        },
      })

      const rec = makeReconciler(mockApi, cache)
      const context: ContextCRD = {
        name: 'dev',
        namespace: 'mcp-server',
        spec: { contextId: 'dev', mcpServers: ['mongo'] },
      }

      await rec.reconcileContext(context, { isCurrent: () => true })

      const rpcProxyEgressCall = mockApi.createNamespacedNetworkPolicy.mock.calls[2][0] as {
        namespace: string
        body: {
          metadata: { name: string; namespace: string; labels: Record<string, string> }
          spec: {
            podSelector: { matchLabels: Record<string, string> }
            policyTypes: string[]
            egress: Array<{
              to: Array<{
                namespaceSelector: { matchLabels: Record<string, string> }
                podSelector: { matchLabels: Record<string, string> }
              }>
              ports: Array<{ port: number }>
            }>
          }
        }
      }

      expect(rpcProxyEgressCall.namespace).toBe('rpc-proxy')
      expect(rpcProxyEgressCall.body.metadata.name).toBe('rpc-egress-dev-mongo')
      expect(rpcProxyEgressCall.body.metadata.labels['clerum.io/policy-type']).toBe(
        'rpc-proxy-egress'
      )
      expect(rpcProxyEgressCall.body.spec.podSelector.matchLabels).toEqual({
        app: 'rpc-proxy',
      })
      const egressRule = rpcProxyEgressCall.body.spec.egress[0]
      expect(egressRule.to[0].namespaceSelector.matchLabels['kubernetes.io/metadata.name']).toBe(
        'mcp-server'
      )
      expect(egressRule.to[0].podSelector.matchLabels['clerum.io/mcpserver']).toBe('mongo')
      expect(egressRule.ports[0].port).toBe(3000)
    })
  })

  // ─── L3: External Egress ───────────────────────────────────────────

  describe('L3 — reconcileExternalEgress', () => {
    it('removes a deterministic safety policy created after its desired-state fence is lost', async () => {
      const server: McpServerCRD = {
        name: 'race-server',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'default',
          image: 'race:latest',
          transport: { type: 'streamableHttp', port: 3000 },
          egressBindings: [{ cidr: '104.18.0.0/16', port: 443 }],
        },
      }
      const createStarted = deferred()
      const releaseCreate = deferred()
      let current = true
      mockApi.createNamespacedNetworkPolicy.mockImplementationOnce(async () => {
        createStarted.resolve(undefined)
        await releaseCreate.promise
        return {
          metadata: {
            name: 'ext-egress-race-server-104-18-0-0-16-443',
            namespace: server.namespace,
            uid: 'created-race-policy',
            resourceVersion: '7',
          },
        }
      })

      const safety = (reconciler as any).reconcileExternalEgressSafety(
        server,
        [{ metadata: { name: 'ext-egress-race-server-stale' } }],
        () => current
      ) as Promise<boolean>

      await createStarted.promise
      current = false
      releaseCreate.resolve(undefined)

      expect(await safety).toBe(false)
      const created = mockApi.createNamespacedNetworkPolicy.mock.calls[0][0].body
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: created.metadata.name,
          namespace: server.namespace,
          body: { preconditions: { uid: 'created-race-policy', resourceVersion: '7' } },
        })
      )
    })

    it('refuses to adopt a foreign policy that collides with an external-egress name', async () => {
      const server: McpServerCRD = {
        name: 'openai-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'openai:latest',
          transport: { type: 'streamableHttp', port: 3000 },
          egressBindings: [{ cidr: '104.18.0.0/16', port: 443 }],
        },
      }
      mockApi.createNamespacedNetworkPolicy.mockRejectedValueOnce(
        Object.assign(new Error('already exists'), { code: 409 })
      )
      mockApi.readNamespacedNetworkPolicy.mockResolvedValueOnce({
        metadata: {
          name: 'ext-egress-openai-mcp-104-18-0-0-16-443',
          namespace: 'mcp-server',
          uid: 'foreign-uid',
          resourceVersion: '7',
          labels: {
            'clerum.io/managed-by': 'foreign-controller',
            'clerum.io/policy-type': 'external-egress',
            'clerum.io/mcpserver': server.name,
          },
        },
      })

      await expect(
        reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      ).rejects.toThrow(/ownership/i)
      expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('refuses to replace an HCC external-egress policy owned by a different server', async () => {
      const server: McpServerCRD = {
        name: 'openai-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'openai:latest',
          transport: { type: 'streamableHttp', port: 3000 },
          egressBindings: [{ cidr: '104.18.0.0/16', port: 443 }],
        },
      }
      mockApi.createNamespacedNetworkPolicy.mockRejectedValueOnce(
        Object.assign(new Error('already exists'), { code: 409 })
      )
      mockApi.readNamespacedNetworkPolicy.mockResolvedValueOnce({
        metadata: {
          name: 'ext-egress-openai-mcp-104-18-0-0-16-443',
          namespace: 'mcp-server',
          uid: 'other-hcc-owner-uid',
          resourceVersion: '7',
          labels: {
            'clerum.io/managed-by': 'host-context-controller',
            'clerum.io/policy-type': 'external-egress',
            'clerum.io/mcpserver': 'different-server',
          },
        },
      })

      await expect(
        reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      ).rejects.toThrow(/ownership/i)
      expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('creates egress policy for CIDR binding', async () => {
      const server: McpServerCRD = {
        name: 'openai-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'openai:latest',
          transport: { type: 'streamableHttp', url: 'http://openai:3000', port: 3000 },
          egressBindings: [{ cidr: '104.18.0.0/16', port: 443 }],
        },
      }

      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })

      expect(mockApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      const body = mockApi.createNamespacedNetworkPolicy.mock.calls[0][0].body
      expect(body.metadata.labels['clerum.io/policy-type']).toBe('external-egress')
      expect(body.metadata.labels['clerum.io/egress-class']).toBe('exact-host')
      expect(body.spec.egress[0].to[0].ipBlock.cidr).toBe('104.18.0.0/16')
      expect(body.spec.egress[0].ports[0].port).toBe(443)
    })

    it('resolves DNS to IPs and creates ipBlock policies', async () => {
      const server: McpServerCRD = {
        name: 'openai-mcp',
        namespace: 'mcp-server',
        generation: 7,
        spec: {
          contextRef: 'dev',
          image: 'openai:latest',
          transport: { type: 'streamableHttp', url: 'http://openai:3000', port: 3000 },
          egressBindings: [{ dns: 'api.openai.com', port: 443 }],
        },
      }

      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })

      expect(mockApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      const body = mockApi.createNamespacedNetworkPolicy.mock.calls[0][0].body
      // DNS resolved to 1.2.3.4 and 5.6.7.8 — two egress rules
      expect(body.spec.egress.length).toBe(2)
      expect(body.metadata.labels['clerum.io/egress-class']).toBe('exact-host')
      expect(body.spec.egress[0].to[0].ipBlock.cidr).toBe('1.2.3.4/32')
      expect(body.spec.egress[1].to[0].ipBlock.cidr).toBe('5.6.7.8/32')
      expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'openai-mcp',
          body: expect.arrayContaining([
            expect.objectContaining({
              path: '/status/resolvedEgressIPs',
              value: [
                expect.objectContaining({
                  dns: 'api.openai.com',
                  ips: ['1.2.3.4', '5.6.7.8'],
                }),
              ],
            }),
            expect.objectContaining({
              path: '/status/conditions',
              value: expect.arrayContaining([
                expect.objectContaining({
                  type: 'ExternalEgressReady',
                  status: 'True',
                  reason: 'Reconciled',
                  observedGeneration: 7,
                }),
              ]),
            }),
          ]),
        })
      )
    })

    it('does not mutate policy or status after its McpServer authority lease is retired', async () => {
      const dnsStarted = deferred()
      const releaseDns = deferred<string[]>()
      vi.mocked(dns.resolve4).mockImplementationOnce(async () => {
        dnsStarted.resolve(undefined)
        return releaseDns.promise
      })
      let inventoryGeneration = 7
      const capturedGeneration = inventoryGeneration
      const server: McpServerCRD = {
        name: 'authority-race-mcp',
        namespace: 'mcp-server',
        uid: 'authority-race-uid',
        generation: 3,
        spec: {
          contextRef: 'dev',
          image: 'authority-race:test',
          transport: { type: 'streamableHttp', port: 3000 },
          egressBindings: [{ dns: 'api.openai.com', port: 443 }],
        },
      }

      const reconcile = reconciler.reconcileExternalEgress(server, {
        isCurrent: () => inventoryGeneration === capturedGeneration,
      })
      await dnsStarted.promise

      // Retire and recover to a different generation. The recovered cache is
      // authoritative again, but never for this stale pass.
      inventoryGeneration = 9
      releaseDns.resolve(['1.2.3.4'])
      await reconcile

      expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockCustomApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    })

    it('identity-fences the status patch and preserves unrelated conditions', async () => {
      mockCustomApi.getNamespacedCustomObjectStatus.mockResolvedValueOnce({
        metadata: {
          uid: 'openai-mcp-uid',
          generation: 7,
          resourceVersion: 'status-rv-17',
        },
        status: {
          conditions: [
            {
              type: 'RuntimeReady',
              status: 'True',
              reason: 'DeploymentAvailable',
              message: 'Runtime deployment is available',
              lastTransitionTime: '2026-07-29T00:00:00.000Z',
              observedGeneration: 7,
            },
          ],
        },
      })
      const server: McpServerCRD = {
        name: 'openai-mcp',
        namespace: 'mcp-server',
        uid: 'openai-mcp-uid',
        generation: 7,
        spec: {
          contextRef: 'dev',
          image: 'openai:latest',
          transport: { type: 'streamableHttp', url: 'http://openai:3000', port: 3000 },
          egressBindings: [{ dns: 'api.openai.com', port: 443 }],
        },
      }

      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })

      const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
      expect(patch.slice(0, 3)).toEqual([
        { op: 'test', path: '/metadata/uid', value: 'openai-mcp-uid' },
        { op: 'test', path: '/metadata/generation', value: 7 },
        { op: 'test', path: '/metadata/resourceVersion', value: 'status-rv-17' },
      ])
      expect(patch).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: '/status/conditions',
            value: expect.arrayContaining([
              expect.objectContaining({
                type: 'RuntimeReady',
                reason: 'DeploymentAvailable',
              }),
              expect.objectContaining({
                type: 'ExternalEgressReady',
                status: 'True',
                observedGeneration: 7,
              }),
            ]),
          }),
        ])
      )
    })

    it('fences every identity field read from status when synthetic input omits them', async () => {
      mockCustomApi.getNamespacedCustomObjectStatus.mockResolvedValueOnce({
        metadata: {
          uid: 'openai-mcp-uid',
          generation: 7,
          resourceVersion: 'status-rv-17',
        },
        status: {},
      })
      const server: McpServerCRD = {
        name: 'openai-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'openai:latest',
          transport: { type: 'streamableHttp', url: 'http://openai:3000', port: 3000 },
          egressBindings: [{ dns: 'api.openai.com', port: 443 }],
        },
      }

      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })

      const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
      expect(patch.slice(0, 3)).toEqual([
        { op: 'test', path: '/metadata/uid', value: 'openai-mcp-uid' },
        { op: 'test', path: '/metadata/generation', value: 7 },
        { op: 'test', path: '/metadata/resourceVersion', value: 'status-rv-17' },
      ])
    })

    it.each([
      {
        name: 'UID',
        currentMetadata: {
          uid: 'replacement-uid',
          generation: 7,
          resourceVersion: 'status-rv-18',
        },
      },
      {
        name: 'generation',
        currentMetadata: {
          uid: 'openai-mcp-uid',
          generation: 8,
          resourceVersion: 'status-rv-18',
        },
      },
    ])(
      'rejects a stale $name before patching external egress status',
      async ({ currentMetadata }) => {
        mockCustomApi.getNamespacedCustomObjectStatus.mockResolvedValueOnce({
          metadata: currentMetadata,
          status: {},
        })
        const server: McpServerCRD = {
          name: 'openai-mcp',
          namespace: 'mcp-server',
          uid: 'openai-mcp-uid',
          generation: 7,
          spec: {
            contextRef: 'dev',
            image: 'openai:latest',
            transport: { type: 'streamableHttp', url: 'http://openai:3000', port: 3000 },
            egressBindings: [{ dns: 'api.openai.com', port: 443 }],
          },
        }

        await expect(
          reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
        ).rejects.toThrow(/stale McpServer/i)

        expect(mockCustomApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
      }
    )

    it('fails closed when a same-generation status writer wins the resourceVersion race', async () => {
      const conflict = Object.assign(new Error('JSON patch test failed'), { code: 409 })
      mockCustomApi.getNamespacedCustomObjectStatus.mockResolvedValueOnce({
        metadata: {
          uid: 'openai-mcp-uid',
          generation: 7,
          resourceVersion: 'status-rv-17',
        },
        status: {
          conditions: [
            {
              type: 'RuntimeReady',
              status: 'True',
              reason: 'DeploymentAvailable',
              lastTransitionTime: '2026-07-29T00:00:00.000Z',
            },
          ],
        },
      })
      mockCustomApi.patchNamespacedCustomObjectStatus.mockRejectedValueOnce(conflict)
      const server: McpServerCRD = {
        name: 'openai-mcp',
        namespace: 'mcp-server',
        uid: 'openai-mcp-uid',
        generation: 7,
        spec: {
          contextRef: 'dev',
          image: 'openai:latest',
          transport: { type: 'streamableHttp', url: 'http://openai:3000', port: 3000 },
          egressBindings: [{ dns: 'api.openai.com', port: 443 }],
        },
      }

      await expect(
        reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      ).rejects.toBe(conflict)

      expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.arrayContaining([
            {
              op: 'test',
              path: '/metadata/resourceVersion',
              value: 'status-rv-17',
            },
          ]),
        })
      )
    })

    it('fails closed when ExternalEgressReady status cannot be written', async () => {
      const statusError = new Error('status update denied')
      mockCustomApi.patchNamespacedCustomObjectStatus.mockRejectedValueOnce(statusError)
      const server: McpServerCRD = {
        name: 'openai-mcp',
        namespace: 'mcp-server',
        generation: 7,
        spec: {
          contextRef: 'dev',
          image: 'openai:latest',
          transport: { type: 'streamableHttp', url: 'http://openai:3000', port: 3000 },
          egressBindings: [{ dns: 'api.openai.com', port: 443 }],
        },
      }

      await expect(
        reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      ).rejects.toThrow('status update denied')

      expect(mockApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalled()
    })

    it('fails closed when ExternalEgressReady status cannot be read', async () => {
      const statusError = new Error('status read denied')
      mockCustomApi.getNamespacedCustomObjectStatus.mockRejectedValueOnce(statusError)
      const server: McpServerCRD = {
        name: 'openai-mcp',
        namespace: 'mcp-server',
        generation: 7,
        spec: {
          contextRef: 'dev',
          image: 'openai:latest',
          transport: { type: 'streamableHttp', url: 'http://openai:3000', port: 3000 },
          egressBindings: [{ dns: 'api.openai.com', port: 443 }],
        },
      }

      await expect(
        reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      ).rejects.toThrow('status read denied')

      expect(mockApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockCustomApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    })

    it('creates explicit public-web egress with private and special-use ranges excluded', async () => {
      const server: McpServerCRD = {
        name: 'search-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'search:latest',
          transport: { type: 'streamableHttp', url: 'http://search:3000', port: 3000 },
          egressBindings: [{ egressClass: 'public-web' }],
        },
      }

      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })

      expect(dns.resolve4).not.toHaveBeenCalled()
      expect(mockApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      const body = mockApi.createNamespacedNetworkPolicy.mock.calls[0][0].body
      expect(body.metadata.name).toBe('ext-egress-search-mcp-public-web')
      expect(body.metadata.labels['clerum.io/egress-class']).toBe('public-web')
      expect(body.spec.egress).toEqual([
        expect.objectContaining({
          to: [
            {
              ipBlock: expect.objectContaining({
                cidr: '0.0.0.0/0',
                except: expect.arrayContaining([
                  '10.0.0.0/8',
                  '169.254.0.0/16',
                  '192.168.0.0/16',
                  '198.51.100.0/24',
                ]),
              }),
            },
          ],
          ports: [
            { port: 443, protocol: 'TCP' },
            { port: 80, protocol: 'TCP' },
          ],
        }),
      ])
    })

    it('rejects public-web egressBindings that include exact destination fields', async () => {
      const server: McpServerCRD = {
        name: 'search-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'search:latest',
          transport: { type: 'streamableHttp', url: 'http://search:3000', port: 3000 },
          egressBindings: [{ egressClass: 'public-web', dns: 'api.example.com', port: 443 }],
        },
      }

      await expect(
        reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      ).rejects.toThrow(/public-web external egress bindings/)
      expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('rejects public-web egressBindings that include protocol', async () => {
      const server: McpServerCRD = {
        name: 'search-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'search:latest',
          transport: { type: 'streamableHttp', url: 'http://search:3000', port: 3000 },
          egressBindings: [{ egressClass: 'public-web', protocol: 'TCP' }],
        },
      }

      await expect(
        reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      ).rejects.toThrow(/public-web external egress bindings/)
      expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('does not patch status when only resolvedAt changes across DNS resyncs', async () => {
      mockCustomApi.getNamespacedCustomObjectStatus.mockResolvedValueOnce({
        status: {
          resolvedEgressIPs: [
            {
              dns: 'api.openai.com',
              ips: ['1.2.3.4', '5.6.7.8'],
              resolvedAt: '2026-05-15T00:00:00.000Z',
            },
          ],
          conditions: [
            {
              type: 'ExternalEgressReady',
              status: 'True',
              reason: 'Reconciled',
              message: 'External egress policies reconciled',
              lastTransitionTime: '2026-05-15T00:00:00.000Z',
            },
          ],
        },
      })
      const server: McpServerCRD = {
        name: 'openai-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'openai:latest',
          transport: { type: 'streamableHttp', url: 'http://openai:3000', port: 3000 },
          egressBindings: [{ dns: 'api.openai.com', port: 443 }],
        },
      }

      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })

      expect(mockCustomApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    })

    it('does not patch status when conditions are unchanged but the apiserver returned condition keys alphabetized', async () => {
      // The Kubernetes apiserver canonicalizes CRD `.status` JSON with object
      // keys in ALPHABETICAL order, whereas the controller rebuilds condition
      // objects in code insertion order ({type,status,reason,message,...}). A
      // key-order-sensitive `JSON.stringify` equality check never matches across
      // this read->rebuild round-trip, so the no-op gate would re-patch status on
      // every reconcile — and each status write self-triggers the McpServer watch,
      // producing an unbounded reconcile loop that OOMs HCC (observed in prod on
      // mcp-evenfire-brain-remote). This reproduces the apiserver key order; the
      // gate must compare by content, not serialization order.
      mockCustomApi.getNamespacedCustomObjectStatus.mockResolvedValueOnce({
        status: {
          resolvedEgressIPs: [
            {
              dns: 'api.openai.com',
              ips: ['1.2.3.4', '5.6.7.8'],
              resolvedAt: '2026-05-15T00:00:00.000Z',
            },
          ],
          conditions: [
            {
              lastTransitionTime: '2026-05-15T00:00:00.000Z',
              message: 'External egress policies reconciled',
              reason: 'Reconciled',
              status: 'True',
              type: 'ExternalEgressReady',
            },
          ],
        },
      })
      const server: McpServerCRD = {
        name: 'openai-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'openai:latest',
          transport: { type: 'streamableHttp', url: 'http://openai:3000', port: 3000 },
          egressBindings: [{ dns: 'api.openai.com', port: 443 }],
        },
      }

      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })

      expect(mockCustomApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    })

    it('writes resolved egress IP status in stable DNS order', async () => {
      resolve4Mock.mockImplementation(async (hostname: string) => {
        if (hostname === 'b.example.com') return rec('5.6.7.8')
        if (hostname === 'a.example.com') return rec('1.2.3.4')
        return []
      })
      const server: McpServerCRD = {
        name: 'ordered-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'ordered:latest',
          transport: { type: 'streamableHttp', url: 'http://ordered:3000', port: 3000 },
          egressBindings: [
            { dns: 'b.example.com', port: 443 },
            { dns: 'a.example.com', port: 443 },
          ],
        },
      }

      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })

      const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
      const resolvedPatch = patch.find(
        (operation: { path?: string }) => operation.path === '/status/resolvedEgressIPs'
      )
      expect(resolvedPatch.value.map((entry: { dns: string }) => entry.dns)).toEqual([
        'a.example.com',
        'b.example.com',
      ])
    })

    it('is a NO-OP on the next resync when DNS answers are unchanged (issue #299 F2 anti-churn)', async () => {
      const server: McpServerCRD = {
        name: 'noop-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'noop:latest',
          transport: { type: 'streamableHttp', url: 'http://noop:3000', port: 3000 },
          egressBindings: [{ dns: 'api.example.com', port: 443 }],
        },
      }

      // First reconcile bootstraps and writes the external-egress policy.
      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      const created = mockApi.createNamespacedNetworkPolicy.mock.calls[0][0] as {
        body: k8s.V1NetworkPolicy
      }
      const written = created.body
      expect(written.metadata?.annotations?.['clerum.io/egress-fqdn-state']).toBeTruthy()

      // The policy is now live with its accumulated state annotation. Feed it back
      // as the existing policy for the next resync tick.
      mockApi.listNamespacedNetworkPolicy.mockResolvedValue({
        items: [
          {
            metadata: {
              name: written.metadata?.name,
              labels: written.metadata?.labels,
              annotations: written.metadata?.annotations,
            },
            spec: written.spec,
          },
        ],
      })
      mockApi.createNamespacedNetworkPolicy.mockClear()
      mockApi.replaceNamespacedNetworkPolicy.mockClear()

      // Second resync: same DNS answers → same IP set → must NOT rewrite the
      // policy (a timestamp-only refresh is a no-op). This is the churn the audit
      // caught: before the fix, RESOLVED_AT + renewed expiry forced a write here.
      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('WRITES on resync when the persisted window is AGING even though the IP set is unchanged (issue #299 M1 renewalDue wiring)', async () => {
      const server: McpServerCRD = {
        name: 'renew-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'renew:latest',
          transport: { type: 'streamableHttp', url: 'http://renew:3000', port: 3000 },
          egressBindings: [{ dns: 'api.example.com', port: 443 }],
        },
      }
      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      const written = (
        mockApi.createNamespacedNetworkPolicy.mock.calls[0][0] as { body: k8s.V1NetworkPolicy }
      ).body

      // Age the persisted window: rewrite each entry's expiresAt to just above now
      // (well within overlap/2) so renewalDue fires while the IP set is unchanged.
      const annotations = { ...(written.metadata?.annotations ?? {}) }
      const state = JSON.parse(annotations['clerum.io/egress-fqdn-state']) as Array<{
        expiresAt: number
      }>
      for (const e of state) e.expiresAt = Date.now() + 1000
      annotations['clerum.io/egress-fqdn-state'] = JSON.stringify(state)

      mockApi.listNamespacedNetworkPolicy.mockResolvedValue({
        items: [
          {
            metadata: {
              name: written.metadata?.name,
              labels: written.metadata?.labels,
              annotations,
            },
            spec: written.spec,
          },
        ],
      })
      mockApi.createNamespacedNetworkPolicy.mockClear()
      mockApi.replaceNamespacedNetworkPolicy.mockClear()

      // Same DNS → set unchanged (changed=false) but window aging → renewalDue=true
      // → the policy MUST be re-persisted (deleting `|| egressRenewalDue` breaks this,
      // reintroducing the M1 overlap-grace loss).
      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      const wrote =
        mockApi.createNamespacedNetworkPolicy.mock.calls.length +
        mockApi.replaceNamespacedNetworkPolicy.mock.calls.length
      expect(wrote).toBeGreaterThan(0)
    })

    it('WRITES through create-409 when renewalDue so the inner no-op gate cannot veto M1', async () => {
      const server: McpServerCRD = {
        name: 'renew-409-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'renew:latest',
          transport: { type: 'streamableHttp', url: 'http://renew:3000', port: 3000 },
          egressBindings: [{ dns: 'api.example.com', port: 443 }],
        },
      }
      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      const written = (
        mockApi.createNamespacedNetworkPolicy.mock.calls[0][0] as { body: k8s.V1NetworkPolicy }
      ).body

      const annotations = { ...(written.metadata?.annotations ?? {}) }
      const state = JSON.parse(annotations['clerum.io/egress-fqdn-state']) as Array<{
        expiresAt: number
      }>
      for (const e of state) e.expiresAt = Date.now() + 1000
      annotations['clerum.io/egress-fqdn-state'] = JSON.stringify(state)

      mockApi.listNamespacedNetworkPolicy.mockResolvedValue({
        items: [
          {
            metadata: {
              name: written.metadata?.name,
              labels: written.metadata?.labels,
              annotations,
            },
            spec: written.spec,
          },
        ],
      })
      mockApi.createNamespacedNetworkPolicy.mockRejectedValue(
        Object.assign(new Error('already exists'), { code: 409 })
      )
      mockApi.readNamespacedNetworkPolicy.mockResolvedValue({
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: {
          name: written.metadata?.name,
          namespace: written.metadata?.namespace,
          labels: written.metadata?.labels,
          annotations,
          resourceVersion: '9',
        },
        spec: written.spec,
      })
      mockApi.createNamespacedNetworkPolicy.mockClear()
      mockApi.replaceNamespacedNetworkPolicy.mockClear()

      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      expect(mockApi.readNamespacedNetworkPolicy).toHaveBeenCalled()
      expect(mockApi.replaceNamespacedNetworkPolicy).toHaveBeenCalled()
    })

    it('DROPS a blocked/private IP rehydrated from a tampered annotation (issue #299 M3 defense-in-depth)', async () => {
      const server: McpServerCRD = {
        name: 'tamper-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'tamper:latest',
          transport: { type: 'streamableHttp', url: 'http://tamper:3000', port: 3000 },
          egressBindings: [{ dns: 'api.example.com', port: 443 }],
        },
      }
      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      const written = (
        mockApi.createNamespacedNetworkPolicy.mock.calls[0][0] as { body: k8s.V1NetworkPolicy }
      ).body

      // Simulate a tampered live policy: a private IP injected into BOTH the state
      // annotation (so it rehydrates) and the spec egress (so a write is needed).
      const future = Date.now() + 3_600_000
      const state = [
        {
          ip: '1.2.3.4',
          port: 443,
          protocol: 'TCP',
          fqdn: 'api.example.com',
          expiresAt: future,
          lastObservedAt: Date.now(),
        },
        {
          ip: '5.6.7.8',
          port: 443,
          protocol: 'TCP',
          fqdn: 'api.example.com',
          expiresAt: future,
          lastObservedAt: Date.now(),
        },
        {
          ip: '10.0.0.5',
          port: 443,
          protocol: 'TCP',
          fqdn: 'api.example.com',
          expiresAt: future,
          lastObservedAt: Date.now(),
        },
      ]
      const tampered: k8s.V1NetworkPolicy = {
        metadata: {
          name: written.metadata?.name,
          labels: written.metadata?.labels,
          annotations: { 'clerum.io/egress-fqdn-state': JSON.stringify(state) },
        },
        spec: {
          ...written.spec!,
          egress: [
            { to: [{ ipBlock: { cidr: '1.2.3.4/32' } }], ports: [{ port: 443, protocol: 'TCP' }] },
            { to: [{ ipBlock: { cidr: '5.6.7.8/32' } }], ports: [{ port: 443, protocol: 'TCP' }] },
            { to: [{ ipBlock: { cidr: '10.0.0.5/32' } }], ports: [{ port: 443, protocol: 'TCP' }] },
          ],
        },
      }
      mockApi.listNamespacedNetworkPolicy.mockResolvedValue({ items: [tampered] })
      mockApi.createNamespacedNetworkPolicy.mockClear()
      mockApi.replaceNamespacedNetworkPolicy.mockClear()

      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      // The reconcile must rewrite the policy WITHOUT the private IP.
      const call =
        mockApi.replaceNamespacedNetworkPolicy.mock.calls[0]?.[0] ??
        mockApi.createNamespacedNetworkPolicy.mock.calls[0]?.[0]
      const cidrs = JSON.stringify(
        (call as { body: k8s.V1NetworkPolicy })?.body?.spec?.egress ?? []
      )
      expect(call).toBeTruthy()
      expect(cidrs).not.toContain('10.0.0.5')
      expect(cidrs).toContain('1.2.3.4')
    })

    it('updates the observed min-TTL from a resolution (issue #299 M4 — feeds the TTL-aware resync)', async () => {
      resolve4Mock.mockResolvedValueOnce([{ address: '1.2.3.4', ttl: 15 }]) // ttl 15s
      const server: McpServerCRD = {
        name: 'ttl-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'ttl:latest',
          transport: { type: 'streamableHttp', url: 'http://ttl:3000', port: 3000 },
          egressBindings: [{ dns: 'api.example.com', port: 443 }],
        },
      }
      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      // The min observed TTL (ms) must reflect the 15s answer — deleting the
      // Math.min update leaves it Infinity and the resync degrades to the fixed
      // interval (the #299 under-sampling failure mode).
      expect(reconciler.externalEgressRefreshMinTtlMs).toBe(15_000)
    })

    it('accumulates the UNION across a real A->B rotation via rehydration (issue #299 M4 — wiring not vacuous)', async () => {
      const server: McpServerCRD = {
        name: 'rot-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'rot:latest',
          transport: { type: 'streamableHttp', url: 'http://rot:3000', port: 3000 },
          egressBindings: [{ dns: 'api.example.com', port: 443 }],
        },
      }
      // Round 1: DNS serves A only.
      resolve4Mock.mockResolvedValueOnce([{ address: '140.82.112.3', ttl: 15 }])
      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      const written = (
        mockApi.createNamespacedNetworkPolicy.mock.calls[0][0] as { body: k8s.V1NetworkPolicy }
      ).body
      mockApi.listNamespacedNetworkPolicy.mockResolvedValue({
        items: [{ metadata: written.metadata, spec: written.spec }],
      })
      mockApi.createNamespacedNetworkPolicy.mockClear()
      mockApi.replaceNamespacedNetworkPolicy.mockClear()

      // Round 2: DNS rotates to B. The written policy must be the UNION {A, B} —
      // this only holds if previousAnnotations rehydration is actually wired in.
      resolve4Mock.mockResolvedValueOnce([{ address: '140.82.112.4', ttl: 15 }])
      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      const call =
        mockApi.replaceNamespacedNetworkPolicy.mock.calls[0]?.[0] ??
        mockApi.createNamespacedNetworkPolicy.mock.calls[0]?.[0]
      const egress = JSON.stringify(
        (call as { body: k8s.V1NetworkPolicy })?.body?.spec?.egress ?? []
      )
      expect(egress).toContain('140.82.112.3') // A retained (overlap)
      expect(egress).toContain('140.82.112.4') // B added
    })

    it('is a NO-OP on resync for an unchanged STATIC cidr binding (issue #299 F2 — no static churn)', async () => {
      const server: McpServerCRD = {
        name: 'cidr-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'cidr:latest',
          transport: { type: 'streamableHttp', url: 'http://cidr:3000', port: 3000 },
          egressBindings: [{ cidr: '93.184.216.0/24', port: 443 }],
        },
      }
      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      const created = mockApi.createNamespacedNetworkPolicy.mock.calls[0][0] as {
        body: k8s.V1NetworkPolicy
      }
      const written = created.body
      mockApi.listNamespacedNetworkPolicy.mockResolvedValue({
        items: [{ metadata: written.metadata, spec: written.spec }],
      })
      mockApi.createNamespacedNetworkPolicy.mockClear()
      mockApi.replaceNamespacedNetworkPolicy.mockClear()

      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('is a NO-OP when the live policy has identical egress but different KEY ORDER (issue #299 R2-1)', async () => {
      // The apiserver/client deserializes egress rules with keys ordered
      // {ports, to} while the builder emits {to, ports}. A raw JSON.stringify
      // compare would see them as different and rewrite every tick (write-storm).
      // The semantic signature must treat them as equal → no-op.
      const server: McpServerCRD = {
        name: 'keyorder-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'keyorder:latest',
          transport: { type: 'streamableHttp', url: 'http://keyorder:3000', port: 3000 },
          egressBindings: [{ cidr: '93.184.216.0/24', port: 443 }],
        },
      }
      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      const created = mockApi.createNamespacedNetworkPolicy.mock.calls[0][0] as {
        body: k8s.V1NetworkPolicy
      }
      const written = created.body
      // Rebuild egress rules with keys in apiserver order {ports, to}.
      const reordered: k8s.V1NetworkPolicy = {
        metadata: written.metadata,
        spec: {
          ...written.spec!,
          egress: (written.spec!.egress ?? []).map(r => ({ ports: r.ports, to: r.to })),
        },
      }
      mockApi.listNamespacedNetworkPolicy.mockResolvedValue({ items: [reordered] })
      mockApi.createNamespacedNetworkPolicy.mockClear()
      mockApi.replaceNamespacedNetworkPolicy.mockClear()

      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('self-heals an external-egress policy whose live spec.egress drifted out-of-band (issue #299 L1)', async () => {
      const server: McpServerCRD = {
        name: 'drift-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'drift:latest',
          transport: { type: 'streamableHttp', url: 'http://drift:3000', port: 3000 },
          egressBindings: [{ cidr: '93.184.216.0/24', port: 443 }],
        },
      }
      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      const created = mockApi.createNamespacedNetworkPolicy.mock.calls[0][0] as {
        body: k8s.V1NetworkPolicy
      }
      const written = created.body
      // Simulate out-of-band tampering: the live policy's egress was widened.
      const drifted: k8s.V1NetworkPolicy = {
        metadata: written.metadata,
        spec: {
          ...written.spec!,
          egress: [
            { to: [{ ipBlock: { cidr: '0.0.0.0/0' } }], ports: [{ port: 443, protocol: 'TCP' }] },
          ],
        },
      }
      mockApi.listNamespacedNetworkPolicy.mockResolvedValue({ items: [drifted] })
      mockApi.createNamespacedNetworkPolicy.mockClear()
      mockApi.replaceNamespacedNetworkPolicy.mockClear()

      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      // The reconciler must rewrite the policy back to the declared CIDR.
      const wrote =
        mockApi.createNamespacedNetworkPolicy.mock.calls.length +
        mockApi.replaceNamespacedNetworkPolicy.mock.calls.length
      expect(wrote).toBeGreaterThan(0)
    })

    it('rejects private or special-use CIDR bindings fail-closed', async () => {
      for (const cidr of ['10.0.0.0/8', '169.254.169.254/32', '192.168.1.0/24']) {
        const server: McpServerCRD = {
          name: 'private-mcp',
          namespace: 'mcp-server',
          spec: {
            contextRef: 'dev',
            image: 'private:latest',
            transport: { type: 'streamableHttp', url: 'http://private:3000', port: 3000 },
            egressBindings: [{ cidr, port: 443 }],
          },
        }

        await expect(
          reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
        ).rejects.toThrow(/External egress reconciliation failed/)
      }

      expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('rejects mixed public/private DNS results for the whole hostname', async () => {
      resolve4Mock.mockResolvedValueOnce(rec('10.0.0.5', '1.2.3.4'))
      const server: McpServerCRD = {
        name: 'mixed-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'mixed:latest',
          transport: { type: 'streamableHttp', url: 'http://mixed:3000', port: 3000 },
          egressBindings: [{ dns: 'api.example.com', port: 443 }],
        },
      }

      await expect(
        reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      ).rejects.toThrow(/resolved disallowed address/)

      expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.arrayContaining([
            expect.objectContaining({
              path: '/status/conditions',
              value: expect.arrayContaining([
                expect.objectContaining({
                  type: 'ExternalEgressReady',
                  status: 'False',
                  reason: 'ExternalEgressRejected',
                }),
              ]),
            }),
          ]),
        })
      )
    })

    it('rejects internal DNS hostnames before resolving them', async () => {
      const server: McpServerCRD = {
        name: 'internal-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'internal:latest',
          transport: { type: 'streamableHttp', url: 'http://internal:3000', port: 3000 },
          egressBindings: [{ dns: 'kubernetes.default.svc', port: 443 }],
        },
      }

      await expect(
        reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      ).rejects.toThrow(/private, internal, metadata/)

      expect(dns.resolve4).not.toHaveBeenCalled()
      expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('does not create an external egress policy when DNS only resolves private IPs', async () => {
      resolve4Mock.mockResolvedValueOnce(rec('10.0.0.5', '192.168.1.10'))
      const server: McpServerCRD = {
        name: 'private-dns-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'private-dns:latest',
          transport: { type: 'streamableHttp', url: 'http://private-dns:3000', port: 3000 },
          egressBindings: [{ dns: 'api.example.com', port: 443 }],
        },
      }

      await expect(
        reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      ).rejects.toThrow(/resolved disallowed address/)

      expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('deletes only orphaned external egress policies after applying the desired set', async () => {
      mockApi.listNamespacedNetworkPolicy.mockResolvedValue({
        items: [
          { metadata: { name: 'ext-egress-openai-mcp-api.openai.com-443' } },
          { metadata: { name: 'ext-egress-openai-mcp-old-example-com-443' } },
        ],
      })

      const server: McpServerCRD = {
        name: 'openai-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'openai:latest',
          transport: { type: 'streamableHttp', url: 'http://openai:3000', port: 3000 },
          egressBindings: [{ dns: 'api.openai.com', port: 443 }],
        },
      }

      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })

      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ext-egress-openai-mcp-old-example-com-443',
          namespace: 'mcp-server',
        })
      )
    })

    it('fails closed when an orphaned external egress policy cannot be deleted', async () => {
      mockApi.listNamespacedNetworkPolicy.mockResolvedValue({
        items: [
          { metadata: { name: 'ext-egress-openai-mcp-api.openai.com-443' } },
          { metadata: { name: 'ext-egress-openai-mcp-old-example-com-443' } },
        ],
      })
      mockApi.deleteNamespacedNetworkPolicy.mockRejectedValueOnce(new Error('delete denied'))

      const server: McpServerCRD = {
        name: 'openai-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'openai:latest',
          transport: { type: 'streamableHttp', url: 'http://openai:3000', port: 3000 },
          egressBindings: [{ dns: 'api.openai.com', port: 443 }],
        },
      }

      await expect(
        reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      ).rejects.toThrow('delete denied')
    })

    it('deletes stale policies and fails when DNS resolution for that binding fails', async () => {
      vi.mocked(dns.resolve4).mockRejectedValueOnce(new Error('dns timeout'))
      mockApi.listNamespacedNetworkPolicy.mockResolvedValue({
        items: [
          { metadata: { name: 'ext-egress-openai-mcp-api.openai.com-443' } },
          { metadata: { name: 'ext-egress-openai-mcp-old-example-com-443' } },
        ],
      })

      const server: McpServerCRD = {
        name: 'openai-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'openai:latest',
          transport: { type: 'streamableHttp', url: 'http://openai:3000', port: 3000 },
          egressBindings: [{ dns: 'api.openai.com', port: 443 }],
        },
      }

      await expect(
        reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      ).rejects.toThrow(/dns timeout/)

      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ext-egress-openai-mcp-api.openai.com-443',
          namespace: 'mcp-server',
        })
      )
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ext-egress-openai-mcp-old-example-com-443',
          namespace: 'mcp-server',
        })
      )
      expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.arrayContaining([
            expect.objectContaining({
              path: '/status/conditions',
              value: expect.arrayContaining([
                expect.objectContaining({
                  type: 'ExternalEgressReady',
                  status: 'False',
                  reason: 'ExternalEgressRejected',
                }),
              ]),
            }),
          ]),
        })
      )
    })

    it('fails closed for malformed exact-host bindings without dns or cidr', async () => {
      const server: McpServerCRD = {
        name: 'broken-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'broken:latest',
          transport: { type: 'streamableHttp', url: 'http://broken:3000', port: 3000 },
          egressBindings: [{ port: 443 }],
        },
      }

      await expect(
        reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      ).rejects.toThrow(/must declare dns or cidr/)
      expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('bounds DNS resolution so a stuck resolver cannot block reconciliation indefinitely', async () => {
      vi.useFakeTimers()
      vi.mocked(dns.resolve4).mockImplementationOnce(() => new Promise(() => undefined))
      const server: McpServerCRD = {
        name: 'stuck-dns-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'stuck-dns:test',
          transport: { type: 'streamableHttp', port: 3000 },
          egressBindings: [{ dns: 'api.openai.com', port: 443 }],
        },
      }

      const reconcile = reconciler.reconcileExternalEgress(server, { isCurrent: () => true })
      const rejection = expect(reconcile).rejects.toThrow(/DNS resolution timed out after 5000ms/)
      await vi.advanceTimersByTimeAsync(5_000)
      await rejection

      expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('skips if no egressBindings', async () => {
      const server: McpServerCRD = {
        name: 'basic-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'basic:latest',
          transport: { type: 'streamableHttp', url: 'http://basic:3000', port: 3000 },
        },
      }

      await reconciler.reconcileExternalEgress(server, { isCurrent: () => true })

      expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })
  })

  describe('inventory listing failures', () => {
    it('propagates context policy list failures instead of treating inventory as empty', async () => {
      mockApi.listNamespacedNetworkPolicy.mockRejectedValueOnce(new Error('api list denied'))

      await expect((reconciler as any).listPoliciesForContext('dev')).rejects.toThrow(
        'api list denied'
      )
    })

    it('propagates all-context policy list failures', async () => {
      mockApi.listNamespacedNetworkPolicy.mockRejectedValueOnce(new Error('api list denied'))

      await expect((reconciler as any).listAllContextPolicies()).rejects.toThrow('api list denied')
    })

    it('propagates all-context mcp-host egress policy list failures', async () => {
      mockApi.listNamespacedNetworkPolicy.mockRejectedValueOnce(new Error('api list denied'))

      await expect((reconciler as any).listAllContextEgressPolicies()).rejects.toThrow(
        'api list denied'
      )
    })

    it('propagates all external-egress policy list failures', async () => {
      mockApi.listNamespacedNetworkPolicy.mockRejectedValueOnce(new Error('api list denied'))

      await expect((reconciler as any).listAllExternalEgressPolicies()).rejects.toThrow(
        'api list denied'
      )
    })
  })

  describe('delete-context TOCTOU re-check', () => {
    it('stops mid-inventory when the context is recreated between two deletes', async () => {
      // deleteAllowed is a live GET, so its answer can change while the loop
      // runs. Hoisting the check out of the loop would satisfy every existing
      // test and still delete the recreated context's own policies.
      mockApi.listNamespacedNetworkPolicy.mockResolvedValueOnce({
        items: [
          { metadata: { name: 'ctx-allow-first' } },
          { metadata: { name: 'ctx-allow-second' } },
        ],
      })
      const deleteAllowed = vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(true)
        .mockResolvedValue(false)

      await reconciler.reconcileDeleteContext('dev', deleteAllowed)

      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'ctx-allow-first' })
      )
      expect(deleteAllowed).toHaveBeenCalledTimes(2)
    })

    it('re-checks before every mcp-host egress delete', async () => {
      mockApi.listNamespacedNetworkPolicy
        .mockResolvedValueOnce({ items: [] }) // context-allow
        .mockResolvedValueOnce({
          items: [
            { metadata: { name: 'host-egress-first' } },
            { metadata: { name: 'host-egress-second' } },
          ],
        })
      const deleteAllowed = vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(true)
        .mockResolvedValue(false)

      await reconciler.reconcileDeleteContext('dev', deleteAllowed)

      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'host-egress-first' })
      )
    })

    it('re-checks before every rpc-proxy egress delete', async () => {
      mockApi.listNamespacedNetworkPolicy
        .mockResolvedValueOnce({ items: [] }) // context-allow
        .mockResolvedValueOnce({ items: [] }) // mcp-host egress
        .mockResolvedValueOnce({
          items: [
            { metadata: { name: 'rpc-egress-first' } },
            { metadata: { name: 'rpc-egress-second' } },
          ],
        })
      const deleteAllowed = vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(true)
        .mockResolvedValue(false)

      await reconciler.reconcileDeleteContext('dev', deleteAllowed)

      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'rpc-egress-first' })
      )
    })
  })

  describe('L3 — DNS-derived retention by binding identity (B3)', () => {
    // Live DNS policy built through the reconciler's OWN builder so its identity
    // is exact-by-construction; each test drifts exactly one dimension.
    function makeDnsFixture() {
      const server: McpServerCRD = {
        name: 'openai-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'openai:latest',
          transport: { type: 'streamableHttp', port: 3000 },
          egressBindings: [{ dns: 'api.openai.com', port: 443 }],
        },
      }
      const binding = server.spec.egressBindings![0]
      const name = (reconciler as any).externalEgressPolicyName(server.name, binding) as string
      const live = (reconciler as any).buildExactHostEgressPolicy(server, name, binding, [
        '1.2.3.4/32',
      ]) as k8s.V1NetworkPolicy
      live.metadata!.uid = 'live-dns-uid'
      live.metadata!.resourceVersion = '11'
      return { server, binding, name, live }
    }

    async function runSafety(server: McpServerCRD, live: k8s.V1NetworkPolicy): Promise<boolean> {
      return (reconciler as any).reconcileExternalEgressSafety(
        server,
        [live],
        () => true
      ) as Promise<boolean>
    }

    function expectRevoked(name: string) {
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name,
          namespace: 'mcp-server',
          body: { preconditions: { uid: 'live-dns-uid', resourceVersion: '11' } },
        })
      )
    }

    it('(a) retains an unchanged DNS-derived allow — no revocation', async () => {
      const { server, live } = makeDnsFixture()
      await expect(runSafety(server, live)).resolves.toBe(true)
      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('(b) revokes on spec-level port drift under the same policy name', async () => {
      const { server, name, live } = makeDnsFixture()
      live.spec!.egress![0].ports = [{ port: 8443, protocol: 'TCP' }]
      await expect(runSafety(server, live)).resolves.toBe(true)
      expectRevoked(name)
    })

    it('(c) revokes on protocol drift TCP→UDP', async () => {
      const { server, name, live } = makeDnsFixture()
      live.spec!.egress![0].ports = [{ port: 443, protocol: 'UDP' }]
      await expect(runSafety(server, live)).resolves.toBe(true)
      expectRevoked(name)
    })

    it('(d) revokes a foreign-owned policy even when the spec is identical', async () => {
      const { server, name, live } = makeDnsFixture()
      live.metadata!.labels!['clerum.io/managed-by'] = 'foreign-controller'
      await expect(runSafety(server, live)).resolves.toBe(true)
      expectRevoked(name)
    })

    it('(f) revokes a degenerate zero-cidr "allow" (deny in disguise)', async () => {
      const { server, name, live } = makeDnsFixture()
      live.spec!.egress = []
      await expect(runSafety(server, live)).resolves.toBe(true)
      expectRevoked(name)
    })

    it('(e) queues recreation AT the revocation even when the pass then aborts and throws', async () => {
      const { server, binding, name } = makeDnsFixture()
      // Identity-drifted (protocol UDP) → this DNS allow is revoked (deleted).
      const live = (reconciler as any).buildExactHostEgressPolicy(server, name, binding, [
        '1.2.3.4/32',
      ]) as k8s.V1NetworkPolicy
      live.spec!.egress![0].ports = [{ port: 443, protocol: 'UDP' }]
      live.metadata!.uid = 'live-dns-uid'
      live.metadata!.resourceVersion = '11'

      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => ({
          items: !labelSelector && namespace === 'mcp-server' ? [live] : [],
        })
      )

      let resolved: McpServerCRD | undefined = server
      const spy = vi.fn()
      // Flip authority false AT the deletion, so the pass aborts right after the
      // revocation hook fires — reproducing the abort/throw window B3 must survive.
      mockApi.deleteNamespacedNetworkPolicy.mockImplementationOnce(async () => {
        resolved = undefined
        return {}
      })

      const rec = makeReconciler(mockApi, new Map([[server.name, server]]), mockCustomApi)

      await expect(
        rec.fullReconcile([], [server], {
          ensureDefaults: false,
          contextInventoryAuthoritative: () => true,
          serverInventoryAuthoritative: () => true,
          resolveCurrentServer: () => resolved,
          onExternalEgressRevoked: spy,
        })
      ).rejects.toThrow(/inventory changed during authoritative revocation/)

      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ name: server.name, namespace: server.namespace })
      )
    })
  })

  describe('startup fullReconcile', () => {
    it('discovers and revokes orphaned policies with one missing ownership marker in every safety lane', async () => {
      const partiallyLabelledByNamespace: Record<string, k8s.V1NetworkPolicy[]> = {
        'mcp-server': [
          {
            metadata: {
              name: 'ctx-orphan-context-old-server',
              labels: {
                'clerum.io/managed-by': 'host-context-controller',
                'clerum.io/context': 'orphan-context',
                'clerum.io/mcpserver': 'old-server',
              },
            },
            spec: { podSelector: {}, policyTypes: ['Ingress'] },
          },
          {
            metadata: {
              name: 'ext-egress-orphan-server-old-example-com-443',
              labels: {
                'clerum.io/policy-type': 'external-egress',
                'clerum.io/mcpserver': 'orphan-server',
                'clerum.io/egress-class': 'exact-host',
              },
            },
            spec: { podSelector: {}, policyTypes: ['Egress'] },
          },
        ],
        'mcp-host': [
          {
            metadata: {
              name: 'ctx-orphan-context-old-server-egress',
              labels: {
                'clerum.io/policy-type': 'context-allow',
                'clerum.io/context': 'orphan-context',
                'clerum.io/mcpserver': 'old-server',
              },
            },
            spec: { podSelector: {}, policyTypes: ['Egress'] },
          },
        ],
        'rpc-proxy': [
          {
            metadata: {
              name: 'rpc-egress-orphan-context-old-server',
              labels: {
                'clerum.io/managed-by': 'host-context-controller',
                'clerum.io/context': 'orphan-context',
                'clerum.io/mcpserver': 'old-server',
              },
            },
            spec: { podSelector: {}, policyTypes: ['Egress'] },
          },
        ],
      }
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => ({
          items: labelSelector ? [] : (partiallyLabelledByNamespace[namespace ?? ''] ?? []),
        })
      )
      const onAuthoritativeRevocationComplete = vi.fn()

      await reconciler.fullReconcile([], [], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        onAuthoritativeRevocationComplete,
      })

      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ctx-orphan-context-old-server',
          namespace: 'mcp-server',
        })
      )
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ctx-orphan-context-old-server-egress',
          namespace: 'mcp-host',
        })
      )
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'rpc-egress-orphan-context-old-server',
          namespace: 'rpc-proxy',
        })
      )
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ext-egress-orphan-server-old-example-com-443',
          namespace: 'mcp-server',
        })
      )
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(4)
      expect(onAuthoritativeRevocationComplete).toHaveBeenCalledOnce()
    })

    it('repairs one-marker live widened policies in every lane before certification', async () => {
      const server: McpServerCRD = {
        name: 'live-server',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'live-context',
          image: 'live:test',
          transport: { type: 'streamableHttp', port: 3000 },
          egressBindings: [{ cidr: '8.8.8.8/32', port: 443 }],
        },
      }
      const context: ContextCRD = {
        name: 'live-context-resource',
        namespace: 'mcp-server',
        spec: { contextId: 'live-context', mcpServers: [server.name] },
      }
      const cache = new Map([[server.name, server]])
      const rec = makeReconciler(mockApi, cache, mockCustomApi)

      await rec.reconcileContext(context, { isCurrent: () => true })
      await rec.reconcileExternalEgress(server, { isCurrent: () => true })
      const generated = mockApi.createNamespacedNetworkPolicy.mock.calls.map(
        call => (call[0] as { body: k8s.V1NetworkPolicy }).body
      )
      const widened = generated.map((policy, index) => ({
        ...policy,
        metadata: {
          ...policy.metadata,
          labels: Object.fromEntries(
            Object.entries(policy.metadata?.labels ?? {}).filter(
              ([label]) =>
                label !== (index % 2 === 0 ? 'clerum.io/managed-by' : 'clerum.io/policy-type')
            )
          ),
        },
        spec: {
          ...policy.spec,
          policyTypes: [...(policy.spec?.policyTypes ?? []), 'Ingress'],
        },
      }))

      vi.clearAllMocks()
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => ({
          items: labelSelector
            ? []
            : widened.filter(policy => policy.metadata?.namespace === namespace),
        })
      )
      mockApi.createNamespacedNetworkPolicy.mockRejectedValue(
        Object.assign(new Error('already exists'), { code: 409 })
      )
      const ordering: string[] = []
      mockApi.replaceNamespacedNetworkPolicy.mockImplementation(async ({ name }) => {
        ordering.push(`replace:${name}`)
        return {}
      })
      const onAuthoritativeRevocationComplete = vi.fn(() => ordering.push('certify'))

      await rec.fullReconcile([context], [server], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        resolveCurrentContext: () => context,
        resolveCurrentServer: () => server,
        onAuthoritativeRevocationComplete,
      })

      const certificationIndex = ordering.indexOf('certify')
      expect(certificationIndex).toBeGreaterThanOrEqual(4)
      for (const expectedName of [
        'ctx-live-context-live-server',
        'ctx-live-context-live-server-egress',
        'rpc-egress-live-context-live-server',
        'ext-egress-live-server-8-8-8-8-32-443',
      ]) {
        expect(ordering.indexOf(`replace:${expectedName}`)).toBeGreaterThanOrEqual(0)
        expect(ordering.indexOf(`replace:${expectedName}`)).toBeLessThan(certificationIndex)
      }
      expect(onAuthoritativeRevocationComplete).toHaveBeenCalledOnce()
    })

    it.each([
      [
        'context ingress',
        'mcp-server',
        {
          metadata: { name: 'ctx-reserved-context-server', labels: {} },
          spec: { podSelector: {}, policyTypes: ['Ingress'] },
        },
      ],
      [
        'host egress',
        'mcp-host',
        {
          metadata: { name: 'ctx-reserved-context-server-egress', labels: {} },
          spec: { podSelector: {}, policyTypes: ['Egress'] },
        },
      ],
      [
        'rpc egress',
        'rpc-proxy',
        {
          metadata: { name: 'rpc-egress-reserved-context-server', labels: {} },
          spec: { podSelector: {}, policyTypes: ['Egress'] },
        },
      ],
      [
        'external egress',
        'mcp-server',
        {
          metadata: { name: 'ext-egress-reserved-server-example-443', labels: {} },
          spec: { podSelector: {}, policyTypes: ['Egress'] },
        },
      ],
    ])(
      'fails closed without takeover for a both-markers-missing reserved %s name',
      async (_lane, namespace, candidate) => {
        mockApi.listNamespacedNetworkPolicy.mockImplementation(
          async ({
            namespace: listedNamespace,
            labelSelector,
          }: {
            namespace?: string
            labelSelector?: string
          }) => ({
            items: !labelSelector && listedNamespace === namespace ? [candidate] : [],
          })
        )
        const onAuthoritativeRevocationComplete = vi.fn()

        await expect(
          reconciler.fullReconcile([], [], {
            ensureDefaults: false,
            contextInventoryAuthoritative: () => true,
            serverInventoryAuthoritative: () => true,
            onAuthoritativeRevocationComplete,
          })
        ).rejects.toThrow(/Ambiguous NetworkPolicy ownership/)

        expect(onAuthoritativeRevocationComplete).not.toHaveBeenCalled()
        expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
        expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
      }
    )

    it('fails closed for an explicit foreign ownership conflict on an HCC-shaped policy', async () => {
      const candidate: k8s.V1NetworkPolicy = {
        metadata: {
          name: 'ext-egress-live-server-api-example-com-443',
          labels: {
            'clerum.io/managed-by': 'foreign-controller',
            'clerum.io/policy-type': 'external-egress',
            'clerum.io/mcpserver': 'live-server',
          },
        },
        spec: { podSelector: {}, policyTypes: ['Egress'] },
      }
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => ({
          items: !labelSelector && namespace === 'mcp-server' ? [candidate] : [],
        })
      )
      const onAuthoritativeRevocationComplete = vi.fn()

      await expect(
        reconciler.fullReconcile([], [], {
          ensureDefaults: false,
          contextInventoryAuthoritative: () => true,
          serverInventoryAuthoritative: () => true,
          onAuthoritativeRevocationComplete,
        })
      ).rejects.toThrow(/Ambiguous NetworkPolicy ownership/)

      expect(onAuthoritativeRevocationComplete).not.toHaveBeenCalled()
      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('treats a non-reserved external policy missing its manager marker as ambiguous', async () => {
      const candidate: k8s.V1NetworkPolicy = {
        metadata: {
          name: 'custom-egress-policy',
          labels: {
            'clerum.io/policy-type': 'external-egress',
            'clerum.io/mcpserver': 'live-server',
          },
        },
        spec: { podSelector: {}, policyTypes: ['Egress'] },
      }
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => ({
          items: !labelSelector && namespace === 'mcp-server' ? [candidate] : [],
        })
      )
      const onAuthoritativeRevocationComplete = vi.fn()

      await expect(
        reconciler.fullReconcile([], [], {
          ensureDefaults: false,
          contextInventoryAuthoritative: () => true,
          serverInventoryAuthoritative: () => true,
          onAuthoritativeRevocationComplete,
        })
      ).rejects.toThrow(/Ambiguous NetworkPolicy ownership/)

      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(onAuthoritativeRevocationComplete).not.toHaveBeenCalled()
    })

    it('lets the broad snapshot shadow a selected-owned object that became unrelated at the same UID', async () => {
      const selected: k8s.V1NetworkPolicy = {
        metadata: {
          name: 'legacy-custom-policy',
          uid: 'stable-policy-uid',
          resourceVersion: '7',
          labels: {
            'clerum.io/managed-by': 'host-context-controller',
            'clerum.io/policy-type': 'context-allow',
            'clerum.io/context': 'orphan-context',
            'clerum.io/mcpserver': 'old-server',
          },
        },
        spec: { podSelector: {}, policyTypes: ['Ingress'] },
      }
      const broadRelabelled: k8s.V1NetworkPolicy = {
        ...selected,
        metadata: {
          ...selected.metadata,
          resourceVersion: '8',
          labels: { 'tenant.example/managed-by': 'tenant-controller' },
        },
      }
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => {
          if (namespace !== 'mcp-server') return { items: [] }
          if (labelSelector?.includes('policy-type=context-allow')) return { items: [selected] }
          if (!labelSelector) return { items: [broadRelabelled] }
          return { items: [] }
        }
      )
      const onAuthoritativeRevocationComplete = vi.fn()

      await reconciler.fullReconcile([], [], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        onAuthoritativeRevocationComplete,
      })

      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(onAuthoritativeRevocationComplete).toHaveBeenCalledOnce()
    })

    it('leaves unrelated namespace policies untouched and still certifies', async () => {
      const unrelated: k8s.V1NetworkPolicy = {
        metadata: {
          name: 'tenant-owned-policy',
          labels: {
            'app.kubernetes.io/managed-by': 'tenant-operator',
            'tenant.example/purpose': 'custom-egress',
          },
        },
        spec: { podSelector: {}, policyTypes: ['Egress'] },
      }
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => ({
          items: !labelSelector && namespace === 'mcp-server' ? [unrelated] : [],
        })
      )
      const onAuthoritativeRevocationComplete = vi.fn()

      await reconciler.fullReconcile([], [], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        onAuthoritativeRevocationComplete,
      })

      expect(onAuthoritativeRevocationComplete).toHaveBeenCalledOnce()
      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('fails closed when the broad safety inventory LIST fails', async () => {
      mockApi.listNamespacedNetworkPolicy
        .mockResolvedValueOnce({ items: [] })
        .mockResolvedValueOnce({ items: [] })
        .mockResolvedValueOnce({ items: [] })
        .mockResolvedValueOnce({ items: [] })
        .mockRejectedValueOnce(new Error('broad inventory denied'))
      const onAuthoritativeRevocationComplete = vi.fn()

      await expect(
        reconciler.fullReconcile([], [], {
          ensureDefaults: false,
          contextInventoryAuthoritative: () => true,
          serverInventoryAuthoritative: () => true,
          onAuthoritativeRevocationComplete,
        })
      ).rejects.toThrow('broad inventory denied')

      expect(onAuthoritativeRevocationComplete).not.toHaveBeenCalled()
      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('withholds certification and mutation when Context authority is lost during the broad LIST', async () => {
      let contextAuthoritative = true
      const candidate: k8s.V1NetworkPolicy = {
        metadata: {
          name: 'ctx-orphan-context-old-server',
          labels: {
            'clerum.io/policy-type': 'context-allow',
            'clerum.io/context': 'orphan-context',
            'clerum.io/mcpserver': 'old-server',
          },
        },
        spec: { podSelector: {}, policyTypes: ['Ingress'] },
      }
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => {
          if (!labelSelector && namespace === 'mcp-server') {
            contextAuthoritative = false
            return { items: [candidate] }
          }
          return { items: [] }
        }
      )
      const onAuthoritativeRevocationComplete = vi.fn()

      await reconciler.fullReconcile([], [], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => contextAuthoritative,
        serverInventoryAuthoritative: () => true,
        onAuthoritativeRevocationComplete,
      })

      expect(onAuthoritativeRevocationComplete).not.toHaveBeenCalled()
      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('does not reconcile a queued Context when its current contextId changed', async () => {
      const queuedContext: ContextCRD = {
        name: 'mutable-context-resource',
        namespace: 'mcp-server',
        spec: { contextId: 'captured-context', mcpServers: [] },
      }
      const currentContext: ContextCRD = {
        ...queuedContext,
        spec: { contextId: 'replacement-context', mcpServers: [] },
      }
      const reconcileContext = vi.spyOn(reconciler, 'reconcileContext').mockResolvedValue(true)
      const effectKeys: string[] = []

      await reconciler.fullReconcile([queuedContext], [], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => false,
        resolveCurrentContext: () => currentContext,
        runContextEffect: async (contextId, work) => {
          effectKeys.push(contextId)
          await work()
        },
      })

      expect(effectKeys).toEqual(['captured-context', 'captured-context'])
      expect(reconcileContext).not.toHaveBeenCalled()
    })

    it('retires a full-pass Context lease when the selected object is replaced', async () => {
      const selected: ContextCRD = {
        name: 'full-pass-context',
        namespace: 'mcp-server',
        spec: { contextId: 'full-pass-context', description: 'old', mcpServers: [] },
      }
      const replacement: ContextCRD = {
        ...selected,
        spec: { ...selected.spec, description: 'new' },
      }
      let current = selected
      let selectedLease: (() => boolean) | undefined
      const mutationStarted = deferred()
      const releaseMutation = deferred()
      vi.spyOn(reconciler, 'reconcileContext').mockImplementationOnce(async (_context, options) => {
        selectedLease = options?.isCurrent
        mutationStarted.resolve(undefined)
        await releaseMutation.promise
        return true
      })

      const fullPass = reconciler.fullReconcile([selected], [], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        resolveCurrentContext: () => current,
      })
      await mutationStarted.promise
      expect(selectedLease?.()).toBe(true)

      current = replacement
      expect(selectedLease?.()).toBe(false)
      releaseMutation.resolve(undefined)
      await fullPass
    })

    it('deletes orphaned Context policies in all three namespaces through the canonical contextId effect key', async () => {
      const effectKeys: string[] = []
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => {
          if (namespace === 'mcp-server' && labelSelector?.includes('context-allow')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'ctx-orphan-context-old-server',
                    labels: { 'clerum.io/context': 'orphan-context' },
                  },
                },
              ],
            }
          }
          if (namespace === 'mcp-host' && labelSelector?.includes('context-allow')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'ctx-orphan-context-old-server-egress',
                    labels: { 'clerum.io/context': 'orphan-context' },
                  },
                },
              ],
            }
          }
          if (namespace === 'rpc-proxy' && labelSelector?.includes('rpc-proxy-egress')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'rpc-egress-orphan-context-old-server',
                    labels: { 'clerum.io/context': 'orphan-context' },
                  },
                },
              ],
            }
          }
          return { items: [] }
        }
      )

      await reconciler.fullReconcile([], [], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        runContextEffect: async (contextId, work) => {
          effectKeys.push(contextId)
          await work()
        },
      })

      expect(effectKeys).toEqual(['orphan-context', 'orphan-context', 'orphan-context'])
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ctx-orphan-context-old-server',
          namespace: 'mcp-server',
        })
      )
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ctx-orphan-context-old-server-egress',
          namespace: 'mcp-host',
        })
      )
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'rpc-egress-orphan-context-old-server',
          namespace: 'rpc-proxy',
        })
      )
    })

    it('routes desired and orphan Context policy lanes through canonical contextId effect keys', async () => {
      const desiredContext: ContextCRD = {
        name: 'desired-context-resource',
        namespace: 'mcp-server',
        spec: { contextId: 'desired-context', mcpServers: [] },
      }
      const effectKeys: string[] = []
      vi.spyOn(reconciler, 'reconcileContext').mockResolvedValue(true)
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => {
          if (namespace === 'mcp-server' && labelSelector?.includes('context-allow')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'ctx-orphan-context-old-server',
                    labels: { 'clerum.io/context': 'orphan-context' },
                  },
                },
              ],
            }
          }
          if (namespace === 'rpc-proxy' && labelSelector?.includes('rpc-proxy-egress')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'rpc-egress-orphan-context-old-server',
                    labels: { 'clerum.io/context': 'orphan-context' },
                  },
                },
              ],
            }
          }
          return { items: [] }
        }
      )

      await reconciler.fullReconcile([desiredContext], [], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        runContextEffect: async (contextId, work) => {
          effectKeys.push(contextId)
          await work()
        },
      })

      expect(effectKeys).toEqual([
        'orphan-context',
        'orphan-context',
        'desired-context',
        'desired-context',
      ])
    })

    it('revokes every orphan allow lane before a slow additive Context effect', async () => {
      const desiredContext: ContextCRD = {
        name: 'desired-context-resource',
        namespace: 'mcp-server',
        spec: { contextId: 'desired-context', mcpServers: [] },
      }
      const additiveStarted = deferred()
      const releaseAdditive = deferred()
      vi.spyOn(reconciler, 'reconcileContext').mockImplementationOnce(async () => {
        additiveStarted.resolve(undefined)
        await releaseAdditive.promise
        return true
      })
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => {
          if (namespace === 'mcp-server' && labelSelector?.includes('context-allow')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'ctx-orphan-context-old-server',
                    labels: { 'clerum.io/context': 'orphan-context' },
                  },
                },
              ],
            }
          }
          if (namespace === 'mcp-host' && labelSelector?.includes('context-allow')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'ctx-orphan-context-old-server-egress',
                    labels: { 'clerum.io/context': 'orphan-context' },
                  },
                },
              ],
            }
          }
          if (namespace === 'rpc-proxy' && labelSelector?.includes('rpc-proxy-egress')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'rpc-egress-orphan-context-old-server',
                    labels: { 'clerum.io/context': 'orphan-context' },
                  },
                },
              ],
            }
          }
          if (namespace === 'mcp-server' && labelSelector?.includes('external-egress')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'ext-egress-orphan-server-old.example',
                    labels: { 'clerum.io/mcpserver': 'orphan-server' },
                  },
                },
              ],
            }
          }
          return { items: [] }
        }
      )

      const fullPass = reconciler.fullReconcile([desiredContext], [], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
      })

      await additiveStarted.promise
      try {
        expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'ctx-orphan-context-old-server',
            namespace: 'mcp-server',
          })
        )
        expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'ctx-orphan-context-old-server-egress',
            namespace: 'mcp-host',
          })
        )
        expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'rpc-egress-orphan-context-old-server',
            namespace: 'rpc-proxy',
          })
        )
        expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'ext-egress-orphan-server-old.example',
            namespace: 'mcp-server',
          })
        )
      } finally {
        releaseAdditive.resolve(undefined)
        await fullPass
      }
    })

    it('revokes every stale allow lane for a live Context before signaling authoritative revocation', async () => {
      const liveContext: ContextCRD = {
        name: 'live-context-resource',
        namespace: 'mcp-server',
        spec: { contextId: 'live-context', mcpServers: [] },
      }
      const additiveStarted = deferred()
      const releaseAdditive = deferred()
      vi.spyOn(reconciler, 'reconcileContext').mockImplementationOnce(async () => {
        additiveStarted.resolve(undefined)
        await releaseAdditive.promise
        return true
      })
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => {
          if (namespace === 'mcp-server' && labelSelector?.includes('context-allow')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'ctx-live-context-removed-server',
                    labels: { 'clerum.io/context': 'live-context' },
                  },
                },
              ],
            }
          }
          if (namespace === 'mcp-host' && labelSelector?.includes('context-allow')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'ctx-live-context-removed-server-egress',
                    labels: { 'clerum.io/context': 'live-context' },
                  },
                },
              ],
            }
          }
          if (namespace === 'rpc-proxy' && labelSelector?.includes('rpc-proxy-egress')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'rpc-egress-live-context-removed-server',
                    labels: { 'clerum.io/context': 'live-context' },
                  },
                },
              ],
            }
          }
          return { items: [] }
        }
      )
      const onAuthoritativeRevocationComplete = vi.fn()

      const fullPass = reconciler.fullReconcile([liveContext], [], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        onAuthoritativeRevocationComplete,
      })

      await additiveStarted.promise
      try {
        expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'ctx-live-context-removed-server',
            namespace: 'mcp-server',
          })
        )
        expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'ctx-live-context-removed-server-egress',
            namespace: 'mcp-host',
          })
        )
        expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'rpc-egress-live-context-removed-server',
            namespace: 'rpc-proxy',
          })
        )
        expect(onAuthoritativeRevocationComplete).toHaveBeenCalledOnce()
      } finally {
        releaseAdditive.resolve(undefined)
        await fullPass
      }
    })

    it('revokes stale external egress for a live McpServer before readiness certification', async () => {
      const liveServer: McpServerCRD = {
        name: 'live-server',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'default',
          image: 'live:latest',
          transport: { type: 'streamableHttp', port: 3000 },
          egressBindings: [],
        },
      }
      const ordering: string[] = []
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => {
          if (namespace === 'mcp-server' && labelSelector?.includes('external-egress')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'ext-egress-live-server-old.example-443',
                    labels: { 'clerum.io/mcpserver': 'live-server' },
                  },
                },
              ],
            }
          }
          return { items: [] }
        }
      )
      mockApi.deleteNamespacedNetworkPolicy.mockImplementation(async () => {
        ordering.push('delete')
        return {}
      })
      const onAuthoritativeRevocationComplete = vi.fn(() => {
        ordering.push('certify')
      })

      await reconciler.fullReconcile([], [liveServer], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        onAuthoritativeRevocationComplete,
      })

      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ext-egress-live-server-old.example-443',
          namespace: 'mcp-server',
        })
      )
      expect(ordering.slice(0, 2)).toEqual(['delete', 'certify'])
      expect(onAuthoritativeRevocationComplete).toHaveBeenCalledOnce()
    })

    it('does not let one post-certification Context failure starve later additive owners', async () => {
      const contexts: ContextCRD[] = ['aaa-poisoned', 'bbb-healthy'].map(contextId => ({
        name: `${contextId}-resource`,
        namespace: 'mcp-server',
        spec: { contextId, mcpServers: [] },
      }))
      const ordering: string[] = []
      const additiveFailure = new Error('poisoned additive Context')
      vi.spyOn(reconciler, 'reconcileContext').mockImplementation(async context => {
        ordering.push(`context:${context.spec.contextId}`)
        if (context.spec.contextId === 'aaa-poisoned') throw additiveFailure
        return true
      })
      const onAuthoritativeRevocationComplete = vi.fn(() => {
        ordering.push('certify')
      })
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

      const error = await reconciler
        .fullReconcile(contexts, [], {
          ensureDefaults: false,
          contextInventoryAuthoritative: () => true,
          serverInventoryAuthoritative: () => true,
          onAuthoritativeRevocationComplete,
        })
        .then(
          () => undefined,
          failure => failure
        )

      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([additiveFailure])
      expect(ordering).toEqual(['certify', 'context:aaa-poisoned', 'context:bbb-healthy'])
      expect(errorLog).toHaveBeenCalledWith(
        '[NetPol] Additive Context reconciliation failed for "aaa-poisoned":',
        additiveFailure
      )
    })

    it('replaces same-name Context allow policies in every lane before certification', async () => {
      const oldServer: McpServerCRD = {
        name: 'live-server',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'default',
          image: 'live:latest',
          transport: { type: 'streamableHttp', port: 3000 },
        },
      }
      const currentServer: McpServerCRD = {
        ...oldServer,
        spec: {
          ...oldServer.spec,
          transport: { type: 'streamableHttp', port: 4000 },
        },
      }
      const liveContext: ContextCRD = {
        name: 'live-context-resource',
        namespace: 'mcp-server',
        spec: { contextId: 'live-context', mcpServers: [oldServer.name] },
      }
      const serverCache = new Map([[oldServer.name, oldServer]])
      const rec = makeReconciler(mockApi, serverCache, mockCustomApi)

      await rec.reconcileContext(liveContext, { isCurrent: () => true })
      const oldPolicies = mockApi.createNamespacedNetworkPolicy.mock.calls.map(
        call => (call[0] as { body: k8s.V1NetworkPolicy }).body
      )
      expect(oldPolicies).toHaveLength(3)

      vi.clearAllMocks()
      serverCache.set(currentServer.name, currentServer)
      mockApi.createNamespacedNetworkPolicy.mockRejectedValue(
        Object.assign(new Error('already exists'), { code: 409 })
      )
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => {
          if (labelSelector?.includes('external-egress')) return { items: [] }
          return {
            items: oldPolicies.filter(policy => policy.metadata?.namespace === namespace),
          }
        }
      )
      vi.spyOn(rec, 'reconcileContext').mockResolvedValue(true)
      vi.spyOn(rec, 'reconcileExternalEgress').mockResolvedValue(undefined)
      const ordering: string[] = []
      mockApi.replaceNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace }: { namespace?: string }) => {
          ordering.push(`replace:${namespace}`)
          return {}
        }
      )
      const onAuthoritativeRevocationComplete = vi.fn(() => ordering.push('certify'))

      await rec.fullReconcile([liveContext], [currentServer], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        onAuthoritativeRevocationComplete,
      })

      expect(ordering).toEqual([
        'replace:mcp-server',
        'replace:mcp-host',
        'replace:rpc-proxy',
        'certify',
      ])
      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(onAuthoritativeRevocationComplete).toHaveBeenCalledOnce()
    })

    it.each([
      ['context-ingress', 'mcp-server'],
      ['context-host-egress', 'mcp-host'],
      ['context-rpc-egress', 'rpc-proxy'],
    ])(
      'refuses a same-name %s safety replacement owned by another server',
      async (_lane, targetNamespace) => {
        const oldServer: McpServerCRD = {
          name: 'live-server',
          namespace: 'mcp-server',
          spec: {
            contextRef: 'default',
            image: 'live:latest',
            transport: { type: 'streamableHttp', port: 3000 },
          },
        }
        const currentServer: McpServerCRD = {
          ...oldServer,
          spec: {
            ...oldServer.spec,
            transport: { type: 'streamableHttp', port: 4000 },
          },
        }
        const liveContext: ContextCRD = {
          name: 'live-context-resource',
          namespace: 'mcp-server',
          spec: { contextId: 'live-context', mcpServers: [oldServer.name] },
        }
        const serverCache = new Map([[oldServer.name, oldServer]])
        const rec = makeReconciler(mockApi, serverCache, mockCustomApi)

        await rec.reconcileContext(liveContext, { isCurrent: () => true })
        const oldPolicies = mockApi.createNamespacedNetworkPolicy.mock.calls.map(call => {
          const policy = (call[0] as { body: k8s.V1NetworkPolicy }).body
          if (policy.metadata?.namespace !== targetNamespace) return policy
          return {
            ...policy,
            metadata: {
              ...policy.metadata,
              labels: {
                ...policy.metadata?.labels,
                'clerum.io/mcpserver': 'different-server',
              },
            },
          }
        })

        vi.clearAllMocks()
        serverCache.set(currentServer.name, currentServer)
        mockApi.listNamespacedNetworkPolicy.mockImplementation(
          async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => {
            if (labelSelector?.includes('external-egress')) return { items: [] }
            return {
              items: oldPolicies.filter(policy => policy.metadata?.namespace === namespace),
            }
          }
        )
        const onAuthoritativeRevocationComplete = vi.fn()

        await expect(
          rec.fullReconcile([liveContext], [currentServer], {
            ensureDefaults: false,
            contextInventoryAuthoritative: () => true,
            serverInventoryAuthoritative: () => true,
            onAuthoritativeRevocationComplete,
          })
        ).rejects.toThrow(/ownership/i)

        expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
          expect.objectContaining({ namespace: targetNamespace })
        )
        expect(onAuthoritativeRevocationComplete).not.toHaveBeenCalled()
      }
    )

    it('fails the safety pass without certifying when a same-name Context replacement fails', async () => {
      const oldServer: McpServerCRD = {
        name: 'live-server',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'default',
          image: 'live:latest',
          transport: { type: 'streamableHttp', port: 3000 },
        },
      }
      const currentServer: McpServerCRD = {
        ...oldServer,
        spec: {
          ...oldServer.spec,
          transport: { type: 'streamableHttp', port: 4000 },
        },
      }
      const liveContext: ContextCRD = {
        name: 'live-context-resource',
        namespace: 'mcp-server',
        spec: { contextId: 'live-context', mcpServers: [oldServer.name] },
      }
      const serverCache = new Map([[oldServer.name, oldServer]])
      const rec = makeReconciler(mockApi, serverCache, mockCustomApi)

      await rec.reconcileContext(liveContext, { isCurrent: () => true })
      const oldPolicies = mockApi.createNamespacedNetworkPolicy.mock.calls.map(
        call => (call[0] as { body: k8s.V1NetworkPolicy }).body
      )

      vi.clearAllMocks()
      serverCache.set(currentServer.name, currentServer)
      mockApi.createNamespacedNetworkPolicy.mockRejectedValue(
        Object.assign(new Error('already exists'), { code: 409 })
      )
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => {
          if (labelSelector?.includes('external-egress')) return { items: [] }
          return {
            items: oldPolicies.filter(policy => policy.metadata?.namespace === namespace),
          }
        }
      )
      const replacementFailure = new Error('replace unavailable')
      mockApi.replaceNamespacedNetworkPolicy.mockRejectedValueOnce(replacementFailure)
      const onAuthoritativeRevocationComplete = vi.fn()

      await expect(
        rec.fullReconcile([liveContext], [currentServer], {
          ensureDefaults: false,
          contextInventoryAuthoritative: () => true,
          serverInventoryAuthoritative: () => true,
          onAuthoritativeRevocationComplete,
        })
      ).rejects.toBe(replacementFailure)

      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(onAuthoritativeRevocationComplete).not.toHaveBeenCalled()
      expect(networkPolicySafetyPassDurationSeconds.observe).toHaveBeenCalledWith(
        { outcome: 'failed' },
        expect.any(Number)
      )
      expect(networkPolicySafetyPassDurationSeconds.observe).toHaveBeenCalledTimes(1)
    })

    it('retains authoritative same-name policies when only API object key order differs', async () => {
      const server: McpServerCRD = {
        name: 'live-server',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'default',
          image: 'live:latest',
          transport: { type: 'streamableHttp', port: 3000 },
        },
      }
      const liveContext: ContextCRD = {
        name: 'live-context-resource',
        namespace: 'mcp-server',
        spec: { contextId: 'live-context', mcpServers: [server.name] },
      }
      const rec = makeReconciler(mockApi, new Map([[server.name, server]]), mockCustomApi)
      const reverseObjectKeys = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(reverseObjectKeys)
        if (value === null || typeof value !== 'object') return value
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .reverse()
            .map(([key, entry]) => [key, reverseObjectKeys(entry)])
        )
      }

      await rec.reconcileContext(liveContext, { isCurrent: () => true })
      const existingPolicies = mockApi.createNamespacedNetworkPolicy.mock.calls.map(call => {
        const policy = (call[0] as { body: k8s.V1NetworkPolicy }).body
        return { ...policy, spec: reverseObjectKeys(policy.spec) as k8s.V1NetworkPolicySpec }
      })
      vi.clearAllMocks()
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => {
          if (labelSelector?.includes('external-egress')) return { items: [] }
          return {
            items: existingPolicies.filter(policy => policy.metadata?.namespace === namespace),
          }
        }
      )
      vi.spyOn(rec, 'reconcileContext').mockResolvedValue(true)
      vi.spyOn(rec, 'reconcileExternalEgress').mockResolvedValue(undefined)

      await rec.fullReconcile([liveContext], [server], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
      })

      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('revokes same-name DNS egress before certifying and leaves refresh to its coordinator', async () => {
      const oldServer: McpServerCRD = {
        name: 'live-server',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'default',
          image: 'live:latest',
          transport: { type: 'streamableHttp', port: 3000 },
          egressBindings: [{ dns: 'api.example.com', port: 443, protocol: 'TCP' }],
        },
      }
      const currentServer: McpServerCRD = {
        ...oldServer,
        spec: {
          ...oldServer.spec,
          egressBindings: [{ dns: 'api.example.com', port: 443, protocol: 'UDP' }],
        },
      }
      const rec = makeReconciler(mockApi, new Map([[oldServer.name, oldServer]]), mockCustomApi)

      await rec.reconcileExternalEgress(oldServer, { isCurrent: () => true })
      const oldPolicy = mockApi.createNamespacedNetworkPolicy.mock.calls
        .map(call => (call[0] as { body: k8s.V1NetworkPolicy }).body)
        .find(policy => policy.metadata?.labels?.['clerum.io/policy-type'] === 'external-egress')
      expect(oldPolicy).toBeDefined()

      vi.clearAllMocks()
      const ordering: string[] = []
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ labelSelector }: { labelSelector?: string }) =>
          labelSelector?.includes('external-egress') ? { items: [oldPolicy!] } : { items: [] }
      )
      mockApi.createNamespacedNetworkPolicy.mockRejectedValue(
        Object.assign(new Error('already exists'), { code: 409 })
      )
      mockApi.replaceNamespacedNetworkPolicy.mockImplementation(async () => {
        ordering.push('replace')
        return {}
      })
      mockApi.deleteNamespacedNetworkPolicy.mockImplementation(async () => {
        ordering.push('delete')
        return {}
      })
      const onAuthoritativeRevocationComplete = vi.fn(() => {
        ordering.push('certify')
      })

      await rec.fullReconcile([], [currentServer], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        onAuthoritativeRevocationComplete,
      })

      expect(ordering.slice(0, 2)).toEqual(['delete', 'certify'])
      expect(ordering).not.toContain('replace')
      expect(dns.resolve4).not.toHaveBeenCalled()
      expect(onAuthoritativeRevocationComplete).toHaveBeenCalledOnce()
    })

    it('revokes a divergent same-name DNS policy when its safe replacement cannot resolve', async () => {
      const oldServer: McpServerCRD = {
        name: 'live-server',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'default',
          image: 'live:latest',
          transport: { type: 'streamableHttp', port: 3000 },
          egressBindings: [{ dns: 'api.example.com', port: 443, protocol: 'TCP' }],
        },
      }
      const currentServer: McpServerCRD = {
        ...oldServer,
        spec: {
          ...oldServer.spec,
          egressBindings: [{ dns: 'api.example.com', port: 443, protocol: 'UDP' }],
        },
      }
      const rec = makeReconciler(mockApi, new Map([[oldServer.name, oldServer]]), mockCustomApi)

      await rec.reconcileExternalEgress(oldServer, { isCurrent: () => true })
      const oldPolicy = mockApi.createNamespacedNetworkPolicy.mock.calls
        .map(call => (call[0] as { body: k8s.V1NetworkPolicy }).body)
        .find(policy => policy.metadata?.labels?.['clerum.io/policy-type'] === 'external-egress')
      expect(oldPolicy).toBeDefined()

      vi.clearAllMocks()
      const ordering: string[] = []
      vi.mocked(dns.resolve4).mockImplementation(async () => {
        ordering.push('dns')
        throw new Error('dns unavailable')
      })
      let currentPolicies = [oldPolicy!]
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ labelSelector }: { labelSelector?: string }) =>
          labelSelector?.includes('external-egress') ? { items: currentPolicies } : { items: [] }
      )
      mockApi.deleteNamespacedNetworkPolicy.mockImplementation(async () => {
        ordering.push('delete')
        currentPolicies = []
        return {}
      })
      const onAuthoritativeRevocationComplete = vi.fn(() => {
        ordering.push('certify')
      })

      await expect(
        rec.fullReconcile([], [currentServer], {
          ensureDefaults: false,
          contextInventoryAuthoritative: () => true,
          serverInventoryAuthoritative: () => true,
          onAuthoritativeRevocationComplete,
        })
      ).resolves.toBeUndefined()

      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: oldPolicy!.metadata!.name!,
          namespace: oldServer.namespace,
        })
      )
      expect(onAuthoritativeRevocationComplete).toHaveBeenCalledOnce()
      expect(dns.resolve4).not.toHaveBeenCalled()
      expect(ordering).toEqual(['delete', 'certify'])
    })

    it('revokes a renamed DNS binding before certification and performs no DNS lookup on the safety path', async () => {
      const oldServer: McpServerCRD = {
        name: 'renamed-dns-server',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'default',
          image: 'dns:test',
          transport: { type: 'streamableHttp', port: 3000 },
          egressBindings: [{ dns: 'old.example.com', port: 443 }],
        },
      }
      const currentServer: McpServerCRD = {
        ...oldServer,
        spec: {
          ...oldServer.spec,
          egressBindings: [{ dns: 'new.example.com', port: 443 }],
        },
      }
      const rec = makeReconciler(mockApi, new Map([[oldServer.name, oldServer]]), mockCustomApi)
      await rec.reconcileExternalEgress(oldServer, { isCurrent: () => true })
      const oldPolicy = mockApi.createNamespacedNetworkPolicy.mock.calls
        .map(call => (call[0] as { body: k8s.V1NetworkPolicy }).body)
        .find(policy => policy.metadata?.labels?.['clerum.io/policy-type'] === 'external-egress')!

      vi.clearAllMocks()
      const ordering: string[] = []
      let currentPolicies = [oldPolicy]
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ labelSelector }: { labelSelector?: string }) =>
          labelSelector?.includes('external-egress') ? { items: currentPolicies } : { items: [] }
      )
      mockApi.deleteNamespacedNetworkPolicy.mockImplementation(async ({ name }) => {
        ordering.push('delete')
        currentPolicies = currentPolicies.filter(policy => policy.metadata?.name !== name)
        return {}
      })
      vi.mocked(dns.resolve4).mockImplementation(async () => {
        ordering.push('dns')
        return ['1.2.3.4']
      })
      const onAuthoritativeRevocationComplete = vi.fn(() => {
        expect(dns.resolve4).not.toHaveBeenCalled()
        ordering.push('certify')
      })

      await rec.fullReconcile([], [currentServer], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        onAuthoritativeRevocationComplete,
      })

      expect(ordering).toEqual(['delete', 'certify'])
      expect(dns.resolve4).not.toHaveBeenCalled()
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: oldPolicy.metadata!.name!,
        namespace: oldServer.namespace,
        body: {
          preconditions: {
            uid: `${oldServer.namespace}:${oldPolicy.metadata!.name!}:uid`,
            resourceVersion: '1',
          },
        },
      })
    })

    it('replaces deterministic drift and revokes renamed DNS before certification without resolving DNS', async () => {
      const oldServer: McpServerCRD = {
        name: 'mixed-drift-server',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'default',
          image: 'mixed:test',
          transport: { type: 'streamableHttp', port: 3000 },
          egressBindings: [
            { cidr: '8.8.8.8/32', port: 443, protocol: 'TCP' },
            { dns: 'old.example.com', port: 443, protocol: 'TCP' },
          ],
        },
      }
      const currentServer: McpServerCRD = {
        ...oldServer,
        spec: {
          ...oldServer.spec,
          egressBindings: [
            { cidr: '8.8.8.8/32', port: 443, protocol: 'UDP' },
            { dns: 'new.example.com', port: 443, protocol: 'TCP' },
          ],
        },
      }
      const rec = makeReconciler(mockApi, new Map([[oldServer.name, oldServer]]), mockCustomApi)
      await rec.reconcileExternalEgress(oldServer, { isCurrent: () => true })
      const oldPolicies = mockApi.createNamespacedNetworkPolicy.mock.calls
        .map(call => (call[0] as { body: k8s.V1NetworkPolicy }).body)
        .filter(policy => policy.metadata?.labels?.['clerum.io/policy-type'] === 'external-egress')

      vi.clearAllMocks()
      const ordering: string[] = []
      let currentPolicies = oldPolicies
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ labelSelector }: { labelSelector?: string }) =>
          labelSelector?.includes('external-egress') ? { items: currentPolicies } : { items: [] }
      )
      mockApi.replaceNamespacedNetworkPolicy.mockImplementation(async () => {
        ordering.push('replace')
        return {}
      })
      mockApi.deleteNamespacedNetworkPolicy.mockImplementation(async ({ name }) => {
        ordering.push('delete')
        currentPolicies = currentPolicies.filter(policy => policy.metadata?.name !== name)
        return {}
      })
      vi.mocked(dns.resolve4).mockImplementation(async () => {
        ordering.push('dns')
        return ['1.2.3.4']
      })
      const onAuthoritativeRevocationComplete = vi.fn(() => {
        expect(dns.resolve4).not.toHaveBeenCalled()
        ordering.push('certify')
      })

      await rec.fullReconcile([], [currentServer], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        onAuthoritativeRevocationComplete,
      })

      expect(ordering).toEqual(['replace', 'delete', 'certify'])
      expect(dns.resolve4).not.toHaveBeenCalled()
    })

    it('aborts certification when an identity-drifted safety delete reports a recreate conflict', async () => {
      const server: McpServerCRD = {
        name: 'recreated-dns-server',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'default',
          image: 'dns:test',
          transport: { type: 'streamableHttp', port: 3000 },
          egressBindings: [{ dns: 'api.example.com', port: 443 }],
        },
      }
      const rec = makeReconciler(mockApi, new Map([[server.name, server]]), mockCustomApi)
      await rec.reconcileExternalEgress(server, { isCurrent: () => true })
      const existing = mockApi.createNamespacedNetworkPolicy.mock.calls
        .map(call => (call[0] as { body: k8s.V1NetworkPolicy }).body)
        .find(policy => policy.metadata?.labels?.['clerum.io/policy-type'] === 'external-egress')!
      // B3: identity-drift the live policy (protocol TCP→UDP) so the safety pass
      // still revokes it. A same-intent (identity-stable) DNS allow is now
      // RETAINED (see the retention pins in the B3 describe block); the revoke /
      // abort machinery this test guards fires only for a drifted policy.
      existing.spec!.egress = existing.spec!.egress!.map(rule => ({
        ...rule,
        ports: rule.ports?.map(port => ({ ...port, protocol: 'UDP' })),
      }))

      vi.clearAllMocks()
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ labelSelector }: { labelSelector?: string }) =>
          labelSelector?.includes('external-egress') ? { items: [existing] } : { items: [] }
      )
      const conflict = Object.assign(new Error('delete precondition conflict'), { code: 409 })
      mockApi.deleteNamespacedNetworkPolicy.mockRejectedValue(conflict)
      const onAuthoritativeRevocationComplete = vi.fn()

      await expect(
        rec.fullReconcile([], [server], {
          ensureDefaults: false,
          contextInventoryAuthoritative: () => true,
          serverInventoryAuthoritative: () => true,
          onAuthoritativeRevocationComplete,
        })
      ).rejects.toBe(conflict)

      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: existing.metadata!.name!,
        namespace: server.namespace,
        body: {
          preconditions: {
            uid: `${server.namespace}:${existing.metadata!.name!}:uid`,
            resourceVersion: '1',
          },
        },
      })
      expect(onAuthoritativeRevocationComplete).not.toHaveBeenCalled()
    })

    it.each([
      [
        'foreign relabel',
        {
          labels: {
            'clerum.io/managed-by': 'foreign-controller',
            'clerum.io/policy-type': 'external-egress',
            'clerum.io/mcpserver': 'fresh-read-server',
          },
        },
      ],
      ['UID drift', { uid: 'replacement-uid' }],
      ['resourceVersion drift', { resourceVersion: '2' }],
    ])(
      'aborts a deterministic safety replace after fresh-read %s',
      async (_case, metadataDrift) => {
        const oldServer: McpServerCRD = {
          name: 'fresh-read-server',
          namespace: 'mcp-server',
          spec: {
            contextRef: 'default',
            image: 'fresh:test',
            transport: { type: 'streamableHttp', port: 3000 },
            egressBindings: [{ cidr: '8.8.8.8/32', port: 443, protocol: 'TCP' }],
          },
        }
        const currentServer: McpServerCRD = {
          ...oldServer,
          spec: {
            ...oldServer.spec,
            egressBindings: [{ cidr: '8.8.8.8/32', port: 443, protocol: 'UDP' }],
          },
        }
        const rec = makeReconciler(mockApi, new Map([[oldServer.name, oldServer]]), mockCustomApi)
        await rec.reconcileExternalEgress(oldServer, { isCurrent: () => true })
        const existing = mockApi.createNamespacedNetworkPolicy.mock.calls
          .map(call => (call[0] as { body: k8s.V1NetworkPolicy }).body)
          .find(policy => policy.metadata?.labels?.['clerum.io/policy-type'] === 'external-egress')!

        vi.clearAllMocks()
        mockApi.listNamespacedNetworkPolicy.mockImplementation(
          async ({ labelSelector }: { labelSelector?: string }) =>
            labelSelector?.includes('external-egress') ? { items: [existing] } : { items: [] }
        )
        mockApi.readNamespacedNetworkPolicy.mockResolvedValue({
          metadata: {
            ...metadataDrift,
          },
        })
        const onAuthoritativeRevocationComplete = vi.fn()

        await expect(
          rec.fullReconcile([], [currentServer], {
            ensureDefaults: false,
            contextInventoryAuthoritative: () => true,
            serverInventoryAuthoritative: () => true,
            onAuthoritativeRevocationComplete,
          })
        ).rejects.toThrow(/ownership/)

        expect(mockApi.readNamespacedNetworkPolicy).toHaveBeenCalledWith({
          name: existing.metadata!.name!,
          namespace: oldServer.namespace,
        })
        expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
        expect(onAuthoritativeRevocationComplete).not.toHaveBeenCalled()
      }
    )

    it('uses the fresh identity to complete a deterministic safety replacement before certification', async () => {
      const oldServer: McpServerCRD = {
        name: 'fresh-success-server',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'default',
          image: 'fresh:test',
          transport: { type: 'streamableHttp', port: 3000 },
          egressBindings: [{ cidr: '8.8.8.8/32', port: 443, protocol: 'TCP' }],
        },
      }
      const currentServer: McpServerCRD = {
        ...oldServer,
        spec: {
          ...oldServer.spec,
          egressBindings: [{ cidr: '8.8.8.8/32', port: 443, protocol: 'UDP' }],
        },
      }
      const rec = makeReconciler(mockApi, new Map([[oldServer.name, oldServer]]), mockCustomApi)
      await rec.reconcileExternalEgress(oldServer, { isCurrent: () => true })
      const existing = mockApi.createNamespacedNetworkPolicy.mock.calls
        .map(call => (call[0] as { body: k8s.V1NetworkPolicy }).body)
        .find(policy => policy.metadata?.labels?.['clerum.io/policy-type'] === 'external-egress')!

      vi.clearAllMocks()
      const ordering: string[] = []
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ labelSelector }: { labelSelector?: string }) =>
          labelSelector?.includes('external-egress') ? { items: [existing] } : { items: [] }
      )
      mockApi.readNamespacedNetworkPolicy.mockImplementation(async () => {
        ordering.push('read')
        return { metadata: { resourceVersion: '1' } }
      })
      mockApi.replaceNamespacedNetworkPolicy.mockImplementation(async () => {
        ordering.push('replace')
        return {}
      })
      const onAuthoritativeRevocationComplete = vi.fn(() => ordering.push('certify'))

      await rec.fullReconcile([], [currentServer], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        onAuthoritativeRevocationComplete,
      })

      expect(ordering.slice(0, 3)).toEqual(['read', 'replace', 'certify'])
      expect(mockApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: existing.metadata!.name!,
        namespace: oldServer.namespace,
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            name: existing.metadata!.name!,
            namespace: oldServer.namespace,
            resourceVersion: '1',
          }),
          spec: expect.objectContaining({
            egress: expect.arrayContaining([
              expect.objectContaining({
                ports: [expect.objectContaining({ protocol: 'UDP' })],
              }),
            ]),
          }),
        }),
      })
    })

    it('revokes an identity-drifted DNS policy before readiness and defers its refresh', async () => {
      const server: McpServerCRD = {
        name: 'stable-dns-server',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'default',
          image: 'stable:latest',
          transport: { type: 'streamableHttp', port: 3000 },
          egressBindings: [{ dns: 'api.example.com', port: 443, protocol: 'TCP' }],
        },
      }
      const rec = makeReconciler(mockApi, new Map([[server.name, server]]), mockCustomApi)
      await rec.reconcileExternalEgress(server, { isCurrent: () => true })
      const existing = mockApi.createNamespacedNetworkPolicy.mock.calls
        .map(call => (call[0] as { body: k8s.V1NetworkPolicy }).body)
        .find(policy => policy.metadata?.labels?.['clerum.io/policy-type'] === 'external-egress')
      expect(existing).toBeDefined()
      // B3: identity-drift (protocol TCP→UDP) so this policy is revoked; a
      // same-intent DNS allow is now retained. The revoke-before-readiness +
      // defer-refresh machinery this test guards still fires on the drifted one.
      existing!.spec!.egress = existing!.spec!.egress!.map(rule => ({
        ...rule,
        ports: rule.ports?.map(port => ({ ...port, protocol: 'UDP' })),
      }))

      vi.clearAllMocks()
      let currentPolicies = [existing!]
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ labelSelector }: { labelSelector?: string }) =>
          labelSelector?.includes('external-egress') ? { items: currentPolicies } : { items: [] }
      )
      mockApi.deleteNamespacedNetworkPolicy.mockImplementation(async () => {
        currentPolicies = []
        return {}
      })
      const onAuthoritativeRevocationComplete = vi.fn()

      await rec.fullReconcile([], [server], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        onAuthoritativeRevocationComplete,
      })
      expect(onAuthoritativeRevocationComplete).toHaveBeenCalledOnce()
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: existing!.metadata!.name!,
          namespace: server.namespace,
        })
      )
      expect(dns.resolve4).not.toHaveBeenCalled()
    })

    it('does not certify safety when an identity-drifted DNS policy cannot be revoked', async () => {
      const server: McpServerCRD = {
        name: 'undeletable-dns-server',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'default',
          image: 'stable:latest',
          transport: { type: 'streamableHttp', port: 3000 },
          egressBindings: [{ dns: 'api.example.com', port: 443, protocol: 'TCP' }],
        },
      }
      const rec = makeReconciler(mockApi, new Map([[server.name, server]]), mockCustomApi)
      await rec.reconcileExternalEgress(server, { isCurrent: () => true })
      const existing = mockApi.createNamespacedNetworkPolicy.mock.calls
        .map(call => (call[0] as { body: k8s.V1NetworkPolicy }).body)
        .find(policy => policy.metadata?.labels?.['clerum.io/policy-type'] === 'external-egress')
      expect(existing).toBeDefined()
      // B3: identity-drift (protocol TCP→UDP) so this policy is revoked; a
      // same-intent DNS allow is now retained. The no-certify-when-revoke-fails
      // machinery this test guards still fires on the drifted one.
      existing!.spec!.egress = existing!.spec!.egress!.map(rule => ({
        ...rule,
        ports: rule.ports?.map(port => ({ ...port, protocol: 'UDP' })),
      }))

      vi.clearAllMocks()
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ labelSelector }: { labelSelector?: string }) =>
          labelSelector?.includes('external-egress') ? { items: [existing!] } : { items: [] }
      )
      mockApi.deleteNamespacedNetworkPolicy.mockRejectedValue(new Error('delete denied'))
      const onAuthoritativeRevocationComplete = vi.fn()

      await expect(
        rec.fullReconcile([], [server], {
          ensureDefaults: false,
          contextInventoryAuthoritative: () => true,
          serverInventoryAuthoritative: () => true,
          onAuthoritativeRevocationComplete,
        })
      ).rejects.toThrow('delete denied')

      expect(onAuthoritativeRevocationComplete).not.toHaveBeenCalled()
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: existing!.metadata!.name!,
          namespace: server.namespace,
        })
      )
    })

    it('does not certify revocation when an earlier Context changes while a later owner is paused', async () => {
      const contexts: ContextCRD[] = ['first', 'later'].map(contextId => ({
        name: `${contextId}-resource`,
        namespace: 'mcp-server',
        spec: { contextId, mcpServers: [] },
      }))
      const currentContexts = new Map(contexts.map(context => [context.name, context]))
      let contextDesiredRevision = 10
      let laterPaused = false
      const laterStarted = deferred()
      const releaseLater = deferred()
      const onAuthoritativeRevocationComplete = vi.fn()

      const fullPass = reconciler.fullReconcile(contexts, [], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        resolveCurrentContext: name => currentContexts.get(name),
        runContextEffect: async (contextId, work) => {
          if (contextId === 'later' && !laterPaused) {
            laterPaused = true
            laterStarted.resolve(undefined)
            await releaseLater.promise
          }
          await work()
        },
        contextDesiredRevision: () => contextDesiredRevision,
        onAuthoritativeRevocationComplete,
      })

      await laterStarted.promise
      currentContexts.set('first-resource', {
        ...contexts[0],
        spec: { ...contexts[0].spec, mcpServers: ['replacement'] },
      })
      contextDesiredRevision += 1
      releaseLater.resolve(undefined)

      await expect(fullPass).rejects.toThrow(/desired NetworkPolicy inventory changed/i)
      expect(onAuthoritativeRevocationComplete).not.toHaveBeenCalled()
    })

    it('does not certify revocation when a new owner is added after the global inventory LISTs', async () => {
      const anchorContext: ContextCRD = {
        name: 'anchor-resource',
        namespace: 'mcp-server',
        spec: { contextId: 'anchor', mcpServers: [] },
      }
      const currentContexts = new Map([[anchorContext.name, anchorContext]])
      let contextDesiredRevision = 21
      const safetyEffectStarted = deferred()
      const releaseSafetyEffect = deferred()
      let safetyEffectPaused = false
      const onAuthoritativeRevocationComplete = vi.fn()

      const fullPass = reconciler.fullReconcile([anchorContext], [], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        resolveCurrentContext: name => currentContexts.get(name),
        runContextEffect: async (_contextId, work) => {
          if (!safetyEffectPaused) {
            safetyEffectPaused = true
            safetyEffectStarted.resolve(undefined)
            await releaseSafetyEffect.promise
          }
          await work()
        },
        contextDesiredRevision: () => contextDesiredRevision,
        onAuthoritativeRevocationComplete,
      })

      await safetyEffectStarted.promise
      currentContexts.set('late-resource', {
        name: 'late-resource',
        namespace: 'mcp-server',
        spec: { contextId: 'late', mcpServers: [] },
      })
      contextDesiredRevision += 1
      releaseSafetyEffect.resolve(undefined)

      await expect(fullPass).rejects.toThrow(/desired NetworkPolicy inventory changed/i)
      expect(onAuthoritativeRevocationComplete).not.toHaveBeenCalled()
    })

    it('does not certify revocation when a new McpServer owner is added after inventory LISTs', async () => {
      const anchorServer: McpServerCRD = {
        name: 'anchor-server',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'default',
          image: 'anchor:latest',
          transport: { type: 'streamableHttp', port: 3000 },
        },
      }
      const currentServers = new Map([[anchorServer.name, anchorServer]])
      let serverDesiredRevision = 31
      const safetyEffectStarted = deferred()
      const releaseSafetyEffect = deferred()
      let safetyEffectPaused = false
      const onAuthoritativeRevocationComplete = vi.fn()

      const fullPass = reconciler.fullReconcile([], [anchorServer], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        resolveCurrentServer: name => currentServers.get(name),
        runServerEffect: async (_serverName, work) => {
          if (!safetyEffectPaused) {
            safetyEffectPaused = true
            safetyEffectStarted.resolve(undefined)
            await releaseSafetyEffect.promise
          }
          await work()
        },
        serverDesiredRevision: () => serverDesiredRevision,
        onAuthoritativeRevocationComplete,
      })

      await safetyEffectStarted.promise
      currentServers.set('late-server', {
        name: 'late-server',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'default',
          image: 'late:latest',
          transport: { type: 'streamableHttp', port: 3000 },
        },
      })
      serverDesiredRevision += 1
      releaseSafetyEffect.resolve(undefined)

      await expect(fullPass).rejects.toThrow(/desired NetworkPolicy inventory changed/i)
      expect(onAuthoritativeRevocationComplete).not.toHaveBeenCalled()
    })

    it('does not certify revocation when desired inventory changes while default policies are ensured', async () => {
      const context: ContextCRD = {
        name: 'default-window-context',
        namespace: 'mcp-server',
        spec: { contextId: 'default-window', mcpServers: [] },
      }
      const server: McpServerCRD = {
        name: 'default-window-server',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'default-window',
          image: 'default-window:latest',
          transport: { type: 'streamableHttp', port: 3000 },
        },
      }
      let contextDesiredRevision = 41
      let serverDesiredRevision = 51
      const defaultsStarted = deferred()
      const releaseDefaults = deferred()
      const onAuthoritativeRevocationComplete = vi.fn()
      vi.spyOn(reconciler, 'ensureDefaultPolicies').mockImplementation(async () => {
        defaultsStarted.resolve(undefined)
        await releaseDefaults.promise
      })

      const fullPass = reconciler.fullReconcile([context], [server], {
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        contextDesiredRevision: () => contextDesiredRevision,
        serverDesiredRevision: () => serverDesiredRevision,
        onAuthoritativeRevocationComplete,
      })

      await defaultsStarted.promise
      contextDesiredRevision += 1
      serverDesiredRevision += 1
      releaseDefaults.resolve(undefined)

      await expect(fullPass).rejects.toThrow(/desired NetworkPolicy inventory changed/i)
      expect(onAuthoritativeRevocationComplete).not.toHaveBeenCalled()
    })

    it('does not signal authoritative revocation when a live-owner delete fails', async () => {
      const liveContext: ContextCRD = {
        name: 'live-context-resource',
        namespace: 'mcp-server',
        spec: { contextId: 'live-context', mcpServers: [] },
      }
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => {
          if (namespace === 'mcp-server' && labelSelector?.includes('context-allow')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'ctx-live-context-removed-server',
                    labels: { 'clerum.io/context': 'live-context' },
                  },
                },
              ],
            }
          }
          return { items: [] }
        }
      )
      mockApi.deleteNamespacedNetworkPolicy.mockRejectedValueOnce(
        new Error('policy delete unavailable')
      )
      const onAuthoritativeRevocationComplete = vi.fn()

      await expect(
        reconciler.fullReconcile([liveContext], [], {
          ensureDefaults: false,
          contextInventoryAuthoritative: () => true,
          serverInventoryAuthoritative: () => true,
          onAuthoritativeRevocationComplete,
        })
      ).rejects.toThrow('policy delete unavailable')
      expect(onAuthoritativeRevocationComplete).not.toHaveBeenCalled()
    })

    it('does not delete or signal revocation after live Context authority is lost', async () => {
      const liveContext: ContextCRD = {
        name: 'live-context-resource',
        namespace: 'mcp-server',
        spec: { contextId: 'live-context', mcpServers: [] },
      }
      let authoritative = true
      const inventoryListed = deferred()
      const releaseInventory = deferred<{ items: k8s.V1NetworkPolicy[] }>()
      mockApi.listNamespacedNetworkPolicy.mockImplementationOnce(async () => {
        inventoryListed.resolve(undefined)
        return releaseInventory.promise
      })
      const onAuthoritativeRevocationComplete = vi.fn()

      const fullPass = reconciler.fullReconcile([liveContext], [], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => authoritative,
        serverInventoryAuthoritative: () => true,
        onAuthoritativeRevocationComplete,
      })
      await inventoryListed.promise
      authoritative = false
      releaseInventory.resolve({
        items: [
          {
            metadata: {
              name: 'ctx-live-context-removed-server',
              labels: { 'clerum.io/context': 'live-context' },
            },
          },
        ],
      })

      await fullPass
      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(onAuthoritativeRevocationComplete).not.toHaveBeenCalled()
    })

    it('uses selected lane LISTs plus one broad LIST per bounded namespace before additive convergence', async () => {
      const contexts: ContextCRD[] = ['alpha', 'beta', 'gamma'].map(contextId => ({
        name: `${contextId}-resource`,
        namespace: 'mcp-server',
        spec: { contextId, mcpServers: [] },
      }))
      const servers: McpServerCRD[] = ['one', 'two'].map(name => ({
        name,
        namespace: 'mcp-server',
        spec: {
          contextRef: 'default',
          image: `${name}:latest`,
          transport: { type: 'streamableHttp', port: 3000 },
        },
      }))
      const additiveStarted = deferred()
      const releaseAdditive = deferred()
      vi.spyOn(reconciler, 'reconcileContext').mockImplementationOnce(async () => {
        additiveStarted.resolve(undefined)
        await releaseAdditive.promise
        return true
      })
      mockApi.listNamespacedNetworkPolicy.mockResolvedValue({ items: [] })

      const fullPass = reconciler.fullReconcile(contexts, servers, {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
      })

      await additiveStarted.promise
      try {
        expect(mockApi.listNamespacedNetworkPolicy).toHaveBeenCalledTimes(7)
        expect(mockApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
          namespace: 'mcp-server',
          labelSelector: expect.stringContaining('policy-type=context-allow'),
        })
        expect(mockApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
          namespace: 'mcp-host',
          labelSelector: expect.stringContaining('policy-type=context-allow'),
        })
        expect(mockApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
          namespace: 'rpc-proxy',
          labelSelector: expect.stringContaining('policy-type=rpc-proxy-egress'),
        })
        expect(mockApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
          namespace: 'mcp-server',
          labelSelector: expect.stringContaining('policy-type=external-egress'),
        })
        expect(mockApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
          namespace: 'mcp-server',
        })
        expect(mockApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
          namespace: 'mcp-host',
        })
        expect(mockApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
          namespace: 'rpc-proxy',
        })
      } finally {
        releaseAdditive.resolve(undefined)
        await fullPass
      }
    })

    it('leaves startup external egress creation to its dedicated coordinator', async () => {
      const server: McpServerCRD = {
        name: 'airtable-mcp',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'dev',
          image: 'airtable:latest',
          transport: { type: 'streamableHttp', url: 'http://airtable:3000', port: 3000 },
          egressBindings: [{ dns: 'api.airtable.com', port: 443 }],
        },
      }

      await reconciler.fullReconcile([], [server])

      const externalPolicies = mockApi.createNamespacedNetworkPolicy.mock.calls.filter(
        (call: unknown[]) => {
          const arg = call[0] as { body: { metadata: { labels: Record<string, string> } } }
          return arg.body.metadata.labels['clerum.io/policy-type'] === 'external-egress'
        }
      )
      expect(externalPolicies).toHaveLength(0)
      expect(dns.resolve4).not.toHaveBeenCalled()
    })

    it('deletes orphaned external egress policies for servers no longer present', async () => {
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ labelSelector }: { labelSelector?: string }) => {
          if (labelSelector?.includes('context-allow')) return { items: [] }
          if (labelSelector?.includes('rpc-proxy-egress')) return { items: [] }
          if (labelSelector?.includes('external-egress')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'ext-egress-old-server-api-example-com-443',
                    labels: { 'clerum.io/mcpserver': 'old-server' },
                  },
                },
              ],
            }
          }
          return { items: [] }
        }
      )

      await reconciler.fullReconcile([], [], { serverInventoryComplete: true })

      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ext-egress-old-server-api-example-com-443',
          namespace: 'mcp-server',
        })
      )
    })

    it('fails closed by deleting HCC-managed policies with missing owner labels', async () => {
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => {
          const managedLabels = { 'clerum.io/managed-by': 'host-context-controller' }
          if (labelSelector?.includes('policy-type=context-allow')) {
            return {
              items: [
                {
                  metadata: {
                    name:
                      namespace === 'mcp-host'
                        ? 'malformed-host-egress'
                        : 'malformed-context-ingress',
                    labels: managedLabels,
                  },
                },
              ],
            }
          }
          if (labelSelector?.includes('rpc-proxy-egress')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'malformed-rpc-proxy-egress',
                    labels: managedLabels,
                  },
                },
              ],
            }
          }
          if (labelSelector?.includes('external-egress')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'malformed-external-egress',
                    labels: managedLabels,
                  },
                },
              ],
            }
          }
          return { items: [] }
        }
      )

      await reconciler.fullReconcile([], [], {
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        serverInventoryComplete: true,
      })

      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'malformed-context-ingress',
          namespace: 'mcp-server',
        })
      )
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'malformed-host-egress',
          namespace: 'mcp-host',
        })
      )
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'malformed-rpc-proxy-egress',
          namespace: 'rpc-proxy',
        })
      )
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'malformed-external-egress',
          namespace: 'mcp-server',
        })
      )
    })

    it('skips external egress orphan cleanup when startup server discovery is incomplete', async () => {
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ labelSelector }: { labelSelector?: string }) => {
          if (labelSelector?.includes('context-allow')) return { items: [] }
          if (labelSelector?.includes('rpc-proxy-egress')) return { items: [] }
          if (labelSelector?.includes('external-egress')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'ext-egress-old-server-api-example-com-443',
                    labels: { 'clerum.io/mcpserver': 'old-server' },
                  },
                },
              ],
            }
          }
          return { items: [] }
        }
      )

      await reconciler.fullReconcile([], [], { serverInventoryComplete: false })

      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith({
        name: 'ext-egress-old-server-api-example-com-443',
        namespace: 'mcp-server',
      })
    })

    it('finishes desired Context reconciliation but stops Context and rpc-proxy orphan cleanup when authority is lost after inventory listing', async () => {
      const desiredContext: ContextCRD = {
        name: 'current',
        namespace: 'mcp-server',
        spec: { contextId: 'current', mcpServers: [] },
      }
      const reconcileContext = vi.spyOn(reconciler, 'reconcileContext').mockResolvedValue(true)
      const contextInventoryAuthoritative = vi
        .fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false)
        .mockReturnValue(true)

      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => {
          if (namespace === 'mcp-server' && labelSelector?.includes('policy-type=context-allow')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'ctx-deleted-context-old-server',
                    labels: { 'clerum.io/context': 'deleted-context' },
                  },
                },
              ],
            }
          }
          if (labelSelector?.includes('external-egress')) return { items: [] }
          return { items: [] }
        }
      )

      await reconciler.fullReconcile([desiredContext], [], {
        ensureDefaults: false,
        contextInventoryAuthoritative,
      })

      expect(reconcileContext).toHaveBeenCalledWith(desiredContext, {
        isCurrent: expect.any(Function),
      })
      expect(contextInventoryAuthoritative).toHaveBeenCalled()
      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith({
        name: 'ctx-deleted-context-old-server',
        namespace: 'mcp-server',
      })
      expect(mockApi.listNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'rpc-proxy',
          labelSelector: expect.stringContaining('policy-type=rpc-proxy-egress'),
        })
      )
    })

    it('stops external-egress orphan cleanup when authority is lost after inventory listing', async () => {
      const desiredServer: McpServerCRD = {
        name: 'current-server',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'current',
          image: 'current:latest',
          transport: { type: 'streamableHttp', url: 'http://current:3000', port: 3000 },
        },
      }
      const serverInventoryAuthoritative = vi
        .fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false)
        .mockReturnValue(true)

      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ labelSelector }: { labelSelector?: string }) => {
          if (labelSelector?.includes('external-egress')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'ext-egress-deleted-server-api-example-com-443',
                    labels: { 'clerum.io/mcpserver': 'deleted-server' },
                  },
                },
              ],
            }
          }
          return { items: [] }
        }
      )

      await reconciler.fullReconcile([], [desiredServer], {
        ensureDefaults: false,
        serverInventoryComplete: true,
        serverInventoryAuthoritative,
      })

      expect(serverInventoryAuthoritative).toHaveBeenCalled()
      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith({
        name: 'ext-egress-deleted-server-api-example-com-443',
        namespace: 'mcp-server',
      })
    })

    it('does not delete any Context policy lane when a same-contextId CRD exists before its watch event arrives', async () => {
      mockCustomApi.listNamespacedCustomObject.mockResolvedValue({
        items: [{ metadata: { name: 'recreated-context' }, spec: { contextId: 'recreated' } }],
      })
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => {
          if (namespace === 'mcp-server' && labelSelector?.includes('context-allow')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'ctx-recreated-server',
                    labels: { 'clerum.io/context': 'recreated' },
                  },
                },
              ],
            }
          }
          if (namespace === 'mcp-host' && labelSelector?.includes('context-allow')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'ctx-recreated-server-egress',
                    labels: { 'clerum.io/context': 'recreated' },
                  },
                },
              ],
            }
          }
          if (namespace === 'rpc-proxy' && labelSelector?.includes('rpc-proxy-egress')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'rpc-egress-recreated-server',
                    labels: { 'clerum.io/context': 'recreated' },
                  },
                },
              ],
            }
          }
          return { items: [] }
        }
      )

      await reconciler.fullReconcile([], [], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
      })

      expect(mockCustomApi.listNamespacedCustomObject).toHaveBeenCalled()
      expect(mockApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'mcp-host',
          labelSelector: expect.stringContaining('policy-type=context-allow'),
        })
      )
      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('does not delete external-egress policy when a same-name McpServer exists before ADDED arrives', async () => {
      mockCustomApi.getNamespacedCustomObject.mockResolvedValue({
        metadata: { name: 'recreated-server', uid: 'new-uid' },
      })
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ labelSelector }: { labelSelector?: string }) => {
          if (labelSelector?.includes('external-egress')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'ext-egress-recreated-server-api-example-com-443',
                    labels: { 'clerum.io/mcpserver': 'recreated-server' },
                  },
                },
              ],
            }
          }
          return { items: [] }
        }
      )

      await reconciler.fullReconcile([], [], {
        ensureDefaults: false,
        serverInventoryComplete: true,
        serverInventoryAuthoritative: () => true,
      })

      expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({ plural: 'mcpservers', name: 'recreated-server' })
      )
      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('delegates startup McpServer orphan safety to the canonical absence helper', async () => {
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ labelSelector }: { labelSelector?: string }) => {
          if (labelSelector?.includes('external-egress')) {
            return {
              items: [
                {
                  metadata: {
                    name: 'ext-egress-orphan-server-api-example-com-443',
                    labels: { 'clerum.io/mcpserver': 'orphan-server' },
                  },
                },
              ],
            }
          }
          return { items: [] }
        }
      )

      await reconciler.fullReconcile([], [], {
        ensureDefaults: false,
        serverInventoryComplete: true,
        serverInventoryAuthoritative: () => true,
      })

      expect(confirmAuthoritativeMcpServerAbsence).toHaveBeenCalledTimes(1)
      expect(confirmAuthoritativeMcpServerAbsence).toHaveBeenCalledWith({
        inventoryAuthoritative: expect.any(Function),
        resolveCurrent: expect.any(Function),
        readCurrent: expect.any(Function),
      })
    })
  })

  describe('L3 — cleanupExternalEgress', () => {
    it('deletes all external egress policies for a server', async () => {
      mockApi.listNamespacedNetworkPolicy.mockResolvedValue({
        items: [{ metadata: { name: 'ext-egress-openai-mcp-api-443' } }],
      })

      await reconciler.cleanupExternalEgress('openai-mcp', 'mcp-server')

      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'ext-egress-openai-mcp-api-443',
        namespace: 'mcp-server',
        body: {
          preconditions: {
            uid: 'mcp-server:ext-egress-openai-mcp-api-443:uid',
            resourceVersion: '1',
          },
        },
      })
    })

    it('fails closed when stale external egress policy deletion fails', async () => {
      const error = Object.assign(new Error('forbidden'), { code: 403 })
      mockApi.listNamespacedNetworkPolicy.mockResolvedValue({
        items: [{ metadata: { name: 'ext-egress-openai-mcp-old-api-443' } }],
      })
      mockApi.deleteNamespacedNetworkPolicy.mockRejectedValueOnce(error)

      await expect(reconciler.cleanupExternalEgress('openai-mcp', 'mcp-server')).rejects.toThrow(
        'forbidden'
      )
    })

    it('ignores NotFound when stale external egress policy is already gone', async () => {
      const error = Object.assign(new Error('not found'), { code: 404 })
      mockApi.listNamespacedNetworkPolicy.mockResolvedValue({
        items: [{ metadata: { name: 'ext-egress-openai-mcp-old-api-443' } }],
      })
      mockApi.deleteNamespacedNetworkPolicy.mockRejectedValueOnce(error)

      await expect(
        reconciler.cleanupExternalEgress('openai-mcp', 'mcp-server')
      ).resolves.toBeUndefined()
    })

    it('does not report a revocation when the policy was already absent', async () => {
      const error = Object.assign(new Error('not found'), { code: 404 })
      const onDeleted = vi.fn()
      mockApi.listNamespacedNetworkPolicy.mockResolvedValue({
        items: [{ metadata: { name: 'ext-egress-openai-mcp-old-api-443' } }],
      })
      mockApi.deleteNamespacedNetworkPolicy.mockRejectedValueOnce(error)

      await reconciler.cleanupExternalEgress(
        'openai-mcp',
        'mcp-server',
        undefined,
        undefined,
        onDeleted
      )

      expect(onDeleted).not.toHaveBeenCalled()
    })
  })

  describe('scoped delta certification vs. a stuck safety inventory', () => {
    const ambiguousReservedPolicy: k8s.V1NetworkPolicy = {
      metadata: { name: 'ctx-reserved-context-server', labels: {} },
      spec: { podSelector: {}, policyTypes: ['Ingress'] },
    }
    const deltaContext: ContextCRD = {
      name: 'default',
      namespace: 'mcp-server',
      spec: { contextId: 'default', mcpServers: [] },
    }

    function stickSafetyInventory(): void {
      // Only the namespace-wide safety inventory sees the foreign policy. The
      // label-scoped LISTs the delta lane uses stay clean, which is exactly why
      // the delta cannot vouch for the namespace.
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => ({
          items: !labelSelector && namespace === 'mcp-server' ? [ambiguousReservedPolicy] : [],
        })
      )
    }

    it('refuses to certify a scoped delta while the safety pass is stuck on its inventory', async () => {
      stickSafetyInventory()
      const onAuthoritativeRevocationComplete = vi.fn()

      await expect(
        reconciler.fullReconcile([], [], {
          ensureDefaults: false,
          contextInventoryAuthoritative: () => true,
          serverInventoryAuthoritative: () => true,
          onAuthoritativeRevocationComplete,
        })
      ).rejects.toThrow(/Ambiguous NetworkPolicy ownership/)
      expect(onAuthoritativeRevocationComplete).not.toHaveBeenCalled()

      // The delta's own revocation still completes — its label-scoped LISTs are
      // clean. What it may not do is vouch for the namespace-wide inventory,
      // which the readiness lane checks separately.
      expect(await reconciler.reconcileContext(deltaContext, { isCurrent: () => true })).toBe(true)
      expect(reconciler.hasCertifiedSafetyInventory()).toBe(false)
    })

    it('certifies a scoped delta again once a later safety pass completes', async () => {
      stickSafetyInventory()
      await expect(
        reconciler.fullReconcile([], [], {
          ensureDefaults: false,
          contextInventoryAuthoritative: () => true,
          serverInventoryAuthoritative: () => true,
          onAuthoritativeRevocationComplete: vi.fn(),
        })
      ).rejects.toThrow(/Ambiguous NetworkPolicy ownership/)

      mockApi.listNamespacedNetworkPolicy.mockResolvedValue({ items: [] })
      const onAuthoritativeRevocationComplete = vi.fn()
      await reconciler.fullReconcile([], [], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        onAuthoritativeRevocationComplete,
      })

      expect(onAuthoritativeRevocationComplete).toHaveBeenCalledOnce()
      expect(await reconciler.reconcileContext(deltaContext, { isCurrent: () => true })).toBe(true)
      expect(reconciler.hasCertifiedSafetyInventory()).toBe(true)
    })

    it('does not certify the safety inventory until an authoritative pass has run', async () => {
      // Fail-closed default: before any authoritative safety pass certifies, the
      // namespace-wide inventory is NOT certified, even though the scoped delta's
      // own label-scoped revocation completes (returns true). A delta cannot
      // vouch for the namespace-wide inventory it never enumerated.
      expect(await reconciler.reconcileContext(deltaContext, { isCurrent: () => true })).toBe(true)
      expect(reconciler.hasCertifiedSafetyInventory()).toBe(false)
    })
  })

  describe('lost delete fence during stale-allow revocation', () => {
    const staleContext: ContextCRD = {
      name: 'default',
      namespace: 'mcp-server',
      spec: { contextId: 'default', mcpServers: [] },
    }
    const stalePolicy: k8s.V1NetworkPolicy = {
      metadata: {
        name: 'ctx-default-alpha',
        namespace: 'mcp-server',
        labels: {
          'clerum.io/managed-by': 'host-context-controller',
          'clerum.io/policy-type': 'context-allow',
          'clerum.io/context': 'default',
          'clerum.io/mcpserver': 'alpha',
        },
      },
      spec: { podSelector: {}, policyTypes: ['Ingress'] },
    }
    const lostFence = Object.assign(new Error('the UID in the precondition does not match'), {
      code: 409,
    })

    function listOnlyTheStalePolicy(): void {
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace }: { namespace?: string }) => ({
          items: namespace === 'mcp-server' ? [stalePolicy] : [],
        })
      )
    }

    it('refuses to certify a scoped delta instead of throwing the lost fence', async () => {
      listOnlyTheStalePolicy()
      mockApi.deleteNamespacedNetworkPolicy.mockRejectedValueOnce(lostFence)

      // 409 is what Kubernetes returns when the uid/resourceVersion
      // preconditions no longer match: the object live under that name is not
      // the one this pass classified. Nothing was revoked, so the delta must
      // decline to certify — and it must not blow up the caller, which would
      // only force a spurious full re-convergence.
      // The scoped delta lane reads this boolean and withholds the certificate,
      // so it is the one caller allowed to take the lost fence as an outcome
      // rather than a throw.
      expect(
        await reconciler.reconcileContext(staleContext, {
          honorsLostFence: true,
          isCurrent: () => true,
        })
      ).toBe(false)
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'ctx-default-alpha', namespace: 'mcp-server' })
      )
    })

    it('withdraws certification when an additive revocation loses the fence after certifying', async () => {
      // The additive phase re-runs reconcileContext, which carries a second
      // revocation lane over a fresh LIST. Losing the fence there happens after
      // the pass already certified, and the outcome recorder is first-wins — so
      // the duration sample stays 'completed', which is right, but the safety
      // fence must still degrade. It is an assertion about live allows, and it
      // may only ever move toward unsafe.
      const additiveContext: ContextCRD = {
        name: 'additive',
        namespace: 'mcp-server',
        spec: { contextId: 'additive', mcpServers: [] },
      }
      const additiveStalePolicy: k8s.V1NetworkPolicy = {
        metadata: {
          name: 'ctx-additive-alpha',
          namespace: 'mcp-server',
          labels: {
            'clerum.io/managed-by': 'host-context-controller',
            'clerum.io/policy-type': 'context-allow',
            'clerum.io/context': 'additive',
            'clerum.io/mcpserver': 'alpha',
          },
        },
        spec: { podSelector: {}, policyTypes: ['Ingress'] },
      }
      // Self-synchronising: the stale policy only becomes visible once the pass
      // has already certified, so the safety phase is clean by construction and
      // only the additive re-LIST finds work.
      let certified = false
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace }: { namespace?: string }) => ({
          items: certified && namespace === 'mcp-server' ? [additiveStalePolicy] : [],
        })
      )
      mockApi.deleteNamespacedNetworkPolicy.mockRejectedValue(lostFence)
      const onAuthoritativeRevocationComplete = vi.fn(() => {
        certified = true
      })

      await expect(
        reconciler.fullReconcile([additiveContext], [], {
          ensureDefaults: false,
          contextInventoryAuthoritative: () => true,
          serverInventoryAuthoritative: () => true,
          onAuthoritativeRevocationComplete,
        })
      ).rejects.toThrow()

      expect(onAuthoritativeRevocationComplete).toHaveBeenCalledOnce()
      expect(reconciler.hasCertifiedSafetyInventory()).toBe(false)
    })

    it('marks the inventory uncertified the moment the authoritative pass loses the fence', async () => {
      // The doom must be visible mid-pass, not only after the unwind. A lost
      // fence is the one doom cause that does not bump a watch generation, so
      // it is the only one where the whole certification machinery stays green
      // while the pass is already condemned. A scoped delta interleaving in
      // that window would certify readiness over a stale allow.
      //
      // Two contexts, each with its own stale policy: the first loses the fence
      // and the second's delete gives an observation point while the pass is
      // condemned but still unwinding.
      const secondContext: ContextCRD = {
        name: 'second',
        namespace: 'mcp-server',
        spec: { contextId: 'second', mcpServers: [] },
      }
      const secondStalePolicy: k8s.V1NetworkPolicy = {
        metadata: {
          name: 'ctx-second-beta',
          namespace: 'mcp-server',
          labels: {
            'clerum.io/managed-by': 'host-context-controller',
            'clerum.io/policy-type': 'context-allow',
            'clerum.io/context': 'second',
            'clerum.io/mcpserver': 'beta',
          },
        },
        spec: { podSelector: {}, policyTypes: ['Ingress'] },
      }
      mockApi.listNamespacedNetworkPolicy.mockImplementation(
        async ({ namespace }: { namespace?: string }) => ({
          items: namespace === 'mcp-server' ? [stalePolicy, secondStalePolicy] : [],
        })
      )
      let certifiedDuringUnwind: boolean | undefined
      mockApi.deleteNamespacedNetworkPolicy.mockImplementation(async () => {
        if (
          certifiedDuringUnwind === undefined &&
          mockApi.deleteNamespacedNetworkPolicy.mock.calls.length > 1
        ) {
          certifiedDuringUnwind = reconciler.hasCertifiedSafetyInventory()
          return {}
        }
        throw lostFence
      })

      await expect(
        reconciler.fullReconcile([staleContext, secondContext], [], {
          ensureDefaults: false,
          contextInventoryAuthoritative: () => true,
          serverInventoryAuthoritative: () => true,
          onAuthoritativeRevocationComplete: vi.fn(),
        })
      ).rejects.toThrow()

      expect(certifiedDuringUnwind).toBe(false)
    })

    it('fails the additive phase when it loses the delete fence', async () => {
      listOnlyTheStalePolicy()
      // Safety phase revokes cleanly and certifies; the additive phase then
      // races another writer and loses the fence. The additive caller discards
      // reconcileContext's boolean, so swallowing the 409 there would record
      // the pass as a success, disarm the convergence retry, and leave a stale
      // allow live with no NetworkPolicy resync to recover it.
      mockApi.deleteNamespacedNetworkPolicy
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(lostFence)
      const onAuthoritativeRevocationComplete = vi.fn()

      await expect(
        reconciler.fullReconcile([staleContext], [], {
          ensureDefaults: false,
          contextInventoryAuthoritative: () => true,
          serverInventoryAuthoritative: () => true,
          onAuthoritativeRevocationComplete,
        })
      ).rejects.toThrow()

      expect(onAuthoritativeRevocationComplete).toHaveBeenCalledOnce()
    })

    it('refuses to certify the safety pass instead of throwing the lost fence', async () => {
      listOnlyTheStalePolicy()
      mockApi.deleteNamespacedNetworkPolicy.mockRejectedValueOnce(lostFence)
      const onAuthoritativeRevocationComplete = vi.fn()

      await expect(
        reconciler.fullReconcile([staleContext], [], {
          ensureDefaults: false,
          contextInventoryAuthoritative: () => true,
          serverInventoryAuthoritative: () => true,
          onAuthoritativeRevocationComplete,
        })
      ).rejects.toThrow(DESIRED_NETWORKPOLICY_INVENTORY_CHANGED_MESSAGE)

      expect(onAuthoritativeRevocationComplete).not.toHaveBeenCalled()
    })

    it('still fails loud when the delete fails for any other reason', async () => {
      listOnlyTheStalePolicy()
      const forbidden = Object.assign(new Error('forbidden'), { code: 403 })
      mockApi.deleteNamespacedNetworkPolicy.mockRejectedValueOnce(forbidden)

      await expect(
        reconciler.reconcileContext(staleContext, { isCurrent: () => true })
      ).rejects.toBe(forbidden)
    })

    it('still certifies when the stale policy was already gone', async () => {
      listOnlyTheStalePolicy()
      mockApi.deleteNamespacedNetworkPolicy.mockRejectedValueOnce(
        Object.assign(new Error('not found'), { code: 404 })
      )

      expect(await reconciler.reconcileContext(staleContext, { isCurrent: () => true })).toBe(true)
    })
  })

  describe('same-name conflict creating a safety external-egress policy', () => {
    const server: McpServerCRD = {
      name: 'renamed-server',
      namespace: 'mcp-server',
      spec: {
        contextRef: 'default',
        image: 'renamed:latest',
        transport: { type: 'streamableHttp', port: 3000 },
        egressBindings: [{ cidr: '104.18.0.0/16', port: 443 }],
      },
    }
    const desiredName = 'ext-egress-renamed-server-104-18-0-0-16-443'
    const stalePredecessor: k8s.V1NetworkPolicy = {
      metadata: {
        name: 'ext-egress-renamed-server-stale',
        namespace: 'mcp-server',
        uid: 'stale-uid',
        resourceVersion: '3',
      },
    }

    function reconcileExternalEgressSafety(): Promise<boolean> {
      return (
        reconciler as unknown as {
          reconcileExternalEgressSafety: (
            server: McpServerCRD,
            existingPolicies: k8s.V1NetworkPolicy[],
            isCurrent: () => boolean
          ) => Promise<boolean>
        }
      ).reconcileExternalEgressSafety(server, [stalePredecessor], () => true)
    }

    it('BYPASS-NP-1: equivalent HCC-owned recorded policy skips replace', async () => {
      const binding = server.spec.egressBindings![0]
      const desired = (
        reconciler as unknown as {
          buildExactHostEgressPolicy: (
            server: McpServerCRD,
            name: string,
            binding: { cidr?: string; port?: number; protocol?: string },
            cidrs: string[]
          ) => k8s.V1NetworkPolicy
        }
      ).buildExactHostEgressPolicy(server, desiredName, binding, ['104.18.0.0/16'])
      mockApi.createNamespacedNetworkPolicy.mockRejectedValue(
        Object.assign(new Error('already exists'), { code: 409 })
      )
      mockApi.readNamespacedNetworkPolicy.mockResolvedValue(asApiserverNetworkPolicy(desired))

      expect(await reconcileExternalEgressSafety()).toBe(true)
      expect(mockApi.createNamespacedNetworkPolicy).toHaveBeenCalled()
      expect(mockApi.readNamespacedNetworkPolicy).toHaveBeenCalled()
      expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('converges an HCC-owned same-name policy instead of aborting the pass', async () => {
      mockApi.createNamespacedNetworkPolicy.mockRejectedValueOnce(
        Object.assign(new Error('already exists'), { code: 409 })
      )
      mockApi.readNamespacedNetworkPolicy.mockResolvedValueOnce({
        metadata: {
          name: desiredName,
          namespace: server.namespace,
          uid: 'own-uid',
          resourceVersion: '7',
          labels: {
            'clerum.io/managed-by': 'host-context-controller',
            'clerum.io/policy-type': 'external-egress',
            'clerum.io/mcpserver': server.name,
          },
        },
      })

      // This is the only creation route that bypasses applyNetworkPolicy. A
      // same-name object HCC already owns is an idempotent re-run, not a
      // reason to fail the pass and hold readiness down.
      expect(await reconcileExternalEgressSafety()).toBe(true)
      expect(mockApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ name: desiredName, namespace: server.namespace })
      )
    })

    it('still fails closed when the same-name policy is foreign', async () => {
      mockApi.createNamespacedNetworkPolicy.mockRejectedValueOnce(
        Object.assign(new Error('already exists'), { code: 409 })
      )
      mockApi.readNamespacedNetworkPolicy.mockResolvedValueOnce({
        metadata: {
          name: desiredName,
          namespace: server.namespace,
          uid: 'foreign-uid',
          resourceVersion: '7',
          labels: {
            'clerum.io/managed-by': 'foreign-controller',
            'clerum.io/policy-type': 'external-egress',
            'clerum.io/mcpserver': server.name,
          },
        },
      })

      await expect(reconcileExternalEgressSafety()).rejects.toThrow(/ownership/i)
      expect(mockApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('still fails loud when the create fails for any other reason', async () => {
      const forbidden = Object.assign(new Error('forbidden'), { code: 403 })
      mockApi.createNamespacedNetworkPolicy.mockRejectedValueOnce(forbidden)

      await expect(reconcileExternalEgressSafety()).rejects.toBe(forbidden)
    })
  })

  describe('safety-pass duration on the uncertified return path', () => {
    it('samples a failed outcome when the pass returns without certifying', async () => {
      const onAuthoritativeRevocationComplete = vi.fn()

      // Losing inventory authority ends the pass without an exception and
      // without certifying. Operators alert on "the pass never completed", so
      // this path has to produce a `failed` sample — absence is not a signal.
      await expect(
        reconciler.fullReconcile([], [], {
          ensureDefaults: false,
          contextInventoryAuthoritative: () => false,
          serverInventoryAuthoritative: () => true,
          onAuthoritativeRevocationComplete,
        })
      ).resolves.toBeUndefined()

      expect(onAuthoritativeRevocationComplete).not.toHaveBeenCalled()
      expect(networkPolicySafetyPassDurationSeconds.observe).toHaveBeenCalledWith(
        { outcome: 'failed' },
        expect.any(Number)
      )
      expect(networkPolicySafetyPassDurationSeconds.observe).toHaveBeenCalledTimes(1)
    })

    it('keeps the completed sample when a certified pass fails an additive effect afterwards', async () => {
      const context: ContextCRD = {
        name: 'default',
        namespace: 'mcp-server',
        spec: { contextId: 'default', mcpServers: [] },
      }
      const additiveFailure = new Error('additive list unavailable')
      let certified = false
      const onAuthoritativeRevocationComplete = vi.fn(() => {
        certified = true
      })
      mockApi.listNamespacedNetworkPolicy.mockImplementation(async () => {
        if (certified) throw additiveFailure
        return { items: [] }
      })

      await expect(
        reconciler.fullReconcile([context], [], {
          ensureDefaults: false,
          contextInventoryAuthoritative: () => true,
          serverInventoryAuthoritative: () => true,
          onAuthoritativeRevocationComplete,
        })
      ).rejects.toThrow(/additive Context NetworkPolicy reconciliations failed/)

      expect(onAuthoritativeRevocationComplete).toHaveBeenCalledOnce()
      expect(networkPolicySafetyPassDurationSeconds.observe).toHaveBeenCalledWith(
        { outcome: 'completed' },
        expect.any(Number)
      )
      expect(networkPolicySafetyPassDurationSeconds.observe).toHaveBeenCalledTimes(1)
    })
  })
})
