/**
 * #1338, replayed end to end.
 *
 * What happened on the dev cluster:
 *   1. an hourly NetworkPolicy pass started while connections to the API server
 *      were being dropped (an automated deploy was running);
 *   2. one LIST of that pass never got an answer: the client had no deadline,
 *      so the pass never settled, and the single-flight pass blocked every later
 *      pass;
 *   3. the deploy then patched a Context, so the request lane needed a newly
 *      certified pass and answered 503 on every protected route;
 *   4. mcp-host revokes its whole MCP fleet after 180 s without a successful
 *      inventory poll, so every agent lost its MCP tools for 14.5 hours.
 *
 * This test runs the same sequence through the production watcher, server and
 * NetworkPolicy reconciler. Only the Kubernetes transport is replaced: a fake
 * that runs the real request middleware (so the production deadline wrapper
 * sets the request's AbortSignal) and, for the one lost LIST, never answers
 * unless that signal aborts, which is how node-fetch behaves on a connection
 * that stops answering. The Context change arrives through the production
 * Context watch callback, as the deploy's patch did.
 *
 * The test fails unless the Host inventory route is back to 200 before the
 * mcp-host staleness bound, i.e. before any Host would revoke its fleet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { McpServerWatcher } from './k8sClient'
import type { McpApiAuthenticator, VerifiedMcpHostPrincipal } from './mcpApiAuthentication'
import {
  type AuthorityContext,
  type AuthorityHost,
  McpAuthorizationService,
  type McpAuthorizationStore,
} from './mcpAuthorization'
import {
  resolveHostAuthoritativeFn,
  resolveProbeAuthoritativeFn,
  resolveProviderAuthoritativeFn,
  resolveReadinessDetailFn,
} from './readinessGate'
import { ContextMapperServer } from './server'

// mcp-host revokes its published fleet after this long without a successful
// inventory poll (HCC_AUTHORITY_MAX_STALENESS_MS default, mcp-host/src/config.ts).
const MCP_HOST_AUTHORITY_STALENESS_MS = 180_000
// Production default of HCC_K8S_REQUEST_TIMEOUT_MS (host-context-controller/src/config.ts).
const K8S_REQUEST_TIMEOUT_MS = 30_000

const mocks = vi.hoisted(() => ({
  listNamespacedNetworkPolicy: vi.fn(),
  deleteNamespacedNetworkPolicy: vi.fn(),
  readNamespacedNetworkPolicy: vi.fn(),
  createNamespacedNetworkPolicy: vi.fn(),
  replaceNamespacedNetworkPolicy: vi.fn(),
  listNamespacedCustomObject: vi.fn(),
  getNamespacedCustomObject: vi.fn(),
  getNamespacedCustomObjectStatus: vi.fn(),
  patchNamespacedCustomObjectStatus: vi.fn(),
  watch: vi.fn(),
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
    k8sRequestTimeoutMs: 30_000,
    netPolPassHardLimitMs: 30 * 60_000,
    hostResyncIntervalSec: 0,
    externalEgressResyncIntervalSec: 0,
    controlApiBaseUrl: 'http://control-api.test:8090',
    governedTracingEnabled: false,
  },
}))

vi.mock('@kubernetes/client-node', () => {
  // The deadline wrapper's middleware returns an Observable; the generated
  // client resolves it with toPromise().
  class Observable<T> {
    constructor(private readonly promise: Promise<T>) {}
    toPromise(): Promise<T> {
      return this.promise
    }
  }
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
    Observable,
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

type RequestContext = { getSignal(): AbortSignal | undefined; setSignal(s: AbortSignal): void }
type Middleware = { pre(context: RequestContext): { toPromise(): Promise<unknown> } }

/**
 * The lost request: run the call's middleware like the generated client does,
 * then never answer. Only an abort of the signal the middleware installed ends
 * it, with node-fetch's AbortError. Without a deadline middleware it never
 * settles, exactly as on the incident cluster.
 */
async function requestThatNeverAnswers(
  _params: unknown,
  options?: { middleware?: Middleware[] }
): Promise<never> {
  let signal: AbortSignal | undefined
  const context: RequestContext = {
    getSignal: () => signal,
    setSignal: next => {
      signal = next
    },
  }
  for (const middleware of options?.middleware ?? []) await middleware.pre(context).toPromise()
  return new Promise<never>((_resolve, reject) => {
    signal?.addEventListener(
      'abort',
      () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })),
      { once: true }
    )
  })
}

const principal: VerifiedMcpHostPrincipal = {
  subject: 'mcp-host/host-a',
  hostName: 'host-a',
  hostUid: 'host-uid-a',
  namespace: 'mcp-host',
  jti: 'jti-a',
  issuedAt: 1,
  expiresAt: 4_000_000_000,
  audiences: ['host-context-controller'],
}

/** A Host bound to Context `alpha`, which selects no McpServer: inventory 200 means "authorized, empty". */
class HostAuthorityStore implements McpAuthorizationStore {
  hostReads = 0
  private readonly host: AuthorityHost = {
    name: 'host-a',
    namespace: 'mcp-host',
    metadata: { uid: 'host-uid-a', resourceVersion: '1' },
    contextRef: 'alpha',
  }
  private readonly context: AuthorityContext = {
    name: 'alpha',
    namespace: 'mcp-server',
    metadata: { uid: 'ctx-uid-alpha', resourceVersion: '2' },
    mcpServers: [],
  }
  async readHost() {
    this.hostReads += 1
    return this.host
  }
  async readContext() {
    return this.context
  }
  async readMcpServer() {
    return null
  }
  async readSecretMetadata() {
    return null
  }
  async readSecret() {
    return null
  }
}

class MockResponse {
  statusCode = 200
  headers: Record<string, string> = {}
  body = ''
  headersSent = false
  setHeader(name: string, value: string): void {
    this.headers[name] = value
  }
  writeHead(status: number, headers?: Record<string, string>): void {
    this.statusCode = status
    this.headersSent = true
    if (headers) Object.assign(this.headers, headers)
  }
  end(chunk?: string): void {
    if (chunk) this.body += chunk
  }
}

async function status(server: ContextMapperServer, path: string): Promise<number> {
  const req = Readable.from([])
  Object.assign(req, {
    method: 'GET',
    url: path,
    headers: { authorization: 'Bearer host-token' },
    rawHeaders: ['authorization', 'Bearer host-token'],
  })
  const res = new MockResponse()
  await (
    server as unknown as { handleRequest: (r: Readable, s: MockResponse) => Promise<void> }
  ).handleRequest(req, res)
  return res.statusCode
}

type LogEntry = { fields: any }

function captureLogs(): LogEntry[] {
  const entries: LogEntry[] = []
  for (const method of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((line?: unknown) => {
      if (typeof line !== 'string' || !line.startsWith('{')) return
      entries.push({ fields: JSON.parse(line) })
    })
  }
  return entries
}

function passResults(entries: LogEntry[]): Array<{ passId: number; result: string }> {
  return entries
    .filter(entry => entry.fields?.event === 'networkpolicy-pass-result')
    .map(entry => ({ passId: entry.fields.passId, result: entry.fields.result }))
}

function resetMocks(): void {
  vi.clearAllMocks()
  mocks.listNamespacedNetworkPolicy.mockResolvedValue({ items: [] })
  mocks.deleteNamespacedNetworkPolicy.mockResolvedValue({})
  mocks.createNamespacedNetworkPolicy.mockResolvedValue({})
  mocks.replaceNamespacedNetworkPolicy.mockResolvedValue({})
  mocks.readNamespacedNetworkPolicy.mockRejectedValue(
    Object.assign(new Error('not found'), { code: 404 })
  )
  mocks.listNamespacedCustomObject.mockResolvedValue({ items: [] })
  mocks.getNamespacedCustomObject.mockRejectedValue(
    Object.assign(new Error('not found'), { code: 404 })
  )
  mocks.getNamespacedCustomObjectStatus.mockResolvedValue({
    metadata: { generation: 1, resourceVersion: 'rv-1' },
    status: {},
  })
  mocks.patchNamespacedCustomObjectStatus.mockResolvedValue({})
  mocks.watch.mockResolvedValue({ abort: vi.fn() })
}

describe('#1338 replay: a lost request during a pass, then a deploy that changes a Context', () => {
  let watcher: Record<string, any>
  let server: ContextMapperServer
  const exitProcess = vi.fn()

  beforeEach(() => {
    resetMocks()
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    })
    watcher = new McpServerWatcher({ exitProcess }) as unknown as Record<string, any>
    watcher.mcpServerCacheSynced = true
    watcher.contextCacheSynced = true
    watcher.hostCacheSynced = true
    watcher.contexts.set('alpha', {
      name: 'alpha',
      namespace: 'mcp-server',
      uid: 'ctx-uid-alpha',
      generation: 1,
      spec: { contextId: 'alpha', mcpServers: [] },
    })
    const typed = watcher as unknown as InstanceType<typeof McpServerWatcher>
    server = new ContextMapperServer(
      typed,
      0,
      undefined,
      undefined,
      resolveProviderAuthoritativeFn(typed),
      resolveHostAuthoritativeFn(typed),
      { authenticate: () => principal } as unknown as McpApiAuthenticator,
      new McpAuthorizationService(new HostAuthorityStore()),
      resolveReadinessDetailFn(typed),
      resolveProbeAuthoritativeFn(typed)
    )
    server.setReady(true)
  })

  afterEach(async () => {
    await watcher.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('certifies again and reopens the Host inventory before any Host would revoke its fleet', async () => {
    const logs = captureLogs()

    // Before the incident: a certified pass, Hosts get their inventory.
    await watcher.runInitialNetworkPolicyConvergence({ cause: 'startup' })
    expect(passResults(logs)).toEqual([{ passId: 1, result: 'certified' }])
    expect(await status(server, '/api/v2/hosts/self/mcpservers')).toBe(200)

    // The Context watch is live, as in production; the deploy's patch arrives through it.
    await watcher.startContextWatch('rv-ctx-1')
    const contextWatchCall = mocks.watch.mock.calls.find(([path]) =>
      String(path).endsWith('/namespaces/mcp-server/contexts')
    )
    expect(contextWatchCall).toBeDefined()
    const onContextEvent = contextWatchCall![2] as (type: string, obj: unknown) => Promise<void>

    // 1-2. The hourly pass starts and its first LIST is lost.
    mocks.listNamespacedNetworkPolicy.mockImplementationOnce(requestThatNeverAnswers)
    const listsBefore = mocks.listNamespacedNetworkPolicy.mock.calls.length
    const hourlyPassStartMs = Date.now()
    const hourlyPass = watcher.runInitialNetworkPolicyConvergence({ cause: 'periodic-resync' })
    await vi.advanceTimersByTimeAsync(0)
    // Liveness witness: the pass is in flight on the lost request.
    expect(mocks.listNamespacedNetworkPolicy.mock.calls.length).toBe(listsBefore + 1)
    expect(watcher.activeNetworkPolicyPass?.passId).toBe(2)

    // 3. The deploy patches the Context three times in quick succession while the
    //    pass is stuck (the incident: three modifications in 10 s, desired
    //    revision 14 -> 17). Each later event arrives before the earlier one's
    //    scoped revocation has recorded its certificate, so no scoped delta can
    //    realign the revocation revision: only a newly certified full pass can.
    const deployPatchAtMs = Date.now()
    const revisionBefore = watcher.contextDesiredRevision
    await Promise.all(
      [2, 3, 4].map(generation =>
        onContextEvent('MODIFIED', {
          metadata: { name: 'alpha', namespace: 'mcp-server', uid: 'ctx-uid-alpha', generation },
          spec: {
            contextId: 'alpha',
            mcpServers: [],
            description: `patched by a deploy (generation ${generation})`,
          },
        })
      )
    )
    await vi.advanceTimersByTimeAsync(0)
    // Witness: the three patches moved the desired revision.
    expect(watcher.contextDesiredRevision).toBe(revisionBefore + 3)
    // This is the incident state: protected Host routes refuse while the pass is stuck.
    expect(await status(server, '/api/v2/hosts/self/mcpservers')).toBe(503)
    expect(await status(server, '/ready')).toBe(200)

    // 4. Time runs; Hosts poll every 30 s. Record when their inventory is served again.
    let reopenedAtMs: number | undefined
    while (Date.now() - deployPatchAtMs < MCP_HOST_AUTHORITY_STALENESS_MS) {
      await vi.advanceTimersByTimeAsync(1_000)
      if ((await status(server, '/api/v2/hosts/self/mcpservers')) === 200) {
        reopenedAtMs = Date.now()
        break
      }
    }
    // Asserted before awaiting the pass: without a deadline the pass never settles.
    expect(reopenedAtMs, 'Host inventory still 503 at the mcp-host staleness bound').toBeDefined()
    expect(reopenedAtMs! - deployPatchAtMs).toBeLessThan(MCP_HOST_AUTHORITY_STALENESS_MS)
    await hourlyPass
    // The lost request ended at its deadline, the pass failed, and the retry certified.
    expect(passResults(logs)).toEqual([
      { passId: 1, result: 'certified' },
      { passId: 2, result: 'failed' },
      expect.objectContaining({ result: 'certified' }),
    ])
    // Recovery came through the lost request's deadline, not through some other path.
    expect(reopenedAtMs! - hourlyPassStartMs).toBeGreaterThanOrEqual(K8S_REQUEST_TIMEOUT_MS)
    expect(await status(server, '/api/v1/mcpservers')).toBe(200)
    expect(exitProcess).not.toHaveBeenCalled()
  })
})
