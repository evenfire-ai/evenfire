import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpServerWatcher, listAllCommunicationChannels } from './k8sClient'

const mocks = vi.hoisted(() => {
  const listNamespacedCustomObject = vi.fn()
  const ensureDefaultPolicies = vi.fn().mockResolvedValue(undefined)
  const netPolFullReconcile = vi.fn().mockResolvedValue(undefined)
  const serverFullReconcile = vi.fn().mockResolvedValue(undefined)
  const hostFullReconcile = vi.fn().mockResolvedValue(undefined)
  const sfsFullReconcile = vi.fn().mockResolvedValue(undefined)
  return {
    listNamespacedCustomObject,
    ensureDefaultPolicies,
    netPolFullReconcile,
    serverFullReconcile,
    hostFullReconcile,
    sfsFullReconcile,
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
    hostResyncIntervalSec: 0,
    externalEgressResyncIntervalSec: 0,
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
  }
  class KubeConfig {
    loadFromDefault(): void {}
    makeApiClient(api: unknown): unknown {
      if (api === CustomObjectsApi) {
        return { listNamespacedCustomObject: mocks.listNamespacedCustomObject }
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
  HostReconciler: class {
    fullReconcile = mocks.hostFullReconcile
    reconcile = vi.fn()
    reconcileDelete = vi.fn()
    setResolveContextMounts = vi.fn()
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

describe('McpServerWatcher startup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listNamespacedCustomObject.mockImplementation(async ({ plural }: { plural: string }) => {
      if (plural === 'mcpservers') return { items: [] }
      if (plural === 'contexts') throw new Error('context discovery failed')
      if (plural === 'hosts') return { items: [] }
      if (plural === 'sharedfilesystems') return { items: [] }
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

  it('ensures default policies even when initial Context discovery fails', async () => {
    const watcher = new McpServerWatcher()
    vi.spyOn(watcher as any, 'startMcpServerWatch').mockImplementation(async () => undefined)
    vi.spyOn(watcher as any, 'startContextWatch').mockImplementation(async () => undefined)
    vi.spyOn(watcher as any, 'startHostWatch').mockImplementation(async () => undefined)
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
      if (plural === 'communicationchannels') return { items: [] }
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
    vi.spyOn(watcher as any, 'startHostWatch').mockImplementation(async () => undefined)
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
      if (plural === 'communicationchannels') return { items: [] }
      return { items: [] }
    })

    const watcher = new McpServerWatcher()
    const netPol = (watcher as any).netPolReconciler
    netPol.reconcileExternalEgress.mockRejectedValueOnce(new Error('dns resolution failed'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(watcher as any, 'startMcpServerWatch').mockImplementation(async () => undefined)
    vi.spyOn(watcher as any, 'startContextWatch').mockImplementation(async () => undefined)
    vi.spyOn(watcher as any, 'startHostWatch').mockImplementation(async () => undefined)
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

  it('handles reconcile errors without throwing (logs only)', async () => {
    const watcher = new McpServerWatcher()
    const hosts = (watcher as any).hosts as Map<string, { name: string; spec: any }>
    hosts.set('marketing', {
      name: 'marketing',
      namespace: 'mcp-host',
      spec: { host: 'marketing', contextRef: 'c', secretRef: 's' },
    } as any)
    vi.spyOn(watcher.getHostReconciler(), 'reconcile').mockRejectedValue(new Error('boom'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect((watcher as any).reconcileHostsReferencingCC('marketing')).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()

    errorSpy.mockRestore()
  })
})

describe('McpServerWatcher.start ordering (#281 R6-bis)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

    const watcher = new McpServerWatcher()

    vi.spyOn(watcher as any, 'startMcpServerWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startContextWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startHostWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startCommunicationChannelWatch').mockImplementation(async () => {
      eventLog.push('startCommunicationChannelWatch')
    })

    await watcher.start()

    // The critical ordering (R6-bis): CC list must fire before fullReconcile.
    const idxList = eventLog.indexOf('listAllCommunicationChannels')
    const idxReconcile = eventLog.indexOf('fullReconcile')
    expect(idxList).toBeGreaterThanOrEqual(0)
    expect(idxReconcile).toBeGreaterThanOrEqual(0)
    expect(idxList).toBeLessThan(idxReconcile)

    // CC watch must be started.
    expect(eventLog).toContain('startCommunicationChannelWatch')

    // Cache populated by the initial LIST.
    const cache = (watcher as any).communicationChannels as Map<string, any>
    expect(cache.size).toBe(1)
    expect(cache.get('cc-1')?.spec.hostRef).toBe('marketing')
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
    vi.spyOn(watcher as any, 'startHostWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startSharedFileSystemWatch').mockResolvedValue(undefined)
    vi.spyOn(watcher as any, 'startGlobalFileSystemWatch').mockResolvedValue(undefined)
    const ccWatchSpy = vi
      .spyOn(watcher as any, 'startCommunicationChannelWatch')
      .mockResolvedValue(undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(watcher.start()).resolves.toBeUndefined()
    expect(ccWatchSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(
      '[K8s] CommunicationChannel initial load failed; ccCacheSynced remains false ' +
        '(B2 will preserve existing channel-reader replicas):',
      expect.any(Error)
    )

    errorSpy.mockRestore()
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
