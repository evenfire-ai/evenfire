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

const GROK_FLAG_ENV = 'MCP_HOST_GROK_SUBSCRIPTION_ENABLED'

type Connection = {
  status: string
  catalogRevision: number
  connectionRevision: number
  models: string[]
}

function allowlistConfigMap(
  options: {
    grokEnabled?: boolean
    grokConnections?: Record<string, Connection>
  } = {}
) {
  const annotations: Record<string, string> = {
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
    }),
  }
  if (options.grokEnabled !== undefined) {
    annotations['clerum.io/grok-enabled'] = String(options.grokEnabled)
  }
  if (options.grokConnections) {
    annotations['clerum.io/grok-connections'] = JSON.stringify(options.grokConnections)
  }
  return {
    metadata: { resourceVersion: '1', annotations },
    data: {
      'codex-subscription': JSON.stringify([{ model: 'gpt-5.3-codex', stale: false }]),
    },
  }
}

const liveGrokConnections: Record<string, Connection> = {
  'team-grok': {
    status: 'connected',
    catalogRevision: 1,
    connectionRevision: 1,
    models: ['grok-4'],
  },
}

function makeHost(name: string, model: NonNullable<HostCRD['spec']['model']>): HostCRD {
  return {
    name,
    namespace: 'mcp-host',
    uid: `${name}-uid`,
    generation: 1,
    spec: { host: name, contextRef: 'context-a', channels: ['channel-a'], model },
  }
}

const grokHost = () =>
  makeHost('grok-host', {
    provider: 'grok-subscription',
    name: 'grok-4',
    connectionRef: 'team-grok',
  })

const codexHost = () =>
  makeHost('codex-host', {
    provider: 'codex-subscription',
    name: 'gpt-5.3-codex',
    connectionRef: 'deployment-default',
  })

const staticHost = () => makeHost('static-host', { provider: 'openai', name: 'gpt-5.4-mini' })

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
  cm: ReturnType<typeof allowlistConfigMap>
) {
  const original = coreApi.readNamespacedConfigMap.getMockImplementation()
  coreApi.readNamespacedConfigMap.mockImplementation(args => {
    if (args?.name === 'clerum-llm-allowed-models') return Promise.resolve(cm)
    return original
      ? original(args)
      : Promise.resolve({ metadata: { resourceVersion: '1' }, data: {} })
  })
}

function issuedScopes(): string[] {
  const last = vi.mocked(issueMcpHostRuntimeTokens).mock.calls.at(-1)
  return (last?.[2] ?? []) as string[]
}

function lastDeployment(
  appsApi: ReturnType<typeof createMockAppsApi>,
  hostName: string
): k8s.V1Deployment {
  const writes = [
    ...appsApi.createNamespacedDeployment.mock.calls,
    ...appsApi.replaceNamespacedDeployment.mock.calls,
  ]
  const body = writes
    .map(call => call[0]?.body as k8s.V1Deployment | undefined)
    .filter(candidate => candidate?.metadata?.name === hostName)
    .at(-1)
  expect(body).toBeDefined()
  return body!
}

function mcpHostEnv(deployment: k8s.V1Deployment): k8s.V1EnvVar[] {
  const container = deployment.spec?.template.spec?.containers.find(c => c.name === 'mcp-host')
  expect(container).toBeDefined()
  return container!.env ?? []
}

function grokPolicyCalls(networkingApi: ReturnType<typeof createMockNetworkingApi>, host: string) {
  const policyName = `mcp-host-${host}-egress-grok-proxy`
  const named = (call: unknown[]) => {
    const request = call[0] as { name?: string; body?: { metadata?: { name?: string } } }
    return request?.name === policyName || request?.body?.metadata?.name === policyName
  }
  return [
    ...networkingApi.readNamespacedNetworkPolicy.mock.calls,
    ...networkingApi.createNamespacedNetworkPolicy.mock.calls,
    ...networkingApi.replaceNamespacedNetworkPolicy.mock.calls,
    ...networkingApi.deleteNamespacedNetworkPolicy.mock.calls,
  ].filter(named)
}

describe('HostReconciler Grok Host runtime gating', () => {
  beforeEach(() => {
    vi.mocked(issueMcpHostRuntimeTokens).mockClear()
  })

  it('sets the mcp-host Grok factory flag when the Host projection derives llm:grok:execute', async () => {
    const { reconciler, appsApi, coreApi } = createReconciler()
    wireAllowlist(
      coreApi,
      allowlistConfigMap({ grokEnabled: true, grokConnections: liveGrokConnections })
    )

    await reconciler.reconcile(grokHost())

    expect(issuedScopes()).toEqual([
      ...DEFAULT_FIRST_PARTY_WORKFLOW_CONTROL_SCOPES,
      'llm:grok:execute',
    ])
    const flag = mcpHostEnv(lastDeployment(appsApi, 'grok-host')).filter(
      env => env.name === GROK_FLAG_ENV
    )
    expect(flag).toEqual([{ name: GROK_FLAG_ENV, value: 'true' }])
  })

  it('omits the Grok factory flag when clerum.io/grok-enabled is false', async () => {
    const { reconciler, appsApi, coreApi } = createReconciler()
    wireAllowlist(
      coreApi,
      allowlistConfigMap({ grokEnabled: false, grokConnections: liveGrokConnections })
    )

    await reconciler.reconcile(grokHost())

    expect(issuedScopes()).not.toContain('llm:grok:execute')
    expect(mcpHostEnv(lastDeployment(appsApi, 'grok-host')).map(env => env.name)).not.toContain(
      GROK_FLAG_ENV
    )
  })

  it('omits the Grok factory flag when the assigned Grok connection is not connected', async () => {
    const { reconciler, appsApi, coreApi } = createReconciler()
    wireAllowlist(
      coreApi,
      allowlistConfigMap({
        grokEnabled: true,
        grokConnections: {
          'team-grok': { ...liveGrokConnections['team-grok'], status: 'revoked' },
        },
      })
    )

    await reconciler.reconcile(grokHost())

    expect(issuedScopes()).not.toContain('llm:grok:execute')
    expect(mcpHostEnv(lastDeployment(appsApi, 'grok-host')).map(env => env.name)).not.toContain(
      GROK_FLAG_ENV
    )
  })

  it('rolls the Deployment template when Grok eligibility flips off', async () => {
    const { reconciler, appsApi, coreApi } = createReconciler()
    wireAllowlist(
      coreApi,
      allowlistConfigMap({ grokEnabled: true, grokConnections: liveGrokConnections })
    )
    await reconciler.reconcile(grokHost())
    const eligible = lastDeployment(appsApi, 'grok-host')
    expect(mcpHostEnv(eligible).map(env => env.name)).toContain(GROK_FLAG_ENV)

    wireAllowlist(
      coreApi,
      allowlistConfigMap({ grokEnabled: false, grokConnections: liveGrokConnections })
    )
    await reconciler.reconcile(grokHost())
    const withdrawn = lastDeployment(appsApi, 'grok-host')
    expect(mcpHostEnv(withdrawn).map(env => env.name)).not.toContain(GROK_FLAG_ENV)
    expect(withdrawn.spec?.template).not.toEqual(eligible.spec?.template)
  })

  it.each([
    ['Codex-only', codexHost],
    ['static-provider', staticHost],
  ] as const)(
    'keeps the %s Host pod template byte-identical whether or not a live Grok grant exists',
    async (_label, hostFactory) => {
      const withoutGrok = createReconciler()
      wireAllowlist(withoutGrok.coreApi, allowlistConfigMap())
      const host = hostFactory()
      await withoutGrok.reconciler.reconcile(host)
      const baseline = lastDeployment(withoutGrok.appsApi, host.name)

      const withGrok = createReconciler()
      wireAllowlist(
        withGrok.coreApi,
        allowlistConfigMap({ grokEnabled: true, grokConnections: liveGrokConnections })
      )
      await withGrok.reconciler.reconcile(hostFactory())
      const candidate = lastDeployment(withGrok.appsApi, host.name)

      expect(JSON.stringify(candidate.spec?.template)).toBe(JSON.stringify(baseline.spec?.template))
      expect(mcpHostEnv(candidate).map(env => env.name)).toEqual([
        'CLERUM_HOST_NAME',
        'CLERUM_NAMESPACE',
        'CLERUM_WORKSPACE_PATH',
        'CLERUM_LLM_SECRET_REF',
        'MCP_HOST_RUNTIME_ACCESS_TOKEN',
        'MCP_HOST_RUNTIME_REFRESH_TOKEN',
        'MCP_HOST_WORKFLOW_CONTROL_TOKEN',
        'MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE',
        'MCP_HOST_RUNTIME_AUTH_STATE_DIR',
        'MCP_HOST_GATEWAY_URL',
      ])
    }
  )

  it('revalidates Host authority between the Codex and Grok proxy egress policy writes', async () => {
    const { reconciler, coreApi, networkingApi } = createReconciler()
    wireAllowlist(
      coreApi,
      allowlistConfigMap({ grokEnabled: true, grokConnections: liveGrokConnections })
    )
    const host = grokHost()
    let superseded = false
    const internals = reconciler as unknown as {
      reconcileMcpHostCodexProxyEgressNetworkPolicy(host: HostCRD): Promise<void>
      reconcileCore(host: HostCRD, revalidate?: () => HostCRD): Promise<void>
    }
    const codexPolicy = internals.reconcileMcpHostCodexProxyEgressNetworkPolicy.bind(reconciler)
    vi.spyOn(internals, 'reconcileMcpHostCodexProxyEgressNetworkPolicy').mockImplementation(
      async target => {
        await codexPolicy(target)
        // A newer Host generation is observed while the Codex policy write awaits.
        superseded = true
      }
    )
    const revalidate = () => {
      if (superseded) {
        throw Object.assign(new Error('Host spec generation changed'), {
          name: 'HostMutationSpecRevisionChangedError',
        })
      }
      return host
    }

    await expect(internals.reconcileCore(host, revalidate)).rejects.toMatchObject({
      name: 'HostMutationSpecRevisionChangedError',
    })

    expect(internals.reconcileMcpHostCodexProxyEgressNetworkPolicy).toHaveBeenCalledTimes(1)
    expect(grokPolicyCalls(networkingApi, host.name)).toEqual([])
  })
})
