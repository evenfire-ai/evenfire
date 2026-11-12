/**
 * #1338: a NetworkPolicy pass that never settles.
 *
 * The production watcher and the production NetworkPolicyReconciler run with
 * `@kubernetes/client-node` as the only mock. The pass is single-flight, so a
 * pass that never settles keeps every later request attached to it and keeps
 * the provider inventory non-authoritative while `/ready` stays green.
 *
 * Two bounds close that:
 * - a finite Kubernetes call that exceeds its deadline rejects, so the pass
 *   ends `failed`, schedules its retry, and the next pass can certify;
 * - a pass that still runs past its overrun marks is reported with its phase
 *   and pending effect, and past the hard limit the process exits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as http from 'http'
import { NETPOL_PASS_OVERRUN_WARN_MS } from './constants'
import { K8sRequestTimeoutError } from './k8s/k8sRequestDeadline'
import { McpServerWatcher } from './k8sClient'
import { registry } from './metrics'
import {
  resolveHostAuthoritativeFn,
  resolveProbeAuthoritativeFn,
  resolveProviderAuthoritativeFn,
  resolveReadinessDetailFn,
} from './readinessGate'
import { ContextMapperServer } from './server'

const HARD_LIMIT_MS = 30 * 60_000

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
    // Longer than the hard limit, so a held request in the fake-clock tests
    // below stays pending instead of ending at its own deadline.
    k8sRequestTimeoutMs: 2 * 60 * 60_000,
    netPolPassHardLimitMs: 30 * 60_000,
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

const alphaContext = {
  name: 'alpha',
  namespace: 'mcp-server',
  spec: { contextId: 'alpha', mcpServers: [] },
}

type LogEntry = { level: string; message: string; fields: any }

/**
 * Capture the lines HostContextLogger actually prints. Its `sanitize` step
 * redacts field names such as `key`, so assertions must read the serialized
 * output, not the arguments passed to `hccLogger.*`.
 */
function captureLogs(): LogEntry[] {
  const entries: LogEntry[] = []
  for (const method of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((line?: unknown) => {
      if (typeof line !== 'string' || !line.startsWith('{')) return
      const fields = JSON.parse(line)
      entries.push({ level: fields.level, message: fields.msg, fields })
    })
  }
  return entries
}

function events(entries: LogEntry[], event: string): any[] {
  return entries.filter(entry => entry.fields?.event === event).map(entry => entry.fields)
}

async function overrunCount(severity: string, phase: string): Promise<number> {
  const metric = registry.getSingleMetric('clerum_hcc_networkpolicy_pass_overruns_total')
  if (!metric) throw new Error('clerum_hcc_networkpolicy_pass_overruns_total is not registered')
  const snapshot = await metric.get()
  return (
    snapshot.values.find(
      entry => entry.labels.severity === severity && entry.labels.phase === phase
    )?.value ?? 0
  )
}

/** A watcher whose Context/McpServer caches are synced and hold one Context. */
function syncedWatcher(exitProcess: (code: number) => void): Record<string, any> {
  const watcher = new McpServerWatcher({ exitProcess }) as unknown as Record<string, any>
  watcher.mcpServerCacheSynced = true
  watcher.contextCacheSynced = true
  watcher.hostCacheSynced = true
  watcher.contexts.set('alpha', alphaContext)
  return watcher
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

async function getStatus(
  server: InstanceType<typeof ContextMapperServer>,
  path: string
): Promise<number> {
  const listener = (server as unknown as { server: http.Server | null }).server
  const address = listener?.address()
  if (!address || typeof address === 'string') throw new Error('listener never bound')
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: address.port, path }, res => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      .on('error', reject)
  })
}

describe('#1338: a Kubernetes call past its deadline ends the NetworkPolicy pass', () => {
  let watcher: Record<string, any>
  let server: InstanceType<typeof ContextMapperServer>
  const exitProcess = vi.fn()

  beforeEach(async () => {
    resetMocks()
    watcher = syncedWatcher(exitProcess)
    const typed = watcher as unknown as InstanceType<typeof McpServerWatcher>
    server = new ContextMapperServer(
      typed,
      0,
      undefined,
      undefined,
      resolveProviderAuthoritativeFn(typed),
      resolveHostAuthoritativeFn(typed),
      undefined,
      undefined,
      resolveReadinessDetailFn(typed),
      resolveProbeAuthoritativeFn(typed)
    )
    await server.start()
    server.setReady(true)
  })

  afterEach(async () => {
    await server.stop()
    await watcher.stop()
    vi.restoreAllMocks()
  })

  it('logs a failed result, schedules the retry, and lets the next pass certify and reopen the API', async () => {
    const logs = captureLogs()
    // Certified baseline: the gate is open.
    await watcher.runInitialNetworkPolicyConvergence({ cause: 'startup' })
    expect(events(logs, 'networkpolicy-pass-result').map(e => e.result)).toEqual(['certified'])
    expect(await getStatus(server, '/api/v1/mcpservers')).toBe(200)

    // The next pass's first LIST exceeds its deadline. A Context changed, so
    // only a newly certified pass can reopen the API.
    mocks.listNamespacedNetworkPolicy.mockRejectedValueOnce(
      new K8sRequestTimeoutError('NetworkingV1Api.listNamespacedNetworkPolicy', 30_000)
    )
    watcher.contextDesiredRevision += 3
    const listsBefore = mocks.listNamespacedNetworkPolicy.mock.calls.length
    await watcher.runInitialNetworkPolicyConvergence({ cause: 'periodic-resync' })

    // Liveness witness: the pass reached the LIST that timed out.
    expect(mocks.listNamespacedNetworkPolicy.mock.calls.length).toBe(listsBefore + 1)
    expect(events(logs, 'networkpolicy-pass-result')).toEqual([
      expect.objectContaining({ passId: 1, result: 'certified' }),
      expect.objectContaining({ passId: 2, result: 'failed' }),
    ])
    expect(watcher.initialConvergenceRetryTimers.has('NetworkPolicy')).toBe(true)
    expect(watcher.initialConvergenceRuns.has('NetworkPolicy')).toBe(false)
    expect(await getStatus(server, '/api/v1/mcpservers')).toBe(503)
    expect(await getStatus(server, '/ready')).toBe(200)

    // A later request starts a new pass instead of attaching to a stuck one.
    await watcher.runInitialNetworkPolicyConvergence({ cause: 'retry' })
    expect(events(logs, 'networkpolicy-pass-result').at(-1)).toEqual(
      expect.objectContaining({ passId: 3, result: 'certified' })
    )
    expect(await getStatus(server, '/api/v1/mcpservers')).toBe(200)
    expect(exitProcess).not.toHaveBeenCalled()
  })
})

describe('#1338: a NetworkPolicy pass that outlives its bound', () => {
  let watcher: Record<string, any>
  const exitProcess = vi.fn()

  beforeEach(() => {
    resetMocks()
    registry.resetMetrics()
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    })
    watcher = syncedWatcher(exitProcess)
  })

  afterEach(async () => {
    await watcher.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /**
   * Hold the `alpha` Context queue with work that never settles. It is not a
   * Kubernetes call, so no request deadline can end it.
   */
  function holdAlphaContextQueue(): void {
    void watcher.enqueueContextReconciliation('alpha', () => new Promise<void>(() => {}))
  }

  it('reports the phase and pending effect at each overrun mark and exits at the hard limit', async () => {
    const logs = captureLogs()
    holdAlphaContextQueue()
    void watcher.runInitialNetworkPolicyConvergence({ cause: 'periodic-resync' })
    await vi.waitFor(() => expect(mocks.listNamespacedNetworkPolicy).toHaveBeenCalled())
    expect(events(logs, 'networkpolicy-pass-start')).toEqual([
      expect.objectContaining({ passId: 1 }),
    ])
    // vi.waitFor advances fake time while it polls, so measure from the pass.
    const startedAtMs: number = watcher.networkPolicyPassProgress.startedAtMs
    const advanceToElapsed = (ms: number) =>
      vi.advanceTimersByTimeAsync(startedAtMs + ms - Date.now())

    await advanceToElapsed(NETPOL_PASS_OVERRUN_WARN_MS)
    const overruns = events(logs, 'networkpolicy-pass-overrun')
    expect(overruns).toEqual([
      expect.objectContaining({
        passId: 1,
        causes: ['periodic-resync'],
        elapsedSeconds: NETPOL_PASS_OVERRUN_WARN_MS / 1000,
        hardLimitSeconds: HARD_LIMIT_MS / 1000,
        phase: 'context-revocation',
        pendingEffect: {
          kind: 'context',
          name: 'alpha',
          state: 'queued',
          seconds: NETPOL_PASS_OVERRUN_WARN_MS / 1000,
        },
      }),
    ])
    expect(await overrunCount('warn', 'context-revocation')).toBe(1)
    // The overrun mark above is the witness that the watchdog ran.
    expect(exitProcess).not.toHaveBeenCalled()

    await advanceToElapsed(HARD_LIMIT_MS - 1)
    expect(events(logs, 'networkpolicy-pass-overrun')).toHaveLength(5)
    expect(exitProcess).not.toHaveBeenCalled()

    await advanceToElapsed(HARD_LIMIT_MS)
    expect(events(logs, 'networkpolicy-pass-hard-limit')).toEqual([
      expect.objectContaining({
        passId: 1,
        elapsedSeconds: HARD_LIMIT_MS / 1000,
        phase: 'context-revocation',
        pendingEffect: expect.objectContaining({ kind: 'context', name: 'alpha', state: 'queued' }),
      }),
    ])
    expect(
      logs.some(
        entry => entry.level === 'error' && entry.fields?.event === 'networkpolicy-pass-hard-limit'
      )
    ).toBe(true)
    expect(await overrunCount('fatal', 'context-revocation')).toBe(1)
    expect(exitProcess).toHaveBeenCalledTimes(1)
    expect(exitProcess).toHaveBeenCalledWith(1)
  })

  it('ends the process through process.exit when no exit function is injected', async () => {
    await watcher.stop()
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    watcher = new McpServerWatcher() as unknown as Record<string, any>
    watcher.mcpServerCacheSynced = true
    watcher.contextCacheSynced = true
    watcher.hostCacheSynced = true
    watcher.contexts.set('alpha', alphaContext)
    const logs = captureLogs()
    holdAlphaContextQueue()
    void watcher.runInitialNetworkPolicyConvergence({ cause: 'periodic-resync' })
    await vi.waitFor(() => expect(mocks.listNamespacedNetworkPolicy).toHaveBeenCalled())
    const startedAtMs: number = watcher.networkPolicyPassProgress.startedAtMs

    await vi.advanceTimersByTimeAsync(startedAtMs + HARD_LIMIT_MS - Date.now())

    expect(events(logs, 'networkpolicy-pass-hard-limit')).toEqual([
      expect.objectContaining({ passId: 1, elapsedSeconds: HARD_LIMIT_MS / 1000 }),
    ])
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
    expect(exitProcess).not.toHaveBeenCalled()
  })

  it('disarms the bound when the pass finishes', async () => {
    const logs = captureLogs()
    await watcher.runInitialNetworkPolicyConvergence({ cause: 'periodic-resync' })
    // Witness: the pass ran to a result.
    expect(events(logs, 'networkpolicy-pass-result')).toEqual([
      expect.objectContaining({ passId: 1, result: 'certified' }),
    ])
    expect(watcher.networkPolicyPassWatchdog).toBeNull()

    await vi.advanceTimersByTimeAsync(HARD_LIMIT_MS + NETPOL_PASS_OVERRUN_WARN_MS)
    expect(events(logs, 'networkpolicy-pass-overrun')).toEqual([])
    expect(events(logs, 'networkpolicy-pass-hard-limit')).toEqual([])
    expect(exitProcess).not.toHaveBeenCalled()
  })

  it('reports a pending effect as running when the effect itself is the wait', async () => {
    const logs = captureLogs()
    // One stale context-allow for `alpha` (it allows a server the Context no
    // longer lists), so the pass must revoke it; that delete never answers.
    const staleAllow = {
      metadata: {
        name: 'ctx-alpha-ghost',
        namespace: 'mcp-server',
        uid: 'ghost-uid',
        resourceVersion: '7',
        labels: {
          'clerum.io/managed-by': 'host-context-controller',
          'clerum.io/policy-type': 'context-allow',
          'clerum.io/context': 'alpha',
          'clerum.io/mcpserver': 'ghost',
        },
      },
      spec: { podSelector: {}, policyTypes: ['Ingress'] },
    }
    mocks.listNamespacedNetworkPolicy.mockImplementation(
      async ({ namespace, labelSelector }: { namespace?: string; labelSelector?: string }) => ({
        items:
          namespace === 'mcp-server' && !(labelSelector ?? '').includes('external-egress')
            ? [staleAllow]
            : [],
      })
    )
    mocks.deleteNamespacedNetworkPolicy.mockImplementation(() => new Promise(() => {}))
    void watcher.runInitialNetworkPolicyConvergence({ cause: 'periodic-resync' })
    await vi.waitFor(() => expect(mocks.deleteNamespacedNetworkPolicy).toHaveBeenCalled())
    const startedAtMs: number = watcher.networkPolicyPassProgress.startedAtMs

    await vi.advanceTimersByTimeAsync(startedAtMs + NETPOL_PASS_OVERRUN_WARN_MS - Date.now())
    expect(events(logs, 'networkpolicy-pass-overrun')).toEqual([
      expect.objectContaining({
        passId: 1,
        phase: 'context-revocation',
        pendingEffect: expect.objectContaining({
          kind: 'context',
          name: 'alpha',
          state: 'running',
        }),
      }),
    ])
    expect(exitProcess).not.toHaveBeenCalled()
  })

  it('disarms the bound when the watcher stops during a pass', async () => {
    const logs = captureLogs()
    holdAlphaContextQueue()
    void watcher.runInitialNetworkPolicyConvergence({ cause: 'periodic-resync' })
    await vi.waitFor(() => expect(mocks.listNamespacedNetworkPolicy).toHaveBeenCalled())
    // Witness: the bound is armed for the running pass.
    expect(watcher.networkPolicyPassWatchdog).not.toBeNull()

    await watcher.stop()
    expect(watcher.networkPolicyPassWatchdog).toBeNull()

    await vi.advanceTimersByTimeAsync(HARD_LIMIT_MS + NETPOL_PASS_OVERRUN_WARN_MS)
    expect(events(logs, 'networkpolicy-pass-overrun')).toEqual([])
    expect(events(logs, 'networkpolicy-pass-hard-limit')).toEqual([])
    expect(exitProcess).not.toHaveBeenCalled()
  })

  it('reports every stage of an authoritative pass, in order', async () => {
    const phases: string[] = []
    await watcher.netPolReconciler.fullReconcile([alphaContext], [], {
      ensureDefaults: false,
      contextInventoryAuthoritative: () => true,
      serverInventoryAuthoritative: () => true,
      onAuthoritativeRevocationComplete: () => {},
      onPhase: (phase: string) => phases.push(phase),
    })
    expect(phases).toEqual([
      'inventory-list',
      'context-orphan-cleanup',
      'context-revocation',
      'server-orphan-cleanup',
      'server-revocation',
      'additive',
    ])
  })
})
