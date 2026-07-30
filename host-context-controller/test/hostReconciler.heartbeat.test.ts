import { describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { HostReconciler } from '../src/hostReconciler'
import { HostCRD, HostCrdStatus } from '../src/types'
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
  mintHostGfsToken: vi.fn(async (namespace: string, name: string) => ({
    ['to' + 'ken']: 'gfs-runtime-value',
    expiresInSeconds: 600,
    subject: `host:1st:${namespace}/${name}`,
  })),
}))

function makeStatelessHost(
  overrides: {
    name?: string
    spec?: Partial<HostCRD['spec']>
    status?: HostCrdStatus
    annotations?: Record<string, string>
  } = {}
): HostCRD {
  const name = overrides.name ?? 'stateless-host'
  return {
    name,
    namespace: 'mcp-host',
    ...(overrides.annotations ? { annotations: overrides.annotations } : {}),
    spec: {
      host: name,
      contextRef: 'context-a',
      secretRef: 'host-secret',
      lifecycle: { stateless: true },
      ...overrides.spec,
    },
    ...(overrides.status ? { status: overrides.status } : {}),
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
    // Heartbeat cases model the steady state after the watcher completed its
    // CommunicationChannel initial list. Cache-startup fail-closed behavior
    // is covered in hostReconciler.lifecycle.test.ts.
    isCommunicationChannelCacheSynced: () => true,
  })

  return { reconciler, appsApi, coreApi, networkingApi, rbacApi, customApi }
}

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
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
 * Raw CustomObjects GET response served to the fresh-read guard inside the
 * heartbeat-path status writers (HostReconciler.readFreshHost). The guard is
 * authoritative over the caller's snapshot, so each test states the
 * server-side truth explicitly.
 */
function freshHostRead(lifecycle?: {
  state: 'active' | 'draining' | 'suspended'
  wakeHandledGeneration: number
  reason?: string
}) {
  return {
    metadata: { name: 'stateless-host', namespace: 'mcp-host' },
    spec: {
      host: 'stateless-host',
      contextRef: 'context-a',
      secretRef: 'host-secret',
      lifecycle: { stateless: true },
    },
    ...(lifecycle ? { status: { lifecycle } } : {}),
  }
}

describe('HostReconciler heartbeat mutation admission', () => {
  const heartbeatMutations = [
    {
      name: 'suspend',
      core: 'suspendHostFromHeartbeatCore',
      coreArgs: ['idle', 0] as const,
      freshLifecycle: { state: 'draining', wakeHandledGeneration: 0 } as const,
      invoke: (reconciler: HostReconciler, host: HostCRD) =>
        reconciler.suspendHostFromHeartbeat(host, 'idle', 0),
    },
    {
      name: 'suspend-blocked reason',
      core: 'publishSuspendBlockedReasonCore',
      coreArgs: ['suspend-blocked: activeTask'] as const,
      freshLifecycle: { state: 'active', wakeHandledGeneration: 0 } as const,
      invoke: (reconciler: HostReconciler, host: HostCRD) =>
        reconciler.publishSuspendBlockedReason(host, 'suspend-blocked: activeTask'),
    },
    {
      name: 'draining',
      core: 'markHostDrainingFromHeartbeatCore',
      coreArgs: [0] as const,
      freshLifecycle: { state: 'active', wakeHandledGeneration: 0 } as const,
      invoke: (reconciler: HostReconciler, host: HostCRD) =>
        reconciler.markHostDrainingFromHeartbeat(host, 0),
    },
    {
      name: 'cancel-drain',
      core: 'markHostActiveFromHeartbeatCore',
      coreArgs: [] as const,
      freshLifecycle: { state: 'draining', wakeHandledGeneration: 0 } as const,
      invoke: (reconciler: HostReconciler, host: HostCRD) =>
        reconciler.markHostActiveFromHeartbeat(host),
    },
  ] as const

  it.each(heartbeatMutations)(
    'rejects queued $name work when Host authority changes before serializer admission',
    async ({ core, invoke }) => {
      const { reconciler } = createReconciler()
      const host = { ...makeStatelessHost(), uid: 'heartbeat-host-uid', generation: 1 }
      const authority = { current: { known: true, generation: 7 } }
      reconciler.setResolveCurrentHost(name => (name === host.name ? host : undefined))
      reconciler.setHostWatchAuthority(() => authority.current)
      const lifecycle = (reconciler as any).lifecycle
      const coreSpy = vi.spyOn(lifecycle, core).mockResolvedValue(undefined)
      const blockerStarted = deferred()
      const releaseBlocker = deferred()
      const occupied = lifecycle.serializeByHost(host.name, async () => {
        blockerStarted.resolve(undefined)
        await releaseBlocker.promise
      }) as Promise<void>
      await blockerStarted.promise

      const pending = invoke(reconciler, host)
      authority.current = { known: false, generation: 8 }
      releaseBlocker.resolve(undefined)
      await occupied

      await expect(pending).rejects.toThrow(/Host inventory authority/)
      expect(coreSpy).not.toHaveBeenCalled()
    }
  )

  it.each(heartbeatMutations)(
    'rejects queued $name work when the Host UID changes before serializer admission',
    async ({ core, invoke }) => {
      const { reconciler } = createReconciler()
      const requested = { ...makeStatelessHost(), uid: 'heartbeat-host-old-uid', generation: 4 }
      let current = requested
      const authority = { current: { known: true, generation: 9 } }
      reconciler.setResolveCurrentHost(name => (name === requested.name ? current : undefined))
      reconciler.setHostWatchAuthority(() => authority.current)
      const lifecycle = (reconciler as any).lifecycle
      const coreSpy = vi.spyOn(lifecycle, core).mockResolvedValue(undefined)
      const blockerStarted = deferred()
      const releaseBlocker = deferred()
      const occupied = lifecycle.serializeByHost(requested.name, async () => {
        blockerStarted.resolve(undefined)
        await releaseBlocker.promise
      }) as Promise<void>
      await blockerStarted.promise

      const pending = invoke(reconciler, requested)
      current = { ...requested, uid: 'heartbeat-host-new-uid', generation: 1 }
      releaseBlocker.resolve(undefined)
      await occupied

      await expect(pending).rejects.toThrow(/Host identity/)
      expect(coreSpy).not.toHaveBeenCalled()
    }
  )

  it.each(heartbeatMutations)(
    'admits the latest same-UID same-spec Host snapshot for $name inside the heartbeat serializer',
    async ({ core, coreArgs, invoke }) => {
      const { reconciler } = createReconciler()
      const requested = { ...makeStatelessHost(), uid: 'heartbeat-host-uid', generation: 4 }
      const current = {
        ...requested,
        resourceVersion: 'cache-rv-latest',
        status: { lifecycle: { state: 'active' as const, wakeHandledGeneration: 2 } },
      }
      reconciler.setResolveCurrentHost(name => (name === requested.name ? current : undefined))
      reconciler.setHostWatchAuthority(() => ({ known: true, generation: 12 }))
      const lifecycle = (reconciler as any).lifecycle
      const coreSpy = vi.spyOn(lifecycle, core).mockResolvedValue(undefined)

      await invoke(reconciler, requested)

      expect(coreSpy).toHaveBeenCalledOnce()
      expect(coreSpy).toHaveBeenCalledWith(current, ...coreArgs, expect.any(Function))
    }
  )

  it.each(heartbeatMutations)(
    'rejects a $name 409 retry that resolves to a recreated same-name Host',
    async ({ freshLifecycle, invoke }) => {
      const { reconciler, customApi } = createReconciler()
      const host = {
        ...makeStatelessHost({ status: { lifecycle: freshLifecycle } }),
        uid: 'heartbeat-host-old-uid',
        generation: 4,
      }
      reconciler.setResolveCurrentHost(name => (name === host.name ? host : undefined))
      reconciler.setHostWatchAuthority(() => ({ known: true, generation: 15 }))
      customApi.getNamespacedCustomObject
        .mockResolvedValueOnce({
          ...freshHostRead(freshLifecycle),
          metadata: {
            name: host.name,
            namespace: host.namespace,
            uid: host.uid,
            generation: 4,
            resourceVersion: 'rv-old',
          },
        })
        .mockResolvedValueOnce({
          ...freshHostRead(freshLifecycle),
          metadata: {
            name: host.name,
            namespace: host.namespace,
            uid: 'heartbeat-host-new-uid',
            generation: 1,
            resourceVersion: 'rv-new',
          },
        })
      customApi.patchNamespacedCustomObjectStatus
        .mockRejectedValueOnce({ code: 409 })
        .mockResolvedValueOnce(undefined)

      await expect(invoke(reconciler, host)).rejects.toThrow(/Host identity/)
      expect(customApi.getNamespacedCustomObject).toHaveBeenCalledTimes(2)
      expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
    }
  )

  it.each(heartbeatMutations)(
    'rejects queued $name work when the same Host advances to a new spec generation',
    async ({ core, invoke }) => {
      const { reconciler } = createReconciler()
      const requested = { ...makeStatelessHost(), uid: 'heartbeat-host-uid', generation: 4 }
      let current = requested
      reconciler.setResolveCurrentHost(name => (name === requested.name ? current : undefined))
      reconciler.setHostWatchAuthority(() => ({ known: true, generation: 13 }))
      const lifecycle = (reconciler as any).lifecycle
      const coreSpy = vi.spyOn(lifecycle, core).mockResolvedValue(undefined)
      const blockerStarted = deferred()
      const releaseBlocker = deferred()
      const occupied = lifecycle.serializeByHost(requested.name, async () => {
        blockerStarted.resolve(undefined)
        await releaseBlocker.promise
      }) as Promise<void>
      await blockerStarted.promise

      const pending = invoke(reconciler, requested)
      current = {
        ...requested,
        generation: 5,
        spec: { ...requested.spec, contextRef: 'new-runtime-context' },
      }
      releaseBlocker.resolve(undefined)
      await occupied

      await expect(pending).rejects.toThrow(/Host spec generation/)
      expect(coreSpy).not.toHaveBeenCalled()
    }
  )

  it.each(heartbeatMutations)(
    'does not apply stale $name evidence to a newer same-UID stateless spec',
    async ({ freshLifecycle, invoke }) => {
      const { reconciler, customApi } = createReconciler()
      const host = {
        ...makeStatelessHost({ status: { lifecycle: freshLifecycle } }),
        uid: 'heartbeat-host-uid',
        generation: 4,
      }
      reconciler.setResolveCurrentHost(name => (name === host.name ? host : undefined))
      reconciler.setHostWatchAuthority(() => ({ known: true, generation: 14 }))
      customApi.getNamespacedCustomObject.mockResolvedValue({
        ...freshHostRead(freshLifecycle),
        metadata: {
          name: host.name,
          namespace: host.namespace,
          uid: host.uid,
          generation: 5,
          resourceVersion: 'rv-new-spec',
        },
        spec: { ...host.spec, contextRef: 'new-runtime-context' },
      })
      const reconcileCore = vi
        .spyOn(reconciler as any, 'reconcileCore')
        .mockResolvedValue(undefined)

      await invoke(reconciler, host)

      expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
      expect(reconcileCore).not.toHaveBeenCalled()
    }
  )

  it.each(heartbeatMutations)(
    'does not apply stale $name evidence after the same-UID Host becomes stateful',
    async ({ invoke }) => {
      const { reconciler, customApi } = createReconciler()
      const host = { ...makeStatelessHost(), uid: 'heartbeat-host-uid', generation: 4 }
      reconciler.setResolveCurrentHost(name => (name === host.name ? host : undefined))
      reconciler.setHostWatchAuthority(() => ({ known: true, generation: 16 }))
      customApi.getNamespacedCustomObject.mockResolvedValue({
        ...freshHostRead({ state: 'active', wakeHandledGeneration: 0 }),
        metadata: {
          name: host.name,
          namespace: host.namespace,
          uid: host.uid,
          generation: 5,
          resourceVersion: 'rv-stateful',
        },
        spec: {
          ...host.spec,
          lifecycle: { stateless: false },
        },
      })
      const reconcileCore = vi
        .spyOn(reconciler as any, 'reconcileCore')
        .mockResolvedValue(undefined)

      await invoke(reconciler, host)

      expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
      expect(reconcileCore).not.toHaveBeenCalled()
    }
  )

  it('does not retry stale heartbeat evidence after a 409 reveals a same-UID stateful spec', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = { ...makeStatelessHost(), uid: 'heartbeat-host-uid', generation: 4 }
    reconciler.setResolveCurrentHost(name => (name === host.name ? host : undefined))
    reconciler.setHostWatchAuthority(() => ({ known: true, generation: 17 }))
    customApi.getNamespacedCustomObject
      .mockResolvedValueOnce({
        ...freshHostRead({ state: 'active', wakeHandledGeneration: 0 }),
        metadata: {
          name: host.name,
          namespace: host.namespace,
          uid: host.uid,
          generation: 4,
          resourceVersion: 'rv-stateless',
        },
      })
      .mockResolvedValueOnce({
        ...freshHostRead({ state: 'active', wakeHandledGeneration: 0 }),
        metadata: {
          name: host.name,
          namespace: host.namespace,
          uid: host.uid,
          generation: 5,
          resourceVersion: 'rv-stateful',
        },
        spec: {
          ...host.spec,
          lifecycle: { stateless: false },
        },
      })
    customApi.patchNamespacedCustomObjectStatus.mockRejectedValueOnce({ code: 409 })

    await reconciler.markHostDrainingFromHeartbeat(host, 0)

    expect(customApi.getNamespacedCustomObject).toHaveBeenCalledTimes(2)
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
  })

  it('does not retry stale heartbeat evidence after a 409 reveals a newer stateless spec', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = { ...makeStatelessHost(), uid: 'heartbeat-host-uid', generation: 4 }
    reconciler.setResolveCurrentHost(name => (name === host.name ? host : undefined))
    reconciler.setHostWatchAuthority(() => ({ known: true, generation: 17 }))
    customApi.getNamespacedCustomObject
      .mockResolvedValueOnce({
        ...freshHostRead({ state: 'active', wakeHandledGeneration: 0 }),
        metadata: {
          name: host.name,
          namespace: host.namespace,
          uid: host.uid,
          generation: 4,
          resourceVersion: 'rv-old-spec',
        },
      })
      .mockResolvedValueOnce({
        ...freshHostRead({ state: 'active', wakeHandledGeneration: 0 }),
        metadata: {
          name: host.name,
          namespace: host.namespace,
          uid: host.uid,
          generation: 5,
          resourceVersion: 'rv-new-spec',
        },
        spec: { ...host.spec, contextRef: 'new-runtime-context' },
      })
    customApi.patchNamespacedCustomObjectStatus.mockRejectedValueOnce({ code: 409 })

    await reconciler.markHostDrainingFromHeartbeat(host, 0)

    expect(customApi.getNamespacedCustomObject).toHaveBeenCalledTimes(2)
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
  })

  it('revalidates authority after the fresh read and before the first status patch', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = { ...makeStatelessHost(), uid: 'heartbeat-host-uid', generation: 4 }
    const authority = { current: { known: true, generation: 18 } }
    reconciler.setResolveCurrentHost(name => (name === host.name ? host : undefined))
    reconciler.setHostWatchAuthority(() => authority.current)
    customApi.getNamespacedCustomObject.mockImplementation(async () => {
      authority.current = { known: false, generation: 19 }
      return {
        ...freshHostRead({ state: 'active', wakeHandledGeneration: 0 }),
        metadata: {
          name: host.name,
          namespace: host.namespace,
          uid: host.uid,
          resourceVersion: 'rv-authority-lost',
        },
      }
    })

    await expect(reconciler.markHostDrainingFromHeartbeat(host, 0)).rejects.toThrow(
      /Host inventory authority/
    )
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('revalidates authority before a 409 retry performs another fresh read', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = { ...makeStatelessHost(), uid: 'heartbeat-host-uid', generation: 4 }
    const authority = { current: { known: true, generation: 21 } }
    reconciler.setResolveCurrentHost(name => (name === host.name ? host : undefined))
    reconciler.setHostWatchAuthority(() => authority.current)
    customApi.getNamespacedCustomObject.mockResolvedValue({
      ...freshHostRead({ state: 'active', wakeHandledGeneration: 0 }),
      metadata: {
        name: host.name,
        namespace: host.namespace,
        uid: host.uid,
        generation: 4,
        resourceVersion: 'rv-before-conflict',
      },
    })
    customApi.patchNamespacedCustomObjectStatus.mockImplementationOnce(async () => {
      authority.current = { known: false, generation: 22 }
      throw { code: 409 }
    })

    await expect(reconciler.markHostDrainingFromHeartbeat(host, 0)).rejects.toThrow(
      /Host inventory authority/
    )
    expect(customApi.getNamespacedCustomObject).toHaveBeenCalledTimes(1)
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
  })

  it('does not reconcile runtime effects after suspend when the Host UID changes', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = {
      ...makeStatelessHost({
        status: { lifecycle: { state: 'draining', wakeHandledGeneration: 0 } },
      }),
      uid: 'heartbeat-host-old-uid',
      generation: 4,
    }
    let current = host
    reconciler.setResolveCurrentHost(name => (name === host.name ? current : undefined))
    reconciler.setHostWatchAuthority(() => ({ known: true, generation: 24 }))
    const reconcileCore = vi.spyOn(reconciler as any, 'reconcileCore').mockResolvedValue(undefined)
    customApi.getNamespacedCustomObject.mockResolvedValue({
      ...freshHostRead({ state: 'draining', wakeHandledGeneration: 0 }),
      metadata: {
        name: host.name,
        namespace: host.namespace,
        uid: host.uid,
        generation: 4,
        resourceVersion: 'rv-suspend',
      },
    })
    customApi.patchNamespacedCustomObjectStatus.mockImplementationOnce(async () => {
      current = { ...host, uid: 'heartbeat-host-new-uid', generation: 1 }
    })

    await expect(reconciler.suspendHostFromHeartbeat(host, 'idle', 0)).rejects.toThrow(
      /Host identity/
    )
    expect(reconcileCore).not.toHaveBeenCalled()
  })

  it('reconciles suspend follow-on effects from the successful fresh same-UID Host spec', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = {
      ...makeStatelessHost({
        spec: { contextRef: 'latest-context' },
        status: { lifecycle: { state: 'draining', wakeHandledGeneration: 0 } },
      }),
      uid: 'heartbeat-host-uid',
      generation: 5,
    }
    reconciler.setResolveCurrentHost(name => (name === host.name ? host : undefined))
    reconciler.setHostWatchAuthority(() => ({ known: true, generation: 26 }))
    const reconcileCore = vi.spyOn(reconciler as any, 'reconcileCore').mockResolvedValue(undefined)
    customApi.getNamespacedCustomObject
      .mockResolvedValueOnce({
        ...freshHostRead({ state: 'draining', wakeHandledGeneration: 0 }),
        metadata: {
          name: host.name,
          namespace: host.namespace,
          uid: host.uid,
          generation: 5,
          resourceVersion: 'rv-suspend-current',
        },
        spec: { ...host.spec, contextRef: 'latest-context' },
      })
      .mockResolvedValue({
        ...freshHostRead({
          state: 'suspended',
          wakeHandledGeneration: 0,
          reason: 'idle',
        }),
        metadata: {
          name: host.name,
          namespace: host.namespace,
          uid: host.uid,
          generation: 5,
          resourceVersion: 'rv-suspend-committed',
        },
        spec: { ...host.spec, contextRef: 'latest-context' },
      })

    await reconciler.suspendHostFromHeartbeat(host, 'idle', 0)

    expect(reconcileCore).toHaveBeenCalledOnce()
    const reconciledHost = reconcileCore.mock.calls[0][0] as HostCRD
    expect(reconciledHost).toMatchObject({
      uid: host.uid,
      generation: 5,
      spec: expect.objectContaining({ contextRef: 'latest-context' }),
    })
    expect(reconciledHost.status?.lifecycle).toEqual({
      state: 'suspended',
      wakeHandledGeneration: 0,
      reason: 'idle',
    })
  })

  it('rejects a known-identity status write without a fresh resourceVersion', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = { ...makeStatelessHost(), uid: 'heartbeat-host-uid', generation: 4 }
    reconciler.setResolveCurrentHost(name => (name === host.name ? host : undefined))
    reconciler.setHostWatchAuthority(() => ({ known: true, generation: 28 }))
    customApi.getNamespacedCustomObject.mockResolvedValue({
      ...freshHostRead({ state: 'active', wakeHandledGeneration: 0 }),
      metadata: { name: host.name, namespace: host.namespace, uid: host.uid },
    })

    await expect(reconciler.markHostDrainingFromHeartbeat(host, 0)).rejects.toThrow(
      /no fresh resourceVersion/
    )
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('retries a 409 on the same UID and uses the latest Host for suspend follow-on effects', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = {
      ...makeStatelessHost({
        status: { lifecycle: { state: 'draining', wakeHandledGeneration: 0 } },
      }),
      uid: 'heartbeat-host-uid',
      generation: 4,
    }
    let current = host
    reconciler.setResolveCurrentHost(name => (name === host.name ? current : undefined))
    reconciler.setHostWatchAuthority(() => ({ known: true, generation: 30 }))
    const reconcileCore = vi.spyOn(reconciler as any, 'reconcileCore').mockResolvedValue(undefined)
    customApi.getNamespacedCustomObject
      .mockResolvedValueOnce({
        ...freshHostRead({ state: 'draining', wakeHandledGeneration: 0 }),
        metadata: {
          name: host.name,
          namespace: host.namespace,
          uid: host.uid,
          generation: 4,
          resourceVersion: 'rv-1',
        },
      })
      .mockResolvedValueOnce({
        ...freshHostRead({ state: 'draining', wakeHandledGeneration: 0 }),
        metadata: {
          name: host.name,
          namespace: host.namespace,
          uid: host.uid,
          generation: 4,
          resourceVersion: 'rv-2',
        },
        spec: host.spec,
      })
      .mockResolvedValueOnce({
        ...freshHostRead({
          state: 'suspended',
          wakeHandledGeneration: 0,
          reason: 'idle',
        }),
        metadata: {
          name: host.name,
          namespace: host.namespace,
          uid: host.uid,
          generation: 4,
          resourceVersion: 'rv-3',
        },
        spec: host.spec,
      })
    customApi.patchNamespacedCustomObjectStatus
      .mockImplementationOnce(async () => {
        current = {
          ...host,
          resourceVersion: 'cache-rv-after-conflict',
        }
        throw { code: 409 }
      })
      .mockResolvedValueOnce(undefined)

    await reconciler.suspendHostFromHeartbeat(host, 'idle', 0)

    expect(customApi.getNamespacedCustomObject).toHaveBeenCalledTimes(3)
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(2)
    expect(reconcileCore.mock.calls[0][0]).toMatchObject({
      uid: host.uid,
      generation: 4,
      spec: expect.objectContaining({ contextRef: 'context-a' }),
    })
  })

  it('does not apply or record suspension when only the follow-on GET observes a newer spec', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = {
      ...makeStatelessHost({
        status: { lifecycle: { state: 'draining', wakeHandledGeneration: 0 } },
      }),
      uid: 'heartbeat-host-uid',
      generation: 4,
    }
    reconciler.setResolveCurrentHost(name => (name === host.name ? host : undefined))
    reconciler.setHostWatchAuthority(() => ({ known: true, generation: 33 }))
    customApi.getNamespacedCustomObject
      .mockResolvedValueOnce({
        ...freshHostRead({ state: 'draining', wakeHandledGeneration: 0 }),
        metadata: {
          name: host.name,
          namespace: host.namespace,
          uid: host.uid,
          generation: 4,
          resourceVersion: 'rv-suspend-write',
        },
      })
      .mockResolvedValueOnce({
        ...freshHostRead({
          state: 'suspended',
          wakeHandledGeneration: 0,
          reason: 'idle',
        }),
        metadata: {
          name: host.name,
          namespace: host.namespace,
          uid: host.uid,
          generation: 5,
          resourceVersion: 'rv-new-spec',
        },
        spec: {
          ...host.spec,
          contextRef: 'replacement-context',
          lifecycle: { stateless: false },
        },
      })
    const reconcileCore = vi.spyOn(reconciler as any, 'reconcileCore').mockResolvedValue(undefined)
    const recordSuspended = vi.spyOn((reconciler as any).lifecycle, 'recordSuspendedApplied')

    await expect(reconciler.suspendHostFromHeartbeat(host, 'idle', 0)).rejects.toThrow(
      /Host spec generation/
    )

    expect(reconcileCore).not.toHaveBeenCalled()
    expect(recordSuspended).not.toHaveBeenCalled()
  })

  it('rejects stale suspend follow-on work when the Host spec changes during Secret validation', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = {
      ...makeStatelessHost({
        status: { lifecycle: { state: 'draining', wakeHandledGeneration: 0 } },
      }),
      uid: 'heartbeat-host-uid',
      generation: 4,
    }
    let current = host
    reconciler.setResolveCurrentHost(name => (name === host.name ? current : undefined))
    reconciler.setHostWatchAuthority(() => ({ known: true, generation: 34 }))
    customApi.getNamespacedCustomObject
      .mockResolvedValueOnce({
        ...freshHostRead({ state: 'draining', wakeHandledGeneration: 0 }),
        metadata: {
          name: host.name,
          namespace: host.namespace,
          uid: host.uid,
          generation: 4,
          resourceVersion: 'rv-suspend-write',
        },
      })
      .mockResolvedValueOnce({
        ...freshHostRead({
          state: 'suspended',
          wakeHandledGeneration: 0,
          reason: 'idle',
        }),
        metadata: {
          name: host.name,
          namespace: host.namespace,
          uid: host.uid,
          generation: 4,
          resourceVersion: 'rv-suspend-follow-on',
        },
      })
    const secretReadStarted = deferred()
    const releaseSecretRead = deferred()
    vi.spyOn(reconciler as any, 'validateHostSecret').mockImplementation(async () => {
      secretReadStarted.resolve(undefined)
      await releaseSecretRead.promise
      return { ok: true }
    })
    const staleMutation = vi
      .spyOn(reconciler as any, 'ensureHostServiceAccount')
      .mockRejectedValue(new Error('stale follow-on mutation was admitted'))

    const pending = reconciler.suspendHostFromHeartbeat(host, 'idle', 0)
    await secretReadStarted.promise
    current = {
      ...host,
      generation: 5,
      spec: {
        ...host.spec,
        contextRef: 'replacement-context',
        lifecycle: { stateless: false },
      },
    }
    releaseSecretRead.resolve(undefined)

    await expect(pending).rejects.toThrow(/Host spec generation/)
    expect(staleMutation).not.toHaveBeenCalled()
  })

  it('does not record a suspended scale-down when follow-on reconcile handles a wake', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = {
      ...makeStatelessHost({
        status: { lifecycle: { state: 'draining', wakeHandledGeneration: 0 } },
      }),
      uid: 'heartbeat-host-uid',
      generation: 4,
    }
    reconciler.setResolveCurrentHost(name => (name === host.name ? host : undefined))
    reconciler.setHostWatchAuthority(() => ({ known: true, generation: 32 }))
    customApi.getNamespacedCustomObject.mockResolvedValue({
      ...freshHostRead({ state: 'draining', wakeHandledGeneration: 0 }),
      metadata: {
        name: host.name,
        namespace: host.namespace,
        uid: host.uid,
        generation: 4,
        resourceVersion: 'rv-wake-follow-on',
      },
    })
    vi.spyOn(reconciler as any, 'reconcileCore').mockImplementation(async (...args: unknown[]) => {
      const reconcileHost = args[0] as HostCRD
      reconcileHost.annotations = { 'clerum.io/wake-requested': '1' }
      reconcileHost.status = {
        lifecycle: { state: 'active', wakeHandledGeneration: 1 },
      }
    })
    const recordSuspended = vi.spyOn((reconciler as any).lifecycle, 'recordSuspendedApplied')

    await expect(reconciler.suspendHostFromHeartbeat(host, 'idle', 0)).resolves.toBe('suspended')

    expect(recordSuspended).not.toHaveBeenCalled()
  })
})

describe('HostReconciler.suspendHostFromHeartbeat', () => {
  it('does not mutate the admitted watch-cache snapshot while applying a suspension', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'draining', wakeHandledGeneration: 2 } },
    })
    host.uid = 'stateless-host-uid'
    host.generation = 1
    host.resourceVersion = 'cache-rv'
    const snapshot = structuredClone(host)
    Object.freeze(host)
    reconciler.setResolveCurrentHost(name => (name === host.name ? host : undefined))
    reconciler.setHostMutationAuthority(() => ({
      known: true,
      hostGeneration: 1,
      contextGeneration: 1,
    }))
    const draining = freshHostRead({ state: 'draining', wakeHandledGeneration: 2 })
    Object.assign(draining.metadata, {
      uid: host.uid,
      generation: host.generation,
      resourceVersion: 'draining-rv',
    })
    const suspended = freshHostRead({
      state: 'suspended',
      wakeHandledGeneration: 2,
      reason: 'idle',
    })
    Object.assign(suspended.metadata, {
      uid: host.uid,
      generation: host.generation,
      resourceVersion: 'suspended-rv',
    })
    customApi.getNamespacedCustomObject.mockResolvedValueOnce(draining).mockResolvedValue(suspended)

    await expect(reconciler.suspendHostFromHeartbeat(host, 'idle', 2)).resolves.toBe('suspended')
    expect(host).toEqual(snapshot)
  })

  it("writes state='suspended' + reason 'idle' durably, then reconciles to replicas=0", async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 2 } },
    })
    // Server timeline: draining when the suspend's fresh GET runs (the
    // poller's durable draining write already landed), suspended for every
    // read after the suspend PATCH — the FIX 1 replicas guard re-reads
    // fresh before deriving replicas.
    customApi.getNamespacedCustomObject
      .mockResolvedValueOnce(freshHostRead({ state: 'draining', wakeHandledGeneration: 2 }))
      .mockResolvedValue(
        freshHostRead({ state: 'suspended', wakeHandledGeneration: 2, reason: 'idle' })
      )

    await reconciler.suspendHostFromHeartbeat(host, 'idle', 2)

    const writes = lifecycleStatusWrites(customApi)
    expect(writes.length).toBeGreaterThanOrEqual(1)
    expect(writes[0].lifecycle).toEqual({
      state: 'suspended',
      wakeHandledGeneration: 2,
      reason: 'idle',
    })
    expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(0)
  })

  it('fails loud when the durable status write fails (no scale-down happens)', async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    customApi.patchNamespacedCustomObjectStatus.mockRejectedValue(new Error('api down'))
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 0 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'draining', wakeHandledGeneration: 0 })
    )

    await expect(reconciler.suspendHostFromHeartbeat(host, 'idle', 0)).rejects.toThrow('api down')
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('a pending wake beats the suspension: the reconcile flips back to active + replicas=1', async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    // clerum.io/wake-requested generation 7 > wakeHandledGeneration 2: the
    // wake fast-path inside reconcile() must win over the suspend request.
    const host = makeStatelessHost({
      annotations: { 'clerum.io/wake-requested': '7' },
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 2 } },
    })
    // Read 1 (the suspend commit's fresh guard): draining with no pending
    // wake yet — the suspend commits. Later reads (the fast-path's AP-1
    // commit-point read inside the follow-up reconcile): the durable wake
    // annotation is now visible on the suspended CR, so the fast-path
    // re-decides requested 7 > handled 2 from FRESH and wins.
    customApi.getNamespacedCustomObject
      .mockResolvedValueOnce(freshHostRead({ state: 'draining', wakeHandledGeneration: 2 }))
      .mockResolvedValue({
        ...freshHostRead({ state: 'suspended', wakeHandledGeneration: 2 }),
        metadata: {
          name: 'stateless-host',
          namespace: 'mcp-host',
          annotations: { 'clerum.io/wake-requested': '7' },
        },
      })

    await reconciler.suspendHostFromHeartbeat(host, 'idle', 2)

    expect(host.status?.lifecycle?.state).toBe('active')
    expect(host.status?.lifecycle?.wakeHandledGeneration).toBe(7)
    expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(1)
  })

  it('no-ops when a wake was handled after the suspend decision: fresh draining with a generation past the entry epoch', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { reconciler, appsApi, customApi } = createReconciler()
      // The tracker decided this suspend off a snapshot with handled=2 …
      const host = makeStatelessHost({
        status: { lifecycle: { state: 'draining', wakeHandledGeneration: 2 } },
      })
      // … but by the commit point a wake was handled (the fast-path bumped
      // the generation to 3) and an aged drain:true verdict re-persisted
      // `draining`. requested==handled → nothing would ever revive a
      // suspended Host, so the commit MUST no-op.
      customApi.getNamespacedCustomObject.mockResolvedValue(
        freshHostRead({ state: 'draining', wakeHandledGeneration: 3 })
      )

      await reconciler.suspendHostFromHeartbeat(host, 'idle', 2)

      expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
      expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
      expect(host.status?.lifecycle?.state).toBe('draining')
      const staleLines = logSpy.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.includes('phase=drained_report_stale'))
      expect(staleLines).toEqual([
        expect.stringMatching(
          /^\[StatelessSuspend\] host=stateless-host phase=drained_report_stale reason=wake_handled_since entryGeneration=2 freshGeneration=3 ts=\d+$/
        ),
      ])
    } finally {
      logSpy.mockRestore()
    }
  })

  it('no-ops when a wake is pending at the commit point (fresh requested > handled)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { reconciler, appsApi, customApi } = createReconciler()
      const host = makeStatelessHost({
        status: { lifecycle: { state: 'draining', wakeHandledGeneration: 2 } },
      })
      // Fresh carries a not-yet-handled wake annotation: requested 3 > handled 2.
      customApi.getNamespacedCustomObject.mockResolvedValue({
        metadata: {
          name: 'stateless-host',
          namespace: 'mcp-host',
          annotations: { 'clerum.io/wake-requested': '3' },
        },
        spec: {
          host: 'stateless-host',
          contextRef: 'context-a',
          secretRef: 'host-secret',
          lifecycle: { stateless: true },
        },
        status: { lifecycle: { state: 'draining', wakeHandledGeneration: 2 } },
      })

      await reconciler.suspendHostFromHeartbeat(host, 'idle', 2)

      expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
      expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
      const staleLines = logSpy.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.includes('phase=drained_report_stale'))
      expect(staleLines).toEqual([
        expect.stringMatching(
          /^\[StatelessSuspend\] host=stateless-host phase=drained_report_stale reason=wake_pending requestedGeneration=3 handledGeneration=2 ts=\d+$/
        ),
      ])
    } finally {
      logSpy.mockRestore()
    }
  })
})

describe('HostReconciler.publishSuspendBlockedReason', () => {
  it('writes the reason once and is change-only across repeats', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 0 } },
    })
    // AP-1 (9th costume): the writer decides against a FRESH read, not the
    // caller's snapshot. Fresh is active with no reason yet → first write lands.
    customApi.getNamespacedCustomObject.mockResolvedValueOnce(
      freshHostRead({ state: 'active', wakeHandledGeneration: 0 })
    )
    await reconciler.publishSuspendBlockedReason(host, 'SuspendBlocked: activeTask')
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
    expect(host.status?.lifecycle?.reason).toBe('SuspendBlocked: activeTask')

    // Same reason again → the fresh read now carries it → change-only no-op.
    customApi.getNamespacedCustomObject.mockResolvedValueOnce(
      freshHostRead({
        state: 'active',
        wakeHandledGeneration: 0,
        reason: 'SuspendBlocked: activeTask',
      })
    )
    await reconciler.publishSuspendBlockedReason(host, 'SuspendBlocked: activeTask')
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)

    // Different reason → one more write.
    customApi.getNamespacedCustomObject.mockResolvedValueOnce(
      freshHostRead({
        state: 'active',
        wakeHandledGeneration: 0,
        reason: 'SuspendBlocked: activeTask',
      })
    )
    await reconciler.publishSuspendBlockedReason(host, 'SuspendBlocked: pendingResults')
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(2)
    expect(host.status?.lifecycle?.reason).toBe('SuspendBlocked: pendingResults')
  })

  it('the published reason survives a subsequent full reconcile (accepted path preserves it)', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 0 } },
    })
    // AP-1 (9th costume): the publish itself decides against a FRESH read — an
    // active Host with no reason yet → the reason write lands.
    customApi.getNamespacedCustomObject.mockResolvedValueOnce(
      freshHostRead({ state: 'active', wakeHandledGeneration: 0 })
    )
    await reconciler.publishSuspendBlockedReason(host, 'SuspendBlocked: activeTask')
    // Server-side truth for the fresh-read the accepted-path status writer
    // performs (AP-1): the durable publishSuspendBlockedReason write already
    // landed, so the fresh Host is active + carries the heartbeat-managed
    // reason. The accepted path must re-source that reason from fresh.
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({
        state: 'active',
        wakeHandledGeneration: 0,
        reason: 'SuspendBlocked: activeTask',
      })
    )
    await reconciler.reconcile(host)

    const writes = lifecycleStatusWrites(customApi)
    const last = writes[writes.length - 1]
    expect(last.lifecycle).toEqual({
      state: 'active',
      wakeHandledGeneration: 0,
      reason: 'SuspendBlocked: activeTask',
    })
  })

  it('a rejection reason from assessLifecycle is NOT preserved as heartbeat-managed', async () => {
    const { reconciler, customApi } = createReconciler()
    // A previously-written rejection message in status.lifecycle.reason must
    // be cleared by the accepted path (only tracker-owned reasons survive).
    const host = makeStatelessHost({
      status: {
        lifecycle: {
          state: 'active',
          wakeHandledGeneration: 0,
          reason:
            '1 CommunicationChannel(s) reference this Host; disassociate them to enable the requested stateless lifecycle',
        },
      },
    })

    // Server-side truth for the fresh-read the accepted-path status writer
    // performs (AP-1): the fresh Host is active and still carries the stale
    // rejection reason. The accepted path re-sources state from fresh but
    // drops the reason because a rejection message is NOT heartbeat-managed.
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({
        state: 'active',
        wakeHandledGeneration: 0,
        reason:
          '1 CommunicationChannel(s) reference this Host; disassociate them to enable the requested stateless lifecycle',
      })
    )

    await reconciler.reconcile(host)

    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(1)
    expect(writes[0].lifecycle).toEqual({ state: 'active', wakeHandledGeneration: 0 })
  })

  it('AP-1 (9th costume): a cached-draining host whose fresh read is suspended does NOT write (no resurrection)', async () => {
    const { reconciler, customApi } = createReconciler()
    // The tracker's !idleEligible branch calls cancelDrainOnEvidence then
    // publishSuspendBlockedReason against the SAME host ref. cancelDrainOnEvidence
    // skipped (fresh already moved past draining) leaving host.status stale
    // `draining`. A suspend landed first on the chain, so the fresh read is
    // `suspended`. The reason writer must NOT re-source the stale draining and
    // write state back — it must no-op so it never resurrects the suspended Host.
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'draining', wakeHandledGeneration: 4 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'suspended', wakeHandledGeneration: 4, reason: 'idle' })
    )

    await reconciler.publishSuspendBlockedReason(host, 'SuspendBlocked: activeTask')

    // No write at all: a suspend-blocked reason is meaningless once suspended,
    // and writing it would resurrect the Host (replicas derive from state).
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    // The in-memory snapshot is untouched — the suspended Host is preserved.
    expect(host.status?.lifecycle?.state).toBe('draining')
  })

  it('AP-1 (9th costume): writes the reason on the FRESH active state via a targeted /status/lifecycle op', async () => {
    const { reconciler, customApi } = createReconciler()
    // Cached active; fresh read is active carrying a newer wakeHandledGeneration
    // than the snapshot (a wake landed since). The writer must stamp the reason
    // on the FRESH state (state:'active', gen from fresh), never the snapshot.
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 1 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'active', wakeHandledGeneration: 5 })
    )

    await reconciler.publishSuspendBlockedReason(host, 'SuspendBlocked: activeTask')

    const [patch] = customApi.patchNamespacedCustomObjectStatus.mock.calls
    const body = (patch[0] as { body: Array<{ op: string; path: string; value: unknown }> }).body
    // Targeted op — never a whole-/status spread.
    const lifecycleOp = body.find(op => op.path === '/status/lifecycle')
    if (!lifecycleOp) {
      throw new Error('expected a targeted /status/lifecycle op')
    }
    expect(body.some(op => op.path === '/status')).toBe(false)
    expect(lifecycleOp.value).toEqual({
      state: 'active',
      wakeHandledGeneration: 5,
      reason: 'SuspendBlocked: activeTask',
    })
    expect(host.status?.lifecycle).toEqual({
      state: 'active',
      wakeHandledGeneration: 5,
      reason: 'SuspendBlocked: activeTask',
    })
  })

  it('AP-1 (9th costume): a 409 re-reads fresh and retries under the D3 precondition', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 0 } },
    })
    // First fresh read (rv-1) is active → build proceeds; the patch 409s.
    // Second fresh read (rv-2) is STILL active → build re-runs and succeeds.
    customApi.getNamespacedCustomObject
      .mockResolvedValueOnce(
        freshHostReadWithRv('rv-1', { state: 'active', wakeHandledGeneration: 0 })
      )
      .mockResolvedValueOnce(
        freshHostReadWithRv('rv-2', { state: 'active', wakeHandledGeneration: 0 })
      )
    customApi.patchNamespacedCustomObjectStatus
      .mockRejectedValueOnce(conflict409())
      .mockResolvedValueOnce({})

    await reconciler.publishSuspendBlockedReason(host, 'SuspendBlocked: activeTask')

    expect(customApi.getNamespacedCustomObject.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(2)
    // The retry carried the re-read resourceVersion, proving it re-read fresh.
    const secondBody = (
      customApi.patchNamespacedCustomObjectStatus.mock.calls[1][0] as {
        body: Array<{ op: string; path: string; value: unknown }>
      }
    ).body
    expect(secondBody[0]).toEqual({ op: 'add', path: '/metadata/resourceVersion', value: 'rv-2' })
    expect(host.status?.lifecycle?.reason).toBe('SuspendBlocked: activeTask')
  })
})

describe('HostReconciler.findPodCreationTimestamp', () => {
  it('resolves the creationTimestamp of the pod matching the UID', async () => {
    const { reconciler, coreApi } = createReconciler()
    coreApi.listNamespacedPod.mockResolvedValue({
      items: [
        { metadata: { uid: 'pod-b', creationTimestamp: '2026-07-02T00:00:00Z' } },
        { metadata: { uid: 'pod-a', creationTimestamp: '2026-07-01T00:00:00Z' } },
      ],
    })
    const host = makeStatelessHost()

    const created = await reconciler.findPodCreationTimestamp(host, 'pod-a')
    expect(created).toEqual(new Date('2026-07-01T00:00:00Z'))
    expect(coreApi.listNamespacedPod).toHaveBeenCalledWith({
      namespace: 'mcp-host',
      labelSelector: 'app=stateless-host',
    })
  })

  it('returns null when no pod carries the UID', async () => {
    const { reconciler, coreApi } = createReconciler()
    coreApi.listNamespacedPod.mockResolvedValue({ items: [{ metadata: { uid: 'pod-x' } }] })
    expect(await reconciler.findPodCreationTimestamp(makeStatelessHost(), 'pod-a')).toBeNull()
  })
})

describe('HostReconciler stateless env — CLERUM_POD_UID downward API', () => {
  it('injects CLERUM_POD_UID via fieldRef metadata.uid on stateless hosts', () => {
    const { reconciler } = createReconciler()
    const dep = reconciler.buildDeployment(makeStatelessHost())
    const env = dep.spec?.template?.spec?.containers?.[0]?.env ?? []
    expect(env).toContainEqual({
      name: 'CLERUM_POD_UID',
      valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } },
    })
  })

  it('does not inject CLERUM_POD_UID on non-stateless hosts', () => {
    const { reconciler } = createReconciler()
    const dep = reconciler.buildDeployment(
      makeStatelessHost({ spec: { lifecycle: { stateless: false } } })
    )
    const names = (dep.spec?.template?.spec?.containers?.[0]?.env ?? []).map(e => e.name)
    expect(names).not.toContain('CLERUM_POD_UID')
  })
})

describe('HostReconciler.markHostDrainingFromHeartbeat', () => {
  it("flips an active Host to state='draining' durably (wake generation preserved, stale reason dropped)", async () => {
    const { reconciler, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: {
        lifecycle: {
          state: 'active',
          wakeHandledGeneration: 3,
          reason: 'suspend-blocked: activeTask',
        },
      },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({
        state: 'active',
        wakeHandledGeneration: 3,
        reason: 'suspend-blocked: activeTask',
      })
    )

    await reconciler.markHostDrainingFromHeartbeat(host, 3)

    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(1)
    expect(writes[0].lifecycle).toEqual({ state: 'draining', wakeHandledGeneration: 3 })
    // In-memory reflection so a same-pass drained report sees the flip.
    expect(host.status?.lifecycle?.state).toBe('draining')
  })

  it('is idempotent: an already-draining Host writes nothing', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'draining', wakeHandledGeneration: 1 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'draining', wakeHandledGeneration: 1 })
    )

    await reconciler.markHostDrainingFromHeartbeat(host, 1)
    await reconciler.markHostDrainingFromHeartbeat(host, 1)

    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('never clobbers a suspended Host back to draining', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'suspended', wakeHandledGeneration: 2, reason: 'idle' } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'suspended', wakeHandledGeneration: 2, reason: 'idle' })
    )

    await reconciler.markHostDrainingFromHeartbeat(host, 2)

    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    expect(host.status?.lifecycle?.state).toBe('suspended')
  })

  it('writes exactly once across repeated drain verdicts for the same episode', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 0 } },
    })
    // Server timeline: active for the first verdict, draining once the
    // durable write landed — the fresh-read guard makes the repeats no-ops.
    customApi.getNamespacedCustomObject
      .mockResolvedValueOnce(freshHostRead({ state: 'active', wakeHandledGeneration: 0 }))
      .mockResolvedValue(freshHostRead({ state: 'draining', wakeHandledGeneration: 0 }))

    await reconciler.markHostDrainingFromHeartbeat(host, 0)
    await reconciler.markHostDrainingFromHeartbeat(host, 0)
    await reconciler.markHostDrainingFromHeartbeat(host, 0)

    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
  })

  it('fails loud when the durable status write fails (no in-memory flip)', async () => {
    const { reconciler, customApi } = createReconciler()
    customApi.patchNamespacedCustomObjectStatus.mockRejectedValue(new Error('api conflict'))
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 0 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'active', wakeHandledGeneration: 0 })
    )

    await expect(reconciler.markHostDrainingFromHeartbeat(host, 0)).rejects.toThrow('api conflict')
    expect(host.status?.lifecycle?.state).toBe('active')
  })
})

describe('HostReconciler.markHostActiveFromHeartbeat', () => {
  it("reverts a draining Host to state='active' preserving the wake generation", async () => {
    const { reconciler, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'draining', wakeHandledGeneration: 4 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'draining', wakeHandledGeneration: 4 })
    )

    await reconciler.markHostActiveFromHeartbeat(host)

    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(1)
    expect(writes[0].lifecycle).toEqual({ state: 'active', wakeHandledGeneration: 4 })
    // In-memory reflection so a same-pass decision sees the revert.
    expect(host.status?.lifecycle?.state).toBe('active')
  })

  it('is a no-op on an already-active Host (no status write)', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 1 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'active', wakeHandledGeneration: 1 })
    )

    await reconciler.markHostActiveFromHeartbeat(host)

    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('never revives a suspended Host (that is the wake fast-path job)', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'suspended', wakeHandledGeneration: 2, reason: 'idle' } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'suspended', wakeHandledGeneration: 2, reason: 'idle' })
    )

    await reconciler.markHostActiveFromHeartbeat(host)

    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    expect(host.status?.lifecycle?.state).toBe('suspended')
  })

  it('fails loud when the durable status write fails (no in-memory flip)', async () => {
    const { reconciler, customApi } = createReconciler()
    customApi.patchNamespacedCustomObjectStatus.mockRejectedValue(new Error('api conflict'))
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'draining', wakeHandledGeneration: 0 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'draining', wakeHandledGeneration: 0 })
    )

    await expect(reconciler.markHostActiveFromHeartbeat(host)).rejects.toThrow('api conflict')
    expect(host.status?.lifecycle?.state).toBe('draining')
  })
})
describe('HostReconciler heartbeat cores — fresh-read guard (cross-instance staleness)', () => {
  // The Host watch callback builds a brand-new HostCRD per ADDED/MODIFIED
  // event, so two independently-triggered callers (drain-grace expiry vs the
  // next polled heartbeat) can hold DIFFERENT object instances for the same
  // host. The in-memory `host.status` reflection only helps same-instance
  // callers — each core must guard against a FRESH GET of the CR.

  it('closing-review scenario: a stale draining snapshot on a second instance cannot resurrect a just-suspended Host', async () => {
    const { reconciler, customApi } = createReconciler()
    // Two DISTINCT HostCRD instances for the same hostRef, as two watch
    // events produce (the watch callback REPLACES the map entry each time).
    const hostA = makeStatelessHost({
      status: { lifecycle: { state: 'draining', wakeHandledGeneration: 2 } },
    })
    const hostB = makeStatelessHost({
      status: { lifecycle: { state: 'draining', wakeHandledGeneration: 2 } },
    })
    // Server timeline: draining when the suspend's fresh GET runs, suspended
    // for every read after the suspend PATCH landed.
    customApi.getNamespacedCustomObject
      .mockResolvedValueOnce(freshHostRead({ state: 'draining', wakeHandledGeneration: 2 }))
      .mockResolvedValue(
        freshHostRead({ state: 'suspended', wakeHandledGeneration: 2, reason: 'idle' })
      )

    await reconciler.suspendHostFromHeartbeat(hostA, 'idle', 2)
    const writesAfterSuspend = lifecycleStatusWrites(customApi)
    expect(writesAfterSuspend[0].lifecycle?.state).toBe('suspended')

    // hostB's stale snapshot still says draining — the revert must observe
    // the FRESH suspended state and write NOTHING.
    await reconciler.markHostActiveFromHeartbeat(hostB)

    const writesAfterRevert = lifecycleStatusWrites(customApi)
    expect(writesAfterRevert).toHaveLength(writesAfterSuspend.length)
    // Final state stays suspended: no write ever asserted 'active'.
    expect(writesAfterRevert.every(w => w.lifecycle?.state !== 'active')).toBe(true)
  })

  it('cancel-drain takes wakeHandledGeneration from the FRESH lifecycle, not the stale snapshot', async () => {
    const { reconciler, customApi } = createReconciler()
    const staleHost = makeStatelessHost({
      status: { lifecycle: { state: 'draining', wakeHandledGeneration: 3 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'draining', wakeHandledGeneration: 7 })
    )

    await reconciler.markHostActiveFromHeartbeat(staleHost)

    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(1)
    expect(writes[0].lifecycle).toEqual({ state: 'active', wakeHandledGeneration: 7 })
  })

  it('suspend with a stale draining snapshot over a fresh active CR writes nothing and never scales down', async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    const staleHost = makeStatelessHost({
      status: { lifecycle: { state: 'draining', wakeHandledGeneration: 1 } },
    })
    // A cancel-drain (or wake) landed in between: the CR is active again.
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'active', wakeHandledGeneration: 1 })
    )

    await reconciler.suspendHostFromHeartbeat(staleHost, 'idle', 1)

    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('drain write with a stale active snapshot over a fresh suspended CR writes nothing', async () => {
    const { reconciler, customApi } = createReconciler()
    const staleHost = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 0 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'suspended', wakeHandledGeneration: 2, reason: 'idle' })
    )

    await reconciler.markHostDrainingFromHeartbeat(staleHost, 0)

    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    expect(staleHost.status?.lifecycle?.state).toBe('active')
  })

  it('suspendHostFromHeartbeat propagates a fresh GET failure (no patch)', async () => {
    const { reconciler, customApi } = createReconciler()
    customApi.getNamespacedCustomObject.mockRejectedValue(new Error('fresh get failed'))
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'draining', wakeHandledGeneration: 0 } },
    })

    await expect(reconciler.suspendHostFromHeartbeat(host, 'idle', 0)).rejects.toThrow(
      'fresh get failed'
    )
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('markHostDrainingFromHeartbeat propagates a fresh GET failure (no patch)', async () => {
    const { reconciler, customApi } = createReconciler()
    customApi.getNamespacedCustomObject.mockRejectedValue(new Error('fresh get failed'))
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 0 } },
    })

    await expect(reconciler.markHostDrainingFromHeartbeat(host, 0)).rejects.toThrow(
      'fresh get failed'
    )
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('markHostActiveFromHeartbeat propagates a fresh GET failure (no patch)', async () => {
    const { reconciler, customApi } = createReconciler()
    customApi.getNamespacedCustomObject.mockRejectedValue(new Error('fresh get failed'))
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'draining', wakeHandledGeneration: 0 } },
    })

    await expect(reconciler.markHostActiveFromHeartbeat(host)).rejects.toThrow('fresh get failed')
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })
})

/**
 * Raw CustomObjects GET response carrying a metadata.resourceVersion so the
 * D3 optimistic-concurrency precondition op is emitted (freshHostRead omits
 * it, exercising the no-precondition fallback).
 */
function freshHostReadWithRv(
  resourceVersion: string,
  lifecycle: {
    state: 'active' | 'draining' | 'suspended'
    wakeHandledGeneration: number
    reason?: string
  }
) {
  return {
    metadata: { name: 'stateless-host', namespace: 'mcp-host', resourceVersion },
    spec: {
      host: 'stateless-host',
      contextRef: 'context-a',
      secretRef: 'host-secret',
      lifecycle: { stateless: true },
    },
    status: { lifecycle },
  }
}

/** A K8s 409 Conflict error as getErrorCode reads it (.code). */
function conflict409(): Error {
  return Object.assign(new Error('the object has been modified'), { code: 409 })
}

describe('HostReconciler heartbeat status writes — D3 resourceVersion precondition + 409 retry', () => {
  it('carries metadata.resourceVersion as a precondition op when the fresh read supplies one', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 2 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostReadWithRv('rv-100', { state: 'draining', wakeHandledGeneration: 2 })
    )

    await reconciler.suspendHostFromHeartbeat(host, 'idle', 2)

    const [firstPatch] = customApi.patchNamespacedCustomObjectStatus.mock.calls
    const body = (firstPatch[0] as { body: Array<{ op: string; path: string; value: unknown }> })
      .body
    expect(body[0]).toEqual({ op: 'add', path: '/metadata/resourceVersion', value: 'rv-100' })
    expect(body[1].path).toBe('/status')
  })

  it('on a 409 (stale resourceVersion) re-reads fresh, re-checks the guard, and retries the patch', async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 2 } },
    })
    // First fresh read (rv-1) is draining → build proceeds. The patch 409s.
    // Second fresh read (rv-2) is STILL draining → build re-runs and succeeds.
    customApi.getNamespacedCustomObject
      .mockResolvedValueOnce(
        freshHostReadWithRv('rv-1', { state: 'draining', wakeHandledGeneration: 2 })
      )
      .mockResolvedValueOnce(
        freshHostReadWithRv('rv-2', { state: 'draining', wakeHandledGeneration: 2 })
      )
    customApi.patchNamespacedCustomObjectStatus
      .mockRejectedValueOnce(conflict409())
      .mockResolvedValueOnce({})

    await reconciler.suspendHostFromHeartbeat(host, 'idle', 2)

    // The suspend write re-read fresh after the 409 (>=2 GETs) and re-patched
    // (>=2 patch attempts); the post-suspend reconcile adds further calls, so
    // assert lower bounds, not exact counts.
    expect(customApi.getNamespacedCustomObject.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(customApi.patchNamespacedCustomObjectStatus.mock.calls.length).toBeGreaterThanOrEqual(2)
    // The retry carried the re-read resourceVersion, proving it re-read fresh.
    const secondBody = (
      customApi.patchNamespacedCustomObjectStatus.mock.calls[1][0] as {
        body: Array<{ op: string; path: string; value: unknown }>
      }
    ).body
    expect(secondBody[0]).toEqual({ op: 'add', path: '/metadata/resourceVersion', value: 'rv-2' })
    // The suspend committed → scale-down happened.
    expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(0)
  })

  it('re-checks the guard on the fresh re-read: a wake that lands during the 409 window aborts the suspend', async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 2 } },
    })
    // First fresh read is draining (build proceeds), the patch 409s, and the
    // re-read now shows the drain was overturned to active (a cancel-drain or
    // wake landed) → the guard skips: NO suspend, NO further patch.
    customApi.getNamespacedCustomObject
      .mockResolvedValueOnce(
        freshHostReadWithRv('rv-1', { state: 'draining', wakeHandledGeneration: 2 })
      )
      .mockResolvedValueOnce(
        freshHostReadWithRv('rv-2', { state: 'active', wakeHandledGeneration: 2 })
      )
    customApi.patchNamespacedCustomObjectStatus.mockRejectedValueOnce(conflict409())

    await reconciler.suspendHostFromHeartbeat(host, 'idle', 2)

    // Exactly one patch attempt (the 409); the re-checked guard skipped the retry.
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('throws loudly when the 409 conflict never clears (retry exhaustion is not swallowed)', async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 2 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostReadWithRv('rv-x', { state: 'draining', wakeHandledGeneration: 2 })
    )
    customApi.patchNamespacedCustomObjectStatus.mockRejectedValue(conflict409())

    await expect(reconciler.suspendHostFromHeartbeat(host, 'idle', 2)).rejects.toThrow(
      /after 5 attempts \(persistent 409 conflict\)/
    )
    // 5 bounded attempts, then fail loud — no scale-down over unconfirmed state.
    // The suspend never commits, so no post-suspend reconcile adds writes.
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(5)
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
  })
})

describe('HostReconciler.writeLifecycleStatusToCluster — D2 targeted patch does not clobber fresher fields', () => {
  it('writes ONLY /status/lifecycle + /status/conditions, preserving a fresher condition the reconcile did not compute', async () => {
    const { reconciler, customApi } = createReconciler()
    // The reconcile path drives writeLifecycleStatusToCluster; the fresh read
    // it performs carries an unrelated condition (written by another writer)
    // plus a resourceVersion. The targeted patch must keep that condition.
    customApi.getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: 'stateless-host', namespace: 'mcp-host', resourceVersion: 'rv-77' },
      spec: {
        host: 'stateless-host',
        contextRef: 'context-a',
        secretRef: 'host-secret',
        lifecycle: { stateless: true },
      },
      status: {
        lifecycle: { state: 'active', wakeHandledGeneration: 0 },
        conditions: [
          { type: 'UnrelatedThirdPartyCondition', status: 'True', reason: 'X', message: 'keep me' },
        ],
      },
    })
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 0 } },
    })

    await reconciler.reconcile(host)

    const call = customApi.patchNamespacedCustomObjectStatus.mock.calls.at(-1)
    expect(call).toBeDefined()
    const body = (call![0] as { body: Array<{ op: string; path: string; value: unknown }> }).body
    // Precondition op from the fresh read, then targeted sub-object ops only —
    // never a whole-/status op that would drop the unrelated condition.
    expect(body.map(op => op.path)).toEqual([
      '/metadata/resourceVersion',
      '/status/lifecycle',
      '/status/conditions',
    ])
    const writtenConditions = body.find(op => op.path === '/status/conditions')!.value as Array<{
      type: string
    }>
    // The fresher unrelated condition survived (D2: no clobber of un-computed fields).
    expect(writtenConditions.map(c => c.type)).toContain('UnrelatedThirdPartyCondition')
  })

  it('seeds the whole /status once when the fresh Host has no status yet (add /status/lifecycle would fail on a missing parent)', async () => {
    const { reconciler, customApi } = createReconciler()
    // Fresh Host with NO status subresource at all.
    customApi.getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: 'stateless-host', namespace: 'mcp-host', resourceVersion: 'rv-1' },
      spec: {
        host: 'stateless-host',
        contextRef: 'context-a',
        secretRef: 'host-secret',
        lifecycle: { stateless: true },
      },
    })
    const host = makeStatelessHost()
    // Force a status write by giving the cached host a spec.lifecycle (opt-in gate).

    await reconciler.reconcile(host)

    const call = customApi.patchNamespacedCustomObjectStatus.mock.calls.at(-1)
    expect(call).toBeDefined()
    const body = (call![0] as { body: Array<{ op: string; path: string; value: unknown }> }).body
    // Whole-/status seed (preceded by the precondition op), NOT targeted ops.
    expect(body.map(op => op.path)).toEqual(['/metadata/resourceVersion', '/status'])
  })
})

describe('HostReconciler.markHostDrainingFromHeartbeat — AP-1 entry-epoch guard (FIX 2)', () => {
  it('no-ops when a wake was handled after the drain verdict: fresh ACTIVE with a generation past the entry epoch', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { reconciler, customApi } = createReconciler()
      // The tracker decided drain:true off a snapshot with handled=2 …
      const host = makeStatelessHost({
        status: { lifecycle: { state: 'active', wakeHandledGeneration: 2 } },
      })
      // … but by the persist point a wake was handled (fast-path bumped the
      // generation to 3) and the CR is ACTIVE — exactly the state a
      // just-handled wake produces. Re-writing draining would re-fence the
      // woken pod with requested==handled (nothing revives it): MUST no-op.
      customApi.getNamespacedCustomObject.mockResolvedValue(
        freshHostRead({ state: 'active', wakeHandledGeneration: 3 })
      )

      await reconciler.markHostDrainingFromHeartbeat(host, 2)

      expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
      expect(host.status?.lifecycle?.state).toBe('active')
      const staleLines = logSpy.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.includes('phase=draining_write_stale'))
      expect(staleLines).toEqual([
        expect.stringMatching(
          /^\[StatelessSuspend\] host=stateless-host phase=draining_write_stale reason=wake_handled_since entryGeneration=2 freshGeneration=3 ts=\d+$/
        ),
      ])
    } finally {
      logSpy.mockRestore()
    }
  })

  it('no-ops when a wake is pending at the persist point (fresh requested > handled)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { reconciler, customApi } = createReconciler()
      const host = makeStatelessHost({
        status: { lifecycle: { state: 'active', wakeHandledGeneration: 2 } },
      })
      customApi.getNamespacedCustomObject.mockResolvedValue({
        metadata: {
          name: 'stateless-host',
          namespace: 'mcp-host',
          annotations: { 'clerum.io/wake-requested': '3' },
        },
        spec: {
          host: 'stateless-host',
          contextRef: 'context-a',
          secretRef: 'host-secret',
          lifecycle: { stateless: true },
        },
        status: { lifecycle: { state: 'active', wakeHandledGeneration: 2 } },
      })

      await reconciler.markHostDrainingFromHeartbeat(host, 2)

      expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
      const staleLines = logSpy.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.includes('phase=draining_write_stale'))
      expect(staleLines).toEqual([
        expect.stringMatching(
          /^\[StatelessSuspend\] host=stateless-host phase=draining_write_stale reason=wake_pending requestedGeneration=3 handledGeneration=2 ts=\d+$/
        ),
      ])
    } finally {
      logSpy.mockRestore()
    }
  })

  it('a current verdict (epoch equals the fresh generation) still writes draining', async () => {
    const { reconciler, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 2 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'active', wakeHandledGeneration: 2 })
    )

    await reconciler.markHostDrainingFromHeartbeat(host, 2)

    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(1)
    expect(writes[0].lifecycle).toEqual({ state: 'draining', wakeHandledGeneration: 2 })
  })
})

describe('HostReconciler.suspendHostFromHeartbeat — outcome contract (FIX 2)', () => {
  it("returns 'skipped_stale' when the generation-epoch guard no-ops the commit", async () => {
    const { reconciler, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'draining', wakeHandledGeneration: 2 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'draining', wakeHandledGeneration: 3 })
    )
    await expect(reconciler.suspendHostFromHeartbeat(host, 'idle', 2)).resolves.toBe(
      'skipped_stale'
    )
  })

  it("returns 'skipped_stale' when the drain was overturned (fresh active)", async () => {
    const { reconciler, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'draining', wakeHandledGeneration: 1 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'active', wakeHandledGeneration: 1 })
    )
    await expect(reconciler.suspendHostFromHeartbeat(host, 'idle', 1)).resolves.toBe(
      'skipped_stale'
    )
  })

  it("returns 'already_suspended' for the idempotent drained-report retry", async () => {
    const { reconciler, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'suspended', wakeHandledGeneration: 2, reason: 'idle' } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'suspended', wakeHandledGeneration: 2, reason: 'idle' })
    )
    await expect(reconciler.suspendHostFromHeartbeat(host, 'idle', 2)).resolves.toBe(
      'already_suspended'
    )
  })

  it("returns 'suspended' when the commit lands", async () => {
    const { reconciler, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 2 } },
    })
    customApi.getNamespacedCustomObject
      .mockResolvedValueOnce(freshHostRead({ state: 'draining', wakeHandledGeneration: 2 }))
      .mockResolvedValue(
        freshHostRead({ state: 'suspended', wakeHandledGeneration: 2, reason: 'idle' })
      )
    await expect(reconciler.suspendHostFromHeartbeat(host, 'idle', 2)).resolves.toBe('suspended')
  })
})

describe('HostReconciler reconcile — stateless replicas derive from FRESH state (FIX 1)', () => {
  it('a stale suspended payload over a fresh ACTIVE CR keeps replicas=1 (never kills the live pod)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { reconciler, appsApi, customApi } = createReconciler()
      // The reconcile payload is a STALE cache entry: it still says suspended
      // although the wake was fully handled (fresh: active, requested ==
      // handled == 3) and the pod is serving a turn.
      const host = makeStatelessHost({
        status: { lifecycle: { state: 'suspended', wakeHandledGeneration: 3, reason: 'idle' } },
      })
      customApi.getNamespacedCustomObject.mockResolvedValue(
        freshHostRead({ state: 'active', wakeHandledGeneration: 3 })
      )

      await reconciler.reconcile(host)

      // Replicas derive from FRESH (active), not the stale payload: the live
      // pod is never scaled to 0.
      expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(1)
      const guardLines = logSpy.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.includes('disagrees with fresh'))
      expect(guardLines).toEqual([
        '[HostReconciler] Stateless replicas guard for "stateless-host": cached lifecycle state "suspended" disagrees with fresh "active" — deriving replicas from FRESH state',
      ])
    } finally {
      logSpy.mockRestore()
    }
  })

  it('a stale active payload over a fresh SUSPENDED CR keeps replicas=0 (no resurrection without a wake)', async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    // Mirror direction: the payload predates a heartbeat suspension; fresh
    // says suspended with no pending wake (requested == handled).
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 3 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'suspended', wakeHandledGeneration: 3, reason: 'idle' })
    )

    await reconciler.reconcile(host)

    expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(0)
    // The rebuilt assessment preserves the heartbeat-managed reason.
    expect(host.status?.lifecycle?.state).toBe('suspended')
  })

  it('agreement between cache and fresh keeps the assessment untouched (replicas from the durable state)', async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'suspended', wakeHandledGeneration: 2, reason: 'idle' } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'suspended', wakeHandledGeneration: 2, reason: 'idle' })
    )

    await reconciler.reconcile(host)

    expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(0)
  })

  it('a fresh-read failure skips the Deployment scale entirely this pass (loud, conservative)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { reconciler, appsApi, customApi } = createReconciler()
      const host = makeStatelessHost({
        status: { lifecycle: { state: 'active', wakeHandledGeneration: 0 } },
      })
      customApi.getNamespacedCustomObject.mockRejectedValue(new Error('apiserver unavailable'))

      await reconciler.reconcile(host)

      // No Deployment apply happened: never commit replicas from a
      // possibly-stale cached state without the fresh confirmation.
      expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
      expect(
        errorSpy.mock.calls.filter(args =>
          String(args[0]).includes('skipping the Deployment scale this pass')
        )
      ).toHaveLength(1)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
