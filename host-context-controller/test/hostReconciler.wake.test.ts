import { describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { HostReconciler } from '../src/hostReconciler'
import { HostCRD, HostCrdStatus, HostLifecycleState } from '../src/types'
import {
  type MockAppsApi,
  type MockCustomApi,
  asAppsApi,
  asCoreApi,
  asCustomApi,
  asNetworkingApi,
  asRbacApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockCustomApi,
  createMockNetworkingApi,
  createMockRbacApi,
} from './__fixtures__/testMocks'

vi.mock('../src/config', () => ({
  config: {
    devMode: false,
    port: 8081,
    namespace: 'mcp-server',
    controlPlaneNamespace: 'control-plane',
    hostNamespace: 'mcp-host',
    rpcProxyNamespace: 'rpc-proxy',
    channelsNamespace: 'channels',
    channelReaderImage: 'clerum/channel-reader:test',
    channelReaderImagePullPolicy: 'IfNotPresent',
    hostImage: 'clerum/mcp-host:0.6.0',
    hostImagePullPolicy: 'Always',
    hostImagePullSecretName: 'clerum',
    hostPort: 8080,
    gfsNamespace: 'gfs',
    gfscPort: 8087,
    hostConfigMapName: 'mcp-host-config',
    hostServiceAccountName: 'mcp-host',
    hostWorkspaceStorageClassName: 'do-block-storage-retain',
    hostWorkspaceStorageSize: '10Gi',
    hostWorkspacePath: '/workspace',
    hostResources: {
      requests: { memory: '128Mi', cpu: '100m' },
      limits: { memory: '512Mi', cpu: '500m' },
    },
    desktopImage: 'clerum/mcp-host-desktop:latest',
    desktopPort: 3000,
    desktopResources: {
      requests: { memory: '256Mi', cpu: '250m' },
      limits: { memory: '4Gi', cpu: '1000m' },
    },
    devMcpServers: [],
    devContexts: [],
    devAuthTokens: new Map(),
    controlApiBaseUrl: 'http://control-api.test:8090',
    internalControlJwtHccHmacSecret: 'test-hcc-internal-control-secret',
    hccTargetNamespace: 'mcp-host',
    mcpHostGatewayUrl:
      'http://nginx-workflow-approval-gateway.control-plane.svc.cluster.local:8092',
  },
}))

// Short-circuit the HCC issuer so reconcile tests don't reach the network.
vi.mock('../src/mcpHostRuntimeTokenIssuerClient', () => ({
  issueMcpHostRuntimeTokens: vi.fn().mockResolvedValue({
    accessToken: 'test-mcp-host-runtime-access-token',
    refreshToken: 'test-mcp-host-runtime-refresh-token',
    mcpHostControlToken: 'test-mcp-host-workflow-control-token',
    channelReaderMessageToken: 'test-channel-reader-message-token',
    channelReaderApprovalToken: 'test-channel-reader-approval-token',
    channelReaderWorkflowApprovalDecisionToken: 'test-channel-reader-decision-token',
    channelReaderActivityToken: 'test-channel-reader-activity-token',
    channelReaderCronReadToken: 'test-channel-reader-cron-read-token',
    channelReaderCronAckToken: 'test-channel-reader-cron-ack-token',
    expiresInSeconds: 600,
    refreshExpiresInSeconds: 3600,
    controlExpiresInSeconds: 600,
    channelReaderMessageExpiresInSeconds: 600,
    channelReaderApprovalExpiresInSeconds: 600,
    channelReaderWorkflowApprovalDecisionExpiresInSeconds: 600,
  }),
}))

vi.mock('../src/gfsHostBinding', () => ({
  mintHostGfsToken: vi.fn().mockResolvedValue({
    ['to' + 'ken']: 'gfs-runtime-value',
    expiresInSeconds: 600,
    subject: 'host:1st:mcp-host/stateless-host',
  }),
}))

const WAKE_ANNOTATION = 'clerum.io/wake-requested'

function runtimeTokenProvision(host: HostCRD) {
  const internals = HostReconciler as unknown as {
    runtimeTokenScopeHash(host: HostCRD, hasChannelIngress: boolean): string
  }
  return {
    revision: 'runtime-revision',
    scopeHash: internals.runtimeTokenScopeHash(host, false),
  }
}

/** Converged accepted-stateless condition, exactly as assessLifecycle writes it. */
function statelessEnabledCondition() {
  return {
    type: 'StatelessEnableRejected',
    status: 'False' as const,
    reason: 'StatelessEnabled',
    message: 'stateless lifecycle is enabled',
    lastTransitionTime: '2026-01-01T00:00:00.000Z',
  }
}

/** Converged accepted pull-policy condition, exactly as assessLifecycle writes it. */
function statelessPullPolicyAcceptedCondition() {
  return {
    type: 'StatelessPullPolicyRejected',
    status: 'False' as const,
    reason: 'StatelessPullPolicyAccepted',
    message: 'stateless imagePullPolicy resolves to Always',
    lastTransitionTime: '2026-01-01T00:00:00.000Z',
  }
}

/**
 * Stateless Host in a given durable lifecycle state with an optional
 * wake-requested annotation. The status carries the converged
 * StatelessEnableRejected=False condition so the heavy reconcile body's
 * status write is a no-op unless the wake actually changes something.
 */
function makeWakeHost(
  opts: {
    wakeRequested?: string
    state?: HostLifecycleState
    wakeHandledGeneration?: number
  } = {}
): HostCRD {
  const status: HostCrdStatus = {
    lifecycle: {
      state: opts.state ?? 'suspended',
      wakeHandledGeneration: opts.wakeHandledGeneration ?? 0,
    },
    conditions: [statelessEnabledCondition(), statelessPullPolicyAcceptedCondition()],
  }
  return {
    name: 'stateless-host',
    namespace: 'mcp-host',
    ...(opts.wakeRequested !== undefined
      ? { annotations: { [WAKE_ANNOTATION]: opts.wakeRequested } }
      : {}),
    spec: {
      host: 'stateless-host',
      contextRef: 'context-a',
      secretRef: 'host-secret',
      lifecycle: { stateless: true },
    },
    status,
  }
}

function createReconciler() {
  const appsApi = createMockAppsApi()
  const coreApi = createMockCoreApi()
  const networkingApi = createMockNetworkingApi()
  const rbacApi = createMockRbacApi()
  const customApi = createMockCustomApi()

  const reconciler = new HostReconciler({} as k8s.KubeConfig, {
    appsApi: asAppsApi(appsApi),
    coreApi: asCoreApi(coreApi),
    networkingApi: asNetworkingApi(networkingApi),
    rbacApi: asRbacApi(rbacApi),
    customApi: asCustomApi(customApi),
    now: () => new Date('2026-07-03T00:00:00.000Z'),
    // Wake cases model the steady state after the watcher completed its
    // CommunicationChannel initial list. Cache-startup fail-closed behavior
    // is covered in hostReconciler.lifecycle.test.ts.
    isCommunicationChannelCacheSynced: () => true,
  })

  return { reconciler, appsApi, coreApi, networkingApi, rbacApi, customApi }
}

/** The mcp-host Deployment body sent to the K8s API (excludes channel-reader). */
function hostDeploymentBody(appsApi: MockAppsApi, name: string): k8s.V1Deployment {
  const calls = [
    ...appsApi.createNamespacedDeployment.mock.calls,
    ...appsApi.replaceNamespacedDeployment.mock.calls,
  ]
  const call = calls.find(
    ([arg]) => (arg as { body?: k8s.V1Deployment })?.body?.metadata?.name === name
  )
  if (!call) {
    throw new Error(`No Deployment create/replace call found for "${name}"`)
  }
  return (call[0] as { body: k8s.V1Deployment }).body
}

/** Every replicas value sent in a create/replace of the mcp-host Deployment. */
function allHostDeploymentReplicas(appsApi: MockAppsApi, name: string): Array<number | undefined> {
  return [
    ...appsApi.createNamespacedDeployment.mock.calls,
    ...appsApi.replaceNamespacedDeployment.mock.calls,
  ]
    .map(([arg]) => (arg as { body?: k8s.V1Deployment })?.body)
    .filter(body => body?.metadata?.name === name)
    .map(body => body?.spec?.replicas)
}

/**
 * Every /status value written through the CustomObjects API, reconstructed
 * from the JSON Patch ops. The lifecycle writers use three shapes:
 *   - full-status seed: `[{ add /status }]` (heartbeat cores + fresh-Host seed)
 *   - targeted sub-object: `[{ add /status/lifecycle }, { add /status/conditions }]`
 *     (writeLifecycleStatusToCluster, D2 — never clobbers un-computed fields)
 * either optionally preceded by an `add /metadata/resourceVersion` precondition
 * op (D3). This helper strips the precondition op and merges the remaining ops
 * into a single HostCrdStatus so assertions stay shape-agnostic.
 */
function lifecycleStatusWrites(customApi: MockCustomApi): HostCrdStatus[] {
  return customApi.patchNamespacedCustomObjectStatus.mock.calls.map(([arg]) => {
    const body = (arg as { body: Array<{ op: string; path: string; value: unknown }> }).body
    if (!Array.isArray(body)) {
      throw new Error(`Unexpected status patch body: ${JSON.stringify(body)}`)
    }
    const ops = body.filter(op => op.path !== '/metadata/resourceVersion')
    let status: HostCrdStatus = {}
    for (const op of ops) {
      if (op.path === '/status') {
        status = op.value as HostCrdStatus
      } else if (op.path === '/status/lifecycle') {
        status = { ...status, lifecycle: op.value as HostCrdStatus['lifecycle'] }
      } else if (op.path === '/status/conditions') {
        status = { ...status, conditions: op.value as HostCrdStatus['conditions'] }
      } else {
        throw new Error(`Unexpected status patch op path: ${JSON.stringify(op)}`)
      }
    }
    return status
  })
}

/**
 * API-shaped fresh-read response mirroring makeWakeHost: the AP-1 hardened
 * fast-path re-decides the wake from a FRESH GET at the commit point, so
 * tests must serve the server-side truth through
 * customApi.getNamespacedCustomObject. Carries a resourceVersion so the D3
 * precondition op is exercised, and the converged conditions so the heavy
 * body's status write stays a no-op unless a test overrides them.
 */
function freshWakeHostResponse(
  opts: {
    wakeRequested?: string
    state?: HostLifecycleState
    wakeHandledGeneration?: number
    reason?: string
  } = {}
) {
  return {
    metadata: {
      name: 'stateless-host',
      namespace: 'mcp-host',
      resourceVersion: 'rv-1',
      ...(opts.wakeRequested !== undefined
        ? { annotations: { [WAKE_ANNOTATION]: opts.wakeRequested } }
        : {}),
    },
    spec: {
      host: 'stateless-host',
      contextRef: 'context-a',
      secretRef: 'host-secret',
      lifecycle: { stateless: true },
    },
    status: {
      lifecycle: {
        state: opts.state ?? 'suspended',
        wakeHandledGeneration: opts.wakeHandledGeneration ?? 0,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      },
      conditions: [statelessEnabledCondition(), statelessPullPolicyAcceptedCondition()],
    },
  }
}

/** A K8s 409 Conflict error as getErrorCode reads it (.code). */
function conflict409(): Error {
  return Object.assign(new Error('the object has been modified'), { code: 409 })
}

describe('HostReconciler wake fast-path — wake × state transition matrix', () => {
  it('wake in suspended flips the status to active, records the generation, and scales to 1', async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    // Server-side truth for the fast-path's AP-1 commit-point read.
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshWakeHostResponse({ wakeRequested: '2', state: 'suspended' })
    )
    await reconciler.reconcile(makeWakeHost({ wakeRequested: '2', state: 'suspended' }))

    const writes = lifecycleStatusWrites(customApi)
    expect(writes[0].lifecycle).toEqual({ state: 'active', wakeHandledGeneration: 2 })
    // The fast-path's minimal scale patch targets the existing Deployment.
    expect(appsApi.patchNamespacedDeployment).toHaveBeenCalledTimes(1)
    const [scaleArg] = appsApi.patchNamespacedDeployment.mock.calls[0]
    expect(scaleArg).toMatchObject({
      name: 'stateless-host',
      namespace: 'mcp-host',
      body: { spec: { replicas: 1 } },
    })
    // The heavy body then converges the full Deployment on replicas=1 too.
    expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(1)
    // Exactly one durable write: the heavy body's status write is a
    // converged no-op after the fast-path flip.
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
  })

  it('falls back to a deployment update when the minimal scale patch is forbidden', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { reconciler, appsApi, customApi } = createReconciler()
      customApi.getNamespacedCustomObject.mockResolvedValue(
        freshWakeHostResponse({ wakeRequested: '2', state: 'suspended' })
      )
      appsApi.patchNamespacedDeployment.mockRejectedValueOnce(
        Object.assign(new Error('forbidden'), { code: 403 })
      )
      appsApi.readNamespacedDeployment.mockResolvedValueOnce({
        metadata: { resourceVersion: 'rv-1' },
        spec: {
          replicas: 0,
          selector: { matchLabels: { app: 'stateless-host' } },
          template: {
            metadata: { labels: { app: 'stateless-host' } },
            spec: { containers: [] },
          },
        },
      })

      await reconciler.reconcile(makeWakeHost({ wakeRequested: '2', state: 'suspended' }))

      const replacement = appsApi.replaceNamespacedDeployment.mock.calls.find(
        ([arg]) => arg.name === 'stateless-host' && arg.namespace === 'mcp-host'
      )?.[0]
      expect(replacement?.body.spec?.replicas).toBe(1)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('used deployment update fallback')
      )
      expect(
        logSpy.mock.calls
          .map(args => String(args[0]))
          .some(line => line.includes('phase=replicas_patched'))
      ).toBe(true)
    } finally {
      logSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('wake in draining cancels the drain: status active, NO scale call issued', async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshWakeHostResponse({ wakeRequested: '4', state: 'draining', wakeHandledGeneration: 1 })
    )
    await reconciler.reconcile(
      makeWakeHost({ wakeRequested: '4', state: 'draining', wakeHandledGeneration: 1 })
    )

    const writes = lifecycleStatusWrites(customApi)
    expect(writes[0].lifecycle).toEqual({ state: 'active', wakeHandledGeneration: 4 })
    // Replicas were never dropped while draining — no scale patch.
    expect(appsApi.patchNamespacedDeployment).not.toHaveBeenCalled()
    expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(1)
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
  })

  it('drained-pre-scale guard: a wake pending after a failed fast-path write aborts replicas=0', async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    const internals = reconciler as unknown as {
      ensureMcpHostRuntimeTokenSecret: (
        host: HostCRD,
        options?: { forceFreshForWake?: boolean; targetSuspended?: boolean }
      ) => Promise<{ revision: string; scopeHash: string }>
    }
    const ensureBootstrap = vi
      .spyOn(internals, 'ensureMcpHostRuntimeTokenSecret')
      .mockImplementation(async host => runtimeTokenProvision(host))
    // Simulate the wake landing in the drained-pre-scale window: the
    // fast-path durable flip fails, so the assessment still observes
    // suspended when the scale-down would derive from it.
    customApi.patchNamespacedCustomObjectStatus.mockRejectedValueOnce(
      new Error('simulated status write conflict')
    )
    // M2/AP-1: the fast-path's commit-point read AND the drained-pre-scale
    // guard both re-check the wake against a FRESH GET (not the cache). The
    // cluster holds the woken-pending state throughout (the fast-path status
    // flip failed), so every fresh read must surface wake-requested=3 over
    // handled=0 for the guard to abort replicas=0.
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshWakeHostResponse({ wakeRequested: '3', state: 'suspended' })
    )
    await reconciler.reconcile(makeWakeHost({ wakeRequested: '3', state: 'suspended' }))

    // The fast-path never scaled (its durable flip failed first) ...
    expect(appsApi.patchNamespacedDeployment).not.toHaveBeenCalled()
    // ... and the pending replicas:0 was aborted: every Deployment apply
    // carried replicas=1, so the scale-down never reached the cluster.
    const replicas = allHostDeploymentReplicas(appsApi, 'stateless-host')
    expect(replicas.length).toBeGreaterThan(0)
    expect(replicas.every(r => r === 1)).toBe(true)
    expect(ensureBootstrap).toHaveBeenCalledWith(expect.anything(), {
      forceFreshForWake: false,
      targetSuspended: false,
    })
    // The guard re-ran the durable wake transition.
    const writes = lifecycleStatusWrites(customApi)
    expect(writes.at(-1)?.lifecycle).toMatchObject({
      state: 'active',
      wakeHandledGeneration: 3,
    })
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(2)
  })

  it('uses the fresh guard wake when the cached Host has not observed it yet', async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    const internals = reconciler as unknown as {
      ensureMcpHostRuntimeTokenSecret: (
        host: HostCRD,
        options?: { forceFreshForWake?: boolean; targetSuspended?: boolean }
      ) => Promise<{ revision: string; scopeHash: string }>
    }
    const ensureBootstrap = vi
      .spyOn(internals, 'ensureMcpHostRuntimeTokenSecret')
      .mockImplementation(async host => runtimeTokenProvision(host))

    // The cached Host does not carry the wake annotation, so the fast-path
    // returns before its own fresh read. The later scale guard sees the live
    // wake and must make bootstrap selection target the active state.
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshWakeHostResponse({ wakeRequested: '3', state: 'suspended' })
    )
    await reconciler.reconcile(makeWakeHost({ state: 'suspended', wakeHandledGeneration: 0 }))

    expect(appsApi.patchNamespacedDeployment).not.toHaveBeenCalled()
    expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(1)
    expect(ensureBootstrap).toHaveBeenCalledWith(expect.anything(), {
      forceFreshForWake: false,
      targetSuspended: false,
    })
  })

  it('wake in active records the generation only: no scale, no writes beyond the generation', async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshWakeHostResponse({ wakeRequested: '3', state: 'active', wakeHandledGeneration: 1 })
    )
    await reconciler.reconcile(
      makeWakeHost({ wakeRequested: '3', state: 'active', wakeHandledGeneration: 1 })
    )

    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(1)
    expect(writes[0].lifecycle).toEqual({ state: 'active', wakeHandledGeneration: 3 })
    expect(appsApi.patchNamespacedDeployment).not.toHaveBeenCalled()
    expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(1)
  })

  it('repeated events with the same generation transition once; the redelivery is a no-op', async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshWakeHostResponse({ wakeRequested: '2', state: 'suspended' })
    )
    await reconciler.reconcile(makeWakeHost({ wakeRequested: '2', state: 'suspended' }))
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
    expect(appsApi.patchNamespacedDeployment).toHaveBeenCalledTimes(1)

    // The redelivered event serves the woken status with the same annotation
    // (the API reflects the fast-path's own /status write).
    await reconciler.reconcile(
      makeWakeHost({ wakeRequested: '2', state: 'active', wakeHandledGeneration: 2 })
    )
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
    expect(appsApi.patchNamespacedDeployment).toHaveBeenCalledTimes(1)
  })
})

describe('HostReconciler wake fast-path — durability and restart behavior', () => {
  it('HCC restart amnesia: wakeHandledGeneration == annotation does not re-wake the host', async () => {
    // A fresh reconciler instance simulates the restart: no in-memory wake
    // state survives, only the CRD annotation + status.
    const { reconciler, appsApi, customApi } = createReconciler()
    await reconciler.reconcile(
      makeWakeHost({ wakeRequested: '5', state: 'suspended', wakeHandledGeneration: 5 })
    )

    expect(appsApi.patchNamespacedDeployment).not.toHaveBeenCalled()
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(0)
  })

  it('Deployment recreated while suspended stays at replicas=0 when the wake is already handled', async () => {
    const { reconciler, appsApi } = createReconciler()
    // The mock create succeeds (no 409), i.e. the Deployment does not exist
    // yet — exactly the "recreated while suspended" case.
    await reconciler.reconcile(
      makeWakeHost({ wakeRequested: '2', state: 'suspended', wakeHandledGeneration: 2 })
    )

    const created = appsApi.createNamespacedDeployment.mock.calls
      .map(([arg]) => (arg as { body?: k8s.V1Deployment })?.body)
      .find(body => body?.metadata?.name === 'stateless-host')
    if (!created) {
      throw new Error('expected the mcp-host Deployment to be created')
    }
    expect(created.spec?.replicas).toBe(0)
    expect(appsApi.patchNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('fast-path acts before any readiness or pod-listing API is touched', async () => {
    const { reconciler, appsApi, coreApi, customApi } = createReconciler()
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshWakeHostResponse({ wakeRequested: '2', state: 'suspended' })
    )
    await reconciler.reconcile(makeWakeHost({ wakeRequested: '2', state: 'suspended' }))

    const statusOrder = customApi.patchNamespacedCustomObjectStatus.mock.invocationCallOrder[0]
    const scaleOrder = appsApi.patchNamespacedDeployment.mock.invocationCallOrder[0]
    // Durable flip first, then the scale patch.
    expect(statusOrder).toBeLessThan(scaleOrder)
    // Every readiness/waiting API call (Deployment reads, pod listings)
    // happens strictly AFTER the fast-path completed — the fast path never
    // awaits pod readiness.
    const readinessOrders = [
      ...appsApi.readNamespacedDeployment.mock.invocationCallOrder,
      ...coreApi.listNamespacedPod.mock.invocationCallOrder,
    ]
    expect(readinessOrders.length).toBeGreaterThan(0)
    for (const order of readinessOrders) {
      expect(order).toBeGreaterThan(scaleOrder)
    }
  })

  it('malformed annotation means no wake intent: logged loudly once, never throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { reconciler, appsApi, customApi } = createReconciler()
      await expect(
        reconciler.reconcile(makeWakeHost({ wakeRequested: 'not-a-number', state: 'suspended' }))
      ).resolves.toBeUndefined()
      // A second delivery of the same malformed value must not repeat the log.
      await reconciler.reconcile(
        makeWakeHost({ wakeRequested: 'not-a-number', state: 'suspended' })
      )

      // No wake happened: the host stays suspended at replicas=0.
      expect(appsApi.patchNamespacedDeployment).not.toHaveBeenCalled()
      expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
      expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(0)

      const malformedLogs = errorSpy.mock.calls.filter(args =>
        String(args[0]).includes('Malformed clerum.io/wake-requested')
      )
      expect(malformedLogs).toHaveLength(1)
      expect(String(malformedLogs[0][0])).toContain('"not-a-number"')
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('HostReconciler wake fast-path — structured wake timestamps (Stage 6, W2)', () => {
  it('emits wake_observed, status_flipped, replicas_patched with the same generation', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { reconciler, customApi } = createReconciler()
      customApi.getNamespacedCustomObject.mockResolvedValue(
        freshWakeHostResponse({ wakeRequested: '2', state: 'suspended' })
      )
      await reconciler.reconcile(makeWakeHost({ wakeRequested: '2', state: 'suspended' }))

      const wakeLines = logSpy.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.startsWith('[StatelessWake]'))
      expect(wakeLines).toEqual([
        expect.stringMatching(
          /^\[StatelessWake\] host=stateless-host generation=2 phase=wake_observed ts=\d+$/
        ),
        expect.stringMatching(
          /^\[StatelessWake\] host=stateless-host generation=2 phase=status_flipped ts=\d+$/
        ),
        expect.stringMatching(
          /^\[StatelessWake\] host=stateless-host generation=2 phase=replicas_patched ts=\d+$/
        ),
      ])
    } finally {
      logSpy.mockRestore()
    }
  })

  it('emits no replicas_patched (and no scale metric) for a cancel-drain wake', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { reconciler, customApi } = createReconciler()
      customApi.getNamespacedCustomObject.mockResolvedValue(
        freshWakeHostResponse({ wakeRequested: '4', state: 'draining', wakeHandledGeneration: 1 })
      )
      await reconciler.reconcile(
        makeWakeHost({ wakeRequested: '4', state: 'draining', wakeHandledGeneration: 1 })
      )

      const lines = logSpy.mock.calls.map(args => String(args[0]))
      const phases = lines
        .filter(line => line.startsWith('[StatelessWake]'))
        .map(line => /phase=(\w+)/.exec(line)?.[1])
      expect(phases).toEqual(['wake_observed', 'status_flipped'])
      expect(lines.some(line => line.startsWith('[StatelessMetric]'))).toBe(false)
    } finally {
      logSpy.mockRestore()
    }
  })
})

describe('HostReconciler — scale-transition counter (Stage 6 metric)', () => {
  it('increments per host in both directions and emits suspended_applied on the way down', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { reconciler, customApi } = createReconciler()
      const host = makeWakeHost({ wakeRequested: '2', state: 'suspended' })
      customApi.getNamespacedCustomObject.mockResolvedValue(
        freshWakeHostResponse({ wakeRequested: '2', state: 'suspended' })
      )

      // suspended → wake → replicas=1 (direction=up)
      await reconciler.reconcile(host)
      // active → heartbeat suspension → replicas=0 (direction=down).
      // Server-side truth for the suspend core's fresh-read guard: the
      // durable draining write already landed with the woken generation.
      customApi.getNamespacedCustomObject
        .mockResolvedValueOnce({
          metadata: { name: 'stateless-host', namespace: 'mcp-host' },
          spec: {
            host: 'stateless-host',
            contextRef: 'context-a',
            secretRef: 'host-secret',
            lifecycle: { stateless: true },
          },
          status: { lifecycle: { state: 'draining', wakeHandledGeneration: 2 } },
        })
        // After the suspend PATCH lands the server is suspended — the FIX 1
        // replicas guard re-reads fresh before deriving replicas=0.
        .mockResolvedValue({
          metadata: { name: 'stateless-host', namespace: 'mcp-host' },
          spec: {
            host: 'stateless-host',
            contextRef: 'context-a',
            secretRef: 'host-secret',
            lifecycle: { stateless: true },
          },
          status: {
            lifecycle: { state: 'suspended', wakeHandledGeneration: 2, reason: 'idle' },
          },
        })
      await reconciler.suspendHostFromHeartbeat(host, 'idle', 2)

      const metricLines = logSpy.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.startsWith('[StatelessMetric]'))
      expect(metricLines).toEqual([
        '[StatelessMetric] scale_transition host=stateless-host direction=up total=1',
        '[StatelessMetric] scale_transition host=stateless-host direction=down total=2',
      ])

      const suspendLines = logSpy.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.startsWith('[StatelessSuspend]'))
      expect(suspendLines).toEqual([
        expect.stringMatching(
          /^\[StatelessSuspend\] host=stateless-host phase=suspended_applied ts=\d+$/
        ),
      ])
    } finally {
      logSpy.mockRestore()
    }
  })
})

describe('HostReconciler wake fast-path — AP-1 fresh re-decide at the commit point', () => {
  it('skips when the cached snapshot shows a pending wake but FRESH already handled it: no write, no duplicate phase logs', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { reconciler, appsApi, customApi } = createReconciler()
      // A sibling (or a prior fast-path pass over another snapshot) already
      // handled generation 3: the server-side truth is active with
      // handled == requested.
      customApi.getNamespacedCustomObject.mockResolvedValue(
        freshWakeHostResponse({ wakeRequested: '3', state: 'active', wakeHandledGeneration: 3 })
      )
      // Stale cached event payload: suspended with the wake still pending.
      await reconciler.reconcile(makeWakeHost({ wakeRequested: '3', state: 'suspended' }))

      expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
      expect(appsApi.patchNamespacedDeployment).not.toHaveBeenCalled()
      const lines = logSpy.mock.calls.map(args => String(args[0]))
      expect(lines.filter(line => line.startsWith('[StatelessWake]'))).toEqual([])
      expect(lines.filter(line => line.includes('Wake fast-path for'))).toEqual([])
    } finally {
      logSpy.mockRestore()
    }
  })

  it('never resurrects stale cached conditions/reason: the write is a targeted /status/lifecycle op', async () => {
    const { reconciler, customApi } = createReconciler()
    // FRESH carries the converged conditions + heartbeat reason a hardened
    // sibling wrote AFTER the cached snapshot was captured.
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshWakeHostResponse({
        wakeRequested: '2',
        state: 'suspended',
        reason: 'sibling-written-reason',
      })
    )
    // CACHED snapshot: stale conditions and a stale lifecycle reason that
    // pre-date the sibling's write.
    const host = makeWakeHost({ wakeRequested: '2', state: 'suspended' })
    host.status = {
      lifecycle: { state: 'suspended', wakeHandledGeneration: 0, reason: 'stale-cached-reason' },
      conditions: [
        {
          type: 'StatelessEnableRejected',
          status: 'True',
          reason: 'StaleCachedCondition',
          message: 'stale cached condition',
          lastTransitionTime: '2020-01-01T00:00:00.000Z',
        },
      ],
    }
    await reconciler.reconcile(host)

    // The fast-path emits ONLY the targeted lifecycle op (plus the D3
    // resourceVersion precondition): the whole-/status spread that would
    // resurrect the stale cached conditions over the sibling's fresher ones
    // is gone, and the stale cached reason is dropped, not written.
    const [firstPatch] = customApi.patchNamespacedCustomObjectStatus.mock.calls
    const body = (firstPatch[0] as { body: Array<{ op: string; path: string; value: unknown }> })
      .body
    expect(body.filter(op => op.path !== '/metadata/resourceVersion')).toEqual([
      {
        op: 'add',
        path: '/status/lifecycle',
        value: { state: 'active', wakeHandledGeneration: 2 },
      },
    ])
    expect(body.some(op => op.path === '/status' || op.path === '/status/conditions')).toBe(false)
  })

  it('normal wake: fresh requested > handled flips to active with the fresh generation, each phase once', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { reconciler, appsApi, customApi } = createReconciler()
      customApi.getNamespacedCustomObject.mockResolvedValue(
        freshWakeHostResponse({ wakeRequested: '5', state: 'suspended' })
      )
      await reconciler.reconcile(makeWakeHost({ wakeRequested: '5', state: 'suspended' }))

      const writes = lifecycleStatusWrites(customApi)
      expect(writes[0].lifecycle).toEqual({ state: 'active', wakeHandledGeneration: 5 })
      expect(appsApi.patchNamespacedDeployment).toHaveBeenCalledTimes(1)
      const phases = logSpy.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.startsWith('[StatelessWake]'))
        .map(line => /phase=(\w+)/.exec(line)?.[1])
      expect(phases).toEqual(['wake_observed', 'status_flipped', 'replicas_patched'])
    } finally {
      logSpy.mockRestore()
    }
  })

  it('409 conflict: re-reads fresh and retries, then completes the wake (D3 idiom)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { reconciler, appsApi, customApi } = createReconciler()
      customApi.getNamespacedCustomObject.mockResolvedValue(
        freshWakeHostResponse({ wakeRequested: '2', state: 'suspended' })
      )
      customApi.patchNamespacedCustomObjectStatus.mockRejectedValueOnce(conflict409())
      await reconciler.reconcile(makeWakeHost({ wakeRequested: '2', state: 'suspended' }))

      // Attempt 1 (409) + attempt 2 (success); the heavy body's status write
      // is a converged no-op after the flip.
      expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(2)
      // The retry re-READ fresh before re-building (initial read + 409 re-read).
      expect(customApi.getNamespacedCustomObject.mock.calls.length).toBeGreaterThanOrEqual(2)
      const writes = lifecycleStatusWrites(customApi)
      expect(writes.at(-1)?.lifecycle).toEqual({ state: 'active', wakeHandledGeneration: 2 })
      expect(appsApi.patchNamespacedDeployment).toHaveBeenCalledTimes(1)
      const flipped = logSpy.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.includes('phase=status_flipped'))
      expect(flipped).toHaveLength(1)
    } finally {
      logSpy.mockRestore()
    }
  })

  it('409 conflict then FRESH shows the wake handled: the retry skips instead of double-writing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { reconciler, appsApi, customApi } = createReconciler()
      customApi.getNamespacedCustomObject
        .mockResolvedValueOnce(freshWakeHostResponse({ wakeRequested: '2', state: 'suspended' }))
        // The racing writer that caused the 409 handled the wake itself.
        .mockResolvedValue(
          freshWakeHostResponse({ wakeRequested: '2', state: 'active', wakeHandledGeneration: 2 })
        )
      customApi.patchNamespacedCustomObjectStatus.mockRejectedValueOnce(conflict409())
      await reconciler.reconcile(makeWakeHost({ wakeRequested: '2', state: 'suspended' }))

      // Only the 409'd attempt reached the API — the re-decided build skipped.
      expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
      expect(appsApi.patchNamespacedDeployment).not.toHaveBeenCalled()
      const flipped = logSpy.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.includes('phase=status_flipped'))
      expect(flipped).toEqual([])
    } finally {
      logSpy.mockRestore()
    }
  })
})
