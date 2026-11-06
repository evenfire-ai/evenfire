import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { V1Deployment, V1Service } from '@kubernetes/client-node'
import { fakeSecretApiserver } from './__tests__/fakeSecretApiserver'
import { config } from './config'
import { ManagedDeploymentInformer } from './informers/deploymentInformer'
import { SecretInformer } from './informers/secretInformer'
import { K8sRequestTimeoutError } from './k8s/k8sRequestDeadline'
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
  failDeploymentName: undefined as string | undefined,
  serverExists: true,
  readInput: undefined as undefined | ((request: { name: string }) => Promise<unknown>),
  statusPatches: 0,
  failPublication: undefined as undefined | ((body: any[]) => boolean),
  server: undefined as any,
  peers: [] as any[],
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
    k8sRequestTimeoutMs: 30_000,
    netPolPassHardLimitMs: 1_800_000,
    hostResyncIntervalSec: 0,
    // Below the 30 min NetworkPolicy pass hard limit: A-T7a holds a pass open
    // across one full tick, and a pass held past the limit ends the process.
    netPolResyncIntervalSec: 600,
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
    if (
      kind === 'Deployment' &&
      (fixture.failDeployment || fixture.failDeploymentName === body.metadata.name)
    )
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
    readNamespacedSecret: async (request: { name: string }) => {
      if (fixture.readInput) return fixture.readInput(request)
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
  const servers = () => [...(fixture.serverExists ? [fixture.server] : []), ...fixture.peers]
  const serverNamed = (name: string) => {
    const server = servers().find(candidate => candidate.metadata.name === name)
    if (!server) throw absent()
    return server
  }
  const custom = {
    listNamespacedCustomObject: async ({ plural }: any) => ({
      metadata: { resourceVersion: String(++fixture.revision) },
      items: plural === 'mcpservers' ? servers().map(server => structuredClone(server)) : [],
    }),
    getNamespacedCustomObject: async ({ name }: any) => structuredClone(serverNamed(name)),
    getNamespacedCustomObjectStatus: async ({ name }: any) => structuredClone(serverNamed(name)),
    patchNamespacedCustomObjectStatus: async ({ name, body }: any) => {
      fixture.statusPatches++
      if (fixture.failPublication?.(body))
        throw Object.assign(new Error('fixture status unavailable'), { code: 503 })
      const server = serverNamed(name)
      for (const patch of body) {
        if (patch.op === 'test') {
          const field = patch.path.slice('/metadata/'.length)
          if (server.metadata[field] !== patch.value)
            throw Object.assign(new Error('fixture status conflict'), { code: 409 })
        } else if (patch.path === '/status') server.status = structuredClone(patch.value)
        else if (patch.path === '/status/conditions')
          server.status.conditions = structuredClone(patch.value)
        else throw new Error(`Unexpected status patch ${patch.path}`)
      }
      server.metadata.resourceVersion = String(++fixture.revision)
      return structuredClone(server)
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

function recordReconciledNames(state: any): string[] {
  const names: string[] = []
  const reconcile = state.reconciler.reconcile.bind(state.reconciler)
  vi.spyOn(state.reconciler, 'reconcile').mockImplementation(async (server: any, options: any) => {
    names.push(server.name)
    return reconcile(server, options)
  })
  return names
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
    fixture.failDeploymentName = undefined
    fixture.serverExists = true
    fixture.peers = []
    fixture.readInput = undefined
    fixture.statusPatches = 0
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
    await vi.advanceTimersByTimeAsync(600_000)
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
    await vi.advanceTimersByTimeAsync(600_000)
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

  describe('a persistently failing server alongside a healthy peer', () => {
    beforeEach(() => {
      const peer = structuredClone(fixture.server)
      peer.metadata = { ...peer.metadata, name: 'runtime-peer', uid: 'runtime-peer-uid' }
      fixture.peers = [peer]
      fixture.failDeploymentName = 'runtime-witness'
    })

    async function startWithScopedRetryArmed() {
      const harness = prepareWatcher()
      watcher = harness.watcher
      const { state } = harness
      await watcher.start()
      await drain(state)
      expect(fixture.deployments.has('runtime-peer')).toBe(true)
      expect(fixture.deployments.has('runtime-witness')).toBe(false)
      expect(state.reconciler.incompleteReconciliationNames()).toEqual(['runtime-witness'])
      expect(state.runtimeRepairPending).toBe(true)
      expect(state.initialConvergenceRetryTimers.has('McpServer')).toBe(true)
      return state
    }

    it('A-T7 regression: retries only the failing server, then certifies and skips identical recovery', async () => {
      const state = await startWithScopedRetryArmed()
      const reconciled = recordReconciledNames(state)
      await vi.advanceTimersByTimeAsync(5000)
      await drain(state)
      expect(reconciled).toEqual(['runtime-witness'])
      expect(state.runtimeRepairPending).toBe(true)
      expect(state.initialConvergenceRetryTimers.has('McpServer')).toBe(true)

      fixture.failDeploymentName = undefined
      await vi.advanceTimersByTimeAsync(15000)
      await drain(state)
      expect(reconciled).toEqual(['runtime-witness', 'runtime-witness'])
      expect(fixture.deployments.has('runtime-witness')).toBe(true)
      expect(state.reconciler.hasIncompleteReconciliation()).toBe(false)
      expect(state.runtimeRepairPending).toBe(false)
      expect(state.initialConvergenceRetryTimers.has('McpServer')).toBe(false)

      // Fold the status writes back through a real LIST once, then an
      // identical recovery must skip again.
      await state.recoverMcpServerInventoryAndWatch()
      await drain(state)
      const decisions = vi.spyOn(hccLogger, 'info')
      await state.recoverMcpServerInventoryAndWatch()
      await drain(state)
      expect(decisions).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ decision: 'skip', reason: 'identical-complete' })
      )
    })

    it('A-T7 control: a scoped retry widens to the fleet once inventory has moved', async () => {
      const state = await startWithScopedRetryArmed()
      state.mcpServerRetryRequest = {
        ...state.mcpServerRetryRequest,
        serverRevision: state.mcpServerRetryRequest.serverRevision - 1,
      }
      const reconciled = recordReconciledNames(state)
      await vi.advanceTimersByTimeAsync(5000)
      await drain(state)
      expect([...reconciled].sort()).toEqual(['runtime-peer', 'runtime-witness'])
    })

    it('A-T7 control: a full retry request widens an armed scoped retry', async () => {
      const state = await startWithScopedRetryArmed()
      state.scheduleInitialConvergenceRetry('McpServer')
      expect(state.mcpServerRetryRequest).toBe('full')
      const reconciled = recordReconciledNames(state)
      await vi.advanceTimersByTimeAsync(5000)
      await drain(state)
      expect([...reconciled].sort()).toEqual(['runtime-peer', 'runtime-witness'])
    })
  })

  describe('#1338 H3 D2: an out-of-pass obligation gets the McpServer lane retry', () => {
    const witness = 'runtime-witness'
    const peer = 'runtime-peer'
    let secretReads: Map<string, number>
    let failures: Map<string, Array<() => unknown>>
    let alwaysFail: Set<string>
    let deploymentInformers: ManagedDeploymentInformer[]

    const reads = (input: string) => secretReads.get(input) ?? 0
    const timeout = () => new K8sRequestTimeoutError('readNamespacedSecret', 30_000)
    const absentInput = () => Object.assign(new Error('fixture input absent'), { code: 404 })
    const failNext = (input: string, ...next: Array<() => unknown>) => {
      failures.set(input, [...(failures.get(input) ?? []), ...next])
    }

    beforeEach(() => {
      secretReads = new Map()
      failures = new Map()
      alwaysFail = new Set()
      deploymentInformers = []
      fixture.server.spec.envSecret = { name: 'witness-input', keys: [] }
      fixture.readInput = async request => {
        secretReads.set(request.name, reads(request.name) + 1)
        if (alwaysFail.has(request.name)) throw timeout()
        const failure = failures.get(request.name)?.shift()
        if (failure) throw failure()
        return { metadata: { name: request.name, resourceVersion: '1' }, data: {} }
      }
    })

    afterEach(() => {
      for (const informer of deploymentInformers) informer.stop()
      config.netPolResyncIntervalSec = 600
    })

    async function retryCount(): Promise<number> {
      const metric = registry.getSingleMetric('clerum_hcc_initial_convergence_retries_total')
      if (!metric) throw new Error('clerum_hcc_initial_convergence_retries_total is not registered')
      const snapshot = await metric.get()
      return snapshot.values.find(value => value.labels.lane === 'McpServer')?.value ?? 0
    }

    /** A started watcher whose NetworkPolicy and McpServer lanes are certified at the current revision. */
    async function startCertified(options: { withPeer?: boolean } = {}) {
      if (options.withPeer) {
        const sibling = structuredClone(fixture.server)
        sibling.metadata = { ...sibling.metadata, name: peer, uid: `${peer}-uid` }
        sibling.spec.envSecret = { name: 'peer-input', keys: [] }
        fixture.peers = [sibling]
      }
      const harness = prepareWatcher()
      watcher = harness.watcher
      const { state } = harness
      await watcher.start()
      await drain(state)
      // Fold the conditions the first reconcile wrote back through a real LIST,
      // so the cache carries exactly what a successful reconcile publishes.
      await state.recoverMcpServerInventoryAndWatch()
      await drain(state)
      expect(state.runtimeRepairPending).toBe(false)
      expect(state.matchesCurrentInventory(state.completedRuntimeRevision)).toBe(true)
      expect(state.initialConvergenceRetryTimers.has('McpServer')).toBe(false)
      expect(state.reconciler.getStatus(state.servers.get(witness))).toMatchObject({
        ready: true,
        authoritative: true,
      })
      return state
    }

    it('I1 an informer ADDED read timeout keeps ready, and the scoped retry discharges the obligation', async () => {
      const state = await startCertified()
      const info = vi.spyOn(hccLogger, 'info')
      const patchesBefore = fixture.statusPatches
      const readsBefore = reads('witness-input')
      failNext('witness-input', timeout)

      await watcher!.reconcileByEnvSecret('witness-input', 'mcp-server', 'ADDED')

      expect(reads('witness-input')).toBe(readsBefore + 1)
      expect(state.reconciler.getStatus(state.servers.get(witness)).ready).toBe(true)
      expect(state.reconciler.hasIncompleteReconciliation()).toBe(true)
      expect(state.initialConvergenceRetryTimers.has('McpServer')).toBe(true)
      await vi.advanceTimersByTimeAsync(5000)
      await drain(state)
      expect(reads('witness-input')).toBe(readsBefore + 2)
      expect(info).toHaveBeenCalledWith(
        '[K8s] Running scoped McpServer background reconciliation retry...',
        { servers: [witness] }
      )
      expect(state.reconciler.hasIncompleteReconciliation()).toBe(false)
      expect(state.reconciler.getStatus(state.servers.get(witness)).ready).toBe(true)
      expect(fixture.statusPatches).toBe(patchesBefore)
      expect(state.initialConvergenceRetryTimers.has('McpServer')).toBe(false)
    })

    it('I2 an informer MODIFIED read timeout publishes not-ready, and the retry restores ready', async () => {
      const state = await startCertified()
      const patchesBefore = fixture.statusPatches
      const readsBefore = reads('witness-input')
      failNext('witness-input', timeout)

      await watcher!.reconcileByEnvSecret('witness-input', 'mcp-server', 'MODIFIED')

      expect(reads('witness-input')).toBe(readsBefore + 1)
      expect(state.reconciler.getStatus(state.servers.get(witness)).ready).toBe(false)
      expect(fixture.statusPatches).toBeGreaterThan(patchesBefore)
      expect(fixture.server.status.conditions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'SecretResolved', status: 'False', reason: 'ReadError' }),
        ])
      )
      await vi.advanceTimersByTimeAsync(5000)
      await drain(state)
      expect(reads('witness-input')).toBe(readsBefore + 2)
      expect(state.reconciler.getStatus(state.servers.get(witness)).ready).toBe(true)
      expect(state.reconciler.hasIncompleteReconciliation()).toBe(false)
    })

    // A watch event that changes the desired revision (spec, labels or
    // annotations) also starts a NetworkPolicy pass whose authoritative
    // revocation requests a full McpServer convergence, and that run owns the
    // obligation. The watch event the fleet lane never covers is a replayed
    // ADDED of an unchanged object: it reconciles without moving the revision.
    it('I3 a replayed watch ADDED that moves no revision gets the retry from its own reconcile', async () => {
      const state = await startCertified()
      const revisionBefore = state.mcpServerDesiredRevision
      const readsBefore = reads('witness-input')
      failNext('witness-input', timeout)

      await state.getMcpServerWatchCallback()('ADDED', structuredClone(fixture.server))
      await drain(state)

      expect(state.mcpServerDesiredRevision).toBe(revisionBefore)
      expect(reads('witness-input')).toBe(readsBefore + 1)
      expect(state.reconciler.getStatus(state.servers.get(witness)).ready).toBe(true)
      expect(state.reconciler.hasIncompleteReconciliation()).toBe(true)
      await vi.advanceTimersByTimeAsync(5000)
      await drain(state)
      expect(reads('witness-input')).toBe(readsBefore + 2)
      expect(state.reconciler.hasIncompleteReconciliation()).toBe(false)
    })

    it('I4 a persistent read failure retries only at the lane rungs and keeps ready without status writes', async () => {
      const state = await startCertified()
      const patchesBefore = fixture.statusPatches
      const retriesBefore = await retryCount()
      const readsBefore = reads('witness-input')
      alwaysFail.add('witness-input')

      await watcher!.reconcileByEnvSecret('witness-input', 'mcp-server', 'ADDED')
      expect(reads('witness-input')).toBe(readsBefore + 1)

      // Cumulative rungs of INITIAL_CONVERGENCE_RETRY_DELAYS_MS: 5, 20, 50, 110, 410 s.
      const rungs = [5_000, 15_000, 30_000, 60_000, 300_000]
      for (const [index, delay] of rungs.entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1)
        await drain(state)
        expect(reads('witness-input')).toBe(readsBefore + 1 + index)
        await vi.advanceTimersByTimeAsync(1)
        await drain(state)
        expect(reads('witness-input')).toBe(readsBefore + 2 + index)
        expect(state.reconciler.getStatus(state.servers.get(witness)).ready).toBe(true)
      }
      expect(fixture.statusPatches).toBe(patchesBefore)
      expect(await retryCount()).toBe(retriesBefore + rungs.length + 1)
      expect(state.reconciler.hasIncompleteReconciliation()).toBe(true)
    })

    it('I5 a retry that fires without a safety certificate waits for the next certified full convergence', async () => {
      const state = await startCertified({ withPeer: true })
      const warn = vi.spyOn(console, 'warn')
      const core = vi.spyOn(state, 'runInitialMcpServerConvergenceCore')
      const witnessBefore = reads('witness-input')
      const peerBefore = reads('peer-input')
      failNext('witness-input', timeout)

      await watcher!.reconcileByEnvSecret('witness-input', 'mcp-server', 'ADDED')
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Scheduling initial McpServer background convergence retry 1')
      )
      state.netPolReconciler.hasCertifiedSafetyInventory.mockReturnValue(false)
      await vi.advanceTimersByTimeAsync(5000)
      await drain(state)

      expect(core).toHaveBeenCalledTimes(1)
      expect(reads('witness-input')).toBe(witnessBefore + 1)
      expect(reads('peer-input')).toBe(peerBefore)
      expect(state.initialConvergenceRetryTimers.has('McpServer')).toBe(false)
      expect(state.runtimeRepairPending).toBe(true)
      expect(state.reconciler.hasIncompleteReconciliation()).toBe(true)

      state.netPolReconciler.hasCertifiedSafetyInventory.mockReturnValue(true)
      await state.runInitialNetworkPolicyConvergence({ cause: 'retry' })
      await drain(state)

      expect(reads('witness-input')).toBe(witnessBefore + 2)
      expect(reads('peer-input')).toBe(peerBefore + 1)
      expect(state.reconciler.hasIncompleteReconciliation()).toBe(false)
      expect(state.runtimeRepairPending).toBe(false)
    })

    it('I6 a retry requested while the lane certificate lags the inventory runs the whole fleet', async () => {
      const state = await startCertified({ withPeer: true })
      state.completedRuntimeRevision = {
        ...state.completedRuntimeRevision,
        serverRevision: state.completedRuntimeRevision.serverRevision - 1,
      }
      const witnessBefore = reads('witness-input')
      const peerBefore = reads('peer-input')
      failNext('witness-input', timeout)

      await watcher!.reconcileByEnvSecret('witness-input', 'mcp-server', 'ADDED')

      expect(reads('witness-input')).toBe(witnessBefore + 1)
      expect(state.mcpServerRetryRequest).toBe('full')
      expect(state.matchesCurrentInventory(state.completedRuntimeRevision)).toBe(false)
      await vi.advanceTimersByTimeAsync(5000)
      await drain(state)
      expect(reads('witness-input')).toBe(witnessBefore + 2)
      expect(reads('peer-input')).toBe(peerBefore + 1)
      expect(state.matchesCurrentInventory(state.completedRuntimeRevision)).toBe(true)
      expect(state.runtimeRepairPending).toBe(false)
    })

    it('I7 a kept verdict fails closed at the first retry that reads 404', async () => {
      const state = await startCertified()
      const readsBefore = reads('witness-input')
      failNext('witness-input', timeout, absentInput)

      await watcher!.reconcileByEnvSecret('witness-input', 'mcp-server', 'ADDED')
      expect(state.reconciler.getStatus(state.servers.get(witness)).ready).toBe(true)
      expect(fixture.deployments.has(witness)).toBe(true)
      await vi.advanceTimersByTimeAsync(5000)
      await drain(state)

      expect(reads('witness-input')).toBe(readsBefore + 2)
      expect(fixture.deployments.has(witness)).toBe(false)
      expect(state.reconciler.getStatus(witness).ready).toBe(false)
      expect(fixture.server.status.conditions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'Ready',
            status: 'False',
            reason: 'SecretValidationFailed',
          }),
        ])
      )
    })

    const forbidden = () => Object.assign(new Error('fixture access denied'), { code: 403 })
    const recoveryDecision = (reason: string, decision: string) =>
      expect.objectContaining({ event: 'networkpolicy-recovery-decision', decision, reason })

    it('I8 a Secret change while the inventory is not authoritative is routed at recovery, and its read error publishes', async () => {
      const state = await startCertified()
      const warn = vi.spyOn(hccLogger, 'warn')
      const info = vi.spyOn(hccLogger, 'info')
      const readsBefore = reads('witness-input')
      state.retireMcpServerWatch()

      await watcher!.reconcileByEnvSecret('witness-input', 'mcp-server', 'MODIFIED')

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Secret change deferred until the McpServer inventory is authoritative'
        ),
        expect.objectContaining({ event: 'secret-change-deferred' })
      )
      expect(reads('witness-input')).toBe(readsBefore)
      failNext('witness-input', timeout)

      await state.recoverMcpServerInventoryAndWatch()
      await drain(state)

      expect(info).toHaveBeenCalledWith(
        expect.any(String),
        recoveryDecision('work-pending', 'request')
      )
      expect(reads('witness-input')).toBe(readsBefore + 1)
      expect(state.reconciler.getStatus(state.servers.get(witness))).toMatchObject({
        ready: false,
        authoritative: true,
      })
      expect(fixture.server.status.conditions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'SecretResolved', status: 'False', reason: 'ReadError' }),
        ])
      )
    })

    it('I9 a Secret change whose reconcile is dropped because authority moved is still converged at recovery', async () => {
      const state = await startCertified()
      const warn = vi.spyOn(hccLogger, 'warn')
      const info = vi.spyOn(hccLogger, 'info')
      const readsBefore = reads('witness-input')
      const started = deferred()
      const release = deferred()
      const blocker = state.enqueueMcpServerReconciliation(
        { name: witness, namespace: 'mcp-server' },
        async () => {
          started.resolve()
          await release.promise
        }
      )
      await started.promise

      const event = watcher!.reconcileByEnvSecret('witness-input', 'mcp-server', 'MODIFIED')
      state.retireMcpServerWatch()
      release.resolve()
      await Promise.all([blocker, event])

      expect(warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ event: 'secret-reconcile-dropped', serverName: witness })
      )
      expect(reads('witness-input')).toBe(readsBefore)
      failNext('witness-input', timeout)

      await state.recoverMcpServerInventoryAndWatch()
      await drain(state)

      expect(info).toHaveBeenCalledWith(
        expect.any(String),
        recoveryDecision('work-pending', 'request')
      )
      expect(reads('witness-input')).toBe(readsBefore + 1)
      expect(state.reconciler.getStatus(state.servers.get(witness)).ready).toBe(false)
    })

    async function informerEvents(type: string): Promise<number> {
      const metric = registry.getSingleMetric('clerum_hcc_secret_informer_events_total')
      if (!metric) throw new Error('clerum_hcc_secret_informer_events_total is not registered')
      const snapshot = await metric.get()
      return (
        snapshot.values.find(
          value => value.labels.namespace === 'mcp-server' && value.labels.type === type
        )?.value ?? 0
      )
    }

    async function informerCounter(name: string, labels: Record<string, string>) {
      const metric = registry.getSingleMetric(name)
      if (!metric) throw new Error(`${name} is not registered`)
      const snapshot = await metric.get()
      return (
        snapshot.values.find(value =>
          Object.entries(labels).every(([label, expected]) => value.labels[label] === expected)
        )?.value ?? 0
      )
    }

    /** The mcp-server informer, in resume mode, wired to the watcher as main.ts wires it. */
    async function startInformer(state: any, names: string[]) {
      const api = fakeSecretApiserver('mcp-server', names)
      const informer = new SecretInformer(
        {} as any,
        'mcp-server',
        watcher!.handleSecretEvent,
        { mode: 'resume', list: api.list },
        { watch: { watch: api.watch } }
      )
      await expect(informer.start()).resolves.toBe(true)
      await drain(state)
      return { api, informer }
    }

    it('I10a an informer MODIFIED reaches the watcher as MODIFIED: evidence is recorded and a read timeout publishes', async () => {
      const state = await startCertified()
      const { api, informer } = await startInformer(state, ['witness-input'])
      try {
        const readsBefore = reads('witness-input')
        const modifiedBefore = await informerEvents('MODIFIED')
        failNext('witness-input', timeout)

        api.modify('witness-input')
        await drain(state)

        expect(await informerEvents('MODIFIED')).toBe(modifiedBefore + 1)
        expect(reads('witness-input')).toBe(readsBefore + 1)
        expect(state.reconciler.hasSecretChangeEvidence()).toBe(true)
        expect(state.reconciler.getStatus(state.servers.get(witness)).ready).toBe(false)
      } finally {
        informer.stop()
      }
    })

    it('I10b an informer ADDED for a first-seen Secret reaches the watcher as ADDED: a read timeout keeps ready', async () => {
      const state = await startCertified()
      const { api, informer } = await startInformer(state, ['unrelated-input'])
      try {
        const readsBefore = reads('witness-input')
        const addedBefore = await informerEvents('ADDED')
        failNext('witness-input', timeout)

        api.create('witness-input')
        await drain(state)

        expect(await informerEvents('ADDED')).toBe(addedBefore + 1)
        expect(reads('witness-input')).toBe(readsBefore + 1)
        expect(state.reconciler.hasSecretChangeEvidence()).toBe(false)
        expect(state.reconciler.getStatus(state.servers.get(witness)).ready).toBe(true)
      } finally {
        informer.stop()
      }
    })

    /** Three env-Secret McpServers, ready and certified, with the informer started. */
    async function startQuietFleet() {
      const peers = ['peer-one', 'peer-two'].map(name => {
        const sibling = structuredClone(fixture.server)
        sibling.metadata = { ...sibling.metadata, name, uid: `${name}-uid` }
        sibling.spec.envSecret = { name: `${name}-input`, keys: [] }
        return sibling
      })
      fixture.peers = peers
      const state = await startCertified()
      const started = await startInformer(state, [
        'witness-input',
        'peer-one-input',
        'peer-two-input',
      ])
      const allReads = () => [...secretReads.values()].reduce((sum, value) => sum + value, 0)
      return { state, ...started, allReads }
    }

    it.each([
      ['resumes', false],
      ['relists after a 410', true],
    ] as const)(
      'I11 a quiet informer reconnect that %s costs no reconcile, no Secret read and no status write',
      async (_label, expire) => {
        const { state, api, informer, allReads } = await startQuietFleet()
        try {
          const byEnvSecret = vi.spyOn(watcher!, 'reconcileByEnvSecret')
          const readsBefore = allReads()
          const patchesBefore = fixture.statusPatches
          const resumesBefore = await informerCounter('clerum_hcc_secret_informer_resumes_total', {
            namespace: 'mcp-server',
          })
          const relistsBefore = await informerCounter('clerum_hcc_secret_informer_lists_total', {
            namespace: 'mcp-server',
            outcome: 'relist',
          })

          for (let reconnect = 0; reconnect < 3; reconnect++) {
            api.disconnect()
            if (expire && reconnect === 0) {
              api.expireNextResume()
              await vi.advanceTimersByTimeAsync(1000)
            }
            await vi.advanceTimersByTimeAsync(1000)
            await drain(state)
          }

          expect(byEnvSecret).not.toHaveBeenCalled()
          expect(allReads()).toBe(readsBefore)
          expect(fixture.statusPatches).toBe(patchesBefore)
          const watches = api.watchCalls.slice(1)
          expect(watches.length).toBeGreaterThanOrEqual(3)
          for (const call of watches) expect(call.queryParams.resourceVersion).toBeDefined()
          if (expire) {
            expect(api.list).toHaveBeenCalledTimes(2)
            expect(
              await informerCounter('clerum_hcc_secret_informer_lists_total', {
                namespace: 'mcp-server',
                outcome: 'relist',
              })
            ).toBe(relistsBefore + 1)
          } else {
            expect(api.watchFn).toHaveBeenCalledTimes(4)
            expect(
              await informerCounter('clerum_hcc_secret_informer_resumes_total', {
                namespace: 'mcp-server',
              })
            ).toBe(resumesBefore + 3)
          }
        } finally {
          informer.stop()
        }
      }
    )

    it('I12 a Secret modified while the informer was down becomes evidence, so a read timeout publishes', async () => {
      const state = await startCertified()
      const { api, informer } = await startInformer(state, ['witness-input'])
      try {
        const readsBefore = reads('witness-input')
        api.disconnect()
        api.expireNextResume()
        api.modify('witness-input')
        failNext('witness-input', timeout)

        await vi.advanceTimersByTimeAsync(2000)
        await drain(state)

        expect(api.list).toHaveBeenCalledTimes(2)
        expect(reads('witness-input')).toBe(readsBefore + 1)
        expect(state.reconciler.hasSecretChangeEvidence()).toBe(true)
        expect(state.reconciler.getStatus(state.servers.get(witness)).ready).toBe(false)
      } finally {
        informer.stop()
      }
    })

    it('I13 a Secret deleted while the informer was down is reconciled and fails the server closed', async () => {
      const state = await startCertified()
      const { api, informer } = await startInformer(state, ['witness-input'])
      try {
        const readsBefore = reads('witness-input')
        expect(fixture.deployments.has(witness)).toBe(true)
        api.disconnect()
        api.expireNextResume()
        api.remove('witness-input')
        failNext('witness-input', absentInput)

        await vi.advanceTimersByTimeAsync(2000)
        await drain(state)

        expect(reads('witness-input')).toBe(readsBefore + 1)
        expect(fixture.deployments.has(witness)).toBe(false)
        expect(fixture.server.status.conditions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'SecretResolved',
              status: 'False',
              reason: 'SecretNotFound',
            }),
          ])
        )
      } finally {
        informer.stop()
      }
    })

    it('I14 a denied Secret read fails closed and D2 restores the server once access returns (#1338 H1)', async () => {
      const state = await startCertified()
      const retriesBefore = await retryCount()
      const readsBefore = reads('witness-input')
      failNext('witness-input', forbidden)

      await state.reconciler.reconcile(state.servers.get(witness))

      expect(reads('witness-input')).toBe(readsBefore + 1)
      expect(fixture.deployments.has(witness)).toBe(false)
      expect(state.reconciler.getStatus(witness).ready).toBe(false)
      expect(state.reconciler.hasIncompleteReconciliation()).toBe(true)

      await vi.advanceTimersByTimeAsync(5000)
      await drain(state)

      expect(await retryCount()).toBe(retriesBefore + 1)
      expect(reads('witness-input')).toBe(readsBefore + 2)
      expect(fixture.deployments.has(witness)).toBe(true)
      expect(state.reconciler.getStatus(witness).ready).toBe(true)
      expect(state.reconciler.hasIncompleteReconciliation()).toBe(false)
    })

    it('I15 evidence for a server that left the inventory no longer requests recovery passes (#1338 M1)', async () => {
      fixture.server.spec.managed = false
      const state = await startCertified()
      state.reconciler.recordSecretChangeEvidence(witness)
      fixture.serverExists = false
      await state.recoverMcpServerInventoryAndWatch()
      await drain(state)
      const info = vi.spyOn(hccLogger, 'info')

      await state.recoverMcpServerInventoryAndWatch()
      await drain(state)

      expect(state.servers.has(witness)).toBe(false)
      expect(info).toHaveBeenCalledWith(
        expect.any(String),
        recoveryDecision('identical-complete', 'skip')
      )
      expect(state.reconciler.hasSecretChangeEvidence()).toBe(false)
    })

    /** A real Deployment informer over the fixture, wired as main.ts wires it. */
    async function attachDeploymentInformer() {
      let onEvent: ((type: string, object: unknown) => void) | undefined
      const informer = new ManagedDeploymentInformer(
        {} as any,
        'mcp-server',
        watcher!.handleDeploymentObservation,
        async () => ({
          items: [...fixture.deployments.values()].map(value => structuredClone(value)),
          metadata: { resourceVersion: String(fixture.revision) },
        }),
        {
          watch: {
            watch: async (_path, _query, callback) => {
              onEvent = callback
              return { abort() {} } as unknown as AbortController
            },
          },
        }
      )
      deploymentInformers.push(informer)
      await expect(informer.start()).resolves.toBe(true)
      return (type: string, name: string) => {
        const deployment = structuredClone(fixture.deployments.get(name))
        if (!deployment) throw new Error(`fixture has no Deployment ${name}`)
        deployment.metadata = {
          ...deployment.metadata,
          resourceVersion: String(++fixture.revision),
        }
        onEvent!(type, deployment)
      }
    }

    function markRolloutReady(name: string) {
      const deployment = fixture.deployments.get(name)!
      deployment.status!.readyReplicas = 1
      deployment.status!.availableReplicas = 1
    }

    /** The witness is stuck with a terminal verdict, the peer is ready, the revision is certified. */
    async function startStuckCertified(options: { withPeer?: boolean } = {}) {
      fixture.rolloutReady = false
      if (options.withPeer) {
        const sibling = structuredClone(fixture.server)
        sibling.metadata = { ...sibling.metadata, name: peer, uid: `${peer}-uid` }
        sibling.spec.envSecret = { name: 'peer-input', keys: [] }
        fixture.peers = [sibling]
      }
      const harness = prepareWatcher()
      watcher = harness.watcher
      const { state } = harness
      await watcher.start()
      await drain(state)
      const emit = await attachDeploymentInformer()
      if (options.withPeer) markRolloutReady(peer)
      await vi.advanceTimersByTimeAsync(24 * 5000)
      await drain(state)
      await state.recoverMcpServerInventoryAndWatch()
      await drain(state)
      expect(fixture.server.status.conditions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'DeploymentReady', reason: 'RolloutIncomplete' }),
        ])
      )
      expect(state.reconciler.namesAwaitingExternalChange('RolloutIncomplete')).toEqual([witness])
      expect(state.reconciler.hasIncompleteReconciliation()).toBe(false)
      expect(state.matchesCurrentInventory(state.completedRuntimeRevision)).toBe(true)
      expect(state.initialConvergenceRetryTimers.has('McpServer')).toBe(false)
      return { state, emit }
    }

    function holdQueue(state: any) {
      const started = deferred()
      const release = deferred()
      const blocker = state.enqueueMcpServerReconciliation(
        { name: witness, namespace: 'mcp-server' },
        async () => {
          started.resolve()
          await release.promise
        }
      )
      return { blocker, started, release }
    }

    it('I16 a rollout that converges after its readiness poll gave up is restored by its Deployment event', async () => {
      fixture.rolloutReady = false
      const harness = prepareWatcher()
      watcher = harness.watcher
      const { state } = harness
      await watcher.start()
      await drain(state)
      const emit = await attachDeploymentInformer()
      expect(state.reconciler.readinessPolls.size).toBe(1)
      const retriesBefore = await retryCount()

      await vi.advanceTimersByTimeAsync(24 * 5000)
      await drain(state)

      expect(fixture.server.status.conditions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'DeploymentReady',
            status: 'False',
            reason: 'RolloutIncomplete',
          }),
        ])
      )
      expect(state.reconciler.hasIncompleteReconciliation()).toBe(false)
      expect(state.reconciler.namesAwaitingExternalChange('RolloutIncomplete')).toEqual([witness])
      expect(await retryCount()).toBe(retriesBefore)
      const reconciled = recordReconciledNames(state)
      const filter = vi.spyOn(state.reconciler, 'rolloutObservationRequiresReconcile')
      markRolloutReady(witness)

      // Nothing polls: without an event the converged rollout stays unobserved.
      await vi.advanceTimersByTimeAsync(30_000)
      await drain(state)
      expect(reconciled).toEqual([])

      const clockAtEvent = Date.now()
      emit('MODIFIED', witness)
      await drain(state)

      expect(filter).toHaveReturnedWith(true)
      expect(Date.now()).toBe(clockAtEvent)
      expect(reconciled).toEqual([witness])
      expect(state.reconciler.getStatus(witness).ready).toBe(true)
      expect(fixture.server.status.conditions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'DeploymentReady', status: 'True' }),
        ])
      )
      expect(state.reconciler.namesAwaitingExternalChange('RolloutIncomplete')).toEqual([])
      expect(await retryCount()).toBe(retriesBefore)
    })

    it('I19 a stuck server holds neither the fleet nor certification, and only its moving event costs a reconcile', async () => {
      config.netPolResyncIntervalSec = 0
      const { state, emit } = await startStuckCertified({ withPeer: true })
      const retriesBefore = await retryCount()
      const reconciled = recordReconciledNames(state)
      const filter = vi.spyOn(state.reconciler, 'rolloutObservationRequiresReconcile')

      await vi.advanceTimersByTimeAsync(900_000)
      await drain(state)
      emit('MODIFIED', witness)
      await drain(state)
      expect(filter).toHaveLastReturnedWith(false)
      expect(reconciled).toEqual([])

      await vi.advanceTimersByTimeAsync(900_000)
      await drain(state)
      expect(reconciled).toEqual([])
      expect(await retryCount()).toBe(retriesBefore)
      expect(state.initialConvergenceRetryTimers.has('McpServer')).toBe(false)

      markRolloutReady(witness)
      emit('MODIFIED', witness)
      await drain(state)

      expect(filter).toHaveLastReturnedWith(true)
      expect(reconciled).toEqual([witness])
      expect(state.reconciler.getStatus(witness).ready).toBe(true)
    })

    it('I20 a stuck server does not pin the lane: a peer failure after 15 min retries at the first rung', async () => {
      const { state } = await startStuckCertified({ withPeer: true })
      await vi.advanceTimersByTimeAsync(900_000)
      await drain(state)
      const before = reads('peer-input')
      failNext('peer-input', timeout)

      await watcher!.reconcileByEnvSecret('peer-input', 'mcp-server', 'ADDED')
      expect(reads('peer-input')).toBe(before + 1)

      await vi.advanceTimersByTimeAsync(4999)
      expect(reads('peer-input')).toBe(before + 1)
      await vi.advanceTimersByTimeAsync(1)
      await drain(state)
      expect(reads('peer-input')).toBe(before + 2)
    })

    it('I21 a stuck server does not force a recovery pass, while a live readiness window still does', async () => {
      fixture.rolloutReady = false
      const harness = prepareWatcher()
      watcher = harness.watcher
      const { state } = harness
      await watcher.start()
      await drain(state)
      await state.recoverMcpServerInventoryAndWatch()
      await drain(state)
      const info = vi.spyOn(hccLogger, 'info')

      await state.recoverMcpServerInventoryAndWatch()
      await drain(state)
      expect(info).toHaveBeenCalledWith(
        expect.any(String),
        recoveryDecision('work-pending', 'request')
      )

      await vi.advanceTimersByTimeAsync(24 * 5000)
      await drain(state)
      await state.recoverMcpServerInventoryAndWatch()
      await drain(state)
      info.mockClear()

      await state.recoverMcpServerInventoryAndWatch()
      await drain(state)

      expect(state.reconciler.namesAwaitingExternalChange('RolloutIncomplete')).toEqual([witness])
      expect(info).toHaveBeenCalledWith(
        expect.any(String),
        recoveryDecision('identical-complete', 'skip')
      )
    })

    it('I22a a timeout on the wake keeps the verdict and leaves a scoped retry for that name', async () => {
      const { state, emit } = await startStuckCertified({ withPeer: true })
      const retriesBefore = await retryCount()
      const patchesBefore = fixture.statusPatches
      const readsBefore = reads('witness-input')
      failNext('witness-input', timeout)
      markRolloutReady(witness)

      emit('MODIFIED', witness)
      await drain(state)

      expect(reads('witness-input')).toBe(readsBefore + 1)
      expect(fixture.statusPatches).toBe(patchesBefore)
      expect(state.reconciler.getStatus(witness).ready).toBe(false)
      expect(state.mcpServerRetryRequest.names).toEqual(new Set([witness]))
      expect(await retryCount()).toBe(retriesBefore + 1)

      await vi.advanceTimersByTimeAsync(5000)
      await drain(state)

      expect(state.reconciler.getStatus(witness).ready).toBe(true)
      expect(state.reconciler.hasIncompleteReconciliation()).toBe(false)
    })

    it('I25 an event inside a non-authoritative window is replayed after the recovery decision', async () => {
      const { state, emit } = await startStuckCertified()
      const reconciled = recordReconciledNames(state)
      const filter = vi.spyOn(state.reconciler, 'rolloutObservationRequiresReconcile')
      const info = vi.spyOn(hccLogger, 'info')
      state.retireMcpServerWatch()
      markRolloutReady(witness)

      emit('MODIFIED', witness)
      await drain(state)

      expect(filter).toHaveReturnedWith(true)
      expect(reconciled).toEqual([])

      await state.recoverMcpServerInventoryAndWatch()
      await drain(state)

      expect(info).toHaveBeenCalledWith(
        expect.any(String),
        recoveryDecision('identical-complete', 'skip')
      )
      expect(reconciled).toEqual([witness])
      expect(state.reconciler.getStatus(witness).ready).toBe(true)
    })

    it('I25b a queued wake dropped because authority moved is replayed at recovery', async () => {
      const { state, emit } = await startStuckCertified()
      const reconciled = recordReconciledNames(state)
      const { blocker, started, release } = holdQueue(state)
      await started.promise
      markRolloutReady(witness)

      emit('MODIFIED', witness)
      state.retireMcpServerWatch()
      release.resolve()
      await blocker
      await drain(state)

      expect(reconciled).toEqual([])
      expect(state.reconciler.namesAwaitingExternalChange('RolloutIncomplete')).toEqual([witness])

      await state.recoverMcpServerInventoryAndWatch()
      await drain(state)

      expect(reconciled).toEqual([witness])
      expect(state.reconciler.getStatus(witness).ready).toBe(true)
    })

    it('I25c a queued wake that finds a new generation re-dispatches instead of waiting for another recovery', async () => {
      const { state, emit } = await startStuckCertified()
      const reconciled = recordReconciledNames(state)
      const { blocker, started, release } = holdQueue(state)
      await started.promise
      markRolloutReady(witness)

      emit('MODIFIED', witness)
      state.retireMcpServerWatch()
      await state.recoverMcpServerInventoryAndWatch()
      expect(reconciled).toEqual([])
      const clockAtRelease = Date.now()
      const recovery = vi.spyOn(state, 'recoverMcpServerInventoryAndWatch')

      release.resolve()
      await blocker
      await drain(state)

      expect(recovery).not.toHaveBeenCalled()
      expect(Date.now()).toBe(clockAtRelease)
      expect(reconciled).toEqual([witness])
      expect(state.reconciler.getStatus(witness).ready).toBe(true)
    })

    it('I26 a wake queued behind a held key does not apply a newer spec ahead of its egress work', async () => {
      const { state, emit } = await startStuckCertified()
      const reconciled = recordReconciledNames(state)
      // No revocation completes here, so no fleet pass joins the order under test.
      state.netPolReconciler.fullReconcile.mockImplementation(async () => {})
      const order: string[] = []
      state.netPolReconciler.reconcileExternalEgress.mockImplementation(async () => {
        order.push('egress')
      })
      const { blocker, started, release } = holdQueue(state)
      await started.promise
      markRolloutReady(witness)
      emit('MODIFIED', witness)
      expect(reconciled).toEqual([])

      const edited = structuredClone(fixture.server)
      edited.metadata.generation = 2
      edited.metadata.resourceVersion = String(++fixture.revision)
      edited.spec.image = 'ghcr.io/palmeradao/runtime-test:v2'
      edited.spec.egressBindings = [{ name: 'fixture-egress' }]
      fixture.server = edited
      const watchEvent = state.getMcpServerWatchCallback()('MODIFIED', structuredClone(edited))
      fixture.writes.length = 0
      const write = fixture.writes.push.bind(fixture.writes)
      vi.spyOn(fixture.writes, 'push').mockImplementation((...items: string[]) => {
        order.push(items[0])
        return write(...items)
      })

      release.resolve()
      await blocker
      await watchEvent
      await drain(state)

      expect(reconciled).toEqual([witness])
      expect(order.indexOf('egress')).toBeGreaterThanOrEqual(0)
      expect(order.indexOf('egress')).toBeLessThan(order.indexOf(`Deployment/${witness}`))
      expect(fixture.deployments.get(witness)?.spec?.template.spec?.containers[0].image).toBe(
        'ghcr.io/palmeradao/runtime-test:v2'
      )
    })

    it('I27 a periodic pass reconciles a stuck server once, patches nothing, and certifies', async () => {
      config.netPolResyncIntervalSec = 3600
      const { state } = await startStuckCertified({ withPeer: true })
      const retriesBefore = await retryCount()
      const patchesBefore = fixture.statusPatches
      const reconciled = recordReconciledNames(state)
      const certificateBefore = state.completedRuntimeRevision

      await vi.advanceTimersByTimeAsync(3_600_000 - 24 * 5000)
      await drain(state)

      expect([...reconciled].sort()).toEqual([peer, witness])
      expect(fixture.statusPatches).toBe(patchesBefore)
      expect(state.reconciler.namesAwaitingExternalChange('RolloutIncomplete')).toEqual([witness])
      expect(state.completedRuntimeRevision).not.toBe(certificateBefore)
      expect(state.matchesCurrentInventory(state.completedRuntimeRevision)).toBe(true)
      expect(await retryCount()).toBe(retriesBefore)

      // With no informer event, the next pass still observes a converged rollout.
      markRolloutReady(witness)
      await vi.advanceTimersByTimeAsync(3_600_000)
      await drain(state)

      expect(state.reconciler.getStatus(witness).ready).toBe(true)
      expect(fixture.server.status.conditions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'DeploymentReady', status: 'True' }),
        ])
      )
    })

    it('I28 a wake running when a pass ends costs a scoped retry and certifies 5 s later', async () => {
      const { state, emit } = await startStuckCertified({ withPeer: true })
      const holds = new Map<string, Promise<void>>()
      const entered = new Map<string, number>()
      const readInput = fixture.readInput!
      fixture.readInput = async request => {
        entered.set(request.name, (entered.get(request.name) ?? 0) + 1)
        await holds.get(request.name)
        return readInput(request)
      }
      const reconciled = recordReconciledNames(state)
      const certificateBefore = state.completedRuntimeRevision
      const holdPeer = deferred()
      holds.set('peer-input', holdPeer.promise)

      const pass = state.runInitialMcpServerConvergence('full')
      await until(() => entered.get('peer-input') === 1 && entered.get('witness-input') === 1)
      await until(
        () =>
          !state.reconciler.incompleteReconciliationNames().includes(witness) &&
          state.reconciler.namesAwaitingExternalChange('RolloutIncomplete').includes(witness)
      )

      const holdWake = deferred()
      holds.set('witness-input', holdWake.promise)
      markRolloutReady(witness)
      emit('MODIFIED', witness)
      await until(() => entered.get('witness-input') === 2)

      holdPeer.resolve()
      await pass
      expect(state.mcpServerRetryRequest.names).toEqual(new Set([witness]))
      expect(state.completedRuntimeRevision).toBe(certificateBefore)

      holdWake.resolve()
      await drain(state)
      expect(state.reconciler.getStatus(witness).ready).toBe(true)
      const peerReconciles = reconciled.filter(name => name === peer).length

      await vi.advanceTimersByTimeAsync(5000)
      await drain(state)

      expect(state.completedRuntimeRevision).not.toBe(certificateBefore)
      expect(state.matchesCurrentInventory(state.completedRuntimeRevision)).toBe(true)
      expect(reconciled.filter(name => name === peer)).toHaveLength(peerReconciles)
    })
  })
})
