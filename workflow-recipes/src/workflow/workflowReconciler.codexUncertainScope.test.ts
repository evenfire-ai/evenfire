import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computeCodexPolicyHash } from '@clerum/llm-provider-attempt-contract'
import type { WorkflowRecipeSpec } from '../types'
import { issueMcpHostRuntimeTokens } from './mcpHostRuntimeTokenIssuerClient'
import { WorkflowReconciler, type WorkflowReconcilerDeps } from './workflowReconciler'

const crashRecoveryMocks = vi.hoisted(() => ({
  deletePodIfExists: vi.fn().mockResolvedValue(undefined),
  waitForPodDeletion: vi.fn().mockResolvedValue(true),
  evaluateCompletedRuntimePodRecovery: vi.fn().mockReturnValue({
    action: 'none',
    message: 'healthy',
    newPhase: 'running',
    newAttempt: 0,
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
const RECIPE = 'codex-recipe'
const MODEL = 'gpt-5.3-codex'
const GRANT = 'team-plus'
const CODEX_SCOPE = 'llm:codex:execute'

const EXPECTED_BINDING_HASH = computeCodexPolicyHash({
  model: MODEL,
  catalogRevision: 1,
  credentialRevision: 1,
  connectionKey: GRANT,
})

function unsignedRuntimeJwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.x`
}

function codexConfigMap(status = 'connected') {
  return {
    metadata: {
      resourceVersion: '1',
      annotations: {
        'clerum.io/content-hash': 'aa',
        'clerum.io/catalog-revision': '1',
        'clerum.io/connection-revision': '1',
        'clerum.io/codex-connection-status': status,
        'clerum.io/codex-enabled': 'true',
      },
    },
    data: { 'codex-subscription': JSON.stringify([{ model: MODEL, stale: false }]) },
  }
}

/**
 * A live runtime-token Secret whose JWTs already carry the Codex scope and are
 * far from expiry, so nothing but a scope decision can trigger a remint.
 */
function liveSecretWith(scopes: string[], recipeName = RECIPE) {
  const binding = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    recipeNamespace: sandboxNamespace,
    recipeName,
    hostRefs: [`${sandboxNamespace}/${recipeName}`],
    workflowControlScopes: scopes,
    scopes: [...scopes, 'gfs.read'],
  }
  const jwt = Buffer.from(unsignedRuntimeJwt(binding)).toString('base64')
  return {
    data: {
      'mcp-host-runtime-access-token': jwt,
      'mcp-host-runtime-refresh-token': jwt,
      'mcp-host-workflow-control-token': jwt,
      'mcp-host-gfs-token': Buffer.from(
        unsignedRuntimeJwt({
          ...binding,
          sub: `host:3rd:${sandboxNamespace}/${recipeName}`,
          scopes: ['gfs.read'],
        })
      ).toString('base64'),
    },
  }
}

function codexSdkSpec(overrides: Partial<WorkflowRecipeSpec> = {}): WorkflowRecipeSpec {
  return {
    agent: { provider: 'codex-subscription', model: MODEL },
    steps: [{ id: 'brief', instruction: 'write the brief' }],
    workloads: [{ id: 'sdk-caller', type: 'deployment', image: 'caller:test' }],
    pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['sdk-caller'] },
    ...overrides,
  } as unknown as WorkflowRecipeSpec
}

function createHarness() {
  const coreApi = {
    readNamespacedPod: vi.fn().mockResolvedValue({}),
    readNamespacedSecret: vi.fn().mockRejectedValue({ code: 404 }),
    readNamespacedService: vi.fn().mockRejectedValue({ code: 404 }),
    readNamespacedEndpoints: vi.fn().mockRejectedValue({ code: 404 }),
    readNamespacedConfigMap: vi.fn().mockResolvedValue(codexConfigMap()),
    createNamespacedSecret: vi.fn().mockResolvedValue({}),
    replaceNamespacedSecret: vi.fn().mockResolvedValue({}),
    createNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    createNamespacedService: vi.fn().mockResolvedValue({}),
    createNamespacedPod: vi.fn().mockResolvedValue({}),
    patchNamespacedSecret: vi.fn().mockResolvedValue({}),
    deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
    deleteNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    deleteNamespacedService: vi.fn().mockResolvedValue({}),
    deleteNamespacedPod: vi.fn().mockResolvedValue({}),
    readNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({
      metadata: { name: 'existing-workflow-output', deletionTimestamp: undefined },
    }),
    createNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
    deleteNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
    deleteCollectionNamespacedService: vi.fn().mockResolvedValue({}),
  }
  const networkingApi = {
    createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    readNamespacedNetworkPolicy: vi.fn().mockRejectedValue({ code: 404 }),
    replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    listNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ items: [] }),
  }
  const customApi = {
    patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
  }
  const configure = vi.fn().mockResolvedValue({
    status: 202,
    body: {
      configured: true,
      ready: true,
      provider: 'codex-subscription',
      model: MODEL,
      contractVersion: 3,
      policyReady: true,
      policyState: 'active',
      policyRevision: 1,
      policyHash: 'a'.repeat(64),
      defaultTargetRef: 'primary-codex',
      defaultProvider: 'codex-subscription',
      defaultModel: MODEL,
      codexBinding: {
        connectionKey: GRANT,
        catalogRevision: 1,
        credentialRevision: 1,
        model: MODEL,
        bindingHash: EXPECTED_BINDING_HASH,
      },
    },
  })
  const deps = {
    coreApi,
    customApi,
    networkingApi,
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
      pluginWorkloadSdkEnabled: true,
    },
    tokenFactory: {
      signWrcConfigureToken: vi.fn().mockResolvedValue('wrc-configure-token'),
      signWrcArtifactDeleteToken: vi.fn().mockResolvedValue('stub-token'),
      signCoordinatorToMcpHostToken: vi.fn().mockResolvedValue('coordinator-mcp-host-token'),
      signCoordinatorToWrcToken: vi.fn().mockResolvedValue('coordinator-wrc-token'),
      signCustomCoordinatorToWrcToken: vi.fn().mockResolvedValue('custom-coordinator-wrc-token'),
    },
    modelConfigHandler: { configurePluginWorkloadSdkBootstrap: configure },
    pluginWorkloadSdkRevocationClient: {
      revoke: vi.fn().mockResolvedValue({ state: 'missing', revoked: 0, fencedInvocations: 0 }),
      finalize: vi.fn(),
    },
  } as unknown as WorkflowReconcilerDeps

  const reconciler = new WorkflowReconciler(deps)
  return { reconciler, coreApi, networkingApi, configure }
}

function bindGrant(reconciler: WorkflowReconciler, recipeName = RECIPE, connectionKey = GRANT) {
  reconciler.setCodexReconcileContext({
    recipeUid: `uid-${recipeName}`,
    recipeName,
    runtimeScopeRecipeName: recipeName,
    claimedParent: false,
    parentSpec: null,
    connectionKey,
  })
}

function reconcileRecipe(
  reconciler: WorkflowReconciler,
  spec: WorkflowRecipeSpec,
  recipeName = RECIPE
) {
  return reconciler.reconcile(
    recipeName,
    `uid-${recipeName}`,
    sandboxNamespace,
    spec,
    { workflowExecution: { phase: 'initializing' } },
    undefined,
    recipeName,
    undefined
  )
}

function issuedScopes(): string[] {
  const last = runtimeTokenIssuerMocks.issueMcpHostRuntimeTokens.mock.calls.at(-1)
  return (last?.[2] ?? []) as string[]
}

/**
 * The eager mcp-host Pod body WRC actually built, or undefined if the reconcile
 * never got that far. Every test below asserts on it before its own subject:
 * a reconcile that dies early satisfies "did not remint" and "did not roll"
 * for entirely the wrong reason.
 */
function builtMcpHostPodFrom(coreApi: {
  createNamespacedPod: { mock: { calls: Array<[{ body?: { metadata?: { name?: string } } }]> } }
}) {
  return coreApi.createNamespacedPod.mock.calls
    .map(call => call[0]?.body)
    .find(body => body?.metadata?.name === `${RECIPE}-mcp-host`)
}

describe('Codex scope under an undecidable catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    crashRecoveryMocks.getPodPhase.mockResolvedValue(undefined)
    crashRecoveryMocks.getPodReadiness.mockResolvedValue({
      ready: true,
      phase: 'Running',
      uid: 'pod-uid-1',
    })
    crashRecoveryMocks.isRecoverableContainerWaitingReason.mockReturnValue(false)
    runtimeTokenIssuerMocks.issueMcpHostRuntimeTokens.mockResolvedValue({
      accessToken: 'runtime-access-token',
      refreshToken: 'runtime-refresh-token',
      mcpHostControlToken: 'mcp-host-control-token',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 204 } as unknown as Response)
    )
  })

  it('does not remint or roll when the allowlist read fails and the JWT already holds the scope', async () => {
    // N-04. An unreadable ConfigMap yields an empty derivedScopes, which is
    // indistinguishable from a revocation. Treating it as one remints with
    // reason 'scope', which rolls the eager pod and drops its bootstrap proof —
    // then rolls it a SECOND time when the ConfigMap comes back. No policy
    // changed, so nothing may change.
    const { reconciler, coreApi } = createHarness()
    bindGrant(reconciler)
    coreApi.readNamespacedSecret.mockResolvedValue(
      liveSecretWith(['plugin-workload-sdk', CODEX_SCOPE])
    )
    coreApi.readNamespacedConfigMap.mockRejectedValue(
      Object.assign(new Error('Kubernetes request timed out'), { code: 'ETIMEDOUT' })
    )

    await reconcileRecipe(reconciler, codexSdkSpec())

    // Positive evidence first: the reconcile really reached eager provisioning,
    // so the negative assertions below mean "chose not to", not "never got there".
    expect(builtMcpHostPodFrom(coreApi)).toBeDefined()
    expect(issueMcpHostRuntimeTokens).not.toHaveBeenCalled()
    expect(coreApi.patchNamespacedSecret).not.toHaveBeenCalled()
    expect(crashRecoveryMocks.deletePodIfExists).not.toHaveBeenCalledWith(
      expect.anything(),
      `${RECIPE}-mcp-host`,
      sandboxNamespace
    )
  })

  it('still withdraws the scope and rolls the pod when a readable catalog revokes the grant', async () => {
    // The other half of the same rule: `uncertain` preserves, but a decision
    // decides. If this ever stops rolling, N-04's fix has swallowed the
    // revocation path it was explicitly required not to mask.
    //
    // The steady-state pass in the middle is the control: it runs against the
    // very pod WRC built, so it drifts on nothing. A delete appearing only
    // after the grant is revoked can therefore only come from the scope remint.
    const { reconciler, coreApi } = createHarness()
    bindGrant(reconciler)
    coreApi.readNamespacedSecret.mockResolvedValue(
      liveSecretWith(['plugin-workload-sdk', CODEX_SCOPE])
    )

    await reconcileRecipe(reconciler, codexSdkSpec())
    const builtMcpHostPod = builtMcpHostPodFrom(coreApi)

    coreApi.readNamespacedPod.mockImplementation(async (params: { name?: string }) =>
      params.name === `${RECIPE}-mcp-host` ? builtMcpHostPod : {}
    )
    crashRecoveryMocks.getPodPhase.mockImplementation(async (_api: unknown, name: string) =>
      name === `${RECIPE}-mcp-host` ? 'Running' : undefined
    )

    // Control: the catalog still grants, the pod is the one WRC built.
    crashRecoveryMocks.deletePodIfExists.mockClear()
    await reconcileRecipe(reconciler, codexSdkSpec())
    expect(crashRecoveryMocks.deletePodIfExists).not.toHaveBeenCalledWith(
      expect.anything(),
      `${RECIPE}-mcp-host`,
      sandboxNamespace
    )

    // Revocation: readable ConfigMap, connection degraded.
    coreApi.readNamespacedConfigMap.mockResolvedValue(codexConfigMap('reauth-required'))
    runtimeTokenIssuerMocks.issueMcpHostRuntimeTokens.mockClear()
    coreApi.patchNamespacedSecret.mockClear()

    await reconcileRecipe(reconciler, codexSdkSpec())

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalled()
    expect(issuedScopes()).not.toContain(CODEX_SCOPE)
    const patch = coreApi.patchNamespacedSecret.mock.calls.at(-1)?.[0] as {
      body?: { metadata?: { annotations?: Record<string, string> } }
    }
    expect(
      patch?.body?.metadata?.annotations?.['clerum.io/mcp-host-runtime-token-generation']
    ).toBe('1')
    expect(crashRecoveryMocks.deletePodIfExists).toHaveBeenCalledWith(
      expect.anything(),
      `${RECIPE}-mcp-host`,
      sandboxNamespace
    )
  })

  it('preserves only the Codex scope, never an unrelated one', async () => {
    // The preservation is surgical. A JWT carrying a workflow scope the spec no
    // longer declares must still be reminted while the catalog is unreadable.
    const { reconciler, coreApi } = createHarness()
    bindGrant(reconciler)
    coreApi.readNamespacedSecret.mockResolvedValue(
      liveSecretWith(['plugin-workload-sdk', 'workflow:list', CODEX_SCOPE])
    )
    coreApi.readNamespacedConfigMap.mockRejectedValue(
      Object.assign(new Error('forbidden'), { code: 403 })
    )

    await reconcileRecipe(reconciler, codexSdkSpec())

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalled()
    expect(issuedScopes()).toContain(CODEX_SCOPE)
    expect(issuedScopes()).not.toContain('workflow:list')
  })

  it('mints without the Codex scope on the first mint under an unreadable catalog', async () => {
    // Nothing to preserve on a 404: fail closed. The scope arrives on the first
    // reconcile that can actually read the catalog.
    const { reconciler, coreApi } = createHarness()
    bindGrant(reconciler)
    coreApi.readNamespacedConfigMap.mockRejectedValue(
      Object.assign(new Error('Kubernetes request timed out'), { code: 'ETIMEDOUT' })
    )

    await reconcileRecipe(reconciler, codexSdkSpec())

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalled()
    expect(issuedScopes()).not.toContain(CODEX_SCOPE)
  })
})

describe('Codex allowlist view across interleaved recipes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    crashRecoveryMocks.getPodPhase.mockResolvedValue(undefined)
    crashRecoveryMocks.getPodReadiness.mockResolvedValue({
      ready: true,
      phase: 'Running',
      uid: 'pod-uid-1',
    })
    crashRecoveryMocks.isRecoverableContainerWaitingReason.mockReturnValue(false)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 204 } as unknown as Response)
    )
  })

  it('configures with its OWN binding when another recipe wipes the shared view mid-reconcile', async () => {
    // N-08. Recipe B captured a readable catalog; while B is inside
    // ensureEagerSdkMcpHost, recipe A's refresh fails and clears the shared
    // state. Resolving the binding from that shared state after the awaits gave
    // B a null binding while `codexBindingUndecidable` still said false — a
    // binding-less v3 configure that wipes the live host binding. B must
    // configure from the view it captured, or not configure at all.
    const { reconciler, coreApi, configure } = createHarness()
    bindGrant(reconciler, RECIPE)
    bindGrant(reconciler, 'other-recipe', 'personal-pro')

    let interleaved = false
    coreApi.createNamespacedService.mockImplementation(async () => {
      if (!interleaved) {
        interleaved = true
        // Recipe A reconciles on the same controller and its ConfigMap read
        // fails, clearing the shared allowlist state under B's feet.
        coreApi.readNamespacedConfigMap.mockRejectedValue(
          Object.assign(new Error('Kubernetes request timed out'), { code: 'ETIMEDOUT' })
        )
        await reconciler.reconcilePluginWorkloadSdkOnly(
          'other-recipe',
          'uid-other-recipe',
          sandboxNamespace,
          codexSdkSpec({ steps: undefined }),
          'other-recipe'
        )
      }
      return {}
    })

    await reconcileRecipe(reconciler, codexSdkSpec())

    expect(interleaved).toBe(true)
    const codexRecipeConfigure = configure.mock.calls.filter(call =>
      String(call[2]).includes(RECIPE)
    )
    expect(codexRecipeConfigure).toHaveLength(1)
    expect(codexRecipeConfigure[0][5]).toEqual({
      connectionKey: GRANT,
      catalogRevision: 1,
      credentialRevision: 1,
      model: MODEL,
      bindingHash: EXPECTED_BINDING_HASH,
    })
  })
})
