import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { WorkflowRecipeReconciler } from '../../../src/reconciler/workflowRecipeReconciler'
import { WorkflowRecipeCRD } from '../../../src/types'
import { INHERITED_PARENT_RESOURCES_ANNOTATION } from '../../../src/workflow/childRecipeFactory'

// ─── Mock K8s client ────────────────────────────────────────────────

const mockAppsApi = {
  createNamespacedDeployment: vi.fn().mockResolvedValue({}),
  readNamespacedDeployment: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
  replaceNamespacedDeployment: vi.fn().mockResolvedValue({}),
  deleteNamespacedDeployment: vi.fn().mockResolvedValue({}),
  createNamespacedStatefulSet: vi.fn().mockResolvedValue({}),
  readNamespacedStatefulSet: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
  replaceNamespacedStatefulSet: vi.fn().mockResolvedValue({}),
  deleteNamespacedStatefulSet: vi.fn().mockResolvedValue({}),
  createNamespacedDaemonSet: vi.fn().mockResolvedValue({}),
  readNamespacedDaemonSet: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
  replaceNamespacedDaemonSet: vi.fn().mockResolvedValue({}),
  deleteNamespacedDaemonSet: vi.fn().mockResolvedValue({}),
}

const mockBatchApi = {
  createNamespacedCronJob: vi.fn().mockResolvedValue({}),
  readNamespacedCronJob: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
  replaceNamespacedCronJob: vi.fn().mockResolvedValue({}),
  deleteNamespacedCronJob: vi.fn().mockResolvedValue({}),
  createNamespacedJob: vi.fn().mockResolvedValue({}),
  readNamespacedJob: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
  replaceNamespacedJob: vi.fn().mockResolvedValue({}),
  deleteNamespacedJob: vi.fn().mockResolvedValue({}),
}

const mockCoreApi = {
  createNamespacedService: vi.fn().mockResolvedValue({}),
  readNamespacedService: vi
    .fn()
    .mockResolvedValue({ metadata: { resourceVersion: '1' }, spec: { clusterIP: '10.0.0.1' } }),
  replaceNamespacedService: vi.fn().mockResolvedValue({}),
  deleteNamespacedService: vi.fn().mockResolvedValue({}),
  createNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
  readNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({
    metadata: {
      labels: {
        app: 'data',
        'clerum.io/managed-by': 'workflow-recipes',
        'clerum.io/recipe': 'normal-recipe',
        'clerum.io/resource': 'data',
      },
    },
  }),
  deleteNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
  createNamespacedSecret: vi.fn().mockResolvedValue({}),
  readNamespacedSecret: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
  replaceNamespacedSecret: vi.fn().mockResolvedValue({}),
  deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
  createNamespacedConfigMap: vi.fn().mockResolvedValue({}),
  readNamespacedConfigMap: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
  replaceNamespacedConfigMap: vi.fn().mockResolvedValue({}),
  deleteNamespacedConfigMap: vi.fn().mockResolvedValue({}),
}

const mockCustomApi = {
  createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  getNamespacedCustomObject: vi
    .fn()
    .mockResolvedValue({ metadata: { resourceVersion: '1', annotations: {} }, spec: {} }),
  listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
  replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
  deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
}

const mockNetworkingApi = {
  createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
  readNamespacedNetworkPolicy: vi.fn().mockRejectedValue({ code: 404 }),
  replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
  deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
  listNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ items: [] }),
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

describe('Workflow Reconciler Bifurcation', () => {
  let reconciler: WorkflowRecipeReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '1', generation: 1 },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
    })
    mockAppsApi.readNamespacedStatefulSet.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      spec: { replicas: 1 },
      status: { readyReplicas: 1 },
    })
    mockAppsApi.readNamespacedDaemonSet.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      status: { desiredNumberScheduled: 1, numberReady: 1 },
    })
    mockBatchApi.readNamespacedCronJob.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      spec: { suspend: false },
    })
    mockBatchApi.readNamespacedJob.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      spec: { completions: 1 },
      status: { succeeded: 1 },
    })
    mockCustomApi.getNamespacedCustomObject.mockResolvedValue({
      metadata: { resourceVersion: '1', annotations: {} },
      spec: {},
    })
    const kc = new k8s.KubeConfig()
    reconciler = new WorkflowRecipeReconciler(kc)
  })

  it('delegates to workflowReconciler when spec.steps is present', async () => {
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'wf-test', namespace: 'sandbox-recipes', uid: 'uid-wf-1' },
      spec: {
        workloads: [],
        agent: { model: 'gpt-4o', provider: 'openai' },
        steps: [{ id: 'step-1', instruction: 'Do something' }],
      },
      status: { phase: 'approved' },
    }

    // Without initializing workflow, should return failed
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('failed')
    expect(result.message).toContain('Workflow subsystem not initialized')
  })

  it('continues with workload path when spec.steps is absent', async () => {
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'normal-recipe', namespace: 'sandbox-recipes', uid: 'uid-normal' },
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine' }],
      },
      status: { phase: 'approved' },
    }

    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('active')
    expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalled()
  })

  it('accepts a pre-existing recipe PVC only when its WRC ownership labels match', async () => {
    mockCoreApi.createNamespacedPersistentVolumeClaim.mockRejectedValueOnce({ code: 409 })
    mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValueOnce({
      metadata: {
        labels: {
          app: 'data',
          'clerum.io/managed-by': 'workflow-recipes',
          'clerum.io/recipe': 'normal-recipe',
          'clerum.io/resource': 'data',
        },
      },
    })
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'normal-recipe', namespace: 'sandbox-recipes', uid: 'uid-normal' },
      spec: {
        resources: [{ id: 'data', type: 'pvc', size: '1Gi' }],
        workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine' }],
      },
      status: { phase: 'approved' },
    }

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('active')
    // PVC read/ownership check targets the recipe-scoped physical name (issue #571).
    expect(mockCoreApi.readNamespacedPersistentVolumeClaim).toHaveBeenCalledWith({
      name: expect.stringMatching(/^normal-recipe-data-[a-f0-9]{12}$/),
      namespace: 'sandbox-recipes',
    })
    expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalled()
  })

  it('rejects a pre-existing recipe PVC that is already deleting', async () => {
    mockCoreApi.createNamespacedPersistentVolumeClaim.mockRejectedValueOnce({ code: 409 })
    mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValueOnce({
      metadata: {
        deletionTimestamp: '2026-05-24T00:00:00Z',
        labels: {
          app: 'data',
          'clerum.io/managed-by': 'workflow-recipes',
          'clerum.io/recipe': 'normal-recipe',
          'clerum.io/resource': 'data',
        },
      },
    })
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'normal-recipe', namespace: 'sandbox-recipes', uid: 'uid-normal' },
      spec: {
        resources: [{ id: 'data', type: 'pvc', size: '1Gi' }],
        workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine' }],
      },
      status: { phase: 'approved' },
    }

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toMatch(/Existing PVC "normal-recipe-data-[a-f0-9]{12}"/)
    expect(result.message).toContain('is deleting')
    expect(result.message).toContain('refusing to mount it')
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('rejects a pre-existing recipe PVC without matching WRC ownership labels', async () => {
    mockCoreApi.createNamespacedPersistentVolumeClaim.mockRejectedValueOnce({ code: 409 })
    mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValueOnce({
      metadata: {
        labels: {
          app: 'data',
        },
      },
    })
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'normal-recipe', namespace: 'sandbox-recipes', uid: 'uid-normal' },
      spec: {
        resources: [{ id: 'data', type: 'pvc', size: '1Gi' }],
        workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine' }],
      },
      status: { phase: 'approved' },
    }

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toMatch(/Existing PVC "normal-recipe-data-[a-f0-9]{12}"/)
    expect(result.message).toContain('refusing to mount a possibly external claim')
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('adopts a pre-existing raw PVC owned by this recipe into status.resourceInstances (issue #571 F1)', async () => {
    // default readNamespacedPersistentVolumeClaim is labeled clerum.io/recipe=normal-recipe
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'normal-recipe', namespace: 'sandbox-recipes', uid: 'uid-normal' },
      spec: {
        resources: [{ id: 'data', type: 'pvc', size: '1Gi' }],
        workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine' }],
      },
      status: { phase: 'active' }, // legacy phase → adoption eligible
    }

    await reconciler.reconcile(recipe)

    expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({ body: { status: { resourceInstances: { data: 'data' } } } }),
      expect.anything()
    )
  })

  it('does NOT adopt a raw PVC owned by another recipe — uses a scoped name (issue #571 F1)', async () => {
    mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
      metadata: {
        labels: { 'clerum.io/recipe': 'some-other-recipe', 'clerum.io/resource': 'data' },
      },
    })
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'normal-recipe', namespace: 'sandbox-recipes', uid: 'uid-normal' },
      spec: {
        resources: [{ id: 'data', type: 'pvc', size: '1Gi' }],
        workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine' }],
      },
      status: { phase: 'active' },
    }

    await reconciler.reconcile(recipe)

    expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          status: {
            resourceInstances: {
              data: expect.stringMatching(/^normal-recipe-data-[a-f0-9]{12}$/),
            },
          },
        },
      }),
      expect.anything()
    )
  })

  it('refuses to overwrite a Secret owned by another recipe (issue #571 F1b)', async () => {
    mockCoreApi.createNamespacedSecret.mockRejectedValueOnce({ code: 409 })
    mockCoreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { resourceVersion: '1', labels: { 'clerum.io/recipe': 'some-other-recipe' } },
    })
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'normal-recipe', namespace: 'sandbox-recipes', uid: 'uid-normal' },
      spec: {
        resources: [{ id: 'creds', type: 'secret', data: { k: 'v' } }],
        workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine' }],
      },
      status: { phase: 'approved' },
    }

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('not owned by WorkflowRecipe "normal-recipe"')
    expect(mockCoreApi.replaceNamespacedSecret).not.toHaveBeenCalled()
  })

  it('refuses to inherit a generateKeys Secret owned by another recipe on 409 (issue #571 S3)', async () => {
    mockCoreApi.createNamespacedSecret.mockRejectedValueOnce({ code: 409 })
    mockCoreApi.readNamespacedSecret.mockResolvedValueOnce({
      metadata: { resourceVersion: '1', labels: { 'clerum.io/recipe': 'some-other-recipe' } },
    })
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'normal-recipe', namespace: 'sandbox-recipes', uid: 'uid-normal' },
      spec: {
        resources: [{ id: 'gen-creds', type: 'secret', generateKeys: ['token'] }],
        workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine' }],
      },
      status: { phase: 'approved' },
    }

    const result = await reconciler.reconcile(recipe)

    // The generateKeys create-only path must verify ownership on 409 instead of
    // silently inheriting a foreign Secret.
    expect(result.phase).toBe('failed')
    expect(result.message).toContain('not owned by WorkflowRecipe "normal-recipe"')
  })

  it('rejects prepareVolumeOwnership without a non-root target UID', async () => {
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'normal-recipe', namespace: 'sandbox-recipes', uid: 'uid-normal' },
      spec: {
        workloads: [
          {
            id: 'mongodb',
            type: 'deployment',
            image: 'mongodb/mongodb-community-server:7.0-ubi8',
            security: { prepareVolumeOwnership: true },
            volumeMounts: [{ name: 'data', mountPath: '/data/db' }],
          },
        ],
      },
      status: { phase: 'approved' },
    }

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('security.prepareVolumeOwnership requires security.runAsUser')
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('rejects prepareVolumeOwnership without a writable volume mount', async () => {
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'normal-recipe', namespace: 'sandbox-recipes', uid: 'uid-normal' },
      spec: {
        workloads: [
          {
            id: 'mongodb',
            type: 'deployment',
            image: 'mongodb/mongodb-community-server:7.0-ubi8',
            security: { runAsUser: 1000, prepareVolumeOwnership: true },
            volumeMounts: [{ name: 'data', mountPath: '/data/db', readOnly: true }],
          },
        ],
      },
      status: { phase: 'approved' },
    }

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain(
      'security.prepareVolumeOwnership requires at least one writable volumeMount'
    )
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('accepts recipes with steps but no workloads (workflow-only)', async () => {
    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'wf-only', namespace: 'sandbox-recipes', uid: 'uid-wf-only' },
      spec: {
        workloads: [],
        agent: { model: 'gpt-4o', provider: 'openai' },
        steps: [{ id: 'analyze', instruction: 'Analyze the data' }],
      },
    }

    // Will fail because workflow not initialized, but should NOT fail with "at least one workload"
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('failed')
    expect(result.message).not.toContain('at least one workload')
  })

  it('keeps active parent workflow trigger infrastructure steady without inner reconcile', async () => {
    const innerReconcile = vi.fn()
    const validateWorkflowSpec = vi.fn()
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof innerReconcile
          validateWorkflowSpec: typeof validateWorkflowSpec
        }
      }
    ).workflowReconciler = { reconcile: innerReconcile, validateWorkflowSpec }

    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: {
        name: 'parent-scheduled-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-parent-scheduled',
        labels: {},
      },
      spec: {
        steps: [{ id: 'report', instruction: 'summarize the scheduled report' }],
      },
      status: { phase: 'active' },
    }

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow trigger infrastructure registered',
      skipStatusPatch: true,
    })
    // The steady short-circuit still runs semantic preflight before deciding
    // whether coordinator GFS egress is eligible; only the inner reconcile is skipped.
    expect(validateWorkflowSpec).toHaveBeenCalledTimes(1)
    expect(innerReconcile).not.toHaveBeenCalled()
  })

  it('passes declared resources and runtime egress to the workflow reconciler', async () => {
    const innerReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'workflow runtime created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof innerReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: innerReconcile, validateWorkflowSpec: () => undefined }

    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'wf-snippet', namespace: 'sandbox-recipes', uid: 'uid-wf-snippet' },
      spec: {
        workloads: [],
        resources: [{ id: 'pg-auth', type: 'secret', data: { password: 'redacted' } }],
        runtimeEgress: { http: { allowedHosts: ['api.example.com'] } },
        steps: [
          {
            id: 'query-postgres',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return { ok: true }',
              capabilities: {
                secrets: [{ alias: 'pg', secretRef: { name: 'pg-auth', key: 'password' } }],
              },
            },
          },
        ],
      },
      status: { phase: 'approved' },
    }

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('deploying')
    expect(innerReconcile).toHaveBeenCalledTimes(1)
    const delegatedSpec = innerReconcile.mock.calls[0]?.[3]
    expect(delegatedSpec).toMatchObject({
      resources: recipe.spec.resources,
      runtimeEgress: recipe.spec.runtimeEgress,
    })
  })

  it('creates workflow resources before workload and runtime pods', async () => {
    const callOrder: string[] = []
    mockCoreApi.createNamespacedSecret.mockImplementationOnce(async () => {
      callOrder.push('secret')
      return {}
    })
    mockAppsApi.createNamespacedStatefulSet.mockImplementationOnce(async () => {
      callOrder.push('statefulset')
      return {}
    })
    const innerReconcile = vi.fn().mockImplementation(async () => {
      callOrder.push('runtime')
      return {
        phase: 'deploying',
        message: 'workflow runtime created',
        workflowPhase: 'initializing',
      }
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof innerReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: innerReconcile, validateWorkflowSpec: () => undefined }

    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'wf-db', namespace: 'sandbox-recipes', uid: 'uid-wf-db' },
      spec: {
        workloads: [
          {
            id: 'postgres',
            type: 'statefulset',
            image: 'postgres:16-alpine',
            port: 5432,
            env: [{ name: 'POSTGRES_PASSWORD', value: '{{pg-auth:password}}' }],
          },
        ],
        resources: [{ id: 'pg-auth', type: 'secret', data: { password: 'redacted' } }],
        steps: [
          {
            id: 'query-postgres',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return { ok: true }',
              capabilities: {
                secrets: [{ alias: 'pg', secretRef: { name: 'pg-auth', key: 'password' } }],
                postgres: { access: 'read', workloads: ['postgres'] },
              },
            },
          },
        ],
      },
      status: { phase: 'approved' },
    }

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('deploying')
    expect(callOrder).toEqual(['secret', 'statefulset', 'runtime'])
    const statefulSet = mockAppsApi.createNamespacedStatefulSet.mock.calls[0]?.[0].body
    expect(statefulSet.spec.template.spec.containers[0].env).toContainEqual({
      name: 'POSTGRES_PASSWORD',
      value: 'redacted',
    })
  })

  it('uses inherited child resources for templates without re-creating parent-owned resources', async () => {
    const verifyWorkflowRunProvenance = vi.fn().mockResolvedValue('verified')
    reconciler = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
      verifyWorkflowRunProvenance,
    })
    const callOrder: string[] = []
    mockCoreApi.createNamespacedSecret.mockImplementationOnce(async () => {
      callOrder.push('secret')
      return {}
    })
    mockAppsApi.createNamespacedStatefulSet.mockImplementationOnce(async () => {
      callOrder.push('statefulset')
      return {}
    })
    const innerReconcile = vi.fn().mockImplementation(async () => {
      callOrder.push('runtime')
      return {
        phase: 'deploying',
        message: 'workflow runtime created',
        workflowPhase: 'initializing',
      }
    })
    mockCustomApi.getNamespacedCustomObject.mockImplementation(async ({ name }) => {
      if (name === 'wf-db') {
        return { metadata: { uid: 'uid-wf-db', resourceVersion: '1', annotations: {} }, spec: {} }
      }
      return {
        metadata: { uid: 'uid-wf-db-run', resourceVersion: '1', annotations: {} },
        spec: {},
      }
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof innerReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: innerReconcile, validateWorkflowSpec: () => undefined }

    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: {
        name: 'wf-db-run-00000000',
        namespace: 'sandbox-recipes',
        uid: 'uid-wf-db-run',
        labels: {
          'clerum.io/parent-recipe': 'wf-db',
          'clerum.io/workflow-run-id': '00000000-0000-4000-8000-000000000123',
        },
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        ownerReferences: [
          {
            apiVersion: 'clerum.io/v1alpha1',
            kind: 'WorkflowRecipe',
            name: 'wf-db',
            uid: 'uid-wf-db',
            controller: true,
            blockOwnerDeletion: true,
          },
        ],
      },
      spec: {
        workloads: [
          {
            id: 'postgres',
            type: 'statefulset',
            image: 'postgres:16-alpine',
            port: 5432,
            env: [{ name: 'POSTGRES_PASSWORD', value: '{{pg-auth:password}}' }],
          },
        ],
        resources: [{ id: 'pg-auth', type: 'secret', data: { password: 'redacted' } }],
        steps: [
          {
            id: 'query-postgres',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return { ok: true }',
              capabilities: {
                secrets: [{ alias: 'pg', secretRef: { name: 'pg-auth', key: 'password' } }],
                postgres: { access: 'read', workloads: ['postgres'] },
              },
            },
          },
        ],
      },
      status: { phase: 'approved' },
    }

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('deploying')
    expect(verifyWorkflowRunProvenance).toHaveBeenCalledWith({
      runId: '00000000-0000-4000-8000-000000000123',
      parentNamespace: 'sandbox-recipes',
      parentName: 'wf-db',
      childNamespace: 'sandbox-recipes',
      childName: 'wf-db-run-00000000',
    })
    expect(callOrder).toEqual(['statefulset', 'runtime'])
    expect(mockCoreApi.createNamespacedSecret).not.toHaveBeenCalled()
    const statefulSet = mockAppsApi.createNamespacedStatefulSet.mock.calls[0]?.[0].body
    expect(statefulSet.spec.template.spec.containers[0].env).toContainEqual({
      name: 'POSTGRES_PASSWORD',
      value: 'redacted',
    })
  })

  it('does not honor inherited-resource annotations without a controller ownerReference', async () => {
    const innerReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'workflow runtime created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof innerReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: innerReconcile, validateWorkflowSpec: () => undefined }

    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: {
        name: 'forged-child',
        namespace: 'sandbox-recipes',
        uid: 'uid-forged-child',
        labels: { 'clerum.io/parent-recipe': 'wf-db' },
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
      },
      spec: {
        workloads: [],
        resources: [{ id: 'api-key', type: 'secret', data: { token: 'redacted' } }],
        steps: [
          {
            id: 'fetch',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return { ok: true }',
              capabilities: {
                secrets: [{ alias: 'api', secretRef: { name: 'api-key', key: 'token' } }],
              },
            },
          },
        ],
      },
      status: { phase: 'approved' },
    }

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('deploying')
    expect(mockCoreApi.createNamespacedSecret).toHaveBeenCalled()
  })

  it('assigns workflow workload instances before semantic preflight without creating resources on failure', async () => {
    const validateWorkflowSpec = vi
      .fn()
      .mockReturnValue('snippet postgres capability must declare access')
    const innerReconcile = vi.fn()
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof innerReconcile
          validateWorkflowSpec: typeof validateWorkflowSpec
        }
      }
    ).workflowReconciler = { reconcile: innerReconcile, validateWorkflowSpec }

    const recipe: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'wf-invalid', namespace: 'sandbox-recipes', uid: 'uid-wf-invalid' },
      spec: {
        workloads: [
          {
            id: 'postgres',
            type: 'statefulset',
            image: 'postgres:16-alpine',
            port: 5432,
          },
        ],
        resources: [{ id: 'pg-auth', type: 'secret', data: { password: 'redacted' } }],
        steps: [
          {
            id: 'query-postgres',
            run: {
              type: 'snippet',
              language: 'typescript',
              code: 'return { ok: true }',
              capabilities: {
                postgres: { workloads: ['postgres'] },
              },
            },
          },
        ],
      },
      status: { phase: 'approved' },
    }

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toBe('snippet postgres capability must declare access')
    // Preflight runs once before GFS policy eligibility and again after instance
    // assignment, when runtime Service names reflect the persisted mapping.
    expect(validateWorkflowSpec).toHaveBeenCalledTimes(2)
    expect(innerReconcile).not.toHaveBeenCalled()
    // Two status patches reserve the name maps before preflight: workload
    // instances and resource instances (issue #571). Neither creates real K8s
    // resources when preflight fails.
    expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(2)
    expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          status: {
            workloadInstances: expect.objectContaining({
              postgres: expect.stringMatching(/^wf-invalid-postgres-[a-f0-9]{8}$/),
            }),
          },
        },
      }),
      expect.anything()
    )
    expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          status: {
            resourceInstances: expect.objectContaining({
              'pg-auth': expect.stringMatching(/^wf-invalid-pg-auth-[a-f0-9]{12}$/),
            }),
          },
        },
      }),
      expect.anything()
    )
    expect(mockCoreApi.createNamespacedSecret).not.toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedStatefulSet).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedService).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedConfigMap).not.toHaveBeenCalled()
  })
})
