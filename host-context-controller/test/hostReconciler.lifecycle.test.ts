import { afterEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { config } from '../src/config'
import { mintHostGfsToken } from '../src/gfsHostBinding'
import {
  type EffectiveHostLifecycle,
  HostReconciler,
  OAUTH_USER_TOKEN_SCOPE,
  type ResolvedSfsMount,
} from '../src/hostReconciler'
import type { InfrastructureTelemetryReporter } from '../src/infrastructureTelemetryReporter'
import { HostContextLogger } from '../src/logger'
import { issueMcpHostRuntimeTokens } from '../src/mcpHostRuntimeTokenIssuerClient'
import {
  MCP_HOST_GFS_TOKEN_SECRET_KEY,
  MCP_HOST_RUNTIME_TOKEN_SECRET_ACCESS_KEY,
  MCP_HOST_RUNTIME_TOKEN_SECRET_CONTROL_KEY,
  MCP_HOST_RUNTIME_TOKEN_SECRET_REFRESH_KEY,
} from '../src/secretFactory'
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

/**
 * A hand-built credential record with the identity, revision and refresh-window
 * annotations only. It deliberately omits the bootstrap-state, rollout marker
 * and scope hash the producer always writes, so it models a legacy record. It
 * is kept for the held-runtime identity guards and the GFS renewal window,
 * which read none of those. A test whose decision depends on the bootstrap or
 * scope annotations uses `mintedRuntimeCredentialRecord` instead.
 */
function runtimeCredentialRecord(
  host: HostCRD,
  options: {
    gfsRefreshBefore?: string
    frontsOAuthServer?: string
    hasChannelIngress?: string
    hostUid?: string
    managedByHost?: boolean
  } = {}
) {
  const data = {
    [MCP_HOST_RUNTIME_TOKEN_SECRET_ACCESS_KEY]: Buffer.from('access-value').toString('base64'),
    [MCP_HOST_RUNTIME_TOKEN_SECRET_REFRESH_KEY]: Buffer.from('refresh-value').toString('base64'),
    [MCP_HOST_RUNTIME_TOKEN_SECRET_CONTROL_KEY]: Buffer.from('control-value').toString('base64'),
    [MCP_HOST_GFS_TOKEN_SECRET_KEY]: Buffer.from('gfs-value').toString('base64'),
  }
  const revision = (
    HostReconciler as unknown as {
      runtimeTokenSecretRevision(data: Record<string, string>): string
    }
  ).runtimeTokenSecretRevision(data)
  return {
    metadata: {
      name: `host-${host.name}-mcp-host-runtime-tokens`,
      namespace: host.namespace,
      resourceVersion: '88',
      labels:
        options.managedByHost === false
          ? { 'clerum.io/managed-by': 'someone-else' }
          : {
              'clerum.io/managed-by': 'host-context-controller',
              'clerum.io/host': host.name,
            },
      annotations: {
        'clerum.io/gfs-token-host-uid': options.hostUid ?? host.uid ?? '',
        'clerum.io/runtime-token-secret-revision': revision,
        'clerum.io/runtime-token-has-channel-ingress': options.hasChannelIngress ?? 'false',
        'clerum.io/runtime-token-fronts-oauth-server': options.frontsOAuthServer ?? 'false',
        'clerum.io/gfs-token-refresh-before':
          options.gfsRefreshBefore ?? '2999-01-01T00:00:00.000Z',
      },
    },
    data,
  } as unknown as k8s.V1Secret
}

function trustedRuntimeDeployment(
  reconciler: HostReconciler,
  host: HostCRD,
  options: { readyReplicas?: number; replicas?: number } = {}
) {
  const deployment = reconciler.buildDeployment(host)
  deployment.metadata = {
    ...deployment.metadata,
    uid: `deployment-${host.name}`,
    resourceVersion: '91',
    labels: {
      ...(deployment.metadata?.labels ?? {}),
      'clerum.io/managed-by': 'host-context-controller',
      'clerum.io/host': host.name,
    },
    annotations: {
      ...(deployment.metadata?.annotations ?? {}),
      'clerum.io/host-uid': host.uid ?? '',
    },
  }
  if (deployment.spec) {
    deployment.spec.replicas = options.replicas ?? 1
  }
  deployment.status = { readyReplicas: options.readyReplicas ?? 1 }
  return deployment
}

function markPersistedRuntimeTrusted(
  deployment: k8s.V1Deployment,
  host: HostCRD,
  readyReplicas = 1
): k8s.V1Deployment {
  deployment.metadata = {
    ...deployment.metadata,
    labels: {
      ...(deployment.metadata?.labels ?? {}),
      'clerum.io/managed-by': 'host-context-controller',
      'clerum.io/host': host.name,
    },
    annotations: {
      ...(deployment.metadata?.annotations ?? {}),
      'clerum.io/host-uid': host.uid ?? '',
    },
  }
  deployment.status = { readyReplicas }
  return deployment
}

function encodedRuntimeRefreshMaterial(expiresAtMs: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return [
    encode({ alg: 'none', typ: 'JWT' }),
    encode({ exp: Math.floor(expiresAtMs / 1000) }),
    'test-signature',
  ].join('.')
}

const PRODUCER_RUNTIME_ANNOTATIONS = [
  'clerum.io/runtime-token-bootstrap-state',
  'clerum.io/runtime-token-rollout-required',
  'clerum.io/runtime-token-scope-hash',
] as const

/** Fails loud when a credential fixture lacks an annotation the producer always writes. */
function assertProducerRuntimeAnnotations(record: k8s.V1Secret): k8s.V1Secret {
  const annotations = record.metadata?.annotations ?? {}
  const missing = PRODUCER_RUNTIME_ANNOTATIONS.filter(key => !(key in annotations))
  if (missing.length > 0) {
    throw new Error(`runtime credential fixture lacks producer annotations: ${missing.join(', ')}`)
  }
  return record
}

/**
 * The runtime credential record as HCC persists it, produced by one real
 * `ensureMcpHostRuntimeTokenSecret` mint pass on a dedicated producer
 * reconciler, so the caller's API mocks record none of the producer's calls.
 * The written `stringData` is stored as base64 `data`, the way the apiserver
 * returns it. With `bootstrap: 'consumed'` (the default) a second real pass
 * against a Ready Deployment running the minted revision consumes the
 * bootstrap, which is what a running pod's record looks like. `annotations`
 * overrides only what a test drives explicitly.
 */
async function mintedRuntimeCredentialRecord(
  host: HostCRD,
  options: {
    frontsOAuthServer?: boolean
    hasChannelIngress?: boolean
    bootstrap?: 'fresh' | 'consumed'
    annotations?: Record<string, string>
  } = {}
): Promise<k8s.V1Secret> {
  const {
    reconciler: producer,
    appsApi,
    coreApi,
  } = createReconciler({
    countCommunicationChannels: () => (options.hasChannelIngress ? 1 : 0),
  })
  producer.setHostFrontsOAuthServer(async () => options.frontsOAuthServer ?? false)
  const issue = vi.mocked(issueMcpHostRuntimeTokens)
  const issueDefaults = issue.getMockImplementation()
  if (!issueDefaults) throw new Error('issueMcpHostRuntimeTokens mock has no implementation')
  // A decodable refresh token, so a later reuse decision can reach `current`.
  issue.mockImplementationOnce(async (...args) => ({
    ...(await issueDefaults(...args)),
    refreshToken: encodedRuntimeRefreshMaterial(Date.now() + 3_600_000),
  }))
  coreApi.readNamespacedSecret.mockRejectedValue({ code: 404 })
  await (producer as any).ensureMcpHostRuntimeTokenSecret(host)
  const created = coreApi.createNamespacedSecret.mock.calls.at(-1)?.[0].body as
    | k8s.V1Secret
    | undefined
  if (!created?.stringData) throw new Error('producer pass wrote no runtime credential Secret')
  let record: k8s.V1Secret = {
    ...created,
    metadata: { ...created.metadata, resourceVersion: '88' },
    data: Object.fromEntries(
      Object.entries(created.stringData).map(([key, value]) => [
        key,
        Buffer.from(value).toString('base64'),
      ])
    ),
  }
  delete record.stringData
  if (options.bootstrap !== 'fresh') {
    const revision = record.metadata?.annotations?.['clerum.io/runtime-token-secret-revision']
    if (!revision) throw new Error('producer pass wrote no runtime credential revision')
    const running = trustedRuntimeDeployment(producer, host)
    running.spec!.template!.metadata!.annotations = {
      ...running.spec!.template!.metadata!.annotations,
      'clerum.io/runtime-token-revision': revision,
    }
    appsApi.readNamespacedDeployment.mockResolvedValue(running)
    coreApi.readNamespacedSecret.mockResolvedValue(record)
    await (producer as any).ensureMcpHostRuntimeTokenSecret(host)
    const consumed = coreApi.replaceNamespacedSecret.mock.calls.at(-1)?.[0].body as
      | k8s.V1Secret
      | undefined
    if (
      consumed?.metadata?.annotations?.['clerum.io/runtime-token-bootstrap-state'] !== 'consumed'
    ) {
      throw new Error('producer pass did not consume the runtime credential bootstrap')
    }
    record = consumed
  }
  record.metadata = {
    ...record.metadata,
    annotations: { ...(record.metadata?.annotations ?? {}), ...options.annotations },
  }
  return assertProducerRuntimeAnnotations(record)
}

function withReadableRuntimeRefreshMaterial(record: k8s.V1Secret): k8s.V1Secret {
  const material =
    (
      HostReconciler as unknown as {
        runtimeTokenSecretData(record: k8s.V1Secret): Record<string, string> | null
      }
    ).runtimeTokenSecretData(record) ?? {}
  return {
    ...record,
    data: {
      ...material,
      [MCP_HOST_RUNTIME_TOKEN_SECRET_REFRESH_KEY]: Buffer.from(
        encodedRuntimeRefreshMaterial(Date.now() + 3_600_000)
      ).toString('base64'),
    },
  }
}

/** Model persisted API state so a loss-of-authority test cannot invent a template. */
function persistHostDeployment(appsApi: MockAppsApi, host: HostCRD, initial: k8s.V1Deployment) {
  let live = structuredClone(initial)
  live.metadata = {
    ...live.metadata,
    uid: live.metadata?.uid ?? 'deployment-uid',
    resourceVersion: live.metadata?.resourceVersion ?? '73',
  }
  const read = appsApi.readNamespacedDeployment.getMockImplementation()!
  appsApi.readNamespacedDeployment.mockImplementation(request =>
    request.name === host.name ? Promise.resolve(structuredClone(live)) : read(request)
  )
  const replace = appsApi.replaceNamespacedDeployment.getMockImplementation()!
  appsApi.replaceNamespacedDeployment.mockImplementation(async request => {
    if (request.name !== host.name) return replace(request)
    expect(request.body.metadata.resourceVersion).toBe(live.metadata!.resourceVersion)
    live = structuredClone(request.body)
    return live
  })
  return () => live
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

  it('preserves stateless+suspended replicas while the channel cache is unsynced', () => {
    const { reconciler } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    const dep = reconciler.buildDeployment(makeStatelessHost({ status: suspendedStatus() }))
    expect(dep.spec?.replicas).toBe(0)
    expect(dep.spec?.template.spec?.priorityClassName).toBe('clerum-interactive-host')
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
      annotations: {
        ...deployment.metadata?.annotations,
        'deployment.kubernetes.io/revision': '7',
      },
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

    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(appsApi.readNamespacedDeployment).toHaveBeenCalledOnce()
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

    appsApi.replaceNamespacedDeployment.mockClear()
    const readDeployment = appsApi.readNamespacedDeployment.getMockImplementation()!
    appsApi.readNamespacedDeployment.mockImplementation(request =>
      request.name === stateful.name ? Promise.resolve(runningStateful) : readDeployment(request)
    )

    const stateless = makeStatelessHost({ name: 'transition-host' })
    customApi.getNamespacedCustomObject.mockResolvedValue({
      metadata: { name: stateless.name, namespace: stateless.namespace, uid: stateless.uid },
      spec: stateless.spec,
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 0 } },
    })

    await reconciler.reconcile(stateless)

    const hostReplacements = appsApi.replaceNamespacedDeployment.mock.calls.filter(
      ([request]) => request.name === stateful.name
    )
    expect(hostReplacements).toHaveLength(1)
    const replacement = hostReplacements[0][0].body as k8s.V1Deployment
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

    // Model a genuinely new principal Deployment, then expose its created state.
    let principalCreated = false
    const readDeployment = appsApi.readNamespacedDeployment.getMockImplementation()!
    appsApi.readNamespacedDeployment.mockImplementation(request => {
      if (request.name === stateless.name && !principalCreated) return Promise.reject({ code: 404 })
      return readDeployment(request)
    })
    appsApi.createNamespacedDeployment.mockImplementation(async request => {
      if (request.body.metadata?.name === stateless.name) principalCreated = true
      return request.body
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
  it('preserves a rejected stateful runtime across cold channel LIST failure and recovery', async () => {
    const host = makeStatelessHost()
    const previous = createReconciler({ countCommunicationChannels: () => 1 })
    previous.customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    vi.spyOn(previous.reconciler as any, 'provisionRuntimeTokenRevision').mockResolvedValue(
      runtimeTokenProvision(host, true)
    )
    await previous.reconciler.reconcile(host)
    host.status = lifecycleStatusWrites(previous.customApi).at(-1)
    expect(rejectedCondition(host.status!).reason).toBe('ActiveCommunicationChannels')
    const applied = hostDeploymentBody(previous.appsApi, host.name)
    applied.metadata = { ...applied.metadata, uid: 'deployment-uid', resourceVersion: '73' }
    const baseline = JSON.stringify(applied.spec!.template)
    expect(containerEnv(applied).some(entry => entry.name === 'CLERUM_STATELESS_LIFECYCLE')).toBe(
      false
    )
    let synced = false
    let channels = 0
    const { reconciler, appsApi, customApi } = createReconciler({
      countCommunicationChannels: () => channels,
      isCommunicationChannelCacheSynced: () => synced,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const live = persistHostDeployment(appsApi, host, applied)
    vi.spyOn(reconciler as any, 'provisionRuntimeTokenRevision').mockResolvedValue(
      runtimeTokenProvision(host, true)
    )
    await reconciler.reconcile(host)
    expect(JSON.stringify(live().spec!.template)).toBe(baseline)
    expect(live().spec!.replicas).toBe(1)
    expect(
      appsApi.replaceNamespacedDeployment.mock.calls.filter(([r]) => r.name === host.name)
    ).toHaveLength(0)
    host.status = lifecycleStatusWrites(customApi).at(-1)
    synced = true
    channels = 1
    await reconciler.reconcile(host)
    expect(JSON.stringify(live().spec!.template)).toBe(baseline)
    expect(rejectedCondition(lifecycleStatusWrites(customApi).at(-1)!).reason).toBe(
      'ActiveCommunicationChannels'
    )
  })

  it('does not use a stale positive channel cache to change an applied stateless template', async () => {
    const host = makeStatelessHost()
    const { reconciler, appsApi, customApi } = createReconciler({
      countCommunicationChannels: () => 1,
      isCommunicationChannelCacheSynced: () => false,
    })
    const read = appsApi.readNamespacedDeployment.getMockImplementation()!
    appsApi.readNamespacedDeployment.mockImplementation(request =>
      request.name === host.name ? Promise.reject({ code: 404 }) : read(request)
    )
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const applied = createReconciler().reconciler.buildDeployment(host)
    applied.metadata = { ...applied.metadata, uid: 'deployment-uid', resourceVersion: '74' }
    const live = persistHostDeployment(appsApi, host, applied)
    await reconciler.reconcile(host)
    expect(live().spec!.template).toEqual(applied.spec!.template)
    expect(rejectedCondition(lifecycleStatusWrites(customApi).at(-1)!).reason).toBe(
      'CommunicationChannelCacheUnsynced'
    )
  })

  it('defers creating a missing Deployment until the channel inventory is authoritative', async () => {
    let synced = false
    const host = makeStatelessHost()
    const { reconciler, appsApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => synced,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const read = appsApi.readNamespacedDeployment.getMockImplementation()!
    appsApi.readNamespacedDeployment.mockImplementation(request =>
      request.name === host.name ? Promise.reject({ code: 404 }) : read(request)
    )
    vi.mocked(issueMcpHostRuntimeTokens).mockClear()
    await reconciler.reconcile(host)
    expect(
      appsApi.createNamespacedDeployment.mock.calls.filter(
        ([r]) => r.body.metadata.name === host.name
      )
    ).toHaveLength(0)
    expect(vi.mocked(issueMcpHostRuntimeTokens)).not.toHaveBeenCalled()
    expect(reconciler.getStatus(host.name)).toMatchObject({ deployed: false, ready: false })
    synced = true
    await reconciler.reconcile(host)
    expect(
      appsApi.createNamespacedDeployment.mock.calls.filter(
        ([r]) => r.body.metadata.name === host.name
      )
    ).toHaveLength(1)
  })

  it('preserves the applied suspended replica count during cache loss', async () => {
    const host = makeStatelessHost({ status: suspendedStatus() })
    const { reconciler, appsApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const applied = createReconciler().reconciler.buildDeployment(host)
    const current = structuredClone(applied)
    current.metadata = { ...current.metadata, uid: 'deployment-uid', resourceVersion: '41' }
    const baseline = JSON.stringify(current.spec!.template)
    appsApi.readNamespacedDeployment.mockImplementation(async () => structuredClone(current))
    await reconciler.reconcile(host)
    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
    expect(current.spec!.replicas).toBe(0)
    expect(JSON.stringify(applied.spec!.template)).toBe(baseline)
    expect(current.spec!.template).toEqual(applied.spec!.template)
  })

  it.each([
    'foreign owner',
    'missing UID',
    'missing resourceVersion',
    'prior Host UID',
    'unannotated legacy',
  ])('does not scale an unverified Deployment during cache loss: %s', async invalid => {
    const host = makeStatelessHost({ status: suspendedStatus() })
    const { reconciler, appsApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const applied = createReconciler().reconciler.buildDeployment(host)
    applied.metadata = { ...applied.metadata, uid: 'deployment-uid', resourceVersion: '73' }
    if (invalid === 'foreign owner') applied.metadata.labels!['clerum.io/host'] = 'another-host'
    if (invalid === 'missing UID') delete applied.metadata.uid
    if (invalid === 'missing resourceVersion') delete applied.metadata.resourceVersion
    if (invalid === 'prior Host UID') {
      applied.metadata.annotations = {
        ...applied.metadata.annotations,
        'clerum.io/host-uid': 'prior-host-uid',
      }
    }
    if (invalid === 'unannotated legacy')
      delete applied.metadata.annotations?.['clerum.io/host-uid']
    appsApi.readNamespacedDeployment.mockResolvedValue(applied)
    await expect(reconciler.reconcile(host)).rejects.toThrow('unverified Deployment')
    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
    expect(appsApi.patchNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('never scales an unannotated legacy Deployment with an existing UID and resourceVersion', async () => {
    const host = makeStatelessHost({ status: suspendedStatus() })
    const { reconciler, appsApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    const legacy = reconciler.buildDeployment(host)
    delete legacy.metadata?.annotations?.['clerum.io/host-uid']
    legacy.metadata = {
      ...legacy.metadata,
      uid: 'deployment-uid',
      resourceVersion: '73',
    }
    appsApi.readNamespacedDeployment.mockResolvedValue(legacy)
    // Derive the held lifecycle from the Host itself so the fixture cannot
    // contradict the durable suspended status.
    const heldLifecycle = reconciler.getEffectiveLifecycle(host)
    expect(heldLifecycle).toEqual({
      stateless: true,
      state: 'suspended',
      suspensionBlocked: true,
    })

    await expect(
      (reconciler as any).ensureDeployment(host, [], undefined, {
        ...heldLifecycle,
        allowScaleUpDuringHold: true,
      })
    ).rejects.toThrow('unverified Deployment')
    expect(appsApi.readNamespacedDeployment).toHaveBeenCalledWith({
      namespace: host.namespace,
      name: host.name,
    })
    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('throws held-path PVC and Service errors before any credential or Deployment mutation', async () => {
    const host = makeStatelessHost({ status: suspendedStatus() })
    host.annotations = { 'clerum.io/wake-requested': '1' }
    const { reconciler, appsApi, coreApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const applied = reconciler.buildDeployment(host)
    applied.spec!.replicas = 0
    applied.spec!.template!.metadata!.annotations = {
      ...applied.spec!.template!.metadata!.annotations,
      'clerum.io/runtime-token-revision': 'applied-runtime-revision',
    }
    markPersistedRuntimeTrusted(applied, host, 0)
    const live = persistHostDeployment(appsApi, host, applied)
    const templateBefore = structuredClone(live().spec!.template)
    const provision = vi
      .spyOn(reconciler as any, 'provisionRuntimeTokenRevision')
      .mockResolvedValue(runtimeTokenProvision(host))
    const ingress = vi
      .spyOn(reconciler as any, 'ensureMcpHostIngressNetworkPolicy')
      .mockResolvedValue('up_to_date')

    coreApi.readNamespacedPersistentVolumeClaim.mockRejectedValueOnce(new Error('PVC read failed'))
    coreApi.readNamespacedService.mockRejectedValueOnce(new Error('Service read failed'))

    const rejection = await reconciler.reconcile(host).then(
      () => undefined,
      (error: unknown) => error
    )

    expect(rejection).toBeInstanceOf(AggregateError)
    expect((rejection as AggregateError).errors.map(error => (error as Error).message)).toEqual([
      'PVC read failed',
      'Service read failed',
    ])
    // Liveness witness: the pass reached the resource reads and the policy
    // phase before rejecting.
    expect(coreApi.readNamespacedPersistentVolumeClaim).toHaveBeenCalledWith({
      namespace: host.namespace,
      name: `${host.name}-workspace`,
    })
    expect(coreApi.readNamespacedService).toHaveBeenCalledWith({
      namespace: host.namespace,
      name: host.name,
    })
    expect(ingress).toHaveBeenCalledWith(host)
    expect(provision).not.toHaveBeenCalled()
    expect(live().spec!.replicas).toBe(0)
    expect(live().spec!.template).toEqual(templateBefore)
  })

  it('rethrows a single held-path PVC error unwrapped and never enters the hold', async () => {
    const host = makeStatelessHost({ status: suspendedStatus() })
    host.annotations = { 'clerum.io/wake-requested': '1' }
    const { reconciler, appsApi, coreApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const applied = reconciler.buildDeployment(host)
    applied.spec!.replicas = 0
    applied.spec!.template!.metadata!.annotations = {
      ...applied.spec!.template!.metadata!.annotations,
      'clerum.io/runtime-token-revision': 'applied-runtime-revision',
    }
    markPersistedRuntimeTrusted(applied, host, 0)
    const live = persistHostDeployment(appsApi, host, applied)
    const templateBefore = structuredClone(live().spec!.template)
    const provision = vi
      .spyOn(reconciler as any, 'provisionRuntimeTokenRevision')
      .mockResolvedValue(runtimeTokenProvision(host))
    const ingress = vi
      .spyOn(reconciler as any, 'ensureMcpHostIngressNetworkPolicy')
      .mockResolvedValue('up_to_date')
    const ready = vi.spyOn(reconciler as any, 'checkDeploymentReady')

    coreApi.readNamespacedPersistentVolumeClaim.mockRejectedValueOnce(new Error('PVC read failed'))

    const rejection = await reconciler.reconcile(host).then(
      () => undefined,
      (error: unknown) => error
    )

    expect(rejection).toBeInstanceOf(Error)
    expect(rejection).not.toBeInstanceOf(AggregateError)
    expect((rejection as Error).message).toBe('PVC read failed')
    // Liveness witness: the pass read the PVC and Service and ran the policy
    // phase, the last step before the throw. The hold path (which would mint
    // credentials for this held wake and poll readiness) never ran.
    expect(coreApi.readNamespacedPersistentVolumeClaim).toHaveBeenCalledWith({
      namespace: host.namespace,
      name: `${host.name}-workspace`,
    })
    expect(coreApi.readNamespacedService).toHaveBeenCalledWith({
      namespace: host.namespace,
      name: host.name,
    })
    expect(ingress).toHaveBeenCalledWith(host)
    expect(provision).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
    expect(live().spec!.replicas).toBe(0)
    expect(live().spec!.template).toEqual(templateBefore)
  })

  it('waits for a verified applied runtime when a wake is requested and the live Deployment has no applied-runtime annotation', async () => {
    const host = makeStatelessHost({ status: suspendedStatus() })
    host.annotations = { 'clerum.io/wake-requested': '1' }
    const { reconciler, appsApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    // A legacy Deployment: owned by the Host and at zero replicas, but its pod
    // template carries no runtime-token-revision annotation.
    const legacy = reconciler.buildDeployment(host)
    legacy.spec!.replicas = 0
    delete legacy.spec!.template!.metadata!.annotations?.['clerum.io/runtime-token-revision']
    markPersistedRuntimeTrusted(legacy, host, 0)
    const live = persistHostDeployment(appsApi, host, legacy)
    const templateBefore = structuredClone(live().spec!.template)
    const provision = vi
      .spyOn(reconciler as any, 'provisionRuntimeTokenRevision')
      .mockResolvedValue(runtimeTokenProvision(host))
    const poll = vi.spyOn(reconciler as any, 'pollReadiness').mockImplementation(() => undefined)

    await reconciler.reconcile(host)

    expect(reconciler.getStatus(host.name)).toEqual({
      deployed: true,
      ready: false,
      message:
        'Waiting for a verified applied runtime before waking during CommunicationChannel inventory loss',
    })
    // Liveness witness: the held pass read the live Deployment before deciding.
    expect(appsApi.readNamespacedDeployment).toHaveBeenCalledWith({
      namespace: host.namespace,
      name: host.name,
    })
    expect(provision).not.toHaveBeenCalled()
    expect(poll).not.toHaveBeenCalled()
    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
    expect(live().spec!.replicas).toBe(0)
    expect(live().spec!.template).toEqual(templateBefore)
  })

  it('converges the held runtime boundary and reports policy failures without polling', async () => {
    // An active, not-Ready held runtime would be polled if the boundary were
    // complete, so only the policy failure keeps the poll from running.
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 1 } },
    })
    const { reconciler, appsApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const applied = reconciler.buildDeployment(host)
    markPersistedRuntimeTrusted(applied, host, 0)
    const live = persistHostDeployment(appsApi, host, applied)
    const readySpy = vi.spyOn(reconciler as any, 'checkDeploymentReady')
    const templateBefore = structuredClone(live().spec!.template)
    const replicasBefore = live().spec!.replicas
    const poll = vi.spyOn(reconciler as any, 'pollReadiness')

    const ingress = vi
      .spyOn(reconciler as any, 'ensureMcpHostIngressNetworkPolicy')
      .mockRejectedValueOnce(new Error('ingress policy failed'))
    const gfsEgress = vi
      .spyOn(reconciler as any, 'ensureMcpHostGfsEgressNetworkPolicy')
      .mockResolvedValue('up_to_date')
    const codexEgress = vi
      .spyOn(reconciler as any, 'reconcileMcpHostCodexProxyEgressNetworkPolicy')
      .mockResolvedValue('up_to_date')

    await reconciler.reconcile(host)

    expect(ingress).toHaveBeenCalledOnce()
    expect(ingress).toHaveBeenCalledWith(host)
    expect(gfsEgress).toHaveBeenCalledOnce()
    expect(codexEgress).toHaveBeenCalledOnce()
    expect(live().spec!.replicas).toBe(replicasBefore)
    expect(live().spec!.template).toEqual(templateBefore)
    expect(reconciler.getStatus(host.name)).toMatchObject({
      deployed: true,
      ready: false,
      message: expect.stringContaining('mcp-host ingress: ingress policy failed'),
    })
    expect(reconciler.getStatus(host.name)?.message).not.toContain('Host PVC')
    expect(reconciler.getStatus(host.name)?.message).not.toContain('Host Service')
    expect(reconciler.getStatus(host.name)?.message).not.toContain('GFS egress')
    expect(reconciler.getStatus(host.name)?.message).not.toContain('Codex proxy egress')
    // Liveness witness: the hold reached its readiness check and found the
    // runtime not Ready, the state in which a complete boundary is polled.
    expect(readySpy).toHaveBeenCalledWith(host.name, host.namespace)
    await expect(readySpy.mock.results[0].value).resolves.toBe(false)
    expect(poll).not.toHaveBeenCalled()
  })

  it('polls readiness after a held wake scales the Host up from zero', async () => {
    const host = makeStatelessHost({ status: suspendedStatus() })
    host.annotations = { 'clerum.io/wake-requested': '1' }
    const { reconciler, appsApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const applied = reconciler.buildDeployment(host)
    applied.spec!.replicas = 0
    applied.spec!.template!.metadata!.annotations = {
      ...applied.spec!.template!.metadata!.annotations,
      'clerum.io/runtime-token-revision': 'applied-runtime-revision',
    }
    markPersistedRuntimeTrusted(applied, host, 0)
    const live = persistHostDeployment(appsApi, host, applied)
    vi.spyOn(reconciler as any, 'provisionRuntimeTokenRevision').mockResolvedValue(
      runtimeTokenProvision(host)
    )
    const poll = vi.spyOn(reconciler as any, 'pollReadiness').mockImplementation(() => undefined)

    await reconciler.reconcile(host)

    expect(live().spec!.replicas).toBe(1)
    expect(reconciler.getStatus(host.name)).toEqual({
      deployed: true,
      ready: false,
      message: 'CommunicationChannel inventory unavailable; preserved applied runtime is not Ready',
    })
    expect(poll).toHaveBeenCalledOnce()
    expect(poll).toHaveBeenCalledWith(host.name, host.namespace)
  })

  it.each([
    {
      runtime: 'Ready',
      readyReplicas: 1,
      ready: true,
      message: 'CommunicationChannel inventory unavailable; preserving applied runtime',
    },
    {
      runtime: 'not Ready',
      readyReplicas: 0,
      ready: false,
      message: 'CommunicationChannel inventory unavailable; preserved applied runtime is not Ready',
    },
  ])(
    'holds a held wake on a suspended Host whose applied runtime still runs ($runtime)',
    async ({ readyReplicas, ready, message }) => {
      // The suspension reached the Host status but its scale-down never reached
      // the Deployment, so the applied runtime still runs at one replica.
      const host = makeStatelessHost({ status: suspendedStatus() })
      host.annotations = { 'clerum.io/wake-requested': '1' }
      const { reconciler, appsApi, customApi } = createReconciler({
        isCommunicationChannelCacheSynced: () => false,
      })
      customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
      const applied = reconciler.buildDeployment(host)
      applied.spec!.replicas = 1
      applied.spec!.template!.metadata!.annotations = {
        ...applied.spec!.template!.metadata!.annotations,
        'clerum.io/runtime-token-revision': 'applied-runtime-revision',
      }
      markPersistedRuntimeTrusted(applied, host, readyReplicas)
      const live = persistHostDeployment(appsApi, host, applied)
      const templateBefore = structuredClone(live().spec!.template)
      const provision = vi
        .spyOn(reconciler as any, 'provisionRuntimeTokenRevision')
        .mockResolvedValue(runtimeTokenProvision(host))
      const readySpy = vi.spyOn(reconciler as any, 'checkDeploymentReady')
      const poll = vi.spyOn(reconciler as any, 'pollReadiness').mockImplementation(() => undefined)

      await reconciler.reconcile(host)

      // Liveness witness: the held pass reached its readiness check.
      expect(readySpy).toHaveBeenCalledWith(host.name, host.namespace)
      await expect(readySpy.mock.results[0].value).resolves.toBe(readyReplicas > 0)
      expect(reconciler.getStatus(host.name)).toEqual({ deployed: true, ready, message })
      // A running runtime renews only its GFS credential; it never mints for
      // the wake, and a not-Ready one is polled instead of renewed.
      expect(provision.mock.calls).toEqual(
        readyReplicas > 0 ? [[host, { targetSuspended: false, refreshGfsOnly: true }]] : []
      )
      expect(poll.mock.calls).toEqual(readyReplicas > 0 ? [] : [[host.name, host.namespace]])
      expect(live().spec!.replicas).toBe(1)
      expect(live().spec!.template).toEqual(templateBefore)
    }
  )

  it('does not report a Deployment applied when create conflict is followed by a missing read', async () => {
    const host = makeStatelessHost()
    const { reconciler, appsApi } = createReconciler()
    appsApi.readNamespacedDeployment
      .mockRejectedValueOnce({ code: 404 })
      .mockRejectedValueOnce({ code: 404 })
    appsApi.createNamespacedDeployment.mockRejectedValueOnce({ code: 409 })

    await expect((reconciler as any).ensureDeployment(host, [], 'runtime-revision')).resolves.toBe(
      false
    )
    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('refreshes only the GFS token for a running held Host during cache loss', async () => {
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 1 } },
    })
    const { reconciler, appsApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const applied = reconciler.buildDeployment(host)
    applied.spec!.template.metadata!.annotations = { 'example.org/applied': 'keep-exactly' }
    markPersistedRuntimeTrusted(applied, host)
    const live = persistHostDeployment(appsApi, host, applied)
    const provision = vi
      .spyOn(reconciler as any, 'provisionRuntimeTokenRevision')
      .mockResolvedValue(runtimeTokenProvision(host))
    await reconciler.reconcile(host)
    expect(provision).toHaveBeenCalledOnce()
    expect(provision).toHaveBeenCalledWith(host, {
      refreshGfsOnly: true,
      targetSuspended: false,
    })
    expect(live().spec!.replicas).toBe(1)
    expect(live().spec!.template).toEqual(applied.spec!.template)
    expect(rejectedCondition(lifecycleStatusWrites(customApi).at(-1)!).reason).toBe(
      'CommunicationChannelCacheUnsynced'
    )
  })

  it('fails closed when held credential renewal cannot verify the runtime identity', async () => {
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 1 } },
    })
    const { reconciler, appsApi, coreApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const applied = reconciler.buildDeployment(host)
    markPersistedRuntimeTrusted(applied, host)
    const live = persistHostDeployment(appsApi, host, applied)
    const templateBefore = structuredClone(live().spec!.template)
    // The record was minted for a previous Host incarnation, so the real
    // refreshGfsOnly provision refuses to renew it and returns null.
    coreApi.readNamespacedSecret.mockResolvedValue(
      runtimeCredentialRecord(host, { hostUid: 'prior-host-uid' }) as any
    )
    const runtimeSecretName = `host-${host.name}-mcp-host-runtime-tokens`
    vi.mocked(issueMcpHostRuntimeTokens).mockClear()

    await reconciler.reconcile(host)

    // Liveness witness: the held renewal read the runtime credential record.
    expect(coreApi.readNamespacedSecret).toHaveBeenCalledWith({
      name: runtimeSecretName,
      namespace: host.namespace,
    })
    expect(reconciler.getStatus(host.name)).toEqual({
      deployed: true,
      ready: false,
      message: 'Held runtime credential renewal is not safely available',
    })
    expect(vi.mocked(issueMcpHostRuntimeTokens)).not.toHaveBeenCalled()
    expect(
      coreApi.replaceNamespacedSecret.mock.calls.filter(
        ([request]) => (request as { name?: string }).name === runtimeSecretName
      )
    ).toHaveLength(0)
    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
    expect(live().spec!.replicas).toBe(1)
    expect(live().spec!.template).toEqual(templateBefore)
  })

  it('keeps a suspended Host at zero replicas during cache loss without a pending wake', async () => {
    const host = makeStatelessHost({ status: suspendedStatus(3) })
    const { reconciler, appsApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const applied = reconciler.buildDeployment(host)
    applied.spec!.template.metadata!.annotations = { 'example.org/applied': 'keep-exactly' }
    applied.spec!.replicas = 0
    const live = persistHostDeployment(appsApi, host, applied)
    const provision = vi
      .spyOn(reconciler as any, 'provisionRuntimeTokenRevision')
      .mockResolvedValue(runtimeTokenProvision(host))

    await reconciler.reconcile(host)

    expect(provision).not.toHaveBeenCalled()
    expect(live().spec!.replicas).toBe(0)
    expect(live().spec!.template).toEqual(applied.spec!.template)
    expect(lifecycleStatusWrites(customApi).at(-1)?.lifecycle).toMatchObject({
      state: 'suspended',
      wakeHandledGeneration: 3,
    })
  })

  it('keeps a preserved suspended wake target at zero replicas during cache loss without a pending wake', async () => {
    // This Deployment IS a preserved wake target (applied runtime revision at
    // zero replicas), so only the missing wake keeps the hold from minting
    // bootstrap credentials and scaling it up.
    const host = makeStatelessHost({ status: suspendedStatus() })
    const { reconciler, appsApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const applied = reconciler.buildDeployment(host)
    applied.spec!.replicas = 0
    applied.spec!.template!.metadata!.annotations = {
      ...applied.spec!.template!.metadata!.annotations,
      'clerum.io/runtime-token-revision': 'applied-runtime-revision',
    }
    markPersistedRuntimeTrusted(applied, host, 0)
    const live = persistHostDeployment(appsApi, host, applied)
    const templateBefore = structuredClone(live().spec!.template)
    const provision = vi
      .spyOn(reconciler as any, 'provisionRuntimeTokenRevision')
      .mockResolvedValue(runtimeTokenProvision(host))
    const ensureDeployment = vi.spyOn(reconciler as any, 'ensureDeployment')
    const poll = vi.spyOn(reconciler as any, 'pollReadiness').mockImplementation(() => undefined)

    await reconciler.reconcile(host)

    // Liveness witness: the pass read the live Deployment and applied the hold
    // with the suspended, cache-loss lifecycle.
    expect(
      appsApi.readNamespacedDeployment.mock.calls.filter(([request]) => request.name === host.name)
        .length
    ).toBeGreaterThan(0)
    expect(ensureDeployment).toHaveBeenCalledOnce()
    expect(ensureDeployment.mock.calls[0][3]).toMatchObject({
      state: 'suspended',
      suspensionBlocked: true,
      allowScaleUpDuringHold: false,
    })
    await expect(ensureDeployment.mock.results[0].value).resolves.toBe(true)
    expect(reconciler.getStatus(host.name)).toEqual({
      deployed: true,
      ready: false,
      message: 'CommunicationChannel inventory unavailable; preserving suspended Host replicas',
    })
    expect(provision).not.toHaveBeenCalled()
    expect(poll).not.toHaveBeenCalled()
    expect(live().spec!.replicas).toBe(0)
    expect(live().spec!.template).toEqual(templateBefore)
  })

  it('does not poll readiness when the held Deployment disappears before it is applied', async () => {
    // An active, not-Ready held runtime with a complete boundary is polled, so
    // only the unapplied Deployment keeps the poll from running.
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 1 } },
    })
    const { reconciler, appsApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const applied = reconciler.buildDeployment(host)
    markPersistedRuntimeTrusted(applied, host, 0)
    persistHostDeployment(appsApi, host, applied)
    const persistedRead = appsApi.readNamespacedDeployment.getMockImplementation()!
    let deleted = false
    appsApi.readNamespacedDeployment.mockImplementation(request =>
      deleted && request.name === host.name ? Promise.reject({ code: 404 }) : persistedRead(request)
    )
    const realEnsureDeployment = (reconciler as any).ensureDeployment.bind(reconciler)
    const ensureDeployment = vi
      .spyOn(reconciler as any, 'ensureDeployment')
      .mockImplementation(async (...args: unknown[]) => {
        // The Deployment is deleted after the hold read it and before it is applied.
        deleted = true
        return realEnsureDeployment(...args)
      })
    const readySpy = vi.spyOn(reconciler as any, 'checkDeploymentReady')
    const poll = vi.spyOn(reconciler as any, 'pollReadiness').mockImplementation(() => undefined)

    await reconciler.reconcile(host)

    // Liveness witness: the hold reached ensureDeployment, whose re-read found
    // the Deployment gone and left it unapplied.
    expect(ensureDeployment).toHaveBeenCalledOnce()
    await expect(ensureDeployment.mock.results[0].value).resolves.toBe(false)
    expect(reconciler.getStatus(host.name)).toEqual({
      deployed: false,
      ready: false,
      message: 'Waiting for CommunicationChannel inventory before creating runtime',
    })
    expect(
      appsApi.createNamespacedDeployment.mock.calls.filter(
        ([request]) => request.body.metadata.name === host.name
      )
    ).toHaveLength(0)
    expect(readySpy).not.toHaveBeenCalled()
    expect(poll).not.toHaveBeenCalled()
  })

  it('uses the fenced replica-only update for a pending wake during cache loss', async () => {
    const host = makeStatelessHost({ status: suspendedStatus() })
    host.annotations = { 'clerum.io/wake-requested': '1' }
    const { reconciler, appsApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const applied = createReconciler().reconciler.buildDeployment(host)
    applied.spec!.replicas = 0
    applied.spec!.template!.metadata!.annotations = {
      ...applied.spec!.template!.metadata!.annotations,
      'clerum.io/runtime-token-revision': 'applied-runtime-revision',
    }
    markPersistedRuntimeTrusted(applied, host, 0)
    const live = persistHostDeployment(appsApi, host, applied)
    const provision = vi
      .spyOn(reconciler as any, 'provisionRuntimeTokenRevision')
      .mockResolvedValue(runtimeTokenProvision(host))
    await reconciler.reconcile(host)
    expect(provision).toHaveBeenCalledOnce()
    expect(provision).toHaveBeenCalledWith(host, {
      forceFreshForWake: true,
      targetSuspended: false,
      preserveDeploymentTemplateOnWake: true,
    })
    expect(provision.mock.invocationCallOrder[0]).toBeLessThan(
      appsApi.replaceNamespacedDeployment.mock.invocationCallOrder.at(-1)!
    )
    expect(appsApi.patchNamespacedDeployment).not.toHaveBeenCalled()
    expect(live().spec!.replicas).toBe(1)
    expect(live().spec!.template).toEqual(applied.spec!.template)
  })

  it('does not apply a channel rejection after that inventory loses authority mid-reconcile', async () => {
    let synced = true
    const host = makeStatelessHost()
    const { reconciler, appsApi, customApi, networkingApi } = createReconciler({
      countCommunicationChannels: () => 1,
      isCommunicationChannelCacheSynced: () => synced,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const applied = createReconciler().reconciler.buildDeployment(host)
    const live = persistHostDeployment(appsApi, host, applied)
    const readPolicy = networkingApi.readNamespacedNetworkPolicy.getMockImplementation()!
    networkingApi.readNamespacedNetworkPolicy.mockImplementation(async request => {
      synced = false
      return readPolicy(request)
    })
    await reconciler.reconcile(host)
    expect(live().spec!.template).toEqual(applied.spec!.template)
    expect(rejectedCondition(lifecycleStatusWrites(customApi).at(-1)!).reason).toBe(
      'CommunicationChannelCacheUnsynced'
    )
  })

  it('preserves the template when authority is lost during the final asynchronous scope lookup', async () => {
    let synced = true
    let lookup = 0
    const host = makeStatelessHost()
    const { reconciler, appsApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => synced,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const applied = reconciler.buildDeployment(host)
    applied.spec!.template.metadata!.annotations = { 'example.org/applied': 'keep-exactly' }
    const live = persistHostDeployment(appsApi, host, applied)
    vi.spyOn(reconciler as any, 'provisionRuntimeTokenRevision').mockResolvedValue(
      runtimeTokenProvision(host)
    )
    // The final lookup loses channel authority and its McpServer read fails too:
    // neither an unobservable OAuth answer nor the lost authority may commit
    // the template.
    reconciler.setHostFrontsOAuthServer(async () => {
      if (++lookup === 1) return false
      synced = false
      throw new Error('mcp-server watch retired')
    })
    await reconciler.reconcile(host)
    // One observed lookup, then the final lookup's three attempts.
    expect(lookup).toBe(4)
    expect(live().spec!.template).toEqual(applied.spec!.template)
    expect(rejectedCondition(lifecycleStatusWrites(customApi).at(-1)!).reason).toBe(
      'CommunicationChannelCacheUnsynced'
    )
  })

  it('preserves an independently confirmed desktop rejection while the channel cache is unknown', async () => {
    const host = makeStatelessHost({ spec: { desktop: { browser: true } } })
    const { reconciler, appsApi, coreApi, customApi } = createReconciler({
      countCommunicationChannels: () => 1,
      isCommunicationChannelCacheSynced: () => false,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    coreApi.readNamespacedSecret.mockResolvedValue({
      metadata: {
        resourceVersion: '1',
        labels: {
          'clerum.io/managed-by': 'host-context-controller',
          'clerum.io/host': host.name,
        },
        annotations: {
          'clerum.io/gfs-token-host-uid': host.uid,
          'clerum.io/runtime-token-has-channel-ingress': 'true',
          'clerum.io/runtime-token-fronts-oauth-server': 'false',
        },
      },
      data: {},
    } as any)
    await reconciler.reconcile(host)
    const condition = rejectedCondition(lifecycleStatusWrites(customApi).at(-1)!)
    expect(condition.reason).toBe('DesktopEnabled')
    expect(condition.status).toBe('True')
    expect(
      containerEnv(hostDeploymentBody(appsApi, host.name)).some(
        entry => entry.name === 'CLERUM_STATELESS_LIFECYCLE'
      )
    ).toBe(false)
  })

  it('defers a confirmed desktop rejection when no trusted scope observation exists', async () => {
    const host = makeStatelessHost({ spec: { desktop: { browser: true } } })
    const { reconciler, appsApi, customApi } = createReconciler({
      countCommunicationChannels: () => 1,
      isCommunicationChannelCacheSynced: () => false,
    })
    const readDeployment = appsApi.readNamespacedDeployment.getMockImplementation()!
    appsApi.readNamespacedDeployment.mockImplementation(request =>
      request.name === host.name ? Promise.reject({ code: 404 }) : readDeployment(request)
    )
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))

    await reconciler.reconcile(host)

    expect(rejectedCondition(lifecycleStatusWrites(customApi).at(-1)!).reason).toBe(
      'DesktopEnabled'
    )
    expect(
      [
        ...appsApi.createNamespacedDeployment.mock.calls,
        ...appsApi.replaceNamespacedDeployment.mock.calls,
      ].filter(
        ([request]) => (request as { body?: k8s.V1Deployment }).body?.metadata?.name === host.name
      )
    ).toHaveLength(0)
    expect(reconciler.getStatus(host.name)).toMatchObject({ deployed: false, ready: false })
  })

  it('does not let a failed live probe narrow a retained OAuth grant before its renewal window', async () => {
    const host = makeStatelessHost()
    const { reconciler, coreApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => true,
    })
    coreApi.readNamespacedSecret.mockResolvedValue(
      await mintedRuntimeCredentialRecord(host, { frontsOAuthServer: true })
    )
    const oauthResolver = vi.fn(async (): Promise<boolean> => {
      throw new Error('oauth lookup unavailable')
    })
    reconciler.setHostFrontsOAuthServer(oauthResolver)
    vi.mocked(issueMcpHostRuntimeTokens).mockClear()

    const provision = await (reconciler as any).ensureMcpHostRuntimeTokenSecret(host)

    // Liveness witness: the record was read and the live probe ran all its attempts.
    expect(coreApi.readNamespacedSecret).toHaveBeenCalled()
    expect(oauthResolver).toHaveBeenCalledTimes(3)
    expect(provision).toBeNull()
    expect(vi.mocked(issueMcpHostRuntimeTokens)).not.toHaveBeenCalled()
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled()
    expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled()
  })

  it('uses the retained channel observation but a live OAuth observation while channel authority is unavailable', async () => {
    const host = makeStatelessHost()
    const countChannels = vi.fn(() => 0)
    const { reconciler, coreApi } = createReconciler({
      countCommunicationChannels: countChannels,
      isCommunicationChannelCacheSynced: () => false,
    })
    coreApi.readNamespacedSecret.mockResolvedValue(
      await mintedRuntimeCredentialRecord(host, {
        frontsOAuthServer: false,
        hasChannelIngress: true,
      })
    )
    const oauthResolver = vi.fn(async () => true)
    reconciler.setHostFrontsOAuthServer(oauthResolver)
    vi.mocked(issueMcpHostRuntimeTokens).mockClear()

    const provision = await (reconciler as any).ensureMcpHostRuntimeTokenSecret(host)

    expect(provision).not.toBeNull()
    expect(oauthResolver).toHaveBeenCalledWith(host)
    expect(countChannels).not.toHaveBeenCalled()
    expect(vi.mocked(issueMcpHostRuntimeTokens).mock.calls.at(-1)?.[2]).toContain(
      OAUTH_USER_TOKEN_SCOPE
    )
    const write = coreApi.replaceNamespacedSecret.mock.calls.at(-1)?.[0].body as k8s.V1Secret
    expect(write.metadata?.annotations).toMatchObject({
      'clerum.io/runtime-token-fronts-oauth-server': 'true',
      'clerum.io/runtime-token-has-channel-ingress': 'true',
    })
  })

  describe('McpServer OAuth observation unavailable while channel authority is synced', () => {
    /**
     * A Host whose Ready pod runs a consumed credential that grants
     * oauth:user-token, over stateful Secret and Deployment mocks.
     */
    async function oauthGrantedRuntime(annotations: Record<string, string> = {}) {
      const host = makeHost()
      const { reconciler, appsApi, coreApi } = createReconciler()
      let record = await mintedRuntimeCredentialRecord(host, {
        frontsOAuthServer: true,
        annotations,
      })
      const secretName = record.metadata!.name!
      const readSecret = coreApi.readNamespacedSecret.getMockImplementation()!
      coreApi.readNamespacedSecret.mockImplementation(request =>
        request.name === secretName ? Promise.resolve(structuredClone(record)) : readSecret(request)
      )
      coreApi.replaceNamespacedSecret.mockImplementation(async request => {
        if (request.name === secretName) record = structuredClone(request.body as k8s.V1Secret)
        return request.body
      })
      let live = trustedRuntimeDeployment(reconciler, host)
      live.spec!.template!.metadata!.annotations = {
        ...live.spec!.template!.metadata!.annotations,
        'clerum.io/runtime-token-revision':
          record.metadata!.annotations!['clerum.io/runtime-token-secret-revision'],
      }
      const readDeployment = appsApi.readNamespacedDeployment.getMockImplementation()!
      appsApi.readNamespacedDeployment.mockImplementation(request =>
        request.name === host.name
          ? Promise.resolve(structuredClone(live))
          : readDeployment(request)
      )
      const replaceDeployment = appsApi.replaceNamespacedDeployment.getMockImplementation()!
      appsApi.replaceNamespacedDeployment.mockImplementation(async request => {
        if (request.name !== host.name) return replaceDeployment(request)
        // The replaced pod stays Ready, as a running runtime does.
        live = { ...structuredClone(request.body), status: { readyReplicas: 1 } }
        return live
      })
      const hostDeploymentWrites = () =>
        [
          ...appsApi.createNamespacedDeployment.mock.calls,
          ...appsApi.replaceNamespacedDeployment.mock.calls,
          ...appsApi.patchNamespacedDeployment.mock.calls,
        ].filter(([request]) => (request as { name?: string }).name === host.name)
      return {
        host,
        reconciler,
        appsApi,
        coreApi,
        record: () => record,
        hostDeploymentWrites,
      }
    }

    it('keeps oauth:user-token and does not roll the Deployment when the McpServer probe fails between relists', async () => {
      const { host, reconciler, appsApi, record, hostDeploymentWrites } =
        await oauthGrantedRuntime()
      const oauthResolver = vi.fn(async (): Promise<boolean> => true)
      reconciler.setHostFrontsOAuthServer(oauthResolver)
      const issue = vi.mocked(issueMcpHostRuntimeTokens)
      issue.mockClear()
      for (let pass = 1; pass <= 3; pass++) await reconciler.reconcile(host)
      // The steady state is stable: no runtime mint while the grant is observed.
      expect(issue).not.toHaveBeenCalled()

      oauthResolver.mockImplementation(async () => {
        throw new Error('mcp-server watch retired')
      })
      oauthResolver.mockClear()
      appsApi.createNamespacedDeployment.mockClear()
      appsApi.replaceNamespacedDeployment.mockClear()
      appsApi.patchNamespacedDeployment.mockClear()
      const warn = vi.spyOn(HostContextLogger.prototype, 'warn').mockImplementation(() => undefined)
      try {
        await reconciler.reconcile(host)

        expect(issue).not.toHaveBeenCalled()
        expect(hostDeploymentWrites()).toHaveLength(0)
        expect(record().metadata!.annotations).toMatchObject({
          'clerum.io/runtime-token-fronts-oauth-server': 'true',
          'clerum.io/runtime-token-rollout-required': 'false',
        })
        // Liveness witness: the live probe ran all its attempts and the reconcile
        // deferred with the reason it could not decide.
        expect(oauthResolver).toHaveBeenCalledTimes(3)
        expect(warn).toHaveBeenCalledWith(
          'deferring runtime token decision: OAuth observation unavailable and retained scope grants oauth:user-token',
          {
            host: host.name,
            namespace: host.namespace,
            observation: 'frontsOAuthServer',
            attempts: 3,
            err: 'mcp-server watch retired',
          }
        )
        expect(reconciler.getStatus(host.name)).toMatchObject({
          deployed: true,
          ready: false,
          message: 'Waiting for authoritative scope observation',
        })
      } finally {
        warn.mockRestore()
      }
    })

    it('lets the Deployment drift guard keep an observed grant when its own McpServer read fails', async () => {
      const { host, reconciler, record } = await oauthGrantedRuntime()
      const oauthResolver = vi.fn(async (): Promise<boolean> => true)
      reconciler.setHostFrontsOAuthServer(oauthResolver)
      const issue = vi.mocked(issueMcpHostRuntimeTokens)
      issue.mockClear()
      for (let pass = 1; pass <= 3; pass++) await reconciler.reconcile(host)
      expect(issue).not.toHaveBeenCalled()
      const steadyStatus = structuredClone(reconciler.getStatus(host.name))

      // Issuance observes the grant; every later read (the drift guard's) fails.
      oauthResolver.mockClear()
      oauthResolver.mockImplementation(async () => {
        if (oauthResolver.mock.calls.length === 1) return true
        throw new Error('mcp-server watch retired')
      })
      await reconciler.reconcile(host)

      // Liveness witness: the drift guard read after issuance and exhausted its retries.
      expect(oauthResolver.mock.calls.length).toBeGreaterThanOrEqual(4)
      expect(issue).not.toHaveBeenCalled()
      expect(reconciler.getStatus(host.name)).toEqual(steadyStatus)
      expect(record().metadata!.annotations).toMatchObject({
        'clerum.io/runtime-token-fronts-oauth-server': 'true',
        'clerum.io/runtime-token-rollout-required': 'false',
      })
    })

    it('falls back to a fail-closed mint when the OAuth observation is unavailable inside the renewal window', async () => {
      const { host, reconciler, record } = await oauthGrantedRuntime({
        'clerum.io/runtime-token-refresh-before': '2000-01-01T00:00:00.000Z',
      })
      const oauthResolver = vi.fn(async (): Promise<boolean> => {
        throw new Error('mcp-server watch retired')
      })
      reconciler.setHostFrontsOAuthServer(oauthResolver)
      const issue = vi.mocked(issueMcpHostRuntimeTokens)
      issue.mockClear()

      const provision = await (reconciler as any).ensureMcpHostRuntimeTokenSecret(host)

      // Liveness witness: the live probe ran all its attempts before the mint.
      expect(oauthResolver).toHaveBeenCalledTimes(3)
      expect(provision).not.toBeNull()
      expect(issue).toHaveBeenCalledOnce()
      expect(issue.mock.calls[0]?.[2]).not.toContain(OAUTH_USER_TOKEN_SCOPE)
      expect(record().metadata!.annotations).toMatchObject({
        'clerum.io/runtime-token-fronts-oauth-server': 'false',
        'clerum.io/runtime-token-rollout-required': 'true',
      })
    })
  })

  describe('held wake OAuth scope during channel cache loss', () => {
    function heldZeroReplicaWake(options: {
      cacheSynced: boolean
      retainedFrontsOAuth: 'true' | 'false'
      resolveFrontsOAuth: () => Promise<boolean>
    }) {
      const host = makeStatelessHost({
        status: { lifecycle: { state: 'active', wakeHandledGeneration: 1 } },
      })
      const { reconciler, appsApi, coreApi, customApi } = createReconciler({
        isCommunicationChannelCacheSynced: () => options.cacheSynced,
      })
      customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
      const runtimeRecord = runtimeCredentialRecord(host, {
        frontsOAuthServer: options.retainedFrontsOAuth,
      })
      const runtimeRecordReads: string[] = []
      coreApi.readNamespacedSecret.mockImplementation(({ name }) => {
        if (name?.includes('runtime-tokens')) {
          runtimeRecordReads.push(name)
          return Promise.resolve(runtimeRecord)
        }
        return Promise.resolve({ metadata: { resourceVersion: '1' }, data: {} } as any)
      })
      const applied = reconciler.buildDeployment(host)
      applied.spec!.replicas = 0
      applied.spec!.template!.metadata!.annotations = {
        ...applied.spec!.template!.metadata!.annotations,
        'clerum.io/runtime-token-revision': 'applied-runtime-revision',
      }
      markPersistedRuntimeTrusted(applied, host, 0)
      const live = persistHostDeployment(appsApi, host, applied)
      const oauthResolver = vi.fn(options.resolveFrontsOAuth)
      reconciler.setHostFrontsOAuthServer(oauthResolver)
      vi.mocked(issueMcpHostRuntimeTokens).mockClear()
      return { host, reconciler, coreApi, live, oauthResolver, runtimeRecordReads }
    }

    function runtimeTokenWrite(coreApi: ReturnType<typeof createMockCoreApi>): k8s.V1Secret {
      const write = coreApi.replaceNamespacedSecret.mock.calls.find(([request]) =>
        request.name?.includes('runtime-tokens')
      )?.[0].body as k8s.V1Secret | undefined
      if (!write) throw new Error('No runtime token Secret write recorded')
      return write
    }

    it.each([false, true])(
      'mints without oauth:user-token when the OAuth mcp-server was removed (cache synced: %s)',
      async cacheSynced => {
        const { host, reconciler, coreApi, live, oauthResolver } = heldZeroReplicaWake({
          cacheSynced,
          retainedFrontsOAuth: 'true',
          resolveFrontsOAuth: async () => false,
        })

        await reconciler.reconcile(host)

        expect(oauthResolver).toHaveBeenCalledWith(host)
        expect(vi.mocked(issueMcpHostRuntimeTokens)).toHaveBeenCalledOnce()
        expect(vi.mocked(issueMcpHostRuntimeTokens).mock.calls[0]?.[2]).not.toContain(
          OAUTH_USER_TOKEN_SCOPE
        )
        expect(
          runtimeTokenWrite(coreApi).metadata?.annotations?.[
            'clerum.io/runtime-token-fronts-oauth-server'
          ]
        ).toBe('false')
        expect(live().spec!.replicas).toBe(1)
      }
    )

    it('skips a held wake mint when the OAuth read fails and the retained scope would grant it', async () => {
      const { host, reconciler, coreApi, live, oauthResolver, runtimeRecordReads } =
        heldZeroReplicaWake({
          cacheSynced: false,
          retainedFrontsOAuth: 'true',
          resolveFrontsOAuth: async () => {
            throw new Error('McpServer read unavailable')
          },
        })
      const warn = vi.spyOn(HostContextLogger.prototype, 'warn').mockImplementation(() => undefined)
      try {
        await reconciler.reconcile(host)
        expect(warn).toHaveBeenCalledWith(
          'skipping runtime token mint during channel cache loss without an authoritative OAuth observation',
          {
            host: host.name,
            namespace: host.namespace,
            observation: 'frontsOAuthServer',
            attempts: 3,
            err: 'McpServer read unavailable',
          }
        )
      } finally {
        warn.mockRestore()
      }

      expect(runtimeRecordReads.length).toBeGreaterThan(0)
      expect(oauthResolver).toHaveBeenCalledTimes(3)
      expect(vi.mocked(issueMcpHostRuntimeTokens)).not.toHaveBeenCalled()
      expect(
        coreApi.replaceNamespacedSecret.mock.calls.filter(([request]) =>
          request.name?.includes('runtime-tokens')
        )
      ).toHaveLength(0)
      expect(live().spec!.replicas).toBe(0)
      expect(reconciler.getStatus(host.name)).toMatchObject({
        deployed: true,
        ready: false,
        message: 'Waiting for authoritative scope observation',
      })
    })

    it('uses a retained non-granting OAuth observation when the OAuth read fails', async () => {
      const { host, reconciler, coreApi, live, oauthResolver } = heldZeroReplicaWake({
        cacheSynced: false,
        retainedFrontsOAuth: 'false',
        resolveFrontsOAuth: async () => {
          throw new Error('McpServer read unavailable')
        },
      })

      await reconciler.reconcile(host)

      expect(oauthResolver).toHaveBeenCalledTimes(3)
      expect(vi.mocked(issueMcpHostRuntimeTokens)).toHaveBeenCalledOnce()
      expect(vi.mocked(issueMcpHostRuntimeTokens).mock.calls[0]?.[2]).not.toContain(
        OAUTH_USER_TOKEN_SCOPE
      )
      expect(
        runtimeTokenWrite(coreApi).metadata?.annotations?.[
          'clerum.io/runtime-token-fronts-oauth-server'
        ]
      ).toBe('false')
      expect(live().spec!.replicas).toBe(1)
    })
  })

  it('does not renew held-runtime GFS before its refresh window', async () => {
    const host = makeStatelessHost()
    const { reconciler, appsApi, coreApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    coreApi.readNamespacedSecret.mockResolvedValue(runtimeCredentialRecord(host))
    appsApi.readNamespacedDeployment.mockResolvedValue(trustedRuntimeDeployment(reconciler, host))
    vi.mocked(mintHostGfsToken).mockClear()

    const provision = await (reconciler as any).ensureMcpHostRuntimeTokenSecret(host, {
      refreshGfsOnly: true,
    })

    expect(provision).not.toBeNull()
    expect(vi.mocked(mintHostGfsToken)).not.toHaveBeenCalled()
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled()
  })

  it('renews only held-runtime GFS at the refresh boundary', async () => {
    const host = makeStatelessHost()
    const { reconciler, appsApi, coreApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    const record = runtimeCredentialRecord(host, {
      gfsRefreshBefore: '2000-01-01T00:00:00.000Z',
    })
    coreApi.readNamespacedSecret.mockResolvedValue(record)
    const deployment = trustedRuntimeDeployment(reconciler, host)
    deployment.spec!.template!.metadata!.annotations = {
      ...deployment.spec!.template!.metadata!.annotations,
      'clerum.io/runtime-token-revision': 'applied-runtime-revision',
    }
    appsApi.readNamespacedDeployment.mockResolvedValue(deployment)
    vi.mocked(mintHostGfsToken).mockClear()

    const provision = await (reconciler as any).ensureMcpHostRuntimeTokenSecret(host, {
      refreshGfsOnly: true,
    })

    expect(vi.mocked(mintHostGfsToken)).toHaveBeenCalledOnce()
    expect(provision.revision).toBe('applied-runtime-revision')
    const write = coreApi.replaceNamespacedSecret.mock.calls.at(-1)?.[0].body as k8s.V1Secret
    expect(write.data?.[MCP_HOST_RUNTIME_TOKEN_SECRET_ACCESS_KEY]).toBe(
      record.data?.[MCP_HOST_RUNTIME_TOKEN_SECRET_ACCESS_KEY]
    )
    expect(write.data?.[MCP_HOST_RUNTIME_TOKEN_SECRET_REFRESH_KEY]).toBe(
      record.data?.[MCP_HOST_RUNTIME_TOKEN_SECRET_REFRESH_KEY]
    )
    expect(write.data?.[MCP_HOST_RUNTIME_TOKEN_SECRET_CONTROL_KEY]).toBe(
      record.data?.[MCP_HOST_RUNTIME_TOKEN_SECRET_CONTROL_KEY]
    )
    expect(write.data?.[MCP_HOST_GFS_TOKEN_SECRET_KEY]).not.toBe(
      record.data?.[MCP_HOST_GFS_TOKEN_SECRET_KEY]
    )
  })

  it('never falls back to full issuance from a closed held-runtime GFS renewal', async () => {
    const host = makeStatelessHost()
    const { reconciler, appsApi, coreApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    coreApi.readNamespacedSecret.mockRejectedValue({ code: 404 })
    appsApi.readNamespacedDeployment.mockResolvedValue(trustedRuntimeDeployment(reconciler, host))
    vi.mocked(issueMcpHostRuntimeTokens).mockClear()
    vi.mocked(mintHostGfsToken).mockClear()

    const provision = await (reconciler as any).ensureMcpHostRuntimeTokenSecret(host, {
      refreshGfsOnly: true,
    })

    expect(provision).toBeNull()
    expect(vi.mocked(issueMcpHostRuntimeTokens)).not.toHaveBeenCalled()
    expect(vi.mocked(mintHostGfsToken)).not.toHaveBeenCalled()
  })

  it('does not treat a requested but unready held runtime as ready for GFS renewal', async () => {
    const host = makeStatelessHost()
    const { reconciler, appsApi, coreApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    coreApi.readNamespacedSecret.mockResolvedValue(
      runtimeCredentialRecord(host, { gfsRefreshBefore: '2000-01-01T00:00:00.000Z' })
    )
    appsApi.readNamespacedDeployment.mockResolvedValue(
      trustedRuntimeDeployment(reconciler, host, { readyReplicas: 0 })
    )
    vi.mocked(mintHostGfsToken).mockClear()

    const provision = await (reconciler as any).ensureMcpHostRuntimeTokenSecret(host, {
      refreshGfsOnly: true,
    })

    expect(provision).toBeNull()
    expect(vi.mocked(mintHostGfsToken)).not.toHaveBeenCalled()
  })

  it('does not reassign a prior Host UID during held-runtime GFS renewal', async () => {
    const host = makeStatelessHost()
    const { reconciler, appsApi, coreApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    coreApi.readNamespacedSecret.mockResolvedValue(
      runtimeCredentialRecord(host, { hostUid: 'prior-host-uid' })
    )
    appsApi.readNamespacedDeployment.mockResolvedValue(trustedRuntimeDeployment(reconciler, host))
    vi.mocked(mintHostGfsToken).mockClear()

    const provision = await (reconciler as any).ensureMcpHostRuntimeTokenSecret(host, {
      refreshGfsOnly: true,
    })

    expect(provision).toBeNull()
    expect(vi.mocked(mintHostGfsToken)).not.toHaveBeenCalled()
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled()
  })

  describe('held-runtime GFS renewal identity guards', () => {
    const dueForRenewal = { gfsRefreshBefore: '2000-01-01T00:00:00.000Z' }

    /** Runs one refreshGfsOnly provision against a due record and a Ready Deployment. */
    async function renewHeldGfs(
      scenario: {
        host?: HostCRD
        record?: (host: HostCRD) => k8s.V1Secret
        deployment?: (reconciler: HostReconciler, host: HostCRD) => k8s.V1Deployment | null
      } = {}
    ) {
      const host = scenario.host ?? makeStatelessHost()
      const { reconciler, appsApi, coreApi } = createReconciler({
        isCommunicationChannelCacheSynced: () => false,
      })
      coreApi.readNamespacedSecret.mockResolvedValue(
        scenario.record ? scenario.record(host) : runtimeCredentialRecord(host, dueForRenewal)
      )
      const deployment = scenario.deployment
        ? scenario.deployment(reconciler, host)
        : trustedRuntimeDeployment(reconciler, host)
      if (deployment) {
        appsApi.readNamespacedDeployment.mockResolvedValue(deployment)
      } else {
        appsApi.readNamespacedDeployment.mockRejectedValue({ code: 404 })
      }
      vi.mocked(mintHostGfsToken).mockClear()

      const provision = await (reconciler as any).ensureMcpHostRuntimeTokenSecret(host, {
        refreshGfsOnly: true,
      })

      return {
        provision,
        mints: vi.mocked(mintHostGfsToken).mock.calls.length,
        recordReads: coreApi.readNamespacedSecret.mock.calls.length,
        deploymentReads: appsApi.readNamespacedDeployment.mock.calls.length,
        recordWrites: coreApi.replaceNamespacedSecret.mock.calls.length,
      }
    }

    /** The unmodified scenario mints, so every refusal below is a real refusal. */
    async function expectControlRenews() {
      const control = await renewHeldGfs()
      expect(control.provision).not.toBeNull()
      expect(control.mints).toBe(1)
      expect(control.recordWrites).toBe(1)
    }

    async function expectRefusedAfterReads(scenario: Parameters<typeof renewHeldGfs>[0]) {
      await expectControlRenews()
      const refused = await renewHeldGfs(scenario)
      // Liveness witness: the credential record and the Deployment were both read
      // before the guard refused, so the guarded path was entered.
      expect(refused.recordReads).toBeGreaterThan(0)
      expect(refused.deploymentReads).toBeGreaterThan(0)
      expect(refused.provision).toBeNull()
      expect(refused.mints).toBe(0)
      expect(refused.recordWrites).toBe(0)
    }

    it('refuses to renew an incomplete credential record', async () => {
      await expectRefusedAfterReads({
        record: host => {
          const record = runtimeCredentialRecord(host, dueForRenewal)
          delete record.data![MCP_HOST_GFS_TOKEN_SECRET_KEY]
          return record
        },
      })
    })

    it.each([
      [
        'managed by another controller',
        (host: HostCRD) =>
          runtimeCredentialRecord(host, { ...dueForRenewal, managedByHost: false }),
      ],
      [
        'labelled for another Host',
        (host: HostCRD) => {
          const record = runtimeCredentialRecord(host, dueForRenewal)
          record.metadata!.labels!['clerum.io/host'] = 'other-host'
          return record
        },
      ],
    ])('refuses to renew a credential record %s', async (_label, record) => {
      await expectRefusedAfterReads({ record })
    })

    it.each<[string, (deployment: k8s.V1Deployment) => void]>([
      [
        'labelled for another Host',
        deployment => {
          deployment.metadata!.labels!['clerum.io/host'] = 'other-host'
        },
      ],
      [
        'managed by another controller',
        deployment => {
          deployment.metadata!.labels!['clerum.io/managed-by'] = 'someone-else'
        },
      ],
      [
        'named after another Deployment',
        deployment => {
          deployment.metadata!.name = 'other-host'
        },
      ],
      [
        'created for a prior Host incarnation',
        deployment => {
          deployment.metadata!.annotations!['clerum.io/host-uid'] = 'prior-host-uid'
        },
      ],
      [
        'being deleted',
        deployment => {
          deployment.metadata!.deletionTimestamp = new Date('2026-07-02T00:00:00.000Z')
        },
      ],
      [
        'without a uid',
        deployment => {
          delete deployment.metadata!.uid
        },
      ],
      [
        'without a resourceVersion',
        deployment => {
          delete deployment.metadata!.resourceVersion
        },
      ],
      [
        'without a pod template spec',
        deployment => {
          delete deployment.spec!.template!.spec
        },
      ],
    ])('refuses to renew when the Deployment is %s', async (_label, corrupt) => {
      await expectRefusedAfterReads({
        deployment: (reconciler, host) => {
          const deployment = trustedRuntimeDeployment(reconciler, host)
          corrupt(deployment)
          return deployment
        },
      })
    })

    it('refuses to renew when the Deployment is absent', async () => {
      await expectRefusedAfterReads({ deployment: () => null })
    })

    it.each<[string, (deployment: k8s.V1Deployment) => void]>([
      [
        'scaled to zero replicas',
        deployment => {
          deployment.spec!.replicas = 0
        },
      ],
      [
        'without a replica count',
        deployment => {
          delete deployment.spec!.replicas
        },
      ],
    ])('refuses to renew when the Ready-status Deployment is %s', async (_label, corrupt) => {
      await expectRefusedAfterReads({
        deployment: (reconciler, host) => {
          // readyReplicas stays 1 so only the replica-count guard can refuse.
          const deployment = trustedRuntimeDeployment(reconciler, host, { readyReplicas: 1 })
          corrupt(deployment)
          return deployment
        },
      })
    })

    describe('with an unconsumed wake bootstrap', () => {
      const APPLIED_REVISION = 'applied-runtime-revision'

      /** A due record whose fresh bootstrap is bound to the given Deployment UID. */
      const freshBootstrapBoundTo = (boundUid: string) => (host: HostCRD) => {
        const record = runtimeCredentialRecord(host, dueForRenewal)
        Object.assign(record.metadata!.annotations!, {
          'clerum.io/runtime-token-bootstrap-state': 'fresh',
          'clerum.io/runtime-token-bootstrap-deployment-uid': boundUid,
          'clerum.io/runtime-token-bootstrap-applied-revision': APPLIED_REVISION,
        })
        return record
      }
      const appliedDeployment = (reconciler: HostReconciler, host: HostCRD) => {
        const deployment = trustedRuntimeDeployment(reconciler, host)
        deployment.spec!.template!.metadata!.annotations = {
          ...deployment.spec!.template!.metadata!.annotations,
          'clerum.io/runtime-token-revision': APPLIED_REVISION,
        }
        return deployment
      }

      it('marks a bootstrap bound to the applied Deployment consumed without minting', async () => {
        const host = makeStatelessHost()

        const bound = await renewHeldGfs({
          host,
          record: freshBootstrapBoundTo(`deployment-${host.name}`),
          deployment: appliedDeployment,
        })

        // Liveness witness: the record was read and the consumed marker was written.
        expect(bound.recordReads).toBeGreaterThan(0)
        expect(bound.recordWrites).toBe(1)
        expect(bound.provision.revision).toBe(APPLIED_REVISION)
        expect(bound.mints).toBe(0)
      })

      it('renews once the bootstrap is bound to a different Deployment UID', async () => {
        const host = makeStatelessHost()
        const bound = await renewHeldGfs({
          host,
          record: freshBootstrapBoundTo(`deployment-${host.name}`),
          deployment: appliedDeployment,
        })
        expect(bound.mints).toBe(0)
        expect(bound.recordWrites).toBe(1)

        const replaced = await renewHeldGfs({
          host,
          record: freshBootstrapBoundTo('deployment-replaced-uid'),
          deployment: appliedDeployment,
        })

        expect(replaced.mints).toBe(1)
        expect(replaced.recordWrites).toBe(1)
      })
    })
  })

  it('consumes a fresh bootstrap on GFS-only refresh when the Ready Deployment runs its revision', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const t0 = Date.parse('2026-07-03T00:00:00.000Z')
      vi.setSystemTime(t0)
      let cacheSynced = true
      const host = makeStatelessHost()
      const { reconciler, appsApi, coreApi } = createReconciler({
        isCommunicationChannelCacheSynced: () => cacheSynced,
      })
      reconciler.setHostFrontsOAuthServer(async () => false)
      // The real producer mints a fresh bootstrap and the pod boots Ready on it,
      // with channel authority lost before the resync that would consume it.
      let record = await mintedRuntimeCredentialRecord(host, { bootstrap: 'fresh' })
      const deployedRevision =
        record.metadata!.annotations!['clerum.io/runtime-token-secret-revision']
      expect(record.metadata!.annotations!['clerum.io/runtime-token-bootstrap-state']).toBe('fresh')
      const deployment = trustedRuntimeDeployment(reconciler, host)
      deployment.spec!.template!.metadata!.annotations = {
        ...deployment.spec!.template!.metadata!.annotations,
        'clerum.io/runtime-token-revision': deployedRevision,
      }
      appsApi.readNamespacedDeployment.mockResolvedValue(deployment)
      coreApi.readNamespacedSecret.mockImplementation(async () => structuredClone(record))
      coreApi.replaceNamespacedSecret.mockImplementation(async request => {
        const body = request.body as k8s.V1Secret
        // Two writes on one resourceVersion would be a 409 from the apiserver.
        expect(body.metadata?.resourceVersion).toBe(record.metadata!.resourceVersion)
        record = structuredClone({
          ...body,
          metadata: {
            ...body.metadata,
            resourceVersion: String(Number(body.metadata!.resourceVersion) + 1),
          },
        })
        return record
      })
      vi.mocked(mintHostGfsToken).mockClear()
      // A renewed GFS credential differs from the one the pod booted with, so
      // the record's revision moves away from the deployed one.
      vi.mocked(mintHostGfsToken).mockImplementationOnce(async ({ name, namespace }) => ({
        ['to' + 'ken']: 'gfs-renewed-value',
        expiresInSeconds: 600,
        subject: `host:1st:${namespace}/${name}`,
      }))
      vi.mocked(issueMcpHostRuntimeTokens).mockClear()

      cacheSynced = false
      vi.setSystemTime(t0 + 601_000)
      await (reconciler as any).ensureMcpHostRuntimeTokenSecret(host, { refreshGfsOnly: true })
      vi.setSystemTime(t0 + 601_500)
      await (reconciler as any).ensureMcpHostRuntimeTokenSecret(host, { refreshGfsOnly: true })

      expect(record.metadata!.annotations!['clerum.io/runtime-token-bootstrap-state']).toBe(
        'consumed'
      )

      cacheSynced = true
      vi.setSystemTime(t0 + 602_000)
      const provision = await (reconciler as any).ensureMcpHostRuntimeTokenSecret(host)

      // Liveness witness: the hold renewed GFS once and wrote the record twice
      // (the consumed marker, then the renewed GFS credential).
      expect(vi.mocked(mintHostGfsToken)).toHaveBeenCalledOnce()
      expect(coreApi.replaceNamespacedSecret.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(record.metadata!.annotations!['clerum.io/runtime-token-rollout-required']).not.toBe(
        'true'
      )
      // The Ready pod already rotated the refresh token it booted with, so moving
      // the Deployment to another revision without a runtime mint would hand the
      // new pod a revoked token.
      if (provision.revision !== deployedRevision) {
        expect(vi.mocked(issueMcpHostRuntimeTokens).mock.calls.length).toBeGreaterThan(0)
      }
      expect(provision.revision).toBe(deployedRevision)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a Ready held runtime deployed when its GFS renewal fails, without retry backoff', async () => {
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 1 } },
    })
    const infrastructureTelemetryReporter = createTelemetryReporterMock()
    const { reconciler, appsApi, coreApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
      infrastructureTelemetryReporter,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    reconciler.setHostFrontsOAuthServer(async () => false)
    // A running pod's consumed record whose GFS credential is due for renewal.
    const record = await mintedRuntimeCredentialRecord(host, {
      annotations: { 'clerum.io/gfs-token-refresh-before': '2000-01-01T00:00:00.000Z' },
    })
    const runtimeSecretName = record.metadata!.name!
    const readSecret = coreApi.readNamespacedSecret.getMockImplementation()!
    coreApi.readNamespacedSecret.mockImplementation(request =>
      request.name === runtimeSecretName
        ? Promise.resolve(structuredClone(record))
        : readSecret(request)
    )
    const applied = trustedRuntimeDeployment(reconciler, host)
    applied.spec!.template!.metadata!.annotations = {
      ...applied.spec!.template!.metadata!.annotations,
      'clerum.io/runtime-token-revision':
        record.metadata!.annotations!['clerum.io/runtime-token-secret-revision'],
    }
    const live = persistHostDeployment(appsApi, host, applied)
    const gfsMint = vi.mocked(mintHostGfsToken)
    const defaultGfsMint = gfsMint.getMockImplementation()!
    gfsMint.mockClear()
    gfsMint.mockImplementation(async () => {
      throw new Error('gfs token endpoint unavailable')
    })
    vi.mocked(issueMcpHostRuntimeTokens).mockClear()
    try {
      const started = performance.now()
      await reconciler.reconcile(host)
      const elapsedMs = performance.now() - started

      // Liveness witness: the hold attempted the GFS renewal exactly once.
      expect(gfsMint).toHaveBeenCalledOnce()
      expect(elapsedMs).toBeLessThan(1000)
      expect(reconciler.getStatus(host.name)).toEqual({
        deployed: true,
        ready: true,
        message: 'Held runtime credential renewal failed; runtime kept',
      })
      const controllerErrors = vi
        .mocked(infrastructureTelemetryReporter.enqueue)
        .mock.calls.filter(([event]) => event.telemetryType === 'controller_error')
      expect(controllerErrors).toHaveLength(1)
      expect(controllerErrors[0]![0].payload).toMatchObject({
        reason_code: 'RuntimeCredentialRenewalFailed',
        status: 'failed',
      })
      expect(live().spec!.replicas).toBe(1)
      expect(live().spec!.template).toEqual(applied.spec!.template)
      expect(vi.mocked(issueMcpHostRuntimeTokens)).not.toHaveBeenCalled()
    } finally {
      gfsMint.mockImplementation(defaultGfsMint)
    }
  })

  it('recovers an active held Deployment from zero after minting credentials on each pass', async () => {
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 1 } },
    })
    const { reconciler, appsApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const applied = reconciler.buildDeployment(host)
    applied.spec!.replicas = 0
    applied.spec!.template.metadata!.annotations = { 'example.org/applied': 'keep-exactly' }
    applied.spec!.template!.metadata!.annotations = {
      ...applied.spec!.template!.metadata!.annotations,
      'clerum.io/runtime-token-revision': 'applied-runtime-revision',
    }
    markPersistedRuntimeTrusted(applied, host, 0)
    const live = persistHostDeployment(appsApi, host, applied)
    const provision = vi
      .spyOn(reconciler as any, 'provisionRuntimeTokenRevision')
      .mockResolvedValue(runtimeTokenProvision(host))

    for (let pass = 1; pass <= 3; pass++) {
      await reconciler.reconcile(host)

      // One credential mint per pass, made before that pass's replica-only update.
      expect(provision).toHaveBeenCalledTimes(pass)
      expect(provision).toHaveBeenLastCalledWith(host, {
        forceFreshForWake: true,
        targetSuspended: false,
        preserveDeploymentTemplateOnWake: true,
      })
      const passReplace = appsApi.replaceNamespacedDeployment.mock.invocationCallOrder.at(-1)!
      expect(provision.mock.invocationCallOrder.at(-1)!).toBeLessThan(passReplace)
      expect(live().spec!.replicas).toBe(1)
      expect(live().spec!.template).toEqual(applied.spec!.template)

      // Scale the held Deployment back to zero so the next pass recovers it again.
      live().spec!.replicas = 0
      live().status = { readyReplicas: 0 }
    }
  })

  it('does not roll a held wake bootstrap when the watch recovers before Ready', async () => {
    let cacheSynced = false
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 1 } },
    })
    const { reconciler, appsApi, coreApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => cacheSynced,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    let runtimeRecord = runtimeCredentialRecord(host)
    coreApi.readNamespacedSecret.mockImplementation(({ name }) =>
      name?.includes('runtime-tokens')
        ? Promise.resolve(runtimeRecord)
        : Promise.resolve({ metadata: { resourceVersion: '1' }, data: {} } as any)
    )
    const applied = reconciler.buildDeployment(host)
    applied.spec!.replicas = 0
    applied.spec!.template!.metadata!.annotations = {
      ...applied.spec!.template!.metadata!.annotations,
      'clerum.io/runtime-token-revision': 'applied-runtime-revision',
    }
    markPersistedRuntimeTrusted(applied, host, 0)
    const live = persistHostDeployment(appsApi, host, applied)
    const issueRuntimeMaterial = vi.mocked(issueMcpHostRuntimeTokens)
    issueRuntimeMaterial.mockClear()

    await reconciler.reconcile(host)

    expect(issueRuntimeMaterial).toHaveBeenCalledOnce()
    expect(live().spec!.replicas).toBe(1)
    expect(live().spec!.template!.metadata!.annotations?.['clerum.io/runtime-token-revision']).toBe(
      'applied-runtime-revision'
    )
    const wakeWrite = coreApi.replaceNamespacedSecret.mock.calls.find(([request]) =>
      request.name?.includes('runtime-tokens')
    )?.[0].body as k8s.V1Secret
    expect(wakeWrite.metadata?.annotations).toMatchObject({
      'clerum.io/runtime-token-bootstrap-state': 'fresh',
      'clerum.io/runtime-token-rollout-required': 'false',
      'clerum.io/runtime-token-bootstrap-deployment-uid': 'deployment-uid',
      'clerum.io/runtime-token-bootstrap-applied-revision': 'applied-runtime-revision',
    })
    runtimeRecord = withReadableRuntimeRefreshMaterial(wakeWrite)
    issueRuntimeMaterial.mockClear()
    appsApi.createNamespacedDeployment.mockClear()
    appsApi.replaceNamespacedDeployment.mockClear()
    cacheSynced = true
    await reconciler.reconcile(host)

    expect(issueRuntimeMaterial).not.toHaveBeenCalled()
    expect(
      appsApi.replaceNamespacedDeployment.mock.calls.filter(
        ([request]) => request.body?.metadata?.name === host.name
      )
    ).toHaveLength(0)

    live().status = { readyReplicas: 1 }
    coreApi.replaceNamespacedSecret.mockClear()
    await reconciler.reconcile(host)

    expect(issueRuntimeMaterial).not.toHaveBeenCalled()
    expect(
      appsApi.replaceNamespacedDeployment.mock.calls.filter(
        ([request]) => request.body?.metadata?.name === host.name
      )
    ).toHaveLength(0)
    const consumedWrite = coreApi.replaceNamespacedSecret.mock.calls.find(([request]) =>
      request.name?.includes('runtime-tokens')
    )?.[0].body as k8s.V1Secret
    expect(consumedWrite.metadata?.annotations?.['clerum.io/runtime-token-bootstrap-state']).toBe(
      'consumed'
    )
    runtimeRecord = consumedWrite

    live().spec!.replicas = 0
    live().status = { readyReplicas: 0 }
    issueRuntimeMaterial.mockClear()
    await reconciler.reconcile(host)

    expect(issueRuntimeMaterial).toHaveBeenCalledOnce()
    expect(live().spec!.replicas).toBe(1)
  })

  it('marks a newly created preserved wake bootstrap for scale-only delivery', async () => {
    const host = makeStatelessHost()
    const { reconciler, appsApi, coreApi } = createReconciler()
    const deployment = trustedRuntimeDeployment(reconciler, host, {
      replicas: 0,
      readyReplicas: 0,
    })
    deployment.spec!.template!.metadata!.annotations = {
      ...deployment.spec!.template!.metadata!.annotations,
      'clerum.io/runtime-token-revision': 'applied-runtime-revision',
    }
    appsApi.readNamespacedDeployment.mockResolvedValue(deployment)
    coreApi.readNamespacedSecret.mockRejectedValue({ code: 404 })
    const issueRuntimeMaterial = vi.mocked(issueMcpHostRuntimeTokens)
    issueRuntimeMaterial.mockClear()

    const first = await (reconciler as any).ensureMcpHostRuntimeTokenSecret(host, {
      forceFreshForWake: true,
      targetSuspended: false,
      preserveDeploymentTemplateOnWake: true,
    })

    expect(first.revision).toBe('applied-runtime-revision')
    const created = coreApi.createNamespacedSecret.mock.calls.find(([request]) =>
      request.body?.metadata?.name?.includes('runtime-tokens')
    )?.[0].body as k8s.V1Secret
    expect(created.metadata?.annotations).toMatchObject({
      'clerum.io/runtime-token-bootstrap-state': 'fresh',
      'clerum.io/runtime-token-rollout-required': 'false',
      'clerum.io/runtime-token-bootstrap-applied-revision': 'applied-runtime-revision',
    })

    const readableCreated = withReadableRuntimeRefreshMaterial(created)
    coreApi.readNamespacedSecret.mockResolvedValue(readableCreated)
    deployment.spec!.replicas = 1
    issueRuntimeMaterial.mockClear()

    const second = await (reconciler as any).ensureMcpHostRuntimeTokenSecret(host, {
      targetSuspended: false,
      preserveDeploymentTemplateOnWake: true,
    })

    expect(issueRuntimeMaterial).not.toHaveBeenCalled()
    expect(second.revision).toBe('applied-runtime-revision')
  })

  describe('wake bootstrap binding to the applied Deployment', () => {
    const BOOTSTRAP_UID = 'clerum.io/runtime-token-bootstrap-deployment-uid'
    const BOOTSTRAP_REVISION = 'clerum.io/runtime-token-bootstrap-applied-revision'
    const APPLIED_REVISION = 'applied-runtime-revision'

    /**
     * Mints a wake bootstrap for a zero-replica Deployment through the real
     * producer, then models the wake: the same Deployment at one replica that is
     * not Ready yet, with the persisted record bound to it.
     */
    async function boundWakeBootstrap() {
      const host = makeStatelessHost()
      const { reconciler, appsApi, coreApi } = createReconciler()
      const deployment = trustedRuntimeDeployment(reconciler, host, {
        replicas: 0,
        readyReplicas: 0,
      })
      deployment.spec!.template!.metadata!.annotations = {
        ...deployment.spec!.template!.metadata!.annotations,
        'clerum.io/runtime-token-revision': APPLIED_REVISION,
      }
      appsApi.readNamespacedDeployment.mockResolvedValue(deployment)
      coreApi.readNamespacedSecret.mockRejectedValue({ code: 404 })
      const issueRuntimeMaterial = vi.mocked(issueMcpHostRuntimeTokens)
      issueRuntimeMaterial.mockClear()

      await (reconciler as any).ensureMcpHostRuntimeTokenSecret(host, {
        forceFreshForWake: true,
        targetSuspended: false,
        preserveDeploymentTemplateOnWake: true,
      })

      const created = coreApi.createNamespacedSecret.mock.calls.find(([request]) =>
        request.body?.metadata?.name?.includes('runtime-tokens')
      )?.[0].body as k8s.V1Secret
      expect(created.metadata?.annotations).toMatchObject({
        'clerum.io/runtime-token-bootstrap-state': 'fresh',
        [BOOTSTRAP_UID]: deployment.metadata!.uid,
        [BOOTSTRAP_REVISION]: APPLIED_REVISION,
      })
      const record = withReadableRuntimeRefreshMaterial(created)
      coreApi.readNamespacedSecret.mockResolvedValue(record)
      deployment.spec!.replicas = 1

      /** One follow-up provision on the woken Deployment, with the counters it moved. */
      const provisionOnWokenDeployment = async () => {
        issueRuntimeMaterial.mockClear()
        coreApi.replaceNamespacedSecret.mockClear()
        const recordReadsBefore = coreApi.readNamespacedSecret.mock.calls.length
        const deploymentReadsBefore = appsApi.readNamespacedDeployment.mock.calls.length
        const provision = await (reconciler as any).ensureMcpHostRuntimeTokenSecret(host, {
          targetSuspended: false,
          preserveDeploymentTemplateOnWake: true,
        })
        return {
          provision,
          mints: issueRuntimeMaterial.mock.calls.length,
          recordReads: coreApi.readNamespacedSecret.mock.calls.length - recordReadsBefore,
          deploymentReads:
            appsApi.readNamespacedDeployment.mock.calls.length - deploymentReadsBefore,
          writes: coreApi.replaceNamespacedSecret.mock.calls.map(([request]) => request.body),
        }
      }
      return { deployment, record, provisionOnWokenDeployment }
    }

    it('reuses a wake bootstrap bound to the applied Deployment UID and revision', async () => {
      const { provisionOnWokenDeployment } = await boundWakeBootstrap()

      const reused = await provisionOnWokenDeployment()

      // Liveness witness: the record and the Deployment were read and the reuse
      // path returned the applied revision it binds.
      expect(reused.recordReads).toBeGreaterThan(0)
      expect(reused.deploymentReads).toBeGreaterThan(0)
      expect(reused.provision.revision).toBe(APPLIED_REVISION)
      expect(reused.mints).toBe(0)
      expect(reused.writes).toHaveLength(0)
    })

    it.each<[string, (deployment: k8s.V1Deployment) => void]>([
      [
        'Deployment UID',
        deployment => {
          deployment.metadata!.uid = 'deployment-replaced-uid'
        },
      ],
      [
        'applied runtime revision',
        deployment => {
          deployment.spec!.template!.metadata!.annotations = {
            ...deployment.spec!.template!.metadata!.annotations,
            'clerum.io/runtime-token-revision': 'other-applied-revision',
          }
        },
      ],
    ])('mints again once the bound %s changes', async (_label, changeDeployment) => {
      const { deployment, provisionOnWokenDeployment } = await boundWakeBootstrap()
      const reused = await provisionOnWokenDeployment()
      expect(reused.recordReads).toBeGreaterThan(0)
      expect(reused.mints).toBe(0)

      changeDeployment(deployment)
      const reissued = await provisionOnWokenDeployment()

      expect(reissued.mints).toBe(1)
      expect(reissued.writes).toHaveLength(1)
      expect((reissued.writes[0] as k8s.V1Secret).metadata?.annotations).toMatchObject({
        'clerum.io/runtime-token-bootstrap-state': 'fresh',
      })
    })

    it.each<[string, (deployment: k8s.V1Deployment, record: k8s.V1Secret) => void]>([
      [
        'empty Deployment UID',
        (deployment, record) => {
          deployment.metadata!.uid = ''
          record.metadata!.annotations![BOOTSTRAP_UID] = ''
        },
      ],
      [
        'empty applied runtime revision',
        (deployment, record) => {
          deployment.spec!.template!.metadata!.annotations = {
            ...deployment.spec!.template!.metadata!.annotations,
            'clerum.io/runtime-token-revision': '',
          }
          record.metadata!.annotations![BOOTSTRAP_REVISION] = ''
        },
      ],
    ])('does not treat an %s on both sides as a binding', async (_label, empty) => {
      const { deployment, record, provisionOnWokenDeployment } = await boundWakeBootstrap()
      const reused = await provisionOnWokenDeployment()
      expect(reused.recordReads).toBeGreaterThan(0)
      expect(reused.mints).toBe(0)

      empty(deployment, record)
      const reissued = await provisionOnWokenDeployment()

      expect(reissued.mints).toBe(1)
      expect(reissued.writes).toHaveLength(1)
    })
  })

  it('keeps an active held Deployment at zero when credential minting is unavailable', async () => {
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 1 } },
    })
    const { reconciler, appsApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const applied = reconciler.buildDeployment(host)
    applied.spec!.replicas = 0
    applied.spec!.template!.metadata!.annotations = {
      ...applied.spec!.template!.metadata!.annotations,
      'clerum.io/runtime-token-revision': 'applied-runtime-revision',
    }
    markPersistedRuntimeTrusted(applied, host, 0)
    const live = persistHostDeployment(appsApi, host, applied)
    appsApi.replaceNamespacedDeployment.mockClear()
    const provision = vi
      .spyOn(reconciler as any, 'provisionRuntimeTokenRevision')
      .mockResolvedValue(null)

    await reconciler.reconcile(host)

    expect(provision).toHaveBeenCalledOnce()
    expect(provision).toHaveBeenCalledWith(host, {
      forceFreshForWake: true,
      targetSuspended: false,
      preserveDeploymentTemplateOnWake: true,
    })
    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
    expect(live().spec!.replicas).toBe(0)
    expect(reconciler.getStatus(host.name)).toMatchObject({
      deployed: true,
      ready: false,
      message: 'Waiting for authoritative scope observation',
    })
  })

  it('reconciles an active Host twice through cache loss without changing its session path or template', async () => {
    let cacheSynced = true
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 2 } },
    })
    let serverHost = host
    const { reconciler, appsApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => cacheSynced,
    })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(serverHost))

    await reconciler.reconcile(host)
    const live = persistHostDeployment(appsApi, host, hostDeploymentBody(appsApi, host.name))
    const baseline = structuredClone(live().spec?.template)
    expect(envValue(live(), 'CLERUM_SESSION_DB_DIR')).toBe('/var/lib/clerum/state')

    for (let cycle = 1; cycle <= 2; cycle++) {
      cacheSynced = false
      // Exercise the fresh-read race as well as the cached active state: a
      // suspend may have landed after the initial Host watch event.
      serverHost = makeStatelessHost({ status: suspendedStatus(2 + cycle) })
      appsApi.createNamespacedDeployment.mockClear()
      appsApi.replaceNamespacedDeployment.mockClear()
      await reconciler.reconcile(host)

      const deployment = live()
      expect(deployment.spec?.replicas).toBe(1)
      expect(deployment.spec?.template).toEqual(baseline)
      expect(envValue(deployment, 'CLERUM_SESSION_DB_DIR')).toBe('/var/lib/clerum/state')
      expect(reconciler.getEffectiveLifecycle(host)).toMatchObject({
        stateless: true,
        suspensionBlocked: true,
      })
      expect(rejectedCondition(lifecycleStatusWrites(customApi).at(-1)!).reason).toBe(
        'CommunicationChannelCacheUnsynced'
      )
      expect(lifecycleStatusWrites(customApi).at(-1)?.lifecycle?.state).toBe('suspended')
      expect(
        appsApi.replaceNamespacedDeployment.mock.calls.filter(([r]) => r.name === host.name)
      ).toHaveLength(0)
      cacheSynced = true
      serverHost = host
      await reconciler.reconcile(host)
      expect(live().spec?.template).toEqual(baseline)
    }
  })

  it('preserves a suspended Host while the CommunicationChannel cache is unsynced', async () => {
    const { reconciler, appsApi, customApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => false,
    })
    const host = makeStatelessHost({ status: suspendedStatus() })
    const live = persistHostDeployment(
      appsApi,
      host,
      createReconciler().reconciler.buildDeployment(host)
    )
    await reconciler.reconcile(host)

    const deployment = live()
    expect(deployment.spec?.replicas).toBe(0)
    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(1)
    expect(writes[0].lifecycle?.state).toBe('suspended')
    const condition = rejectedCondition(writes[0])
    expect(condition.status).toBe('False')
    expect(condition.reason).toContain('CommunicationChannelCacheUnsynced')
  })

  it('preserves the stateless template when the channel cache becomes unsynced during reconciliation', async () => {
    let cacheSynced = true
    const { reconciler, appsApi, customApi, networkingApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => cacheSynced,
    })
    const host = makeStatelessHost({ status: suspendedStatus(4) })
    const applied = reconciler.buildDeployment(host)
    markPersistedRuntimeTrusted(applied, host)
    const live = persistHostDeployment(appsApi, host, applied)
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const readPolicy = networkingApi.readNamespacedNetworkPolicy.getMockImplementation()!
    networkingApi.readNamespacedNetworkPolicy.mockImplementation(async request => {
      cacheSynced = false
      return readPolicy(request)
    })
    const provision = vi
      .spyOn(reconciler as any, 'provisionRuntimeTokenRevision')
      .mockResolvedValue(runtimeTokenProvision(host))

    await reconciler.reconcile(host)
    expect(networkingApi.readNamespacedNetworkPolicy).toHaveBeenCalled()

    expect(provision).not.toHaveBeenCalled()
    const deployment = live()
    expect(deployment.spec?.replicas).toBe(0)
    expect(envValue(deployment, 'CLERUM_STATELESS_LIFECYCLE')).toBe('true')
    expect(envValue(deployment, 'CLERUM_SESSION_STORE')).toBe('sqlite')
    expect(envValue(deployment, 'CLERUM_SESSION_DB_DIR')).toBe('/var/lib/clerum/state')
    const writes = lifecycleStatusWrites(customApi)
    expect(writes).toHaveLength(2)
    expect(writes[0].lifecycle?.state).toBe('suspended')
    expect(writes[1].lifecycle).toMatchObject({
      state: 'suspended',
      wakeHandledGeneration: 4,
    })
    expect(rejectedCondition(writes[1]).reason).toBe('CommunicationChannelCacheUnsynced')
    expect(rejectedCondition(writes[1]).status).toBe('False')
  })

  it('fails closed when a channel starts referencing the Host during reconciliation', async () => {
    let channelCount = 0
    const { reconciler, appsApi, customApi, networkingApi } = createReconciler({
      countCommunicationChannels: () => channelCount,
    })
    const host = makeStatelessHost({ status: suspendedStatus(5) })
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const readPolicy = networkingApi.readNamespacedNetworkPolicy.getMockImplementation()!
    networkingApi.readNamespacedNetworkPolicy.mockImplementation(async request => {
      channelCount = 1
      return readPolicy(request)
    })

    await reconciler.reconcile(host)
    expect(networkingApi.readNamespacedNetworkPolicy).toHaveBeenCalled()

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
    const readPolicy = networkingApi.readNamespacedNetworkPolicy.getMockImplementation()!
    networkingApi.readNamespacedNetworkPolicy.mockImplementation(async request => {
      channelCount = 1
      return readPolicy(request)
    })
    const issueTokens = vi.mocked(issueMcpHostRuntimeTokens)
    const mintGfs = vi.mocked(mintHostGfsToken)
    issueTokens.mockClear()
    mintGfs.mockClear()

    await reconciler.reconcile(host)
    expect(networkingApi.readNamespacedNetworkPolicy).toHaveBeenCalled()

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
    appsApi.replaceNamespacedDeployment.mockImplementation(
      async ({ body }: { body: k8s.V1Deployment }) => {
        if (body.metadata?.name === 'stateless-host') throw failure
        return {}
      }
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(reconciler.reconcile(makeStatelessHost())).rejects.toBe(failure)
      expect(appsApi.replaceNamespacedDeployment).toHaveBeenCalledOnce()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('rechecks channel policy when the Deployment existence read observes a late channel', async () => {
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
    const readPolicy = networkingApi.readNamespacedNetworkPolicy.getMockImplementation()!
    networkingApi.readNamespacedNetworkPolicy.mockImplementation(async request => {
      channelCount = 1
      return readPolicy(request)
    })
    const provision = vi
      .spyOn(reconciler as any, 'provisionRuntimeTokenRevision')
      .mockResolvedValue(runtimeTokenProvision(host, true))

    await reconciler.reconcile(host)
    expect(networkingApi.readNamespacedNetworkPolicy).toHaveBeenCalled()

    expect(provision).toHaveBeenCalledOnce()
  })

  it('refreshes only the GFS token during active cache loss without changing replicas', async () => {
    let cacheSynced = true
    const { reconciler, appsApi, customApi, networkingApi } = createReconciler({
      isCommunicationChannelCacheSynced: () => cacheSynced,
    })
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 1 } },
    })
    const applied = reconciler.buildDeployment(host)
    markPersistedRuntimeTrusted(applied, host)
    const live = persistHostDeployment(appsApi, host, applied)
    customApi.getNamespacedCustomObject.mockImplementation(async () => hostApiObject(host))
    const readPolicy = networkingApi.readNamespacedNetworkPolicy.getMockImplementation()!
    networkingApi.readNamespacedNetworkPolicy.mockImplementation(async request => {
      cacheSynced = false
      return readPolicy(request)
    })
    const provision = vi
      .spyOn(reconciler as any, 'provisionRuntimeTokenRevision')
      .mockResolvedValue(runtimeTokenProvision(host))

    await reconciler.reconcile(host)
    expect(networkingApi.readNamespacedNetworkPolicy).toHaveBeenCalled()

    expect(provision).toHaveBeenCalledOnce()
    expect(provision).toHaveBeenCalledWith(host, {
      refreshGfsOnly: true,
      targetSuspended: false,
    })
    const deployment = live()
    expect(deployment.spec?.replicas).toBe(1)
    expect(envValue(deployment, 'CLERUM_STATELESS_LIFECYCLE')).toBe('true')
    expect(envValue(deployment, 'CLERUM_SESSION_STORE')).toBe('sqlite')
    expect(envValue(deployment, 'CLERUM_SESSION_DB_DIR')).toBe('/var/lib/clerum/state')
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

  it('binds the committed health transition to the Host uid (#691)', async () => {
    const infrastructureTelemetryReporter = createTelemetryReporterMock()
    const { reconciler, customApi } = createReconciler({ infrastructureTelemetryReporter })
    await reconciler.reconcile({ ...makeStatelessHost(), generation: 3 })

    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
    expect(infrastructureTelemetryReporter.enqueueHealthTransition).toHaveBeenCalledTimes(1)
    expect(infrastructureTelemetryReporter.enqueueHealthTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        hostLookupReference: {
          name: 'stateless-host',
          namespace: 'mcp-host',
          generation: 3,
          uid: 'stateless-host-uid',
        },
        payload: { transition: 'lifecycle:suspended', state: 'suspended' },
      })
    )
  })

  it('never commits a lifecycle status for a Host snapshot without a uid (#693)', async () => {
    const infrastructureTelemetryReporter = createTelemetryReporterMock()
    const { reconciler, customApi } = createReconciler({ infrastructureTelemetryReporter })
    const withUid: HostCRD = { ...makeStatelessHost(), generation: 3 }
    const withoutUid: HostCRD = { ...makeStatelessHost(), generation: 3 }
    delete (withoutUid as { uid?: string }).uid

    // Liveness: the identical fixture, differing only in the uid, does commit
    // and does emit. The absence below is the missing uid, not a fixture that
    // never had anything to commit.
    await reconciler.reconcile(withUid)
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
    expect(infrastructureTelemetryReporter.enqueueHealthTransition).toHaveBeenCalledTimes(1)

    await reconciler.reconcile(withoutUid)

    // The health-transition emitter carries a uid guard the compiler demands,
    // but it is unreachable through reconcile: the commit that invokes it does
    // not happen without a uid, so no uid-less reference can reach control-api
    // by this route and earn the terminal 400 (#693).
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
    expect(infrastructureTelemetryReporter.enqueueHealthTransition).toHaveBeenCalledTimes(1)
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

  it('confirmed incompatibility restores active state after a concurrent suspend', async () => {
    const { reconciler, customApi } = createReconciler({
      countCommunicationChannels: () => 1,
    })
    // A confirmed channel conflict has the existing always-on policy. If a
    // heartbeat suspended the Host during the fresh read, reconcile wakes it.
    const host = makeStatelessHost({
      status: { lifecycle: { state: 'active', wakeHandledGeneration: 3 } },
    })
    customApi.getNamespacedCustomObject.mockResolvedValue(
      freshHostRead({ state: 'suspended', wakeHandledGeneration: 5, reason: 'idle' })
    )

    await reconciler.reconcile(host)

    const writes = lifecycleStatusWrites(customApi)
    expect(writes.at(-1)?.lifecycle).toEqual({
      state: 'active',
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

describe('HostReconciler readiness poll generation fence', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  async function pollOnce(options: { supersede: boolean }) {
    vi.useFakeTimers()
    const { reconciler } = createReconciler()
    const internals = reconciler as unknown as {
      advanceReconcileGeneration(name: string): number
      setStatus(name: string, status: { deployed: boolean; ready: boolean; message: string }): void
      pollReadiness(
        name: string,
        namespace: string,
        intervalMs?: number,
        maxAttempts?: number
      ): void
    }
    const readySpy = vi.spyOn(reconciler as any, 'checkDeploymentReady').mockResolvedValue(true)
    internals.advanceReconcileGeneration('stateless-host')
    internals.setStatus('stateless-host', {
      deployed: true,
      ready: false,
      message: 'Deployed, waiting for readiness',
    })
    internals.pollReadiness('stateless-host', 'tenant-ns', 10, 2)
    if (options.supersede) {
      // A later reconcile pass owns the status now; the older poll must not
      // overwrite its verdict with a stale 'Running'.
      internals.advanceReconcileGeneration('stateless-host')
      internals.setStatus('stateless-host', {
        deployed: true,
        ready: false,
        message: 'Degraded: newer reconcile verdict',
      })
    }
    await vi.advanceTimersByTimeAsync(10)
    return { reconciler, readySpy }
  }

  it('reports Running when no newer reconcile superseded the poll', async () => {
    const { reconciler, readySpy } = await pollOnce({ supersede: false })

    expect(readySpy).toHaveBeenCalledTimes(1)
    expect(reconciler.getStatus('stateless-host')).toEqual({
      deployed: true,
      ready: true,
      message: 'Running',
    })
  })

  it('keeps the newer reconcile verdict when the generation advanced during the poll', async () => {
    const { reconciler, readySpy } = await pollOnce({ supersede: true })

    // Liveness witness: the poll ran and observed a ready Deployment.
    expect(readySpy).toHaveBeenCalledTimes(1)
    expect(readySpy).toHaveBeenCalledWith('stateless-host', 'tenant-ns')
    expect(reconciler.getStatus('stateless-host')).toEqual({
      deployed: true,
      ready: false,
      message: 'Degraded: newer reconcile verdict',
    })
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
    const warnSpy = vi.spyOn(HostContextLogger.prototype, 'warn').mockImplementation(() => {})
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
    expect(advisoryLogs[0][1]).toEqual(
      expect.objectContaining({
        imagePullPolicy: 'IfNotPresent',
        image: expect.stringContaining('clerum/mcp-host:0.6.0'),
      })
    )

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
