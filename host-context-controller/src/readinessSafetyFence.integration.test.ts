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
})
