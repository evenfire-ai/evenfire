import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { V1Deployment, V1Service } from '@kubernetes/client-node'
import { McpServerWatcher } from './k8sClient'
import { hccLogger } from './logger'
import { registry } from './metrics'
import { McpServerReconciler } from './reconciler'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

const fixture = vi.hoisted(() => ({
  services: new Map<string, V1Service>(),
  deployments: new Map<string, V1Deployment>(),
  writes: [] as string[],
  revision: 0,
  rolloutReady: true,
  failDeployment: false,
  serverExists: true,
  readInput: undefined as undefined | (() => Promise<unknown>),
  failPublication: undefined as undefined | ((body: any[]) => boolean),
  server: undefined as any,
  readService: undefined as undefined | (() => Promise<void>),
}))

vi.mock('./config', () => ({
  config: {
    devMode: false,
    namespace: 'mcp-server',
    hostNamespace: 'mcp-host',
    channelsNamespace: 'channels',
    llmHooksNamespace: 'llm-hooks',
    rpcProxyNamespace: 'rpc-proxy',
    runtimeNamespaces: ['mcp-server', 'mcp-host', 'rpc-proxy'],
    hostK8sRequestTimeoutMs: 30000,
    hostResyncIntervalSec: 0,
    netPolResyncIntervalSec: 3600,
    netPolDefaultsResyncIntervalSec: 0,
    externalEgressResyncIntervalSec: 0,
    allowedPluginImagePrefixes: ['ghcr.io/palmeradao/'],
    mcpServerImagePullPolicy: 'IfNotPresent',
  },
}))

vi.mock('@kubernetes/client-node', async importOriginal => {
  const actual = await importOriginal<typeof import('@kubernetes/client-node')>()
  const absent = () => Object.assign(new Error('fixture resource absent'), { code: 404 })
  const read = <T>(store: Map<string, T>, name: string): T => {
    const object = store.get(name)
    if (!object) throw absent()
    return structuredClone(object)
  }
  const save = (kind: string, store: Map<string, any>, namespace: string, body: any) => {
    if (kind === 'Deployment' && fixture.failDeployment)
      throw new Error('fixture deployment write unavailable')
    const object = structuredClone(body)
    object.metadata = {
      ...object.metadata,
      namespace,
      uid: `${kind}-${body.metadata.name}`,
      resourceVersion: String(++fixture.revision),
      generation: 1,
    }
    if (kind === 'Deployment')
      object.status = {
        observedGeneration: 1,
        replicas: 1,
        readyReplicas: fixture.rolloutReady ? 1 : 0,
        availableReplicas: fixture.rolloutReady ? 1 : 0,
        updatedReplicas: 1,
      }
    store.set(object.metadata.name, object)
    fixture.writes.push(`${kind}/${object.metadata.name}`)
    return structuredClone(object)
  }
  const core = {
    readNamespacedSecret: async () => {
      if (fixture.readInput) return fixture.readInput()
      throw absent()
    },
    readNamespacedConfigMap: async () => {
      throw absent()
    },
    deleteNamespacedService: async ({ name }: any) => {
      fixture.services.delete(name)
    },
    readNamespacedService: async ({ name }: any) => {
      await fixture.readService?.()
      return read(fixture.services, name)
    },
    createNamespacedService: async ({ namespace, body }: any) =>
      save('Service', fixture.services, namespace, body),
    replaceNamespacedService: async ({ namespace, body }: any) =>
      save('Service', fixture.services, namespace, body),
  }
  const apps = {
    deleteNamespacedDeployment: async ({ name }: any) => {
      fixture.deployments.delete(name)
    },
    listNamespacedDeployment: async () => ({
      items: [...fixture.deployments.values()].map(value => structuredClone(value)),
    }),
    readNamespacedDeployment: async ({ name }: any) => read(fixture.deployments, name),
    createNamespacedDeployment: async ({ namespace, body }: any) =>
      save('Deployment', fixture.deployments, namespace, body),
    replaceNamespacedDeployment: async ({ namespace, body }: any) =>
      save('Deployment', fixture.deployments, namespace, body),
  }
  const custom = {
    listNamespacedCustomObject: async ({ plural }: any) => ({
      metadata: { resourceVersion: String(++fixture.revision) },
      items:
        plural === 'mcpservers' && fixture.serverExists ? [structuredClone(fixture.server)] : [],
    }),
    getNamespacedCustomObject: async () => {
      if (!fixture.serverExists) throw absent()
      return structuredClone(fixture.server)
    },
    getNamespacedCustomObjectStatus: async () => structuredClone(fixture.server),
    patchNamespacedCustomObjectStatus: async ({ body }: any) => {
      if (fixture.failPublication?.(body))
        throw Object.assign(new Error('fixture status unavailable'), { code: 503 })
      for (const patch of body) {
        if (patch.op === 'test') {
          const field = patch.path.slice('/metadata/'.length)
          if (fixture.server.metadata[field] !== patch.value)
            throw Object.assign(new Error('fixture status conflict'), { code: 409 })
        } else if (patch.path === '/status') fixture.server.status = structuredClone(patch.value)
        else if (patch.path === '/status/conditions')
          fixture.server.status.conditions = structuredClone(patch.value)
        else throw new Error(`Unexpected status patch ${patch.path}`)
      }
      fixture.server.metadata.resourceVersion = String(++fixture.revision)
      return structuredClone(fixture.server)
    },
  }
  return {
    ...actual,
    KubeConfig: class {
      loadFromDefault() {}
      makeApiClient(type: unknown) {
        if (type === actual.CoreV1Api) return core
        if (type === actual.AppsV1Api) return apps
        if (type === actual.CustomObjectsApi) return custom
        return {}
      }
    },
    Watch: class {
      async watch() {
        return { abort() {} }
      }
    },
  }
})

async function until(predicate: () => boolean) {
  for (let turn = 0; turn < 200; turn++) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('Expected runtime state did not settle')
}

async function drain(state: any) {
  for (let pass = 0; pass < 30; pass++) {
    await Promise.resolve()
    const pending = [...state.initialConvergenceRuns.values()].map((run: any) => run.promise)
    for (const entry of state.mcpServerReconciliationQueues.values()) pending.push(entry.queue.tail)
    if (!pending.length) return
    await Promise.all(pending)
  }
  throw new Error('Runtime queues did not drain')
}

function prepareWatcher(policyTail?: Promise<void>) {
  const watcher = new McpServerWatcher()
  const state = watcher as any
  expect(state.reconciler).toBeInstanceOf(McpServerReconciler)
  // Only unrelated controller effects are replaced. Runtime reconciliation,
  // serializers, authority fences and generated Service/Deployment bodies run.
  vi.spyOn(state.netPolReconciler, 'ensureDefaultPolicies').mockResolvedValue(undefined)
  vi.spyOn(state.netPolReconciler, 'hasCertifiedSafetyInventory').mockReturnValue(true)
  vi.spyOn(state.netPolReconciler, 'reconcileExternalEgress').mockResolvedValue(undefined)
  vi.spyOn(state.netPolReconciler, 'fullReconcile').mockImplementation(async (...args: any[]) => {
    args[2].onAuthoritativeRevocationComplete()
    await policyTail
  })
  for (const owner of [
    'hostReconciler',
    'sharedFileSystemReconciler',
    'gfsReconciler',
    'llmHookReconciler',
  ]) {
    vi.spyOn(state[owner], 'fullReconcile').mockResolvedValue(undefined)
  }
  vi.spyOn(state.hostReconciler, 'reconcileHosts').mockResolvedValue(undefined)
  return { watcher, state }
}

async function skippedTickCount() {
  const metric = await registry
    .getSingleMetric('clerum_hcc_netpol_resync_ticks_skipped_total')!
    .get()
  return metric.values.find(value => value.labels.reason === 'pass-in-flight')?.value ?? 0
}

describe('A-T7 real MCP runtime repair after identical recovery', () => {
  let watcher: McpServerWatcher | undefined
  beforeEach(() => {
    vi.useFakeTimers()
    fixture.services.clear()
    fixture.deployments.clear()
    fixture.writes.length = 0
    fixture.revision = 0
    fixture.rolloutReady = true
    fixture.failDeployment = false
    fixture.serverExists = true
    fixture.readInput = undefined
    fixture.failPublication = undefined
    fixture.readService = undefined
    fixture.server = {
      metadata: {
        name: 'runtime-witness',
        namespace: 'mcp-server',
        uid: 'runtime-witness-uid',
        generation: 1,
        resourceVersion: '1',
      },
      spec: {
        image: 'ghcr.io/palmeradao/runtime-test:v1',
        enabled: true,
        managed: true,
        transport: { type: 'http', port: 3000 },
      },
    }
  })
  afterEach(async () => {
    await watcher?.stop()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('A-T7a a skipped tick does not repair drift; the next effective periodic tick repairs unchanged CRD intent', async () => {
    const policyTail = deferred()
    const harness = prepareWatcher(policyTail.promise)
    watcher = harness.watcher
    const { state } = harness
    const decisions = vi.spyOn(hccLogger, 'info')
    await watcher.start()
    await until(() => !state.runtimeRepairPending && fixture.deployments.size === 1)
    expect(fixture.writes).toEqual(['Service/runtime-witness', 'Deployment/runtime-witness'])
    const desired = structuredClone(fixture.server.spec)
    const desiredGeneration = fixture.server.metadata.generation
    fixture.services.delete('runtime-witness')
    const writesBefore = fixture.writes.length
    const skipsBefore = await skippedTickCount()
    await vi.advanceTimersByTimeAsync(3600_000)
    expect(await skippedTickCount()).toBe(skipsBefore + 1)
    expect(fixture.services.has('runtime-witness')).toBe(false)
    expect(fixture.writes).toHaveLength(writesBefore)
    policyTail.resolve()
    await drain(state)
    await state.recoverMcpServerInventoryAndWatch()
    await drain(state)
    expect(decisions).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: 'networkpolicy-recovery-decision',
        decision: 'skip',
        reason: 'identical-complete',
      })
    )
    expect(fixture.services.has('runtime-witness')).toBe(false)
    expect(fixture.writes).toHaveLength(writesBefore)
    await vi.advanceTimersByTimeAsync(3600_000)
    await drain(state)
    expect(fixture.services.get('runtime-witness')?.spec?.ports?.[0].port).toBe(3000)
    expect(fixture.writes.slice(writesBefore)).toContain('Service/runtime-witness')
    expect(fixture.server.spec).toEqual(desired)
    expect(fixture.server.metadata.generation).toBe(desiredGeneration)
    expect(state.runtimeRepairPending).toBe(false)
  })

  it('A-T7b a new watch generation retires a blocked effect and retains repair until a real resource write completes', async () => {
    const oldRead = deferred()
    const newRead = deferred()
    let reads = 0
    fixture.readService = async () => {
      reads++
      if (reads === 1) await oldRead.promise
      if (reads === 2) await newRead.promise
    }
    const harness = prepareWatcher()
    watcher = harness.watcher
    const { state } = harness
    const decisions = vi.spyOn(hccLogger, 'info')
    await watcher.start()
    await until(() => reads === 1 && !state.networkPolicyRepairPending)
    expect(state.runtimeRepairPending).toBe(true)
    const oldGeneration = state.mcpWatchGeneration
    const clockBefore = Date.now()
    await state.recoverMcpServerInventoryAndWatch()
    expect(state.mcpWatchGeneration).toBeGreaterThan(oldGeneration)
    oldRead.resolve()
    await until(() => reads === 2)
    expect(fixture.writes).toEqual([])
    expect(fixture.services.size).toBe(0)
    expect(state.runtimeRepairPending).toBe(true)
    newRead.resolve()
    await drain(state)
    expect(fixture.writes).toEqual(['Service/runtime-witness', 'Deployment/runtime-witness'])
    expect(fixture.services.get('runtime-witness')?.spec?.ports?.[0].port).toBe(3000)
    expect(
      fixture.deployments.get('runtime-witness')?.spec?.template.spec?.containers[0].image
    ).toBe('ghcr.io/palmeradao/runtime-test:v1')
    expect(state.runtimeRepairPending).toBe(false)
    expect(decisions).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ decision: 'request', reason: 'work-pending' })
    )
    expect(Date.now()).toBe(clockBefore)
  })

  it('A-T7 regression: a swallowed runtime API failure must retain its pending repair', async () => {
    fixture.readService = async () => {
      throw new Error('transient upstream unavailable')
    }
    const harness = prepareWatcher()
    watcher = harness.watcher
    const { state } = harness
    await watcher.start()
    await drain(state)
    expect(fixture.services.size).toBe(0)
    expect(fixture.deployments.size).toBe(0)
    expect(state.reconciler.getStatus('runtime-witness')?.deployed).toBe(false)
    fixture.readService = undefined
    const decision = vi.spyOn(hccLogger, 'info')
    await state.recoverMcpServerInventoryAndWatch()
    await drain(state)
    expect(decision).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ decision: 'request' })
    )
    expect(fixture.services.has('runtime-witness')).toBe(true)
  })

  it('A-T7 regression: identical recovery must preserve the active readiness poll', async () => {
    fixture.rolloutReady = false
    const harness = prepareWatcher()
    watcher = harness.watcher
    const { state } = harness
    await watcher.start()
    await drain(state)
    expect(state.reconciler.hasIncompleteReconciliation()).toBe(false)
    expect(state.reconciler.hasPendingReconciliation()).toBe(true)
    expect(state.initialConvergenceRetryTimers.has('McpServer')).toBe(false)
    expect(state.reconciler.readinessPolls.size).toBe(1)
    expect(state.reconciler.getStatus('runtime-witness').ready).toBe(false)
    await state.recoverMcpServerInventoryAndWatch()
    await drain(state)
    const deployment = fixture.deployments.get('runtime-witness')!
    deployment.status!.readyReplicas = 1
    deployment.status!.availableReplicas = 1
    await vi.advanceTimersByTimeAsync(5000)
    expect(state.reconciler.getStatus('runtime-witness').ready).toBe(true)
    expect(fixture.server.status.conditions).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'DeploymentReady', status: 'True' })])
    )
    expect(state.reconciler.hasPendingReconciliation()).toBe(false)
  })

  it.each(['disabled', 'wrc', 'missing-input', 'wrc-missing-input'] as const)(
    'A-T7 control: intentional %s runtime absence is complete',
    async mode => {
      if (mode === 'disabled') fixture.server.spec.enabled = false
      else if (mode === 'wrc' || mode === 'wrc-missing-input') fixture.server.spec.managed = false
      if (mode.includes('missing-input'))
        fixture.server.spec.envSecret = { name: 'absent-fixture', keys: [] }
      const harness = prepareWatcher()
      watcher = harness.watcher
      const { state } = harness
      await watcher.start()
      await drain(state)
      expect(fixture.services.size).toBe(0)
      expect(fixture.deployments.size).toBe(0)
      expect(state.reconciler.hasPendingReconciliation()).toBe(false)
      expect(state.initialConvergenceRetryTimers.has('McpServer')).toBe(false)
      // Fold the status-derived eligibility result back through real LIST once.
      await state.recoverMcpServerInventoryAndWatch()
      await drain(state)
      expect(state.reconciler.hasPendingReconciliation()).toBe(false)
      const decisions = vi.spyOn(hccLogger, 'info')
      await state.recoverMcpServerInventoryAndWatch()
      await drain(state)
      expect(decisions).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ decision: 'skip', reason: 'identical-complete' })
      )
    }
  )

  it('A-T7 control: watch or informer work retains its obligation outside a fleet pass', async () => {
    const harness = prepareWatcher()
    watcher = harness.watcher
    const { state } = harness
    await watcher.start()
    await drain(state)
    fixture.services.delete('runtime-witness')
    const entered = deferred(),
      release = deferred()
    fixture.readService = async () => {
      entered.resolve()
      await release.promise
    }
    const work = state.reconciler.reconcile(state.servers.get('runtime-witness'))
    await entered.promise
    expect(state.runtimeRepairPending).toBe(false)
    expect(state.reconciler.hasPendingReconciliation()).toBe(true)
    const decisions = vi.spyOn(hccLogger, 'info')
    await state.recoverMcpServerInventoryAndWatch()
    release.resolve()
    await work
    await drain(state)
    expect(fixture.services.get('runtime-witness')?.spec?.ports?.[0].port).toBe(3000)
    expect(state.reconciler.hasIncompleteReconciliation()).toBe(false)
    expect(decisions).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ decision: 'request', reason: 'work-pending' })
    )
  })

  it('A-T7 control: a readiness tick retired during LIST preserves repair after its poll entry disappears', async () => {
    fixture.rolloutReady = false
    const harness = prepareWatcher()
    watcher = harness.watcher
    const { state } = harness
    await watcher.start()
    await drain(state)
    expect(state.reconciler.readinessPolls.size).toBe(1)
    const entered = deferred(),
      release = deferred()
    vi.spyOn(state.watch, 'watch').mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return { abort() {} }
    })
    const recovery = state.recoverMcpServerInventoryAndWatch()
    await entered.promise
    await vi.advanceTimersByTimeAsync(5000)
    expect(state.reconciler.readinessPolls.size).toBe(0)
    expect(state.reconciler.hasIncompleteReconciliation()).toBe(true)
    release.resolve()
    await recovery
    await drain(state)
    const deployment = fixture.deployments.get('runtime-witness')!
    deployment.status!.readyReplicas = 1
    deployment.status!.availableReplicas = 1
    await vi.advanceTimersByTimeAsync(5000)
    expect(state.reconciler.getStatus('runtime-witness').ready).toBe(true)
    expect(state.reconciler.hasPendingReconciliation()).toBe(false)
  })
  it.each(['managed', 'wrc'] as const)(
    'A-T7 regression: transient input read preserves %s repair',
    async mode => {
      fixture.server.spec.envSecret = { name: 'synthetic-input', keys: [] }
      if (mode === 'wrc') fixture.server.spec.managed = false
      fixture.readInput = async () => {
        throw Object.assign(new Error('transient fixture API failure'), { code: 503 })
      }
      const harness = prepareWatcher()
      watcher = harness.watcher
      const { state } = harness
      await watcher.start()
      await drain(state)
      expect(fixture.services.size).toBe(0)
      expect(state.reconciler.hasIncompleteReconciliation()).toBe(true)
      expect(state.initialConvergenceRetryTimers.has('McpServer')).toBe(true)
      fixture.readInput = async () => ({
        metadata: { name: 'synthetic-input', resourceVersion: '1' },
        data: {},
      })
      const before = Date.now()
      await state.recoverMcpServerInventoryAndWatch()
      await drain(state)
      expect(Date.now()).toBe(before)
      expect(state.reconciler.hasIncompleteReconciliation()).toBe(false)
      expect(state.initialConvergenceRetryTimers.has('McpServer')).toBe(false)
      if (mode === 'managed')
        expect(fixture.services.get('runtime-witness')?.spec?.ports?.[0].port).toBe(3000)
      else expect(fixture.services.size).toBe(0)
      expect(state.reconciler.getStatus('runtime-witness').ready).toBe(true)
    }
  )

  it('A-T7 regression: failed negative eligibility publication remains pending until repaired', async () => {
    fixture.server.spec.envSecret = { name: 'synthetic-input', keys: [] }
    fixture.readInput = async () => ({
      metadata: { name: 'synthetic-input', resourceVersion: '1' },
      data: {},
    })
    const harness = prepareWatcher()
    watcher = harness.watcher
    const { state } = harness
    await watcher.start()
    await drain(state)
    await state.recoverMcpServerInventoryAndWatch()
    await drain(state)
    expect(fixture.services.size).toBe(1)
    expect(fixture.server.status.conditions).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'SecretResolved', status: 'True' })])
    )
    fixture.readInput = undefined
    fixture.failPublication = body =>
      body.some((patch: any) => {
        const conditions =
          patch.path === '/status'
            ? patch.value?.conditions
            : patch.path === '/status/conditions'
              ? patch.value
              : undefined
        return conditions?.some(
          (condition: any) => condition.type === 'SecretResolved' && condition.status === 'False'
        )
      })
    await state.reconciler.reconcile(state.servers.get('runtime-witness'))
    expect(fixture.services.size).toBe(0)
    expect(fixture.deployments.size).toBe(0)
    expect(fixture.server.status.conditions).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'SecretResolved', status: 'True' })])
    )
    expect(state.reconciler.hasIncompleteReconciliation()).toBe(true)
    fixture.failPublication = undefined
    const before = Date.now()
    await state.recoverMcpServerInventoryAndWatch()
    await drain(state)
    expect(Date.now()).toBe(before)
    expect(fixture.server.status.conditions).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'SecretResolved', status: 'False' })])
    )
    expect(state.reconciler.hasIncompleteReconciliation()).toBe(false)
  })

  it('A-T7 control: deleting a failed create cleans its Service-only remainder and discharges repair', async () => {
    fixture.failDeployment = true
    const harness = prepareWatcher()
    watcher = harness.watcher
    const { state } = harness
    await watcher.start()
    await drain(state)
    expect(fixture.services.size).toBe(1)
    expect(fixture.deployments.size).toBe(0)
    expect(state.reconciler.hasIncompleteReconciliation()).toBe(true)
    fixture.serverExists = false
    await state.recoverMcpServerInventoryAndWatch()
    await drain(state)
    expect(fixture.services.size).toBe(0)
    expect(fixture.deployments.size).toBe(0)
    expect(state.reconciler.hasPendingReconciliation()).toBe(false)
    expect(state.initialConvergenceRetryTimers.has('McpServer')).toBe(false)
  })
})
