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
    llmHooksNamespace: 'llm-hooks',
    hostFullReconcileConcurrency: 2,
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

function createReconciler(customApi?: { getNamespacedCustomObject: ReturnType<typeof vi.fn> }) {
  const appsApi = createMockAppsApi()
  const coreApi = createMockCoreApi()
  const networkingApi = createMockNetworkingApi()
  const rbacApi = createMockRbacApi()

  const reconciler = new HostReconciler({} as k8s.KubeConfig, {
    appsApi: asAppsApi(appsApi),
    coreApi: asCoreApi(coreApi),
    networkingApi: asNetworkingApi(networkingApi),
    rbacApi: asRbacApi(rbacApi),
    ...(customApi ? { customApi: customApi as unknown as k8s.CustomObjectsApi } : {}),
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

// NOTE: the mcp-host→llm-hooks egress policy moved to LlmHookReconciler
// (per-host, scoped to referenced hook pods — N1/N7); see
// src/llmHookReconciler.test.ts "per-host egress". HostReconciler still deletes
// `mcp-host-<host>-egress-llm-hooks` on host delete (covered by the
// deleteHostNetworkPolicies test below).

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

    expect(mocks.networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(6)
    const calls = (mocks.networkingApi.deleteNamespacedNetworkPolicy as any).mock.calls
    expect(calls).toContainEqual([
      { name: 'mcp-host-chatllm-ingress-channel-reader', namespace: 'mcp-host' },
    ])
    expect(calls).toContainEqual([
      { name: 'mcp-host-chatllm-ingress-rpc-proxy', namespace: 'mcp-host' },
    ])
    expect(calls).toContainEqual([{ name: 'mcp-host-chatllm-egress-gfs', namespace: 'mcp-host' }])
    expect(calls).toContainEqual([
      { name: 'mcp-host-chatllm-egress-codex-proxy', namespace: 'mcp-host' },
    ])
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

describe('HostReconciler.fullReconcile — orphan NetworkPolicy cleanup wiring', () => {
  // The Phase-6 `sweepOrphanHostNetworkPolicies` method was folded into the
  // §10.5 authority-gated cleanup: under known watch authority a full pass
  // gathers managed NetworkPolicies (across all three managed namespaces) as
  // orphan candidates, then applies the fresh-read authority gate before any
  // bundle deletion. This proves the NP sweep is still wired into fullReconcile.
  it('gathers managed NetworkPolicy candidates across all managed namespaces during a full pass', async () => {
    const { reconciler, mocks } = createReconciler()
    // Known + stable watch authority so cleanup runs instead of deferring.
    reconciler.setHostWatchAuthority(() => ({ known: true, generation: 1 }))

    await reconciler.fullReconcile([])

    for (const namespace of ['channels', 'mcp-host', 'rpc-proxy']) {
      expect(mocks.networkingApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace,
          labelSelector: 'clerum.io/managed-by=host-context-controller',
        })
      )
    }
  })
})

describe('HostReconciler orphan NetworkPolicy authority-gated cleanup', () => {
  // Preserves the three semantics of the removed sweepOrphanHostNetworkPolicies,
  // now realized through the §10.5 discover-owner + delete-owned-bundle path:
  //   (A) an orphan NP (clerum.io/host not a live host, fresh 404 confirmed) →
  //       that host's owned NP bundle is deleted;
  //   (B) an NP whose owning host is still present → retained;
  //   (C) an unlabeled/static NP (no derivable owner) → never touched.
  it('deletes the owned NP bundle for an orphan host and retains a live host', async () => {
    const getObj = vi.fn().mockRejectedValue({ code: 404 })
    const { reconciler, mocks } = createReconciler({ getNamespacedCustomObject: getObj })
    reconciler.setHostWatchAuthority(() => ({ known: true, generation: 1 }))
    reconciler.setResolveCurrentHost(name =>
      name === 'livehost' ? { ...HOST, name: 'livehost' } : undefined
    )
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

    await reconciler.fullReconcile([])

    // (A) stale host confirmed gone (fresh 404) → its owned per-Host NPs deleted
    // via the bundle; (B) the live host is never read nor deleted.
    expect(getObj).toHaveBeenCalledWith(expect.objectContaining({ name: 'stalehost' }))
    expect(getObj).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'livehost' }))
    expect(mocks.networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: 'channel-reader-stalehost-egress',
      namespace: 'channels',
    })
    expect(mocks.networkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith({
      name: 'channel-reader-livehost-egress',
      namespace: 'channels',
    })
  })

  it('never touches an NP whose owning Host cannot be derived from labels (static base policies)', async () => {
    const getObj = vi.fn()
    const { reconciler, mocks } = createReconciler({ getNamespacedCustomObject: getObj })
    reconciler.setHostWatchAuthority(() => ({ known: true, generation: 1 }))
    reconciler.setResolveCurrentHost(() => undefined)
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

    await reconciler.fullReconcile([])

    // (C) No derivable owner → deferred before any fresh read, never deleted.
    expect(getObj).not.toHaveBeenCalled()
    expect(mocks.networkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('defers NP cleanup and deletes nothing when watch authority is unknown', async () => {
    // §10.5 gate proven on purpose: unknown watch authority short-circuits the
    // whole cleanup before any candidate is gathered, so a real orphan NP is
    // left intact rather than risking a wrong delete.
    const getObj = vi.fn()
    const { reconciler, mocks } = createReconciler({ getNamespacedCustomObject: getObj })
    reconciler.setHostWatchAuthority(() => ({ known: false, generation: 1 }))
    reconciler.setResolveCurrentHost(() => undefined)
    ;(mocks.networkingApi.listNamespacedNetworkPolicy as any).mockResolvedValue({
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
      ],
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await reconciler.fullReconcile([])

    expect(getObj).not.toHaveBeenCalled()
    expect(mocks.networkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Deferring orphan cleanup: authority_unknown')
    )
    warn.mockRestore()
  })
})
