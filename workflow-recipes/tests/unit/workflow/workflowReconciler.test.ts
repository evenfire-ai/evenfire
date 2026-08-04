/**
 * Tests for workflowReconciler reconcile loop.
 *  *
 * WorkflowReconciler.reconcile() signature:
 *   reconcile(recipeName, recipeUid, namespace, spec, currentStatus?)
 *
 * Deps: { coreApi, customApi, networkingApi, batchApi?, config, tokenFactory }
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mintRecipeHostGfsToken } from '../../../src/gfsBinding'
import {
  resolveStatefulSetHeadlessServiceName,
  resolveWorkloadMcpServerLabel,
  resolveWorkloadRuntimeResourceName,
} from '../../../src/reconciler/resourceBuilder'
import {
  issueMcpHostRuntimeTokens,
  issueMcpHostWorkflowControlToken,
} from '../../../src/workflow/mcpHostRuntimeTokenIssuerClient'
import { buildMcpHostRouteAliasServiceName } from '../../../src/workflow/resourceNames'
import {
  type WorkflowRecipeSpec,
  WorkflowReconciler,
  type WorkflowReconcilerDeps,
} from '../../../src/workflow/workflowReconciler'

vi.mock('../../../src/workflow/mcpHostRuntimeTokenIssuerClient', () => ({
  issueMcpHostRuntimeTokens: vi.fn().mockResolvedValue({
    accessToken: 'mcp-host-runtime-access-token',
    refreshToken: 'mcp-host-runtime-refresh-token',
    mcpHostControlToken: 'mcp-host-workflow-control-token',
    expiresInSeconds: 3600,
    controlExpiresInSeconds: 3600,
  }),
  issueMcpHostWorkflowControlToken: vi.fn().mockResolvedValue('mcp-host-workflow-control-token'),
}))

vi.mock('../../../src/gfsBinding', () => ({
  mintRecipeHostGfsToken: vi.fn().mockResolvedValue({
    ['to'.concat('ken')]: 'gfs-runtime-value',
    expiresInSeconds: 300,
    subject: 'host:3rd:sandbox-recipes/workflow-recipe',
  }),
}))

// ─── Mock helpers ────────────────────────────────────────────────────────────

function makeSpec(overrides: Partial<WorkflowRecipeSpec> = {}): WorkflowRecipeSpec {
  return {
    agent: { provider: 'openai', model: 'gpt-4o' },
    steps: [
      { id: 's1', instruction: 'Do step 1' },
      { id: 's2', instruction: 'Do step 2', dependsOn: ['s1'] },
    ],
    ...overrides,
  }
}

function snippetRun(code = 'return { ok: true }') {
  return { type: 'snippet' as const, language: 'typescript' as const, code }
}

function makeConfig() {
  return {
    sandboxNamespace: 'sandbox-recipes',
    controlPlaneNamespace: 'control-plane',
    mcpServerNamespace: 'mcp-server',
    wrcPort: 8082,
    mcpHostPort: 8080,
    coordinatorImage: 'clerum/coordinator:test',
    mcpHostImage: 'clerum/mcp-host:test',
    artifactReaderImage: 'clerum/workflow-recipes:test',
    maxWorkflowSteps: 100,
    workflowDefaultRunDurationSeconds: 3600,
    workflowMaxRunDurationSeconds: 86_400,
    runtimeTokenTtlSeconds: 900,
    runtimeTokenRefreshBeforeSeconds: 300,
    runtimeEgressDnsOverlapSeconds: 300,
    workflowMaxWorkloadsPerRecipe: 25,
    workflowUiEgressInternalMaxItems: 25,
    workflowMaxSteps: 100,
    workflowStepDependsOnMaxItems: 100,
    workflowStepAllowedToolsMaxItems: 50,
    workflowStepMcpServersMaxItems: 20,
    workflowStatefulSetMaxReplicas: 20,
    workflowStatefulSetMaxVolumeClaimTemplates: 4,
    workflowStatefulSetMaxPvcPreflightChecks: 80,
  }
}

function makeTokenFactory() {
  return {
    signCoordinatorToMcpHostToken: vi.fn().mockResolvedValue('coord-mcp-token'),
    signCoordinatorToWrcToken: vi.fn().mockResolvedValue('coord-wrc-token'),
    // Split WRC→mcp-host signers (2026-04-09 refactor). No persistent token store.
    signWrcConfigureToken: vi.fn().mockResolvedValue('wrc-configure-token'),
    signWrcArtifactToken: vi.fn().mockResolvedValue('wrc-artifact-token'),
    signWrcArtifactDeleteToken: vi.fn().mockResolvedValue('wrc-artifact-delete-token'),
    signCustomCoordinatorToWrcToken: vi.fn().mockResolvedValue('custom-coord-wrc-token'),
  }
}

function makeCoreApi(
  podExists = false,
  options: {
    workflowOutputAnchorPhase?: string | null
    workflowOutputPreparePhase?: string | null
    workflowOutputPrepareWaitingReason?: string
    workflowOutputPrepareSchedulingReason?: string
  } = {}
) {
  const createdPods = new Map<string, unknown>()
  const workflowOutputPreparePhase = Object.prototype.hasOwnProperty.call(
    options,
    'workflowOutputPreparePhase'
  )
    ? options.workflowOutputPreparePhase
    : 'Succeeded'
  const workflowOutputAnchorPhase = Object.prototype.hasOwnProperty.call(
    options,
    'workflowOutputAnchorPhase'
  )
    ? options.workflowOutputAnchorPhase
    : 'Running'
  const readyPod = (name: string) => ({
    metadata: { name },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'True' }],
    },
  })
  const workflowOutputPreparePod = (name: string) => ({
    metadata: { name },
    status: {
      phase: workflowOutputPreparePhase ?? undefined,
      conditions: [
        ...(options.workflowOutputPrepareSchedulingReason
          ? [
              {
                type: 'PodScheduled',
                status: 'False',
                reason: options.workflowOutputPrepareSchedulingReason,
              },
            ]
          : []),
      ],
      containerStatuses: options.workflowOutputPrepareWaitingReason
        ? [
            {
              state: {
                waiting: { reason: options.workflowOutputPrepareWaitingReason },
              },
            },
          ]
        : [],
    },
  })
  const workflowOutputAnchorPod = (name: string) => ({
    metadata: { name },
    status: {
      phase: workflowOutputAnchorPhase ?? undefined,
      conditions:
        workflowOutputAnchorPhase === 'Running' ? [{ type: 'Ready', status: 'True' }] : [],
    },
  })

  return {
    createNamespacedSecret: vi.fn().mockResolvedValue({}),
    readNamespacedSecret: vi.fn().mockRejectedValue({ code: 404 }),
    patchNamespacedSecret: vi.fn().mockResolvedValue({}),
    replaceNamespacedSecret: vi.fn().mockResolvedValue({}),
    deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
    createNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    readNamespacedConfigMap: vi.fn().mockRejectedValue({ code: 404 }),
    replaceNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    // Pod API on CoreV1Api
    createNamespacedPod: vi.fn().mockImplementation(async ({ body }) => {
      const name = body?.metadata?.name
      if (name) createdPods.set(name, body)
      return {}
    }),
    readNamespacedPod: vi.fn().mockImplementation(async ({ name }) => {
      const isKnownRuntimePodName = [
        '-coordinator',
        '-mcp-host',
        '-artifact-reader',
        '-snippet-runner',
        '-workflow-output-prepare',
      ].some(suffix => name.endsWith(suffix))
      if (name.endsWith('-workflow-output-anchor') || !isKnownRuntimePodName) {
        if (workflowOutputAnchorPhase === null) throw { code: 404 }
        return workflowOutputAnchorPod(name)
      }
      if (name.endsWith('-workflow-output-prepare')) {
        if (workflowOutputPreparePhase === null) throw { code: 404 }
        return workflowOutputPreparePod(name)
      }
      if (podExists || createdPods.has(name)) return readyPod(name)
      throw { code: 404 }
    }),
    deleteNamespacedPod: vi.fn().mockResolvedValue({}),
    listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
    createNamespacedService: vi.fn().mockResolvedValue({}),
    readNamespacedService: vi.fn().mockRejectedValue({ code: 404 }),
    replaceNamespacedService: vi.fn().mockResolvedValue({}),
    deleteNamespacedService: vi.fn().mockResolvedValue({}),
    deleteCollectionNamespacedService: vi.fn().mockResolvedValue({}),
    // PVC API
    readNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({
      metadata: {
        annotations: {
          'volume.kubernetes.io/selected-node': 'node-a',
        },
      },
      spec: { accessModes: ['ReadWriteOnce'] },
      status: { accessModes: ['ReadWriteOnce'] },
    }),
    createNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
    deleteNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
  }
}

function getCreatedMcpHostPod(coreApi: ReturnType<typeof makeCoreApi>) {
  const call = coreApi.createNamespacedPod.mock.calls.find(
    ([arg]) => arg.body?.metadata?.name === 'test-wf-mcp-host'
  )
  if (!call) {
    const createdPodNames = coreApi.createNamespacedPod.mock.calls
      .map(([arg]) => arg.body?.metadata?.name)
      .filter(Boolean)
      .join(', ')
    throw new Error(`expected WRC to create test-wf-mcp-host pod; created: ${createdPodNames}`)
  }
  return call[0].body
}

function getCreatedCoordinatorPod(coreApi: ReturnType<typeof makeCoreApi>) {
  const call = coreApi.createNamespacedPod.mock.calls.find(
    ([arg]) => arg.body?.metadata?.name === 'test-wf-coordinator'
  )
  if (!call) {
    const createdPodNames = coreApi.createNamespacedPod.mock.calls
      .map(([arg]) => arg.body?.metadata?.name)
      .filter(Boolean)
      .join(', ')
    throw new Error(`expected WRC to create test-wf-coordinator pod; created: ${createdPodNames}`)
  }
  return call[0].body
}

function getCreatedArtifactReaderPod(coreApi: ReturnType<typeof makeCoreApi>) {
  const call = coreApi.createNamespacedPod.mock.calls.find(
    ([arg]) => arg.body?.metadata?.name === 'test-wf-artifact-reader'
  )
  if (!call) {
    const createdPodNames = coreApi.createNamespacedPod.mock.calls
      .map(([arg]) => arg.body?.metadata?.name)
      .filter(Boolean)
      .join(', ')
    throw new Error(
      `expected WRC to create test-wf-artifact-reader pod; created: ${createdPodNames}`
    )
  }
  return call[0].body
}

function getCreatedSnippetRunnerPod(coreApi: ReturnType<typeof makeCoreApi>) {
  const call = coreApi.createNamespacedPod.mock.calls.find(
    ([arg]) => arg.body?.metadata?.name === 'test-wf-snippet-runner'
  )
  if (!call) {
    const createdPodNames = coreApi.createNamespacedPod.mock.calls
      .map(([arg]) => arg.body?.metadata?.name)
      .filter(Boolean)
      .join(', ')
    throw new Error(
      `expected WRC to create test-wf-snippet-runner pod; created: ${createdPodNames}`
    )
  }
  return call[0].body
}

function getCreatedWorkflowOutputAnchorPod(
  coreApi: ReturnType<typeof makeCoreApi>,
  name = 'test-wf-workflow-output-anchor'
) {
  const call = coreApi.createNamespacedPod.mock.calls.find(
    ([arg]) => arg.body?.metadata?.name === name
  )
  if (!call) {
    const createdPodNames = coreApi.createNamespacedPod.mock.calls
      .map(([arg]) => arg.body?.metadata?.name)
      .filter(Boolean)
      .join(', ')
    throw new Error(`expected WRC to create ${name} pod; created: ${createdPodNames}`)
  }
  return call[0].body
}

function getCreatedWorkflowOutputPreparePod(
  coreApi: ReturnType<typeof makeCoreApi>,
  name = 'test-wf-workflow-output-prepare'
) {
  const call = coreApi.createNamespacedPod.mock.calls.find(
    ([arg]) => arg.body?.metadata?.name === name
  )
  if (!call) {
    const createdPodNames = coreApi.createNamespacedPod.mock.calls
      .map(([arg]) => arg.body?.metadata?.name)
      .filter(Boolean)
      .join(', ')
    throw new Error(`expected WRC to create ${name} pod; created: ${createdPodNames}`)
  }
  return call[0].body
}

function expectWorkflowOutputAnchorAffinity(
  pod: { spec?: { affinity?: any; nodeName?: string } },
  claimLabel = 'test-wf-workflow-output'
): void {
  const required =
    pod.spec!.affinity!.podAffinity!.requiredDuringSchedulingIgnoredDuringExecution![0]
  expect(pod.spec!.nodeName).toBeUndefined()
  expect(required.topologyKey).toBe('kubernetes.io/hostname')
  expect(required.labelSelector!.matchExpressions).toEqual([
    { key: 'clerum.io/workflow-output-claim', operator: 'In', values: [claimLabel] },
    { key: 'clerum.io/component', operator: 'In', values: ['workflow-output-anchor'] },
  ])
}

function makeCustomApi() {
  return {
    patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    getNamespacedCustomObject: vi.fn().mockResolvedValue({
      metadata: { name: 'test-wf', resourceVersion: '1' },
      spec: {},
      status: {},
    }),
    createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
  }
}

function makeNetworkingApi() {
  return {
    createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    readNamespacedNetworkPolicy: vi.fn().mockRejectedValue({ code: 404 }),
    replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    listNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ items: [] }),
  }
}

function hasPublicHttpEgressRule(policy: {
  spec?: {
    egress?: Array<{
      to?: Array<{ ipBlock?: { cidr?: string; except?: string[] } }>
      ports?: Array<{ port?: number | string }>
    }>
  }
}): boolean {
  return Boolean(
    policy.spec?.egress?.some(rule => {
      const ports = new Set(rule.ports?.map(port => port.port))
      const requiredExcludes = [
        '0.0.0.0/8',
        '10.0.0.0/8',
        '100.64.0.0/10',
        '127.0.0.0/8',
        '169.254.0.0/16',
        '172.16.0.0/12',
        '192.0.0.0/24',
        '192.0.2.0/24',
        '192.31.196.0/24',
        '192.52.193.0/24',
        '192.88.99.0/24',
        '192.168.0.0/16',
        '192.175.48.0/24',
        '198.51.100.0/24',
        '198.18.0.0/15',
        '203.0.113.0/24',
        '224.0.0.0/4',
        '240.0.0.0/4',
      ]
      return (
        ports.has(443) &&
        ports.has(80) &&
        rule.to?.some(target => {
          const block = target.ipBlock
          return Boolean(
            block?.cidr &&
            (block.cidr !== '0.0.0.0/0' ||
              requiredExcludes.every(item => block.except?.includes(item)))
          )
        })
      )
    })
  )
}

function publicHttpEgressCidrs(policy: {
  spec?: {
    egress?: Array<{
      to?: Array<{ ipBlock?: { cidr?: string } }>
      ports?: Array<{ port?: number | string }>
    }>
  }
}): string[] {
  return (
    policy.spec?.egress
      ?.filter(rule => {
        const ports = new Set(rule.ports?.map(port => port.port))
        return ports.has(443) && ports.has(80)
      })
      .flatMap(rule => rule.to?.map(target => target.ipBlock?.cidr).filter(Boolean) ?? []) ?? []
  )
}

function makeDeps(overrides: Partial<WorkflowReconcilerDeps> = {}): WorkflowReconcilerDeps {
  return {
    coreApi: makeCoreApi() as never,
    customApi: makeCustomApi() as never,
    networkingApi: makeNetworkingApi() as never,
    config: makeConfig() as never,
    tokenFactory: makeTokenFactory() as never,
    resolveRuntimeHttpEgressCidrs: vi.fn().mockResolvedValue(['93.184.216.34/32']),
    ...overrides,
  }
}

function makePgPool() {
  const query = vi.fn(async (sql: string) => {
    const trimmed = sql.trim().toUpperCase()
    if (trimmed.startsWith('SELECT')) {
      return { rows: [], rowCount: 0 }
    }
    return { rows: [], rowCount: 1 }
  })
  const release = vi.fn()
  const connect = vi.fn(async () => ({ query, release }))
  return {
    query,
    connect,
    release,
    pool: { query, connect } as unknown as NonNullable<WorkflowReconcilerDeps['pgPool']>,
  }
}

function makeJwtWithExp(
  expiresInSecondsFromNow: number,
  extraClaims: Record<string, unknown> = {}
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const recipeNamespace =
    typeof extraClaims.recipeNamespace === 'string'
      ? extraClaims.recipeNamespace
      : 'recipe-runtime-ns'
  const recipeName = typeof extraClaims.recipeName === 'string' ? extraClaims.recipeName : 'test-wf'
  const hostRefs = Array.isArray(extraClaims.hostRefs)
    ? extraClaims.hostRefs
    : [`${recipeNamespace}/${recipeName}`]
  const payload = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + expiresInSecondsFromNow,
      recipeNamespace,
      recipeName,
      hostRefs,
      ...extraClaims,
    })
  ).toString('base64url')
  return `${header}.${payload}.signature`
}

function makeEncodedGfsAccess(
  expiresInSecondsFromNow = 3600,
  recipeName = 'test-wf',
  scopes = ['gfs.read']
): string {
  return Buffer.from(
    makeJwtWithExp(expiresInSecondsFromNow, {
      sub: `host:3rd:recipe-runtime-ns/${recipeName}`,
      recipeName,
      scopes,
    })
  ).toString('base64')
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WorkflowReconciler — reconcile loop', () => {
  let deps: WorkflowReconcilerDeps
  const runId = '00000000-0000-4000-8000-000000000001'

  beforeEach(() => {
    vi.clearAllMocks()
    deps = makeDeps()
    vi.mocked(issueMcpHostRuntimeTokens).mockResolvedValue({
      accessToken: 'mcp-host-runtime-access-token',
      refreshToken: 'mcp-host-runtime-refresh-token',
      mcpHostControlToken: 'mcp-host-workflow-control-token',
      expiresInSeconds: 3600,
      controlExpiresInSeconds: 3600,
    })
    vi.mocked(issueMcpHostWorkflowControlToken).mockResolvedValue('mcp-host-workflow-control-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns a result with a defined phase on fresh reconcile', async () => {
    const reconciler = new WorkflowReconciler(deps)
    const result = await reconciler.reconcile('test-wf', 'uid-123', 'sandbox-recipes', makeSpec())
    expect(result.phase).toBeDefined()
    expect(typeof result.phase).toBe('string')
  })

  it('registers fresh agentic parent infrastructure as active while it waits for a triggered run', async () => {
    const reconciler = new WorkflowReconciler(deps)
    const result = await reconciler.reconcile('test-wf', 'uid-123', 'sandbox-recipes', makeSpec())
    expect(result.phase).toBe('active')
    expect(result.workflowPhase).toBeUndefined()
    expect(result.clearWorkflowExecution).toBe(true)
  })

  it('rejects workflow specs above configured runtime limits before creating resources', async () => {
    const coreApi = makeCoreApi()
    deps = makeDeps({
      coreApi: coreApi as never,
      config: { ...makeConfig(), workflowMaxSteps: 2 } as never,
    })
    const reconciler = new WorkflowReconciler(deps)

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        steps: [
          { id: 's1', instruction: 'Do step 1' },
          { id: 's2', instruction: 'Do step 2' },
          { id: 's3', instruction: 'Do step 3' },
        ],
      })
    )

    expect(result).toMatchObject({
      phase: 'failed',
      workflowPhase: 'failed',
      message: 'spec.steps must contain at most 2 items',
    })
    expect(coreApi.createNamespacedConfigMap).not.toHaveBeenCalled()
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
    expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled()
  })

  it('maps a running workflow execution to active recipe infrastructure', async () => {
    const reconciler = new WorkflowReconciler(deps)
    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec(),
      {
        workflowExecution: { phase: 'running' },
        steps: [],
      },
      undefined,
      undefined,
      runId
    )
    expect(result.phase).toBe('active')
    expect(result.workflowPhase).toBe('running')
  })

  it('creates coordinator Secret via coreApi', async () => {
    const reconciler = new WorkflowReconciler(deps)
    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec(),
      undefined,
      undefined,
      undefined,
      runId
    )
    expect(deps.coreApi.createNamespacedSecret).toHaveBeenCalled()
  })

  it('issues mcpHost runtime tokens for the logical recipe namespace, not sandbox-recipes', async () => {
    const reconciler = new WorkflowReconciler(deps)
    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'recipe-runtime-ns',
      makeSpec(),
      undefined,
      undefined,
      undefined,
      runId
    )

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledWith('recipe-runtime-ns', 'test-wf', [])
  })

  it('issues mcpHost runtime tokens for the parent recipe when reconciling a child workflow run', async () => {
    const reconciler = new WorkflowReconciler(deps)
    await reconciler.reconcile(
      'test-wf-child',
      'uid-123',
      'recipe-runtime-ns',
      makeSpec(),
      undefined,
      undefined,
      'test-wf',
      runId
    )

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledWith('recipe-runtime-ns', 'test-wf', [])
  })

  it('creates coordinator ConfigMap via coreApi', async () => {
    const reconciler = new WorkflowReconciler(deps)
    await reconciler.reconcile('test-wf', 'uid-123', 'sandbox-recipes', makeSpec())
    expect(deps.coreApi.createNamespacedConfigMap).toHaveBeenCalled()
  })

  it('persists per-step timeout, backoff, and retry settings into the coordinator config', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        steps: [
          {
            id: 'render',
            run: snippetRun(),
            timeoutSeconds: 12,
            backoffSeconds: 3,
            maxRetries: 5,
          },
        ],
      })
    )

    const configMap = coreApi.createNamespacedConfigMap.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === 'test-wf-workflow-config'
    )?.[0].body
    const config = JSON.parse(configMap!.data!['config.json'])
    expect(config.steps[0]).toMatchObject({
      id: 'render',
      timeoutSeconds: 12,
      backoffSeconds: 3,
      maxRetries: 5,
    })
  })

  it('creates snippet runner and artifact reader for TypeScript snippet workflows without mcp-host', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    // Shared Secret (clerum.io/shared=true) so the snippet capability passes the
    // Issue #637 ownership gate — a "public-api-key" is the shared-secret case.
    coreApi.readNamespacedSecret.mockResolvedValue({
      metadata: { labels: { 'clerum.io/shared': 'true' } },
      data: { key: 'dmFsdWU=' },
    })
    const networkingApi = makeNetworkingApi() as ReturnType<typeof makeNetworkingApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        networkingApi: networkingApi as never,
        config: {
          ...makeConfig(),
          enableSnippetRuntime: true,
          snippetRunnerImage: 'clerum/workflow-snippet-runner:test',
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        workloads: [{ id: 'postgres', type: 'deployment', image: 'postgres:16', port: 5432 }],
        steps: [
          {
            id: 'snippet',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return await sdk.postgres.query({ workload: "postgres", database: "clerum" }, { sql: "select 1" })',
              capabilities: {
                secrets: [{ alias: 'api_key', secretRef: { name: 'public-api-key', key: 'key' } }],
                postgres: { access: 'read', workloads: ['postgres'] },
              },
            },
          },
        ],
      })
    )

    expect(result.workflowPhase).not.toBe('failed')
    const snippetRunnerPod = getCreatedSnippetRunnerPod(coreApi)
    expect(snippetRunnerPod.spec.containers[0].image).toBe('clerum/workflow-snippet-runner:test')
    expect(getCreatedArtifactReaderPod(coreApi)).toBeDefined()
    expect(
      coreApi.createNamespacedPod.mock.calls.some(
        ([arg]) => arg.body?.metadata?.name === 'test-wf-mcp-host'
      )
    ).toBe(false)
    expect(
      networkingApi.createNamespacedNetworkPolicy.mock.calls
        .map(([arg]) => arg.body.metadata.name)
        .filter((name: string) => name.includes('snippet-runner'))
    ).toEqual(
      expect.arrayContaining([
        'test-wf-coord-to-snippet-runner',
        'test-wf-coord-to-snippet-runner-ingress',
        'test-wf-snippet-runner-egress',
      ])
    )
  })

  it('uses a dedicated workflow output PVC when snippet workflows declare pvc output', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedSecret.mockResolvedValue({ data: { key: 'dmFsdWU=' } })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableSnippetRuntime: true,
          snippetRunnerImage: 'clerum/workflow-snippet-runner:test',
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [
          {
            id: 'snippet',
            run: snippetRun('return await sdk.artifacts.writeJson("report.json", { ok: true })'),
          },
        ],
        output: { destination: 'pvc', storageSize: '1Gi' },
      })
    )

    const snippetRunnerPod = getCreatedSnippetRunnerPod(coreApi)
    const artifactReaderPod = getCreatedArtifactReaderPod(coreApi)
    const snippetOutputMount = snippetRunnerPod.spec!.containers![0].volumeMounts!.find(
      (m: { mountPath: string }) => m.mountPath === '/output'
    )
    const artifactReaderOutputMount = artifactReaderPod.spec!.containers![0].volumeMounts!.find(
      (m: { mountPath: string }) => m.mountPath === '/output'
    )

    expect(snippetOutputMount).toMatchObject({
      name: 'recipe-output',
      mountPath: '/output',
      subPath: 'workflow-output/test-wf',
    })
    expect(artifactReaderOutputMount).toMatchObject({
      name: 'recipe-output',
      mountPath: '/output',
      subPath: 'workflow-output/test-wf',
    })
    expect(
      snippetRunnerPod.spec!.volumes!.find((v: { name: string }) => v.name === 'recipe-output')!
        .persistentVolumeClaim!.claimName
    ).toBe('test-wf-workflow-output')
    expect(
      artifactReaderPod.spec!.volumes!.find((v: { name: string }) => v.name === 'recipe-output')!
        .persistentVolumeClaim!.claimName
    ).toBe('test-wf-workflow-output')
    expect(coreApi.createNamespacedPersistentVolumeClaim).toHaveBeenCalledWith({
      namespace: 'sandbox-recipes',
      body: expect.objectContaining({
        metadata: expect.objectContaining({
          name: 'test-wf-workflow-output',
          labels: expect.objectContaining({
            'clerum.io/recipe': 'test-wf',
            'clerum.io/component': 'workflow-output',
          }),
        }),
        spec: expect.objectContaining({
          resources: { requests: { storage: '1Gi' } },
        }),
      }),
    })
    expect(
      coreApi.createNamespacedPod.mock.calls.some(
        ([arg]) => arg.body?.metadata?.name === 'test-wf-workflow-output-prepare'
      )
    ).toBe(false)
    expect(result.workflowConditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'WorkflowOutputPrepareGate' }),
        expect.objectContaining({ type: 'WorkflowOutputWrcManagedLifecycle' }),
      ])
    )
  })

  it('creates the workflow output anchor pod and waits before starting prepare/runtime pods', async () => {
    const coreApi = makeCoreApi(false, {
      workflowOutputAnchorPhase: null,
      workflowOutputPreparePhase: null,
    }) as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedSecret.mockResolvedValue({ data: { key: 'dmFsdWU=' } })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableSnippetRuntime: true,
          snippetRunnerImage: 'clerum/workflow-snippet-runner:test',
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [
          {
            id: 'snippet',
            run: snippetRun('return await sdk.artifacts.writeJson("report.json", { ok: true })'),
          },
        ],
        output: { destination: 'pvc', storageSize: '1Gi' },
      })
    )

    expect(result.phase).toBe('deploying')
    expect(result.message).toContain('Created workflow output anchor pod')
    expect(getCreatedWorkflowOutputAnchorPod(coreApi)).toBeDefined()
    expect(
      coreApi.createNamespacedPod.mock.calls.some(
        ([arg]) => arg.body?.metadata?.name === 'test-wf-workflow-output-prepare'
      )
    ).toBe(false)
    expect(
      coreApi.createNamespacedPod.mock.calls.some(
        ([arg]) => arg.body?.metadata?.name === 'test-wf-snippet-runner'
      )
    ).toBe(false)
  })

  it('creates a workflow output prepare pod and blocks runtime pods until it succeeds', async () => {
    const coreApi = makeCoreApi(false, { workflowOutputPreparePhase: null }) as ReturnType<
      typeof makeCoreApi
    >
    coreApi.readNamespacedSecret.mockResolvedValue({ data: { key: 'dmFsdWU=' } })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableSnippetRuntime: true,
          snippetRunnerImage: 'clerum/workflow-snippet-runner:test',
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [
          {
            id: 'snippet',
            run: snippetRun('return await sdk.artifacts.writeJson("report.json", { ok: true })'),
          },
        ],
        output: { destination: 'pvc', storageSize: '1Gi' },
      })
    )

    const preparePod = getCreatedWorkflowOutputPreparePod(coreApi)
    expect(result.phase).toBe('deploying')
    expect(result.message).toContain('Created workflow output prepare pod')
    expect(preparePod.spec!.affinity).toBeDefined()
    expect(preparePod.spec!.containers![0].env).toEqual(
      expect.arrayContaining([
        { name: 'WORKFLOW_OUTPUT_SUB_PATH', value: 'workflow-output/test-wf' },
      ])
    )
    expect(
      coreApi.createNamespacedPod.mock.calls.some(
        ([arg]) => arg.body?.metadata?.name === 'test-wf-snippet-runner'
      )
    ).toBe(false)
    expect(
      coreApi.createNamespacedPod.mock.calls.some(
        ([arg]) => arg.body?.metadata?.name === 'test-wf-artifact-reader'
      )
    ).toBe(false)
  })

  it('surfaces workflow output prepare pod pending state without reporting an MCP failure', async () => {
    const coreApi = makeCoreApi(false, {
      workflowOutputPreparePhase: 'Pending',
      workflowOutputPrepareSchedulingReason: 'Unschedulable',
    }) as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedSecret.mockResolvedValue({ data: { key: 'dmFsdWU=' } })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableSnippetRuntime: true,
          snippetRunnerImage: 'clerum/workflow-snippet-runner:test',
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [
          {
            id: 'snippet',
            run: snippetRun('return await sdk.artifacts.writeJson("report.json", { ok: true })'),
          },
        ],
      })
    )

    expect(result.phase).toBe('deploying')
    expect(result.message).toContain('Waiting for workflow output prepare pod')
    expect(result.message).toContain('scheduling=Unschedulable')
    expect(result.message).not.toContain('mcp-host')
    expect(
      coreApi.createNamespacedPod.mock.calls.some(
        ([arg]) => arg.body?.metadata?.name === 'test-wf-snippet-runner'
      )
    ).toBe(false)
  })

  it('recreates a failed workflow output prepare pod before starting runtime pods', async () => {
    const coreApi = makeCoreApi(false, { workflowOutputPreparePhase: 'Failed' }) as ReturnType<
      typeof makeCoreApi
    >
    coreApi.readNamespacedSecret.mockResolvedValue({ data: { key: 'dmFsdWU=' } })
    const customApi = makeCustomApi()
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        customApi: customApi as never,
        config: {
          ...makeConfig(),
          enableSnippetRuntime: true,
          snippetRunnerImage: 'clerum/workflow-snippet-runner:test',
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [
          {
            id: 'snippet',
            run: snippetRun('return await sdk.artifacts.writeJson("report.json", { ok: true })'),
          },
        ],
      }),
      {
        workflowExecution: { phase: 'initializing', attempt: 0 },
      }
    )

    expect(result.phase).toBe('deploying')
    expect(result.workflowPhase).toBe('recovering')
    expect(result.message).toContain('recreating it (attempt 1/3)')
    expect(coreApi.deleteNamespacedPod).toHaveBeenCalledWith({
      name: 'test-wf-workflow-output-prepare',
      namespace: 'sandbox-recipes',
    })
    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          status: {
            workflowExecution: expect.objectContaining({
              phase: 'recovering',
              attempt: 1,
            }),
          },
        },
      }),
      expect.anything()
    )
    expect(
      coreApi.createNamespacedPod.mock.calls.some(
        ([arg]) => arg.body?.metadata?.name === 'test-wf-snippet-runner'
      )
    ).toBe(false)
  })

  it('fails the workflow output prepare gate after the retry budget is exhausted', async () => {
    const coreApi = makeCoreApi(false, { workflowOutputPreparePhase: 'Failed' }) as ReturnType<
      typeof makeCoreApi
    >
    coreApi.readNamespacedSecret.mockResolvedValue({ data: { key: 'dmFsdWU=' } })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableSnippetRuntime: true,
          snippetRunnerImage: 'clerum/workflow-snippet-runner:test',
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [
          {
            id: 'snippet',
            run: snippetRun('return await sdk.artifacts.writeJson("report.json", { ok: true })'),
          },
        ],
      }),
      {
        workflowExecution: { phase: 'recovering', attempt: 3 },
      }
    )

    expect(result.phase).toBe('failed')
    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('prepare pod failed after 3 recovery attempts')
    expect(coreApi.deleteNamespacedPod).not.toHaveBeenCalledWith({
      name: 'test-wf-workflow-output-prepare',
      namespace: 'sandbox-recipes',
    })
  })

  it('uses an external workflow output PVC claim without creating or deleting it', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedPersistentVolumeClaim = vi.fn().mockResolvedValue({
      metadata: {
        name: 'external-output-claim',
        labels: {
          'clerum.io/workflow-output-external': 'true',
          'clerum.io/workflow-output-claim': 'external-output-claim',
          'clerum.io/workflow-output-scope': 'test-wf',
        },
      },
      status: { phase: 'Bound' },
    })
    coreApi.readNamespacedSecret.mockResolvedValue({ data: { key: 'dmFsdWU=' } })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableSnippetRuntime: true,
          snippetRunnerImage: 'clerum/workflow-snippet-runner:test',
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [
          {
            id: 'snippet',
            run: snippetRun('return await sdk.artifacts.writeJson("report.json", { ok: true })'),
          },
        ],
        output: { destination: 'pvc', claimName: 'external-output-claim' },
      })
    )

    const snippetRunnerPod = getCreatedSnippetRunnerPod(coreApi)
    const artifactReaderPod = getCreatedArtifactReaderPod(coreApi)
    expect(
      snippetRunnerPod.spec!.volumes!.find((v: { name: string }) => v.name === 'recipe-output')!
        .persistentVolumeClaim!.claimName
    ).toBe('external-output-claim')
    expect(
      artifactReaderPod.spec!.volumes!.find((v: { name: string }) => v.name === 'recipe-output')!
        .persistentVolumeClaim!.claimName
    ).toBe('external-output-claim')
    expect(coreApi.readNamespacedPersistentVolumeClaim).toHaveBeenCalledWith({
      name: 'external-output-claim',
      namespace: 'sandbox-recipes',
    })
    expect(coreApi.createNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(
      coreApi.createNamespacedPod.mock.calls.some(
        ([arg]) => arg.body?.metadata?.name === 'test-wf-workflow-output-prepare'
      )
    ).toBe(false)
    expect(result.workflowConditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'WorkflowOutputExternalClaim' }),
        expect.objectContaining({ type: 'WorkflowOutputRwoCompatibility' }),
      ])
    )
  })

  it('rejects an external workflow output PVC claim managed by another WRC scope', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedPersistentVolumeClaim = vi.fn().mockResolvedValue({
      metadata: {
        name: 'other-wf-workflow-output',
        labels: {
          'clerum.io/managed-by': 'wrc',
          'clerum.io/component': 'workflow-output',
          'clerum.io/workflow-output-claim': 'other-wf-workflow-output',
          'clerum.io/workflow-output-scope': 'other-wf',
        },
      },
      status: { phase: 'Bound' },
    })
    coreApi.readNamespacedSecret.mockResolvedValue({ data: { key: 'dmFsdWU=' } })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableSnippetRuntime: true,
          snippetRunnerImage: 'clerum/workflow-snippet-runner:test',
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [{ id: 'snippet', run: snippetRun() }],
        output: { destination: 'pvc', claimName: 'other-wf-workflow-output' },
      })
    )

    expect(result.phase).toBe('failed')
    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('managed by WRC')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects an external workflow output PVC claim managed by the same WRC scope', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedPersistentVolumeClaim = vi.fn().mockResolvedValue({
      metadata: {
        name: 'test-wf-workflow-output',
        labels: {
          'clerum.io/managed-by': 'wrc',
          'clerum.io/component': 'workflow-output',
          'clerum.io/workflow-output-claim': 'test-wf-workflow-output',
          'clerum.io/workflow-output-scope': 'test-wf',
        },
      },
      status: { phase: 'Bound' },
    })
    coreApi.readNamespacedSecret.mockResolvedValue({ data: { key: 'dmFsdWU=' } })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableSnippetRuntime: true,
          snippetRunnerImage: 'clerum/workflow-snippet-runner:test',
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [{ id: 'snippet', run: snippetRun() }],
        output: { destination: 'pvc', claimName: 'test-wf-workflow-output' },
      })
    )

    expect(result.phase).toBe('failed')
    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('managed by WRC')
    expect(result.message).toContain('remove spec.output.claimName')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects an unlabeled external workflow output PVC claim', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedPersistentVolumeClaim = vi.fn().mockResolvedValue({
      metadata: { name: 'external-output-claim' },
      status: { phase: 'Bound' },
    })
    coreApi.readNamespacedSecret.mockResolvedValue({ data: { key: 'dmFsdWU=' } })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableSnippetRuntime: true,
          snippetRunnerImage: 'clerum/workflow-snippet-runner:test',
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [{ id: 'snippet', run: snippetRun() }],
        output: { destination: 'pvc', claimName: 'external-output-claim' },
      })
    )

    expect(result.phase).toBe('failed')
    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('is not labeled for workflow output scope "test-wf"')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('preserves workflow output condition transition times across steady reconciles', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedPersistentVolumeClaim = vi.fn().mockResolvedValue({
      metadata: {
        name: 'external-output-claim',
        labels: {
          'clerum.io/workflow-output-external': 'true',
          'clerum.io/workflow-output-claim': 'external-output-claim',
          'clerum.io/workflow-output-scope': 'test-wf',
        },
      },
      status: { phase: 'Bound' },
    })
    coreApi.readNamespacedSecret.mockResolvedValue({ data: { key: 'dmFsdWU=' } })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableSnippetRuntime: true,
        },
      })
    )

    const previousTransition = '2026-01-01T00:00:00.000Z'
    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [
          {
            id: 'snippet',
            run: snippetRun('return await sdk.artifacts.writeJson("report.json", { ok: true })'),
          },
        ],
        output: { destination: 'pvc', claimName: 'external-output-claim' },
      }),
      {
        conditions: [
          {
            type: 'WorkflowOutputRwoCompatibility',
            status: 'True',
            reason: 'RwoOutputClaimCoLocation',
            message: 'previous',
            lastTransitionTime: previousTransition,
          },
        ],
      }
    )

    expect(
      result.workflowConditions?.find(c => c.type === 'WorkflowOutputRwoCompatibility')
        ?.lastTransitionTime
    ).toBe(previousTransition)
  })

  it('surfaces a visible wait when an external workflow output PVC is missing', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedPersistentVolumeClaim = vi.fn().mockRejectedValue({ code: 404 })
    coreApi.readNamespacedSecret.mockResolvedValue({ data: { key: 'dmFsdWU=' } })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableSnippetRuntime: true,
          snippetRunnerImage: 'clerum/workflow-snippet-runner:test',
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [{ id: 'snippet', run: snippetRun() }],
        output: { destination: 'pvc', claimName: 'missing-output-claim' },
      })
    )

    expect(result.phase).toBe('deploying')
    expect(result.message).toContain(
      'External workflow output PVC "missing-output-claim" was not found'
    )
    expect(coreApi.createNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects a pre-existing generated workflow output PVC without matching WRC ownership labels', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.createNamespacedPersistentVolumeClaim = vi.fn().mockRejectedValue({ code: 409 })
    coreApi.readNamespacedPersistentVolumeClaim = vi.fn().mockResolvedValue({
      metadata: {
        name: 'test-wf-workflow-output',
        labels: {
          'clerum.io/managed-by': 'wrc',
          'clerum.io/component': 'workflow-output',
          'clerum.io/workflow-output-claim': 'test-wf-workflow-output',
          'clerum.io/workflow-output-scope': 'other-wf',
        },
      },
      status: { phase: 'Bound' },
    })
    coreApi.readNamespacedSecret.mockResolvedValue({ data: { key: 'dmFsdWU=' } })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableSnippetRuntime: true,
          snippetRunnerImage: 'clerum/workflow-snippet-runner:test',
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [{ id: 'snippet', run: snippetRun() }],
        output: { destination: 'pvc', storageSize: '1Gi' },
      })
    )

    expect(result.phase).toBe('failed')
    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('not managed by WRC for workflow output scope "test-wf"')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('waits for a terminating explicit workflow output PVC before creating runtime pods', async () => {
    vi.useFakeTimers()
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.createNamespacedPersistentVolumeClaim = vi
      .fn()
      .mockRejectedValueOnce({ code: 409 })
      .mockResolvedValueOnce({})
    coreApi.readNamespacedPersistentVolumeClaim = vi
      .fn()
      .mockResolvedValueOnce({
        metadata: { deletionTimestamp: '2026-05-14T00:00:00Z' },
        spec: { accessModes: ['ReadWriteOnce'] },
        status: { accessModes: ['ReadWriteOnce'] },
      })
      .mockRejectedValueOnce({ code: 404 })
      .mockResolvedValue({
        metadata: { annotations: {} },
        spec: { accessModes: ['ReadWriteOnce'] },
        status: { accessModes: ['ReadWriteOnce'] },
      })
    coreApi.readNamespacedSecret.mockResolvedValue({ data: { key: 'dmFsdWU=' } })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableSnippetRuntime: true,
          snippetRunnerImage: 'clerum/workflow-snippet-runner:test',
        } as never,
      })
    )

    const resultPromise = reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [
          {
            id: 'snippet',
            run: snippetRun('return await sdk.artifacts.writeJson("report.json", { ok: true })'),
          },
        ],
        output: { destination: 'pvc', storageSize: '1Gi' },
      })
    )
    await vi.advanceTimersByTimeAsync(1000)
    const result = await resultPromise

    vi.useRealTimers()
    expect(result.workflowPhase).not.toBe('failed')
    expect(coreApi.createNamespacedPersistentVolumeClaim).toHaveBeenCalledTimes(2)
    expect(getCreatedSnippetRunnerPod(coreApi)).toBeDefined()
    expect(getCreatedArtifactReaderPod(coreApi)).toBeDefined()
  })

  it('recreates an explicit workflow output PVC after a Kubernetes delete race', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.createNamespacedPersistentVolumeClaim = vi
      .fn()
      .mockRejectedValueOnce({ code: 409 })
      .mockResolvedValueOnce({})
    coreApi.readNamespacedPersistentVolumeClaim = vi.fn().mockRejectedValue({ code: 404 })
    coreApi.readNamespacedSecret.mockResolvedValue({ data: { key: 'dmFsdWU=' } })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableSnippetRuntime: true,
          snippetRunnerImage: 'clerum/workflow-snippet-runner:test',
        } as never,
      })
    )

    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [
          {
            id: 'snippet',
            run: snippetRun('return await sdk.artifacts.writeJson("report.json", { ok: true })'),
          },
        ],
        output: { destination: 'pvc', storageSize: '1Gi' },
      })
    )

    expect(coreApi.createNamespacedPersistentVolumeClaim).toHaveBeenCalledTimes(2)
    expect(getCreatedSnippetRunnerPod(coreApi)).toBeDefined()
    expect(getCreatedArtifactReaderPod(coreApi)).toBeDefined()
  })

  it('creates artifact reader for agentic mcp-host child runs with tool-generated output artifacts', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const networkingApi = makeNetworkingApi() as ReturnType<typeof makeNetworkingApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        networkingApi: networkingApi as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: { provider: 'zai', model: 'glm-5-turbo' },
        steps: [{ id: 'weekly-report', instruction: 'Generate a weekly summary.' }],
      }),
      undefined,
      undefined,
      undefined,
      'run-123'
    )

    expect(result.workflowPhase).not.toBe('failed')
    expect(getCreatedMcpHostPod(coreApi)).toBeDefined()
    const artifactReaderPod = getCreatedArtifactReaderPod(coreApi)
    expect(artifactReaderPod.spec!.containers![0].volumeMounts).toContainEqual(
      expect.objectContaining({
        name: 'recipe-output',
        mountPath: '/output',
        subPath: 'workflow-output/test-wf/run-123',
      })
    )
    expect(
      networkingApi.createNamespacedNetworkPolicy.mock.calls
        .map(([arg]) => arg.body.metadata.name)
        .filter((name: string) => name.includes('artifact-reader'))
    ).toEqual(expect.arrayContaining(['test-wf-wrc-to-artifact-reader']))
  })

  it('uses the parent workflow output PVC for triggered child runs with explicit pvc output', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    await reconciler.reconcile(
      'parent-wf-run-12345678',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: { provider: 'zai', model: 'glm-5-turbo' },
        steps: [{ id: 'weekly-report', instruction: 'Generate a weekly summary.' }],
        output: { destination: 'pvc', storageSize: '2Gi' },
      }),
      undefined,
      undefined,
      'parent-wf',
      'run-123'
    )

    const mcpHostPod = coreApi.createNamespacedPod.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === 'parent-wf-run-12345678-mcp-host'
    )?.[0].body
    const artifactReaderPod = coreApi.createNamespacedPod.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === 'parent-wf-run-12345678-artifact-reader'
    )?.[0].body

    expect(mcpHostPod).toBeDefined()
    expect(artifactReaderPod).toBeDefined()
    expect(
      mcpHostPod!.spec!.volumes!.find((v: { name: string }) => v.name === 'recipe-output')!
        .persistentVolumeClaim!.claimName
    ).toBe('parent-wf-workflow-output')
    expect(
      artifactReaderPod!.spec!.volumes!.find((v: { name: string }) => v.name === 'recipe-output')!
        .persistentVolumeClaim!.claimName
    ).toBe('parent-wf-workflow-output')
    expect(
      mcpHostPod!.spec!.containers![0].volumeMounts!.find(
        (m: { mountPath: string }) => m.mountPath === '/output'
      )!.subPath
    ).toBe('workflow-output/parent-wf/run-123')
    expect(coreApi.createNamespacedPersistentVolumeClaim).toHaveBeenCalledWith({
      namespace: 'sandbox-recipes',
      body: expect.objectContaining({
        metadata: expect.objectContaining({
          name: 'parent-wf-workflow-output',
          labels: expect.objectContaining({ 'clerum.io/recipe': 'parent-wf' }),
        }),
        spec: expect.objectContaining({
          resources: { requests: { storage: '2Gi' } },
        }),
      }),
    })
  })

  it('uses StatefulSet runtime names for snippet workload config and NetworkPolicy selectors', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const networkingApi = makeNetworkingApi() as ReturnType<typeof makeNetworkingApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        networkingApi: networkingApi as never,
        config: { ...makeConfig(), enableSnippetRuntime: true } as never,
      })
    )
    const recipeName = 'manual-layer3a-api-mongo-postgres-four-step'
    const recipeUid = 'statefulset-runtime-selector-uid'
    const spec = makeSpec({
      agent: undefined,
      workloads: [
        {
          id: 'mongodb',
          type: 'statefulset',
          image: 'mongodb/mongodb-community-server:7.0-ubi8',
          port: 27017,
        },
        { id: 'postgres', type: 'statefulset', image: 'postgres:16-alpine', port: 5432 },
      ],
      steps: [
        {
          id: 'query-mongo',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return await sdk.mongo.find({ workload: "mongodb", database: "clerum", collection: "asset_prices" }, { limit: 1 })',
            capabilities: { mongo: { access: 'read', workloads: ['mongodb'] } },
          },
        },
        {
          id: 'query-postgres',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return await sdk.postgres.query({ workload: "postgres", database: "clerum" }, { sql: "select 1" })',
            capabilities: { postgres: { access: 'read', workloads: ['postgres'] } },
          },
        },
      ],
    })

    const result = await reconciler.reconcile(recipeName, recipeUid, 'sandbox-recipes', spec)

    expect(result.workflowPhase).not.toBe('failed')
    const recipeRef = {
      apiVersion: 'clerum.io/v1alpha1' as const,
      kind: 'WorkflowRecipe' as const,
      metadata: { name: recipeName, namespace: 'sandbox-recipes', uid: recipeUid },
      spec,
    }
    const mongo = spec.workloads![0]
    const postgres = spec.workloads![1]
    const mongoRuntimeName = resolveWorkloadRuntimeResourceName(recipeRef, mongo)
    const postgresRuntimeName = resolveWorkloadRuntimeResourceName(recipeRef, postgres)

    const configMap = coreApi.createNamespacedConfigMap.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === `${recipeName}-workflow-config`
    )?.[0].body
    const config = JSON.parse(configMap!.data!['config.json'])
    expect(config.workloads.find((item: { id: string }) => item.id === 'mongodb')).toMatchObject({
      resourceName: mongoRuntimeName,
      serviceName: resolveStatefulSetHeadlessServiceName(recipeRef, mongo),
      host: `${resolveStatefulSetHeadlessServiceName(recipeRef, mongo)}.sandbox-recipes.svc.cluster.local`,
    })
    expect(config.workloads.find((item: { id: string }) => item.id === 'postgres')).toMatchObject({
      resourceName: postgresRuntimeName,
      serviceName: resolveStatefulSetHeadlessServiceName(recipeRef, postgres),
      host: `${resolveStatefulSetHeadlessServiceName(recipeRef, postgres)}.sandbox-recipes.svc.cluster.local`,
    })

    const snippetEgress = networkingApi.createNamespacedNetworkPolicy.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === `${recipeName}-snippet-runner-egress`
    )?.[0].body
    const selectedApps = snippetEgress!.spec!.egress!.flatMap(rule =>
      (rule.to ?? []).map(peer => peer.podSelector?.matchLabels?.app).filter(Boolean)
    )
    expect(selectedApps).toEqual(expect.arrayContaining([mongoRuntimeName, postgresRuntimeName]))
  })

  it('rejects workflows that exceed WRC_MAX_WORKFLOW_STEPS before creating pods', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: { ...makeConfig(), maxWorkflowSteps: 2 } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        steps: [
          { id: 's1', run: snippetRun() },
          { id: 's2', run: snippetRun() },
          { id: 's3', run: snippetRun() },
        ],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('WRC_MAX_WORKFLOW_STEPS=2')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects snippet secrets that reference platform-managed runtime Secrets', async () => {
    const reconciler = new WorkflowReconciler(
      makeDeps({ config: { ...makeConfig(), enableSnippetRuntime: true } as never })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        runtimeEgress: { http: { allowedHosts: ['api.example.com'] } },
        steps: [
          {
            id: 'snippet',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return {}',
              capabilities: {
                secrets: [
                  {
                    alias: 'wrc_token',
                    secretRef: { name: 'wf-test-wf-coordinator-token', key: 'wrc-token' },
                  },
                ],
              },
            },
          },
        ],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('cannot reference platform-managed secret')
  })

  it('allows snippet HTTP egress through declared allowedHosts and creates scoped public egress policy', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const networkingApi = makeNetworkingApi() as ReturnType<typeof makeNetworkingApi>
    const resolveRuntimeHttpEgressCidrs = vi.fn().mockResolvedValue(['93.184.216.34/32'])
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        networkingApi: networkingApi as never,
        resolveRuntimeHttpEgressCidrs,
        config: { ...makeConfig(), enableSnippetRuntime: true } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        runtimeEgress: { http: { allowedHosts: ['api.example.com'] } },
        steps: [
          {
            id: 'snippet',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return await sdk.http.fetchJson("https://api.example.com/data")',
              capabilities: {
                http: { allowedHosts: ['api.example.com'] },
              },
            },
          },
        ],
      })
    )

    expect(result.workflowPhase).not.toBe('failed')
    expect(resolveRuntimeHttpEgressCidrs).toHaveBeenCalledWith(['api.example.com'])
    expect(coreApi.createNamespacedPod).toHaveBeenCalled()
    const snippetEgress = networkingApi.createNamespacedNetworkPolicy.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === 'test-wf-snippet-runner-egress'
    )?.[0].body
    expect(snippetEgress).toBeDefined()
    expect(hasPublicHttpEgressRule(snippetEgress!)).toBe(true)
    expect(publicHttpEgressCidrs(snippetEgress!)).toEqual(['93.184.216.34/32'])
  })

  it('allows explicit public-web snippet HTTP egress without resolving exact hosts', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const networkingApi = makeNetworkingApi() as ReturnType<typeof makeNetworkingApi>
    const resolveRuntimeHttpEgressCidrs = vi.fn()
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        networkingApi: networkingApi as never,
        resolveRuntimeHttpEgressCidrs,
        config: { ...makeConfig(), enableSnippetRuntime: true } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        runtimeEgress: { http: { egressClass: 'public-web' } },
        steps: [
          {
            id: 'snippet',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return await sdk.http.fetchJson("https://search.example.com/data")',
              capabilities: {
                http: { egressClass: 'public-web' },
              },
            },
          },
        ],
      })
    )

    expect(result.workflowPhase).not.toBe('failed')
    expect(resolveRuntimeHttpEgressCidrs).not.toHaveBeenCalled()
    const snippetEgress = networkingApi.createNamespacedNetworkPolicy.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === 'test-wf-snippet-runner-egress'
    )?.[0].body
    expect(snippetEgress).toBeDefined()
    expect(snippetEgress!.metadata!.labels!['clerum.io/egress-class']).toBe('public-web')
    expect(publicHttpEgressCidrs(snippetEgress!)).toEqual(['0.0.0.0/0'])
    expect(hasPublicHttpEgressRule(snippetEgress!)).toBe(true)
  })

  it('fails closed when declared snippet HTTP egress cannot be resolved to allowed CIDRs', async () => {
    const networkingApi = makeNetworkingApi() as ReturnType<typeof makeNetworkingApi>
    const resolveRuntimeHttpEgressCidrs = vi
      .fn()
      .mockRejectedValue(new Error('runtime host resolved disallowed address'))
    const reconciler = new WorkflowReconciler(
      makeDeps({
        networkingApi: networkingApi as never,
        resolveRuntimeHttpEgressCidrs,
        config: { ...makeConfig(), enableSnippetRuntime: true } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        runtimeEgress: { http: { allowedHosts: ['api.example.com'] } },
        steps: [
          {
            id: 'snippet',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return await sdk.http.fetchJson("https://api.example.com/data")',
              capabilities: {
                http: { allowedHosts: ['api.example.com'] },
              },
            },
          },
        ],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('runtime host resolved disallowed address')
    expect(networkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('refreshes runtime HTTP egress policies with DNS overlap for active snippets', async () => {
    const networkingApi = makeNetworkingApi() as ReturnType<typeof makeNetworkingApi>
    networkingApi.createNamespacedNetworkPolicy.mockRejectedValue({ code: 409 })
    networkingApi.readNamespacedNetworkPolicy.mockResolvedValue({
      metadata: {
        resourceVersion: 'rv-1',
        annotations: {
          'clerum.io/runtime-http-egress-current-cidrs': '93.184.216.34/32',
        },
      },
    })
    const resolveRuntimeHttpEgressCidrs = vi.fn().mockResolvedValue(['93.184.216.35/32'])
    const reconciler = new WorkflowReconciler(
      makeDeps({
        networkingApi: networkingApi as never,
        resolveRuntimeHttpEgressCidrs,
        config: { ...makeConfig(), enableSnippetRuntime: true } as never,
      })
    )
    const spec = makeSpec({
      agent: undefined,
      runtimeEgress: { http: { allowedHosts: ['api.example.com'] } },
      steps: [
        {
          id: 'snippet',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return await sdk.http.fetchJson("https://api.example.com/data")',
            capabilities: {
              http: { allowedHosts: ['api.example.com'] },
            },
          },
        },
      ],
    })

    await reconciler.refreshRuntimeHttpEgressNetworkPolicies(
      'sandbox-recipes',
      'test-wf',
      'uid-123',
      spec
    )

    expect(resolveRuntimeHttpEgressCidrs).toHaveBeenCalledWith(['api.example.com'])
    const replaced = networkingApi.replaceNamespacedNetworkPolicy.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === 'test-wf-snippet-runner-egress'
    )?.[0].body
    expect(replaced).toBeDefined()
    expect(publicHttpEgressCidrs(replaced!)).toEqual(['93.184.216.34/32', '93.184.216.35/32'])
    expect(replaced!.metadata!.annotations).toMatchObject({
      'clerum.io/runtime-http-egress-current-cidrs': '93.184.216.35/32',
      'clerum.io/runtime-http-egress-previous-cidrs': '93.184.216.34/32',
    })
    const previousExpiresAt =
      replaced!.metadata!.annotations!['clerum.io/runtime-http-egress-previous-expires-at']
    expect(previousExpiresAt).toBeDefined()
    expect(Date.parse(previousExpiresAt!)).toBeGreaterThan(Date.now())
  })

  it('refreshes coordinator and snippet runtime HTTP egress policies with one overlap window', async () => {
    const networkingApi = makeNetworkingApi() as ReturnType<typeof makeNetworkingApi>
    networkingApi.createNamespacedNetworkPolicy.mockRejectedValue({ code: 409 })
    const laterPreviousExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    networkingApi.readNamespacedNetworkPolicy.mockImplementation(async ({ name }) => {
      if (name === 'test-wf-coord-to-wrc') {
        return {
          metadata: {
            resourceVersion: 'rv-coord',
            annotations: {
              'clerum.io/runtime-http-egress-current-cidrs': '93.184.216.34/32',
              'clerum.io/runtime-http-egress-previous-cidrs': '93.184.216.33/32',
              'clerum.io/runtime-http-egress-previous-expires-at': laterPreviousExpiresAt,
            },
          },
        }
      }
      if (name === 'test-wf-snippet-runner-egress') {
        return {
          metadata: {
            resourceVersion: 'rv-snippet',
            annotations: {
              'clerum.io/runtime-http-egress-current-cidrs': '93.184.216.35/32',
            },
          },
        }
      }
      throw { code: 404 }
    })
    const resolveRuntimeHttpEgressCidrs = vi.fn().mockResolvedValue(['93.184.216.36/32'])
    const reconciler = new WorkflowReconciler(
      makeDeps({
        networkingApi: networkingApi as never,
        resolveRuntimeHttpEgressCidrs,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          enableSnippetRuntime: true,
        } as never,
      })
    )
    const spec = makeSpec({
      agent: undefined,
      coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
      runtimeEgress: { http: { allowedHosts: ['api.example.com'] } },
      steps: [
        {
          id: 'snippet',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return await sdk.http.fetchJson("https://api.example.com/data")',
            capabilities: {
              http: { allowedHosts: ['api.example.com'] },
            },
          },
        },
      ],
    })

    await reconciler.refreshRuntimeHttpEgressNetworkPolicies(
      'sandbox-recipes',
      'test-wf',
      'uid-123',
      spec
    )

    expect(resolveRuntimeHttpEgressCidrs).toHaveBeenCalledWith(['api.example.com'])
    const replacedPolicies = Object.fromEntries(
      networkingApi.replaceNamespacedNetworkPolicy.mock.calls.map(([arg]) => [
        arg.body?.metadata?.name,
        arg.body,
      ])
    )
    for (const name of ['test-wf-coord-to-wrc', 'test-wf-snippet-runner-egress']) {
      const policy = replacedPolicies[name]
      expect(policy).toBeDefined()
      expect(publicHttpEgressCidrs(policy!)).toEqual([
        '93.184.216.33/32',
        '93.184.216.34/32',
        '93.184.216.35/32',
        '93.184.216.36/32',
      ])
      expect(policy!.metadata!.annotations).toMatchObject({
        'clerum.io/runtime-http-egress-current-cidrs': '93.184.216.36/32',
        'clerum.io/runtime-http-egress-previous-cidrs':
          '93.184.216.33/32,93.184.216.34/32,93.184.216.35/32',
        'clerum.io/runtime-http-egress-previous-expires-at': laterPreviousExpiresAt,
      })
      const previousExpiries = JSON.parse(
        policy!.metadata!.annotations!['clerum.io/runtime-http-egress-previous-cidr-expiries']
      )
      expect(previousExpiries['93.184.216.33/32']).toBe(laterPreviousExpiresAt)
      expect(Date.parse(previousExpiries['93.184.216.34/32'])).toBeLessThan(
        Date.parse(laterPreviousExpiresAt)
      )
      expect(Date.parse(previousExpiries['93.184.216.35/32'])).toBeLessThan(
        Date.parse(laterPreviousExpiresAt)
      )
    }
  })

  it('does not extend older runtime HTTP egress CIDR expiries during a new DNS rollover', async () => {
    const networkingApi = makeNetworkingApi() as ReturnType<typeof makeNetworkingApi>
    networkingApi.createNamespacedNetworkPolicy.mockRejectedValue({ code: 409 })
    const olderPreviousExpiresAt = new Date(Date.now() + 60 * 1000).toISOString()
    networkingApi.readNamespacedNetworkPolicy.mockResolvedValue({
      metadata: {
        resourceVersion: 'rv-1',
        annotations: {
          'clerum.io/runtime-http-egress-current-cidrs': '93.184.216.35/32',
          'clerum.io/runtime-http-egress-previous-cidrs': '93.184.216.34/32',
          'clerum.io/runtime-http-egress-previous-expires-at': olderPreviousExpiresAt,
          'clerum.io/runtime-http-egress-previous-cidr-expiries': JSON.stringify({
            '93.184.216.34/32': olderPreviousExpiresAt,
          }),
        },
      },
    })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        networkingApi: networkingApi as never,
        resolveRuntimeHttpEgressCidrs: vi.fn().mockResolvedValue(['93.184.216.36/32']),
        config: { ...makeConfig(), enableSnippetRuntime: true } as never,
      })
    )
    const spec = makeSpec({
      agent: undefined,
      runtimeEgress: { http: { allowedHosts: ['api.example.com'] } },
      steps: [
        {
          id: 'snippet',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return await sdk.http.fetchJson("https://api.example.com/data")',
            capabilities: {
              http: { allowedHosts: ['api.example.com'] },
            },
          },
        },
      ],
    })

    await reconciler.refreshRuntimeHttpEgressNetworkPolicies(
      'sandbox-recipes',
      'test-wf',
      'uid-123',
      spec
    )

    const replaced = networkingApi.replaceNamespacedNetworkPolicy.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === 'test-wf-snippet-runner-egress'
    )?.[0].body
    expect(replaced).toBeDefined()
    expect(publicHttpEgressCidrs(replaced!)).toEqual([
      '93.184.216.34/32',
      '93.184.216.35/32',
      '93.184.216.36/32',
    ])
    const previousExpiries = JSON.parse(
      replaced!.metadata!.annotations!['clerum.io/runtime-http-egress-previous-cidr-expiries']
    )
    expect(previousExpiries['93.184.216.34/32']).toBe(olderPreviousExpiresAt)
    expect(Date.parse(previousExpiries['93.184.216.35/32'])).toBeGreaterThan(
      Date.parse(olderPreviousExpiresAt)
    )
  })

  it('prunes expired runtime HTTP egress overlap CIDRs even when DNS refresh fails', async () => {
    const networkingApi = makeNetworkingApi() as ReturnType<typeof makeNetworkingApi>
    networkingApi.createNamespacedNetworkPolicy.mockRejectedValue({ code: 409 })
    const activePreviousExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    networkingApi.readNamespacedNetworkPolicy.mockResolvedValue({
      metadata: {
        resourceVersion: 'rv-1',
        annotations: {
          'clerum.io/runtime-http-egress-current-cidrs': '93.184.216.36/32',
          'clerum.io/runtime-http-egress-previous-cidrs': '93.184.216.34/32,93.184.216.35/32',
          'clerum.io/runtime-http-egress-previous-expires-at': activePreviousExpiresAt,
          'clerum.io/runtime-http-egress-previous-cidr-expiries': JSON.stringify({
            '93.184.216.34/32': '2000-01-01T00:00:00.000Z',
            '93.184.216.35/32': activePreviousExpiresAt,
          }),
        },
      },
    })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        networkingApi: networkingApi as never,
        resolveRuntimeHttpEgressCidrs: vi.fn().mockRejectedValue(new Error('ENOTFOUND')),
        config: { ...makeConfig(), enableSnippetRuntime: true } as never,
      })
    )
    const spec = makeSpec({
      agent: undefined,
      runtimeEgress: { http: { allowedHosts: ['api.example.com'] } },
      steps: [
        {
          id: 'snippet',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return await sdk.http.fetchJson("https://api.example.com/data")',
            capabilities: {
              http: { allowedHosts: ['api.example.com'] },
            },
          },
        },
      ],
    })

    await expect(
      reconciler.refreshRuntimeHttpEgressNetworkPolicies(
        'sandbox-recipes',
        'test-wf',
        'uid-123',
        spec
      )
    ).rejects.toThrow('ENOTFOUND')

    const replaced = networkingApi.replaceNamespacedNetworkPolicy.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === 'test-wf-snippet-runner-egress'
    )?.[0].body
    expect(replaced).toBeDefined()
    expect(publicHttpEgressCidrs(replaced!)).toEqual(['93.184.216.35/32', '93.184.216.36/32'])
    expect(replaced!.metadata!.annotations).toMatchObject({
      'clerum.io/runtime-http-egress-current-cidrs': '93.184.216.36/32',
      'clerum.io/runtime-http-egress-previous-cidrs': '93.184.216.35/32',
      'clerum.io/runtime-http-egress-previous-expires-at': activePreviousExpiresAt,
    })
  })

  it('creates runtime HTTP egress policies without previous overlap on first refresh', async () => {
    const networkingApi = makeNetworkingApi() as ReturnType<typeof makeNetworkingApi>
    networkingApi.readNamespacedNetworkPolicy.mockRejectedValue({ code: 404 })
    const resolveRuntimeHttpEgressCidrs = vi.fn().mockResolvedValue(['93.184.216.34/32'])
    const reconciler = new WorkflowReconciler(
      makeDeps({
        networkingApi: networkingApi as never,
        resolveRuntimeHttpEgressCidrs,
        config: { ...makeConfig(), enableSnippetRuntime: true } as never,
      })
    )
    const spec = makeSpec({
      agent: undefined,
      runtimeEgress: { http: { allowedHosts: ['api.example.com'] } },
      steps: [
        {
          id: 'snippet',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return await sdk.http.fetchJson("https://api.example.com/data")',
            capabilities: {
              http: { allowedHosts: ['api.example.com'] },
            },
          },
        },
      ],
    })

    await reconciler.refreshRuntimeHttpEgressNetworkPolicies(
      'sandbox-recipes',
      'test-wf',
      'uid-123',
      spec
    )

    const created = networkingApi.createNamespacedNetworkPolicy.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === 'test-wf-snippet-runner-egress'
    )?.[0].body
    expect(created).toBeDefined()
    expect(publicHttpEgressCidrs(created!)).toEqual(['93.184.216.34/32'])
    expect(created!.metadata!.annotations).toMatchObject({
      'clerum.io/runtime-http-egress-current-cidrs': '93.184.216.34/32',
    })
    expect(
      created!.metadata!.annotations!['clerum.io/runtime-http-egress-previous-cidrs']
    ).toBeUndefined()
    expect(
      created!.metadata!.annotations!['clerum.io/runtime-http-egress-previous-expires-at']
    ).toBeUndefined()
  })

  it('drops expired runtime HTTP egress overlap CIDRs on refresh', async () => {
    const networkingApi = makeNetworkingApi() as ReturnType<typeof makeNetworkingApi>
    networkingApi.createNamespacedNetworkPolicy.mockRejectedValue({ code: 409 })
    networkingApi.readNamespacedNetworkPolicy.mockResolvedValue({
      metadata: {
        resourceVersion: 'rv-1',
        annotations: {
          'clerum.io/runtime-http-egress-current-cidrs': '93.184.216.35/32',
          'clerum.io/runtime-http-egress-previous-cidrs': '93.184.216.34/32',
          'clerum.io/runtime-http-egress-previous-expires-at': '2000-01-01T00:00:00.000Z',
        },
      },
    })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        networkingApi: networkingApi as never,
        resolveRuntimeHttpEgressCidrs: vi.fn().mockResolvedValue(['93.184.216.35/32']),
        config: { ...makeConfig(), enableSnippetRuntime: true } as never,
      })
    )
    const spec = makeSpec({
      agent: undefined,
      runtimeEgress: { http: { allowedHosts: ['api.example.com'] } },
      steps: [
        {
          id: 'snippet',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return await sdk.http.fetchJson("https://api.example.com/data")',
            capabilities: {
              http: { allowedHosts: ['api.example.com'] },
            },
          },
        },
      ],
    })

    await reconciler.refreshRuntimeHttpEgressNetworkPolicies(
      'sandbox-recipes',
      'test-wf',
      'uid-123',
      spec
    )

    const replaced = networkingApi.replaceNamespacedNetworkPolicy.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === 'test-wf-snippet-runner-egress'
    )?.[0].body
    expect(replaced).toBeDefined()
    expect(publicHttpEgressCidrs(replaced!)).toEqual(['93.184.216.35/32'])
    expect(
      replaced!.metadata!.annotations!['clerum.io/runtime-http-egress-previous-cidrs']
    ).toBeUndefined()
    expect(
      replaced!.metadata!.annotations!['clerum.io/runtime-http-egress-previous-expires-at']
    ).toBeUndefined()
  })

  it('drops invalid, private, or untrusted-future runtime HTTP egress overlap CIDRs from annotations', async () => {
    const networkingApi = makeNetworkingApi() as ReturnType<typeof makeNetworkingApi>
    networkingApi.createNamespacedNetworkPolicy.mockRejectedValue({ code: 409 })
    networkingApi.readNamespacedNetworkPolicy.mockResolvedValue({
      metadata: {
        resourceVersion: 'rv-1',
        annotations: {
          'clerum.io/runtime-http-egress-current-cidrs':
            '10.0.0.5/32,93.184.216.34/32,0.0.0.0/0,garbage',
          'clerum.io/runtime-http-egress-previous-cidrs':
            '192.168.1.5/32,93.184.216.0/24,93.184.216.33/32',
          'clerum.io/runtime-http-egress-previous-expires-at': '2999-01-01T00:00:00.000Z',
        },
      },
    })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        networkingApi: networkingApi as never,
        resolveRuntimeHttpEgressCidrs: vi.fn().mockResolvedValue(['93.184.216.35/32']),
        config: { ...makeConfig(), enableSnippetRuntime: true } as never,
      })
    )
    const spec = makeSpec({
      agent: undefined,
      runtimeEgress: { http: { allowedHosts: ['api.example.com'] } },
      steps: [
        {
          id: 'snippet',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return await sdk.http.fetchJson("https://api.example.com/data")',
            capabilities: {
              http: { allowedHosts: ['api.example.com'] },
            },
          },
        },
      ],
    })

    await reconciler.refreshRuntimeHttpEgressNetworkPolicies(
      'sandbox-recipes',
      'test-wf',
      'uid-123',
      spec
    )

    const replaced = networkingApi.replaceNamespacedNetworkPolicy.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === 'test-wf-snippet-runner-egress'
    )?.[0].body
    expect(replaced).toBeDefined()
    expect(publicHttpEgressCidrs(replaced!)).toEqual(['93.184.216.34/32', '93.184.216.35/32'])
    expect(replaced!.metadata!.annotations!['clerum.io/runtime-http-egress-previous-cidrs']).toBe(
      '93.184.216.34/32'
    )
  })

  it('rejects snippet HTTP hosts that are not declared in runtimeEgress', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: { ...makeConfig(), enableSnippetRuntime: true } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [
          {
            id: 'snippet',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return await sdk.http.fetchText("https://api.example.com/data")',
              capabilities: {
                http: { allowedHosts: ['api.example.com'] },
              },
            },
          },
        ],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('must be declared in spec.runtimeEgress.http.allowedHosts')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects public-web snippet HTTP capabilities that also declare exact allowedHosts', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: { ...makeConfig(), enableSnippetRuntime: true } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        runtimeEgress: { http: { egressClass: 'public-web' } },
        steps: [
          {
            id: 'snippet',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return await sdk.http.fetchText("https://api.example.com/data")',
              capabilities: {
                http: { egressClass: 'public-web', allowedHosts: ['api.example.com'] },
              },
            },
          },
        ],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('allowedHosts must be omitted when egressClass is public-web')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects snippet database workloads that are not declared in the recipe', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: { ...makeConfig(), enableSnippetRuntime: true } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [
          {
            id: 'snippet',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return await sdk.postgres.query({ workload: "missing", database: "clerum" }, { sql: "select 1" })',
              capabilities: {
                postgres: { access: 'read', workloads: ['missing'] },
              },
            },
          },
        ],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('references undeclared postgres workload "missing"')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects snippet database capabilities without explicit read or readWrite access', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: { ...makeConfig(), enableSnippetRuntime: true } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        workloads: [{ id: 'postgres', type: 'deployment', image: 'postgres:16', port: 5432 }],
        steps: [
          {
            id: 'snippet',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return await sdk.postgres.query({ workload: "postgres", database: "clerum" }, { sql: "select 1" })',
              capabilities: {
                postgres: { workloads: ['postgres'] },
              },
            },
          },
        ],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('postgres capability must declare access read or readWrite')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects snippet MCP servers and tools outside the declared capability context', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: { ...makeConfig(), enableSnippetRuntime: true } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        mcpServers: [{ id: 'mock-tools', endpoint: 'http://mock-tools.mcp-server.svc:3000/mcp' }],
        steps: [
          {
            id: 'snippet',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return await sdk.mcp.callTool("mock-tools", "add", { a: 1, b: 2 })',
              capabilities: {
                mcp: {
                  servers: ['mock-tools'],
                  allowedTools: { include: ['other-server__add'] },
                },
              },
            },
          },
        ],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('must be scoped to an allowed server')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it.each([
    ['169.254.169.254', 'must not be an IP literal'],
    ['metadata.google.internal', 'must be a public DNS hostname'],
    ['metadata.goog', 'must be a public DNS hostname'],
    ['postgres.sandbox-recipes.svc.cluster.local', 'must be a public DNS hostname'],
    ['pod-1.sandbox-recipes.pod.cluster.local', 'must be a public DNS hostname'],
  ])(
    'rejects non-public runtimeEgress HTTP host %s before creating workflow pods',
    async (host, message) => {
      const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
      const reconciler = new WorkflowReconciler(
        makeDeps({
          coreApi: coreApi as never,
          config: {
            ...makeConfig(),
            enableCustomCoordinatorImage: true,
            allowedCoordinatorImagePrefixes: ['clerum/workflow-custom-sdk-e2e:'],
          } as never,
        })
      )

      const result = await reconciler.reconcile(
        'test-wf',
        'uid-123',
        'sandbox-recipes',
        makeSpec({
          agent: undefined,
          coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
          runtimeEgress: { http: { allowedHosts: [host] } },
          steps: [{ id: 'prepare' }],
        })
      )

      expect(result.workflowPhase).toBe('failed')
      expect(result.message).toContain(message)
      expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
    }
  )

  it('rejects too many runtimeEgress HTTP hosts before DNS resolution', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const resolveRuntimeHttpEgressCidrs = vi.fn().mockResolvedValue(['93.184.216.34/32'])
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        resolveRuntimeHttpEgressCidrs,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/workflow-custom-sdk-e2e:'],
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        runtimeEgress: {
          http: {
            allowedHosts: Array.from({ length: 21 }, (_, index) => `api-${index}.example.com`),
          },
        },
        steps: [{ id: 'prepare' }],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('runtimeEgress.http.allowedHosts must contain at most 20')
    expect(resolveRuntimeHttpEgressCidrs).not.toHaveBeenCalled()
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('replaces existing NetworkPolicies so removed HTTP egress cannot persist', async () => {
    const networkingApi = makeNetworkingApi() as ReturnType<typeof makeNetworkingApi>
    networkingApi.createNamespacedNetworkPolicy.mockRejectedValue({ code: 409 })
    networkingApi.readNamespacedNetworkPolicy.mockResolvedValue({
      metadata: { name: 'test-wf-coord-to-wrc', resourceVersion: 'rv-1' },
    })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        networkingApi: networkingApi as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/workflow-custom-sdk-e2e:'],
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        steps: [{ id: 'prepare' }],
      })
    )

    expect(result.workflowPhase).not.toBe('failed')
    expect(networkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalled()
    const coordPolicy = networkingApi.replaceNamespacedNetworkPolicy.mock.calls.find(
      ([arg]) => arg.name === 'test-wf-coord-to-wrc'
    )?.[0].body
    expect(coordPolicy).toBeDefined()
    expect(coordPolicy!.metadata!.resourceVersion).toBe('rv-1')
    expect(hasPublicHttpEgressRule(coordPolicy!)).toBe(false)
  })

  it('prunes legacy recipe MCP server broad internet egress policies during reconcile', async () => {
    const networkingApi = makeNetworkingApi() as ReturnType<typeof makeNetworkingApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        networkingApi: networkingApi as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({ mcpServers: ['redis-mcp'] })
    )

    expect(result.workflowPhase).not.toBe('failed')
    expect(networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: 'test-wf-mcp-servers-egress-internet',
      namespace: 'mcp-server',
    })
    expect(
      networkingApi.createNamespacedNetworkPolicy.mock.calls.some(
        ([arg]) => arg.body?.metadata?.name === 'test-wf-mcp-servers-egress-internet'
      )
    ).toBe(false)
  })

  it('retries NetworkPolicy replace once when resourceVersion is stale', async () => {
    const networkingApi = makeNetworkingApi() as ReturnType<typeof makeNetworkingApi>
    networkingApi.createNamespacedNetworkPolicy.mockRejectedValue({ code: 409 })
    const readCounts = new Map<string, number>()
    const coordResourceVersions: Array<string | undefined> = []
    networkingApi.readNamespacedNetworkPolicy.mockImplementation(async ({ name }) => {
      const count = readCounts.get(name) ?? 0
      readCounts.set(name, count + 1)
      return {
        metadata: {
          name,
          resourceVersion: name === 'test-wf-coord-to-wrc' && count === 1 ? 'rv-2' : 'rv-1',
        },
      }
    })
    networkingApi.replaceNamespacedNetworkPolicy.mockImplementation(async ({ name, body }) => {
      if (name === 'test-wf-coord-to-wrc') {
        coordResourceVersions.push(body.metadata?.resourceVersion)
        const coordCalls = networkingApi.replaceNamespacedNetworkPolicy.mock.calls.filter(
          ([arg]) => arg.name === 'test-wf-coord-to-wrc'
        ).length
        if (coordCalls === 1) throw { code: 409 }
      }
      return {}
    })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        networkingApi: networkingApi as never,
        config: { ...makeConfig() } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [{ id: 'prepare', run: snippetRun() }],
      })
    )

    expect(result.workflowPhase).not.toBe('failed')
    const coordCalls = networkingApi.replaceNamespacedNetworkPolicy.mock.calls.filter(
      ([arg]) => arg.name === 'test-wf-coord-to-wrc'
    )
    expect(coordCalls).toHaveLength(2)
    expect(coordResourceVersions).toEqual(['rv-1', 'rv-2'])
  })

  it('resolves snippet MCP transport workloads into the mounted runner config', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: { ...makeConfig(), enableSnippetRuntime: true } as never,
      })
    )

    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        workloads: [
          {
            id: 'mock-tools',
            type: 'deployment',
            image: 'clerum/mock-mcp-server:test',
            port: 3000,
            transport: { type: 'streamableHttp', path: '/mcp' },
          },
        ],
        steps: [
          {
            id: 'call-mcp',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return await sdk.mcp.callTool("mock-tools", "add", { a: 40, b: 2 })',
              capabilities: {
                mcp: {
                  servers: ['mock-tools'],
                  allowedTools: { include: ['mock-tools__add'] },
                },
              },
            },
          },
        ],
      })
    )

    const configMap = coreApi.createNamespacedConfigMap.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === 'test-wf-workflow-config'
    )?.[0].body
    const config = JSON.parse(configMap!.data!['config.json'])
    expect(config.mcpServers).toHaveLength(1)
    expect(config.mcpServers[0]).toMatchObject({
      id: 'mock-tools',
      endpoint: expect.stringContaining('.mcp-server.svc.cluster.local:3000/mcp'),
      transport: 'streamableHttp',
    })
    expect(config.steps[0].run.capabilities.mcp.allowedTools.include).toEqual(['mock-tools__add'])
  })

  it('uses the runtime-safe MCP server label in snippet NetworkPolicy selectors for long child recipes', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const networkingApi = makeNetworkingApi() as ReturnType<typeof makeNetworkingApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        networkingApi: networkingApi as never,
        config: { ...makeConfig(), enableSnippetRuntime: true } as never,
      })
    )
    const recipeName = 'manual-pr259-layer3a-hybrid-secret-pvc-5step-7f99549a'
    const recipeUid = 'long-child-uid'
    const spec = makeSpec({
      agent: undefined,
      mcpServers: [{ id: 'mock-tools' }],
      workloads: [
        {
          id: 'mock-tools',
          type: 'deployment',
          image: 'clerum/mock-mcp-server:test',
          port: 3000,
          transport: { type: 'streamableHttp', path: '/mcp' },
        },
      ],
      steps: [
        {
          id: 'call-mcp',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return await sdk.mcp.callTool("mock-tools", "add", { a: 40, b: 2 })',
            capabilities: {
              mcp: {
                servers: ['mock-tools'],
                allowedTools: { include: ['mock-tools__add'] },
              },
            },
          },
        },
      ],
    })

    await reconciler.reconcile(recipeName, recipeUid, 'sandbox-recipes', spec)

    const recipeRef = {
      apiVersion: 'clerum.io/v1alpha1' as const,
      kind: 'WorkflowRecipe' as const,
      metadata: { name: recipeName, namespace: 'sandbox-recipes', uid: recipeUid },
      spec,
    }
    const expectedLabel = resolveWorkloadMcpServerLabel(recipeRef, spec.workloads![0])
    const rawInvalidLabel = `${recipeName}-mock-tools`
    const snippetEgress = networkingApi.createNamespacedNetworkPolicy.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === `${recipeName}-snippet-runner-egress`
    )?.[0].body
    const selectedMcpServers = snippetEgress!.spec!.egress!.flatMap(rule =>
      (rule.to ?? [])
        .map(peer => peer.podSelector?.matchLabels?.['clerum.io/mcpserver'])
        .filter(Boolean)
    )

    expect(rawInvalidLabel.length).toBeGreaterThan(63)
    expect(expectedLabel.length).toBeLessThanOrEqual(63)
    expect(selectedMcpServers).toContain(expectedLabel)
    expect(selectedMcpServers).not.toContain(rawInvalidLabel)
  })

  it('resolves hybrid step MCP server IDs and step-level agent settings into coordinator config', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        mcpServers: [
          {
            id: 'mock-tools',
            endpoint: 'http://mock-tools.mcp-server.svc.cluster.local:3000/mcp',
          },
        ],
        steps: [
          { id: 'prepare', run: snippetRun() },
          {
            id: 'calculate',
            dependsOn: ['prepare'],
            instruction: 'Use the add tool.',
            agent: { provider: 'zai', model: 'glm-4.7' },
            mcpServers: ['mock-tools'],
            allowedTools: { include: ['mock-tools__add'] },
            maxIterations: 6,
          },
        ],
      })
    )

    const configMap = coreApi.createNamespacedConfigMap.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === 'test-wf-workflow-config'
    )?.[0].body
    const config = JSON.parse(configMap!.data!['config.json'])
    expect(config.agent).toBeUndefined()
    expect(config.steps[1]).toMatchObject({
      id: 'calculate',
      agent: { provider: 'zai', model: 'glm-4.7' },
      mcpServers: [
        {
          name: 'mock-tools',
          url: 'http://mock-tools.mcp-server.svc.cluster.local:3000/mcp',
        },
      ],
      allowedTools: { include: ['mock-tools__add'] },
      maxIterations: 6,
    })
  })

  it('creates coordinator and mcp-host Pods via coreApi', async () => {
    const reconciler = new WorkflowReconciler(deps)
    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec(),
      undefined,
      undefined,
      undefined,
      runId
    )
    expect(deps.coreApi.createNamespacedPod).toHaveBeenCalled()
  })

  it('creates a short mcp-host route alias Service for provider callback routing', async () => {
    const reconciler = new WorkflowReconciler(deps)
    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec(),
      undefined,
      undefined,
      undefined,
      runId
    )

    const createdServiceNames = vi
      .mocked(deps.coreApi.createNamespacedService)
      .mock.calls.map(([arg]) => arg.body?.metadata?.name)
    expect(createdServiceNames).toContain(
      buildMcpHostRouteAliasServiceName('test-wf', 'sandbox-recipes')
    )
  })

  it('applies runtime NetworkPolicies before creating runtime Pods', async () => {
    const reconciler = new WorkflowReconciler(deps)
    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec(),
      undefined,
      undefined,
      undefined,
      runId
    )

    const firstPolicyCall = vi.mocked(deps.networkingApi.createNamespacedNetworkPolicy).mock
      .invocationCallOrder[0]
    const runtimePodCall = vi
      .mocked(deps.coreApi.createNamespacedPod)
      .mock.calls.findIndex(
        ([arg]) => arg.body?.metadata?.name !== 'test-wf-workflow-output-anchor'
      )
    expect(runtimePodCall).toBeGreaterThanOrEqual(0)
    const firstRuntimePodCall = vi.mocked(deps.coreApi.createNamespacedPod).mock
      .invocationCallOrder[runtimePodCall]
    expect(firstPolicyCall).toBeLessThan(firstRuntimePodCall)
  })

  it('registers an agentic parent workflow without runtime pods until a run id exists', async () => {
    const coreApi = makeCoreApi(false, { workflowOutputAnchorPhase: null }) as ReturnType<
      typeof makeCoreApi
    >
    const networkingApi = makeNetworkingApi() as ReturnType<typeof makeNetworkingApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({ coreApi: coreApi as never, networkingApi: networkingApi as never })
    )

    const result = await reconciler.reconcile('test-wf', 'uid-123', 'sandbox-recipes', makeSpec())

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow trigger infrastructure registered (workflow-agentic)',
      clearWorkflowExecution: true,
    })
    const createdPodNames = coreApi.createNamespacedPod.mock.calls.map(
      ([arg]) => arg.body?.metadata?.name
    )
    expect(createdPodNames).toEqual(['test-wf-workflow-output-anchor'])
    expect(issueMcpHostRuntimeTokens).not.toHaveBeenCalled()
  })

  it('threads workflow run id into the coordinator pod env', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec(),
      undefined,
      undefined,
      undefined,
      runId
    )

    const pod = getCreatedCoordinatorPod(coreApi)
    const env = pod.spec!.containers![0].env!.find(
      (e: { name: string }) => e.name === 'CLERUM_WORKFLOW_RUN_ID'
    )
    expect(env!.value).toBe(runId)
  })

  it('maps admin workflow actors to usage-only admin-ui user keys', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec(),
      undefined,
      undefined,
      undefined,
      runId,
      'control-plane-admin-ui',
      '11111111-1111-4111-8111-111111111111',
      'admin'
    )

    const pod = getCreatedCoordinatorPod(coreApi)
    const env = pod.spec!.containers![0].env!
    expect(env.find((e: { name: string }) => e.name === 'CLERUM_WORKFLOW_RUN_ID')!.value).toBe(
      runId
    )
    expect(env.find((e: { name: string }) => e.name === 'CLERUM_WORKFLOW_TEAM_ID')!.value).toBe(
      'control-plane-admin-ui'
    )
    expect(env.find((e: { name: string }) => e.name === 'CLERUM_WORKFLOW_USER_ID')!.value).toBe(
      'admin-ui/11111111-1111-4111-8111-111111111111'
    )
  })

  it('accepts pure snippet workflows and skips the mcp-host pod', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [{ id: 'render', run: snippetRun() }],
      })
    )

    expect(result.phase).toBe('deploying')
    const createdPodNames = coreApi.createNamespacedPod.mock.calls.map(
      ([arg]) => arg.body?.metadata?.name
    )
    expect(createdPodNames).toContain('test-wf-coordinator')
    expect(createdPodNames).not.toContain('test-wf-mcp-host')
    expect(result.message).not.toContain('not yet implemented')
  })

  it('rejects custom coordinator images when the feature flag is disabled', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        steps: [{ id: 'prepare' }],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('custom coordinator images are disabled')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('runs pure custom coordinator workflows without mcp-host and with implicit platform output', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const tokenFactory = makeTokenFactory()
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        tokenFactory: tokenFactory as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/workflow-custom-sdk-e2e:'],
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        steps: [{ id: 'prepare' }, { id: 'emit', dependsOn: ['prepare'] }],
      })
    )

    expect(result.message).toContain('workflow-custom')
    const createdPodNames = coreApi.createNamespacedPod.mock.calls.map(
      ([arg]) => arg.body?.metadata?.name
    )
    expect(createdPodNames).toContain('test-wf-coordinator')
    expect(createdPodNames).toContain('test-wf-artifact-reader')
    expect(createdPodNames).not.toContain('test-wf-mcp-host')

    const coordPod = getCreatedCoordinatorPod(coreApi)
    const artifactReaderPod = getCreatedArtifactReaderPod(coreApi)
    const envNames = coordPod.spec!.containers![0].env!.map((env: { name: string }) => env.name)
    expect(coordPod.spec!.containers![0].image).toBe('clerum/workflow-custom-sdk-e2e:test')
    expect(artifactReaderPod.spec!.containers![0].image).toBe('clerum/workflow-recipes:test')
    const artifactReaderOutputMount = artifactReaderPod.spec!.containers![0].volumeMounts!.find(
      (mount: { mountPath: string }) => mount.mountPath === '/output'
    )
    expect(artifactReaderOutputMount).toMatchObject({
      name: 'recipe-output',
      mountPath: '/output',
      subPath: 'workflow-output/test-wf',
    })
    expect(artifactReaderOutputMount).not.toHaveProperty('readOnly')
    expect(
      artifactReaderPod.spec!.volumes!.find((v: { name: string }) => v.name === 'recipe-output')!
        .persistentVolumeClaim!.claimName
    ).toBe('test-wf-workflow-output')
    expect(envNames).not.toContain('MCP_HOST_TOKEN')
    expect(envNames).not.toContain('MCP_HOST_RUNTIME_ACCESS_TOKEN')
    expect(coordPod.spec!.enableServiceLinks).toBe(false)
    expect(coordPod.spec!.hostNetwork).toBe(false)
    expect(coordPod.spec!.hostPID).toBe(false)
    expect(coordPod.spec!.hostIPC).toBe(false)
    expect(coordPod.spec!.activeDeadlineSeconds).toBe(3300)
    expect(
      coordPod.spec!.volumes!.find((v: { name: string }) => v.name === 'tmp')!.emptyDir
    ).toEqual({
      sizeLimit: '64Mi',
    })
    expect(
      coordPod.spec!.volumes!.find((v: { name: string }) => v.name === 'recipe-output')!
        .persistentVolumeClaim!.claimName
    ).toBe('test-wf-workflow-output')
    expect(
      coordPod.spec!.containers![0].volumeMounts!.find(
        (m: { mountPath: string }) => m.mountPath === '/output'
      )!.subPath
    ).toBe('workflow-output/test-wf')
    expectWorkflowOutputAnchorAffinity(coordPod)
    expectWorkflowOutputAnchorAffinity(artifactReaderPod)
    expect(coreApi.createNamespacedPersistentVolumeClaim).toHaveBeenCalled()
    expect(tokenFactory.signCustomCoordinatorToWrcToken).toHaveBeenCalledWith(
      'test-wf',
      'sandbox-recipes'
    )
    expect(tokenFactory.signCoordinatorToMcpHostToken).not.toHaveBeenCalled()

    const coordinatorSecret = coreApi.createNamespacedSecret.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === 'wf-test-wf-coordinator-token'
    )?.[0].body
    expect(coordinatorSecret!.data!['mcp-host-token']).toBeUndefined()
    expect(Buffer.from(coordinatorSecret!.data!['wrc-token'], 'base64').toString()).toBe(
      'custom-coord-wrc-token'
    )
  })

  it('honors explicit custom coordinator pvc output while keeping the mount run scoped', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/workflow-custom-sdk-e2e:'],
        } as never,
      })
    )

    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        steps: [{ id: 'prepare' }],
        output: { destination: 'pvc' },
      }),
      undefined,
      undefined,
      undefined,
      runId
    )

    const coordPod = getCreatedCoordinatorPod(coreApi)
    const outputMount = coordPod.spec!.containers![0].volumeMounts!.find(
      (m: { mountPath: string }) => m.mountPath === '/output'
    )
    expect(outputMount).toMatchObject({
      name: 'recipe-output',
      mountPath: '/output',
      subPath: `workflow-output/test-wf/${runId}`,
    })
    expect(
      coordPod.spec!.volumes!.find((v: { name: string }) => v.name === 'recipe-output')!
        .persistentVolumeClaim!.claimName
    ).toBe('test-wf-workflow-output')
    expect(coreApi.createNamespacedPersistentVolumeClaim).toHaveBeenCalled()
  })

  it('propagates runtimeEgress and grants declared public HTTP egress to custom coordinators', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const networkingApi = makeNetworkingApi() as ReturnType<typeof makeNetworkingApi>
    const resolveRuntimeHttpEgressCidrs = vi.fn().mockResolvedValue(['93.184.216.34/32'])
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        networkingApi: networkingApi as never,
        resolveRuntimeHttpEgressCidrs,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/workflow-custom-sdk-e2e:'],
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        runtimeEgress: { http: { allowedHosts: ['example.com'] } },
        steps: [{ id: 'prepare' }, { id: 'emit', dependsOn: ['prepare'] }],
        output: { destination: 'pvc' },
      })
    )

    expect(result.workflowPhase).not.toBe('failed')
    expect(resolveRuntimeHttpEgressCidrs).toHaveBeenCalledWith(['example.com'])
    const configMap = coreApi.createNamespacedConfigMap.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === 'test-wf-workflow-config'
    )?.[0].body
    const config = JSON.parse(configMap!.data!['config.json'])
    expect(config.runtimeEgress.http.allowedHosts).toEqual(['example.com'])

    const coordPolicy = networkingApi.createNamespacedNetworkPolicy.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === 'test-wf-coord-to-wrc'
    )?.[0].body
    expect(coordPolicy).toBeDefined()
    expect(coordPolicy!.metadata!.labels!['clerum.io/egress-class']).toBe('exact-host')
    expect(hasPublicHttpEgressRule(coordPolicy!)).toBe(true)
    expect(publicHttpEgressCidrs(coordPolicy!)).toEqual(['93.184.216.34/32'])
  })

  it('grants explicit public-web egress to custom coordinators without DNS resolution', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const networkingApi = makeNetworkingApi() as ReturnType<typeof makeNetworkingApi>
    const resolveRuntimeHttpEgressCidrs = vi.fn()
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        networkingApi: networkingApi as never,
        resolveRuntimeHttpEgressCidrs,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/workflow-custom-sdk-e2e:'],
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        runtimeEgress: { http: { egressClass: 'public-web' } },
        steps: [{ id: 'prepare' }, { id: 'emit', dependsOn: ['prepare'] }],
        output: { destination: 'pvc' },
      })
    )

    expect(result.workflowPhase).not.toBe('failed')
    expect(resolveRuntimeHttpEgressCidrs).not.toHaveBeenCalled()
    const coordPolicy = networkingApi.createNamespacedNetworkPolicy.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === 'test-wf-coord-to-wrc'
    )?.[0].body
    expect(coordPolicy).toBeDefined()
    expect(coordPolicy!.metadata!.labels!['clerum.io/egress-class']).toBe('public-web')
    expect(hasPublicHttpEgressRule(coordPolicy!)).toBe(true)
    expect(publicHttpEgressCidrs(coordPolicy!)).toEqual(['0.0.0.0/0'])
  })

  it('keeps artifact-reader available for broker-backed custom coordinator output artifacts', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const tokenFactory = makeTokenFactory()
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        tokenFactory: tokenFactory as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/workflow-custom-sdk-e2e:'],
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        output: { destination: 'pvc' },
        steps: [
          { id: 'prepare' },
          {
            id: 'broker-review',
            dependsOn: ['prepare'],
            instruction: 'Use the broker',
            agent: { provider: 'zai', model: 'glm-4.7' },
            mcpServers: ['mock-tools'],
          },
          { id: 'emit', dependsOn: ['broker-review'] },
        ],
      }),
      undefined,
      undefined,
      undefined,
      runId
    )

    expect(result.message).toContain('workflow-custom')
    const createdPodNames = coreApi.createNamespacedPod.mock.calls.map(
      ([arg]) => arg.body?.metadata?.name
    )
    expect(createdPodNames).toContain('test-wf-coordinator')
    expect(createdPodNames).toContain('test-wf-mcp-host')
    expect(createdPodNames).toContain('test-wf-artifact-reader')
    expect(getCreatedArtifactReaderPod(coreApi).spec!.containers![0].volumeMounts).toContainEqual(
      expect.objectContaining({
        name: 'recipe-output',
        mountPath: '/output',
      })
    )
    expect(tokenFactory.signCustomCoordinatorToWrcToken).toHaveBeenCalledWith(
      'test-wf',
      'sandbox-recipes'
    )
    expect(tokenFactory.signCoordinatorToMcpHostToken).toHaveBeenCalledWith(
      'test-wf',
      'sandbox-recipes'
    )
  })

  it('persists resolved inputs into the mounted custom coordinator config', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/workflow-custom-sdk-e2e:'],
        } as never,
      })
    )

    const resolvedInputs = {
      requestId: 'ui-custom-123',
      approvalThreshold: 1000,
      scenario: 'desktop-custom-coordinator-trigger',
    }

    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        inputContract: {
          properties: {
            requestId: { type: 'string', default: 'ui-custom-default' },
            approvalThreshold: { type: 'number', default: 5000 },
            scenario: { type: 'string', default: 'default-scenario' },
          },
        },
        steps: [{ id: 'prepare' }, { id: 'emit', dependsOn: ['prepare'] }],
        output: { destination: 'pvc' },
      }),
      undefined,
      resolvedInputs
    )

    const configMap = coreApi.createNamespacedConfigMap.mock.calls.find(
      ([arg]) => arg.body?.metadata?.name === 'test-wf-workflow-config'
    )?.[0].body
    const config = JSON.parse(configMap!.data!['config.json'])
    expect(config.inputs).toEqual(resolvedInputs)
    expect(config.inputContract.properties.requestId.default).toBe('ui-custom-default')
  })

  it('rejects custom coordinator timeout budgets above the active deadline cap', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/workflow-custom-sdk-e2e:'],
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        steps: [
          { id: 'prepare', timeoutSeconds: 2400 },
          { id: 'emit', dependsOn: ['prepare'], timeoutSeconds: 2400 },
        ],
        output: { destination: 'pvc' },
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('maximum active deadline')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('runs broker-backed custom coordinator workflows with mcp-host credentials only when needed', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const tokenFactory = makeTokenFactory()
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        tokenFactory: tokenFactory as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/workflow-custom-sdk-e2e:'],
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: { provider: 'openai', model: 'gpt-4o-mini' },
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        steps: [
          { id: 'prepare' },
          { id: 'review', dependsOn: ['prepare'], instruction: 'Review the prepared result.' },
        ],
        output: { destination: 'pvc' },
      }),
      undefined,
      undefined,
      undefined,
      runId
    )

    expect(result.message).toContain('workflow-custom')
    const createdPodNames = coreApi.createNamespacedPod.mock.calls.map(
      ([arg]) => arg.body?.metadata?.name
    )
    expect(createdPodNames).toContain('test-wf-coordinator')
    expect(createdPodNames).toContain('test-wf-mcp-host')
    const coordPod = getCreatedCoordinatorPod(coreApi)
    const envNames = coordPod.spec!.containers![0].env!.map((env: { name: string }) => env.name)
    expect(envNames).toContain('CLERUM_MCPHOST_URL')
    expect(envNames).toContain('MCP_HOST_TOKEN_FILE')
    expect(envNames).not.toContain('MCP_HOST_TOKEN')
    for (const forbiddenEnv of [
      'MCP_HOST_RUNTIME_ACCESS_TOKEN',
      'MCP_HOST_RUNTIME_REFRESH_TOKEN',
      'MCP_HOST_WORKFLOW_CONTROL_TOKEN',
      'MCP_HOST_GATEWAY_URL',
      'OPENAI_API_KEY',
      'ZAI_API_KEY',
      'BAILIAN_API_KEY',
      'CLAUDE_API_KEY',
      'CLERUM_MODEL_API_KEY',
    ]) {
      expect(envNames).not.toContain(forbiddenEnv)
    }
    expect(tokenFactory.signCustomCoordinatorToWrcToken).toHaveBeenCalledWith(
      'test-wf',
      'sandbox-recipes'
    )
    expect(tokenFactory.signCoordinatorToMcpHostToken).toHaveBeenCalledWith(
      'test-wf',
      'sandbox-recipes'
    )
  })

  it('keeps broker-backed custom workflows without explicit pvc output on WRC-managed output', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/workflow-custom-sdk-e2e:'],
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: { provider: 'openai', model: 'gpt-4o-mini' },
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        steps: [
          { id: 'prepare' },
          { id: 'review', dependsOn: ['prepare'], instruction: 'Review the prepared result.' },
        ],
      }),
      undefined,
      undefined,
      undefined,
      runId
    )

    expect(result.message).toContain('workflow-custom')
    const mcpHostPod = getCreatedMcpHostPod(coreApi)
    const outputMount = mcpHostPod.spec!.containers![0].volumeMounts!.find(
      (m: { mountPath: string }) => m.mountPath === '/output'
    )
    expect(outputMount!.subPath).toBe(`workflow-output/test-wf/${runId}`)
    expect(
      mcpHostPod.spec!.volumes!.find((v: { name: string }) => v.name === 'recipe-output')!
        .persistentVolumeClaim!.claimName
    ).toBe('test-wf-workflow-output')
    expectWorkflowOutputAnchorAffinity(mcpHostPod)
    expect(coreApi.createNamespacedPersistentVolumeClaim).toHaveBeenCalled()
  })

  it('keeps existing custom coordinator token Secrets reduced on later reconciles', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const tokenFactory = makeTokenFactory()
    coreApi.createNamespacedSecret = vi.fn().mockImplementation(async ({ body }) => {
      if (body?.metadata?.name === 'wf-test-wf-coordinator-token') throw { code: 409 }
      return {}
    })
    coreApi.readNamespacedSecret = vi.fn().mockImplementation(async ({ name }) => {
      if (name === 'wf-test-wf-coordinator-token') {
        return {
          data: {
            'wrc-token': Buffer.from(makeJwtWithExp(3600, { sub: 'custom-coordinator' })).toString(
              'base64'
            ),
          },
        }
      }
      throw { code: 404 }
    })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        tokenFactory: tokenFactory as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/workflow-custom-sdk-e2e:'],
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        steps: [{ id: 'prepare' }, { id: 'emit', dependsOn: ['prepare'] }],
        output: { destination: 'pvc' },
      })
    )

    expect(result.message).toContain('workflow-custom')
    expect(tokenFactory.signCoordinatorToMcpHostToken).not.toHaveBeenCalled()
    expect(tokenFactory.signCustomCoordinatorToWrcToken).toHaveBeenCalledTimes(1)
    expect(coreApi.patchNamespacedSecret).not.toHaveBeenCalled()
  })

  it('prunes stale mcp-host tokens from existing pure custom coordinator Secrets', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const tokenFactory = makeTokenFactory()
    coreApi.createNamespacedSecret = vi.fn().mockImplementation(async ({ body }) => {
      if (body?.metadata?.name === 'wf-test-wf-coordinator-token') throw { code: 409 }
      return {}
    })
    coreApi.readNamespacedSecret = vi.fn().mockImplementation(async ({ name }) => {
      if (name === 'wf-test-wf-coordinator-token') {
        return {
          data: {
            'mcp-host-token': Buffer.from(makeJwtWithExp(3600)).toString('base64'),
            'wrc-token': Buffer.from(makeJwtWithExp(3600, { sub: 'custom-coordinator' })).toString(
              'base64'
            ),
          },
        }
      }
      throw { code: 404 }
    })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        tokenFactory: tokenFactory as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/workflow-custom-sdk-e2e:'],
        } as never,
      })
    )

    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        steps: [{ id: 'prepare' }],
        output: { destination: 'pvc' },
      })
    )

    expect(tokenFactory.signCoordinatorToMcpHostToken).not.toHaveBeenCalled()
    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'wf-test-wf-coordinator-token',
        body: {
          data: {
            'mcp-host-token': null,
          },
        },
      }),
      expect.any(Object)
    )
  })

  it('rotates an existing coordinator WRC token when a custom coordinator needs the custom subject', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const tokenFactory = makeTokenFactory()
    coreApi.createNamespacedSecret = vi.fn().mockImplementation(async ({ body }) => {
      if (body?.metadata?.name === 'wf-test-wf-coordinator-token') throw { code: 409 }
      return {}
    })
    coreApi.readNamespacedSecret = vi.fn().mockImplementation(async ({ name }) => {
      if (name === 'wf-test-wf-coordinator-token') {
        return {
          data: {
            'wrc-token': Buffer.from(makeJwtWithExp(3600, { sub: 'coordinator' })).toString(
              'base64'
            ),
          },
        }
      }
      throw { code: 404 }
    })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        tokenFactory: tokenFactory as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/workflow-custom-sdk-e2e:'],
        } as never,
      })
    )

    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        steps: [{ id: 'prepare' }],
        output: { destination: 'pvc' },
      })
    )

    expect(tokenFactory.signCustomCoordinatorToWrcToken).toHaveBeenCalledWith(
      'test-wf',
      'sandbox-recipes'
    )
    expect(tokenFactory.signCoordinatorToWrcToken).not.toHaveBeenCalled()
    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'wf-test-wf-coordinator-token',
        body: {
          data: {
            'wrc-token': Buffer.from('custom-coord-wrc-token').toString('base64'),
          },
        },
      }),
      expect.any(Object)
    )
  })

  it('rotates an existing custom coordinator WRC token back to the builtin coordinator subject', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const tokenFactory = makeTokenFactory()
    coreApi.createNamespacedSecret = vi.fn().mockImplementation(async ({ body }) => {
      if (body?.metadata?.name === 'wf-test-wf-coordinator-token') throw { code: 409 }
      return {}
    })
    coreApi.readNamespacedSecret = vi.fn().mockImplementation(async ({ name }) => {
      if (name === 'wf-test-wf-coordinator-token') {
        return {
          data: {
            'mcp-host-token': Buffer.from(makeJwtWithExp(3600)).toString('base64'),
            'wrc-token': Buffer.from(makeJwtWithExp(3600, { sub: 'custom-coordinator' })).toString(
              'base64'
            ),
          },
        }
      }
      throw { code: 404 }
    })
    const reconciler = new WorkflowReconciler(
      makeDeps({ coreApi: coreApi as never, tokenFactory: tokenFactory as never })
    )

    await reconciler.reconcile('test-wf', 'uid-123', 'sandbox-recipes', makeSpec())

    expect(tokenFactory.signCoordinatorToWrcToken).toHaveBeenCalledWith(
      'test-wf',
      'sandbox-recipes'
    )
    expect(tokenFactory.signCustomCoordinatorToWrcToken).not.toHaveBeenCalled()
    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'wf-test-wf-coordinator-token',
        body: {
          data: {
            'wrc-token': Buffer.from('coord-wrc-token').toString('base64'),
          },
        },
      }),
      expect.any(Object)
    )
  })

  it('refreshes coordinator runtime credentials during steady-state snippet workflows', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const tokenFactory = makeTokenFactory()
    coreApi.readNamespacedSecret = vi.fn().mockImplementation(async ({ name }) => {
      if (name === 'wf-test-wf-coordinator-token') {
        return {
          data: {
            'wrc-token': Buffer.from(
              makeJwtWithExp(30, { sub: 'coordinator', recipeName: 'test-wf' })
            ).toString('base64'),
            'snippet-runner-token': Buffer.from('snippet-runner-token').toString('base64'),
          },
        }
      }
      throw { code: 404 }
    })
    const reconciler = new WorkflowReconciler(
      makeDeps({ coreApi: coreApi as never, tokenFactory: tokenFactory as never })
    )

    await reconciler.ensureCoordinatorRuntimeCredentials(
      'sandbox-recipes',
      'test-wf',
      makeSpec({
        agent: undefined,
        steps: [{ id: 'snippet', run: snippetRun() }],
      })
    )

    expect(tokenFactory.signCoordinatorToWrcToken).toHaveBeenCalledWith(
      'test-wf',
      'sandbox-recipes'
    )
    expect(tokenFactory.signCoordinatorToMcpHostToken).not.toHaveBeenCalled()
    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'wf-test-wf-coordinator-token',
        namespace: 'sandbox-recipes',
        body: {
          data: {
            'wrc-token': Buffer.from('coord-wrc-token').toString('base64'),
          },
        },
      }),
      expect.any(Object)
    )
  })

  it('refreshes coordinator GFS access when declared publish scopes change', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedSecret = vi.fn().mockImplementation(async ({ name }) => {
      if (name === 'wf-test-wf-coordinator-token') {
        return {
          data: {
            'gfs-token': makeEncodedGfsAccess(3600, 'test-wf', ['gfs.read']),
          },
        }
      }
      throw { code: 404 }
    })
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    await reconciler.ensureCoordinatorRuntimeCredentials(
      'recipe-runtime-ns',
      'test-wf',
      makeSpec({
        gfs: {
          publishTargets: [{ drive: 'main', target: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
        },
      })
    )

    expect(mintRecipeHostGfsToken).toHaveBeenCalledWith('recipe-runtime-ns', 'test-wf', {
      scopes: ['gfs.read', 'gfs.write'],
    })
    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'wf-test-wf-coordinator-token',
        namespace: 'recipe-runtime-ns',
        body: {
          data: expect.objectContaining({
            'gfs-token': expect.any(String),
          }),
        },
      }),
      expect.any(Object)
    )
  })

  it('refreshes short-TTL coordinator tokens early enough for Secret volume projection', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const tokenFactory = makeTokenFactory()
    coreApi.readNamespacedSecret = vi.fn().mockImplementation(async ({ name }) => {
      if (name === 'wf-test-wf-coordinator-token') {
        return {
          data: {
            'wrc-token': Buffer.from(
              makeJwtWithExp(60, { sub: 'coordinator', recipeName: 'test-wf' })
            ).toString('base64'),
            'snippet-runner-token': Buffer.from('snippet-runner-token').toString('base64'),
          },
        }
      }
      throw { code: 404 }
    })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        tokenFactory: tokenFactory as never,
        config: {
          ...makeConfig(),
          runtimeTokenTtlSeconds: 90,
          runtimeTokenRefreshBeforeSeconds: 45,
        } as never,
      })
    )

    await reconciler.ensureCoordinatorRuntimeCredentials(
      'sandbox-recipes',
      'test-wf',
      makeSpec({
        agent: undefined,
        steps: [{ id: 'snippet', run: snippetRun() }],
      })
    )

    expect(tokenFactory.signCoordinatorToWrcToken).toHaveBeenCalledWith(
      'test-wf',
      'sandbox-recipes'
    )
    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'wf-test-wf-coordinator-token',
        namespace: 'sandbox-recipes',
        body: {
          data: {
            'wrc-token': Buffer.from('coord-wrc-token').toString('base64'),
          },
        },
      }),
      expect.any(Object)
    )
  })

  it('rejects coordinator image changes after the runtime pod already exists', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedPod = vi.fn().mockImplementation(async ({ name }) => {
      if (name === 'test-wf-coordinator') {
        return {
          status: { phase: 'Running' },
          spec: { containers: [{ image: 'clerum/coordinator:test' }] },
        }
      }
      throw { code: 404 }
    })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/workflow-custom-sdk-e2e:'],
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        steps: [{ id: 'prepare' }],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('coordinator image is immutable')
    expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled()
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('allows built-in coordinator pods to finish after platform image config changes', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedPod = vi.fn().mockImplementation(async ({ name }) => {
      if (name === 'test-wf-coordinator') {
        return {
          metadata: { labels: { 'clerum.io/coordinator-tier': 'builtin' } },
          status: { phase: 'Running' },
          spec: { containers: [{ image: 'clerum/coordinator:old' }] },
        }
      }
      throw { code: 404 }
    })
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          coordinatorImage: 'clerum/coordinator:new',
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [{ id: 'render', run: snippetRun() }],
      })
    )

    expect(result.workflowPhase).not.toBe('failed')
    expect(result.message).not.toContain('coordinator image is immutable')
    const createdPodNames = coreApi.createNamespacedPod.mock.calls.map(
      ([arg]) => arg.body?.metadata?.name
    )
    expect(createdPodNames).not.toContain('test-wf-coordinator')
  })

  it('rejects removing a custom coordinator image after the custom runtime pod already exists', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedPod = vi.fn().mockImplementation(async ({ name }) => {
      if (name === 'test-wf-coordinator') {
        return {
          metadata: { labels: { 'clerum.io/coordinator-tier': 'custom' } },
          status: { phase: 'Running' },
          spec: { containers: [{ image: 'clerum/workflow-custom-sdk-e2e:test' }] },
        }
      }
      throw { code: 404 }
    })
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [{ id: 'render', run: snippetRun() }],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('coordinator tier is immutable')
    expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled()
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects disallowed custom coordinator image prefixes before creating pods', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['ghcr.io/your-org/'],
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'docker.io/unknown/custom:test',
        steps: [{ id: 'prepare' }],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('not allowed')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects adjacent custom coordinator image prefix bypasses', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['ghcr.io/your-org/workflow'],
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'ghcr.io/your-org/workflow-evil:test',
        steps: [{ id: 'prepare' }],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('not allowed')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects custom coordinator image path traversal segments before prefix checks', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['ghcr.io/your-org/'],
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'ghcr.io/your-org/../../attacker/workflow:test',
        steps: [{ id: 'prepare' }],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('custom coordinator image reference is invalid')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects custom coordinator images when the allowlist is empty', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: [],
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        steps: [{ id: 'prepare' }],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('allowlist is empty')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it.each([
    {
      caseName: 'slash boundary',
      prefixes: ['ghcr.io/your-org'],
      image: 'ghcr.io/your-org/workflow-custom:test',
    },
    {
      caseName: 'tag boundary',
      prefixes: ['clerum/workflow-custom-sdk-e2e'],
      image: 'clerum/workflow-custom-sdk-e2e:test',
    },
    {
      caseName: 'digest boundary',
      prefixes: ['clerum/workflow-custom-sdk-e2e'],
      image: `clerum/workflow-custom-sdk-e2e@sha256:${'a'.repeat(64)}`,
    },
    {
      caseName: 'prefix ending with explicit tag delimiter',
      prefixes: ['clerum/workflow-custom-sdk-e2e:'],
      image: 'clerum/workflow-custom-sdk-e2e:test',
    },
  ])('accepts custom coordinator allowlist $caseName', async ({ prefixes, image }) => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: prefixes,
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: image,
        steps: [{ id: 'prepare' }],
      })
    )

    expect(result.workflowPhase).not.toBe('failed')
    expect(coreApi.createNamespacedPod).toHaveBeenCalled()
  })

  it('rejects latest custom coordinator images', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/'],
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:latest',
        steps: [{ id: 'prepare' }],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('must not use :latest')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects latest custom coordinator images even when a digest is present', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/'],
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: `clerum/workflow-custom-sdk-e2e:latest@sha256:${'a'.repeat(64)}`,
        steps: [{ id: 'prepare' }],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('must not use :latest')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects malformed custom coordinator digests', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/'],
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test@sha256:nothex',
        steps: [{ id: 'prepare' }],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('valid sha256 digest')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects uppercase custom coordinator sha256 digests', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/'],
          requireCoordinatorImageDigest: true,
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: `clerum/workflow-custom-sdk-e2e:test@sha256:${'A'.repeat(64)}`,
        steps: [{ id: 'prepare' }],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('valid sha256 digest')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('enforces custom coordinator digest policy when configured', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/'],
          requireCoordinatorImageDigest: true,
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        steps: [{ id: 'prepare' }],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('valid sha256 digest')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('accepts valid custom coordinator digest refs when digest policy is configured', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/workflow-custom-sdk-e2e'],
          requireCoordinatorImageDigest: true,
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: `clerum/workflow-custom-sdk-e2e:test@sha256:${'a'.repeat(64)}`,
        steps: [{ id: 'prepare' }],
      })
    )

    expect(result.message).toContain('workflow-custom')
    expect(coreApi.createNamespacedPod).toHaveBeenCalled()
  })

  it('fails custom approval steps without a broker agent before creating runtime resources', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          enableCustomCoordinatorImage: true,
          allowedCoordinatorImagePrefixes: ['clerum/workflow-custom-sdk-e2e:'],
        } as never,
      })
    )

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        steps: [
          {
            id: 'approval',
            requiresApproval: {
              target: { userId: 'operator' },
              message: 'approve custom step',
            },
          },
        ],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('requires an agent configuration for approval')
    expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled()
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('classifies all-run workflows as snippet workflows even when a default agent is present', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        steps: [{ id: 'render', run: snippetRun() }],
      })
    )

    const createdPodNames = coreApi.createNamespacedPod.mock.calls.map(
      ([arg]) => arg.body?.metadata?.name
    )
    expect(result.message).toContain('workflow-snippet')
    expect(createdPodNames).toContain('test-wf-coordinator')
    expect(createdPodNames).not.toContain('test-wf-mcp-host')
  })

  it('rejects run steps that also configure a step agent', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [
          {
            id: 'ambiguous',
            run: snippetRun(),
            agent: { provider: 'zai', model: 'glm-4.7' },
          },
        ],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('cannot configure an agent when run is set')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects snippet run steps that require approval before creating pods', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [
          {
            id: 'gated',
            run: snippetRun(),
            requiresApproval: {
              target: { userId: 'operator' },
              message: 'approve snippet step',
            },
          },
        ],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('cannot require approval')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('skips runtime token Secret provisioning for pure snippet workflows', async () => {
    vi.mocked(issueMcpHostRuntimeTokens).mockClear()
    const reconciler = new WorkflowReconciler(deps)

    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'recipe-runtime-ns',
      makeSpec({
        agent: undefined,
        steps: [{ id: 'render', run: snippetRun() }],
      })
    )

    expect(issueMcpHostRuntimeTokens).not.toHaveBeenCalled()
  })

  it('does not mount mcp-host credentials on snippet coordinator pods', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [{ id: 'render', run: snippetRun() }],
      })
    )

    const coordPod = getCreatedCoordinatorPod(coreApi)
    const envNames = coordPod.spec!.containers![0].env!.map((env: { name: string }) => env.name)
    expect(envNames).not.toContain('MCP_HOST_ENDPOINT')
    expect(envNames).not.toContain('MCP_HOST_TOKEN')
    expect(envNames).not.toContain('MCP_HOST_RUNTIME_ACCESS_TOKEN')
  })

  it('mounts the parent output PVC on snippet coordinator pods when workflow output is enabled', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [
          {
            id: 'pdf',
            run: snippetRun(),
          },
        ],
      }),
      undefined,
      undefined,
      undefined,
      runId
    )

    const coordPod = getCreatedCoordinatorPod(coreApi)
    const outputMount = coordPod.spec!.containers![0].volumeMounts!.find(
      (mount: { mountPath: string }) => mount.mountPath === '/output'
    )
    expect(outputMount).toMatchObject({
      name: 'recipe-output',
      subPath: `workflow-output/test-wf/${runId}`,
    })
    const createdPodNames = coreApi.createNamespacedPod.mock.calls.map(
      ([arg]) => arg.body?.metadata?.name
    )
    expect(createdPodNames).toContain('test-wf-artifact-reader')
    expect(createdPodNames).not.toContain('test-wf-mcp-host')
    expect(getCreatedArtifactReaderPod(coreApi).spec!.containers![0].volumeMounts).toContainEqual(
      expect.objectContaining({
        name: 'recipe-output',
        mountPath: '/output',
        subPath: `workflow-output/test-wf/${runId}`,
      })
    )
    expectWorkflowOutputAnchorAffinity(coordPod)
  })

  it('rejects invalid snippet step shapes before creating pods', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [{ id: 'bad', instruction: 'run', run: snippetRun() }],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('cannot configure both run and instruction')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects unsupported snippet run fields before creating pods', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [
          {
            id: 'bad',
            run: { ...snippetRun(), unexpected: true } as never,
          },
        ],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('run contains unsupported field "unexpected"')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects non-snippet run types before creating pods', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [
          {
            id: 'bad',
            run: { type: 'handler', handler: 'foo' } as never,
          },
        ],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('run.type must be snippet')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects cyclic step dependencies before creating pods', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [
          { id: 'first', dependsOn: ['second'], run: snippetRun() },
          { id: 'second', dependsOn: ['first'], run: snippetRun() },
        ],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('dependency cycle detected')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects duplicate step ids before creating pods', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [
          { id: 'first', run: { handler: 'noop' } },
          { id: 'first', run: { handler: 'noop' } },
        ],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('duplicate step id "first" is not allowed')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('rejects unknown step dependencies before creating pods', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        agent: undefined,
        steps: [{ id: 'first', dependsOn: ['missing'], run: snippetRun() }],
      })
    )

    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('depends on unknown step "missing"')
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('does not read selected-node or pin mcp-host pods to stale node names', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec(),
      undefined,
      undefined,
      undefined,
      runId
    )

    expect(coreApi.readNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    const mcpHostPod = getCreatedMcpHostPod(coreApi)
    expectWorkflowOutputAnchorAffinity(mcpHostPod)
  })

  it('creates mcp-host pods with anchor affinity and does not inspect selected-node', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedPersistentVolumeClaim = vi.fn().mockResolvedValue({
      metadata: { annotations: {} },
      spec: { accessModes: ['ReadWriteOnce'] },
      status: { accessModes: ['ReadWriteOnce'] },
    })
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec(),
      undefined,
      undefined,
      undefined,
      runId
    )

    expect(result.phase).toBeDefined()
    expect(coreApi.readNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    const mcpHostPod = getCreatedMcpHostPod(coreApi)
    expectWorkflowOutputAnchorAffinity(mcpHostPod)
  })

  it('does not need selected-node lookup to use anchor affinity', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedPersistentVolumeClaim = vi.fn().mockRejectedValue({ code: 404 })
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec(),
      undefined,
      undefined,
      undefined,
      runId
    )

    expect(result.phase).toBeDefined()
    expect(coreApi.readNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    const mcpHostPod = getCreatedMcpHostPod(coreApi)
    expectWorkflowOutputAnchorAffinity(mcpHostPod)
  })

  it('ignores stale selected-node annotations when creating mcp-host pods', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedPersistentVolumeClaim = vi.fn().mockResolvedValue({
      metadata: {
        annotations: {
          'volume.kubernetes.io/selected-node': 'node-a',
        },
      },
      spec: { accessModes: ['ReadWriteMany'] },
      status: { accessModes: ['ReadWriteMany'] },
    })
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec(),
      undefined,
      undefined,
      undefined,
      runId
    )

    expect(result.phase).toBeDefined()
    expect(coreApi.readNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    const mcpHostPod = getCreatedMcpHostPod(coreApi)
    expectWorkflowOutputAnchorAffinity(mcpHostPod)
  })

  it('creates NetworkPolicies via networkingApi', async () => {
    const reconciler = new WorkflowReconciler(deps)
    await reconciler.reconcile('test-wf', 'uid-123', 'sandbox-recipes', makeSpec())
    expect(deps.networkingApi.createNamespacedNetworkPolicy).toHaveBeenCalled()
  })

  it('passes runRetention through schedule reconcile into workflow_schedules', async () => {
    const { pool: pgPool, query: pgQuery } = makePgPool()
    const schedulingDeps = makeDeps({ pgPool })
    const reconciler = new WorkflowReconciler(schedulingDeps)

    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec({
        triggers: {
          schedule: {
            cron: '0 9 * * *',
            timezone: 'UTC',
          },
        },
        runRetention: {
          maxRunDurationSeconds: 1800,
          ttlSecondsAfterFinished: 3600,
        },
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      '11111111-1111-4111-8111-111111111111'
    )

    const insertCall = pgQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO workflow_schedules')
    )
    expect(insertCall).toBeDefined()
    expect(String(insertCall?.[0])).toContain('max_duration_seconds')
    expect(String(insertCall?.[0])).toContain('ttl_seconds_after_finished')
    expect((insertCall?.[1] as unknown[] | undefined)?.[2]).toBe(
      '11111111-1111-4111-8111-111111111111'
    )
    expect((insertCall?.[1] as unknown[] | undefined)?.[8]).toBe(1800)
    expect((insertCall?.[1] as unknown[] | undefined)?.[9]).toBe(3600)
  })

  it('calls tokenFactory to generate coordinator tokens (WRC→mcp-host tokens are now signed per-request, not on reconcile)', async () => {
    const reconciler = new WorkflowReconciler(deps)
    await reconciler.reconcile('test-wf', 'uid-123', 'sandbox-recipes', makeSpec())
    const tf = deps.tokenFactory as unknown as ReturnType<typeof makeTokenFactory>
    // Coordinator tokens are persistent (Secret-mounted) → signed at reconcile time.
    expect(tf.signCoordinatorToMcpHostToken).toHaveBeenCalled()
    expect(tf.signCoordinatorToWrcToken).toHaveBeenCalled()
    // WRC→mcp-host configure/artifact tokens are no longer issued on reconcile —
    // they are signed fresh per call by restEndpoints handlers.
    expect(tf.signWrcConfigureToken).not.toHaveBeenCalled()
    expect(tf.signWrcArtifactToken).not.toHaveBeenCalled()
  })

  it('is idempotent — Pod already running causes no crash (readNamespacedPod returns existing)', async () => {
    const coreApiWithExistingPod = makeCoreApi(true)
    const idempotentDeps = makeDeps({ coreApi: coreApiWithExistingPod as never })
    const reconciler = new WorkflowReconciler(idempotentDeps)

    // Should not throw on second reconcile
    const result = await reconciler.reconcile('test-wf', 'uid-123', 'sandbox-recipes', makeSpec())
    expect(result.phase).toBeDefined()
  })

  it('deletes stale mcp-host and artifact reader before coordinator recovery and recreates runtime pods', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedPod = vi.fn().mockImplementation(async ({ name }) => {
      if (name === 'test-wf-coordinator') {
        return {
          status: { phase: 'Failed' },
          spec: { containers: [{ image: 'clerum/coordinator:test' }] },
        }
      }
      if (name === 'test-wf-mcp-host') {
        return {
          status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
          spec: { containers: [{ image: 'mcp-host' }] },
        }
      }
      if (name === 'test-wf-workflow-output-anchor') {
        return { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } }
      }
      if (name === 'test-wf-workflow-output-prepare') {
        return { status: { phase: 'Succeeded' } }
      }
      throw { code: 404 }
    })
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec(),
      {
        workflowExecution: { phase: 'running', attempt: 0 },
      },
      undefined,
      undefined,
      runId
    )

    expect(result.phase).toBeDefined()
    const deletedNames = coreApi.deleteNamespacedPod.mock.calls.map(([arg]) => arg.name)
    expect(deletedNames.slice(0, 3)).toEqual([
      'test-wf-mcp-host',
      'test-wf-artifact-reader',
      'test-wf-coordinator',
    ])
    const createdPodNames = coreApi.createNamespacedPod.mock.calls.map(
      ([arg]) => arg.body?.metadata?.name
    )
    expect(createdPodNames).toContain('test-wf-mcp-host')
    expect(createdPodNames).toContain('test-wf-artifact-reader')
    expect(createdPodNames).toContain('test-wf-coordinator')
  })

  it('handles spec with no mcpServers (pure-compute workflow)', async () => {
    const reconciler = new WorkflowReconciler(deps)
    const spec = makeSpec({ mcpServers: undefined })
    const result = await reconciler.reconcile('pure-compute', 'uid-pc', 'sandbox-recipes', spec)
    expect(result.phase).toBeDefined()
    // Should not crash on missing mcpServers
  })

  it('returns failed when coreApi createNamespacedSecret rejects with non-404', async () => {
    const errorDeps = makeDeps({
      coreApi: {
        ...makeCoreApi(),
        createNamespacedSecret: vi.fn().mockRejectedValue(new Error('quota exceeded')),
      } as never,
    })
    const reconciler = new WorkflowReconciler(errorDeps)
    const result = await reconciler.reconcile('test-wf', 'uid-123', 'sandbox-recipes', makeSpec())
    expect(result.phase).toBe('failed')
    expect(result.message).toBeDefined()
  })

  it('fails reconcile when creating the mcpHost runtime token Secret fails', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.createNamespacedSecret = vi.fn().mockImplementation(async ({ body }) => {
      if (body?.metadata?.name === 'wf-test-wf-mcp-host-runtime-tokens') {
        throw new Error('approval secret create failed')
      }
      return {}
    })
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'recipe-runtime-ns',
      makeSpec(),
      undefined,
      undefined,
      undefined,
      runId
    )

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('approval secret create failed')
  })

  it('refreshes the mcpHost runtime token Secret when stored tokens are near expiry', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedSecret = vi.fn().mockImplementation(async ({ name }) => {
      if (name === 'wf-test-wf-mcp-host-runtime-tokens') {
        return {
          data: {
            'mcp-host-runtime-access-token': Buffer.from(makeJwtWithExp(30)).toString('base64'),
            'mcp-host-runtime-refresh-token': Buffer.from(makeJwtWithExp(30)).toString('base64'),
            'mcp-host-workflow-control-token': Buffer.from(makeJwtWithExp(30)).toString('base64'),
          },
        }
      }
      throw { code: 404 }
    })

    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))
    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'recipe-runtime-ns',
      makeSpec(),
      undefined,
      undefined,
      undefined,
      runId
    )

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledWith('recipe-runtime-ns', 'test-wf', [])
    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'wf-test-wf-mcp-host-runtime-tokens',
        namespace: 'sandbox-recipes',
      }),
      expect.any(Object)
    )
  })

  it('uses the configured runtime token refresh threshold for mcpHost runtime tokens', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedSecret = vi.fn().mockImplementation(async ({ name }) => {
      if (name === 'wf-test-wf-mcp-host-runtime-tokens') {
        return {
          data: {
            'mcp-host-runtime-access-token': Buffer.from(
              makeJwtWithExp(1200, { recipeName: 'test-wf' })
            ).toString('base64'),
            'mcp-host-runtime-refresh-token': Buffer.from(
              makeJwtWithExp(1200, { recipeName: 'test-wf' })
            ).toString('base64'),
            'mcp-host-workflow-control-token': Buffer.from(
              makeJwtWithExp(1200, { recipeName: 'test-wf' })
            ).toString('base64'),
          },
        }
      }
      throw { code: 404 }
    })

    const reconciler = new WorkflowReconciler(
      makeDeps({
        coreApi: coreApi as never,
        config: {
          ...makeConfig(),
          runtimeTokenTtlSeconds: 3600,
          runtimeTokenRefreshBeforeSeconds: 1800,
        } as never,
      })
    )
    await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'recipe-runtime-ns',
      makeSpec(),
      undefined,
      undefined,
      undefined,
      runId
    )

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledWith('recipe-runtime-ns', 'test-wf', [])
    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'wf-test-wf-mcp-host-runtime-tokens' }),
      expect.any(Object)
    )
  })

  it('reissues mcpHost runtime tokens when the stored recipeName no longer matches the runtime scope', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedSecret = vi.fn().mockImplementation(async ({ name }) => {
      if (name === 'wf-child-run-mcp-host-runtime-tokens') {
        return {
          data: {
            'mcp-host-runtime-access-token': Buffer.from(
              makeJwtWithExp(3600, { recipeName: 'child-run' })
            ).toString('base64'),
            'mcp-host-runtime-refresh-token': Buffer.from(
              makeJwtWithExp(3600, { recipeName: 'child-run' })
            ).toString('base64'),
            'mcp-host-workflow-control-token': Buffer.from(
              makeJwtWithExp(3600, { recipeName: 'child-run' })
            ).toString('base64'),
            'mcp-host-gfs-token': makeEncodedGfsAccess(3600, 'child-run'),
          },
        }
      }
      throw { code: 404 }
    })

    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))
    await reconciler.ensureMcpHostRuntimeCredentials(
      'recipe-runtime-ns',
      'child-run',
      makeSpec(),
      'parent-recipe'
    )

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledWith('recipe-runtime-ns', 'parent-recipe', [])
    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'wf-child-run-mcp-host-runtime-tokens',
        namespace: 'sandbox-recipes',
        body: {
          data: {
            'mcp-host-runtime-access-token': Buffer.from('mcp-host-runtime-access-token').toString(
              'base64'
            ),
            'mcp-host-runtime-refresh-token': Buffer.from(
              'mcp-host-runtime-refresh-token'
            ).toString('base64'),
            'mcp-host-workflow-control-token': Buffer.from(
              'mcp-host-workflow-control-token'
            ).toString('base64'),
            'mcp-host-gfs-token': Buffer.from('gfs-runtime-value').toString('base64'),
          },
        },
      }),
      expect.any(Object)
    )
  })

  it('treats mcpHost runtime token Secret 409 as idempotent and reuses the existing Secret', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    let mcpHostRuntimeSecretCreated = false

    coreApi.readNamespacedSecret = vi.fn().mockImplementation(async ({ name }) => {
      if (name === 'wf-test-wf-mcp-host-runtime-tokens') {
        if (!mcpHostRuntimeSecretCreated) throw { code: 404 }
        return {
          data: {
            'mcp-host-runtime-access-token': Buffer.from(
              makeJwtWithExp(3600, { recipeName: 'test-wf' })
            ).toString('base64'),
            'mcp-host-runtime-refresh-token': Buffer.from(
              makeJwtWithExp(3600, { recipeName: 'test-wf' })
            ).toString('base64'),
            'mcp-host-workflow-control-token': Buffer.from(makeJwtWithExp(3600)).toString('base64'),
            'mcp-host-gfs-token': makeEncodedGfsAccess(),
          },
        }
      }
      throw { code: 404 }
    })
    coreApi.createNamespacedSecret = vi.fn().mockImplementation(async ({ body }) => {
      if (body?.metadata?.name === 'wf-test-wf-mcp-host-runtime-tokens') {
        mcpHostRuntimeSecretCreated = true
        throw { code: 409 }
      }
      return {}
    })

    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))
    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'recipe-runtime-ns',
      makeSpec(),
      undefined,
      undefined,
      undefined,
      runId
    )

    expect(result.phase).not.toBe('failed')
    expect(coreApi.createNamespacedSecret).toHaveBeenCalled()
    expect(coreApi.patchNamespacedSecret).not.toHaveBeenCalled()
  })

  it('keeps the existing mcpHost runtime token Secret when stored tokens are healthy', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedSecret = vi.fn().mockImplementation(async ({ name }) => {
      if (name === 'wf-test-wf-mcp-host-runtime-tokens') {
        return {
          data: {
            'mcp-host-runtime-access-token': Buffer.from(
              makeJwtWithExp(3600, { recipeName: 'test-wf' })
            ).toString('base64'),
            'mcp-host-runtime-refresh-token': Buffer.from(
              makeJwtWithExp(3600, { recipeName: 'test-wf' })
            ).toString('base64'),
            'mcp-host-workflow-control-token': Buffer.from(
              makeJwtWithExp(3600, { recipeName: 'test-wf' })
            ).toString('base64'),
            'mcp-host-gfs-token': makeEncodedGfsAccess(),
          },
        }
      }
      throw { code: 404 }
    })

    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))
    const callsBefore = vi.mocked(issueMcpHostRuntimeTokens).mock.calls.length
    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'recipe-runtime-ns',
      makeSpec(),
      undefined,
      undefined,
      undefined,
      runId
    )

    expect(result.phase).not.toBe('failed')
    expect(vi.mocked(issueMcpHostRuntimeTokens).mock.calls.length).toBe(callsBefore)
    expect(coreApi.patchNamespacedSecret).not.toHaveBeenCalled()
  })

  it('reissues stale access and refresh scopes once, then converges on the next reconcile', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const expectedWorkflowControlScopes = [
      'workflow:trigger',
      'workflow:approval:resolve',
      'workflow:approval:decide',
    ]
    const canonicalAccessToken = makeJwtWithExp(3600, {
      workflowControlScopes: expectedWorkflowControlScopes,
    })
    const canonicalRefreshToken = makeJwtWithExp(3600, {
      workflowControlScopes: expectedWorkflowControlScopes,
    })
    const canonicalControlToken = makeJwtWithExp(3600, {
      scopes: expectedWorkflowControlScopes,
    })
    vi.mocked(issueMcpHostRuntimeTokens).mockResolvedValue({
      accessToken: canonicalAccessToken,
      refreshToken: canonicalRefreshToken,
      mcpHostControlToken: canonicalControlToken,
    })

    let secretData: Record<string, string> = {
      'mcp-host-runtime-access-token': Buffer.from(
        makeJwtWithExp(3600, { workflowControlScopes: ['workflow:list'] })
      ).toString('base64'),
      'mcp-host-runtime-refresh-token': Buffer.from(
        makeJwtWithExp(3600, { workflowControlScopes: ['workflow:list'] })
      ).toString('base64'),
      'mcp-host-workflow-control-token': Buffer.from(
        makeJwtWithExp(3600, { scopes: expectedWorkflowControlScopes })
      ).toString('base64'),
      'mcp-host-gfs-token': makeEncodedGfsAccess(),
    }
    coreApi.readNamespacedSecret = vi.fn().mockImplementation(async ({ name }) => {
      if (name === 'wf-test-wf-mcp-host-runtime-tokens') return { data: secretData }
      throw { code: 404 }
    })
    coreApi.patchNamespacedSecret = vi.fn().mockImplementation(async ({ body }) => {
      secretData = { ...secretData, ...(body?.data ?? {}) }
      return {}
    })

    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))
    const spec = makeSpec({
      steps: [
        {
          id: 'broker-trigger',
          instruction: 'Trigger a workflow',
          allowedTools: { include: ['workflow_trigger'] },
        },
      ],
    })

    await reconciler.ensureMcpHostRuntimeCredentials('recipe-runtime-ns', 'test-wf', spec)
    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledTimes(1)
    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledWith(
      'recipe-runtime-ns',
      'test-wf',
      expectedWorkflowControlScopes
    )
    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledTimes(1)

    await reconciler.ensureMcpHostRuntimeCredentials('recipe-runtime-ns', 'test-wf', spec)
    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledTimes(1)
    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledTimes(1)
  })

  it('reissues only the workflow-control token when declared broker scopes change', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const expectedWorkflowControlScopes = [
      'workflow:trigger',
      'workflow:approval:resolve',
      'workflow:approval:decide',
    ]
    coreApi.readNamespacedSecret = vi.fn().mockImplementation(async ({ name }) => {
      if (name === 'wf-test-wf-mcp-host-runtime-tokens') {
        return {
          data: {
            'mcp-host-runtime-access-token': Buffer.from(
              makeJwtWithExp(3600, {
                recipeName: 'test-wf',
                workflowControlScopes: expectedWorkflowControlScopes,
              })
            ).toString('base64'),
            'mcp-host-runtime-refresh-token': Buffer.from(
              makeJwtWithExp(3600, {
                recipeName: 'test-wf',
                workflowControlScopes: expectedWorkflowControlScopes,
              })
            ).toString('base64'),
            'mcp-host-workflow-control-token': Buffer.from(
              makeJwtWithExp(3600, { recipeName: 'test-wf', scopes: ['workflow:list'] })
            ).toString('base64'),
            'mcp-host-gfs-token': makeEncodedGfsAccess(),
          },
        }
      }
      throw { code: 404 }
    })

    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))
    const runtimeCallsBefore = vi.mocked(issueMcpHostRuntimeTokens).mock.calls.length
    await reconciler.ensureMcpHostRuntimeCredentials(
      'recipe-runtime-ns',
      'test-wf',
      makeSpec({
        steps: [
          {
            id: 'broker-trigger',
            instruction: 'Trigger a workflow',
            allowedTools: { include: ['workflow_trigger'] },
          },
        ],
      })
    )

    expect(vi.mocked(issueMcpHostRuntimeTokens).mock.calls.length).toBe(runtimeCallsBefore)
    expect(issueMcpHostWorkflowControlToken).toHaveBeenCalledWith('recipe-runtime-ns', 'test-wf', [
      ...expectedWorkflowControlScopes,
    ])
    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'wf-test-wf-mcp-host-runtime-tokens',
        namespace: 'sandbox-recipes',
        body: {
          data: {
            'mcp-host-workflow-control-token': Buffer.from(
              'mcp-host-workflow-control-token'
            ).toString('base64'),
          },
        },
      }),
      expect.any(Object)
    )
  })

  it('can repair a missing mcpHost runtime token Secret without recreating workflow pods', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    await reconciler.ensureMcpHostRuntimeCredentials('recipe-runtime-ns', 'test-wf', makeSpec())

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledWith('recipe-runtime-ns', 'test-wf', [])
    expect(coreApi.createNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'sandbox-recipes',
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'wf-test-wf-mcp-host-runtime-tokens',
          }),
        }),
      })
    )
    expect(coreApi.createNamespacedPod).not.toHaveBeenCalled()
  })

  it('derives workflow-control scopes from declared workflow broker tools', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    await reconciler.ensureMcpHostRuntimeCredentials(
      'recipe-runtime-ns',
      'test-wf',
      makeSpec({
        steps: [
          {
            id: 'broker',
            instruction: 'Use workflow broker',
            allowedTools: {
              include: [
                'clerum__list_workflows',
                'clerum__read_workflow',
                'clerum__trigger_workflow',
              ],
            },
          },
        ],
      })
    )

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledWith('recipe-runtime-ns', 'test-wf', [
      'workflow:list',
      'workflow:read',
      'workflow:trigger',
      'workflow:approval:resolve',
      'workflow:approval:decide',
    ])
  })

  it('derives write-scoped GFS host tokens from declared publish targets', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    await reconciler.ensureMcpHostRuntimeCredentials(
      'recipe-runtime-ns',
      'test-wf',
      makeSpec({
        gfs: {
          publishTargets: [{ drive: 'main', target: 'outputs' }],
        },
      })
    )

    expect(mintRecipeHostGfsToken).toHaveBeenCalledWith('recipe-runtime-ns', 'test-wf', {
      scopes: ['gfs.read', 'gfs.write'],
    })
  })

  it('derives workflow approval scopes from agentic approval-gated steps', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    await reconciler.ensureMcpHostRuntimeCredentials(
      'recipe-runtime-ns',
      'test-wf',
      makeSpec({
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [
          {
            id: 'approval-gated',
            instruction: 'Continue after approval',
            requiresApproval: {
              target: { userId: 'user-1' },
              message: 'Approve this step',
            },
          },
        ],
      })
    )

    expect(issueMcpHostRuntimeTokens).toHaveBeenCalledWith('recipe-runtime-ns', 'test-wf', [
      'workflow:approval:resolve',
      'workflow:approval:decide',
    ])
  })

  it('does not create mcpHost runtime credentials for snippet-only workflows', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    await reconciler.ensureMcpHostRuntimeCredentials(
      'recipe-runtime-ns',
      'test-wf',
      makeSpec({ steps: [{ id: 's1', run: snippetRun() }] })
    )

    expect(coreApi.createNamespacedSecret).not.toHaveBeenCalled()
    expect(issueMcpHostRuntimeTokens).not.toHaveBeenCalled()
  })

  it('cleans workflow output through artifact-reader before deleting runtime resources', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedService = vi.fn().mockImplementation(({ name }: { name: string }) => {
      if (name === 'wf-test-wf-artifact-reader') return Promise.resolve({})
      throw { code: 404 }
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response)
    vi.stubGlobal('fetch', fetchMock)
    const tokenFactory = makeTokenFactory()
    const reconciler = new WorkflowReconciler(
      makeDeps({ coreApi: coreApi as never, tokenFactory: tokenFactory as never })
    )

    await reconciler.reconcileDelete('test-wf', 'sandbox-recipes')

    expect(tokenFactory.signWrcArtifactDeleteToken).toHaveBeenCalledWith(
      'test-wf',
      'sandbox-recipes'
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'http://wf-test-wf-artifact-reader.sandbox-recipes.svc.cluster.local:8080/api/v1/workflow/artifacts',
      expect.objectContaining({
        method: 'DELETE',
        headers: { authorization: 'Bearer wrc-artifact-delete-token' },
      })
    )
    expect(coreApi.deleteNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'test-wf-artifact-reader' })
    )
  })

  it('keeps the finalizer retryable when runtime pod cleanup fails', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.deleteNamespacedPod = vi.fn().mockImplementation(({ name }: { name: string }) => {
      if (name === 'test-wf-workflow-output-anchor') {
        return Promise.reject({ code: 500, message: 'api server unavailable' })
      }
      return Promise.resolve({})
    })
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    await expect(reconciler.reconcileDelete('test-wf', 'sandbox-recipes')).rejects.toThrow(
      'test-wf-workflow-output-anchor'
    )

    expect(coreApi.deleteNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'test-wf-coordinator' })
    )
    expect(coreApi.deleteNamespacedPersistentVolumeClaim).toHaveBeenCalledWith({
      name: 'test-wf-workflow-output',
      namespace: 'sandbox-recipes',
    })
  })

  it('falls back to mcp-host artifact cleanup when artifact-reader is unavailable', async () => {
    const coreApi = makeCoreApi() as ReturnType<typeof makeCoreApi>
    coreApi.readNamespacedService = vi.fn().mockImplementation(({ name }: { name: string }) => {
      if (name === 'wf-test-wf-mcp-host') return Promise.resolve({})
      throw { code: 404 }
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response)
    vi.stubGlobal('fetch', fetchMock)
    const reconciler = new WorkflowReconciler(makeDeps({ coreApi: coreApi as never }))

    await reconciler.reconcileDelete('test-wf', 'sandbox-recipes')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'http://wf-test-wf-mcp-host.sandbox-recipes.svc.cluster.local:8080/api/v1/workflow/artifacts'
    )
  })

  it('deletes workflow trigger policy and cancels live approvals for the deleted recipe', async () => {
    const { pool: pgPool, query, release } = makePgPool()
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("to_regclass('public.workflow_recipe_allowed_users')")) {
        return { rows: [{ regclass: 'workflow_recipe_allowed_users' }], rowCount: 1 }
      }
      const trimmed = String(sql).trim().toUpperCase()
      if (trimmed.startsWith('SELECT')) {
        return { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 1 }
    })
    const reconciler = new WorkflowReconciler(makeDeps({ pgPool }))

    await reconciler.reconcileDelete('test-wf', 'sandbox-recipes')

    const sqls = query.mock.calls.map(([sql]) => String(sql))
    expect(sqls).toContainEqual('BEGIN')
    expect(sqls).toContainEqual(expect.stringContaining('DELETE FROM user_workflow_triggers'))
    expect(sqls).toContainEqual(expect.stringContaining('DELETE FROM team_workflow_triggers'))
    expect(sqls).toContainEqual(
      expect.stringContaining('DELETE FROM workflow_recipe_allowed_teams')
    )
    expect(sqls).toContainEqual(
      expect.stringContaining("to_regclass('public.workflow_recipe_allowed_users')")
    )
    expect(sqls).toContainEqual(
      expect.stringContaining('DELETE FROM workflow_recipe_allowed_users')
    )
    expect(sqls).toContainEqual(expect.stringContaining('UPDATE workflow_approval_requests'))
    expect(sqls).toContainEqual(expect.stringContaining("status IN ('pending', 'approved')"))
    expect(sqls).toContainEqual(
      expect.stringContaining("cancelled_by = COALESCE(cancelled_by, 'workflow-recipe-delete')")
    )
    expect(sqls).toContainEqual('COMMIT')
    expect(query.mock.calls).toContainEqual([
      expect.stringContaining('DELETE FROM team_workflow_triggers'),
      ['sandbox-recipes', 'test-wf'],
    ])
    expect(query.mock.calls).toContainEqual([
      expect.stringContaining('DELETE FROM workflow_recipe_allowed_teams'),
      ['sandbox-recipes', 'test-wf'],
    ])
    expect(query.mock.calls).toContainEqual([
      expect.stringContaining('DELETE FROM workflow_recipe_allowed_users'),
      ['sandbox-recipes', 'test-wf'],
    ])
    expect(query.mock.calls).toContainEqual([
      expect.stringContaining('UPDATE workflow_approval_requests'),
      ['sandbox-recipes', 'test-wf'],
    ])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('keeps recipe-delete cleanup idempotent when legacy allowed-users table is absent', async () => {
    const { pool: pgPool, query, release } = makePgPool()
    const reconciler = new WorkflowReconciler(makeDeps({ pgPool }))

    await reconciler.reconcileDelete('test-wf', 'sandbox-recipes')

    const sqls = query.mock.calls.map(([sql]) => String(sql))
    expect(sqls).toContainEqual(
      expect.stringContaining("to_regclass('public.workflow_recipe_allowed_users')")
    )
    expect(sqls).not.toContainEqual(
      expect.stringContaining('DELETE FROM workflow_recipe_allowed_users')
    )
    expect(sqls).toContainEqual('COMMIT')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('workflowPhase in result is a valid WorkflowPhase value', async () => {
    const reconciler = new WorkflowReconciler(deps)
    const result = await reconciler.reconcile(
      'test-wf',
      'uid-123',
      'sandbox-recipes',
      makeSpec(),
      undefined,
      undefined,
      'test-wf',
      runId
    )
    const validPhases = [
      'pending',
      'approved',
      'deploying',
      'running',
      'awaiting_approval',
      'completed',
      'failed',
      'cancelling',
      'cancelled',
      'recovering',
      'initializing',
    ]
    expect(validPhases).toContain(result.workflowPhase)
  })
})
