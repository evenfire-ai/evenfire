import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import * as dns from 'node:dns/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { confirmAuthoritativeMcpServerAbsence } from './mcpServerSafety'
import { NetworkPolicyReconciler, PUBLIC_EGRESS_EXCEPT_CIDRS } from './networkPolicyReconciler'
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
  },
}))

// Mock dns
vi.mock('node:dns/promises', () => ({
  resolve4: vi.fn().mockResolvedValue(['1.2.3.4', '5.6.7.8']),
}))

function makeMockNetworkingApi() {
  return {
    createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    readNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
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
  ;(reconciler as unknown as { networkingApi: unknown }).networkingApi = mockApi
  ;(reconciler as unknown as { customApi: unknown }).customApi = mockCustomApi
  return reconciler
}

describe('NetworkPolicyReconciler', () => {
  let mockApi: ReturnType<typeof makeMockNetworkingApi>
  let mockCustomApi: ReturnType<typeof makeMockCustomApi>
  let reconciler: NetworkPolicyReconciler

  beforeEach(() => {
    mockApi = makeMockNetworkingApi()
    mockCustomApi = makeMockCustomApi()
    reconciler = makeReconciler(mockApi, undefined, mockCustomApi)
    vi.clearAllMocks()
    vi.mocked(dns.resolve4).mockResolvedValue(['1.2.3.4', '5.6.7.8'])
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
      await reconciler.ensureDefaultPolicies()

      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        namespace: 'rpc-proxy',
        name: 'allow-desktop-egress-rpc-proxy',
      })
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        namespace: 'mcp-server',
        name: 'allow-rpc-proxy-to-managed-mcp-servers',
      })
    })

    it('fails closed when legacy static policy cleanup fails', async () => {
      const cleanupError = Object.assign(new Error('rbac denied'), { code: 403 })
      mockApi.deleteNamespacedNetworkPolicy.mockImplementation(async ({ name }) => {
        if (name === 'allow-rpc-proxy-to-managed-mcp-servers') {
          throw cleanupError
        }
        return {}
      })

      await expect(reconciler.ensureDefaultPolicies()).rejects.toBe(cleanupError)
    })
  })

  // ─── L1: Allow API ─────────────────────────────────────────────────

  describe('L1 — ensureAllowContextMapperApi', () => {
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

      await rec.reconcileContext(context)

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

    it('does not mutate policies after its combined inventory authority lease is retired', async () => {
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
      const inventoryListed = deferred()
      const releaseInventory = deferred<{ items: k8s.V1NetworkPolicy[] }>()
      mockApi.listNamespacedNetworkPolicy.mockImplementationOnce(async () => {
        inventoryListed.resolve(undefined)
        return releaseInventory.promise
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
      await inventoryListed.promise

      contextGeneration = 6
      serverGeneration = 10
      releaseInventory.resolve({ items: [] })
      await reconcile

      expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
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
        spec: { contextId: 'dev', mcpServers: ['mongo'] },
      }

      const reconcile = rec.reconcileContext(context)
      await inventoryListed.promise
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
      releaseInventory.resolve({ items: [] })
      await reconcile

      expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
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
        spec: { contextId: 'dev', mcpServers: ['mongo'] },
      }

      const reconcile = rec.reconcileContext(context)
      await inventoryListed.promise
      cache.set(selected.name, {
        ...selected,
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      })
      releaseInventory.resolve({ items: [] })
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

      const reconcile = rec.reconcileContext(context)
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

      await rec.reconcileContext(context)

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

      await rec.reconcileContext(context)

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

      await rec.reconcileContext(context)

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

      await reconciler.reconcileExternalEgress(server)

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

      await reconciler.reconcileExternalEgress(server)

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

      await reconciler.reconcileExternalEgress(server)

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

      await reconciler.reconcileExternalEgress(server)

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

        await expect(reconciler.reconcileExternalEgress(server)).rejects.toThrow(/stale McpServer/i)

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

      await expect(reconciler.reconcileExternalEgress(server)).rejects.toBe(conflict)

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

      await expect(reconciler.reconcileExternalEgress(server)).rejects.toThrow(
        'status update denied'
      )

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

      await expect(reconciler.reconcileExternalEgress(server)).rejects.toThrow('status read denied')

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

      await reconciler.reconcileExternalEgress(server)

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

      await expect(reconciler.reconcileExternalEgress(server)).rejects.toThrow(
        /public-web external egress bindings/
      )
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

      await expect(reconciler.reconcileExternalEgress(server)).rejects.toThrow(
        /public-web external egress bindings/
      )
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

      await reconciler.reconcileExternalEgress(server)

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

      await reconciler.reconcileExternalEgress(server)

      expect(mockCustomApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    })

    it('writes resolved egress IP status in stable DNS order', async () => {
      vi.mocked(dns.resolve4).mockImplementation(async hostname => {
        if (hostname === 'b.example.com') return ['5.6.7.8']
        if (hostname === 'a.example.com') return ['1.2.3.4']
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

      await reconciler.reconcileExternalEgress(server)

      const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
      const resolvedPatch = patch.find(
        (operation: { path?: string }) => operation.path === '/status/resolvedEgressIPs'
      )
      expect(resolvedPatch.value.map((entry: { dns: string }) => entry.dns)).toEqual([
        'a.example.com',
        'b.example.com',
      ])
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

        await expect(reconciler.reconcileExternalEgress(server)).rejects.toThrow(
          /External egress reconciliation failed/
        )
      }

      expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('rejects mixed public/private DNS results for the whole hostname', async () => {
      vi.mocked(dns.resolve4).mockResolvedValueOnce(['10.0.0.5', '1.2.3.4'])
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

      await expect(reconciler.reconcileExternalEgress(server)).rejects.toThrow(
        /resolved disallowed address/
      )

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

      await expect(reconciler.reconcileExternalEgress(server)).rejects.toThrow(
        /private, internal, metadata/
      )

      expect(dns.resolve4).not.toHaveBeenCalled()
      expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('does not create an external egress policy when DNS only resolves private IPs', async () => {
      vi.mocked(dns.resolve4).mockResolvedValueOnce(['10.0.0.5', '192.168.1.10'])
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

      await expect(reconciler.reconcileExternalEgress(server)).rejects.toThrow(
        /resolved disallowed address/
      )

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

      await reconciler.reconcileExternalEgress(server)

      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'ext-egress-openai-mcp-old-example-com-443',
        namespace: 'mcp-server',
      })
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

      await expect(reconciler.reconcileExternalEgress(server)).rejects.toThrow('delete denied')
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

      await expect(reconciler.reconcileExternalEgress(server)).rejects.toThrow(/dns timeout/)

      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'ext-egress-openai-mcp-api.openai.com-443',
        namespace: 'mcp-server',
      })
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'ext-egress-openai-mcp-old-example-com-443',
        namespace: 'mcp-server',
      })
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

      await expect(reconciler.reconcileExternalEgress(server)).rejects.toThrow(
        /must declare dns or cidr/
      )
      expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
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

      await reconciler.reconcileExternalEgress(server)

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

  describe('startup fullReconcile', () => {
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
      const reconcileContext = vi.spyOn(reconciler, 'reconcileContext').mockResolvedValue(undefined)
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

      expect(effectKeys).toEqual(['captured-context'])
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

    it('retires a full-pass external-egress lease when desired state is replaced', async () => {
      const selected: McpServerCRD = {
        name: 'full-pass-egress',
        namespace: 'mcp-server',
        uid: 'full-pass-egress-uid',
        generation: 1,
        spec: {
          contextRef: 'dev',
          image: 'full-pass-egress:old',
          transport: { type: 'streamableHttp', port: 3000 },
          egressBindings: [{ dns: 'old.example', port: 443 }],
        },
      }
      const replacement: McpServerCRD = {
        ...selected,
        generation: 2,
        spec: {
          ...selected.spec,
          image: 'full-pass-egress:new',
          egressBindings: [{ dns: 'new.example', port: 443 }],
        },
      }
      let current = selected
      let selectedLease: (() => boolean) | undefined
      const mutationStarted = deferred()
      const releaseMutation = deferred()
      vi.spyOn(reconciler, 'reconcileExternalEgress').mockImplementationOnce(
        async (_server, options) => {
          selectedLease = options?.isCurrent
          mutationStarted.resolve(undefined)
          await releaseMutation.promise
        }
      )

      const fullPass = reconciler.fullReconcile([], [selected], {
        ensureDefaults: false,
        serverInventoryAuthoritative: () => true,
        resolveCurrentServer: () => current,
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
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'ctx-orphan-context-old-server',
        namespace: 'mcp-server',
      })
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'ctx-orphan-context-old-server-egress',
        namespace: 'mcp-host',
      })
      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'rpc-egress-orphan-context-old-server',
        namespace: 'rpc-proxy',
      })
    })

    it('routes desired and orphan Context policy lanes through canonical contextId effect keys', async () => {
      const desiredContext: ContextCRD = {
        name: 'desired-context-resource',
        namespace: 'mcp-server',
        spec: { contextId: 'desired-context', mcpServers: [] },
      }
      const effectKeys: string[] = []
      vi.spyOn(reconciler, 'reconcileContext').mockResolvedValue(undefined)
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

      expect(effectKeys).toEqual(['orphan-context', 'orphan-context', 'desired-context'])
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
        expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
          name: 'ctx-orphan-context-old-server',
          namespace: 'mcp-server',
        })
        expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
          name: 'ctx-orphan-context-old-server-egress',
          namespace: 'mcp-host',
        })
        expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
          name: 'rpc-egress-orphan-context-old-server',
          namespace: 'rpc-proxy',
        })
        expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
          name: 'ext-egress-orphan-server-old.example',
          namespace: 'mcp-server',
        })
      } finally {
        releaseAdditive.resolve(undefined)
        await fullPass
      }
    })

    it('reconciles external egress policies for existing servers on startup', async () => {
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
      expect(externalPolicies).toHaveLength(1)
      const body = (
        externalPolicies[0][0] as {
          body: {
            metadata: { name: string }
            spec: { egress: Array<{ ports: Array<{ port: number }> }> }
          }
        }
      ).body
      expect(body.metadata.name).toContain('ext-egress-airtable-mcp')
      expect(body.spec.egress[0].ports[0].port).toBe(443)
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

      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'ext-egress-old-server-api-example-com-443',
        namespace: 'mcp-server',
      })
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
      const reconcileContext = vi.spyOn(reconciler, 'reconcileContext').mockResolvedValue(undefined)
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
      expect(contextInventoryAuthoritative).toHaveBeenCalledTimes(2)
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

    it('finishes desired McpServer reconciliation but stops external-egress orphan cleanup when authority is lost after inventory listing', async () => {
      const desiredServer: McpServerCRD = {
        name: 'current-server',
        namespace: 'mcp-server',
        spec: {
          contextRef: 'current',
          image: 'current:latest',
          transport: { type: 'streamableHttp', url: 'http://current:3000', port: 3000 },
        },
      }
      const reconcileExternalEgress = vi
        .spyOn(reconciler, 'reconcileExternalEgress')
        .mockResolvedValue(undefined)
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

      expect(reconcileExternalEgress).toHaveBeenCalledWith(desiredServer, {
        isCurrent: expect.any(Function),
      })
      expect(serverInventoryAuthoritative).toHaveBeenCalledTimes(2)
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

      expect(mockApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
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
  })
})
