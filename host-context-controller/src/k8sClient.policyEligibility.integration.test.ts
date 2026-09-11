import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { V1DeleteOptions, V1NetworkPolicy, V1ObjectMeta } from '@kubernetes/client-node'
import * as http from 'node:http'
import { config } from './config'
import { McpServerWatcher, createMcpAuthorizationStore } from './k8sClient'
import { hccLogger } from './logger'
import type { McpApiAuthenticator } from './mcpApiAuthentication'
import { McpAuthorizationService } from './mcpAuthorization'
import { resolveProbeAuthoritativeFn, resolveProviderAuthoritativeFn } from './readinessGate'
import { ContextMapperServer } from './server'
import type { ContextCRD, McpServerCRD, McpServerCrdStatus } from './types'

type ApiServer = Pick<McpServerCRD, 'spec' | 'status'> & { metadata: V1ObjectMeta }
type StoredPolicy = V1NetworkPolicy & { metadata: V1ObjectMeta }

const fixture = vi.hoisted(() => ({
  policies: new Map<string, StoredPolicy>(),
  servers: new Map<string, ApiServer>(),
  revision: 0,
  contexts: new Map<string, { metadata: V1ObjectMeta; spec: ContextCRD['spec'] }>(),
  failPolicyType: undefined as string | undefined,
  watch: vi.fn().mockResolvedValue({ abort: vi.fn() }),
  list: vi.fn(),
}))

vi.mock('./config', () => ({
  config: {
    devMode: false,
    k8sApiCidrs: [],
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
    getNamespacedCustomObject: async ({ name, plural }: { name: string; plural: string }) => {
      if (plural === 'hosts')
        return {
          metadata: { name: 'host', namespace: 'mcp-host', uid: 'host-uid', resourceVersion: '1' },
          spec: { contextRef: 'ctx' },
        }
      if (plural === 'contexts') return structuredClone(fixture.contexts.get(name))
      return read(name)
    },
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
    if (
      fixture.failPolicyType &&
      Object.values(body.metadata.labels ?? {}).includes(fixture.failPolicyType)
    )
      throw new Error('injected additive API failure')
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
    hasPendingReconciliation() {
      return false
    }
    hasIncompleteReconciliation() {
      return false
    }
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
  runInitialNetworkPolicyConvergence(options?: { cause?: string }): Promise<void>
  runInitialConvergence(lane: string): Promise<void>
  initialConvergenceRetryTimers: Map<string, unknown>
  recoverContextInventoryAndWatch(): Promise<boolean>
  enqueueMcpServerReconciliation(server: McpServerCRD, work: () => Promise<void>): Promise<void>
  servers: Map<string, McpServerCRD>
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
  let api: ContextMapperServer | undefined
  beforeEach(() => {
    vi.useFakeTimers()
    fixture.policies.clear()
    fixture.contexts.clear()
    fixture.failPolicyType = undefined
    config.netPolResyncIntervalSec = 0
    fixture.servers.clear()
    fixture.revision = 0
    fixture.list.mockImplementation(async ({ plural }: { plural: string }) => ({
      metadata: { resourceVersion: `list-${++fixture.revision}` },
      items:
        plural === 'mcpservers'
          ? [...fixture.servers.values()].map(value => structuredClone(value))
          : plural === 'contexts'
            ? [...fixture.contexts.values()].map(value => structuredClone(value))
            : [],
    }))
  })
  afterEach(async () => {
    await api?.stop()
    api = undefined
    await watcher?.stop()
    vi.restoreAllMocks()
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
  async function settled(): Promise<Harness> {
    config.netPolResyncIntervalSec = 3600
    fixture.contexts.set('ctx', {
      metadata: {
        name: 'ctx',
        namespace: 'mcp-server',
        uid: 'ctx-uid',
        generation: 1,
        resourceVersion: '1',
      },
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
    watcher = new McpServerWatcher()
    await watcher.start()
    const state = watcher as unknown as Harness
    await drain(state)
    expect(watcher.isReadinessInventoryAuthoritative()).toBe(true)
    expect(fixture.policies.size).toBeGreaterThanOrEqual(4)
    return state
  }

  it('A-T3/T5: settled identical recoveries skip before scheduler admission with an active resync', async () => {
    const state = await settled()
    const admission = vi.spyOn(state, 'runInitialConvergence')
    const log = vi.spyOn(hccLogger, 'info')
    const before = structuredClone([...fixture.policies.entries()])
    expect(await state.recoverMcpServerInventoryAndWatch()).toBe(true)
    expect(await state.recoverContextInventoryAndWatch()).toBe(true)
    await drain(state)
    expect(admission.mock.calls.filter(([lane]) => lane === 'NetworkPolicy')).toEqual([])
    expect([...fixture.policies.entries()]).toEqual(before)
    for (const kind of ['McpServer', 'Context'])
      expect(log).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          event: 'networkpolicy-recovery-decision',
          kind,
          decision: 'skip',
          reason: 'identical-complete',
        })
      )
  })

  it.each(['McpServer', 'Context', 'timer'] as const)(
    'A-T4: %s repairs a real additive failure',
    async kind => {
      const state = await settled()
      const desired = [...fixture.policies.entries()].find(([, policy]) =>
        Object.values(policy.metadata.labels ?? {}).includes('context-allow')
      )!
      expect(desired).toBeDefined()
      const certificate = vi.spyOn(
        state as unknown as { recordNetworkPolicySafetyCertificate(value: unknown): boolean },
        'recordNetworkPolicySafetyCertificate'
      )
      fixture.policies.delete(desired[0])
      fixture.failPolicyType = 'context-allow'
      await state.runInitialNetworkPolicyConvergence({ cause: 'context-change' })
      await drain(state)
      expect(certificate).toHaveBeenCalled()
      expect(
        certificate.mock.results.some(result => result.type === 'return' && result.value === true)
      ).toBe(true)
      expect(fixture.policies.has(desired[0])).toBe(false)
      expect(watcher.getReadinessInventoryDetail().safetyInventoryCertified).toBe(false)
      expect(state.initialConvergenceRetryTimers.has('NetworkPolicy')).toBe(true)
      fixture.failPolicyType = undefined
      const now = Date.now()
      const request = vi.spyOn(state, 'runInitialNetworkPolicyConvergence')
      if (kind === 'timer') {
        await vi.advanceTimersByTimeAsync(5000)
        expect(request).toHaveBeenCalledWith(expect.objectContaining({ cause: 'retry' }))
      } else {
        expect(
          await (kind === 'McpServer'
            ? state.recoverMcpServerInventoryAndWatch()
            : state.recoverContextInventoryAndWatch())
        ).toBe(true)
        expect(Date.now()).toBe(now)
      }
      await drain(state)
      expect(fixture.policies.get(desired[0])?.spec).toEqual(desired[1].spec)
      expect(watcher.isReadinessInventoryAuthoritative()).toBe(true)
      expect(state.initialConvergenceRetryTimers.has('NetworkPolicy')).toBe(false)
    }
  )

  it.each(['McpServer', 'Context'] as const)(
    'A-T6: concurrent %s recoveries share one physical LIST and one decision',
    async kind => {
      const state = await settled()
      let release!: () => void
      const barrier = new Promise<void>(resolve => {
        release = resolve
      })
      const list = fixture.list.getMockImplementation()!
      const plural = kind === 'McpServer' ? 'mcpservers' : 'contexts'
      fixture.list.mockImplementation(async args => {
        if (args.plural === plural) await barrier
        return list(args)
      })
      fixture.list.mockClear()
      const log = vi.spyOn(hccLogger, 'info')
      const recover = () =>
        kind === 'McpServer'
          ? state.recoverMcpServerInventoryAndWatch()
          : state.recoverContextInventoryAndWatch()
      const first = recover(),
        second = recover()
      expect(first).toBe(second)
      release()
      expect(await first).toBe(true)
      await drain(state)
      expect(fixture.list.mock.calls.filter(([args]) => args.plural === plural)).toHaveLength(1)
      expect(
        log.mock.calls.filter(
          ([, fields]) =>
            (fields as { event?: string; kind?: string })?.event ===
              'networkpolicy-recovery-decision' && (fields as { kind?: string }).kind === kind
        )
      ).toHaveLength(1)
    }
  )

  it('A-T3: inactive periodic recovery never permits an identical omission', async () => {
    const state = await settled()
    const internals = state as unknown as {
      netPolResyncTimer: ReturnType<typeof setInterval> | null
    }
    clearInterval(internals.netPolResyncTimer!)
    internals.netPolResyncTimer = null
    const admission = vi.spyOn(state, 'runInitialConvergence')
    expect(await state.recoverMcpServerInventoryAndWatch()).toBe(true)
    await drain(state)
    expect(admission.mock.calls.filter(([lane]) => lane === 'NetworkPolicy')).toHaveLength(1)
  })

  it.each(['spec', 'uid', 'generation'] as const)(
    'A-T3: changed server %s requests convergence and final policy matches current inventory',
    async change => {
      const state = await settled()
      const server = fixture.servers.get('server')!
      if (change === 'spec') server.spec.transport.port = 3011
      else if (change === 'uid') server.metadata.uid = 'replacement-server-uid'
      else server.metadata.generation = 2
      const admission = vi.spyOn(state, 'runInitialConvergence')
      expect(await state.recoverMcpServerInventoryAndWatch()).toBe(true)
      await drain(state)
      expect(admission.mock.calls.filter(([lane]) => lane === 'NetworkPolicy')).toHaveLength(1)
      expect(watcher.isReadinessInventoryAuthoritative()).toBe(true)
      const contextPolicy = [...fixture.policies.values()].find(policy =>
        Object.values(policy.metadata.labels ?? {}).includes('context-allow')
      )!
      expect(
        contextPolicy.spec?.ingress
          ?.flatMap(rule => rule.ports ?? [])
          .some(port => port.port === (change === 'spec' ? 3011 : 3000))
      ).toBe(true)
      expect(state.servers.get('server')?.uid).toBe(server.metadata.uid)
    }
  )

  it('A-T8: a blocked server FIFO closes API authority while the probe stays fresh, then restores business policies', async () => {
    const state = await settled()
    const control = structuredClone(fixture.servers.get('server')!)
    control.metadata.name = 'control'
    control.metadata.uid = 'control-uid'
    fixture.servers.set('control', control)
    fixture.contexts.get('ctx')!.spec.mcpServers.push('control')
    await state.recoverMcpServerInventoryAndWatch()
    await state.recoverContextInventoryAndWatch()
    await drain(state)
    const controlPolicies = [...fixture.policies.entries()].filter(([, policy]) =>
      Object.values(policy.metadata.labels ?? {}).includes('control')
    )
    expect(controlPolicies.length).toBeGreaterThan(0)
    const apiGate = resolveProviderAuthoritativeFn(watcher)
    const probeGate = resolveProbeAuthoritativeFn(watcher)
    const authenticator = {
      authenticate: () => ({
        subject: 'host:test',
        hostName: 'host',
        hostUid: 'host-uid',
        namespace: 'mcp-host',
        jti: 'request-id',
        issuedAt: 1,
        expiresAt: Number.MAX_SAFE_INTEGER,
        audiences: ['host-context-controller'],
      }),
    } as unknown as McpApiAuthenticator
    const authorization = new McpAuthorizationService(createMcpAuthorizationStore(watcher))
    api = new ContextMapperServer(
      watcher,
      0,
      undefined,
      undefined,
      apiGate,
      undefined,
      authenticator,
      authorization,
      () => watcher.getReadinessInventoryDetail(),
      probeGate
    )
    await api.start()
    api.setReady(true)
    const address = (api as unknown as { server: http.Server }).server.address() as { port: number }
    const request = (path: string): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        http
          .get({ hostname: '127.0.0.1', port: address.port, path }, response => {
            let body = ''
            response.setEncoding('utf8')
            response.on('data', chunk => {
              body += chunk
            })
            response.on('end', () => resolve({ status: response.statusCode!, body }))
          })
          .on('error', reject)
      })
    expect((await request('/api/v2/hosts/self/mcpservers')).status).toBe(200)
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const queue = state.enqueueMcpServerReconciliation(state.servers.get('server')!, async () => {
      entered()
      await blocked
    })
    await started
    const original = structuredClone(fixture.servers.get('server')!)
    const changed = structuredClone(original)
    for (const condition of changed.status!.conditions!) {
      condition.status = 'False'
      condition.reason = condition.reason?.replace('Found', 'NotFound')
    }
    fixture.servers.set('server', changed)
    expect(await state.recoverMcpServerInventoryAndWatch()).toBe(true)
    expect(apiGate()).toBe(false)
    expect(probeGate()).toBe(true)
    expect((await request('/ready')).status).toBe(200)
    expect(await request('/api/v2/hosts/self/mcpservers')).toEqual({
      status: 503,
      body: JSON.stringify({ error: 'authorization_unavailable' }),
    })
    expect(
      [...fixture.policies.values()].some(policy =>
        Object.values(policy.metadata.labels ?? {}).includes('external-egress')
      )
    ).toBe(true)
    release()
    await queue
    await drain(state)
    expect(apiGate()).toBe(true)
    expect(probeGate()).toBe(true)
    expect(
      [...fixture.policies.values()].filter(
        policy =>
          Object.values(policy.metadata.labels ?? {}).includes('server') &&
          ['context-allow', 'rpc-proxy-egress', 'external-egress'].some(type =>
            Object.values(policy.metadata.labels ?? {}).includes(type)
          )
      )
    ).toEqual([])
    for (const [key, policy] of controlPolicies) expect(fixture.policies.get(key)).toEqual(policy)
    fixture.servers.set('server', original)
    expect(await state.recoverMcpServerInventoryAndWatch()).toBe(true)
    await drain(state)
    expect(apiGate()).toBe(true)
    const restored = await request('/api/v2/hosts/self/mcpservers')
    expect(restored.status).toBe(200)
    expect(JSON.parse(restored.body).servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'server' }),
        expect.objectContaining({ name: 'control' }),
      ])
    )
    expect(
      [...fixture.policies.values()].some(policy =>
        Object.values(policy.metadata.labels ?? {}).includes('context-allow')
      )
    ).toBe(true)
  })

  it.each(['before', 'after'] as const)(
    'A-T5/T6: changes %s capture retain causes and converge the final revision',
    async order => {
      const state = await settled()
      const internal = state as unknown as {
        installMcpServerSnapshot(snapshot: { servers: McpServerCRD[] }): void
        netPolReconciler: { fullReconcile(...args: unknown[]): Promise<void> }
      }
      const log = vi.spyOn(hccLogger, 'info')
      const install = (port: number) => {
        fixture.servers.get('server')!.spec.transport.port = port
        const current = structuredClone(state.servers.get('server')!)
        current.spec.transport.port = port
        internal.installMcpServerSnapshot({ servers: [current] })
      }
      let entered!: () => void, release!: () => void
      const captured = new Promise<void>(resolve => {
        entered = resolve
      })
      const barrier = new Promise<void>(resolve => {
        release = resolve
      })
      const real = internal.netPolReconciler.fullReconcile.bind(internal.netPolReconciler)
      if (order === 'after')
        vi.spyOn(internal.netPolReconciler, 'fullReconcile').mockImplementationOnce(
          async (...args) => {
            entered()
            await barrier
            await real(...args)
          }
        )
      install(3001)
      const first = state.runInitialNetworkPolicyConvergence({ cause: 'mcp-change' })
      if (order === 'after') await captured
      install(3002)
      const second = state.runInitialNetworkPolicyConvergence({ cause: 'context-change' })
      release()
      await Promise.all([first, second])
      await drain(state)
      const starts = log.mock.calls
        .map(
          ([, fields]) =>
            fields as {
              event?: string
              causes: string[]
              serverRevision: number
              trailing: boolean
            }
        )
        .filter(fields => fields?.event === 'networkpolicy-pass-start')
      expect(starts.map(fields => fields.serverRevision)).toEqual(order === 'before' ? [3] : [2, 3])
      expect(starts.map(fields => fields.trailing)).toEqual(
        order === 'before' ? [false] : [false, true]
      )
      expect(starts.flatMap(fields => fields.causes).sort()).toEqual([
        'context-change',
        'mcp-change',
      ])
      expect(watcher.isReadinessInventoryAuthoritative()).toBe(true)
      const policy = [...fixture.policies.values()].find(policy =>
        Object.values(policy.metadata.labels ?? {}).includes('context-allow')
      )!
      expect(
        policy.spec?.ingress?.flatMap(rule => rule.ports ?? []).some(port => port.port === 3002)
      ).toBe(true)
    }
  )

  it('A-T6: identical crossed recoveries do not add trailing work to an active settled pass', async () => {
    const state = await settled()
    const core = state as unknown as { runInitialNetworkPolicyConvergenceCore(): Promise<void> }
    const real = core.runInitialNetworkPolicyConvergenceCore.bind(core)
    let entered!: () => void, release!: () => void
    const completed = new Promise<void>(resolve => {
      entered = resolve
    })
    const barrier = new Promise<void>(resolve => {
      release = resolve
    })
    const passes = vi
      .spyOn(core, 'runInitialNetworkPolicyConvergenceCore')
      .mockImplementationOnce(async () => {
        await real()
        const runtime = state.initialConvergenceRuns.get('McpServer')
        if (runtime) await runtime.promise
        entered()
        await barrier
      })
    const active = state.runInitialNetworkPolicyConvergence({ cause: 'periodic-resync' })
    await completed
    const admission = vi.spyOn(state, 'runInitialConvergence')
    expect(await state.recoverMcpServerInventoryAndWatch()).toBe(true)
    expect(await state.recoverContextInventoryAndWatch()).toBe(true)
    expect(admission.mock.calls.filter(([lane]) => lane === 'NetworkPolicy')).toEqual([])
    release()
    await active
    await drain(state)
    expect(passes).toHaveBeenCalledTimes(1)
  })

  it('A-T3: Context membership removal and restoration produce final allow policies', async () => {
    const state = await settled()
    const desired = [...fixture.policies.entries()].filter(([, policy]) =>
      Object.values(policy.metadata.labels ?? {}).includes('context-allow')
    )
    expect(desired.length).toBeGreaterThan(0)
    fixture.contexts.get('ctx')!.spec.mcpServers = []
    expect(await state.recoverContextInventoryAndWatch()).toBe(true)
    await drain(state)
    for (const [key] of desired) expect(fixture.policies.has(key)).toBe(false)
    fixture.contexts.get('ctx')!.spec.mcpServers = ['server']
    expect(await state.recoverContextInventoryAndWatch()).toBe(true)
    await drain(state)
    for (const [key, policy] of desired)
      expect(fixture.policies.get(key)?.spec).toEqual(policy.spec)
  })
  it('A-T5: all eight production entry points report their actual cause', async () => {
    const log = vi.spyOn(hccLogger, 'info')
    const state = await settled()
    const server = fixture.servers.get('server')!
    server.spec.transport.port = 3010
    await state.getMcpServerWatchCallback()('MODIFIED', structuredClone(server))
    await drain(state)
    const contextCallback = () =>
      fixture.watch.mock.calls
        .filter(([path]) => String(path).endsWith('/contexts'))
        .at(-1)![2] as (type: string, value: unknown) => Promise<void>
    const context = fixture.contexts.get('ctx')!
    context.metadata.generation = 2
    await contextCallback()('MODIFIED', structuredClone(context))
    await drain(state)
    server.metadata.generation = 2
    expect(await state.recoverMcpServerInventoryAndWatch()).toBe(true)
    await drain(state)
    context.metadata.generation = 3
    expect(await state.recoverContextInventoryAndWatch()).toBe(true)
    await drain(state)
    const policy = [...fixture.policies.entries()].find(([, policy]) =>
      Object.values(policy.metadata.labels ?? {}).includes('context-allow')
    )!
    fixture.policies.delete(policy[0])
    fixture.failPolicyType = 'context-allow'
    await contextCallback()('MODIFIED', structuredClone(context))
    await drain(state)
    expect(state.initialConvergenceRetryTimers.has('NetworkPolicy')).toBe(true)
    fixture.failPolicyType = undefined
    await vi.advanceTimersByTimeAsync(5000)
    await drain(state)
    await vi.advanceTimersByTimeAsync(3_600_000)
    await drain(state)
    const requests = log.mock.calls
      .map(([, fields]) => fields as { event?: string; cause: string })
      .filter(fields => fields?.event === 'networkpolicy-request')
    expect([...new Set(requests.map(fields => fields.cause))].sort()).toEqual([
      'context-change',
      'context-reconcile-failure',
      'context-recovery',
      'mcp-change',
      'mcp-recovery',
      'periodic-resync',
      'retry',
      'startup',
    ])
    expect(fixture.policies.get(policy[0])?.spec).toEqual(policy[1].spec)
  })

  it('A-T6 regression: interrupted additive policy work cannot be marked complete after identical recovery', async () => {
    const state = await settled()
    const owner = (state as any).netPolReconciler
    const desired = [...fixture.policies.entries()].find(([, policy]) =>
      Object.values(policy.metadata.labels ?? {}).includes('context-allow')
    )!
    fixture.policies.delete(desired[0])
    const defer = () => {
      let resolve!: () => void
      const promise = new Promise<void>(done => {
        resolve = done
      })
      return { promise, resolve }
    }
    const entered = defer(),
      run = defer(),
      innerDone = defer(),
      finish = defer(),
      watchEntered = defer(),
      watchFinish = defer()
    const real = owner.reconcileContext.bind(owner)
    vi.spyOn(owner, 'reconcileContext').mockImplementationOnce(async (...args) => {
      entered.resolve()
      await run.promise
      const result = await real(...args)
      innerDone.resolve()
      await finish.promise
      return result
    })
    const pass = state.runInitialNetworkPolicyConvergence({ cause: 'periodic-resync' })
    await entered.promise
    const runtime = state.initialConvergenceRuns.get('McpServer')
    if (runtime) await runtime.promise
    fixture.watch.mockImplementationOnce(async () => {
      watchEntered.resolve()
      await watchFinish.promise
      return { abort: vi.fn() }
    })
    const recovery = state.recoverContextInventoryAndWatch()
    await watchEntered.promise
    run.resolve()
    await innerDone.promise
    expect(fixture.policies.has(desired[0])).toBe(false)
    watchFinish.resolve()
    await recovery
    finish.resolve()
    await pass
    await drain(state)
    expect(state.initialConvergenceRetryTimers.has('NetworkPolicy')).toBe(true)
    expect(watcher.getReadinessInventoryDetail().safetyInventoryCertified).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    await drain(state)
    expect(fixture.policies.get(desired[0])?.spec).toEqual(desired[1].spec)
  })
  it('A-T6 recovery scheduling: simultaneous retirement defers MCP until Context restores authority', async () => {
    const state = await settled()
    const before = structuredClone([...fixture.policies.entries()])
    expect(before).toHaveLength(17)
    const log = vi.spyOn(hccLogger, 'info')
    const originalList = fixture.list.getMockImplementation()!
    for (let cycle = 0; cycle < 3; cycle++) {
      await vi.advanceTimersByTimeAsync(7000)
      let release!: () => void, entered!: () => void
      const hold = new Promise<void>(resolve => {
        release = resolve
      })
      const started = new Promise<void>(resolve => {
        entered = resolve
      })
      fixture.list.mockImplementation(async args => {
        if (args.plural === 'contexts') {
          entered()
          await hold
        }
        return originalList(args)
      })
      ;(state as any).retireContextWatch()
      ;(state as any).retireMcpServerWatch()
      const contextRecovery = state.recoverContextInventoryAndWatch()
      await started
      expect(await state.recoverMcpServerInventoryAndWatch()).toBe(true)
      expect(state.contextCacheSynced).toBe(false)
      release()
      expect(await contextRecovery).toBe(true)
      await drain(state)
      expect(watcher.isReadinessInventoryAuthoritative()).toBe(true)
      expect([...fixture.policies.entries()]).toEqual(before)
    }
    const decisions = log.mock.calls
      .map(([, data]) => data as any)
      .filter(data => data?.event === 'networkpolicy-recovery-decision')
    const mcps = decisions.filter(data => data.kind === 'McpServer')
    const contexts = decisions.filter(data => data.kind === 'Context')
    expect(mcps).toHaveLength(3)
    expect(mcps.every(data => data.decision === 'defer' && data.reason === 'no-authority')).toBe(
      true
    )
    expect(contexts).toHaveLength(3)
    expect(
      contexts.every(data => data.decision === 'skip' && data.reason === 'identical-complete')
    ).toBe(true)
  })

  it('A-T6 recovery scheduling: independent recoveries skip while their peer stays authoritative', async () => {
    const state = await settled()
    const before = structuredClone([...fixture.policies.entries()])
    expect(before).toHaveLength(17)
    const log = vi.spyOn(hccLogger, 'info')
    const admission = vi.spyOn(state, 'runInitialConvergence')
    for (let cycle = 0; cycle < 3; cycle++) {
      await vi.advanceTimersByTimeAsync(7000)
      expect(state.contextCacheSynced).toBe(true)
      ;(state as any).retireMcpServerWatch()
      expect(await state.recoverMcpServerInventoryAndWatch()).toBe(true)
      await drain(state)
      expect(watcher.isReadinessInventoryAuthoritative()).toBe(true)
      expect([...fixture.policies.entries()]).toEqual(before)
      expect(state.mcpServerCacheSynced).toBe(true)
      ;(state as any).retireContextWatch()
      expect(await state.recoverContextInventoryAndWatch()).toBe(true)
      await drain(state)
      expect(watcher.isReadinessInventoryAuthoritative()).toBe(true)
      expect([...fixture.policies.entries()]).toEqual(before)
    }
    const decisions = log.mock.calls
      .map(([, data]) => data as any)
      .filter(data => data?.event === 'networkpolicy-recovery-decision')
    const mcpSkips = decisions.filter(
      data => data.kind === 'McpServer' && data.decision === 'skip'
    ).length
    const contextSkips = decisions.filter(
      data => data.kind === 'Context' && data.decision === 'skip'
    ).length
    const npAdmissions = admission.mock.calls.filter(([lane]) => lane === 'NetworkPolicy').length
    expect(mcpSkips).toBe(3)
    expect(contextSkips).toBe(3)
    expect(npAdmissions).toBe(0)
  })
})
