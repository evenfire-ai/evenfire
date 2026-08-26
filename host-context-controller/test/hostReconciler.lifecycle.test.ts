import { afterEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { config } from '../src/config'
import { mintHostGfsToken } from '../src/gfsHostBinding'
import {
  type EffectiveHostLifecycle,
  HostReconciler,
  type ResolvedSfsMount,
} from '../src/hostReconciler'
import type { InfrastructureTelemetryReporter } from '../src/infrastructureTelemetryReporter'
import { issueMcpHostRuntimeTokens } from '../src/mcpHostRuntimeTokenIssuerClient'
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

function makeHost(overrides?: Partial<HostCRD>): HostCRD {
  return {
    name: 'alpha-host',
    namespace: 'mcp-host',
    uid: 'alpha-host-uid',
    spec: {
      host: 'alpha-host',
      contextRef: 'context-a',
      secretRef: 'host-secret',
    },
    ...overrides,
  }
}

function makeStatelessHost(
  overrides: { name?: string; spec?: Partial<HostCRD['spec']>; status?: HostCrdStatus } = {}
): HostCRD {
  const name = overrides.name ?? 'stateless-host'
  return {
    name,
    namespace: 'mcp-host',
    uid: `${name}-uid`,
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

function suspendedStatus(wakeHandledGeneration = 0): HostCrdStatus {
  return { lifecycle: { state: 'suspended', wakeHandledGeneration } }
}

function createTelemetryReporterMock(): InfrastructureTelemetryReporter {
  return {
    enqueue: vi.fn(),
    enqueueHealthTransition: vi.fn(),
    stop: vi.fn(async () => undefined),
  }
}

function hostApiObject(host: HostCRD) {
  return {
    metadata: {
      name: host.name,
      namespace: host.namespace,
      uid: host.uid,
      resourceVersion: host.resourceVersion ?? '42',
      annotations: host.annotations,
    },
    spec: host.spec,
    status: host.status,
  }
}

function createReconciler(deps?: {
  countCommunicationChannels?: (hostName: string) => number
  isCommunicationChannelCacheSynced?: () => boolean
  resolveContextMounts?: (host: HostCRD) => Promise<ResolvedSfsMount[]>
  infrastructureTelemetryReporter?: InfrastructureTelemetryReporter
}) {
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
    ...deps,
    // Lifecycle tests model a fully initialized watcher unless a case is
    // explicitly exercising the fail-closed cache-startup behavior.
    isCommunicationChannelCacheSynced: deps?.isCommunicationChannelCacheSynced ?? (() => true),
  })

  return { reconciler, appsApi, coreApi, networkingApi, rbacApi, customApi }
}

function runtimeTokenProvision(host: HostCRD, hasChannelIngress = false) {
  const internals = HostReconciler as unknown as {
    runtimeTokenScopeHash(host: HostCRD, hasChannelIngress: boolean): string
  }
  return {
    revision: 'runtime-revision',
    scopeHash: internals.runtimeTokenScopeHash(host, hasChannelIngress),
  }
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

function containerEnv(dep: k8s.V1Deployment): k8s.V1EnvVar[] {
  const env = dep.spec?.template?.spec?.containers?.[0]?.env
  if (!env) {
    throw new Error('Deployment has no mcp-host container env')
  }
  return env
}

function envValue(dep: k8s.V1Deployment, name: string): string {
  const entry = containerEnv(dep).find(e => e.name === name)
  if (!entry || entry.value === undefined) {
    throw new Error(`env var "${name}" not found on the mcp-host container`)
  }
  return entry.value
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

function rejectedCondition(status: HostCrdStatus) {
  const cond = status.conditions?.find(c => c.type === 'StatelessEnableRejected')
  if (!cond) {
    throw new Error('StatelessEnableRejected condition missing from status write')
  }
  return cond
}

describe('HostReconciler stateless lifecycle — buildDeployment replicas', () => {
  it('pins replicas=1 and maxSurge=0 for a non-stateless host', () => {
    const { reconciler } = createReconciler()
    const dep = reconciler.buildDeployment(makeHost())
    expect(dep.spec?.replicas).toBe(1)
    expect(dep.spec?.strategy?.rollingUpdate?.maxSurge).toBe(0)
    expect(dep.spec?.strategy?.rollingUpdate?.maxUnavailable).toBe(1)
    expect(dep.spec?.template.spec?.priorityClassName).toBeUndefined()
  })

  it('derives replicas=0 for stateless+suspended from the CRD status', () => {
    const { reconciler } = createReconciler()
    const dep = reconciler.buildDeployment(makeStatelessHost({ status: suspendedStatus() }))
    expect(dep.spec?.replicas).toBe(0)
  })

  it('forces stateless+suspended to replicas=1 when CommunicationChannels exist by default', () => {
    const { reconciler } = createReconciler({
      countCommunicationChannels: () => 1,
    })
    const dep = reconciler.buildDeployment(makeStatelessHost({ status: suspendedStatus() }))
    expect(dep.spec?.replicas).toBe(1)
  })

  it('forces stateless+suspended to replicas=1 while the channel cache is unsynced', () => {
    const { reconciler } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    const dep = reconciler.buildDeployment(makeStatelessHost({ status: suspendedStatus() }))
    expect(dep.spec?.replicas).toBe(1)
    expect(dep.spec?.template.spec?.priorityClassName).toBeUndefined()
  })

  it('derives replicas=1 for stateless+active and stateless+draining', () => {
    const { reconciler } = createReconciler()
    const active = reconciler.buildDeployment(makeStatelessHost())
    expect(active.spec?.replicas).toBe(1)
    const draining = reconciler.buildDeployment(
      makeStatelessHost({ status: { lifecycle: { state: 'draining', wakeHandledGeneration: 1 } } })
    )
    expect(draining.spec?.replicas).toBe(1)
  })

  it('assigns the interactive priority class to every effective stateless Host', () => {
    const { reconciler } = createReconciler()
    const active = reconciler.buildDeployment(makeStatelessHost())
    const suspended = reconciler.buildDeployment(makeStatelessHost({ status: suspendedStatus() }))

    expect(active.spec?.template.spec?.priorityClassName).toBe('clerum-interactive-host')
    expect(suspended.spec?.template.spec?.priorityClassName).toBe('clerum-interactive-host')
  })

  it('derives replicas=0 from an explicit suspended lifecycle argument', () => {
    const { reconciler } = createReconciler()
    const lifecycle: EffectiveHostLifecycle = { stateless: true, state: 'suspended' }
    const dep = reconciler.buildDeployment(makeStatelessHost(), [], '', lifecycle)
    expect(dep.spec?.replicas).toBe(0)
  })
})

describe('HostReconciler ensureDeployment — idempotent replacement', () => {
  function withKubernetesProbeDefaults(probe: k8s.V1Probe | undefined): k8s.V1Probe | undefined {
    if (!probe) return probe
    const persisted = {
      ...probe,
      successThreshold: 1,
      httpGet: probe.httpGet ? { ...probe.httpGet, scheme: 'HTTP' } : probe.httpGet,
    }
    if (persisted.initialDelaySeconds === 0) delete persisted.initialDelaySeconds
    return persisted
  }

  function existingDeployment(
    reconciler: HostReconciler,
    host: HostCRD,
    runtimeTokenRevision: string,
    lifecycle?: EffectiveHostLifecycle
  ): k8s.V1Deployment {
    const deployment = structuredClone(
      reconciler.buildDeployment(host, [], runtimeTokenRevision, lifecycle)
    )
    const deploymentSpec = deployment.spec
    if (!deploymentSpec) throw new Error('expected Host Deployment spec')
    const podSpec = deploymentSpec.template.spec
    if (!podSpec) throw new Error('expected Host Deployment PodSpec')
    deployment.metadata = {
      ...deployment.metadata,
      resourceVersion: '42',
      uid: 'deployment-uid',
      generation: 7,
      creationTimestamp: new Date('2026-07-10T00:00:00Z'),
      annotations: { 'deployment.kubernetes.io/revision': '7' },
    }
    deployment.status = { readyReplicas: 1, availableReplicas: 1 }
    deployment.spec = {
      ...deploymentSpec,
      progressDeadlineSeconds: 600,
      revisionHistoryLimit: 10,
      template: {
        ...deploymentSpec.template,
        metadata: {
          ...deploymentSpec.template.metadata,
          annotations: {
            ...deploymentSpec.template.metadata?.annotations,
            'kubectl.kubernetes.io/restartedAt': '2026-07-10T00:00:00Z',
          },
        },
        spec: {
          ...podSpec,
          dnsPolicy: 'ClusterFirst',
          restartPolicy: 'Always',
          schedulerName: 'default-scheduler',
          serviceAccount: `host-${host.name}-sa`,
          terminationGracePeriodSeconds: 30,
          containers: podSpec.containers.map(container => ({
            ...container,
            terminationMessagePath: '/dev/termination-log',
            terminationMessagePolicy: 'File',
            startupProbe: withKubernetesProbeDefaults(container.startupProbe),
            livenessProbe: withKubernetesProbeDefaults(container.livenessProbe),
            readinessProbe: withKubernetesProbeDefaults(container.readinessProbe),
            env: container.env?.map(env =>
              env.valueFrom?.fieldRef
                ? {
                    ...env,
                    valueFrom: {
                      ...env.valueFrom,
                      fieldRef: { ...env.valueFrom.fieldRef, apiVersion: 'v1' },
                    },
                  }
                : env
            ),
          })),
          volumes: (podSpec.volumes ?? []).map(volume =>
            volume.secret ? { ...volume, secret: { ...volume.secret, defaultMode: 420 } } : volume
          ),
        },
      },
    }
    return deployment
  }

  it('does not replace a converged stateful Deployment when Kubernetes only adds defaults', async () => {
    const { reconciler, appsApi } = createReconciler()
    const host = makeHost({ name: 'chatllm' })
    appsApi.createNamespacedDeployment.mockRejectedValue({ code: 409 })
    appsApi.readNamespacedDeployment.mockResolvedValue(
      existingDeployment(reconciler, host, 'revision-a')
    )

    await (reconciler as any).ensureDeployment(host, [], 'revision-a')

    expect(appsApi.createNamespacedDeployment).toHaveBeenCalledOnce()
    expect(appsApi.readNamespacedDeployment).toHaveBeenCalledWith({
      namespace: 'mcp-host',
      name: 'chatllm',
    })
    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('does not replace a converged stateless Deployment when Kubernetes omits zero probe delays', async () => {
    const { reconciler, appsApi } = createReconciler()
    const host = makeStatelessHost()
    const active: EffectiveHostLifecycle = { stateless: true, state: 'active' }
    appsApi.createNamespacedDeployment.mockRejectedValue({ code: 409 })
    appsApi.readNamespacedDeployment.mockResolvedValue(
      existingDeployment(reconciler, host, 'revision-a', active)
    )

    await (reconciler as any).ensureDeployment(host, [], 'revision-a', active)

    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('replaces an existing Deployment when an HCC-owned nested field is stale', async () => {
    const { reconciler, appsApi } = createReconciler()
    const host = makeHost({ name: 'chatllm' })
    const existing = existingDeployment(reconciler, host, 'revision-a')
    const container = existing.spec?.template.spec?.containers?.[0]
    if (!container) throw new Error('expected mcp-host container')
    container.securityContext = {
      ...container.securityContext,
      readOnlyRootFilesystem: true,
    }
    appsApi.createNamespacedDeployment.mockRejectedValue({ code: 409 })
    appsApi.readNamespacedDeployment.mockResolvedValue(existing)

    await (reconciler as any).ensureDeployment(host, [], 'revision-a')

    expect(appsApi.replaceNamespacedDeployment).toHaveBeenCalledOnce()
  })

  it('replaces an existing Deployment when a defaultable Deployment field is non-default', async () => {
    const { reconciler, appsApi } = createReconciler()
    const host = makeHost({ name: 'chatllm' })
    const existing = existingDeployment(reconciler, host, 'revision-a')
    existing.spec!.progressDeadlineSeconds = 30
    appsApi.createNamespacedDeployment.mockRejectedValue({ code: 409 })
    appsApi.readNamespacedDeployment.mockResolvedValue(existing)

    await (reconciler as any).ensureDeployment(host, [], 'revision-a')

    expect(appsApi.replaceNamespacedDeployment).toHaveBeenCalledOnce()
  })

  it('replaces an existing Deployment when a defaultable Pod field is non-default', async () => {
    const { reconciler, appsApi } = createReconciler()
    const host = makeHost({ name: 'chatllm' })
    const existing = existingDeployment(reconciler, host, 'revision-a')
    existing.spec!.template.spec!.terminationGracePeriodSeconds = 120
    appsApi.createNamespacedDeployment.mockRejectedValue({ code: 409 })
    appsApi.readNamespacedDeployment.mockResolvedValue(existing)

    await (reconciler as any).ensureDeployment(host, [], 'revision-a')

    expect(appsApi.replaceNamespacedDeployment).toHaveBeenCalledOnce()
  })

  it('treats an unrecognized admission mutation as drift', async () => {
    const { reconciler, appsApi } = createReconciler()
    const host = makeHost({ name: 'chatllm' })
    const existing = existingDeployment(reconciler, host, 'revision-a')
    existing.spec!.template.spec!.tolerations = [
      { key: 'admission.example.io/injected', operator: 'Exists', effect: 'NoSchedule' },
    ]
    appsApi.createNamespacedDeployment.mockRejectedValue({ code: 409 })
    appsApi.readNamespacedDeployment.mockResolvedValue(existing)

    await (reconciler as any).ensureDeployment(host, [], 'revision-a')

    expect(appsApi.replaceNamespacedDeployment).toHaveBeenCalledOnce()
  })

  it.each([
    [
      'readiness successThreshold',
      (deployment: k8s.V1Deployment) => {
        deployment.spec!.template.spec!.containers![0].readinessProbe!.successThreshold = 2
      },
    ],
    [
      'readiness HTTP scheme',
      (deployment: k8s.V1Deployment) => {
        deployment.spec!.template.spec!.containers![0].readinessProbe!.httpGet!.scheme = 'HTTPS'
      },
    ],
    [
      'fieldRef API version',
      (deployment: k8s.V1Deployment) => {
        const namespaceEnv = deployment.spec!.template.spec!.containers![0].env!.find(
          env => env.name === 'CLERUM_NAMESPACE'
        )
        namespaceEnv!.valueFrom!.fieldRef!.apiVersion = 'v2'
      },
    ],
    [
      'Secret defaultMode',
      (deployment: k8s.V1Deployment) => {
        const runtimeVolume = deployment.spec!.template.spec!.volumes!.find(
          volume => volume.name === 'mcp-host-runtime-tokens'
        )
        runtimeVolume!.secret!.defaultMode = 384
      },
    ],
    [
      'Secret optional flag',
      (deployment: k8s.V1Deployment) => {
        const runtimeVolume = deployment.spec!.template.spec!.volumes!.find(
          volume => volume.name === 'mcp-host-runtime-tokens'
        )
        runtimeVolume!.secret!.optional = true
      },
    ],
  ])('replaces an existing Deployment when %s is non-default', async (_case, mutate) => {
    const { reconciler, appsApi } = createReconciler()
    const host = makeHost({ name: 'chatllm' })
    const existing = existingDeployment(reconciler, host, 'revision-a')
    mutate(existing)
    appsApi.createNamespacedDeployment.mockRejectedValue({ code: 409 })
    appsApi.readNamespacedDeployment.mockResolvedValue(existing)

    await (reconciler as any).ensureDeployment(host, [], 'revision-a')

    expect(appsApi.replaceNamespacedDeployment).toHaveBeenCalledOnce()
  })

  it('stops retrying when a fresh read converges after a replace conflict', async () => {
    const { reconciler, appsApi } = createReconciler()
    const host = makeHost({ name: 'chatllm' })
    const stale = existingDeployment(reconciler, host, 'revision-a')
    const container = stale.spec?.template.spec?.containers?.[0]
    if (!container) throw new Error('expected mcp-host container')
    container.securityContext = {
      ...container.securityContext,
      readOnlyRootFilesystem: true,
    }
    appsApi.createNamespacedDeployment.mockRejectedValue({ code: 409 })
    appsApi.readNamespacedDeployment
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(existingDeployment(reconciler, host, 'revision-a'))
    appsApi.replaceNamespacedDeployment.mockRejectedValueOnce({ code: 409 })

    await (reconciler as any).ensureDeployment(host, [], 'revision-a')

    expect(appsApi.readNamespacedDeployment).toHaveBeenCalledTimes(2)
    expect(appsApi.replaceNamespacedDeployment).toHaveBeenCalledOnce()
  })

  it('replaces an existing Deployment when the runtime token revision changes', async () => {
    const { reconciler, appsApi } = createReconciler()
    const host = makeHost({ name: 'chatllm' })
    appsApi.createNamespacedDeployment.mockRejectedValue({ code: 409 })
    appsApi.readNamespacedDeployment.mockResolvedValue(
      existingDeployment(reconciler, host, 'revision-a')
    )

    await (reconciler as any).ensureDeployment(host, [], 'revision-b')

    expect(appsApi.replaceNamespacedDeployment).toHaveBeenCalledOnce()
    const replacement = appsApi.replaceNamespacedDeployment.mock.calls[0][0]
      .body as k8s.V1Deployment
    expect(replacement.metadata?.resourceVersion).toBe('42')
    expect(
      replacement.spec?.template.metadata?.annotations?.['clerum.io/runtime-token-revision']
    ).toBe('revision-b')
  })

  it('replaces an existing Deployment when the stateless lifecycle target changes', async () => {
    const { reconciler, appsApi } = createReconciler()
    const host = makeStatelessHost()
    const active: EffectiveHostLifecycle = { stateless: true, state: 'active' }
    const suspended: EffectiveHostLifecycle = { stateless: true, state: 'suspended' }
    appsApi.createNamespacedDeployment.mockRejectedValue({ code: 409 })
    appsApi.readNamespacedDeployment.mockResolvedValue(
      existingDeployment(reconciler, host, 'revision-a', active)
    )

    await (reconciler as any).ensureDeployment(host, [], 'revision-a', suspended)

    expect(appsApi.replaceNamespacedDeployment).toHaveBeenCalledOnce()
    const replacement = appsApi.replaceNamespacedDeployment.mock.calls[0][0]
      .body as k8s.V1Deployment
    expect(replacement.metadata?.resourceVersion).toBe('42')
    expect(replacement.spec?.replicas).toBe(0)
    expect(
      replacement.spec?.template.metadata?.annotations?.['clerum.io/runtime-token-revision']
    ).toBe('revision-a')
  })

  it('replaces a running stateful Host with the stateless template when lifecycle is enabled', async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    const stateful = makeHost({ name: 'transition-host' })

    await reconciler.reconcile(stateful)
    const runningStateful = structuredClone(hostDeploymentBody(appsApi, 'transition-host'))
    runningStateful.metadata = { ...runningStateful.metadata, resourceVersion: '42' }
    runningStateful.status = { readyReplicas: 1, availableReplicas: 1 }
    expect(runningStateful.spec?.replicas).toBe(1)
    expect(containerEnv(runningStateful).map(entry => entry.name)).not.toContain(
      'CLERUM_STATELESS_LIFECYCLE'
    )

    appsApi.createNamespacedDeployment.mockRejectedValueOnce({ code: 409 })
    appsApi.readNamespacedDeployment.mockResolvedValueOnce(runningStateful)

    const stateless = makeStatelessHost({ name: 'transition-host' })
    customApi.getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: stateless.name, namespace: stateless.namespace, uid: stateless.uid },
      spec: stateless.spec,
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 0 } },
    })

    await reconciler.reconcile(stateless)

    expect(appsApi.replaceNamespacedDeployment).toHaveBeenCalledOnce()
    const replacement = appsApi.replaceNamespacedDeployment.mock.calls[0][0]
      .body as k8s.V1Deployment
    expect(replacement.spec?.replicas).toBe(1)
    expect(replacement.spec?.template.spec?.priorityClassName).toBe('clerum-interactive-host')
    expect(
      replacement.spec?.template.spec?.initContainers?.map(container => container.name)
    ).toContain('workspace-layout-init')
    expect(envValue(replacement, 'CLERUM_STATELESS_LIFECYCLE')).toBe('true')
    expect(replacement.spec?.template.spec?.containers?.[0]?.volumeMounts).toContainEqual({
      name: 'workspace',
      mountPath: '/workspace',
      subPath: 'workspace',
    })
    expect(replacement.spec?.template.spec?.containers?.[0]?.volumeMounts).toContainEqual({
      name: 'workspace',
      mountPath: '/var/lib/clerum/state',
      subPath: 'state',
    })
  })
})

describe('HostReconciler stateless lifecycle — env injection', () => {
  it('creates the stateless template directly for a new Host', async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    const stateless = makeStatelessHost({ name: 'new-stateless-host' })
    customApi.getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: stateless.name, namespace: stateless.namespace, uid: stateless.uid },
      spec: stateless.spec,
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 0 } },
    })

    await reconciler.reconcile(stateless)

    const creates = appsApi.createNamespacedDeployment.mock.calls.filter(
      ([arg]) => (arg as { body?: k8s.V1Deployment }).body?.metadata?.name === 'new-stateless-host'
    )
    const replacements = appsApi.replaceNamespacedDeployment.mock.calls.filter(
      ([arg]) => (arg as { body?: k8s.V1Deployment }).body?.metadata?.name === 'new-stateless-host'
    )
    expect(creates).toHaveLength(1)
    expect(replacements).toHaveLength(0)
    const created = hostDeploymentBody(appsApi, 'new-stateless-host')
    expect(created.spec?.replicas).toBe(1)
    expect(created.spec?.template.spec?.priorityClassName).toBe('clerum-interactive-host')
    expect(created.spec?.template.spec?.initContainers?.map(container => container.name)).toContain(
      'workspace-layout-init'
    )
    expect(envValue(created, 'CLERUM_STATELESS_LIFECYCLE')).toBe('true')
    expect(created.spec?.template.spec?.containers?.[0]?.volumeMounts).toContainEqual({
      name: 'workspace',
      mountPath: '/workspace',
      subPath: 'workspace',
    })
    expect(created.spec?.template.spec?.containers?.[0]?.volumeMounts).toContainEqual({
      name: 'workspace',
      mountPath: '/var/lib/clerum/state',
      subPath: 'state',
    })
  })

  it('injects the three stateless env vars when stateless is enabled', () => {
    const { reconciler } = createReconciler()
    const dep = reconciler.buildDeployment(makeStatelessHost())
    expect(envValue(dep, 'CLERUM_STATELESS_LIFECYCLE')).toBe('true')
    expect(envValue(dep, 'CLERUM_SESSION_STORE')).toBe('sqlite')
    expect(envValue(dep, 'CLERUM_SESSION_DB_DIR')).toBe('/var/lib/clerum/state')
  })

  it('does not inject the stateless env vars when stateless is off', () => {
    const { reconciler } = createReconciler()
    const names = containerEnv(reconciler.buildDeployment(makeHost())).map(e => e.name)
    expect(names).not.toContain('CLERUM_STATELESS_LIFECYCLE')
    expect(names).not.toContain('CLERUM_SESSION_STORE')
    expect(names).not.toContain('CLERUM_SESSION_DB_DIR')
  })
})

describe('HostReconciler stateless lifecycle — rejection matrix', () => {
  it('fails closed while the CommunicationChannel cache is unsynced', async () => {
    const { reconciler, appsApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    await reconciler.reconcile(makeStatelessHost({ status: suspendedStatus() }))

    expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(1)
    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(1)
    expect(writes[0].lifecycle?.state).toBe('active')
    const condition = rejectedCondition(writes[0])
    expect(condition.status).toBe('True')
    expect(condition.reason).toContain('CommunicationChannelCacheUnsynced')
  })

  it('fails closed when the channel cache becomes unsynced during reconciliation', async () => {
    let cacheSynced = true
    const { reconciler, appsApi, customApi, networkingApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => cacheSynced,
    })
    const host = makeStatelessHost({ status: suspendedStatus(4) })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    networkingApi.createNamespacedNetworkPolicy.mockImplementation(async () => {
      cacheSynced = false
      return {}
    })
    const provision = vi
      .spyOn(reconciler as any, 'provisionRuntimeTokenRevision')
      .mockResolvedValue(runtimeTokenProvision(host))

    await reconciler.reconcile(host)

    expect(provision).toHaveBeenCalledOnce()
    expect(provision).toHaveBeenCalledWith(
      host,
      expect.objectContaining({ targetSuspended: false })
    )
    const deployment = hostDeploymentBody(appsApi, host.name)
    expect(deployment.spec?.replicas).toBe(1)
    expect(containerEnv(deployment).map(entry => entry.name)).not.toContain(
      'CLERUM_STATELESS_LIFECYCLE'
    )
    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(2)
    expect(writes[0].lifecycle?.state).toBe('suspended')
    expect(writes[1].lifecycle).toEqual({
      state: 'active',
      wakeHandledGeneration: 4,
      reason: 'CommunicationChannel cache is not synchronized; stateless lifecycle is held active',
    })
    expect(rejectedCondition(writes[1]).reason).toBe('CommunicationChannelCacheUnsynced')
  })

  it('fails closed when a channel starts referencing the Host during reconciliation', async () => {
    let channelCount = 0
    const { reconciler, appsApi, customApi, networkingApi } = createReconciler({
      countCommunicationChannels: () => channelCount,
    })
    const host = makeStatelessHost({ status: suspendedStatus(5) })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    networkingApi.createNamespacedNetworkPolicy.mockImplementation(async () => {
      channelCount = 1
      return {}
    })

    await reconciler.reconcile(host)

    const deployment = hostDeploymentBody(appsApi, host.name)
    expect(deployment.spec?.replicas).toBe(1)
    expect(containerEnv(deployment).map(entry => entry.name)).not.toContain(
      'CLERUM_STATELESS_LIFECYCLE'
    )
    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(2)
    expect(writes[1].lifecycle).toEqual({
      state: 'active',
      wakeHandledGeneration: 5,
      reason:
        '1 CommunicationChannel(s) reference this Host; disassociate them to enable the requested stateless lifecycle',
    })
    expect(rejectedCondition(writes[1])).toMatchObject({
      status: 'True',
      reason: 'ActiveCommunicationChannels',
    })
  })

  it('issues bootstrap material once with final scopes for an already-active late channel', async () => {
    let channelCount = 0
    const { reconciler, appsApi, customApi, networkingApi } = createReconciler({
      countCommunicationChannels: () => channelCount,
    })
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 1 } },
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    networkingApi.createNamespacedNetworkPolicy.mockImplementation(async () => {
      channelCount = 1
      return {}
    })
    const issueTokens = vi.mocked(issueMcpHostRuntimeTokens)
    const mintGfs = vi.mocked(mintHostGfsToken)
    issueTokens.mockClear()
    mintGfs.mockClear()

    await reconciler.reconcile(host)

    expect(issueTokens).toHaveBeenCalledOnce()
    expect(mintGfs).toHaveBeenCalledOnce()
    expect(mintGfs).toHaveBeenCalledWith({ name: host.name, namespace: host.namespace })
    expect(issueTokens).toHaveBeenCalledWith(
      host.name,
      host.uid,
      expect.arrayContaining([
        'workflow:list',
        'workflow:read',
        'workflow:trigger',
        'workflow:approval:resolve',
        'workflow:approval:decide',
      ])
    )
    const deployment = hostDeploymentBody(appsApi, host.name)
    expect(deployment.spec?.replicas).toBe(1)
    expect(containerEnv(deployment).map(entry => entry.name)).not.toContain(
      'CLERUM_STATELESS_LIFECYCLE'
    )
  })

  it('reissues channel-aware bootstrap material when a channel appears during provisioning', async () => {
    let channelCount = 0
    const { reconciler, appsApi, customApi } = createReconciler({
      countCommunicationChannels: () => channelCount,
    })
    const host = makeStatelessHost({ status: suspendedStatus(6) })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const issueTokens = vi.mocked(issueMcpHostRuntimeTokens)
    const defaultIssueTokens = issueTokens.getMockImplementation()
    issueTokens.mockClear()
    issueTokens.mockImplementationOnce(async (hostName, hostUid, scopes) => {
      const tokens = await defaultIssueTokens!(hostName, hostUid, scopes)
      channelCount = 1
      return tokens
    })

    await reconciler.reconcile(host)

    expect(issueTokens).toHaveBeenCalledTimes(2)
    expect(issueTokens.mock.calls[0][1]).toBe(host.uid)
    expect(issueTokens.mock.calls[0][2]).not.toContain('workflow:trigger')
    expect(issueTokens.mock.calls[1][2]).toContain('workflow:trigger')
    const deployment = hostDeploymentBody(appsApi, host.name)
    expect(deployment.spec?.replicas).toBe(1)
    expect(containerEnv(deployment).map(entry => entry.name)).not.toContain(
      'CLERUM_STATELESS_LIFECYCLE'
    )
    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(2)
    expect(writes[1].lifecycle).toEqual({
      state: 'active',
      wakeHandledGeneration: 6,
      reason:
        '1 CommunicationChannel(s) reference this Host; disassociate them to enable the requested stateless lifecycle',
    })
  })

  it('reissues channel-aware bootstrap material for a stateful Host when a channel appears during provisioning', async () => {
    let channelCount = 0
    const { reconciler, appsApi } = createReconciler({
      countCommunicationChannels: () => channelCount,
    })
    const host = makeHost()
    const issueTokens = vi.mocked(issueMcpHostRuntimeTokens)
    const defaultIssueTokens = issueTokens.getMockImplementation()
    issueTokens.mockClear()
    issueTokens.mockImplementationOnce(async (hostName, hostUid, scopes) => {
      const tokens = await defaultIssueTokens!(hostName, hostUid, scopes)
      channelCount = 1
      return tokens
    })

    await reconciler.reconcile(host)

    expect(issueTokens).toHaveBeenCalledTimes(2)
    expect(issueTokens.mock.calls[0][1]).toBe(host.uid)
    expect(issueTokens.mock.calls[0][2]).not.toContain('workflow:trigger')
    expect(issueTokens.mock.calls[1][2]).toContain('workflow:trigger')
    expect(
      containerEnv(hostDeploymentBody(appsApi, host.name)).map(entry => entry.name)
    ).not.toContain('CLERUM_STATELESS_LIFECYCLE')
  })

  it('propagates runtime token provisioning failure so lifecycle convergence can retry', async () => {
    const { reconciler } = createReconciler()
    const failure = new Error('runtime token issuer unavailable')
    vi.spyOn(reconciler as any, 'ensureMcpHostRuntimeTokenSecret').mockRejectedValue(failure)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(reconciler.reconcile(makeStatelessHost())).rejects.toBe(failure)
      expect(reconciler.getStatus('stateless-host')).toEqual(
        expect.objectContaining({
          deployed: false,
          ready: false,
          message: 'mcpHost runtime token provisioning failed',
        })
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('propagates the principal Deployment mutation failure so lifecycle convergence can retry', async () => {
    const { reconciler, appsApi } = createReconciler()
    const failure = Object.assign(new Error('Deployment API unavailable'), { code: 503 })
    appsApi.createNamespacedDeployment.mockImplementation(
      async ({ body }: { body: k8s.V1Deployment }) => {
        if (body.metadata?.name === 'stateless-host') throw failure
        return {}
      }
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(reconciler.reconcile(makeStatelessHost())).rejects.toBe(failure)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('rechecks channel policy after a Deployment create conflict before replace', async () => {
    let channelCount = 0
    let hostDeploymentReads = 0
    const { reconciler, appsApi, customApi } = createReconciler({
      countCommunicationChannels: () => channelCount,
    })
    const host = makeStatelessHost({ status: suspendedStatus(7) })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const issueTokens = vi.mocked(issueMcpHostRuntimeTokens)
    issueTokens.mockClear()
    appsApi.createNamespacedDeployment.mockImplementation(
      async ({ body }: { body: k8s.V1Deployment }) => {
        if (body.metadata?.name === host.name) {
          throw Object.assign(new Error('Deployment already exists'), { code: 409 })
        }
        return {}
      }
    )
    appsApi.readNamespacedDeployment.mockImplementation(async ({ name }: { name: string }) => {
      if (name === host.name) {
        hostDeploymentReads += 1
        if (hostDeploymentReads >= 2) channelCount = 1
        return {
          metadata: { name, namespace: host.namespace, resourceVersion: '9' },
          spec: { replicas: 0 },
          status: { readyReplicas: 1 },
        }
      }
      return {
        metadata: { name, namespace: 'channels', resourceVersion: '4' },
        spec: { replicas: 1 },
        status: { readyReplicas: 1 },
      }
    })

    await reconciler.reconcile(host)

    expect(issueTokens).toHaveBeenCalledTimes(2)
    expect(issueTokens.mock.calls[0][1]).toBe(host.uid)
    expect(issueTokens.mock.calls[0][2]).not.toContain('workflow:trigger')
    expect(issueTokens.mock.calls[1][2]).toContain('workflow:trigger')
    const hostReplace = appsApi.replaceNamespacedDeployment.mock.calls.find(
      ([request]) => request.name === host.name
    )?.[0].body as k8s.V1Deployment | undefined
    expect(hostReplace?.spec?.replicas).toBe(1)
    expect(containerEnv(hostReplace!).map(entry => entry.name)).not.toContain(
      'CLERUM_STATELESS_LIFECYCLE'
    )
    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(2)
    expect(writes[1].lifecycle?.reason).toBe(
      '1 CommunicationChannel(s) reference this Host; disassociate them to enable the requested stateless lifecycle'
    )
  })

  it('does not repeat bootstrap provisioning when channel ingress already existed in spec', async () => {
    let channelCount = 0
    const { reconciler, customApi, networkingApi } = createReconciler({
      countCommunicationChannels: () => channelCount,
    })
    const host = makeStatelessHost({
      spec: { channels: ['existing-channel'] },
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 1 } },
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    networkingApi.createNamespacedNetworkPolicy.mockImplementation(async () => {
      channelCount = 1
      return {}
    })
    const provision = vi
      .spyOn(reconciler as any, 'provisionRuntimeTokenRevision')
      .mockResolvedValue(runtimeTokenProvision(host, true))

    await reconciler.reconcile(host)

    expect(provision).toHaveBeenCalledOnce()
  })

  it('does not repeat bootstrap provisioning for active cache loss without channels', async () => {
    let cacheSynced = true
    const { reconciler, appsApi, customApi, networkingApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => cacheSynced,
    })
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 1 } },
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    networkingApi.createNamespacedNetworkPolicy.mockImplementation(async () => {
      cacheSynced = false
      return {}
    })
    const provision = vi
      .spyOn(reconciler as any, 'provisionRuntimeTokenRevision')
      .mockResolvedValue(runtimeTokenProvision(host))

    await reconciler.reconcile(host)

    expect(provision).toHaveBeenCalledOnce()
    const deployment = hostDeploymentBody(appsApi, host.name)
    expect(deployment.spec?.replicas).toBe(1)
    expect(containerEnv(deployment).map(entry => entry.name)).not.toContain(
      'CLERUM_STATELESS_LIFECYCLE'
    )
  })

  it('rejects stateless by default when CommunicationChannels reference the host', async () => {
    const { reconciler, appsApi, customApi } = createReconciler({
      countCommunicationChannels: () => 2,
    })
    await reconciler.reconcile(makeStatelessHost({ status: suspendedStatus() }))

    expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(1)
    expect(hostDeploymentBody(appsApi, 'channel-reader-stateless-host').spec?.replicas).toBe(1)
    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(1)
    expect(writes[0].lifecycle?.state).toBe('active')
    expect(writes[0].lifecycle?.reason).toContain('CommunicationChannel')
    const cond = rejectedCondition(writes[0])
    expect(cond.status).toBe('True')
    expect(cond.reason).toContain('ActiveCommunicationChannels')
  })

  it('returns to the normal stateless lifecycle after the last channel is removed', async () => {
    let channelCount = 1
    let serverHost = makeStatelessHost({ status: suspendedStatus(2) })
    const { reconciler, appsApi, customApi } = createReconciler({
      countCommunicationChannels: () => channelCount,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(serverHost))

    await reconciler.reconcile(serverHost)
    expect(hostDeploymentBody(appsApi, serverHost.name).spec?.replicas).toBe(1)

    channelCount = 0
    serverHost = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 2 } },
    })
    appsApi.createNamespacedDeployment.mockClear()
    appsApi.replaceNamespacedDeployment.mockClear()
    await reconciler.reconcile(serverHost)

    const accepted = hostDeploymentBody(appsApi, serverHost.name)
    expect(accepted.spec?.replicas).toBe(1)
    expect(envValue(accepted, 'CLERUM_STATELESS_LIFECYCLE')).toBe('true')
    expect(rejectedCondition(lifecycleStatusWrites(customApi).at(-1)!)).toMatchObject({
      status: 'False',
      reason: 'StatelessEnabled',
    })

    serverHost = makeStatelessHost({ status: suspendedStatus(2) })
    appsApi.createNamespacedDeployment.mockClear()
    appsApi.replaceNamespacedDeployment.mockClear()
    await reconciler.reconcile(serverHost)
    expect(hostDeploymentBody(appsApi, serverHost.name).spec?.replicas).toBe(0)
  })

  it('surfaces a failed channel-reader scale-down and converges on retry', async () => {
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 2 } },
    })
    const { reconciler, appsApi, customApi } = createReconciler({
      countCommunicationChannels: () => 0,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const channelReaderName = `channel-reader-${host.name}`
    const alreadyExists = Object.assign(new Error('Deployment already exists'), { code: 409 })
    const scaleDownFailure = Object.assign(new Error('Deployment replace unavailable'), {
      code: 503,
    })
    let channelReaderReplicas = 1
    let failScaleDown = true

    appsApi.createNamespacedDeployment.mockImplementation(
      async ({ body }: { body: k8s.V1Deployment }) => {
        if (body.metadata?.name === channelReaderName) throw alreadyExists
        return {}
      }
    )
    appsApi.readNamespacedDeployment.mockImplementation(async ({ name }: { name: string }) => {
      if (name === channelReaderName) {
        return {
          metadata: {
            name,
            namespace: 'channels',
            resourceVersion: '7',
            labels: {
              app: 'channel-reader',
              'clerum.io/host': host.name,
              'clerum.io/managed-by': 'host-context-controller',
            },
          },
          spec: { replicas: channelReaderReplicas },
          status: { readyReplicas: channelReaderReplicas },
        }
      }
      return {
        metadata: {
          name,
          namespace: host.namespace,
          resourceVersion: '3',
          labels: {
            'clerum.io/host': host.name,
            'clerum.io/managed-by': 'host-context-controller',
          },
        },
        spec: { replicas: 1 },
        status: { readyReplicas: 1 },
      }
    })
    appsApi.replaceNamespacedDeployment.mockImplementation(
      async ({ name, body }: { name: string; body: k8s.V1Deployment }) => {
        if (name !== channelReaderName) return {}
        if (failScaleDown) throw scaleDownFailure
        channelReaderReplicas = body.spec?.replicas ?? 0
        return {}
      }
    )

    await expect(reconciler.reconcile(host)).rejects.toThrow(
      `Failed to converge channel-reader resources for Host "${host.name}"`
    )
    expect(channelReaderReplicas).toBe(1)
    expect(reconciler.getStatus(host.name).channelReader).toMatchObject({
      expected: false,
      ready: false,
      message: expect.stringContaining('Deployment replace unavailable'),
    })

    failScaleDown = false
    await expect(reconciler.reconcile(host)).resolves.toBeUndefined()
    expect(channelReaderReplicas).toBe(0)
    expect(reconciler.getStatus(host.name).channelReader).toMatchObject({
      expected: false,
      ready: false,
      message: 'Scaled to 0 (no CommunicationChannels)',
    })
  })

  it('retries when a channel-reader disappears after a create conflict', async () => {
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 2 } },
    })
    const { reconciler, appsApi, customApi } = createReconciler({
      countCommunicationChannels: () => 1,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const channelReaderName = `channel-reader-${host.name}`
    const conflict = Object.assign(new Error('Deployment already exists'), { code: 409 })
    const disappeared = Object.assign(new Error('Deployment disappeared'), { code: 404 })
    let injectConflictRace = true
    let channelReaderExists = false

    appsApi.createNamespacedDeployment.mockImplementation(
      async ({ body }: { body: k8s.V1Deployment }) => {
        if (body.metadata?.name !== channelReaderName) return {}
        if (injectConflictRace) throw conflict
        channelReaderExists = true
        return {}
      }
    )
    appsApi.readNamespacedDeployment.mockImplementation(async ({ name }: { name: string }) => {
      if (name === channelReaderName) {
        if (!channelReaderExists) throw disappeared
        return {
          metadata: {
            name,
            namespace: 'channels',
            resourceVersion: '9',
            labels: {
              app: 'channel-reader',
              'clerum.io/host': host.name,
              'clerum.io/managed-by': 'host-context-controller',
            },
          },
          spec: { replicas: 1 },
          status: { readyReplicas: 1 },
        }
      }
      return {
        metadata: {
          name,
          namespace: host.namespace,
          resourceVersion: '4',
          labels: {
            'clerum.io/host': host.name,
            'clerum.io/managed-by': 'host-context-controller',
          },
        },
        spec: { replicas: 1 },
        status: { readyReplicas: 1 },
      }
    })

    await expect(reconciler.reconcile(host)).rejects.toThrow(
      `Failed to converge channel-reader resources for Host "${host.name}"`
    )
    expect(reconciler.getStatus(host.name).channelReader).toMatchObject({
      expected: true,
      ready: false,
      message: expect.stringContaining('Deployment disappeared'),
    })

    injectConflictRace = false
    await expect(reconciler.reconcile(host)).resolves.toBeUndefined()
    expect(channelReaderExists).toBe(true)
    expect(reconciler.getStatus(host.name).channelReader).toMatchObject({
      expected: true,
      ready: true,
      message: 'Running',
    })
  })

  it('rejects when spec.desktop is present (and never suspends)', async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    await reconciler.reconcile(
      makeStatelessHost({ spec: { desktop: { x11: true } }, status: suspendedStatus() })
    )

    expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(1)
    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(1)
    expect(writes[0].lifecycle?.state).toBe('active')
    const cond = rejectedCondition(writes[0])
    expect(cond.status).toBe('True')
    expect(cond.reason).toContain('DesktopEnabled')
  })

  it('rejects when 2+ SFS wfc pods are provably on different nodes', async () => {
    const mounts: ResolvedSfsMount[] = [
      { name: 'sfs-a', namespace: 'mcp-host', pvcName: 'sfs-a-pvc', mountPath: '/mnt/sfs-a' },
      { name: 'sfs-b', namespace: 'mcp-host', pvcName: 'sfs-b-pvc', mountPath: '/mnt/sfs-b' },
    ]
    const { reconciler, appsApi, coreApi, customApi } = createReconciler({
      resolveContextMounts: async () => mounts,
    })
    coreApi.listNamespacedPod.mockImplementation(
      ({ labelSelector }: { labelSelector?: string } = {}) =>
        Promise.resolve({
          items: [{ spec: { nodeName: labelSelector?.includes('sfs-a') ? 'node-1' : 'node-2' } }],
        })
    )
    await reconciler.reconcile(makeStatelessHost({ status: suspendedStatus() }))

    expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(1)
    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(1)
    expect(writes[0].lifecycle?.state).toBe('active')
    expect(writes[0].lifecycle?.reason).toContain('node-1')
    const cond = rejectedCondition(writes[0])
    expect(cond.status).toBe('True')
    expect(cond.reason).toContain('SfsColocationUnsatisfiable')
  })

  it('accepts 2+ SFS when all wfc pods share one node (suspension preserved)', async () => {
    const mounts: ResolvedSfsMount[] = [
      { name: 'sfs-a', namespace: 'mcp-host', pvcName: 'sfs-a-pvc', mountPath: '/mnt/sfs-a' },
      { name: 'sfs-b', namespace: 'mcp-host', pvcName: 'sfs-b-pvc', mountPath: '/mnt/sfs-b' },
    ]
    const { reconciler, appsApi, coreApi, customApi } = createReconciler({
      resolveContextMounts: async () => mounts,
    })
    coreApi.listNamespacedPod.mockResolvedValue({ items: [{ spec: { nodeName: 'node-1' } }] })
    await reconciler.reconcile(makeStatelessHost({ status: suspendedStatus(4) }))

    expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(0)
    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(1)
    expect(writes[0].lifecycle).toEqual({ state: 'suspended', wakeHandledGeneration: 4 })
    expect(rejectedCondition(writes[0]).status).toBe('False')
  })

  it('hard-rejects on the FIRST stateless reconcile when a channel already exists (reverse arrival order)', async () => {
    // Addendum 6 (order independence): the operator scenario is a STATEFUL Host
    // with an active channel whose spec is then flipped to stateless:true. The
    // decision is state-derived, not arrival-order-dependent — the confirmed
    // channel must hard-reject from the very first stateless-requesting
    // reconcile; stateless must never be transiently enabled.
    const { reconciler, appsApi, customApi } = createReconciler({
      countCommunicationChannels: () => 1,
    })
    // Prior stateful projection: the Host ran active with the channel and is
    // now flipped to stateless:true. The AP-1 fresh read agrees with the cached
    // snapshot — this scenario has no concurrent heartbeat transition, and the
    // shared mock's default fresh object is a SUSPENDED host, which would
    // otherwise inject an unrelated echo.
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 0 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue({
      metadata: {
        name: host.name,
        namespace: host.namespace,
        uid: host.uid,
        resourceVersion: '42',
      },
      spec: host.spec,
      status: host.status,
    })

    await reconciler.reconcile(host)

    const writes = lifecycleStatusWrites(customApi)
    // Never transiently enabled: EVERY status write carries the rejection and
    // stays active. (This tree has no status.lifecycle.effectiveMode field, so
    // the "never transiently stateless" invariant is asserted through the
    // durable rejection condition + state, which is what it projects here.)
    expect(writes.length).toBeGreaterThan(0)
    for (const write of writes) {
      expect(write.lifecycle?.state).toBe('active')
      expect(rejectedCondition(write)).toMatchObject({
        status: 'True',
        reason: 'ActiveCommunicationChannels',
      })
    }
    // The status reason is present immediately, naming the count + recovery.
    expect(writes.at(-1)!.lifecycle?.reason).toBe(
      '1 CommunicationChannel(s) reference this Host; disassociate them to enable the requested stateless lifecycle'
    )
    // Stateful active runtime (no lifecycle env).
    expect(hostDeploymentBody(appsApi, host.name).spec?.replicas).toBe(1)
    expect(containerEnv(hostDeploymentBody(appsApi, host.name)).map(e => e.name)).not.toContain(
      'CLERUM_STATELESS_LIFECYCLE'
    )
  })

  it('surfaces the disassociation recovery action in the StatelessEnableRejected condition message', async () => {
    // Operator-visibility contract (control-ui renders condition.message
    // verbatim): the recovery action MUST live in the condition message, not
    // only in lifecycle.reason.
    const { reconciler, customApi } = createReconciler({
      countCommunicationChannels: () => 3,
    })

    await reconciler.reconcile(makeStatelessHost())

    const condition = rejectedCondition(lifecycleStatusWrites(customApi).at(-1)!)
    expect(condition.status).toBe('True')
    expect(condition.reason).toBe('ActiveCommunicationChannels')
    expect(condition.message).toBe(
      '3 CommunicationChannel(s) reference this Host; disassociate them to enable the requested stateless lifecycle'
    )
  })
})

describe('HostReconciler stateless lifecycle — kill-switches', () => {
  it('default channel policy kill-switches stateless to active + condition', async () => {
    const { reconciler, appsApi, customApi } = createReconciler({
      countCommunicationChannels: () => 1,
    })
    await reconciler.reconcile(makeStatelessHost({ status: suspendedStatus(3) }))

    expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(1)
    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(1)
    expect(writes[0].lifecycle).toEqual({
      state: 'active',
      wakeHandledGeneration: 3,
      reason:
        '1 CommunicationChannel(s) reference this Host; disassociate them to enable the requested stateless lifecycle',
    })
    expect(rejectedCondition(writes[0]).status).toBe('True')
  })

  it('kill-switch: stateless:false returns a suspended host to active + replicas 1', async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    await reconciler.reconcile(
      makeStatelessHost({ spec: { lifecycle: { stateless: false } }, status: suspendedStatus(5) })
    )

    expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(1)
    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(1)
    expect(writes[0].lifecycle).toEqual({ state: 'active', wakeHandledGeneration: 5 })
    const cond = rejectedCondition(writes[0])
    expect(cond.status).toBe('False')
    expect(cond.reason).toBe('StatelessDisabled')
  })

  it('kill-switch: removing spec.lifecycle returns a suspended host to active', async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    const host = makeHost({ name: 'stateless-host', status: suspendedStatus(2) })
    customApi.getNamespacedCustomObject.mockResolvedValue({
      metadata: {
        name: host.name,
        namespace: host.namespace,
        uid: host.uid,
        resourceVersion: '42',
      },
      spec: host.spec,
      status: host.status,
    })
    await reconciler.reconcile(host)

    expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(1)
    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(1)
    expect(writes[0].lifecycle).toEqual({ state: 'active', wakeHandledGeneration: 2 })
  })
})

describe('HostReconciler stateless lifecycle — status write idempotence', () => {
  it('writes status once for an unchanged assessment across reconciles', async () => {
    const infrastructureTelemetryReporter = createTelemetryReporterMock()
    const { reconciler, customApi } = createReconciler({ infrastructureTelemetryReporter })
    const host = makeStatelessHost()
    await reconciler.reconcile(host)
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
    await reconciler.reconcile(host)
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
    expect(infrastructureTelemetryReporter.enqueue).toHaveBeenCalledTimes(3)
    expect(
      vi
        .mocked(infrastructureTelemetryReporter.enqueue)
        .mock.calls.filter(([event]) => event.telemetryType === 'lifecycle_transition')
    ).toHaveLength(1)
  })

  it('skips the write when the observed status already matches', async () => {
    const infrastructureTelemetryReporter = createTelemetryReporterMock()
    const { reconciler, customApi } = createReconciler({ infrastructureTelemetryReporter })
    const host = makeStatelessHost({
      status: {
        lifecycle: { state: 'active', wakeHandledGeneration: 0 },
        conditions: [
          {
            type: 'StatelessEnableRejected',
            status: 'False',
            reason: 'StatelessEnabled',
            message: 'stateless lifecycle is enabled',
            lastTransitionTime: '2026-01-01T00:00:00.000Z',
          },
          {
            type: 'StatelessPullPolicyRejected',
            status: 'False',
            reason: 'StatelessPullPolicyAccepted',
            message: 'stateless imagePullPolicy resolves to Always',
            lastTransitionTime: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    })
    // FIX 1 replicas guard: state the server-side truth explicitly — the
    // fresh read must agree with the observed (converged) active status.
    customApi.getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: 'stateless-host', namespace: 'mcp-host', uid: 'stateless-host-uid' },
      spec: {
        host: 'stateless-host',
        contextRef: 'context-a',
        secretRef: 'host-secret',
        lifecycle: { stateless: true },
      },
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 0 } },
    })
    await reconciler.reconcile(host)
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    expect(infrastructureTelemetryReporter.enqueue).not.toHaveBeenCalledWith(
      expect.objectContaining({ telemetryType: 'lifecycle_transition' })
    )
  })

  it('never writes status for a host that has not opted into the lifecycle', async () => {
    const infrastructureTelemetryReporter = createTelemetryReporterMock()
    const { reconciler, customApi } = createReconciler({ infrastructureTelemetryReporter })
    await reconciler.reconcile(makeHost())
    expect(customApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
    expect(infrastructureTelemetryReporter.enqueue).not.toHaveBeenCalledWith(
      expect.objectContaining({ telemetryType: 'lifecycle_transition' })
    )
  })

  it('does not report a lifecycle transition when the status write fails', async () => {
    const infrastructureTelemetryReporter = createTelemetryReporterMock()
    const { reconciler, customApi } = createReconciler({ infrastructureTelemetryReporter })
    customApi.patchNamespacedCustomObjectStatus.mockRejectedValue(new Error('write failed'))

    await reconciler.reconcile(makeStatelessHost())

    expect(infrastructureTelemetryReporter.enqueue).not.toHaveBeenCalledWith(
      expect.objectContaining({ telemetryType: 'lifecycle_transition' })
    )
  })
})

describe('HostReconciler stateless lifecycle — AP-1 fresh-read status writer', () => {
  function freshHostRead(lifecycle: {
    state: 'active' | 'draining' | 'suspended'
    wakeHandledGeneration: number
    reason?: string
  }) {
    return {
      metadata: {
        name: 'stateless-host',
        namespace: 'mcp-host',
        uid: 'stateless-host-uid',
        resourceVersion: '42',
      },
      spec: {
        host: 'stateless-host',
        contextRef: 'context-a',
        secretRef: 'host-secret',
        lifecycle: { stateless: true },
      },
      status: { lifecycle },
    }
  }

  it('preserves a fresher heartbeat suspend over a stale accepted assessment (the 8th costume)', async () => {
    const { reconciler, customApi } = createReconciler()
    // Cached watch-cache snapshot: the reconcile assessment is derived from
    // THIS (draining, gen 1) and has no conditions[], so the accepted-path
    // status writer fires on the conditions transition.
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'draining', wakeHandledGeneration: 1 } },
    })
    // Server-side truth: a heartbeat suspend landed AFTER the snapshot but
    // BEFORE the writer's fresh read (higher generation). The precondition
    // passes trivially, so a verbatim `assessment.lifecycle` write would
    // resurrect the Host to draining/gen-1 with no wake. The AP-1 fix must
    // re-source state + monotonic generation from fresh.
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'suspended', wakeHandledGeneration: 5 })
    )

    await reconciler.reconcile(host)

    const writes = lifecycleStatusWrites(customApi)
    expect(writes.length).toBeGreaterThanOrEqual(1)
    // Reverting the fix (writing assessment.lifecycle verbatim) yields
    // { state: 'draining', wakeHandledGeneration: 1 } here and fails.
    expect(writes.at(-1)?.lifecycle).toEqual({ state: 'suspended', wakeHandledGeneration: 5 })
  })

  it('never regresses wakeHandledGeneration below the fresh value on an accepted echo', async () => {
    const { reconciler, customApi } = createReconciler()
    // Cached snapshot active/gen 2 (no conditions → writer fires); fresh is
    // active but at a higher generation a concurrent wake already handled.
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 2 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'active', wakeHandledGeneration: 9 })
    )

    await reconciler.reconcile(host)

    const writes = lifecycleStatusWrites(customApi)
    expect(writes.at(-1)?.lifecycle).toEqual({ state: 'active', wakeHandledGeneration: 9 })
  })

  it('kill-switch STILL forces active over a suspended fresh read (no over-correction)', async () => {
    const { reconciler, customApi } = createReconciler()
    // Kill-switch: stateless disabled on a currently-suspended Host. The
    // assessment INTENDS state=active as an operator-visible kill-switch; that
    // override must win even though the fresh read is still suspended.
    const host = makeStatelessHost({
      spec: { lifecycle: { stateless: false } },
      status: { lifecycle: { state: 'suspended', wakeHandledGeneration: 4 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'suspended', wakeHandledGeneration: 4 })
    )

    await reconciler.reconcile(host)

    const writes = lifecycleStatusWrites(customApi)
    expect(writes.at(-1)?.lifecycle).toEqual({ state: 'active', wakeHandledGeneration: 4 })
  })

  it('rejection STILL forces active + message over a suspended fresh read (no over-correction)', async () => {
    const { reconciler, customApi } = createReconciler({
      countCommunicationChannels: () => 1,
    })
    // Rejection (an active CommunicationChannel references the Host) on a
    // currently-suspended Host: the assessment forces active + the rejection
    // message as reason. That override must win over the suspended fresh read.
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'suspended', wakeHandledGeneration: 3 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'suspended', wakeHandledGeneration: 3 })
    )

    await reconciler.reconcile(host)

    const writes = lifecycleStatusWrites(customApi)
    expect(writes.at(-1)?.lifecycle).toEqual({
      state: 'active',
      wakeHandledGeneration: 3,
      reason:
        '1 CommunicationChannel(s) reference this Host; disassociate them to enable the requested stateless lifecycle',
    })
  })

  it('reject-while-active carries the rejection message onto the fresh active state (not dropped)', async () => {
    const { reconciler, customApi } = createReconciler({
      countCommunicationChannels: () => 1,
    })
    // A rejection fires while the Host is ALREADY active: assessment.state
    // ('active') === cachedState ('active'), so the plain state-diff
    // discriminator routes it to the ECHO branch, which would re-source the
    // reason via isHeartbeatManagedLifecycleReason and DROP the rejection
    // message (not heartbeat-managed). The reject-branch discriminator must
    // recognise condition.status='True' as an INTENDED reason override and
    // stamp the rejection message onto the fresh state instead.
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 2 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'active', wakeHandledGeneration: 2 })
    )

    await reconciler.reconcile(host)

    const writes = lifecycleStatusWrites(customApi)
    expect(writes.at(-1)?.lifecycle).toEqual({
      state: 'active',
      wakeHandledGeneration: 2,
      reason:
        '1 CommunicationChannel(s) reference this Host; disassociate them to enable the requested stateless lifecycle',
    })
  })

  it('reject-while-active keeps state from FRESH (8th costume preserved): a suspend that landed is not resurrected', async () => {
    const { reconciler, customApi } = createReconciler({
      countCommunicationChannels: () => 1,
    })
    // Cached active, but a heartbeat suspend landed between the snapshot and
    // the writer's fresh read (fresh = suspended, gen 5). The rejection reason
    // is an intended override, but STATE must still come from fresh — the
    // reject branch must NOT reintroduce the 8th costume by echoing the cached
    // active state over a just-suspended Host.
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 3 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'suspended', wakeHandledGeneration: 5, reason: 'idle' })
    )

    await reconciler.reconcile(host)

    const writes = lifecycleStatusWrites(customApi)
    expect(writes.at(-1)?.lifecycle).toEqual({
      state: 'suspended',
      wakeHandledGeneration: 5,
      reason:
        '1 CommunicationChannel(s) reference this Host; disassociate them to enable the requested stateless lifecycle',
    })
  })

  it('pure accepted-path echo (no rejection) still preserves ONLY heartbeat-managed reasons', async () => {
    const { reconciler, customApi } = createReconciler()
    // Accepted (no rejection): condition.status='False'. The echo branch must
    // keep the pre-FIX behaviour — state from fresh, and reason preserved only
    // when heartbeat-managed. A non-heartbeat-managed fresh reason is dropped.
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 0 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({
        state: 'active',
        wakeHandledGeneration: 0,
        reason: 'some stale non-heartbeat reason',
      })
    )

    await reconciler.reconcile(host)

    const writes = lifecycleStatusWrites(customApi)
    // Reason dropped (not heartbeat-managed, no rejection intending an override).
    expect(writes.at(-1)?.lifecycle).toEqual({ state: 'active', wakeHandledGeneration: 0 })
  })
})

describe('HostReconciler stateless lifecycle — initContainer and mounts', () => {
  it('adds the workspace-layout initContainer with dual subPath mounts', () => {
    const { reconciler } = createReconciler()
    const dep = reconciler.buildDeployment(makeStatelessHost())

    const initContainers = dep.spec?.template?.spec?.initContainers
    if (!initContainers || initContainers.length !== 1) {
      throw new Error('expected exactly one initContainer on the stateless pod')
    }
    const init = initContainers[0]
    expect(init.name).toBe('workspace-layout-init')
    expect(init.image).toBe('clerum/mcp-host:0.6.0')
    expect(init.command?.[0]).toBe('/bin/sh')
    expect(init.command?.[2]).toContain('assert_managed_dir "$root/workspace" workspace')
    expect(init.command?.[2]).toContain('directory is a symlink')
    expect(init.command?.[2]).toContain('state.db-wal')
    expect(init.volumeMounts).toEqual([{ name: 'workspace', mountPath: '/mnt/workspace-root' }])
    expect(init.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      runAsUser: 1001,
      runAsGroup: 1001,
      capabilities: { drop: ['ALL'] },
      seccompProfile: { type: 'RuntimeDefault' },
    })

    const mounts = dep.spec?.template?.spec?.containers?.[0]?.volumeMounts ?? []
    expect(mounts).toContainEqual({
      name: 'workspace',
      mountPath: '/workspace',
      subPath: 'workspace',
    })
    expect(mounts).toContainEqual({
      name: 'workspace',
      mountPath: '/var/lib/clerum/state',
      subPath: 'state',
    })
  })

  it('keeps the non-stateless pod spec identical to the legacy shape', () => {
    const { reconciler } = createReconciler()
    const dep = reconciler.buildDeployment(makeHost())

    expect(dep.spec?.template?.spec?.initContainers).toBeUndefined()
    const mounts = dep.spec?.template?.spec?.containers?.[0]?.volumeMounts ?? []
    expect(mounts).toContainEqual({ name: 'workspace', mountPath: '/workspace' })
    const serialized = JSON.stringify(dep)
    expect(serialized).not.toContain('subPath')
    expect(serialized).not.toContain('CLERUM_STATELESS_LIFECYCLE')
    expect(serialized).not.toContain('workspace-layout-init')
    // An explicit non-stateless lifecycle argument yields the exact same manifest.
    const explicit = reconciler.buildDeployment(makeHost(), [], '', {
      stateless: false,
      state: 'active',
    })
    expect(explicit).toEqual(dep)
  })
})

describe('HostReconciler stateless lifecycle — suspension durability', () => {
  it('keeps a suspended host at replicas=0 across full reconciles (no resurrection)', async () => {
    const { reconciler, appsApi, customApi } = createReconciler()
    const host = makeStatelessHost({ status: suspendedStatus(7) })

    await reconciler.reconcile(host)
    expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(0)
    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(1)
    expect(writes[0].lifecycle).toEqual({ state: 'suspended', wakeHandledGeneration: 7 })
    expect(reconciler.getStatus('stateless-host').message).toContain('Suspended')

    // Simulate the periodic resync: a second reconcile of the same cached CRD
    // must not scale the Deployment back up (the resurrection bug).
    appsApi.createNamespacedDeployment.mockClear()
    appsApi.replaceNamespacedDeployment.mockClear()
    await reconciler.reconcile(host)
    expect(hostDeploymentBody(appsApi, 'stateless-host').spec?.replicas).toBe(0)
    // And the unchanged status is not rewritten.
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
  })
})

describe('HostReconciler stateless lifecycle — probe tuning (Stage 6, W7)', () => {
  it('gives the stateless pod an aggressive startup probe preserving the 310s allowance', () => {
    const { reconciler } = createReconciler()
    const container =
      reconciler.buildDeployment(makeStatelessHost()).spec?.template?.spec?.containers?.[0]
    expect(container?.startupProbe).toEqual({
      httpGet: { path: '/v1/runtime/live', port: 'http' },
      initialDelaySeconds: 0,
      periodSeconds: 2,
      timeoutSeconds: 2,
      // 0 + 2s × 155 = 310s — same ceiling as the legacy 10 + 5s × 60.
      failureThreshold: 155,
    })
    expect(container?.readinessProbe?.initialDelaySeconds).toBe(0)
    expect(container?.readinessProbe?.periodSeconds).toBe(10)
  })

  it('keeps the non-stateless probes byte-identical to the legacy shape', () => {
    const { reconciler } = createReconciler()
    const container = reconciler.buildDeployment(makeHost()).spec?.template?.spec?.containers?.[0]
    expect(container?.startupProbe).toEqual({
      httpGet: { path: '/v1/runtime/live', port: 'http' },
      initialDelaySeconds: 10,
      periodSeconds: 5,
      timeoutSeconds: 2,
      failureThreshold: 60,
    })
    expect(container?.readinessProbe).toEqual({
      httpGet: { path: '/v1/runtime/health', port: 'http' },
      initialDelaySeconds: 20,
      periodSeconds: 10,
      timeoutSeconds: 2,
      failureThreshold: 6,
    })
  })
})

describe('HostReconciler stateless lifecycle — guarded image pull policy (Stage 6, W5)', () => {
  afterEach(() => {
    config.statelessImagePullPolicy = ''
    config.hostImage = 'clerum/mcp-host:0.6.0'
    vi.restoreAllMocks()
  })

  function podContainers(dep: k8s.V1Deployment) {
    const container = dep.spec?.template?.spec?.containers?.[0]
    const init = dep.spec?.template?.spec?.initContainers?.[0]
    if (!container) {
      throw new Error('Deployment has no mcp-host container')
    }
    return { container, init }
  }

  it('applies IfNotPresent for an immutable sha-<gitsha> tag', () => {
    config.statelessImagePullPolicy = 'IfNotPresent'
    config.hostImage = 'clerum/mcp-host:sha-abc1234'
    const { reconciler } = createReconciler()
    const { container, init } = podContainers(reconciler.buildDeployment(makeStatelessHost()))
    expect(container.imagePullPolicy).toBe('IfNotPresent')
    expect(init?.imagePullPolicy).toBe('IfNotPresent')
  })

  it('applies IfNotPresent for a digest-pinned reference', () => {
    config.statelessImagePullPolicy = 'IfNotPresent'
    config.hostImage = `clerum/mcp-host@sha256:${'a'.repeat(64)}`
    const { reconciler } = createReconciler()
    const { container, init } = podContainers(reconciler.buildDeployment(makeStatelessHost()))
    expect(container.imagePullPolicy).toBe('IfNotPresent')
    expect(init?.imagePullPolicy).toBe('IfNotPresent')
  })

  it('IfNotPresent + mutable tag: policy KEPT (pod stays pullable) + advisory condition + warn', async () => {
    // The image-skew guard must never override IfNotPresent to an unpullable
    // Always for a node-local image (regression: T2 minikube ImagePullBackOff).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    config.statelessImagePullPolicy = 'IfNotPresent' // hostImage stays 0.6.0 (mutable)
    const { reconciler, appsApi, customApi } = createReconciler()
    await reconciler.reconcile(makeStatelessHost())

    const dep = hostDeploymentBody(appsApi, 'stateless-host')
    const { container, init } = podContainers(dep)
    // Policy is preserved — NOT forced to Always (which a node-local image
    // cannot pull). This is the whole point of the guard being advisory.
    expect(container.imagePullPolicy).toBe('IfNotPresent')
    expect(init?.imagePullPolicy).toBe('IfNotPresent')

    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(1)
    const cond = writes[0].conditions?.find(c => c.type === 'StatelessPullPolicyRejected')
    if (!cond) {
      throw new Error('StatelessPullPolicyRejected condition missing from status write')
    }
    // Operator-visible advisory (the stale-cached-image-on-wake risk stands).
    expect(cond.status).toBe('True')
    expect(cond.reason).toBe('MutableImageReference')
    expect(cond.message).toContain('clerum/mcp-host:0.6.0')
    expect(cond.message).not.toContain('Always is enforced')

    const advisoryLogs = warnSpy.mock.calls.filter(args =>
      String(args[0]).includes('serves old code on wake')
    )
    expect(advisoryLogs).toHaveLength(1)
    expect(String(advisoryLogs[0][0])).toContain('clerum/mcp-host:0.6.0')

    // A second reconcile of the same image does not repeat the advisory.
    await reconciler.reconcile(makeStatelessHost())
    expect(
      warnSpy.mock.calls.filter(args => String(args[0]).includes('serves old code on wake'))
    ).toHaveLength(1)
  })

  it('inherits the global policy when the override is unset', () => {
    // statelessImagePullPolicy stays '' (the default) → global 'Always'.
    const { reconciler } = createReconciler()
    const { container, init } = podContainers(reconciler.buildDeployment(makeStatelessHost()))
    expect(container.imagePullPolicy).toBe('Always')
    expect(init?.imagePullPolicy).toBe('Always')
  })

  it('keeps the non-stateless pod on the global policy even when the override is set', () => {
    config.statelessImagePullPolicy = 'IfNotPresent'
    config.hostImage = 'clerum/mcp-host:sha-abc1234'
    const { reconciler } = createReconciler()
    const { container, init } = podContainers(reconciler.buildDeployment(makeHost()))
    expect(container.imagePullPolicy).toBe('Always')
    expect(init).toBeUndefined()
  })
})
