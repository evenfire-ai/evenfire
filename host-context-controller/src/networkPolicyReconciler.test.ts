import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import type { RecordWithTtl } from 'node:dns'
import * as dns from 'node:dns/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NetworkPolicyReconciler, PUBLIC_EGRESS_EXCEPT_CIDRS } from './networkPolicyReconciler'
import { ContextCRD, McpServerCRD } from './types'

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
    // #299 sliding-window knobs read by reconcileExternalEgress.
    externalEgressOverlapSec: 300,
    externalEgressMaxEntries: 128,
    // #299 Phase 2 — provider-CIDR catalog. providerRangeBoundsOverrides omitted
    // ⇒ the registry per-provider bounds win.
    providerNetblocksConfigMapName: 'clerum-provider-netblocks',
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
    getNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({ status: {} }),
    patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
  }
}

// issue #299 Phase 2 — provider-netblocks catalog reader (HCC only reads it).
function makeMockCoreApi() {
  return {
    readNamespacedConfigMap: vi.fn().mockResolvedValue({ data: {} }),
  }
}

function makeReconciler(
  mockApi: ReturnType<typeof makeMockNetworkingApi>,
  serverCache?: Map<string, McpServerCRD>,
  mockCustomApi: ReturnType<typeof makeMockCustomApi> = makeMockCustomApi(),
  mockCoreApi: ReturnType<typeof makeMockCoreApi> = makeMockCoreApi()
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
  ;(reconciler as unknown as { coreApi: unknown }).coreApi = mockCoreApi
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
    resolve4Mock.mockResolvedValue(rec('1.2.3.4', '5.6.7.8'))
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

    // ── issue #299 Phase 2 — provider-CIDR mode (D.3). HCC-7, HCC-9. ──
    const PROVIDER_API_24 = [
      '192.30.252.0/22',
      '185.199.108.0/22',
      '140.82.112.0/20',
      '143.55.64.0/20',
      '20.201.28.148/32',
      '20.205.243.168/32',
      '20.87.245.6/32',
      '4.237.22.34/32',
      '4.228.31.149/32',
      '20.207.73.85/32',
      '20.27.177.116/32',
      '20.200.245.245/32',
      '20.175.192.149/32',
      '20.233.83.146/32',
      '20.29.134.17/32',
      '20.199.39.228/32',
      '20.217.135.0/32',
      '4.225.11.201/32',
      '4.208.26.200/32',
      '20.26.156.210/32',
      '172.182.252.137/32',
      '4.249.131.166/32',
      '48.202.248.39/32',
      '48.204.201.2/32',
    ].join('\n')

    const providerServer = (): McpServerCRD => ({
      name: 'gh-mcp',
      namespace: 'mcp-server',
      spec: {
        contextRef: 'dev',
        image: 'x:latest',
        transport: { type: 'streamableHttp', url: 'http://x:3000', port: 3000 },
        egressBindings: [
          {
            egressClass: 'provider',
            dns: 'api.github.com',
            port: 443,
            provider: { name: 'github' },
          },
        ],
      },
    })

    it('HCC-7: a provider binding renders the catalog ranges and stamps provenance', async () => {
      const mockCore = makeMockCoreApi()
      mockCore.readNamespacedConfigMap.mockResolvedValue({
        data: { 'github.api.ipv4': PROVIDER_API_24 },
      })
      const r = makeReconciler(mockApi, undefined, makeMockCustomApi(), mockCore)
      resolve4Mock.mockResolvedValue([{ address: '140.82.121.5', ttl: 60 }]) // covered by the /20

      await r.reconcileExternalEgress(providerServer())

      expect(mockApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      const body = mockApi.createNamespacedNetworkPolicy.mock.calls[0][0].body
      expect(body.spec.egress).toHaveLength(24) // the 24 catalog ranges; covered IP never entered the window
      for (const rule of body.spec.egress) {
        expect(rule.ports).toEqual([{ port: 443, protocol: 'TCP' }])
      }
      expect(body.metadata.labels['clerum.io/egress-class']).toBe('provider')
      expect(body.metadata.annotations['clerum.io/egress-provider-ranges']).toContain(
        'api.github.com='
      )
    })

    it('HCC-9 (H3): a catalog read failure RETAINS the live policy (LKG, never egress loss)', async () => {
      const mockCore = makeMockCoreApi()
      mockCore.readNamespacedConfigMap.mockResolvedValue({
        data: { 'github.api.ipv4': PROVIDER_API_24 },
      })
      const custom = makeMockCustomApi()
      const r = makeReconciler(mockApi, undefined, custom, mockCore)
      resolve4Mock.mockResolvedValue([{ address: '140.82.121.5', ttl: 60 }])

      // Phase 1: a successful reconcile creates the policy; capture its name.
      await r.reconcileExternalEgress(providerServer())
      const name = mockApi.createNamespacedNetworkPolicy.mock.calls[0][0].body.metadata
        .name as string

      // Phase 2: the policy is now live and the catalog read fails.
      vi.clearAllMocks()
      mockApi.listNamespacedNetworkPolicy.mockResolvedValue({
        items: [
          {
            metadata: {
              name,
              labels: {
                'clerum.io/policy-type': 'external-egress',
                'clerum.io/mcpserver': 'gh-mcp',
              },
            },
          },
        ],
      })
      mockCore.readNamespacedConfigMap.mockRejectedValue(
        Object.assign(new Error('not found'), { statusCode: 404 })
      )

      await expect(r.reconcileExternalEgress(providerServer())).rejects.toThrow()

      // H3: the live NetworkPolicy is RETAINED — neither deleted nor rewritten.
      expect(mockApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      // Ready=False was surfaced with the rejection reason.
      expect(JSON.stringify(custom.patchNamespacedCustomObjectStatus.mock.calls)).toContain(
        'ExternalEgressRejected'
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
      await reconciler.reconcileExternalEgress(server)
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
      await reconciler.reconcileExternalEgress(server)
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
      await reconciler.reconcileExternalEgress(server)
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
      await reconciler.reconcileExternalEgress(server)
      const wrote =
        mockApi.createNamespacedNetworkPolicy.mock.calls.length +
        mockApi.replaceNamespacedNetworkPolicy.mock.calls.length
      expect(wrote).toBeGreaterThan(0)
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
      await reconciler.reconcileExternalEgress(server)
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

      await reconciler.reconcileExternalEgress(server)
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
      await reconciler.reconcileExternalEgress(server)
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
      await reconciler.reconcileExternalEgress(server)
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
      await reconciler.reconcileExternalEgress(server)
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
      await reconciler.reconcileExternalEgress(server)
      const created = mockApi.createNamespacedNetworkPolicy.mock.calls[0][0] as {
        body: k8s.V1NetworkPolicy
      }
      const written = created.body
      mockApi.listNamespacedNetworkPolicy.mockResolvedValue({
        items: [{ metadata: written.metadata, spec: written.spec }],
      })
      mockApi.createNamespacedNetworkPolicy.mockClear()
      mockApi.replaceNamespacedNetworkPolicy.mockClear()

      await reconciler.reconcileExternalEgress(server)
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
      await reconciler.reconcileExternalEgress(server)
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

      await reconciler.reconcileExternalEgress(server)
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
      await reconciler.reconcileExternalEgress(server)
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

      await reconciler.reconcileExternalEgress(server)
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

        await expect(reconciler.reconcileExternalEgress(server)).rejects.toThrow(
          /External egress reconciliation failed/
        )
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

    it('propagates all external-egress policy list failures', async () => {
      mockApi.listNamespacedNetworkPolicy.mockRejectedValueOnce(new Error('api list denied'))

      await expect((reconciler as any).listAllExternalEgressPolicies()).rejects.toThrow(
        'api list denied'
      )
    })
  })

  describe('startup fullReconcile', () => {
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
