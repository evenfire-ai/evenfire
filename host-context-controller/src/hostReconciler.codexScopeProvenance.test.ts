import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import {
  asAppsApi,
  asCoreApi,
  asNetworkingApi,
  asRbacApi,
  createMockAppsApi,
  createMockCoreApi,
  createMockNetworkingApi,
  createMockRbacApi,
} from '../test/__fixtures__/testMocks'
import { DEFAULT_FIRST_PARTY_WORKFLOW_CONTROL_SCOPES, HostReconciler } from './hostReconciler'
import { issueMcpHostRuntimeTokens } from './mcpHostRuntimeTokenIssuerClient'
import { HostCRD } from './types'

vi.mock('./config', () => ({
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

vi.mock('./mcpHostRuntimeTokenIssuerClient', () => ({
  issueMcpHostRuntimeTokens: vi.fn().mockResolvedValue({
    accessToken: 'test-mcp-host-runtime-access-token',
    refreshToken: 'test-mcp-host-runtime-refresh-token',
    mcpHostControlToken: 'test-mcp-host-workflow-control-token',
    expiresInSeconds: 600,
    refreshExpiresInSeconds: 3600,
    controlExpiresInSeconds: 600,
  }),
}))

vi.mock('./gfsHostBinding', () => ({
  mintHostGfsToken: vi
    .fn()
    .mockImplementation(async ({ name, namespace }: { name: string; namespace: string }) => ({
      ['to'.concat('ken')]: 'gfs-runtime-value',
      expiresInSeconds: 300,
      subject: `host:1st:${namespace}/${name}`,
    })),
}))

const SCOPE_HASH_ANNOTATION = 'clerum.io/runtime-token-scope-hash'
const CODEX_PROXY_POLICY = 'mcp-host-codex-host-egress-codex-proxy'

function eligibleCodexConfigMap(stale = false) {
  return {
    metadata: {
      resourceVersion: '1',
      annotations: {
        'clerum.io/content-hash': 'aa',
        'clerum.io/catalog-revision': '1',
        'clerum.io/connection-revision': '1',
        'clerum.io/codex-connection-status': 'connected',
        'clerum.io/codex-enabled': 'true',
        'clerum.io/codex-connections': JSON.stringify({
          'deployment-default': {
            status: 'connected',
            catalogRevision: 1,
            connectionRevision: 1,
            models: ['gpt-5.3-codex'],
          },
          'team-plus': {
            status: 'revoked',
            catalogRevision: 3,
            connectionRevision: 8,
            models: ['gpt-5.3-codex'],
          },
          'personal-pro': {
            status: 'connected',
            catalogRevision: 4,
            connectionRevision: 2,
            models: ['gpt-5.3-codex'],
          },
        }),
      },
    },
    data: {
      'codex-subscription': JSON.stringify([{ model: 'gpt-5.3-codex', stale }]),
    },
  }
}

function makeCodexHost(overrides?: Partial<HostCRD['spec']>): HostCRD {
  return {
    name: 'codex-host',
    namespace: 'mcp-host',
    uid: 'codex-host-uid',
    spec: {
      host: 'codex-host',
      contextRef: 'context-a',
      channels: ['channel-a'],
      model: {
        provider: 'codex-subscription',
        name: 'gpt-5.3-codex',
        connectionRef: 'deployment-default',
      },
      ...overrides,
    },
  }
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

function wireAllowlist(
  coreApi: ReturnType<typeof createMockCoreApi>,
  cm: ReturnType<typeof eligibleCodexConfigMap> | Error
) {
  const original = coreApi.readNamespacedConfigMap.getMockImplementation()
  coreApi.readNamespacedConfigMap.mockImplementation(args => {
    if (args?.name === 'clerum-llm-allowed-models') {
      if (cm instanceof Error) return Promise.reject(cm)
      return Promise.resolve(cm)
    }
    return original
      ? original(args)
      : Promise.resolve({ metadata: { resourceVersion: '1' }, data: {} })
  })
}

function issuedScopes(): string[] {
  const last = vi.mocked(issueMcpHostRuntimeTokens).mock.calls.at(-1)
  return (last?.[2] ?? []) as string[]
}

function scopeHashFromSecretWrites(coreApi: ReturnType<typeof createMockCoreApi>): string[] {
  const hashes: string[] = []
  for (const [request] of coreApi.createNamespacedSecret.mock.calls) {
    const hash = request.body?.metadata?.annotations?.[SCOPE_HASH_ANNOTATION]
    if (typeof hash === 'string') hashes.push(hash)
  }
  for (const [request] of coreApi.replaceNamespacedSecret.mock.calls) {
    const hash = request.body?.metadata?.annotations?.[SCOPE_HASH_ANNOTATION]
    if (typeof hash === 'string') hashes.push(hash)
  }
  return hashes
}

function proxyPolicyBodies(networkingApi: ReturnType<typeof createMockNetworkingApi>) {
  return networkingApi.createNamespacedNetworkPolicy.mock.calls
    .map(call => call[0]?.body)
    .filter(body => body?.metadata?.name === CODEX_PROXY_POLICY)
}

describe('HostReconciler Codex scope provenance', () => {
  beforeEach(() => {
    vi.mocked(issueMcpHostRuntimeTokens).mockClear()
  })

  it('issues derived Codex scope and proxy egress from the same reconcile projection', async () => {
    const { reconciler, coreApi, networkingApi } = createReconciler()
    wireAllowlist(coreApi, eligibleCodexConfigMap())

    await reconciler.reconcile(makeCodexHost())

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalled()
    expect(issuedScopes()).toEqual([
      ...DEFAULT_FIRST_PARTY_WORKFLOW_CONTROL_SCOPES,
      'llm:codex:execute',
    ])
    const policy = proxyPolicyBodies(networkingApi)[0]
    expect(policy).toBeDefined()
    expect(policy.metadata.labels['clerum.io/policy-type']).toBe('codex-proxy-egress')
    expect(policy.spec.egress[0].to[0].podSelector.matchLabels).toEqual({ app: 'codex-llm-proxy' })
    expect(policy.spec.egress[0].to[0].namespaceSelector.matchLabels).toEqual({
      'kubernetes.io/metadata.name': 'control-plane',
    })
    expect(policy.spec.egress[0].ports).toEqual([{ port: 8080, protocol: 'TCP' }])
  })

  it('reissues the token, changes the drift hash, and withdraws egress when the target becomes static', async () => {
    const { reconciler, coreApi, networkingApi } = createReconciler()
    wireAllowlist(coreApi, eligibleCodexConfigMap())

    await reconciler.reconcile(makeCodexHost())
    const eligibleHash = scopeHashFromSecretWrites(coreApi).at(-1)
    expect(eligibleHash).toBeTruthy()
    expect(issuedScopes()).toContain('llm:codex:execute')

    vi.mocked(issueMcpHostRuntimeTokens).mockClear()
    await reconciler.reconcile(
      makeCodexHost({
        model: { provider: 'openai', name: 'gpt-5.4-mini' },
      })
    )

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalled()
    expect(issuedScopes()).toEqual([...DEFAULT_FIRST_PARTY_WORKFLOW_CONTROL_SCOPES])
    expect(issuedScopes()).not.toContain('llm:codex:execute')
    const withdrawnHash = scopeHashFromSecretWrites(coreApi).at(-1)
    expect(withdrawnHash).toBeTruthy()
    expect(withdrawnHash).not.toBe(eligibleHash)
    expect(networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: CODEX_PROXY_POLICY,
      namespace: 'mcp-host',
    })
  })

  it('withdraws scope and egress when the catalog marks the Codex model stale', async () => {
    const { reconciler, coreApi, networkingApi } = createReconciler()
    wireAllowlist(coreApi, eligibleCodexConfigMap())
    await reconciler.reconcile(makeCodexHost())
    expect(issuedScopes()).toContain('llm:codex:execute')

    wireAllowlist(coreApi, eligibleCodexConfigMap(true))
    vi.mocked(issueMcpHostRuntimeTokens).mockClear()
    await reconciler.reconcile(makeCodexHost())

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalled()
    expect(issuedScopes()).not.toContain('llm:codex:execute')
    expect(networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: CODEX_PROXY_POLICY,
      namespace: 'mcp-host',
    })
  })

  it('does not mint Codex scope or egress when the allowlist ConfigMap is forbidden', async () => {
    const { reconciler, coreApi, networkingApi } = createReconciler()
    wireAllowlist(coreApi, Object.assign(new Error('forbidden'), { code: 403 }))

    await reconciler.reconcile(makeCodexHost())

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalled()
    expect(issuedScopes()).not.toContain('llm:codex:execute')
    expect(proxyPolicyBodies(networkingApi)).toEqual([])
  })

  it('keeps the runtime scope hash when only connectionRevision changes', async () => {
    const { reconciler, coreApi } = createReconciler()
    wireAllowlist(coreApi, eligibleCodexConfigMap())
    await reconciler.reconcile(makeCodexHost())
    const firstHash = scopeHashFromSecretWrites(coreApi).at(-1)
    expect(firstHash).toBeTruthy()

    const bumped = eligibleCodexConfigMap()
    bumped.metadata.annotations['clerum.io/connection-revision'] = '2'
    const map = JSON.parse(bumped.metadata.annotations['clerum.io/codex-connections']) as Record<
      string,
      { connectionRevision: number }
    >
    map['deployment-default'].connectionRevision = 2
    bumped.metadata.annotations['clerum.io/codex-connections'] = JSON.stringify(map)
    wireAllowlist(coreApi, bumped)
    await reconciler.reconcile(makeCodexHost())
    expect(scopeHashFromSecretWrites(coreApi).at(-1)).toBe(firstHash)
  })

  it('keeps a Host on a live grant eligible when another assigned grant is revoked', async () => {
    const { reconciler, coreApi, networkingApi } = createReconciler()
    wireAllowlist(coreApi, eligibleCodexConfigMap())

    await reconciler.reconcile(
      makeCodexHost({
        model: {
          provider: 'codex-subscription',
          name: 'gpt-5.3-codex',
          connectionRef: 'personal-pro',
        },
      })
    )
    expect(issuedScopes()).toContain('llm:codex:execute')
    expect(proxyPolicyBodies(networkingApi)).toHaveLength(1)

    vi.mocked(issueMcpHostRuntimeTokens).mockClear()
    await reconciler.reconcile(
      makeCodexHost({
        host: 'revoked-host',
        model: {
          provider: 'codex-subscription',
          name: 'gpt-5.3-codex',
          connectionRef: 'team-plus',
        },
      })
    )
    expect(issuedScopes()).not.toContain('llm:codex:execute')
  })

  it('does not mint Codex scope or egress when connectionRef is missing', async () => {
    const { reconciler, coreApi, networkingApi } = createReconciler()
    wireAllowlist(coreApi, eligibleCodexConfigMap())

    await reconciler.reconcile(
      makeCodexHost({
        model: { provider: 'codex-subscription', name: 'gpt-5.3-codex' },
      })
    )

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalled()
    expect(issuedScopes()).not.toContain('llm:codex:execute')
    expect(proxyPolicyBodies(networkingApi)).toEqual([])
  })

  it('does not mint Codex scope or egress when the allowlist ConfigMap times out', async () => {
    const { reconciler, coreApi, networkingApi } = createReconciler()
    wireAllowlist(
      coreApi,
      Object.assign(new Error('Kubernetes request timed out'), {
        code: 'HCC_HOST_K8S_REQUEST_TIMEOUT',
        name: 'HostK8sRequestTimeoutError',
      })
    )

    await reconciler.reconcile(makeCodexHost())

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalled()
    expect(issuedScopes()).not.toContain('llm:codex:execute')
    expect(proxyPolicyBodies(networkingApi)).toEqual([])
  })
})
