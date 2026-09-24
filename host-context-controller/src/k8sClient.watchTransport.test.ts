import { afterEach, describe, expect, it, vi } from 'vitest'
import * as http from 'node:http'
import type { Socket } from 'node:net'
import { McpServerWatcher, getKubeConfig } from './k8sClient'

// Preserve the installed Watch and HTTP transport. Replace only ambient
// configuration loading with an anonymous, inert loopback configuration.
vi.mock('@kubernetes/client-node', async importOriginal => {
  const actual = await importOriginal<typeof import('@kubernetes/client-node')>()
  return {
    ...actual,
    KubeConfig: class extends actual.KubeConfig {
      loadFromDefault(): void {
        this.loadFromOptions({
          clusters: [{ name: 'loopback', server: 'http://127.0.0.1:1', skipTLSVerify: true }],
          users: [{ name: 'anonymous' }],
          contexts: [{ name: 'loopback', cluster: 'loopback', user: 'anonymous' }],
          currentContext: 'loopback',
        })
      }
    },
  }
})
vi.mock('./config', () => ({
  config: {
    devMode: false,
    namespace: 'mcp-server',
    hostNamespace: 'mcp-host',
    channelsNamespace: 'channels',
    llmHooksNamespace: 'llm-hooks',
    rpcProxyNamespace: 'rpc-proxy',
    runtimeNamespaces: ['mcp-server', 'mcp-host', 'rpc-proxy'],
    hostK8sRequestTimeoutMs: 30_000,
    hostResyncIntervalSec: 0,
    netPolResyncIntervalSec: 0,
    netPolDefaultsResyncIntervalSec: 0,
    externalEgressResyncIntervalSec: 0,
    governedTracingEnabled: false,
  },
}))

const lanes = [
  {
    plural: 'mcpservers',
    start: 'startMcpServerWatch',
    rv: '101',
    cache: 'servers',
    effect: 'enqueueMcpServerReconciliation',
  },
  {
    plural: 'contexts',
    start: 'startContextWatch',
    rv: '202',
    cache: 'contexts',
    effect: 'enqueueContextIdentityReconciliation',
  },
  {
    plural: 'sharedfilesystems',
    start: 'startSharedFileSystemWatch',
    cache: 'sharedFileSystems',
    effect: 'enqueueSharedFileSystemReconciliation',
  },
  {
    plural: 'globalfilesystems',
    start: 'startGlobalFileSystemWatch',
    cache: 'globalFileSystems',
    effect: 'enqueueGlobalFileSystemReconciliation',
  },
  {
    plural: 'communicationchannels',
    start: 'startCommunicationChannelWatch',
    rv: '505',
    cache: 'communicationChannels',
    effect: 'reconcileHostsReferencingCC',
  },
  { plural: 'llmhooks', start: 'startLlmHookWatch', cache: 'llmHooks', effect: 'hookReconcile' },
  {
    plural: 'hosts',
    start: 'startHostWatch',
    rv: '707',
    cache: 'hosts',
    effect: 'reconcileHostWatchEvent',
  },
] as const

type WatchCallback = (type: string, object: any) => Promise<void>
const watchers: McpServerWatcher[] = []

function createFixture() {
  const watcher = new McpServerWatcher()
  watchers.push(watcher)
  // These exact private methods are called by start(), which also performs
  // unrelated LIST/bootstrap work. Exercise their installed callbacks here.
  const state = watcher as any
  state.mcpServerCacheSynced = true
  state.contextCacheSynced = true
  state.hostCacheSynced = true
  state.ccCacheSynced = true
  const effects: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const method of [
    'enqueueMcpServerReconciliation',
    'enqueueContextIdentityReconciliation',
    'enqueueSharedFileSystemReconciliation',
    'enqueueGlobalFileSystemReconciliation',
    'runInitialNetworkPolicyConvergence',
    'reconcileSharedFileSystemsReferencedByContext',
    'reconcileHostWatchEvent',
    'admitHostDependentEffects',
    'requestHostFleetReconcile',
  ])
    effects[method] = vi.spyOn(state, method).mockResolvedValue(undefined)
  effects.reconcileHostsReferencingCC = vi
    .spyOn(state, 'reconcileHostsReferencingCC')
    .mockResolvedValue(true)
  for (const [name, owner, method] of [
    ['hookReconcile', 'llmHookReconciler', 'reconcile'],
    ['hookDelete', 'llmHookReconciler', 'reconcileDelete'],
    ['hookPolicies', 'llmHookReconciler', 'reconcileNetworkPoliciesForHooks'],
    ['hostEgress', 'llmHookReconciler', 'reconcileHostEgress'],
    ['channelRevision', 'hostReconciler', 'patchChannelReaderRevisionAnnotation'],
    ['sfsReconcile', 'sharedFileSystemReconciler', 'reconcile'],
    ['gfsReconcile', 'gfsReconciler', 'reconcile'],
    ['mcpReconcile', 'reconciler', 'reconcile'],
  ])
    effects[name] = vi.spyOn(state[owner], method).mockResolvedValue(undefined)
  effects.change = vi.fn()
  state.changeCallback = effects.change
  return { watcher, state, effects }
}

function snapshot(state: any) {
  return {
    caches: lanes.map(lane => [...state[lane.cache].entries()]),
    revisions: [
      state.mcpServerDesiredRevision,
      state.contextDesiredRevision,
      state.sharedFileSystemCacheRevision,
      state.globalFileSystemCacheRevision,
      state.hostDesiredRevision,
      state.hostWatchRevision,
      state.ccLifecycleGeneration,
    ],
    tasks: [
      state.mcpServerReconciliationQueues.size,
      state.contextReconciliationQueues.size,
      state.sharedFileSystemReconciliationQueues.size,
      state.globalFileSystemReconciliationQueues.size,
      state.latestHostWatchEventRevisions.size,
    ],
  }
}

function addedObject(plural: string) {
  return {
    metadata: {
      name: `${plural}-witness`,
      namespace: 'fixture',
      uid: `${plural}-uid`,
      generation: 1,
      resourceVersion: '900',
    },
    spec: {
      contextId: 'context-witness',
      contextRef: 'context-witness',
      hostRef: 'host-witness',
      sharedFileSystems: [],
    },
  }
}

afterEach(async () => {
  for (const watcher of watchers.splice(0)) await watcher.stop()
  vi.restoreAllMocks()
})

describe('A-T1 production watch callbacks', () => {
  it.each(lanes)(
    '$plural ignores metadata-only BOOKMARK and admits a named ADDED witness',
    async lane => {
      const { state, effects } = createFixture()
      let callback: WatchCallback | undefined
      vi.spyOn(state.watch, 'watch').mockImplementation(
        async (_path: unknown, _params: unknown, cb: unknown) => {
          callback = cb as WatchCallback
          return new AbortController()
        }
      )
      await state[lane.start]('rv' in lane ? lane.rv : undefined)
      expect(callback).toBeTypeOf('function')
      expect(state.stopped).toBe(false)
      const before = snapshot(state)
      await expect(
        callback!('BOOKMARK', { metadata: { resourceVersion: '899' } })
      ).resolves.toBeUndefined()
      expect(snapshot(state)).toEqual(before)
      for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled()

      // Same callback and fixture: stale generations and no-op callbacks fail
      // this positive control even if the BOOKMARK assertions pass.
      const object = addedObject(lane.plural)
      await callback!('ADDED', object)
      expect(state[lane.cache].get(object.metadata.name)).toMatchObject({
        name: object.metadata.name,
      })
      expect(effects[lane.effect]).toHaveBeenCalledTimes(1)
      const [firstArgument] = effects[lane.effect].mock.calls[0]
      if (lane.plural === 'contexts') expect(firstArgument).toEqual(['context-witness'])
      else if (lane.plural === 'communicationchannels') expect(firstArgument).toBe('host-witness')
      else if (lane.plural === 'hosts')
        expect(effects[lane.effect]).toHaveBeenCalledWith(
          'ADDED',
          expect.objectContaining({ name: object.metadata.name }),
          expect.any(Number)
        )
      else if (lane.plural === 'sharedfilesystems' || lane.plural === 'globalfilesystems')
        expect(firstArgument).toBe(object.metadata.name)
      else expect(firstArgument).toMatchObject({ name: object.metadata.name })
    }
  )
})

describe('A-T2a installed Kubernetes Watch HTTP transport', () => {
  it('sends seven distinct watch requests, retaining RVs and requesting bookmarks only for MCP/Context', async () => {
    const requests: URL[] = []
    const sockets = new Set<Socket>()
    const server = http.createServer((request, response) => {
      requests.push(new URL(request.url!, 'http://127.0.0.1'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.flushHeaders()
    })
    server.on('connection', socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Loopback server did not bind')
    const kubeConfig = getKubeConfig()!
    kubeConfig.loadFromOptions({
      clusters: kubeConfig.getClusters().map(cluster => ({
        ...cluster,
        server: `http://127.0.0.1:${address.port}`,
      })),
      users: kubeConfig.getUsers(),
      contexts: kubeConfig.getContexts(),
      currentContext: kubeConfig.getCurrentContext(),
    })
    const { watcher, state } = createFixture()
    try {
      for (const lane of lanes) await state[lane.start]('rv' in lane ? lane.rv : undefined)
      expect(requests).toHaveLength(7)
      expect(new Set(requests.map(url => url.pathname)).size).toBe(7)
      for (const lane of lanes) {
        const matches = requests.filter(url => url.pathname.endsWith(`/${lane.plural}`))
        expect(matches, lane.plural).toHaveLength(1)
        const url = matches[0]
        expect(url.searchParams.get('watch'), lane.plural).toBe('true')
        expect(url.searchParams.get('allowWatchBookmarks'), lane.plural).toBe(
          lane.plural === 'mcpservers' || lane.plural === 'contexts' ? 'true' : null
        )
        expect(url.searchParams.get('resourceVersion'), lane.plural).toBe(
          'rv' in lane ? lane.rv : null
        )
      }
    } finally {
      await watcher.stop()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error('Loopback server close exceeded 2 seconds')),
          2000
        )
        server.close(error => {
          clearTimeout(deadline)
          if (error) reject(error)
          else resolve()
        })
      })
    }
  }, 10_000)
})
