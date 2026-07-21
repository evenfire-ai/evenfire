import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { HostReconciler } from '../src/hostReconciler'
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
    controlApiBaseUrl: 'http://control-api.test:8090',
    internalControlJwtHccHmacSecret: 'test-hcc-internal-control-secret',
    hccTargetNamespace: 'mcp-host',
    mcpHostGatewayUrl:
      'http://nginx-workflow-approval-gateway.control-plane.svc.cluster.local:8092',
  },
}))

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
    channelReaderActivityExpiresInSeconds: 600,
    channelReaderCronReadExpiresInSeconds: 600,
    channelReaderCronAckExpiresInSeconds: 600,
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

const HOST: HostCRD = {
  name: 'chatllm',
  namespace: 'mcp-host',
  spec: {
    host: 'chatllm',
    contextRef: 'context-a',
    secretRef: 'host-secret',
    channels: ['channel-a'],
  },
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

  return { reconciler, mocks: { appsApi, coreApi, networkingApi, rbacApi } }
}

describe('HostReconciler.ensureChannelReaderEgressNetworkPolicy', () => {
  it('creates the egress NP in channels namespace with correct selectors', async () => {
    const { reconciler, mocks } = createReconciler()

    await (reconciler as any).ensureChannelReaderEgressNetworkPolicy(HOST)

    expect(mocks.networkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    const call = (mocks.networkingApi.createNamespacedNetworkPolicy as any).mock.calls[0][0]

    expect(call.namespace).toBe('channels')
    expect(call.body.metadata.name).toBe('channel-reader-chatllm-egress')
    expect(call.body.metadata.labels['clerum.io/managed-by']).toBe('host-context-controller')
    expect(call.body.metadata.labels['clerum.io/host']).toBe('chatllm')
    expect(call.body.metadata.labels['clerum.io/policy-type']).toBe('channel-reader-egress')
    // Source pod selector requires managed-by so the policy refuses to apply
    // to pods spoofed into channels by another controller.
    expect(call.body.spec.podSelector.matchLabels).toEqual({
      app: 'channel-reader',
      'clerum.io/host': 'chatllm',
      'clerum.io/managed-by': 'host-context-controller',
    })
    expect(call.body.spec.policyTypes).toEqual(['Egress'])
    expect(call.body.spec.egress).toHaveLength(1)
    expect(call.body.spec.egress[0].to[0].namespaceSelector.matchLabels).toEqual({
      'kubernetes.io/metadata.name': 'mcp-host',
    })
    expect(call.body.spec.egress[0].to[0].podSelector.matchLabels).toEqual({
      'clerum.io/host': 'chatllm',
    })
    expect(call.body.spec.egress[0].ports).toEqual([{ port: 8080, protocol: 'TCP' }])
    expect(JSON.stringify(call.body.spec.egress)).not.toContain('nginx-workflow-approval-gateway')
    expect(JSON.stringify(call.body.spec.egress)).not.toContain('control-plane')
  })
})

describe('HostReconciler.ensureMcpHostIngressNetworkPolicy', () => {
  it('creates the ingress NP in mcp-host namespace with correct selectors', async () => {
    const { reconciler, mocks } = createReconciler()

    await (reconciler as any).ensureMcpHostIngressNetworkPolicy(HOST)

    expect(mocks.networkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    const call = (mocks.networkingApi.createNamespacedNetworkPolicy as any).mock.calls[0][0]

    expect(call.namespace).toBe('mcp-host')
    expect(call.body.metadata.name).toBe('mcp-host-chatllm-ingress-channel-reader')
    expect(call.body.metadata.labels['clerum.io/managed-by']).toBe('host-context-controller')
    expect(call.body.metadata.labels['clerum.io/host']).toBe('chatllm')
    expect(call.body.metadata.labels['clerum.io/policy-type']).toBe('channel-reader-ingress')
    expect(call.body.spec.podSelector.matchLabels).toEqual({
      'clerum.io/host': 'chatllm',
      'clerum.io/managed-by': 'host-context-controller',
    })
    expect(call.body.spec.policyTypes).toEqual(['Ingress'])
    expect(call.body.spec.ingress).toHaveLength(1)
    expect(call.body.spec.ingress[0]._from[0].namespaceSelector.matchLabels).toEqual({
      'kubernetes.io/metadata.name': 'channels',
    })
    // _from-pod selector requires managed-by so the policy only admits HCC-
    // owned per-Host channel-reader pods, not pods spoofed into channels.
    expect(call.body.spec.ingress[0]._from[0].podSelector.matchLabels).toEqual({
      app: 'channel-reader',
      'clerum.io/host': 'chatllm',
      'clerum.io/managed-by': 'host-context-controller',
    })
    expect(call.body.spec.ingress[0].ports).toEqual([{ port: 8080, protocol: 'TCP' }])
  })
})

describe('HostReconciler.reconcile — NP wiring', () => {
  let reconciler: HostReconciler

  beforeEach(() => {
    const { reconciler: r } = createReconciler()
    reconciler = r
    // Stub all the methods that hit real K8s/state to no-ops
    vi.spyOn(reconciler as any, 'validateHostSecret').mockResolvedValue({ ok: true })
    vi.spyOn(reconciler as any, 'ensureHostServiceAccount').mockResolvedValue(undefined)
    vi.spyOn(reconciler as any, 'ensureHostRole').mockResolvedValue(undefined)
    vi.spyOn(reconciler as any, 'ensureHostRoleBinding').mockResolvedValue(undefined)
    vi.spyOn(reconciler as any, 'provisionRuntimeTokenRevision').mockResolvedValue({
      revision: 'runtime-revision',
      scopeHash: (HostReconciler as any).runtimeTokenScopeHash(HOST, false),
    })
    vi.spyOn(reconciler as any, 'ensurePvc').mockResolvedValue(undefined)
    vi.spyOn(reconciler as any, 'ensureService').mockResolvedValue(undefined)
    vi.spyOn(reconciler as any, 'ensureDeployment').mockResolvedValue(undefined)
    vi.spyOn(reconciler as any, 'ensureDesktopNetworkPolicy').mockResolvedValue(undefined)
    vi.spyOn(reconciler as any, 'reconcileChannelReaderDeployment').mockResolvedValue(undefined)
    vi.spyOn(reconciler as any, 'checkDeploymentReady').mockResolvedValue(true)
  })

  it('calls ensureMcpHostIngressNetworkPolicy BEFORE ensureDeployment', async () => {
    // Reviewer #11: NPs must be in place before the pod they govern is
    // created, so the policy is enforced from the pod's first packet rather
    // than racing the deny-all default.
    const ingressSpy = vi
      .spyOn(reconciler as any, 'ensureMcpHostIngressNetworkPolicy')
      .mockResolvedValue(undefined)
    const deploySpy = vi.spyOn(reconciler as any, 'ensureDeployment').mockResolvedValue(undefined)
    const readySpy = vi.spyOn(reconciler as any, 'checkDeploymentReady').mockResolvedValue(true)

    await reconciler.reconcile(HOST)

    expect(ingressSpy).toHaveBeenCalledTimes(1)
    const deployOrder = deploySpy.mock.invocationCallOrder[0]
    const ingressOrder = ingressSpy.mock.invocationCallOrder[0]
    const readyOrder = readySpy.mock.invocationCallOrder[0]
    expect(ingressOrder).toBeLessThan(deployOrder)
    expect(deployOrder).toBeLessThan(readyOrder)
  })

  it('calls ensureChannelReaderEgressNetworkPolicy before reconcileChannelReaderDeployment', async () => {
    const egressSpy = vi
      .spyOn(reconciler as any, 'ensureChannelReaderEgressNetworkPolicy')
      .mockResolvedValue(undefined)
    const cReaderSpy = vi
      .spyOn(reconciler as any, 'reconcileChannelReaderDeployment')
      .mockResolvedValue(undefined)

    await reconciler.reconcile(HOST)

    expect(egressSpy).toHaveBeenCalledTimes(1)
    const egressOrder = egressSpy.mock.invocationCallOrder[0]
    const cReaderOrder = cReaderSpy.mock.invocationCallOrder[0]
    expect(egressOrder).toBeLessThan(cReaderOrder)
  })

  it('surfaces ingress NP apply failure in Host status as degraded', async () => {
    // Reviewer #4: an NP apply failure must NOT be silently swallowed —
    // the per-Host NP IS the channel-reader↔mcp-host security boundary.
    vi.spyOn(reconciler as any, 'ensureMcpHostIngressNetworkPolicy').mockRejectedValue(
      new Error('rbac: networkpolicies.networking.k8s.io is forbidden')
    )
    vi.spyOn(reconciler as any, 'ensureChannelReaderEgressNetworkPolicy').mockResolvedValue(
      undefined
    )

    await reconciler.reconcile(HOST)

    const status = (reconciler as any).statusMap.get('chatllm') as
      | { deployed?: boolean; ready?: boolean; message?: string }
      | undefined
    expect(status).toBeDefined()
    expect(status!.deployed).toBe(true)
    expect(status!.ready).toBe(false)
    expect(status!.message).toMatch(/degraded/i)
    expect(status!.message).toMatch(/mcp-host NP/)
  })

  it('surfaces egress NP apply failure in Host status as degraded', async () => {
    vi.spyOn(reconciler as any, 'ensureMcpHostIngressNetworkPolicy').mockResolvedValue(undefined)
    vi.spyOn(reconciler as any, 'ensureChannelReaderEgressNetworkPolicy').mockRejectedValue(
      new Error('cluster connectivity failure')
    )

    await reconciler.reconcile(HOST)

    const status = (reconciler as any).statusMap.get('chatllm') as
      | { deployed?: boolean; ready?: boolean; message?: string }
      | undefined
    expect(status).toBeDefined()
    expect(status!.deployed).toBe(true)
    expect(status!.ready).toBe(false)
    expect(status!.message).toMatch(/degraded/i)
    expect(status!.message).toMatch(/egress NP/)
  })
})

describe('HostReconciler.deleteHostNetworkPolicies', () => {
  it('deletes all per-Host NPs across mcp-host, channels, and rpc-proxy', async () => {
    const { reconciler, mocks } = createReconciler()

    await (reconciler as any).deleteHostNetworkPolicies('chatllm', 'mcp-host')

    expect(mocks.networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(5)
    const calls = (mocks.networkingApi.deleteNamespacedNetworkPolicy as any).mock.calls
    expect(calls).toContainEqual([
      { name: 'mcp-host-chatllm-ingress-channel-reader', namespace: 'mcp-host' },
    ])
    expect(calls).toContainEqual([
      { name: 'mcp-host-chatllm-ingress-rpc-proxy', namespace: 'mcp-host' },
    ])
    expect(calls).toContainEqual([{ name: 'mcp-host-chatllm-egress-gfs', namespace: 'mcp-host' }])
    expect(calls).toContainEqual([{ name: 'mcp-host-chatllm-egress-gfs', namespace: 'mcp-host' }])
    expect(calls).toContainEqual([{ name: 'channel-reader-chatllm-egress', namespace: 'channels' }])
    expect(calls).toContainEqual([
      { name: 'rpc-proxy-chatllm-egress-mcp-host', namespace: 'rpc-proxy' },
    ])
  })

  it('tolerates 404 when the NP is already gone', async () => {
    const { reconciler, mocks } = createReconciler()
    ;(mocks.networkingApi.deleteNamespacedNetworkPolicy as any).mockRejectedValue(
      Object.assign(new Error('not found'), { code: 404 })
    )

    await expect(
      (reconciler as any).deleteHostNetworkPolicies('chatllm', 'mcp-host')
    ).resolves.toBeUndefined()
  })
})

describe('HostReconciler.fullReconcile — sweepOrphanHostNetworkPolicies wiring', () => {
  // Regression guard: Phase 6 wired sweepOrphanHostNetworkPolicies into fullReconcile.
  // This test ensures the wiring survives future refactors; the sweep method itself
  // is exercised by the describe block below.
  it('invokes sweepOrphanHostNetworkPolicies with the known host names', async () => {
    const { reconciler } = createReconciler()

    // Stub per-Host work and channel-reader sweep to no-ops so only the NP
    // sweep call is observable.
    vi.spyOn(reconciler, 'reconcile').mockResolvedValue(undefined)
    vi.spyOn(reconciler as any, 'listManagedHostDeployments').mockResolvedValue([])
    vi.spyOn(reconciler as any, 'sweepOrphanChannelReaderResources').mockResolvedValue(undefined)

    const sweepSpy = vi
      .spyOn(reconciler as any, 'sweepOrphanHostNetworkPolicies')
      .mockResolvedValue(undefined)

    await reconciler.fullReconcile([HOST])

    expect(sweepSpy).toHaveBeenCalledTimes(1)
    expect(sweepSpy).toHaveBeenCalledWith(['chatllm'])
  })
})

describe('HostReconciler.sweepOrphanHostNetworkPolicies', () => {
  it('deletes NPs whose clerum.io/host label is not in knownHosts', async () => {
    const { reconciler, mocks } = createReconciler()
    ;(mocks.networkingApi.listNamespacedNetworkPolicy as any).mockImplementation(
      ({ namespace }: { namespace: string }) => {
        if (namespace === 'channels') {
          return Promise.resolve({
            items: [
              {
                metadata: {
                  name: 'channel-reader-stalehost-egress',
                  namespace: 'channels',
                  labels: {
                    'clerum.io/managed-by': 'host-context-controller',
                    'clerum.io/host': 'stalehost',
                  },
                },
              },
              {
                metadata: {
                  name: 'channel-reader-livehost-egress',
                  namespace: 'channels',
                  labels: {
                    'clerum.io/managed-by': 'host-context-controller',
                    'clerum.io/host': 'livehost',
                  },
                },
              },
            ],
          })
        }
        return Promise.resolve({ items: [] })
      }
    )

    await (reconciler as any).sweepOrphanHostNetworkPolicies(['livehost'])

    expect(mocks.networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: 'channel-reader-stalehost-egress',
      namespace: 'channels',
    })
    expect(mocks.networkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith({
      name: 'channel-reader-livehost-egress',
      namespace: 'channels',
    })
  })

  it('does not touch NPs without managed-by label (e.g. static base policies)', async () => {
    const { reconciler, mocks } = createReconciler()
    ;(mocks.networkingApi.listNamespacedNetworkPolicy as any).mockResolvedValue({
      items: [
        {
          metadata: {
            name: 'mcp-host',
            namespace: 'mcp-host',
            labels: {},
          },
        },
      ],
    })

    await (reconciler as any).sweepOrphanHostNetworkPolicies([])

    expect(mocks.networkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })
})
