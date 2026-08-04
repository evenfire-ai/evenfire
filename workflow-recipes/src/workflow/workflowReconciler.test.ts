import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  isRecoverableContainerWaitingReason: vi.fn(
    (phase: string | undefined, reason: string | undefined) =>
      Boolean(
        reason &&
        [
          'CreateContainerConfigError',
          'CreateContainerError',
          'ImagePullBackOff',
          'ErrImagePull',
          'InvalidImageName',
          'CrashLoopBackOff',
        ].includes(reason) &&
        (phase === 'Pending' || (phase === 'Running' && reason === 'CrashLoopBackOff'))
      )
  ),
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

const gfsBindingMocks = vi.hoisted(() => ({
  mintRecipeHostGfsToken: vi.fn().mockResolvedValue({
    ['to'.concat('ken')]: 'gfs-runtime-value',
    expiresInSeconds: 300,
    subject: 'host:3rd:sandbox-recipes/workflow-recipe',
  }),
}))

vi.mock('../gfsBinding', () => gfsBindingMocks)

const isoDateAgo = (ageMs: number) => new Date(Date.now() - ageMs).toISOString()

function unsignedRuntimeJwt(payload: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.x`
}

type MockPodReadiness = {
  ready: boolean
  phase?: string
  uid?: string
  waitingReason?: string
  schedulingReason?: string
}

function mockAgenticOutputPodPhases(overrides?: {
  anchor?: string
  prepare?: string
  mcpHost?: string | (() => string | undefined)
}) {
  crashRecoveryMocks.getPodPhase.mockImplementation(async (_api, name: string) => {
    if (name === 'agentic-recipe-workflow-output-anchor') {
      return overrides?.anchor ?? 'Running'
    }
    if (name === 'agentic-recipe-workflow-output-prepare') {
      return overrides?.prepare ?? 'Succeeded'
    }
    if (name === 'agentic-recipe-mcp-host') {
      const value = overrides?.mcpHost
      return typeof value === 'function' ? value() : (value ?? undefined)
    }
    return undefined
  })
}

function mockMcpHostReadiness(readiness: MockPodReadiness) {
  crashRecoveryMocks.getPodReadiness.mockImplementation(async (_api, podName: string) => {
    if (podName.endsWith('-mcp-host')) {
      return readiness
    }
    return { ready: true, phase: 'Running' }
  })
}

function mockMcpHostReadinessSequence(...sequence: MockPodReadiness[]) {
  let mcpHostCalls = 0
  crashRecoveryMocks.getPodReadiness.mockImplementation(async (_api, podName: string) => {
    if (podName.endsWith('-mcp-host')) {
      const value = sequence[Math.min(mcpHostCalls, sequence.length - 1)]
      mcpHostCalls += 1
      return value
    }
    return { ready: true, phase: 'Running' }
  })
}

describe('WorkflowReconciler.reconcileDelete — orphaned Service cleanup', () => {
  const sandboxNamespace = 'sandbox-recipes'
  const mcpServerNamespace = 'mcp-server'

  const mockCoreApi = {
    readNamespacedPod: vi.fn().mockResolvedValue({}),
    readNamespacedSecret: vi.fn().mockRejectedValue({ code: 404 }),
    readNamespacedService: vi.fn().mockResolvedValue({}),
    readNamespacedEndpoints: vi.fn().mockRejectedValue({ code: 404 }),
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
    // Under test: new label-selector cleanup for cross-namespace-orphaned Services.
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

  // Minimal token factory for the mcp-host artifact cleanup path.
  const mockTokenFactory = {
    signWrcArtifactDeleteToken: vi.fn().mockResolvedValue('stub-token'),
    signCoordinatorToMcpHostToken: vi.fn().mockResolvedValue('coordinator-mcp-host-token'),
    signCustomCoordinatorToWrcToken: vi.fn().mockResolvedValue('custom-coordinator-wrc-token'),
    signCoordinatorToWrcToken: vi.fn().mockResolvedValue('coordinator-wrc-token'),
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
      mcpServerNamespace,
      imagePullPolicy: 'IfNotPresent' as const,
      maxWorkflowSteps: 100,
      runtimeTokenTtlSeconds: 3600,
      runtimeTokenRefreshBeforeSeconds: 300,
    },
    tokenFactory: mockTokenFactory,
    pluginWorkloadSdkRevocationClient: {
      revoke: vi.fn().mockResolvedValue({ state: 'missing', revoked: 0, fencedInvocations: 0 }),
      finalize: vi.fn(),
    },
  } as unknown as WorkflowReconcilerDeps

  beforeEach(() => {
    vi.clearAllMocks()
    crashRecoveryMocks.getContainerWaitingReason.mockResolvedValue(undefined)
    crashRecoveryMocks.getPodPhase.mockResolvedValue(undefined)
    crashRecoveryMocks.getPodReadiness.mockResolvedValue({
      ready: true,
      phase: 'Running',
      uid: 'pod-uid-1',
    })
    // Run-scoped reconciles skip the eager→run recreate gate when the mcp-host already
    // carries the workflow-output claim label.
    mockCoreApi.readNamespacedPod.mockImplementation(async (params: { name?: string }) => {
      if (typeof params.name === 'string' && params.name.endsWith('-mcp-host')) {
        return {
          metadata: {
            labels: { 'clerum.io/workflow-output-claim': 'shared-output' },
          },
        }
      }
      return {}
    })
    mockCoreApi.readNamespacedSecret.mockRejectedValue({ code: 404 })
    mockCoreApi.readNamespacedService.mockResolvedValue({})
    mockCoreApi.createNamespacedSecret.mockResolvedValue({})
    mockCoreApi.createNamespacedConfigMap.mockResolvedValue({})
    mockCoreApi.createNamespacedService.mockResolvedValue({})
    mockCoreApi.createNamespacedPod.mockResolvedValue({})
    mockCoreApi.patchNamespacedSecret.mockResolvedValue({})
    mockNetworkingApi.createNamespacedNetworkPolicy.mockResolvedValue({})
    mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue({
      metadata: { resourceVersion: '1' },
    })
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockResolvedValue({})
    mockNetworkingApi.deleteNamespacedNetworkPolicy.mockResolvedValue({})
    mockNetworkingApi.listNamespacedNetworkPolicy.mockResolvedValue({ items: [] })
    mockCustomApi.patchNamespacedCustomObject.mockResolvedValue({})
    mockCustomApi.patchNamespacedCustomObjectStatus.mockResolvedValue({})
    crashRecoveryMocks.evaluateCrashRecovery.mockReturnValue({
      action: 'none',
      message: 'Pod is healthy',
    })
    crashRecoveryMocks.evaluateCompletedRuntimePodRecovery.mockReturnValue({
      action: 'replace',
      message:
        'mcp_host pod completed before workflow became terminal; creating replacement (attempt 1/3)',
      newPhase: 'recovering',
      newAttempt: 1,
    })
    crashRecoveryMocks.getContainerWaitingReason.mockResolvedValue(undefined)
    crashRecoveryMocks.getPodPhase.mockResolvedValue(undefined)
    crashRecoveryMocks.getPodReadiness.mockResolvedValue({
      ready: true,
      phase: 'Running',
      uid: 'pod-uid-1',
    })
    crashRecoveryMocks.isRecoverableContainerWaitingReason.mockImplementation(
      (phase: string | undefined, reason: string | undefined) =>
        Boolean(
          reason &&
          [
            'CreateContainerConfigError',
            'CreateContainerError',
            'ImagePullBackOff',
            'ErrImagePull',
            'InvalidImageName',
            'CrashLoopBackOff',
          ].includes(reason) &&
          (phase === 'Pending' || (phase === 'Running' && reason === 'CrashLoopBackOff'))
        )
    )
    runtimeTokenIssuerMocks.issueMcpHostRuntimeTokens.mockResolvedValue({
      accessToken: 'runtime-access-token',
      refreshToken: 'runtime-refresh-token',
      mcpHostControlToken: 'mcp-host-control-token',
    })
    runtimeTokenIssuerMocks.issueMcpHostWorkflowControlToken.mockResolvedValue(
      'mcp-host-control-token'
    )
    // Stub global.fetch used by cleanupRecipeArtifacts (best-effort).
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 204 } as unknown as Response)
    )
  })

  it('stores inherited child mcp-host control credentials with the runtime-scope caller', async () => {
    const reconciler = new WorkflowReconciler(deps)
    runtimeTokenIssuerMocks.issueMcpHostRuntimeTokens.mockResolvedValueOnce({
      accessToken: 'parent-runtime-access-token',
      refreshToken: 'parent-runtime-refresh-token',
      mcpHostControlToken: 'parent-workflow-control-token',
    })
    runtimeTokenIssuerMocks.issueMcpHostWorkflowControlToken.mockResolvedValueOnce(
      'child-workflow-control-token'
    )

    await reconciler.ensureMcpHostRuntimeCredentials(
      sandboxNamespace,
      'child-run',
      { steps: [{ id: 'step-1', instruction: 'run with tools' }] },
      'parent-recipe'
    )

    expect(runtimeTokenIssuerMocks.issueMcpHostRuntimeTokens).toHaveBeenCalledWith(
      sandboxNamespace,
      'parent-recipe',
      []
    )
    expect(runtimeTokenIssuerMocks.issueMcpHostWorkflowControlToken).not.toHaveBeenCalled()
    const createCall = mockCoreApi.createNamespacedSecret.mock.calls[0]?.[0] as {
      body?: { data?: Record<string, string> }
    }
    expect(
      Buffer.from(
        createCall.body?.data?.['mcp-host-workflow-control-token'] ?? '',
        'base64'
      ).toString('utf-8')
    ).toBe('parent-workflow-control-token')
  })

  it('mints read-scoped GFS credentials for recipe hosts by default', async () => {
    const reconciler = new WorkflowReconciler(deps)

    await reconciler.ensureMcpHostRuntimeCredentials(sandboxNamespace, 'read-recipe', {
      steps: [{ id: 'step-1', instruction: 'read inputs' }],
    })

    expect(gfsBindingMocks.mintRecipeHostGfsToken).toHaveBeenCalledWith(
      sandboxNamespace,
      'read-recipe',
      { scopes: ['gfs.read'] }
    )
  })

  it('mints exactly read scope when a recipe mount is read-only', async () => {
    const reconciler = new WorkflowReconciler(deps)

    await reconciler.ensureMcpHostRuntimeCredentials(sandboxNamespace, 'read-mount-recipe', {
      steps: [{ id: 'step-1', instruction: 'read mounted inputs' }],
      gfs: {
        mounts: [{ drive: 'main', target: 'inputs', scopes: ['gfs.read'] }],
      },
    })

    expect(gfsBindingMocks.mintRecipeHostGfsToken).toHaveBeenCalledTimes(1)
    expect(gfsBindingMocks.mintRecipeHostGfsToken).toHaveBeenCalledWith(
      sandboxNamespace,
      'read-mount-recipe',
      { scopes: ['gfs.read'] }
    )
  })

  it('keeps the read ceiling and adds write when a recipe mount is write-only', async () => {
    const reconciler = new WorkflowReconciler(deps)

    await reconciler.ensureMcpHostRuntimeCredentials(sandboxNamespace, 'write-mount-recipe', {
      steps: [{ id: 'step-1', instruction: 'write mounted outputs' }],
      gfs: {
        mounts: [{ drive: 'main', target: 'outputs', scopes: ['gfs.write'] }],
      },
    })

    expect(gfsBindingMocks.mintRecipeHostGfsToken).toHaveBeenCalledTimes(1)
    expect(gfsBindingMocks.mintRecipeHostGfsToken).toHaveBeenCalledWith(
      sandboxNamespace,
      'write-mount-recipe',
      { scopes: ['gfs.read', 'gfs.write'] }
    )
  })

  it('orders and de-duplicates read-write mount scopes before minting', async () => {
    const reconciler = new WorkflowReconciler(deps)

    await reconciler.ensureMcpHostRuntimeCredentials(sandboxNamespace, 'read-write-mount-recipe', {
      steps: [{ id: 'step-1', instruction: 'read and write mounted content' }],
      gfs: {
        mounts: [
          {
            drive: 'main',
            target: 'workspace',
            scopes: ['gfs.write', 'gfs.read', 'gfs.write'],
          },
        ],
      },
    })

    expect(gfsBindingMocks.mintRecipeHostGfsToken).toHaveBeenCalledTimes(1)
    expect(gfsBindingMocks.mintRecipeHostGfsToken).toHaveBeenCalledWith(
      sandboxNamespace,
      'read-write-mount-recipe',
      { scopes: ['gfs.read', 'gfs.write'] }
    )
  })

  it('mints inherited child GFS scopes against the parent runtime identity', async () => {
    const reconciler = new WorkflowReconciler(deps)

    await reconciler.ensureMcpHostRuntimeCredentials(
      sandboxNamespace,
      'child-run',
      {
        steps: [{ id: 'step-1', instruction: 'use the parent grant' }],
        gfs: {
          mounts: [
            {
              drive: 'main',
              target: 'workspace',
              scopes: ['gfs.read', 'gfs.write'],
            },
          ],
        },
      },
      'parent-recipe'
    )

    expect(gfsBindingMocks.mintRecipeHostGfsToken).toHaveBeenCalledTimes(1)
    expect(gfsBindingMocks.mintRecipeHostGfsToken).toHaveBeenCalledWith(
      sandboxNamespace,
      'parent-recipe',
      { scopes: ['gfs.read', 'gfs.write'] }
    )
  })

  it('mints write-scoped GFS credentials when the recipe declares publish targets', async () => {
    const reconciler = new WorkflowReconciler(deps)

    await reconciler.ensureMcpHostRuntimeCredentials(sandboxNamespace, 'publish-recipe', {
      steps: [{ id: 'step-1', instruction: 'publish output' }],
      gfs: {
        publishTargets: [{ drive: 'main', target: 'outputs' }],
      },
    })

    expect(gfsBindingMocks.mintRecipeHostGfsToken).toHaveBeenCalledWith(
      sandboxNamespace,
      'publish-recipe',
      { scopes: ['gfs.read', 'gfs.write'] }
    )
  })

  it('deletes transport Services in mcp-server by label selector (agentic path, cross-namespace orphans)', async () => {
    const reconciler = new WorkflowReconciler(deps)
    const recipeName = 'my-agentic-recipe'

    await reconciler.reconcileDelete(recipeName, sandboxNamespace)

    // The new cleanup call: mcp-server namespace + composite label selector
    // matching what `buildService()` actually emits on Services (NOT `wrc`,
    // which is only on NetworkPolicies built by workflowReconciler itself).
    expect(mockCoreApi.deleteCollectionNamespacedService).toHaveBeenCalledTimes(1)
    expect(mockCoreApi.deleteCollectionNamespacedService).toHaveBeenCalledWith({
      namespace: mcpServerNamespace,
      labelSelector: `clerum.io/recipe=${recipeName},clerum.io/managed-by=workflow-recipes`,
    })
  })

  it('still deletes per-mcp-server NetworkPolicies by label selector without deletecollection', async () => {
    const reconciler = new WorkflowReconciler(deps)
    const recipeName = 'my-agentic-recipe'
    mockNetworkingApi.listNamespacedNetworkPolicy.mockImplementation(({ namespace }) =>
      Promise.resolve({
        items:
          namespace === mcpServerNamespace
            ? [{ metadata: { name: `${recipeName}-dynamic-mcp-ingress` } }]
            : [],
      })
    )

    await reconciler.reconcileDelete(recipeName, sandboxNamespace)

    expect(mockNetworkingApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
      namespace: mcpServerNamespace,
      labelSelector: `clerum.io/recipe=${recipeName},clerum.io/managed-by=wrc`,
    })
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: `${recipeName}-dynamic-mcp-ingress`,
      namespace: mcpServerNamespace,
    })
  })

  it('deletes WRC-managed sandbox NetworkPolicies by recipe label for dynamic snippet policy names', async () => {
    const reconciler = new WorkflowReconciler(deps)
    const recipeName = 'my-snippet-recipe'
    mockNetworkingApi.listNamespacedNetworkPolicy.mockImplementation(({ namespace }) =>
      Promise.resolve({
        items:
          namespace === sandboxNamespace
            ? [{ metadata: { name: `${recipeName}-dynamic-snippet-ingress` } }]
            : [],
      })
    )

    await reconciler.reconcileDelete(recipeName, sandboxNamespace)

    expect(mockNetworkingApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
      namespace: sandboxNamespace,
      labelSelector: `clerum.io/recipe=${recipeName},clerum.io/managed-by=wrc`,
    })
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: `${recipeName}-dynamic-snippet-ingress`,
      namespace: sandboxNamespace,
    })
  })

  it('prefers artifact-reader HTTP artifact cleanup when the artifact-reader Service exists', async () => {
    const reconciler = new WorkflowReconciler(deps)
    const recipeName = 'agentic-recipe'

    await reconciler.reconcileDelete(recipeName, sandboxNamespace)

    expect(mockTokenFactory.signWrcArtifactDeleteToken).toHaveBeenCalledWith(
      recipeName,
      sandboxNamespace
    )
    expect(fetch).toHaveBeenCalledWith(
      `http://wf-${recipeName}-artifact-reader.${sandboxNamespace}.svc.cluster.local:8080/api/v1/workflow/artifacts`,
      expect.objectContaining({
        method: 'DELETE',
        headers: { authorization: 'Bearer stub-token' },
      })
    )
  })

  it('accepts snippet secretRef without requiring a matching spec.resources secret placeholder', () => {
    const reconciler = new WorkflowReconciler(deps)

    const error = reconciler.validateWorkflowSpec({
      steps: [
        {
          id: 'fetch-price',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return { ok: true }',
            capabilities: {
              secrets: [
                {
                  alias: 'coingecko_api_key',
                  secretRef: { name: 'coingecko-api', key: 'apiKey' },
                },
              ],
            },
          },
        },
      ],
    })

    expect(error).toBeUndefined()
  })

  it('rejects snippet secretRef entries that point at platform-managed workflow Secrets', () => {
    const reconciler = new WorkflowReconciler(deps)

    const error = reconciler.validateWorkflowSpec({
      steps: [
        {
          id: 'read-runtime-token',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return { ok: true }',
            capabilities: {
              secrets: [
                {
                  alias: 'runtime_token',
                  secretRef: { name: 'wf-example-coordinator-token', key: 'token' },
                },
              ],
            },
          },
        },
      ],
    })

    expect(error).toBe(
      'step "read-runtime-token" cannot reference platform-managed secret "wf-example-coordinator-token"'
    )
  })

  it('does not reject user-managed snippet Secrets only because their name mentions coordinator-token', () => {
    const reconciler = new WorkflowReconciler(deps)

    const error = reconciler.validateWorkflowSpec({
      steps: [
        {
          id: 'read-api-key',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return { ok: true }',
            capabilities: {
              secrets: [
                {
                  alias: 'api_key',
                  secretRef: { name: 'api-coordinator-token-rotator', key: 'token' },
                },
              ],
            },
          },
        },
      ],
    })

    expect(error).toBeUndefined()
  })

  it('fails workflow reconcile before pod creation when a snippet secretRef Secret is missing', async () => {
    mockCoreApi.readNamespacedSecret.mockRejectedValueOnce({ code: 404 })
    const reconciler = new WorkflowReconciler(deps)

    const result = await reconciler.reconcile('snippet-recipe', 'uid-snippet', sandboxNamespace, {
      steps: [
        {
          id: 'fetch-price',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return { ok: true }',
            capabilities: {
              secrets: [
                {
                  alias: 'coingecko_api_key',
                  secretRef: { name: 'coingecko-api', key: 'apiKey' },
                },
              ],
            },
          },
        },
      ],
    })

    expect(result).toMatchObject({
      phase: 'failed',
      workflowPhase: 'failed',
      message: 'snippet secret "coingecko-api" was not found in namespace "sandbox-recipes"',
    })
    expect(mockCoreApi.readNamespacedSecret).toHaveBeenCalledWith({
      name: 'coingecko-api',
      namespace: sandboxNamespace,
    })
  })

  it('resolves snippet resource ids through status.resourceInstances before validating access', async () => {
    mockCoreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { labels: { 'clerum.io/owner-recipe': 'snippet-recipe' } },
      data: Object.fromEntries([['pass', 'present']]),
    })
    const reconciler = new WorkflowReconciler(deps)

    const result = await reconciler.reconcile(
      'snippet-recipe',
      'uid-snippet',
      sandboxNamespace,
      {
        resources: [{ id: 'pg-auth', type: 'secret', data: { pass: 'redacted' } }],
        steps: [
          {
            id: 'query-postgres',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return { ok: true }',
              capabilities: {
                secrets: [{ alias: 'pg', secretRef: { name: 'pg-auth', key: 'pass' } }],
              },
            },
          },
        ],
      },
      { resourceInstances: { 'pg-auth': 'snippet-recipe-pg-auth-d07f008b65ec' } }
    )

    expect(result.phase).toBe('deploying')
    expect(mockCoreApi.readNamespacedSecret).toHaveBeenCalledWith({
      name: 'snippet-recipe-pg-auth-d07f008b65ec',
      namespace: sandboxNamespace,
    })
  })

  it('preserves workflow status and signals skipStatusPatch on a transient infra error (no terminal failure)', async () => {
    const reconciler = new WorkflowReconciler(deps)
    // First call inside the reconcile try (getPodPhase) hits a transient API blip.
    crashRecoveryMocks.getPodPhase.mockRejectedValueOnce(
      Object.assign(new Error('connect ETIMEDOUT 10.96.0.1:443'), { code: 'ETIMEDOUT' })
    )

    const result = await reconciler.reconcile(
      'flaky-workflow',
      'uid-flaky',
      sandboxNamespace,
      {
        steps: [
          { id: 'render', run: { type: 'snippet', language: 'typescript', code: 'return {}' } },
        ],
      },
      { workflowExecution: { phase: 'recovering', message: 'prior transient blip' } }
    )

    // Must NOT latch the workflow to terminal failed.
    expect(result.phase).not.toBe('failed')
    expect(result.workflowPhase).not.toBe('failed')
    // Preserves the current execution phase + message and tells WRC to skip the patch.
    expect(result.skipStatusPatch).toBe(true)
    expect(result.workflowPhase).toBe('recovering')
    expect(result.message).toBe('prior transient blip')
    // No status patch was written for the transient blip.
    expect(mockCustomApi.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })

  it('fails workflow reconcile before pod creation when a snippet secretRef key is missing', async () => {
    // Owned by the recipe (passes the Issue #637 ownership gate) but the key is
    // absent — so the failure must be the key-missing message, not ownership.
    mockCoreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { labels: { 'clerum.io/owner-recipe': 'snippet-recipe' } },
      data: { otherKey: 'dmFsdWU=' },
    })
    const reconciler = new WorkflowReconciler(deps)

    const result = await reconciler.reconcile('snippet-recipe', 'uid-snippet', sandboxNamespace, {
      steps: [
        {
          id: 'fetch-price',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return { ok: true }',
            capabilities: {
              secrets: [
                {
                  alias: 'coingecko_api_key',
                  secretRef: { name: 'coingecko-api', key: 'apiKey' },
                },
              ],
            },
          },
        },
      ],
    })

    expect(result).toMatchObject({
      phase: 'failed',
      workflowPhase: 'failed',
      message:
        'snippet secret key "apiKey" was not found in Secret "coingecko-api" in namespace "sandbox-recipes"',
    })
  })

  it('fails workflow reconcile before pod creation when a snippet secretRef Secret is owned by another recipe (Issue #637)', async () => {
    // The Secret EXISTS and HAS the requested key, but it is owned by a DIFFERENT
    // recipe — the snippet runner pod must never be created with a foreign credential.
    mockCoreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { labels: { 'clerum.io/owner-recipe': 'victim-recipe' } },
      data: { apiKey: 'c3RvbGVu' },
    })
    const reconciler = new WorkflowReconciler(deps)

    const result = await reconciler.reconcile('attacker-recipe', 'uid-attacker', sandboxNamespace, {
      steps: [
        {
          id: 'fetch-price',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return { ok: true }',
            capabilities: {
              secrets: [
                {
                  alias: 'coingecko_api_key',
                  secretRef: { name: 'coingecko-api', key: 'apiKey' },
                },
              ],
            },
          },
        },
      ],
    })

    expect(result).toMatchObject({
      phase: 'failed',
      workflowPhase: 'failed',
      message:
        'snippet secret "coingecko-api" is not accessible to recipe "attacker-recipe" — ' +
        'it requires clerum.io/shared=true or clerum.io/owner-recipe=attacker-recipe',
    })
    // No snippet-runner pod was created for the denied recipe.
    expect(mockCoreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('skips artifact HTTP cleanup when neither artifact-reader nor mcp-host Service exists', async () => {
    mockCoreApi.readNamespacedService.mockRejectedValue({ code: 404 })
    const reconciler = new WorkflowReconciler(deps)
    const recipeName = 'pure-custom-recipe'

    await reconciler.reconcileDelete(recipeName, sandboxNamespace)

    expect(mockCoreApi.readNamespacedService).toHaveBeenCalledWith({
      name: `wf-${recipeName}-artifact-reader`,
      namespace: sandboxNamespace,
    })
    expect(mockCoreApi.readNamespacedService).toHaveBeenCalledWith({
      name: `wf-${recipeName}-mcp-host`,
      namespace: sandboxNamespace,
    })
    expect(mockTokenFactory.signWrcArtifactDeleteToken).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).toHaveBeenCalledWith({
      name: `${recipeName}-workflow-output`,
      namespace: sandboxNamespace,
    })
  })

  it('gates coordinator creation while the mcp-host pod is still waiting for scheduling', async () => {
    crashRecoveryMocks.getPodPhase.mockImplementation(async (_api, name: string) => {
      if (name === 'agentic-recipe-workflow-output-anchor') return 'Running'
      if (name === 'agentic-recipe-workflow-output-prepare') return 'Succeeded'
      return undefined
    })
    crashRecoveryMocks.getPodReadiness.mockResolvedValueOnce({
      ready: false,
      phase: 'Pending',
      schedulingReason: 'Unschedulable',
    })
    const reconciler = new WorkflowReconciler(deps)

    const result = await reconciler.reconcile(
      'agentic-recipe',
      'uid-agentic',
      sandboxNamespace,
      {
        agent: { provider: 'openai', model: 'gpt-4.1' },
        steps: [{ id: 'brief', instruction: 'write the brief' }],
      },
      { workflowExecution: { phase: 'initializing' } },
      undefined,
      'agentic-recipe',
      'run-1'
    )

    expect(result).toMatchObject({
      phase: 'deploying',
      workflowPhase: 'initializing',
    })
    expect(result.message).toContain('Waiting for mcp-host pod to become Ready')
    const podNames = mockCoreApi.createNamespacedPod.mock.calls.map(
      call => call[0].body.metadata.name
    )
    expect(podNames).toContain('agentic-recipe-mcp-host')
    expect(podNames).not.toContain('agentic-recipe-coordinator')
  })

  it('preserves required toolChoice in the workflow config ConfigMap', async () => {
    crashRecoveryMocks.getPodPhase.mockImplementation(async (_api, name: string) => {
      if (name === 'tool-choice-recipe-workflow-output-anchor') return 'Running'
      if (name === 'tool-choice-recipe-workflow-output-prepare') return 'Succeeded'
      return undefined
    })
    mockMcpHostReadiness({ ready: false, phase: 'Pending' })
    const reconciler = new WorkflowReconciler(deps)

    await reconciler.reconcile(
      'tool-choice-recipe',
      'uid-tool-choice',
      sandboxNamespace,
      {
        agent: { provider: 'openai', model: 'gpt-4.1' },
        steps: [
          {
            id: 'use-gfs',
            instruction: 'Use the available GFS tools',
            toolChoice: 'required',
          },
        ],
      },
      { workflowExecution: { phase: 'initializing' } },
      undefined,
      'tool-choice-recipe',
      'run-1'
    )

    const configMap = mockCoreApi.createNamespacedConfigMap.mock.calls
      .map(call => call[0].body)
      .find(body => body.metadata?.name === 'tool-choice-recipe-workflow-config')
    const workflowConfig = JSON.parse(configMap.data['config.json'])

    expect(workflowConfig.steps[0]).toMatchObject({
      id: 'use-gfs',
      toolChoice: 'required',
    })
  })

  it('does not add toolChoice to workflow config steps when it is absent', async () => {
    crashRecoveryMocks.getPodPhase.mockImplementation(async (_api, name: string) => {
      if (name === 'default-tool-choice-recipe-workflow-output-anchor') return 'Running'
      if (name === 'default-tool-choice-recipe-workflow-output-prepare') return 'Succeeded'
      return undefined
    })
    mockMcpHostReadiness({ ready: false, phase: 'Pending' })
    const reconciler = new WorkflowReconciler(deps)

    await reconciler.reconcile(
      'default-tool-choice-recipe',
      'uid-default-tool-choice',
      sandboxNamespace,
      {
        agent: { provider: 'openai', model: 'gpt-4.1' },
        steps: [{ id: 'answer', instruction: 'Answer without a tool requirement' }],
      },
      { workflowExecution: { phase: 'initializing' } },
      undefined,
      'default-tool-choice-recipe',
      'run-1'
    )

    const configMap = mockCoreApi.createNamespacedConfigMap.mock.calls
      .map(call => call[0].body)
      .find(body => body.metadata?.name === 'default-tool-choice-recipe-workflow-config')
    const workflowConfig = JSON.parse(configMap.data['config.json'])

    expect(workflowConfig.steps[0]).not.toHaveProperty('toolChoice')
  })

  it('preserves recovering while the mcp-host pod is not ready', async () => {
    crashRecoveryMocks.getPodPhase.mockImplementation(async (_api, name: string) => {
      if (name === 'agentic-recipe-workflow-output-anchor') return 'Running'
      if (name === 'agentic-recipe-workflow-output-prepare') return 'Succeeded'
      return undefined
    })
    crashRecoveryMocks.getPodReadiness.mockResolvedValueOnce({
      ready: false,
      phase: 'Pending',
    })
    const reconciler = new WorkflowReconciler(deps)

    const result = await reconciler.reconcile(
      'agentic-recipe',
      'uid-agentic',
      sandboxNamespace,
      {
        agent: { provider: 'openai', model: 'gpt-4.1' },
        steps: [{ id: 'brief', instruction: 'write the brief' }],
      },
      { workflowExecution: { phase: 'recovering', attempt: 1 } },
      undefined,
      'agentic-recipe',
      'run-1'
    )

    expect(result).toMatchObject({
      phase: 'deploying',
      workflowPhase: 'recovering',
    })
  })

  it('fails stale pre-coordinator readiness wait for a Running non-ready mcp-host pod', async () => {
    mockAgenticOutputPodPhases({ mcpHost: 'Running' })
    mockMcpHostReadiness({
      ready: false,
      phase: 'Running',
    })
    const reconciler = new WorkflowReconciler(deps)

    const result = await reconciler.reconcile(
      'agentic-recipe',
      'uid-agentic',
      sandboxNamespace,
      {
        agent: { provider: 'openai', model: 'gpt-4.1' },
        steps: [{ id: 'brief', instruction: 'write the brief' }],
      },
      { workflowExecution: { phase: 'initializing', startedAt: isoDateAgo(10 * 60_000) } },
      undefined,
      'agentic-recipe',
      'run-1'
    )

    expect(result).toMatchObject({
      phase: 'failed',
      workflowPhase: 'failed',
    })
    expect(result.message).toContain('Waiting for mcp-host pod to become Ready (phase=Running)')
    expect(result.message).toContain('readiness deadline exceeded')
  })

  it('fails stale pre-coordinator readiness wait for a Pending non-recoverable mcp-host pod', async () => {
    mockAgenticOutputPodPhases({ mcpHost: 'Pending' })
    mockMcpHostReadiness({
      ready: false,
      phase: 'Pending',
    })
    const reconciler = new WorkflowReconciler(deps)

    const result = await reconciler.reconcile(
      'agentic-recipe',
      'uid-agentic',
      sandboxNamespace,
      {
        agent: { provider: 'openai', model: 'gpt-4.1' },
        steps: [{ id: 'brief', instruction: 'write the brief' }],
      },
      { workflowExecution: { phase: 'initializing', startedAt: isoDateAgo(10 * 60_000) } },
      undefined,
      'agentic-recipe',
      'run-1'
    )

    expect(result).toMatchObject({
      phase: 'failed',
      workflowPhase: 'failed',
    })
    expect(result.message).toContain('Waiting for mcp-host pod to become Ready (phase=Pending)')
    expect(result.message).toContain('readiness deadline exceeded')
  })

  it('keeps waiting when mcp-host readiness wait is still inside the deadline', async () => {
    mockAgenticOutputPodPhases({ mcpHost: 'Running' })
    mockMcpHostReadiness({
      ready: false,
      phase: 'Running',
    })
    const reconciler = new WorkflowReconciler(deps)

    const result = await reconciler.reconcile(
      'agentic-recipe',
      'uid-agentic',
      sandboxNamespace,
      {
        agent: { provider: 'openai', model: 'gpt-4.1' },
        steps: [{ id: 'brief', instruction: 'write the brief' }],
      },
      { workflowExecution: { phase: 'initializing', startedAt: isoDateAgo(60_000) } },
      undefined,
      'agentic-recipe',
      'run-1'
    )

    expect(result).toMatchObject({
      phase: 'deploying',
      workflowPhase: 'initializing',
    })
    expect(result.message).not.toContain('readiness deadline exceeded')
  })

  it('does not fail the first mcp-host readiness wait before startedAt is persisted', async () => {
    mockAgenticOutputPodPhases({ mcpHost: 'Pending' })
    mockMcpHostReadiness({
      ready: false,
      phase: 'Pending',
    })
    const reconciler = new WorkflowReconciler(deps)

    const result = await reconciler.reconcile(
      'agentic-recipe',
      'uid-agentic',
      sandboxNamespace,
      {
        agent: { provider: 'openai', model: 'gpt-4.1' },
        steps: [{ id: 'brief', instruction: 'write the brief' }],
      },
      { workflowExecution: { phase: 'initializing' } },
      undefined,
      'agentic-recipe',
      'run-1'
    )

    expect(result).toMatchObject({
      phase: 'deploying',
      workflowPhase: 'initializing',
    })
    expect(result.message).not.toContain('readiness deadline exceeded')
  })

  it('does not gate an already running workflow on transient mcp-host readiness', async () => {
    crashRecoveryMocks.getPodPhase
      .mockResolvedValueOnce('Running')
      .mockResolvedValueOnce('Running')
      .mockResolvedValueOnce('Succeeded')
      .mockResolvedValueOnce(undefined)
    const reconciler = new WorkflowReconciler(deps)

    const result = await reconciler.reconcile(
      'agentic-recipe',
      'uid-agentic',
      sandboxNamespace,
      {
        agent: { provider: 'openai', model: 'gpt-4.1' },
        steps: [{ id: 'brief', instruction: 'write the brief' }],
      },
      { workflowExecution: { phase: 'running', attempt: 0 } },
      undefined,
      'agentic-recipe',
      'run-1'
    )

    expect(crashRecoveryMocks.getPodReadiness).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      phase: 'active',
      workflowPhase: 'running',
    })
  })

  it('does not replace a completed mcp-host after workflow completion', async () => {
    crashRecoveryMocks.getPodPhase.mockImplementation(async (_api, name: string) => {
      if (name === 'agentic-recipe-coordinator') return 'Succeeded'
      if (name === 'agentic-recipe-workflow-output-anchor') return 'Running'
      if (name === 'agentic-recipe-workflow-output-prepare') return 'Succeeded'
      if (name === 'agentic-recipe-mcp-host') return 'Succeeded'
      return undefined
    })
    const reconciler = new WorkflowReconciler(deps)

    const result = await reconciler.reconcile(
      'agentic-recipe',
      'uid-agentic',
      sandboxNamespace,
      {
        agent: { provider: 'openai', model: 'gpt-4.1' },
        steps: [{ id: 'brief', instruction: 'write the brief' }],
      },
      { workflowExecution: { phase: 'completed', attempt: 0 } },
      undefined,
      'agentic-recipe',
      'run-1'
    )

    expect(crashRecoveryMocks.evaluateCompletedRuntimePodRecovery).not.toHaveBeenCalled()
    expect(crashRecoveryMocks.getPodReadiness).not.toHaveBeenCalled()
    expect(crashRecoveryMocks.deletePodIfExists).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      phase: 'active',
      workflowPhase: 'completed',
    })
  })

  it('creates the coordinator on a later reconcile after mcp-host becomes Ready', async () => {
    let mcpHostPhaseReads = 0
    mockAgenticOutputPodPhases({
      mcpHost: () => {
        mcpHostPhaseReads += 1
        return mcpHostPhaseReads === 1 ? undefined : 'Running'
      },
    })
    mockMcpHostReadinessSequence(
      { ready: false, phase: 'Pending' },
      { ready: true, phase: 'Running' }
    )
    const reconciler = new WorkflowReconciler(deps)
    const spec = {
      agent: { provider: 'openai' as const, model: 'gpt-4.1' },
      steps: [{ id: 'brief', instruction: 'write the brief' }],
    }

    await reconciler.reconcile(
      'agentic-recipe',
      'uid-agentic',
      sandboxNamespace,
      spec,
      { workflowExecution: { phase: 'initializing' } },
      undefined,
      'agentic-recipe',
      'run-1'
    )
    mockCoreApi.createNamespacedPod.mockClear()

    const result = await reconciler.reconcile(
      'agentic-recipe',
      'uid-agentic',
      sandboxNamespace,
      spec,
      { workflowExecution: { phase: 'initializing' } },
      undefined,
      'agentic-recipe',
      'run-1'
    )

    expect(result).toMatchObject({
      phase: 'deploying',
      workflowPhase: 'initializing',
    })
    const podNames = mockCoreApi.createNamespacedPod.mock.calls.map(
      call => call[0].body.metadata.name
    )
    expect(podNames).toContain('agentic-recipe-coordinator')

    const createdPods = mockCoreApi.createNamespacedPod.mock.calls.map(call => call[0].body)
    const artifactReaderPod = createdPods.find(
      pod => pod.metadata.name === 'agentic-recipe-artifact-reader'
    )
    const coordinatorPod = createdPods.find(
      pod => pod.metadata.name === 'agentic-recipe-coordinator'
    )
    expect(
      artifactReaderPod.spec.affinity.podAffinity.requiredDuringSchedulingIgnoredDuringExecution[0]
        .labelSelector.matchExpressions
    ).toContainEqual({
      key: 'clerum.io/component',
      operator: 'In',
      values: ['workflow-output-anchor'],
    })
    expect(
      coordinatorPod.spec.affinity.podAffinity.requiredDuringSchedulingIgnoredDuringExecution[0]
        .labelSelector.matchExpressions
    ).toContainEqual({
      key: 'clerum.io/component',
      operator: 'In',
      values: ['workflow-output-anchor'],
    })
  })

  it('replaces a CrashLoopBackOff mcp-host pod before waiting on readiness', async () => {
    mockAgenticOutputPodPhases({ mcpHost: 'Running' })
    mockMcpHostReadiness({ ready: true, phase: 'Running' })
    crashRecoveryMocks.getContainerWaitingReason.mockImplementation(async (_api, name: string) =>
      name === 'agentic-recipe-mcp-host' ? 'CrashLoopBackOff' : undefined
    )
    crashRecoveryMocks.evaluateCrashRecovery.mockReturnValueOnce({
      action: 'replace',
      message: 'Pod in Running with CrashLoopBackOff; creating replacement (attempt 1/3)',
      newPhase: 'recovering',
      newAttempt: 1,
    })
    const reconciler = new WorkflowReconciler(deps)

    await reconciler.reconcile(
      'agentic-recipe',
      'uid-agentic',
      sandboxNamespace,
      {
        agent: { provider: 'openai', model: 'gpt-4.1' },
        steps: [{ id: 'brief', instruction: 'write the brief' }],
      },
      { workflowExecution: { phase: 'initializing', attempt: 0 } },
      undefined,
      'agentic-recipe',
      'run-1'
    )

    expect(crashRecoveryMocks.evaluateCrashRecovery).toHaveBeenCalledWith(
      'Running',
      { phase: 'initializing', attempt: 0 },
      'CrashLoopBackOff'
    )
    expect(crashRecoveryMocks.deletePodIfExists).toHaveBeenCalledWith(
      mockCoreApi,
      'agentic-recipe-mcp-host',
      sandboxNamespace
    )
    const podNames = mockCoreApi.createNamespacedPod.mock.calls.map(
      call => call[0].body.metadata.name
    )
    expect(podNames).toContain('agentic-recipe-mcp-host')
    expect(podNames).toContain('agentic-recipe-coordinator')
  })

  it('replaces a completed mcp-host pod before waiting on readiness', async () => {
    mockAgenticOutputPodPhases({ mcpHost: 'Succeeded' })
    mockMcpHostReadiness({ ready: true, phase: 'Running' })
    const reconciler = new WorkflowReconciler(deps)

    await reconciler.reconcile(
      'agentic-recipe',
      'uid-agentic',
      sandboxNamespace,
      {
        agent: { provider: 'openai', model: 'gpt-4.1' },
        steps: [{ id: 'brief', instruction: 'write the brief' }],
      },
      { workflowExecution: { phase: 'initializing', attempt: 0 } },
      undefined,
      'agentic-recipe',
      'run-1'
    )

    expect(crashRecoveryMocks.evaluateCompletedRuntimePodRecovery).toHaveBeenCalledWith(
      { phase: 'initializing', attempt: 0 },
      'mcp_host'
    )
    expect(crashRecoveryMocks.deletePodIfExists).toHaveBeenCalledWith(
      mockCoreApi,
      'agentic-recipe-mcp-host',
      sandboxNamespace
    )
    const podNames = mockCoreApi.createNamespacedPod.mock.calls.map(
      call => call[0].body.metadata.name
    )
    expect(podNames).toContain('agentic-recipe-mcp-host')
    expect(podNames).toContain('agentic-recipe-coordinator')
  })

  describe('teardownComputePodsForTerminalRun', () => {
    it('deletes coordinator, mcp-host, and snippet-runner but PRESERVES artifact-reader', async () => {
      const reconciler = new WorkflowReconciler(deps)

      await reconciler.teardownComputePodsForTerminalRun('wf-run-7')

      const deletedPods = crashRecoveryMocks.deletePodIfExists.mock.calls.map(
        call => call[1] as string
      )
      expect(deletedPods).toContain('wf-run-7-coordinator')
      expect(deletedPods).toContain('wf-run-7-mcp-host')
      expect(deletedPods).toContain('wf-run-7-snippet-runner')
      // Artifacts must stay downloadable — artifact-reader is never torn down here.
      expect(deletedPods).not.toContain('wf-run-7-artifact-reader')
      // All deletions target the sandbox namespace.
      for (const call of crashRecoveryMocks.deletePodIfExists.mock.calls) {
        expect(call[2]).toBe(sandboxNamespace)
      }
    })

    it('is idempotent: re-running after pods are gone is a no-op (404-safe)', async () => {
      const reconciler = new WorkflowReconciler(deps)
      // deletePodIfExists already swallows 404 internally; a second pass must not throw.
      await reconciler.teardownComputePodsForTerminalRun('wf-run-7')
      await expect(
        reconciler.teardownComputePodsForTerminalRun('wf-run-7')
      ).resolves.toBeUndefined()
    })
  })
})

describe('WorkflowReconciler — Plugin Workload SDK eager mcp-host', () => {
  const sandboxNamespace = 'sandbox-recipes'
  const mcpServerNamespace = 'mcp-server'

  const mockCoreApi = {
    readNamespacedPod: vi.fn().mockResolvedValue({}),
    readNamespacedSecret: vi.fn().mockRejectedValue({ code: 404 }),
    readNamespacedService: vi.fn().mockResolvedValue({}),
    readNamespacedEndpoints: vi.fn().mockRejectedValue({ code: 404 }),
    createNamespacedSecret: vi.fn().mockResolvedValue({}),
    createNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    createNamespacedService: vi.fn().mockResolvedValue({}),
    createNamespacedPod: vi.fn().mockResolvedValue({}),
    patchNamespacedSecret: vi.fn().mockResolvedValue({}),
    deleteNamespacedPod: vi.fn().mockResolvedValue({}),
    deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
    deleteNamespacedService: vi.fn().mockResolvedValue({}),
  }
  const mockCustomApi = {
    patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
  }
  const mockNetworkingApi = {
    createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    readNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
    replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    listNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ items: [] }),
  }
  const mockModelConfigHandler = {
    configurePluginWorkloadSdkBootstrap: vi.fn().mockResolvedValue({
      status: 202,
      body: {
        configured: true,
        ready: true,
        provider: 'zai',
        model: 'glm-4.7',
        contractVersion: 2,
        policyRevision: 1,
        policyHash: 'a'.repeat(64),
        defaultTargetRef: 'primary-zai',
        defaultProvider: 'zai',
        defaultModel: 'glm-4.7',
      },
    }),
  }
  const mockTokenFactory = {
    signWrcConfigureToken: vi.fn().mockResolvedValue('wrc-configure-token'),
    signWrcArtifactDeleteToken: vi.fn().mockResolvedValue('stub-token'),
  }
  const mockPluginWorkloadSdkRevocationClient = {
    revoke: vi.fn().mockResolvedValue({ state: 'missing', revoked: 0, fencedInvocations: 0 }),
    finalize: vi.fn(),
  }

  const makeDeps = () =>
    ({
      coreApi: mockCoreApi,
      customApi: mockCustomApi,
      networkingApi: mockNetworkingApi,
      config: {
        coordinatorImage: 'coordinator:test',
        mcpHostImage: 'mcp-host:test',
        wrcEndpoint: 'http://wrc.example/api',
        sandboxNamespace,
        mcpServerNamespace,
        imagePullPolicy: 'IfNotPresent' as const,
        maxWorkflowSteps: 100,
        runtimeTokenTtlSeconds: 3600,
        runtimeTokenRefreshBeforeSeconds: 300,
        pluginWorkloadSdkEnabled: true,
      },
      tokenFactory: mockTokenFactory,
      modelConfigHandler: mockModelConfigHandler,
      pluginWorkloadSdkRevocationClient: mockPluginWorkloadSdkRevocationClient,
    }) as unknown as WorkflowReconcilerDeps

  const sdkBootstrapProof = () => ({
    configured: true,
    ready: true,
    provider: 'zai',
    model: 'glm-4.7',
    contractVersion: 2,
    policyRevision: 1,
    policyHash: 'a'.repeat(64),
    defaultTargetRef: 'primary-zai',
    defaultProvider: 'zai',
    defaultModel: 'glm-4.7',
  })

  beforeEach(() => {
    vi.clearAllMocks()
    crashRecoveryMocks.getContainerWaitingReason.mockResolvedValue(undefined)
    crashRecoveryMocks.getPodPhase.mockResolvedValue(undefined)
    crashRecoveryMocks.getPodReadiness.mockResolvedValue({
      ready: true,
      phase: 'Running',
      uid: 'pod-uid-1',
    })
    crashRecoveryMocks.evaluateCrashRecovery.mockReturnValue({ action: 'none', message: 'healthy' })
    mockCoreApi.createNamespacedPod.mockResolvedValue({})
    mockCoreApi.readNamespacedService.mockRejectedValue({ code: 404 })
    mockCoreApi.readNamespacedEndpoints.mockRejectedValue({ code: 404 })
    mockNetworkingApi.readNamespacedNetworkPolicy.mockRejectedValue({ code: 404 })
    mockNetworkingApi.listNamespacedNetworkPolicy.mockResolvedValue({ items: [] })
    mockModelConfigHandler.configurePluginWorkloadSdkBootstrap.mockResolvedValue({
      status: 202,
      body: sdkBootstrapProof(),
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 204 } as unknown as Response)
    )
  })

  const sdkSpec = (overrides = {}) =>
    ({
      agent: { provider: 'zai', model: 'glm-4.7' },
      steps: [{ id: 'keepalive', instruction: 'ack' }],
      workloads: [{ id: 'sdk-caller', type: 'deployment', image: 'caller:test' }],
      pluginWorkloadSdk: {
        promptBridge: {},
        allowedCallers: ['sdk-caller'],
      },
      ...overrides,
    }) as unknown as Parameters<WorkflowReconciler['reconcile']>[3]

  it('rotates access, refresh, and control tokens when runtime scopes drift', async () => {
    const now = Math.floor(Date.now() / 1000)
    const staleBinding = {
      exp: now + 3600,
      recipeNamespace: sandboxNamespace,
      recipeName: 'sdk-recipe',
      hostRefs: [`${sandboxNamespace}/sdk-recipe`],
      scopes: [],
    }
    const staleGfsBinding = {
      ...staleBinding,
      hostRefs: [`host:3rd:${sandboxNamespace}/sdk-recipe`],
      scopes: ['gfs.read'],
    }
    mockCoreApi.readNamespacedSecret.mockResolvedValueOnce({
      data: {
        'mcp-host-runtime-access-token': Buffer.from(unsignedRuntimeJwt(staleBinding)).toString(
          'base64'
        ),
        'mcp-host-runtime-refresh-token': Buffer.from(unsignedRuntimeJwt(staleBinding)).toString(
          'base64'
        ),
        'mcp-host-workflow-control-token': Buffer.from(unsignedRuntimeJwt(staleBinding)).toString(
          'base64'
        ),
        'mcp-host-gfs-token': Buffer.from(unsignedRuntimeJwt(staleGfsBinding)).toString('base64'),
      },
    })

    const reconciler = new WorkflowReconciler(makeDeps())
    await reconciler.ensureMcpHostRuntimeCredentials(sandboxNamespace, 'sdk-recipe', sdkSpec())

    expect(runtimeTokenIssuerMocks.issueMcpHostRuntimeTokens).toHaveBeenCalledWith(
      sandboxNamespace,
      'sdk-recipe',
      ['plugin-workload-sdk']
    )
    expect(mockCoreApi.patchNamespacedSecret).toHaveBeenCalledTimes(1)
    const patch = mockCoreApi.patchNamespacedSecret.mock.calls[0]?.[0] as {
      body?: { data?: Record<string, string> }
    }
    expect(patch.body?.data).toEqual(
      expect.objectContaining({
        'mcp-host-runtime-access-token': expect.any(String),
        'mcp-host-runtime-refresh-token': expect.any(String),
        'mcp-host-workflow-control-token': expect.any(String),
      })
    )
  })

  it('creates the mcp-host but NOT the coordinator when no run is triggered', async () => {
    const reconciler = new WorkflowReconciler(makeDeps())

    await reconciler.reconcile(
      'sdk-recipe',
      'uid-sdk',
      sandboxNamespace,
      sdkSpec(),
      { workflowExecution: { phase: 'initializing' } },
      undefined,
      'sdk-recipe',
      undefined // no run id → awaitsTriggeredRun
    )

    const podNames = mockCoreApi.createNamespacedPod.mock.calls.map(
      call => call[0].body.metadata.name
    )
    expect(podNames).toContain('sdk-recipe-mcp-host')
    expect(podNames).not.toContain('sdk-recipe-coordinator')

    // The eager mcp-host must get the same runtime-token + SDK-token Secrets the
    // triggered-run path provisions, or it boots NotReady (degraded runtime auth).
    const secretNames = mockCoreApi.createNamespacedSecret.mock.calls.map(
      call => call[0].body.metadata.name
    )
    expect(secretNames).toContain('wf-sdk-recipe-mcp-host-runtime-tokens')
    const runtimeSecret = mockCoreApi.createNamespacedSecret.mock.calls
      .map(call => call[0].body)
      .find(secret => secret.metadata.name === 'wf-sdk-recipe-mcp-host-runtime-tokens')
    expect(runtimeSecret?.stringData?.[['mcp-host-gfs', 'token'].join('-')]).toBe(
      'gfs-runtime-value'
    )

    // The SDK lane NetworkPolicies must also come up so the sdk-caller can
    // reach the SDK server on :8099.
    const npNames = mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls.map(
      call => call[0].body.metadata.name
    )
    // A stepless SDK host has no coordinator. The eager network lane must not
    // create workflow-only coordinator policies that would later be orphaned.
    expect(npNames).not.toContain('sdk-recipe-coord-to-mcp-host')
    expect(npNames).not.toContain('sdk-recipe-coord-to-mcp-host-ingress')
    expect(npNames).not.toContain('sdk-recipe-coord-to-wrc')
    expect(npNames).toContain('sdk-recipe-workload-to-mcp-host-sdk-ingress')
    expect(npNames).toContain('sdk-recipe-workload-to-mcp-host-sdk-egress')
    expect(npNames).toContain('sdk-recipe-mcp-host-to-gfs')

    // The mcp-host headless Service must exist so the SDK endpoint DNS resolves.
    const svcNames = mockCoreApi.createNamespacedService.mock.calls.map(
      call => call[0].body.metadata.name
    )
    expect(svcNames).toContain('wf-sdk-recipe-mcp-host')
  })

  it('leaves coordinator GFS NetworkPolicy ownership to the outer recipe reconciler', async () => {
    const reconciler = new WorkflowReconciler(makeDeps())

    await reconciler.reconcile(
      'sdk-recipe',
      'uid-sdk',
      sandboxNamespace,
      sdkSpec({ gfs: { publishTargets: [{ drive: 'main', target: 'outputs' }] } }),
      { workflowExecution: { phase: 'initializing' } },
      undefined,
      'sdk-recipe',
      undefined
    )

    const npNames = mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls.map(
      call => call[0].body.metadata.name
    )
    expect(npNames).not.toContain('sdk-recipe-coordinator-to-gfs')
  })

  it('creates eager mcp-host for SDK-only recipes without agentic steps', async () => {
    const reconciler = new WorkflowReconciler(makeDeps())

    const result = await reconciler.reconcilePluginWorkloadSdkOnly(
      'sdk-only',
      'uid-sdk-only',
      sandboxNamespace,
      sdkSpec({ steps: undefined })
    )

    const podNames = mockCoreApi.createNamespacedPod.mock.calls.map(
      call => call[0].body.metadata.name
    )
    expect(podNames).toContain('sdk-only-mcp-host')
    expect(podNames).not.toContain('sdk-only-coordinator')
    const npNames = mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls.map(
      call => call[0].body.metadata.name
    )
    expect(npNames).not.toContain('sdk-only-coord-to-mcp-host')
    expect(npNames).not.toContain('sdk-only-coord-to-mcp-host-ingress')
    expect(npNames).not.toContain('sdk-only-coord-to-wrc')
    expect(result.phase).toBe('active')
    expect(mockModelConfigHandler.configurePluginWorkloadSdkBootstrap).toHaveBeenCalledWith(
      'zai',
      'glm-4.7',
      expect.any(String),
      'wrc-configure-token'
    )
  })

  it('creates a provider-free eager mcp-host for clientNotifications-only without an agent', async () => {
    const reconciler = new WorkflowReconciler(makeDeps())

    const result = await reconciler.reconcilePluginWorkloadSdkOnly(
      'notifications-only',
      'uid-notifications-only',
      sandboxNamespace,
      sdkSpec({
        agent: undefined,
        steps: undefined,
        pluginWorkloadSdk: {
          clientNotifications: { allowedEventTypes: ['e2e.test'] },
          allowedCallers: ['sdk-caller'],
        },
      })
    )

    expect(result.phase).toBe('active')
    const pod = mockCoreApi.createNamespacedPod.mock.calls[0]?.[0].body
    const envNames = (pod.spec.containers[0].env ?? []).map((entry: { name: string }) => entry.name)
    expect(envNames).not.toContain('CLERUM_MODEL_PROVIDER')
    expect(envNames).not.toContain('CLERUM_MODEL')
    expect(mockModelConfigHandler.configurePluginWorkloadSdkBootstrap).not.toHaveBeenCalled()
  })

  it('cleans SDK-only host resources idempotently without creating workflow resources', async () => {
    const reconciler = new WorkflowReconciler(makeDeps())

    await expect(reconciler.cleanupPluginWorkloadSdk('sdk-only')).resolves.toBeUndefined()
    await expect(reconciler.cleanupPluginWorkloadSdk('sdk-only')).resolves.toBeUndefined()

    expect(mockCoreApi.deleteNamespacedService).toHaveBeenCalledWith({
      name: 'wf-sdk-only-mcp-host',
      namespace: sandboxNamespace,
    })
    expect(mockCoreApi.deleteNamespacedSecret).toHaveBeenCalledWith({
      name: 'wf-sdk-only-plugin-workload-sdk-token',
      namespace: sandboxNamespace,
    })
    expect(mockCoreApi.deleteNamespacedSecret).toHaveBeenCalledWith({
      name: 'wf-sdk-only-mcp-host-runtime-tokens',
      namespace: sandboxNamespace,
    })
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: 'sdk-only-workload-to-mcp-host-sdk-ingress',
      namespace: sandboxNamespace,
    })
    expect(mockCoreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('fails closed before physical cleanup when the Control API revocation client is absent', async () => {
    const deps = makeDeps() as unknown as { pluginWorkloadSdkRevocationClient?: unknown }
    delete deps.pluginWorkloadSdkRevocationClient
    const reconciler = new WorkflowReconciler(deps as unknown as WorkflowReconcilerDeps)

    await expect(reconciler.cleanupPluginWorkloadSdk('sdk-only')).rejects.toThrow(
      /revocation client is not configured/
    )
    expect(mockCoreApi.deleteNamespacedPod).not.toHaveBeenCalled()
  })

  it('retains every SDK resource when Control API revocation fails', async () => {
    const deps = makeDeps()
    mockPluginWorkloadSdkRevocationClient.revoke.mockRejectedValueOnce(
      new Error('control-api unavailable')
    )
    const reconciler = new WorkflowReconciler(deps)

    await expect(reconciler.cleanupPluginWorkloadSdk('sdk-only')).rejects.toThrow(
      'control-api unavailable'
    )
    expect(mockCoreApi.deleteNamespacedPod).not.toHaveBeenCalled()
    expect(mockCoreApi.deleteNamespacedService).not.toHaveBeenCalled()
    expect(mockCoreApi.deleteNamespacedSecret).not.toHaveBeenCalled()
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('converges after a post-revocation delete failure on the next reconcile', async () => {
    const deps = makeDeps()
    const revocationId = '55555555-5555-4555-8555-555555555555'
    mockPluginWorkloadSdkRevocationClient.revoke.mockResolvedValue({
      state: 'revoking',
      revocationId,
      revoked: 1,
      fencedInvocations: 1,
    })
    mockPluginWorkloadSdkRevocationClient.finalize.mockResolvedValue({
      state: 'disabled',
      revocationId,
      revoked: 0,
      fencedInvocations: 0,
      disabled: 1,
    })
    mockCoreApi.deleteNamespacedService.mockRejectedValueOnce(new Error('apiserver timeout'))
    const reconciler = new WorkflowReconciler(deps)

    await expect(reconciler.cleanupPluginWorkloadSdk('sdk-only')).rejects.toThrow(
      'apiserver timeout'
    )
    expect(mockPluginWorkloadSdkRevocationClient.finalize).not.toHaveBeenCalled()

    await expect(reconciler.cleanupPluginWorkloadSdk('sdk-only')).resolves.toBeUndefined()
    expect(mockPluginWorkloadSdkRevocationClient.finalize).toHaveBeenCalledWith(
      sandboxNamespace,
      'sdk-only',
      revocationId
    )
  })

  it('retries finalization after a transient Control API failure once resources are absent', async () => {
    const deps = makeDeps()
    const revocationId = '66666666-6666-4666-8666-666666666666'
    mockPluginWorkloadSdkRevocationClient.revoke.mockResolvedValue({
      state: 'revoking',
      revocationId,
      revoked: 1,
      fencedInvocations: 0,
    })
    mockPluginWorkloadSdkRevocationClient.finalize
      .mockRejectedValueOnce(new Error('control-api finalize timeout'))
      .mockResolvedValueOnce({
        state: 'disabled',
        revocationId,
        revoked: 0,
        fencedInvocations: 0,
        disabled: 1,
      })
    const reconciler = new WorkflowReconciler(deps)

    await expect(reconciler.cleanupPluginWorkloadSdk('sdk-only')).rejects.toThrow(
      'control-api finalize timeout'
    )
    await expect(reconciler.cleanupPluginWorkloadSdk('sdk-only')).resolves.toBeUndefined()
    expect(mockPluginWorkloadSdkRevocationClient.finalize).toHaveBeenCalledTimes(2)
    expect(mockPluginWorkloadSdkRevocationClient.finalize).toHaveBeenLastCalledWith(
      sandboxNamespace,
      'sdk-only',
      revocationId
    )
  })

  it('accepts an already-removed grant as terminal revocation confirmation', async () => {
    const deps = makeDeps()
    const revocationId = '77777777-7777-4777-8777-777777777777'
    mockPluginWorkloadSdkRevocationClient.revoke.mockResolvedValue({
      state: 'revoking',
      revocationId,
      revoked: 1,
      fencedInvocations: 0,
    })
    mockPluginWorkloadSdkRevocationClient.finalize.mockResolvedValue({
      state: 'missing',
      revoked: 0,
      fencedInvocations: 0,
    })
    const reconciler = new WorkflowReconciler(deps)

    await expect(reconciler.cleanupPluginWorkloadSdk('sdk-only')).resolves.toBeUndefined()
    expect(mockPluginWorkloadSdkRevocationClient.finalize).toHaveBeenCalledWith(
      sandboxNamespace,
      'sdk-only',
      revocationId
    )
  })

  it('sweeps legacy SDK network policies by recipe label during cleanup', async () => {
    let legacyPolicyPresent = true
    mockNetworkingApi.listNamespacedNetworkPolicy.mockImplementation(
      ({ namespace }: { namespace: string }) =>
        Promise.resolve({
          items:
            namespace === sandboxNamespace && legacyPolicyPresent
              ? [{ metadata: { name: 'sdk-only-legacy-coord-to-mcp-host' } }]
              : [],
        })
    )
    mockNetworkingApi.deleteNamespacedNetworkPolicy.mockImplementation(
      async ({ name }: { name?: string }) => {
        if (name === 'sdk-only-legacy-coord-to-mcp-host') legacyPolicyPresent = false
        return {}
      }
    )
    const reconciler = new WorkflowReconciler(makeDeps())

    await reconciler.cleanupPluginWorkloadSdk('sdk-only')

    expect(mockNetworkingApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
      namespace: sandboxNamespace,
      labelSelector: 'clerum.io/recipe=sdk-only,clerum.io/managed-by=wrc',
    })
    expect(mockNetworkingApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
      namespace: mcpServerNamespace,
      labelSelector: 'clerum.io/recipe=sdk-only,clerum.io/managed-by=wrc',
    })
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: 'sdk-only-legacy-coord-to-mcp-host',
      namespace: sandboxNamespace,
    })
  })

  it('brokers the provider into the eager mcp-host for promptBridge recipes', async () => {
    const reconciler = new WorkflowReconciler(makeDeps())

    await reconciler.reconcile(
      'sdk-recipe',
      'uid-sdk',
      sandboxNamespace,
      sdkSpec(),
      { workflowExecution: { phase: 'initializing' } },
      undefined,
      'sdk-recipe',
      undefined
    )

    expect(mockModelConfigHandler.configurePluginWorkloadSdkBootstrap).toHaveBeenCalledTimes(1)
    expect(mockModelConfigHandler.configurePluginWorkloadSdkBootstrap).toHaveBeenCalledWith(
      'zai',
      'glm-4.7',
      expect.any(String),
      'wrc-configure-token'
    )
  })

  it('does NOT broker a provider for clientNotifications-only recipes', async () => {
    const reconciler = new WorkflowReconciler(makeDeps())

    await reconciler.reconcile(
      'notif-recipe',
      'uid-notif',
      sandboxNamespace,
      sdkSpec({
        pluginWorkloadSdk: {
          clientNotifications: { allowedEventTypes: ['e2e.test'] },
          allowedCallers: ['sdk-caller'],
        },
      }),
      { workflowExecution: { phase: 'initializing' } },
      undefined,
      'notif-recipe',
      undefined
    )

    const podNames = mockCoreApi.createNamespacedPod.mock.calls.map(
      call => call[0].body.metadata.name
    )
    expect(podNames).toContain('notif-recipe-mcp-host')
    expect(mockModelConfigHandler.configurePluginWorkloadSdkBootstrap).not.toHaveBeenCalled()
  })

  it('skips the provider broker while the eager mcp-host is not ready', async () => {
    crashRecoveryMocks.getPodReadiness.mockResolvedValue({ ready: false, phase: 'Pending' })
    const reconciler = new WorkflowReconciler(makeDeps())

    await reconciler.reconcile(
      'sdk-recipe',
      'uid-sdk',
      sandboxNamespace,
      sdkSpec(),
      { workflowExecution: { phase: 'initializing' } },
      undefined,
      'sdk-recipe',
      undefined
    )

    expect(mockModelConfigHandler.configurePluginWorkloadSdkBootstrap).not.toHaveBeenCalled()
  })

  it('returns phase=deploying while the eager mcp-host boots so the watcher requeues the configure', async () => {
    // The eager pod is created but not Ready yet, so /configure is skipped this
    // pass. The result MUST be phase=deploying (NOT active) so the watcher
    // requeues at the fixed progress interval and re-runs the eager /configure
    // once the pod is Ready. Returning 'active' drops the requeue
    // (requeueAfterMs=undefined) — the now-Ready pod is never re-reconciled and
    // stays "waiting for /configure" forever, so promptBridge / clientNotifications
    // fail with provider_unavailable. Regression guard for the readiness race.
    crashRecoveryMocks.getPodReadiness.mockResolvedValue({ ready: false, phase: 'Pending' })
    const reconciler = new WorkflowReconciler(makeDeps())

    const result = await reconciler.reconcile(
      'sdk-recipe',
      'uid-sdk',
      sandboxNamespace,
      sdkSpec(),
      { workflowExecution: { phase: 'initializing' } },
      undefined,
      'sdk-recipe',
      undefined
    )

    expect(result.phase).toBe('deploying')
    expect(result.message).toContain('starting')
    expect(result.message).not.toContain('registered')
  })

  it('returns phase=active once the eager mcp-host is Ready and configured (steady state)', async () => {
    // Pod Ready + /configure succeeds → eagerStatus='ready'. The recipe is
    // settled: phase=active (no progress requeue); the workflowNeedsInfrastructure
    // Reconcile keep-alive loop handles steady-state re-configure/self-heal.
    crashRecoveryMocks.getPodReadiness.mockResolvedValue({
      ready: true,
      phase: 'Running',
      uid: 'pod-uid-1',
    })
    const reconciler = new WorkflowReconciler(makeDeps())

    const result = await reconciler.reconcile(
      'sdk-recipe',
      'uid-sdk',
      sandboxNamespace,
      sdkSpec(),
      { workflowExecution: { phase: 'initializing' } },
      undefined,
      'sdk-recipe',
      undefined
    )

    expect(result.phase).toBe('active')
    expect(result.message).toContain('registered')
    expect(mockModelConfigHandler.configurePluginWorkloadSdkBootstrap).toHaveBeenCalledTimes(1)
  })

  it('reports awaiting_policy when identity bootstrap is ready but the operator grant is missing', async () => {
    crashRecoveryMocks.getPodReadiness.mockResolvedValue({
      ready: true,
      phase: 'Running',
      uid: 'pod-uid-1',
    })
    mockModelConfigHandler.configurePluginWorkloadSdkBootstrap.mockResolvedValue({
      status: 202,
      body: {
        configured: true,
        ready: true,
        provider: 'zai',
        model: 'glm-4.7',
        contractVersion: 2,
        policyReady: false,
        policyState: 'missing',
        policyReason: 'grant_missing',
      },
    })
    const reconciler = new WorkflowReconciler(makeDeps())

    const result = await reconciler.reconcilePluginWorkloadSdkOnly(
      'sdk-recipe',
      'uid-sdk',
      sandboxNamespace,
      sdkSpec({ steps: undefined })
    )

    expect(result.phase).toBe('awaiting_policy')
    expect(result.message).toContain('operator policy pending')
    expect(result.message).toContain('grant_missing')
    expect(result.message).not.toContain('provider unavailable')
    expect(result.pluginWorkloadSdkBootstrapProof).toMatchObject({
      ready: true,
      policyReady: false,
      policyState: 'missing',
      policyReason: 'grant_missing',
    })
  })

  it('re-probes live bootstrap policy on every reconcile of the same ready pod', async () => {
    crashRecoveryMocks.getPodReadiness.mockResolvedValue({
      ready: true,
      phase: 'Running',
      uid: 'pod-uid-1',
    })
    const reconciler = new WorkflowReconciler(makeDeps())
    const run = () =>
      reconciler.reconcile(
        'sdk-recipe',
        'uid-sdk',
        sandboxNamespace,
        sdkSpec(),
        { workflowExecution: { phase: 'initializing' } },
        undefined,
        'sdk-recipe',
        undefined
      )

    await run()
    await run()

    // A pod UID is not proof that the operator policy is unchanged. Each
    // reconcile must obtain a fresh Control API proof so grant revocation and
    // target-order changes become effective without restarting the pod.
    expect(mockModelConfigHandler.configurePluginWorkloadSdkBootstrap).toHaveBeenCalledTimes(2)
  })

  it('stays pending (not registered) and retries when the provider broker fails', async () => {
    crashRecoveryMocks.getPodReadiness.mockResolvedValue({
      ready: true,
      phase: 'Running',
      uid: 'pod-uid-1',
    })
    mockModelConfigHandler.configurePluginWorkloadSdkBootstrap.mockResolvedValue({
      status: 500,
      body: { error: 'boom' },
    })
    const reconciler = new WorkflowReconciler(makeDeps())
    const run = () =>
      reconciler.reconcile(
        'sdk-recipe',
        'uid-sdk',
        sandboxNamespace,
        sdkSpec(),
        { workflowExecution: { phase: 'initializing' } },
        undefined,
        'sdk-recipe',
        undefined
      )

    const first = await run()
    // Configure failed → recipe must NOT report the SDK as registered/ready.
    expect(first.message).toContain('starting')
    expect(first.message).not.toContain('registered')

    // Failure must not poison the configure cache: the next reconcile retries.
    mockModelConfigHandler.configurePluginWorkloadSdkBootstrap.mockResolvedValue({
      status: 202,
      body: sdkBootstrapProof(),
    })
    const second = await run()
    expect(mockModelConfigHandler.configurePluginWorkloadSdkBootstrap).toHaveBeenCalledTimes(2)
    expect(second.message).toContain('registered')
  })

  it('does not publish SDK readiness when the bootstrap contract is not v2', async () => {
    crashRecoveryMocks.getPodReadiness.mockResolvedValue({
      ready: true,
      phase: 'Running',
      uid: 'pod-uid-1',
    })
    mockModelConfigHandler.configurePluginWorkloadSdkBootstrap.mockResolvedValue({
      status: 202,
      body: { configured: true },
    })
    const reconciler = new WorkflowReconciler(makeDeps())
    const result = await reconciler.reconcile(
      'sdk-recipe',
      'uid-sdk',
      sandboxNamespace,
      sdkSpec(),
      { workflowExecution: { phase: 'initializing' } },
      undefined,
      'sdk-recipe',
      undefined
    )

    expect(result.phase).toBe('deploying')
    expect(result.message).toContain('starting')
    expect(result.message).not.toContain('registered')
  })

  it('projects provider_unavailable after repeated configure failures instead of an indefinite starting', async () => {
    crashRecoveryMocks.getPodReadiness.mockResolvedValue({
      ready: true,
      phase: 'Running',
      uid: 'pod-uid-1',
    })
    // Provider broker is permanently broken (e.g. bad secretRef).
    mockModelConfigHandler.configurePluginWorkloadSdkBootstrap.mockResolvedValue({
      status: 500,
      body: { error: 'boom' },
    })
    const reconciler = new WorkflowReconciler(makeDeps())
    const run = () =>
      reconciler.reconcile(
        'sdk-recipe',
        'uid-sdk',
        sandboxNamespace,
        sdkSpec(),
        { workflowExecution: { phase: 'initializing' } },
        undefined,
        'sdk-recipe',
        undefined
      )

    // First two failures stay "starting" so transient blips keep retrying.
    const first = await run()
    expect(first.message).toContain('starting')
    expect(first.message).not.toContain('provider unavailable')
    const second = await run()
    expect(second.message).toContain('starting')

    // Third consecutive failure crosses MAX_EAGER_CONFIGURE_ATTEMPTS → distinct
    // provider_unavailable projection (still phase=active so it self-heals).
    const third = await run()
    expect(third.phase).toBe('active')
    expect(third.message).toContain('provider unavailable')
    expect(third.workflowConditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'PluginWorkloadSdkProviderUnavailable',
          reason: 'EagerConfigureFailed',
          status: 'True',
        }),
      ])
    )

    // It keeps retrying — recovers as soon as the broker config is fixed, and
    // the unavailable condition is no longer projected.
    mockModelConfigHandler.configurePluginWorkloadSdkBootstrap.mockResolvedValue({
      status: 202,
      body: sdkBootstrapProof(),
    })
    const recovered = await run()
    expect(recovered.message).toContain('registered')
    expect(recovered.workflowConditions ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'PluginWorkloadSdkProviderUnavailable' }),
      ])
    )
  })

  it('restarts the configure failure budget when the eager mcp-host pod is externally replaced', async () => {
    let podUid = 'pod-uid-1'
    crashRecoveryMocks.getPodReadiness.mockImplementation(async (_api, podName: string) => {
      if (podName.endsWith('-mcp-host')) {
        return { ready: true, phase: 'Running', uid: podUid }
      }
      return { ready: true, phase: 'Running' }
    })
    mockModelConfigHandler.configurePluginWorkloadSdkBootstrap.mockResolvedValue({
      status: 500,
      body: { error: 'boom' },
    })
    const reconciler = new WorkflowReconciler(makeDeps())
    const run = () =>
      reconciler.reconcile(
        'sdk-recipe',
        'uid-sdk',
        sandboxNamespace,
        sdkSpec(),
        { workflowExecution: { phase: 'initializing' } },
        undefined,
        'sdk-recipe',
        undefined
      )

    expect((await run()).message).toContain('starting')
    expect((await run()).message).toContain('starting')

    // The replacement was not rolled by WRC, so no explicit reset hook runs.
    // The budget must still restart because it is keyed by pod UID/provider/model.
    podUid = 'pod-uid-2'
    const replacementFirstFailure = await run()
    expect(replacementFirstFailure.message).toContain('starting')
    expect(replacementFirstFailure.message).not.toContain('provider unavailable')

    expect((await run()).message).toContain('starting')
    const replacementThirdFailure = await run()
    expect(replacementThirdFailure.message).toContain('provider unavailable')
  })

  it('re-brokers the provider after the eager mcp-host pod restarts (new uid)', async () => {
    const reconciler = new WorkflowReconciler(makeDeps())
    crashRecoveryMocks.getPodReadiness.mockResolvedValue({
      ready: true,
      phase: 'Running',
      uid: 'pod-uid-1',
    })
    await reconciler.reconcile(
      'sdk-recipe',
      'uid-sdk',
      sandboxNamespace,
      sdkSpec(),
      { workflowExecution: { phase: 'initializing' } },
      undefined,
      'sdk-recipe',
      undefined
    )
    // Pod restarted — new UID invalidates the cache, forcing a fresh configure.
    crashRecoveryMocks.getPodReadiness.mockResolvedValue({
      ready: true,
      phase: 'Running',
      uid: 'pod-uid-2',
    })
    await reconciler.reconcile(
      'sdk-recipe',
      'uid-sdk',
      sandboxNamespace,
      sdkSpec(),
      { workflowExecution: { phase: 'initializing' } },
      undefined,
      'sdk-recipe',
      undefined
    )

    expect(mockModelConfigHandler.configurePluginWorkloadSdkBootstrap).toHaveBeenCalledTimes(2)
  })

  it('recreates a wedged (CrashLoopBackOff) eager mcp-host pod', async () => {
    // Pod exists and is Running but stuck in CrashLoopBackOff — the terminal-phase
    // guard alone would never replace it, so the eager path must delete it first.
    crashRecoveryMocks.getPodPhase.mockResolvedValue('Running')
    crashRecoveryMocks.getContainerWaitingReason.mockResolvedValue('CrashLoopBackOff')
    const reconciler = new WorkflowReconciler(makeDeps())

    await reconciler.reconcile(
      'sdk-recipe',
      'uid-sdk',
      sandboxNamespace,
      sdkSpec(),
      { workflowExecution: { phase: 'initializing' } },
      undefined,
      'sdk-recipe',
      undefined
    )

    expect(crashRecoveryMocks.deletePodIfExists).toHaveBeenCalledWith(
      mockCoreApi,
      'sdk-recipe-mcp-host',
      sandboxNamespace
    )
    // After deletion the pod is recreated in the same pass.
    const podNames = mockCoreApi.createNamespacedPod.mock.calls.map(
      call => call[0].body.metadata.name
    )
    expect(podNames).toContain('sdk-recipe-mcp-host')
  })
})
