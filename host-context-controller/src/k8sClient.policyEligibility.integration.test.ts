import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { V1DeleteOptions, V1NetworkPolicy, V1ObjectMeta } from '@kubernetes/client-node'
import { McpServerWatcher } from './k8sClient'
import type { ContextCRD, McpServerCRD, McpServerCrdStatus } from './types'

type ApiServer = Pick<McpServerCRD, 'spec' | 'status'> & { metadata: V1ObjectMeta }
type StoredPolicy = V1NetworkPolicy & { metadata: V1ObjectMeta }

const fixture = vi.hoisted(() => ({
  policies: new Map<string, StoredPolicy>(),
  servers: new Map<string, ApiServer>(),
  revision: 0,
  watch: vi.fn().mockResolvedValue({ abort: vi.fn() }),
  list: vi.fn(),
}))

vi.mock('./config', () => ({
  config: {
    devMode: false,
    namespace: 'mcp-server',
    hostNamespace: 'mcp-host',
    rpcProxyNamespace: 'rpc-proxy',
    channelsNamespace: 'channels',
    controlPlaneNamespace: 'control-plane',
    port: 8081,
    hostK8sRequestTimeoutMs: 30000,
    runtimeNamespaces: ['mcp-server', 'mcp-host', 'rpc-proxy'],
    netPolOrphanDeleteCap: 10,
    netPolOrphanDeleteCapPercent: 100,
    externalEgressDnsResolveTimeoutMs: 5000,
    externalEgressMaxEntries: 128,
    externalEgressOverlapSec: 300,
    netPolResyncIntervalSec: 0,
    netPolDefaultsResyncIntervalSec: 0,
    externalEgressResyncIntervalSec: 0,
    hostResyncIntervalSec: 0,
  },
}))

vi.mock('@kubernetes/client-node', async importOriginal => {
  const actual = await importOriginal<typeof import('@kubernetes/client-node')>()
  const absent = () => Object.assign(new Error('fixture object absent'), { code: 404 })
  const read = (name: string) => {
    const server = fixture.servers.get(name)
    if (!server) throw absent()
    return structuredClone(server)
  }
  const custom = {
    listNamespacedCustomObject: fixture.list,
    getNamespacedCustomObject: async ({ name }: { name: string }) => read(name),
    getNamespacedCustomObjectStatus: async ({ name }: { name: string }) => read(name),
    patchNamespacedCustomObjectStatus: async ({
      name,
      body,
    }: {
      name: string
      body: Array<{ op: string; path: string; value: unknown }>
    }) => {
      const server = read(name)
      for (const change of body) {
        if (change.op === 'test') {
          const metadataField = change.path.slice('/metadata/'.length)
          const metadata = server.metadata as Record<string, unknown>
          if (!change.path.startsWith('/metadata/') || metadata[metadataField] !== change.value)
            throw Object.assign(new Error('status identity conflict'), { code: 409 })
          continue
        }
        if (
          change.op !== 'add' ||
          !['/status', '/status/conditions', '/status/resolvedEgressIPs'].includes(change.path)
        )
          throw new Error(`Unsupported fixture status mutation: ${change.op} ${change.path}`)
        if (change.path === '/status') server.status = change.value as McpServerCrdStatus
        if (change.path === '/status/conditions')
          (server.status ??= {}).conditions = change.value as McpServerCrdStatus['conditions']
        if (change.path === '/status/resolvedEgressIPs')
          (server.status ??= {}).resolvedEgressIPs =
            change.value as McpServerCrdStatus['resolvedEgressIPs']
      }
      server.metadata.resourceVersion = String(++fixture.revision)
      fixture.servers.set(name, server)
      return server
    },
  }
  const save = (namespace: string, body: StoredPolicy) => {
    const key = `${namespace}/${body.metadata.name}`
    const old = fixture.policies.get(key)
    const policy = structuredClone({
      ...body,
      metadata: {
        ...body.metadata,
        namespace,
        uid: old?.metadata.uid ?? `policy-${++fixture.revision}`,
        resourceVersion: String(++fixture.revision),
      },
    })
    fixture.policies.set(key, policy)
    return structuredClone(policy)
  }
  const networking = {
    listNamespacedNetworkPolicy: async ({
      namespace,
      labelSelector,
    }: {
      namespace: string
      labelSelector?: string
    }) => ({
      items: [...fixture.policies.values()]
        .filter(
          policy =>
            policy.metadata.namespace === namespace &&
            (!labelSelector ||
              labelSelector.split(',').every(clause => {
                const [key, value] = clause.split('=')
                return policy.metadata.labels?.[key] === value
              }))
        )
        .map(policy => structuredClone(policy)),
    }),
    readNamespacedNetworkPolicy: async ({
      namespace,
      name,
    }: {
      namespace: string
      name: string
    }) => {
      const policy = fixture.policies.get(`${namespace}/${name}`)
      if (!policy) throw absent()
      return structuredClone(policy)
    },
    createNamespacedNetworkPolicy: async ({
      namespace,
      body,
    }: {
      namespace: string
      body: StoredPolicy
    }) => {
      if (fixture.policies.has(`${namespace}/${body.metadata.name}`))
        throw Object.assign(new Error('already exists'), { code: 409 })
      return save(namespace, body)
    },
    replaceNamespacedNetworkPolicy: async ({
      namespace,
      body,
    }: {
      namespace: string
      body: StoredPolicy
    }) => save(namespace, body),
    deleteNamespacedNetworkPolicy: async ({
      namespace,
      name,
      body,
    }: {
      namespace: string
      name: string
      body: V1DeleteOptions
    }) => {
      const key = `${namespace}/${name}`,
        policy = fixture.policies.get(key)
      if (!policy) throw absent()
      expect(body.preconditions).toEqual({
        uid: policy.metadata.uid,
        resourceVersion: policy.metadata.resourceVersion,
      })
      fixture.policies.delete(key)
      return {}
    },
  }
  return {
    ...actual,
    KubeConfig: class {
      loadFromDefault() {}
      makeApiClient(kind: unknown) {
        if (kind === actual.CustomObjectsApi) return custom
        if (kind === actual.NetworkingV1Api) return networking
        return {}
      }
    },
    Watch: class {
      watch = fixture.watch
    },
  }
})

// Secret validation/runtime objects are a precondition of this policy test.
// Preserve the actual startup runEffect contract (and hence its egress gate),
// while keeping unrelated workload API writes out of this fixture.
vi.mock('./reconciler', () => ({
  McpServerReconciler: class {
    setInventoryAuthority() {}
    setResolveCurrentServer() {}
    reconcile() {
      return Promise.resolve()
    }
    reconcileDelete() {
      return Promise.resolve()
    }
    getStatus() {
      return { deployed: true, ready: true }
    }
    async fullReconcile(
      servers: McpServerCRD[],
      options: { runEffect: (name: string, work: () => Promise<void>) => Promise<void> }
    ) {
      for (const server of servers) await options.runEffect(server.name, async () => {})
    }
  },
}))

type Harness = {
  contexts: Map<string, ContextCRD>
  contextCacheSynced: boolean
  mcpServerCacheSynced: boolean
  initialConvergenceRuns: Map<string, { promise: Promise<void> }>
  mcpServerReconciliationQueues: Map<string, { queue: { tail: Promise<void> } }>
  contextReconciliationQueues: Map<string, { queue: { tail: Promise<void> } }>
  getMcpServerWatchCallback(): (type: string, object: ApiServer) => Promise<void>
  recoverMcpServerInventoryAndWatch(): Promise<boolean>
}

async function drain(state: Harness): Promise<void> {
  // Await work already scheduled by the input. Never call a reconcile method
  // to "drain": that would conceal a missing WATCH/LIST scheduling edge.
  for (let pass = 0; pass < 30; pass++) {
    await Promise.resolve()
    const pending = [...state.initialConvergenceRuns.values()].map(run => run.promise)
    for (const queues of [state.mcpServerReconciliationQueues, state.contextReconciliationQueues]) {
      for (const entry of queues.values()) pending.push(entry.queue.tail)
    }
    if (pending.length === 0) return
    await Promise.all(pending)
  }
  throw new Error('policy queues did not drain')
}

describe('WATCH and recovered LIST policy effects', () => {
  let watcher: McpServerWatcher
  beforeEach(() => {
    vi.useFakeTimers()
    fixture.policies.clear()
    fixture.servers.clear()
    fixture.revision = 0
    fixture.list.mockImplementation(async ({ plural }: { plural: string }) => ({
      metadata: { resourceVersion: `list-${++fixture.revision}` },
      items:
        plural === 'mcpservers'
          ? [...fixture.servers.values()].map(value => structuredClone(value))
          : [],
    }))
  })
  afterEach(async () => {
    await watcher?.stop()
    vi.useRealTimers()
  })

  it.each(['WATCH', 'LIST'] as const)(
    '%s drains revocation and recovery of all four families',
    async source => {
      watcher = new McpServerWatcher()
      const state = watcher as unknown as Harness
      state.contextCacheSynced = true
      state.mcpServerCacheSynced = true
      state.contexts.set('ctx', {
        name: 'ctx',
        namespace: 'mcp-server',
        uid: 'ctx-uid',
        generation: 1,
        spec: { contextId: 'ctx', mcpServers: ['server'] },
      })
      const server: ApiServer = {
        metadata: {
          name: 'server',
          namespace: 'mcp-server',
          uid: 'server-uid',
          generation: 1,
          resourceVersion: '1',
        },
        spec: {
          image: 'fixture:v1',
          contextRef: 'ctx',
          transport: { type: 'streamableHttp', port: 3000 },
          envSecret: { name: 'fixture-env', keys: [] },
          egressBindings: [{ cidr: '1.2.3.4/32', port: 443 }],
        },
        status: { conditions: [{ type: 'SecretResolved', status: 'True', reason: 'SecretFound' }] },
      }
      fixture.servers.set('server', server)
      await state.getMcpServerWatchCallback()('ADDED', structuredClone(server))
      await drain(state)
      expect(fixture.policies.size).toBe(4)
      const keys = [...fixture.policies.keys()].sort()

      for (const [status, reason, count] of [
        ['False', 'SecretNotFound', 0],
        ['True', 'SecretFound', 4],
      ] as const) {
        const updated = {
          ...server,
          status: { conditions: [{ type: 'SecretResolved', status, reason }] },
        }
        fixture.servers.set('server', updated)
        if (source === 'WATCH')
          await state.getMcpServerWatchCallback()('MODIFIED', structuredClone(updated))
        else expect(await state.recoverMcpServerInventoryAndWatch()).toBe(true)
        await drain(state)
        await vi.advanceTimersByTimeAsync(5000)
        await drain(state)
        expect(fixture.policies.size).toBe(count)
      }
      expect([...fixture.policies.keys()].sort()).toEqual(keys)
      if (source === 'LIST')
        expect(fixture.list).toHaveBeenCalledWith(expect.objectContaining({ plural: 'mcpservers' }))
    }
  )
})
