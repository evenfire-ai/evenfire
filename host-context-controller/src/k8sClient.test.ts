import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as http from 'http'
import { externalEgressResyncDelayMs } from './externalEgressConvergenceCoordinator'
import { HostFleetReconcileError } from './hostReconciler'
import { HostK8sRequestTimeoutError } from './k8s/hostK8sApiClient'
import {
  McpServerWatcher,
  createMcpAuthorizationStore,
  getContext,
  isMcpAuthorizationNotFound,
  listAllCommunicationChannels,
  listAllGlobalFileSystems,
  listAllHosts,
  listAllSharedFileSystems,
} from './k8sClient'
import { registry } from './metrics'
import { DESIRED_NETWORKPOLICY_INVENTORY_CHANGED_MESSAGE } from './networkPolicyReconciler'
import { ContextMapperServer } from './server'
import type { HostCRD, McpServerCRD } from './types'

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await Promise.resolve()
  }
}

async function readInitialConvergenceMetric(
  name:
    | 'clerum_hcc_initial_convergence_retries_total'
    | 'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
  lane: 'McpServer' | 'NetworkPolicy'
): Promise<number> {
  const metric = registry.getSingleMetric(name)
  if (!metric) throw new Error(`${name} is not registered`)
  const snapshot = await metric.get()
  return snapshot.values.find(entry => entry.labels.lane === lane)?.value ?? 0
}

async function readLabeledConvergenceMetric(
  name:
    | 'clerum_hcc_initial_convergence_swallowed_total'
    | 'clerum_hcc_initial_convergence_effects_dropped_total'
    | 'clerum_hcc_initial_convergence_pass_results_total',
  labels: Record<string, string>
): Promise<number> {
  const metric = registry.getSingleMetric(name)
  if (!metric) throw new Error(`${name} is not registered`)
  const snapshot = await metric.get()
  return (
    snapshot.values.find(entry =>
      Object.entries(labels).every(([key, value]) => entry.labels[key] === value)
    )?.value ?? 0
  )
}

async function requestHccHttpPath(
  server: ContextMapperServer,
  path: '/ready' | '/metrics'
): Promise<{
  statusCode: number | undefined
  body: string
}> {
  const listener = (server as unknown as { server: http.Server | null }).server
  const address = listener?.address()
  if (!address || typeof address === 'string') {
    throw new Error('HCC readiness listener did not bind a TCP port')
  }

  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: address.port, path }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        body += chunk
      })
      response.on('end', () => resolve({ statusCode: response.statusCode, body }))
    })
    request.once('error', reject)
  })
}

async function requestReadyOverHttp(server: ContextMapperServer): Promise<{
  statusCode: number | undefined
  body: string
}> {
  return requestHccHttpPath(server, '/ready')
}

async function requestMetricsOverHttp(server: ContextMapperServer): Promise<{
  statusCode: number | undefined
  body: string
}> {
  return requestHccHttpPath(server, '/metrics')
}

// Label order is not part of the Prometheus contract. Match each label
// independently so a scrape-path pin cannot pass on registry.get() and fail
// on the text GKE actually keys. Require the pair to end at ',' or '}' so a
// value cannot match as a prefix of a longer sibling (result="certified"
// must not hit result="certified-extra").
function promLabelPairPresent(labelPart: string, key: string, value: string): boolean {
  const needle = `${key}="${value}"`
  let from = 0
  while (from < labelPart.length) {
    const at = labelPart.indexOf(needle, from)
    if (at < 0) return false
    const after = labelPart[at + needle.length]
    if (after === ',' || after === '}' || after === undefined) return true
    from = at + 1
  }
  return false
}

function readPromTextMetric(text: string, name: string, labels: Record<string, string>): number {
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`)) continue
    const close = line.indexOf('}')
    if (close < 0) continue
    const labelPart = line.slice(name.length, close + 1)
    if (
      !Object.entries(labels).every(([key, value]) => promLabelPairPresent(labelPart, key, value))
    ) {
      continue
    }
    const value = Number(line.slice(close + 1).trim())
    return Number.isFinite(value) ? value : 0
  }
  return 0
}

describe('readPromTextMetric', () => {
  it('does not treat a label value as a prefix of another', () => {
    const text = [
      'clerum_hcc_initial_convergence_pass_results_total{lane="NetworkPolicy",result="certified-extra"} 9',
      'clerum_hcc_initial_convergence_pass_results_total{lane="NetworkPolicy",result="certified"} 3',
    ].join('\n')
    expect(
      readPromTextMetric(text, 'clerum_hcc_initial_convergence_pass_results_total', {
        lane: 'NetworkPolicy',
        result: 'certified',
      })
    ).toBe(3)
  })
})

function stubAuthoritativeInventoryWatch(
  watcher: McpServerWatcher,
  kind: 'McpServer' | 'Context',
  effect?: () => void | Promise<void>
) {
  const method = kind === 'McpServer' ? 'startMcpServerWatch' : 'startContextWatch'
  const generationField = kind === 'McpServer' ? 'mcpWatchGeneration' : 'contextWatchGeneration'
  const requestField = kind === 'McpServer' ? 'mcpWatchRequest' : 'ctxWatchRequest'
  return vi.spyOn(watcher as any, method).mockImplementation(async () => {
    const generation = ((watcher as any)[generationField] as number) + 1
    ;(watcher as any)[generationField] = generation
    ;(watcher as any)[requestField] = { abort: vi.fn() }
    await effect?.()
    return generation
  })
}

function markHostInventoryAuthoritative(watcher: McpServerWatcher): void {
  ;(watcher as any).hostCacheSynced = true
  ;(watcher as any).contextCacheSynced = true
}

function markMcpServerInventoryAuthoritative(watcher: McpServerWatcher): void {
  ;(watcher as any).mcpServerCacheSynced = true
}

function markNetworkPolicyRevocationAuthoritative(watcher: McpServerWatcher): void {
  ;(watcher as any).networkPolicyRevocationContextRevision = (watcher as any).contextDesiredRevision
  ;(watcher as any).networkPolicyRevocationServerRevision = (
    watcher as any
  ).mcpServerDesiredRevision
}

function seedNetworkPolicyPassInventory(watcher: McpServerWatcher): void {
  ;(watcher as any).contextCacheSynced = true
  ;(watcher as any).mcpServerCacheSynced = true
  ;(watcher as any).contextWatchGeneration = 11
  ;(watcher as any).mcpWatchGeneration = 13
  ;(watcher as any).contexts.set('stale-context', {
    name: 'stale-context',
    namespace: 'mcp-server',
    spec: { contextId: 'stale-context', mcpServers: ['stale-server'] },
  })
  ;(watcher as any).servers.set('stale-server', {
    name: 'stale-server',
    namespace: 'mcp-server',
    spec: {
      contextRef: 'stale-context',
      image: 'clerum/stale-server:v1',
      transport: { type: 'streamableHttp' as const, port: 3000 },
    },
  })
}

function newContextAuthoritativeWatcher(): McpServerWatcher {
  const watcher = new McpServerWatcher()
  ;(watcher as any).contextCacheSynced = true
  return watcher
}

const mocks = vi.hoisted(() => {
  const listNamespacedCustomObject = vi.fn()
  const getNamespacedCustomObject = vi
    .fn()
    .mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }))
  const readNamespacedSecret = vi.fn()
  const ensureDefaultPolicies = vi.fn().mockResolvedValue(undefined)
  const hasCertifiedSafetyInventory = vi.fn().mockReturnValue(true)
  const netPolFullReconcile = vi.fn().mockImplementation(async (...args: unknown[]) => {
    const options = args[2] as { onAuthoritativeRevocationComplete?: () => void } | undefined
    options?.onAuthoritativeRevocationComplete?.()
  })
  const serverFullReconcile = vi.fn().mockResolvedValue(undefined)
  const hostFullReconcile = vi.fn().mockResolvedValue(undefined)
  const hostReconcileHosts = vi.fn().mockResolvedValue(undefined)
  const sfsFullReconcile = vi.fn().mockResolvedValue(undefined)
  const watch = vi.fn().mockResolvedValue({ abort: vi.fn() })
  const hostListCallOptions = vi.fn()
  const sharedFileSystemListCallOptions = vi.fn()
  const createAdministrativeOutcomeReporter = vi.fn().mockReturnValue(undefined)
  return {
    hasCertifiedSafetyInventory,
    listNamespacedCustomObject,
    getNamespacedCustomObject,
    readNamespacedSecret,
    ensureDefaultPolicies,
    netPolFullReconcile,
    serverFullReconcile,
    hostFullReconcile,
    hostReconcileHosts,
    sfsFullReconcile,
    watch,
    hostListCallOptions,
    sharedFileSystemListCallOptions,
    createAdministrativeOutcomeReporter,
  }
})

// Kept at externalEgressResyncIntervalSec: 0 in every test (reset in afterEach):
// the external-egress periodic resync timer now lives in the convergence
// coordinator and is unit-tested in externalEgressConvergenceCoordinator.test.ts,
// so the k8sClient integration tests leave it disabled to avoid a stray timer.
const mockConfig = vi.hoisted(() => ({
  devMode: false,
  namespace: 'mcp-server',
  hostNamespace: 'mcp-host',
  rpcProxyNamespace: 'rpc-proxy',
  channelsNamespace: 'channels',
  port: 8081,
  runtimeNamespaces: ['mcp-server', 'mcp-host', 'sandbox-recipes', 'rpc-proxy'],
  hostK8sRequestTimeoutMs: 30_000,
  hostResyncIntervalSec: 0,
  externalEgressResyncIntervalSec: 0,
  externalEgressRefreshFloorSec: 5,
  controlApiBaseUrl: 'http://control-api.test:8090',
  governedTracingEnabled: false,
}))
vi.mock('./config', () => ({ config: mockConfig }))

vi.mock('./administrativeOutcomeReporter', () => ({
  createAdministrativeOutcomeReporter: mocks.createAdministrativeOutcomeReporter,
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
    makeApiClient(api: unknown): unknown {
      if (api === CustomObjectsApi) {
        return {
          getNamespacedCustomObject: mocks.getNamespacedCustomObject,
          listNamespacedCustomObject: async (request: { plural?: string }, options?: unknown) => {
            if (request.plural === 'hosts') mocks.hostListCallOptions(options)
            if (request.plural === 'sharedfilesystems')
              mocks.sharedFileSystemListCallOptions(options)
            const response = await mocks.listNamespacedCustomObject(request)
            if (
              request.plural &&
              ['hosts', 'mcpservers', 'contexts'].includes(request.plural) &&
              response &&
              typeof response === 'object' &&
              !('metadata' in response)
            ) {
              // Real Kubernetes collection LIST responses always include this
              // field. Preserve compact legacy fixtures without weakening the
              // production missing-resourceVersion failure path.
              return {
                ...response,
                metadata: {
                  resourceVersion:
                    request.plural === 'hosts'
                      ? 'test-host-collection-rv'
                      : `test-${request.plural}-collection-rv`,
                },
              }
            }
            return response
          },
        }
      }
      if (api === CoreV1Api) {
        return { readNamespacedSecret: mocks.readNamespacedSecret }
      }
      return {}
    }
  }
  return {
    KubeConfig,
    Watch,
    CustomObjectsApi,
    CoreV1Api,
    NetworkingV1Api,
    PolicyV1Api,
    AppsV1Api,
    BatchV1Api,
    RbacAuthorizationV1Api,
  }
})

vi.mock('./reconciler', () => ({
  McpServerReconciler: class {
    fullReconcile = mocks.serverFullReconcile
    reconcile = vi.fn()
    reconcileDelete = vi.fn()
    getStatus = vi.fn()
    setInventoryAuthority = vi.fn()
    setResolveCurrentServer = vi.fn()
  },
}))

vi.mock('./hostReconciler', () => ({
  HostFleetReconcileError: class HostFleetReconcileError extends AggregateError {
    constructor(
      readonly hostFailures: unknown[],
      readonly cleanupFailures: unknown[]
    ) {
      super([...hostFailures, ...cleanupFailures])
    }
  },
  HostReconciler: class {
    fullReconcile = mocks.hostFullReconcile
    reconcileHosts = mocks.hostReconcileHosts
    reconcile = vi.fn()
    reconcileDelete = vi.fn()
    setResolveContextMounts = vi.fn()
    // §10.4/§10.5 wiring: McpServerWatcher injects the live Host-cache resolver
    // and the watch-authority snapshot into HostReconciler at construction.
    setResolveCurrentHost = vi.fn()
    setHostWatchAuthority = vi.fn()
    setHostMutationAuthority = vi.fn()
    // H2: capture the injected uid-guarded cache reflector so Test C can invoke it.
    _reflectHostOutcomeFn:
      | ((name: string, uid: string | undefined, apply: (target: HostCRD) => void) => void)
      | null = null
    setReflectHostOutcome = vi.fn().mockImplementation(function (
      this: {
        _reflectHostOutcomeFn:
          | ((name: string, uid: string | undefined, apply: (target: HostCRD) => void) => void)
          | null
      },
      fn: (name: string, uid: string | undefined, apply: (target: HostCRD) => void) => void
    ) {
      this._reflectHostOutcomeFn = fn
    })
    _hostMutationDependenciesFn: ((host: HostCRD) => readonly unknown[]) | null = null
    setResolveHostMutationDependencies = vi.fn().mockImplementation(function (
      this: { _hostMutationDependenciesFn: ((host: HostCRD) => readonly unknown[]) | null },
      fn: (host: HostCRD) => readonly unknown[]
    ) {
      this._hostMutationDependenciesFn = fn
    })
    // Stores the injected callback so tests can invoke it directly.
    _countCommunicationChannelsFn: ((host: string) => number) | null = null
    setCountCommunicationChannels = vi.fn().mockImplementation(function (
      this: { _countCommunicationChannelsFn: ((host: string) => number) | null },
      fn: (host: string) => number
    ) {
      this._countCommunicationChannelsFn = fn
    })
    countCommunicationChannels = function (
      this: { _countCommunicationChannelsFn: ((host: string) => number) | null },
      host: string
    ) {
      return this._countCommunicationChannelsFn ? this._countCommunicationChannelsFn(host) : 0
    }
    setFindCommunicationChannelsByHostRef = vi.fn()
    setFindCommunicationChannelsByCredentialsSecretName = vi.fn()
    // B2: mock the CC cache-sync setter so McpServerWatcher constructor succeeds.
    setIsCommunicationChannelCacheSynced = vi.fn()
    patchChannelReaderRevisionAnnotation = vi.fn().mockResolvedValue(undefined)
    reconcileChannelReaderRevision = vi.fn().mockResolvedValue(undefined)
  },
}))

vi.mock('./networkPolicyReconciler', async () => {
  // Use the REAL safety-critical comparator (uid/generation-aware, canonicalized)
  // instead of a hand-rolled stand-in that diverged from prod semantics; only the
  // NetworkPolicyReconciler class is replaced with a test double.
  const actual = await vi.importActual<typeof import('./networkPolicyReconciler')>(
    './networkPolicyReconciler'
  )
  return {
    sameContextDesiredRevision: actual.sameContextDesiredRevision,
    DESIRED_NETWORKPOLICY_INVENTORY_CHANGED_MESSAGE:
      actual.DESIRED_NETWORKPOLICY_INVENTORY_CHANGED_MESSAGE,
    NetworkPolicyReconciler: class {
      ensureDefaultPolicies = mocks.ensureDefaultPolicies
      fullReconcile = mocks.netPolFullReconcile
      reconcileExternalEgress = vi.fn()
      reconcileContext = vi.fn()
      reconcileDeleteContext = vi.fn()
      cleanupExternalEgress = vi.fn()
      hasCertifiedSafetyInventory = mocks.hasCertifiedSafetyInventory
    },
  }
})

vi.mock('./bindingPolicyReconciler', () => ({
  BindingPolicyReconciler: class {
    reconcileBindings = vi.fn()
    cleanupBindings = vi.fn()
  },
}))

vi.mock('./sharedFileSystemReconciler', () => ({
  SharedFileSystemReconciler: class {
    fullReconcile = mocks.sfsFullReconcile
    reconcile = vi.fn()
    reconcileDelete = vi.fn()
    getStatus = vi.fn()
    setListContextRefs = vi.fn()
    isMountable = vi.fn().mockReturnValue(false)
  },
}))

beforeEach(() => {
  mocks.hostFullReconcile.mockReset().mockResolvedValue(undefined)
  mocks.hostReconcileHosts.mockReset().mockResolvedValue(undefined)
})

describe('MCP authorization store Kubernetes 404 normalization', () => {
  const provider = {
    getAllServerInfos: () => [],
  } as unknown as Parameters<typeof createMcpAuthorizationStore>[0]

  const restoreDefaultReadMocks = () => {
    mocks.getNamespacedCustomObject
      .mockReset()
      .mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }))
    mocks.readNamespacedSecret.mockReset()
  }

  beforeEach(() => {
    restoreDefaultReadMocks()
  })

  afterEach(() => {
    // These tests intentionally reset the shared Kubernetes read mocks. Restore
    // the normal 404 default so later watcher tests still model an absent
    // object instead of an accidentally resolved undefined response.
    restoreDefaultReadMocks()
  })

  it('treats ApiException.code=404 as absent for every CR authority read', async () => {
    mocks.getNamespacedCustomObject.mockRejectedValue({ code: 404 })
    const store = createMcpAuthorizationStore(provider)

    await expect(store.readHost('host-a')).resolves.toBeNull()
    await expect(store.readContext('context-a')).resolves.toBeNull()
    await expect(store.readMcpServer('server-a')).resolves.toBeNull()
  })

  it('treats ApiException.code=404 as absent for metadata and full Secret reads', async () => {
    mocks.readNamespacedSecret.mockRejectedValue({ code: 404 })
    const store = createMcpAuthorizationStore(provider)

    await expect(store.readSecretMetadata('server-token')).resolves.toBeNull()
    await expect(store.readSecret('server-token')).resolves.toBeNull()
  })

  it('projects only Secret identity metadata for inventory even when Kubernetes returns data', async () => {
    mocks.readNamespacedSecret.mockResolvedValue({
      metadata: {
        name: 'server-token',
        namespace: 'mcp-server',
        uid: 'secret-uid',
        resourceVersion: '42',
      },
      data: { token: 'credential-bytes-must-not-cross-this-boundary' },
    })
    const store = createMcpAuthorizationStore(provider)

    const metadata = await store.readSecretMetadata('server-token')
    expect(metadata).toEqual({
      name: 'server-token',
      namespace: 'mcp-server',
      metadata: { uid: 'secret-uid', resourceVersion: '42' },
    })
    expect(metadata).not.toHaveProperty('data')
    expect(JSON.stringify(metadata)).not.toContain('credential-bytes-must-not-cross-this-boundary')
  })

  it('projects successful Host, Context, and McpServer authority reads from live Kubernetes objects', async () => {
    const provider = {
      getAllServerInfos: () => [
        {
          name: 'server-a',
          status: { deployed: true, ready: true, authoritative: true },
        },
      ],
    } as unknown as Parameters<typeof createMcpAuthorizationStore>[0]
    const objects: Record<string, unknown> = {
      'hosts/host-a': {
        metadata: {
          name: 'host-a',
          namespace: 'mcp-host',
          uid: 'host-uid-a',
          resourceVersion: '11',
        },
        spec: { contextRef: 'context-a' },
      },
      'contexts/context-a': {
        metadata: {
          name: 'context-a',
          namespace: 'mcp-server',
          uid: 'context-uid-a',
          resourceVersion: '12',
        },
        spec: { mcpServers: ['server-a'] },
      },
      'mcpservers/server-a': {
        metadata: {
          name: 'server-a',
          namespace: 'mcp-server',
          uid: 'server-uid-a',
          resourceVersion: '13',
        },
        spec: {
          description: 'Server A',
          transport: { type: 'streamableHttp', url: 'http://server-a/mcp', port: 8080 },
          auth: { type: 'bearer', secretRef: 'server-a-auth', secretKey: 'token' },
          enabled: true,
        },
      },
    }
    mocks.getNamespacedCustomObject.mockImplementation(
      async ({ plural, name }: { plural: string; name: string }) => objects[`${plural}/${name}`]
    )

    const store = createMcpAuthorizationStore(provider)

    await expect(store.readHost('host-a')).resolves.toEqual({
      name: 'host-a',
      namespace: 'mcp-host',
      metadata: { uid: 'host-uid-a', resourceVersion: '11' },
      contextRef: 'context-a',
    })
    await expect(store.readContext('context-a')).resolves.toEqual({
      name: 'context-a',
      namespace: 'mcp-server',
      metadata: { uid: 'context-uid-a', resourceVersion: '12' },
      mcpServers: ['server-a'],
    })
    await expect(store.readMcpServer('server-a')).resolves.toEqual({
      name: 'server-a',
      namespace: 'mcp-server',
      metadata: { uid: 'server-uid-a', resourceVersion: '13' },
      description: 'Server A',
      transport: { type: 'streamableHttp', url: 'http://server-a/mcp', port: 8080 },
      auth: { type: 'bearer', secretRef: 'server-a-auth', secretKey: 'token' },
      enabled: true,
      status: { deployed: true, ready: true, authoritative: true },
    })
  })
})

describe('McpServerWatcher startup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.watch.mockReset().mockResolvedValue({ abort: vi.fn() })
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'mcpservers') return { items: [] }
      if (plural === 'contexts') return { items: [] }
      if (plural === 'hosts') return { items: [] }
      if (plural === 'sharedfilesystems') return { items: [] }
      if (plural === 'communicationchannels')
        return { metadata: { resourceVersion: '1' }, items: [] }
      return { items: [] }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    // Certified is the resting state. vi.clearAllMocks() in beforeEach clears
    // calls but not implementations, so a test that degrades this getter and
    // fails before its own restore would silently re-gate readiness for every
    // later test in the file. Restore it structurally rather than by
    // per-test discipline.
    mocks.hasCertifiedSafetyInventory.mockReset().mockReturnValue(true)
    mockConfig.externalEgressResyncIntervalSec = 0 // keep periodic resync off by default
    mocks.ensureDefaultPolicies.mockReset().mockResolvedValue(undefined)
    mocks.netPolFullReconcile.mockReset().mockImplementation(async (...args: unknown[]) => {
      const options = args[2] as { onAuthoritativeRevocationComplete?: () => void } | undefined
      options?.onAuthoritativeRevocationComplete?.()
    })
    mocks.serverFullReconcile.mockReset().mockResolvedValue(undefined)
    mocks.hostFullReconcile.mockReset().mockResolvedValue(undefined)
    mocks.sfsFullReconcile.mockReset().mockResolvedValue(undefined)
  })

  it('passes the governed tracing switch to the administrative reporter factory', () => {
    new McpServerWatcher()

    expect(mocks.createAdministrativeOutcomeReporter).toHaveBeenCalledWith(false, {
      baseUrl: 'http://control-api.test:8090',
    })
  })

  it('ensures baseline policies before opening any inventory watch', async () => {
    const watcher = new McpServerWatcher()

    await watcher.start()

    expect(mocks.ensureDefaultPolicies).toHaveBeenCalledTimes(1)
    expect(mocks.ensureDefaultPolicies.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.watch.mock.invocationCallOrder[0]
    )
    await vi.waitFor(() =>
      expect(mocks.serverFullReconcile).toHaveBeenCalledWith([], {
        runEffect: expect.any(Function),
      })
    )
    expect(mocks.hostFullReconcile).toHaveBeenCalledWith([])
    expect(mocks.sfsFullReconcile).toHaveBeenCalledWith([])
    await watcher.stop()
  })

  it('loads the SharedFileSystem inventory before scheduling the first Host fleet pass', async () => {
    const sharedFileSystemsListed = deferred<{ items: unknown[] }>()
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'sharedfilesystems') return sharedFileSystemsListed.promise
      if (plural === 'communicationchannels') {
        return { metadata: { resourceVersion: 'sfs-ordering-cc-rv' }, items: [] }
      }
      return { items: [] }
    })
    const watcher = new McpServerWatcher()
    // Sampling "not yet called" after a fixed number of microtask turns cannot
    // distinguish "correctly waiting" from "scheduled but not drained yet".
    // Record what the first pass actually observed instead: the invariant is
    // that it never runs against an unpopulated SharedFileSystem cache, because
    // that is what writes mount-less templates and rerolls the fleet.
    let sfsCacheSizeAtFirstPass: number | undefined
    mocks.hostFullReconcile.mockImplementation(async () => {
      if (sfsCacheSizeAtFirstPass === undefined) {
        sfsCacheSizeAtFirstPass = (watcher as any).sharedFileSystems.size
      }
    })
    const start = watcher.start()

    try {
      // Await the whole startup first. That is the positive signal that the
      // cold-start Host recovery already reached the point where it decides
      // whether to schedule the fleet pass, so the absence assertion below
      // cannot pass merely because nothing has been drained yet.
      await start
      await flushMicrotasks()
      expect(mocks.hostFullReconcile).not.toHaveBeenCalled()

      sharedFileSystemsListed.resolve({
        items: [{ metadata: { name: 'initial-sfs', namespace: 'mcp-host' }, spec: {} }],
      })
      await vi.waitFor(() => expect(mocks.hostFullReconcile).toHaveBeenCalledOnce())
      expect(sfsCacheSizeAtFirstPass).toBe(1)
      expect((watcher as any).sharedFileSystems.get('initial-sfs')).toEqual(
        expect.objectContaining({ name: 'initial-sfs' })
      )
    } finally {
      sharedFileSystemsListed.resolve({ items: [] })
      await start.catch(() => undefined)
      await watcher.stop()
    }
  })

  it('lists the SharedFileSystem inventory through the deadline-bearing client', async () => {
    // The cold-start Host fleet pass waits on this inventory. Bounding the wait
    // is not enough: an unbounded request stays hung, so the socket leaks and
    // `startSharedFileSystemWatch()` — which runs after this await — never
    // starts. Only the deadline-bearing client aborts the request itself, and
    // it is observable because it appends its deadline middleware to the call.
    mocks.listNamespacedCustomObject.mockResolvedValue({ items: [] })

    await listAllSharedFileSystems()

    expect(mocks.sharedFileSystemListCallOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        middleware: [expect.objectContaining({ pre: expect.any(Function) })],
        middlewareMergeStrategy: 'append',
      })
    )
  })

  it('schedules the first Host fleet pass when the SharedFileSystem watch never starts', async () => {
    // `k8s.Watch` carries no transport deadline — client-node overwrites its own
    // AbortSignal.timeout with a bare controller signal — so awaiting the watch
    // start inside the inventory promise re-strands the cold-start fleet pass
    // that bounding the LIST was meant to protect.
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'communicationchannels') {
        return { metadata: { resourceVersion: 'sfs-watch-stall-cc-rv' }, items: [] }
      }
      return { items: [] }
    })
    mocks.watch.mockImplementation(async (path: string) => {
      if (path.endsWith('/sharedfilesystems')) return new Promise(() => undefined)
      return { abort: vi.fn() }
    })
    const watcher = new McpServerWatcher()
    const start = watcher.start()

    try {
      await start
      await vi.waitFor(() => expect(mocks.hostFullReconcile).toHaveBeenCalledOnce())
    } finally {
      await watcher.stop()
      await start.catch(() => undefined)
    }
  })

  it('schedules the first Host fleet pass when the SharedFileSystem inventory fails', async () => {
    // The inventory LIST runs on the deadline-bearing client, so an apiserver
    // that never answers is aborted and surfaces here as a rejection. The Host
    // fleet must still converge: stranding it would leave every Host
    // unreconciled behind an already-certified readiness.
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'sharedfilesystems') throw new Error('sharedfilesystems LIST aborted')
      if (plural === 'communicationchannels') {
        return { metadata: { resourceVersion: 'sfs-abort-cc-rv' }, items: [] }
      }
      return { items: [] }
    })
    const watcher = new McpServerWatcher()
    const start = watcher.start()

    try {
      await start
      await vi.waitFor(() => expect(mocks.hostFullReconcile).toHaveBeenCalledOnce())
    } finally {
      await watcher.stop()
      await start.catch(() => undefined)
    }
  })

  it('retains Context uid and generation from the authoritative initial snapshot', async () => {
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'contexts') {
        return {
          items: [
            {
              metadata: {
                name: 'identity-context',
                namespace: 'mcp-server',
                uid: 'context-uid-1',
                generation: 7,
              },
              spec: { contextId: 'identity-context', mcpServers: [] },
            },
          ],
        }
      }
      if (plural === 'communicationchannels') {
        return { metadata: { resourceVersion: 'context-identity-cc-rv' }, items: [] }
      }
      return { items: [] }
    })
    const watcher = new McpServerWatcher()

    try {
      await watcher.start()
      expect((watcher as any).contexts.get('identity-context')).toEqual(
        expect.objectContaining({ uid: 'context-uid-1', generation: 7 })
      )
    } finally {
      await watcher.stop()
    }
  })

  it('fails safe bootstrap and keeps readiness unavailable when baseline NetworkPolicies fail', async () => {
    const policyError = new Error('baseline NetworkPolicies unavailable')
    mocks.ensureDefaultPolicies.mockRejectedValueOnce(policyError)
    const watcher = new McpServerWatcher()
    const server = new ContextMapperServer(watcher, 0)
    await server.start()
    const bootstrap = watcher.start().then(() => server.setReady(true))

    try {
      await expect(bootstrap).rejects.toThrow(policyError)
      const ready = await requestReadyOverHttp(server)
      expect(ready.statusCode).toBe(503)
      expect(JSON.parse(ready.body)).toEqual({ status: 'starting', ready: false })
      expect(mocks.watch).not.toHaveBeenCalled()
      expect(mocks.serverFullReconcile).not.toHaveBeenCalled()
      expect(mocks.netPolFullReconcile).not.toHaveBeenCalled()
    } finally {
      await server.stop()
      await watcher.stop()
    }
  })

  it.each(['LIST', 'WATCH'] as const)(
    'stays live and recovers readiness after a transient Host %s bootstrap failure',
    async failureBoundary => {
      vi.useFakeTimers()
      let hostListAttempts = 0
      let hostWatchAttempts = 0
      mocks.listNamespacedCustomObject.mockImplementation(
        async ({ plural }: { plural: string }) => {
          if (plural === 'hosts') {
            hostListAttempts += 1
            if (failureBoundary === 'LIST' && hostListAttempts === 1) {
              throw new Error('host discovery temporarily unavailable')
            }
            return { metadata: { resourceVersion: 'host-recovery-rv' }, items: [] }
          }
          if (plural === 'communicationchannels') {
            return { metadata: { resourceVersion: 'cc-rv' }, items: [] }
          }
          return { items: [] }
        }
      )
      mocks.watch.mockImplementation(async path => {
        if (path.endsWith('/hosts')) {
          hostWatchAttempts += 1
          if (failureBoundary === 'WATCH' && hostWatchAttempts === 1) {
            throw new Error('host watch temporarily unavailable')
          }
        }
        return { abort: vi.fn() }
      })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const watcher = new McpServerWatcher()
      stubAuthoritativeInventoryWatch(watcher, 'McpServer')
      stubAuthoritativeInventoryWatch(watcher, 'Context')
      vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockResolvedValue(undefined)
      vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockResolvedValue(undefined)
      const server = new ContextMapperServer(watcher, 0, undefined, undefined, () =>
        watcher.isReadinessInventoryAuthoritative()
      )
      await server.start()

      try {
        await expect(watcher.start()).resolves.toBeUndefined()
        server.setReady(true)

        expect(watcher.isReadinessInventoryAuthoritative()).toBe(false)
        expect((await requestReadyOverHttp(server)).statusCode).toBe(503)
        await vi.waitFor(() => expect(mocks.serverFullReconcile).toHaveBeenCalledOnce())
        await vi.waitFor(() => expect(mocks.netPolFullReconcile).toHaveBeenCalledOnce())
        expect((watcher as any).hostCacheRecoveryTimer).not.toBeNull()

        await vi.advanceTimersByTimeAsync(5000)
        await vi.waitFor(() => expect(watcher.isReadinessInventoryAuthoritative()).toBe(true))
        await vi.waitFor(() => expect(mocks.hostFullReconcile).toHaveBeenCalledOnce())

        expect(hostListAttempts).toBe(2)
        expect(hostWatchAttempts).toBe(failureBoundary === 'LIST' ? 1 : 2)
        expect((watcher as any).ccAppliedLifecycleGeneration).toBe(1)
        expect((await requestReadyOverHttp(server)).statusCode).toBe(200)
      } finally {
        await server.stop()
        await watcher.stop()
        errorSpy.mockRestore()
        warnSpy.mockRestore()
      }
    }
  )

  it.each(['LIST', 'WATCH'] as const)(
    'stays live and recovers readiness after a transient McpServer %s bootstrap failure',
    async failureBoundary => {
      vi.useFakeTimers()
      let mcpServerListAttempts = 0
      let mcpServerWatchAttempts = 0
      mocks.listNamespacedCustomObject.mockImplementation(
        async ({ plural }: { plural: string }) => {
          if (plural === 'mcpservers') {
            mcpServerListAttempts += 1
            if (failureBoundary === 'LIST' && mcpServerListAttempts === 1) {
              throw new Error('mcpserver discovery temporarily unavailable')
            }
            return { metadata: { resourceVersion: 'mcpserver-recovery-rv' }, items: [] }
          }
          if (plural === 'hosts') {
            return { metadata: { resourceVersion: 'host-rv' }, items: [] }
          }
          if (plural === 'communicationchannels') {
            return { metadata: { resourceVersion: 'cc-rv' }, items: [] }
          }
          return { items: [] }
        }
      )
      mocks.watch.mockImplementation(async path => {
        if (path.endsWith('/mcpservers')) {
          mcpServerWatchAttempts += 1
          if (failureBoundary === 'WATCH' && mcpServerWatchAttempts === 1) {
            throw new Error('mcpserver watch temporarily unavailable')
          }
        }
        return { abort: vi.fn() }
      })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const watcher = new McpServerWatcher()
      // The McpServer lane runs for real (LIST + WATCH) so its bootstrap
      // failure and recovery exercise production code. Context stays
      // authoritative so readiness can be promoted once the lane recovers.
      stubAuthoritativeInventoryWatch(watcher, 'Context')
      vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockResolvedValue(undefined)
      vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockResolvedValue(undefined)
      const server = new ContextMapperServer(watcher, 0, undefined, undefined, () =>
        watcher.isReadinessInventoryAuthoritative()
      )
      await server.start()

      try {
        await expect(watcher.start()).resolves.toBeUndefined()
        server.setReady(true)

        expect(watcher.isReadinessInventoryAuthoritative()).toBe(false)
        expect((await requestReadyOverHttp(server)).statusCode).toBe(503)
        expect((watcher as any).mcpServerCacheRecoveryTimer).not.toBeNull()

        await vi.advanceTimersByTimeAsync(5000)
        await vi.waitFor(() => expect(watcher.isReadinessInventoryAuthoritative()).toBe(true))
        await vi.waitFor(() => expect(mocks.netPolFullReconcile).toHaveBeenCalled())

        expect(mcpServerListAttempts).toBe(2)
        expect(mcpServerWatchAttempts).toBe(failureBoundary === 'LIST' ? 1 : 2)
        expect((await requestReadyOverHttp(server)).statusCode).toBe(200)
      } finally {
        await server.stop()
        await watcher.stop()
        errorSpy.mockRestore()
        warnSpy.mockRestore()
      }
    }
  )

  it.each(['LIST', 'WATCH'] as const)(
    'stays live and recovers readiness after a transient Context %s bootstrap failure',
    async failureBoundary => {
      vi.useFakeTimers()
      let contextListAttempts = 0
      let contextWatchAttempts = 0
      mocks.listNamespacedCustomObject.mockImplementation(
        async ({ plural }: { plural: string }) => {
          if (plural === 'contexts') {
            contextListAttempts += 1
            if (failureBoundary === 'LIST' && contextListAttempts === 1) {
              throw new Error('context discovery temporarily unavailable')
            }
            return { metadata: { resourceVersion: 'context-recovery-rv' }, items: [] }
          }
          if (plural === 'hosts') {
            return { metadata: { resourceVersion: 'host-rv' }, items: [] }
          }
          if (plural === 'communicationchannels') {
            return { metadata: { resourceVersion: 'cc-rv' }, items: [] }
          }
          return { items: [] }
        }
      )
      mocks.watch.mockImplementation(async path => {
        if (path.endsWith('/contexts')) {
          contextWatchAttempts += 1
          if (failureBoundary === 'WATCH' && contextWatchAttempts === 1) {
            throw new Error('context watch temporarily unavailable')
          }
        }
        return { abort: vi.fn() }
      })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const watcher = new McpServerWatcher()
      // The Context lane runs for real (LIST + WATCH) so its bootstrap
      // failure and recovery exercise production code. McpServer stays
      // authoritative so readiness can be promoted once the lane recovers.
      stubAuthoritativeInventoryWatch(watcher, 'McpServer')
      vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockResolvedValue(undefined)
      vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockResolvedValue(undefined)
      const server = new ContextMapperServer(watcher, 0, undefined, undefined, () =>
        watcher.isReadinessInventoryAuthoritative()
      )
      await server.start()

      try {
        await expect(watcher.start()).resolves.toBeUndefined()
        server.setReady(true)

        expect(watcher.isReadinessInventoryAuthoritative()).toBe(false)
        expect((await requestReadyOverHttp(server)).statusCode).toBe(503)
        expect((watcher as any).contextCacheRecoveryTimer).not.toBeNull()

        await vi.advanceTimersByTimeAsync(5000)
        await vi.waitFor(() => expect(watcher.isReadinessInventoryAuthoritative()).toBe(true))
        await vi.waitFor(() => expect(mocks.netPolFullReconcile).toHaveBeenCalled())

        expect(contextListAttempts).toBe(2)
        expect(contextWatchAttempts).toBe(failureBoundary === 'LIST' ? 1 : 2)
        expect((await requestReadyOverHttp(server)).statusCode).toBe(200)
      } finally {
        await server.stop()
        await watcher.stop()
        errorSpy.mockRestore()
        warnSpy.mockRestore()
      }
    }
  )

  it('cancels a pending Host bootstrap recovery when the watcher stops', async () => {
    vi.useFakeTimers()
    let hostListAttempts = 0
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') {
        hostListAttempts += 1
        throw new Error('host inventory remains unavailable')
      }
      if (plural === 'communicationchannels') {
        return { metadata: { resourceVersion: 'cc-rv' }, items: [] }
      }
      return { items: [] }
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const watcher = new McpServerWatcher()
    stubAuthoritativeInventoryWatch(watcher, 'McpServer')
    stubAuthoritativeInventoryWatch(watcher, 'Context')
    vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockResolvedValue(undefined)

    try {
      await watcher.start()
      expect((watcher as any).hostCacheRecoveryTimer).not.toBeNull()

      await watcher.stop()
      await vi.advanceTimersByTimeAsync(5000)

      expect(hostListAttempts).toBe(1)
      expect((watcher as any).hostCacheRecoveryTimer).toBeNull()
      expect((watcher as any).hostCacheRecoveryIntent).toBeNull()
    } finally {
      await watcher.stop()
      errorSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('defers every Host-dependent effect while a bootstrap LIST lacks WATCH authority', async () => {
    vi.useFakeTimers()
    const staleHost = {
      metadata: {
        name: 'stale-bootstrap-host',
        namespace: 'mcp-host',
        generation: 1,
        uid: 'stale-bootstrap-host-uid',
      },
      spec: {
        host: 'stale-bootstrap-host',
        contextRef: 'bootstrap-context',
        secretRef: 'bootstrap-secret',
        model: { provider: 'openai', name: 'gpt-4o-mini' },
      },
    }
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') {
        return {
          metadata: { resourceVersion: 'stale-bootstrap-rv' },
          items: [staleHost],
        }
      }
      if (plural === 'communicationchannels') {
        return { metadata: { resourceVersion: 'cc-rv' }, items: [] }
      }
      return { items: [] }
    })
    mocks.watch.mockImplementation(async path => {
      if (path.endsWith('/hosts')) {
        throw new Error('host watch remains unavailable')
      }
      return { abort: vi.fn() }
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const watcher = new McpServerWatcher()
    stubAuthoritativeInventoryWatch(watcher, 'McpServer')
    stubAuthoritativeInventoryWatch(watcher, 'Context')
    vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockResolvedValue(undefined)
    const hostReconciler = (watcher as any).hostReconciler

    try {
      await watcher.start()
      expect(watcher.isReadinessInventoryAuthoritative()).toBe(false)

      expect(watcher.getHost('stale-bootstrap-host')).toBeUndefined()
      const ccWatchCallback = (watcher as any).getCommunicationChannelWatchCallback()
      await ccWatchCallback('ADDED', {
        metadata: { name: 'bootstrap-channel', namespace: 'channels' },
        spec: { hostRef: 'stale-bootstrap-host' },
      })
      ;(watcher as any).contexts.set('bootstrap-context', {
        name: 'bootstrap-context',
        namespace: 'mcp-server',
        spec: {
          contextId: 'bootstrap-context',
          sharedFileSystems: [{ name: 'bootstrap-sfs', mountPath: '/shared' }],
        },
      })
      await (watcher as any).reconcileHostsReferencingSfs('bootstrap-sfs')
      await (watcher as any).reconcileHostsReferencingContext('bootstrap-context')
      ;(watcher as any).ccCacheSynced = false
      await (watcher as any).reconcileChannelReaderRevision('bootstrap-channel-secret', 'channels')

      expect(hostReconciler.reconcile).not.toHaveBeenCalled()
      expect(hostReconciler.patchChannelReaderRevisionAnnotation).not.toHaveBeenCalled()
      expect(hostReconciler.reconcileChannelReaderRevision).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(
        '[K8s] Deferring CommunicationChannel Secret "channels/bootstrap-channel-secret" Host convergence; CommunicationChannel cache is not authoritative'
      )
      expect((watcher as any).hostCacheRecoveryTimer).not.toBeNull()
    } finally {
      await watcher.stop()
      errorSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('defers Host fleet convergence until both Host and Context inventories are authoritative', async () => {
    const watcher = new McpServerWatcher()
    ;(watcher as any).hostCacheSynced = true
    ;(watcher as any).contextCacheSynced = false
    ;(watcher as any).hosts.set('context-dependent-host', {
      name: 'context-dependent-host',
      namespace: 'mcp-host',
      spec: {
        host: 'context-dependent-host',
        contextRef: 'current-context',
        secretRef: 'host-secret',
      },
    })

    await (watcher as any).performHostFleetReconcileOnce({
      reason: 'Context authority test',
      mode: 'full',
    })

    expect(mocks.hostFullReconcile).not.toHaveBeenCalled()
    ;(watcher as any).contextCacheSynced = true
    await (watcher as any).performHostFleetReconcileOnce({
      reason: 'Context authority recovered',
      mode: 'full',
    })

    expect(mocks.hostFullReconcile).toHaveBeenCalledOnce()
    expect(mocks.hostFullReconcile).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'context-dependent-host' }),
    ])
    await watcher.stop()
  })

  it('applies a pending CommunicationChannel lifecycle generation during Context recovery', async () => {
    const watcher = new McpServerWatcher()
    ;(watcher as any).hostCacheSynced = true
    ;(watcher as any).contextCacheSynced = false
    const pendingGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()

    await (watcher as any).recoverContextInventoryAndWatch()
    await vi.waitFor(() => expect(mocks.hostFullReconcile).toHaveBeenCalledOnce())

    expect((watcher as any).ccAppliedLifecycleGeneration).toBe(pendingGeneration)
    await watcher.stop()
  })

  it('starts McpServer and Context watches from their inventory resourceVersions', async () => {
    const watcher = new McpServerWatcher()

    await (watcher as any).startMcpServerWatch('mcp-inventory-rv')
    await (watcher as any).startContextWatch('context-inventory-rv')

    expect(mocks.watch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/mcpservers'),
      { resourceVersion: 'mcp-inventory-rv' },
      expect.any(Function),
      expect.any(Function)
    )
    expect(mocks.watch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/contexts'),
      { resourceVersion: 'context-inventory-rv' },
      expect.any(Function),
      expect.any(Function)
    )
    watcher.stop()
  })

  it.each([
    ['Context', 'startContextWatch', 'contextWatchGeneration'],
    ['Host', 'startHostWatch', 'hostWatchGeneration'],
  ] as const)(
    'assigns a fresh generation to every replacement %s watch',
    async (_kind, method, generationField) => {
      const watcher = new McpServerWatcher()
      const before = (watcher as any)[generationField] as number

      const first = await (watcher as any)[method]('first-rv')
      const second = await (watcher as any)[method]('second-rv')

      expect(first).toBe(before + 1)
      expect(second).toBe(before + 2)
      expect((watcher as any)[generationField]).toBe(before + 2)
      await watcher.stop()
    }
  )

  it.each([
    [
      'McpServer',
      'restartMcpServerWatch',
      'startMcpServerWatch',
      'mcpWatchGeneration',
      'mcpServerCacheSynced',
      { resourceVersion: 'mcp-rv', servers: [] },
    ],
    [
      'Context',
      'restartContextWatch',
      'startContextWatch',
      'contextWatchGeneration',
      'contextCacheSynced',
      { resourceVersion: 'context-rv', contexts: [] },
    ],
  ] as const)(
    'rejects a %s LIST snapshot that is not paired with a live watch request',
    async (_kind, restartMethod, startMethod, generationField, cacheField, snapshot) => {
      const watcher = new McpServerWatcher()
      vi.spyOn(watcher as any, startMethod).mockImplementation(async () => {
        ;(watcher as any)[generationField] += 1
        return (watcher as any)[generationField]
      })

      await expect((watcher as any)[restartMethod](snapshot)).rejects.toThrow(
        'snapshot could not be paired with an active watch'
      )
      expect((watcher as any)[cacheField]).toBe(false)
      await watcher.stop()
    }
  )

  it.each([
    ['McpServer', 'mcpservers', 'mcpServerCacheRecoveryTimer'],
    ['Context', 'contexts', 'contextCacheRecoveryTimer'],
  ] as const)(
    'stays live and arms in-process recovery when the %s inventory LIST is unavailable',
    async (kind, failingPlural, recoveryTimerField) => {
      mocks.listNamespacedCustomObject.mockImplementation(
        async ({ plural }: { plural: string }) => {
          if (plural === failingPlural) throw new Error(`${plural} inventory unavailable`)
          if (plural === 'communicationchannels') {
            return { metadata: { resourceVersion: 'cc-rv' }, items: [] }
          }
          return { items: [] }
        }
      )
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const watcher = new McpServerWatcher()

      try {
        await expect(watcher.start()).resolves.toBeUndefined()

        expect(errorSpy).toHaveBeenCalledWith(
          `[K8s] Initial ${kind} inventory is unavailable; HCC remains unready while in-process recovery continues:`,
          expect.objectContaining({ message: `${failingPlural} inventory unavailable` })
        )
        expect(watcher.isReadinessInventoryAuthoritative()).toBe(false)
        expect((watcher as any)[recoveryTimerField]).not.toBeNull()
        expect(mocks.serverFullReconcile).not.toHaveBeenCalled()
        expect(mocks.netPolFullReconcile).not.toHaveBeenCalled()
      } finally {
        await watcher.stop()
        errorSpy.mockRestore()
        warnSpy.mockRestore()
      }
    }
  )

  it.each([
    ['McpServer', 'mcpservers', 'mcpServerCacheRecoveryTimer'],
    ['Context', 'contexts', 'contextCacheRecoveryTimer'],
  ] as const)(
    'stays live and arms in-process recovery when the %s collection resourceVersion is missing',
    async (kind, missingPlural, recoveryTimerField) => {
      mocks.listNamespacedCustomObject.mockImplementation(
        async ({ plural }: { plural: string }) => {
          if (plural === missingPlural) return { metadata: {}, items: [] }
          if (plural === 'communicationchannels') {
            return { metadata: { resourceVersion: 'cc-rv' }, items: [] }
          }
          return { items: [] }
        }
      )
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const watcher = new McpServerWatcher()

      try {
        await expect(watcher.start()).resolves.toBeUndefined()

        expect(errorSpy).toHaveBeenCalledWith(
          `[K8s] Initial ${kind} inventory is unavailable; HCC remains unready while in-process recovery continues:`,
          expect.objectContaining({ message: `${kind} snapshot missing resourceVersion` })
        )
        expect(watcher.isReadinessInventoryAuthoritative()).toBe(false)
        expect((watcher as any)[recoveryTimerField]).not.toBeNull()
        expect(mocks.serverFullReconcile).not.toHaveBeenCalled()
        expect(mocks.netPolFullReconcile).not.toHaveBeenCalled()
      } finally {
        await watcher.stop()
        errorSpy.mockRestore()
        warnSpy.mockRestore()
      }
    }
  )

  it('replays McpServer and Context changes from the inventory resourceVersion before convergence', async () => {
    const staleServer = {
      metadata: {
        name: 'gap-server',
        namespace: 'mcp-server',
        uid: 'gap-server-uid',
        generation: 1,
      },
      spec: {
        contextRef: 'default',
        image: 'clerum/gap-server:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
      },
    }
    const staleContext = {
      metadata: { name: 'gap-context', namespace: 'mcp-server' },
      spec: { contextId: 'gap-context', mcpServers: [] },
    }
    const currentContext = {
      metadata: { name: 'gap-context', namespace: 'mcp-server' },
      spec: { contextId: 'gap-context', mcpServers: ['current-server'] },
    }
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'mcpservers') {
        return { metadata: { resourceVersion: 'opaque/mcp:101' }, items: [staleServer] }
      }
      if (plural === 'contexts') {
        return { metadata: { resourceVersion: 'opaque/context:202' }, items: [staleContext] }
      }
      if (plural === 'communicationchannels') {
        return { metadata: { resourceVersion: 'cc-rv' }, items: [] }
      }
      return { items: [] }
    })
    mocks.watch.mockImplementation(async (path, options, callback) => {
      if (path.endsWith('/mcpservers')) {
        expect(options).toEqual({ resourceVersion: 'opaque/mcp:101' })
        await callback('DELETED', staleServer)
      }
      if (path.endsWith('/contexts')) {
        expect(options).toEqual({ resourceVersion: 'opaque/context:202' })
        await callback('MODIFIED', currentContext)
      }
      return { abort: vi.fn() }
    })
    const watcher = new McpServerWatcher()

    await watcher.start()

    await vi.waitFor(() => {
      expect(mocks.serverFullReconcile).toHaveBeenCalledWith([], {
        runEffect: expect.any(Function),
      })
      expect(mocks.netPolFullReconcile).toHaveBeenCalledWith(
        [expect.objectContaining({ spec: currentContext.spec })],
        [],
        expect.objectContaining({
          serverInventoryComplete: true,
          ensureDefaults: false,
          contextInventoryAuthoritative: expect.any(Function),
          serverInventoryAuthoritative: expect.any(Function),
          contextDesiredRevision: expect.any(Function),
          serverDesiredRevision: expect.any(Function),
        })
      )
    })
    expect(watcher.getAllServers()).toEqual([])
    await watcher.stop()
  })

  it('recovers a closed McpServer watch through a fresh authoritative snapshot', async () => {
    vi.useFakeTimers()
    const callbacks: Array<(type: string, apiObj: any) => Promise<void>> = []
    const doneCallbacks: Array<(error: Error | null) => void> = []
    const watchQueries: unknown[] = []
    mocks.watch.mockImplementation(async (path, options, callback, done) => {
      if (path.endsWith('/mcpservers')) {
        callbacks.push(callback)
        doneCallbacks.push(done)
        watchQueries.push(options)
      }
      return { abort: vi.fn() }
    })
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'mcpservers') {
        return {
          metadata: { resourceVersion: 'mcp-recovery-rv' },
          items: [
            {
              metadata: {
                name: 'recovered-server',
                namespace: 'mcp-server',
                uid: 'recovered-uid',
                generation: 1,
              },
              spec: {
                contextRef: 'default',
                image: 'clerum/recovered:test',
                transport: { type: 'streamableHttp' as const, port: 3000 },
              },
            },
          ],
        }
      }
      return { items: [] }
    })
    const watcher = new McpServerWatcher()
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).hostCacheSynced = true
    await (watcher as any).restartMcpServerWatch({
      resourceVersion: 'mcp-start-rv',
      servers: [],
    })
    markNetworkPolicyRevocationAuthoritative(watcher)
    expect(watcher.isReadinessInventoryAuthoritative()).toBe(true)

    doneCallbacks[0](Object.assign(new Error('resource version expired'), { statusCode: 410 }))
    expect(watcher.isReadinessInventoryAuthoritative()).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    await vi.waitFor(() => expect(watchQueries).toHaveLength(2))

    expect(watchQueries).toEqual([
      { resourceVersion: 'mcp-start-rv' },
      { resourceVersion: 'mcp-recovery-rv' },
    ])
    expect(watcher.getAllServers()).toEqual([expect.objectContaining({ name: 'recovered-server' })])
    expect(callbacks).toHaveLength(2)
    expect(watcher.isReadinessInventoryAuthoritative()).toBe(true)
    await watcher.stop()
    expect(watcher.isReadinessInventoryAuthoritative()).toBe(false)
  })

  it('withdraws readiness when the safety pass leaves its inventory uncertified', async () => {
    // Losing a delete fence is the one doom cause that bumps no watch
    // generation and moves no desired revision, so every equality below stays
    // satisfied while an allow this pass classified as stale is still live.
    // The reconciler already degrades its fence at the point of loss; readiness
    // has to read it, or /ready keeps answering 200 over that allow until a
    // retry lands (>=5s, and indefinitely against a persistent second writer —
    // e.g. the two-replica overlap every rolling update opens, since the
    // Deployment carries no leader election).
    const watcher = newContextAuthoritativeWatcher()
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).hostCacheSynced = true
    markNetworkPolicyRevocationAuthoritative(watcher)
    expect(watcher.isReadinessInventoryAuthoritative()).toBe(true)

    try {
      mocks.hasCertifiedSafetyInventory.mockReturnValue(false)

      expect(watcher.isReadinessInventoryAuthoritative()).toBe(false)
    } finally {
      // vi.clearAllMocks() clears calls, not implementations, so an escaped
      // mockReturnValue would silently re-gate every later test in this file.
      mocks.hasCertifiedSafetyInventory.mockReturnValue(true)
    }
  })

  it('restores readiness once a later safety pass certifies its inventory again', async () => {
    // The withdrawal above must not be a one-way latch: a fence raised by a
    // transient loss has to clear on the next completed pass, or the retry
    // machinery would leave the controller permanently unready.
    const watcher = newContextAuthoritativeWatcher()
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).hostCacheSynced = true
    markNetworkPolicyRevocationAuthoritative(watcher)
    try {
      mocks.hasCertifiedSafetyInventory.mockReturnValue(false)
      expect(watcher.isReadinessInventoryAuthoritative()).toBe(false)

      mocks.hasCertifiedSafetyInventory.mockReturnValue(true)

      expect(watcher.isReadinessInventoryAuthoritative()).toBe(true)
    } finally {
      // An assertion failure above must not escape a false implementation into
      // the rest of the file — vi.clearAllMocks() would not undo it.
      mocks.hasCertifiedSafetyInventory.mockReturnValue(true)
    }
  })

  it('keeps getReadinessInventoryDetail aligned with isReadinessInventoryAuthoritative one gate at a time', () => {
    const watcher = newContextAuthoritativeWatcher()
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).hostCacheSynced = true
    markNetworkPolicyRevocationAuthoritative(watcher)

    const expectAligned = (authoritative: boolean) => {
      const detail = watcher.getReadinessInventoryDetail()
      const fromDetail =
        !detail.stopped &&
        detail.mcpServerCacheSynced &&
        detail.contextCacheSynced &&
        detail.hostCacheSynced &&
        detail.safetyInventoryCertified &&
        detail.contextRevisionAligned &&
        detail.serverRevisionAligned
      expect(fromDetail).toBe(authoritative)
      expect(watcher.isReadinessInventoryAuthoritative()).toBe(authoritative)
    }

    expectAligned(true)
    ;(watcher as any).stopped = true
    expectAligned(false)
    expect(watcher.getReadinessInventoryDetail().stopped).toBe(true)
    ;(watcher as any).stopped = false
    expectAligned(true)
    ;(watcher as any).mcpServerCacheSynced = false
    expectAligned(false)
    expect(watcher.getReadinessInventoryDetail().mcpServerCacheSynced).toBe(false)
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).contextCacheSynced = false
    expectAligned(false)
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).hostCacheSynced = false
    expectAligned(false)
    ;(watcher as any).hostCacheSynced = true
    try {
      mocks.hasCertifiedSafetyInventory.mockReturnValue(false)
      expectAligned(false)
      expect(watcher.getReadinessInventoryDetail().safetyInventoryCertified).toBe(false)
    } finally {
      mocks.hasCertifiedSafetyInventory.mockReturnValue(true)
    }
    ;(watcher as any).networkPolicyRevocationContextRevision =
      (watcher as any).contextDesiredRevision + 1
    expectAligned(false)
    expect(watcher.getReadinessInventoryDetail().contextRevisionAligned).toBe(false)
    markNetworkPolicyRevocationAuthoritative(watcher)
    ;(watcher as any).networkPolicyRevocationServerRevision =
      (watcher as any).mcpServerDesiredRevision + 1
    expectAligned(false)
    expect(watcher.getReadinessInventoryDetail().serverRevisionAligned).toBe(false)
    markNetworkPolicyRevocationAuthoritative(watcher)
    expectAligned(true)
  })

  it('ignores a late McpServer callback from a retired watch generation', async () => {
    const callbacks: Array<(type: string, apiObj: any) => Promise<void>> = []
    mocks.watch.mockImplementation(async (path, _options, callback) => {
      if (path.endsWith('/mcpservers')) callbacks.push(callback)
      return { abort: vi.fn() }
    })
    const watcher = new McpServerWatcher()
    await (watcher as any).restartMcpServerWatch({
      resourceVersion: 'mcp-old-rv',
      servers: [],
    })
    await (watcher as any).restartMcpServerWatch({
      resourceVersion: 'mcp-new-rv',
      servers: [
        {
          name: 'current-server',
          namespace: 'mcp-server',
          uid: 'current-uid',
          generation: 1,
          spec: {
            contextRef: 'default',
            image: 'clerum/current:test',
            transport: { type: 'streamableHttp' as const, port: 3000 },
          },
        },
      ],
    })

    await callbacks[0]('ADDED', {
      metadata: {
        name: 'stale-server',
        namespace: 'mcp-server',
        uid: 'stale-uid',
        generation: 1,
      },
      spec: {
        contextRef: 'default',
        image: 'clerum/stale:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
      },
    })

    expect(watcher.getAllServers().map(server => server.name)).toEqual(['current-server'])
    await watcher.stop()
  })

  it('recovers a closed Context watch through a fresh authoritative snapshot', async () => {
    vi.useFakeTimers()
    const doneCallbacks: Array<(error: Error | null) => void> = []
    const watchQueries: unknown[] = []
    mocks.watch.mockImplementation(async (path, options, _callback, done) => {
      if (path.endsWith('/contexts')) {
        doneCallbacks.push(done)
        watchQueries.push(options)
      }
      return { abort: vi.fn() }
    })
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'contexts') {
        return {
          metadata: { resourceVersion: 'context-recovery-rv' },
          items: [
            {
              metadata: { name: 'recovered-context', namespace: 'mcp-server' },
              spec: { contextId: 'recovered-context', mcpServers: [] },
            },
          ],
        }
      }
      return { items: [] }
    })
    const watcher = new McpServerWatcher()
    ;(watcher as any).mcpServerCacheSynced = true
    await (watcher as any).restartContextWatch({
      resourceVersion: 'context-start-rv',
      contexts: [],
    })

    doneCallbacks[0](Object.assign(new Error('resource version expired'), { statusCode: 410 }))
    await vi.advanceTimersByTimeAsync(5000)
    await vi.waitFor(() => expect(watchQueries).toHaveLength(2))

    expect(watchQueries).toEqual([
      { resourceVersion: 'context-start-rv' },
      { resourceVersion: 'context-recovery-rv' },
    ])
    expect((watcher as any).contexts.get('recovered-context')).toEqual(
      expect.objectContaining({ name: 'recovered-context' })
    )
    await vi.waitFor(() => expect(mocks.netPolFullReconcile).toHaveBeenCalled())
    await watcher.stop()
  })

  it('becomes ready after authoritative revocation while every additive convergence lane remains pending', async () => {
    const initialServerFleet = deferred()
    const initialNetworkPolicies = deferred()
    const initialHostFleet = deferred()
    const initialSfsFleet = deferred()
    const initialGfsFleet = deferred()
    let completeAuthoritativeRevocation: (() => void) | undefined
    mocks.serverFullReconcile.mockImplementationOnce(() => initialServerFleet.promise)
    mocks.netPolFullReconcile.mockImplementationOnce(
      async (
        _contexts: unknown,
        _servers: unknown,
        options?: { onAuthoritativeRevocationComplete?: () => void }
      ) => {
        completeAuthoritativeRevocation = options?.onAuthoritativeRevocationComplete
        await initialNetworkPolicies.promise
      }
    )
    mocks.hostFullReconcile.mockImplementationOnce(() => initialHostFleet.promise)
    mocks.sfsFullReconcile.mockImplementationOnce(() => initialSfsFleet.promise)
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'communicationchannels') {
        return { metadata: { resourceVersion: 'safe-bootstrap-rv' }, items: [] }
      }
      return { items: [] }
    })
    const watcher = new McpServerWatcher()
    const startMcpServerWatch = stubAuthoritativeInventoryWatch(watcher, 'McpServer')
    const startContextWatch = stubAuthoritativeInventoryWatch(watcher, 'Context')
    const startSharedFileSystemWatch = vi
      .spyOn(watcher as any, 'startSharedFileSystemWatch')
      .mockResolvedValue(undefined)
    const startGlobalFileSystemWatch = vi
      .spyOn(watcher as any, 'startGlobalFileSystemWatch')
      .mockResolvedValue(undefined)
    const gfsFullReconcile = vi
      .spyOn((watcher as any).gfsReconciler, 'fullReconcile')
      .mockImplementationOnce(() => initialGfsFleet.promise)

    const server = new ContextMapperServer(watcher, 0, undefined, undefined, () =>
      watcher.isReadinessInventoryAuthoritative()
    )
    await server.start()
    const bootstrap = watcher.start()

    try {
      await vi.waitFor(() => {
        expect(mocks.netPolFullReconcile).toHaveBeenCalledOnce()
        expect(mocks.hostFullReconcile).toHaveBeenCalledOnce()
        expect(mocks.sfsFullReconcile).toHaveBeenCalledOnce()
        expect(gfsFullReconcile).toHaveBeenCalledOnce()
      })
      expect(mocks.serverFullReconcile).not.toHaveBeenCalled()

      await expect(bootstrap).resolves.toBeUndefined()
      server.setReady(true)
      const beforeRevocation = await requestReadyOverHttp(server)
      expect(beforeRevocation.statusCode).toBe(503)
      expect(completeAuthoritativeRevocation).toBeTypeOf('function')

      completeAuthoritativeRevocation?.()
      await vi.waitFor(() => expect(mocks.serverFullReconcile).toHaveBeenCalledOnce())
      const ready = await requestReadyOverHttp(server)
      expect(ready.statusCode).toBe(200)
      expect(JSON.parse(ready.body)).toEqual({ status: 'ready', ready: true })
      expect(startMcpServerWatch).toHaveBeenCalledOnce()
      expect(startContextWatch).toHaveBeenCalledOnce()
      expect(startSharedFileSystemWatch).toHaveBeenCalledOnce()
      expect(startGlobalFileSystemWatch).toHaveBeenCalledOnce()
      expect(watcher.isCommunicationChannelCacheSynced()).toBe(true)

      // Runtime convergence starts at the safety-certification boundary, not
      // after the NetworkPolicy additive fleet completes. This prevents the
      // startup egress lane from racing the policy safety pass while retaining
      // readiness decoupling from both additive fleets.
      expect(mocks.serverFullReconcile).toHaveBeenCalledOnce()
      expect(mocks.netPolFullReconcile).toHaveBeenCalledOnce()
    } finally {
      initialServerFleet.resolve(undefined)
      initialNetworkPolicies.resolve(undefined)
      initialHostFleet.resolve(undefined)
      initialSfsFleet.resolve(undefined)
      initialGfsFleet.resolve(undefined)
      await bootstrap.catch(() => undefined)
      await server.stop()
      watcher.stop()
    }
  })

  it('keeps readiness after a current Context safety delta while an older additive pass is pending', async () => {
    const olderAdditivePass = deferred()
    const currentDeltaSafety = deferred<boolean>()
    let contextWatchCallback:
      | ((
          type: string,
          apiObj: {
            metadata: { name: string; namespace: string; uid: string }
            spec: { contextId: string; mcpServers: string[] }
          }
        ) => Promise<void>)
      | undefined
    let networkPolicyPasses = 0
    mocks.watch.mockImplementationOnce(async (path, _options, callback) => {
      if (path.endsWith('/contexts')) contextWatchCallback = callback
      return { abort: vi.fn() }
    })
    mocks.netPolFullReconcile.mockImplementation(async (...args: unknown[]) => {
      networkPolicyPasses += 1
      const options = args[2] as { onAuthoritativeRevocationComplete?: () => void } | undefined
      options?.onAuthoritativeRevocationComplete?.()
      if (networkPolicyPasses === 1) await olderAdditivePass.promise
    })

    const watcher = new McpServerWatcher()
    await (watcher as any).startContextWatch('context-delta-rv')
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).hostCacheSynced = true
    ;(watcher as any).mcpWatchGeneration = 1
    ;(watcher as any).contexts.set('delta-context', {
      name: 'delta-context',
      namespace: 'mcp-server',
      uid: 'delta-context-uid',
      spec: { contextId: 'delta-context', mcpServers: [] },
    })
    const server = new ContextMapperServer(watcher, 0, undefined, undefined, () =>
      watcher.isReadinessInventoryAuthoritative()
    )
    await server.start()
    server.setReady(true)
    const initialPass = (watcher as any).runInitialNetworkPolicyConvergence() as Promise<void>
    ;(watcher as any).netPolReconciler.reconcileContext.mockImplementationOnce(
      () => currentDeltaSafety.promise
    )

    try {
      await vi.waitFor(() => expect(mocks.netPolFullReconcile).toHaveBeenCalledOnce())
      expect((await requestReadyOverHttp(server)).statusCode).toBe(200)

      const currentDelta = contextWatchCallback!('MODIFIED', {
        metadata: {
          name: 'delta-context',
          namespace: 'mcp-server',
          uid: 'delta-context-uid',
        },
        spec: { contextId: 'delta-context', mcpServers: ['delta-server'] },
      })

      await vi.waitFor(() =>
        expect((watcher as any).netPolReconciler.reconcileContext).toHaveBeenCalledOnce()
      )
      expect((await requestReadyOverHttp(server)).statusCode).toBe(503)
      // The scoped revocation completed, which is what authorises the delta
      // certificate; see the aborted-pass twin above for the negative side.
      currentDeltaSafety.resolve(true)
      await currentDelta
      expect((await requestReadyOverHttp(server)).statusCode).toBe(200)
      expect(mocks.netPolFullReconcile).toHaveBeenCalledOnce()
    } finally {
      olderAdditivePass.resolve(undefined)
      await initialPass
      await server.stop()
      await watcher.stop()
    }
  })

  it('does not certify a Context delta whose stale-allow revocation aborted mid-pass', async () => {
    const olderAdditivePass = deferred()
    const abortedDeltaSafety = deferred<boolean>()
    let contextWatchCallback:
      | ((
          type: string,
          apiObj: {
            metadata: { name: string; namespace: string; uid: string }
            spec: { contextId: string; mcpServers: string[] }
          }
        ) => Promise<void>)
      | undefined
    let networkPolicyPasses = 0
    mocks.watch.mockImplementationOnce(async (path, _options, callback) => {
      if (path.endsWith('/contexts')) contextWatchCallback = callback
      return { abort: vi.fn() }
    })
    mocks.netPolFullReconcile.mockImplementation(async (...args: unknown[]) => {
      networkPolicyPasses += 1
      const options = args[2] as { onAuthoritativeRevocationComplete?: () => void } | undefined
      options?.onAuthoritativeRevocationComplete?.()
      if (networkPolicyPasses === 1) await olderAdditivePass.promise
    })

    const watcher = new McpServerWatcher()
    await (watcher as any).startContextWatch('aborted-delta-rv')
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).hostCacheSynced = true
    ;(watcher as any).mcpWatchGeneration = 1
    ;(watcher as any).contexts.set('delta-context', {
      name: 'delta-context',
      namespace: 'mcp-server',
      uid: 'delta-context-uid',
      spec: { contextId: 'delta-context', mcpServers: [] },
    })
    const server = new ContextMapperServer(watcher, 0, undefined, undefined, () =>
      watcher.isReadinessInventoryAuthoritative()
    )
    await server.start()
    server.setReady(true)
    const initialPass = (watcher as any).runInitialNetworkPolicyConvergence() as Promise<void>
    // `reconcileContext` reports that its authority fence broke, so the scoped
    // revocation never finished deleting this Context's stale allows.
    ;(watcher as any).netPolReconciler.reconcileContext.mockImplementationOnce(
      () => abortedDeltaSafety.promise
    )

    try {
      await vi.waitFor(() => expect(mocks.netPolFullReconcile).toHaveBeenCalledOnce())
      expect((await requestReadyOverHttp(server)).statusCode).toBe(200)

      const abortedDelta = contextWatchCallback!('MODIFIED', {
        metadata: {
          name: 'delta-context',
          namespace: 'mcp-server',
          uid: 'delta-context-uid',
        },
        spec: { contextId: 'delta-context', mcpServers: ['delta-server'] },
      })

      await vi.waitFor(() =>
        expect((watcher as any).netPolReconciler.reconcileContext).toHaveBeenCalledOnce()
      )
      expect((await requestReadyOverHttp(server)).statusCode).toBe(503)
      abortedDeltaSafety.resolve(false)
      await abortedDelta

      // An incomplete revocation must leave readiness withheld until the
      // authoritative full pass re-certifies. Certifying here would report
      // Ready while a stale allow is still live.
      expect((await requestReadyOverHttp(server)).statusCode).toBe(503)
    } finally {
      olderAdditivePass.resolve(undefined)
      await initialPass
      await server.stop()
      await watcher.stop()
    }
  })

  it('does not certify a Context delta while the namespace-wide inventory is uncertified', async () => {
    const olderAdditivePass = deferred()
    const uncertifiedDelta = deferred<boolean>()
    let contextWatchCallback:
      | ((
          type: string,
          apiObj: {
            metadata: { name: string; namespace: string; uid: string }
            spec: { contextId: string; mcpServers: string[] }
          }
        ) => Promise<void>)
      | undefined
    let networkPolicyPasses = 0
    mocks.watch.mockImplementationOnce(async (path, _options, callback) => {
      if (path.endsWith('/contexts')) contextWatchCallback = callback
      return { abort: vi.fn() }
    })
    mocks.netPolFullReconcile.mockImplementation(async (...args: unknown[]) => {
      networkPolicyPasses += 1
      const options = args[2] as { onAuthoritativeRevocationComplete?: () => void } | undefined
      options?.onAuthoritativeRevocationComplete?.()
      if (networkPolicyPasses === 1) await olderAdditivePass.promise
    })

    const watcher = new McpServerWatcher()
    await (watcher as any).startContextWatch('uncertified-inventory-rv')
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).hostCacheSynced = true
    ;(watcher as any).mcpWatchGeneration = 1
    ;(watcher as any).contexts.set('delta-context', {
      name: 'delta-context',
      namespace: 'mcp-server',
      uid: 'delta-context-uid',
      spec: { contextId: 'delta-context', mcpServers: [] },
    })
    const server = new ContextMapperServer(watcher, 0, undefined, undefined, () =>
      watcher.isReadinessInventoryAuthoritative()
    )
    await server.start()
    server.setReady(true)
    const initialPass = (watcher as any).runInitialNetworkPolicyConvergence() as Promise<void>
    ;(watcher as any).netPolReconciler.reconcileContext.mockImplementationOnce(
      () => uncertifiedDelta.promise
    )
    try {
      await vi.waitFor(() => expect(mocks.netPolFullReconcile).toHaveBeenCalledOnce())
      // Baseline: the inventory is still certified here, so readiness is
      // genuinely green. Degrading the fence before this point would assert a
      // 200 that only the missing readiness gate could produce.
      expect((await requestReadyOverHttp(server)).statusCode).toBe(200)

      // The delta's own revocation completes, but the last authoritative pass left
      // the namespace-wide inventory uncertified. A label-scoped delta cannot
      // vouch for that namespace, so readiness must stay withheld.
      mocks.hasCertifiedSafetyInventory.mockReturnValue(false)

      const delta = contextWatchCallback!('MODIFIED', {
        metadata: {
          name: 'delta-context',
          namespace: 'mcp-server',
          uid: 'delta-context-uid',
        },
        spec: { contextId: 'delta-context', mcpServers: ['delta-server'] },
      })

      await vi.waitFor(() =>
        expect((watcher as any).netPolReconciler.reconcileContext).toHaveBeenCalledOnce()
      )
      expect((await requestReadyOverHttp(server)).statusCode).toBe(503)
      uncertifiedDelta.resolve(true)
      await delta

      expect((await requestReadyOverHttp(server)).statusCode).toBe(503)
    } finally {
      mocks.hasCertifiedSafetyInventory.mockReturnValue(true)
      olderAdditivePass.resolve(undefined)
      await initialPass
      await server.stop()
      await watcher.stop()
    }
  })

  it('recovers when a Context delta loses the delete fence with no certificate to withhold', async () => {
    // A MODIFIED that does not move the desired revision — a status or label
    // write by another controller — still runs a scoped revocation, but builds
    // no delta certificate. Nothing reads the returned boolean there, so a lost
    // delete fence must stay loud and reach the convergence retry instead of
    // leaving a stale allow live with no NetworkPolicy resync to recover it.
    let contextWatchCallback:
      | ((
          type: string,
          apiObj: {
            metadata: { name: string; namespace: string; uid: string; generation?: number }
            spec: { contextId: string; mcpServers: string[] }
          }
        ) => Promise<void>)
      | undefined
    mocks.watch.mockImplementationOnce(async (path, _options, callback) => {
      if (path.endsWith('/contexts')) contextWatchCallback = callback
      return { abort: vi.fn() }
    })

    const watcher = new McpServerWatcher()
    await (watcher as any).startContextWatch('lost-fence-no-certificate-rv')
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).hostCacheSynced = true
    ;(watcher as any).mcpWatchGeneration = 1
    ;(watcher as any).contexts.set('steady-context', {
      name: 'steady-context',
      namespace: 'mcp-server',
      uid: 'steady-context-uid',
      generation: 4,
      spec: { contextId: 'steady-context', mcpServers: [] },
    })
    markNetworkPolicyRevocationAuthoritative(watcher)
    const passesBefore = mocks.netPolFullReconcile.mock.calls.length
    // With honorsLostFence false the real reconciler throws the 409 rather than
    // reporting it, which is the whole point: the throw is what reaches the
    // convergence retry below.
    ;(watcher as any).netPolReconciler.reconcileContext.mockRejectedValueOnce(
      Object.assign(new Error('the UID in the precondition does not match'), { code: 409 })
    )

    try {
      await contextWatchCallback!('MODIFIED', {
        metadata: {
          name: 'steady-context',
          namespace: 'mcp-server',
          uid: 'steady-context-uid',
          generation: 4,
        },
        spec: { contextId: 'steady-context', mcpServers: [] },
      })

      // This lane cannot act on the boolean, so it must not have opted into the
      // reported outcome.
      expect((watcher as any).netPolReconciler.reconcileContext).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'steady-context' }),
        expect.objectContaining({ honorsLostFence: false })
      )
      await vi.waitFor(() =>
        expect(mocks.netPolFullReconcile.mock.calls.length).toBeGreaterThan(passesBefore)
      )
    } finally {
      await watcher.stop()
    }
  })

  it('does not issue a Context delta certificate before any authoritative safety certificate', async () => {
    const pendingFullSafetyPass = deferred()
    let contextWatchCallback:
      | ((
          type: string,
          apiObj: {
            metadata: { name: string; namespace: string; uid: string }
            spec: { contextId: string; mcpServers: string[] }
          }
        ) => Promise<void>)
      | undefined
    mocks.watch.mockImplementationOnce(async (_path, _options, callback) => {
      contextWatchCallback = callback
      return { abort: vi.fn() }
    })
    mocks.netPolFullReconcile.mockImplementationOnce(() => pendingFullSafetyPass.promise)

    const watcher = new McpServerWatcher()
    await (watcher as any).startContextWatch('uncertified-context-delta-rv')
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).hostCacheSynced = true
    ;(watcher as any).mcpWatchGeneration = 1
    ;(watcher as any).contexts.set('uncertified-context', {
      name: 'uncertified-context',
      namespace: 'mcp-server',
      uid: 'uncertified-context-uid',
      spec: { contextId: 'uncertified-context', mcpServers: [] },
    })
    const server = new ContextMapperServer(watcher, 0, undefined, undefined, () =>
      watcher.isReadinessInventoryAuthoritative()
    )
    await server.start()
    server.setReady(true)

    try {
      await contextWatchCallback!('MODIFIED', {
        metadata: {
          name: 'uncertified-context',
          namespace: 'mcp-server',
          uid: 'uncertified-context-uid',
        },
        spec: { contextId: 'uncertified-context', mcpServers: ['delta-server'] },
      })

      expect((await requestReadyOverHttp(server)).statusCode).toBe(503)
    } finally {
      pendingFullSafetyPass.resolve(undefined)
      await watcher.stop()
      await server.stop()
    }
  })

  it('does not let a Context delta certify an outstanding McpServer revision', async () => {
    const pendingFullSafetyPass = deferred()
    let contextWatchCallback:
      | ((
          type: string,
          apiObj: {
            metadata: { name: string; namespace: string; uid: string }
            spec: { contextId: string; mcpServers: string[] }
          }
        ) => Promise<void>)
      | undefined
    mocks.watch.mockImplementationOnce(async (_path, _options, callback) => {
      contextWatchCallback = callback
      return { abort: vi.fn() }
    })
    mocks.netPolFullReconcile.mockImplementationOnce(() => pendingFullSafetyPass.promise)

    const watcher = new McpServerWatcher()
    await (watcher as any).startContextWatch('server-revision-context-delta-rv')
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).hostCacheSynced = true
    ;(watcher as any).mcpWatchGeneration = 1
    ;(watcher as any).contexts.set('unrelated-context', {
      name: 'unrelated-context',
      namespace: 'mcp-server',
      uid: 'unrelated-context-uid',
      spec: { contextId: 'unrelated-context', mcpServers: [] },
    })
    markNetworkPolicyRevocationAuthoritative(watcher)
    ;(watcher as any).mcpServerDesiredRevision += 1
    const server = new ContextMapperServer(watcher, 0, undefined, undefined, () =>
      watcher.isReadinessInventoryAuthoritative()
    )
    await server.start()
    server.setReady(true)

    try {
      expect((await requestReadyOverHttp(server)).statusCode).toBe(503)
      await contextWatchCallback!('MODIFIED', {
        metadata: {
          name: 'unrelated-context',
          namespace: 'mcp-server',
          uid: 'unrelated-context-uid',
        },
        spec: { contextId: 'unrelated-context', mcpServers: ['delta-server'] },
      })

      expect((await requestReadyOverHttp(server)).statusCode).toBe(503)
    } finally {
      pendingFullSafetyPass.resolve(undefined)
      await watcher.stop()
      await server.stop()
    }
  })

  it('does not let one Context delta certify another Context revision still in flight', async () => {
    const pendingFullSafetyPass = deferred()
    let contextWatchCallback:
      | ((
          type: string,
          apiObj: {
            metadata: { name: string; namespace: string; uid: string }
            spec: { contextId: string; mcpServers: string[] }
          }
        ) => Promise<void>)
      | undefined
    mocks.watch.mockImplementationOnce(async (_path, _options, callback) => {
      contextWatchCallback = callback
      return { abort: vi.fn() }
    })
    mocks.netPolFullReconcile.mockImplementationOnce(() => pendingFullSafetyPass.promise)

    const watcher = new McpServerWatcher()
    await (watcher as any).startContextWatch('parallel-context-delta-rv')
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).hostCacheSynced = true
    ;(watcher as any).mcpWatchGeneration = 1
    ;(watcher as any).contexts.set('first-context', {
      name: 'first-context',
      namespace: 'mcp-server',
      uid: 'first-context-uid',
      spec: { contextId: 'first-context', mcpServers: [] },
    })
    ;(watcher as any).contexts.set('second-context', {
      name: 'second-context',
      namespace: 'mcp-server',
      uid: 'second-context-uid',
      spec: { contextId: 'second-context', mcpServers: [] },
    })
    markNetworkPolicyRevocationAuthoritative(watcher)
    // This represents a prior Context change whose global safety sweep is
    // pending. It invalidates the old certificate before the scoped delta.
    ;(watcher as any).contextDesiredRevision += 1
    const server = new ContextMapperServer(watcher, 0, undefined, undefined, () =>
      watcher.isReadinessInventoryAuthoritative()
    )
    await server.start()
    server.setReady(true)

    try {
      await contextWatchCallback!('MODIFIED', {
        metadata: {
          name: 'second-context',
          namespace: 'mcp-server',
          uid: 'second-context-uid',
        },
        spec: { contextId: 'second-context', mcpServers: ['delta-server'] },
      })

      expect((await requestReadyOverHttp(server)).statusCode).toBe(503)
    } finally {
      pendingFullSafetyPass.resolve(undefined)
      await watcher.stop()
      await server.stop()
    }
  })

  it.each([
    ['Context', 'contextDesiredRevision'],
    ['McpServer', 'mcpServerDesiredRevision'],
  ] as const)(
    'does not restore readiness from a stale %s delta safety certificate',
    async (_kind, revisionField) => {
      const watcher = new McpServerWatcher()
      ;(watcher as any).contextCacheSynced = true
      ;(watcher as any).mcpServerCacheSynced = true
      ;(watcher as any).hostCacheSynced = true
      ;(watcher as any).contextWatchGeneration = 4
      ;(watcher as any).mcpWatchGeneration = 7
      markNetworkPolicyRevocationAuthoritative(watcher)
      const certificate = {
        contextGeneration: (watcher as any).contextWatchGeneration,
        serverGeneration: (watcher as any).mcpWatchGeneration,
        contextRevision: (watcher as any).contextDesiredRevision,
        serverRevision: (watcher as any).mcpServerDesiredRevision,
      }

      ;(watcher as any)[revisionField] += 1

      expect((watcher as any).recordNetworkPolicySafetyCertificate(certificate)).toBe(false)
      expect(watcher.isReadinessInventoryAuthoritative()).toBe(false)
      await watcher.stop()
    }
  )

  it.each([
    ['SharedFileSystem', 'LIST', 'sharedfilesystems', 'startSharedFileSystemWatch'],
    ['SharedFileSystem', 'WATCH', 'sharedfilesystems', 'startSharedFileSystemWatch'],
    ['GlobalFileSystem', 'LIST', 'globalfilesystems', 'startGlobalFileSystemWatch'],
    ['GlobalFileSystem', 'WATCH', 'globalfilesystems', 'startGlobalFileSystemWatch'],
  ] as const)(
    'does not let a pending %s %s delay NetworkPolicy safety, bootstrap, or readiness certification',
    async (_kind, boundary, plural, watchMethod) => {
      const pendingBoundary = deferred<unknown>()
      const pendingAdditivePolicies = deferred()
      let completeAuthoritativeRevocation: (() => void) | undefined
      mocks.listNamespacedCustomObject.mockImplementation(
        async ({ plural: requestedPlural }: { plural: string }) => {
          if (requestedPlural === 'communicationchannels') {
            return { metadata: { resourceVersion: 'background-lane-rv' }, items: [] }
          }
          if (boundary === 'LIST' && requestedPlural === plural) {
            return pendingBoundary.promise
          }
          return { items: [] }
        }
      )
      mocks.netPolFullReconcile.mockImplementationOnce(
        async (
          _contexts: unknown,
          _servers: unknown,
          options?: { onAuthoritativeRevocationComplete?: () => void }
        ) => {
          completeAuthoritativeRevocation = options?.onAuthoritativeRevocationComplete
          await pendingAdditivePolicies.promise
        }
      )

      const watcher = new McpServerWatcher()
      stubAuthoritativeInventoryWatch(watcher, 'McpServer')
      stubAuthoritativeInventoryWatch(watcher, 'Context')
      const sfsWatch = vi
        .spyOn(watcher as any, 'startSharedFileSystemWatch')
        .mockResolvedValue(undefined)
      const gfsWatch = vi
        .spyOn(watcher as any, 'startGlobalFileSystemWatch')
        .mockResolvedValue(undefined)
      const targetWatch = watchMethod === 'startSharedFileSystemWatch' ? sfsWatch : gfsWatch
      if (boundary === 'WATCH') {
        targetWatch.mockImplementationOnce(() => pendingBoundary.promise as Promise<void>)
      }
      const bootstrap = watcher.start()

      try {
        await vi.waitFor(() => expect(mocks.netPolFullReconcile).toHaveBeenCalledOnce())
        await expect(bootstrap).resolves.toBeUndefined()

        expect(completeAuthoritativeRevocation).toBeTypeOf('function')
        expect(watcher.isReadinessInventoryAuthoritative()).toBe(false)
        if (boundary === 'LIST') {
          expect(targetWatch).not.toHaveBeenCalled()
        } else {
          expect(targetWatch).toHaveBeenCalledOnce()
        }

        completeAuthoritativeRevocation?.()
        await vi.waitFor(() => expect(watcher.isReadinessInventoryAuthoritative()).toBe(true))
      } finally {
        pendingBoundary.resolve({ items: [] })
        pendingAdditivePolicies.resolve(undefined)
        await flushMicrotasks()
        await watcher.stop()
      }
    }
  )

  it('starts every initial background convergence lane from the caches current after watches', async () => {
    const staleServer = {
      metadata: { name: 'stale-server', namespace: 'mcp-server' },
      spec: {
        contextRef: 'default',
        image: 'clerum/stale-server:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
      },
    }
    const currentServer = {
      name: 'current-server',
      namespace: 'mcp-server',
      spec: {
        contextRef: 'default',
        image: 'clerum/current-server:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
      },
    }
    const staleContext = {
      metadata: { name: 'stale-context', namespace: 'mcp-server' },
      spec: { contextId: 'stale-context', mcpServers: [] },
    }
    const currentContext = {
      name: 'current-context',
      namespace: 'mcp-server',
      spec: { contextId: 'current-context', mcpServers: [] },
    }
    const staleSfs = { metadata: { name: 'stale-sfs', namespace: 'mcp-host' }, spec: {} }
    const currentSfs = { name: 'current-sfs', namespace: 'mcp-host', spec: {} }
    const staleGfs = { metadata: { name: 'stale-gfs', namespace: 'mcp-host' }, spec: {} }
    const currentGfs = { name: 'current-gfs', namespace: 'mcp-host', spec: {} }
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'mcpservers') return { items: [staleServer] }
      if (plural === 'contexts') return { items: [staleContext] }
      if (plural === 'sharedfilesystems') return { items: [staleSfs] }
      if (plural === 'globalfilesystems') return { items: [staleGfs] }
      if (plural === 'communicationchannels') {
        return { metadata: { resourceVersion: 'current-cache-rv' }, items: [] }
      }
      return { items: [] }
    })
    const watcher = new McpServerWatcher()
    stubAuthoritativeInventoryWatch(watcher, 'McpServer', () => {
      ;(watcher as any).servers.clear()
      ;(watcher as any).servers.set(currentServer.name, currentServer)
    })
    stubAuthoritativeInventoryWatch(watcher, 'Context', () => {
      ;(watcher as any).contexts.clear()
      ;(watcher as any).contexts.set(currentContext.name, currentContext)
    })
    vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockImplementation(async () => {
      ;(watcher as any).sharedFileSystems.clear()
      ;(watcher as any).sharedFileSystems.set(currentSfs.name, currentSfs)
    })
    vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockImplementation(async () => {
      ;(watcher as any).globalFileSystems.clear()
      ;(watcher as any).globalFileSystems.set(currentGfs.name, currentGfs)
    })
    const gfsFullReconcile = vi.spyOn((watcher as any).gfsReconciler, 'fullReconcile')

    await watcher.start()

    await vi.waitFor(() => {
      expect(mocks.serverFullReconcile).toHaveBeenCalledWith([currentServer], {
        runEffect: expect.any(Function),
      })
      expect(mocks.netPolFullReconcile).toHaveBeenCalledWith(
        [currentContext],
        [currentServer],
        expect.objectContaining({
          serverInventoryComplete: true,
          ensureDefaults: false,
          contextInventoryAuthoritative: expect.any(Function),
          serverInventoryAuthoritative: expect.any(Function),
        })
      )
      expect(mocks.sfsFullReconcile).toHaveBeenCalledWith([currentSfs])
      expect(gfsFullReconcile).toHaveBeenCalledWith([currentGfs])
    })

    watcher.stop()
  })

  it('updates discovery without re-reconciling a status-only McpServer watch event', async () => {
    const previousServer = {
      name: 'status-server',
      namespace: 'mcp-server',
      uid: 'status-server-uid',
      generation: 7,
      annotations: { 'clerum.io/recipe': 'status-recipe' },
      labels: { 'clerum.io/workload': 'status-server' },
      spec: {
        contextRef: 'default',
        image: 'clerum/status-server:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
      },
    }
    const watcher = new McpServerWatcher()
    ;(watcher as any).servers.set(previousServer.name, previousServer)
    const changed = vi.fn()
    watcher.onChange(changed)
    const reconciler = (watcher as any).reconciler
    const netPol = (watcher as any).netPolReconciler
    const callback = (watcher as any).getMcpServerWatchCallback()
    expect((watcher as any).mcpServerDesiredRevision).toBe(0)

    await callback('MODIFIED', {
      metadata: {
        name: previousServer.name,
        namespace: previousServer.namespace,
        uid: previousServer.uid,
        generation: previousServer.generation,
        annotations: previousServer.annotations,
        labels: previousServer.labels,
      },
      spec: previousServer.spec,
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    })

    expect(watcher.getAllServers()[0]?.status).toEqual({
      conditions: [{ type: 'Ready', status: 'True' }],
    })
    expect(changed).toHaveBeenCalledOnce()
    expect(reconciler.reconcile).not.toHaveBeenCalled()
    expect(netPol.reconcileExternalEgress).not.toHaveBeenCalled()
    expect((watcher as any).mcpServerDesiredRevision).toBe(0)

    await callback('MODIFIED', {
      metadata: {
        name: previousServer.name,
        namespace: previousServer.namespace,
        uid: previousServer.uid,
        generation: 8,
        annotations: previousServer.annotations,
        labels: previousServer.labels,
      },
      spec: { ...previousServer.spec, image: 'clerum/status-server:next' },
    })
    expect(reconciler.reconcile).toHaveBeenCalledOnce()
    expect((watcher as any).mcpServerDesiredRevision).toBe(1)
    await watcher.stop()
  })

  it('does not advance desired revision for the controller-owned network-ready handshake', async () => {
    const previousServer = {
      name: 'network-ready-server',
      namespace: 'mcp-server',
      uid: 'network-ready-server-uid',
      generation: 7,
      annotations: { 'clerum.io/pre-deploy': 'true' },
      labels: { 'clerum.io/workload': 'network-ready-server' },
      spec: {
        contextRef: 'default',
        image: 'clerum/network-ready-server:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
      },
    }
    const watcher = new McpServerWatcher()
    ;(watcher as any).servers.set(previousServer.name, previousServer)
    const callback = (watcher as any).getMcpServerWatchCallback()

    await callback('MODIFIED', {
      metadata: {
        name: previousServer.name,
        namespace: previousServer.namespace,
        uid: previousServer.uid,
        generation: previousServer.generation,
        annotations: {
          ...previousServer.annotations,
          'clerum.io/network-ready': 'true',
        },
        labels: previousServer.labels,
      },
      spec: previousServer.spec,
    })

    expect((watcher as any).mcpServerDesiredRevision).toBe(0)
    expect((watcher as any).reconciler.reconcile).not.toHaveBeenCalled()
    await watcher.stop()
  })

  it('advances McpServer desired revision for owner addition and deletion', async () => {
    const serverObject = {
      metadata: {
        name: 'revision-server',
        namespace: 'mcp-server',
        uid: 'revision-server-uid',
        generation: 1,
      },
      spec: {
        contextRef: 'default',
        image: 'clerum/revision-server:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
      },
    }
    const watcher = new McpServerWatcher()
    const callback = (watcher as any).getMcpServerWatchCallback()

    expect((watcher as any).mcpServerDesiredRevision).toBe(0)
    await callback('ADDED', serverObject)
    expect((watcher as any).mcpServerDesiredRevision).toBe(1)
    await callback('DELETED', serverObject)
    expect((watcher as any).mcpServerDesiredRevision).toBe(2)

    await watcher.stop()
  })

  it('advances Context desired revision only when the authoritative desired cache changes', async () => {
    const watcher = new McpServerWatcher()
    let contextWatchCallback:
      | ((
          type: string,
          apiObj: {
            metadata: { name: string; namespace: string }
            spec: { contextId: string; mcpServers: string[] }
          }
        ) => Promise<void>)
      | undefined
    mocks.watch.mockImplementationOnce(async (_path, _options, callback) => {
      contextWatchCallback = callback
      return { abort: vi.fn() }
    })
    await (watcher as any).startContextWatch('context-desired-revision-rv')
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true

    const added = {
      metadata: { name: 'revision-context', namespace: 'mcp-server' },
      spec: { contextId: 'revision-context', mcpServers: [] as string[] },
    }
    expect((watcher as any).contextDesiredRevision).toBe(0)
    await contextWatchCallback!('ADDED', added)
    expect((watcher as any).contextDesiredRevision).toBe(1)

    await contextWatchCallback!('MODIFIED', added)
    expect((watcher as any).contextDesiredRevision).toBe(1)

    const modified = {
      ...added,
      spec: { ...added.spec, mcpServers: ['revision-server'] },
    }
    await contextWatchCallback!('MODIFIED', modified)
    expect((watcher as any).contextDesiredRevision).toBe(2)

    await contextWatchCallback!('DELETED', modified)
    expect((watcher as any).contextDesiredRevision).toBe(3)

    await watcher.stop()
  })

  it('uses only the bounded fleet pass for the cold-start Host snapshot', async () => {
    const initialHosts = Array.from({ length: 50 }, (_, index) => ({
      metadata: {
        name: `initial-host-${index}`,
        namespace: 'mcp-host',
        uid: `initial-host-uid-${index}`,
        generation: 1,
      },
      spec: {
        host: `initial-host-${index}`,
        contextRef: 'default',
        secretRef: 'host-secret',
      },
    }))
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') {
        return {
          metadata: { resourceVersion: 'initial-host-rv' },
          items: initialHosts,
        }
      }
      if (plural === 'communicationchannels') {
        return { metadata: { resourceVersion: 'initial-cc-rv' }, items: [] }
      }
      return { items: [] }
    })
    const watcher = new McpServerWatcher()
    const urgentReconcile = vi.spyOn(watcher.getHostReconciler(), 'reconcile')

    await watcher.start()
    await vi.waitFor(() =>
      expect(mocks.hostFullReconcile).toHaveBeenCalledWith(
        initialHosts.map(host =>
          expect.objectContaining({
            name: host.metadata.name,
            generation: host.metadata.generation,
          })
        )
      )
    )
    await flushMicrotasks()

    expect(mocks.hostFullReconcile).toHaveBeenCalledOnce()
    expect(urgentReconcile).not.toHaveBeenCalled()
    await watcher.stop()
  })

  it('admits a McpServer watch reconciliation while initial convergence is blocked on another server', async () => {
    const staleServer = {
      name: 'stale-server',
      namespace: 'mcp-server',
      spec: {
        contextRef: 'default',
        image: 'clerum/stale-server:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
        egressBindings: [{ dns: 'stale.example', port: 443 }],
      },
    }
    const currentServer = {
      metadata: { name: 'current-server', namespace: 'mcp-server' },
      spec: {
        contextRef: 'default',
        image: 'clerum/current-server:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
      },
    }
    const egressStarted = deferred()
    const releaseEgress = deferred()
    const reconciliationOrder: string[] = []
    const watcher = new McpServerWatcher()
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).contextCacheSynced = true
    markNetworkPolicyRevocationAuthoritative(watcher)
    ;(watcher as any).servers.set(staleServer.name, staleServer)
    const netPol = (watcher as any).netPolReconciler
    netPol.reconcileExternalEgress.mockImplementationOnce(async () => {
      egressStarted.resolve(undefined)
      await releaseEgress.promise
    })
    mocks.serverFullReconcile.mockImplementationOnce(async (servers, options) => {
      await Promise.all(
        servers.map((selected: { name: string }) =>
          options.runEffect(selected.name, async () => {
            reconciliationOrder.push('initial')
          })
        )
      )
    })
    const reconciler = (watcher as any).reconciler
    reconciler.reconcile.mockImplementationOnce(async () => {
      reconciliationOrder.push('watch')
    })

    const convergence = (watcher as any).runInitialMcpServerConvergence()
    await egressStarted.promise
    const watchConvergence = (watcher as any).getMcpServerWatchCallback()('MODIFIED', currentServer)

    await flushMicrotasks()
    expect(reconciler.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'current-server' }),
      { isCurrent: expect.any(Function) }
    )

    releaseEgress.resolve(undefined)
    await Promise.all([convergence, watchConvergence])

    expect(reconciliationOrder).toEqual(['watch'])
    expect(reconciler.reconcile).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'current-server' }),
      { isCurrent: expect.any(Function) }
    )
    await watcher.stop()
  })

  it('continues a same-server reconciliation lane after a rejected operation', async () => {
    const watcher = new McpServerWatcher()
    const server = { name: 'retry-safe-server', namespace: 'mcp-server' }
    const order: string[] = []
    const firstStarted = deferred()
    const rejectFirst = deferred()

    const rejected = (watcher as any).enqueueMcpServerReconciliation(server, async () => {
      order.push('rejected')
      firstStarted.resolve(undefined)
      await rejectFirst.promise
      throw new Error('transient lane failure')
    }) as Promise<void>
    await firstStarted.promise
    const recovered = (watcher as any).enqueueMcpServerReconciliation(server, async () => {
      order.push('recovered')
    }) as Promise<void>
    rejectFirst.resolve(undefined)

    await expect(rejected).rejects.toThrow('transient lane failure')
    await expect(recovered).resolves.toBeUndefined()
    expect(order).toEqual(['rejected', 'recovered'])
    expect((watcher as any).mcpServerReconciliationQueues.size).toBe(0)
    await watcher.stop()
  })

  it('revalidates env-Secret matches inside each server lane before reconciling', async () => {
    const currentServer = {
      name: 'current-secret-server',
      namespace: 'mcp-server',
      spec: {
        contextRef: 'default',
        image: 'clerum/current-secret-server:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
        envSecret: { name: 'shared-env' },
      },
    }
    const staleServer = {
      name: 'stale-secret-server',
      namespace: 'mcp-server',
      spec: {
        contextRef: 'default',
        image: 'clerum/stale-secret-server:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
        envSecret: { name: 'shared-env' },
      },
    }
    const unrelatedServer = {
      name: 'unrelated-secret-server',
      namespace: 'mcp-server',
      spec: {
        contextRef: 'default',
        image: 'clerum/unrelated-secret-server:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
        envSecret: { name: 'other-env' },
      },
    }
    const blockerStarted = deferred()
    const releaseBlocker = deferred()
    const watcher = new McpServerWatcher()
    markMcpServerInventoryAuthoritative(watcher)
    const reconciler = (watcher as any).reconciler
    for (const server of [currentServer, staleServer, unrelatedServer]) {
      ;(watcher as any).servers.set(server.name, server)
    }

    const blocker = (watcher as any).enqueueMcpServerReconciliation(staleServer, async () => {
      blockerStarted.resolve(undefined)
      await releaseBlocker.promise
    })
    await blockerStarted.promise

    const convergence = watcher.reconcileByEnvSecret('shared-env', 'mcp-server')
    ;(watcher as any).servers.set(staleServer.name, {
      ...staleServer,
      spec: { ...staleServer.spec, envSecret: { name: 'replacement-env' } },
    })
    await vi.waitFor(() =>
      expect(reconciler.reconcile).toHaveBeenCalledWith(
        expect.objectContaining({ name: currentServer.name }),
        { isCurrent: expect.any(Function) }
      )
    )
    releaseBlocker.resolve(undefined)
    await Promise.all([blocker, convergence])

    expect(reconciler.reconcile).toHaveBeenCalledTimes(1)
    expect(
      reconciler.reconcile.mock.calls.some(
        ([server]: [McpServerCRD]) => server.name === staleServer.name
      )
    ).toBe(false)
    expect(
      reconciler.reconcile.mock.calls.some(
        ([server]: [McpServerCRD]) => server.name === unrelatedServer.name
      )
    ).toBe(false)
    await watcher.stop()
  })

  it('defers env-Secret reconciliation until the McpServer inventory is authoritative', async () => {
    const selected = {
      name: 'authority-fenced-secret-server',
      namespace: 'mcp-server',
      spec: {
        contextRef: 'default',
        image: 'clerum/authority-fenced-secret-server:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
        envSecret: { name: 'shared-env' },
      },
    }
    const watcher = new McpServerWatcher()
    const reconciler = (watcher as any).reconciler
    ;(watcher as any).servers.set(selected.name, selected)
    ;(watcher as any).mcpServerCacheSynced = false

    await watcher.reconcileByEnvSecret('shared-env', 'mcp-server')

    expect(reconciler.reconcile).not.toHaveBeenCalled()

    markMcpServerInventoryAuthoritative(watcher)
    await watcher.reconcileByEnvSecret('shared-env', 'mcp-server')

    expect(reconciler.reconcile).toHaveBeenCalledOnce()
    expect(reconciler.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ name: selected.name }),
      { isCurrent: expect.any(Function) }
    )
    await watcher.stop()
  })

  it('fences Context-triggered SharedFileSystem convergence to the current Context lease', async () => {
    const context = {
      name: 'sfs-context',
      namespace: 'mcp-server',
      spec: {
        contextId: 'sfs-context',
        sharedFileSystems: [{ name: 'shared-data', mountPath: '/shared' }],
      },
    }
    const sharedFileSystem = {
      name: 'shared-data',
      namespace: 'mcp-host',
      spec: {},
    }
    const watcher = new McpServerWatcher()
    const reconciler = (watcher as any).sharedFileSystemReconciler
    ;(watcher as any).sharedFileSystems.set(sharedFileSystem.name, sharedFileSystem)

    await (watcher as any).reconcileSharedFileSystemsReferencedByContext(
      undefined,
      context,
      () => false
    )

    expect(reconciler.reconcile).not.toHaveBeenCalled()

    await (watcher as any).reconcileSharedFileSystemsReferencedByContext(
      undefined,
      context,
      () => true
    )

    expect(reconciler.reconcile).toHaveBeenCalledOnce()
    expect(reconciler.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ name: sharedFileSystem.name })
    )
    await watcher.stop()
  })

  it('fences Context-triggered Host convergence to the current Context lease', async () => {
    const watcher = new McpServerWatcher()
    markHostInventoryAuthoritative(watcher)
    ;(watcher as any).hosts.set('context-host', {
      name: 'context-host',
      namespace: 'mcp-host',
      spec: {
        host: 'context-host',
        contextRef: 'context-a',
        secretRef: 'host-secret',
      },
    })
    const hostReconciler = (watcher as any).hostReconciler

    await (watcher as any).reconcileHostsReferencingContext('context-a', () => false)

    expect(hostReconciler.reconcile).not.toHaveBeenCalled()

    await (watcher as any).reconcileHostsReferencingContext('context-a', () => true)

    expect(hostReconciler.reconcile).toHaveBeenCalledOnce()
    expect(hostReconciler.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'context-host' })
    )
    await watcher.stop()
  })

  it('keeps env-Secret reconciliation a no-op after stop', async () => {
    const selected = {
      name: 'stopped-secret-server',
      namespace: 'mcp-server',
      spec: {
        contextRef: 'default',
        image: 'clerum/stopped-secret-server:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
        envSecret: { name: 'shared-env' },
      },
    }
    const watcher = new McpServerWatcher()
    const reconciler = (watcher as any).reconciler
    ;(watcher as any).servers.set(selected.name, selected)

    await watcher.stop()
    await watcher.reconcileByEnvSecret('shared-env', 'mcp-server')

    expect(reconciler.reconcile).not.toHaveBeenCalled()
  })

  it('admits an initial server without egress while another initial server waits on DNS', async () => {
    const dnsBlockedServer = {
      name: 'dns-blocked-server',
      namespace: 'mcp-server',
      uid: 'dns-blocked-server-uid',
      generation: 1,
      spec: {
        contextRef: 'default',
        image: 'clerum/dns-blocked-server:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
        egressBindings: [{ dns: 'blocked.example', port: 443 }],
      },
    }
    const independentServer = {
      name: 'independent-server',
      namespace: 'mcp-server',
      uid: 'independent-server-uid',
      generation: 1,
      spec: {
        contextRef: 'default',
        image: 'clerum/independent-server:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
      },
    }
    const egressStarted = deferred()
    const releaseEgress = deferred()
    const watcher = new McpServerWatcher()
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).contextCacheSynced = true
    markNetworkPolicyRevocationAuthoritative(watcher)
    ;(watcher as any).servers.set(dnsBlockedServer.name, dnsBlockedServer)
    ;(watcher as any).servers.set(independentServer.name, independentServer)
    const netPol = (watcher as any).netPolReconciler
    const reconciler = (watcher as any).reconciler
    netPol.reconcileExternalEgress.mockImplementationOnce(async () => {
      egressStarted.resolve(undefined)
      await releaseEgress.promise
    })
    mocks.serverFullReconcile.mockImplementationOnce(
      async (
        servers: Array<typeof dnsBlockedServer | typeof independentServer>,
        options: { runEffect: (serverName: string, work: () => Promise<void>) => Promise<void> }
      ) => {
        await Promise.all(
          servers.map(server => options.runEffect(server.name, () => reconciler.reconcile(server)))
        )
      }
    )

    const convergence = (watcher as any).runInitialMcpServerConvergence()
    await egressStarted.promise
    await flushMicrotasks()

    expect(reconciler.reconcile).toHaveBeenCalledWith(independentServer)
    expect(reconciler.reconcile).not.toHaveBeenCalledWith(dnsBlockedServer)

    releaseEgress.resolve(undefined)
    await convergence

    expect(reconciler.reconcile).toHaveBeenCalledWith(dnsBlockedServer)
    await watcher.stop()
  })

  it('admits a Context watch reconciliation while initial policy convergence is blocked', async () => {
    const staleContext = {
      name: 'stale-context',
      namespace: 'mcp-server',
      spec: { contextId: 'stale-context', mcpServers: [] },
    }
    const currentContext = {
      metadata: { name: 'current-context', namespace: 'mcp-server' },
      spec: { contextId: 'current-context', mcpServers: [] },
    }
    const fullReconcileStarted = deferred()
    const releaseFullReconcile = deferred()
    const reconciliationOrder: string[] = []
    const watcher = new McpServerWatcher()
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).contexts.set(staleContext.name, staleContext)
    mocks.netPolFullReconcile.mockImplementationOnce(async () => {
      fullReconcileStarted.resolve(undefined)
      await releaseFullReconcile.promise
      reconciliationOrder.push('initial')
    })
    const netPol = (watcher as any).netPolReconciler
    netPol.reconcileContext.mockImplementationOnce(async () => {
      reconciliationOrder.push('watch')
    })
    let contextWatchCallback:
      | ((type: string, apiObj: typeof currentContext) => Promise<void>)
      | undefined
    mocks.watch.mockImplementationOnce(async (_path, _options, callback) => {
      contextWatchCallback = callback
      return { abort: vi.fn() }
    })
    await (watcher as any).startContextWatch('context-queue-rv')

    const convergence = (watcher as any).runInitialNetworkPolicyConvergence(true)
    await fullReconcileStarted.promise
    const watchConvergence = contextWatchCallback!('MODIFIED', currentContext)

    await flushMicrotasks()
    expect(netPol.reconcileContext).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'current-context' }),
      expect.objectContaining({ isCurrent: expect.any(Function) })
    )

    releaseFullReconcile.resolve(undefined)
    await Promise.all([convergence, watchConvergence])

    expect(reconciliationOrder).toEqual(['watch', 'initial'])
    expect(netPol.reconcileContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'current-context' }),
      expect.objectContaining({ isCurrent: expect.any(Function) })
    )
    await watcher.stop()
  })

  it('makes a recreated Context the last writer after same-contextId orphan cleanup', async () => {
    const contextName = 'recreated-context-resource'
    const contextId = 'recreated-context'
    const recreatedContext = {
      metadata: { name: contextName, namespace: 'mcp-server' },
      spec: {
        contextId,
        description: 'recreated',
        mcpServers: [],
      },
    }
    const orphanCleanupStarted = deferred()
    const releaseOrphanCleanup = deferred()
    const order: string[] = []
    const watcher = new McpServerWatcher()
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).contextCacheSynced = true
    mocks.netPolFullReconcile.mockImplementationOnce(
      async (
        _contexts: unknown[],
        _servers: unknown[],
        options: {
          runContextEffect: (effectContextId: string, work: () => Promise<void>) => Promise<void>
        }
      ) => {
        await options.runContextEffect(contextId, async () => {
          orphanCleanupStarted.resolve(undefined)
          await releaseOrphanCleanup.promise
          order.push('orphan-delete')
        })
      }
    )
    const netPol = (watcher as any).netPolReconciler
    netPol.reconcileContext.mockImplementationOnce(async () => {
      order.push('live-recreate')
    })
    let contextWatchCallback:
      | ((type: string, apiObj: typeof recreatedContext) => Promise<void>)
      | undefined
    mocks.watch.mockImplementationOnce(async (_path, _options, callback) => {
      contextWatchCallback = callback
      return { abort: vi.fn() }
    })
    await (watcher as any).startContextWatch('recreated-context-rv')

    const convergence = (watcher as any).runInitialNetworkPolicyConvergence()
    await orphanCleanupStarted.promise
    const recreation = contextWatchCallback!('ADDED', recreatedContext)
    await flushMicrotasks()

    expect(netPol.reconcileContext).not.toHaveBeenCalled()

    releaseOrphanCleanup.resolve(undefined)
    await Promise.all([convergence, recreation])

    expect(order).toEqual(['orphan-delete', 'live-recreate'])
    expect(netPol.reconcileContext).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: contextName,
        spec: expect.objectContaining({ contextId, description: 'recreated' }),
      }),
      expect.objectContaining({ isCurrent: expect.any(Function) })
    )
    await watcher.stop()
  })

  it('retires old contextId policies before reconciling a mutable Context identity', async () => {
    const oldContext = {
      name: 'mutable-context-resource',
      namespace: 'mcp-server',
      spec: {
        contextId: 'old-context-id',
        mcpServers: ['redis-tools'],
      },
    }
    const newContext = {
      metadata: { name: oldContext.name, namespace: oldContext.namespace },
      spec: {
        contextId: 'new-context-id',
        mcpServers: ['redis-tools'],
      },
    }
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'contexts') {
        return {
          metadata: { resourceVersion: 'mutable-context-rv' },
          items: [newContext],
        }
      }
      return { items: [] }
    })
    let contextWatchCallback:
      | ((type: string, apiObj: typeof newContext) => Promise<void>)
      | undefined
    mocks.watch.mockImplementationOnce(async (_path, _options, callback) => {
      contextWatchCallback = callback
      return { abort: vi.fn() }
    })
    const watcher = new McpServerWatcher()
    ;(watcher as any).contexts.set(oldContext.name, oldContext)
    ;(watcher as any).contextCacheSynced = true
    const netPol = (watcher as any).netPolReconciler
    const order: string[] = []
    netPol.reconcileDeleteContext.mockImplementation(async (contextId: string) => {
      order.push(`delete:${contextId}`)
    })
    netPol.reconcileContext.mockImplementation(async (context: typeof oldContext) => {
      order.push(`reconcile:${context.spec.contextId}`)
    })
    await (watcher as any).startContextWatch('mutable-context-rv')

    await contextWatchCallback!('MODIFIED', newContext)

    expect(order).toEqual(['delete:old-context-id', 'reconcile:new-context-id'])
    expect(netPol.reconcileDeleteContext).toHaveBeenCalledWith(
      'old-context-id',
      expect.any(Function)
    )
    await watcher.stop()
  })

  it('retires queued Context policy work immediately when its watch ends', async () => {
    const context = {
      metadata: { name: 'retired-context-resource', namespace: 'mcp-server' },
      spec: { contextId: 'retired-context-id', mcpServers: [] },
    }
    const blockerStarted = deferred()
    const releaseBlocker = deferred()
    let contextWatchCallback: ((type: string, apiObj: typeof context) => Promise<void>) | undefined
    let contextWatchDone: ((error: Error | null) => void) | undefined
    mocks.watch.mockImplementationOnce(async (_path, _options, callback, done) => {
      contextWatchCallback = callback
      contextWatchDone = done
      return { abort: vi.fn() }
    })
    const watcher = new McpServerWatcher()
    const netPol = (watcher as any).netPolReconciler
    await (watcher as any).startContextWatch('retired-context-rv')
    const blocker = (watcher as any).enqueueContextReconciliation(
      context.spec.contextId,
      async () => {
        blockerStarted.resolve(undefined)
        await releaseBlocker.promise
      }
    )
    await blockerStarted.promise

    const event = contextWatchCallback!('MODIFIED', context)
    contextWatchDone!(null)
    releaseBlocker.resolve(undefined)
    await Promise.all([blocker, event])

    expect(netPol.reconcileContext).not.toHaveBeenCalled()
    await watcher.stop()
  })

  it('serializes McpServer-driven Context policy work with a newer Context watch revision', async () => {
    const server = {
      metadata: {
        name: 'context-policy-server',
        namespace: 'mcp-server',
        uid: 'context-policy-server-uid',
        generation: 1,
      },
      spec: {
        contextRef: 'context-policy',
        image: 'clerum/context-policy-server:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
      },
    }
    const oldContext = {
      name: 'context-policy-resource',
      namespace: 'mcp-server',
      spec: {
        contextId: 'context-policy',
        description: 'old',
        mcpServers: [server.metadata.name],
      },
    }
    const newContext = {
      metadata: { name: oldContext.name, namespace: oldContext.namespace },
      spec: {
        ...oldContext.spec,
        description: 'new',
      },
    }
    const oldStarted = deferred()
    const releaseOld = deferred()
    const order: string[] = []
    let oldLease: (() => boolean) | undefined
    let contextWatchCallback:
      | ((type: string, apiObj: typeof newContext) => Promise<void>)
      | undefined
    mocks.watch.mockImplementationOnce(async (_path, _options, callback) => {
      contextWatchCallback = callback
      return { abort: vi.fn() }
    })
    const watcher = new McpServerWatcher()
    ;(watcher as any).contexts.set(oldContext.name, oldContext)
    const netPol = (watcher as any).netPolReconciler
    netPol.reconcileContext.mockImplementation(
      async (context: typeof oldContext, options: { isCurrent: () => boolean }) => {
        if (context.spec.description === 'old') {
          oldLease = options.isCurrent
          oldStarted.resolve(undefined)
          await releaseOld.promise
          order.push('old')
          return
        }
        order.push('new')
      }
    )
    await (watcher as any).startContextWatch('context-policy-rv')

    const serverEvent = (watcher as any).getMcpServerWatchCallback()('MODIFIED', server)
    await oldStarted.promise
    const contextEvent = contextWatchCallback!('MODIFIED', newContext)
    await flushMicrotasks()

    expect(netPol.reconcileContext).toHaveBeenCalledTimes(1)
    expect(oldLease?.()).toBe(false)
    releaseOld.resolve(undefined)
    await Promise.all([serverEvent, contextEvent])

    expect(order).toEqual(['old', 'new'])
    expect(netPol.reconcileContext).toHaveBeenLastCalledWith(
      expect.objectContaining({
        spec: expect.objectContaining({ description: 'new' }),
      }),
      expect.objectContaining({ isCurrent: expect.any(Function) })
    )
    await watcher.stop()
  })

  it('retires a blocked Context policy lease when MODIFIED replaces it in the same watch', async () => {
    const oldContext = {
      metadata: { name: 'same-stream-context', namespace: 'mcp-server' },
      spec: {
        contextId: 'same-stream-context',
        description: 'old',
        mcpServers: ['old-server'],
      },
    }
    const newContext = {
      metadata: oldContext.metadata,
      spec: {
        ...oldContext.spec,
        description: 'new',
        mcpServers: ['new-server'],
      },
    }
    const mutationStarted = deferred()
    const releaseMutation = deferred()
    let oldLease: (() => boolean) | undefined
    let contextWatchCallback:
      | ((type: string, apiObj: typeof oldContext) => Promise<void>)
      | undefined
    mocks.watch.mockImplementationOnce(async (_path, _options, callback) => {
      contextWatchCallback = callback
      return { abort: vi.fn() }
    })
    const watcher = new McpServerWatcher()
    const netPol = (watcher as any).netPolReconciler
    netPol.reconcileContext.mockImplementationOnce(
      async (_context: unknown, options: { isCurrent: () => boolean }) => {
        oldLease = options.isCurrent
        mutationStarted.resolve()
        await releaseMutation.promise
      }
    )
    await (watcher as any).startContextWatch('same-stream-context-rv')
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true

    const oldReconcile = contextWatchCallback!('MODIFIED', oldContext)
    await mutationStarted.promise
    expect(oldLease?.()).toBe(true)

    const newReconcile = contextWatchCallback!('MODIFIED', newContext)
    expect(oldLease?.()).toBe(false)

    releaseMutation.resolve()
    await Promise.all([oldReconcile, newReconcile])
    await watcher.stop()
  })

  it('keeps live control-plane events responsive during a periodic external-egress fleet resync', async () => {
    const server = {
      name: 'periodic-egress-server',
      namespace: 'mcp-server',
      uid: 'periodic-egress-uid',
      generation: 1,
      spec: {
        contextRef: 'default',
        image: 'clerum/periodic-egress:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
        egressBindings: [{ dns: 'periodic.example', port: 443 }],
      },
    }
    const context = {
      metadata: { name: 'live-context', namespace: 'mcp-server' },
      spec: { contextId: 'live-context', mcpServers: [] },
    }
    const resyncStarted = deferred()
    const releaseResync = deferred()
    let contextWatchCallback: ((type: string, apiObj: typeof context) => Promise<void>) | undefined
    mocks.watch.mockImplementationOnce(async (_path, _options, callback) => {
      contextWatchCallback = callback
      return { abort: vi.fn() }
    })
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const watcher = new McpServerWatcher()
    markMcpServerInventoryAuthoritative(watcher)
    ;(watcher as any).servers.set(server.name, server)
    const netPol = (watcher as any).netPolReconciler
    netPol.reconcileExternalEgress.mockImplementationOnce(async () => {
      resyncStarted.resolve(undefined)
      await releaseResync.promise
    })
    await (watcher as any).startContextWatch('live-context-rv')

    const firstResync = (watcher as any).externalEgressCoordinator.runResync() as Promise<void>
    const overlappingResync = (
      watcher as any
    ).externalEgressCoordinator.runResync() as Promise<void>
    expect(overlappingResync).toBe(firstResync)
    await resyncStarted.promise

    const liveEvent = contextWatchCallback!('MODIFIED', context)
    await flushMicrotasks()
    expect(netPol.reconcileContext).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'live-context' }),
      expect.objectContaining({ isCurrent: expect.any(Function) })
    )

    releaseResync.resolve(undefined)
    await Promise.all([firstResync, liveEvent])
    await watcher.stop()
    randomSpy.mockRestore()
  })

  it('retires a blocked periodic egress lease when MODIFIED replaces it in the same watch', async () => {
    const oldServer = {
      name: 'same-stream-egress',
      namespace: 'mcp-server',
      uid: 'same-stream-egress-uid',
      generation: 1,
      spec: {
        contextRef: 'default',
        image: 'clerum/same-stream-egress:old',
        transport: { type: 'streamableHttp' as const, port: 3000 },
        egressBindings: [{ dns: 'old.example', port: 443 }],
      },
    }
    const newServer = {
      metadata: {
        name: oldServer.name,
        namespace: oldServer.namespace,
        uid: oldServer.uid,
        generation: 2,
      },
      spec: {
        ...oldServer.spec,
        image: 'clerum/same-stream-egress:new',
        egressBindings: [{ dns: 'new.example', port: 443 }],
      },
    }
    const mutationStarted = deferred()
    const releaseMutation = deferred()
    let oldLease: (() => boolean) | undefined
    const watcher = new McpServerWatcher()
    markMcpServerInventoryAuthoritative(watcher)
    ;(watcher as any).servers.set(oldServer.name, oldServer)
    const netPol = (watcher as any).netPolReconciler
    netPol.reconcileExternalEgress.mockImplementationOnce(
      async (_server: unknown, options: { isCurrent: () => boolean }) => {
        oldLease = options.isCurrent
        mutationStarted.resolve()
        await releaseMutation.promise
      }
    )
    vi.spyOn(Math, 'random').mockReturnValue(0)

    const periodic = (watcher as any).externalEgressCoordinator.runResync() as Promise<void>
    await mutationStarted.promise
    expect(oldLease?.()).toBe(true)

    const replacement = (watcher as any).getMcpServerWatchCallback()('MODIFIED', newServer)
    expect(oldLease?.()).toBe(false)

    releaseMutation.resolve()
    await Promise.all([periodic, replacement])
    await watcher.stop()
  })

  it('uses the latest cached McpServer after periodic external-egress jitter', async () => {
    vi.useFakeTimers()
    const staleServer = {
      name: 'periodic-egress-server',
      namespace: 'mcp-server',
      uid: 'periodic-egress-uid',
      generation: 1,
      spec: {
        contextRef: 'default',
        image: 'clerum/periodic-egress:old',
        transport: { type: 'streamableHttp' as const, port: 3000 },
        egressBindings: [{ dns: 'old.example', port: 443 }],
      },
    }
    const currentServer = {
      metadata: {
        name: staleServer.name,
        namespace: staleServer.namespace,
        uid: staleServer.uid,
        generation: 2,
      },
      spec: {
        ...staleServer.spec,
        image: 'clerum/periodic-egress:new',
        egressBindings: [{ dns: 'new.example', port: 443 }],
      },
    }
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const watcher = new McpServerWatcher()
    ;(watcher as any).servers.set(staleServer.name, staleServer)
    const netPol = (watcher as any).netPolReconciler

    const periodic = (watcher as any).externalEgressCoordinator.runResync() as Promise<void>
    await flushMicrotasks()
    await (watcher as any).getMcpServerWatchCallback()('MODIFIED', currentServer)
    await vi.advanceTimersByTimeAsync(2500)
    await periodic

    expect(netPol.reconcileExternalEgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: staleServer.name,
        generation: 2,
        spec: expect.objectContaining({
          egressBindings: [{ dns: 'new.example', port: 443 }],
        }),
      }),
      { isCurrent: expect.any(Function) }
    )
    await watcher.stop()
    randomSpy.mockRestore()
  })

  it('queues same-object SharedFileSystem and GlobalFileSystem watch effects behind initial passes', async () => {
    const staleSfs = { name: 'stale-sfs', namespace: 'mcp-host', spec: {} }
    const currentSfs = { metadata: { name: 'stale-sfs', namespace: 'mcp-host' }, spec: {} }
    const staleGfs = { name: 'stale-gfs', namespace: 'mcp-host', spec: {} }
    const currentGfs = {
      metadata: { name: 'stale-gfs', namespace: 'mcp-host' },
      spec: {},
      status: {
        phase: 'Ready',
        pvcName: 'gfs-drive',
        serviceName: 'gfsc',
        serviceUrl: 'http://gfsc.gfs.svc.cluster.local:8087',
      },
    }
    const sfsInitialStarted = deferred()
    const releaseSfsInitial = deferred()
    const gfsInitialStarted = deferred()
    const releaseGfsInitial = deferred()
    const sfsOrder: string[] = []
    const gfsOrder: string[] = []
    const watcher = new McpServerWatcher()
    ;(watcher as any).sharedFileSystems.set(staleSfs.name, staleSfs)
    ;(watcher as any).globalFileSystems.set(staleGfs.name, staleGfs)

    mocks.sfsFullReconcile.mockImplementationOnce(async () => {
      sfsInitialStarted.resolve(undefined)
      await releaseSfsInitial.promise
      sfsOrder.push('initial')
    })
    const sfsReconciler = (watcher as any).sharedFileSystemReconciler
    sfsReconciler.reconcile.mockImplementationOnce(async () => {
      sfsOrder.push('watch')
    })
    const gfsReconciler = (watcher as any).gfsReconciler
    vi.spyOn(gfsReconciler, 'fullReconcile').mockImplementationOnce(async () => {
      gfsInitialStarted.resolve(undefined)
      await releaseGfsInitial.promise
      gfsOrder.push('initial')
    })
    const gfsReconcile = vi.spyOn(gfsReconciler, 'reconcile').mockImplementationOnce(async () => {
      gfsOrder.push('watch')
    })

    let sfsWatchCallback: ((type: string, apiObj: typeof currentSfs) => Promise<void>) | undefined
    let gfsWatchCallback: ((type: string, apiObj: typeof currentGfs) => Promise<void>) | undefined
    mocks.watch
      .mockImplementationOnce(async (_path, _options, callback) => {
        sfsWatchCallback = callback
        return { abort: vi.fn() }
      })
      .mockImplementationOnce(async (_path, _options, callback) => {
        gfsWatchCallback = callback
        return { abort: vi.fn() }
      })
    await (watcher as any).startSharedFileSystemWatch()
    await (watcher as any).startGlobalFileSystemWatch()

    const sfsInitial = (watcher as any).runInitialSharedFileSystemConvergence()
    const gfsInitial = (watcher as any).runInitialGlobalFileSystemConvergence()
    await Promise.all([sfsInitialStarted.promise, gfsInitialStarted.promise])
    const sfsWatch = sfsWatchCallback!('MODIFIED', currentSfs)
    const gfsWatch = gfsWatchCallback!('MODIFIED', currentGfs)

    await flushMicrotasks()
    expect(sfsReconciler.reconcile).not.toHaveBeenCalled()
    expect(gfsReconcile).not.toHaveBeenCalled()

    releaseSfsInitial.resolve(undefined)
    releaseGfsInitial.resolve(undefined)
    await Promise.all([sfsInitial, gfsInitial, sfsWatch, gfsWatch])

    expect(sfsOrder).toEqual(['initial', 'watch'])
    expect(gfsOrder).toEqual(['initial', 'watch'])
    expect(gfsReconcile).toHaveBeenCalledWith(
      expect.objectContaining({ status: currentGfs.status })
    )
    await watcher.stop()
  })

  it('does not let a periodic SFS or GFS inventory overwrite a newer watch cache entry', async () => {
    const staleSfs = { metadata: { name: 'stale-sfs', namespace: 'mcp-host' }, spec: {} }
    const currentSfs = { metadata: { name: 'current-sfs', namespace: 'mcp-host' }, spec: {} }
    const staleGfs = { metadata: { name: 'stale-gfs', namespace: 'mcp-host' }, spec: {} }
    const currentGfs = { metadata: { name: 'current-gfs', namespace: 'mcp-host' }, spec: {} }
    const sfsListStarted = deferred()
    const releaseSfsList = deferred<unknown>()
    const gfsListStarted = deferred()
    const releaseGfsList = deferred<unknown>()
    const watcher = new McpServerWatcher()
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'sharedfilesystems') {
        sfsListStarted.resolve(undefined)
        return releaseSfsList.promise
      }
      if (plural === 'globalfilesystems') {
        gfsListStarted.resolve(undefined)
        return releaseGfsList.promise
      }
      return { items: [] }
    })
    const gfsReconciler = (watcher as any).gfsReconciler
    vi.spyOn(gfsReconciler, 'fullReconcile').mockResolvedValue(undefined)

    let sfsWatchCallback: ((type: string, apiObj: typeof currentSfs) => Promise<void>) | undefined
    let gfsWatchCallback: ((type: string, apiObj: typeof currentGfs) => Promise<void>) | undefined
    mocks.watch
      .mockImplementationOnce(async (_path, _options, callback) => {
        sfsWatchCallback = callback
        return { abort: vi.fn() }
      })
      .mockImplementationOnce(async (_path, _options, callback) => {
        gfsWatchCallback = callback
        return { abort: vi.fn() }
      })
    await (watcher as any).startSharedFileSystemWatch()
    await (watcher as any).startGlobalFileSystemWatch()

    const sfsResync = (watcher as any).runSfsResync()
    const gfsResync = (watcher as any).runGfsResync()
    await Promise.all([sfsListStarted.promise, gfsListStarted.promise])
    const sfsWatch = sfsWatchCallback!('MODIFIED', currentSfs)
    const gfsWatch = gfsWatchCallback!('MODIFIED', currentGfs)
    releaseSfsList.resolve({ items: [staleSfs] })
    releaseGfsList.resolve({ items: [staleGfs] })
    await Promise.all([sfsResync, gfsResync, sfsWatch, gfsWatch])

    expect(mocks.sfsFullReconcile).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'current-sfs' }),
    ])
    expect(gfsReconciler.fullReconcile).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'current-gfs' }),
    ])
    expect((watcher as any).sharedFileSystems.get('current-sfs')).toEqual(
      expect.objectContaining({ name: 'current-sfs' })
    )
    expect((watcher as any).sharedFileSystems.has('stale-sfs')).toBe(false)
    expect((watcher as any).globalFileSystems.get('current-gfs')).toEqual(
      expect.objectContaining({ name: 'current-gfs' })
    )
    expect((watcher as any).globalFileSystems.has('stale-gfs')).toBe(false)
    await watcher.stop()
  })

  it('refreshes SFS and GFS caches and effects from an uncontested periodic inventory', async () => {
    const listedSfs = {
      metadata: { name: 'listed-sfs', namespace: 'mcp-host' },
      spec: { capacity: '1Gi' },
    }
    const listedGfs = {
      metadata: { name: 'listed-gfs', namespace: 'gfs' },
      spec: { capacity: '10Gi' },
    }
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'sharedfilesystems') return { items: [listedSfs] }
      if (plural === 'globalfilesystems') return { items: [listedGfs] }
      return { items: [] }
    })
    const watcher = new McpServerWatcher()
    const gfsReconciler = (watcher as any).gfsReconciler
    const gfsFullReconcile = vi.spyOn(gfsReconciler, 'fullReconcile').mockResolvedValue(undefined)

    await Promise.all([(watcher as any).runSfsResync(), (watcher as any).runGfsResync()])

    expect((watcher as any).sharedFileSystems.get('listed-sfs')).toEqual(
      expect.objectContaining({ name: 'listed-sfs', spec: listedSfs.spec })
    )
    expect((watcher as any).globalFileSystems.get('listed-gfs')).toEqual(
      expect.objectContaining({ name: 'listed-gfs', spec: listedGfs.spec })
    )
    expect(mocks.sfsFullReconcile).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'listed-sfs', spec: listedSfs.spec }),
    ])
    expect(gfsFullReconcile).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'listed-gfs', spec: listedGfs.spec }),
    ])
    await watcher.stop()
  })

  it('does not run queued fleet effects after the watcher stops', async () => {
    const initialServer = {
      name: 'initial-server',
      namespace: 'mcp-server',
      spec: {
        contextRef: 'default',
        image: 'clerum/initial-server:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
        egressBindings: [{ dns: 'initial.example', port: 443 }],
      },
    }
    const queuedServer = {
      metadata: { name: 'queued-server', namespace: 'mcp-server' },
      spec: {
        contextRef: 'default',
        image: 'clerum/queued-server:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
      },
    }
    const egressStarted = deferred()
    const releaseEgress = deferred()
    const watcher = new McpServerWatcher()
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).contextCacheSynced = true
    markNetworkPolicyRevocationAuthoritative(watcher)
    ;(watcher as any).servers.set(initialServer.name, initialServer)
    const netPol = (watcher as any).netPolReconciler
    netPol.reconcileExternalEgress.mockImplementationOnce(async () => {
      egressStarted.resolve(undefined)
      await releaseEgress.promise
    })
    const reconciler = (watcher as any).reconciler
    mocks.serverFullReconcile.mockImplementationOnce(async (servers, options) => {
      await Promise.all(
        servers.map((selected: { name: string }) =>
          options.runEffect(selected.name, () => reconciler.reconcile(selected))
        )
      )
    })

    const initial = (watcher as any).runInitialMcpServerConvergence()
    await egressStarted.promise
    const queuedWatch = (watcher as any).getMcpServerWatchCallback()('MODIFIED', queuedServer)

    await watcher.stop()
    releaseEgress.resolve(undefined)
    await Promise.all([initial, queuedWatch])

    expect(mocks.serverFullReconcile).toHaveBeenCalledOnce()
    expect(reconciler.reconcile).not.toHaveBeenCalled()
  })

  it('coalesces overlapping McpServer fleet passes into one trailing current-cache pass', async () => {
    const firstPassStarted = deferred()
    const releaseFirstPass = deferred()
    const snapshots: string[][] = []
    const watcher = new McpServerWatcher()
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).contextCacheSynced = true
    markNetworkPolicyRevocationAuthoritative(watcher)
    ;(watcher as any).servers.set('first-server', {
      name: 'first-server',
      namespace: 'mcp-server',
      spec: {
        contextRef: 'default',
        image: 'clerum/first-server:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
      },
    })
    mocks.serverFullReconcile
      .mockImplementationOnce(async (servers: Array<{ name: string }>) => {
        snapshots.push(servers.map(server => server.name))
        firstPassStarted.resolve(undefined)
        await releaseFirstPass.promise
      })
      .mockImplementationOnce(async (servers: Array<{ name: string }>) => {
        snapshots.push(servers.map(server => server.name))
      })

    const first = (watcher as any).runInitialMcpServerConvergence()
    await firstPassStarted.promise
    ;(watcher as any).servers.set('second-server', {
      name: 'second-server',
      namespace: 'mcp-server',
      spec: {
        contextRef: 'default',
        image: 'clerum/second-server:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
      },
    })
    const second = (watcher as any).runInitialMcpServerConvergence()
    const third = (watcher as any).runInitialMcpServerConvergence()

    expect(mocks.serverFullReconcile).toHaveBeenCalledTimes(1)
    releaseFirstPass.resolve(undefined)
    await Promise.all([first, second, third])

    expect(mocks.serverFullReconcile).toHaveBeenCalledTimes(2)
    expect(snapshots).toEqual([['first-server'], ['first-server', 'second-server']])
    await watcher.stop()
  })

  it('coalesces overlapping NetworkPolicy fleet passes into one trailing current-cache pass', async () => {
    const firstPassStarted = deferred()
    const releaseFirstPass = deferred()
    const snapshots: string[][] = []
    const watcher = new McpServerWatcher()
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).contexts.set('first-context', {
      name: 'first-context',
      namespace: 'mcp-server',
      spec: { contextId: 'first-context', mcpServers: [] },
    })
    mocks.netPolFullReconcile
      .mockImplementationOnce(async (contexts: Array<{ name: string }>) => {
        snapshots.push(contexts.map(context => context.name))
        firstPassStarted.resolve(undefined)
        await releaseFirstPass.promise
      })
      .mockImplementationOnce(async (contexts: Array<{ name: string }>) => {
        snapshots.push(contexts.map(context => context.name))
      })

    const first = (watcher as any).runInitialNetworkPolicyConvergence()
    await firstPassStarted.promise
    ;(watcher as any).contexts.set('second-context', {
      name: 'second-context',
      namespace: 'mcp-server',
      spec: { contextId: 'second-context', mcpServers: [] },
    })
    const second = (watcher as any).runInitialNetworkPolicyConvergence()
    const third = (watcher as any).runInitialNetworkPolicyConvergence()

    expect(mocks.netPolFullReconcile).toHaveBeenCalledTimes(1)
    releaseFirstPass.resolve(undefined)
    await Promise.all([first, second, third])

    expect(mocks.netPolFullReconcile).toHaveBeenCalledTimes(2)
    expect(snapshots).toEqual([['first-context'], ['first-context', 'second-context']])
    await watcher.stop()
  })

  it('does not lose an initial convergence request queued in the settlement microtask', async () => {
    const watcher = new McpServerWatcher()
    let trailing: Promise<void> | undefined
    const convergenceCore = vi
      .fn()
      .mockImplementationOnce(
        () =>
          ({
            then: (resolve: () => void) => {
              resolve()
              queueMicrotask(() => {
                trailing = (watcher as any).runInitialMcpServerConvergence()
              })
            },
          }) as PromiseLike<void>
      )
      .mockResolvedValueOnce(undefined)
    ;(watcher as any).runInitialMcpServerConvergenceCore = convergenceCore

    const first = (watcher as any).runInitialMcpServerConvergence()
    await first
    await vi.waitFor(() => expect(trailing).toBeDefined())
    await trailing

    expect(convergenceCore).toHaveBeenCalledTimes(2)
    await watcher.stop()
  })

  it('retains one keyed queue until every same-key waiter has drained', async () => {
    const watcher = new McpServerWatcher()
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const effects: string[] = []
    const queues = (watcher as any).contextReconciliationQueues as Map<
      string,
      { references: number }
    >

    const first = (watcher as any).enqueueContextReconciliation('shared', async () => {
      effects.push('first')
      firstStarted.resolve(undefined)
      await releaseFirst.promise
    })
    await firstStarted.promise
    const second = (watcher as any).enqueueContextReconciliation('shared', async () => {
      effects.push('second')
    })

    expect(queues.get('shared')?.references).toBe(2)
    expect(effects).toEqual(['first'])
    releaseFirst.resolve(undefined)
    await Promise.all([first, second])
    expect(effects).toEqual(['first', 'second'])
    expect(queues.size).toBe(0)
    await watcher.stop()
  })

  it('does not execute newly enqueued keyed work after stop', async () => {
    const watcher = new McpServerWatcher()
    const work = vi.fn()
    ;(watcher as any).stopped = true

    await (watcher as any).enqueueContextReconciliation('stopped', work)

    expect(work).not.toHaveBeenCalled()
    expect((watcher as any).contextReconciliationQueues.size).toBe(0)
  })

  it('acquires multi-context identity keys in one deterministic sorted order', async () => {
    const watcher = new McpServerWatcher()
    const acquired: string[] = []
    vi.spyOn(watcher as any, 'enqueueContextReconciliation').mockImplementation(
      async (...args: unknown[]) => {
        const [key, work] = args as [string, () => Promise<void>]
        acquired.push(key)
        await work()
      }
    )

    await (watcher as any).enqueueContextIdentityReconciliation(
      ['z-context', 'a-context', 'm-context', 'z-context'],
      async () => undefined
    )

    expect(acquired).toEqual(['a-context', 'm-context', 'z-context'])
    await watcher.stop()
  })

  it('fences an McpServer fleet pass when its LIST-to-WATCH authority is retired', async () => {
    const egressStarted = deferred()
    const releaseEgress = deferred()
    const watcher = new McpServerWatcher()
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpWatchGeneration = 7
    markNetworkPolicyRevocationAuthoritative(watcher)
    ;(watcher as any).initialConvergenceRetryAttempts.set('McpServer', 3)
    ;(watcher as any).servers.set('stale-server', {
      name: 'stale-server',
      namespace: 'mcp-server',
      generation: 1,
      spec: {
        contextRef: 'default',
        image: 'clerum/stale-server:v1',
        transport: { type: 'streamableHttp' as const, port: 3000 },
        egressBindings: [{ dns: 'stale.example', port: 443 }],
      },
    })
    const netPol = (watcher as any).netPolReconciler
    const reconciler = (watcher as any).reconciler
    netPol.reconcileExternalEgress.mockImplementationOnce(async () => {
      egressStarted.resolve(undefined)
      await releaseEgress.promise
    })
    mocks.serverFullReconcile.mockImplementation(async (servers, options) => {
      await Promise.all(
        servers.map((selected: { name: string }) =>
          options.runEffect(selected.name, () => reconciler.reconcile(selected))
        )
      )
    })

    const stalePass = (watcher as any).runInitialMcpServerConvergence()
    await egressStarted.promise
    ;(watcher as any).mcpServerCacheSynced = false
    ;(watcher as any).mcpWatchGeneration = 8
    const trailing = (watcher as any).runInitialMcpServerConvergence()
    releaseEgress.resolve(undefined)
    await Promise.all([stalePass, trailing])

    expect(reconciler.reconcile).not.toHaveBeenCalled()
    expect((watcher as any).initialConvergenceRetryAttempts.get('McpServer')).toBe(3)
    ;(watcher as any).servers.set('stale-server', {
      name: 'stale-server',
      namespace: 'mcp-server',
      generation: 2,
      spec: {
        contextRef: 'default',
        image: 'clerum/stale-server:v2',
        transport: { type: 'streamableHttp' as const, port: 3000 },
        egressBindings: [{ dns: 'current.example', port: 443 }],
      },
    })
    ;(watcher as any).mcpServerCacheSynced = true
    markNetworkPolicyRevocationAuthoritative(watcher)
    await (watcher as any).runInitialMcpServerConvergence()

    expect(reconciler.reconcile).toHaveBeenCalledOnce()
    expect(reconciler.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 2,
        spec: expect.objectContaining({ image: 'clerum/stale-server:v2' }),
      })
    )
    expect((watcher as any).initialConvergenceRetryAttempts.has('McpServer')).toBe(false)
    await watcher.stop()
  })

  it('fences NetworkPolicy positive effects when their inventory leases are retired', async () => {
    const firstPassStarted = deferred()
    const releaseFirstPass = deferred()
    const appliedContexts: string[] = []
    const appliedServers: string[] = []
    let pass = 0
    const watcher = new McpServerWatcher()
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).contextWatchGeneration = 11
    ;(watcher as any).mcpWatchGeneration = 13
    ;(watcher as any).initialConvergenceRetryAttempts.set('NetworkPolicy', 4)
    ;(watcher as any).contexts.set('stale-context', {
      name: 'stale-context',
      namespace: 'mcp-server',
      spec: { contextId: 'stale-context', mcpServers: ['stale-server'] },
    })
    ;(watcher as any).servers.set('stale-server', {
      name: 'stale-server',
      namespace: 'mcp-server',
      spec: {
        contextRef: 'stale-context',
        image: 'clerum/stale-server:v1',
        transport: { type: 'streamableHttp' as const, port: 3000 },
      },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const successTimestampBefore = await readInitialConvergenceMetric(
      'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
      'NetworkPolicy'
    )
    const swallowedBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_swallowed_total',
      { lane: 'NetworkPolicy', sink: 'authority-lost' }
    )
    const abortedBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_pass_results_total',
      { lane: 'NetworkPolicy', result: 'aborted-authority' }
    )
    const droppedBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_effects_dropped_total',
      { lane: 'NetworkPolicy', kind: 'context' }
    )
    mocks.netPolFullReconcile.mockImplementation(async (contexts, servers, options) => {
      pass += 1
      if (pass === 1) {
        firstPassStarted.resolve(undefined)
        await releaseFirstPass.promise
      }
      await Promise.all(
        contexts.map((context: { spec: { contextId: string } }) =>
          options.runContextEffect(context.spec.contextId, async () => {
            appliedContexts.push(context.spec.contextId)
          })
        )
      )
      await Promise.all(
        servers.map((server: { name: string }) =>
          options.runServerEffect(server.name, async () => {
            appliedServers.push(server.name)
          })
        )
      )
    })

    const stalePass = (watcher as any).runInitialNetworkPolicyConvergence()
    await firstPassStarted.promise
    ;(watcher as any).contextCacheSynced = false
    ;(watcher as any).mcpServerCacheSynced = false
    ;(watcher as any).contextWatchGeneration = 12
    ;(watcher as any).mcpWatchGeneration = 14
    const trailing = (watcher as any).runInitialNetworkPolicyConvergence()
    releaseFirstPass.resolve(undefined)
    await Promise.all([stalePass, trailing])

    expect(appliedContexts).toEqual([])
    expect(appliedServers).toEqual([])
    expect(
      warnSpy.mock.calls.some(call =>
        String(call[0]).includes('pass ended without certifying: inventory authority lost')
      )
    ).toBe(true)
    expect((watcher as any).initialConvergenceRetryAttempts.get('NetworkPolicy')).toBe(5)
    expect((watcher as any).initialConvergenceRetryTimers.has('NetworkPolicy')).toBe(true)
    expect(
      await readInitialConvergenceMetric(
        'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
        'NetworkPolicy'
      )
    ).toBe(successTimestampBefore)
    expect(
      await readLabeledConvergenceMetric('clerum_hcc_initial_convergence_swallowed_total', {
        lane: 'NetworkPolicy',
        sink: 'authority-lost',
      })
    ).toBe(swallowedBefore + 1)
    expect(
      await readLabeledConvergenceMetric('clerum_hcc_initial_convergence_pass_results_total', {
        lane: 'NetworkPolicy',
        result: 'aborted-authority',
      })
    ).toBe(abortedBefore + 1)
    expect(
      await readLabeledConvergenceMetric('clerum_hcc_initial_convergence_effects_dropped_total', {
        lane: 'NetworkPolicy',
        kind: 'context',
      })
    ).toBe(droppedBefore + 1)
    const authorityServer = new ContextMapperServer(watcher, 0, undefined, undefined, () =>
      watcher.isReadinessInventoryAuthoritative()
    )
    await authorityServer.start()
    authorityServer.setReady(true)
    try {
      const scraped = await requestMetricsOverHttp(authorityServer)
      expect(scraped.statusCode).toBe(200)
      expect(
        readPromTextMetric(scraped.body, 'clerum_hcc_initial_convergence_swallowed_total', {
          lane: 'NetworkPolicy',
          sink: 'authority-lost',
        })
      ).toBe(swallowedBefore + 1)
      expect(
        readPromTextMetric(scraped.body, 'clerum_hcc_initial_convergence_pass_results_total', {
          lane: 'NetworkPolicy',
          result: 'aborted-authority',
        })
      ).toBe(abortedBefore + 1)
      expect(
        readPromTextMetric(
          scraped.body,
          'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
          { lane: 'NetworkPolicy' }
        )
      ).toBe(successTimestampBefore)
      expect((await requestReadyOverHttp(authorityServer)).statusCode).toBe(503)
    } finally {
      await authorityServer.stop()
    }
    ;(watcher as any).contexts.clear()
    ;(watcher as any).servers.clear()
    ;(watcher as any).contexts.set('current-context', {
      name: 'current-context',
      namespace: 'mcp-server',
      spec: { contextId: 'current-context', mcpServers: ['current-server'] },
    })
    ;(watcher as any).servers.set('current-server', {
      name: 'current-server',
      namespace: 'mcp-server',
      spec: {
        contextRef: 'current-context',
        image: 'clerum/current-server:v2',
        transport: { type: 'streamableHttp' as const, port: 3000 },
      },
    })
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true
    await (watcher as any).runInitialNetworkPolicyConvergence()

    expect(appliedContexts).toEqual(['current-context'])
    expect(appliedServers).toEqual(['current-server'])
    expect((watcher as any).initialConvergenceRetryAttempts.has('NetworkPolicy')).toBe(false)
    expect(
      await readInitialConvergenceMetric(
        'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
        'NetworkPolicy'
      )
    ).toBeGreaterThan(successTimestampBefore)
    warnSpy.mockRestore()
    await watcher.stop()
  })

  it('G1: certifies a NetworkPolicy pass when only watch generations recycle mid-flight', async () => {
    const firstPassStarted = deferred()
    const releaseFirstPass = deferred()
    const appliedContexts: string[] = []
    const appliedServers: string[] = []
    let offeredContextEffects = 0
    let offeredServerEffects = 0
    const watcher = new McpServerWatcher()
    seedNetworkPolicyPassInventory(watcher)
    ;(watcher as any).initialConvergenceRetryAttempts.set('NetworkPolicy', 4)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const successTimestampBefore = await readInitialConvergenceMetric(
      'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
      'NetworkPolicy'
    )
    const swallowedBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_swallowed_total',
      { lane: 'NetworkPolicy', sink: 'authority-lost' }
    )
    const abortedBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_pass_results_total',
      { lane: 'NetworkPolicy', result: 'aborted-authority' }
    )
    const certifiedBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_pass_results_total',
      { lane: 'NetworkPolicy', result: 'certified' }
    )
    mocks.netPolFullReconcile.mockImplementation(async (contexts, servers, options) => {
      firstPassStarted.resolve(undefined)
      await releaseFirstPass.promise
      options.onAuthoritativeRevocationComplete?.()
      await Promise.all([
        ...contexts.map((context: { spec: { contextId: string } }) => {
          offeredContextEffects += 1
          return options.runContextEffect(context.spec.contextId, async () => {
            appliedContexts.push(context.spec.contextId)
          })
        }),
        ...servers.map((server: { name: string }) => {
          offeredServerEffects += 1
          return options.runServerEffect(server.name, async () => {
            appliedServers.push(server.name)
          })
        }),
      ])
    })

    const pass = (watcher as any).runInitialNetworkPolicyConvergence()
    await firstPassStarted.promise
    const contextRevision = (watcher as any).contextDesiredRevision
    const serverRevision = (watcher as any).mcpServerDesiredRevision
    ;(watcher as any).contextWatchGeneration += 2
    ;(watcher as any).mcpWatchGeneration += 2
    expect((watcher as any).contextCacheSynced).toBe(true)
    expect((watcher as any).mcpServerCacheSynced).toBe(true)
    expect((watcher as any).contextDesiredRevision).toBe(contextRevision)
    expect((watcher as any).mcpServerDesiredRevision).toBe(serverRevision)
    releaseFirstPass.resolve(undefined)
    await pass

    expect(offeredContextEffects).toBeGreaterThanOrEqual(1)
    expect(offeredServerEffects).toBeGreaterThanOrEqual(1)
    expect(appliedContexts).toEqual(['stale-context'])
    expect(appliedServers).toEqual(['stale-server'])
    expect(
      warnSpy.mock.calls.some(
        call => String(call[0]) === '[K8s] pass ended without certifying: inventory authority lost'
      )
    ).toBe(false)
    expect((watcher as any).initialConvergenceRetryAttempts.has('NetworkPolicy')).toBe(false)
    expect((watcher as any).initialConvergenceRetryTimers.has('NetworkPolicy')).toBe(false)
    expect(
      await readLabeledConvergenceMetric('clerum_hcc_initial_convergence_swallowed_total', {
        lane: 'NetworkPolicy',
        sink: 'authority-lost',
      })
    ).toBe(swallowedBefore)
    expect(
      await readLabeledConvergenceMetric('clerum_hcc_initial_convergence_pass_results_total', {
        lane: 'NetworkPolicy',
        result: 'aborted-authority',
      })
    ).toBe(abortedBefore)
    expect(
      await readLabeledConvergenceMetric('clerum_hcc_initial_convergence_pass_results_total', {
        lane: 'NetworkPolicy',
        result: 'certified',
      })
    ).toBe(certifiedBefore + 1)
    expect(
      await readInitialConvergenceMetric(
        'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
        'NetworkPolicy'
      )
    ).toBeGreaterThan(successTimestampBefore)
    warnSpy.mockRestore()
    await watcher.stop()
  })

  it('G2: aborts a NetworkPolicy pass when contextDesiredRevision advances mid-flight', async () => {
    const firstPassStarted = deferred()
    const releaseFirstPass = deferred()
    const watcher = new McpServerWatcher()
    seedNetworkPolicyPassInventory(watcher)
    ;(watcher as any).initialConvergenceRetryAttempts.set('NetworkPolicy', 4)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const successTimestampBefore = await readInitialConvergenceMetric(
      'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
      'NetworkPolicy'
    )
    const swallowedBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_swallowed_total',
      { lane: 'NetworkPolicy', sink: 'authority-lost' }
    )
    const abortedBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_pass_results_total',
      { lane: 'NetworkPolicy', result: 'aborted-authority' }
    )
    mocks.netPolFullReconcile.mockImplementation(async (_contexts, _servers, options) => {
      firstPassStarted.resolve(undefined)
      await releaseFirstPass.promise
      options.onAuthoritativeRevocationComplete?.()
    })

    const pass = (watcher as any).runInitialNetworkPolicyConvergence()
    await firstPassStarted.promise
    const generationBefore = (watcher as any).contextWatchGeneration
    ;(watcher as any).contextDesiredRevision += 1
    expect((watcher as any).contextWatchGeneration).toBe(generationBefore)
    releaseFirstPass.resolve(undefined)
    await pass

    expect(warnSpy).toHaveBeenCalledWith(
      '[K8s] pass ended without certifying: inventory authority lost',
      expect.objectContaining({
        contextMoved: true,
        serverMoved: false,
        contextCacheSynced: true,
        mcpServerCacheSynced: true,
      })
    )
    expect((watcher as any).initialConvergenceRetryAttempts.get('NetworkPolicy')).toBe(5)
    expect((watcher as any).initialConvergenceRetryTimers.has('NetworkPolicy')).toBe(true)
    expect(
      await readInitialConvergenceMetric(
        'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
        'NetworkPolicy'
      )
    ).toBe(successTimestampBefore)
    expect(
      await readLabeledConvergenceMetric('clerum_hcc_initial_convergence_swallowed_total', {
        lane: 'NetworkPolicy',
        sink: 'authority-lost',
      })
    ).toBe(swallowedBefore + 1)
    expect(
      await readLabeledConvergenceMetric('clerum_hcc_initial_convergence_pass_results_total', {
        lane: 'NetworkPolicy',
        result: 'aborted-authority',
      })
    ).toBe(abortedBefore + 1)
    warnSpy.mockRestore()
    await watcher.stop()
  })

  it('G3: aborts a NetworkPolicy pass when mcpServerDesiredRevision advances mid-flight', async () => {
    const firstPassStarted = deferred()
    const releaseFirstPass = deferred()
    const watcher = new McpServerWatcher()
    seedNetworkPolicyPassInventory(watcher)
    ;(watcher as any).initialConvergenceRetryAttempts.set('NetworkPolicy', 4)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const successTimestampBefore = await readInitialConvergenceMetric(
      'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
      'NetworkPolicy'
    )
    const swallowedBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_swallowed_total',
      { lane: 'NetworkPolicy', sink: 'authority-lost' }
    )
    const abortedBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_pass_results_total',
      { lane: 'NetworkPolicy', result: 'aborted-authority' }
    )
    mocks.netPolFullReconcile.mockImplementation(async (_contexts, _servers, options) => {
      firstPassStarted.resolve(undefined)
      await releaseFirstPass.promise
      options.onAuthoritativeRevocationComplete?.()
    })

    const pass = (watcher as any).runInitialNetworkPolicyConvergence()
    await firstPassStarted.promise
    const generationBefore = (watcher as any).mcpWatchGeneration
    ;(watcher as any).mcpServerDesiredRevision += 1
    expect((watcher as any).mcpWatchGeneration).toBe(generationBefore)
    releaseFirstPass.resolve(undefined)
    await pass

    expect(warnSpy).toHaveBeenCalledWith(
      '[K8s] pass ended without certifying: inventory authority lost',
      expect.objectContaining({
        contextMoved: false,
        serverMoved: true,
        contextCacheSynced: true,
        mcpServerCacheSynced: true,
      })
    )
    expect((watcher as any).initialConvergenceRetryAttempts.get('NetworkPolicy')).toBe(5)
    expect((watcher as any).initialConvergenceRetryTimers.has('NetworkPolicy')).toBe(true)
    expect(
      await readInitialConvergenceMetric(
        'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
        'NetworkPolicy'
      )
    ).toBe(successTimestampBefore)
    expect(
      await readLabeledConvergenceMetric('clerum_hcc_initial_convergence_swallowed_total', {
        lane: 'NetworkPolicy',
        sink: 'authority-lost',
      })
    ).toBe(swallowedBefore + 1)
    expect(
      await readLabeledConvergenceMetric('clerum_hcc_initial_convergence_pass_results_total', {
        lane: 'NetworkPolicy',
        result: 'aborted-authority',
      })
    ).toBe(abortedBefore + 1)
    warnSpy.mockRestore()
    await watcher.stop()
  })

  it('G4: drops queued NetworkPolicy effects when a desired revision advances before they run', async () => {
    const contextBlockerStarted = deferred()
    const releaseContextBlocker = deferred()
    const serverBlockerStarted = deferred()
    const releaseServerBlocker = deferred()
    const effectsOffered = deferred()
    const contextWork = vi.fn()
    const serverWork = vi.fn()
    let passes = 0
    let offeredContextEffects = 0
    let offeredServerEffects = 0
    const watcher = new McpServerWatcher()
    seedNetworkPolicyPassInventory(watcher)
    const droppedContextBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_effects_dropped_total',
      { lane: 'NetworkPolicy', kind: 'context' }
    )
    const droppedServerBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_effects_dropped_total',
      { lane: 'NetworkPolicy', kind: 'server' }
    )
    const contextBlocker = (watcher as any).enqueueContextReconciliation(
      'stale-context',
      async () => {
        contextBlockerStarted.resolve(undefined)
        await releaseContextBlocker.promise
      }
    )
    const serverBlocker = (watcher as any).enqueueMcpServerReconciliation(
      { name: 'stale-server', namespace: 'mcp-server' },
      async () => {
        serverBlockerStarted.resolve(undefined)
        await releaseServerBlocker.promise
      }
    )
    await Promise.all([contextBlockerStarted.promise, serverBlockerStarted.promise])
    mocks.netPolFullReconcile.mockImplementation(async (contexts, servers, options) => {
      passes += 1
      options.onAuthoritativeRevocationComplete?.()
      const pending = [
        ...contexts.map((context: { spec: { contextId: string } }) => {
          offeredContextEffects += 1
          return options.runContextEffect(context.spec.contextId, contextWork)
        }),
        ...servers.map((server: { name: string }) => {
          offeredServerEffects += 1
          return options.runServerEffect(server.name, serverWork)
        }),
      ]
      effectsOffered.resolve(undefined)
      await Promise.all(pending)
    })

    const pass = (watcher as any).runInitialNetworkPolicyConvergence()
    await effectsOffered.promise
    expect(passes).toBeGreaterThan(0)
    expect(offeredContextEffects).toBeGreaterThanOrEqual(1)
    expect(offeredServerEffects).toBeGreaterThanOrEqual(1)
    expect(contextWork).not.toHaveBeenCalled()
    expect(serverWork).not.toHaveBeenCalled()
    ;(watcher as any).contextDesiredRevision += 1
    ;(watcher as any).mcpServerDesiredRevision += 1
    releaseContextBlocker.resolve(undefined)
    releaseServerBlocker.resolve(undefined)
    await Promise.all([contextBlocker, serverBlocker, pass])

    expect(contextWork).not.toHaveBeenCalled()
    expect(serverWork).not.toHaveBeenCalled()
    expect(
      await readLabeledConvergenceMetric('clerum_hcc_initial_convergence_effects_dropped_total', {
        lane: 'NetworkPolicy',
        kind: 'context',
      })
    ).toBe(droppedContextBefore + 1)
    expect(
      await readLabeledConvergenceMetric('clerum_hcc_initial_convergence_effects_dropped_total', {
        lane: 'NetworkPolicy',
        kind: 'server',
      })
    ).toBe(droppedServerBefore + 1)
    await watcher.stop()
  })

  it('does not certify NetworkPolicy revocation after authority is lost at the callback boundary', async () => {
    const watcher = new McpServerWatcher()
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).contextWatchGeneration = 21
    ;(watcher as any).mcpWatchGeneration = 34
    mocks.netPolFullReconcile.mockImplementationOnce(async (_contexts, _servers, options) => {
      ;(watcher as any).contextCacheSynced = false
      options.onAuthoritativeRevocationComplete()
    })

    await (watcher as any).runInitialNetworkPolicyConvergence()

    // Authority lost at the callback boundary (contextCacheSynced=false) → record
    // refuses, so the content-identity revocation counters stay at the "never
    // certified" sentinel rather than adopting the captured revision.
    expect((watcher as any).networkPolicyRevocationContextRevision).toBe(-1)
    expect((watcher as any).networkPolicyRevocationServerRevision).toBe(-1)
    await watcher.stop()
  })

  it('wires onExternalEgressRevoked to schedule a MODIFIED external-egress retry (B3)', async () => {
    const watcher = new McpServerWatcher()
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).contextWatchGeneration = 21
    ;(watcher as any).mcpWatchGeneration = 34
    const server = {
      name: 'openai-mcp',
      namespace: 'mcp-server',
      spec: {
        contextRef: 'dev',
        image: 'openai:latest',
        transport: { type: 'streamableHttp' as const, port: 3000 },
        egressBindings: [{ dns: 'api.openai.com', port: 443 }],
      },
    }
    const retrySpy = vi
      .spyOn((watcher as any).externalEgressCoordinator, 'scheduleRetry')
      .mockImplementation(() => undefined)
    let captured: { onExternalEgressRevoked?: (s: unknown) => void } | undefined
    mocks.netPolFullReconcile.mockImplementationOnce(
      async (_contexts: unknown[], _servers: unknown[], options: typeof captured) => {
        captured = options
      }
    )

    await (watcher as any).runInitialNetworkPolicyConvergence()

    expect(captured?.onExternalEgressRevoked).toBeTypeOf('function')
    captured!.onExternalEgressRevoked!(server)
    expect(retrySpy).toHaveBeenCalledWith('MODIFIED', server)
    await watcher.stop()
  })

  it('does not start runtime fleet convergence without a current NetworkPolicy safety certificate', async () => {
    const watcher = new McpServerWatcher()
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).contextWatchGeneration = 4
    ;(watcher as any).mcpWatchGeneration = 7

    await (watcher as any).runInitialMcpServerConvergence()
    expect(mocks.serverFullReconcile).not.toHaveBeenCalled()

    await (watcher as any).runInitialNetworkPolicyConvergence()
    await vi.waitFor(() => expect(mocks.serverFullReconcile).toHaveBeenCalledOnce())

    await watcher.stop()
  })

  it('does not start runtime fleet convergence while the safety inventory is uncertified', async () => {
    // M1: with the revocation counters aligned, the ONLY thing that can null the
    // certificate is the lost safety fence. Fence lost -> cert null -> the fleet
    // lane must not run; fence restored -> it runs exactly once.
    const watcher = new McpServerWatcher()
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).contextWatchGeneration = 4
    ;(watcher as any).mcpWatchGeneration = 7
    markNetworkPolicyRevocationAuthoritative(watcher)
    try {
      mocks.hasCertifiedSafetyInventory.mockReturnValue(false)
      await (watcher as any).runInitialMcpServerConvergence()
      expect(mocks.serverFullReconcile).not.toHaveBeenCalled()

      mocks.hasCertifiedSafetyInventory.mockReturnValue(true)
      await (watcher as any).runInitialMcpServerConvergence()
      expect(mocks.serverFullReconcile).toHaveBeenCalledOnce()
    } finally {
      // vi.clearAllMocks() clears calls, not implementations — restore explicitly
      // or every later test would re-gate on a stale false.
      mocks.hasCertifiedSafetyInventory.mockReturnValue(true)
      await watcher.stop()
    }
  })

  it('invalidates readiness when either desired policy revision advances', async () => {
    const watcher = new McpServerWatcher()
    ;(watcher as any).hostCacheSynced = true
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).contextWatchGeneration = 4
    ;(watcher as any).mcpWatchGeneration = 7
    markNetworkPolicyRevocationAuthoritative(watcher)
    expect(watcher.isReadinessInventoryAuthoritative()).toBe(true)
    ;(watcher as any).mcpServerDesiredRevision += 1
    expect(watcher.isReadinessInventoryAuthoritative()).toBe(false)

    markNetworkPolicyRevocationAuthoritative(watcher)
    expect(watcher.isReadinessInventoryAuthoritative()).toBe(true)
    ;(watcher as any).contextDesiredRevision += 1
    expect(watcher.isReadinessInventoryAuthoritative()).toBe(false)

    await watcher.stop()
  })

  it('retires readiness and requests a safety pass before a changed McpServer effect settles', async () => {
    const previous = {
      metadata: {
        name: 'restrictive-change',
        namespace: 'mcp-server',
        uid: 'restrictive-change-uid',
        generation: 1,
      },
      spec: {
        contextRef: 'default',
        image: 'clerum/restrictive-change:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
        egressBindings: [{ dns: 'api.example.com', port: 443, protocol: 'TCP' as const }],
      },
    }
    const current = {
      ...previous,
      metadata: { ...previous.metadata, generation: 2 },
      spec: {
        ...previous.spec,
        egressBindings: [{ dns: 'api.example.com', port: 443, protocol: 'UDP' as const }],
      },
    }
    const watcher = new McpServerWatcher()
    ;(watcher as any).hostCacheSynced = true
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).contextWatchGeneration = 4
    ;(watcher as any).mcpWatchGeneration = 7
    ;(watcher as any).servers.set(previous.metadata.name, {
      name: previous.metadata.name,
      namespace: previous.metadata.namespace,
      uid: previous.metadata.uid,
      generation: previous.metadata.generation,
      spec: previous.spec,
    })
    markNetworkPolicyRevocationAuthoritative(watcher)
    const safetyPass = vi
      .spyOn(watcher as any, 'runInitialNetworkPolicyConvergence')
      .mockResolvedValue(undefined)
    ;(watcher as any).netPolReconciler.reconcileExternalEgress.mockRejectedValueOnce(
      new Error('replacement policy unavailable')
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await (watcher as any).getMcpServerWatchCallback(7)('MODIFIED', current)

    expect(watcher.isReadinessInventoryAuthoritative()).toBe(false)
    expect(safetyPass).toHaveBeenCalled()
    await watcher.stop()
    errorSpy.mockRestore()
  })

  it('fences runtime effects when a desired-revision change retires the safety certificate', async () => {
    const selected = {
      name: 'certificate-fenced-server',
      namespace: 'mcp-server',
      spec: {
        contextRef: 'default',
        image: 'clerum/certificate-fenced:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
        egressBindings: [{ dns: 'certificate-fenced.example', port: 443 }],
      },
    }
    const egressStarted = deferred()
    const releaseEgress = deferred()
    const runtimeEffect = vi.fn()
    const watcher = new McpServerWatcher()
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).contextWatchGeneration = 11
    ;(watcher as any).mcpWatchGeneration = 13
    markNetworkPolicyRevocationAuthoritative(watcher)
    ;(watcher as any).servers.set(selected.name, selected)
    ;(watcher as any).netPolReconciler.reconcileExternalEgress.mockImplementationOnce(async () => {
      egressStarted.resolve(undefined)
      await releaseEgress.promise
    })
    mocks.serverFullReconcile.mockImplementationOnce(async (servers, options) => {
      await Promise.all(
        servers.map((server: { name: string }) => options.runEffect(server.name, runtimeEffect))
      )
    })

    const convergence = (watcher as any).runInitialMcpServerConvergence()
    await egressStarted.promise
    // A real desired-state change lands mid-convergence: the content identity
    // moves, retiring the captured safety certificate. A watch reconnect that
    // did NOT change content (generation-only bump) would correctly NOT fence —
    // that is the whole point of the content-identity gate — so the fence must
    // key on the revision, which this change advances.
    ;(watcher as any).contextDesiredRevision += 1
    releaseEgress.resolve(undefined)
    await convergence

    expect(runtimeEffect).not.toHaveBeenCalled()
    await watcher.stop()
  })

  it.each([
    ['SharedFileSystem', 'enqueueSharedFileSystemReconciliation'],
    ['GlobalFileSystem', 'enqueueGlobalFileSystemReconciliation'],
  ] as const)(
    'does not admit queued %s effects after the watcher stops',
    async (_, enqueueMethod) => {
      const firstStarted = deferred()
      const releaseFirst = deferred()
      const watcher = new McpServerWatcher()
      let queuedEffectRan = false

      const first = (watcher as any)[enqueueMethod]('same-object', async () => {
        firstStarted.resolve(undefined)
        await releaseFirst.promise
      }) as Promise<void>
      await firstStarted.promise
      const queued = (watcher as any)[enqueueMethod]('same-object', async () => {
        queuedEffectRan = true
      }) as Promise<void>

      await watcher.stop()
      releaseFirst.resolve(undefined)
      await Promise.all([first, queued])

      expect(queuedEffectRan).toBe(false)
    }
  )

  it.each([
    ['SharedFileSystem', 'enqueueSharedFileSystemReconciliation'],
    ['GlobalFileSystem', 'enqueueGlobalFileSystemReconciliation'],
  ] as const)(
    'serializes the same %s identity without blocking an unrelated fleet member',
    async (_, enqueueMethod) => {
      const firstStarted = deferred()
      const releaseFirst = deferred()
      const secondStarted = deferred()
      const unrelatedStarted = deferred()
      const watcher = new McpServerWatcher()
      let secondRan = false

      const first = (watcher as any)[enqueueMethod]('slow', async () => {
        firstStarted.resolve(undefined)
        await releaseFirst.promise
      }) as Promise<void>
      await firstStarted.promise
      const second = (watcher as any)[enqueueMethod]('slow', async () => {
        secondRan = true
        secondStarted.resolve(undefined)
      }) as Promise<void>
      const unrelated = (watcher as any)[enqueueMethod]('independent', async () => {
        unrelatedStarted.resolve(undefined)
      }) as Promise<void>

      await unrelatedStarted.promise
      expect(secondRan).toBe(false)
      releaseFirst.resolve(undefined)
      await Promise.all([first, second, unrelated])
      await expect(secondStarted.promise).resolves.toBeUndefined()
      await watcher.stop()
    }
  )

  it('keeps a keyed lane alive until a third waiter has consumed the same queue entry', async () => {
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const secondStarted = deferred()
    const releaseSecond = deferred()
    const thirdStarted = deferred()
    let thirdRan = false
    const watcher = new McpServerWatcher()

    const first = (watcher as any).enqueueContextReconciliation('shared', async () => {
      firstStarted.resolve(undefined)
      await releaseFirst.promise
    })
    await firstStarted.promise
    const second = (watcher as any).enqueueContextReconciliation('shared', async () => {
      secondStarted.resolve(undefined)
      await releaseSecond.promise
    })
    const third = (watcher as any).enqueueContextReconciliation('shared', async () => {
      thirdRan = true
      thirdStarted.resolve(undefined)
    })

    expect((watcher as any).contextReconciliationQueues.get('shared').references).toBe(3)
    releaseFirst.resolve(undefined)
    await secondStarted.promise
    expect(thirdRan).toBe(false)
    expect((watcher as any).contextReconciliationQueues.get('shared').references).toBe(2)
    releaseSecond.resolve(undefined)
    await Promise.all([first, second, third])
    expect((watcher as any).contextReconciliationQueues.has('shared')).toBe(false)
    await watcher.stop()
  })

  it('caps initial convergence retry delay after attempts exceed the schedule', async () => {
    vi.useFakeTimers()
    const watcher = new McpServerWatcher()
    const convergence = vi
      .spyOn(watcher as any, 'runInitialMcpServerConvergence')
      .mockResolvedValue(undefined)
    ;(watcher as any).initialConvergenceRetryAttempts.set('McpServer', 99)
    ;(watcher as any).scheduleInitialConvergenceRetry('McpServer')
    await vi.advanceTimersByTimeAsync(299_999)
    expect(convergence).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(convergence).toHaveBeenCalledOnce()
    await watcher.stop()
  })

  it('defers NetworkPolicy full convergence until both inventories are authoritative', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const watcher = new McpServerWatcher()
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = false
    ;(watcher as any).initialConvergenceRetryAttempts.set('NetworkPolicy', 2)
    const successTimestampBefore = await readInitialConvergenceMetric(
      'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
      'NetworkPolicy'
    )
    const swallowedBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_swallowed_total',
      { lane: 'NetworkPolicy', sink: 'unsynced' }
    )
    const deferredBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_pass_results_total',
      { lane: 'NetworkPolicy', result: 'deferred-unsynced' }
    )

    await (watcher as any).runInitialNetworkPolicyConvergence()

    expect(mocks.netPolFullReconcile).not.toHaveBeenCalled()
    expect(warnSpy.mock.calls.some(call => String(call[0]).includes('caches unsynced'))).toBe(true)
    expect((watcher as any).initialConvergenceRetryAttempts.get('NetworkPolicy')).toBe(3)
    expect((watcher as any).initialConvergenceRetryTimers.has('NetworkPolicy')).toBe(true)
    expect(
      await readLabeledConvergenceMetric('clerum_hcc_initial_convergence_swallowed_total', {
        lane: 'NetworkPolicy',
        sink: 'unsynced',
      })
    ).toBe(swallowedBefore + 1)
    expect(
      await readLabeledConvergenceMetric('clerum_hcc_initial_convergence_pass_results_total', {
        lane: 'NetworkPolicy',
        result: 'deferred-unsynced',
      })
    ).toBe(deferredBefore + 1)
    expect(
      await readInitialConvergenceMetric(
        'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
        'NetworkPolicy'
      )
    ).toBe(successTimestampBefore)
    ;(watcher as any).mcpServerCacheSynced = true
    await (watcher as any).runInitialNetworkPolicyConvergence()

    expect(mocks.netPolFullReconcile).toHaveBeenCalledOnce()
    expect(mocks.netPolFullReconcile).toHaveBeenLastCalledWith(
      [],
      [],
      expect.objectContaining({
        serverInventoryComplete: true,
        ensureDefaults: false,
        contextInventoryAuthoritative: expect.any(Function),
        serverInventoryAuthoritative: expect.any(Function),
      })
    )
    expect((watcher as any).initialConvergenceRetryAttempts.has('NetworkPolicy')).toBe(false)
    expect(
      await readInitialConvergenceMetric(
        'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
        'NetworkPolicy'
      )
    ).toBeGreaterThan(successTimestampBefore)
    warnSpy.mockRestore()
    await watcher.stop()
  })

  it('re-runs NetworkPolicy convergence from the retry ladder after a silent-sink miss without later watch events', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const watcher = new McpServerWatcher()
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = false
    const successTimestampBefore = await readInitialConvergenceMetric(
      'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
      'NetworkPolicy'
    )
    const certifiedBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_pass_results_total',
      { lane: 'NetworkPolicy', result: 'certified' }
    )

    await (watcher as any).runInitialNetworkPolicyConvergence()

    expect(mocks.netPolFullReconcile).not.toHaveBeenCalled()
    expect((watcher as any).initialConvergenceRetryAttempts.get('NetworkPolicy')).toBe(1)
    expect((watcher as any).initialConvergenceRetryTimers.has('NetworkPolicy')).toBe(true)
    expect(
      await readInitialConvergenceMetric(
        'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
        'NetworkPolicy'
      )
    ).toBe(successTimestampBefore)
    ;(watcher as any).mcpServerCacheSynced = true
    await vi.advanceTimersByTimeAsync(5000)

    expect(mocks.netPolFullReconcile).toHaveBeenCalledOnce()
    expect((watcher as any).initialConvergenceRetryAttempts.has('NetworkPolicy')).toBe(false)
    expect(
      await readLabeledConvergenceMetric('clerum_hcc_initial_convergence_pass_results_total', {
        lane: 'NetworkPolicy',
        result: 'certified',
      })
    ).toBe(certifiedBefore + 1)
    expect(
      await readInitialConvergenceMetric(
        'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
        'NetworkPolicy'
      )
    ).toBeGreaterThan(successTimestampBefore)

    mocks.netPolFullReconcile.mockClear()
    ;(watcher as any).mcpServerCacheSynced = false
    await (watcher as any).runInitialNetworkPolicyConvergence()
    expect(mocks.netPolFullReconcile).not.toHaveBeenCalled()
    expect((watcher as any).initialConvergenceRetryAttempts.get('NetworkPolicy')).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    await flushMicrotasks()
    expect(mocks.netPolFullReconcile).not.toHaveBeenCalled()
    expect((watcher as any).initialConvergenceRetryAttempts.get('NetworkPolicy')).toBe(2)
    expect((watcher as any).initialConvergenceRetryTimers.has('NetworkPolicy')).toBe(true)
    await vi.advanceTimersByTimeAsync(14_999)
    await flushMicrotasks()
    expect(mocks.netPolFullReconcile).not.toHaveBeenCalled()
    ;(watcher as any).mcpServerCacheSynced = true
    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(mocks.netPolFullReconcile).toHaveBeenCalledOnce()
    expect((watcher as any).initialConvergenceRetryAttempts.has('NetworkPolicy')).toBe(false)
    expect(
      await readLabeledConvergenceMetric('clerum_hcc_initial_convergence_pass_results_total', {
        lane: 'NetworkPolicy',
        result: 'certified',
      })
    ).toBe(certifiedBefore + 2)
    warnSpy.mockRestore()
    await watcher.stop()
  })

  it('recovers HTTP /ready after a NetworkPolicy unsynced swallow without later watch events', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.hasCertifiedSafetyInventory.mockReturnValue(false)
    mocks.netPolFullReconcile.mockImplementation(async (...args: unknown[]) => {
      const options = args[2] as { onAuthoritativeRevocationComplete?: () => void } | undefined
      options?.onAuthoritativeRevocationComplete?.()
      mocks.hasCertifiedSafetyInventory.mockReturnValue(true)
    })
    const watcher = new McpServerWatcher()
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = false
    ;(watcher as any).hostCacheSynced = true
    const certifiedBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_pass_results_total',
      { lane: 'NetworkPolicy', result: 'certified' }
    )
    const deferredBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_pass_results_total',
      { lane: 'NetworkPolicy', result: 'deferred-unsynced' }
    )
    const swallowedBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_swallowed_total',
      { lane: 'NetworkPolicy', sink: 'unsynced' }
    )
    const retriesBefore = await readInitialConvergenceMetric(
      'clerum_hcc_initial_convergence_retries_total',
      'NetworkPolicy'
    )
    const successTimestampBefore = await readInitialConvergenceMetric(
      'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
      'NetworkPolicy'
    )
    // Prior tests in this file leave a process-global last-success sample that
    // can sit ahead of a freshly installed fake clock. Pin time past that
    // sample so "timestamp moved" cannot pass by comparing against a rewind.
    vi.setSystemTime(Math.max(Date.now(), Math.round(successTimestampBefore * 1000) + 1000))
    const server = new ContextMapperServer(watcher, 0, undefined, undefined, () =>
      watcher.isReadinessInventoryAuthoritative()
    )
    await server.start()
    server.setReady(true)

    try {
      await (watcher as any).runInitialNetworkPolicyConvergence()
      expect(mocks.netPolFullReconcile).not.toHaveBeenCalled()
      expect((await requestReadyOverHttp(server)).statusCode).toBe(503)
      const deferredScrape = await requestMetricsOverHttp(server)
      expect(deferredScrape.statusCode).toBe(200)
      expect(
        readPromTextMetric(deferredScrape.body, 'clerum_hcc_initial_convergence_swallowed_total', {
          lane: 'NetworkPolicy',
          sink: 'unsynced',
        })
      ).toBe(swallowedBefore + 1)
      expect(
        readPromTextMetric(
          deferredScrape.body,
          'clerum_hcc_initial_convergence_pass_results_total',
          {
            lane: 'NetworkPolicy',
            result: 'deferred-unsynced',
          }
        )
      ).toBe(deferredBefore + 1)
      expect(
        readPromTextMetric(deferredScrape.body, 'clerum_hcc_initial_convergence_retries_total', {
          lane: 'NetworkPolicy',
        })
      ).toBe(retriesBefore + 1)
      expect(
        readPromTextMetric(
          deferredScrape.body,
          'clerum_hcc_initial_convergence_pass_results_total',
          {
            lane: 'NetworkPolicy',
            result: 'certified',
          }
        )
      ).toBe(certifiedBefore)
      ;(watcher as any).mcpServerCacheSynced = true
      expect((await requestReadyOverHttp(server)).statusCode).toBe(503)
      await vi.advanceTimersByTimeAsync(5000)
      await flushMicrotasks()

      expect(mocks.netPolFullReconcile).toHaveBeenCalledOnce()
      expect(
        await readLabeledConvergenceMetric('clerum_hcc_initial_convergence_pass_results_total', {
          lane: 'NetworkPolicy',
          result: 'certified',
        })
      ).toBe(certifiedBefore + 1)
      expect(
        await readInitialConvergenceMetric(
          'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
          'NetworkPolicy'
        )
      ).toBeGreaterThan(successTimestampBefore)
      expect((await requestReadyOverHttp(server)).statusCode).toBe(200)
      const certifiedScrape = await requestMetricsOverHttp(server)
      expect(certifiedScrape.statusCode).toBe(200)
      expect(
        readPromTextMetric(certifiedScrape.body, 'clerum_hcc_initial_convergence_swallowed_total', {
          lane: 'NetworkPolicy',
          sink: 'unsynced',
        })
      ).toBe(swallowedBefore + 1)
      expect(
        readPromTextMetric(
          certifiedScrape.body,
          'clerum_hcc_initial_convergence_pass_results_total',
          {
            lane: 'NetworkPolicy',
            result: 'deferred-unsynced',
          }
        )
      ).toBe(deferredBefore + 1)
      expect(
        readPromTextMetric(
          certifiedScrape.body,
          'clerum_hcc_initial_convergence_pass_results_total',
          {
            lane: 'NetworkPolicy',
            result: 'certified',
          }
        )
      ).toBe(certifiedBefore + 1)
      expect(
        readPromTextMetric(
          certifiedScrape.body,
          'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
          { lane: 'NetworkPolicy' }
        )
      ).toBeGreaterThan(successTimestampBefore)
    } finally {
      mocks.hasCertifiedSafetyInventory.mockReturnValue(true)
      mocks.netPolFullReconcile.mockImplementation(async (...args: unknown[]) => {
        const options = args[2] as { onAuthoritativeRevocationComplete?: () => void } | undefined
        options?.onAuthoritativeRevocationComplete?.()
      })
      warnSpy.mockRestore()
      await server.stop()
      await watcher.stop()
    }
  })

  it('names a generic NetworkPolicy catch failure failed instead of aborted-bump', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const watcher = new McpServerWatcher()
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true
    mocks.netPolFullReconcile.mockRejectedValueOnce(new Error('apiserver 5xx'))
    const failedBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_pass_results_total',
      { lane: 'NetworkPolicy', result: 'failed' }
    )
    const bumpBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_pass_results_total',
      { lane: 'NetworkPolicy', result: 'aborted-bump' }
    )

    await (watcher as any).runInitialNetworkPolicyConvergence()

    expect(
      await readLabeledConvergenceMetric('clerum_hcc_initial_convergence_pass_results_total', {
        lane: 'NetworkPolicy',
        result: 'failed',
      })
    ).toBe(failedBefore + 1)
    expect(
      await readLabeledConvergenceMetric('clerum_hcc_initial_convergence_pass_results_total', {
        lane: 'NetworkPolicy',
        result: 'aborted-bump',
      })
    ).toBe(bumpBefore)
    expect((watcher as any).initialConvergenceRetryAttempts.get('NetworkPolicy')).toBe(1)
    errorSpy.mockRestore()
    await watcher.stop()
  })

  it('names the inventory-changed throw aborted-bump', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const watcher = new McpServerWatcher()
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true
    mocks.netPolFullReconcile.mockRejectedValueOnce(
      new Error(DESIRED_NETWORKPOLICY_INVENTORY_CHANGED_MESSAGE)
    )
    const bumpBefore = await readLabeledConvergenceMetric(
      'clerum_hcc_initial_convergence_pass_results_total',
      { lane: 'NetworkPolicy', result: 'aborted-bump' }
    )

    await (watcher as any).runInitialNetworkPolicyConvergence()

    expect(
      await readLabeledConvergenceMetric('clerum_hcc_initial_convergence_pass_results_total', {
        lane: 'NetworkPolicy',
        result: 'aborted-bump',
      })
    ).toBe(bumpBefore + 1)
    expect((watcher as any).initialConvergenceRetryAttempts.get('NetworkPolicy')).toBe(1)
    expect(warnSpy).toHaveBeenCalledWith(
      '[K8s] pass ended without certifying: desired inventory changed',
      expect.objectContaining({
        contextMoved: false,
        serverMoved: false,
        contextCacheSynced: true,
        mcpServerCacheSynced: true,
      })
    )
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    await watcher.stop()
  })

  it('fences NetworkPolicy orphan cleanup to the desired revisions captured by the pass', async () => {
    const watcher = new McpServerWatcher()
    ;(watcher as any).contextCacheSynced = true
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).contextWatchGeneration = 17
    ;(watcher as any).mcpWatchGeneration = 23
    let options:
      | {
          contextInventoryAuthoritative: () => boolean
          serverInventoryAuthoritative: () => boolean
        }
      | undefined
    mocks.netPolFullReconcile.mockImplementationOnce(
      async (
        _contexts: unknown[],
        _servers: unknown[],
        received: {
          contextInventoryAuthoritative: () => boolean
          serverInventoryAuthoritative: () => boolean
        }
      ) => {
        options = received
      }
    )

    await (watcher as any).runInitialNetworkPolicyConvergence()

    expect(options?.contextInventoryAuthoritative()).toBe(true)
    expect(options?.serverInventoryAuthoritative()).toBe(true)

    // A recovered watch that re-LISTs identical content advances generation
    // (channel identity) but not the desired revision. That reconnect must
    // not retire this pass's orphan-cleanup authority.
    ;(watcher as any).contextWatchGeneration = 18
    ;(watcher as any).mcpWatchGeneration = 24

    expect(options?.contextInventoryAuthoritative()).toBe(true)
    expect(options?.serverInventoryAuthoritative()).toBe(true)

    // A real desired-state change advances the revision and must fence this
    // in-flight pass immediately.
    ;(watcher as any).contextDesiredRevision += 1
    ;(watcher as any).mcpServerDesiredRevision += 1

    expect(options?.contextInventoryAuthoritative()).toBe(false)
    expect(options?.serverInventoryAuthoritative()).toBe(false)
    await watcher.stop()
  })

  it('escalates and resets failed initial McpServer convergence without delaying bootstrap', async () => {
    vi.useFakeTimers()
    const server = {
      metadata: { name: 'initial-runtime', namespace: 'mcp-server' },
      spec: {
        contextRef: 'default',
        image: 'clerum/initial-runtime:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
      },
    }
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'mcpservers') return { items: [server] }
      if (plural === 'contexts') return { items: [] }
      if (plural === 'communicationchannels') {
        return { metadata: { resourceVersion: 'mcp-retry-rv' }, items: [] }
      }
      return { items: [] }
    })
    mocks.serverFullReconcile
      .mockRejectedValueOnce(new Error('initial runtime reconciliation failed'))
      .mockRejectedValueOnce(new Error('initial runtime reconciliation still unavailable'))
      .mockResolvedValueOnce(undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const retryMetricBefore = await readInitialConvergenceMetric(
      'clerum_hcc_initial_convergence_retries_total',
      'McpServer'
    )
    const watcher = new McpServerWatcher()
    stubAuthoritativeInventoryWatch(watcher, 'McpServer')
    stubAuthoritativeInventoryWatch(watcher, 'Context')
    vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startCommunicationChannelWatch').mockResolvedValue(undefined)

    await watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.serverFullReconcile).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.serverFullReconcile).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(14_999)
    expect(mocks.serverFullReconcile).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.serverFullReconcile).toHaveBeenCalledTimes(3)
    expect((watcher as any).initialConvergenceRetryAttempts.has('McpServer')).toBe(false)
    expect((watcher as any).initialConvergenceRetryTimers.has('McpServer')).toBe(false)
    expect(
      await readInitialConvergenceMetric(
        'clerum_hcc_initial_convergence_retries_total',
        'McpServer'
      )
    ).toBe(retryMetricBefore + 2)
    expect(
      await readInitialConvergenceMetric(
        'clerum_hcc_initial_convergence_last_success_timestamp_seconds',
        'McpServer'
      )
    ).toBeGreaterThan(0)

    await watcher.stop()
    errorSpy.mockRestore()
  })

  it('cancels a pending initial convergence retry when the watcher stops', async () => {
    vi.useFakeTimers()
    const watcher = new McpServerWatcher()
    ;(watcher as any).mcpServerCacheSynced = true
    ;(watcher as any).contextCacheSynced = true
    markNetworkPolicyRevocationAuthoritative(watcher)
    mocks.serverFullReconcile.mockRejectedValueOnce(
      new Error('initial runtime reconciliation unavailable')
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await (watcher as any).runInitialMcpServerConvergence()

    expect(mocks.serverFullReconcile).toHaveBeenCalledTimes(1)
    expect((watcher as any).initialConvergenceRetryAttempts.get('McpServer')).toBe(1)
    expect((watcher as any).initialConvergenceRetryTimers.has('McpServer')).toBe(true)

    await watcher.stop()
    await vi.advanceTimersByTimeAsync(300_000)

    expect(mocks.serverFullReconcile).toHaveBeenCalledTimes(1)
    expect((watcher as any).initialConvergenceRetryAttempts.size).toBe(0)
    expect((watcher as any).initialConvergenceRetryTimers.size).toBe(0)
    errorSpy.mockRestore()
  })

  it('retries failed initial NetworkPolicy convergence from the current caches', async () => {
    vi.useFakeTimers()
    const context = {
      metadata: { name: 'initial-context', namespace: 'mcp-server' },
      spec: { contextId: 'initial-context', mcpServers: [] },
    }
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'mcpservers') return { items: [] }
      if (plural === 'contexts') return { items: [context] }
      if (plural === 'communicationchannels') {
        return { metadata: { resourceVersion: 'netpol-retry-rv' }, items: [] }
      }
      return { items: [] }
    })
    mocks.netPolFullReconcile
      .mockRejectedValueOnce(new Error('initial NetworkPolicy reconciliation failed'))
      .mockImplementationOnce(
        async (
          _contexts: unknown,
          _servers: unknown,
          options?: { onAuthoritativeRevocationComplete?: () => void }
        ) => {
          options?.onAuthoritativeRevocationComplete?.()
        }
      )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const watcher = new McpServerWatcher()
    stubAuthoritativeInventoryWatch(watcher, 'McpServer')
    stubAuthoritativeInventoryWatch(watcher, 'Context')
    vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startCommunicationChannelWatch').mockResolvedValue(undefined)

    await watcher.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.netPolFullReconcile).toHaveBeenCalledTimes(1)
    expect(watcher.isReadinessInventoryAuthoritative()).toBe(false)

    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.netPolFullReconcile).toHaveBeenCalledTimes(2)
    expect(watcher.isReadinessInventoryAuthoritative()).toBe(true)
    expect(mocks.netPolFullReconcile).toHaveBeenLastCalledWith(
      [expect.objectContaining({ name: 'initial-context' })],
      [],
      expect.objectContaining({
        serverInventoryComplete: true,
        ensureDefaults: false,
        contextInventoryAuthoritative: expect.any(Function),
        serverInventoryAuthoritative: expect.any(Function),
      })
    )

    await watcher.stop()
    errorSpy.mockRestore()
  })

  it('does not report a post-certification additive failure as a readiness safety failure', async () => {
    vi.useFakeTimers()
    const additiveFailure = new AggregateError(
      [new Error('Context policy API unavailable')],
      'One or more additive Context NetworkPolicy reconciliations failed'
    )
    mocks.netPolFullReconcile.mockImplementationOnce(
      async (
        _contexts: unknown,
        _servers: unknown,
        options?: { onAuthoritativeRevocationComplete?: () => void }
      ) => {
        options?.onAuthoritativeRevocationComplete?.()
        throw additiveFailure
      }
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const watcher = new McpServerWatcher()
    stubAuthoritativeInventoryWatch(watcher, 'McpServer')
    stubAuthoritativeInventoryWatch(watcher, 'Context')
    vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startCommunicationChannelWatch').mockResolvedValue(undefined)

    await watcher.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(watcher.isReadinessInventoryAuthoritative()).toBe(true)
    expect(errorSpy).toHaveBeenCalledWith(
      '[K8s] Initial NetworkPolicy post-certification additive reconciliation failed:',
      additiveFailure
    )
    expect(errorSpy).not.toHaveBeenCalledWith(
      '[K8s] Initial NetworkPolicy background reconciliation failed:',
      additiveFailure
    )
    expect((watcher as any).initialConvergenceRetryTimers.has('NetworkPolicy')).toBe(true)

    await watcher.stop()
    errorSpy.mockRestore()
  })

  it.each([
    ['McpServer', 'startMcpServerWatch'],
    ['Context', 'startContextWatch'],
  ] as const)(
    'keeps safe bootstrap authority-gated when the %s watch cannot be established',
    async (_kind, method) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const watcher = new McpServerWatcher()
      if (method === 'startMcpServerWatch') {
        vi.spyOn(watcher as any, method).mockRejectedValue(new Error(`${method} unavailable`))
      } else {
        stubAuthoritativeInventoryWatch(watcher, 'McpServer')
      }
      if (method === 'startContextWatch') {
        vi.spyOn(watcher as any, method).mockRejectedValue(new Error(`${method} unavailable`))
      } else if (method !== 'startMcpServerWatch') {
        stubAuthoritativeInventoryWatch(watcher, 'Context')
      }
      vi.spyOn(watcher as any, 'startCommunicationChannelWatch').mockResolvedValue(undefined)
      const recoveryTimerField =
        method === 'startMcpServerWatch'
          ? 'mcpServerCacheRecoveryTimer'
          : 'contextCacheRecoveryTimer'

      try {
        await expect(watcher.start()).resolves.toBeUndefined()
        expect(watcher.isReadinessInventoryAuthoritative()).toBe(false)
        expect((watcher as any)[recoveryTimerField]).not.toBeNull()
        expect(mocks.netPolFullReconcile).not.toHaveBeenCalled()
      } finally {
        await watcher.stop()
        errorSpy.mockRestore()
        warnSpy.mockRestore()
      }
    }
  )

  it.each([
    ['SharedFileSystem', 'startSharedFileSystemWatch'],
    ['GlobalFileSystem', 'startGlobalFileSystemWatch'],
  ] as const)(
    'isolates, logs, and retries an initial %s background watch rejection',
    async (kind, method) => {
      vi.useFakeTimers()
      const failure = new Error(`${method} unavailable`)
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const watcher = new McpServerWatcher()
      stubAuthoritativeInventoryWatch(watcher, 'McpServer')
      stubAuthoritativeInventoryWatch(watcher, 'Context')
      const rejectedWatch = vi
        .spyOn(watcher as any, method)
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(undefined)
      const otherMethod =
        method === 'startSharedFileSystemWatch'
          ? 'startGlobalFileSystemWatch'
          : 'startSharedFileSystemWatch'
      vi.spyOn(watcher as any, otherMethod).mockResolvedValue(undefined)
      vi.spyOn(watcher as any, 'startCommunicationChannelWatch').mockResolvedValue(undefined)

      await expect(watcher.start()).resolves.toBeUndefined()
      await vi.advanceTimersByTimeAsync(0)

      expect(errorSpy).toHaveBeenCalledWith(
        `[K8s] ${kind} background watch failed to start:`,
        failure
      )
      expect(rejectedWatch).toHaveBeenCalledOnce()
      expect(mocks.netPolFullReconcile).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(4_999)
      expect(rejectedWatch).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect(rejectedWatch).toHaveBeenCalledTimes(2)

      await watcher.stop()
      errorSpy.mockRestore()
    }
  )

  it('applies the request deadline wrapper to the finite Host inventory LIST', async () => {
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') return { items: [] }
      return { items: [] }
    })

    await expect(listAllHosts()).resolves.toEqual([])

    expect(mocks.hostListCallOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        middleware: [expect.objectContaining({ pre: expect.any(Function) })],
        middlewareMergeStrategy: 'append',
      })
    )
  })

  it('preserves Host UID from the Kubernetes inventory boundary', async () => {
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') {
        return {
          items: [
            {
              metadata: {
                name: 'uid-host',
                namespace: 'mcp-host',
                uid: '9f43826a-4031-4a31-93af-a3dd8fcfe805',
                generation: 4,
              },
              spec: { host: 'uid-host', contextRef: 'context-a', secretRef: 'host-secret' },
            },
          ],
        }
      }
      return { items: [] }
    })

    await expect(listAllHosts()).resolves.toEqual([
      expect.objectContaining({
        name: 'uid-host',
        uid: '9f43826a-4031-4a31-93af-a3dd8fcfe805',
        generation: 4,
      }),
    ])
  })

  it('preserves observed GlobalFileSystem status from the Kubernetes inventory boundary', async () => {
    const status = {
      phase: 'Ready',
      pvcName: 'gfs-drive',
      serviceName: 'gfsc',
      serviceUrl: 'http://gfsc.gfs.svc.cluster.local:8087',
    }
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'globalfilesystems') {
        return {
          items: [
            {
              metadata: { name: 'gfs', namespace: 'gfs' },
              spec: {},
              status,
            },
          ],
        }
      }
      return { items: [] }
    })

    await expect(listAllGlobalFileSystems()).resolves.toEqual([
      expect.objectContaining({ name: 'gfs', namespace: 'gfs', status }),
    ])
  })

  it('reconciles startup external egress before runtime full reconciliation', async () => {
    const eventLog: string[] = []
    const server = {
      metadata: { name: 'web-search', namespace: 'mcp-server', generation: 4 },
      spec: {
        contextRef: 'wf-research',
        image: 'clerum/web-search:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
        egressBindings: [{ dns: 'duckduckgo.com', port: 443 }],
      },
    }

    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'mcpservers') return { items: [server] }
      if (plural === 'contexts') return { items: [] }
      if (plural === 'hosts') return { items: [] }
      if (plural === 'sharedfilesystems') return { items: [] }
      if (plural === 'communicationchannels')
        return { metadata: { resourceVersion: '1' }, items: [] }
      return { items: [] }
    })
    mocks.ensureDefaultPolicies.mockImplementation(async () => {
      eventLog.push('defaults')
    })
    const watcher = new McpServerWatcher()
    const reconciler = (watcher as any).reconciler
    mocks.serverFullReconcile.mockImplementation(async (servers, options) => {
      await Promise.all(
        servers.map((selected: { name: string }) =>
          options.runEffect(selected.name, async () => {
            eventLog.push('runtime')
            await reconciler.reconcile(selected)
          })
        )
      )
    })
    const netPol = (watcher as any).netPolReconciler
    netPol.reconcileExternalEgress.mockImplementation(async () => {
      eventLog.push('egress')
    })
    stubAuthoritativeInventoryWatch(watcher, 'McpServer')
    stubAuthoritativeInventoryWatch(watcher, 'Context')
    vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockImplementation(async () => undefined)
    vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockImplementation(async () => undefined)
    vi.spyOn(watcher as any, 'startCommunicationChannelWatch').mockImplementation(
      async () => undefined
    )

    await watcher.start()

    await vi.waitFor(() => expect(eventLog).toContain('runtime'))
    expect(eventLog.slice(0, 3)).toEqual(['defaults', 'egress', 'runtime'])
    expect(mocks.serverFullReconcile).toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'web-search' })],
      { runEffect: expect.any(Function) }
    )

    watcher.stop()
  })

  it('skips startup runtime reconciliation for servers whose external egress is not ready', async () => {
    vi.useFakeTimers()
    const server = {
      metadata: { name: 'web-search', namespace: 'mcp-server', generation: 4 },
      spec: {
        contextRef: 'wf-research',
        image: 'clerum/web-search:test',
        transport: { type: 'streamableHttp' as const, port: 3000 },
        egressBindings: [{ dns: 'duckduckgo.com', port: 443 }],
      },
    }

    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'mcpservers') return { items: [server] }
      if (plural === 'contexts') return { items: [] }
      if (plural === 'hosts') return { items: [] }
      if (plural === 'sharedfilesystems') return { items: [] }
      if (plural === 'communicationchannels')
        return { metadata: { resourceVersion: '1' }, items: [] }
      return { items: [] }
    })

    const watcher = new McpServerWatcher()
    const reconciler = (watcher as any).reconciler
    mocks.serverFullReconcile.mockImplementation(async (servers, options) => {
      await Promise.all(
        servers.map((selected: { name: string }) =>
          options.runEffect(selected.name, () => reconciler.reconcile(selected))
        )
      )
    })
    const netPol = (watcher as any).netPolReconciler
    const dnsFailure = new Error('dns resolution failed')
    netPol.reconcileExternalEgress.mockRejectedValueOnce(dnsFailure)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubAuthoritativeInventoryWatch(watcher, 'McpServer')
    stubAuthoritativeInventoryWatch(watcher, 'Context')
    vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockImplementation(async () => undefined)
    vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockImplementation(async () => undefined)
    vi.spyOn(watcher as any, 'startCommunicationChannelWatch').mockImplementation(
      async () => undefined
    )

    await watcher.start()

    await vi.waitFor(() => expect(mocks.serverFullReconcile).toHaveBeenCalledOnce())
    expect(mocks.serverFullReconcile).toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'web-search' })],
      { runEffect: expect.any(Function) }
    )
    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(1)
    expect(reconciler.reconcile).not.toHaveBeenCalled()
    expect(watcher.isReadinessInventoryAuthoritative()).toBe(true)
    expect((watcher as any).initialConvergenceRetryTimers.has('NetworkPolicy')).toBe(false)
    expect(errorSpy).not.toHaveBeenCalledWith(
      '[K8s] Initial NetworkPolicy background reconciliation failed:',
      dnsFailure
    )

    watcher.stop()
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })
})

describe('getContext error semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('preserves not-found semantics only for an authoritative 404', async () => {
    mocks.getNamespacedCustomObject.mockRejectedValueOnce(
      Object.assign(new Error('context absent'), { code: 404 })
    )

    await expect(getContext('missing-context')).resolves.toBeNull()
  })

  it('propagates non-404 API failures instead of converting discovery to an empty fleet', async () => {
    const unavailable = Object.assign(new Error('apiserver unavailable'), {
      response: { statusCode: 503 },
    })
    mocks.getNamespacedCustomObject.mockRejectedValueOnce(unavailable)

    await expect(getContext('production-context')).rejects.toBe(unavailable)
  })
})

describe('MCP authorization Kubernetes not-found classification', () => {
  it.each([{ code: 404 }, { response: { statusCode: 404 } }])(
    'recognizes Kubernetes 404 shape %#',
    error => {
      expect(isMcpAuthorizationNotFound(error)).toBe(true)
    }
  )

  it('does not classify authority failures as not-found', () => {
    expect(isMcpAuthorizationNotFound({ code: 403 })).toBe(false)
    expect(isMcpAuthorizationNotFound({ response: { statusCode: 503 } })).toBe(false)
  })
})

describe('McpServerWatcher external egress retries', () => {
  const serverObject = {
    metadata: { name: 'redis-tools', namespace: 'mcp-server' },
    spec: {
      contextRef: 'context1',
      image: 'redis-tools:test',
      transport: { type: 'streamableHttp' as const, port: 3000 },
      egressBindings: [{ dns: 'example.com', port: 443 }],
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('retries failed external egress reconciliation from an ADDED event', async () => {
    const watcher = new McpServerWatcher()
    markMcpServerInventoryAuthoritative(watcher)
    const netPol = (watcher as any).netPolReconciler
    const reconciler = (watcher as any).reconciler
    const bindingReconciler = (watcher as any).bindingReconciler
    const serverWithBindings = {
      ...serverObject,
      metadata: {
        ...serverObject.metadata,
        annotations: {
          'clerum.io/recipe-bindings': JSON.stringify([
            { source: 'redis-tools', target: 'downstream' },
          ]),
        },
      },
    }
    ;(watcher as any).contexts.set('context1', {
      name: 'context1',
      namespace: 'mcp-server',
      spec: { contextId: 'context1', mcpServers: ['redis-tools'] },
    })
    netPol.reconcileExternalEgress.mockRejectedValueOnce(new Error('api temporarily unavailable'))
    netPol.reconcileExternalEgress.mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const watchCallback = (watcher as any).getMcpServerWatchCallback()
    await watchCallback('ADDED', serverWithBindings)

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(1)
    expect(bindingReconciler.reconcileBindings).not.toHaveBeenCalled()
    expect(netPol.reconcileContext).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5000)

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(2)
    expect(reconciler.reconcile).toHaveBeenCalledTimes(1)
    expect(reconciler.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'redis-tools' }),
      { isCurrent: expect.any(Function) }
    )
    expect(bindingReconciler.reconcileBindings).toHaveBeenCalledTimes(1)
    expect(netPol.reconcileContext).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: expect.objectContaining({ contextId: 'context1' }),
      }),
      expect.objectContaining({ isCurrent: expect.any(Function) })
    )

    watcher.stop()
  })

  it('retires a binding-policy lease when a same-watch MODIFIED supersedes the server', async () => {
    const watcher = new McpServerWatcher()
    markMcpServerInventoryAuthoritative(watcher)
    const bindingReconciler = (watcher as any).bindingReconciler
    const bindingStarted = deferred()
    const releaseBinding = deferred()
    bindingReconciler.reconcileBindings.mockImplementationOnce(async () => {
      bindingStarted.resolve(undefined)
      await releaseBinding.promise
    })
    const annotations = {
      'clerum.io/recipe-bindings': JSON.stringify([
        { from: 'redis-tools', to: 'downstream', port: 443 },
      ]),
    }
    const original = {
      ...serverObject,
      metadata: {
        ...serverObject.metadata,
        uid: 'redis-tools-uid',
        generation: 1,
        annotations,
      },
    }
    const replacement = {
      ...original,
      metadata: { ...original.metadata, generation: 2 },
      spec: { ...original.spec, image: 'redis-tools:v2' },
    }
    const watchCallback = (watcher as any).getMcpServerWatchCallback()

    const originalEffect = watchCallback('ADDED', original)
    await bindingStarted.promise
    const replacementEffect = watchCallback('MODIFIED', replacement)

    const originalOptions = bindingReconciler.reconcileBindings.mock.calls[0][4]
    expect(originalOptions).toEqual({ isCurrent: expect.any(Function) })
    expect(originalOptions.isCurrent()).toBe(false)

    releaseBinding.resolve(undefined)
    await Promise.all([originalEffect, replacementEffect])

    expect(bindingReconciler.reconcileBindings).toHaveBeenCalledTimes(2)
    expect(bindingReconciler.reconcileBindings).toHaveBeenLastCalledWith(
      'redis-tools',
      expect.any(Array),
      'redis-tools',
      'redis-tools',
      { isCurrent: expect.any(Function) }
    )
    await watcher.stop()
  })

  it('retires binding cleanup when a same-name McpServer is recreated during DELETE', async () => {
    const watcher = new McpServerWatcher()
    ;(watcher as any).mcpServerCacheSynced = true
    const bindingReconciler = (watcher as any).bindingReconciler
    const cleanupStarted = deferred()
    const releaseCleanup = deferred()
    bindingReconciler.cleanupBindings.mockImplementationOnce(async () => {
      cleanupStarted.resolve(undefined)
      await releaseCleanup.promise
    })
    const deleted = {
      ...serverObject,
      metadata: {
        ...serverObject.metadata,
        uid: 'redis-tools-old-uid',
        generation: 1,
      },
    }
    const recreated = {
      ...serverObject,
      metadata: {
        ...serverObject.metadata,
        uid: 'redis-tools-new-uid',
        generation: 1,
      },
      spec: { ...serverObject.spec, image: 'redis-tools:recreated' },
    }
    const watchCallback = (watcher as any).getMcpServerWatchCallback()

    const deleteEffect = watchCallback('DELETED', deleted)
    await cleanupStarted.promise
    const recreateEffect = watchCallback('ADDED', recreated)

    const cleanupOptions = bindingReconciler.cleanupBindings.mock.calls[0][1]
    expect(cleanupOptions).toEqual({ deleteAllowed: expect.any(Function) })
    await expect(cleanupOptions.deleteAllowed()).resolves.toBe(false)

    releaseCleanup.resolve(undefined)
    await Promise.all([deleteEffect, recreateEffect])

    expect(bindingReconciler.cleanupBindings).toHaveBeenCalledTimes(1)
    await watcher.stop()
  })

  it('retries the complete pipeline when a no-egress runtime reconcile fails', async () => {
    const watcher = new McpServerWatcher()
    markMcpServerInventoryAuthoritative(watcher)
    const reconciler = (watcher as any).reconciler
    const noEgressServer = {
      ...serverObject,
      spec: {
        ...serverObject.spec,
        egressBindings: undefined,
      },
    }
    reconciler.reconcile
      .mockRejectedValueOnce(new Error('deployment temporarily unavailable'))
      .mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await (watcher as any).getMcpServerWatchCallback()('ADDED', noEgressServer)
    expect(reconciler.reconcile).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5000)

    expect(reconciler.reconcile).toHaveBeenCalledTimes(2)
    watcher.stop()
  })

  it('retries runtime reconciliation when external egress is ready but runtime reconcile fails', async () => {
    const watcher = new McpServerWatcher()
    markMcpServerInventoryAuthoritative(watcher)
    const netPol = (watcher as any).netPolReconciler
    const reconciler = (watcher as any).reconciler
    netPol.reconcileExternalEgress.mockResolvedValue(undefined)
    reconciler.reconcile.mockRejectedValueOnce(new Error('deployment temporarily unavailable'))
    reconciler.reconcile.mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const watchCallback = (watcher as any).getMcpServerWatchCallback()
    await watchCallback('ADDED', serverObject)

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(1)
    expect(reconciler.reconcile).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5000)

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(2)
    expect(reconciler.reconcile).toHaveBeenCalledTimes(2)
    expect(reconciler.reconcile).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'redis-tools' }),
      { isCurrent: expect.any(Function) }
    )

    watcher.stop()
  })

  it('keeps retry attempts bounded when runtime fails after an external egress retry succeeds', async () => {
    const watcher = new McpServerWatcher()
    markMcpServerInventoryAuthoritative(watcher)
    const netPol = (watcher as any).netPolReconciler
    const reconciler = (watcher as any).reconciler
    netPol.reconcileExternalEgress.mockRejectedValueOnce(new Error('api temporarily unavailable'))
    netPol.reconcileExternalEgress.mockResolvedValue(undefined)
    reconciler.reconcile.mockRejectedValueOnce(new Error('deployment temporarily unavailable'))
    reconciler.reconcile.mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const watchCallback = (watcher as any).getMcpServerWatchCallback()
    await watchCallback('ADDED', serverObject)

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(1)
    expect(reconciler.reconcile).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5000)

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(2)
    expect(reconciler.reconcile).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(15000)

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(3)
    expect(reconciler.reconcile).toHaveBeenCalledTimes(2)
    expect(reconciler.reconcile).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'redis-tools' }),
      { isCurrent: expect.any(Function) }
    )

    watcher.stop()
  })

  it('continues a pending runtime pipeline during periodic external egress resync', async () => {
    const watcher = new McpServerWatcher()
    markMcpServerInventoryAuthoritative(watcher)
    const netPol = (watcher as any).netPolReconciler
    const reconciler = (watcher as any).reconciler
    netPol.reconcileExternalEgress.mockResolvedValue(undefined)
    reconciler.reconcile.mockRejectedValueOnce(new Error('deployment temporarily unavailable'))
    reconciler.reconcile.mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(Math, 'random').mockReturnValue(0)

    const watchCallback = (watcher as any).getMcpServerWatchCallback()
    await watchCallback('ADDED', serverObject)

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(1)
    expect(reconciler.reconcile).toHaveBeenCalledTimes(1)

    await (watcher as any).externalEgressCoordinator.runResync()

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(2)
    expect(reconciler.reconcile).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(5000)
    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(2)
    expect(reconciler.reconcile).toHaveBeenCalledTimes(2)

    watcher.stop()
  })

  it('keeps retrying an ADDED pipeline at the capped delay until it recovers', async () => {
    const watcher = new McpServerWatcher()
    markMcpServerInventoryAuthoritative(watcher)
    const netPol = (watcher as any).netPolReconciler
    const reconciler = (watcher as any).reconciler
    netPol.reconcileExternalEgress
      .mockRejectedValueOnce(new Error('initial outage'))
      .mockRejectedValueOnce(new Error('outage after 5s'))
      .mockRejectedValueOnce(new Error('outage after 15s'))
      .mockRejectedValueOnce(new Error('outage after 30s'))
      .mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await (watcher as any).getMcpServerWatchCallback()('ADDED', serverObject)
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(15000)
    await vi.advanceTimersByTimeAsync(30000)

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(4)
    expect(reconciler.reconcile).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30000)

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(5)
    expect(reconciler.reconcile).toHaveBeenCalledTimes(1)
    watcher.stop()
  })

  it('keeps retrying a partial DELETE pipeline at the capped delay until it recovers', async () => {
    const watcher = new McpServerWatcher()
    ;(watcher as any).mcpServerCacheSynced = true
    const netPol = (watcher as any).netPolReconciler
    const reconciler = (watcher as any).reconciler
    const bindingReconciler = (watcher as any).bindingReconciler
    netPol.cleanupExternalEgress
      .mockRejectedValueOnce(new Error('initial cleanup outage'))
      .mockRejectedValueOnce(new Error('cleanup outage after 5s'))
      .mockRejectedValueOnce(new Error('cleanup outage after 15s'))
      .mockRejectedValueOnce(new Error('cleanup outage after 30s'))
      .mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await (watcher as any).getMcpServerWatchCallback()('DELETED', serverObject)
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(15000)
    await vi.advanceTimersByTimeAsync(30000)

    expect(netPol.cleanupExternalEgress).toHaveBeenCalledTimes(4)
    expect(reconciler.reconcileDelete).not.toHaveBeenCalled()
    expect(bindingReconciler.cleanupBindings).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30000)

    expect(netPol.cleanupExternalEgress).toHaveBeenCalledTimes(5)
    expect(reconciler.reconcileDelete).toHaveBeenCalledWith('redis-tools', 'mcp-server')
    expect(bindingReconciler.cleanupBindings).toHaveBeenCalledWith('redis-tools', {
      deleteAllowed: expect.any(Function),
    })
    watcher.stop()
  })

  it('bounds concurrent durable retries across McpServers', async () => {
    const watcher = new McpServerWatcher()
    markMcpServerInventoryAuthoritative(watcher)
    const reconciler = (watcher as any).reconciler
    const release = deferred()
    let active = 0
    let maxActive = 0
    reconciler.reconcile.mockImplementation(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await release.promise
      active -= 1
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    for (let index = 0; index < 11; index += 1) {
      const server = {
        name: `server-${index}`,
        namespace: 'mcp-server',
        spec: {
          ...serverObject.spec,
          egressBindings: undefined,
        },
      }
      ;(watcher as any).servers.set(server.name, server)
      ;(watcher as any).scheduleExternalEgressRetry('ADDED', server)
    }

    await vi.advanceTimersByTimeAsync(5000)
    await flushMicrotasks()

    expect(maxActive).toBe(10)

    release.resolve(undefined)
    await flushMicrotasks()
    watcher.stop()
  })

  it('replays a retry against the watcher generation current when the timer executes', async () => {
    const watcher = new McpServerWatcher()
    markMcpServerInventoryAuthoritative(watcher)
    const selected = {
      name: 'generation-fenced-server',
      namespace: 'mcp-server',
      spec: {
        ...serverObject.spec,
        egressBindings: undefined,
      },
    }
    ;(watcher as any).servers.set(selected.name, selected)
    ;(watcher as any).mcpWatchGeneration = 41
    const replay = vi
      .spyOn(watcher as any, 'reconcileMcpServerWatchEvent')
      .mockResolvedValue(undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(watcher as any).scheduleExternalEgressRetry('ADDED', selected)
    ;(watcher as any).mcpWatchGeneration = 42
    await vi.advanceTimersByTimeAsync(5000)

    expect(replay).toHaveBeenCalledWith(
      'MODIFIED',
      expect.objectContaining({ name: selected.name }),
      42,
      expect.objectContaining({
        isCurrent: expect.any(Function),
        complete: expect.any(Function),
      })
    )
    watcher.stop()
  })

  it('reconciles external egress before runtime reconciliation on ADDED events', async () => {
    const watcher = new McpServerWatcher()
    const netPol = (watcher as any).netPolReconciler
    const reconciler = (watcher as any).reconciler
    const order: string[] = []
    netPol.reconcileExternalEgress.mockImplementation(async () => {
      order.push('egress')
    })
    reconciler.reconcile.mockImplementation(async () => {
      order.push('runtime')
    })

    const watchCallback = (watcher as any).getMcpServerWatchCallback()
    await watchCallback('ADDED', serverObject)

    expect(order).toEqual(['egress', 'runtime'])

    watcher.stop()
  })

  it('does not reconcile runtime resources when external egress pre-start reconciliation fails', async () => {
    const watcher = new McpServerWatcher()
    const netPol = (watcher as any).netPolReconciler
    const reconciler = (watcher as any).reconciler
    netPol.reconcileExternalEgress.mockRejectedValueOnce(new Error('api temporarily unavailable'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const watchCallback = (watcher as any).getMcpServerWatchCallback()
    await watchCallback('ADDED', serverObject)

    expect(reconciler.reconcile).not.toHaveBeenCalled()

    watcher.stop()
  })

  it('retries failed external egress cleanup from a DELETED event', async () => {
    const watcher = new McpServerWatcher()
    ;(watcher as any).mcpServerCacheSynced = true
    const netPol = (watcher as any).netPolReconciler
    const reconciler = (watcher as any).reconciler
    const bindingReconciler = (watcher as any).bindingReconciler
    netPol.cleanupExternalEgress.mockRejectedValueOnce(new Error('delete temporarily unavailable'))
    netPol.cleanupExternalEgress.mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const watchCallback = (watcher as any).getMcpServerWatchCallback()
    await watchCallback('DELETED', serverObject)

    expect(netPol.cleanupExternalEgress).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5000)

    expect(netPol.cleanupExternalEgress).toHaveBeenCalledTimes(2)
    expect(netPol.cleanupExternalEgress).toHaveBeenLastCalledWith(
      'redis-tools',
      'mcp-server',
      undefined,
      expect.any(Function)
    )
    expect(reconciler.reconcileDelete).toHaveBeenCalledWith('redis-tools', 'mcp-server')
    expect(bindingReconciler.cleanupBindings).toHaveBeenCalledWith('redis-tools', {
      deleteAllowed: expect.any(Function),
    })

    watcher.stop()
  })

  it('retries the full DELETE pipeline when authoritative absence is temporarily unavailable', async () => {
    const watcher = new McpServerWatcher()
    ;(watcher as any).mcpServerCacheSynced = true
    const netPol = (watcher as any).netPolReconciler
    const reconciler = (watcher as any).reconciler
    const bindingReconciler = (watcher as any).bindingReconciler
    const unavailable = Object.assign(new Error('apiserver temporarily unavailable'), {
      response: { statusCode: 503 },
    })
    mocks.getNamespacedCustomObject.mockRejectedValueOnce(unavailable)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const watchCallback = (watcher as any).getMcpServerWatchCallback()
    await expect(watchCallback('DELETED', serverObject)).resolves.toBeUndefined()

    expect(mocks.getNamespacedCustomObject).toHaveBeenCalledTimes(1)
    expect(netPol.cleanupExternalEgress).not.toHaveBeenCalled()
    expect(reconciler.reconcileDelete).not.toHaveBeenCalled()
    expect(bindingReconciler.cleanupBindings).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5000)

    expect(netPol.cleanupExternalEgress).toHaveBeenCalledTimes(1)
    expect(reconciler.reconcileDelete).toHaveBeenCalledWith('redis-tools', 'mcp-server')
    expect(bindingReconciler.cleanupBindings).toHaveBeenCalledWith('redis-tools', {
      deleteAllowed: expect.any(Function),
    })
    expect(mocks.getNamespacedCustomObject).toHaveBeenCalledTimes(4)

    watcher.stop()
  })

  it('retries the full DELETE pipeline when inventory authority is lost between cleanup stages', async () => {
    const watcher = new McpServerWatcher()
    ;(watcher as any).mcpServerCacheSynced = true
    const netPol = (watcher as any).netPolReconciler
    const reconciler = (watcher as any).reconciler
    const bindingReconciler = (watcher as any).bindingReconciler
    reconciler.reconcileDelete.mockImplementationOnce(async () => {
      ;(watcher as any).mcpServerCacheSynced = false
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const watchCallback = (watcher as any).getMcpServerWatchCallback()
    await expect(watchCallback('DELETED', serverObject)).resolves.toBeUndefined()

    expect(netPol.cleanupExternalEgress).toHaveBeenCalledTimes(1)
    expect(reconciler.reconcileDelete).toHaveBeenCalledWith('redis-tools', 'mcp-server')
    expect(bindingReconciler.cleanupBindings).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5000)

    expect(netPol.cleanupExternalEgress).toHaveBeenCalledTimes(1)
    expect(reconciler.reconcileDelete).toHaveBeenCalledTimes(1)
    expect(bindingReconciler.cleanupBindings).not.toHaveBeenCalled()
    ;(watcher as any).mcpServerCacheSynced = true
    await vi.advanceTimersByTimeAsync(14_999)
    expect(netPol.cleanupExternalEgress).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(netPol.cleanupExternalEgress).toHaveBeenCalledTimes(2)
    expect(reconciler.reconcileDelete).toHaveBeenCalledTimes(2)
    expect(bindingReconciler.cleanupBindings).toHaveBeenCalledWith('redis-tools', {
      deleteAllowed: expect.any(Function),
    })

    watcher.stop()
  })

  it('retires queued McpServer work immediately when its watch ends', async () => {
    const blockerStarted = deferred()
    const releaseBlocker = deferred()
    let watchCallback: ((type: string, apiObj: typeof serverObject) => Promise<void>) | undefined
    let watchDone: ((error: Error | null) => void) | undefined
    mocks.watch.mockImplementationOnce(async (_path, _options, callback, done) => {
      watchCallback = callback
      watchDone = done
      return { abort: vi.fn() }
    })
    const watcher = new McpServerWatcher()
    const netPol = (watcher as any).netPolReconciler
    await (watcher as any).startMcpServerWatch('mcp-watch-rv')
    const blocker = (watcher as any).enqueueMcpServerReconciliation(
      { name: 'redis-tools', namespace: 'mcp-server' },
      async () => {
        blockerStarted.resolve(undefined)
        await releaseBlocker.promise
      }
    )
    await blockerStarted.promise

    const event = watchCallback!('ADDED', serverObject)
    watchDone!(null)
    releaseBlocker.resolve(undefined)
    await Promise.all([blocker, event])

    expect(netPol.reconcileExternalEgress).not.toHaveBeenCalled()
    await watcher.stop()
  })

  it('retries the recreated server when an older DELETE retry timer already owns the key', async () => {
    const deletedServer = {
      metadata: {
        name: 'redis-tools',
        namespace: 'mcp-server',
        uid: 'redis-tools-old-uid',
        generation: 1,
      },
      spec: serverObject.spec,
    }
    const recreatedServer = {
      metadata: {
        name: 'redis-tools',
        namespace: 'mcp-server',
        uid: 'redis-tools-new-uid',
        generation: 1,
      },
      spec: { ...serverObject.spec, image: 'redis-tools:recreated' },
    }
    const watcher = new McpServerWatcher()
    ;(watcher as any).mcpServerCacheSynced = true
    const netPol = (watcher as any).netPolReconciler
    const reconciler = (watcher as any).reconciler
    netPol.cleanupExternalEgress.mockRejectedValueOnce(new Error('cleanup unavailable'))
    netPol.reconcileExternalEgress
      .mockRejectedValueOnce(new Error('recreated policy unavailable'))
      .mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const watchCallback = (watcher as any).getMcpServerWatchCallback()

    await watchCallback('DELETED', deletedServer)
    await watchCallback('ADDED', recreatedServer)
    await vi.advanceTimersByTimeAsync(5000)

    expect(netPol.cleanupExternalEgress).toHaveBeenCalledTimes(1)
    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(2)
    expect(reconciler.reconcile).toHaveBeenCalledOnce()
    expect(reconciler.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: 'redis-tools-new-uid',
        generation: 1,
        spec: expect.objectContaining({ image: 'redis-tools:recreated' }),
      }),
      { isCurrent: expect.any(Function) }
    )

    watcher.stop()
  })

  it('retries the latest DELETE cleanup when an older ADD retry timer already owns the key', async () => {
    const server = {
      metadata: {
        name: 'redis-tools',
        namespace: 'mcp-server',
        uid: 'redis-tools-uid',
        generation: 3,
      },
      spec: serverObject.spec,
    }
    const watcher = new McpServerWatcher()
    ;(watcher as any).mcpServerCacheSynced = true
    const netPol = (watcher as any).netPolReconciler
    netPol.reconcileExternalEgress.mockRejectedValueOnce(new Error('policy unavailable'))
    netPol.cleanupExternalEgress
      .mockRejectedValueOnce(new Error('cleanup unavailable'))
      .mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const watchCallback = (watcher as any).getMcpServerWatchCallback()

    await watchCallback('ADDED', server)
    await watchCallback('DELETED', server)
    await vi.advanceTimersByTimeAsync(5000)

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(1)
    expect(netPol.cleanupExternalEgress).toHaveBeenCalledTimes(2)

    watcher.stop()
  })

  it('does not continue to runtime or bindings after stop releases a live DNS hold', async () => {
    const egressStarted = deferred()
    const releaseEgress = deferred()
    const server = {
      metadata: {
        name: 'redis-tools',
        namespace: 'mcp-server',
        uid: 'redis-tools-uid',
        generation: 1,
        annotations: {
          'clerum.io/recipe-bindings': JSON.stringify([
            { source: 'redis-tools', target: 'downstream' },
          ]),
        },
      },
      spec: serverObject.spec,
    }
    const watcher = new McpServerWatcher()
    const netPol = (watcher as any).netPolReconciler
    const reconciler = (watcher as any).reconciler
    const bindingReconciler = (watcher as any).bindingReconciler
    netPol.reconcileExternalEgress.mockImplementationOnce(async () => {
      egressStarted.resolve(undefined)
      await releaseEgress.promise
    })
    const watchCallback = (watcher as any).getMcpServerWatchCallback()

    const reconcile = watchCallback('ADDED', server)
    await egressStarted.promise
    await watcher.stop()
    releaseEgress.resolve(undefined)
    await reconcile

    expect(reconciler.reconcile).not.toHaveBeenCalled()
    expect(bindingReconciler.reconcileBindings).not.toHaveBeenCalled()
  })

  it('does not run an older runtime revision after newer desired state arrives during egress', async () => {
    const egressStarted = deferred()
    const releaseEgress = deferred()
    const oldServer = {
      metadata: {
        name: 'redis-tools',
        namespace: 'mcp-server',
        uid: 'redis-tools-uid',
        generation: 1,
      },
      spec: { ...serverObject.spec, image: 'redis-tools:old' },
    }
    const newServer = {
      metadata: {
        name: 'redis-tools',
        namespace: 'mcp-server',
        uid: 'redis-tools-uid',
        generation: 2,
      },
      spec: { ...serverObject.spec, image: 'redis-tools:new' },
    }
    const watcher = new McpServerWatcher()
    const netPol = (watcher as any).netPolReconciler
    const reconciler = (watcher as any).reconciler
    netPol.reconcileExternalEgress
      .mockImplementationOnce(async () => {
        egressStarted.resolve(undefined)
        await releaseEgress.promise
      })
      .mockResolvedValue(undefined)
    const watchCallback = (watcher as any).getMcpServerWatchCallback()

    const oldReconcile = watchCallback('ADDED', oldServer)
    await egressStarted.promise
    const newReconcile = watchCallback('MODIFIED', newServer)
    releaseEgress.resolve(undefined)
    await Promise.all([oldReconcile, newReconcile])

    expect(reconciler.reconcile).toHaveBeenCalledOnce()
    expect(reconciler.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 2,
        spec: expect.objectContaining({ image: 'redis-tools:new' }),
      }),
      { isCurrent: expect.any(Function) }
    )

    watcher.stop()
  })

  it('does not resume periodic external egress work from jitter after stop', async () => {
    const watcher = new McpServerWatcher()
    const netPol = (watcher as any).netPolReconciler
    ;(watcher as any).servers.set('redis-tools', {
      name: 'redis-tools',
      namespace: 'mcp-server',
      spec: serverObject.spec,
    })
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    const resync = (watcher as any).externalEgressCoordinator.runResync()
    await flushMicrotasks()
    await watcher.stop()
    await vi.advanceTimersByTimeAsync(2500)
    await resync

    expect(netPol.reconcileExternalEgress).not.toHaveBeenCalled()
  })

  it('periodic resync reuses external egress reconciliation for cached servers with bindings', async () => {
    const watcher = new McpServerWatcher()
    markMcpServerInventoryAuthoritative(watcher)
    const netPol = (watcher as any).netPolReconciler
    netPol.reconcileExternalEgress.mockResolvedValue(undefined)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    ;(watcher as any).servers.set('redis-tools', {
      name: 'redis-tools',
      namespace: 'mcp-server',
      spec: serverObject.spec,
    })

    await (watcher as any).externalEgressCoordinator.runResync()

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(1)

    watcher.stop()
  })

  it('does not run parallel external egress reconciles for the same McpServer', async () => {
    const watcher = new McpServerWatcher()
    const netPol = (watcher as any).netPolReconciler
    const mutationStarted = deferred()
    const releaseMutation = deferred()
    const server = {
      name: 'redis-tools',
      namespace: 'mcp-server',
      spec: serverObject.spec,
    }
    ;(watcher as any).servers.set('redis-tools', server)
    netPol.reconcileExternalEgress.mockImplementationOnce(async () => {
      mutationStarted.resolve(undefined)
      await releaseMutation.promise
    })
    vi.spyOn(Math, 'random').mockReturnValue(0)

    const active = (watcher as any).runExternalEgressOnce('MODIFIED', server)
    await mutationStarted.promise
    await (watcher as any).externalEgressCoordinator.runResync()

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledOnce()

    releaseMutation.resolve(undefined)
    await active
    watcher.stop()
  })

  it('waits for already in-flight external egress before reconciling the current server', async () => {
    const watcher = new McpServerWatcher()
    const netPol = (watcher as any).netPolReconciler
    const mutationStarted = deferred()
    const releaseMutation = deferred()
    const server = {
      name: 'redis-tools',
      namespace: 'mcp-server',
      spec: serverObject.spec,
    }
    ;(watcher as any).servers.set(server.name, server)
    netPol.reconcileExternalEgress.mockImplementationOnce(async () => {
      mutationStarted.resolve(undefined)
      await releaseMutation.promise
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const active = (watcher as any).runExternalEgressOnce('MODIFIED', server)
    await mutationStarted.promise
    const waiting = (watcher as any).runExternalEgressOnce('MODIFIED', server)
    await flushMicrotasks()

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(
      '[K8s] Waiting for external egress reconcile for mcp-server/redis-tools; already in flight'
    )

    releaseMutation.resolve(undefined)
    await Promise.all([active, waiting])
    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(2)

    warn.mockRestore()
    watcher.stop()
  })

  it('does not start another external egress mutation after stop releases an in-flight wait', async () => {
    const watcher = new McpServerWatcher()
    const netPol = (watcher as any).netPolReconciler
    const mutationStarted = deferred()
    const releaseMutation = deferred()
    const server = {
      name: 'redis-tools',
      namespace: 'mcp-server',
      spec: serverObject.spec,
    }
    ;(watcher as any).servers.set(server.name, server)
    netPol.reconcileExternalEgress.mockImplementationOnce(async () => {
      mutationStarted.resolve(undefined)
      await releaseMutation.promise
    })

    const active = (watcher as any).runExternalEgressOnce('MODIFIED', server)
    await mutationStarted.promise
    const waiting = (watcher as any).runExternalEgressOnce('MODIFIED', server)
    await flushMicrotasks()
    await watcher.stop()
    releaseMutation.resolve(undefined)
    await Promise.all([active, waiting])

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledOnce()
  })
})

describe('McpServerWatcher.countCommunicationChannels', () => {
  it('returns 0 for an unknown host', () => {
    const watcher = new McpServerWatcher()
    expect(watcher.countCommunicationChannels('unknown-host')).toBe(0)
  })

  it('counts CCs whose spec.hostRef matches the given host', () => {
    const watcher = new McpServerWatcher()
    // Seed the private cache directly — the real watcher populates from K8s events.
    const ccs = (watcher as any).communicationChannels as Map<string, { spec: { hostRef: string } }>
    ccs.set('cc-1', { name: 'cc-1', namespace: 'channels', spec: { hostRef: 'marketing' } } as any)
    ccs.set('cc-2', { name: 'cc-2', namespace: 'channels', spec: { hostRef: 'marketing' } } as any)
    ccs.set('cc-3', { name: 'cc-3', namespace: 'channels', spec: { hostRef: 'trader' } } as any)
    expect(watcher.countCommunicationChannels('marketing')).toBe(2)
    expect(watcher.countCommunicationChannels('trader')).toBe(1)
    expect(watcher.countCommunicationChannels('chatllm')).toBe(0)
  })
})

describe('listAllCommunicationChannels', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists CommunicationChannel CRDs in the channels namespace', async () => {
    const fixtureItems = [
      {
        metadata: { name: 'gcp-channel', namespace: 'channels' },
        spec: { hostRef: 'josue-agent' },
      },
      {
        metadata: { name: 'tgtestjose2', namespace: 'channels' },
        spec: { hostRef: 'development' },
      },
    ]
    mocks.listNamespacedCustomObject.mockResolvedValueOnce({ items: fixtureItems })

    const result = await listAllCommunicationChannels()

    expect(mocks.listNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'clerum.io',
      version: 'v1alpha1',
      namespace: 'channels',
      plural: 'communicationchannels',
    })
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      name: 'gcp-channel',
      namespace: 'channels',
      spec: { hostRef: 'josue-agent' },
    })
    expect(result[1].spec.hostRef).toBe('development')
  })
})

describe('McpServerWatcher wires CC counter into HostReconciler', () => {
  it('HostReconciler.countCommunicationChannels reads from the watcher cache', () => {
    const watcher = new McpServerWatcher()
    const ccs = (watcher as any).communicationChannels as Map<string, { spec: { hostRef: string } }>
    ccs.set('cc-1', { name: 'cc-1', namespace: 'channels', spec: { hostRef: 'alpha-host' } } as any)
    ccs.set('cc-2', { name: 'cc-2', namespace: 'channels', spec: { hostRef: 'alpha-host' } } as any)
    const hostReconciler = watcher.getHostReconciler()
    // Same private field access pattern the hostReconciler tests use.
    expect((hostReconciler as any).countCommunicationChannels('alpha-host')).toBe(2)
    expect((hostReconciler as any).countCommunicationChannels('beta-host')).toBe(0)
  })
})

describe('McpServerWatcher Host mutation dependency wiring', () => {
  it('H2: wires a uid-guarded cache reflector into HostReconciler', () => {
    const watcher = new McpServerWatcher()
    const reflect = (
      watcher.getHostReconciler() as unknown as {
        _reflectHostOutcomeFn:
          | ((name: string, uid: string | undefined, apply: (target: HostCRD) => void) => void)
          | null
      }
    )._reflectHostOutcomeFn
    if (!reflect) {
      throw new Error('setReflectHostOutcome was never wired by the McpServerWatcher constructor')
    }
    const entry = {
      name: 'h2-host',
      namespace: 'mcp-host',
      uid: 'uid-1',
      spec: { host: 'h2-host', contextRef: 'c', secretRef: 's' },
    } as unknown as HostCRD
    ;(watcher as unknown as { hosts: Map<string, HostCRD> }).hosts.set('h2-host', entry)
    const apply = vi.fn()
    reflect('h2-host', 'uid-1', apply) // positive: current entry, matching uid
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(entry)
    apply.mockClear()
    reflect('h2-host', 'uid-2', apply) // recreation: same name, different uid → skip
    expect(apply).not.toHaveBeenCalled()
    reflect('h2-host', undefined, apply) // fail-closed on missing uid
    expect(apply).not.toHaveBeenCalled()
    reflect('absent-host', 'uid-1', apply) // absent entry → skip
    expect(apply).not.toHaveBeenCalled()
  })

  it('tracks only the selected Context, referenced SFS state, and Host-scoped channels', () => {
    const watcher = new McpServerWatcher()
    const host = {
      name: 'alpha-host',
      namespace: 'mcp-host',
      spec: { contextRef: 'alpha-context' },
    } as HostCRD
    const context = {
      name: 'alpha-context',
      namespace: 'mcp-server',
      spec: {
        contextId: 'alpha-context',
        sharedFileSystems: [{ name: 'documents', mountPath: '/contexts/documents' }],
      },
    }
    const documentsV1 = {
      name: 'documents',
      namespace: 'mcp-host',
      spec: { storageClassName: 'fast-v1' },
    }
    const alphaChannelV1 = {
      name: 'telegram-alpha',
      namespace: 'channels',
      spec: { hostRef: 'alpha-host' },
    }
    ;(watcher as any).contexts.set(context.name, context)
    ;(watcher as any).sharedFileSystems.set(documentsV1.name, documentsV1)
    ;(watcher as any).communicationChannels.set(alphaChannelV1.name, alphaChannelV1)
    ;(watcher as any).ccCacheSynced = true
    ;(watcher as any).ccWatchGeneration = 7
    const sfsReconciler = (watcher as any).sharedFileSystemReconciler
    sfsReconciler.isMountable.mockReturnValue(true)
    const hostReconciler = watcher.getHostReconciler() as any
    const resolveDependencies = hostReconciler._hostMutationDependenciesFn

    const original = resolveDependencies(host)
    expect(original).toEqual([
      { name: context.name, namespace: context.namespace, spec: context.spec },
      true,
      7,
      { name: documentsV1.name, namespace: documentsV1.namespace, spec: documentsV1.spec },
      true,
      {
        name: alphaChannelV1.name,
        namespace: alphaChannelV1.namespace,
        spec: alphaChannelV1.spec,
      },
    ])
    ;(watcher as any).sharedFileSystems.set('unrelated', {
      name: 'unrelated',
      namespace: 'mcp-host',
      spec: {},
    })
    ;(watcher as any).communicationChannels.set('telegram-beta', {
      name: 'telegram-beta',
      namespace: 'channels',
      spec: { hostRef: 'beta-host' },
    })
    const afterUnrelatedChanges = resolveDependencies(host)
    expect(afterUnrelatedChanges).toEqual(original)

    const documentsV2 = {
      ...documentsV1,
      spec: { storageClassName: 'fast-v2' },
    }
    ;(watcher as any).sharedFileSystems.set(documentsV2.name, documentsV2)
    const afterSfsRevision = resolveDependencies(host)
    expect(afterSfsRevision[3]).toEqual({
      name: documentsV2.name,
      namespace: documentsV2.namespace,
      spec: documentsV2.spec,
    })
    expect(afterSfsRevision[3]).not.toEqual(original[3])

    sfsReconciler.isMountable.mockReturnValue(false)
    const afterMountabilityChange = resolveDependencies(host)
    expect(afterMountabilityChange[4]).toBe(false)

    const alphaChannelV2 = {
      ...alphaChannelV1,
      spec: {
        ...alphaChannelV1.spec,
        credentialsSecretRef: { name: 'telegram-alpha-v2' },
      },
    }
    ;(watcher as any).communicationChannels.set(alphaChannelV2.name, alphaChannelV2)
    const afterChannelRevision = resolveDependencies(host)
    expect(afterChannelRevision.at(-1)).toEqual({
      name: alphaChannelV2.name,
      namespace: alphaChannelV2.namespace,
      spec: alphaChannelV2.spec,
    })
    expect(afterChannelRevision.at(-1)).not.toEqual(original.at(-1))
  })
})

describe('McpServerWatcher.reconcileHostsReferencingCC', () => {
  it('re-reconciles the Host whose name matches the CC hostRef', async () => {
    const watcher = new McpServerWatcher()
    markHostInventoryAuthoritative(watcher)
    const hosts = (watcher as any).hosts as Map<string, { name: string; spec: any }>
    hosts.set('marketing', {
      name: 'marketing',
      namespace: 'mcp-host',
      spec: { host: 'marketing', contextRef: 'c', secretRef: 's' },
    } as any)
    const reconcileSpy = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockResolvedValue(undefined)

    await (watcher as any).reconcileHostsReferencingCC('marketing')

    expect(reconcileSpy).toHaveBeenCalledTimes(1)
    expect(reconcileSpy.mock.calls[0][0]).toMatchObject({ name: 'marketing' })
  })

  it('is a no-op when the hostRef does not match any cached Host', async () => {
    const watcher = new McpServerWatcher()
    markHostInventoryAuthoritative(watcher)
    const reconcileSpy = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockResolvedValue(undefined)

    await (watcher as any).reconcileHostsReferencingCC('does-not-exist')

    expect(reconcileSpy).not.toHaveBeenCalled()
  })

  it('reports reconcile errors without throwing so the watch can schedule recovery', async () => {
    const watcher = new McpServerWatcher()
    markHostInventoryAuthoritative(watcher)
    const hosts = (watcher as any).hosts as Map<string, { name: string; spec: any }>
    hosts.set('marketing', {
      name: 'marketing',
      namespace: 'mcp-host',
      spec: { host: 'marketing', contextRef: 'c', secretRef: 's' },
    } as any)
    vi.spyOn(watcher.getHostReconciler(), 'reconcile').mockRejectedValue(new Error('boom'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect((watcher as any).reconcileHostsReferencingCC('marketing')).resolves.toBe(false)
    expect(errorSpy).toHaveBeenCalled()

    errorSpy.mockRestore()
  })

  it('schedules lifecycle convergence when a targeted CC event reconcile fails', async () => {
    const watcher = new McpServerWatcher()
    markHostInventoryAuthoritative(watcher)
    ;(watcher as any).hosts.set('marketing', {
      name: 'marketing',
      namespace: 'mcp-host',
      spec: { host: 'marketing', contextRef: 'c', secretRef: 's' },
    })
    vi.spyOn(watcher.getHostReconciler(), 'reconcile').mockRejectedValue(new Error('temporary'))
    const requestFleet = vi
      .spyOn(watcher as any, 'requestHostFleetReconcile')
      .mockResolvedValue(undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const watchCallback = (watcher as any).getCommunicationChannelWatchCallback()
    await watchCallback('ADDED', {
      metadata: { name: 'marketing-channel', namespace: 'channels' },
      spec: { hostRef: 'marketing' },
    })

    expect(requestFleet).toHaveBeenCalledWith(
      'CommunicationChannel event convergence fallback',
      1,
      'lifecycle'
    )
    errorSpy.mockRestore()
    watcher.stop()
  })
})

describe('McpServerWatcher.start ordering (#281 R6-bis)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.watch.mockReset().mockResolvedValue({ abort: vi.fn() })
    mocks.hostFullReconcile.mockReset().mockResolvedValue(undefined)
  })

  it('populates CC cache and starts CC watch BEFORE fullReconcile(initialHosts)', async () => {
    const eventLog: string[] = []

    // The existing mocking infrastructure routes all list calls through
    // mocks.listNamespacedCustomObject keyed by `plural`. We intercept per-plural
    // to record when each fires relative to fullReconcile.
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'communicationchannels') {
        eventLog.push('listAllCommunicationChannels')
        return {
          metadata: { resourceVersion: '104' },
          items: [
            { metadata: { name: 'cc-1', namespace: 'channels' }, spec: { hostRef: 'marketing' } },
          ],
        }
      }
      if (plural === 'mcpservers') return { items: [] }
      if (plural === 'contexts') return { items: [] }
      if (plural === 'hosts') return { items: [] }
      if (plural === 'sharedfilesystems') return { items: [] }
      return { items: [] }
    })

    // Wrap hostFullReconcile to record when it fires.
    mocks.hostFullReconcile.mockImplementation(async () => {
      eventLog.push('fullReconcile')
    })

    mocks.watch.mockImplementation(async () => {
      eventLog.push('startCommunicationChannelWatch')
      return { abort: vi.fn() }
    })
    const watcher = new McpServerWatcher()

    stubAuthoritativeInventoryWatch(watcher, 'McpServer')
    stubAuthoritativeInventoryWatch(watcher, 'Context')
    vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockResolvedValue(undefined)
    const ccWatchSpy = vi.spyOn(watcher as any, 'startCommunicationChannelWatch')

    await watcher.start()

    // The critical ordering: the paired CC snapshot/watch must be established
    // before any Host can make a stateless eligibility decision.
    const idxList = eventLog.indexOf('listAllCommunicationChannels')
    const idxWatch = eventLog.indexOf('startCommunicationChannelWatch')
    const idxReconcile = eventLog.indexOf('fullReconcile')
    expect(idxList).toBeGreaterThanOrEqual(0)
    expect(idxWatch).toBeGreaterThanOrEqual(0)
    expect(idxReconcile).toBeGreaterThanOrEqual(0)
    expect(idxList).toBeLessThan(idxReconcile)
    expect(idxWatch).toBeLessThan(idxReconcile)
    expect(ccWatchSpy).toHaveBeenCalledWith('104')

    // Cache populated by the initial LIST.
    const cache = (watcher as any).communicationChannels as Map<string, any>
    expect(cache.size).toBe(1)
    expect(cache.get('cc-1')?.spec.hostRef).toBe('marketing')
    expect(watcher.isCommunicationChannelCacheSynced()).toBe(true)
    watcher.stop()
  })

  it('starts CC watch even when initial CC list fails (graceful degradation)', async () => {
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'communicationchannels') throw new Error('CC list failed')
      if (plural === 'mcpservers') return { items: [] }
      if (plural === 'contexts') return { items: [] }
      if (plural === 'hosts') return { items: [] }
      if (plural === 'sharedfilesystems') return { items: [] }
      return { items: [] }
    })

    const watcher = new McpServerWatcher()

    stubAuthoritativeInventoryWatch(watcher, 'McpServer')
    stubAuthoritativeInventoryWatch(watcher, 'Context')
    vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockResolvedValue(undefined)
    const ccWatchSpy = vi
      .spyOn(watcher as any, 'startCommunicationChannelWatch')
      .mockResolvedValue(undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(watcher.start()).resolves.toBeUndefined()
    expect(ccWatchSpy).toHaveBeenCalledTimes(1)
    expect(watcher.isCommunicationChannelCacheSynced()).toBe(false)
    expect(errorSpy).toHaveBeenCalledWith(
      '[K8s] CommunicationChannel initial load failed; ccCacheSynced remains false ' +
        '(B2 preserves channel-reader replicas and holds stateless lifecycle active):',
      expect.any(Error)
    )

    errorSpy.mockRestore()
    watcher.stop()
  })
})

describe('McpServerWatcher CommunicationChannel cache recovery', () => {
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
  }

  function communicationChannelWatchCalls(): typeof mocks.watch.mock.calls {
    return mocks.watch.mock.calls.filter(([path]) =>
      String(path).endsWith('/communicationchannels')
    )
  }

  function resetMocks(): void {
    vi.clearAllMocks()
    mocks.watch.mockReset().mockResolvedValue({ abort: vi.fn() })
    mocks.hostFullReconcile.mockReset().mockResolvedValue(undefined)
    mocks.hostReconcileHosts.mockReset().mockResolvedValue(undefined)
  }

  afterEach(() => {
    vi.useRealTimers()
    mocks.hostFullReconcile.mockReset().mockResolvedValue(undefined)
    mocks.hostReconcileHosts.mockReset().mockResolvedValue(undefined)
  })

  it('rebuilds the cache from a complete snapshot and resumes the watch from its resourceVersion', async () => {
    resetMocks()
    const host = {
      metadata: { name: 'stateless-host', namespace: 'mcp-host' },
      spec: { host: 'stateless-host', contextRef: 'context1', secretRef: 'agent-secret' },
    }
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'communicationchannels') {
        return {
          metadata: { resourceVersion: '201' },
          items: [
            {
              metadata: { name: 'current-channel', namespace: 'channels' },
              spec: { hostRef: 'stateless-host' },
            },
          ],
        }
      }
      if (plural === 'hosts') return { items: [host] }
      return { items: [] }
    })

    const watcher = newContextAuthoritativeWatcher()
    const cache = (watcher as any).communicationChannels as Map<string, any>
    cache.set('partial-channel', {
      name: 'partial-channel',
      namespace: 'channels',
      spec: { hostRef: 'stale-host' },
    })

    await expect((watcher as any).recoverCommunicationChannelCache()).resolves.toBe(true)

    expect(watcher.isCommunicationChannelCacheSynced()).toBe(true)
    expect([...cache.keys()]).toEqual(['current-channel'])
    expect(mocks.watch).toHaveBeenCalledWith(
      '/apis/clerum.io/v1alpha1/namespaces/channels/communicationchannels',
      { resourceVersion: '201' },
      expect.any(Function),
      expect.any(Function)
    )
    // Cache recovery intentionally schedules lifecycle convergence without
    // awaiting it; observe that documented asynchronous boundary explicitly.
    await vi.waitFor(() =>
      expect(mocks.hostReconcileHosts).toHaveBeenCalledWith([
        expect.objectContaining({ name: 'stateless-host' }),
      ])
    )

    watcher.stop()
  })

  it('keeps a partial cache fail-closed when the recovery list fails', async () => {
    resetMocks()
    const host = {
      metadata: { name: 'stateless-host', namespace: 'mcp-host' },
      spec: { host: 'stateless-host', contextRef: 'context1', secretRef: 'agent-secret' },
    }
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'communicationchannels') throw new Error('temporary list failure')
      if (plural === 'hosts') return { items: [host] }
      return { items: [] }
    })
    const watcher = newContextAuthoritativeWatcher()
    const cache = (watcher as any).communicationChannels as Map<string, any>
    cache.set('watch-observed-channel', {
      name: 'watch-observed-channel',
      namespace: 'channels',
      spec: { hostRef: 'stateless-host' },
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect((watcher as any).recoverCommunicationChannelCache()).resolves.toBe(false)

    expect(watcher.isCommunicationChannelCacheSynced()).toBe(false)
    expect(cache.get('watch-observed-channel')?.spec.hostRef).toBe('stateless-host')
    expect(mocks.watch).not.toHaveBeenCalled()
    expect(mocks.hostFullReconcile).not.toHaveBeenCalled()
    expect(mocks.hostReconcileHosts).not.toHaveBeenCalled()

    errorSpy.mockRestore()
    watcher.stop()
  })

  it('deduplicates concurrent recovery and queues one fleet pass after recovery succeeds', async () => {
    resetMocks()
    const host = {
      metadata: { name: 'stateless-host', namespace: 'mcp-host' },
      spec: { host: 'stateless-host', contextRef: 'context1', secretRef: 'agent-secret' },
    }
    const failedList = deferred<never>()
    let recoverList = false
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'communicationchannels') {
        if (!recoverList) return failedList.promise
        return { metadata: { resourceVersion: '205' }, items: [] }
      }
      if (plural === 'hosts') return { items: [host] }
      return { items: [] }
    })
    const firstFleetPass = deferred()
    mocks.hostReconcileHosts
      .mockImplementationOnce(() => firstFleetPass.promise)
      .mockResolvedValue(undefined)
    const watcher = newContextAuthoritativeWatcher()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const lifecycleGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()
    const failClosedPass = (watcher as any).requestHostFleetReconcile(
      'CommunicationChannel watch interruption',
      lifecycleGeneration
    ) as Promise<void>

    try {
      await vi.waitFor(() => expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(1))

      const failedRecoveries = [
        (watcher as any).recoverCommunicationChannelCache() as Promise<boolean>,
        (watcher as any).recoverCommunicationChannelCache() as Promise<boolean>,
        (watcher as any).recoverCommunicationChannelCache() as Promise<boolean>,
      ]
      await vi.waitFor(() =>
        expect(
          mocks.listNamespacedCustomObject.mock.calls.filter(
            ([request]) => request.plural === 'communicationchannels'
          )
        ).toHaveLength(1)
      )
      failedList.reject(new Error('selective CC list failure'))
      await expect(Promise.all(failedRecoveries)).resolves.toEqual([false, false, false])
      expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(1)

      recoverList = true
      const successfulRecoveries = [
        (watcher as any).recoverCommunicationChannelCache() as Promise<boolean>,
        (watcher as any).recoverCommunicationChannelCache() as Promise<boolean>,
      ]
      await expect(Promise.all(successfulRecoveries)).resolves.toEqual([true, true])
      expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(1)

      firstFleetPass.resolve(undefined)
      await failClosedPass
      // Post §10.2: the first lifecycle pass drove Host watch recovery (cache
      // was unsynced), which requested a background full pass (step 8). The
      // successful CC-recovery lifecycle requests merged into that single
      // trailing pass (full wins the merge), so exactly ONE trailing pass runs
      // — now a full pass. This test protects the CC-recovery dedup semantic:
      // concurrent recoveries collapse to one LIST, failed recoveries queue no
      // pass, and a successful recovery queues exactly one trailing pass.
      await vi.waitFor(() => expect(mocks.hostFullReconcile).toHaveBeenCalledTimes(1))
      expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(1)
      expect(
        mocks.listNamespacedCustomObject.mock.calls.filter(
          ([request]) => request.plural === 'communicationchannels'
        )
      ).toHaveLength(2)
      expect(
        mocks.listNamespacedCustomObject.mock.calls.filter(
          ([request]) => request.plural === 'hosts'
        )
      ).toHaveLength(1)
    } finally {
      firstFleetPass.resolve(undefined)
      errorSpy.mockRestore()
      watcher.stop()
    }
  })

  it('retries fail-closed fleet reconciliation when the previous pass failed', async () => {
    vi.useFakeTimers()
    resetMocks()
    const host = {
      metadata: { name: 'stateless-host', namespace: 'mcp-host' },
      spec: { host: 'stateless-host', contextRef: 'context1', secretRef: 'agent-secret' },
    }
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') return { items: [host] }
      return { items: [] }
    })
    const fleetFailure = new Error('fleet did not converge')
    mocks.hostReconcileHosts.mockRejectedValueOnce(fleetFailure).mockResolvedValueOnce(undefined)
    const watcher = newContextAuthoritativeWatcher()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const lifecycleGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()

    try {
      await expect(
        (watcher as any).requestHostFleetReconcile(
          'CommunicationChannel watch interruption',
          lifecycleGeneration
        )
      ).resolves.toBeUndefined()
      expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(4999)
      expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(2)

      expect(errorSpy).toHaveBeenCalledWith(
        '[K8s] Host reconciliation after CommunicationChannel watch interruption failed:',
        fleetFailure
      )
      await vi.advanceTimersByTimeAsync(300000)
      expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(2)
      expect((watcher as any).ccAppliedLifecycleGeneration).toBe(lifecycleGeneration)
    } finally {
      errorSpy.mockRestore()
      watcher.stop()
    }
  })

  it('retries lifecycle convergence when the fresh Host inventory fails', async () => {
    vi.useFakeTimers()
    resetMocks()
    const inventoryFailure = new Error('Host LIST temporarily unavailable')
    let hostListAttempts = 0
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural !== 'hosts') return { items: [] }
      hostListAttempts += 1
      if (hostListAttempts === 1) throw inventoryFailure
      return { items: [] }
    })
    const watcher = newContextAuthoritativeWatcher()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const lifecycleGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()

    try {
      await (watcher as any).requestHostFleetReconcile(
        'CommunicationChannel watch interruption',
        lifecycleGeneration
      )
      expect((watcher as any).ccAppliedLifecycleGeneration).not.toBe(lifecycleGeneration)
      expect(mocks.hostReconcileHosts).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(5000)
      await vi.waitFor(() => expect(mocks.hostReconcileHosts).toHaveBeenCalledOnce())
      expect(hostListAttempts).toBe(2)
      expect((watcher as any).ccAppliedLifecycleGeneration).toBe(lifecycleGeneration)
    } finally {
      errorSpy.mockRestore()
      watcher.stop()
    }
  })

  it('does not retry lifecycle convergence for cleanup-only fleet failures', async () => {
    vi.useFakeTimers()
    resetMocks()
    const cleanupFailure = new Error('orphan cleanup temporarily unavailable')
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') return { items: [] }
      return { items: [] }
    })
    mocks.hostFullReconcile.mockRejectedValueOnce(new HostFleetReconcileError([], [cleanupFailure]))
    const watcher = newContextAuthoritativeWatcher()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const lifecycleGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()

    try {
      await (watcher as any).requestHostFleetReconcile(
        'initial Host reconciliation',
        lifecycleGeneration,
        'full'
      )

      expect((watcher as any).ccAppliedLifecycleGeneration).toBe(lifecycleGeneration)
      await vi.advanceTimersByTimeAsync(300000)
      expect(mocks.hostFullReconcile).toHaveBeenCalledOnce()
    } finally {
      errorSpy.mockRestore()
      watcher.stop()
    }
  })

  it('retries mixed failures as lifecycle work and defers cleanup to the next full pass', async () => {
    vi.useFakeTimers()
    resetMocks()
    const hostFailure = new Error('Host deployment temporarily unavailable')
    const cleanupFailure = new Error('orphan cleanup temporarily unavailable')
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') return { items: [] }
      return { items: [] }
    })
    mocks.hostFullReconcile
      .mockRejectedValueOnce(new HostFleetReconcileError([hostFailure], [cleanupFailure]))
      .mockResolvedValue(undefined)
    const watcher = newContextAuthoritativeWatcher()
    ;(watcher as any).ccCacheSynced = true
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const lifecycleGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()

    try {
      await (watcher as any).requestHostFleetReconcile(
        'initial Host reconciliation',
        lifecycleGeneration,
        'full'
      )
      expect(mocks.hostFullReconcile).toHaveBeenCalledOnce()
      expect(mocks.hostReconcileHosts).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(5000)
      await vi.waitFor(() => expect(mocks.hostReconcileHosts).toHaveBeenCalledOnce())
      expect((watcher as any).ccAppliedLifecycleGeneration).toBe(lifecycleGeneration)

      await (watcher as any).performHostResync()
      expect(mocks.hostFullReconcile).toHaveBeenCalledTimes(2)
      expect(mocks.hostReconcileHosts).toHaveBeenCalledOnce()
    } finally {
      errorSpy.mockRestore()
      watcher.stop()
    }
  })

  it('lets a successful periodic resync consume a pending lifecycle retry', async () => {
    vi.useFakeTimers()
    resetMocks()
    const host = {
      metadata: { name: 'stateless-host', namespace: 'mcp-host' },
      spec: { host: 'stateless-host', contextRef: 'context1', secretRef: 'agent-secret' },
    }
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') return { items: [host] }
      return { items: [] }
    })
    mocks.hostReconcileHosts
      .mockRejectedValueOnce(new Error('lifecycle pass failed'))
      .mockResolvedValue(undefined)
    const watcher = newContextAuthoritativeWatcher()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const lifecycleGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()
    ;(watcher as any).ccCacheSynced = true

    try {
      await (watcher as any).requestHostFleetReconcile(
        'CommunicationChannel recovery',
        lifecycleGeneration
      )
      expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(1)

      await (watcher as any).performHostResync()
      expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(2)
      // Two full passes: the first is the background pass Host watch recovery
      // requested (§10.2 step 8) when the first lifecycle pass synced the cache;
      // the second is the periodic resync. The protected semantic — a successful
      // resync consumes the pending lifecycle retry rather than running it as a
      // third lifecycle pass — is asserted by hostReconcileHosts staying at 2.
      expect(mocks.hostFullReconcile).toHaveBeenCalledTimes(2)
      expect((watcher as any).ccAppliedLifecycleGeneration).toBe(lifecycleGeneration)

      await vi.advanceTimersByTimeAsync(300000)
      expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(2)
      // Still two full passes after the retry window elapses — no additional
      // lifecycle retry was queued (it was consumed by the resync above).
      expect(mocks.hostFullReconcile).toHaveBeenCalledTimes(2)
    } finally {
      errorSpy.mockRestore()
      watcher.stop()
    }
  })

  it('backs off persistent lifecycle convergence failures and caps retries at five minutes', async () => {
    vi.useFakeTimers()
    resetMocks()
    const host = {
      metadata: { name: 'stateless-host', namespace: 'mcp-host' },
      spec: { host: 'stateless-host', contextRef: 'context1', secretRef: 'agent-secret' },
    }
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') return { items: [host] }
      return { items: [] }
    })
    mocks.hostReconcileHosts.mockRejectedValue(new Error('persistent fleet failure'))
    const watcher = newContextAuthoritativeWatcher()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const lifecycleGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()

    try {
      await (watcher as any).requestHostFleetReconcile(
        'CommunicationChannel watch interruption',
        lifecycleGeneration
      )
      expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(1)

      for (const [delay, expectedCalls] of [
        [5000, 2],
        [15000, 3],
        [30000, 4],
        [60000, 5],
        [300000, 6],
        [300000, 7],
      ] as const) {
        await vi.advanceTimersByTimeAsync(delay - 1)
        expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(expectedCalls - 1)
        await vi.advanceTimersByTimeAsync(1)
        expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(expectedCalls)
      }

      expect(
        mocks.listNamespacedCustomObject.mock.calls.filter(
          ([request]) => request.plural === 'hosts'
        )
      ).toHaveLength(1)
    } finally {
      errorSpy.mockRestore()
      watcher.stop()
    }
  })

  it('cancels a stale lifecycle retry when a newer cache transition supersedes it', async () => {
    vi.useFakeTimers()
    resetMocks()
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') return { items: [] }
      return { items: [] }
    })
    mocks.hostReconcileHosts
      .mockRejectedValueOnce(new Error('old generation failed'))
      .mockResolvedValueOnce(undefined)
    const watcher = newContextAuthoritativeWatcher()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const staleGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()
      await (watcher as any).requestHostFleetReconcile('fail-closed', staleGeneration)
      const currentGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()
      await (watcher as any).requestHostFleetReconcile('recovered', currentGeneration)
      expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(300000)
      expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(2)
      expect((watcher as any).ccAppliedLifecycleGeneration).toBe(currentGeneration)
    } finally {
      errorSpy.mockRestore()
      watcher.stop()
    }
  })

  it('does not trust a recovery snapshot without a resourceVersion', async () => {
    resetMocks()
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'communicationchannels') {
        return {
          items: [
            {
              metadata: { name: 'unpaired-channel', namespace: 'channels' },
              spec: { hostRef: 'stateless-host' },
            },
          ],
        }
      }
      return { items: [] }
    })
    const watcher = newContextAuthoritativeWatcher()
    const cache = (watcher as any).communicationChannels as Map<string, any>
    cache.set('previous-channel', {
      name: 'previous-channel',
      namespace: 'channels',
      spec: { hostRef: 'stateless-host' },
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect((watcher as any).recoverCommunicationChannelCache()).resolves.toBe(false)

    expect(watcher.isCommunicationChannelCacheSynced()).toBe(false)
    expect([...cache.keys()]).toEqual(['previous-channel'])
    expect(mocks.watch).not.toHaveBeenCalled()

    errorSpy.mockRestore()
    watcher.stop()
  })

  it('fails closed and schedules a snapshot recovery when the active watch ends', async () => {
    resetMocks()
    const host = {
      metadata: { name: 'stateless-host', namespace: 'mcp-host' },
      spec: { host: 'stateless-host', contextRef: 'context1', secretRef: 'agent-secret' },
    }
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') return { items: [host] }
      return { items: [] }
    })
    let ccDoneCallback: ((err: Error | null) => void) | undefined
    mocks.watch.mockImplementation(
      async (
        path: string,
        _params: object,
        _callback: unknown,
        done: (err: Error | null) => void
      ) => {
        if (path.endsWith('/communicationchannels')) ccDoneCallback = done
        return { abort: vi.fn() }
      }
    )
    const watcher = newContextAuthoritativeWatcher()
    const scheduleSpy = vi
      .spyOn(watcher as any, 'scheduleCommunicationChannelCacheRecovery')
      .mockImplementation(() => {})
    ;(watcher as any).ccCacheSynced = true

    await (watcher as any).startCommunicationChannelWatch('202')
    ccDoneCallback?.(null)

    expect(watcher.isCommunicationChannelCacheSynced()).toBe(false)
    expect((watcher as any).ccLifecycleGeneration).toBe(1)
    expect(scheduleSpy).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(mocks.hostReconcileHosts).toHaveBeenCalledWith([
        expect.objectContaining({ name: 'stateless-host' }),
      ])
    })
    expect((watcher as any).ccAppliedLifecycleGeneration).toBe(1)

    watcher.stop()
  })

  it('opens a fresh watch when the recovered watch closes before Host convergence settles', async () => {
    vi.useFakeTimers()
    resetMocks()
    const host = {
      metadata: { name: 'stateless-host', namespace: 'mcp-host' },
      spec: { host: 'stateless-host', contextRef: 'context1', secretRef: 'agent-secret' },
    }
    let snapshotSequence = 0
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'communicationchannels') {
        snapshotSequence += 1
        return {
          metadata: { resourceVersion: String(300 + snapshotSequence) },
          items: [],
        }
      }
      if (plural === 'hosts') return { items: [host] }
      return { items: [] }
    })
    const doneCallbacks: Array<(err: Error | null) => void> = []
    mocks.watch.mockImplementation(
      async (
        _path: string,
        _params: object,
        _callback: unknown,
        done: (err: Error | null) => void
      ) => {
        doneCallbacks.push(done)
        return { abort: vi.fn() }
      }
    )
    const firstHostConvergence = deferred()
    mocks.hostReconcileHosts
      .mockImplementationOnce(() => firstHostConvergence.promise)
      .mockResolvedValue(undefined)

    const watcher = newContextAuthoritativeWatcher()
    const firstRecovery = (watcher as any).recoverCommunicationChannelCache() as Promise<boolean>

    try {
      await vi.waitFor(() => expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(1))
      expect(communicationChannelWatchCalls()).toHaveLength(1)

      doneCallbacks[0](null)
      await flushMicrotasks()
      expect(watcher.isCommunicationChannelCacheSynced()).toBe(false)

      await vi.advanceTimersByTimeAsync(5000)
      await flushMicrotasks()

      expect(snapshotSequence).toBe(2)
      expect(communicationChannelWatchCalls()).toHaveLength(2)
      expect(communicationChannelWatchCalls()[1]).toEqual([
        expect.any(String),
        { resourceVersion: '302' },
        expect.any(Function),
        expect.any(Function),
      ])
      expect(watcher.isCommunicationChannelCacheSynced()).toBe(true)
    } finally {
      firstHostConvergence.resolve(undefined)
      await firstRecovery
      watcher.stop()
    }
  })

  it('does not trust a watch that closes before watch() returns its request', async () => {
    vi.useFakeTimers()
    resetMocks()
    let snapshotSequence = 0
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'communicationchannels') {
        snapshotSequence += 1
        return {
          metadata: { resourceVersion: String(400 + snapshotSequence) },
          items: [],
        }
      }
      if (plural === 'hosts') return { items: [] }
      return { items: [] }
    })
    mocks.watch
      .mockImplementationOnce(
        async (
          _path: string,
          _params: object,
          _callback: unknown,
          done: (err: Error | null) => void
        ) => {
          done(null)
          return { abort: vi.fn() }
        }
      )
      .mockResolvedValue({ abort: vi.fn() })
    const watcher = newContextAuthoritativeWatcher()

    try {
      await expect((watcher as any).recoverCommunicationChannelCache()).resolves.toBe(false)
      expect(watcher.isCommunicationChannelCacheSynced()).toBe(false)
      expect((watcher as any).ccWatchRequest).toBeNull()

      await vi.advanceTimersByTimeAsync(5000)
      await flushMicrotasks()

      expect(snapshotSequence).toBe(2)
      expect(communicationChannelWatchCalls()).toHaveLength(2)
      expect(watcher.isCommunicationChannelCacheSynced()).toBe(true)
    } finally {
      watcher.stop()
    }
  })

  it('remains fail-closed until the replacement watch request is established', async () => {
    resetMocks()
    const pendingWatch = deferred<{ abort: () => void }>()
    const host = {
      metadata: { name: 'stateless-host', namespace: 'mcp-host' },
      spec: { host: 'stateless-host', contextRef: 'context1', secretRef: 'agent-secret' },
    }
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'communicationchannels') {
        return { metadata: { resourceVersion: '501' }, items: [] }
      }
      if (plural === 'hosts') return { items: [host] }
      return { items: [] }
    })
    mocks.watch.mockImplementationOnce(() => pendingWatch.promise)
    const watcher = newContextAuthoritativeWatcher()
    const recovery = (watcher as any).recoverCommunicationChannelCache() as Promise<boolean>

    try {
      await flushMicrotasks()
      expect(mocks.watch).toHaveBeenCalledTimes(1)
      expect(watcher.isCommunicationChannelCacheSynced()).toBe(false)
      expect(mocks.hostFullReconcile).not.toHaveBeenCalled()
      expect(mocks.hostReconcileHosts).not.toHaveBeenCalled()

      pendingWatch.resolve({ abort: vi.fn() })
      await expect(recovery).resolves.toBe(true)

      expect(watcher.isCommunicationChannelCacheSynced()).toBe(true)
      await vi.waitFor(() => {
        expect(mocks.hostReconcileHosts).toHaveBeenCalledWith([
          expect.objectContaining({ name: 'stateless-host' }),
        ])
      })
    } finally {
      watcher.stop()
    }
  })

  it('ignores events delivered after the active watch has ended', async () => {
    resetMocks()
    let watchCallback:
      | ((
          type: string,
          apiObj: { metadata: { name: string }; spec: { hostRef: string } }
        ) => Promise<void>)
      | undefined
    let doneCallback: ((err: Error | null) => void) | undefined
    mocks.watch.mockImplementation(
      async (
        _path: string,
        _params: object,
        callback: typeof watchCallback,
        done: (err: Error | null) => void
      ) => {
        watchCallback = callback
        doneCallback = done
        return { abort: vi.fn() }
      }
    )
    const watcher = newContextAuthoritativeWatcher()
    const scheduleSpy = vi
      .spyOn(watcher as any, 'scheduleCommunicationChannelCacheRecovery')
      .mockImplementation(() => {})
    const reconcileSpy = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockResolvedValue(undefined)
    ;(watcher as any).ccCacheSynced = true

    await (watcher as any).startCommunicationChannelWatch('502')
    doneCallback?.(null)
    await watchCallback?.('ADDED', {
      metadata: { name: 'late-channel' },
      spec: { hostRef: 'stateless-host' },
    })

    expect(watcher.isCommunicationChannelCacheSynced()).toBe(false)
    expect((watcher as any).communicationChannels.has('late-channel')).toBe(false)
    expect(reconcileSpy).not.toHaveBeenCalled()
    expect(scheduleSpy).toHaveBeenCalledTimes(1)
    watcher.stop()
  })

  it('serializes startup and watch-interruption Host fleet reconciles', async () => {
    resetMocks()
    const initialPass = deferred()
    const host = {
      metadata: { name: 'stateless-host', namespace: 'mcp-host' },
      spec: { host: 'stateless-host', contextRef: 'context1', secretRef: 'agent-secret' },
    }
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'communicationchannels') {
        return { metadata: { resourceVersion: '503' }, items: [] }
      }
      if (plural === 'hosts') return { items: [host] }
      return { items: [] }
    })
    let ccDoneCallback: ((err: Error | null) => void) | undefined
    mocks.watch.mockImplementation(
      async (
        path: string,
        _params: object,
        _callback: unknown,
        done: (err: Error | null) => void
      ) => {
        if (path.endsWith('/communicationchannels')) ccDoneCallback = done
        return { abort: vi.fn() }
      }
    )
    let activePasses = 0
    let maxActivePasses = 0
    mocks.hostFullReconcile.mockImplementationOnce(async () => {
      activePasses += 1
      maxActivePasses = Math.max(maxActivePasses, activePasses)
      await initialPass.promise
      activePasses -= 1
    })
    mocks.hostReconcileHosts.mockImplementation(async () => {
      activePasses += 1
      maxActivePasses = Math.max(maxActivePasses, activePasses)
      activePasses -= 1
    })
    const watcher = newContextAuthoritativeWatcher()
    stubAuthoritativeInventoryWatch(watcher, 'McpServer')
    stubAuthoritativeInventoryWatch(watcher, 'Context')
    vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'scheduleCommunicationChannelCacheRecovery').mockImplementation(
      () => {}
    )
    const start = watcher.start()

    try {
      await vi.waitFor(() => expect(mocks.hostFullReconcile).toHaveBeenCalledTimes(1))
      expect(watcher.isCommunicationChannelCacheSynced()).toBe(true)

      ccDoneCallback?.(null)
      await flushMicrotasks()

      expect(watcher.isCommunicationChannelCacheSynced()).toBe(false)
      expect(mocks.hostFullReconcile).toHaveBeenCalledTimes(1)
      expect(mocks.hostReconcileHosts).not.toHaveBeenCalled()
      expect(maxActivePasses).toBe(1)

      // Startup now resolves after safe bootstrap; the serialized fleet tail
      // keeps running independently and must still drain the queued lifecycle pass.
      await start
      initialPass.resolve(undefined)
      await vi.waitFor(() => expect(mocks.hostReconcileHosts).toHaveBeenCalledOnce())

      expect(mocks.hostFullReconcile).toHaveBeenCalledOnce()
      expect(mocks.hostReconcileHosts).toHaveBeenCalledOnce()
      expect(maxActivePasses).toBe(1)
    } finally {
      initialPass.resolve(undefined)
      watcher.stop()
    }
  })

  it('cancels a scheduled cache recovery when the watcher stops', async () => {
    vi.useFakeTimers()
    resetMocks()
    let doneCallback: ((err: Error | null) => void) | undefined
    const abort = vi.fn()
    mocks.watch.mockImplementation(
      async (
        _path: string,
        _params: object,
        _callback: unknown,
        done: (err: Error | null) => void
      ) => {
        doneCallback = done
        return { abort }
      }
    )
    const watcher = newContextAuthoritativeWatcher()
    ;(watcher as any).ccCacheSynced = true

    await (watcher as any).startCommunicationChannelWatch('504')
    doneCallback?.(null)
    watcher.stop()
    await vi.advanceTimersByTimeAsync(5000)
    await flushMicrotasks()

    expect(mocks.watch).toHaveBeenCalledTimes(1)
    expect(
      mocks.listNamespacedCustomObject.mock.calls.filter(
        ([request]) => request.plural === 'communicationchannels'
      )
    ).toHaveLength(0)
  })

  it('ignores events and completion from a watch replaced by a newer snapshot', async () => {
    resetMocks()
    const callbacks: Array<(type: string, apiObj: any) => Promise<void>> = []
    const doneCallbacks: Array<(err: Error | null) => void> = []
    const requests = [{ abort: vi.fn() }, { abort: vi.fn() }]
    mocks.watch.mockImplementation(
      async (
        _path: string,
        _params: object,
        callback: (type: string, apiObj: any) => Promise<void>,
        done: (err: Error | null) => void
      ) => {
        callbacks.push(callback)
        doneCallbacks.push(done)
        return requests[callbacks.length - 1]
      }
    )
    const watcher = newContextAuthoritativeWatcher()
    const scheduleSpy = vi
      .spyOn(watcher as any, 'scheduleCommunicationChannelCacheRecovery')
      .mockImplementation(() => {})

    await (watcher as any).restartCommunicationChannelWatch({
      resourceVersion: '203',
      channels: [{ name: 'snapshot-one', namespace: 'channels', spec: { hostRef: 'first-host' } }],
    })
    await (watcher as any).restartCommunicationChannelWatch({
      resourceVersion: '204',
      channels: [{ name: 'snapshot-two', namespace: 'channels', spec: { hostRef: 'second-host' } }],
    })
    ;(watcher as any).ccCacheSynced = true

    await callbacks[0]('ADDED', {
      metadata: { name: 'stale-event', namespace: 'channels' },
      spec: { hostRef: 'stale-host' },
    })
    doneCallbacks[0](null)

    const cache = (watcher as any).communicationChannels as Map<string, any>
    expect([...cache.keys()]).toEqual(['snapshot-two'])
    expect(watcher.isCommunicationChannelCacheSynced()).toBe(true)
    expect((watcher as any).ccWatchRequest).toBe(requests[1])
    expect(scheduleSpy).not.toHaveBeenCalled()
    expect(mocks.watch).toHaveBeenNthCalledWith(
      2,
      '/apis/clerum.io/v1alpha1/namespaces/channels/communicationchannels',
      { resourceVersion: '204' },
      expect.any(Function),
      expect.any(Function)
    )

    watcher.stop()
  })
})

describe('McpServerWatcher Host periodic resync serialization', () => {
  afterEach(() => {
    vi.useRealTimers()
    mocks.hostFullReconcile.mockReset().mockResolvedValue(undefined)
    mocks.hostReconcileHosts.mockReset().mockResolvedValue(undefined)
  })

  it('keeps the Host watch stream outside finite Kubernetes request deadlines', async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    const abort = vi.fn()
    const watchRequest = { abort }
    mocks.watch.mockReset().mockResolvedValue(watchRequest)
    const watcher = newContextAuthoritativeWatcher()

    await (watcher as any).startHostWatch('stream-rv')
    await vi.advanceTimersByTimeAsync(30_001)

    expect(mocks.watch).toHaveBeenCalledWith(
      '/apis/clerum.io/v1alpha1/namespaces/mcp-host/hosts',
      { resourceVersion: 'stream-rv' },
      expect.any(Function),
      expect.any(Function)
    )
    expect(abort).not.toHaveBeenCalled()
    expect((watcher as any).hostWatchRequest).toBe(watchRequest)
    watcher.stop()
    expect(abort).toHaveBeenCalledOnce()
  })

  it('coalesces concurrent resync calls while the current pass is in flight', async () => {
    vi.clearAllMocks()
    const host = {
      metadata: { name: 'stateless-host', namespace: 'mcp-host' },
      spec: { host: 'stateless-host', contextRef: 'context1', secretRef: 'agent-secret' },
    }
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') return { items: [host] }
      return { items: [] }
    })
    let finishActivePass!: () => void
    const activePass = new Promise<void>(resolve => {
      finishActivePass = resolve
    })
    mocks.hostFullReconcile
      .mockReset()
      .mockImplementationOnce(() => activePass)
      .mockResolvedValue(undefined)
    const watcher = newContextAuthoritativeWatcher()
    ;(watcher as any).ccCacheSynced = true
    ;(watcher as any).hostFleetScheduler.markLifecycleApplied(
      (watcher as any).ccLifecycleGeneration
    )
    const first = (watcher as any).runHostResync() as Promise<void>

    await vi.waitFor(() => expect(mocks.hostFullReconcile).toHaveBeenCalledTimes(1))

    const second = (watcher as any).runHostResync() as Promise<void>
    const third = (watcher as any).runHostResync() as Promise<void>

    try {
      await vi.waitFor(() => expect(mocks.hostFullReconcile).toHaveBeenCalledTimes(1))
    } finally {
      finishActivePass()
      await Promise.all([first, second, third])
      watcher.stop()
    }

    expect(mocks.hostFullReconcile).toHaveBeenCalledTimes(1)
  })

  it('queues a trailing full Host pass when Context recovery lands during an active pass', async () => {
    vi.clearAllMocks()
    const activePass = deferred()
    mocks.hostFullReconcile
      .mockReset()
      .mockImplementationOnce(() => activePass.promise)
      .mockResolvedValue(undefined)
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'contexts') {
        return {
          metadata: { resourceVersion: 'recovered-context-rv' },
          items: [
            {
              metadata: { name: 'recovered-context', namespace: 'mcp-server' },
              spec: {
                contextId: 'recovered-context',
                mcpServers: [],
                sharedFileSystems: [{ name: 'recovered-sfs' }],
              },
            },
          ],
        }
      }
      return { items: [] }
    })
    mocks.watch.mockReset().mockResolvedValue({ abort: vi.fn() })
    const watcher = newContextAuthoritativeWatcher()
    ;(watcher as any).hostCacheSynced = true

    const first = (watcher as any).requestHostFleetReconcile(
      'before Context recovery'
    ) as Promise<void>
    await vi.waitFor(() => expect(mocks.hostFullReconcile).toHaveBeenCalledTimes(1))

    await expect((watcher as any).recoverContextInventoryAndWatch()).resolves.toBe(true)
    expect(mocks.hostFullReconcile).toHaveBeenCalledTimes(1)

    activePass.resolve(undefined)
    await first
    await vi.waitFor(() => expect(mocks.hostFullReconcile).toHaveBeenCalledTimes(2))

    await watcher.stop()
  })

  it('does not invent another fleet transition during a failed periodic cache recovery', async () => {
    vi.clearAllMocks()
    const watcher = newContextAuthoritativeWatcher()
    ;(watcher as any).ccCacheSynced = false
    const recover = vi
      .spyOn(watcher as any, 'recoverCommunicationChannelCache')
      .mockResolvedValue(false)
    const reconcileFleet = vi
      .spyOn(watcher as any, 'requestHostFleetReconcile')
      .mockResolvedValue(undefined)

    await (watcher as any).performHostResync()

    expect(recover).toHaveBeenCalledTimes(1)
    expect(reconcileFleet).not.toHaveBeenCalled()
    watcher.stop()
  })

  it('coalesces the newest Host input revision into the serialized trailing pass', async () => {
    vi.clearAllMocks()
    const watcher = newContextAuthoritativeWatcher()
    const activePass = deferred()
    const requests: Array<{ inputRevision: number }> = []
    vi.spyOn(watcher as any, 'performHostFleetReconcile').mockImplementation(
      async (...args: unknown[]) => {
        const request = args[0] as { inputRevision: number }
        requests.push({ ...request })
        if (requests.length === 1) await activePass.promise
      }
    )
    ;(watcher as any).hostFleetScheduler.bumpInputRevision()
    const first = (watcher as any).requestHostFleetReconcile('active') as Promise<void>
    ;(watcher as any).hostFleetScheduler.bumpInputRevision()
    const second = (watcher as any).requestHostFleetReconcile('pending-v2') as Promise<void>
    ;(watcher as any).hostFleetScheduler.bumpInputRevision()
    const third = (watcher as any).requestHostFleetReconcile('pending-v3') as Promise<void>

    activePass.resolve(undefined)
    await Promise.all([first, second, third])

    expect(requests).toHaveLength(2)
    expect(requests[1].inputRevision).toBe(3)
    watcher.stop()
  })

  it('collapses overlapping fleet requests into one serialized trailing pass', async () => {
    vi.clearAllMocks()
    const fleetV1 = [
      { metadata: { name: 'stateful-control' }, spec: { host: 'stateful-control' } },
      {
        metadata: { name: 'stateless-primary' },
        spec: { host: 'stateless-primary', lifecycle: { stateless: true } },
      },
    ]
    const fleetV2 = [
      ...fleetV1,
      {
        metadata: { name: 'stateless-sibling' },
        spec: { host: 'stateless-sibling', lifecycle: { stateless: true } },
      },
    ]
    let listCount = 0
    let finishActivePass!: () => void
    const activePass = new Promise<void>(resolve => {
      finishActivePass = resolve
    })
    let activePasses = 0
    let maxActivePasses = 0
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') {
        listCount += 1
        return { items: listCount === 1 ? fleetV1 : fleetV2 }
      }
      return { items: [] }
    })
    mocks.hostReconcileHosts
      .mockReset()
      .mockImplementationOnce(async () => {
        activePasses += 1
        maxActivePasses = Math.max(maxActivePasses, activePasses)
        await activePass
        activePasses -= 1
      })
      .mockImplementation(async () => {
        activePasses += 1
        maxActivePasses = Math.max(maxActivePasses, activePasses)
        activePasses -= 1
      })
    const watcher = newContextAuthoritativeWatcher()
    const firstGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()
    const first = (watcher as any).requestHostFleetReconcile(
      'first',
      firstGeneration
    ) as Promise<void>

    await vi.waitFor(() => expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(1))
    const secondGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()
    const hostCache = (watcher as any).hosts as Map<string, any>
    for (const host of fleetV2) {
      hostCache.set(host.metadata.name, {
        name: host.metadata.name,
        namespace: 'mcp-host',
        spec: host.spec,
      })
    }
    const second = (watcher as any).requestHostFleetReconcile(
      'second',
      secondGeneration
    ) as Promise<void>
    const third = (watcher as any).requestHostFleetReconcile(
      'third',
      secondGeneration
    ) as Promise<void>

    expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(1)
    finishActivePass()
    await Promise.all([first, second, third])

    // One active lifecycle pass (fleetV1) plus exactly ONE trailing pass — the
    // coalescing semantic this test protects. The two later lifecycle requests
    // did not each spawn a pass; they merged into a single trailing pass. That
    // trailing pass is now a FULL pass because the first lifecycle pass drove
    // Host watch recovery on the unsynced cache, which requested a background
    // full pass (§10.2 step 8) that wins the merge over lifecycle. It reconciles
    // the newest cache (fleetV2), and never overlaps the active pass.
    expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(1)
    expect(mocks.hostReconcileHosts).toHaveBeenNthCalledWith(
      1,
      fleetV1.map(host => expect.objectContaining({ name: host.metadata.name }))
    )
    expect(mocks.hostFullReconcile).toHaveBeenCalledTimes(1)
    expect(mocks.hostFullReconcile).toHaveBeenCalledWith(
      fleetV2.map(host => expect.objectContaining({ name: host.metadata.name }))
    )
    expect(listCount).toBe(1)
    expect(maxActivePasses).toBe(1)
    watcher.stop()
  })

  it('uses fresh lifecycle inventory without replacing newer Host watch-cache entries', async () => {
    vi.clearAllMocks()
    const watcher = newContextAuthoritativeWatcher()
    const initialHost = {
      name: 'stateless-primary',
      namespace: 'mcp-host',
      spec: { host: 'stateless-primary', lifecycle: { stateless: true } },
    }
    const newerHost = {
      name: 'stateless-added-during-pass',
      namespace: 'mcp-host',
      spec: { host: 'stateless-added-during-pass', lifecycle: { stateless: true } },
    }
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') {
        return {
          items: [
            {
              metadata: { name: initialHost.name, namespace: initialHost.namespace },
              spec: initialHost.spec,
            },
          ],
        }
      }
      return { items: [] }
    })
    ;(watcher as any).hosts.set(initialHost.name, initialHost)
    let finishActivePass!: () => void
    const activePass = new Promise<void>(resolve => {
      finishActivePass = resolve
    })
    mocks.hostReconcileHosts.mockReset().mockImplementationOnce(() => activePass)
    const reconciler = (watcher as any).hostReconciler
    const lifecycleSpy = vi.spyOn(reconciler, 'reconcileHosts')
    const generation = (watcher as any).beginCommunicationChannelLifecycleTransition()
    const convergence = (watcher as any).requestHostFleetReconcile(
      'CommunicationChannel recovery',
      generation
    ) as Promise<void>

    await vi.waitFor(() => expect(lifecycleSpy).toHaveBeenCalledOnce())
    ;(watcher as any).hosts.set(newerHost.name, newerHost)
    finishActivePass()
    await convergence

    expect((watcher as any).hosts.get(newerHost.name)).toEqual(newerHost)
    expect(
      mocks.listNamespacedCustomObject.mock.calls.filter(([request]) => request.plural === 'hosts')
    ).toHaveLength(1)
    expect(mocks.hostReconcileHosts).toHaveBeenCalledWith([initialHost])
    watcher.stop()
  })

  it('queues a full pass when lifecycle-only work cannot cover the same generation', async () => {
    vi.clearAllMocks()
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') return { items: [] }
      return { items: [] }
    })
    let finishLifecyclePass!: () => void
    const lifecyclePass = new Promise<void>(resolve => {
      finishLifecyclePass = resolve
    })
    mocks.hostReconcileHosts
      .mockReset()
      .mockImplementationOnce(() => lifecyclePass)
      .mockResolvedValue(undefined)
    const watcher = newContextAuthoritativeWatcher()
    const generation = (watcher as any).beginCommunicationChannelLifecycleTransition()
    const lifecycle = (watcher as any).requestHostFleetReconcile(
      'CommunicationChannel interruption',
      generation,
      'lifecycle'
    ) as Promise<void>
    await vi.waitFor(() => expect(mocks.hostReconcileHosts).toHaveBeenCalledOnce())
    const full = (watcher as any).requestHostFleetReconcile(
      'initial Host reconciliation',
      generation,
      'full'
    ) as Promise<void>

    finishLifecyclePass()
    await Promise.all([lifecycle, full])

    expect(mocks.hostReconcileHosts).toHaveBeenCalledOnce()
    expect(mocks.hostFullReconcile).toHaveBeenCalledOnce()
    // Protected semantic: a full request is NOT covered by active lifecycle-only
    // work and queues a separate trailing full pass (one lifecycle + one full
    // pass above). The hosts LIST happens exactly ONCE now: §10.2 decouples
    // watch recovery from the fleet pass, so the trailing full pass reconciles
    // the already-synced cache instead of re-LISTing (the old contract LISTed
    // per pass).
    expect(
      mocks.listNamespacedCustomObject.mock.calls.filter(([request]) => request.plural === 'hosts')
    ).toHaveLength(1)
    watcher.stop()
  })

  it('queues a generation-free full pass behind active lifecycle-only work', async () => {
    vi.clearAllMocks()
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') return { items: [] }
      return { items: [] }
    })
    let finishLifecyclePass!: () => void
    const lifecyclePass = new Promise<void>(resolve => {
      finishLifecyclePass = resolve
    })
    mocks.hostReconcileHosts
      .mockReset()
      .mockImplementationOnce(() => lifecyclePass)
      .mockResolvedValue(undefined)
    const watcher = newContextAuthoritativeWatcher()
    const generation = (watcher as any).beginCommunicationChannelLifecycleTransition()
    const lifecycle = (watcher as any).requestHostFleetReconcile(
      'CommunicationChannel recovery',
      generation,
      'lifecycle'
    ) as Promise<void>
    await vi.waitFor(() => expect(mocks.hostReconcileHosts).toHaveBeenCalledOnce())
    const full = (watcher as any).requestHostFleetReconcile(
      'Periodic resync',
      undefined,
      'full'
    ) as Promise<void>

    finishLifecyclePass()
    await Promise.all([lifecycle, full])

    expect(mocks.hostReconcileHosts).toHaveBeenCalledOnce()
    expect(mocks.hostFullReconcile).toHaveBeenCalledOnce()
    // Protected semantic: a full request is NOT covered by active lifecycle-only
    // work and queues a separate trailing full pass (one lifecycle + one full
    // pass above). The hosts LIST happens exactly ONCE now: §10.2 decouples
    // watch recovery from the fleet pass, so the trailing full pass reconciles
    // the already-synced cache instead of re-LISTing (the old contract LISTed
    // per pass).
    expect(
      mocks.listNamespacedCustomObject.mock.calls.filter(([request]) => request.plural === 'hosts')
    ).toHaveLength(1)
    watcher.stop()
  })

  it('preserves pending full coverage when a newer lifecycle generation arrives', async () => {
    vi.clearAllMocks()
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') return { items: [] }
      return { items: [] }
    })
    let finishLifecyclePass!: () => void
    const lifecyclePass = new Promise<void>(resolve => {
      finishLifecyclePass = resolve
    })
    mocks.hostReconcileHosts
      .mockReset()
      .mockImplementationOnce(() => lifecyclePass)
      .mockResolvedValue(undefined)
    const watcher = newContextAuthoritativeWatcher()
    const firstGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()
    const active = (watcher as any).requestHostFleetReconcile(
      'CommunicationChannel interruption',
      firstGeneration,
      'lifecycle'
    ) as Promise<void>
    await vi.waitFor(() => expect(mocks.hostReconcileHosts).toHaveBeenCalledOnce())
    const pendingFull = (watcher as any).requestHostFleetReconcile(
      'initial Host reconciliation',
      firstGeneration,
      'full'
    ) as Promise<void>
    const secondGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()
    const latestLifecycle = (watcher as any).requestHostFleetReconcile(
      'CommunicationChannel recovery',
      secondGeneration,
      'lifecycle'
    ) as Promise<void>

    finishLifecyclePass()
    await Promise.all([active, pendingFull, latestLifecycle])

    // Protected semantic: a newer lifecycle generation arriving while a full
    // pass is pending does NOT displace the full coverage — it merges in (full
    // wins), so exactly one lifecycle + one full pass run and the newest
    // generation is applied. The hosts LIST happens once now (§10.2 decouples
    // recovery from the fleet pass; the trailing full pass reuses the synced
    // cache rather than re-LISTing).
    expect(mocks.hostReconcileHosts).toHaveBeenCalledOnce()
    expect(mocks.hostFullReconcile).toHaveBeenCalledOnce()
    expect(
      mocks.listNamespacedCustomObject.mock.calls.filter(([request]) => request.plural === 'hosts')
    ).toHaveLength(1)
    expect((watcher as any).ccAppliedLifecycleGeneration).toBe(secondGeneration)
    watcher.stop()
  })

  it('finishes a full pass when its lifecycle generation changes during Host LIST', async () => {
    vi.clearAllMocks()
    const hostList = deferred<{ items: unknown[] }>()
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') return hostList.promise
      return { items: [] }
    })
    mocks.hostFullReconcile.mockReset().mockResolvedValue(undefined)
    mocks.hostReconcileHosts.mockReset().mockResolvedValue(undefined)
    const watcher = newContextAuthoritativeWatcher()
    const firstGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()
    const full = (watcher as any).requestHostFleetReconcile(
      'initial Host reconciliation',
      firstGeneration,
      'full'
    ) as Promise<void>
    await vi.waitFor(() =>
      expect(
        mocks.listNamespacedCustomObject.mock.calls.filter(
          ([request]) => request.plural === 'hosts'
        )
      ).toHaveLength(1)
    )
    const secondGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()
    const lifecycle = (watcher as any).requestHostFleetReconcile(
      'CommunicationChannel recovery',
      secondGeneration,
      'lifecycle'
    ) as Promise<void>

    hostList.resolve({ items: [] })
    await Promise.all([full, lifecycle])

    expect(mocks.hostFullReconcile).toHaveBeenCalledOnce()
    expect(mocks.hostReconcileHosts).toHaveBeenCalledOnce()
    expect((watcher as any).ccAppliedLifecycleGeneration).toBe(secondGeneration)
    watcher.stop()
  })

  it('ignores callbacks from the Host stream retired before a full LIST completes', async () => {
    vi.clearAllMocks()
    const hostList = deferred<{ metadata: { resourceVersion: string }; items: unknown[] }>()
    type HostWatchCallback = (
      type: string,
      host: {
        metadata: { name: string; namespace?: string; generation?: number }
        spec: { host: string; lifecycle?: { stateless?: boolean } }
      }
    ) => Promise<void>
    let hostWatchCallback: HostWatchCallback | undefined
    mocks.watch.mockImplementation(
      async (path: string, _query: unknown, callback: HostWatchCallback) => {
        if (path.endsWith('/hosts')) hostWatchCallback = callback
        return { abort: vi.fn() }
      }
    )
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') return hostList.promise
      return { items: [] }
    })
    mocks.hostFullReconcile.mockReset().mockResolvedValue(undefined)
    const watcher = newContextAuthoritativeWatcher()
    await (watcher as any).startHostWatch('test-host-rv')
    if (!hostWatchCallback) throw new Error('Host watch callback was not installed')

    const full = (watcher as any).requestHostFleetReconcile(
      'Periodic resync',
      undefined,
      'full'
    ) as Promise<void>
    await vi.waitFor(() =>
      expect(
        mocks.listNamespacedCustomObject.mock.calls.filter(
          ([request]) => request.plural === 'hosts'
        )
      ).toHaveLength(1)
    )

    const retiredEvent = hostWatchCallback('MODIFIED', {
      metadata: { name: 'canonical-host', namespace: 'mcp-host', generation: 1 },
      spec: { host: 'canonical-host', lifecycle: { stateless: false } },
    })
    hostList.resolve({
      metadata: { resourceVersion: 'canonical-rv' },
      items: [
        {
          metadata: { name: 'canonical-host', namespace: 'mcp-host', generation: 2 },
          spec: { host: 'canonical-host', lifecycle: { stateless: true } },
        },
      ],
    })
    await Promise.all([full, retiredEvent])

    expect(mocks.hostFullReconcile).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'canonical-host',
        generation: 2,
        spec: { host: 'canonical-host', lifecycle: { stateless: true } },
      }),
    ])
    expect((watcher as any).hosts.get('canonical-host')).toMatchObject({
      generation: 2,
      spec: { lifecycle: { stateless: true } },
    })
    // Generation fence (the protected semantic): the retired-stream callback
    // (canonical-host generation 1) must never drive a reconcile. Under §10.2
    // recovery step 7 the freshly-LISTed canonical-host IS urgently reconciled —
    // but only at generation 2, never the stale generation-1 payload from the
    // retired stream. Assert every reconcile call carried the fresh generation.
    const reconcile = watcher.getHostReconciler().reconcile as unknown as ReturnType<typeof vi.fn>
    expect(reconcile).toHaveBeenCalled()
    for (const [host] of reconcile.mock.calls) {
      expect(host).toMatchObject({ name: 'canonical-host', generation: 2 })
    }
    watcher.stop()
  })

  it('cancels a pending Host event retry when a full snapshot retires its stream', async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    let hostWatchCallback: ((type: string, apiObj: any) => Promise<void>) | undefined
    mocks.watch.mockImplementation(
      async (
        path: string,
        _query: unknown,
        callback: (type: string, apiObj: any) => Promise<void>
      ) => {
        if (path.endsWith('/hosts')) hostWatchCallback = callback
        return { abort: vi.fn() }
      }
    )
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') {
        return {
          metadata: { resourceVersion: 'replacement-rv' },
          items: [
            {
              metadata: { name: 'retry-before-list', namespace: 'mcp-host', generation: 2 },
              spec: { host: 'retry-before-list', lifecycle: { stateless: true } },
            },
          ],
        }
      }
      return { items: [] }
    })
    mocks.hostFullReconcile.mockReset().mockResolvedValue(undefined)
    const watcher = newContextAuthoritativeWatcher()
    const reconcile = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockRejectedValueOnce(new Error('transient event failure'))
      .mockResolvedValue(undefined)
    await (watcher as any).startHostWatch('test-host-rv')
    if (!hostWatchCallback) throw new Error('Host watch callback was not installed')
    markHostInventoryAuthoritative(watcher)

    await hostWatchCallback('MODIFIED', {
      metadata: { name: 'retry-before-list', namespace: 'mcp-host', generation: 1 },
      spec: { host: 'retry-before-list', lifecycle: { stateless: false } },
    })
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect((watcher as any).hostWatchRetryTimers.size).toBe(1)

    // The active Host watch is then lost. A full request must recover a fresh
    // snapshot and retire the failed event's pending retry.
    ;(watcher as any).hostCacheSynced = false
    await (watcher as any).requestHostFleetReconcile('Periodic resync', undefined, 'full')

    expect((watcher as any).hostWatchRetryTimers.size).toBe(0)
    expect((watcher as any).latestHostWatchEventRevisions.size).toBe(0)
    await vi.advanceTimersByTimeAsync(5000)
    // Protected semantic: the pending retry for the failed gen-1 event is
    // CANCELLED when the full snapshot retires the stream — it must not fire
    // after its 5s delay. The gen-1 event is therefore reconciled exactly once
    // (the original failed attempt, never re-run by the retry). Under §10.2
    // recovery step 7 the freshly-LISTed gen-2 host is separately reconciled;
    // that is new, legitimate work, not the cancelled retry.
    const gen1Calls = reconcile.mock.calls.filter(([host]) => host?.generation === 1)
    const gen2Calls = reconcile.mock.calls.filter(([host]) => host?.generation === 2)
    expect(gen1Calls).toHaveLength(1)
    expect(gen2Calls).toHaveLength(1)
    expect(mocks.hostFullReconcile).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'retry-before-list', generation: 2 }),
    ])
    watcher.stop()
  })

  // §10.3 replaces the old global-tail head-of-line contract (independent Host
  // events waited behind an active full pass). The two tests below assert the
  // new contract: an independent Host is admitted immediately during a blocked
  // pass, and same-Host events still reach the per-Host chain in causal order.
  it('admits an independent Host watch event while a full pass is blocked', async () => {
    vi.clearAllMocks()
    const fullReconcile = deferred()
    const order: string[] = []
    type HostWatchCallback = (
      type: string,
      host: {
        metadata: { name: string; namespace?: string; generation?: number }
        spec: { host: string; lifecycle?: { stateless?: boolean } }
      }
    ) => Promise<void>
    let hostWatchCallback: HostWatchCallback | undefined
    mocks.watch.mockImplementation(
      async (path: string, _query: unknown, callback: HostWatchCallback) => {
        if (path.endsWith('/hosts')) hostWatchCallback = callback
        return { abort: vi.fn() }
      }
    )
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural !== 'hosts') return { items: [] }
      return { metadata: { resourceVersion: 'blocked-pass-rv' }, items: [] }
    })
    mocks.hostFullReconcile.mockImplementation(async () => {
      order.push('full:start')
      await fullReconcile.promise
      order.push('full:end')
    })
    const watcher = newContextAuthoritativeWatcher()
    const hostReconciler = watcher.getHostReconciler()
    const reconcile = vi.spyOn(hostReconciler, 'reconcile').mockImplementation(async host => {
      order.push(`watch:${host.name}:${host.generation}`)
    })
    await (watcher as any).startHostWatch('test-host-rv')
    if (!hostWatchCallback)
      throw new Error('Host watch callback was not installed')
      // Cache already synced: the full pass blocks purely on the mocked
      // fullReconcile and does not drive recovery, isolating admission behavior.
    ;(watcher as any).hostCacheSynced = true

    const full = (watcher as any).requestHostFleetReconcile(
      'Periodic resync',
      undefined,
      'full'
    ) as Promise<void>
    await vi.waitFor(() => expect(mocks.hostFullReconcile).toHaveBeenCalledOnce())

    // A watch event for an INDEPENDENT Host must reconcile without waiting for
    // the blocked full pass — the removed global tail no longer gates it.
    const independent = hostWatchCallback('MODIFIED', {
      metadata: { name: 'independent-host', namespace: 'mcp-host', generation: 5 },
      spec: { host: 'independent-host', lifecycle: { stateless: true } },
    })
    await vi.waitFor(() =>
      expect(reconcile).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'independent-host', generation: 5 }),
        'urgent' // direct watch admission reconciles on the urgent lane (F1)
      )
    )
    // Independent Host progressed while the full pass is still blocked.
    expect(order).toContain('watch:independent-host:5')
    expect(order).not.toContain('full:end')

    fullReconcile.resolve()
    await Promise.all([full, independent])
    expect(order).toContain('full:end')
    watcher.stop()
  })

  it('dispatches same-Host watch events to the per-Host chain in causal order', async () => {
    vi.clearAllMocks()
    const order: string[] = []
    type HostWatchCallback = (type: string, host: unknown) => Promise<void>
    let hostWatchCallback: HostWatchCallback | undefined
    mocks.watch.mockImplementation(
      async (path: string, _query: unknown, callback: HostWatchCallback) => {
        if (path.endsWith('/hosts')) hostWatchCallback = callback
        return { abort: vi.fn() }
      }
    )
    mocks.listNamespacedCustomObject.mockImplementation(async () => ({ items: [] }))
    const watcher = newContextAuthoritativeWatcher()
    const hostReconciler = watcher.getHostReconciler()
    // The reconcile()/reconcileDelete() spies stand in for the per-Host chain;
    // the actual serializeByHost non-overlap guarantee is proven in
    // hostReconciler.test.ts (delete serialization). Here we assert the
    // k8sClient dispatch order for the SAME Host is causal and the final cache
    // state belongs to the newest event (§13.1: N+1 follows the same chain).
    vi.spyOn(hostReconciler, 'reconcile').mockImplementation(async (host: HostCRD) => {
      order.push(`reconcile:${host.name}:${host.generation}`)
    })
    vi.spyOn(hostReconciler, 'reconcileDelete').mockImplementation(async (name: string) => {
      order.push(`delete:${name}`)
    })
    await (watcher as any).startHostWatch('same-host-rv')
    if (!hostWatchCallback) throw new Error('Host watch callback was not installed')
    ;(watcher as any).hostCacheSynced = true

    await hostWatchCallback('MODIFIED', {
      metadata: { name: 'same-host', namespace: 'mcp-host', generation: 1 },
      spec: { host: 'same-host', lifecycle: { stateless: false } },
    })
    await hostWatchCallback('MODIFIED', {
      metadata: { name: 'same-host', namespace: 'mcp-host', generation: 2 },
      spec: { host: 'same-host', lifecycle: { stateless: true } },
    })
    await hostWatchCallback('DELETED', {
      metadata: { name: 'same-host', namespace: 'mcp-host', generation: 3 },
      spec: { host: 'same-host' },
    })

    expect(order).toEqual(['reconcile:same-host:1', 'reconcile:same-host:2', 'delete:same-host'])
    expect((watcher as any).hosts.has('same-host')).toBe(false)
    watcher.stop()
  })

  it('advances Host convergence after a timed-out event instead of poisoning the queue', async () => {
    vi.clearAllMocks()
    type HostWatchCallback = (
      type: string,
      host: {
        metadata: { name: string; namespace?: string; generation?: number }
        spec: { host: string; lifecycle?: { stateless?: boolean } }
      }
    ) => Promise<void>
    let hostWatchCallback: HostWatchCallback | undefined
    mocks.watch.mockImplementation(
      async (path: string, _query: unknown, callback: HostWatchCallback) => {
        if (path.endsWith('/hosts')) hostWatchCallback = callback
        return { abort: vi.fn() }
      }
    )
    const watcher = newContextAuthoritativeWatcher()
    const order: string[] = []
    const timeout = new HostK8sRequestTimeoutError('AppsV1Api.readNamespacedDeployment', 30_000)
    const reconcile = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockImplementation(async host => {
        order.push(host.name)
        if (host.name === 'host-a') throw timeout
      })
    await (watcher as any).startHostWatch('test-host-rv')
    if (!hostWatchCallback) throw new Error('Host watch callback was not installed')
    markHostInventoryAuthoritative(watcher)

    const first = hostWatchCallback('MODIFIED', {
      metadata: { name: 'host-a', namespace: 'mcp-host', generation: 1 },
      spec: { host: 'host-a', lifecycle: { stateless: true } },
    })
    const second = hostWatchCallback('MODIFIED', {
      metadata: { name: 'host-b', namespace: 'mcp-host', generation: 1 },
      spec: { host: 'host-b', lifecycle: { stateless: true } },
    })

    await Promise.all([first, second])

    expect(order).toEqual(['host-a', 'host-b'])
    expect(reconcile).toHaveBeenCalledTimes(2)
    expect((watcher as any).hostWatchRetryTimers.has('host-a')).toBe(true)
    watcher.stop()
  })

  it('drops a Host event that arrives after the watcher stops', async () => {
    vi.clearAllMocks()
    let hostWatchCallback: ((type: string, apiObj: any) => Promise<void>) | undefined
    mocks.watch.mockImplementation(
      async (
        path: string,
        _query: unknown,
        callback: (type: string, apiObj: any) => Promise<void>
      ) => {
        if (path.endsWith('/hosts')) hostWatchCallback = callback
        return { abort: vi.fn() }
      }
    )
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') return { items: [] }
      return { items: [] }
    })
    const watcher = newContextAuthoritativeWatcher()
    const reconcile = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockResolvedValue(undefined)
    await (watcher as any).startHostWatch('test-host-rv')
    if (!hostWatchCallback) throw new Error('Host watch callback was not installed')
    ;(watcher as any).hostCacheSynced = true

    // §10.3 removes the global tail, so independent Host events dispatch
    // immediately rather than queuing behind a pass. The drop-on-stop guarantee
    // is now the stopped-guard: a watch event that arrives AFTER the watcher has
    // stopped must not start any reconcile work. Asserted deterministically by
    // awaiting the callback then flushing a microtask — no wait-on-absence.
    watcher.stop()
    const lateEvent = hostWatchCallback('ADDED', {
      metadata: { name: 'stopped-host', namespace: 'mcp-host', generation: 1 },
      spec: { host: 'stopped-host', lifecycle: { stateless: true } },
    })
    await lateEvent
    await Promise.resolve()
    expect(reconcile).not.toHaveBeenCalled()
    expect((watcher as any).hosts.has('stopped-host')).toBe(false)
  })

  it('settles the active caller and lets shutdown unblock a promoted trailing pass', async () => {
    vi.clearAllMocks()
    const host = {
      metadata: { name: 'stateless-host', namespace: 'mcp-host' },
      spec: { host: 'stateless-host', lifecycle: { stateless: true } },
    }
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') return { items: [host] }
      return { items: [] }
    })
    let resolveActivePass!: () => void
    let resolveTrailingPass!: () => void
    const activePass = new Promise<void>(resolve => {
      resolveActivePass = resolve
    })
    const trailingPass = new Promise<void>(resolve => {
      resolveTrailingPass = resolve
    })
    mocks.hostReconcileHosts.mockReset().mockImplementationOnce(() => activePass)
    // The trailing pass is a FULL pass now: the active lifecycle pass drove Host
    // watch recovery on the unsynced cache, which requested a background full
    // pass (§10.2 step 8) that the later lifecycle request merged into (full
    // wins). Block that full pass so it stays running until shutdown unblocks
    // the promoted trailing waiter — the semantic this test protects.
    mocks.hostFullReconcile.mockReset().mockImplementation(() => trailingPass)
    const watcher = newContextAuthoritativeWatcher()
    const activeGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()
    const activeRequest = (watcher as any).requestHostFleetReconcile(
      'startup',
      activeGeneration
    ) as Promise<void>

    await vi.waitFor(() => expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(1))
    const trailingGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()
    const trailingRequest = (watcher as any).requestHostFleetReconcile(
      'watch interruption',
      trailingGeneration
    ) as Promise<void>
    let trailingSettled = false
    void trailingRequest.then(() => {
      trailingSettled = true
    })

    try {
      resolveActivePass()
      await activeRequest
      await vi.waitFor(() => expect(mocks.hostFullReconcile).toHaveBeenCalledTimes(1))
      expect(trailingSettled).toBe(false)

      watcher.stop()
      await trailingRequest
      expect(trailingSettled).toBe(true)
      resolveTrailingPass()
    } finally {
      resolveActivePass()
      resolveTrailingPass()
      watcher.stop()
    }
  })

  it('settles a queued request without starting it after shutdown', async () => {
    vi.clearAllMocks()
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') return { items: [] }
      return { items: [] }
    })
    let resolveActivePass!: () => void
    const activePass = new Promise<void>(resolve => {
      resolveActivePass = resolve
    })
    mocks.hostReconcileHosts.mockReset().mockImplementationOnce(() => activePass)
    const watcher = newContextAuthoritativeWatcher()
    const activeGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()
    const activeRequest = (watcher as any).requestHostFleetReconcile(
      'active',
      activeGeneration
    ) as Promise<void>

    await vi.waitFor(() => expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(1))
    const queuedGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()
    const queuedRequest = (watcher as any).requestHostFleetReconcile(
      'queued',
      queuedGeneration
    ) as Promise<void>
    watcher.stop()

    await expect(queuedRequest).resolves.toBeUndefined()
    expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(1)

    resolveActivePass()
    await activeRequest
    expect(mocks.hostReconcileHosts).toHaveBeenCalledTimes(1)
  })

  it('abandons a stale lifecycle generation and applies only the latest one to the canonical Host cache', async () => {
    vi.clearAllMocks()
    const canonicalFleet = [
      { metadata: { name: 'canonical-host' }, spec: { host: 'canonical-host' } },
    ]
    let resolveInventory!: (value: { items: typeof canonicalFleet }) => void
    const inventory = new Promise<{ items: typeof canonicalFleet }>(resolve => {
      resolveInventory = resolve
    })
    let hostListCount = 0
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural !== 'hosts') return { items: [] }
      hostListCount += 1
      return inventory
    })
    mocks.hostReconcileHosts.mockReset().mockResolvedValue(undefined)
    const watcher = newContextAuthoritativeWatcher()
    const staleGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()
    const staleRequest = (watcher as any).requestHostFleetReconcile(
      'stale transition',
      staleGeneration
    ) as Promise<void>

    await vi.waitFor(() => expect(hostListCount).toBe(1))
    const currentGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()
    const currentRequest = (watcher as any).requestHostFleetReconcile(
      'current transition',
      currentGeneration
    ) as Promise<void>
    resolveInventory({ items: canonicalFleet })
    await Promise.all([staleRequest, currentRequest])

    expect(hostListCount).toBe(1)
    // Protected semantic: the stale-generation lifecycle pass is ABANDONED (its
    // generation no longer matches the current one), so no lifecycle pass runs
    // its work; only the latest work applies, to the freshly-LISTed canonical
    // cache. That latest work now runs as a FULL pass, because Host watch
    // recovery (driven by the first pass) requested a background full pass
    // (§10.2 step 8) into which the current lifecycle request merged (full wins).
    expect(mocks.hostReconcileHosts).not.toHaveBeenCalled()
    expect(mocks.hostFullReconcile).toHaveBeenCalledTimes(1)
    expect(mocks.hostFullReconcile).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'canonical-host' }),
    ])
    expect((watcher as any).hosts.get('canonical-host')).toMatchObject({
      name: 'canonical-host',
    })
    watcher.stop()
  })

  it('does not reconcile or replace the Host cache when stopped during inventory', async () => {
    vi.clearAllMocks()
    let resolveHostInventory!: (value: {
      items: Array<{
        metadata: { name: string; namespace: string }
        spec: { host: string; lifecycle: { stateless: boolean } }
      }>
    }) => void
    const hostInventory = new Promise<{
      items: Array<{
        metadata: { name: string; namespace: string }
        spec: { host: string; lifecycle: { stateless: boolean } }
      }>
    }>(resolve => {
      resolveHostInventory = resolve
    })
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') return hostInventory
      return { items: [] }
    })
    const watcher = newContextAuthoritativeWatcher()
    const run = (watcher as any).requestHostFleetReconcile('shutdown race') as Promise<void>

    await vi.waitFor(() => {
      expect(
        mocks.listNamespacedCustomObject.mock.calls.some(([request]) => request.plural === 'hosts')
      ).toBe(true)
    })
    watcher.stop()
    resolveHostInventory({
      items: [
        {
          metadata: { name: 'late-host', namespace: 'mcp-host' },
          spec: { host: 'late-host', lifecycle: { stateless: true } },
        },
      ],
    })
    await run

    expect(mocks.hostFullReconcile).not.toHaveBeenCalled()
    expect((watcher as any).hosts.size).toBe(0)
  })

  it('releases the periodic single-flight guard after a rejected pass', async () => {
    vi.clearAllMocks()
    const watcher = newContextAuthoritativeWatcher()
    const failure = new Error('transient resync failure')
    const performSpy = vi
      .spyOn(watcher as any, 'performHostResync')
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined)

    await expect((watcher as any).runHostResync()).rejects.toThrow(failure)
    await expect((watcher as any).runHostResync()).resolves.toBeUndefined()

    expect(performSpy).toHaveBeenCalledTimes(2)
    watcher.stop()
  })
})

describe('McpServerWatcher Host watch generation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.watch.mockReset().mockResolvedValue({ abort: vi.fn() })
    mocks.listNamespacedCustomObject
      .mockReset()
      .mockImplementation(async ({ plural }: { plural: string }) => {
        if (plural === 'hosts') {
          return { metadata: { resourceVersion: 'host-recovery-rv' }, items: [] }
        }
        return { items: [] }
      })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('folds a newer lifecycle generation into an in-flight Host inventory recovery', async () => {
    const hostListStarted = deferred()
    const hostList = deferred<{
      metadata: { resourceVersion: string }
      items: unknown[]
    }>()
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') {
        hostListStarted.resolve(undefined)
        return hostList.promise
      }
      return { items: [] }
    })
    const watcher = newContextAuthoritativeWatcher()
    const fleetRequest = vi
      .spyOn(watcher as any, 'requestHostFleetReconcile')
      .mockResolvedValue(undefined)

    const recovery = (watcher as any).recoverHostInventoryAndWatch(
      'Host watch recovery convergence',
      1,
      'watch-recovery'
    ) as Promise<unknown>
    await hostListStarted.promise
    const joined = (watcher as any).recoverHostInventoryAndWatch(
      'initial Host reconciliation',
      2,
      'cold-start'
    ) as Promise<unknown>

    expect(joined).toBe(recovery)
    hostList.resolve({ metadata: { resourceVersion: 'joined-host-rv' }, items: [] })
    await Promise.all([recovery, joined])

    expect(fleetRequest).toHaveBeenCalledOnce()
    expect(fleetRequest).toHaveBeenCalledWith('initial Host reconciliation', 2, 'full')
    await watcher.stop()
  })

  it('adopts a pending cold-start intent when a direct Host recovery starts first', async () => {
    vi.useFakeTimers()
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') {
        return { metadata: { resourceVersion: 'adopted-host-rv' }, items: [] }
      }
      return { items: [] }
    })
    const watcher = newContextAuthoritativeWatcher()
    const fleetRequest = vi
      .spyOn(watcher as any, 'requestHostFleetReconcile')
      .mockResolvedValue(undefined)

    ;(watcher as any).scheduleHostCacheRecovery({
      convergenceReason: 'initial Host reconciliation',
      ccLifecycleGeneration: 2,
      cause: 'cold-start',
    })
    expect((watcher as any).hostCacheRecoveryTimer).not.toBeNull()

    await (watcher as any).recoverHostInventoryAndWatch(
      'Host watch recovery convergence',
      1,
      'watch-recovery'
    )

    expect(mocks.listNamespacedCustomObject).toHaveBeenCalledTimes(1)
    expect(fleetRequest).toHaveBeenCalledOnce()
    expect(fleetRequest).toHaveBeenCalledWith('initial Host reconciliation', 2, 'full')
    expect((watcher as any).hostCacheRecoveryTimer).toBeNull()
    expect((watcher as any).hostCacheRecoveryIntent).toBeNull()
    await watcher.stop()
  })

  it('folds a recovery intent scheduled while Host LIST is in flight into the successful pass', async () => {
    vi.useFakeTimers()
    const hostListStarted = deferred()
    const hostList = deferred<{
      metadata: { resourceVersion: string }
      items: unknown[]
    }>()
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') {
        hostListStarted.resolve(undefined)
        return hostList.promise
      }
      return { items: [] }
    })
    const watcher = newContextAuthoritativeWatcher()
    const fleetRequest = vi
      .spyOn(watcher as any, 'requestHostFleetReconcile')
      .mockResolvedValue(undefined)

    const recovery = (watcher as any).recoverHostInventoryAndWatch(
      'Host watch recovery convergence',
      1,
      'watch-recovery'
    ) as Promise<unknown>
    await hostListStarted.promise
    ;(watcher as any).scheduleHostCacheRecovery({
      convergenceReason: 'CommunicationChannel event Host convergence',
      ccLifecycleGeneration: 3,
      cause: 'cold-start',
    })
    expect((watcher as any).hostCacheRecoveryTimer).not.toBeNull()
    hostList.resolve({ metadata: { resourceVersion: 'in-flight-intent-rv' }, items: [] })
    await recovery

    expect(fleetRequest).toHaveBeenCalledOnce()
    expect(fleetRequest).toHaveBeenCalledWith(
      'CommunicationChannel event Host convergence',
      3,
      'full'
    )
    expect((watcher as any).hostCacheRecoveryTimer).toBeNull()
    expect((watcher as any).hostCacheRecoveryIntent).toBeNull()
    await watcher.stop()
  })

  it('preserves an in-flight recovery intent across failure and the scheduled retry', async () => {
    vi.useFakeTimers()
    const firstHostListStarted = deferred()
    const firstHostList = deferred<{
      metadata: { resourceVersion: string }
      items: unknown[]
    }>()
    let hostListCalls = 0
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural !== 'hosts') return { items: [] }
      hostListCalls += 1
      if (hostListCalls === 1) {
        firstHostListStarted.resolve(undefined)
        return firstHostList.promise
      }
      return { metadata: { resourceVersion: 'retry-preserved-rv' }, items: [] }
    })
    const watcher = newContextAuthoritativeWatcher()
    const fleetRequest = vi
      .spyOn(watcher as any, 'requestHostFleetReconcile')
      .mockResolvedValue(undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const recovery = (watcher as any).recoverHostInventoryAndWatch(
      'Host watch recovery convergence',
      1,
      'watch-recovery'
    ) as Promise<unknown>
    await firstHostListStarted.promise
    ;(watcher as any).scheduleHostCacheRecovery({
      convergenceReason: 'CommunicationChannel event Host convergence',
      ccLifecycleGeneration: 3,
      cause: 'cold-start',
    })
    firstHostList.reject(new Error('transient Host LIST failure'))
    await expect(recovery).rejects.toThrow('transient Host LIST failure')

    expect((watcher as any).hostCacheRecoveryIntent).toEqual({
      convergenceReason: 'CommunicationChannel event Host convergence',
      ccLifecycleGeneration: 3,
      cause: 'cold-start',
    })
    expect((watcher as any).hostCacheRecoveryTimer).not.toBeNull()

    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(fleetRequest).toHaveBeenCalledOnce())

    expect(hostListCalls).toBe(2)
    expect(fleetRequest).toHaveBeenCalledWith(
      'CommunicationChannel event Host convergence',
      3,
      'full'
    )
    expect((watcher as any).hostCacheRecoveryIntent).toBeNull()
    expect((watcher as any).hostCacheRecoveryTimer).toBeNull()
    errorSpy.mockRestore()
    await watcher.stop()
  })

  it('rejects a Host snapshot that cannot anchor a continuing watch', async () => {
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') return { metadata: {}, items: [] }
      return { items: [] }
    })
    const watcher = newContextAuthoritativeWatcher()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await (watcher as any).requestHostFleetReconcile('Periodic resync', undefined, 'full')

    expect(mocks.hostFullReconcile).not.toHaveBeenCalled()
    expect(mocks.watch).not.toHaveBeenCalled()
    expect((watcher as any).hostCacheSynced).toBe(false)
    expect((watcher as any).hostCacheRecoveryTimer).not.toBeNull()
    expect(errorSpy).toHaveBeenCalledWith(
      '[K8s] Host reconciliation after Periodic resync failed:',
      expect.objectContaining({ message: 'Host snapshot missing resourceVersion' })
    )

    errorSpy.mockRestore()
    watcher.stop()
  })

  it('retries from a fresh Host snapshot when versioned watch establishment fails', async () => {
    vi.useFakeTimers()
    let snapshotSequence = 0
    const watchQueries: object[] = []
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural !== 'hosts') return { items: [] }
      snapshotSequence += 1
      return {
        metadata: { resourceVersion: `establish-rv-${snapshotSequence}` },
        items: [],
      }
    })
    mocks.watch.mockImplementation(async (path: string, query: object) => {
      if (!path.endsWith('/hosts')) return { abort: vi.fn() }
      watchQueries.push(query)
      if (watchQueries.length === 1) throw new Error('watch connection failed')
      return { abort: vi.fn() }
    })
    const watcher = newContextAuthoritativeWatcher()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await (watcher as any).requestHostFleetReconcile('Periodic resync', undefined, 'full')

    expect(mocks.hostFullReconcile).not.toHaveBeenCalled()
    expect((watcher as any).hostCacheSynced).toBe(false)
    expect((watcher as any).hostCacheRecoveryTimer).not.toBeNull()
    expect(watchQueries).toEqual([{ resourceVersion: 'establish-rv-1' }])

    await vi.advanceTimersByTimeAsync(5000)
    await vi.waitFor(() => expect(mocks.hostFullReconcile).toHaveBeenCalledOnce())

    expect(snapshotSequence).toBe(2)
    expect(watchQueries).toEqual([
      { resourceVersion: 'establish-rv-1' },
      { resourceVersion: 'establish-rv-2' },
    ])
    expect((watcher as any).hostCacheSynced).toBe(true)
    expect((watcher as any).hostCacheRecoveryTimer).toBeNull()

    errorSpy.mockRestore()
    watcher.stop()
  })

  it('aborts a Host watch request that resolves after shutdown during handoff', async () => {
    const lateRequest = deferred<{ abort: () => void }>()
    const abort = vi.fn()
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural !== 'hosts') return { items: [] }
      return {
        metadata: { resourceVersion: 'shutdown-rv' },
        items: [
          {
            metadata: { name: 'snapshot-host', namespace: 'mcp-host', generation: 1 },
            spec: { host: 'snapshot-host' },
          },
        ],
      }
    })
    mocks.watch.mockImplementation(async (path: string) => {
      if (path.endsWith('/hosts')) return lateRequest.promise
      return { abort: vi.fn() }
    })
    const watcher = newContextAuthoritativeWatcher()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const requested = (watcher as any).requestHostFleetReconcile(
      'Periodic resync',
      undefined,
      'full'
    ) as Promise<void>

    await vi.waitFor(() => expect(mocks.watch).toHaveBeenCalledOnce())
    const internal = (watcher as any).hostFleetScheduler.hostFleetReconcileInFlight
      .promise as Promise<void>
    expect((watcher as any).hosts.has('snapshot-host')).toBe(true)

    watcher.stop()
    lateRequest.resolve({ abort })
    await Promise.all([requested, internal])

    expect(abort).toHaveBeenCalledOnce()
    expect(mocks.hostFullReconcile).not.toHaveBeenCalled()
    expect((watcher as any).hostCacheSynced).toBe(false)
    expect((watcher as any).hostWatchRequest).toBeNull()
    expect((watcher as any).hostCacheRecoveryTimer).toBeNull()
    errorSpy.mockRestore()
  })

  it('recovers a closed Host watch through a fresh LIST and its collection resourceVersion', async () => {
    vi.useFakeTimers()
    const watchQueries: object[] = []
    const doneCallbacks: Array<(err: Error | null) => void> = []
    mocks.watch.mockImplementation(
      async (
        path: string,
        query: object,
        _callback: unknown,
        done: (err: Error | null) => void
      ) => {
        if (path.endsWith('/hosts')) {
          watchQueries.push(query)
          doneCallbacks.push(done)
        }
        return { abort: vi.fn() }
      }
    )
    const watcher = newContextAuthoritativeWatcher()
    await (watcher as any).startHostWatch('initial-rv')
    ;(watcher as any).hostCacheSynced = true

    doneCallbacks[0](Object.assign(new Error('resource version expired'), { statusCode: 410 }))

    expect((watcher as any).hostCacheSynced).toBe(false)
    // Immediate-first-attempt contract: an isolated close (nothing recovered
    // within the 1s floor) re-LISTs NOW in a microtask. The 5s timer stays
    // disarmed and survives only as retry-after-failure pacing.
    expect((watcher as any).hostCacheRecoveryTimer).toBeNull()
    await flushMicrotasks(20)
    await vi.waitFor(() => expect(mocks.hostFullReconcile).toHaveBeenCalledOnce())

    expect(
      mocks.listNamespacedCustomObject.mock.calls.filter(([request]) => request.plural === 'hosts')
    ).toHaveLength(1)
    expect(watchQueries).toEqual([
      { resourceVersion: 'initial-rv' },
      { resourceVersion: 'host-recovery-rv' },
    ])
    expect((watcher as any).hostCacheSynced).toBe(true)
    // The disarmed timer must not produce a duplicate re-LIST at +5s.
    await vi.advanceTimersByTimeAsync(5000)
    expect(
      mocks.listNamespacedCustomObject.mock.calls.filter(([request]) => request.plural === 'hosts')
    ).toHaveLength(1)
    watcher.stop()
  })

  it('retires a pending Host event retry before recovering a normally closed watch', async () => {
    vi.useFakeTimers()
    const callbacks: Array<(type: string, apiObj: any) => Promise<void>> = []
    const doneCallbacks: Array<(err: Error | null) => void> = []
    mocks.watch.mockImplementation(
      async (
        path: string,
        _query: object,
        callback: (type: string, apiObj: any) => Promise<void>,
        done: (err: Error | null) => void
      ) => {
        if (path.endsWith('/hosts')) {
          callbacks.push(callback)
          doneCallbacks.push(done)
        }
        return { abort: vi.fn() }
      }
    )
    const watcher = newContextAuthoritativeWatcher()
    const reconcile = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockRejectedValueOnce(new Error('transient event failure'))
      .mockResolvedValue(undefined)

    await (watcher as any).requestHostFleetReconcile('Periodic resync', undefined, 'full')
    await callbacks[0]('MODIFIED', {
      metadata: { name: 'retry-host', namespace: 'mcp-host', uid: 'retry-host-uid', generation: 1 },
      spec: { host: 'retry-host', lifecycle: { stateless: true } },
    })
    expect(reconcile).toHaveBeenCalledOnce()
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'retry-host-uid' }),
      'urgent'
    )
    expect((watcher as any).hostWatchRetryTimers.size).toBe(1)
    expect((watcher as any).latestHostWatchEventRevisions.size).toBe(1)

    doneCallbacks[0](null)

    expect((watcher as any).hostWatchRetryTimers.size).toBe(0)
    expect((watcher as any).hostWatchRetryAttempts.size).toBe(0)
    expect((watcher as any).latestHostWatchEventRevisions.size).toBe(0)
    await callbacks[0]('MODIFIED', {
      metadata: { name: 'retry-host', namespace: 'mcp-host', generation: 0 },
      spec: { host: 'retry-host', lifecycle: { stateless: false } },
    })
    expect(reconcile).toHaveBeenCalledOnce()
    expect((watcher as any).hosts.get('retry-host')).toMatchObject({
      uid: 'retry-host-uid',
      generation: 1,
      spec: { lifecycle: { stateless: true } },
    })
    await vi.advanceTimersByTimeAsync(5000)
    await vi.waitFor(() => expect(mocks.hostFullReconcile).toHaveBeenCalledTimes(2))

    expect(reconcile).toHaveBeenCalledOnce()
    expect(callbacks).toHaveLength(2)
    expect(
      mocks.listNamespacedCustomObject.mock.calls.filter(([request]) => request.plural === 'hosts')
    ).toHaveLength(2)
    expect((watcher as any).hostCacheSynced).toBe(true)
    watcher.stop()
  })

  it('recovers a closed watch independently of an active full pass', async () => {
    vi.useFakeTimers()
    const firstFullReconcile = deferred()
    let snapshotSequence = 0
    const watchQueries: object[] = []
    const doneCallbacks: Array<(err: Error | null) => void> = []
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural !== 'hosts') return { items: [] }
      snapshotSequence += 1
      return {
        metadata: { resourceVersion: `host-rv-${snapshotSequence}` },
        items: [],
      }
    })
    mocks.watch.mockImplementation(
      async (
        path: string,
        query: object,
        _callback: unknown,
        done: (err: Error | null) => void
      ) => {
        if (path.endsWith('/hosts')) {
          watchQueries.push(query)
          doneCallbacks.push(done)
        }
        return { abort: vi.fn() }
      }
    )
    mocks.hostFullReconcile
      .mockImplementationOnce(() => firstFullReconcile.promise)
      .mockResolvedValue(undefined)
    const watcher = newContextAuthoritativeWatcher()
    const full = (watcher as any).requestHostFleetReconcile(
      'Periodic resync',
      undefined,
      'full'
    ) as Promise<void>

    // The first full pass drives watch recovery: LIST #1 + watch from host-rv-1,
    // then blocks inside the (mocked) fullReconcile.
    await vi.waitFor(() => expect(mocks.hostFullReconcile).toHaveBeenCalledOnce())
    expect(snapshotSequence).toBe(1)

    // The watch closes while the full pass is still blocked.
    doneCallbacks[0](null)
    expect((watcher as any).hostCacheSynced).toBe(false)
    expect((watcher as any).hostCacheRecoveryTimer).not.toBeNull()

    // §10.2 decouples watch recovery from the fleet pass. Under the OLD contract
    // the closed-watch recovery request was COVERED (deferred) by the active
    // full pass, so no re-LIST happened until the pass finished. Now recovery is
    // an independent, deduplicated operation: when its retry timer fires it
    // re-establishes LIST -> WATCH immediately (snapshot #2, fresh watch from the
    // new resourceVersion) WITHOUT waiting for the still-blocked full pass, and
    // marks authority known again. This test protects that independence plus the
    // re-arm-on-close semantic.
    await vi.advanceTimersByTimeAsync(5000)
    expect(snapshotSequence).toBe(2)
    expect((watcher as any).hostCacheSynced).toBe(true)
    expect(watchQueries).toEqual([
      { resourceVersion: 'host-rv-1' },
      { resourceVersion: 'host-rv-2' },
    ])
    expect((watcher as any).hostCacheRecoveryTimer).toBeNull()

    // The still-blocked original full pass resolving afterward does not disturb
    // the independently recovered watch authority.
    firstFullReconcile.resolve(undefined)
    await full
    expect((watcher as any).hostCacheSynced).toBe(true)
    watcher.stop()
  })

  it('pairs a full Host snapshot with a watch from its opaque collection resourceVersion', async () => {
    vi.clearAllMocks()
    const hostWatchQueries: object[] = []
    const aborts: Array<ReturnType<typeof vi.fn>> = []
    mocks.watch.mockImplementation(async (path: string, query: object) => {
      const abort = vi.fn()
      if (path.endsWith('/hosts')) {
        hostWatchQueries.push(query)
        aborts.push(abort)
      }
      return { abort }
    })
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural !== 'hosts') return { items: [] }
      return {
        metadata: { resourceVersion: 'opaque/rv:abc' },
        items: [
          {
            metadata: { name: 'snapshot-host', namespace: 'mcp-host', generation: 2 },
            spec: { host: 'snapshot-host', lifecycle: { stateless: true } },
          },
        ],
      }
    })
    const watcher = newContextAuthoritativeWatcher()
    await (watcher as any).startHostWatch('test-host-rv')

    await (watcher as any).requestHostFleetReconcile('Periodic resync', undefined, 'full')

    expect(hostWatchQueries).toEqual([
      { resourceVersion: 'test-host-rv' },
      { resourceVersion: 'opaque/rv:abc' },
    ])
    expect(aborts[0]).toHaveBeenCalledOnce()
    expect(mocks.hostFullReconcile).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'snapshot-host', generation: 2 }),
    ])
    watcher.stop()
  })

  it('ignores a delayed MODIFIED callback from the Host stream retired by a full snapshot', async () => {
    vi.clearAllMocks()
    const callbacks: Array<(type: string, apiObj: any) => Promise<void>> = []
    mocks.watch.mockImplementation(
      async (
        path: string,
        _query: object,
        callback: (type: string, apiObj: any) => Promise<void>
      ) => {
        if (path.endsWith('/hosts')) callbacks.push(callback)
        return { abort: vi.fn() }
      }
    )
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural !== 'hosts') return { items: [] }
      return {
        metadata: { resourceVersion: 'opaque-rv-2' },
        items: [
          {
            metadata: { name: 'transition-host', namespace: 'mcp-host', generation: 2 },
            spec: { host: 'transition-host', lifecycle: { stateless: true } },
          },
        ],
      }
    })
    const watcher = newContextAuthoritativeWatcher()
    const reconcile = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockResolvedValue(undefined)
    await (watcher as any).startHostWatch('test-host-rv')
    await (watcher as any).requestHostFleetReconcile('Periodic resync', undefined, 'full')

    await callbacks[0]('MODIFIED', {
      metadata: { name: 'transition-host', namespace: 'mcp-host', generation: 1 },
      spec: { host: 'transition-host', lifecycle: { stateless: false } },
    })

    expect(callbacks).toHaveLength(2)
    // Generation fence (the protected semantic): the delayed MODIFIED delivered
    // on the retired stream (transition-host generation 1) is ignored — it must
    // never drive a reconcile and must not overwrite the cache. Under §10.2
    // recovery step 7 the freshly-LISTed transition-host IS urgently reconciled,
    // but only at generation 2, never the stale generation-1 payload.
    expect(reconcile).toHaveBeenCalled()
    for (const [host] of reconcile.mock.calls) {
      expect(host).toMatchObject({ name: 'transition-host', generation: 2 })
    }
    expect((watcher as any).hosts.get('transition-host')).toMatchObject({
      generation: 2,
      spec: { lifecycle: { stateless: true } },
    })
    watcher.stop()
  })

  it('ignores a delayed DELETE from a retired stream after same-name Host recreation', async () => {
    vi.clearAllMocks()
    const callbacks: Array<(type: string, apiObj: any) => Promise<void>> = []
    mocks.watch.mockImplementation(
      async (
        path: string,
        _query: object,
        callback: (type: string, apiObj: any) => Promise<void>
      ) => {
        if (path.endsWith('/hosts')) callbacks.push(callback)
        return { abort: vi.fn() }
      }
    )
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural !== 'hosts') return { items: [] }
      return {
        metadata: { resourceVersion: 'opaque-rv-recreated' },
        items: [
          {
            metadata: { name: 'recreated-host', namespace: 'mcp-host', generation: 1 },
            spec: { host: 'recreated-host', lifecycle: { stateless: true } },
          },
        ],
      }
    })
    const watcher = newContextAuthoritativeWatcher()
    const reconcileDelete = vi
      .spyOn(watcher.getHostReconciler(), 'reconcileDelete')
      .mockResolvedValue(undefined)
    await (watcher as any).startHostWatch('test-host-rv')
    await (watcher as any).requestHostFleetReconcile('Periodic resync', undefined, 'full')

    await callbacks[0]('DELETED', {
      metadata: { name: 'recreated-host', namespace: 'mcp-host', generation: 8 },
      spec: { host: 'recreated-host', lifecycle: { stateless: false } },
    })

    expect(callbacks).toHaveLength(2)
    expect(reconcileDelete).not.toHaveBeenCalled()
    expect((watcher as any).hosts.get('recreated-host')).toMatchObject({
      spec: { lifecycle: { stateless: true } },
    })
    watcher.stop()
  })

  it('recovery diff enqueues an immediate per-Host delete for a disappeared Host (#827 item 1)', async () => {
    vi.clearAllMocks()
    const watcher = newContextAuthoritativeWatcher()
    markHostInventoryAuthoritative(watcher)
    const reconcileDelete = vi
      .spyOn(watcher.getHostReconciler(), 'reconcileDelete')
      .mockResolvedValue(undefined)
    // Fresh authoritative snapshot holds only "live-host"; "gone-host" was in the
    // pre-recovery inventory (previousNames) and has genuinely disappeared.
    ;(watcher as any).enqueueRecoveredHostDeletes(
      [{ name: 'live-host', namespace: 'mcp-host', uid: 'u1', spec: { host: 'live-host' } }],
      new Set(['live-host', 'gone-host'])
    )
    await vi.waitFor(() =>
      expect(reconcileDelete).toHaveBeenCalledWith('gone-host', 'mcp-host', expect.anything())
    )
    // A Host still present in the fresh snapshot is never deleted.
    expect(reconcileDelete).not.toHaveBeenCalledWith('live-host', 'mcp-host', expect.anything())
    watcher.stop()
  })

  // The recovery diff resolves absence at LIST time. Between that diff and the
  // moment the delete is admitted to the per-Host serializer, the recreation's
  // ADDED can land: the watch callback sets `this.hosts` SYNCHRONOUSLY and
  // enters the per-Host chain FIRST, while the fire-and-forget dispatch queues
  // the delete SECOND. serializeByHost is strict FIFO, so without a fence the
  // new bundle is created and then wiped. The fence must therefore read the
  // LIVE cache at admission, not a value captured at enqueue time.
  //
  // This is the case the sibling recreation test does NOT cover: there the
  // recreated Host is present in the snapshot, so enqueueRecoveredHostDeletes
  // short-circuits on snapshotNames.has(name) and never dispatches at all.
  it('recovery delete carries a live-cache fence for a Host recreated during admission (#827 F2 parity)', async () => {
    vi.clearAllMocks()
    const watcher = newContextAuthoritativeWatcher()
    markHostInventoryAuthoritative(watcher)
    const reconcileDelete = vi
      .spyOn(watcher.getHostReconciler(), 'reconcileDelete')
      .mockResolvedValue(undefined)
    // "ghost" is absent from the fresh authoritative snapshot → genuinely
    // disappeared → dispatched for delete.
    ;(watcher as any).enqueueRecoveredHostDeletes([], new Set(['ghost']))
    await vi.waitFor(() => expect(reconcileDelete).toHaveBeenCalled())

    const [, , opts] = reconcileDelete.mock.calls[0] as [
      string,
      string,
      { skipIf?: () => boolean } | undefined,
    ]
    expect(opts?.skipIf, 'the recovery delete must carry a skipIf fence').toBeTypeOf('function')

    // Cache does not hold the name → the Host really is gone → do NOT skip.
    expect(opts!.skipIf!()).toBe(false)

    // The recreation lands in the live cache during the admission window.
    ;(watcher as any).hosts.set('ghost', {
      name: 'ghost',
      namespace: 'mcp-host',
      uid: 'uid-recreated',
      generation: 1,
      spec: { host: 'ghost' },
    })
    // Same fence, re-evaluated at admission → skip the destructive delete.
    expect(opts!.skipIf!()).toBe(true)
    watcher.stop()
  })

  it('recovery diff reconciles (does NOT delete) a same-name Host recreated with a new uid (#827 items 1+2)', async () => {
    vi.clearAllMocks()
    const watcher = newContextAuthoritativeWatcher()
    markHostInventoryAuthoritative(watcher)
    const reconcile = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockResolvedValue(undefined)
    const reconcileDelete = vi
      .spyOn(watcher.getHostReconciler(), 'reconcileDelete')
      .mockResolvedValue(undefined)
    // The recreated Host is the CURRENT cache entry the urgent dispatch resolves.
    ;(watcher as any).hosts.set('x', {
      name: 'x',
      namespace: 'mcp-host',
      uid: 'uid-B',
      generation: 1,
      spec: { host: 'x' },
    })
    // Same name, same generation (reset to 1), but a DIFFERENT uid than before.
    ;(watcher as any).enqueueRecoveredUrgentHosts(
      [{ name: 'x', namespace: 'mcp-host', uid: 'uid-B', generation: 1, spec: { host: 'x' } }],
      new Set(['x']),
      new Map([['x', 1]]),
      new Map([['x', 'uid-A']])
    )
    // The snapshot still contains "x" by name, so the recovery-delete diff never
    // treats it as a disappearance.
    ;(watcher as any).enqueueRecoveredHostDeletes(
      [{ name: 'x', namespace: 'mcp-host', uid: 'uid-B', generation: 1, spec: { host: 'x' } }],
      new Set(['x'])
    )
    await vi.waitFor(() =>
      expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ name: 'x' }), 'urgent')
    )
    expect(reconcileDelete).not.toHaveBeenCalled()
    watcher.stop()
  })

  it('suppresses a watch event whose identity (uid) differs from the cached Host (#827 item 2)', () => {
    const watcher = newContextAuthoritativeWatcher()
    ;(watcher as any).hosts.set('x', {
      name: 'x',
      namespace: 'mcp-host',
      uid: 'uid-B',
      generation: 3,
    })
    ;(watcher as any).latestHostWatchEventRevisions.set('x', 7)
    // A stale MODIFIED carrying the OLD identity must not act on the recreated one.
    expect(
      (watcher as any).isCurrentHostWatchEvent(
        'MODIFIED',
        { name: 'x', namespace: 'mcp-host', uid: 'uid-A', generation: 3 },
        7
      )
    ).toBe(false)
    // The current identity is admitted.
    expect(
      (watcher as any).isCurrentHostWatchEvent(
        'MODIFIED',
        { name: 'x', namespace: 'mcp-host', uid: 'uid-B', generation: 3 },
        7
      )
    ).toBe(true)
    watcher.stop()
  })

  it('recovery urgently admits a wake-pending Host that is otherwise unchanged (§10.2 step 7 wake branch)', async () => {
    vi.clearAllMocks()
    const watcher = newContextAuthoritativeWatcher()
    markHostInventoryAuthoritative(watcher)
    const reconcile = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockResolvedValue(undefined)
    // A Host unchanged by name, generation AND uid but carrying a pending wake
    // annotation must still be admitted on the urgent lane after recovery, so a
    // wake discovered during the LIST→WATCH gap is not deferred to the slow
    // background fleet pass (A3: 2m47s admission vs 3s execution). This closes
    // the recovery-time wake branch that the watch-time admission test does not
    // exercise: deleting `|| wakePending` from enqueueRecoveredUrgentHosts()
    // would make this assertion fail.
    ;(watcher as any).hosts.set('waker', {
      name: 'waker',
      namespace: 'mcp-host',
      uid: 'u1',
      generation: 4,
      annotations: { 'clerum.io/wake-requested': '7' },
      spec: { host: 'waker' },
    })
    ;(watcher as any).enqueueRecoveredUrgentHosts(
      [
        {
          name: 'waker',
          namespace: 'mcp-host',
          uid: 'u1',
          generation: 4,
          annotations: { 'clerum.io/wake-requested': '7' },
          spec: { host: 'waker' },
        },
      ],
      new Set(['waker']), // NOT new
      new Map([['waker', 4]]), // NOT changed (same generation)
      new Map([['waker', 'u1']]) // NOT recreated (same uid)
    )
    await vi.waitFor(() =>
      expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ name: 'waker' }), 'urgent')
    )
    watcher.stop()
  })

  it('recovery does NOT urgently dispatch a fully-unchanged Host with no wake annotation', async () => {
    vi.clearAllMocks()
    const watcher = newContextAuthoritativeWatcher()
    const reconcile = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockResolvedValue(undefined)
    // Same name, generation and uid as before recovery and no wake pending: the
    // background fleet pass already covers it, so recovery must NOT enqueue a
    // redundant urgent reconcile (guards the negative side of the predicate).
    ;(watcher as any).hosts.set('steady', {
      name: 'steady',
      namespace: 'mcp-host',
      uid: 'u1',
      generation: 4,
      spec: { host: 'steady' },
    })
    ;(watcher as any).enqueueRecoveredUrgentHosts(
      [
        {
          name: 'steady',
          namespace: 'mcp-host',
          uid: 'u1',
          generation: 4,
          spec: { host: 'steady' },
        },
      ],
      new Set(['steady']),
      new Map([['steady', 4]]),
      new Map([['steady', 'u1']])
    )
    // Let any erroneously-scheduled async dispatch run before asserting absence.
    await Promise.resolve()
    await Promise.resolve()
    expect(reconcile).not.toHaveBeenCalled()
    watcher.stop()
  })

  it('reconciles a retried Host watch event on the "retry" lane, not "urgent" (F1)', async () => {
    vi.useFakeTimers()
    let hostWatchCallback: ((type: string, apiObj: any) => Promise<void>) | undefined
    mocks.watch.mockImplementation(
      async (
        _path: string,
        _params: object,
        callback: (type: string, apiObj: any) => Promise<void>
      ) => {
        hostWatchCallback = callback
        return { abort: vi.fn() }
      }
    )
    const watcher = newContextAuthoritativeWatcher()
    const reconcile = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined)
    await (watcher as any).startHostWatch('test-host-rv')
    if (!hostWatchCallback) throw new Error('Host watch callback was not installed')
    markHostInventoryAuthoritative(watcher)

    await hostWatchCallback('MODIFIED', {
      metadata: { name: 'retry-lane-host', namespace: 'mcp-host', generation: 2 },
      spec: { host: 'retry-lane-host', lifecycle: { stateless: true } },
    })
    // First attempt is the direct/urgent admission.
    expect(reconcile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: 'retry-lane-host' }),
      'urgent'
    )
    await vi.advanceTimersByTimeAsync(5000)
    // The retry attempt populates the distinct "retry" lane.
    expect(reconcile).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: 'retry-lane-host' }),
      'retry'
    )
    watcher.stop()
    vi.useRealTimers()
  })

  it('automatically retries a transient Host watch reconciliation failure', async () => {
    vi.useFakeTimers()
    let hostWatchCallback: ((type: string, apiObj: any) => Promise<void>) | undefined
    mocks.watch.mockImplementation(
      async (
        _path: string,
        _params: object,
        callback: (type: string, apiObj: any) => Promise<void>
      ) => {
        hostWatchCallback = callback
        return { abort: vi.fn() }
      }
    )
    const watcher = newContextAuthoritativeWatcher()
    const unrelatedHost = {
      name: 'unrelated-host',
      namespace: 'mcp-host',
      generation: 4,
      spec: { host: 'unrelated-host', lifecycle: { stateless: true } },
    }
    ;(watcher as any).hosts.set(unrelatedHost.name, unrelatedHost)
    const reconcile = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockRejectedValueOnce(Object.assign(new Error('disappeared'), { code: 404 }))
      .mockResolvedValue(undefined)
    await (watcher as any).startHostWatch('test-host-rv')
    const watchGeneration = (watcher as any).hostWatchGeneration
    if (!hostWatchCallback) throw new Error('Host watch callback was not installed')
    markHostInventoryAuthoritative(watcher)

    await hostWatchCallback('ADDED', {
      metadata: { name: 'retry-host', namespace: 'mcp-host', generation: 1 },
      spec: { host: 'retry-host', lifecycle: { stateless: true } },
    })
    expect(reconcile).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4999)
    expect(reconcile).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(reconcile).toHaveBeenCalledTimes(2)
    expect((watcher as any).hostWatchRetryTimers.size).toBe(0)
    expect((watcher as any).hostWatchRetryAttempts.size).toBe(0)
    expect(
      mocks.listNamespacedCustomObject.mock.calls.filter(([request]) => request.plural === 'hosts')
    ).toHaveLength(0)
    expect(mocks.watch).toHaveBeenCalledOnce()
    expect(mocks.hostFullReconcile).not.toHaveBeenCalled()
    expect((watcher as any).hostWatchGeneration).toBe(watchGeneration)
    expect((watcher as any).hosts.get(unrelatedHost.name)).toEqual(unrelatedHost)
    watcher.stop()
  })

  it('bounds repeated Host watch retries and stops after exhaustion', async () => {
    vi.useFakeTimers()
    let hostWatchCallback: ((type: string, apiObj: any) => Promise<void>) | undefined
    mocks.watch.mockImplementation(
      async (
        _path: string,
        _params: object,
        callback: (type: string, apiObj: any) => Promise<void>
      ) => {
        hostWatchCallback = callback
        return { abort: vi.fn() }
      }
    )
    const watcher = newContextAuthoritativeWatcher()
    const reconcile = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockRejectedValue(new Error('persistent failure'))
    await (watcher as any).startHostWatch('test-host-rv')
    if (!hostWatchCallback) throw new Error('Host watch callback was not installed')
    markHostInventoryAuthoritative(watcher)

    await hostWatchCallback('ADDED', {
      metadata: { name: 'bounded-host', namespace: 'mcp-host', generation: 1 },
      spec: { host: 'bounded-host', lifecycle: { stateless: true } },
    })
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(15000)
    await vi.advanceTimersByTimeAsync(30000)
    expect(reconcile).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(300000)
    expect(reconcile).toHaveBeenCalledTimes(4)
    expect((watcher as any).hostWatchRetryTimers.size).toBe(0)
    expect((watcher as any).hostWatchRetryAttempts.size).toBe(0)
    watcher.stop()
  })

  it('cancels an older failed Host retry when a newer event succeeds', async () => {
    vi.useFakeTimers()
    let hostWatchCallback: ((type: string, apiObj: any) => Promise<void>) | undefined
    mocks.watch.mockImplementation(
      async (
        _path: string,
        _params: object,
        callback: (type: string, apiObj: any) => Promise<void>
      ) => {
        hostWatchCallback = callback
        return { abort: vi.fn() }
      }
    )
    const watcher = newContextAuthoritativeWatcher()
    const reconcile = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockRejectedValueOnce(new Error('stale event failed'))
      .mockResolvedValue(undefined)
    await (watcher as any).startHostWatch('test-host-rv')
    if (!hostWatchCallback) throw new Error('Host watch callback was not installed')
    markHostInventoryAuthoritative(watcher)

    await hostWatchCallback('ADDED', {
      metadata: { name: 'superseded-host', namespace: 'mcp-host', generation: 1 },
      spec: { host: 'superseded-host', lifecycle: { stateless: true } },
    })
    await hostWatchCallback('MODIFIED', {
      metadata: { name: 'superseded-host', namespace: 'mcp-host', generation: 2 },
      spec: { host: 'superseded-host', lifecycle: { stateless: true } },
    })
    await vi.advanceTimersByTimeAsync(60000)

    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(reconcile.mock.calls[1][0]).toMatchObject({ generation: 2 })
    expect((watcher as any).hostWatchRetryTimers.size).toBe(0)
    watcher.stop()
  })
})

describe('McpServerWatcher.startCommunicationChannelWatch', () => {
  it('caches ADDED events and triggers Host reconcile', async () => {
    const watcher = new McpServerWatcher()
    markHostInventoryAuthoritative(watcher)
    const hosts = (watcher as any).hosts as Map<string, any>
    hosts.set('marketing', {
      name: 'marketing',
      namespace: 'mcp-host',
      spec: { host: 'marketing', contextRef: 'c', secretRef: 's' },
    })
    const reconcileSpy = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockResolvedValue(undefined)

    const watchCallback = (watcher as any).getCommunicationChannelWatchCallback()
    await watchCallback('ADDED', {
      metadata: { name: 'cc-marketing', namespace: 'channels' },
      spec: { hostRef: 'marketing' },
    })

    const cache = (watcher as any).communicationChannels as Map<string, any>
    expect(cache.get('cc-marketing')?.spec.hostRef).toBe('marketing')
    expect(reconcileSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'marketing' }))
  })

  it('removes from cache on DELETED and triggers Host reconcile', async () => {
    const watcher = new McpServerWatcher()
    markHostInventoryAuthoritative(watcher)
    const cache = (watcher as any).communicationChannels as Map<string, any>
    cache.set('cc-marketing', {
      name: 'cc-marketing',
      namespace: 'channels',
      spec: { hostRef: 'marketing' },
    })
    const hosts = (watcher as any).hosts as Map<string, any>
    hosts.set('marketing', {
      name: 'marketing',
      namespace: 'mcp-host',
      spec: { host: 'marketing', contextRef: 'c', secretRef: 's' },
    })
    const reconcileSpy = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockResolvedValue(undefined)

    const watchCallback = (watcher as any).getCommunicationChannelWatchCallback()
    await watchCallback('DELETED', {
      metadata: { name: 'cc-marketing', namespace: 'channels' },
      spec: { hostRef: 'marketing' },
    })

    expect(cache.has('cc-marketing')).toBe(false)
    expect(reconcileSpy).toHaveBeenCalled()
  })

  it('on MODIFIED with hostRef change, reconciles BOTH old and new hosts', async () => {
    const watcher = new McpServerWatcher()
    markHostInventoryAuthoritative(watcher)
    const cache = (watcher as any).communicationChannels as Map<string, any>
    cache.set('cc-1', {
      name: 'cc-1',
      namespace: 'channels',
      spec: { hostRef: 'old-host' },
    })
    const hosts = (watcher as any).hosts as Map<string, any>
    hosts.set('old-host', {
      name: 'old-host',
      namespace: 'mcp-host',
      spec: { host: 'old-host', contextRef: 'c', secretRef: 's' },
    })
    hosts.set('new-host', {
      name: 'new-host',
      namespace: 'mcp-host',
      spec: { host: 'new-host', contextRef: 'c', secretRef: 's' },
    })
    const reconcileSpy = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockResolvedValue(undefined)

    const watchCallback = (watcher as any).getCommunicationChannelWatchCallback()
    await watchCallback('MODIFIED', {
      metadata: { name: 'cc-1', namespace: 'channels' },
      spec: { hostRef: 'new-host' },
    })

    expect(reconcileSpy).toHaveBeenCalledTimes(2)
    const names = reconcileSpy.mock.calls.map(c => (c[0] as any).name).sort()
    expect(names).toEqual(['new-host', 'old-host'])
  })

  it('ignores unknown event types (e.g. BOOKMARK) without mutating cache or reconciling', async () => {
    const watcher = new McpServerWatcher()
    const cache = (watcher as any).communicationChannels as Map<string, any>
    cache.set('cc-1', {
      name: 'cc-1',
      namespace: 'channels',
      spec: { hostRef: 'marketing' },
    })
    const hosts = (watcher as any).hosts as Map<string, any>
    hosts.set('marketing', {
      name: 'marketing',
      namespace: 'mcp-host',
      spec: { host: 'marketing', contextRef: 'c', secretRef: 's' },
    })
    const reconcileSpy = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockResolvedValue(undefined)

    const watchCallback = (watcher as any).getCommunicationChannelWatchCallback()
    await watchCallback('BOOKMARK', {
      metadata: { name: 'cc-1', namespace: 'channels' },
      spec: { hostRef: 'marketing' },
    })

    expect(cache.get('cc-1')?.spec.hostRef).toBe('marketing')
    expect(reconcileSpy).not.toHaveBeenCalled()
  })
})

describe('McpServerWatcher.startCommunicationChannelWatch — channel-reader revision rolls', () => {
  it('on CC ADDED, patches the new host channel-reader revision annotation', async () => {
    const watcher = new McpServerWatcher()
    markHostInventoryAuthoritative(watcher)
    const hosts = (watcher as any).hosts as Map<string, any>
    hosts.set('marketing', {
      name: 'marketing',
      namespace: 'mcp-host',
      spec: { host: 'marketing', contextRef: 'c', secretRef: 's' },
    })
    const patchSpy = vi
      .spyOn(watcher.getHostReconciler(), 'patchChannelReaderRevisionAnnotation')
      .mockResolvedValue(undefined)

    const watchCallback = (watcher as any).getCommunicationChannelWatchCallback()
    await watchCallback('ADDED', {
      metadata: { name: 'cc-marketing', namespace: 'channels' },
      spec: { hostRef: 'marketing' },
    })

    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy).toHaveBeenCalledWith('marketing')
  })

  it('preserves credentialsSecretRef from the watch event into the cache', async () => {
    const watcher = new McpServerWatcher()
    markHostInventoryAuthoritative(watcher)
    const cache = (watcher as any).communicationChannels as Map<string, any>
    const hosts = (watcher as any).hosts as Map<string, any>
    hosts.set('marketing', {
      name: 'marketing',
      namespace: 'mcp-host',
      spec: { host: 'marketing', contextRef: 'c', secretRef: 's' },
    })
    vi.spyOn(watcher.getHostReconciler(), 'patchChannelReaderRevisionAnnotation').mockResolvedValue(
      undefined
    )

    const watchCallback = (watcher as any).getCommunicationChannelWatchCallback()
    await watchCallback('ADDED', {
      metadata: { name: 'cc-marketing', namespace: 'channels' },
      spec: {
        hostRef: 'marketing',
        credentialsSecretRef: { name: 'cc-marketing-credentials' },
      },
    })

    const cached = cache.get('cc-marketing')
    expect(cached.spec.credentialsSecretRef).toEqual({ name: 'cc-marketing-credentials' })
    // findCommunicationChannelsByCredentialsSecretName must find the cached CC
    expect(
      watcher.findCommunicationChannelsByCredentialsSecretName('cc-marketing-credentials')
    ).toHaveLength(1)
  })

  it('on CC MODIFIED with hostRef change, patches BOTH old and new hosts', async () => {
    const watcher = new McpServerWatcher()
    markHostInventoryAuthoritative(watcher)
    const cache = (watcher as any).communicationChannels as Map<string, any>
    cache.set('cc-1', {
      name: 'cc-1',
      namespace: 'channels',
      spec: { hostRef: 'old-host' },
    })
    const hosts = (watcher as any).hosts as Map<string, any>
    hosts.set('old-host', {
      name: 'old-host',
      namespace: 'mcp-host',
      spec: { host: 'old-host', contextRef: 'c', secretRef: 's' },
    })
    hosts.set('new-host', {
      name: 'new-host',
      namespace: 'mcp-host',
      spec: { host: 'new-host', contextRef: 'c', secretRef: 's' },
    })
    const patchSpy = vi
      .spyOn(watcher.getHostReconciler(), 'patchChannelReaderRevisionAnnotation')
      .mockResolvedValue(undefined)

    const watchCallback = (watcher as any).getCommunicationChannelWatchCallback()
    await watchCallback('MODIFIED', {
      metadata: { name: 'cc-1', namespace: 'channels' },
      spec: { hostRef: 'new-host' },
    })

    expect(patchSpy).toHaveBeenCalledTimes(2)
    const targets = patchSpy.mock.calls.map(c => c[0] as string).sort()
    expect(targets).toEqual(['new-host', 'old-host'])
  })

  it('on CC DELETED, patches the (former) host channel-reader revision annotation', async () => {
    const watcher = new McpServerWatcher()
    markHostInventoryAuthoritative(watcher)
    const cache = (watcher as any).communicationChannels as Map<string, any>
    cache.set('cc-marketing', {
      name: 'cc-marketing',
      namespace: 'channels',
      spec: { hostRef: 'marketing' },
    })
    const hosts = (watcher as any).hosts as Map<string, any>
    hosts.set('marketing', {
      name: 'marketing',
      namespace: 'mcp-host',
      spec: { host: 'marketing', contextRef: 'c', secretRef: 's' },
    })
    const patchSpy = vi
      .spyOn(watcher.getHostReconciler(), 'patchChannelReaderRevisionAnnotation')
      .mockResolvedValue(undefined)

    const watchCallback = (watcher as any).getCommunicationChannelWatchCallback()
    await watchCallback('DELETED', {
      metadata: { name: 'cc-marketing', namespace: 'channels' },
      spec: { hostRef: 'marketing' },
    })

    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy).toHaveBeenCalledWith('marketing')
  })

  it('swallows patchChannelReaderRevisionAnnotation errors without breaking the watch loop', async () => {
    const watcher = new McpServerWatcher()
    markHostInventoryAuthoritative(watcher)
    const hosts = (watcher as any).hosts as Map<string, any>
    hosts.set('marketing', {
      name: 'marketing',
      namespace: 'mcp-host',
      spec: { host: 'marketing', contextRef: 'c', secretRef: 's' },
    })
    vi.spyOn(watcher.getHostReconciler(), 'patchChannelReaderRevisionAnnotation').mockRejectedValue(
      new Error('boom')
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const watchCallback = (watcher as any).getCommunicationChannelWatchCallback()
    await expect(
      watchCallback('ADDED', {
        metadata: { name: 'cc-marketing', namespace: 'channels' },
        spec: { hostRef: 'marketing' },
      })
    ).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()

    errorSpy.mockRestore()
  })
})

describe('externalEgressResyncDelayMs (issue #299 H2)', () => {
  it('returns the configured interval (ms) when no TTL has been observed', () => {
    expect(externalEgressResyncDelayMs(60, 5)).toBe(60_000)
    expect(externalEgressResyncDelayMs(60, 5, Infinity)).toBe(60_000)
  })

  it('advances to TTL/2 when the observed TTL is faster than the interval', () => {
    expect(externalEgressResyncDelayMs(60, 5, 15_000)).toBe(7_500)
  })

  it('never drops below the floor even for a tiny TTL', () => {
    expect(externalEgressResyncDelayMs(60, 5, 6_000)).toBe(5_000)
  })

  it('keeps the configured interval when the observed TTL is large', () => {
    expect(externalEgressResyncDelayMs(60, 5, 600_000)).toBe(60_000)
  })

  it('clamps a below-floor configured interval up to the floor', () => {
    expect(externalEgressResyncDelayMs(3, 5)).toBe(5_000)
  })
})

describe('McpServerWatcher readiness under sustained watch churn (GKE Premature-close regime)', () => {
  // Regression for the clerum-dev livelock. PR #205 coupled /ready to a safety
  // certificate whose validity was pinned to the watch GENERATION. On GKE the
  // apiserver closes long-lived watches ("Premature close") every few minutes;
  // each reconnect re-LISTs and bumps the generation, so every certification
  // pass aborted before it could persist and /ready stayed 503 forever — even
  // though the re-listed inventory was byte-identical. minikube never reproduced
  // this because its single local apiserver does not drop watches, which is
  // exactly why T2 stayed green while dev broke. This test injects the sustained
  // churn deterministically so the regression is caught in CI, not in production.
  it('certifies readiness under sustained Context watch churn when every re-list returns identical inventory', async () => {
    vi.useFakeTimers()

    // Stable desired state: the same Context in every LIST. Models clerum-dev,
    // where nothing changed — only the watch dropped and reconnected.
    const stableContexts = [
      {
        metadata: {
          name: 'churn-context',
          namespace: 'mcp-server',
          uid: 'churn-uid-1',
          generation: 1,
        },
        spec: { contextId: 'churn-context', mcpServers: [] },
      },
    ]
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'contexts') {
        return { metadata: { resourceVersion: 'ctx-rv-stable' }, items: stableContexts }
      }
      if (plural === 'mcpservers') {
        return { metadata: { resourceVersion: 'mcp-rv-stable' }, items: [] }
      }
      if (plural === 'hosts') {
        return { metadata: { resourceVersion: 'host-rv-stable' }, items: [] }
      }
      if (plural === 'communicationchannels') {
        return { metadata: { resourceVersion: 'cc-rv-stable' }, items: [] }
      }
      return { items: [] }
    })

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const watcher = new McpServerWatcher()
    vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockResolvedValue(undefined)

    // Model a "Premature close" reconnect that lands DURING each authoritative
    // revocation pass: the pass captures its safety certificate, then the watch
    // reconnects and recovery re-LISTs the identical inventory — so the watch
    // GENERATION advances (channel identity) while the desired REVISION (content
    // identity) is unchanged and the cache stays authoritative. The #205 code
    // pinned the certificate to the generation, so it refused here on every pass
    // and livelocked; the fix pins it to the revision, so it certifies through
    // the churn.
    let passes = 0
    let reconnects = 0
    mocks.netPolFullReconcile.mockImplementation(
      async (
        _ctxs: unknown,
        _servers: unknown,
        options: { onAuthoritativeRevocationComplete?: () => void } | undefined
      ) => {
        passes += 1
        ;(watcher as any).contextWatchGeneration += 2
        ;(watcher as any).mcpWatchGeneration += 2
        reconnects += 1
        options?.onAuthoritativeRevocationComplete?.()
      }
    )

    const server = new ContextMapperServer(watcher, 0, undefined, undefined, () =>
      watcher.isReadinessInventoryAuthoritative()
    )
    await server.start()

    try {
      await watcher.start()
      server.setReady(true)

      // Sustain the churn for a fixed number of authoritative passes. Each pass
      // takes a reconnect (generation bump) with a byte-identical re-LIST. We do
      // NOT stop early: the regime must run enough times that a livelock is
      // unmistakable, and the fix must hold readiness through all of it.
      const CHURN_PASSES = 5
      for (let i = 0; i < CHURN_PASSES; i += 1) {
        await (watcher as any).runInitialNetworkPolicyConvergence()
        await flushMicrotasks()
      }

      // The adverse regime actually ran (zero-tests-is-never-success).
      expect(passes).toBeGreaterThanOrEqual(CHURN_PASSES)
      expect(reconnects).toBeGreaterThanOrEqual(CHURN_PASSES)
      // The livelock assertion: an identical re-LIST must not keep readiness
      // down. #205 code → false (livelock). Fixed code → true.
      expect(
        watcher.isReadinessInventoryAuthoritative(),
        `livelock: ${passes} authoritative passes completed under sustained churn ` +
          `(${reconnects} reconnects, identical inventory on every re-LIST) ` +
          `and none certified the safety inventory`
      ).toBe(true)
      expect((await requestReadyOverHttp(server)).statusCode).toBe(200)
    } finally {
      await server.stop()
      await watcher.stop()
      errorSpy.mockRestore()
      warnSpy.mockRestore()
      logSpy.mockRestore()
    }
  })

  // R1 (fail-closed guardrail): the content-identity gate must NOT paper over a
  // genuine safety failure. If the authoritative pass could not revoke a real
  // stale allow (hasCertifiedSafetyInventory stays false), readiness must remain
  // 503 no matter how quiet the content is. This is the barrier that stops a
  // future "fix" from certifying on identical content when safety never certified.
  it('stays fail-closed under sustained churn when the safety pass never certified', async () => {
    vi.useFakeTimers()
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'contexts') {
        return {
          metadata: { resourceVersion: 'ctx-rv-stable' },
          items: [
            {
              metadata: { name: 'fc-ctx', namespace: 'mcp-server', uid: 'fc-uid', generation: 1 },
              spec: { contextId: 'fc-ctx', mcpServers: [] },
            },
          ],
        }
      }
      if (plural === 'mcpservers') return { metadata: { resourceVersion: 'mcp-rv' }, items: [] }
      if (plural === 'hosts') return { metadata: { resourceVersion: 'host-rv' }, items: [] }
      if (plural === 'communicationchannels')
        return { metadata: { resourceVersion: 'cc-rv' }, items: [] }
      return { items: [] }
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const watcher = new McpServerWatcher()
    vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockResolvedValue(undefined)
    // The authoritative pass aborts revoking a real stale allow: it never certifies.
    mocks.hasCertifiedSafetyInventory.mockReturnValue(false)
    let passes = 0
    mocks.netPolFullReconcile.mockImplementation(async () => {
      passes += 1
      ;(watcher as any).contextWatchGeneration += 2
      ;(watcher as any).mcpWatchGeneration += 2
      // No onAuthoritativeRevocationComplete: the revocation did not complete.
    })
    const server = new ContextMapperServer(watcher, 0, undefined, undefined, () =>
      watcher.isReadinessInventoryAuthoritative()
    )
    await server.start()
    try {
      await watcher.start()
      server.setReady(true)
      const CHURN_PASSES = 5
      for (let i = 0; i < CHURN_PASSES; i += 1) {
        await (watcher as any).runInitialNetworkPolicyConvergence()
        await flushMicrotasks()
      }
      expect(passes).toBeGreaterThanOrEqual(CHURN_PASSES)
      expect(
        watcher.isReadinessInventoryAuthoritative(),
        'fail-closed violated: readiness certified while the safety pass never did'
      ).toBe(false)
      expect((await requestReadyOverHttp(server)).statusCode).toBe(503)
    } finally {
      await server.stop()
      await watcher.stop()
      mocks.hasCertifiedSafetyInventory.mockReturnValue(true)
      errorSpy.mockRestore()
      warnSpy.mockRestore()
      logSpy.mockRestore()
    }
  })

  it('installContextSnapshot bumps the desired revision only when re-listed content changed', () => {
    const watcher = new McpServerWatcher()
    const ctxA = {
      name: 'a',
      namespace: 'mcp-server',
      uid: 'ua',
      generation: 1,
      spec: { contextId: 'a', mcpServers: [] },
    }
    ;(watcher as any).installContextSnapshot({ contexts: [ctxA], resourceVersion: 'rv1' })
    const base = (watcher as any).contextDesiredRevision
    // Identical re-LIST (a Premature-close reconnect) must NOT bump.
    ;(watcher as any).installContextSnapshot({ contexts: [ctxA], resourceVersion: 'rv2' })
    expect((watcher as any).contextDesiredRevision).toBe(base)
    // A spec change on the same identity MUST bump.
    ;(watcher as any).installContextSnapshot({
      contexts: [{ ...ctxA, generation: 2, spec: { contextId: 'a', mcpServers: ['s1'] } }],
      resourceVersion: 'rv3',
    })
    expect((watcher as any).contextDesiredRevision).toBe(base + 1)
    // A removal MUST bump.
    ;(watcher as any).installContextSnapshot({ contexts: [], resourceVersion: 'rv4' })
    expect((watcher as any).contextDesiredRevision).toBe(base + 2)
    // An addition MUST bump.
    ;(watcher as any).installContextSnapshot({ contexts: [ctxA], resourceVersion: 'rv5' })
    expect((watcher as any).contextDesiredRevision).toBe(base + 3)
  })

  it('installMcpServerSnapshot bumps the desired revision only when re-listed content changed', () => {
    const watcher = new McpServerWatcher()
    const srvA = {
      name: 'a',
      namespace: 'mcp-server',
      uid: 'ua',
      generation: 1,
      spec: {
        contextRef: 'ctx',
        image: 'clerum/a:v1',
        transport: { type: 'streamableHttp' as const, port: 3000 },
      },
    }
    ;(watcher as any).installMcpServerSnapshot({ servers: [srvA], resourceVersion: 'rv1' })
    const base = (watcher as any).mcpServerDesiredRevision
    // Identical re-LIST must NOT bump.
    ;(watcher as any).installMcpServerSnapshot({ servers: [srvA], resourceVersion: 'rv2' })
    expect((watcher as any).mcpServerDesiredRevision).toBe(base)
    // A spec change MUST bump.
    ;(watcher as any).installMcpServerSnapshot({
      servers: [{ ...srvA, generation: 2, spec: { ...srvA.spec, image: 'clerum/a:v2' } }],
      resourceVersion: 'rv3',
    })
    expect((watcher as any).mcpServerDesiredRevision).toBe(base + 1)
    // A removal MUST bump.
    ;(watcher as any).installMcpServerSnapshot({ servers: [], resourceVersion: 'rv4' })
    expect((watcher as any).mcpServerDesiredRevision).toBe(base + 2)
  })

  it('installHostSnapshot bumps the desired revision only when re-listed content changed', () => {
    const watcher = new McpServerWatcher()
    const hostA = {
      name: 'a',
      namespace: 'mcp-host',
      uid: 'ua',
      generation: 1,
      spec: { contextRef: 'ctx' },
    } as unknown as HostCRD
    ;(watcher as any).installHostSnapshot({ hosts: [hostA], resourceVersion: 'rv1' })
    const base = (watcher as any).hostDesiredRevision
    // Identical re-LIST (a Premature-close reconnect) must NOT bump — this is
    // what stops the Host mutation-authority fence from starving every reconcile.
    ;(watcher as any).installHostSnapshot({ hosts: [hostA], resourceVersion: 'rv2' })
    expect((watcher as any).hostDesiredRevision).toBe(base)
    // A spec change (metadata.generation advances) MUST bump.
    ;(watcher as any).installHostSnapshot({
      hosts: [{ ...hostA, generation: 2 }],
      resourceVersion: 'rv3',
    })
    expect((watcher as any).hostDesiredRevision).toBe(base + 1)
    // A removal MUST bump.
    ;(watcher as any).installHostSnapshot({ hosts: [], resourceVersion: 'rv4' })
    expect((watcher as any).hostDesiredRevision).toBe(base + 2)
  })

  it('installHostSnapshot is deliberately blind to Host annotations/labels (pins the mutation-relevance invariant)', () => {
    // Guards the SCOPE note on sameHostDesiredRevision: the Host comparator is
    // uid+generation only, unlike the McpServer/Context comparators that hash
    // labels/annotations. That is correct ONLY while no Host annotation/label is
    // load-bearing for a mutation (the wake annotation drives dispatch, not
    // template content). This test pins that contract: annotation/label churn at
    // the SAME (uid, generation) — e.g. a Premature-close re-LIST — must NOT bump
    // the desired revision. If a Host annotation/label ever becomes mutation-
    // relevant, whoever extends the comparator to hash it will break this test and
    // be forced to re-examine the fail-open the SCOPE note warns about.
    const watcher = new McpServerWatcher()
    const hostA = {
      name: 'a',
      namespace: 'mcp-host',
      uid: 'ua',
      generation: 1,
      spec: { contextRef: 'ctx' },
      annotations: { 'clerum.io/wake': 'v1' },
      labels: { tier: 'a' },
    } as unknown as HostCRD
    ;(watcher as any).installHostSnapshot({ hosts: [hostA], resourceVersion: 'rv1' })
    const base = (watcher as any).hostDesiredRevision
    ;(watcher as any).installHostSnapshot({
      hosts: [
        {
          ...hostA,
          annotations: { 'clerum.io/wake': 'v2', 'clerum.io/added': 'x' },
          labels: { tier: 'b' },
        },
      ],
      resourceVersion: 'rv2',
    })
    expect((watcher as any).hostDesiredRevision).toBe(base)
  })
})

describe('McpServerWatcher watch-close recovery latency (immediate first attempt + floor)', () => {
  // GKE closes long-lived watches ("Premature close") every few minutes. The
  // old contract armed a FIXED 5s timer before the first re-LIST, so every
  // isolated close cost ~5.5s of /ready 503. The hardened contract: the FIRST
  // recovery attempt after a close is IMMEDIATE (microtask, no timer), a paced
  // timer survives only as the retry-after-failure pacing (now the jittered
  // exponential backoff: first failure retries within [500ms, 1000ms]), and an
  // anti-busy-loop FLOOR (1s) demotes a close that arrives <1s after the last
  // successful recovery back onto the paced timer so a degraded apiserver is
  // never hammered with back-to-back re-LISTs.
  const inventoryLanes = [
    {
      kind: 'McpServer',
      plural: 'mcpservers',
      pathSuffix: '/mcpservers',
      restartMethod: 'restartMcpServerWatch',
      startSnapshot: { resourceVersion: 'mcp-start-rv', servers: [] },
      startRv: 'mcp-start-rv',
      recoveryRvPrefix: 'mcp-close-recovery-rv',
      timerField: 'mcpServerCacheRecoveryTimer',
      syncedField: 'mcpServerCacheSynced',
      peerSyncedField: 'contextCacheSynced',
    },
    {
      kind: 'Context',
      plural: 'contexts',
      pathSuffix: '/contexts',
      restartMethod: 'restartContextWatch',
      startSnapshot: { resourceVersion: 'context-start-rv', contexts: [] },
      startRv: 'context-start-rv',
      recoveryRvPrefix: 'context-close-recovery-rv',
      timerField: 'contextCacheRecoveryTimer',
      syncedField: 'contextCacheSynced',
      peerSyncedField: 'mcpServerCacheSynced',
    },
  ] as const

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mocks.watch.mockReset().mockResolvedValue({ abort: vi.fn() })
    mocks.listNamespacedCustomObject.mockReset().mockResolvedValue({ items: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(inventoryLanes)(
    're-LISTs the $kind inventory immediately (microtask, no 5s timer) when its watch closes',
    async lane => {
      const doneCallbacks: Array<(error: Error | null) => void> = []
      const watchQueries: unknown[] = []
      let listCalls = 0
      mocks.watch.mockImplementation(async (path, options, _callback, done) => {
        if (path.endsWith(lane.pathSuffix)) {
          doneCallbacks.push(done)
          watchQueries.push(options)
        }
        return { abort: vi.fn() }
      })
      mocks.listNamespacedCustomObject.mockImplementation(
        async ({ plural }: { plural: string }) => {
          if (plural === lane.plural) {
            listCalls += 1
            return {
              metadata: { resourceVersion: `${lane.recoveryRvPrefix}-${listCalls}` },
              items: [],
            }
          }
          return { items: [] }
        }
      )
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const watcher = new McpServerWatcher()
      ;(watcher as any)[lane.peerSyncedField] = true
      await (watcher as any)[lane.restartMethod](lane.startSnapshot)
      expect(watchQueries).toEqual([{ resourceVersion: lane.startRv }])

      doneCallbacks[0](Object.assign(new Error('Premature close'), { statusCode: 500 }))
      await flushMicrotasks(20)

      // Immediate first attempt: fresh LIST + fresh watch WITHOUT advancing
      // any timer. Under the old contract this stayed at 0 until +5000ms.
      expect(listCalls).toBe(1)
      expect(watchQueries).toEqual([
        { resourceVersion: lane.startRv },
        { resourceVersion: `${lane.recoveryRvPrefix}-1` },
      ])
      expect((watcher as any)[lane.syncedField]).toBe(true)
      expect((watcher as any)[lane.timerField]).toBeNull()

      // No retry timer was armed: +5s must not produce a duplicate re-LIST.
      await vi.advanceTimersByTimeAsync(5000)
      expect(listCalls).toBe(1)
      logSpy.mockRestore()
      await watcher.stop()
    }
  )

  it('re-LISTs the Host inventory immediately (microtask, no 5s timer) when its watch closes', async () => {
    const doneCallbacks: Array<(error: Error | null) => void> = []
    const watchQueries: unknown[] = []
    let hostListCalls = 0
    mocks.watch.mockImplementation(async (path, options, _callback, done) => {
      if (path.endsWith('/hosts')) {
        doneCallbacks.push(done)
        watchQueries.push(options)
      }
      return { abort: vi.fn() }
    })
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') {
        hostListCalls += 1
        return {
          metadata: { resourceVersion: `host-close-recovery-rv-${hostListCalls}` },
          items: [],
        }
      }
      return { items: [] }
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const watcher = newContextAuthoritativeWatcher()
    const fleetRequest = vi
      .spyOn(watcher as any, 'requestHostFleetReconcile')
      .mockResolvedValue(undefined)
    await (watcher as any).startHostWatch('host-initial-rv')
    ;(watcher as any).hostCacheSynced = true

    doneCallbacks[0](Object.assign(new Error('Premature close'), { statusCode: 500 }))
    expect((watcher as any).hostCacheSynced).toBe(false)
    await flushMicrotasks(20)

    // Immediate first attempt: fresh LIST + fresh watch WITHOUT advancing any
    // timer. Under the old contract this stayed at 0 until +5000ms.
    expect(hostListCalls).toBe(1)
    expect(watchQueries).toEqual([
      { resourceVersion: 'host-initial-rv' },
      { resourceVersion: 'host-close-recovery-rv-1' },
    ])
    expect((watcher as any).hostCacheSynced).toBe(true)
    expect((watcher as any).hostCacheRecoveryTimer).toBeNull()
    expect(fleetRequest).toHaveBeenCalledOnce()

    // No retry timer was armed: +5s must not produce a duplicate re-LIST.
    await vi.advanceTimersByTimeAsync(5000)
    expect(hostListCalls).toBe(1)
    logSpy.mockRestore()
    await watcher.stop()
  })

  it.each(inventoryLanes)(
    'falls back to the paced backoff retry timer only after a failed immediate $kind recovery attempt',
    async lane => {
      const doneCallbacks: Array<(error: Error | null) => void> = []
      let listCalls = 0
      mocks.watch.mockImplementation(async (path, _options, _callback, done) => {
        if (path.endsWith(lane.pathSuffix)) doneCallbacks.push(done)
        return { abort: vi.fn() }
      })
      mocks.listNamespacedCustomObject.mockImplementation(
        async ({ plural }: { plural: string }) => {
          if (plural === lane.plural) {
            listCalls += 1
            if (listCalls === 1) throw new Error(`${lane.plural} re-LIST temporarily unavailable`)
            return {
              metadata: { resourceVersion: `${lane.recoveryRvPrefix}-${listCalls}` },
              items: [],
            }
          }
          return { items: [] }
        }
      )
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const watcher = new McpServerWatcher()
      ;(watcher as any)[lane.peerSyncedField] = true
      await (watcher as any)[lane.restartMethod](lane.startSnapshot)

      doneCallbacks[0](Object.assign(new Error('Premature close'), { statusCode: 500 }))
      await flushMicrotasks(20)

      // The immediate attempt ran (and failed): exactly one LIST, retry armed.
      expect(listCalls).toBe(1)
      expect((watcher as any)[lane.syncedField]).toBe(false)
      expect((watcher as any)[lane.timerField]).not.toBeNull()

      // Retry-after-failure keeps its pacing: the first-failure backoff delay
      // is jittered within [500ms, 1000ms], so nothing may fire before the
      // 500ms floor and the retry must have fired by the 1000ms bound.
      await vi.advanceTimersByTimeAsync(499)
      expect(listCalls).toBe(1)
      await vi.advanceTimersByTimeAsync(501)
      await flushMicrotasks(20)
      expect(listCalls).toBe(2)
      expect((watcher as any)[lane.syncedField]).toBe(true)
      expect((watcher as any)[lane.timerField]).toBeNull()
      errorSpy.mockRestore()
      logSpy.mockRestore()
      await watcher.stop()
    }
  )

  it('falls back to the paced backoff retry timer only after a failed immediate Host recovery attempt', async () => {
    const doneCallbacks: Array<(error: Error | null) => void> = []
    let hostListCalls = 0
    mocks.watch.mockImplementation(async (path, _options, _callback, done) => {
      if (path.endsWith('/hosts')) doneCallbacks.push(done)
      return { abort: vi.fn() }
    })
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') {
        hostListCalls += 1
        if (hostListCalls === 1) throw new Error('hosts re-LIST temporarily unavailable')
        return {
          metadata: { resourceVersion: `host-close-recovery-rv-${hostListCalls}` },
          items: [],
        }
      }
      return { items: [] }
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const watcher = newContextAuthoritativeWatcher()
    const fleetRequest = vi
      .spyOn(watcher as any, 'requestHostFleetReconcile')
      .mockResolvedValue(undefined)
    await (watcher as any).startHostWatch('host-initial-rv')
    ;(watcher as any).hostCacheSynced = true

    doneCallbacks[0](Object.assign(new Error('Premature close'), { statusCode: 500 }))
    await flushMicrotasks(20)

    // The immediate attempt ran (and failed): exactly one LIST, retry armed
    // by performHostInventoryRecovery's existing failure path. The first-
    // failure backoff delay is jittered within [500ms, 1000ms].
    expect(hostListCalls).toBe(1)
    expect((watcher as any).hostCacheSynced).toBe(false)
    expect((watcher as any).hostCacheRecoveryTimer).not.toBeNull()

    await vi.advanceTimersByTimeAsync(499)
    expect(hostListCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(501)
    await flushMicrotasks(20)
    expect(hostListCalls).toBe(2)
    expect((watcher as any).hostCacheSynced).toBe(true)
    expect((watcher as any).hostCacheRecoveryTimer).toBeNull()
    expect(fleetRequest).toHaveBeenCalled()
    errorSpy.mockRestore()
    logSpy.mockRestore()
    await watcher.stop()
  })

  it.each(inventoryLanes)(
    'demotes a $kind close arriving within the 1s floor of the last recovery onto the paced retry timer',
    async lane => {
      const doneCallbacks: Array<(error: Error | null) => void> = []
      let listCalls = 0
      mocks.watch.mockImplementation(async (path, _options, _callback, done) => {
        if (path.endsWith(lane.pathSuffix)) doneCallbacks.push(done)
        return { abort: vi.fn() }
      })
      mocks.listNamespacedCustomObject.mockImplementation(
        async ({ plural }: { plural: string }) => {
          if (plural === lane.plural) {
            listCalls += 1
            return {
              metadata: { resourceVersion: `${lane.recoveryRvPrefix}-${listCalls}` },
              items: [],
            }
          }
          return { items: [] }
        }
      )
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const watcher = new McpServerWatcher()
      ;(watcher as any)[lane.peerSyncedField] = true
      await (watcher as any)[lane.restartMethod](lane.startSnapshot)

      // Isolated close: immediate recovery (LIST #1, watch #2).
      doneCallbacks[0](Object.assign(new Error('Premature close'), { statusCode: 500 }))
      await flushMicrotasks(20)
      expect(listCalls).toBe(1)
      expect(doneCallbacks).toHaveLength(2)

      // Burst close: the recovered watch dies again with ZERO fake-time
      // elapsed since the recovery that established it (< 1s floor). The
      // anti-busy-loop floor must demote this attempt onto the paced timer
      // instead of hammering the (visibly degraded) apiserver immediately.
      doneCallbacks[1](Object.assign(new Error('Premature close'), { statusCode: 500 }))
      await flushMicrotasks(20)
      expect(listCalls).toBe(1)
      expect((watcher as any)[lane.timerField]).not.toBeNull()
      expect((watcher as any)[lane.syncedField]).toBe(false)

      // The paced retry recovers it within the +5s advance.
      await vi.advanceTimersByTimeAsync(5000)
      await flushMicrotasks(20)
      expect(listCalls).toBe(2)
      expect((watcher as any)[lane.syncedField]).toBe(true)
      expect((watcher as any)[lane.timerField]).toBeNull()
      expect(doneCallbacks).toHaveLength(3)

      // Spaced close: once more than the 1s floor has elapsed since the last
      // recovery, a new close is immediate again (no timer).
      await vi.advanceTimersByTimeAsync(1500)
      doneCallbacks[2](Object.assign(new Error('Premature close'), { statusCode: 500 }))
      await flushMicrotasks(20)
      expect(listCalls).toBe(3)
      expect((watcher as any)[lane.timerField]).toBeNull()
      expect((watcher as any)[lane.syncedField]).toBe(true)
      logSpy.mockRestore()
      await watcher.stop()
    }
  )

  it('demotes a Host close arriving within the 1s floor of the last recovery onto the paced retry timer', async () => {
    const doneCallbacks: Array<(error: Error | null) => void> = []
    let hostListCalls = 0
    mocks.watch.mockImplementation(async (path, _options, _callback, done) => {
      if (path.endsWith('/hosts')) doneCallbacks.push(done)
      return { abort: vi.fn() }
    })
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') {
        hostListCalls += 1
        return {
          metadata: { resourceVersion: `host-close-recovery-rv-${hostListCalls}` },
          items: [],
        }
      }
      return { items: [] }
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const watcher = newContextAuthoritativeWatcher()
    vi.spyOn(watcher as any, 'requestHostFleetReconcile').mockResolvedValue(undefined)
    await (watcher as any).startHostWatch('host-initial-rv')
    ;(watcher as any).hostCacheSynced = true

    // Isolated close: immediate recovery (LIST #1, watch #2).
    doneCallbacks[0](Object.assign(new Error('Premature close'), { statusCode: 500 }))
    await flushMicrotasks(20)
    expect(hostListCalls).toBe(1)
    expect(doneCallbacks).toHaveLength(2)
    expect((watcher as any).hostCacheSynced).toBe(true)

    // Burst close within the 1s floor: demoted onto the paced retry timer.
    doneCallbacks[1](Object.assign(new Error('Premature close'), { statusCode: 500 }))
    await flushMicrotasks(20)
    expect(hostListCalls).toBe(1)
    expect((watcher as any).hostCacheRecoveryTimer).not.toBeNull()
    expect((watcher as any).hostCacheSynced).toBe(false)

    await vi.advanceTimersByTimeAsync(5000)
    await flushMicrotasks(20)
    expect(hostListCalls).toBe(2)
    expect((watcher as any).hostCacheSynced).toBe(true)
    expect((watcher as any).hostCacheRecoveryTimer).toBeNull()
    expect(doneCallbacks).toHaveLength(3)

    // Spaced close beyond the floor: immediate again.
    await vi.advanceTimersByTimeAsync(1500)
    doneCallbacks[2](Object.assign(new Error('Premature close'), { statusCode: 500 }))
    await flushMicrotasks(20)
    expect(hostListCalls).toBe(3)
    expect((watcher as any).hostCacheRecoveryTimer).toBeNull()
    expect((watcher as any).hostCacheSynced).toBe(true)
    logSpy.mockRestore()
    await watcher.stop()
  })
})

describe('McpServerWatcher watch-recovery retry backoff (exponential, jittered, reset-on-success)', () => {
  // During a long apiserver outage (GKE zonal control-plane upgrade: minutes
  // of every watch down and every re-LIST failing) a FIXED retry interval
  // hammers the recovering apiserver, and — worse — the HCC's inventory
  // streams synchronize after a simultaneous cut and hit it in phase. The
  // ecosystem standard (client-go reflector) is exponential backoff with
  // jitter. Contract under test, per hardened lane (McpServer/Context/Host):
  //   - retry-after-failure delay = min(BASE * 2^(failures-1), CAP) with FULL
  //     jitter (random() * computed) floored at BASE/2 so jitter can never
  //     reintroduce a 0-delay busy-loop;
  //   - a SUCCESSFUL recovery resets the failure counter (next failure starts
  //     the ladder again at ~BASE, not where the last outage left off);
  //   - an HTTP 429 carrying Retry-After overrides the computed delay
  //     (respects GKE APF), clamped into [BASE/2, CAP];
  //   - the FIRST attempt after a close stays IMMEDIATE (hardening intact).
  const BACKOFF_BASE_MS = 1000
  const BACKOFF_CAP_MS = 30000
  const BACKOFF_MIN_MS = BACKOFF_BASE_MS / 2

  const inventoryLanes = [
    {
      kind: 'McpServer',
      plural: 'mcpservers',
      pathSuffix: '/mcpservers',
      restartMethod: 'restartMcpServerWatch',
      startSnapshot: { resourceVersion: 'mcp-backoff-start-rv', servers: [] },
      recoveryRvPrefix: 'mcp-backoff-recovery-rv',
      timerField: 'mcpServerCacheRecoveryTimer',
      syncedField: 'mcpServerCacheSynced',
      peerSyncedField: 'contextCacheSynced',
    },
    {
      kind: 'Context',
      plural: 'contexts',
      pathSuffix: '/contexts',
      restartMethod: 'restartContextWatch',
      startSnapshot: { resourceVersion: 'context-backoff-start-rv', contexts: [] },
      recoveryRvPrefix: 'context-backoff-recovery-rv',
      timerField: 'contextCacheRecoveryTimer',
      syncedField: 'contextCacheSynced',
      peerSyncedField: 'mcpServerCacheSynced',
    },
  ] as const

  let randomSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mocks.watch.mockReset().mockResolvedValue({ abort: vi.fn() })
    mocks.listNamespacedCustomObject.mockReset().mockResolvedValue({ items: [] })
    randomSpy = vi.spyOn(Math, 'random')
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    randomSpy.mockRestore()
    errorSpy.mockRestore()
    logSpy.mockRestore()
    vi.useRealTimers()
  })

  /** Install the lane's watch and mock its LIST with a scriptable outcome. */
  async function setUpInventoryLane(
    lane: (typeof inventoryLanes)[number],
    listOutcome: (call: number) => 'fail' | 'fail-429' | { retryAfter: string } | 'succeed'
  ) {
    const doneCallbacks: Array<(error: Error | null) => void> = []
    let listCalls = 0
    mocks.watch.mockImplementation(async (path, _options, _callback, done) => {
      if (path.endsWith(lane.pathSuffix)) doneCallbacks.push(done)
      return { abort: vi.fn() }
    })
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural !== lane.plural) return { items: [] }
      listCalls += 1
      const outcome = listOutcome(listCalls)
      if (outcome === 'fail') {
        throw Object.assign(new Error(`${lane.plural} re-LIST unavailable`), { code: 500 })
      }
      if (outcome === 'fail-429' || typeof outcome === 'object') {
        const retryAfter = outcome === 'fail-429' ? '7' : outcome.retryAfter
        throw Object.assign(new Error(`${lane.plural} re-LIST throttled`), {
          code: 429,
          headers: { 'retry-after': retryAfter },
        })
      }
      return {
        metadata: { resourceVersion: `${lane.recoveryRvPrefix}-${listCalls}` },
        items: [],
      }
    })
    const watcher = new McpServerWatcher()
    ;(watcher as any)[lane.peerSyncedField] = true
    await (watcher as any)[lane.restartMethod](lane.startSnapshot)
    return { watcher, doneCallbacks, getListCalls: () => listCalls }
  }

  /** Host analogue of setUpInventoryLane. */
  async function setUpHostLane(
    listOutcome: (call: number) => 'fail' | { retryAfter: string } | 'succeed'
  ) {
    const doneCallbacks: Array<(error: Error | null) => void> = []
    let listCalls = 0
    mocks.watch.mockImplementation(async (path, _options, _callback, done) => {
      if (path.endsWith('/hosts')) doneCallbacks.push(done)
      return { abort: vi.fn() }
    })
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural !== 'hosts') return { items: [] }
      listCalls += 1
      const outcome = listOutcome(listCalls)
      if (outcome === 'fail') {
        throw Object.assign(new Error('hosts re-LIST unavailable'), { code: 500 })
      }
      if (typeof outcome === 'object') {
        throw Object.assign(new Error('hosts re-LIST throttled'), {
          code: 429,
          headers: { 'retry-after': outcome.retryAfter },
        })
      }
      return {
        metadata: { resourceVersion: `host-backoff-recovery-rv-${listCalls}` },
        items: [],
      }
    })
    const watcher = newContextAuthoritativeWatcher()
    vi.spyOn(watcher as any, 'requestHostFleetReconcile').mockResolvedValue(undefined)
    await (watcher as any).startHostWatch('host-backoff-initial-rv')
    ;(watcher as any).hostCacheSynced = true
    return { watcher, doneCallbacks, getListCalls: () => listCalls }
  }

  const closeError = () => Object.assign(new Error('Premature close'), { statusCode: 500 })

  /**
   * Advance to just before the expected fire instant (no re-LIST may have
   * happened) and then across it (exactly one more re-LIST must happen).
   */
  async function expectRetryAt(delayMs: number, getListCalls: () => number): Promise<void> {
    const before = getListCalls()
    await vi.advanceTimersByTimeAsync(delayMs - 1)
    expect(getListCalls()).toBe(before)
    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks(20)
    expect(getListCalls()).toBe(before + 1)
  }

  it.each(inventoryLanes)(
    'grows the $kind retry delay exponentially (1s, 2s, 4s, ... capped at 30s) under consecutive recovery failures',
    async lane => {
      randomSpy.mockReturnValue(1) // upper jitter bound: delay == computed backoff
      const { watcher, doneCallbacks, getListCalls } = await setUpInventoryLane(lane, () => 'fail')

      // First attempt after the close is immediate (failure #1)...
      doneCallbacks[0](closeError())
      await flushMicrotasks(20)
      expect(getListCalls()).toBe(1)
      expect((watcher as any)[lane.timerField]).not.toBeNull()

      // ...then each retry-after-failure doubles, bounded by the 30s cap.
      for (const expectedDelay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
        await expectRetryAt(expectedDelay, getListCalls)
      }
      await watcher.stop()
    }
  )

  it('grows the Host retry delay exponentially (1s, 2s, 4s, ... capped at 30s) under consecutive recovery failures', async () => {
    randomSpy.mockReturnValue(1)
    const { watcher, doneCallbacks, getListCalls } = await setUpHostLane(() => 'fail')

    doneCallbacks[0](closeError())
    await flushMicrotasks(20)
    expect(getListCalls()).toBe(1)
    expect((watcher as any).hostCacheRecoveryTimer).not.toBeNull()

    for (const expectedDelay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      await expectRetryAt(expectedDelay, getListCalls)
    }
    await watcher.stop()
  })

  it.each(inventoryLanes)(
    'resets the $kind backoff to the base delay after a successful recovery',
    async lane => {
      randomSpy.mockReturnValue(1)
      const { watcher, doneCallbacks, getListCalls } = await setUpInventoryLane(lane, call =>
        call === 3 || call === 5 ? 'succeed' : 'fail'
      )

      // Two consecutive failures escalate the ladder: immediate (#1), +1s (#2).
      doneCallbacks[0](closeError())
      await flushMicrotasks(20)
      expect(getListCalls()).toBe(1)
      await expectRetryAt(1000, getListCalls)
      // Third attempt (+2s) SUCCEEDS and must reset the failure counter.
      await expectRetryAt(2000, getListCalls)
      expect((watcher as any)[lane.syncedField]).toBe(true)
      expect(doneCallbacks).toHaveLength(2)

      // A later close (beyond the 1s floor) fails immediately again (#4). The
      // escalation must restart at the BASE delay (1s), not continue at 4s.
      await vi.advanceTimersByTimeAsync(1500)
      doneCallbacks[1](closeError())
      await flushMicrotasks(20)
      expect(getListCalls()).toBe(4)
      await expectRetryAt(1000, getListCalls)
      expect((watcher as any)[lane.syncedField]).toBe(true)
      await watcher.stop()
    }
  )

  it('resets the Host backoff to the base delay after a successful recovery', async () => {
    randomSpy.mockReturnValue(1)
    const { watcher, doneCallbacks, getListCalls } = await setUpHostLane(call =>
      call === 3 || call === 5 ? 'succeed' : 'fail'
    )

    doneCallbacks[0](closeError())
    await flushMicrotasks(20)
    expect(getListCalls()).toBe(1)
    await expectRetryAt(1000, getListCalls)
    await expectRetryAt(2000, getListCalls)
    expect((watcher as any).hostCacheSynced).toBe(true)
    expect(doneCallbacks).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(1500)
    doneCallbacks[1](closeError())
    await flushMicrotasks(20)
    expect(getListCalls()).toBe(4)
    await expectRetryAt(1000, getListCalls)
    expect((watcher as any).hostCacheSynced).toBe(true)
    await watcher.stop()
  })

  it.each(inventoryLanes)(
    'floors the jittered $kind delay at 500ms (random()=0 must never produce a 0-delay busy-loop)',
    async lane => {
      randomSpy.mockReturnValue(0) // lower jitter bound
      const { watcher, doneCallbacks, getListCalls } = await setUpInventoryLane(lane, call =>
        call === 1 ? 'fail' : 'succeed'
      )

      doneCallbacks[0](closeError())
      await flushMicrotasks(20)
      expect(getListCalls()).toBe(1)
      // Full jitter with random()=0 computes 0; the floor must hold it at
      // BASE/2 = 500ms — no instant (busy-loop) retry.
      await expectRetryAt(BACKOFF_MIN_MS, getListCalls)
      expect((watcher as any)[lane.syncedField]).toBe(true)
      await watcher.stop()
    }
  )

  it('floors the jittered Host delay at 500ms (random()=0 must never produce a 0-delay busy-loop)', async () => {
    randomSpy.mockReturnValue(0)
    const { watcher, doneCallbacks, getListCalls } = await setUpHostLane(call =>
      call === 1 ? 'fail' : 'succeed'
    )

    doneCallbacks[0](closeError())
    await flushMicrotasks(20)
    expect(getListCalls()).toBe(1)
    await expectRetryAt(BACKOFF_MIN_MS, getListCalls)
    expect((watcher as any).hostCacheSynced).toBe(true)
    await watcher.stop()
  })

  it.each(inventoryLanes)(
    'honors a 429 Retry-After for the next $kind retry instead of the computed backoff',
    async lane => {
      randomSpy.mockReturnValue(1)
      const { watcher, doneCallbacks, getListCalls } = await setUpInventoryLane(lane, call =>
        call === 1 ? 'fail-429' : 'succeed'
      )

      doneCallbacks[0](closeError())
      await flushMicrotasks(20)
      expect(getListCalls()).toBe(1)
      // APF said Retry-After: 7 — the next retry must land at 7000ms, not at
      // the 1000ms first-failure backoff.
      await expectRetryAt(7000, getListCalls)
      expect((watcher as any)[lane.syncedField]).toBe(true)
      await watcher.stop()
    }
  )

  it('honors a 429 Retry-After for the next Host retry, clamped to the 30s cap', async () => {
    randomSpy.mockReturnValue(1)
    const { watcher, doneCallbacks, getListCalls } = await setUpHostLane(call =>
      call === 1 ? { retryAfter: '3600' } : 'succeed'
    )

    doneCallbacks[0](closeError())
    await flushMicrotasks(20)
    expect(getListCalls()).toBe(1)
    // Retry-After: 3600 (an hour) must not stall recovery: clamp to the cap.
    await expectRetryAt(BACKOFF_CAP_MS, getListCalls)
    expect((watcher as any).hostCacheSynced).toBe(true)
    await watcher.stop()
  })

  it.each(inventoryLanes)(
    'keeps the first $kind attempt after a spaced close immediate (hardening not regressed by backoff)',
    async lane => {
      randomSpy.mockReturnValue(0) // worst-case jitter must not delay the immediate path
      const { watcher, doneCallbacks, getListCalls } = await setUpInventoryLane(
        lane,
        () => 'succeed'
      )

      await vi.advanceTimersByTimeAsync(1500)
      doneCallbacks[0](closeError())
      await flushMicrotasks(20)
      // Immediate microtask re-LIST, no timer armed.
      expect(getListCalls()).toBe(1)
      expect((watcher as any)[lane.timerField]).toBeNull()
      expect((watcher as any)[lane.syncedField]).toBe(true)
      await watcher.stop()
    }
  )
})
