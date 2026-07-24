import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostFleetReconcileError } from './hostReconciler'
import { HostK8sRequestTimeoutError } from './k8s/hostK8sApiClient'
import { McpServerWatcher, listAllCommunicationChannels, listAllHosts } from './k8sClient'
import type { HostCRD } from './types'

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

const mocks = vi.hoisted(() => {
  const listNamespacedCustomObject = vi.fn()
  const ensureDefaultPolicies = vi.fn().mockResolvedValue(undefined)
  const netPolFullReconcile = vi.fn().mockResolvedValue(undefined)
  const serverFullReconcile = vi.fn().mockResolvedValue(undefined)
  const hostFullReconcile = vi.fn().mockResolvedValue(undefined)
  const hostReconcileHosts = vi.fn().mockResolvedValue(undefined)
  const sfsFullReconcile = vi.fn().mockResolvedValue(undefined)
  const watch = vi.fn().mockResolvedValue({ abort: vi.fn() })
  const hostListCallOptions = vi.fn()
  const createAdministrativeOutcomeReporter = vi.fn().mockReturnValue(undefined)
  return {
    listNamespacedCustomObject,
    ensureDefaultPolicies,
    netPolFullReconcile,
    serverFullReconcile,
    hostFullReconcile,
    hostReconcileHosts,
    sfsFullReconcile,
    watch,
    hostListCallOptions,
    createAdministrativeOutcomeReporter,
  }
})

vi.mock('./config', () => ({
  config: {
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
    controlApiBaseUrl: 'http://control-api.test:8090',
    governedTracingEnabled: false,
  },
}))

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
          listNamespacedCustomObject: async (request: { plural?: string }, options?: unknown) => {
            if (request.plural === 'hosts') mocks.hostListCallOptions(options)
            const response = await mocks.listNamespacedCustomObject(request)
            if (
              request.plural === 'hosts' &&
              response &&
              typeof response === 'object' &&
              !('metadata' in response)
            ) {
              // Real Kubernetes collection LIST responses always include this
              // field. Preserve compact legacy fixtures without weakening the
              // production missing-resourceVersion failure path.
              return {
                ...response,
                metadata: { resourceVersion: 'test-host-collection-rv' },
              }
            }
            return response
          },
        }
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
  },
}))

vi.mock('./networkPolicyReconciler', () => ({
  NetworkPolicyReconciler: class {
    ensureDefaultPolicies = mocks.ensureDefaultPolicies
    fullReconcile = mocks.netPolFullReconcile
    reconcileExternalEgress = vi.fn()
    reconcileContext = vi.fn()
    cleanupExternalEgress = vi.fn()
  },
}))

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
  },
}))

beforeEach(() => {
  mocks.hostFullReconcile.mockReset().mockResolvedValue(undefined)
  mocks.hostReconcileHosts.mockReset().mockResolvedValue(undefined)
})

describe('McpServerWatcher startup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.watch.mockReset().mockResolvedValue({ abort: vi.fn() })
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'mcpservers') return { items: [] }
      if (plural === 'contexts') throw new Error('context discovery failed')
      if (plural === 'hosts') return { items: [] }
      if (plural === 'sharedfilesystems') return { items: [] }
      if (plural === 'communicationchannels')
        return { metadata: { resourceVersion: '1' }, items: [] }
      return { items: [] }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    mocks.ensureDefaultPolicies.mockReset().mockResolvedValue(undefined)
    mocks.netPolFullReconcile.mockReset().mockResolvedValue(undefined)
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

  it('ensures default policies even when initial Context discovery fails', async () => {
    const watcher = new McpServerWatcher()
    vi.spyOn(watcher as any, 'startMcpServerWatch').mockImplementation(async () => undefined)
    vi.spyOn(watcher as any, 'startContextWatch').mockImplementation(async () => undefined)
    vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockImplementation(async () => undefined)
    vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockImplementation(async () => undefined)
    // #281 (Task 9): startCommunicationChannelWatch is wired into start() — stub to prevent the real watch from firing.
    vi.spyOn(watcher as any, 'startCommunicationChannelWatch').mockImplementation(
      async () => undefined
    )

    await watcher.start()

    expect(mocks.ensureDefaultPolicies).toHaveBeenCalledTimes(1)
    expect(mocks.netPolFullReconcile).not.toHaveBeenCalled()
    expect(mocks.serverFullReconcile).toHaveBeenCalledWith([])
    expect(mocks.hostFullReconcile).toHaveBeenCalledWith([])
    expect(mocks.sfsFullReconcile).toHaveBeenCalledWith([])
  })

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
    mocks.serverFullReconcile.mockImplementation(async () => {
      eventLog.push('runtime')
    })

    const watcher = new McpServerWatcher()
    const netPol = (watcher as any).netPolReconciler
    netPol.reconcileExternalEgress.mockImplementation(async () => {
      eventLog.push('egress')
    })
    vi.spyOn(watcher as any, 'startMcpServerWatch').mockImplementation(async () => undefined)
    vi.spyOn(watcher as any, 'startContextWatch').mockImplementation(async () => undefined)
    vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockImplementation(async () => undefined)
    vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockImplementation(async () => undefined)
    vi.spyOn(watcher as any, 'startCommunicationChannelWatch').mockImplementation(
      async () => undefined
    )

    await watcher.start()

    expect(eventLog.slice(0, 3)).toEqual(['defaults', 'egress', 'runtime'])
    expect(mocks.serverFullReconcile).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'web-search' }),
    ])

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
    const netPol = (watcher as any).netPolReconciler
    netPol.reconcileExternalEgress.mockRejectedValueOnce(new Error('dns resolution failed'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(watcher as any, 'startMcpServerWatch').mockImplementation(async () => undefined)
    vi.spyOn(watcher as any, 'startContextWatch').mockImplementation(async () => undefined)
    vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockImplementation(async () => undefined)
    vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockImplementation(async () => undefined)
    vi.spyOn(watcher as any, 'startCommunicationChannelWatch').mockImplementation(
      async () => undefined
    )

    await watcher.start()

    expect(mocks.serverFullReconcile).toHaveBeenCalledWith([])
    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(1)

    watcher.stop()
    errorSpy.mockRestore()
    warnSpy.mockRestore()
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
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('retries failed external egress reconciliation from an ADDED event', async () => {
    const watcher = new McpServerWatcher()
    const netPol = (watcher as any).netPolReconciler
    const reconciler = (watcher as any).reconciler
    netPol.reconcileExternalEgress.mockRejectedValueOnce(new Error('api temporarily unavailable'))
    netPol.reconcileExternalEgress.mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const watchCallback = (watcher as any).getMcpServerWatchCallback()
    await watchCallback('ADDED', serverObject)

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5000)

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(2)
    expect(reconciler.reconcile).toHaveBeenCalledTimes(1)
    expect(reconciler.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'redis-tools' })
    )

    watcher.stop()
  })

  it('retries runtime reconciliation when external egress is ready but runtime reconcile fails', async () => {
    const watcher = new McpServerWatcher()
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
      expect.objectContaining({ name: 'redis-tools' })
    )

    watcher.stop()
  })

  it('keeps retry attempts bounded when runtime fails after an external egress retry succeeds', async () => {
    const watcher = new McpServerWatcher()
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
      expect.objectContaining({ name: 'redis-tools' })
    )

    watcher.stop()
  })

  it('does not let periodic external egress resync cancel a pending runtime retry', async () => {
    const watcher = new McpServerWatcher()
    const netPol = (watcher as any).netPolReconciler
    const reconciler = (watcher as any).reconciler
    netPol.reconcileExternalEgress.mockResolvedValue(undefined)
    reconciler.reconcile.mockRejectedValueOnce(new Error('deployment temporarily unavailable'))
    reconciler.reconcile.mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const watchCallback = (watcher as any).getMcpServerWatchCallback()
    await watchCallback('ADDED', serverObject)

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(1)
    expect(reconciler.reconcile).toHaveBeenCalledTimes(1)

    await (watcher as any).runExternalEgressResync()

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5000)

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(2)
    expect(reconciler.reconcile).toHaveBeenCalledTimes(2)

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
    const netPol = (watcher as any).netPolReconciler
    netPol.cleanupExternalEgress.mockRejectedValueOnce(new Error('delete temporarily unavailable'))
    netPol.cleanupExternalEgress.mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const watchCallback = (watcher as any).getMcpServerWatchCallback()
    await watchCallback('DELETED', serverObject)

    expect(netPol.cleanupExternalEgress).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5000)

    expect(netPol.cleanupExternalEgress).toHaveBeenCalledTimes(2)
    expect(netPol.cleanupExternalEgress).toHaveBeenLastCalledWith('redis-tools', 'mcp-server')

    watcher.stop()
  })

  it('periodic resync reuses external egress reconciliation for cached servers with bindings', async () => {
    const watcher = new McpServerWatcher()
    const netPol = (watcher as any).netPolReconciler
    netPol.reconcileExternalEgress.mockResolvedValue(undefined)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    ;(watcher as any).servers.set('redis-tools', {
      name: 'redis-tools',
      namespace: 'mcp-server',
      spec: serverObject.spec,
    })

    await (watcher as any).runExternalEgressResync()

    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(1)

    watcher.stop()
  })

  it('does not run parallel external egress reconciles for the same McpServer', async () => {
    const watcher = new McpServerWatcher()
    const netPol = (watcher as any).netPolReconciler
    const server = {
      name: 'redis-tools',
      namespace: 'mcp-server',
      spec: serverObject.spec,
    }
    ;(watcher as any).servers.set('redis-tools', server)
    ;(watcher as any).externalEgressInFlight.set(
      'mcp-server/redis-tools',
      new Promise(() => undefined)
    )
    vi.spyOn(Math, 'random').mockReturnValue(0)

    await (watcher as any).runExternalEgressResync()

    expect(netPol.reconcileExternalEgress).not.toHaveBeenCalled()

    watcher.stop()
  })

  it('waits for already in-flight external egress before reconciling the current server', async () => {
    const watcher = new McpServerWatcher()
    const netPol = (watcher as any).netPolReconciler
    const server = {
      name: 'redis-tools',
      namespace: 'mcp-server',
      spec: serverObject.spec,
    }
    let releaseExisting!: () => void
    const existing = new Promise<void>(resolve => {
      releaseExisting = resolve
    })
    ;(watcher as any).externalEgressInFlight.set('mcp-server/redis-tools', existing)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const run = (watcher as any).runExternalEgressOnce('MODIFIED', server)
    await Promise.resolve()

    expect(netPol.reconcileExternalEgress).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      '[K8s] Waiting for external egress reconcile for mcp-server/redis-tools; already in flight'
    )

    releaseExisting()
    await expect(run).resolves.toBeUndefined()
    expect(netPol.reconcileExternalEgress).toHaveBeenCalledTimes(1)

    warn.mockRestore()
    watcher.stop()
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

describe('McpServerWatcher.reconcileHostsReferencingCC', () => {
  it('re-reconciles the Host whose name matches the CC hostRef', async () => {
    const watcher = new McpServerWatcher()
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
    const reconcileSpy = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockResolvedValue(undefined)

    await (watcher as any).reconcileHostsReferencingCC('does-not-exist')

    expect(reconcileSpy).not.toHaveBeenCalled()
  })

  it('reports reconcile errors without throwing so the watch can schedule recovery', async () => {
    const watcher = new McpServerWatcher()
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

    vi.spyOn(watcher as any, 'startMcpServerWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startContextWatch').mockResolvedValue(undefined)
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

    vi.spyOn(watcher as any, 'startMcpServerWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startContextWatch').mockResolvedValue(undefined)
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

    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const lifecycleGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()

    try {
      await (watcher as any).requestHostFleetReconcile(
        'CommunicationChannel watch interruption',
        lifecycleGeneration
      )
      expect((watcher as any).ccAppliedLifecycleGeneration).not.toBe(lifecycleGeneration)
      expect((watcher as any).ccFleetRetryTimer).not.toBeNull()
      expect(mocks.hostReconcileHosts).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(5000)
      await vi.waitFor(() => expect(mocks.hostReconcileHosts).toHaveBeenCalledOnce())
      expect(hostListAttempts).toBe(2)
      expect((watcher as any).ccAppliedLifecycleGeneration).toBe(lifecycleGeneration)
      expect((watcher as any).ccFleetRetryTimer).toBeNull()
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
    const watcher = new McpServerWatcher()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const lifecycleGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()

    try {
      await (watcher as any).requestHostFleetReconcile(
        'initial Host reconciliation',
        lifecycleGeneration,
        'full'
      )

      expect((watcher as any).ccAppliedLifecycleGeneration).toBe(lifecycleGeneration)
      expect((watcher as any).ccFleetRetryTimer).toBeNull()
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
    const watcher = new McpServerWatcher()
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
      expect((watcher as any).ccFleetRetryTimer).toBeNull()

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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const staleGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()
      await (watcher as any).requestHostFleetReconcile('fail-closed', staleGeneration)
      expect((watcher as any).ccFleetRetryTimer).not.toBeNull()
      const currentGeneration = (watcher as any).beginCommunicationChannelLifecycleTransition()
      expect((watcher as any).ccFleetRetryTimer).toBeNull()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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

    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()

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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
    vi.spyOn(watcher as any, 'startMcpServerWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startContextWatch').mockResolvedValue(undefined)
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

      initialPass.resolve(undefined)
      await start

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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()

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
    const watcher = new McpServerWatcher()
    ;(watcher as any).ccCacheSynced = true
    ;(watcher as any).ccAppliedLifecycleGeneration = (watcher as any).ccLifecycleGeneration
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

  it('does not invent another fleet transition during a failed periodic cache recovery', async () => {
    vi.clearAllMocks()
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
    const reconcile = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockRejectedValueOnce(new Error('transient event failure'))
      .mockResolvedValue(undefined)
    await (watcher as any).startHostWatch('test-host-rv')
    if (!hostWatchCallback) throw new Error('Host watch callback was not installed')

    await hostWatchCallback('MODIFIED', {
      metadata: { name: 'retry-before-list', namespace: 'mcp-host', generation: 1 },
      spec: { host: 'retry-before-list', lifecycle: { stateless: false } },
    })
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect((watcher as any).hostWatchRetryTimers.size).toBe(1)

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
    const watcher = new McpServerWatcher()
    const hostReconciler = watcher.getHostReconciler()
    const reconcile = vi.spyOn(hostReconciler, 'reconcile').mockImplementation(async host => {
      order.push(`watch:${host.name}:${host.generation}`)
    })
    await (watcher as any).startHostWatch('test-host-rv')
    if (!hostWatchCallback) throw new Error('Host watch callback was not installed')
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
    const watcher = new McpServerWatcher()
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

    expect(order).toEqual([
      'reconcile:same-host:1',
      'reconcile:same-host:2',
      'delete:same-host',
    ])
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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

  it('rejects a Host snapshot that cannot anchor a continuing watch', async () => {
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'hosts') return { metadata: {}, items: [] }
      return { items: [] }
    })
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const requested = (watcher as any).requestHostFleetReconcile(
      'Periodic resync',
      undefined,
      'full'
    ) as Promise<void>

    await vi.waitFor(() => expect(mocks.watch).toHaveBeenCalledOnce())
    const internal = (watcher as any).hostFleetReconcileInFlight.promise as Promise<void>
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
    const watcher = new McpServerWatcher()
    await (watcher as any).startHostWatch('initial-rv')
    ;(watcher as any).hostCacheSynced = true

    doneCallbacks[0](Object.assign(new Error('resource version expired'), { statusCode: 410 }))

    expect((watcher as any).hostCacheSynced).toBe(false)
    expect((watcher as any).hostCacheRecoveryTimer).not.toBeNull()
    await vi.advanceTimersByTimeAsync(5000)
    await vi.waitFor(() => expect(mocks.hostFullReconcile).toHaveBeenCalledOnce())

    expect(
      mocks.listNamespacedCustomObject.mock.calls.filter(([request]) => request.plural === 'hosts')
    ).toHaveLength(1)
    expect(watchQueries).toEqual([
      { resourceVersion: 'initial-rv' },
      { resourceVersion: 'host-recovery-rv' },
    ])
    expect((watcher as any).hostCacheSynced).toBe(true)
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
    const watcher = new McpServerWatcher()
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
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ uid: 'retry-host-uid' }), 'urgent')
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    expect(reconcileDelete).not.toHaveBeenCalledWith(
      'live-host',
      'mcp-host',
      expect.anything()
    )
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
    ;(watcher as any).hosts.set('x', { name: 'x', namespace: 'mcp-host', uid: 'uid-B', generation: 3 })
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
    const watcher = new McpServerWatcher()
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
      expect(reconcile).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'waker' }),
        'urgent'
      )
    )
    watcher.stop()
  })

  it('recovery does NOT urgently dispatch a fully-unchanged Host with no wake annotation', async () => {
    vi.clearAllMocks()
    const watcher = new McpServerWatcher()
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
      [{ name: 'steady', namespace: 'mcp-host', uid: 'u1', generation: 4, spec: { host: 'steady' } }],
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
    const watcher = new McpServerWatcher()
    const reconcile = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined)
    await (watcher as any).startHostWatch('test-host-rv')
    if (!hostWatchCallback) throw new Error('Host watch callback was not installed')

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
    const watcher = new McpServerWatcher()
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
    const watcher = new McpServerWatcher()
    const reconcile = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockRejectedValue(new Error('persistent failure'))
    await (watcher as any).startHostWatch('test-host-rv')
    if (!hostWatchCallback) throw new Error('Host watch callback was not installed')

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
    const watcher = new McpServerWatcher()
    const reconcile = vi
      .spyOn(watcher.getHostReconciler(), 'reconcile')
      .mockRejectedValueOnce(new Error('stale event failed'))
      .mockResolvedValue(undefined)
    await (watcher as any).startHostWatch('test-host-rv')
    if (!hostWatchCallback) throw new Error('Host watch callback was not installed')

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
