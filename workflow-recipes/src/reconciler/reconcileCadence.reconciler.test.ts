/**
 * Issue #1016 — the DNS-block record a full reconcile writes. Uses the same
 * apiserver doubles as reconciler.test.ts, reduced to what these passes touch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import type { WorkflowRecipeCRD } from '../types'
import { deriveWorkflowRuntimePlan } from '../workflow/runtimePlan'
import { WorkflowReconciler } from '../workflow/workflowReconciler'
import { runInReconcileContext } from './reconcileContext'
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
