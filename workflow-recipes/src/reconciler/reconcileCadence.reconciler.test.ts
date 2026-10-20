/**
 * Issue #1016 — the DNS-block record a full reconcile writes. Uses the same
 * apiserver doubles as reconciler.test.ts, reduced to what these passes touch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import type { WorkflowRecipeCRD } from '../types'
import { deriveWorkflowRuntimePlan } from '../workflow/runtimePlan'
import { WorkflowReconciler } from '../workflow/workflowReconciler'
import { captureLoggerLevels } from './__tests__/captureLogger'
import { ownershipSignature, runInReconcileContext } from './reconcileContext'
import * as rb from './resourceBuilder'
import { WorkflowRecipeReconciler } from './workflowRecipeReconciler'

const ok = () => vi.fn().mockResolvedValue({})
const notFound = () => vi.fn().mockRejectedValue({ code: 404 })

const mockAppsApi = {
  createNamespacedDeployment: ok(),
  readNamespacedDeployment: notFound(),
  replaceNamespacedDeployment: ok(),
  deleteNamespacedDeployment: ok(),
  createNamespacedStatefulSet: ok(),
  readNamespacedStatefulSet: notFound(),
  patchNamespacedStatefulSet: ok(),
  replaceNamespacedStatefulSet: ok(),
  deleteNamespacedStatefulSet: ok(),
  createNamespacedDaemonSet: ok(),
  readNamespacedDaemonSet: notFound(),
  replaceNamespacedDaemonSet: ok(),
  deleteNamespacedDaemonSet: ok(),
}
const mockBatchApi = {
  createNamespacedCronJob: ok(),
  readNamespacedCronJob: notFound(),
  replaceNamespacedCronJob: ok(),
  deleteNamespacedCronJob: ok(),
  createNamespacedJob: ok(),
  readNamespacedJob: notFound(),
  replaceNamespacedJob: ok(),
  deleteNamespacedJob: ok(),
}
const mockCoreApi = {
  createNamespacedService: ok(),
  readNamespacedService: notFound(),
  replaceNamespacedService: ok(),
  deleteNamespacedService: ok(),
  deleteCollectionNamespacedService: ok(),
  createNamespacedPersistentVolumeClaim: ok(),
  readNamespacedPersistentVolumeClaim: notFound(),
  deleteNamespacedPersistentVolumeClaim: ok(),
  deleteCollectionNamespacedPod: ok(),
  deleteNamespacedPod: ok(),
  createNamespacedSecret: ok(),
  readNamespacedSecret: notFound(),
  replaceNamespacedSecret: ok(),
  deleteNamespacedSecret: ok(),
  createNamespacedConfigMap: ok(),
  readNamespacedConfigMap: notFound(),
  replaceNamespacedConfigMap: ok(),
  deleteNamespacedConfigMap: ok(),
}
const mockCustomApi = {
  createNamespacedCustomObject: ok(),
  getNamespacedCustomObject: notFound(),
  listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
  replaceNamespacedCustomObject: ok(),
  patchNamespacedCustomObject: ok(),
  patchNamespacedCustomObjectStatus: ok(),
  deleteNamespacedCustomObject: ok(),
  deleteCollectionNamespacedCustomObject: ok(),
}
const mockNetworkingApi = {
  createNamespacedNetworkPolicy: ok(),
  readNamespacedNetworkPolicy: notFound(),
  replaceNamespacedNetworkPolicy: ok(),
  listNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ items: [] }),
  deleteNamespacedNetworkPolicy: ok(),
  deleteCollectionNamespacedNetworkPolicy: ok(),
}

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: vi.fn().mockImplementation(() => ({
    makeApiClient: vi.fn().mockImplementation((ApiClass: unknown) => {
      const name = (ApiClass as { name: string }).name
      if (name === 'AppsV1Api') return mockAppsApi
      if (name === 'BatchV1Api') return mockBatchApi
      if (name === 'CustomObjectsApi') return mockCustomApi
      if (name === 'NetworkingV1Api') return mockNetworkingApi
      return mockCoreApi
    }),
  })),
  AppsV1Api: { name: 'AppsV1Api' },
  BatchV1Api: { name: 'BatchV1Api' },
  CoreV1Api: { name: 'CoreV1Api' },
  CustomObjectsApi: { name: 'CustomObjectsApi' },
  NetworkingV1Api: { name: 'NetworkingV1Api' },
  setHeaderMiddleware: vi.fn(() => ({})),
}))

function makeRecipe(overrides?: Partial<WorkflowRecipeCRD>): WorkflowRecipeCRD {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'test-recipe', namespace: 'sandbox-recipes', uid: 'uid-123' },
    spec: {
      workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 }],
    },
    status: { phase: 'approved' },
    ...overrides,
  }
}

function newReconciler() {
  return new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
    fqdnLookup: async () => ['93.184.216.34'],
  } as never)
}

describe('DNS-block record (#1016)', () => {
  beforeEach(() => {
    process.env.CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED = 'true'
    mockCustomApi.listNamespacedCustomObject.mockReset()
    mockCustomApi.listNamespacedCustomObject.mockResolvedValue({ items: [] })
    // recipeStillActive reads the live recipe back and compares its uid.
    mockCustomApi.getNamespacedCustomObject.mockReset()
    mockCustomApi.getNamespacedCustomObject.mockImplementation(
      ({ name, plural }: { name?: string; plural?: string }) =>
        plural === 'contexts'
          ? Promise.reject({ code: 404 })
          : Promise.resolve({
              metadata: {
                uid: name === 'dry-run-workflow' ? 'uid-dry-wf' : 'uid-123',
                resourceVersion: '1',
                annotations: { 'clerum.io/network-ready': 'true' },
                labels: { 'clerum.io/recipe': 'test-recipe' },
              },
              status: { conditions: [{ type: 'ExternalEgressReady', status: 'True' }] },
              spec: { mcpServers: [] },
            })
    )
  })

  it('records recipe_egress for a classic recipe with external UI egress', async () => {
    const rec = newReconciler()
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'ui', type: 'deployment', image: 'ui:1', port: 8080 }],
        ui: {
          workloadRef: 'ui',
          port: 8080,
          egress: { external: [{ fqdn: 'current.example.com', port: 443 }] },
        },
      },
      status: { phase: 'active' },
    })
    const result = await rec.reconcile(recipe)
    const record = rec.dnsBlockRecordFor('test-recipe')
    expect(record?.blocks.has('recipe_egress')).toBe(true)
    expect(record?.fingerprint).toEqual(expect.any(String))
    expect(result.cadence?.dnsBlocks).toContain('recipe_egress')
  })

  it('records an empty block set for a dryRun workflow', async () => {
    const rec = newReconciler()
    ;(rec as unknown as { workflowReconciler: unknown }).workflowReconciler = {
      reconcile: vi.fn(),
      validateWorkflowSpec: vi.fn().mockReturnValue(undefined),
    }
    const recipe = makeRecipe({
      metadata: { name: 'dry-run-workflow', namespace: 'sandbox-recipes', uid: 'uid-dry-wf' },
      spec: {
        dryRun: true,
        workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }],
        steps: [{ id: 'run', run: { type: 'snippet', language: 'typescript', code: 'return 1' } }],
      },
      status: { phase: 'candidate' },
    } as Partial<WorkflowRecipeCRD>)
    const result = await rec.reconcile(recipe)
    const record = rec.dnsBlockRecordFor('dry-run-workflow')
    expect(record).toBeDefined()
    expect([...(record?.blocks ?? [])]).toEqual([])
    expect(result.cadence?.dnsBlocks).toEqual([])
  })

  it('drops the record when the pass throws', async () => {
    const rec = newReconciler()
    const recipe = makeRecipe({ status: { phase: 'active' } })
    await rec.reconcile(recipe)
    expect(rec.dnsBlockRecordFor('test-recipe')).toBeDefined()
    mockCustomApi.listNamespacedCustomObject.mockRejectedValue(new Error('apiserver down'))
    await expect(rec.reconcile(recipe)).rejects.toThrow('apiserver down')
    expect(rec.dnsBlockRecordFor('test-recipe')).toBeUndefined()
  })

  it('marks a stale pass (initial liveness check fails) and drops the record', async () => {
    const rec = newReconciler()
    const recipe = makeRecipe({ status: { phase: 'active' } })
    await rec.reconcile(recipe)
    expect(rec.dnsBlockRecordFor('test-recipe')).toBeDefined()
    mockCustomApi.getNamespacedCustomObject.mockRejectedValue({ code: 404 })
    const result = await rec.reconcile(makeRecipe({ status: { phase: 'active' } }))
    expect(result.cadence?.stale).toBe(true)
    expect(rec.dnsBlockRecordFor('test-recipe')).toBeUndefined()
  })
})

// ─── WorkflowReconciler runtime-HTTP egress hook (#1016, spec §3.3/§5) ───────
// Driven directly against a real WorkflowReconciler inside a reconcile context.
// `resolveRuntimeHttpEgressCidrs` is stubbed; only the NetworkPolicy list builders run.
describe('runtime_http_egress recording (#1016)', () => {
  const RECIPE = 'wf'
  const snippetRun = {
    type: 'snippet' as const,
    language: 'typescript' as const,
    code: 'return 1',
    capabilities: { http: { allowedHosts: ['api.example.com'] } },
  }
  const snippetSpec = {
    runtimeEgress: { http: { allowedHosts: ['api.example.com'] } },
    steps: [{ id: 'snippet', run: snippetRun }],
  }
  const coordinatorSpec = {
    coordinatorImage: 'registry.example.com/coord:1',
    runtimeEgress: { http: { allowedHosts: ['api.example.com'] } },
    steps: [{ id: 's1', instruction: 'x' }],
  }

  function realWr() {
    const networkingApi = {
      createNamespacedNetworkPolicy: ok(),
      readNamespacedNetworkPolicy: notFound(),
      replaceNamespacedNetworkPolicy: ok(),
      deleteNamespacedNetworkPolicy: ok(),
      listNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ items: [] }),
    }
    const resolve = vi.fn().mockResolvedValue(['93.184.216.34/32'])
    const wr = new WorkflowReconciler({
      coreApi: {} as never,
      customApi: {} as never,
      networkingApi: networkingApi as never,
      config: {
        sandboxNamespace: 'sandbox-recipes',
        mcpServerNamespace: 'mcp-server',
        controlPlaneNamespace: 'control-plane',
        runtimeEgressDnsOverlapSeconds: 300,
        enableSnippetRuntime: true,
      } as never,
      tokenFactory: {} as never,
      resolveRuntimeHttpEgressCidrs: resolve,
    })
    return { wr, resolve }
  }

  async function buildPolicies(
    wr: WorkflowReconciler,
    spec: Record<string, unknown>,
    opts: { awaitsTriggeredRun: boolean; eagerSdkMcpHost: boolean }
  ) {
    const runtime = deriveWorkflowRuntimePlan(spec as never, {
      recipeName: RECIPE,
      runtimeScopeRecipeName: RECIPE,
      workflowRunId: opts.awaitsTriggeredRun ? undefined : 'run-1',
    })
    const codex = {
      requiresCodexProxyEgress: false,
      derivedScopes: [],
      eligibility: 'ineligible',
      reason: 'static_only',
    }
    return runInReconcileContext(async () => {
      const built = await (
        wr as unknown as {
          buildWorkflowNetworkPoliciesForSpec: (...a: unknown[]) => Promise<{
            policies: Array<{ metadata?: { name?: string } }>
          }>
        }
      ).buildWorkflowNetworkPoliciesForSpec(
        RECIPE,
        'uid-1',
        spec,
        runtime,
        opts.awaitsTriggeredRun,
        codex,
        opts.eagerSdkMcpHost,
        { ...codex, requiresGrokProxyEgress: false }
      )
      return built.policies.map(p => p.metadata?.name)
    })
  }

  it('records the block when a run-path pass emits the snippet-runner egress policy', async () => {
    const { wr, resolve } = realWr()
    const { value, ctx } = await buildPolicies(wr, snippetSpec, {
      awaitsTriggeredRun: false,
      eagerSdkMcpHost: false,
    })
    expect(resolve).toHaveBeenCalled()
    expect(value).toContain('wf-snippet-runner-egress')
    expect([...ctx.dnsBlocks]).toEqual(['runtime_http_egress'])
  })

  it('records the block when a run-path pass emits the coordinator egress policy', async () => {
    const { wr } = realWr()
    const { value, ctx } = await buildPolicies(wr, coordinatorSpec, {
      awaitsTriggeredRun: false,
      eagerSdkMcpHost: false,
    })
    expect(value).toContain('wf-coord-to-wrc')
    expect([...ctx.dnsBlocks]).toEqual(['runtime_http_egress'])
  })

  it.each([
    ['snippet', snippetSpec, 'wf-snippet-runner-egress'],
    ['coordinator', coordinatorSpec, 'wf-coord-to-wrc'],
  ])(
    'records NO block on the eager SDK awaiting-trigger path with %s exact-host hosts',
    async (_n, spec, policyName) => {
      const { wr, resolve } = realWr()
      const { value, ctx } = await buildPolicies(wr, spec, {
        awaitsTriggeredRun: true,
        eagerSdkMcpHost: true,
      })
      // DNS is still resolved, but the pass strips the runtime-HTTP policy.
      expect(resolve).toHaveBeenCalled()
      expect(value).not.toContain(policyName)
      expect([...ctx.dnsBlocks]).toEqual([])
    }
  )

  it('records the block when the steady refresh builds runtime-HTTP policies', async () => {
    const { wr } = realWr()
    const { ctx } = await runInReconcileContext(() =>
      wr.refreshRuntimeHttpEgressNetworkPolicies(
        'sandbox-recipes',
        RECIPE,
        'uid-1',
        snippetSpec as never
      )
    )
    expect([...ctx.dnsBlocks]).toEqual(['runtime_http_egress'])
  })
})

// ─── Recorded block sets across the reconcile branches (#1016, spec §5) ──────
describe('DNS-block record per reconcile branch (#1016)', () => {
  const uiEgressSpec = {
    workloads: [{ id: 'ui', type: 'deployment', image: 'ui:1', port: 8080 }],
    ui: {
      workloadRef: 'ui',
      port: 8080,
      egress: { external: [{ fqdn: 'current.example.com', port: 443 }] },
    },
  }

  beforeEach(() => {
    process.env.CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED = 'true'
    mockCustomApi.listNamespacedCustomObject.mockReset()
    mockCustomApi.listNamespacedCustomObject.mockResolvedValue({ items: [] })
    mockCustomApi.getNamespacedCustomObject.mockReset()
    mockCustomApi.getNamespacedCustomObject.mockImplementation(({ plural }: { plural?: string }) =>
      plural === 'contexts'
        ? Promise.reject({ code: 404 })
        : Promise.resolve({
            metadata: { uid: 'uid-123', resourceVersion: '1', labels: {} },
            status: {},
            spec: { mcpServers: [] },
          })
    )
  })

  /** A real WorkflowReconciler whose credential minting is stubbed; its egress refresh is real. */
  function withRealWr(rec: WorkflowRecipeReconciler) {
    const wr = new WorkflowReconciler({
      coreApi: {} as never,
      customApi: {} as never,
      networkingApi: {
        createNamespacedNetworkPolicy: ok(),
        readNamespacedNetworkPolicy: notFound(),
        replaceNamespacedNetworkPolicy: ok(),
        deleteNamespacedNetworkPolicy: ok(),
        listNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ items: [] }),
      } as never,
      config: {
        sandboxNamespace: 'sandbox-recipes',
        mcpServerNamespace: 'mcp-server',
        controlPlaneNamespace: 'control-plane',
        runtimeEgressDnsOverlapSeconds: 300,
        enableSnippetRuntime: true,
      } as never,
      tokenFactory: {} as never,
      resolveRuntimeHttpEgressCidrs: vi.fn().mockResolvedValue(['93.184.216.34/32']),
    })
    wr.ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(wr as never as { validateWorkflowSpec: unknown }).validateWorkflowSpec = vi
      .fn()
      .mockReturnValue(undefined)
    ;(rec as unknown as { workflowReconciler: unknown }).workflowReconciler = wr
    return wr
  }

  const blocksOf = (rec: WorkflowRecipeReconciler) => [
    ...(rec.dnsBlockRecordFor('test-recipe')?.blocks ?? []),
  ]

  it('a workflow fall-through pass records recipe_egress', async () => {
    const rec = newReconciler()
    ;(rec as unknown as { workflowReconciler: unknown }).workflowReconciler = {
      reconcile: vi
        .fn()
        .mockResolvedValue({ phase: 'active', message: 'ok', workflowPhase: 'running' }),
      validateWorkflowSpec: vi.fn().mockReturnValue(undefined),
      ensureMcpHostRuntimeCredentials: vi.fn(),
      refreshRuntimeHttpEgressNetworkPolicies: vi.fn(),
    }
    const recipe = makeRecipe({
      spec: {
        ...uiEgressSpec,
        steps: [{ id: 'run', run: { type: 'snippet', language: 'typescript', code: 'return 1' } }],
      },
      status: { phase: 'candidate' },
    } as Partial<WorkflowRecipeCRD>)
    await rec.reconcile(recipe)
    expect(blocksOf(rec)).toEqual(['recipe_egress'])
  })

  it('a steady workflow active short-circuit records runtime_http_egress', async () => {
    const rec = newReconciler()
    withRealWr(rec)
    const recipe = makeRecipe({
      spec: {
        runtimeEgress: { http: { allowedHosts: ['api.example.com'] } },
        steps: [
          {
            id: 'snippet',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return 1',
              capabilities: { http: { allowedHosts: ['api.example.com'] } },
            },
          },
        ],
      },
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    } as Partial<WorkflowRecipeCRD>)
    const result = await rec.reconcile(recipe)
    expect(result.skipStatusPatch).toBe(true)
    expect(blocksOf(rec)).toEqual(['runtime_http_egress'])
  })

  it.each([
    ['zero workloads', { spec: { workloads: [] }, status: { phase: 'active' } }],
    [
      'a failed preflight',
      {
        spec: {
          ...uiEgressSpec,
          workloads: [...uiEgressSpec.workloads, ...uiEgressSpec.workloads],
        },
        status: { phase: 'active' },
      },
    ],
    [
      'a non-deployable classic recipe',
      { spec: uiEgressSpec, status: { phase: 'failed', message: 'image pull failed' } },
    ],
  ])('records an empty block set for %s', async (_name, overrides) => {
    const rec = newReconciler()
    const result = await rec.reconcile(makeRecipe(overrides as Partial<WorkflowRecipeCRD>))
    expect(rec.dnsBlockRecordFor('test-recipe')).toBeDefined()
    expect(blocksOf(rec)).toEqual([])
    expect(result.cadence?.dnsBlocks).toEqual([])
  })

  it('records an empty block set for a terminal run-scoped SDK workflow', async () => {
    const rec = newReconciler()
    withRealWr(rec)
    const recipe = makeRecipe({
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        labels: { 'clerum.io/workflow-run-id': 'run-1' },
      },
      spec: {
        pluginWorkloadSdk: { clientNotifications: {} },
        steps: [{ id: 's1', instruction: 'x' }],
      },
      status: { phase: 'failed', workflowExecution: { phase: 'cancelled' } },
    } as unknown as Partial<WorkflowRecipeCRD>)
    await rec.reconcile(recipe)
    expect(rec.dnsBlockRecordFor('test-recipe')).toBeDefined()
    expect(blocksOf(rec)).toEqual([])
  })
})

// ─── Secret-ownership signatures and pending repairs (#1016, spec §3.1/§3.4) ──
describe('ownership signatures (#1016 §3.4)', () => {
  const deleteMocks = () => [
    mockAppsApi.deleteNamespacedDeployment,
    mockAppsApi.deleteNamespacedStatefulSet,
    mockCoreApi.deleteNamespacedService,
  ]

  /** Secrets by name: 'owned' | 'foreign' | 'shared' | 'boom' (500). Unlisted names 404. */
  function stubSecrets(byName: Record<string, 'owned' | 'foreign' | 'shared' | 'boom'>) {
    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) => {
      const kind = byName[args.name]
      if (!kind) return Promise.reject({ code: 404 })
      if (kind === 'boom') return Promise.reject({ code: 500 })
      const labels: Record<string, string> =
        kind === 'owned'
          ? { 'clerum.io/owner-recipe': 'test-recipe' }
          : kind === 'shared'
            ? { 'clerum.io/shared': 'true' }
            : { 'clerum.io/owner-recipe': 'some-other-recipe' }
      return Promise.resolve({ metadata: { resourceVersion: '1', labels }, data: { k: 'eA==' } })
    })
  }

  const envSecretWorkload = (id: string, secret: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: 'deployment' as const,
    image: 'nginx:1.30.1-alpine',
    port: 8080,
    envSecret: { name: secret, keys: [{ secretKey: 'k', envVar: 'K' }] },
    ...extra,
  })

  beforeEach(() => {
    process.env.CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED = 'true'
    for (const m of deleteMocks()) {
      m.mockReset()
      m.mockResolvedValue({})
    }
    mockAppsApi.createNamespacedDeployment.mockClear()
    mockCoreApi.readNamespacedSecret.mockReset()
    mockCoreApi.readNamespacedSecret.mockRejectedValue({ code: 404 })
    mockCustomApi.listNamespacedCustomObject.mockReset()
    mockCustomApi.listNamespacedCustomObject.mockResolvedValue({ items: [] })
    mockCustomApi.getNamespacedCustomObject.mockReset()
    mockCustomApi.getNamespacedCustomObject.mockImplementation(({ plural }: { plural?: string }) =>
      plural === 'contexts'
        ? Promise.reject({ code: 404 })
        : Promise.resolve({
            metadata: { uid: 'uid-123', resourceVersion: '1', labels: {} },
            status: {},
            spec: { mcpServers: [] },
          })
    )
  })

  it('ownershipSignature is order-independent and empty when nothing is denied', () => {
    expect(ownershipSignature(['b:s2', 'a:s1'])).toBe(ownershipSignature(['a:s1', 'b:s2']))
    expect(ownershipSignature(['b:s2', 'a:s1'])).toBe('a:s1|b:s2')
    expect(ownershipSignature([])).toBe('')
  })

  it('observeSecretOwnership: clean / shared / foreign / unverifiable / read throw, never tears down', async () => {
    const rec = newReconciler()
    const recipe = makeRecipe({
      spec: { workloads: [envSecretWorkload('api', 's')] },
      status: { phase: 'active' },
    })

    stubSecrets({ s: 'owned' })
    await expect(rec.observeSecretOwnership(recipe)).resolves.toEqual({ kind: 'ok', signature: '' })
    stubSecrets({ s: 'shared' })
    await expect(rec.observeSecretOwnership(recipe)).resolves.toEqual({ kind: 'ok', signature: '' })
    stubSecrets({ s: 'foreign' })
    await expect(rec.observeSecretOwnership(recipe)).resolves.toEqual({
      kind: 'ok',
      signature: 'api:s',
    })
    // A 500 classifies as state 'error' (ownership unverified).
    stubSecrets({ s: 'boom' })
    await expect(rec.observeSecretOwnership(recipe)).resolves.toEqual({
      kind: 'error',
      reason: 'unverifiable',
    })
    // readReferencedSecrets itself throwing is a distinct reason.
    const spy = vi
      .spyOn(
        rec as unknown as { readReferencedSecrets: () => Promise<unknown> },
        'readReferencedSecrets'
      )
      .mockRejectedValue(new Error('index exploded'))
    await expect(rec.observeSecretOwnership(recipe)).resolves.toEqual({
      kind: 'error',
      reason: 'read_error',
    })
    spy.mockRestore()

    for (const m of deleteMocks()) expect(m).not.toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('observeSecretOwnership sees includeWhen-excluded workloads and leaves the input untouched', async () => {
    const rec = newReconciler()
    stubSecrets({ s: 'foreign' })
    const recipe = makeRecipe({
      spec: {
        workloads: [
          envSecretWorkload('api', 's', { includeWhen: { param: 'enabled', equals: 'yes' } }),
        ],
      },
      status: { phase: 'active' },
    } as Partial<WorkflowRecipeCRD>)
    const before = JSON.stringify(recipe)
    await expect(rec.observeSecretOwnership(recipe)).resolves.toEqual({
      kind: 'ok',
      signature: 'api:s',
    })
    expect(JSON.stringify(recipe)).toBe(before)
    for (const m of deleteMocks()) expect(m).not.toHaveBeenCalled()
  })

  it('classic gate notes the enforced signature; teardown failure notes repairPending', async () => {
    const rec = newReconciler()
    stubSecrets({ s: 'foreign' })
    const recipe = makeRecipe({
      spec: { workloads: [envSecretWorkload('api', 's')] },
      status: { phase: 'approved' },
    })
    const clean = await rec.reconcile(recipe)
    expect(clean.cadence?.enforcedOwnership).toBe('api:s')
    expect(clean.cadence?.repairPending).toBe(false)

    mockAppsApi.deleteNamespacedDeployment.mockRejectedValue({ code: 500 })
    const failed = await rec.reconcile(recipe)
    expect(failed.cadence?.enforcedOwnership).toBe('api:s')
    expect(failed.cadence?.repairPending).toBe(true)
  })

  it('classic gate on an owned Secret enforces the empty signature', async () => {
    const rec = newReconciler()
    stubSecrets({ s: 'owned' })
    const result = await rec.reconcile(
      makeRecipe({
        spec: { workloads: [envSecretWorkload('api', 's')] },
        status: { phase: 'approved' },
      })
    )
    expect(result.cadence?.enforcedOwnership).toBe('')
  })

  it('an unverifiable Secret requeues without noting an enforced signature', async () => {
    const rec = newReconciler()
    stubSecrets({ s: 'boom' })
    const result = await rec.reconcile(
      makeRecipe({
        spec: { workloads: [envSecretWorkload('api', 's')] },
        status: { phase: 'approved' },
      })
    )
    expect(result.requeueAfterMs).toBeGreaterThan(0)
    expect(result.cadence?.enforcedOwnership).toBeUndefined()
    expect(mockAppsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
  })

  function stubWorkflowReconciler(rec: WorkflowRecipeReconciler, overrides: object = {}) {
    const stub = {
      reconcile: vi
        .fn()
        .mockResolvedValue({ phase: 'active', message: 'ok', workflowPhase: 'running' }),
      validateWorkflowSpec: vi.fn().mockReturnValue(undefined),
      ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
      refreshRuntimeHttpEgressNetworkPolicies: vi.fn().mockResolvedValue({ retryPending: false }),
      ...overrides,
    }
    ;(rec as unknown as { workflowReconciler: unknown }).workflowReconciler = stub
    return stub
  }

  const workflowSpec = (secret: string) => ({
    agent: { provider: 'zai', model: 'glm-4.7' },
    workloads: [envSecretWorkload('qa-api', secret)],
    steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
  })

  it('deployWorkflowWorkloads gate notes the enforced signature', async () => {
    const rec = newReconciler()
    stubWorkflowReconciler(rec)
    stubSecrets({ s: 'foreign' })
    const result = await rec.reconcile(
      makeRecipe({
        spec: workflowSpec('s'),
        status: { phase: 'candidate' },
      } as Partial<WorkflowRecipeCRD>)
    )
    expect(result.cadence?.enforcedOwnership).toBe('qa-api:s')
    expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalled()
  })

  it('deployWorkflowWorkloads teardown failure propagates (a throw is already unsettled)', async () => {
    const rec = newReconciler()
    stubWorkflowReconciler(rec)
    stubSecrets({ s: 'foreign' })
    mockAppsApi.deleteNamespacedDeployment.mockRejectedValue({ code: 500 })
    const result = await rec.reconcile(
      makeRecipe({
        spec: workflowSpec('s'),
        status: { phase: 'candidate' },
      } as Partial<WorkflowRecipeCRD>)
    )
    // Converted to a requeued degraded result, never a settled one.
    expect(result.requeueAfterMs).toBeGreaterThan(0)
  })

  const steadyMeta = {
    name: 'test-recipe',
    namespace: 'sandbox-recipes',
    uid: 'uid-123',
    labels: { 'clerum.io/workflow-run-id': 'run-123' },
  }
  const steadyRecipe = (secret?: string) =>
    makeRecipe({
      metadata: steadyMeta,
      spec: secret
        ? workflowSpec(secret)
        : { agent: { provider: 'zai', model: 'glm-4.7' }, steps: [{ id: 'r', instruction: 'x' }] },
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    } as Partial<WorkflowRecipeCRD>)

  it('steady enforcer notes the denied signature, the owned (empty) one, and the no-refs empty one', async () => {
    const rec = newReconciler()
    stubWorkflowReconciler(rec)

    stubSecrets({ s: 'foreign' })
    const denied = await rec.reconcile(steadyRecipe('s'))
    expect(denied.cadence?.enforcedOwnership).toBe('qa-api:s')
    expect(denied.cadence?.repairPending).toBe(false)
    expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalled()

    stubSecrets({ s: 'owned' })
    const owned = await rec.reconcile(steadyRecipe('s'))
    expect(owned.cadence?.enforcedOwnership).toBe('')

    const noRefs = await rec.reconcile(steadyRecipe())
    expect(noRefs.cadence?.enforcedOwnership).toBe('')
  })

  it('steady enforcer: failed teardown notes repairPending and no enforced signature', async () => {
    const rec = newReconciler()
    stubWorkflowReconciler(rec)
    stubSecrets({ s: 'foreign' })
    mockAppsApi.deleteNamespacedDeployment.mockRejectedValue({ code: 500 })
    const result = await rec.reconcile(steadyRecipe('s'))
    expect(result.requeueAfterMs).toBeGreaterThan(0)
    expect(result.cadence?.repairPending).toBe(true)
    expect(result.cadence?.enforcedOwnership).toBeUndefined()
  })

  it('steady enforcer: unverifiable Secret notes no enforced signature', async () => {
    const rec = newReconciler()
    stubWorkflowReconciler(rec)
    stubSecrets({ s: 'boom' })
    const result = await rec.reconcile(steadyRecipe('s'))
    expect(result.requeueAfterMs).toBeGreaterThan(0)
    expect(result.cadence?.enforcedOwnership).toBeUndefined()
  })

  it('swallowed steady credential repair failure notes repairPending', async () => {
    const rec = newReconciler()
    stubWorkflowReconciler(rec, {
      ensureMcpHostRuntimeCredentials: vi.fn().mockRejectedValue(new Error('mint failed')),
    })
    const result = await rec.reconcile(steadyRecipe())
    expect(result.cadence?.repairPending).toBe(true)
  })

  it('a runtime-HTTP refresh left pending a retry notes repairPending', async () => {
    const rec = newReconciler()
    stubWorkflowReconciler(rec, {
      refreshRuntimeHttpEgressNetworkPolicies: vi.fn().mockResolvedValue({ retryPending: true }),
    })
    const result = await rec.reconcile(steadyRecipe())
    expect(result.cadence?.repairPending).toBe(true)
  })

  it('a healthy steady pass is not repairPending', async () => {
    const rec = newReconciler()
    stubWorkflowReconciler(rec)
    const result = await rec.reconcile(steadyRecipe())
    expect(result.cadence?.repairPending).toBe(false)
  })
})

// ─── T3 egress lane: refreshDnsBlocks (#1016, spec §3.3) ─────────────────────
describe('refreshDnsBlocks egress lane (#1016 §3.3)', () => {
  type Np = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  let store: Map<string, Np>
  const key = (ns: string, name: string) => `${ns}/${name}`
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

  function installStore() {
    store = new Map()
    mockNetworkingApi.readNamespacedNetworkPolicy.mockReset()
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name, namespace }: { name: string; namespace: string }) =>
        store.has(key(namespace, name))
          ? Promise.resolve(clone(store.get(key(namespace, name))))
          : Promise.reject({ code: 404 })
    )
    mockNetworkingApi.createNamespacedNetworkPolicy.mockReset()
    mockNetworkingApi.createNamespacedNetworkPolicy.mockImplementation(
      ({ namespace, body }: { namespace: string; body: Np }) => {
        const stored = clone(body)
        stored.metadata = { ...stored.metadata, namespace, uid: 'np-uid', resourceVersion: '1' }
        store.set(key(namespace, body.metadata.name), stored)
        return Promise.resolve(stored)
      }
    )
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockReset()
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockImplementation(
      ({ name, namespace, body }: { name: string; namespace: string; body: Np }) => {
        const stored = clone(body)
        stored.metadata = { ...stored.metadata, namespace, uid: 'np-uid', resourceVersion: '2' }
        store.set(key(namespace, name), stored)
        return Promise.resolve(stored)
      }
    )
    mockNetworkingApi.deleteNamespacedNetworkPolicy.mockReset()
    mockNetworkingApi.deleteNamespacedNetworkPolicy.mockImplementation(
      ({ name, namespace }: { name: string; namespace: string }) => {
        store.delete(key(namespace, name))
        return Promise.resolve({})
      }
    )
    // Label-selector GC sweeps are out of scope; an empty list keeps them inert.
    mockNetworkingApi.listNamespacedNetworkPolicy.mockReset()
    mockNetworkingApi.listNamespacedNetworkPolicy.mockResolvedValue({ items: [] })
  }

  const clearWrites = () => {
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()
    mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
  }
  const writeCalls = () =>
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls.length +
    mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls.length

  const egressSpec = {
    workloads: [
      { id: 'ui', type: 'deployment', image: 'ui:1', port: 8080 },
      {
        id: 'on',
        type: 'deployment',
        image: 'w:1',
        port: 8080,
        egressBindings: [{ egressClass: 'exact-host', dns: 'on.example.com', port: 443 }],
      },
      {
        id: 'off',
        type: 'deployment',
        image: 'w:1',
        port: 8080,
        includeWhen: '{{inputs.offEnabled}}',
        egressBindings: [{ egressClass: 'exact-host', dns: 'off.example.com', port: 443 }],
      },
    ],
    inputs: { offEnabled: false },
    ui: {
      workloadRef: 'ui',
      port: 8080,
      egress: { external: [{ fqdn: 'current.example.com', port: 443 }] },
    },
  }

  const classicRecipe = (overrides: Partial<WorkflowRecipeCRD> = {}) =>
    makeRecipe({ spec: egressSpec, status: { phase: 'active' }, ...overrides } as never)

  const okLookup = async () => ({
    kind: 'ok' as const,
    ipv4: ['93.184.216.34'],
    ipv6: [],
    ttlSeconds: 300,
  })
  type Lookup = () => Promise<Awaited<ReturnType<typeof okLookup>>>

  function reconcilerWith(lookup: Lookup = okLookup) {
    return new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
      fqdnLookup: lookup,
    } as never)
  }

  /** A reconciler that has recorded one full pass for `recipe`. */
  async function recorded(recipe: WorkflowRecipeCRD, lookup?: Lookup) {
    const rec = reconcilerWith(lookup)
    await rec.reconcile(structuredClone(recipe))
    return rec
  }

  beforeEach(() => {
    process.env.CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED = 'true'
    installStore()
    mockCustomApi.listNamespacedCustomObject.mockReset()
    mockCustomApi.listNamespacedCustomObject.mockResolvedValue({ items: [] })
    mockCustomApi.getNamespacedCustomObject.mockReset()
    mockCustomApi.getNamespacedCustomObject.mockImplementation(({ plural }: { plural?: string }) =>
      plural === 'contexts'
        ? Promise.reject({ code: 404 })
        : Promise.resolve({
            metadata: { uid: 'uid-123', resourceVersion: '1', labels: {} },
            status: {},
            spec: { mcpServers: [] },
          })
    )
  })

  it('returns stale with no writes when nothing was recorded', async () => {
    const rec = newReconciler()
    expect(await rec.refreshDnsBlocks(classicRecipe(), [])).toBe('stale')
    expect(writeCalls()).toBe(0)
  })

  it('returns stale with no writes when the fingerprint no longer matches', async () => {
    const rec = await recorded(classicRecipe())
    clearWrites()
    const changed = classicRecipe({ status: { phase: 'active', message: 'changed' } })
    expect(await rec.refreshDnsBlocks(changed, [])).toBe('stale')
    expect(writeCalls()).toBe(0)
  })

  it('returns none with no writes when the recorded block set is empty', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'dry-run-workflow', namespace: 'sandbox-recipes', uid: 'uid-123' },
      spec: {
        dryRun: true,
        workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }],
        steps: [{ id: 'run', run: { type: 'snippet', language: 'typescript', code: 'return 1' } }],
      },
      status: { phase: 'candidate' },
    } as Partial<WorkflowRecipeCRD>)
    const rec = newReconciler()
    ;(rec as unknown as { workflowReconciler: unknown }).workflowReconciler = {
      reconcile: vi.fn(),
      validateWorkflowSpec: vi.fn().mockReturnValue(undefined),
    }
    await rec.reconcile(structuredClone(recipe))
    expect([...(rec.dnsBlockRecordFor('dry-run-workflow')?.blocks ?? [])]).toEqual([])
    clearWrites()
    expect(await rec.refreshDnsBlocks(recipe, [])).toBe('none')
    expect(writeCalls()).toBe(0)
  })

  it('returns none with no writes when the live recipe is being deleted', async () => {
    const recipe = classicRecipe()
    const rec = await recorded(recipe)
    clearWrites()
    mockCustomApi.getNamespacedCustomObject.mockResolvedValue({
      metadata: { uid: 'uid-123', deletionTimestamp: '2026-01-01T00:00:00Z' },
    })
    expect(await rec.refreshDnsBlocks(recipe, [])).toBe('none')
    expect(writeCalls()).toBe(0)
  })

  it('returns stale with no writes when a policy now rejects the recipe', async () => {
    const recipe = classicRecipe()
    const rec = await recorded(recipe)
    clearWrites()
    const denyUi = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipePolicy',
      metadata: { name: 'deny-ui', namespace: 'sandbox-recipes' },
      spec: { detection: { imageDenylist: ['ui:*'] } },
    } as never
    expect(await rec.refreshDnsBlocks(recipe, [denyUi])).toBe('stale')
    expect(writeCalls()).toBe(0)
  })

  it('skips the policy gate for an already policy-failed recipe, like the full pass', async () => {
    const denyUi = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipePolicy',
      metadata: { name: 'deny-ui', namespace: 'sandbox-recipes' },
      spec: { detection: { imageDenylist: ['ui:*'] } },
    } as never
    const failed = classicRecipe({ status: { phase: 'failed', message: 'Policy violation: x' } })
    const lane = reconcilerWith()
    const { dnsBlockFingerprint } = await import('./dnsBlockFingerprint')
    const internals = lane as unknown as {
      config: never
      dnsBlockRecordMap: Map<string, unknown>
    }
    internals.dnsBlockRecordMap.set('test-recipe', {
      fingerprint: dnsBlockFingerprint(failed, internals.config),
      blocks: new Set(['recipe_egress']),
    })
    expect(await lane.refreshDnsBlocks(failed, [denyUi])).toBe('clean')
  })

  it('applies the includeWhen filter to a clone without mutating the input', async () => {
    const recipe = classicRecipe()
    const rec = await recorded(recipe)
    installStore() // pre-state: no policies
    const snapshot = structuredClone(recipe)
    expect(await rec.refreshDnsBlocks(recipe, [])).toBe('clean')
    expect(recipe).toEqual(snapshot)
    const names = [...store.keys()]
    expect(names).toContain(
      key('sandbox-recipes', rb.workloadEgressPolicyName('test-recipe', 'on'))
    )
    expect(
      names.filter(n => n.endsWith(`/${rb.workloadEgressPolicyName('test-recipe', 'off')}`))
    ).toEqual([])
  })

  it('contracts before it resolves DNS', async () => {
    const order: string[] = []
    const lookup = vi.fn(async () => {
      order.push('lookup')
      return okLookup()
    })
    const recipe = classicRecipe()
    const rec = await recorded(recipe, lookup)
    // Policies exist now, so the contraction has something to read and narrow.
    const inner = mockNetworkingApi.readNamespacedNetworkPolicy.getMockImplementation()!
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation((a: never) => {
      order.push('read')
      return inner(a)
    })
    order.length = 0
    await rec.refreshDnsBlocks(recipe, [])
    expect(order).toContain('lookup')
    expect(order.indexOf('read')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('read')).toBeLessThan(order.indexOf('lookup'))
  })

  it('replays runtime_http_egress with (namespace, name, uid, spec)', async () => {
    const recipe = makeRecipe({
      spec: {
        runtimeEgress: { http: { allowedHosts: ['api.example.com'] } },
        steps: [
          {
            id: 'snippet',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return 1',
              capabilities: { http: { allowedHosts: ['api.example.com'] } },
            },
          },
        ],
      },
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    } as Partial<WorkflowRecipeCRD>)
    const refresh = vi.fn().mockResolvedValue({ conflicts: [], retryPending: false })
    const rec = reconcilerWith()
    ;(rec as unknown as { workflowReconciler: unknown }).workflowReconciler = {
      reconcile: vi.fn(),
      validateWorkflowSpec: vi.fn().mockReturnValue(undefined),
      ensureMcpHostRuntimeCredentials: vi.fn(),
      refreshRuntimeHttpEgressNetworkPolicies: refresh,
    }
    // The mocked WorkflowReconciler notes no blocks, so seed the record a steady pass writes.
    const { dnsBlockFingerprint } = await import('./dnsBlockFingerprint')
    const internals = rec as unknown as {
      config: never
      dnsBlockRecordMap: Map<string, unknown>
    }
    internals.dnsBlockRecordMap.set('test-recipe', {
      fingerprint: dnsBlockFingerprint(recipe, internals.config),
      blocks: new Set(['runtime_http_egress']),
    })
    expect(await rec.refreshDnsBlocks(recipe, [])).toBe('clean')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith(
      'sandbox-recipes',
      'test-recipe',
      'uid-123',
      expect.objectContaining({ runtimeEgress: recipe.spec.runtimeEgress })
    )
    expect(refresh.mock.calls[0]).toHaveLength(4)
  })

  it('throws when the runtime-HTTP refresh reports a policy pending a retry', async () => {
    const recipe = makeRecipe({
      spec: {
        runtimeEgress: { http: { allowedHosts: ['api.example.com'] } },
        steps: [{ id: 's', run: { type: 'snippet', language: 'typescript', code: 'return 1' } }],
      },
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    } as Partial<WorkflowRecipeCRD>)
    const refresh = vi.fn().mockResolvedValue({ conflicts: [], retryPending: true })
    const rec = reconcilerWith()
    ;(rec as unknown as { workflowReconciler: unknown }).workflowReconciler = {
      refreshRuntimeHttpEgressNetworkPolicies: refresh,
    }
    const { dnsBlockFingerprint } = await import('./dnsBlockFingerprint')
    const internals = rec as unknown as {
      config: never
      dnsBlockRecordMap: Map<string, unknown>
    }
    internals.dnsBlockRecordMap.set('test-recipe', {
      fingerprint: dnsBlockFingerprint(recipe, internals.config),
      blocks: new Set(['runtime_http_egress']),
    })
    await expect(rec.refreshDnsBlocks(recipe, [])).rejects.toThrow(
      /test-recipe.*runtime HTTP egress NetworkPolicy.*pending a retry/
    )
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('rethrows a DNS failure after the contraction already applied', async () => {
    const recipe = classicRecipe()
    // Record with a working resolver so policies exist, then fail DNS in the lane.
    let fail = false
    const lookup = vi.fn(async () => {
      if (fail) throw new Error('dns down')
      return okLookup()
    })
    const rec = await recorded(recipe, lookup)
    const uiPolicy = key('sandbox-ui', 'ui-egress-test-recipe')
    expect(store.has(uiPolicy)).toBe(true)
    // Widen the live policy with a stale destination so the contraction must rewrite it.
    store.get(uiPolicy)!.spec.egress.push({
      to: [{ ipBlock: { cidr: '203.0.113.9/32' } }],
      ports: [{ protocol: 'TCP', port: 443 }],
    })
    fail = true
    clearWrites()
    const reads = mockNetworkingApi.readNamespacedNetworkPolicy
    reads.mockClear()
    await expect(rec.refreshDnsBlocks(recipe, [])).rejects.toThrow('dns down')
    expect(reads).toHaveBeenCalled()
    const readOrder = reads.mock.invocationCallOrder[0]
    const lookupOrder = lookup.mock.invocationCallOrder[lookup.mock.invocationCallOrder.length - 1]
    expect(readOrder).toBeLessThan(lookupOrder)
    // The contraction rewrote the live UI policy before the lookup rejected.
    expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalled()
    expect(
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.invocationCallOrder[0]
    ).toBeLessThan(lookupOrder)
  })

  describe('log hygiene (#1016 §3.7)', () => {
    const fakeWorkflowReconciler = () => ({
      reconcile: vi
        .fn()
        .mockResolvedValue({ phase: 'active', message: 'ok', workflowPhase: 'running' }),
      validateWorkflowSpec: vi.fn().mockReturnValue(undefined),
      ensureMcpHostRuntimeCredentials: vi.fn(),
      refreshRuntimeHttpEgressNetworkPolicies: vi.fn(),
    })
    const messages = (mock: { mock: { calls: unknown[][] } }) =>
      mock.mock.calls.map(c => String(c[0]))
    const lane = (mock: { mock: { calls: unknown[][] } }) =>
      mock.mock.calls.filter(c => c[0] === 'Running workflow infrastructure lane')

    function sdkRecipe(phase: string) {
      return makeRecipe({
        spec: {
          ...egressSpec,
          pluginWorkloadSdk: { clientNotifications: {} },
          steps: [
            { id: 'run', run: { type: 'snippet', language: 'typescript', code: 'return 1' } },
          ],
        },
        status: { phase },
      } as unknown as Partial<WorkflowRecipeCRD>)
    }

    it('labels an SDK no-run fall-through pass sdk_eager and drops the first-deployment wording', async () => {
      const { calls, restore } = captureLoggerLevels(['info', 'debug'])
      try {
        const rec = reconcilerWith()
        ;(rec as unknown as { workflowReconciler: unknown }).workflowReconciler =
          fakeWorkflowReconciler()
        await rec.reconcile(sdkRecipe('active'))
        const runs = lane(calls.info)
        expect(runs).toHaveLength(1)
        expect(runs[0][1]).toMatchObject({ reason: 'sdk_eager' })
        expect(messages(calls.info)).not.toContain(
          'Creating workflow infrastructure for first deployment'
        )
      } finally {
        restore()
      }
    })

    it('labels a candidate workflow first_deploy', async () => {
      const { calls, restore } = captureLoggerLevels(['info'])
      try {
        const rec = reconcilerWith()
        ;(rec as unknown as { workflowReconciler: unknown }).workflowReconciler =
          fakeWorkflowReconciler()
        await rec.reconcile(sdkRecipe('candidate'))
        expect(lane(calls.info)[0][1]).toMatchObject({ reason: 'first_deploy' })
      } finally {
        restore()
      }
    })

    it('logs unchanged no-op lines of an unchanged classic recipe at debug, not info', async () => {
      const recipe = classicRecipe()
      const rec = reconcilerWith()
      await rec.reconcile(structuredClone(recipe))
      const { calls, restore } = captureLoggerLevels(['info', 'debug'])
      try {
        await rec.reconcile(structuredClone(recipe))
        const noop = (m: string) => /unchanged|Unchanged/.test(m) && /skipping|no-op/.test(m)
        expect(messages(calls.debug).filter(noop).length).toBeGreaterThan(0)
        expect(messages(calls.info).filter(noop)).toEqual([])
      } finally {
        restore()
      }
    })
  })

  describe('parity with the full pass', () => {
    const egressPolicies = () =>
      Object.fromEntries(
        [...store]
          .filter(([k]) => /\/(ui-egress-|.*-egress)/.test(k))
          .map(([k, v]) => [k, { spec: v.spec, annotations: v.metadata?.annotations }])
      )

    async function parity(recipe: WorkflowRecipeCRD, wire: (r: WorkflowRecipeReconciler) => void) {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
      try {
        installStore()
        const a = reconcilerWith()
        wire(a)
        await a.reconcile(structuredClone(recipe))
        const full = egressPolicies()

        installStore()
        const b = reconcilerWith()
        wire(b)
        await b.reconcile(structuredClone(recipe))
        installStore() // reset to the pre-state
        expect(await b.refreshDnsBlocks(recipe, [])).toBe('clean')
        const lane = egressPolicies()
        expect(Object.keys(full).length).toBeGreaterThan(0)
        expect(lane).toEqual(full)
      } finally {
        vi.useRealTimers()
      }
    }

    it('matches for a classic recipe with external egress', async () => {
      await parity(classicRecipe(), () => {})
    })

    it('matches for an SDK no-run workflow that falls through to deployWorkflowWorkloads', async () => {
      const recipe = makeRecipe({
        spec: {
          ...egressSpec,
          steps: [
            { id: 'run', run: { type: 'snippet', language: 'typescript', code: 'return 1' } },
          ],
        },
        status: { phase: 'candidate' },
      } as Partial<WorkflowRecipeCRD>)
      await parity(recipe, r => {
        ;(r as unknown as { workflowReconciler: unknown }).workflowReconciler = {
          reconcile: vi
            .fn()
            .mockResolvedValue({ phase: 'active', message: 'ok', workflowPhase: 'running' }),
          validateWorkflowSpec: vi.fn().mockReturnValue(undefined),
          ensureMcpHostRuntimeCredentials: vi.fn(),
          refreshRuntimeHttpEgressNetworkPolicies: vi.fn(),
        }
      })
    })
  })
})
