import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import {
  asAppsApi,
  asCoreApi,
  asCustomApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockCustomApi,
} from '../../test/__fixtures__/testMocks'
import { McpServerReconciler } from '../reconciler'
import { McpServerCRD } from '../types'

vi.mock('../config', () => ({
  config: {
    devMode: false,
    port: 8081,
    namespace: 'mcp-server',
    hostNamespace: 'mcp-host',
    mcpServerImagePullPolicy: 'IfNotPresent',
    egressProxyImage: 'clerum/nginx-egress-proxy:0.1.0',
    stdioBridgeImage: 'clerum/stdio-bridge:test',
    stdioBridgeResources: {
      requests: { cpu: '50m', memory: '64Mi' },
      limits: { cpu: '200m', memory: '128Mi' },
    },
    devMcpServers: [],
    devContexts: [],
    devAuthTokens: new Map(),
  },
}))

const CREDENTIALS_REVISION_ANNOTATION = 'clerum.io/credentials-revision'

function makeServer(withEnvSecret = true): McpServerCRD {
  return {
    name: 'linear',
    namespace: 'mcp-server',
    uid: 'uid-linear-1234',
    spec: {
      contextRef: 'ctx1',
      image: 'linear-mcp:v1',
      transport: { type: 'streamableHttp', port: 3000, url: 'http://linear.mcp-server.svc:3000' },
      ...(withEnvSecret && {
        envSecret: {
          name: 'linear-credentials',
          keys: [{ secretKey: 'api-key', envVar: 'LINEAR_API_KEY' }],
        },
      }),
    },
  }
}

/** base64 of `value`, the form a Secret's `data` actually carries. */
function stored(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

function createdDeployment(appsApi: ReturnType<typeof createMockAppsApi>): k8s.V1Deployment {
  const call = appsApi.createNamespacedDeployment.mock.calls[0]
  return (call[0] as { body: k8s.V1Deployment }).body
}

function credentialsRevisionOf(deployment: k8s.V1Deployment): string | undefined {
  return deployment.spec?.template?.metadata?.annotations?.[CREDENTIALS_REVISION_ANNOTATION]
}

/**
 * Every DeploymentReady condition written to the CRD, oldest first. Conditions
 * travel as a JSON Patch on the status subresource, so this digs the condition
 * out of the patch document.
 */
function deploymentReadyWrites(customApi: ReturnType<typeof createMockCustomApi>): Array<{
  status: string
  reason: string
  message: string
}> {
  return customApi.patchNamespacedCustomObjectStatus.mock.calls
    .flatMap(call => {
      const body = (call[0] as { body?: unknown }).body
      return Array.isArray(body) ? body : []
    })
    .flatMap((op: unknown) => {
      const value = (op as { value?: unknown }).value
      const conditions = Array.isArray(value)
        ? value
        : ((value as { conditions?: unknown[] })?.conditions ?? [])
      return Array.isArray(conditions) ? conditions : []
    })
    .filter((c: unknown) => (c as { type?: string }).type === 'DeploymentReady')
    .map((c: unknown) => c as { status: string; reason: string; message: string })
}

/** A Deployment whose rollout has fully converged. */
function convergedDeployment(name?: string) {
  return {
    metadata: { name, resourceVersion: '1', generation: 2, labels: {} },
    spec: { replicas: 1 },
    status: {
      observedGeneration: 2,
      replicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
      unavailableReplicas: 0,
    },
  }
}

describe('connector credentials revision (issue #223)', () => {
  const appsApi = createMockAppsApi()
  const coreApi = createMockCoreApi()
  const customApi = createMockCustomApi()
  let reconciler: McpServerReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    coreApi.readNamespacedSecret.mockResolvedValue({
      metadata: { name: 'linear-credentials' },
      data: { 'api-key': stored('old-key') },
    })
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(customApi),
    })
  })

  it('stamps the pod template with a revision derived from the secret content', async () => {
    await reconciler.reconcile(makeServer())

    const revision = credentialsRevisionOf(createdDeployment(appsApi))
    expect(revision).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces the same revision when only the key ORDER differs', async () => {
    coreApi.readNamespacedSecret.mockResolvedValue({
      data: { 'api-key': stored('k1'), 'webhook-secret': stored('k2') },
    })
    await reconciler.reconcile(makeServer())
    const first = credentialsRevisionOf(createdDeployment(appsApi))

    vi.clearAllMocks()
    coreApi.readNamespacedSecret.mockResolvedValue({
      data: { 'webhook-secret': stored('k2'), 'api-key': stored('k1') },
    })
    await reconciler.reconcile(makeServer())
    const second = credentialsRevisionOf(createdDeployment(appsApi))

    // Key order is an artifact of how the API server answered, not a change in
    // credentials: it must never roll a pod.
    expect(second).toBe(first)
  })

  it('produces a different revision when a credential VALUE changes', async () => {
    await reconciler.reconcile(makeServer())
    const before = credentialsRevisionOf(createdDeployment(appsApi))

    vi.clearAllMocks()
    coreApi.readNamespacedSecret.mockResolvedValue({
      data: { 'api-key': stored('rotated-key') },
    })
    await reconciler.reconcile(makeServer())
    const after = credentialsRevisionOf(createdDeployment(appsApi))

    // This difference IS the rollout: same pod template otherwise.
    expect(after).not.toBe(before)
  })

  it('writes no annotation for a connector without envSecret', async () => {
    await reconciler.reconcile(makeServer(false))

    const annotations = createdDeployment(appsApi).spec?.template?.metadata?.annotations
    expect(annotations?.[CREDENTIALS_REVISION_ANNOTATION]).toBeUndefined()
  })

  it('keeps the new revision when replacing over an existing Deployment', async () => {
    // The update path: create answers 409, then read+replace runs the desired
    // object through preserveDeploymentAnnotations. The stale revision on the
    // live object must not win — otherwise a rotation would write the OLD
    // digest back and the pod would never roll.
    appsApi.createNamespacedDeployment.mockRejectedValueOnce(
      Object.assign(new Error('already exists'), { code: 409 })
    )
    appsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { name: 'linear', resourceVersion: '7', generation: 1, labels: {} },
      spec: {
        replicas: 1,
        template: {
          metadata: {
            annotations: {
              [CREDENTIALS_REVISION_ANNOTATION]: 'stale-revision',
              'operator.io/keep-me': 'yes',
            },
          },
        },
      },
      status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, readyReplicas: 1 },
    })

    await reconciler.reconcile(makeServer())

    const replaced = appsApi.replaceNamespacedDeployment.mock.calls[0][0] as {
      body: k8s.V1Deployment
    }
    const annotations = replaced.body.spec?.template?.metadata?.annotations
    expect(annotations?.[CREDENTIALS_REVISION_ANNOTATION]).toMatch(/^[0-9a-f]{64}$/)
    expect(annotations?.[CREDENTIALS_REVISION_ANNOTATION]).not.toBe('stale-revision')
    // Unrelated operator annotations still survive the replace.
    expect(annotations?.['operator.io/keep-me']).toBe('yes')
  })
})

describe('generation-aware rollout readiness (issue #223)', () => {
  const appsApi = createMockAppsApi()
  const coreApi = createMockCoreApi()
  const customApi = createMockCustomApi()
  let reconciler: McpServerReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    coreApi.readNamespacedSecret.mockResolvedValue({ data: { 'api-key': stored('old-key') } })
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(customApi),
    })
  })

  it('is NOT ready while the controller has not observed the current generation', async () => {
    appsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { generation: 3, labels: {} },
      spec: { replicas: 1 },
      // The old pod is still Ready — the trap the pre-#223 check fell into.
      status: { observedGeneration: 2, updatedReplicas: 1, readyReplicas: 1 },
    })

    await reconciler.reconcile(makeServer())

    expect(deploymentReadyWrites(customApi).at(-1)?.status).toBe('False')
  })

  it('is NOT ready while replicas are not yet updated', async () => {
    appsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { generation: 2, labels: {} },
      spec: { replicas: 2 },
      status: { observedGeneration: 2, updatedReplicas: 1, readyReplicas: 2 },
    })

    await reconciler.reconcile(makeServer())

    expect(deploymentReadyWrites(customApi).at(-1)?.status).toBe('False')
  })

  it('is NOT ready while a replica is unavailable', async () => {
    appsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { generation: 2, labels: {} },
      spec: { replicas: 1 },
      status: {
        observedGeneration: 2,
        updatedReplicas: 1,
        readyReplicas: 1,
        unavailableReplicas: 1,
      },
    })

    await reconciler.reconcile(makeServer())

    expect(deploymentReadyWrites(customApi).at(-1)?.status).toBe('False')
  })

  it('is ready only once the rollout has fully converged', async () => {
    appsApi.readNamespacedDeployment.mockResolvedValue(convergedDeployment('linear'))

    await reconciler.reconcile(makeServer())

    expect(deploymentReadyWrites(customApi).at(-1)?.status).toBe('True')
  })

  it('is NOT ready while a crash-looping new pod leaves the OLD pod behind (failed rollout, E2)', async () => {
    // The trap that a bare readyReplicas/unavailableReplicas check misses: with
    // replicas=1 + RollingUpdate(maxSurge=1, maxUnavailable=0), a new pod that
    // crash-loops on a bad credential never goes Ready, so K8s keeps the OLD
    // pod. That old pod holds readyReplicas=1 and availableReplicas=1, so
    // unavailableReplicas=0 and updatedReplicas=1 — everything looks converged
    // EXCEPT status.replicas, which stays at 2 (old + crash-looping new). This
    // is exactly the e2e E2 scenario; without `totalReplicas === updatedReplicas`
    // the poll reports the failed rotation as healthy.
    appsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { generation: 2, labels: {} },
      spec: { replicas: 1 },
      status: {
        observedGeneration: 2,
        replicas: 2, // old pod still present alongside the crash-looping new one
        updatedReplicas: 1,
        readyReplicas: 1, // the OLD pod masks the failure
        availableReplicas: 1,
        unavailableReplicas: 0,
      },
    })

    await reconciler.reconcile(makeServer())

    expect(deploymentReadyWrites(customApi).at(-1)?.status).toBe('False')
  })
})

/**
 * Composition tests. Each half works in isolation — the readiness check reads
 * the Deployment correctly, and updateStatusConditions writes the CRD
 * correctly — but before #223 nothing called the second after the first
 * converged, so a successful rotation never reached the CRD. These two tests
 * fail against that arrangement; they are the regression guard.
 */
describe('the readiness poll must publish its verdict on the CRD (issue #223)', () => {
  const appsApi = createMockAppsApi()
  const coreApi = createMockCoreApi()
  const customApi = createMockCustomApi()
  let reconciler: McpServerReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    coreApi.readNamespacedSecret.mockResolvedValue({ data: { 'api-key': stored('old-key') } })
    reconciler = new McpServerReconciler({} as k8s.KubeConfig, {
      appsApi: asAppsApi(appsApi),
      coreApi: asCoreApi(coreApi),
      customApi: asCustomApi(customApi),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes DeploymentReady=True once the poll sees the rollout converge', async () => {
    // Mid-rollout at reconcile time (the normal state right after a write),
    // converged by the time the poll runs.
    appsApi.readNamespacedDeployment
      .mockResolvedValueOnce({
        metadata: { generation: 2, labels: {} },
        spec: { replicas: 1 },
        status: { observedGeneration: 1, updatedReplicas: 0, readyReplicas: 1 },
      })
      .mockResolvedValue(convergedDeployment('linear'))

    await reconciler.reconcile(makeServer())
    await vi.advanceTimersByTimeAsync(5000)

    expect(deploymentReadyWrites(customApi).at(-1)?.status).toBe('True')
  })

  it('converges from the immediate False to a later True, instead of staying False', async () => {
    appsApi.readNamespacedDeployment
      .mockResolvedValueOnce({
        metadata: { generation: 2, labels: {} },
        spec: { replicas: 1 },
        status: { observedGeneration: 1, updatedReplicas: 0, readyReplicas: 1 },
      })
      .mockResolvedValue(convergedDeployment('linear'))

    await reconciler.reconcile(makeServer())
    const beforePoll = deploymentReadyWrites(customApi).map(c => c.status)
    await vi.advanceTimersByTimeAsync(5000)
    const afterPoll = deploymentReadyWrites(customApi).map(c => c.status)

    // Generation-aware readiness makes the immediate verdict False by
    // construction, so a terminal False here would mean every successful
    // rotation is reported as a failure.
    expect(beforePoll).toContain('False')
    expect(afterPoll.at(-1)).toBe('True')
  })

  it('gives up loudly on the CRD, with the rollout numbers, when it never converges', async () => {
    appsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { generation: 2, labels: {} },
      spec: { replicas: 1 },
      status: {
        observedGeneration: 2,
        updatedReplicas: 1,
        readyReplicas: 0,
        unavailableReplicas: 1,
      },
    })

    await reconciler.reconcile(makeServer())
    // 24 polls × 5s, the full budget.
    await vi.advanceTimersByTimeAsync(24 * 5000)

    const last = deploymentReadyWrites(customApi).at(-1)
    expect(last?.status).toBe('False')
    expect(last?.reason).toBe('RolloutIncomplete')
    // The message must carry evidence, not just "not ready".
    expect(last?.message).toContain('ready 0/1')
    expect(last?.message).toContain('unavailable 1')
  })

  it('still reaches the terminal RolloutIncomplete verdict when repeated reconciles fire during the poll window (status-update-loop, E2)', async () => {
    // Failed credential rotation: the crash-looping new pod leaves the OLD pod
    // behind, so the rollout never converges (total 2 vs updated 1) — the
    // exact E2 shape. Deployment generation never changes: same rollout.
    appsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { generation: 2, labels: {} },
      spec: { replicas: 1 },
      status: {
        observedGeneration: 2,
        replicas: 2,
        updatedReplicas: 1,
        readyReplicas: 1,
        availableReplicas: 1,
        unavailableReplicas: 0,
      },
    })

    await reconciler.reconcile(makeServer())

    // Every status write fires a MODIFIED watch event on the McpServer, which
    // fires another reconcile MID-POLL. Before the fix each of these calls
    // cancelled the running poll and reset its attempt budget, so the poll
    // never exhausted and RolloutIncomplete was never written — the CRD sat
    // at WaitingForReplicas until the UI's generic timeout. 12 × 10s = 120s,
    // the full 24 × 5s budget, with a reconcile landing every 2 polls.
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(2 * 5000)
      await reconciler.reconcile(makeServer())
    }

    const last = deploymentReadyWrites(customApi).at(-1)
    expect(last?.status).toBe('False')
    // The reconcile that follows the terminal write must not downgrade the
    // verdict back to WaitingForReplicas — the LAST write stays terminal.
    expect(last?.reason).toBe('RolloutIncomplete')
    expect(last?.message).toContain('total 2')
  })

  it('grants a NEW rotation (bumped Deployment generation) a fresh poll budget mid-window', async () => {
    const notConverged = (generation: number) => ({
      metadata: { generation, labels: {} },
      spec: { replicas: 1 },
      status: {
        observedGeneration: generation,
        replicas: 2,
        updatedReplicas: 1,
        readyReplicas: 1,
        availableReplicas: 1,
        unavailableReplicas: 0,
      },
    })
    appsApi.readNamespacedDeployment.mockResolvedValue(notConverged(2))

    await reconciler.reconcile(makeServer())
    // 12 polls into the first window…
    await vi.advanceTimersByTimeAsync(12 * 5000)
    // …a SECOND rotation lands: new generation, still not converging.
    appsApi.readNamespacedDeployment.mockResolvedValue(notConverged(3))
    await vi.advanceTimersByTimeAsync(13 * 5000)

    // 125s elapsed — past the original 24 × 5s budget — but the new rollout
    // got a fresh window when its generation appeared at t=65s, so a terminal
    // verdict now would blame the new rollout with the old rollout's clock.
    expect(deploymentReadyWrites(customApi).some(w => w.reason === 'RolloutIncomplete')).toBe(false)

    // The fresh window exhausts its own 24 polls after the generation change.
    await vi.advanceTimersByTimeAsync(11 * 5000)
    const last = deploymentReadyWrites(customApi).at(-1)
    expect(last?.reason).toBe('RolloutIncomplete')
    expect(last?.message).toContain('generation 3/3')
  })

  it('a NEW generation arriving while the LAST tick is in flight still gets its own window (in-flight tick race)', async () => {
    // The race the timer-only re-entrancy guard cannot see: pollReadiness()
    // is called by a reconcile WHILE the budget-exhausting tick is suspended
    // inside its Deployment read. The tick's data predates the reconcile's
    // Deployment write (the new generation), and after the tick goes terminal
    // nothing else re-arms the poll — McpServer has no periodic resync and no
    // Deployment watch — so the CRD would keep the OLD generation's
    // RolloutIncomplete forever even though the NEW rollout converges.
    const notConverged = (generation: number) => ({
      metadata: { generation, labels: {} },
      spec: { replicas: 1 },
      status: {
        observedGeneration: generation,
        replicas: 2,
        updatedReplicas: 1,
        readyReplicas: 1,
        availableReplicas: 1,
        unavailableReplicas: 0,
      },
    })
    const converged = (generation: number) => ({
      metadata: { generation, labels: {} },
      spec: { replicas: 1 },
      status: {
        observedGeneration: generation,
        replicas: 1,
        updatedReplicas: 1,
        readyReplicas: 1,
        unavailableReplicas: 0,
      },
    })

    // Generation 2 crash-loops and never converges.
    appsApi.readNamespacedDeployment.mockResolvedValue(notConverged(2))
    await reconciler.reconcile(makeServer())

    // Burn 23 of the 24 attempts of the window.
    await vi.advanceTimersByTimeAsync(23 * 5000)

    // Tick 24 — the budget-exhausting one — starts its Deployment read, and
    // we hold that read open: the tick is now suspended mid-await, with the
    // OLD generation's data about to come back.
    let releaseInFlightRead: ((deployment: unknown) => void) | undefined
    appsApi.readNamespacedDeployment.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseInFlightRead = resolve
        })
    )
    await vi.advanceTimersByTimeAsync(5000)
    if (releaseInFlightRead === undefined) {
      throw new Error(
        'race precondition failed: tick 24 never started its Deployment read while suspended'
      )
    }

    // While that tick is in flight, the operator fixes the credential: the
    // reconcile writes the Deployment at generation 3 and, at the end of
    // performReconcile, calls pollReadiness() — landing exactly inside the
    // window the re-entrancy guard used to no-op.
    coreApi.readNamespacedSecret.mockResolvedValue({ data: { 'api-key': stored('fixed-key') } })
    appsApi.readNamespacedDeployment.mockResolvedValue(notConverged(3))
    await reconciler.reconcile(makeServer())

    // The suspended tick now completes with the data it read BEFORE the new
    // rollout existed: stale generation-2 numbers, budget exhausted.
    releaseInFlightRead(notConverged(2))
    await vi.advanceTimersByTimeAsync(0)

    // Generation 3 converges shortly after. Only a poll window that survived
    // the race can observe this.
    appsApi.readNamespacedDeployment.mockResolvedValue(converged(3))
    await vi.advanceTimersByTimeAsync(2 * 5000)

    // The final CRD verdict must belong to generation 3 — DeploymentReady=True.
    // A RolloutIncomplete write here would carry generation 2's stale numbers
    // and, with the window dead, would stick indefinitely.
    const writes = deploymentReadyWrites(customApi)
    expect(writes.at(-1)?.status).toBe('True')
    expect(writes.some(w => w.reason === 'RolloutIncomplete')).toBe(false)
  })
})
