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
import { hccLogger } from './logger'
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
    k8sRequestTimeoutMs: 30_000,
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

type LogEntry = { level: 'info' | 'warn' | 'error'; message: string; fields: any }

function captureLogs(): LogEntry[] {
  const entries: LogEntry[] = []
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(hccLogger, level).mockImplementation((message: string, fields?: any) => {
      entries.push({ level, message, fields })
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
          key: 'alpha',
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
        pendingEffect: expect.objectContaining({ kind: 'context', key: 'alpha', state: 'queued' }),
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
})
