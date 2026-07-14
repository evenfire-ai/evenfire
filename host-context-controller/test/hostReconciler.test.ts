import { describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import {
  DEFAULT_FIRST_PARTY_WORKFLOW_CONTROL_SCOPES,
  HostReconciler,
  resolveWorkflowControlScopes,
} from '../src/hostReconciler'
import { HostCRD } from '../src/types'
import {
  asAppsApi,
  asCoreApi,
  asNetworkingApi,
  asRbacApi,
  createMockAppsApi,
  createMockCoreApi,
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
    // mcpHost runtime token provisioning config. Tests do NOT exercise the real
    // network call; `mcpHostRuntimeTokenIssuerClient` is mocked below to short-circuit
    // before reaching the InternalControl signer.
    controlApiBaseUrl: 'http://control-api.test:8090',
    internalControlJwtHccHmacSecret: 'test-hcc-internal-control-secret',
    hccTargetNamespace: 'mcp-host',
    mcpHostGatewayUrl:
      'http://nginx-workflow-approval-gateway.control-plane.svc.cluster.local:8092',
  },
}))

// Short-circuit the HCC issuer so reconcile tests don't reach the network.
// Returns deterministic tokens; the secret-build path in `secretFactory` is
// exercised end-to-end so the Secret content assertions still test real code.
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
    ['to'.concat('ken')]: 'gfs-runtime-value',
    expiresInSeconds: 300,
    subject: 'host:1st:mcp-host/standalone',
  }),
}))

function makeHost(overrides?: Partial<HostCRD>): HostCRD {
  return {
    name: 'alpha-host',
    namespace: 'mcp-host',
    spec: {
      host: 'alpha-host',
      contextRef: 'context-a',
      secretRef: 'host-secret',
      channels: ['channel-a'],
    },
    ...overrides,
  }
}

function makeDesktopHost(
  desktopSpec: { browser?: boolean; x11?: boolean } = { x11: true },
  overrides?: Partial<HostCRD>
): HostCRD {
  return makeHost({
    ...overrides,
    spec: {
      host: 'desktop-host',
      contextRef: 'context-a',
      secretRef: 'host-secret',
      desktop: desktopSpec,
      ...(overrides as HostCRD | undefined)?.spec,
    },
    name: overrides?.name ?? 'desktop-host',
  })
}

function createReconciler() {
  const appsApi = createMockAppsApi()
  const coreApi = createMockCoreApi()
  const networkingApi = createMockNetworkingApi()
  const rbacApi = createMockRbacApi()

  const reconciler = new HostReconciler({} as k8s.KubeConfig, {
    appsApi: asAppsApi(appsApi),
    coreApi: asCoreApi(coreApi),
    networkingApi: asNetworkingApi(networkingApi),
    rbacApi: asRbacApi(rbacApi),
  })

  return { reconciler, appsApi, coreApi, networkingApi, rbacApi }
}

describe('HostReconciler', () => {
  it('creates deployment, service, and pvc for valid host', async () => {
    const { reconciler, appsApi, coreApi } = createReconciler()

    const host = makeHost()
    await reconciler.reconcile(host)

    expect(coreApi.readNamespacedSecret).toHaveBeenCalledWith({
      namespace: 'mcp-host',
      name: 'host-secret',
    })
    expect(coreApi.createNamespacedPersistentVolumeClaim).toHaveBeenCalledTimes(1)
    // reconcile creates two Services: the host (mcp-host ns) and its
    // channel-reader handoff Service (channels ns).
    expect(coreApi.createNamespacedService).toHaveBeenCalledTimes(2)
    expect(coreApi.createNamespacedService.mock.calls).toContainEqual([
      expect.objectContaining({
        namespace: 'mcp-host',
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'alpha-host' }),
        }),
      }),
    ])
    expect(coreApi.createNamespacedService.mock.calls).toContainEqual([
      expect.objectContaining({
        namespace: 'channels',
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'channel-reader-alpha-host' }),
        }),
      }),
    ])
    // reconcile creates two Deployments: the host (mcp-host ns) and its
    // channel-reader (channels ns).
    expect(appsApi.createNamespacedDeployment).toHaveBeenCalledTimes(2)
    expect(appsApi.createNamespacedDeployment.mock.calls).toContainEqual([
      expect.objectContaining({ namespace: 'mcp-host' }),
    ])
    expect(appsApi.createNamespacedDeployment.mock.calls).toContainEqual([
      expect.objectContaining({ namespace: 'channels' }),
    ])
    expect(reconciler.getStatus('alpha-host')).toMatchObject({ deployed: true, ready: true })
  })

  it('fails closed when referenced secret is missing', async () => {
    const { reconciler, appsApi, coreApi, networkingApi, rbacApi } = createReconciler()
    coreApi.readNamespacedSecret.mockImplementation(({ name }: { name?: string } = {}) => {
      if (name === 'host-secret') {
        return Promise.reject({ code: 404 })
      }
      if (name === 'channel-reader-alpha-host-mcp-host-runtime-auth') {
        return Promise.resolve({
          metadata: {
            labels: {
              'clerum.io/component': 'channel-reader',
              'clerum.io/host': 'alpha-host',
              'clerum.io/managed-by': 'host-context-controller',
              'clerum.io/secret-purpose': 'mcp-host-runtime-auth',
            },
          },
        })
      }
      return Promise.resolve({
        metadata: {
          labels: {
            'clerum.io/managed-by': 'host-context-controller',
            'clerum.io/host': 'alpha-host',
          },
        },
      })
    })

    await reconciler.reconcile(makeHost())

    expect(coreApi.createNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(coreApi.createNamespacedService).not.toHaveBeenCalled()
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
      name: 'alpha-host',
      namespace: 'mcp-host',
    })
    expect(coreApi.deleteNamespacedService).toHaveBeenCalledWith({
      name: 'alpha-host',
      namespace: 'mcp-host',
    })
    expect(coreApi.deleteNamespacedSecret).toHaveBeenCalledWith({
      name: 'host-alpha-host-mcp-host-runtime-tokens',
      namespace: 'mcp-host',
    })
    expect(coreApi.deleteNamespacedSecret).toHaveBeenCalledWith({
      name: 'channel-reader-alpha-host-mcp-host-runtime-auth',
      namespace: 'channels',
    })
    expect(rbacApi.deleteNamespacedRole).toHaveBeenCalledWith({
      name: 'host-alpha-host-config-reader',
      namespace: 'mcp-host',
    })
    expect(rbacApi.deleteNamespacedRoleBinding).toHaveBeenCalledWith({
      name: 'host-alpha-host-config-reader',
      namespace: 'mcp-host',
    })
    expect(networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: 'mcp-host-alpha-host-ingress-rpc-proxy',
      namespace: 'mcp-host',
    })
    expect(reconciler.getStatus('alpha-host')).toMatchObject({
      deployed: false,
      ready: false,
    })
  })

  it('does not delete legacy channel-reader runtime auth when labels are not HCC-owned', async () => {
    const { reconciler, coreApi } = createReconciler()
    coreApi.readNamespacedSecret.mockImplementation(({ name }: { name?: string } = {}) => {
      if (name === 'host-secret') {
        return Promise.reject({ code: 404 })
      }
      if (name === 'channel-reader-alpha-host-mcp-host-runtime-auth') {
        return Promise.resolve({
          metadata: {
            labels: {
              'clerum.io/host': 'alpha-host',
            },
          },
        })
      }
      return Promise.resolve({
        metadata: {
          labels: {
            'clerum.io/managed-by': 'host-context-controller',
            'clerum.io/host': 'alpha-host',
          },
        },
      })
    })

    await reconciler.reconcile(makeHost())

    expect(coreApi.deleteNamespacedSecret).not.toHaveBeenCalledWith({
      name: 'channel-reader-alpha-host-mcp-host-runtime-auth',
      namespace: 'channels',
    })
  })

  it('does not provision per-host channel-reader mcp-host runtime JWT mounts', async () => {
    const { reconciler, appsApi, coreApi } = createReconciler()

    await reconciler.reconcile(makeHost())

    const writtenSecrets = [
      ...coreApi.createNamespacedSecret.mock.calls.map(([arg]) => arg),
      ...coreApi.replaceNamespacedSecret.mock.calls.map(([arg]) => arg),
    ]
    expect(writtenSecrets).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace: 'channels',
          body: expect.objectContaining({
            metadata: expect.objectContaining({
              name: 'channel-reader-alpha-host-mcp-host-runtime-auth',
            }),
          }),
        }),
      ])
    )

    const channelReaderCreate = appsApi.createNamespacedDeployment.mock.calls.find(([arg]) => {
      const body = arg.body as k8s.V1Deployment
      return body.metadata?.name === 'channel-reader-alpha-host'
    })
    expect(channelReaderCreate).toBeDefined()
    const deployment = channelReaderCreate![0].body as k8s.V1Deployment
    const container = deployment.spec?.template.spec?.containers?.[0]
    const annotations = deployment.spec?.template.metadata?.annotations ?? {}
    expect(annotations['clerum.io/runtime-auth-revision']).toBeUndefined()
    const envNames = (container?.env ?? []).map(env => env.name)
    // No per-host JWT runtime/control token env — those would be
    // CLERUM_MCP_HOST_RUNTIME_* / *_WORKFLOW_CONTROL_TOKEN. The routing URL
    // (CLERUM_MCP_HOST_URL) is allowed: it is a Service address, not auth.
    expect(
      envNames.filter(
        (name: string) => name.startsWith('CLERUM_MCP_HOST_') && name !== 'CLERUM_MCP_HOST_URL'
      )
    ).toEqual([])
    expect(container?.volumeMounts?.map(mount => mount.name) ?? []).not.toContain(
      'mcp-host-runtime-auth'
    )
    expect(deployment.spec?.template.spec?.volumes?.map(volume => volume.name) ?? []).not.toContain(
      'mcp-host-runtime-auth'
    )
  })

  it('propagates cleanup errors when referenced secret is missing', async () => {
    const { reconciler, appsApi, coreApi } = createReconciler()
    coreApi.readNamespacedSecret.mockRejectedValue({ code: 404 })
    appsApi.deleteNamespacedDeployment.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { code: 403 })
    )

    await expect(reconciler.reconcile(makeHost())).rejects.toThrow(
      'Failed to delete runtime resources for Host "alpha-host"'
    )
    expect(coreApi.deleteNamespacedService).toHaveBeenCalledWith({
      name: 'alpha-host',
      namespace: 'mcp-host',
    })
    expect(reconciler.getStatus('alpha-host')).toMatchObject({
      deployed: false,
      ready: false,
      message: 'Not reconciled yet',
    })
  })

  it('removes orphaned host runtime resources during full reconcile', async () => {
    const { reconciler, appsApi, coreApi } = createReconciler()
    appsApi.listNamespacedDeployment.mockResolvedValue({
      items: [
        {
          metadata: {
            name: 'orphan-host',
            namespace: 'mcp-host',
            labels: { 'clerum.io/host': 'orphan-host' },
          },
        },
      ],
    })

    await reconciler.fullReconcile([])

    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
      name: 'orphan-host',
      namespace: 'mcp-host',
    })
    expect(coreApi.deleteNamespacedService).toHaveBeenCalledWith({
      name: 'orphan-host',
      namespace: 'mcp-host',
    })
    expect(coreApi.deleteNamespacedPersistentVolumeClaim).toHaveBeenCalledWith({
      name: 'orphan-host-workspace',
      namespace: 'mcp-host',
    })
  })

  it('skips replace on existing bound PVC (immutable spec) instead of forcing 422', async () => {
    const { reconciler, coreApi } = createReconciler()
    coreApi.createNamespacedPersistentVolumeClaim.mockRejectedValue({ code: 409 })
    coreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
      metadata: { resourceVersion: '42' },
      spec: {
        volumeName: 'pvc-aaaa-bbbb-cccc-dddd',
        storageClassName: 'standard',
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: '10Gi' } },
      },
    })

    await reconciler.reconcile(makeHost())

    expect(coreApi.replaceNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
  })

  it('replaces existing unbound PVC (no volumeName) to preserve growth/path migrations', async () => {
    const { reconciler, coreApi } = createReconciler()
    coreApi.createNamespacedPersistentVolumeClaim.mockRejectedValue({ code: 409 })
    coreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
      metadata: { resourceVersion: '7' },
      spec: {
        storageClassName: 'standard',
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: '10Gi' } },
      },
    })

    await reconciler.reconcile(makeHost())

    expect(coreApi.replaceNamespacedPersistentVolumeClaim).toHaveBeenCalledTimes(1)
  })
})

describe('HostReconciler — desktop support', () => {
  it('uses desktopImage when host.spec.desktop.x11 = true', async () => {
    const { reconciler, appsApi } = createReconciler()
    const host = makeDesktopHost({ x11: true })
    await reconciler.reconcile(host)

    const call = appsApi.createNamespacedDeployment.mock.calls[0][0]
    const container = call.body.spec.template.spec.containers[0]
    expect(container.image).toBe('clerum/mcp-host-desktop:latest')
  })

  it('uses desktopImage when host.spec.desktop.browser = true', async () => {
    const { reconciler, appsApi } = createReconciler()
    const host = makeDesktopHost({ browser: true })
    await reconciler.reconcile(host)

    const call = appsApi.createNamespacedDeployment.mock.calls[0][0]
    const container = call.body.spec.template.spec.containers[0]
    expect(container.image).toBe('clerum/mcp-host-desktop:latest')
  })

  it('adds desktop port 3000 to deployment when desktop enabled', async () => {
    const { reconciler, appsApi } = createReconciler()
    const host = makeDesktopHost({ x11: true })
    await reconciler.reconcile(host)

    const call = appsApi.createNamespacedDeployment.mock.calls[0][0]
    const ports = call.body.spec.template.spec.containers[0].ports
    expect(ports).toHaveLength(2)
    expect(ports[0]).toMatchObject({ name: 'http', containerPort: 8080 })
    expect(ports[1]).toMatchObject({ name: 'desktop', containerPort: 3000 })
  })

  it('adds desktop port 3000 to service when desktop enabled', async () => {
    const { reconciler, coreApi } = createReconciler()
    const host = makeDesktopHost({ x11: true })
    await reconciler.reconcile(host)

    const call = coreApi.createNamespacedService.mock.calls[0][0]
    const ports = call.body.spec.ports
    expect(ports).toHaveLength(2)
    expect(ports[0]).toMatchObject({ name: 'http', port: 8080 })
    expect(ports[1]).toMatchObject({ name: 'desktop', port: 3000, targetPort: 'desktop' })
  })

  it('sets desktop env vars when desktop enabled', async () => {
    const { reconciler, appsApi } = createReconciler()
    const host = makeDesktopHost({ x11: true, browser: true })
    await reconciler.reconcile(host)

    const call = appsApi.createNamespacedDeployment.mock.calls[0][0]
    const env = call.body.spec.template.spec.containers[0].env
    const envMap = new Map(env.map((e: { name: string; value?: string }) => [e.name, e.value]))
    expect(envMap.get('CLERUM_DESKTOP_X11')).toBe('true')
    expect(envMap.get('CLERUM_DESKTOP_BROWSER')).toBe('true')
    expect(envMap.get('PUID')).toBe('1001')
    expect(envMap.get('PGID')).toBe('1001')
    expect(envMap.get('TZ')).toBe('UTC')
    expect(envMap.get('CUSTOM_PORT')).toBe('3000')
  })

  it('injects the workflow gateway URL for runtime broker traffic', async () => {
    const { reconciler, appsApi } = createReconciler()
    await reconciler.reconcile(makeHost())

    const call = appsApi.createNamespacedDeployment.mock.calls[0][0]
    const env = call.body.spec.template.spec.containers[0].env
    const envMap = new Map(env.map((e: { name: string; value?: string }) => [e.name, e.value]))

    expect(envMap.get('MCP_HOST_GATEWAY_URL')).toBe(
      'http://nginx-workflow-approval-gateway.control-plane.svc.cluster.local:8092'
    )
    expect(envMap.has('CLERUM_WORKFLOW_GATEWAY_URL')).toBe(false)
  })

  it('injects the mcpHost workflow control token from the mcp-host-runtime-token secret', async () => {
    const { reconciler, appsApi } = createReconciler()
    await reconciler.reconcile(makeHost())

    const call = appsApi.createNamespacedDeployment.mock.calls[0][0]
    const env = call.body.spec.template.spec.containers[0].env
    const controlEnv = env.find(
      (e: { name: string }) => e.name === 'MCP_HOST_WORKFLOW_CONTROL_TOKEN'
    )

    expect(controlEnv?.valueFrom?.secretKeyRef).toEqual({
      name: 'host-alpha-host-mcp-host-runtime-tokens',
      key: 'mcp-host-workflow-control-token',
    })
  })

  it('sets runAsNonRoot: false for desktop hosts', async () => {
    const { reconciler, appsApi } = createReconciler()
    const host = makeDesktopHost({ x11: true })
    await reconciler.reconcile(host)

    const call = appsApi.createNamespacedDeployment.mock.calls[0][0]
    const secCtx = call.body.spec.template.spec.securityContext
    expect(secCtx.runAsNonRoot).toBe(false)
    expect(secCtx.seccompProfile).toEqual({ type: 'RuntimeDefault' })
  })

  it('sets startup probe initialDelaySeconds to 30 for desktop hosts', async () => {
    const { reconciler, appsApi } = createReconciler()
    const host = makeDesktopHost({ x11: true })
    await reconciler.reconcile(host)

    const call = appsApi.createNamespacedDeployment.mock.calls[0][0]
    const startupProbe = call.body.spec.template.spec.containers[0].startupProbe
    expect(startupProbe.initialDelaySeconds).toBe(30)
    expect(startupProbe.failureThreshold).toBe(120)
  })

  it('uses desktopResources for desktop hosts', async () => {
    const { reconciler, appsApi } = createReconciler()
    const host = makeDesktopHost({ x11: true })
    await reconciler.reconcile(host)

    const call = appsApi.createNamespacedDeployment.mock.calls[0][0]
    const resources = call.body.spec.template.spec.containers[0].resources
    expect(resources.requests.memory).toBe('256Mi')
    expect(resources.requests.cpu).toBe('250m')
    expect(resources.limits.memory).toBe('4Gi')
    expect(resources.limits.cpu).toBe('1000m')
  })

  it('creates desktop NetworkPolicy when desktop enabled', async () => {
    const { reconciler, networkingApi } = createReconciler()
    const host = makeDesktopHost({ x11: true })
    await reconciler.reconcile(host)

    // reconcile creates per-host ingress, rpc-proxy egress, desktop,
    // GFS egress, channel-reader, and workflow-approval-reader policies.
    expect(networkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(8)
    const names = networkingApi.createNamespacedNetworkPolicy.mock.calls.map(
      (c: any[]) => c[0].body.metadata.name
    )
    expect(names).toEqual(
      expect.arrayContaining([
        'mcp-host-desktop-host-egress-gfs',
        'mcp-host-desktop-host-ingress-workflow-approval-reader',
        'workflow-approval-reader-desktop-host-egress-mcp-host',
      ])
    )
    const call = networkingApi.createNamespacedNetworkPolicy.mock.calls.find(
      (c: any[]) => c[0].body.metadata.name === 'allow-rpc-proxy-desktop-desktop-host'
    )![0]
    expect(call.body.metadata.name).toBe('allow-rpc-proxy-desktop-desktop-host')
    expect(call.body.spec.podSelector).toEqual({ matchLabels: { app: 'desktop-host' } })
  })

  it('does not create desktop NetworkPolicy for non-desktop hosts', async () => {
    const { reconciler, networkingApi } = createReconciler()
    const host = makeHost()
    await reconciler.reconcile(host)

    // reconcile creates 6 NPs for non-desktop hosts:
    // mcp-host ingress from channel-reader, mcp-host ingress from rpc-proxy,
    // mcp-host GFS egress, rpc-proxy host egress, channel-reader egress,
    // and workflow-approval-reader policies.
    // (no desktop NP)
    expect(networkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(7)
    const names = networkingApi.createNamespacedNetworkPolicy.mock.calls.map(
      (c: any[]) => c[0].body.metadata.name
    )
    expect(names).toEqual(
      expect.arrayContaining([
        'mcp-host-alpha-host-egress-gfs',
        'mcp-host-alpha-host-ingress-workflow-approval-reader',
        'workflow-approval-reader-alpha-host-egress-mcp-host',
      ])
    )
    expect(names).not.toContain(expect.stringContaining('desktop'))
  })

  it('deletes desktop NetworkPolicy on reconcileDelete (no leak per Host)', async () => {
    const { reconciler, networkingApi } = createReconciler()

    await reconciler.reconcileDelete('desktop-host', 'mcp-host')

    expect(networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: 'allow-rpc-proxy-desktop-desktop-host',
      namespace: 'mcp-host',
    })
  })

  it('swallows 404 when desktop NetworkPolicy deletion finds nothing (non-desktop host)', async () => {
    const { reconciler, networkingApi } = createReconciler()
    networkingApi.deleteNamespacedNetworkPolicy.mockRejectedValueOnce({ code: 404 })

    await expect(
      reconciler.reconcileDelete('non-desktop-host', 'mcp-host')
    ).resolves.toBeUndefined()
  })

  it('non-desktop hosts use standard image and resources (regression)', async () => {
    const { reconciler, appsApi } = createReconciler()
    const host = makeHost()
    await reconciler.reconcile(host)

    const call = appsApi.createNamespacedDeployment.mock.calls[0][0]
    const container = call.body.spec.template.spec.containers[0]
    expect(container.image).toBe('clerum/mcp-host:0.6.0')
    expect(container.resources.requests.memory).toBe('128Mi')
    expect(container.startupProbe.initialDelaySeconds).toBe(10)

    const secCtx = call.body.spec.template.spec.securityContext
    expect(secCtx.runAsNonRoot).toBe(true)
    expect(secCtx.fsGroup).toBe(1001)
  })

  it('emits restricted-PSA-compliant pod-level securityContext for non-desktop hosts', async () => {
    // MCC shared-tenant namespaces (mcp-host-<slug>) are labeled
    // pod-security.kubernetes.io/enforce=restricted. The pod-level
    // securityContext must set runAsNonRoot + seccompProfile or the
    // ReplicaSet gets FailedCreate and never produces a pod.
    const { reconciler, appsApi } = createReconciler()
    await reconciler.reconcile(makeHost())

    const call = appsApi.createNamespacedDeployment.mock.calls[0][0]
    const secCtx = call.body.spec.template.spec.securityContext
    expect(secCtx.runAsNonRoot).toBe(true)
    // 1001 = the mcp-host image's baked-in `nodejs` user; matches the
    // workspace PVC ownership so re-rolling existing hosts doesn't EACCES.
    expect(secCtx.runAsUser).toBe(1001)
    expect(secCtx.runAsGroup).toBe(1001)
    expect(secCtx.fsGroup).toBe(1001)
    expect(secCtx.seccompProfile).toEqual({ type: 'RuntimeDefault' })
  })

  it('emits restricted-PSA-compliant mcp-host container securityContext for non-desktop hosts', async () => {
    // Restricted PSA requires container-level allowPrivilegeEscalation=false,
    // capabilities.drop=[ALL], runAsNonRoot=true, seccompProfile=RuntimeDefault.
    const { reconciler, appsApi } = createReconciler()
    await reconciler.reconcile(makeHost())

    const call = appsApi.createNamespacedDeployment.mock.calls[0][0]
    const container = call.body.spec.template.spec.containers[0]
    expect(container.name).toBe('mcp-host')
    expect(container.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      // 1001 = the mcp-host image's baked-in `nodejs` user (Dockerfile{,.slim,.full}).
      runAsUser: 1001,
      runAsGroup: 1001,
      capabilities: { drop: ['ALL'] },
      seccompProfile: { type: 'RuntimeDefault' },
    })
    // mcp-host writes outside its mounted volumes; restricted PSA does not
    // require readOnlyRootFilesystem, so it must remain unset.
    expect(container.securityContext.readOnlyRootFilesystem).toBeUndefined()
  })

  it('non-desktop hosts have only http port in service', async () => {
    const { reconciler, coreApi } = createReconciler()
    const host = makeHost()
    await reconciler.reconcile(host)

    const call = coreApi.createNamespacedService.mock.calls[0][0]
    const ports = call.body.spec.ports
    expect(ports).toHaveLength(1)
    expect(ports[0]).toMatchObject({ name: 'http', port: 8080 })
  })
})

describe('HostReconciler — per-Host RBAC scaffolding', () => {
  it('provisions per-Host SA + Role + RoleBinding before the Deployment', async () => {
    const { reconciler, coreApi, rbacApi } = createReconciler()
    await reconciler.reconcile(makeHost())

    expect(coreApi.createNamespacedServiceAccount).toHaveBeenCalledTimes(1)
    expect(coreApi.createNamespacedServiceAccount.mock.calls[0][0].body).toMatchObject({
      kind: 'ServiceAccount',
      metadata: { name: 'host-alpha-host-sa', namespace: 'mcp-host' },
    })

    expect(rbacApi.createNamespacedRole).toHaveBeenCalledTimes(1)
    const roleBody = rbacApi.createNamespacedRole.mock.calls[0][0].body
    expect(roleBody.metadata.name).toBe('host-alpha-host-config-reader')
    // The mcp-host-runtime-token Secret appears in the read-only rule ONLY. HCC
    // writes that Secret using its own ServiceAccount (cluster RBAC); the
    // per-Host SA bound to this Role is mounted on the runtime mcp-host pod,
    // which must NOT be able to rotate its own credentials.
    expect(roleBody.rules).toEqual([
      {
        apiGroups: ['clerum.io'],
        resources: ['hosts'],
        resourceNames: ['alpha-host'],
        verbs: ['get', 'watch', 'list'],
      },
      {
        apiGroups: [''],
        resources: ['configmaps'],
        resourceNames: ['host-alpha-host-env'],
        verbs: ['get', 'watch', 'list'],
      },
      {
        apiGroups: [''],
        resources: ['secrets'],
        resourceNames: [
          'host-secret',
          'host-alpha-host-env-secret',
          'host-alpha-host-mcp-host-runtime-tokens',
        ],
        verbs: ['get', 'watch', 'list'],
      },
    ])

    expect(rbacApi.createNamespacedRoleBinding).toHaveBeenCalledTimes(1)
    expect(rbacApi.createNamespacedRoleBinding.mock.calls[0][0].body).toMatchObject({
      kind: 'RoleBinding',
      subjects: [{ kind: 'ServiceAccount', name: 'host-alpha-host-sa', namespace: 'mcp-host' }],
      roleRef: { kind: 'Role', name: 'host-alpha-host-config-reader' },
    })
  })

  it('uses the per-Host ServiceAccount in the Deployment template', async () => {
    const { reconciler, appsApi } = createReconciler()
    await reconciler.reconcile(makeHost())

    const deployment = appsApi.createNamespacedDeployment.mock.calls[0][0].body
    expect(deployment.spec.template.spec.serviceAccountName).toBe('host-alpha-host-sa')
  })

  it('injects CLERUM_LLM_SECRET_REF into the Deployment env from spec.secretRef', async () => {
    const { reconciler, appsApi } = createReconciler()
    await reconciler.reconcile(makeHost())

    const deployment = appsApi.createNamespacedDeployment.mock.calls[0][0].body
    const env = deployment.spec.template.spec.containers[0].env as Array<{
      name: string
      value?: string
    }>
    expect(env).toContainEqual({ name: 'CLERUM_LLM_SECRET_REF', value: 'host-secret' })
  })

  it('rewrites Role resourceNames when spec.secretRef changes (replace path)', async () => {
    const { reconciler, rbacApi } = createReconciler()
    rbacApi.createNamespacedRole.mockRejectedValueOnce({ code: 409 })
    rbacApi.readNamespacedRole.mockResolvedValue({ metadata: { resourceVersion: '7' } })

    await reconciler.reconcile(makeHost({ spec: { secretRef: 'rotated-secret' } } as never))

    expect(rbacApi.replaceNamespacedRole).toHaveBeenCalledTimes(1)
    const replaced = rbacApi.replaceNamespacedRole.mock.calls[0][0].body
    // The read-only rule includes the mcp-host-runtime-tokens Secret too. Filter by
    // verbs so we don't accidentally pick up a write-only rule.
    const secretRule = replaced.rules.find(
      (r: { resources: string[]; verbs: string[] }) =>
        r.resources[0] === 'secrets' && r.verbs.includes('get')
    )
    expect(secretRule.resourceNames).toEqual([
      'rotated-secret',
      'host-alpha-host-env-secret',
      'host-alpha-host-mcp-host-runtime-tokens',
    ])
    expect(replaced.metadata.resourceVersion).toBe('7')
  })

  it('cleans up RBAC on reconcileDelete', async () => {
    const { reconciler, coreApi, rbacApi } = createReconciler()
    await reconciler.reconcileDelete('alpha-host', 'mcp-host')

    expect(rbacApi.deleteNamespacedRoleBinding).toHaveBeenCalledWith({
      name: 'host-alpha-host-config-reader',
      namespace: 'mcp-host',
    })
    expect(rbacApi.deleteNamespacedRole).toHaveBeenCalledWith({
      name: 'host-alpha-host-config-reader',
      namespace: 'mcp-host',
    })
    expect(coreApi.deleteNamespacedServiceAccount).toHaveBeenCalledWith({
      name: 'host-alpha-host-sa',
      namespace: 'mcp-host',
    })
  })

  it('treats existing RBAC as success when create returns 409 (idempotent)', async () => {
    const { reconciler, coreApi, rbacApi } = createReconciler()
    coreApi.createNamespacedServiceAccount.mockRejectedValueOnce({ code: 409 })
    rbacApi.createNamespacedRoleBinding.mockRejectedValueOnce({ code: 409 })

    await expect(reconciler.reconcile(makeHost())).resolves.toBeUndefined()
    expect(reconciler.getStatus('alpha-host').deployed).toBe(true)
  })
})

describe('buildChannelReaderDeployment', () => {
  it('returns Deployment with name channel-reader-<host>', () => {
    const { reconciler } = createReconciler()
    const dep = (reconciler as any).buildChannelReaderDeployment(makeHost(), '')
    expect(dep.metadata?.name).toBe('channel-reader-alpha-host')
    expect(dep.metadata?.namespace).toBe('channels')
  })

  it('sets management labels', () => {
    const { reconciler } = createReconciler()
    const dep = (reconciler as any).buildChannelReaderDeployment(makeHost({ name: 'agent-a' }), '')
    // app.kubernetes.io/name MUST be per-Host (channel-reader-<host>) to
    // avoid collision with the static Deployment's selector which matches
    // supersets (see comment in buildChannelReaderDeployment).
    expect(dep.metadata?.labels).toMatchObject({
      app: 'channel-reader',
      'app.kubernetes.io/name': 'channel-reader-agent-a',
      'clerum.io/host': 'agent-a',
      'clerum.io/managed-by': 'host-context-controller',
    })
    expect(dep.spec?.template?.metadata?.labels).toMatchObject({
      app: 'channel-reader',
      'app.kubernetes.io/name': 'channel-reader-agent-a',
      'clerum.io/host': 'agent-a',
    })
  })

  it('sets CLERUM_HOST_REF env to the host name', () => {
    const { reconciler } = createReconciler()
    const dep = (reconciler as any).buildChannelReaderDeployment(makeHost({ name: 'agent-a' }), '')
    const env = dep.spec!.template!.spec!.containers[0].env!
    expect(env).toContainEqual({ name: 'CLERUM_HOST_REF', value: 'agent-a' })
  })

  it('injects CLERUM_NAMESPACE via downward API fieldRef metadata.namespace', () => {
    const { reconciler } = createReconciler()
    const dep = (reconciler as any).buildChannelReaderDeployment(makeHost(), '')
    const env = dep.spec!.template!.spec!.containers[0].env!
    expect(env).toContainEqual({
      name: 'CLERUM_NAMESPACE',
      valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } },
    })
  })

  it('does not inject direct control-api credentials into channel-reader', () => {
    const { reconciler } = createReconciler()
    const dep = (reconciler as any).buildChannelReaderDeployment(makeHost(), '')
    const env = dep.spec!.template!.spec!.containers[0].env!
    const envFrom = dep.spec!.template!.spec!.containers[0].envFrom ?? []
    const rendered = JSON.stringify({ env, envFrom })

    expect(rendered).not.toContain('CLERUM_CONTROL_API_SERVICE_TOKEN')
    expect(rendered).not.toContain('CONTROL_API_SERVICE_TOKEN')
    expect(rendered).not.toContain('channel-reader-internal-tokens')
  })

  it('injects CLERUM_MCP_HOST_URL pointing at the slug-scoped mcp-host Service in host.namespace', () => {
    const { reconciler } = createReconciler()
    // mcp-host Service is named host.name and lives in host.namespace
    // (mcp-server here / mcp-host-<slug> in MCC), NOT the channels namespace.
    const dep = (reconciler as any).buildChannelReaderDeployment(
      makeHost({ name: 'agent-a', namespace: 'mcp-host-agent-a' }),
      ''
    )
    const env = dep.spec!.template!.spec!.containers[0].env!
    expect(env).toContainEqual({
      name: 'CLERUM_MCP_HOST_URL',
      value: 'http://agent-a.mcp-host-agent-a.svc.cluster.local:8080',
    })
  })

  it('mounts envFrom on configMapRef clerum-channel-reader-config', () => {
    const { reconciler } = createReconciler()
    const dep = (reconciler as any).buildChannelReaderDeployment(makeHost(), '')
    const envFrom = dep.spec!.template!.spec!.containers[0].envFrom!
    expect(envFrom).toContainEqual({ configMapRef: { name: 'clerum-channel-reader-config' } })
  })

  it('sets clerum.io/credentials-revision annotation when revision is provided', () => {
    const { reconciler } = createReconciler()
    const dep = (reconciler as any).buildChannelReaderDeployment(makeHost(), 'abc123')
    expect(dep.spec?.template?.metadata?.annotations).toMatchObject({
      'clerum.io/credentials-revision': 'abc123',
    })
  })

  it('omits credentials-revision annotation when revision is empty (initial create)', () => {
    const { reconciler } = createReconciler()
    const dep = (reconciler as any).buildChannelReaderDeployment(makeHost(), '')
    const ann = dep.spec?.template?.metadata?.annotations ?? {}
    expect(ann['clerum.io/credentials-revision']).toBeUndefined()
  })

  it('runs as non-root with read-only filesystem', () => {
    const { reconciler } = createReconciler()
    const dep = (reconciler as any).buildChannelReaderDeployment(makeHost(), '')
    const sc = dep.spec!.template!.spec!.containers[0].securityContext!
    expect(sc).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
    })
  })

  it('emits restricted-PSA-compliant container securityContext (drop ALL + seccompProfile)', () => {
    // MCC shared-tenant namespaces (channels-<slug>) are labeled
    // pod-security.kubernetes.io/enforce=restricted. capabilities.drop=[ALL]
    // and seccompProfile=RuntimeDefault are required alongside the existing
    // allowPrivilegeEscalation/runAsNonRoot fields.
    const { reconciler } = createReconciler()
    const dep = (reconciler as any).buildChannelReaderDeployment(makeHost(), '')
    const sc = dep.spec!.template!.spec!.containers[0].securityContext!
    expect(sc).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      capabilities: { drop: ['ALL'] },
      seccompProfile: { type: 'RuntimeDefault' },
    })
  })

  it('uses imagePullPolicy from config', () => {
    const { reconciler } = createReconciler()
    const dep = (reconciler as any).buildChannelReaderDeployment(makeHost(), '')
    expect(dep.spec!.template!.spec!.containers[0].imagePullPolicy).toBe('IfNotPresent')
  })

  it('keeps internal notification auth separate from mcp-host runtime access', () => {
    // Channel-reader keeps its internal notification token path separate and no
    // longer receives per-host JWT files for direct mcp-host runtime calls.
    const { reconciler } = createReconciler()
    const dep = (reconciler as any).buildChannelReaderDeployment(makeHost(), '')
    const envNames = (dep.spec?.template?.spec?.containers?.[0]?.env ?? []).map(
      (e: { name: string }) => e.name
    )
    expect(envNames).not.toContain('CLERUM_CHANNEL_READER_BOOTSTRAP_TOKEN')
    expect(envNames).not.toContain('CLERUM_CONTROL_API_URL')
    // No per-host JWT runtime/control token env. The routing URL
    // (CLERUM_MCP_HOST_URL) is allowed: it is a Service address, not auth.
    expect(
      envNames.filter(
        (name: string) => name.startsWith('CLERUM_MCP_HOST_') && name !== 'CLERUM_MCP_HOST_URL'
      )
    ).toEqual([])
  })

  it('sets replicas to 0 when countCommunicationChannels returns 0 (default)', () => {
    const { reconciler } = createReconciler()
    const dep = (reconciler as any).buildChannelReaderDeployment(makeHost(), '')
    expect(dep.spec.replicas).toBe(0)
  })

  it('sets replicas to 1 when countCommunicationChannels returns 1+', () => {
    const { reconciler } = createReconciler()
    reconciler.setCountCommunicationChannels(() => 1)
    const dep = (reconciler as any).buildChannelReaderDeployment(makeHost(), '')
    expect(dep.spec.replicas).toBe(1)
  })

  it('passes host.name to countCommunicationChannels (not a global sum)', () => {
    // Regression guard: if the count was accidentally summed across hosts,
    // alpha-host would see 5 instead of 3. The replica is still 1 either
    // way, but the per-host count must be passed through faithfully so
    // future metrics (clerum_channel_reader_replicas{host=}) remain
    // host-scoped.
    const { reconciler } = createReconciler()
    const captured: string[] = []
    reconciler.setCountCommunicationChannels(host => {
      captured.push(host)
      return host === 'alpha-host' ? 3 : 5
    })
    ;(reconciler as any).buildChannelReaderDeployment(makeHost(), '')
    expect(captured).toEqual(['alpha-host'])
  })
})

describe('reconcileChannelReaderDeployment', () => {
  it('creates Deployment when absent (createNamespacedDeployment succeeds)', async () => {
    const { reconciler, appsApi, coreApi } = createReconciler()
    appsApi.createNamespacedDeployment.mockResolvedValue({})
    coreApi.readNamespacedSecret.mockRejectedValue({ code: 404 })

    await (reconciler as any).reconcileChannelReaderDeployment(makeHost({ name: 'a' }))

    expect(appsApi.createNamespacedDeployment).toHaveBeenCalledWith({
      namespace: 'channels',
      body: expect.objectContaining({
        metadata: expect.objectContaining({ name: 'channel-reader-a', namespace: 'channels' }),
      }),
    })
  })

  it('replaces Deployment on 409 conflict (drift)', async () => {
    const { reconciler, appsApi, coreApi } = createReconciler()
    appsApi.createNamespacedDeployment.mockRejectedValue({ code: 409 })
    appsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { name: 'channel-reader-a', namespace: 'channels', resourceVersion: '42' },
    })
    appsApi.replaceNamespacedDeployment.mockResolvedValue({})
    coreApi.readNamespacedSecret.mockRejectedValue({ code: 404 })

    await (reconciler as any).reconcileChannelReaderDeployment(makeHost({ name: 'a' }))

    expect(appsApi.replaceNamespacedDeployment).toHaveBeenCalledWith({
      name: 'channel-reader-a',
      namespace: 'channels',
      body: expect.objectContaining({
        metadata: expect.objectContaining({ name: 'channel-reader-a', resourceVersion: '42' }),
      }),
    })
  })

  it('reads existing Secret revision and writes annotation on initial create', async () => {
    const { reconciler, appsApi, coreApi } = createReconciler()
    appsApi.createNamespacedDeployment.mockResolvedValue({})
    coreApi.readNamespacedSecret.mockResolvedValue({
      data: { 'telegram-bot-token': Buffer.from('tok-1').toString('base64') },
    })
    // Seed the CC cache so computeChannelReaderRevisionForHost finds a Secret ref
    reconciler.setFindCommunicationChannelsByHostRef(() => [
      {
        name: 'cc-a',
        namespace: 'channels',
        spec: { hostRef: 'a', credentialsSecretRef: { name: 'channel-reader-a-credentials' } },
      },
    ])

    await (reconciler as any).reconcileChannelReaderDeployment(makeHost({ name: 'a' }))

    const call = appsApi.createNamespacedDeployment.mock.calls[0][0]
    const ann = call.body.spec.template.metadata.annotations
    expect(ann['clerum.io/credentials-revision']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('skips reconcile if existing Deployment is owned by a different host', async () => {
    const { reconciler, appsApi, coreApi } = createReconciler()
    appsApi.createNamespacedDeployment.mockRejectedValue({ code: 409 })
    appsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: {
        name: 'channel-reader-a',
        namespace: 'channels',
        labels: { 'clerum.io/host': 'OTHER-HOST' },
      },
    })
    coreApi.readNamespacedSecret.mockRejectedValue({ code: 404 })

    await (reconciler as any).reconcileChannelReaderDeployment(makeHost({ name: 'a' }))

    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('returns gracefully when read-after-409 races with deletion (404)', async () => {
    const { reconciler, appsApi, coreApi } = createReconciler()
    appsApi.createNamespacedDeployment.mockRejectedValue({ code: 409 })
    appsApi.readNamespacedDeployment.mockRejectedValue({ code: 404 })
    coreApi.readNamespacedSecret.mockRejectedValue({ code: 404 })
    await expect(
      (reconciler as any).reconcileChannelReaderDeployment(makeHost({ name: 'a' }))
    ).resolves.toBeUndefined()
    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
  })
})

describe('reconcile / reconcileDelete with channel-reader', () => {
  it('reconcile(host) calls reconcileChannelReaderDeployment', async () => {
    const { reconciler } = createReconciler()
    const spy = vi
      .spyOn(reconciler as any, 'reconcileChannelReaderDeployment')
      .mockResolvedValue(undefined)
    await reconciler.reconcile(makeHost({ name: 'a' }))
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ name: 'a' }))
  })

  it('reconcileDelete(name, ns) deletes channel-reader-<name> Deployment in channels ns', async () => {
    const { reconciler, appsApi } = createReconciler()
    appsApi.deleteNamespacedDeployment.mockResolvedValue({})
    await reconciler.reconcileDelete('a', 'mcp-host')
    expect(appsApi.deleteNamespacedDeployment.mock.calls).toContainEqual([
      { name: 'channel-reader-a', namespace: 'channels' },
    ])
  })

  it('reconcileDelete tolerates 404 on missing channel-reader Deployment', async () => {
    const { reconciler, appsApi } = createReconciler()
    appsApi.deleteNamespacedDeployment.mockRejectedValue({ code: 404 })
    await expect(reconciler.reconcileDelete('a', 'mcp-host')).resolves.toBeUndefined()
  })

  it('records channel-reader failure in status.message while preserving deployed/ready', async () => {
    const { reconciler } = createReconciler()
    vi.spyOn(reconciler as any, 'reconcileChannelReaderDeployment').mockRejectedValue(
      new Error('boom')
    )
    await reconciler.reconcile(makeHost({ name: 'a' }))
    expect(reconciler.getStatus('a')).toMatchObject({
      deployed: true,
      ready: true,
      message: expect.stringContaining('channel-reader: boom'),
    })
  })
})

describe('orphan sweep on fullReconcile (channel-reader)', () => {
  it('deletes channel-reader Deployments without a matching Host', async () => {
    const { reconciler, appsApi } = createReconciler()
    // listNamespacedDeployment is called twice during fullReconcile:
    //   1) mcp-host ns (with labelSelector) for the existing host orphan sweep
    //   2) channels ns (no labelSelector) for the channel-reader sweep
    // Mock based on namespace so we don't pollute the host-side sweep.
    appsApi.listNamespacedDeployment.mockImplementation(({ namespace }: { namespace: string }) => {
      if (namespace === 'channels') {
        return Promise.resolve({
          items: [
            {
              metadata: {
                name: 'channel-reader-a',
                namespace: 'channels',
                labels: {
                  app: 'channel-reader',
                  'clerum.io/host': 'a',
                  'clerum.io/managed-by': 'host-context-controller',
                },
              },
            },
            {
              metadata: {
                name: 'channel-reader-orphan',
                namespace: 'channels',
                labels: {
                  app: 'channel-reader',
                  'clerum.io/host': 'orphan',
                  'clerum.io/managed-by': 'host-context-controller',
                },
              },
            },
            { metadata: { name: 'unrelated-thing', namespace: 'channels', labels: {} } },
          ],
        })
      }
      return Promise.resolve({ items: [] })
    })
    appsApi.deleteNamespacedDeployment.mockResolvedValue({})

    await reconciler.fullReconcile([makeHost({ name: 'a' })])

    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
      name: 'channel-reader-orphan',
      namespace: 'channels',
    })
    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalledWith({
      name: 'channel-reader-a',
      namespace: 'channels',
    })
    expect(appsApi.deleteNamespacedDeployment).not.toHaveBeenCalledWith({
      name: 'unrelated-thing',
      namespace: 'channels',
    })
  })

  it('deletes channel-reader Secrets without a matching Host', async () => {
    const { reconciler, coreApi } = createReconciler()
    coreApi.listNamespacedSecret.mockResolvedValue({
      items: [
        {
          metadata: {
            name: 'channel-reader-a-credentials',
            namespace: 'channels',
            labels: {
              'clerum.io/component': 'channel-reader',
              'clerum.io/host': 'a',
              'clerum.io/managed-by': 'host-context-controller',
            },
          },
        },
        {
          metadata: {
            name: 'channel-reader-orphan-credentials',
            namespace: 'channels',
            labels: {
              'clerum.io/component': 'channel-reader',
              'clerum.io/host': 'orphan',
              'clerum.io/managed-by': 'host-context-controller',
            },
          },
        },
      ],
    })
    coreApi.deleteNamespacedSecret.mockResolvedValue({})

    await reconciler.fullReconcile([makeHost({ name: 'a' })])

    expect(coreApi.deleteNamespacedSecret).toHaveBeenCalledWith({
      name: 'channel-reader-orphan-credentials',
      namespace: 'channels',
    })
    expect(coreApi.deleteNamespacedSecret).not.toHaveBeenCalledWith({
      name: 'channel-reader-a-credentials',
      namespace: 'channels',
    })
  })

  it('does NOT delete Secrets missing the clerum.io/managed-by label', async () => {
    const { reconciler, coreApi } = createReconciler()
    coreApi.listNamespacedSecret.mockResolvedValue({
      items: [
        {
          metadata: {
            name: 'hand-rolled-channel-secret',
            namespace: 'channels',
            labels: {
              'clerum.io/component': 'channel-reader',
              'clerum.io/host': 'unknown-host',
              // intentionally NO managed-by
            },
          },
        },
      ],
    })
    coreApi.deleteNamespacedSecret.mockResolvedValue({})
    await reconciler.fullReconcile([])
    expect(coreApi.deleteNamespacedSecret).not.toHaveBeenCalledWith({
      name: 'hand-rolled-channel-secret',
      namespace: 'channels',
    })
  })
})

describe('sweepLegacyStaticChannelReader', () => {
  // Issue #273: HCC startup sweep that retires the static
  // `clerum-channel-reader` Deployment so per-Host pods don't collide
  // with it on Telegram getUpdates long-poll (409 Conflict).
  // Empirical reproduction in #273 comment.

  it('deletes the static clerum-channel-reader Deployment when it exists', async () => {
    const { reconciler, appsApi } = createReconciler()
    appsApi.deleteNamespacedDeployment.mockResolvedValue({})

    await reconciler.sweepLegacyStaticChannelReader()

    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledTimes(1)
    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
      name: 'clerum-channel-reader',
      namespace: 'channels',
    })
  })

  it('swallows 404 (already gone — steady state)', async () => {
    const { reconciler, appsApi } = createReconciler()
    appsApi.deleteNamespacedDeployment.mockRejectedValue(
      Object.assign(new Error('not found'), { code: 404 })
    )

    // Must not throw — 404 is the steady-state after the legacy retirement.
    await expect(reconciler.sweepLegacyStaticChannelReader()).resolves.toBeUndefined()
    expect(appsApi.deleteNamespacedDeployment).toHaveBeenCalledTimes(1)
  })

  it('logs but does not throw on non-404 errors (e.g. 403 RBAC)', async () => {
    const { reconciler, appsApi } = createReconciler()
    appsApi.deleteNamespacedDeployment.mockRejectedValue(
      Object.assign(new Error('forbidden'), { code: 403 })
    )
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Reviewer-style assertion: startup MUST continue even if the sweep
    // fails — per-Host reconciles are still required.
    await expect(reconciler.sweepLegacyStaticChannelReader()).resolves.toBeUndefined()
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('legacy-sweep failed'),
      expect.anything()
    )

    consoleErrorSpy.mockRestore()
  })

  it('targets the channels namespace (not mcp-host) and the exact name', async () => {
    // Regression guard: if someone refactors namespace config, the sweep
    // must not accidentally target a Deployment named `clerum-channel-reader`
    // in a different namespace.
    const { reconciler, appsApi } = createReconciler()
    appsApi.deleteNamespacedDeployment.mockResolvedValue({})

    await reconciler.sweepLegacyStaticChannelReader()

    const call = appsApi.deleteNamespacedDeployment.mock.calls[0][0] as {
      name: string
      namespace: string
    }
    expect(call.name).toBe('clerum-channel-reader')
    expect(call.namespace).toBe('channels')
  })
})

describe('setCountCommunicationChannels', () => {
  it('defaults to a function returning 0 when not set', () => {
    const { reconciler } = createReconciler()
    expect((reconciler as any).countCommunicationChannels('any-host')).toBe(0)
  })

  it('uses the injected callback to count CCs for a host', () => {
    const { reconciler } = createReconciler()
    const counts = new Map([
      ['alpha-host', 3],
      ['beta-host', 0],
    ])
    reconciler.setCountCommunicationChannels(host => counts.get(host) ?? 0)
    expect((reconciler as any).countCommunicationChannels('alpha-host')).toBe(3)
    expect((reconciler as any).countCommunicationChannels('beta-host')).toBe(0)
    expect((reconciler as any).countCommunicationChannels('unknown-host')).toBe(0)
  })
})

describe('resolveWorkflowControlScopes (F25)', () => {
  const DEFAULT = [
    'workflow:list',
    'workflow:read',
    'workflow:trigger',
    'workflow:approval:resolve',
    'workflow:approval:decide',
  ]

  it('exports the canonical first-party default scope set', () => {
    expect(DEFAULT_FIRST_PARTY_WORKFLOW_CONTROL_SCOPES).toEqual(DEFAULT)
  })

  it('defaults to the first-party scope set when workflowControl is absent (the Control-UI Host gap)', () => {
    // A Host created without the block (e.g. via the Control UI) must still get
    // workflow:approval:resolve, else mcp-host fail-closes Telegram/Slack access.
    expect(resolveWorkflowControlScopes(undefined)).toEqual(DEFAULT)
  })

  it('defaults when the block is present but scopes is omitted', () => {
    expect(resolveWorkflowControlScopes({})).toEqual(DEFAULT)
  })

  it('honors an explicit empty scopes list as an intentional opt-out (does NOT default)', () => {
    expect(resolveWorkflowControlScopes({ scopes: [] })).toEqual([])
  })

  it('honors an explicit scopes list exactly as declared', () => {
    expect(resolveWorkflowControlScopes({ scopes: ['workflow:list', 'workflow:read'] })).toEqual([
      'workflow:list',
      'workflow:read',
    ])
  })

  it('returns a fresh array (callers may sort/mutate without corrupting the default)', () => {
    const a = resolveWorkflowControlScopes(undefined)
    a.sort()
    expect(DEFAULT_FIRST_PARTY_WORKFLOW_CONTROL_SCOPES).toEqual(DEFAULT)
  })
})

// ── B2: CC cache-sync gate on replica decision ─────────────────────────────
describe('buildChannelReaderDeployment — B2 CC cache-sync gate', () => {
  it('sets replicas to 1 when cache is synced and CC count is 1', () => {
    // When the CC cache has completed its initial list and the host has 1+ CCs,
    // the Deployment should be created with replicas=1.
    const { reconciler } = createReconciler()
    reconciler.setCountCommunicationChannels(() => 1)
    reconciler.setIsCommunicationChannelCacheSynced(() => true)
    const dep = (reconciler as any).buildChannelReaderDeployment(makeHost(), '', undefined)
    expect(dep.spec.replicas).toBe(1)
  })

  it('preserves replicas=1 when cache is NOT synced and an existing Deployment has replicas=1', () => {
    // When the CC cache is still empty (startup / load failure) AND we know the
    // existing Deployment had replicas=1, we MUST NOT scale to 0 — the channel-reader
    // is live and scaling it down would drop inbound messages.
    const { reconciler } = createReconciler()
    // ccCacheSyncedFn returns false (unsynced)
    reconciler.setIsCommunicationChannelCacheSynced(() => false)
    // countCommunicationChannels returns 0 (cache empty)
    reconciler.setCountCommunicationChannels(() => 0)
    const dep = (reconciler as any).buildChannelReaderDeployment(makeHost(), '', 1)
    expect(dep.spec.replicas).toBe(1)
  })
})

describe('reconcileChannelReaderDeployment — B2: preserve replicas on unsynced cache (409 path)', () => {
  it('keeps replicas=1 on the replace body when cache is unsynced and existing Deployment has replicas=1', async () => {
    // Scenario: HCC restarts mid-flight. CC cache is still loading (unsynced).
    // The existing live Deployment has replicas=1 (channel-reader is running).
    // reconcileChannelReaderDeployment must NOT scale it to 0.
    const { reconciler, appsApi, coreApi } = createReconciler()

    // Force the 409 → read-existing → replace path
    appsApi.createNamespacedDeployment.mockRejectedValue({ code: 409 })
    appsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: {
        name: 'channel-reader-a',
        namespace: 'channels',
        resourceVersion: '77',
        labels: { 'clerum.io/host': 'a' },
      },
      spec: { replicas: 1 },
    })
    appsApi.replaceNamespacedDeployment.mockResolvedValue({})
    coreApi.readNamespacedSecret.mockRejectedValue({ code: 404 })

    // CC cache is unsynced; count returns 0
    reconciler.setIsCommunicationChannelCacheSynced(() => false)
    reconciler.setCountCommunicationChannels(() => 0)

    await (reconciler as any).reconcileChannelReaderDeployment(makeHost({ name: 'a' }))

    // The replace call body must carry replicas=1, not 0
    expect(appsApi.replaceNamespacedDeployment).toHaveBeenCalledOnce()
    const replaceBody = appsApi.replaceNamespacedDeployment.mock.calls[0][0]
      .body as k8s.V1Deployment
    expect(replaceBody.spec?.replicas).toBe(1)
  })
})
