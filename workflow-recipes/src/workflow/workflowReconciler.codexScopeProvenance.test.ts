import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowRecipeSpec } from '../types'
import { issueMcpHostRuntimeTokens } from './mcpHostRuntimeTokenIssuerClient'
import { WorkflowReconciler, type WorkflowReconcilerDeps } from './workflowReconciler'

const crashRecoveryMocks = vi.hoisted(() => ({
  deletePodIfExists: vi.fn().mockResolvedValue(undefined),
  waitForPodDeletion: vi.fn().mockResolvedValue(true),
  evaluateCompletedRuntimePodRecovery: vi.fn().mockReturnValue({
    action: 'replace',
    message:
      'mcp_host pod completed before workflow became terminal; creating replacement (attempt 1/3)',
    newPhase: 'recovering',
    newAttempt: 1,
  }),
  evaluateCrashRecovery: vi.fn().mockReturnValue({ action: 'none', message: 'Pod is healthy' }),
  getContainerWaitingReason: vi.fn().mockResolvedValue(undefined),
  getPodPhase: vi.fn().mockResolvedValue(undefined),
  getPodReadiness: vi.fn().mockResolvedValue({ ready: true, phase: 'Running', uid: 'pod-uid-1' }),
  isRecoverableContainerWaitingReason: vi.fn(() => false),
}))

const runtimeTokenIssuerMocks = vi.hoisted(() => ({
  issueMcpHostRuntimeTokens: vi.fn().mockResolvedValue({
    accessToken: 'runtime-access-token',
    refreshToken: 'runtime-refresh-token',
    mcpHostControlToken: 'mcp-host-control-token',
  }),
  issueMcpHostWorkflowControlToken: vi.fn().mockResolvedValue('mcp-host-control-token'),
}))

vi.mock('./crashRecovery', () => crashRecoveryMocks)
vi.mock('./mcpHostRuntimeTokenIssuerClient', () => runtimeTokenIssuerMocks)

vi.mock('../gfsBinding', () => ({
  mintRecipeHostGfsToken: vi.fn().mockResolvedValue({
    ['to'.concat('ken')]: 'gfs-runtime-value',
    expiresInSeconds: 300,
    subject: 'host:3rd:sandbox-recipes/codex-recipe',
  }),
}))

const sandboxNamespace = 'sandbox-recipes'
const CODEX_PROXY_POLICY = 'codex-recipe-mcp-host-to-codex-proxy'

function unsignedRuntimeJwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.x`
}

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
      },
    },
    data: {
      'codex-subscription': JSON.stringify([{ model: 'gpt-5.3-codex', stale }]),
    },
  }
}

function makeCodexSpec(overrides?: Partial<WorkflowRecipeSpec>): WorkflowRecipeSpec {
  return {
    agent: { provider: 'codex-subscription', model: 'gpt-5.3-codex' },
    steps: [{ id: 'brief', instruction: 'write the brief' }],
    ...overrides,
  }
}

function issuedScopes(): string[] {
  const last = runtimeTokenIssuerMocks.issueMcpHostRuntimeTokens.mock.calls.at(-1)
  return (last?.[2] ?? []) as string[]
}

function proxyPolicyBodies(networkingApi: {
  createNamespacedNetworkPolicy: {
    mock: { calls: Array<[{ body?: { metadata?: { name?: string }; spec?: unknown } }]> }
  }
}) {
  return networkingApi.createNamespacedNetworkPolicy.mock.calls
    .map(call => call[0]?.body)
    .filter(body => body?.metadata?.name === CODEX_PROXY_POLICY)
}

function createHarness() {
  const mockCoreApi = {
    readNamespacedPod: vi.fn().mockImplementation(async (params: { name?: string }) => {
      if (typeof params.name === 'string' && params.name.endsWith('-mcp-host')) {
        return {
          metadata: {
            labels: { 'clerum.io/workflow-output-claim': 'shared-output' },
          },
        }
      }
      return {}
    }),
    readNamespacedSecret: vi.fn().mockRejectedValue({ code: 404 }),
    readNamespacedService: vi.fn().mockResolvedValue({}),
    readNamespacedEndpoints: vi.fn().mockRejectedValue({ code: 404 }),
    readNamespacedConfigMap: vi.fn().mockResolvedValue(eligibleCodexConfigMap()),
    createNamespacedSecret: vi.fn().mockResolvedValue({}),
    createNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    createNamespacedService: vi.fn().mockResolvedValue({}),
    createNamespacedPod: vi.fn().mockResolvedValue({}),
    patchNamespacedSecret: vi.fn().mockResolvedValue({}),
    deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
    deleteNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    deleteNamespacedService: vi.fn().mockResolvedValue({}),
    readNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({
      metadata: { name: 'existing-workflow-output', deletionTimestamp: undefined },
    }),
    createNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
    deleteNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
    deleteCollectionNamespacedService: vi.fn().mockResolvedValue({}),
  }
  const mockNetworkingApi = {
    createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    readNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
    replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    listNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ items: [] }),
  }
  const mockCustomApi = {
    patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
  }
  const deps = {
    coreApi: mockCoreApi,
    customApi: mockCustomApi,
    networkingApi: mockNetworkingApi,
    config: {
      coordinatorImage: 'coordinator:test',
      mcpHostImage: 'mcp-host:test',
      wrcEndpoint: 'http://wrc.example/api',
      sandboxNamespace,
      mcpServerNamespace: 'mcp-server',
      imagePullPolicy: 'IfNotPresent' as const,
      maxWorkflowSteps: 100,
      runtimeTokenTtlSeconds: 3600,
      runtimeTokenRefreshBeforeSeconds: 300,
    },
    tokenFactory: {
      signWrcArtifactDeleteToken: vi.fn().mockResolvedValue('stub-token'),
      signCoordinatorToMcpHostToken: vi.fn().mockResolvedValue('coordinator-mcp-host-token'),
      signCustomCoordinatorToWrcToken: vi.fn().mockResolvedValue('custom-coordinator-wrc-token'),
      signCoordinatorToWrcToken: vi.fn().mockResolvedValue('coordinator-wrc-token'),
    },
    pluginWorkloadSdkRevocationClient: {
      revoke: vi.fn().mockResolvedValue({ state: 'missing', revoked: 0, fencedInvocations: 0 }),
      finalize: vi.fn(),
    },
  } as unknown as WorkflowReconcilerDeps
  return {
    reconciler: new WorkflowReconciler(deps),
    coreApi: mockCoreApi,
    networkingApi: mockNetworkingApi,
  }
}

async function reconcileRecipe(
  reconciler: WorkflowReconciler,
  spec: WorkflowRecipeSpec,
  recipeName = 'codex-recipe',
  runtimeScopeRecipeName = recipeName
) {
  crashRecoveryMocks.getPodPhase.mockImplementation(async (_api, name: string) => {
    if (name.endsWith('-workflow-output-anchor')) return 'Running'
    if (name.endsWith('-workflow-output-prepare')) return 'Succeeded'
    return undefined
  })
  crashRecoveryMocks.getPodReadiness.mockResolvedValue({
    ready: false,
    phase: 'Pending',
  })
  return reconciler.reconcile(
    recipeName,
    `uid-${recipeName}`,
    sandboxNamespace,
    spec,
    { workflowExecution: { phase: 'initializing' } },
    undefined,
    runtimeScopeRecipeName,
    'run-1'
  )
}

describe('WorkflowReconciler Codex scope provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    crashRecoveryMocks.getPodReadiness.mockResolvedValue({
      ready: true,
      phase: 'Running',
      uid: 'pod-uid-1',
    })
    runtimeTokenIssuerMocks.issueMcpHostRuntimeTokens.mockResolvedValue({
      accessToken: 'runtime-access-token',
      refreshToken: 'runtime-refresh-token',
      mcpHostControlToken: 'mcp-host-control-token',
    })
  })

  it('issues derived Codex scope and proxy egress from the same reconcile projection', async () => {
    const { reconciler, networkingApi } = createHarness()

    await reconcileRecipe(reconciler, makeCodexSpec())

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalled()
    expect(issuedScopes()).toContain('llm:codex:execute')
    const policy = proxyPolicyBodies(networkingApi)[0]
    expect(policy).toBeDefined()
    expect(policy?.metadata?.labels?.['clerum.io/policy-type']).toBe('codex-proxy-egress')
    expect(policy?.spec?.egress?.[0]?.to?.[0]?.podSelector?.matchLabels).toEqual({
      app: 'codex-llm-proxy',
    })
    expect(policy?.spec?.egress?.[0]?.to?.[0]?.namespaceSelector?.matchLabels).toEqual({
      'kubernetes.io/metadata.name': 'control-plane',
    })
    expect(policy?.spec?.egress?.[0]?.ports).toEqual([{ port: 8080, protocol: 'TCP' }])
  })

  it('does not mint Codex from deriveWorkflowControlScopes when the target is static', async () => {
    const { reconciler, networkingApi } = createHarness()

    await reconcileRecipe(
      reconciler,
      makeCodexSpec({ agent: { provider: 'openai', model: 'gpt-5.4-mini' } })
    )

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalled()
    expect(issuedScopes()).not.toContain('llm:codex:execute')
    expect(proxyPolicyBodies(networkingApi)).toEqual([])
  })

  it('reissues the token and withdraws egress when the target becomes static', async () => {
    const { reconciler, coreApi, networkingApi } = createHarness()
    await reconcileRecipe(reconciler, makeCodexSpec())
    expect(issuedScopes()).toContain('llm:codex:execute')

    const futureExp = Math.floor(Date.now() / 1000) + 3600
    const binding = {
      exp: futureExp,
      recipeNamespace: sandboxNamespace,
      recipeName: 'codex-recipe',
      hostRefs: [`${sandboxNamespace}/codex-recipe`],
      workflowControlScopes: ['llm:codex:execute'],
      scopes: ['llm:codex:execute', 'gfs.read'],
    }
    coreApi.readNamespacedSecret.mockResolvedValue({
      data: {
        'mcp-host-runtime-access-token': Buffer.from(unsignedRuntimeJwt(binding)).toString(
          'base64'
        ),
        'mcp-host-runtime-refresh-token': Buffer.from(unsignedRuntimeJwt(binding)).toString(
          'base64'
        ),
        'mcp-host-workflow-control-token': Buffer.from(unsignedRuntimeJwt(binding)).toString(
          'base64'
        ),
        'mcp-host-gfs-token': Buffer.from(
          unsignedRuntimeJwt({
            ...binding,
            sub: `host:3rd:${sandboxNamespace}/codex-recipe`,
            scopes: ['gfs.read'],
          })
        ).toString('base64'),
      },
    })
    runtimeTokenIssuerMocks.issueMcpHostRuntimeTokens.mockClear()

    await reconcileRecipe(
      reconciler,
      makeCodexSpec({ agent: { provider: 'openai', model: 'gpt-5.4-mini' } })
    )

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalled()
    expect(issuedScopes()).not.toContain('llm:codex:execute')
    expect(networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: CODEX_PROXY_POLICY,
      namespace: sandboxNamespace,
    })
  })

  it('withdraws scope and egress when the catalog marks the Codex model stale', async () => {
    const { reconciler, coreApi, networkingApi } = createHarness()
    await reconcileRecipe(reconciler, makeCodexSpec())
    expect(issuedScopes()).toContain('llm:codex:execute')

    coreApi.readNamespacedConfigMap.mockResolvedValue(eligibleCodexConfigMap(true))
    runtimeTokenIssuerMocks.issueMcpHostRuntimeTokens.mockClear()
    await reconcileRecipe(reconciler, makeCodexSpec())

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalled()
    expect(issuedScopes()).not.toContain('llm:codex:execute')
    expect(networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: CODEX_PROXY_POLICY,
      namespace: sandboxNamespace,
    })
  })

  it('inherits the parent target and ignores a static child body', async () => {
    const { reconciler, networkingApi } = createHarness()
    reconciler.setCodexReconcileContext({
      recipeName: 'child-run',
      runtimeScopeRecipeName: 'parent-recipe',
      claimedParent: true,
      parentSpec: makeCodexSpec(),
    })

    await reconcileRecipe(
      reconciler,
      makeCodexSpec({ agent: { provider: 'openai', model: 'gpt-5.4-mini' } }),
      'child-run',
      'parent-recipe'
    )

    expect(issuedScopes()).toContain('llm:codex:execute')
    const createdPolicyNames = networkingApi.createNamespacedNetworkPolicy.mock.calls.map(
      call => call[0]?.body?.metadata?.name
    )
    expect(createdPolicyNames).toContain('child-run-mcp-host-to-codex-proxy')
  })

  it('does not mint Codex when a claimed parent fails provenance', async () => {
    const { reconciler, networkingApi } = createHarness()
    reconciler.setCodexReconcileContext({
      recipeName: 'child-run',
      runtimeScopeRecipeName: 'child-run',
      claimedParent: true,
      parentSpec: makeCodexSpec(),
    })

    await reconcileRecipe(reconciler, makeCodexSpec(), 'child-run')

    expect(issuedScopes()).not.toContain('llm:codex:execute')
    expect(
      networkingApi.createNamespacedNetworkPolicy.mock.calls.some(
        call => call[0]?.body?.metadata?.name === 'child-run-mcp-host-to-codex-proxy'
      )
    ).toBe(false)
  })

  it('does not mint Codex scope or egress when the allowlist ConfigMap is forbidden', async () => {
    const { reconciler, coreApi, networkingApi } = createHarness()
    coreApi.readNamespacedConfigMap.mockRejectedValue(
      Object.assign(new Error('forbidden'), { code: 403 })
    )

    await reconcileRecipe(reconciler, makeCodexSpec())

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalled()
    expect(issuedScopes()).not.toContain('llm:codex:execute')
    expect(proxyPolicyBodies(networkingApi)).toEqual([])
    expect(networkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith({
      name: CODEX_PROXY_POLICY,
      namespace: sandboxNamespace,
    })
  })

  it('does not mint Codex scope or egress when the allowlist ConfigMap times out', async () => {
    const { reconciler, coreApi, networkingApi } = createHarness()
    coreApi.readNamespacedConfigMap.mockRejectedValue(
      Object.assign(new Error('Kubernetes request timed out'), { code: 'ETIMEDOUT' })
    )

    await reconcileRecipe(reconciler, makeCodexSpec())

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalled()
    expect(issuedScopes()).not.toContain('llm:codex:execute')
    expect(proxyPolicyBodies(networkingApi)).toEqual([])
    expect(networkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalledWith({
      name: CODEX_PROXY_POLICY,
      namespace: sandboxNamespace,
    })
  })
})
