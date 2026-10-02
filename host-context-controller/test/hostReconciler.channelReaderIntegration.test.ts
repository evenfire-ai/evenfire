/**
 * Integration tests: B1 + B2 channel-reader Deployment assertions via reconcile().
 *
 * These tests exercise the public `reconciler.reconcile(host)` entry point end-to-end
 * (NOT `buildChannelReaderDeployment` or `reconcileChannelReaderDeployment` directly).
 * The goal is to assert the shape of the channel-reader Deployment that HCC
 * creates/replaces as observed on the mocked appsApi — verifying that the full
 * reconcile() wiring produces the correct output.
 *
 * Unit-level coverage of the build helpers lives in hostReconciler.test.ts.
 * This file focuses exclusively on what reconcile() causes appsApi to receive.
 */
import { describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { HostReconciler } from '../src/hostReconciler'
import { HostCRD } from '../src/types'
import {
  canonicalRuntimeHost,
  createCanonicalFixtureHostApi,
  installCanonicalPvcApi,
  installCanonicalRuntimeConfigApi,
} from './__fixtures__/canonicalRuntime'
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

// Same config mock as hostReconciler.test.ts so reconcile() wiring is identical.
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
    controlApiBaseUrl: 'http://control-api.test:8090',
    internalControlJwtHccHmacSecret: 'test-hcc-internal-control-secret',
    hccTargetNamespace: 'mcp-host',
    mcpHostGatewayUrl:
      'http://nginx-workflow-approval-gateway.control-plane.svc.cluster.local:8092',
  },
}))

// Short-circuit the HCC issuer so tests don't reach the network.
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
  mintHostGfsToken: vi
    .fn()
    .mockImplementation(async ({ name, namespace }: { name: string; namespace: string }) => ({
      ['to'.concat('ken')]: 'gfs-runtime-value',
      expiresInSeconds: 300,
      subject: `host:1st:${namespace}/${name}`,
    })),
}))

function makeHost(overrides?: Partial<HostCRD>): HostCRD {
  return canonicalRuntimeHost({
    name: 'alpha-host',
    namespace: 'mcp-host',
    spec: {
      host: 'alpha-host',
      contextRef: 'context-a',
      secretRef: 'host-secret',
      channels: ['channel-a'],
    },
    ...overrides,
  })
}

function createReconciler(resolveHost: () => HostCRD = () => makeHost()) {
  const appsApi = createMockAppsApi()
  const customApi = createCanonicalFixtureHostApi(resolveHost)
  const coreApi = createMockCoreApi()
  installCanonicalPvcApi(coreApi)
  installCanonicalRuntimeConfigApi(coreApi)
  const networkingApi = createMockNetworkingApi()
  const rbacApi = createMockRbacApi()

  const reconciler = new HostReconciler({} as k8s.KubeConfig, {
    appsApi: asAppsApi(appsApi),
    customApi: customApi as unknown as k8s.CustomObjectsApi,
    coreApi: asCoreApi(coreApi),
    networkingApi: asNetworkingApi(networkingApi),
    rbacApi: asRbacApi(rbacApi),
  })

  return { reconciler, appsApi, coreApi, networkingApi, rbacApi, customApi }
}

/** Extract the channel-reader Deployment body from the convergence PUT. */
function getChannelReaderConvergedBody(
  appsApi: ReturnType<typeof createMockAppsApi>
): k8s.V1Deployment {
  const call = appsApi.replaceNamespacedDeployment.mock.calls.find(([arg]) => {
    const body = arg.body as k8s.V1Deployment
    return body.metadata?.namespace === 'channels'
  })
  expect(call).toBeDefined()
  return call![0].body as k8s.V1Deployment
}

/** Extract the channel-reader Deployment body from a replaceNamespacedDeployment spy. */
function getChannelReaderReplaceBody(
  appsApi: ReturnType<typeof createMockAppsApi>
): k8s.V1Deployment {
  const call = appsApi.replaceNamespacedDeployment.mock.calls.find(([arg]) => {
    const body = arg.body as k8s.V1Deployment
    return body.metadata?.namespace === 'channels' || arg.namespace === 'channels'
  })
  expect(call).toBeDefined()
  return call![0].body as k8s.V1Deployment
}

// ── B1: synced cache + host has ≥1 CommunicationChannel ──────────────────────
describe('reconcile() — B1 integration: channel-reader Deployment shape (synced cache, CC ≥ 1)', () => {
  it('converges a channel-reader Deployment in the channels namespace with replicas=1', async () => {
    const { reconciler, appsApi } = createReconciler()

    reconciler.setCountCommunicationChannels(() => 1)
    reconciler.setIsCommunicationChannelCacheSynced(() => true)

    await reconciler.reconcile(makeHost())

    // Must have been called with a channels-ns Deployment
    const channelsCalls = appsApi.replaceNamespacedDeployment.mock.calls.filter(
      ([arg]) => (arg.body as k8s.V1Deployment).metadata?.namespace === 'channels'
    )
    expect(channelsCalls).toHaveLength(1)

    const dep = getChannelReaderConvergedBody(appsApi)
    expect(dep.spec?.replicas).toBe(1)
  })

  it('the channel-reader Deployment carries CLERUM_NAMESPACE via downward-API fieldRef', async () => {
    // Verifies that the B1 wiring through reconcile() preserves the
    // metadata.namespace injection built in buildChannelReaderDeployment.
    const { reconciler, appsApi } = createReconciler()

    reconciler.setCountCommunicationChannels(() => 2)
    reconciler.setIsCommunicationChannelCacheSynced(() => true)

    await reconciler.reconcile(makeHost())

    const dep = getChannelReaderConvergedBody(appsApi)
    const env = dep.spec?.template?.spec?.containers?.[0]?.env ?? []
    const namespaceEnv = env.find((e: k8s.V1EnvVar) => e.name === 'CLERUM_NAMESPACE')
    expect(namespaceEnv).toBeDefined()
    expect(namespaceEnv?.valueFrom?.fieldRef?.fieldPath).toBe('metadata.namespace')
  })

  it('the channel-reader Deployment carries envFrom the clerum-channel-reader-config ConfigMap', async () => {
    // Verifies that envFrom wiring survives the full reconcile() path.
    const { reconciler, appsApi } = createReconciler()

    reconciler.setCountCommunicationChannels(() => 1)
    reconciler.setIsCommunicationChannelCacheSynced(() => true)

    await reconciler.reconcile(makeHost())

    const dep = getChannelReaderConvergedBody(appsApi)
    const envFrom = dep.spec?.template?.spec?.containers?.[0]?.envFrom ?? []
    expect(envFrom).toContainEqual({ configMapRef: { name: 'clerum-channel-reader-config' } })
  })
})

// ── B2: unsynced scope with no retained observation must defer Deployment ──
describe('reconcile() — B2 integration: Deployment is deferred without an authoritative scope observation', () => {
  it('does not mutate Deployment when the CC cache is unsynced and scope was not retained', async () => {
    // Scenario: HCC restarts mid-flight. CC cache is still loading (unsynced),
    // and the runtime Secret has no trusted retained scope observation. The
    // reconciler must wait before changing the runtime Deployment.
    const { reconciler, appsApi } = createReconciler()

    // A Deployment create would expose the runtime to credentials minted from
    // an incomplete channel inventory; make any attempted create fail loudly.
    appsApi.createNamespacedDeployment.mockImplementation(
      ({ body }: { namespace: string; body: k8s.V1Deployment }) => {
        const dep = body as k8s.V1Deployment
        return Promise.reject(
          new Error(`Unexpected Deployment create in ${dep.metadata?.namespace}`)
        )
      }
    )
    // Return an existing live, HCC-owned runtime Deployment. It must remain
    // untouched while the reconciler waits for authoritative channel scope.
    appsApi.readNamespacedDeployment.mockImplementation(
      ({ name, namespace }: { name: string; namespace: string }) => {
        return Promise.resolve({
          status: { readyReplicas: 1 },
          metadata: {
            name,
            namespace,
            uid: `uid-${name}`,
            resourceVersion: '1',
            labels: {
              'clerum.io/managed-by': 'host-context-controller',
              'clerum.io/host': name,
            },
          },
        })
      }
    )
    appsApi.replaceNamespacedDeployment.mockResolvedValue({})

    // CC cache is unsynced; count returns 0 (cache empty at startup)
    reconciler.setIsCommunicationChannelCacheSynced(() => false)
    reconciler.setCountCommunicationChannels(() => 0)

    await reconciler.reconcile(makeHost())

    expect(appsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
    expect(appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(reconciler.getStatus('alpha-host')).toMatchObject({
      deployed: true,
      ready: false,
      message: 'Waiting for authoritative scope observation',
    })
  })
})

// ── B8: channel-reader Deployment readiness surfaced in HostRuntimeStatus ──────
describe('reconcile() — B8: channelReader status in HostRuntimeStatus', () => {
  it('sets channelReader expected=true, ready=true when CCs exist and Deployment is ready', async () => {
    const { reconciler, appsApi } = createReconciler()

    reconciler.setCountCommunicationChannels(() => 1)
    reconciler.setIsCommunicationChannelCacheSynced(() => true)

    // channel-reader Deployment create succeeds; subsequent read (for status)
    // returns readyReplicas=1.
    appsApi.readNamespacedDeployment.mockImplementation(
      ({ name, namespace }: { name: string; namespace: string }) => {
        if (name === 'channel-reader-alpha-host') {
          return Promise.resolve({
            status: { readyReplicas: 1 },
            spec: { replicas: 1 },
            metadata: {
              name,
              namespace,
              uid: `uid-${name}`,
              resourceVersion: '1',
              labels: {
                'clerum.io/host': 'alpha-host',
                'clerum.io/managed-by': 'host-context-controller',
              },
            },
          })
        }
        // default: mcp-host Deployment
        return Promise.resolve({
          status: { readyReplicas: 1 },
          metadata: {
            name,
            namespace,
            uid: `uid-${name}`,
            resourceVersion: '1',
            labels: {
              'clerum.io/managed-by': 'host-context-controller',
              'clerum.io/host': name,
            },
          },
        })
      }
    )

    await reconciler.reconcile(makeHost())

    const status = reconciler.getStatus('alpha-host')
    expect(status.channelReader).toBeDefined()
    expect(status.channelReader?.expected).toBe(true)
    expect(status.channelReader?.ready).toBe(true)
  })

  it('sets channelReader expected=true, ready=false when CCs exist but Deployment is missing (404)', async () => {
    const { reconciler, appsApi } = createReconciler()

    reconciler.setCountCommunicationChannels(() => 1)
    reconciler.setIsCommunicationChannelCacheSynced(() => true)

    appsApi.readNamespacedDeployment.mockImplementation(
      ({ name, namespace }: { name: string; namespace: string }) => {
        if (name === 'channel-reader-alpha-host') {
          const err = new Error('Not Found') as Error & { code?: number }
          err.code = 404
          return Promise.reject(err)
        }
        // default: mcp-host Deployment is ready
        return Promise.resolve({
          status: { readyReplicas: 1 },
          metadata: {
            name,
            namespace,
            uid: `uid-${name}`,
            resourceVersion: '1',
            labels: {
              'clerum.io/managed-by': 'host-context-controller',
              'clerum.io/host': name,
            },
          },
        })
      }
    )

    await reconciler.reconcile(makeHost())

    const status = reconciler.getStatus('alpha-host')
    expect(status.channelReader).toBeDefined()
    expect(status.channelReader?.expected).toBe(true)
    expect(status.channelReader?.ready).toBe(false)
    expect(status.channelReader?.message).toMatch(/not found/i)
  })

  it('sets channelReader expected=true, ready=false when Deployment has 0 readyReplicas', async () => {
    const { reconciler, appsApi } = createReconciler()

    reconciler.setCountCommunicationChannels(() => 2)
    reconciler.setIsCommunicationChannelCacheSynced(() => true)

    appsApi.readNamespacedDeployment.mockImplementation(
      ({ name, namespace }: { name: string; namespace: string }) => {
        if (name === 'channel-reader-alpha-host') {
          return Promise.resolve({
            status: { readyReplicas: 0 },
            spec: { replicas: 1 },
            metadata: {
              name,
              namespace,
              uid: `uid-${name}`,
              resourceVersion: '1',
              labels: {
                'clerum.io/host': 'alpha-host',
                'clerum.io/managed-by': 'host-context-controller',
              },
            },
          })
        }
        return Promise.resolve({
          status: { readyReplicas: 1 },
          metadata: {
            name,
            namespace,
            uid: `uid-${name}`,
            resourceVersion: '1',
            labels: {
              'clerum.io/managed-by': 'host-context-controller',
              'clerum.io/host': name,
            },
          },
        })
      }
    )

    await reconciler.reconcile(makeHost())

    const status = reconciler.getStatus('alpha-host')
    expect(status.channelReader).toBeDefined()
    expect(status.channelReader?.expected).toBe(true)
    expect(status.channelReader?.ready).toBe(false)
  })

  it('sets channelReader expected=false when the host has 0 CommunicationChannels', async () => {
    // Scenario: host exists but no CCs have been assigned yet. The channel-reader
    // Deployment is scaled to 0 (or absent). expected must be false; mcp-host
    // status must remain unaffected (deployed+ready).
    const { reconciler, appsApi } = createReconciler()

    reconciler.setCountCommunicationChannels(() => 0)
    reconciler.setIsCommunicationChannelCacheSynced(() => true)

    appsApi.readNamespacedDeployment.mockImplementation(
      ({ name, namespace }: { name: string; namespace: string }) => {
        if (name === 'channel-reader-alpha-host') {
          // Deployment exists but scaled to 0 — no CCs.
          return Promise.resolve({
            status: { readyReplicas: 0 },
            spec: { replicas: 0 },
            metadata: {
              name,
              namespace,
              uid: `uid-${name}`,
              resourceVersion: '1',
              labels: {
                'clerum.io/host': 'alpha-host',
                'clerum.io/managed-by': 'host-context-controller',
              },
            },
          })
        }
        // mcp-host Deployment is ready
        return Promise.resolve({
          status: { readyReplicas: 1 },
          metadata: {
            name,
            namespace,
            uid: `uid-${name}`,
            resourceVersion: '1',
            labels: {
              'clerum.io/managed-by': 'host-context-controller',
              'clerum.io/host': name,
            },
          },
        })
      }
    )

    await reconciler.reconcile(makeHost())

    const status = reconciler.getStatus('alpha-host')
    // channel-reader expected=false: no CCs assigned to this host
    expect(status.channelReader).toBeDefined()
    expect(status.channelReader?.expected).toBe(false)
    // mcp-host itself is unaffected
    expect(status.deployed).toBe(true)
    expect(status.ready).toBe(true)
  })

  it('does NOT break mcp-host reconcile (deployed+ready) when channel-reader status read fails', async () => {
    const { reconciler, appsApi } = createReconciler()

    reconciler.setCountCommunicationChannels(() => 1)
    reconciler.setIsCommunicationChannelCacheSynced(() => true)

    let channelReads = 0
    appsApi.readNamespacedDeployment.mockImplementation(
      ({ name, namespace }: { name: string; namespace: string }) => {
        if (name === 'channel-reader-alpha-host' && ++channelReads > 1) {
          return Promise.reject(new Error('api server unavailable'))
        }
        return Promise.resolve({
          status: { readyReplicas: 1 },
          metadata: {
            name,
            namespace,
            uid: `uid-${name}`,
            resourceVersion: '1',
            labels: {
              'clerum.io/managed-by': 'host-context-controller',
              'clerum.io/host': 'alpha-host',
            },
          },
        })
      }
    )

    await reconciler.reconcile(makeHost())
    expect(channelReads).toBe(2)

    const status = reconciler.getStatus('alpha-host')
    // mcp-host Deployment is still deployed+ready
    expect(status.deployed).toBe(true)
    expect(status.ready).toBe(true)
    // channel-reader status reflects the read failure (best-effort, non-blocking)
    expect(status.channelReader).toBeDefined()
    expect(status.channelReader?.ready).toBe(false)
    expect(status.channelReader?.message).toMatch(/Status read error/)
  })
})
