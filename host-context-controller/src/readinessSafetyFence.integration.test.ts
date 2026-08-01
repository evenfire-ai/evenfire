/**
 * Crosses the whole readiness chain with a real NetworkPolicyReconciler.
 *
 * Every other test of this behaviour mocks one side. `k8sClient.test.ts` mocks
 * `./networkPolicyReconciler`, so it can prove the readiness predicate *reads*
 * the certification getter but not that the reconciler ever *degrades* it.
 * `networkPolicyReconciler.test.ts` drives the real fence but never reaches an
 * HTTP response. Each half is verified by mutation; the seam between them was
 * not, and the seam is where the guarantee actually lives.
 *
 * Here `@kubernetes/client-node` is the only mock. The reconciler, the watcher
 * predicate, and the HTTP server are the production classes, so the assertion
 * is end-to-end: a delete that loses its uid/resourceVersion precondition
 * during the additive phase — the 409 a second writer produces, and every
 * rollout opens a two-replica window for one — must turn /ready from 200 into
 * 503, and a later clean pass must turn it back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as http from 'http'
import { McpServerWatcher } from './k8sClient'
import { ContextMapperServer } from './server'

const mocks = vi.hoisted(() => ({
  listNamespacedNetworkPolicy: vi.fn(),
  deleteNamespacedNetworkPolicy: vi.fn(),
  readNamespacedNetworkPolicy: vi.fn(),
  createNamespacedNetworkPolicy: vi.fn(),
  replaceNamespacedNetworkPolicy: vi.fn(),
  listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
  getNamespacedCustomObject: vi
    .fn()
    .mockRejectedValue(Object.assign(new Error('not found'), { code: 404 })),
  getNamespacedCustomObjectStatus: vi
    .fn()
    .mockResolvedValue({ metadata: { generation: 1, resourceVersion: 'rv-1' }, status: {} }),
  patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
  watch: vi.fn().mockResolvedValue({ abort: vi.fn() }),
}))

vi.mock('./config', () => ({
  config: {
    devMode: false,
    namespace: 'mcp-server',
    hostNamespace: 'mcp-host',
    rpcProxyNamespace: 'rpc-proxy',
    channelsNamespace: 'channels',
    port: 0,
    runtimeNamespaces: ['mcp-server', 'mcp-host', 'sandbox-recipes', 'rpc-proxy'],
    hostK8sRequestTimeoutMs: 30_000,
    hostResyncIntervalSec: 0,
    externalEgressResyncIntervalSec: 0,
    controlApiBaseUrl: 'http://control-api.test:8090',
    governedTracingEnabled: false,
  },
}))

vi.mock('@kubernetes/client-node', () => {
  class CustomObjectsApi {}
  class CoreV1Api {}
  class NetworkingV1Api {}
  class PolicyV1Api {}
  class AppsV1Api {}
  class BatchV1Api {}
  class RbacAuthorizationV1Api {}
  class Watch {
    constructor(_kc: unknown) {}
    watch = mocks.watch
  }
  class KubeConfig {
    loadFromDefault(): void {}
    loadFromOptions(_o: unknown): void {}
    makeApiClient(api: unknown): unknown {
      if (api === NetworkingV1Api) {
        return {
          listNamespacedNetworkPolicy: mocks.listNamespacedNetworkPolicy,
          deleteNamespacedNetworkPolicy: mocks.deleteNamespacedNetworkPolicy,
          readNamespacedNetworkPolicy: mocks.readNamespacedNetworkPolicy,
          createNamespacedNetworkPolicy: mocks.createNamespacedNetworkPolicy,
          replaceNamespacedNetworkPolicy: mocks.replaceNamespacedNetworkPolicy,
        }
      }
      if (api === CustomObjectsApi) {
        return {
          listNamespacedCustomObject: mocks.listNamespacedCustomObject,
          getNamespacedCustomObject: mocks.getNamespacedCustomObject,
          getNamespacedCustomObjectStatus: mocks.getNamespacedCustomObjectStatus,
          patchNamespacedCustomObjectStatus: mocks.patchNamespacedCustomObjectStatus,
        }
      }
      return new Proxy({}, { get: () => vi.fn().mockResolvedValue({ items: [] }) })
    }
  }
  return {
    CustomObjectsApi,
    CoreV1Api,
    NetworkingV1Api,
    PolicyV1Api,
    AppsV1Api,
    BatchV1Api,
    RbacAuthorizationV1Api,
    Watch,
    KubeConfig,
  }
})

const MANAGED = 'clerum.io/managed-by'
const POLICY_TYPE = 'clerum.io/policy-type'
const CONTEXT_LABEL = 'clerum.io/context'
const SERVER_LABEL = 'clerum.io/mcpserver'

/** A stale context-allow: HCC-owned, for a server the Context no longer lists. */
const stalePolicy = {
  metadata: {
    name: 'ctx-alpha-ghost',
    namespace: 'mcp-server',
    uid: 'ghost-uid',
    resourceVersion: '7',
    labels: {
      [MANAGED]: 'host-context-controller',
      [POLICY_TYPE]: 'context-allow',
      [CONTEXT_LABEL]: 'alpha',
      [SERVER_LABEL]: 'ghost',
    },
  },
  spec: { podSelector: {}, policyTypes: ['Ingress'] },
}

const alphaContext = {
  name: 'alpha',
  namespace: 'mcp-server',
  spec: { contextId: 'alpha', mcpServers: [] },
}

async function readyStatus(server: InstanceType<typeof ContextMapperServer>): Promise<number> {
  const listener = (server as unknown as { server: http.Server | null }).server
  const address = listener?.address()
  if (!address || typeof address === 'string') throw new Error('readiness listener never bound')
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: address.port, path: '/ready' }, res => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      .on('error', reject)
  })
}

/** Aligns every revocation counter so only the fence can gate readiness. */
function alignRevocationCounters(watcher: InstanceType<typeof McpServerWatcher>): void {
  const w = watcher as unknown as Record<string, unknown>
  w.mcpServerCacheSynced = true
  w.contextCacheSynced = true
  w.hostCacheSynced = true
  w.networkPolicyRevocationContextGeneration = w.contextWatchGeneration
  w.networkPolicyRevocationServerGeneration = w.mcpWatchGeneration
  w.networkPolicyRevocationContextRevision = w.contextDesiredRevision
  w.networkPolicyRevocationServerRevision = w.mcpServerDesiredRevision
}

describe('readiness withdrawal on a real lost delete fence', () => {
  let watcher: InstanceType<typeof McpServerWatcher>
  let server: InstanceType<typeof ContextMapperServer>

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.listNamespacedCustomObject.mockResolvedValue({ items: [] })
    mocks.getNamespacedCustomObject.mockRejectedValue(
      Object.assign(new Error('not found'), { code: 404 })
    )
    mocks.createNamespacedNetworkPolicy.mockResolvedValue({})
    mocks.replaceNamespacedNetworkPolicy.mockResolvedValue({})
    mocks.readNamespacedNetworkPolicy.mockResolvedValue(stalePolicy)
    watcher = new McpServerWatcher()
    server = new ContextMapperServer(watcher, 0, undefined, undefined, () =>
      watcher.isReadinessInventoryAuthoritative()
    )
    await server.start()
    server.setReady(true)
  })

  afterEach(async () => {
    await server.stop()
    await watcher.stop()
  })

  it('turns /ready from 200 to 503 when the additive phase loses a delete fence, and back on a clean pass', async () => {
    const reconciler = (watcher as unknown as { netPolReconciler: any }).netPolReconciler
    alignRevocationCounters(watcher)

    // Baseline: nothing stale anywhere, so the pass certifies and the gate opens.
    mocks.listNamespacedNetworkPolicy.mockResolvedValue({ items: [] })
    mocks.deleteNamespacedNetworkPolicy.mockResolvedValue({})
    await reconciler.fullReconcile([alphaContext], [], {
      ensureDefaults: false,
      contextInventoryAuthoritative: () => true,
      serverInventoryAuthoritative: () => true,
      onAuthoritativeRevocationComplete: () => {},
    })
    alignRevocationCounters(watcher)
    expect(await readyStatus(server)).toBe(200)

    // The stale allow only becomes visible after the authoritative phase has
    // certified, so the safety phase is clean by construction and the additive
    // re-LIST is what finds it. Its delete then loses the uid/resourceVersion
    // precondition — a 409, exactly what a concurrent writer produces.
    let certified = false
    mocks.listNamespacedNetworkPolicy.mockImplementation(
      async ({ namespace }: { namespace?: string }) => ({
        items: certified && namespace === 'mcp-server' ? [stalePolicy] : [],
      })
    )
    mocks.deleteNamespacedNetworkPolicy.mockRejectedValue(
      Object.assign(new Error('the object has been modified'), { code: 409 })
    )

    await expect(
      reconciler.fullReconcile([alphaContext], [], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        onAuthoritativeRevocationComplete: () => {
          certified = true
        },
      })
    ).rejects.toThrow()

    // Nothing moved: no watch generation bumped, no desired revision changed.
    // Only the fence knows this pass left an allow it classified as stale.
    alignRevocationCounters(watcher)
    expect(reconciler.hasCertifiedSafetyInventory()).toBe(false)
    expect(await readyStatus(server)).toBe(503)

    // The retry lands: the allow is gone and the pass certifies again.
    mocks.listNamespacedNetworkPolicy.mockResolvedValue({ items: [] })
    mocks.deleteNamespacedNetworkPolicy.mockResolvedValue({})
    await reconciler.fullReconcile([alphaContext], [], {
      ensureDefaults: false,
      contextInventoryAuthoritative: () => true,
      serverInventoryAuthoritative: () => true,
      onAuthoritativeRevocationComplete: () => {},
    })
    alignRevocationCounters(watcher)
    expect(reconciler.hasCertifiedSafetyInventory()).toBe(true)
    expect(await readyStatus(server)).toBe(200)
  })

  it('withholds readiness when the authoritative pass loses a delete fence under a provided safety snapshot', async () => {
    const reconciler = (watcher as unknown as { netPolReconciler: any }).netPolReconciler
    alignRevocationCounters(watcher)

    // Baseline: a clean authoritative pass certifies and the gate opens.
    mocks.listNamespacedNetworkPolicy.mockResolvedValue({ items: [] })
    mocks.deleteNamespacedNetworkPolicy.mockResolvedValue({})
    await reconciler.fullReconcile([alphaContext], [], {
      ensureDefaults: false,
      contextInventoryAuthoritative: () => true,
      serverInventoryAuthoritative: () => true,
      onAuthoritativeRevocationComplete: () => {},
    })
    alignRevocationCounters(watcher)
    expect(await readyStatus(server)).toBe(200)

    // Unlike the additive-phase test above, the stale allow is visible to the
    // authoritative LISTs from the very start of the pass, so fullReconcile
    // classifies it into the safety snapshot it provides to the revocation
    // lane. Its identity-bound delete then loses the uid/resourceVersion
    // precondition (409). The external-egress selector stays empty so the
    // fence is lost in the provided-snapshot lane and nowhere else.
    mocks.listNamespacedNetworkPolicy.mockImplementation(
      async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => ({
        items:
          namespace === 'mcp-server' && !(labelSelector ?? '').includes('external-egress')
            ? [stalePolicy]
            : [],
      })
    )
    mocks.deleteNamespacedNetworkPolicy.mockRejectedValue(
      Object.assign(new Error('the object has been modified'), { code: 409 })
    )

    // The guarantee under test is that the fence degrades at the point of
    // loss, while the condemned pass is still unwinding — not only when the
    // pass finally reports. Sample it through the authority callback the pass
    // keeps polling: every sample before the lost delete must be certified,
    // and every later sample must already be withdrawn.
    let certifications = 0
    const fenceSeenDuringPass: boolean[] = []
    await expect(
      reconciler.fullReconcile([alphaContext], [], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => {
          fenceSeenDuringPass.push(reconciler.hasCertifiedSafetyInventory())
          return true
        },
        serverInventoryAuthoritative: () => true,
        onAuthoritativeRevocationComplete: () => {
          certifications += 1
        },
      })
    ).rejects.toThrow()

    expect(certifications).toBe(0)
    expect(fenceSeenDuringPass.length).toBeGreaterThan(1)
    expect(fenceSeenDuringPass[0]).toBe(true)
    expect(fenceSeenDuringPass[fenceSeenDuringPass.length - 1]).toBe(false)

    alignRevocationCounters(watcher)
    expect(reconciler.hasCertifiedSafetyInventory()).toBe(false)
    expect(await readyStatus(server)).toBe(503)

    // A clean authoritative pass re-certifies and reopens the gate.
    mocks.listNamespacedNetworkPolicy.mockResolvedValue({ items: [] })
    mocks.deleteNamespacedNetworkPolicy.mockResolvedValue({})
    await reconciler.fullReconcile([alphaContext], [], {
      ensureDefaults: false,
      contextInventoryAuthoritative: () => true,
      serverInventoryAuthoritative: () => true,
      onAuthoritativeRevocationComplete: () => {},
    })
    alignRevocationCounters(watcher)
    expect(reconciler.hasCertifiedSafetyInventory()).toBe(true)
    expect(await readyStatus(server)).toBe(200)
  })

  it('does not let a scoped delta certify readiness while the last authoritative pass left the inventory uncertified', async () => {
    const reconciler = (watcher as unknown as { netPolReconciler: any }).netPolReconciler
    const w = watcher as unknown as Record<string, any>

    // Register the real Context watch so the production watch handler — the
    // scoped-delta certification lane — can be driven through its callback.
    await w.startContextWatch('ctx-rv-1')
    const contextWatchCall = mocks.watch.mock.calls.find(([path]) =>
      String(path).endsWith('/namespaces/mcp-server/contexts')
    )
    if (!contextWatchCall) throw new Error('Context watch was never registered')
    const fireContextEvent = contextWatchCall[2] as (type: string, apiObj: unknown) => Promise<void>

    // Seed the prior Context so the MODIFIED event below is a same-identity
    // delta: same uid, same contextId, new generation.
    const priorContext = {
      name: 'alpha',
      namespace: 'mcp-server',
      uid: 'ctx-alpha-uid',
      generation: 1,
      spec: { contextId: 'alpha', mcpServers: [] },
    }
    w.contexts.set('alpha', priorContext)
    alignRevocationCounters(watcher)

    // Baseline clean authoritative pass: certified, gate open.
    mocks.listNamespacedNetworkPolicy.mockResolvedValue({ items: [] })
    mocks.deleteNamespacedNetworkPolicy.mockResolvedValue({})
    await reconciler.fullReconcile([priorContext], [], {
      ensureDefaults: false,
      contextInventoryAuthoritative: () => true,
      serverInventoryAuthoritative: () => true,
      onAuthoritativeRevocationComplete: () => {},
    })
    alignRevocationCounters(watcher)
    expect(await readyStatus(server)).toBe(200)

    // The authoritative pass loses its delete fence under the provided
    // snapshot, exactly as in the test above: the broad safety LISTs see the
    // stale allow and its delete keeps 409ing. Every context-scoped LIST
    // stays empty so the scoped delta fired below completes its own
    // revocation cleanly — and because the 409 never clears, the convergence
    // pass the watch event kicks off in the background can never certify
    // either.
    mocks.listNamespacedNetworkPolicy.mockImplementation(
      async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => {
        const selector = labelSelector ?? ''
        const scoped =
          selector.includes(`${CONTEXT_LABEL}=`) || selector.includes('external-egress')
        return { items: namespace === 'mcp-server' && !scoped ? [stalePolicy] : [] }
      }
    )
    mocks.deleteNamespacedNetworkPolicy.mockRejectedValue(
      Object.assign(new Error('the object has been modified'), { code: 409 })
    )
    await expect(
      reconciler.fullReconcile([priorContext], [], {
        ensureDefaults: false,
        contextInventoryAuthoritative: () => true,
        serverInventoryAuthoritative: () => true,
        onAuthoritativeRevocationComplete: () => {},
      })
    ).rejects.toThrow()
    alignRevocationCounters(watcher)
    expect(reconciler.hasCertifiedSafetyInventory()).toBe(false)
    expect(await readyStatus(server)).toBe(503)

    // Fire a same-identity MODIFIED delta. Its scoped revocation completes
    // (its label-scoped LISTs are clean) and it carries a delta certificate,
    // so the only thing standing between it and
    // recordNetworkPolicySafetyCertificate is the uncertified fence left by
    // the authoritative pass.
    const warnSpy = vi.spyOn(console, 'warn')
    try {
      await fireContextEvent('MODIFIED', {
        metadata: { name: 'alpha', namespace: 'mcp-server', uid: 'ctx-alpha-uid', generation: 2 },
        spec: { contextId: 'alpha', mcpServers: [] },
      })

      // The delta declined to certify: it warned, it recorded no certificate
      // (the revocation counters were not advanced to the delta's bumped
      // revision), and readiness stays withdrawn even after every counter is
      // realigned so the fence is the only remaining gate.
      expect(
        warnSpy.mock.calls.some(call => String(call[0]).includes('Not certifying the scoped delta'))
      ).toBe(true)
      expect(w.networkPolicyRevocationContextRevision).not.toBe(w.contextDesiredRevision)
      expect(reconciler.hasCertifiedSafetyInventory()).toBe(false)
      alignRevocationCounters(watcher)
      expect(await readyStatus(server)).toBe(503)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
