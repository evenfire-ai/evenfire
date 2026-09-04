import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { loadAll } from 'js-yaml'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EVENFIRE_REGISTRY_PULL_SECRET_NAME } from '@clerum/workflow-runtime-core'
import { loadConfig } from '../config'
import { shouldPatchRecipeStatus } from '../k8sClient'
import { CronJobDef, WorkflowRecipeCRD, WorkflowRecipeGfsIntentSpec, WorkloadDef } from '../types'
import { INHERITED_PARENT_RESOURCES_ANNOTATION } from '../workflow/childRecipeFactory'
import { buildCoordinatorGfsNetworkPolicy } from '../workflow/networkPolicyFactory'
import { isRetryableInfraError } from './k8sErrors'
import type { NetworkPolicyFamily } from './networkPolicyConvergence'
import * as brokerIssuer from './oauthBrokerTokenIssuerClient'
import { PLUGIN_WORKLOAD_SDK_PROVIDER_UNAVAILABLE_CONDITION_TYPE } from './pluginWorkloadSdkValidator'
import {
  resolveResourceName,
  resolveScopedStatefulSetResourceName,
  resolveScopedWorkloadResourceName,
  resolveWorkloadRuntimeResourceName,
} from './resourceBuilder'
import {
  TRANSIENT_REQUEUE_BASE_MS,
  WORKFLOW_PROGRESS_REQUEUE_BASE_MS,
  WorkflowRecipeReconciler,
} from './workflowRecipeReconciler'

// ─── Mock K8s client ────────────────────────────────────────────────

const mockAppsApi = {
  createNamespacedDeployment: vi.fn().mockResolvedValue({}),
  readNamespacedDeployment: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
  replaceNamespacedDeployment: vi.fn().mockResolvedValue({}),
  deleteNamespacedDeployment: vi.fn().mockResolvedValue({}),
  createNamespacedStatefulSet: vi.fn().mockResolvedValue({}),
  readNamespacedStatefulSet: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
  patchNamespacedStatefulSet: vi.fn().mockResolvedValue({}),
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
  deleteCollectionNamespacedService: vi.fn().mockResolvedValue({}),
  createNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
  readNamespacedPersistentVolumeClaim: vi.fn().mockRejectedValue({ code: 404 }),
  deleteNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
  deleteCollectionNamespacedPod: vi.fn().mockResolvedValue({}),
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
  getNamespacedCustomObject: vi.fn().mockResolvedValue({
    metadata: {
      resourceVersion: '1',
      annotations: { 'clerum.io/network-ready': 'true' },
      labels: { 'clerum.io/recipe': 'test-recipe' },
    },
    status: {
      conditions: [{ type: 'ExternalEgressReady', status: 'True' }],
    },
    spec: { mcpServers: [] },
  }),
  listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
  replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
  deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  deleteCollectionNamespacedCustomObject: vi.fn().mockResolvedValue({}),
}

const mockNetworkingApi = {
  createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
  readNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
  replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
  listNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ items: [] }),
  deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
  deleteCollectionNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
}

const mockVerifyWorkflowRunProvenance = vi.fn().mockResolvedValue('verified')

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

function workflowRecipeOwnerRef(name = 'parent-recipe') {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    name,
    uid: `uid-${name}`,
    controller: true,
    blockOwnerDeletion: true,
  }
}

function liveWorkflowRecipeUid(name?: string): string | undefined {
  if (name === 'test-recipe') return 'uid-123'
  if (name === 'child-run') return 'uid-child'
  if (name === 'parent-recipe') return 'uid-parent-recipe'
  return undefined
}

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

function snippetRun(code = 'return { ok: true }') {
  return { type: 'snippet' as const, language: 'typescript' as const, code }
}

describe('WorkflowRecipeReconciler', () => {
  let reconciler: WorkflowRecipeReconciler

  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyWorkflowRunProvenance.mockResolvedValue('verified')
    process.env.CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED = 'true'
    mockAppsApi.readNamespacedDeployment.mockReset()
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '1', generation: 1 },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
    })
    mockAppsApi.readNamespacedStatefulSet.mockReset()
    mockAppsApi.readNamespacedStatefulSet.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      spec: { replicas: 1 },
      status: { readyReplicas: 1 },
    })
    mockAppsApi.patchNamespacedStatefulSet.mockReset()
    mockAppsApi.patchNamespacedStatefulSet.mockResolvedValue({})
    mockAppsApi.readNamespacedDaemonSet.mockReset()
    mockAppsApi.readNamespacedDaemonSet.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      status: { desiredNumberScheduled: 1, numberReady: 1 },
    })
    mockBatchApi.readNamespacedCronJob.mockReset()
    mockBatchApi.readNamespacedCronJob.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      spec: { suspend: false },
    })
    mockBatchApi.readNamespacedJob.mockReset()
    mockBatchApi.readNamespacedJob.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      spec: { completions: 1 },
      status: { succeeded: 1 },
    })
    mockCoreApi.readNamespacedPersistentVolumeClaim.mockReset()
    mockCoreApi.readNamespacedPersistentVolumeClaim.mockRejectedValue({ code: 404 })
    mockCustomApi.createNamespacedCustomObject.mockReset()
    mockCustomApi.createNamespacedCustomObject.mockResolvedValue({})
    mockCustomApi.replaceNamespacedCustomObject.mockReset()
    mockCustomApi.replaceNamespacedCustomObject.mockResolvedValue({})
    mockCustomApi.getNamespacedCustomObject.mockReset()
    mockCustomApi.getNamespacedCustomObject.mockImplementation(({ name }: { name?: string }) =>
      Promise.resolve({
        metadata: {
          uid: liveWorkflowRecipeUid(name),
          resourceVersion: '1',
          annotations: { 'clerum.io/network-ready': 'true' },
          labels: { 'clerum.io/recipe': 'test-recipe' },
        },
        status: {
          conditions: [{ type: 'ExternalEgressReady', status: 'True' }],
        },
        spec: { mcpServers: [] },
      })
    )
    mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()
    mockNetworkingApi.createNamespacedNetworkPolicy.mockReset()
    mockNetworkingApi.createNamespacedNetworkPolicy.mockResolvedValue({})
    mockNetworkingApi.readNamespacedNetworkPolicy.mockReset()
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name }: { name: string }) => {
        if (!name.endsWith('-coordinator-to-gfs')) return Promise.reject({ code: 404 })
        return Promise.resolve({
          metadata: {
            name,
            uid: `uid-${name}`,
            resourceVersion: '1',
            labels: {
              'clerum.io/managed-by': 'wrc',
              'clerum.io/recipe': name.replace(/-coordinator-to-gfs$/, ''),
            },
          },
        })
      }
    )
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockReset()
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockResolvedValue({})
    mockNetworkingApi.deleteNamespacedNetworkPolicy.mockReset()
    mockNetworkingApi.deleteNamespacedNetworkPolicy.mockResolvedValue({})
    mockNetworkingApi.listNamespacedNetworkPolicy.mockReset()
    mockNetworkingApi.listNamespacedNetworkPolicy.mockResolvedValue({ items: [] })
    const kc = new k8s.KubeConfig()
    reconciler = new WorkflowRecipeReconciler(kc, undefined, {
      verifyWorkflowRunProvenance: mockVerifyWorkflowRunProvenance,
    })
  })

  // ─── Pipeline Tests ─────────────────────────────────────────────

  it('processes full pipeline successfully (3.11a)', async () => {
    const result = await reconciler.reconcile(makeRecipe())
    expect(result.phase).toBe('active')
    expect(result.workloadStatuses).toHaveLength(1)
    expect(result.workloadStatuses[0].ready).toBe(true)
  })

  it('uses the SDK-only runtime adapter without invoking workflow reconciliation', async () => {
    const reconcilePluginWorkloadSdkOnly = vi.fn().mockResolvedValue({
      phase: 'active',
      message: 'Plugin Workload SDK mcp-host registered',
      pluginWorkloadSdkBootstrapProof: {
        ready: true,
        contractVersion: 2,
        podUid: 'sdk-pod-uid',
        provider: 'zai',
        model: 'glm-4.7',
        policyReady: true,
        verifiedAt: '2026-08-04T00:00:00.000Z',
      },
    })
    const workflowReconcile = vi.fn()
    const setCodexReconcileContext = vi.fn()
    ;(
      reconciler as unknown as {
        config: { pluginWorkloadSdkEnabled: boolean }
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
          setCodexReconcileContext: typeof setCodexReconcileContext
        }
      }
    ).config.pluginWorkloadSdkEnabled = true
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
          setCodexReconcileContext: typeof setCodexReconcileContext
        }
      }
    ).workflowReconciler = {
      reconcile: workflowReconcile,
      reconcilePluginWorkloadSdkOnly,
      setCodexReconcileContext,
    }

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 }],
        pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('active')
    expect(setCodexReconcileContext).toHaveBeenCalledWith(
      expect.objectContaining({
        recipeName: 'test-recipe',
        runtimeScopeRecipeName: 'test-recipe',
      })
    )
    expect(reconcilePluginWorkloadSdkOnly).toHaveBeenCalledWith(
      'test-recipe',
      'uid-123',
      'sandbox-recipes',
      recipe.spec,
      'test-recipe'
    )
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('never settles promptBridge active when the SDK adapter omits bootstrap proof', async () => {
    const reconcilePluginWorkloadSdkOnly = vi.fn().mockResolvedValue({
      phase: 'active',
      message: 'Plugin Workload SDK mcp-host registered',
    })
    ;(
      reconciler as unknown as {
        config: { pluginWorkloadSdkEnabled: boolean }
        workflowReconciler: {
          reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
        }
      }
    ).config.pluginWorkloadSdkEnabled = true
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
        }
      }
    ).workflowReconciler = { reconcilePluginWorkloadSdkOnly }

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 }],
          pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
        },
      })
    )

    expect(result).toMatchObject({
      phase: 'deploying',
      message: 'Plugin Workload SDK bootstrap identity proof pending',
      requeueAfterMs: TRANSIENT_REQUEUE_BASE_MS,
      requeueFixedInterval: true,
    })
  })

  it('keeps an SDK-only recipe deploying and requeues while the eager host boots', async () => {
    const reconcilePluginWorkloadSdkOnly = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Plugin Workload SDK mcp-host starting',
    })
    ;(
      reconciler as unknown as {
        config: { pluginWorkloadSdkEnabled: boolean }
        workflowReconciler: {
          reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
        }
      }
    ).config.pluginWorkloadSdkEnabled = true
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
        }
      }
    ).workflowReconciler = { reconcilePluginWorkloadSdkOnly }

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 }],
          pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
        },
      })
    )

    expect(result).toMatchObject({
      phase: 'deploying',
      message: 'Plugin Workload SDK mcp-host starting',
      requeueAfterMs: TRANSIENT_REQUEUE_BASE_MS,
      requeueFixedInterval: true,
    })
  })

  it('cleans SDK-only runtime resources after the capability is removed without invoking workflow reconciliation', async () => {
    const cleanupPluginWorkloadSdk = vi.fn().mockResolvedValue(undefined)
    const workflowReconcile = vi.fn()
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          cleanupPluginWorkloadSdk: typeof cleanupPluginWorkloadSdk
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, cleanupPluginWorkloadSdk }

    const result = await reconciler.reconcile(
      makeRecipe({
        status: {
          phase: 'active',
          pluginWorkloadSdk: { state: 'validated', promptBridge: true, clientNotifications: false },
        },
      })
    )

    expect(result.phase).toBe('active')
    expect(cleanupPluginWorkloadSdk).toHaveBeenCalledWith('test-recipe', {
      preserveWorkflowRuntime: false,
    })
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it.each(['failed', 'deprecated', 'rollback-failed'] as const)(
    'cleans a removed SDK capability even when the recipe is already %s',
    async phase => {
      const cleanupPluginWorkloadSdk = vi.fn().mockResolvedValue(undefined)
      ;(
        reconciler as unknown as {
          workflowReconciler: { cleanupPluginWorkloadSdk: typeof cleanupPluginWorkloadSdk }
        }
      ).workflowReconciler = { cleanupPluginWorkloadSdk }

      const result = await reconciler.reconcile(
        makeRecipe({
          status: {
            phase,
            pluginWorkloadSdk: {
              state: 'validated',
              promptBridge: true,
              clientNotifications: false,
            },
          },
        })
      )

      expect(result.phase).toBe(phase)
      expect(cleanupPluginWorkloadSdk).toHaveBeenCalledWith('test-recipe', {
        preserveWorkflowRuntime: false,
      })
    }
  )

  it('tears down an existing SDK-only host when the global feature flag is disabled', async () => {
    const cleanupPluginWorkloadSdk = vi.fn().mockResolvedValue(undefined)
    const workflowReconcile = vi.fn()
    ;(
      reconciler as unknown as {
        config: { pluginWorkloadSdkEnabled: boolean }
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          cleanupPluginWorkloadSdk: typeof cleanupPluginWorkloadSdk
        }
      }
    ).config.pluginWorkloadSdkEnabled = false
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          cleanupPluginWorkloadSdk: typeof cleanupPluginWorkloadSdk
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, cleanupPluginWorkloadSdk }

    const result = await reconciler.reconcile(
      makeRecipe({
        status: {
          phase: 'active',
          pluginWorkloadSdk: { state: 'validated', promptBridge: true, clientNotifications: false },
        },
        spec: {
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 }],
          pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
        },
      })
    )

    expect(result).toMatchObject({
      phase: 'active',
      pluginWorkloadSdkTeardownConfirmed: true,
      message: 'Plugin Workload SDK disabled after confirmed teardown',
    })
    expect(cleanupPluginWorkloadSdk).toHaveBeenCalledWith('test-recipe', {
      preserveWorkflowRuntime: false,
    })
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('degrades an active recipe when observed child Deployment readiness drifts', async () => {
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '1', generation: 1 },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 0, availableReplicas: 0 },
    })

    const result = await reconciler.reconcile(
      makeRecipe({
        status: {
          phase: 'active',
          message: 'All workloads deployed',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.message).toBe('Some workloads not ready')
    expect(result.workloadStatuses).toEqual([
      {
        id: 'app',
        phase: 'degraded',
        ready: false,
        message:
          'Deployment "' +
          resolveScopedWorkloadResourceName(makeRecipe(), 'app') +
          '" updated/ready/available/desired 1/0/0/1',
      },
    ])
  })

  it('treats a fully-available Deployment as ready when observedGeneration transiently lags (no false degraded flap)', async () => {
    // Regression (prod "degraded↔active" flap): WRC's non-idempotent full-replace apply
    // re-defaults server-managed Deployment fields every reconcile, bumping metadata.generation
    // with no real change. A fully-available Deployment (updated/ready/available 1/1/1) therefore
    // momentarily reports observedGeneration < generation. That transient bookkeeping lag must NOT
    // flip the recipe to degraded — replica health is the real readiness signal.
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '598', generation: 598 },
      spec: { replicas: 1 },
      status: {
        observedGeneration: 597,
        updatedReplicas: 1,
        readyReplicas: 1,
        availableReplicas: 1,
      },
    })

    const result = await reconciler.reconcile(
      makeRecipe({
        status: {
          phase: 'active',
          message: 'All workloads deployed',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
    )

    expect(result.phase).toBe('active')
    expect(result.message).toBe('All workloads deployed')
    expect(result.workloadStatuses).toEqual([{ id: 'app', phase: 'deployed', ready: true }])
  })

  it('treats a fully-ready StatefulSet as ready when observedGeneration transiently lags', async () => {
    mockAppsApi.readNamespacedStatefulSet.mockRejectedValueOnce({ code: 404 }).mockResolvedValue({
      metadata: { resourceVersion: '265', generation: 265 },
      spec: { replicas: 1 },
      status: { observedGeneration: 264, readyReplicas: 1 },
    })

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [{ id: 'db', type: 'statefulset', image: 'postgres:16' }],
        },
        status: {
          phase: 'active',
          message: 'All workloads deployed',
          workloads: [{ id: 'db', type: 'statefulset', phase: 'deployed', ready: true }],
        },
      })
    )

    expect(result.phase).toBe('active')
    expect(result.message).toBe('All workloads deployed')
    expect(result.workloadStatuses).toEqual([{ id: 'db', phase: 'deployed', ready: true }])
  })

  it('keeps a Deployment degraded when its rollout exceeded the progress deadline', async () => {
    // The progress-deadline gate is the genuine stuck-rollout signal and must survive: even with
    // all replicas reporting ready, a ProgressDeadlineExceeded condition still degrades the workload.
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '3', generation: 3 },
      spec: { replicas: 1 },
      status: {
        observedGeneration: 3,
        updatedReplicas: 1,
        readyReplicas: 1,
        availableReplicas: 1,
        conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }],
      },
    })

    const result = await reconciler.reconcile(
      makeRecipe({
        status: {
          phase: 'active',
          message: 'All workloads deployed',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.workloadStatuses[0].ready).toBe(false)
    expect(result.workloadStatuses[0].message).toContain('ProgressDeadlineExceeded')
  })

  it('degrades when a child Deployment was externally scaled below recipe replicas', async () => {
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '2', generation: 2 },
      spec: { replicas: 0 },
      status: { observedGeneration: 2, updatedReplicas: 0, readyReplicas: 0, availableReplicas: 0 },
    })

    const result = await reconciler.reconcile(
      makeRecipe({
        status: {
          phase: 'active',
          message: 'All workloads deployed',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.message).toBe('Some workloads not ready')
    expect(result.workloadStatuses).toEqual([
      {
        id: 'app',
        phase: 'degraded',
        ready: false,
        message:
          'Deployment "' +
          resolveScopedWorkloadResourceName(makeRecipe(), 'app') +
          '" updated/ready/available/desired 0/0/0/1',
      },
    ])
  })

  it('degrades when a child StatefulSet was externally scaled below recipe replicas', async () => {
    mockAppsApi.readNamespacedStatefulSet.mockRejectedValueOnce({ code: 404 }).mockResolvedValue({
      metadata: { resourceVersion: '2', generation: 2 },
      spec: { replicas: 0 },
      status: { observedGeneration: 2, readyReplicas: 0 },
    })

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [{ id: 'db', type: 'statefulset', image: 'postgres:16' }],
        },
        status: {
          phase: 'active',
          message: 'All workloads deployed',
          workloads: [{ id: 'db', type: 'statefulset', phase: 'deployed', ready: true }],
        },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.message).toBe('Some workloads not ready')
    expect(result.workloadStatuses).toEqual([
      {
        id: 'db',
        phase: 'degraded',
        ready: false,
        message:
          'StatefulSet "' +
          resolveScopedStatefulSetResourceName(
            makeRecipe({
              spec: {
                workloads: [{ id: 'db', type: 'statefulset', image: 'postgres:16' }],
              },
            }),
            'db'
          ) +
          '" readyReplicas 0/1',
      },
    ])
  })

  it('recovers a degraded recipe when observed child Deployment readiness returns', async () => {
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '1', generation: 1 },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
    })

    const result = await reconciler.reconcile(
      makeRecipe({
        status: {
          phase: 'degraded',
          message: 'Some workloads not ready',
          workloads: [
            {
              id: 'app',
              type: 'deployment',
              phase: 'degraded',
              ready: false,
              message: 'Deployment "app" updated/ready/available/desired 1/0/0/1',
            },
          ],
        },
      })
    )

    expect(result.phase).toBe('active')
    expect(result.message).toBe('All workloads deployed')
    expect(result.workloadStatuses).toEqual([{ id: 'app', phase: 'deployed', ready: true }])
  })

  it('degrades a DaemonSet workload when no pods are scheduled', async () => {
    mockAppsApi.readNamespacedDaemonSet.mockRejectedValueOnce({ code: 404 }).mockResolvedValue({
      metadata: { resourceVersion: '2', generation: 2 },
      status: { observedGeneration: 2, desiredNumberScheduled: 0, numberReady: 0 },
    })

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [{ id: 'agent', type: 'daemonset', image: 'agent:test' }],
        },
        status: {
          phase: 'active',
          message: 'All workloads deployed',
          workloads: [{ id: 'agent', type: 'daemonset', phase: 'deployed', ready: true }],
        },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.message).toBe('Some workloads not ready')
    expect(result.workloadStatuses).toEqual([
      {
        id: 'agent',
        phase: 'degraded',
        ready: false,
        message:
          'DaemonSet "' +
          resolveScopedWorkloadResourceName(
            makeRecipe({
              spec: {
                workloads: [{ id: 'agent', type: 'daemonset', image: 'agent:test' }],
              },
            }),
            'agent'
          ) +
          '" readyReplicas 0/0',
      },
    ])
  })

  // ─── issue #575: live NetworkPolicy convergence ────────────────────────
  describe('applyNetworkPolicy live convergence (issue #575)', () => {
    const SPEC_HASH = 'clerum.io/spec-hash'
    const NS = 'sandbox-recipes'
    const clone = <T>(value: T): T => structuredClone(value)
    type Priv = {
      applyNetworkPolicy: (
        policy: k8s.V1NetworkPolicy,
        namespace: string,
        options: { family: NetworkPolicyFamily; existing?: k8s.V1NetworkPolicy | null }
      ) => Promise<void>
    }
    const apply = (
      policy: k8s.V1NetworkPolicy,
      family: NetworkPolicyFamily = 'workload-ingress',
      existing?: k8s.V1NetworkPolicy | null
    ) =>
      (reconciler as unknown as Priv).applyNetworkPolicy(policy, NS, {
        family,
        ...(existing === undefined ? {} : { existing }),
      })

    const plainPolicy = (): k8s.V1NetworkPolicy => ({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: 'wl-ingress-r-w',
        namespace: NS,
        labels: { 'clerum.io/managed-by': 'workflow-recipes', 'clerum.io/recipe': 'r' },
      },
      spec: {
        podSelector: { matchLabels: { 'clerum.io/workload': 'w' } },
        policyTypes: ['Ingress'],
        ingress: [{ ports: [{ port: 8080, protocol: 'TCP' }] }],
      },
    })

    const intdepPolicy = (): k8s.V1NetworkPolicy => ({
      ...plainPolicy(),
      metadata: {
        name: 'wr-intdep-egress-r-w',
        namespace: NS,
        labels: {
          'clerum.io/managed-by': 'workflow-recipes',
          'clerum.io/recipe': 'r',
          'clerum.io/policy-type': 'internal-dependency',
        },
      },
    })

    const gatewayPolicy = (ownerUid = 'uid-current'): k8s.V1NetworkPolicy => ({
      ...plainPolicy(),
      metadata: {
        name: 'allow-webhook-proxy-ingress-r',
        namespace: NS,
        labels: {
          'clerum.io/managed-by': 'workflow-recipes',
          'clerum.io/recipe-namespace': NS,
          'clerum.io/recipe-name': 'r',
          'clerum.io/webhook-gateway': 'true',
        },
        ownerReferences: [
          {
            apiVersion: 'clerum.io/v1alpha1',
            kind: 'WorkflowRecipe',
            name: 'r',
            uid: ownerUid,
            controller: true,
            blockOwnerDeletion: true,
          },
        ],
      },
    })

    const livePolicy = (
      desired: k8s.V1NetworkPolicy,
      metadata: Partial<k8s.V1ObjectMeta> = {}
    ): k8s.V1NetworkPolicy => ({
      ...clone(desired),
      metadata: {
        ...clone(desired.metadata ?? {}),
        resourceVersion: '9',
        ...metadata,
      },
    })

    function captureNetworkPolicyLogs(): {
      entries: Array<Record<string, unknown>>
      restore: () => void
    } {
      const previousLevel = process.env.LOG_LEVEL
      process.env.LOG_LEVEL = 'info'
      const entries: Array<Record<string, unknown>> = []
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString()
        for (const line of text.split('\n')) {
          if (!line.startsWith('{')) continue
          const parsed = JSON.parse(line) as Record<string, unknown>
          if (String(parsed.msg).startsWith('network policy')) entries.push(parsed)
        }
        return true
      }) as unknown as typeof process.stdout.write)
      return {
        entries,
        restore: () => {
          spy.mockRestore()
          if (previousLevel === undefined) delete process.env.LOG_LEVEL
          else process.env.LOG_LEVEL = previousLevel
        },
      }
    }

    it('T1 skips a live-equivalent policy and emits a structured liveness witness', async () => {
      const desired = plainPolicy()
      const live = livePolicy(desired, { annotations: { [SPEC_HASH]: 'legacy-seal' } })
      live.spec!.ingress![0].ports![0].protocol = undefined
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(live)
      const captured = captureNetworkPolicyLogs()
      try {
        await apply(desired)
        expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
        expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
        expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
        expect(captured.entries).toContainEqual(
          expect.objectContaining({
            level: 'info',
            msg: 'network policy unchanged; skipping update',
            policy: 'wl-ingress-r-w',
            namespace: NS,
            family: 'workload-ingress',
          })
        )
      } finally {
        captured.restore()
      }
    })

    it('T2 repairs live spec drift even when the legacy spec-hash is preserved', async () => {
      const desired = plainPolicy()
      const live = livePolicy(desired, { annotations: { [SPEC_HASH]: 'legacy-seal' } })
      live.spec!.podSelector = {}
      live.spec!.ingress = [{}]
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(live)

      await apply(desired)

      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      const body = (
        mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls[0][0] as {
          body: k8s.V1NetworkPolicy
        }
      ).body
      expect(body.metadata?.resourceVersion).toBe('9')
      expect(body.metadata?.annotations?.[SPEC_HASH]).toBeUndefined()
      expect(body.spec).toEqual(desired.spec)
      expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    })

    it('does not let a supplied cluster-local wl-egress snapshot veto detected drift', async () => {
      const desired = plainPolicy()
      desired.metadata!.name = 'wl-egress-r-w'
      desired.spec = {
        podSelector: { matchLabels: { 'clerum.io/workload': 'w' } },
        policyTypes: ['Egress'],
        egress: [
          {
            to: [{ podSelector: { matchLabels: { 'clerum.io/workload': 'db' } } }],
            ports: [{ port: 5432, protocol: 'TCP' }],
          },
        ],
      }
      const live = livePolicy(desired, { annotations: { [SPEC_HASH]: 'legacy-seal' } })
      live.spec!.podSelector = {}

      await apply(desired, 'workload-egress', live)

      expect(mockNetworkingApi.readNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(
        (
          mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls[0][0] as {
            body: k8s.V1NetworkPolicy
          }
        ).body.spec?.podSelector
      ).toEqual(desired.spec.podSelector)
    })

    it('routes workload-egress label drift through the live apply prefilter', () => {
      const desired = plainPolicy()
      desired.metadata!.name = 'wl-egress-r-w'
      desired.spec = { podSelector: {}, policyTypes: ['Egress'], egress: [] }
      const live = livePolicy(desired)
      live.metadata!.labels = { ...live.metadata!.labels, 'clerum.io/recipe': 'wrong' }

      const writeNeeded = (
        reconciler as unknown as {
          egressWriteNeeded: (
            existing: k8s.V1NetworkPolicy | null,
            wanted: k8s.V1NetworkPolicy
          ) => boolean
        }
      ).egressWriteNeeded(live, desired)

      expect(writeNeeded).toBe(true)

      live.metadata!.labels = desired.metadata!.labels
      live.metadata!.ownerReferences = [
        {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          name: 'foreign',
          uid: 'foreign-uid',
          controller: true,
        },
      ]
      expect(
        (
          reconciler as unknown as {
            egressWriteNeeded: (
              existing: k8s.V1NetworkPolicy | null,
              wanted: k8s.V1NetworkPolicy
            ) => boolean
          }
        ).egressWriteNeeded(live, desired)
      ).toBe(true)
    })

    it('T3 creates on 404 and the next equivalent reconcile is read-only', async () => {
      const desired = plainPolicy()
      mockNetworkingApi.readNamespacedNetworkPolicy.mockRejectedValueOnce({ code: 404 })

      await apply(desired)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      const created = clone(
        (
          mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls[0][0] as {
            body: k8s.V1NetworkPolicy
          }
        ).body
      )
      expect(created.metadata?.annotations?.[SPEC_HASH]).toBeUndefined()

      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(livePolicy(created))

      await apply(desired)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('T4 propagates a foreign intdep ownership veto after exactly one read', async () => {
      const desired = intdepPolicy()
      mockNetworkingApi.readNamespacedNetworkPolicy
        .mockResolvedValueOnce({
          metadata: {
            name: 'wr-intdep-egress-r-w',
            resourceVersion: '9',
            labels: { 'clerum.io/managed-by': 'hcc' },
          },
        })
        .mockRejectedValueOnce({ code: 503 })

      const rejection = await apply(desired, 'internal-dependency').then(
        () => new Error('expected the ownership assertion to reject'),
        (error: unknown) => error as Error
      )
      expect(rejection.name).toBe('NetworkPolicyOwnershipConflictError')
      expect(rejection.message).toMatch(/Refusing to replace NetworkPolicy "wr-intdep-egress-r-w"/)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    })

    it('T4b lets an intdep policy WRC owns converge read-only', async () => {
      const desired = intdepPolicy()
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(livePolicy(desired))

      await expect(apply(desired, 'internal-dependency')).resolves.toBeUndefined()

      expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('T5 retries an HTTP read failure, replaces with the recovered RV, and logs safely', async () => {
      const desired = plainPolicy()
      mockNetworkingApi.readNamespacedNetworkPolicy
        .mockRejectedValueOnce({ code: 500, authorization: 'Bearer must-not-appear' })
        .mockResolvedValueOnce(livePolicy(desired))
      const captured = captureNetworkPolicyLogs()
      try {
        await apply(desired)

        expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
        expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
        expect(
          (
            mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls[0][0] as {
              body: k8s.V1NetworkPolicy
            }
          ).body.metadata?.resourceVersion
        ).toBe('9')
        const warning = captured.entries.find(
          entry => entry.msg === 'network policy read unavailable; retrying once'
        )
        expect(warning).toEqual(
          expect.objectContaining({
            level: 'warn',
            errorName: 'UnknownError',
            errorCode: 500,
            retryable: true,
          })
        )
        expect(JSON.stringify(warning)).not.toContain('must-not-appear')
      } finally {
        captured.restore()
      }
    })

    it('T5b retries a transport read failure once and replaces', async () => {
      const desired = plainPolicy()
      mockNetworkingApi.readNamespacedNetworkPolicy
        .mockRejectedValueOnce({ code: 'ECONNRESET' })
        .mockResolvedValueOnce(livePolicy(desired))

      await apply(desired)

      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
    })

    it('T5c retries a codeless read failure once and replaces', async () => {
      const desired = plainPolicy()
      mockNetworkingApi.readNamespacedNetworkPolicy
        .mockRejectedValueOnce(new Error('transient read timeout'))
        .mockResolvedValueOnce(livePolicy(desired))

      await apply(desired)

      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
    })

    it('repairs the gateway owner UID and refuses a foreign controller owner', async () => {
      const desired = gatewayPolicy('uid-current')
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(
        livePolicy(gatewayPolicy('uid-old'), { annotations: { [SPEC_HASH]: 'legacy-seal' } })
      )

      await apply(desired, 'webhook-gateway')

      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      const body = (
        mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls[0][0] as {
          body: k8s.V1NetworkPolicy
        }
      ).body
      expect(body.metadata?.ownerReferences?.[0].uid).toBe('uid-current')

      mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()
      const foreign = livePolicy(desired)
      foreign.metadata!.ownerReferences = [
        {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          name: 'foreign',
          uid: 'foreign-uid',
          controller: true,
        },
      ]
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(foreign)

      await expect(apply(desired, 'webhook-gateway')).rejects.toMatchObject({
        name: 'NetworkPolicyOwnershipConflictError',
      })
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('handles a read/create race by re-reading instead of blind replacing', async () => {
      const desired = plainPolicy()
      mockNetworkingApi.readNamespacedNetworkPolicy
        .mockRejectedValueOnce({ code: 404 })
        .mockResolvedValueOnce(livePolicy(desired))
      mockNetworkingApi.createNamespacedNetworkPolicy.mockRejectedValueOnce({ code: 409 })

      await apply(desired)

      expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it.each([404, 409])('classifies replace race status %s as retryable', async code => {
      const desired = plainPolicy()
      const live = livePolicy(desired)
      live.spec!.podSelector = {}
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(live)
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mockRejectedValueOnce({ code })

      await expect(apply(desired)).rejects.toMatchObject({
        name: 'RetryableReconcileError',
        cause: { code },
      })
    })

    it('refuses to create a gateway policy without a complete desired owner', async () => {
      const desired = gatewayPolicy('')

      await expect(apply(desired, 'webhook-gateway')).rejects.toMatchObject({
        name: 'NetworkPolicyOwnershipConflictError',
      })
      expect(mockNetworkingApi.readNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })
  })

  describe('idempotent apply (stops generation churn)', () => {
    const SPEC_HASH = 'clerum.io/spec-hash'
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

    afterEach(() => {
      mockAppsApi.createNamespacedDeployment.mockReset().mockResolvedValue({})
      mockAppsApi.readNamespacedDeployment
        .mockReset()
        .mockResolvedValue({ metadata: { resourceVersion: '1' } })
      mockAppsApi.replaceNamespacedDeployment.mockReset().mockResolvedValue({})
      mockAppsApi.createNamespacedStatefulSet.mockReset().mockResolvedValue({})
      mockAppsApi.readNamespacedStatefulSet
        .mockReset()
        .mockResolvedValue({ metadata: { resourceVersion: '1' } })
      mockAppsApi.patchNamespacedStatefulSet.mockReset().mockResolvedValue({})
      mockAppsApi.replaceNamespacedStatefulSet.mockReset().mockResolvedValue({})
      mockAppsApi.createNamespacedDaemonSet.mockReset().mockResolvedValue({})
      mockAppsApi.readNamespacedDaemonSet
        .mockReset()
        .mockResolvedValue({ metadata: { resourceVersion: '1' } })
      mockAppsApi.replaceNamespacedDaemonSet.mockReset().mockResolvedValue({})
      mockBatchApi.createNamespacedCronJob.mockReset().mockResolvedValue({})
      mockBatchApi.readNamespacedCronJob
        .mockReset()
        .mockResolvedValue({ metadata: { resourceVersion: '1' } })
      mockBatchApi.replaceNamespacedCronJob.mockReset().mockResolvedValue({})
      mockBatchApi.createNamespacedJob.mockReset().mockResolvedValue({})
      mockBatchApi.readNamespacedJob
        .mockReset()
        .mockResolvedValue({ metadata: { resourceVersion: '1' } })
      mockBatchApi.replaceNamespacedJob.mockReset().mockResolvedValue({})
    })

    it('does NOT replace a Deployment whose spec-hash is unchanged', async () => {
      const recipe = makeRecipe()
      const workload = recipe.spec.workloads![0]

      // First apply creates the object; capture the manifest WRC writes (carries the hash).
      let createdBody: { metadata: { annotations: Record<string, string> }; spec: unknown } | null =
        null
      mockAppsApi.createNamespacedDeployment.mockImplementation((args: { body: unknown }) => {
        createdBody = args.body as typeof createdBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureDeployment: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureDeployment(workload, recipe, 'minimal', {})
      expect(createdBody!.metadata.annotations[SPEC_HASH]).toBeDefined()

      // Second apply: object already exists with the SAME hash → must skip the PUT.
      mockAppsApi.createNamespacedDeployment.mockRejectedValue({ code: 409 })
      mockAppsApi.readNamespacedDeployment.mockResolvedValue({
        metadata: { resourceVersion: '9', annotations: createdBody!.metadata.annotations },
        spec: createdBody!.spec,
      })
      mockAppsApi.replaceNamespacedDeployment.mockClear()

      await (
        reconciler as unknown as {
          ensureDeployment: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureDeployment(workload, recipe, 'minimal', {})

      expect(mockAppsApi.replaceNamespacedDeployment).not.toHaveBeenCalled()
    })

    it('replaces a Deployment when the desired spec-hash differs', async () => {
      const recipe = makeRecipe()
      const workload = recipe.spec.workloads![0]

      mockAppsApi.createNamespacedDeployment.mockRejectedValue({ code: 409 })
      mockAppsApi.readNamespacedDeployment.mockResolvedValue({
        metadata: { resourceVersion: '9', annotations: { [SPEC_HASH]: 'stale-or-foreign' } },
        spec: {},
      })
      mockAppsApi.replaceNamespacedDeployment.mockClear().mockResolvedValue({})

      await (
        reconciler as unknown as {
          ensureDeployment: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureDeployment(workload, recipe, 'minimal', {})

      expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalledTimes(1)
    })

    it('does NOT replace a StatefulSet whose spec-hash is unchanged', async () => {
      const workload = { id: 'db', type: 'statefulset' as const, image: 'postgres:16' }
      const recipe = makeRecipe({ spec: { workloads: [workload] } })

      let createdBody: { metadata: { annotations: Record<string, string> }; spec: unknown } | null =
        null
      mockAppsApi.createNamespacedStatefulSet.mockImplementation((args: { body: unknown }) => {
        createdBody = args.body as typeof createdBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(workload, recipe, 'minimal', {})
      expect(createdBody!.metadata.annotations[SPEC_HASH]).toBeDefined()

      mockAppsApi.createNamespacedStatefulSet.mockRejectedValue({ code: 409 })
      mockAppsApi.readNamespacedStatefulSet.mockResolvedValue({
        metadata: { resourceVersion: '9', annotations: createdBody!.metadata.annotations },
        spec: createdBody!.spec,
      })
      mockAppsApi.replaceNamespacedStatefulSet.mockClear()

      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(workload, recipe, 'minimal', {})

      expect(mockAppsApi.replaceNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.patchNamespacedStatefulSet).not.toHaveBeenCalled()
    })

    it('patches only StatefulSet metadata when the desired spec already matches', async () => {
      const workload = { id: 'db', type: 'statefulset' as const, image: 'postgres:16' }
      const recipe = makeRecipe({ spec: { workloads: [workload] } })

      let createdBody: {
        metadata: { annotations: Record<string, string> }
        spec: Record<string, unknown>
      } | null = null
      mockAppsApi.createNamespacedStatefulSet.mockImplementation((args: { body: unknown }) => {
        createdBody = args.body as typeof createdBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(workload, recipe, 'minimal', {})

      const existing = clone(createdBody!)
      existing.metadata.annotations = { [SPEC_HASH]: 'stale-or-missing' }
      mockAppsApi.createNamespacedStatefulSet.mockRejectedValue({ code: 409 })
      mockAppsApi.readNamespacedStatefulSet.mockResolvedValue(existing)
      mockAppsApi.replaceNamespacedStatefulSet.mockClear()
      mockAppsApi.patchNamespacedStatefulSet.mockClear()

      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(workload, recipe, 'minimal', {})

      expect(mockAppsApi.replaceNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalledTimes(1)
      expect(mockAppsApi.patchNamespacedStatefulSet.mock.calls[0][0].body).toEqual({
        metadata: { annotations: { [SPEC_HASH]: createdBody!.metadata.annotations[SPEC_HASH] } },
      })
    })

    it('patches mutable StatefulSet spec fields without full replace', async () => {
      const oldWorkload = { id: 'db', type: 'statefulset' as const, image: 'postgres:15' }
      const newWorkload = { id: 'db', type: 'statefulset' as const, image: 'postgres:16' }
      const oldRecipe = makeRecipe({ spec: { workloads: [oldWorkload] } })
      const newRecipe = makeRecipe({ spec: { workloads: [newWorkload] } })

      let existingBody: {
        metadata: { annotations: Record<string, string> }
        spec: Record<string, unknown>
      } | null = null
      mockAppsApi.createNamespacedStatefulSet.mockImplementation((args: { body: unknown }) => {
        existingBody = args.body as typeof existingBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(oldWorkload, oldRecipe, 'minimal', {})

      const existing = clone(existingBody!)
      existing.metadata.annotations = { [SPEC_HASH]: 'stale-old-template' }
      mockAppsApi.createNamespacedStatefulSet.mockRejectedValue({ code: 409 })
      mockAppsApi.readNamespacedStatefulSet.mockResolvedValue(existing)
      mockAppsApi.replaceNamespacedStatefulSet.mockClear()
      mockAppsApi.patchNamespacedStatefulSet.mockClear()

      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(newWorkload, newRecipe, 'minimal', {})

      expect(mockAppsApi.replaceNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalledTimes(1)
      const patchBody = mockAppsApi.patchNamespacedStatefulSet.mock.calls[0][0].body
      expect(patchBody.spec.template.spec.containers[0].image).toBe('postgres:16')
      expect(patchBody.spec.volumeClaimTemplates).toBeUndefined()
    })

    it('treats API-server defaulted StatefulSet volumeClaimTemplates as equivalent', async () => {
      const oldWorkload = {
        id: 'db',
        type: 'statefulset' as const,
        image: 'postgres:15',
        volumeClaimTemplates: [
          {
            name: 'pgdata',
            size: '256Mi',
            accessMode: 'ReadWriteOnce' as const,
            storageClass: 'standard',
          },
        ],
        volumeMounts: [{ name: 'pgdata', mountPath: '/var/lib/postgresql/data' }],
      }
      const newWorkload = { ...oldWorkload, image: 'postgres:16' }
      const oldRecipe = makeRecipe({ spec: { workloads: [oldWorkload] } })
      const newRecipe = makeRecipe({ spec: { workloads: [newWorkload] } })

      let existingBody: {
        metadata: { annotations: Record<string, string> }
        spec: {
          template: Record<string, unknown>
          volumeClaimTemplates?: Array<Record<string, unknown>>
        }
      } | null = null
      mockAppsApi.createNamespacedStatefulSet.mockImplementation((args: { body: unknown }) => {
        existingBody = args.body as typeof existingBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(oldWorkload, oldRecipe, 'minimal', {})

      const existing = clone(existingBody!)
      existing.metadata.annotations = { [SPEC_HASH]: 'stale-old-template' }
      existing.spec.volumeClaimTemplates = existing.spec.volumeClaimTemplates?.map(template => ({
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        ...template,
        spec: {
          ...(template.spec as Record<string, unknown>),
          volumeMode: 'Filesystem',
        },
        status: { phase: 'Pending' },
      }))
      mockAppsApi.createNamespacedStatefulSet.mockRejectedValue({ code: 409 })
      mockAppsApi.readNamespacedStatefulSet.mockResolvedValue(existing)
      mockAppsApi.replaceNamespacedStatefulSet.mockClear()
      mockAppsApi.patchNamespacedStatefulSet.mockClear()

      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(newWorkload, newRecipe, 'minimal', {})

      expect(mockAppsApi.replaceNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalledTimes(1)
      const patchBody = mockAppsApi.patchNamespacedStatefulSet.mock.calls[0][0].body
      expect(patchBody.spec.template.spec.containers[0].image).toBe('postgres:16')
      expect(patchBody.spec.volumeClaimTemplates).toBeUndefined()
    })

    it('patches a legacy scoped StatefulSet with volumeClaimTemplates instead of reporting false drift', async () => {
      const runtimeName = 'issue-690-preexisting-nohash-sim-db-6fd5da9b'
      const oldWorkload = {
        id: 'db',
        type: 'statefulset' as const,
        image: 'postgres:16-alpine',
        port: 5432,
        env: [
          { name: 'POSTGRES_HOST_AUTH_METHOD', value: 'trust' },
          { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
        ],
        security: {
          addCapabilities: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'],
          fsGroup: 70,
          runAsGroup: 70,
          runAsUser: 70,
        },
        volumeClaimTemplates: [
          {
            name: 'pgdata',
            size: '256Mi',
            accessMode: 'ReadWriteOnce' as const,
            storageClass: 'standard',
          },
        ],
        volumeMounts: [{ name: 'pgdata', mountPath: '/var/lib/postgresql/data' }],
      }
      const newWorkload = {
        ...oldWorkload,
        env: [...oldWorkload.env, { name: 'ISSUE_690_GENERATION_BUMP', value: '1' }],
      }
      const oldRecipe = makeRecipe({
        metadata: {
          name: 'issue-690-preexisting-nohash-sim',
          namespace: 'sandbox-recipes',
          uid: '959605ce-077f-4638-b5d0-403fbcd431cf',
        },
        spec: { workloads: [oldWorkload] },
        status: { phase: 'active', workloadInstances: { db: runtimeName } },
      })
      const newRecipe = makeRecipe({
        metadata: oldRecipe.metadata,
        spec: { workloads: [newWorkload] },
        status: oldRecipe.status,
      })

      let existingBody: {
        metadata: { annotations?: Record<string, string> }
        spec: {
          template: Record<string, unknown>
          volumeClaimTemplates?: Array<Record<string, unknown>>
        }
      } | null = null
      mockAppsApi.createNamespacedStatefulSet.mockImplementation((args: { body: unknown }) => {
        existingBody = args.body as typeof existingBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(oldWorkload, oldRecipe, 'minimal', {})

      const existing = clone(existingBody!)
      existing.metadata.annotations = {
        'kubectl.kubernetes.io/last-applied-configuration': '{}',
      }
      existing.spec.volumeClaimTemplates = existing.spec.volumeClaimTemplates?.map(template => ({
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        ...template,
        spec: {
          ...(template.spec as Record<string, unknown>),
          volumeMode: 'Filesystem',
        },
        status: { phase: 'Pending' },
      }))
      mockAppsApi.createNamespacedStatefulSet.mockRejectedValue({ code: 409 })
      mockAppsApi.readNamespacedStatefulSet.mockResolvedValue(existing)
      mockAppsApi.replaceNamespacedStatefulSet.mockClear()
      mockAppsApi.patchNamespacedStatefulSet.mockClear()

      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(newWorkload, newRecipe, 'minimal', {})

      expect(mockAppsApi.replaceNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.patchNamespacedStatefulSet).toHaveBeenCalledTimes(1)
      const patchBody = mockAppsApi.patchNamespacedStatefulSet.mock.calls[0][0].body
      expect(patchBody.spec.template.spec.containers[0].env).toContainEqual({
        name: 'ISSUE_690_GENERATION_BUMP',
        value: '1',
      })
      expect(patchBody.spec.volumeClaimTemplates).toBeUndefined()
    })

    it('fails StatefulSet reconciliation when volumeClaimTemplate storage drifts', async () => {
      const oldWorkload = {
        id: 'db',
        type: 'statefulset' as const,
        image: 'postgres:16',
        volumeClaimTemplates: [
          {
            name: 'pgdata',
            size: '256Mi',
            accessMode: 'ReadWriteOnce' as const,
            storageClass: 'standard',
          },
        ],
        volumeMounts: [{ name: 'pgdata', mountPath: '/var/lib/postgresql/data' }],
      }
      const newWorkload = {
        ...oldWorkload,
        volumeClaimTemplates: [
          {
            name: 'pgdata',
            size: '512Mi',
            accessMode: 'ReadWriteOnce' as const,
            storageClass: 'standard',
          },
        ],
      }
      const oldRecipe = makeRecipe({ spec: { workloads: [oldWorkload] } })
      const newRecipe = makeRecipe({ spec: { workloads: [newWorkload] } })

      let existingBody: {
        metadata: { annotations: Record<string, string> }
        spec: {
          volumeClaimTemplates?: Array<Record<string, unknown>>
        }
      } | null = null
      mockAppsApi.createNamespacedStatefulSet.mockImplementation((args: { body: unknown }) => {
        existingBody = args.body as typeof existingBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(oldWorkload, oldRecipe, 'minimal', {})

      const existing = clone(existingBody!)
      existing.metadata.annotations = { [SPEC_HASH]: 'stale-storage' }
      mockAppsApi.createNamespacedStatefulSet.mockRejectedValue({ code: 409 })
      mockAppsApi.readNamespacedStatefulSet.mockResolvedValue(existing)
      mockAppsApi.replaceNamespacedStatefulSet.mockClear()
      mockAppsApi.patchNamespacedStatefulSet.mockClear()

      await expect(
        (
          reconciler as unknown as {
            ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
          }
        ).ensureStatefulSet(newWorkload, newRecipe, 'minimal', {})
      ).rejects.toMatchObject({
        name: 'ImmutableStatefulSetDriftError',
        condition: {
          type: 'StatefulSetImmutableDrift',
          reason: 'ImmutableStatefulSetDrift',
        },
      })

      expect(mockAppsApi.replaceNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.patchNamespacedStatefulSet).not.toHaveBeenCalled()
    })

    it('fails StatefulSet reconciliation with a stable immutable-drift reason', async () => {
      const workload = { id: 'db', type: 'statefulset' as const, image: 'postgres:16' }
      const recipe = makeRecipe({ spec: { workloads: [workload] } })

      let createdBody: {
        metadata: { annotations: Record<string, string> }
        spec: Record<string, unknown>
      } | null = null
      mockAppsApi.createNamespacedStatefulSet.mockImplementation((args: { body: unknown }) => {
        createdBody = args.body as typeof createdBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureStatefulSet(workload, recipe, 'minimal', {})

      const existing = clone(createdBody!)
      existing.metadata.annotations = { [SPEC_HASH]: 'stale-immutable-drift' }
      existing.spec.serviceName = 'manually-mutated-headless-service'
      mockAppsApi.createNamespacedStatefulSet.mockRejectedValue({ code: 409 })
      mockAppsApi.readNamespacedStatefulSet.mockResolvedValue(existing)
      mockAppsApi.replaceNamespacedStatefulSet.mockClear()
      mockAppsApi.patchNamespacedStatefulSet.mockClear()

      await expect(
        (
          reconciler as unknown as {
            ensureStatefulSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
          }
        ).ensureStatefulSet(workload, recipe, 'minimal', {})
      ).rejects.toMatchObject({
        name: 'ImmutableStatefulSetDriftError',
        condition: {
          type: 'StatefulSetImmutableDrift',
          reason: 'ImmutableStatefulSetDrift',
        },
      })

      expect(mockAppsApi.replaceNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockAppsApi.patchNamespacedStatefulSet).not.toHaveBeenCalled()
    })

    it('does NOT replace a CronJob whose spec-hash is unchanged', async () => {
      const workload = {
        id: 'cron',
        type: 'cronjob' as const,
        image: 'busybox:1.36',
        schedule: '*/5 * * * *',
      }
      const recipe = makeRecipe({ spec: { workloads: [workload] } })

      let createdBody: { metadata: { annotations: Record<string, string> }; spec: unknown } | null =
        null
      mockBatchApi.createNamespacedCronJob.mockImplementation((args: { body: unknown }) => {
        createdBody = args.body as typeof createdBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureCronJob: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureCronJob(workload, recipe, 'minimal', {})
      expect(createdBody!.metadata.annotations[SPEC_HASH]).toBeDefined()

      mockBatchApi.createNamespacedCronJob.mockRejectedValue({ code: 409 })
      mockBatchApi.readNamespacedCronJob.mockResolvedValue({
        metadata: { resourceVersion: '9', annotations: createdBody!.metadata.annotations },
        spec: createdBody!.spec,
      })
      mockBatchApi.replaceNamespacedCronJob.mockClear()

      await (
        reconciler as unknown as {
          ensureCronJob: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureCronJob(workload, recipe, 'minimal', {})

      expect(mockBatchApi.replaceNamespacedCronJob).not.toHaveBeenCalled()
    })

    it('does NOT replace a Job whose spec-hash is unchanged', async () => {
      const workload = { id: 'job', type: 'job' as const, image: 'busybox:1.36' }
      const recipe = makeRecipe({ spec: { workloads: [workload] } })

      let createdBody: { metadata: { annotations: Record<string, string> }; spec: unknown } | null =
        null
      mockBatchApi.createNamespacedJob.mockImplementation((args: { body: unknown }) => {
        createdBody = args.body as typeof createdBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureJob: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureJob(workload, recipe, 'minimal', {})
      expect(createdBody!.metadata.annotations[SPEC_HASH]).toBeDefined()

      mockBatchApi.createNamespacedJob.mockRejectedValue({ code: 409 })
      mockBatchApi.readNamespacedJob.mockResolvedValue({
        metadata: { resourceVersion: '9', annotations: createdBody!.metadata.annotations },
        spec: createdBody!.spec,
      })
      mockBatchApi.replaceNamespacedJob.mockClear()

      await (
        reconciler as unknown as {
          ensureJob: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureJob(workload, recipe, 'minimal', {})

      expect(mockBatchApi.replaceNamespacedJob).not.toHaveBeenCalled()
    })

    it('does NOT replace a DaemonSet whose spec-hash is unchanged', async () => {
      const workload = { id: 'ds', type: 'daemonset' as const, image: 'agent:test' }
      const recipe = makeRecipe({ spec: { workloads: [workload] } })

      let createdBody: { metadata: { annotations: Record<string, string> }; spec: unknown } | null =
        null
      mockAppsApi.createNamespacedDaemonSet.mockImplementation((args: { body: unknown }) => {
        createdBody = args.body as typeof createdBody
        return Promise.resolve({})
      })
      await (
        reconciler as unknown as {
          ensureDaemonSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureDaemonSet(workload, recipe, 'minimal', {})
      expect(createdBody!.metadata.annotations[SPEC_HASH]).toBeDefined()

      mockAppsApi.createNamespacedDaemonSet.mockRejectedValue({ code: 409 })
      mockAppsApi.readNamespacedDaemonSet.mockResolvedValue({
        metadata: { resourceVersion: '9', annotations: createdBody!.metadata.annotations },
        spec: createdBody!.spec,
      })
      mockAppsApi.replaceNamespacedDaemonSet.mockClear()

      await (
        reconciler as unknown as {
          ensureDaemonSet: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureDaemonSet(workload, recipe, 'minimal', {})

      expect(mockAppsApi.replaceNamespacedDaemonSet).not.toHaveBeenCalled()
    })

    it('falls open and replaces when the existing object cannot be read (never silently skips)', async () => {
      const recipe = makeRecipe()
      const workload = recipe.spec.workloads![0]

      mockAppsApi.createNamespacedDeployment.mockRejectedValue({ code: 409 })
      // First read (idempotency check) fails; the replace path's own read then succeeds.
      mockAppsApi.readNamespacedDeployment
        .mockReset()
        .mockRejectedValueOnce(new Error('transient read timeout'))
        .mockResolvedValue({ metadata: { resourceVersion: '9' } })
      mockAppsApi.replaceNamespacedDeployment.mockClear().mockResolvedValue({})

      await (
        reconciler as unknown as {
          ensureDeployment: (w: unknown, r: unknown, l: string, s: unknown) => Promise<void>
        }
      ).ensureDeployment(workload, recipe, 'minimal', {})

      expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalledTimes(1)
    })
  })

  describe('RBAC for StatefulSet patch reconciliation', () => {
    type RoleManifest = {
      kind?: string
      metadata?: { namespace?: string; name?: string }
      rules?: Array<{ apiGroups?: string[]; resources?: string[]; verbs?: string[] }>
    }

    function repoRoot(): string {
      return process.cwd().endsWith('/workflow-recipes')
        ? resolve(process.cwd(), '..')
        : process.cwd()
    }

    function loadRoles(pathFromRoot: string): RoleManifest[] {
      const docs = loadAll(readFileSync(resolve(repoRoot(), pathFromRoot), 'utf8'))
      return docs.filter((doc): doc is RoleManifest => {
        return Boolean(doc && typeof doc === 'object' && (doc as RoleManifest).kind === 'Role')
      })
    }

    function workflowRecipesRole(
      pathFromRoot: string,
      namespace: string,
      name = 'workflow-recipes'
    ): RoleManifest {
      const role = loadRoles(pathFromRoot).find(
        doc => doc.metadata?.name === name && doc.metadata.namespace === namespace
      )
      expect(role).toBeDefined()
      return role!
    }

    it('grants patch only on apps/statefulsets in sandbox-recipes', () => {
      const role = workflowRecipesRole(
        'deploy/base/sandbox-recipes/rbac.yaml',
        'sandbox-recipes',
        'workflow-recipes-sandbox'
      )
      const statefulSetRule = role.rules?.find(
        rule => rule.apiGroups?.includes('apps') && rule.resources?.includes('statefulsets')
      )
      expect(statefulSetRule?.verbs).toEqual(['get', 'list', 'create', 'update', 'patch', 'delete'])

      const deploymentRule = role.rules?.find(
        rule => rule.apiGroups?.includes('apps') && rule.resources?.includes('deployments')
      )
      expect(deploymentRule?.verbs).not.toContain('patch')
    })

    it('allows only read access to Service endpoints for SDK teardown absence checks', () => {
      const role = workflowRecipesRole(
        'deploy/base/sandbox-recipes/rbac.yaml',
        'sandbox-recipes',
        'workflow-recipes-sandbox'
      )
      const endpointsRule = role.rules?.find(
        rule => rule.apiGroups?.includes('') && rule.resources?.includes('endpoints')
      )
      expect(endpointsRule?.verbs).toEqual(['get'])
    })

    it('grants patch only on apps/statefulsets in mcp-server', () => {
      const role = workflowRecipesRole('deploy/base/mcp-server/rbac.yaml', 'mcp-server')
      const statefulSetRule = role.rules?.find(
        rule => rule.apiGroups?.includes('apps') && rule.resources?.includes('statefulsets')
      )
      expect(statefulSetRule?.verbs).toEqual(['get', 'list', 'create', 'update', 'patch', 'delete'])

      const deploymentRule = role.rules?.find(
        rule => rule.apiGroups?.includes('apps') && rule.resources?.includes('deployments')
      )
      expect(deploymentRule?.verbs).not.toContain('patch')
    })
  })

  it('materializes WRC internal-dependency NetworkPolicies and status condition', async () => {
    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:test',
              port: 8080,
              env: [{ name: 'DB_URL', value: 'postgres://{{db:host}}:{{db:port}}/app' }],
            },
            { id: 'db', type: 'deployment', image: 'postgres:16', port: 5432 },
          ],
        },
      })
    )

    expect(result.phase).toBe('active')
    expect(result.internalDependencyConditions?.[0]).toMatchObject({
      type: 'InternalDependenciesReady',
      status: 'True',
      reason: 'Reconciled',
    })
    const internalPolicies = mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls
      .map(call => call[0].body)
      .filter(
        policy => policy.metadata?.labels?.['clerum.io/policy-type'] === 'internal-dependency'
      )

    expect(internalPolicies.map(policy => policy.metadata?.name)).toEqual([
      'wr-intdep-egress-test-recipe-api',
      'wr-intdep-ingress-test-recipe-db',
    ])
    expect(internalPolicies[0].spec.podSelector.matchLabels).toMatchObject({
      'clerum.io/managed-by': 'workflow-recipes',
      'clerum.io/workload': 'api',
    })
    expect(mockNetworkingApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
      namespace: 'sandbox-recipes',
      labelSelector:
        'clerum.io/managed-by=workflow-recipes,clerum.io/policy-type=internal-dependency,clerum.io/recipe=test-recipe',
    })
  })

  it('patchStatus merges InternalDependenciesReady without deleting unrelated conditions', async () => {
    const r = makeRecipe({
      status: {
        phase: 'approved',
        conditions: [
          { type: 'ExternalEgressReady', status: 'True', lastTransitionTime: 'old' },
          {
            type: 'InternalDependenciesReady',
            status: 'False',
            reason: 'Old',
            lastTransitionTime: 'old',
          },
        ],
      },
    })

    await reconciler.patchStatus(r, {
      phase: 'active',
      message: 'All workloads deployed',
      workloadStatuses: [],
      internalDependencyConditions: [
        {
          type: 'InternalDependenciesReady',
          status: 'True',
          reason: 'Reconciled',
          message: 'ok',
          lastTransitionTime: 'now',
        },
      ],
    })

    const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
    expect(patch.status.conditions).toEqual([
      { type: 'ExternalEgressReady', status: 'True', lastTransitionTime: 'old' },
      {
        type: 'InternalDependenciesReady',
        status: 'True',
        reason: 'Reconciled',
        message: 'ok',
        lastTransitionTime: 'now',
      },
    ])
  })

  it('replaces and clears the SDK provider-unavailable condition on recovery', async () => {
    ;(
      reconciler as unknown as { config: { pluginWorkloadSdkEnabled: boolean } }
    ).config.pluginWorkloadSdkEnabled = true
    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 }],
        pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
      },
      status: {
        phase: 'degraded',
        conditions: [
          {
            type: PLUGIN_WORKLOAD_SDK_PROVIDER_UNAVAILABLE_CONDITION_TYPE,
            status: 'True',
            reason: 'ProviderUnavailable',
            lastTransitionTime: 'old',
          },
        ],
      },
    })

    await reconciler.patchStatus(recipe, {
      phase: 'degraded',
      message: 'configured provider unavailable',
      workloadStatuses: [],
      pluginWorkloadSdkProviderUnavailable: true,
    })
    const degradedPatch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.at(-1)![0].body
    expect(
      degradedPatch.status.conditions.filter(
        (condition: { type: string }) =>
          condition.type === PLUGIN_WORKLOAD_SDK_PROVIDER_UNAVAILABLE_CONDITION_TYPE
      )
    ).toHaveLength(1)

    mockCustomApi.patchNamespacedCustomObjectStatus.mockClear()
    const recoveredRecipe: WorkflowRecipeCRD = {
      ...recipe,
      status: { phase: 'degraded', conditions: degradedPatch.status.conditions },
    }
    await reconciler.patchStatus(recoveredRecipe, {
      phase: 'active',
      message: 'All workloads deployed',
      workloadStatuses: [],
      pluginWorkloadSdkProviderUnavailable: false,
      pluginWorkloadSdkBootstrapProof: {
        ready: true,
        contractVersion: 2,
        podUid: 'mcp-host-pod-uid',
        provider: 'zai',
        model: 'glm-4.7',
        policyRevision: 3,
        policyHash: 'sha256:policy',
        defaultTargetRef: 'zai/glm-4.7',
        defaultProvider: 'zai',
        defaultModel: 'glm-4.7',
        verifiedAt: new Date().toISOString(),
      },
    })
    const recoveredPatch =
      mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.at(-1)![0].body
    expect(
      recoveredPatch.status.conditions.some(
        (condition: { type: string }) =>
          condition.type === PLUGIN_WORKLOAD_SDK_PROVIDER_UNAVAILABLE_CONDITION_TYPE
      )
    ).toBe(false)
    expect(recoveredPatch.status.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'PluginWorkloadSdkCapability',
          status: 'True',
          reason: 'Validated',
        }),
      ])
    )
  })

  it('prunes only selected stale internal-dependency policies when none are desired', async () => {
    mockNetworkingApi.listNamespacedNetworkPolicy.mockImplementation(
      ({ namespace }: { namespace: string }) =>
        Promise.resolve({
          items:
            namespace === 'sandbox-recipes'
              ? [{ metadata: { name: 'wr-intdep-egress-test-recipe-old' } }]
              : namespace === 'sandbox-ui'
                ? [{ metadata: { name: 'wr-intdep-egress-test-recipe-stale-ui' } }]
                : [],
        })
    )

    const result = await reconciler.reconcile(makeRecipe())

    expect(result.phase).toBe('active')
    expect(result.internalDependencyConditions?.[0]).toMatchObject({
      status: 'True',
      reason: 'Reconciled',
    })
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: 'wr-intdep-egress-test-recipe-old',
      namespace: 'sandbox-recipes',
    })
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: 'wr-intdep-egress-test-recipe-stale-ui',
      namespace: 'sandbox-ui',
    })
    expect(mockNetworkingApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
      namespace: 'sandbox-ui',
      labelSelector:
        'clerum.io/managed-by=workflow-recipes,clerum.io/policy-type=internal-dependency,clerum.io/recipe=test-recipe',
    })
    expect(mockNetworkingApi.listNamespacedNetworkPolicy.mock.calls[0][0].labelSelector).toContain(
      'clerum.io/policy-type=internal-dependency'
    )
  })

  it('fails closed instead of replacing an existing non-WRC internal-dependency policy', async () => {
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name }: { name: string }) => {
        if (!name.startsWith('wr-intdep-')) return Promise.reject({ code: 404 })
        return Promise.resolve({
          metadata: {
            resourceVersion: 'rv-hcc',
            labels: {
              'clerum.io/managed-by': 'host-capability-controller',
              'clerum.io/policy-type': 'binding-allow',
              'clerum.io/recipe': 'test-recipe',
            },
          },
        })
      }
    )

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:test',
              port: 8080,
              env: [{ name: 'DB_HOST', value: '{{db:host}}' }],
            },
            { id: 'db', type: 'deployment', image: 'postgres:16', port: 5432 },
          ],
        },
      })
    )

    expect(result.phase).toBe('failed')
    expect(result.internalDependencyConditions?.[0]).toMatchObject({
      status: 'False',
      reason: 'OwnershipConflict',
    })
    expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('keeps a recipe retryable when an internal-dependency policy is terminating', async () => {
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name }: { name: string }) => {
        if (!name.startsWith('wr-intdep-')) return Promise.reject({ code: 404 })
        return Promise.resolve({
          metadata: {
            name,
            resourceVersion: 'rv-terminating',
            deletionTimestamp: new Date('2026-09-04T00:00:00Z'),
            labels: {
              'clerum.io/managed-by': 'host-capability-controller',
              'clerum.io/policy-type': 'binding-allow',
              'clerum.io/recipe': 'test-recipe',
            },
          },
        })
      }
    )

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:test',
              port: 8080,
              env: [{ name: 'DB_HOST', value: '{{db:host}}' }],
            },
            { id: 'db', type: 'deployment', image: 'postgres:16', port: 5432 },
          ],
        },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.message).toMatch(/is terminating; retrying after deletion/)
    expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('keeps a recipe retryable when an internal-dependency policy disappears before replace', async () => {
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name }: { name: string }) => {
        if (!name.startsWith('wr-intdep-')) return Promise.reject({ code: 404 })
        return Promise.resolve({
          metadata: {
            name,
            resourceVersion: 'rv-before-delete',
            labels: {
              'clerum.io/managed-by': 'workflow-recipes',
              'clerum.io/policy-type': 'internal-dependency',
              'clerum.io/recipe': 'test-recipe',
            },
          },
          spec: { podSelector: {}, policyTypes: ['Ingress'] },
        })
      }
    )
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockRejectedValueOnce({ code: 404 })

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:test',
              port: 8080,
              env: [{ name: 'DB_HOST', value: '{{db:host}}' }],
            },
            { id: 'db', type: 'deployment', image: 'postgres:16', port: 5432 },
          ],
        },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.message).toMatch(/disappeared during replace/)
  })

  it.each([{ code: 500 }, new Error('network timeout')])(
    'preserves an active recipe and requeues when internal-dependency reads stay unavailable (%s)',
    async readError => {
      mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
        ({ name }: { name: string }) =>
          name.startsWith('wr-intdep-') ? Promise.reject(readError) : Promise.reject({ code: 404 })
      )

      const result = await reconciler.reconcile(
        makeRecipe({
          status: { phase: 'active', message: 'healthy before API outage', workloads: [] },
          spec: {
            workloads: [
              {
                id: 'api',
                type: 'deployment',
                image: 'api:test',
                port: 8080,
                env: [{ name: 'DB_HOST', value: '{{db:host}}' }],
              },
              { id: 'db', type: 'deployment', image: 'postgres:16', port: 5432 },
            ],
          },
        })
      )

      expect(result.phase).toBe('active')
      expect(result.message).toBe('healthy before API outage')
      expect(result.skipStatusPatch).toBe(true)
      expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    }
  )

  it('keeps a workflow non-terminal when internal-dependency reads stay unavailable', async () => {
    const workflowReconcile = vi.fn()
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
      ({ name }: { name: string }) =>
        name.startsWith('wr-intdep-')
          ? Promise.reject({ code: 500 })
          : Promise.reject({ code: 404 })
    )

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:test',
              port: 8080,
              env: [{ name: 'DB_HOST', value: '{{db:host}}' }],
            },
            { id: 'db', type: 'deployment', image: 'postgres:16', port: 5432 },
          ],
          steps: [{ id: 'run', run: snippetRun() }],
        },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.workflowPhase).toBeUndefined()
    expect(result.message).toBe('Workflow workload infrastructure temporarily unavailable (500)')
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('fails closed before workflow execution when a workflow StatefulSet hits a foreign PVC', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      metadata: { name: 'workflow-with-db', namespace: 'sandbox-recipes', uid: 'uid-workflow-db' },
      spec: {
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            volumeClaimTemplates: [
              {
                name: 'pgdata',
                size: '10Gi',
                accessMode: 'ReadWriteOnce',
                storageClass: 'standard',
              },
            ],
          },
        ],
        steps: [{ id: 'run', run: snippetRun() }],
      },
      status: { phase: 'approved' },
    })
    const expectedSts = resolveScopedStatefulSetResourceName(recipe, 'db')
    mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValueOnce({
      metadata: {
        name: 'pgdata-' + expectedSts + '-0',
        labels: { 'clerum.io/recipe': 'other-recipe', 'clerum.io/workload': 'db' },
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(workflowReconcile).not.toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedStatefulSet).not.toHaveBeenCalled()
    expect(result.phase).toBe('failed')
    expect(result.workflowPhase).toBe('failed')
    expect(result.message).toContain('belongs to recipe "other-recipe" workload "db"')
  })

  it('materializes internal-dependency policies for workflow-declared workloads before execution', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:test',
              port: 8080,
              env: [{ name: 'DB_HOST', value: '{{db:host}}' }],
            },
            { id: 'db', type: 'deployment', image: 'postgres:16', port: 5432 },
          ],
          steps: [{ id: 'run', run: snippetRun() }],
        },
      })
    )

    expect(workflowReconcile).toHaveBeenCalled()
    expect(result.internalDependencyConditions?.[0]).toMatchObject({
      status: 'True',
      reason: 'Reconciled',
    })
    const internalPolicyNames = mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls
      .map(call => call[0].body.metadata?.name)
      .filter((name: string | undefined) => name?.startsWith('wr-intdep-'))
    expect(internalPolicyNames).toEqual([
      'wr-intdep-egress-test-recipe-api',
      'wr-intdep-ingress-test-recipe-db',
    ])
  })

  it('does not materialize internal-dependency policies for failed non-workflow recipes', async () => {
    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:test',
              port: 8080,
              env: [{ name: 'DB_HOST', value: 'db.sandbox-recipes.svc.cluster.local' }],
            },
            { id: 'db', type: 'deployment', image: 'postgres:16', port: 5432 },
          ],
        },
        status: { phase: 'failed', message: 'terminal spec failure' },
      })
    )

    expect(result.phase).toBe('failed')
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(mockNetworkingApi.listNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('marks stdio transport workloads active after successful HCC delegation', async () => {
    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          contextRef: 'context1',
          workloads: [
            {
              id: 'calculator',
              type: 'deployment',
              image: 'clerum/mock-stdio-mcp-server:test',
              port: 3000,
              transport: { type: 'stdio' },
            },
          ],
        },
      })
    )

    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(result.phase).toBe('active')
    expect(result.message).toBe('All workloads deployed')
    expect(result.workloadStatuses).toEqual([
      {
        id: 'calculator',
        phase: 'delegated',
        ready: true,
        message: 'HCC manages Deployment',
      },
    ])
  })

  it('rejects workflow specs above configured WRC_MAX_WORKFLOW_STEPS', async () => {
    const limitedReconciler = new WorkflowRecipeReconciler(new k8s.KubeConfig(), {
      ...loadConfig(),
      maxWorkflowSteps: 2,
    })
    const result = await limitedReconciler.reconcile(
      makeRecipe({
        spec: {
          steps: [
            { id: 's1', run: snippetRun() },
            { id: 's2', run: snippetRun() },
            { id: 's3', run: snippetRun() },
          ],
        },
      })
    )

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('WRC_MAX_WORKFLOW_STEPS=2')
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('enforces configured workload limit before deploying non-workflow recipes', async () => {
    const limitedReconciler = new WorkflowRecipeReconciler(new k8s.KubeConfig(), {
      ...loadConfig(),
      workflowMaxWorkloadsPerRecipe: 1,
    })

    const result = await limitedReconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            { id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 },
            { id: 'api', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 },
          ],
        },
      })
    )

    expect(result).toMatchObject({
      phase: 'failed',
      message: 'spec.workloads must contain at most 1 items',
    })
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('enforces configured UI internal egress limit before deploying non-workflow recipes', async () => {
    const limitedReconciler = new WorkflowRecipeReconciler(new k8s.KubeConfig(), {
      ...loadConfig(),
      workflowMaxWorkloadsPerRecipe: 3,
      workflowUiEgressInternalMaxItems: 1,
    })

    const result = await limitedReconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            { id: 'ui', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 },
            { id: 'api', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 },
            { id: 'cache', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 },
          ],
          ui: {
            workloadRef: 'ui',
            port: 8080,
            egress: {
              internal: [
                { workloadRef: 'api', port: 8080 },
                { workloadRef: 'cache', port: 8080 },
              ],
            },
          },
        },
      })
    )

    expect(result).toMatchObject({
      phase: 'failed',
      message: 'spec.ui.egress.internal must contain at most 1 items',
    })
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('creates Deployment for deployment workload', async () => {
    await reconciler.reconcile(makeRecipe())
    expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
  })

  it('creates Service for workloads with port (no transport)', async () => {
    await reconciler.reconcile(makeRecipe())
    expect(mockCoreApi.createNamespacedService).toHaveBeenCalledTimes(1)
  })

  it('delegates Service creation for transport workloads to the MCP namespace', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [
          {
            id: 'mcp',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    await reconciler.reconcile(recipe)
    expect(mockCoreApi.createNamespacedService).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'mcp-server',
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'test-recipe-mcp' }),
        }),
      })
    )
  })

  it('uses create-or-replace pattern on 409 (3.11c)', async () => {
    mockAppsApi.createNamespacedDeployment.mockRejectedValueOnce({ code: 409 })
    await reconciler.reconcile(makeRecipe())
    expect(mockAppsApi.readNamespacedDeployment).toHaveBeenCalled()
    expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalled()
  })

  // ─── Resource Creation ──────────────────────────────────────────

  it('creates resources before workloads (3.11a resources)', async () => {
    const callOrder: string[] = []
    mockCoreApi.createNamespacedSecret.mockImplementation(async () => {
      callOrder.push('secret')
      return {}
    })
    mockCoreApi.createNamespacedConfigMap.mockImplementation(async () => {
      callOrder.push('configmap')
      return {}
    })
    mockAppsApi.createNamespacedDeployment.mockImplementation(async () => {
      callOrder.push('deployment')
      return {}
    })

    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'app:latest', port: 8080 }],
        resources: [
          { id: 'creds', type: 'secret', data: { key: 'val' } },
          { id: 'cfg', type: 'configmap', data: { k: 'v' } },
        ],
      },
    })
    await reconciler.reconcile(recipe)
    expect(callOrder.indexOf('secret')).toBeLessThan(callOrder.indexOf('deployment'))
    expect(callOrder.indexOf('configmap')).toBeLessThan(callOrder.indexOf('deployment'))
  })

  it('creates PVC before workloads', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'app:latest' }],
        resources: [{ id: 'data', type: 'pvc', size: '10Gi' }],
      },
    })
    await reconciler.reconcile(recipe)
    expect(mockCoreApi.createNamespacedPersistentVolumeClaim).toHaveBeenCalled()
  })

  // ─── Delete Pipeline ──────────────────────────────────────────────

  it('deletes workloads in reverse dependency order on DELETE (3.12a)', async () => {
    const deleteOrder: string[] = []
    mockAppsApi.deleteNamespacedDeployment.mockImplementation(async (args: { name: string }) => {
      deleteOrder.push(args.name)
      return {}
    })

    const recipe = makeRecipe({
      spec: {
        workloads: [
          { id: 'db', type: 'deployment', image: 'pg:15' },
          { id: 'app', type: 'deployment', image: 'app:latest', dependsOn: ['db'] },
        ],
      },
    })
    await reconciler.reconcileDelete(recipe)
    // app depends on db, so app deleted first (reverse order)
    expect(deleteOrder[0]).toBe('app')
    expect(deleteOrder[1]).toBe('db')
  })

  it('reconcileDelete prunes WRC internal-dependency policies across WRC namespaces', async () => {
    mockNetworkingApi.listNamespacedNetworkPolicy.mockImplementation(
      ({ namespace }: { namespace: string }) =>
        Promise.resolve({
          items:
            namespace === 'sandbox-recipes'
              ? [{ metadata: { name: 'wr-intdep-ingress-test-recipe-db' } }]
              : namespace === 'mcp-server'
                ? [{ metadata: { name: 'wr-intdep-egress-test-recipe-mcp-recap' } }]
                : namespace === 'sandbox-ui'
                  ? [{ metadata: { name: 'wr-intdep-egress-test-recipe-ui-drift' } }]
                  : [],
        })
    )
    const recipe = makeRecipe({
      spec: {
        workloads: [
          {
            id: 'mcp-recap',
            type: 'deployment',
            image: 'mcp:test',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
          { id: 'db', type: 'deployment', image: 'postgres:16', port: 5432 },
        ],
      },
    })

    await reconciler.reconcileDelete(recipe)

    expect(mockNetworkingApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
      namespace: 'sandbox-recipes',
      labelSelector:
        'clerum.io/managed-by=workflow-recipes,clerum.io/policy-type=internal-dependency,clerum.io/recipe=test-recipe',
    })
    expect(mockNetworkingApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
      namespace: 'mcp-server',
      labelSelector:
        'clerum.io/managed-by=workflow-recipes,clerum.io/policy-type=internal-dependency,clerum.io/recipe=test-recipe',
    })
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: 'wr-intdep-ingress-test-recipe-db',
      namespace: 'sandbox-recipes',
    })
    expect(mockNetworkingApi.listNamespacedNetworkPolicy).toHaveBeenCalledWith({
      namespace: 'sandbox-ui',
      labelSelector:
        'clerum.io/managed-by=workflow-recipes,clerum.io/policy-type=internal-dependency,clerum.io/recipe=test-recipe',
    })
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: 'wr-intdep-egress-test-recipe-mcp-recap',
      namespace: 'mcp-server',
    })
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: 'wr-intdep-egress-test-recipe-ui-drift',
      namespace: 'sandbox-ui',
    })
  })

  it('does NOT delete PVCs on DELETE (Risk 3.12) (3.12b)', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'app:latest' }],
        resources: [
          { id: 'data', type: 'pvc', size: '10Gi' },
          { id: 'creds', type: 'secret', data: { k: 'v' } },
        ],
      },
    })
    await reconciler.reconcileDelete(recipe)
    expect(mockCoreApi.deleteNamespacedSecret).toHaveBeenCalled()
    // PVCs are retained — only Secrets/ConfigMaps are deleted on recipe deletion
  })

  it('does not delete parent-owned resources copied into child WorkflowRecipes', async () => {
    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        labels: { 'clerum.io/parent-recipe': 'parent-recipe' },
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'app:latest' }],
        resources: [
          { id: 'creds', type: 'secret', data: { k: 'v' } },
          { id: 'cfg', type: 'configmap', data: { mode: 'test' } },
        ],
      },
    })

    await reconciler.reconcileDelete(recipe)

    expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalled()
    expect(mockCoreApi.deleteNamespacedSecret).not.toHaveBeenCalled()
    expect(mockCoreApi.deleteNamespacedConfigMap).not.toHaveBeenCalled()
  })

  // ─── Error Handling ───────────────────────────────────────────────

  // ─── Defense-in-depth: namespace allowlist (pre-admission drift) ──

  it('refuses to reconcile recipe in foreign namespace (not in allowlist)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'hostile-recipe', namespace: 'kube-system', uid: 'uid-x' },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('failed')
    expect(result.message).toContain('kube-system')
    expect(result.message).toContain('allowlist')
    expect(result.skipStatusPatch).toBe(true)
    expect(result.workloadStatuses).toEqual([])
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(mockCustomApi.patchNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('refuses WorkflowRecipe CRDs outside sandbox-recipes', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'mcp-recipe', namespace: 'mcp-server', uid: 'uid-mcp' },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('failed')
    expect(result.message).toContain('mcp-server')
    expect(result.message).toContain('allowlist')
    expect(result.skipStatusPatch).toBe(true)
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('allows reconcile in sandbox-recipes namespace (allowlist member)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'sandbox-recipe', namespace: 'sandbox-recipes', uid: 'uid-sb' },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('active')
  })

  it('returns failed phase when validation fails (3.15a)', async () => {
    const recipe = makeRecipe({
      spec: { workloads: [] }, // empty workloads
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('failed')
    expect(result.message).toContain('at least one workload')
  })

  it('returns failed phase for duplicate workload IDs (3.15b)', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [
          { id: 'app', type: 'deployment', image: 'a:1' },
          { id: 'app', type: 'deployment', image: 'a:2' },
        ],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('failed')
    expect(result.message).toContain('unique')
  })

  it('returns failed phase when a binding references an unknown workload', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp-api',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
        bindings: [{ from: 'mcp-api', to: 'missing-db', port: 5432 }],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('missing-db')
  })

  it('returns failed phase when a binding does not connect exactly one transport workload', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [
          { id: 'app', type: 'deployment', image: 'app:latest', port: 8080 },
          { id: 'db', type: 'statefulset', image: 'postgres:16', port: 5432 },
        ],
        bindings: [{ from: 'app', to: 'db', port: 5432 }],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('exactly one MCP transport workload')
  })

  it('returns failed phase when a binding connects two transport workloads', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp-a',
            type: 'deployment',
            image: 'mcp-a:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
          {
            id: 'mcp-b',
            type: 'deployment',
            image: 'mcp-b:latest',
            port: 3001,
            transport: { type: 'streamableHttp' },
          },
        ],
        bindings: [{ from: 'mcp-a', to: 'mcp-b', port: 3001 }],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('exactly one MCP transport workload')
  })

  it('returns failed phase when a workload egress binding uses CIDR notation', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'agent',
            type: 'deployment',
            image: 'agent:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
            egressBindings: [{ dns: '0.0.0.0/0', port: 443 }],
          },
        ],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('CIDR')
  })

  it('returns failed phase when a non-transport workload declares public-web egressBindings', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'worker',
            type: 'deployment',
            image: 'worker:latest',
            port: 8080,
            egressBindings: [{ egressClass: 'public-web' }],
          },
        ],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('public-web is only supported on MCP transport workloads')
  })

  it('creates workload egress policy for non-transport exact-host egressBindings', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'worker',
            type: 'deployment',
            image: 'worker:latest',
            port: 8080,
            egressBindings: [{ dns: 'api.example.com', port: 443 }],
          },
        ],
      },
    })
    const reconcilerWithLookup = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
      fqdnLookup: async () => ({ kind: 'ok', ipv4: ['93.184.216.10'], ipv6: [], ttlSeconds: 300 }),
    })

    const result = await reconcilerWithLookup.reconcile(recipe)

    expect(result.phase).toBe('active')
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'sandbox-recipes',
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'wl-egress-test-recipe-worker' }),
        }),
      })
    )
  })

  it('fails non-transport external egress in required mode when cluster enforcement is not confirmed', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'worker',
            type: 'deployment',
            image: 'worker:latest',
            port: 8080,
            egressBindings: [{ dns: 'api.example.com', port: 443 }],
          },
        ],
      },
    })
    const unconfirmedReconciler = new WorkflowRecipeReconciler(
      new k8s.KubeConfig(),
      {
        ...loadConfig(),
        networkPolicyEnforcementMode: 'required',
        networkPolicyEnforcementConfirmed: false,
      },
      {
        fqdnLookup: async () => ({
          kind: 'ok',
          ipv4: ['93.184.216.10'],
          ipv6: [],
          ttlSeconds: 300,
        }),
      }
    )

    const result = await unconfirmedReconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED')
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'sandbox-recipes',
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'wl-egress-test-recipe-worker' }),
        }),
      })
    )
  })

  it('fails closed when non-transport exact-host egress resolves to a blocked address', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'worker',
            type: 'deployment',
            image: 'worker:latest',
            port: 8080,
            egressBindings: [{ dns: 'api.example.com', port: 443 }],
          },
        ],
      },
    })
    const reconcilerWithLookup = new WorkflowRecipeReconciler(new k8s.KubeConfig(), undefined, {
      fqdnLookup: async () => ({
        kind: 'ok',
        ipv4: ['169.254.169.254'],
        ipv6: [],
        ttlSeconds: 300,
      }),
    })

    const result = await reconcilerWithLookup.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('resolved to blocked IPv4 address')
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'sandbox-recipes',
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'wl-egress-test-recipe-worker' }),
        }),
      })
    )
  })

  it('returns failed phase when a workload egress binding uses wildcard DNS', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'agent',
            type: 'deployment',
            image: 'agent:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
            egressBindings: [{ dns: '*.internal.local', port: 443 }],
          },
        ],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('wildcard')
  })

  it('returns failed phase when a workload egress binding targets internal DNS', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'agent',
            type: 'deployment',
            image: 'agent:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
            egressBindings: [{ dns: 'kubernetes.default.svc', port: 443 }],
          },
        ],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('public DNS hostname')
  })

  it('returns failed phase when a workload egress binding includes a port in dns', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'agent',
            type: 'deployment',
            image: 'agent:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
            egressBindings: [{ dns: 'api.example.com:443', port: 443 }],
          },
        ],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('must not include a port')
  })

  it('returns failed phase when a workload egress binding is not lowercase DNS', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'agent',
            type: 'deployment',
            image: 'agent:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
            egressBindings: [{ dns: 'API.example.com', port: 443 }],
          },
        ],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('lowercase')
  })

  it('returns failed phase when a workload egress binding smuggles a cidr field', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'agent',
            type: 'deployment',
            image: 'agent:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
            egressBindings: [
              {
                dns: 'api.openai.com',
                port: 443,
                cidr: '10.0.0.0/8',
              } as unknown as NonNullable<
                NonNullable<WorkflowRecipeCRD['spec']['workloads']>[number]['egressBindings']
              >[number],
            ],
          },
        ],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('cidr is not allowed')
  })

  it('handles partial failure (some workloads fail) (3.15c)', async () => {
    mockAppsApi.createNamespacedDeployment
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('quota exceeded'))

    const recipe = makeRecipe({
      spec: {
        workloads: [
          { id: 'db', type: 'deployment', image: 'pg:15' },
          { id: 'app', type: 'deployment', image: 'app:latest', dependsOn: ['db'] },
        ],
      },
      status: { phase: 'approved' },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.workloadStatuses[0].ready).toBe(true)
    expect(result.workloadStatuses[1].ready).toBe(false)
    expect(result.phase).toBe('degraded')
  })

  it('handles StatefulSet workload type', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'pg', type: 'statefulset', image: 'pg:15', port: 5432 }],
      },
    })
    await reconciler.reconcile(recipe)
    expect(mockAppsApi.createNamespacedStatefulSet).toHaveBeenCalled()
    // Headless service also created
    expect(mockCoreApi.createNamespacedService).toHaveBeenCalled()
  })

  it('persists scoped workload instances for catalog recipes before materialization', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'catalog-recipe', namespace: 'sandbox-recipes', uid: 'uid-catalog' },
      spec: {
        workloads: [
          { id: 'api', type: 'deployment', image: 'api:latest', port: 8080 },
          { id: 'db', type: 'statefulset', image: 'postgres:16', port: 5432 },
        ],
      },
      status: { phase: 'approved' },
    })

    await reconciler.reconcile(recipe)

    const expectedApi = resolveScopedWorkloadResourceName(recipe, 'api')
    const expectedDb = resolveScopedStatefulSetResourceName(recipe, 'db')
    expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          status: {
            workloadInstances: { api: expectedApi, db: expectedDb },
          },
        },
      }),
      expect.anything()
    )
    expect(mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body.metadata.name).toBe(
      expectedApi
    )
    expect(mockAppsApi.createNamespacedStatefulSet.mock.calls[0][0].body.metadata.name).toBe(
      expectedDb
    )
    expect(
      mockCoreApi.createNamespacedService.mock.calls.some(
        ([arg]) => arg.body.metadata.name === expectedApi
      )
    ).toBe(true)
  })

  it('reuses persisted workload instances without overwriting them', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'catalog-recipe', namespace: 'sandbox-recipes', uid: 'uid-catalog' },
      spec: {
        workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }],
      },
      status: { phase: 'active', workloadInstances: { api: 'stable-api-name' } },
    })

    await reconciler.reconcile(recipe)

    const workloadInstancePatches =
      mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.filter(
        ([arg]) => arg.body?.status?.workloadInstances
      )
    expect(workloadInstancePatches).toHaveLength(0)
    expect(mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body.metadata.name).toBe(
      'stable-api-name'
    )
  })

  it('does not persist generated workload instances for dry-run previews', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'dry-run-recipe', namespace: 'sandbox-recipes', uid: 'uid-dry-run' },
      spec: {
        dryRun: true,
        workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }],
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    const workloadInstancePatches =
      mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.filter(
        ([arg]) => arg.body?.status?.workloadInstances
      )
    expect(result.phase).toBe('candidate')
    expect(workloadInstancePatches).toHaveLength(0)
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('re-scopes raw Deployment names for active catalog recipes (issue #571 migration)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'existing-catalog', namespace: 'sandbox-recipes', uid: 'uid-existing' },
      spec: {
        workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }],
      },
      status: { phase: 'active' },
    })
    const scoped = resolveScopedWorkloadResourceName(recipe, 'api')

    await reconciler.reconcile(recipe)

    // Migration: the legacy raw "api" name is no longer adopted — the workload is
    // re-scoped and the scoped name is persisted in status.workloadInstances.
    expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          status: {
            workloadInstances: { api: scoped },
          },
        },
      }),
      expect.anything()
    )
    expect(scoped).not.toBe('api')
    expect(mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body.metadata.name).toBe(scoped)
    expect(
      mockCoreApi.createNamespacedService.mock.calls.some(
        ([arg]) => arg.body.metadata.name === scoped
      )
    ).toBe(true)
  })

  it('defers legacy raw StatefulSet cleanup until scoped PVC migration is ready on a later reconcile', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'existing-db', namespace: 'sandbox-recipes', uid: 'uid-existing-db' },
      spec: {
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            port: 5432,
            volumeClaimTemplates: [
              {
                name: 'pgdata',
                size: '10Gi',
                accessMode: 'ReadWriteOnce',
                storageClass: 'standard',
              },
            ],
          },
        ],
      },
      status: { phase: 'active' },
    })
    const expectedDb = resolveScopedStatefulSetResourceName(recipe, 'db')

    // Raw "db" exists and is owned by this recipe; the scoped workload is not ready
    // yet → cleanup must defer. Reads carry the clerum.io/recipe ownership label so
    // the owned-probe recognizes them (issue #571 S2).
    mockAppsApi.readNamespacedStatefulSet.mockImplementation(({ name }) =>
      Promise.resolve({
        metadata: { resourceVersion: '1', labels: { 'clerum.io/recipe': 'existing-db' } },
        spec: { replicas: 1 },
        status: { readyReplicas: name === 'db' ? 1 : 0 },
      })
    )
    mockCoreApi.readNamespacedService.mockResolvedValue({
      metadata: { resourceVersion: '1', labels: { 'clerum.io/recipe': 'existing-db' } },
      spec: { clusterIP: '10.0.0.1' },
    })

    const firstResult = await reconciler.reconcile(recipe)

    expect(firstResult.requeueAfterMs).toBeGreaterThan(0)
    expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          status: {
            workloadInstances: { db: expectedDb },
          },
        },
      }),
      expect.anything()
    )
    expect(mockAppsApi.createNamespacedStatefulSet.mock.calls[0][0].body.metadata.name).toBe(
      expectedDb
    )
    expect(mockAppsApi.deleteNamespacedStatefulSet).not.toHaveBeenCalled()
    expect(mockCoreApi.deleteNamespacedService).not.toHaveBeenCalled()

    vi.clearAllMocks()

    // Second reconcile: scoped workload now ready, raw "db" still present and owned →
    // teardown fires. Re-establish owned reads after clearAllMocks.
    mockAppsApi.readNamespacedStatefulSet.mockResolvedValue({
      metadata: { resourceVersion: '1', labels: { 'clerum.io/recipe': 'existing-db' } },
      spec: { replicas: 1 },
      status: { readyReplicas: 1 },
    })
    mockCoreApi.readNamespacedService.mockResolvedValue({
      metadata: { resourceVersion: '1', labels: { 'clerum.io/recipe': 'existing-db' } },
      spec: { clusterIP: '10.0.0.1' },
    })

    await reconciler.reconcile(recipe)

    expect(mockAppsApi.deleteNamespacedStatefulSet).toHaveBeenCalledWith({
      name: 'db',
      namespace: 'sandbox-recipes',
    })
    const deletedServices = mockCoreApi.deleteNamespacedService.mock.calls.map(([arg]) => arg.name)
    expect(deletedServices).toEqual(expect.arrayContaining(['db-headless', 'db']))
    expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
  })

  it('skips legacy raw StatefulSet cleanup deletes once raw runtime resources are gone', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'existing-db', namespace: 'sandbox-recipes', uid: 'uid-existing-db' },
      spec: {
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            port: 5432,
            volumeClaimTemplates: [
              {
                name: 'pgdata',
                size: '10Gi',
                accessMode: 'ReadWriteOnce',
                storageClass: 'standard',
              },
            ],
          },
        ],
      },
      status: {
        phase: 'active',
        workloadInstances: {
          db: 'existing-db-db-14b8a457',
        },
      },
    })

    mockAppsApi.readNamespacedStatefulSet.mockImplementation(({ name }) => {
      if (name === 'db') return Promise.reject({ code: 404 })
      return Promise.resolve({
        metadata: { resourceVersion: '1' },
        spec: { replicas: 1 },
        status: { readyReplicas: 1 },
      })
    })
    mockCoreApi.readNamespacedService.mockImplementation(({ name }) => {
      if (name === 'db' || name === 'db-headless') return Promise.reject({ code: 404 })
      return Promise.resolve({
        metadata: { resourceVersion: '1' },
        spec: { clusterIP: '10.0.0.1' },
      })
    })

    await reconciler.reconcile(recipe)

    expect(mockAppsApi.deleteNamespacedStatefulSet).not.toHaveBeenCalled()
    expect(mockCoreApi.deleteNamespacedService).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'db-headless' })
    )
    expect(mockCoreApi.deleteNamespacedService).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'db' })
    )
    expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
  })

  it('defers legacy raw Deployment cleanup until the scoped workload is ready (issue #571)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'existing-api', namespace: 'sandbox-recipes', uid: 'uid-existing-api' },
      spec: { workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }] },
      status: { phase: 'active' },
    })
    const scoped = resolveScopedWorkloadResourceName(recipe, 'api')

    // Scoped workload not ready yet → tearing down the raw "api" must be deferred.
    // The raw Deployment carries this recipe's ownership label so cleanup recognizes
    // it as its own (issue #571 F2).
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: {
        resourceVersion: '1',
        generation: 1,
        labels: { 'clerum.io/recipe': 'existing-api' },
      },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 0, availableReplicas: 0 },
    })

    const firstResult = await reconciler.reconcile(recipe)

    expect(firstResult.requeueAfterMs).toBeGreaterThan(0)
    expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({ body: { status: { workloadInstances: { api: scoped } } } }),
      expect.anything()
    )
    expect(mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body.metadata.name).toBe(scoped)
    expect(mockAppsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('deletes the legacy raw Deployment once the scoped workload is ready (issue #571)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'existing-api', namespace: 'sandbox-recipes', uid: 'uid-existing-api' },
      spec: { workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }] },
      status: { phase: 'active' },
    })
    const scoped = resolveScopedWorkloadResourceName(recipe, 'api')

    // Scoped workload ready and a raw "api" still present (owned by this recipe) →
    // migrate by deleting it (issue #571 F2 ownership-gated).
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: {
        resourceVersion: '1',
        generation: 1,
        labels: { 'clerum.io/recipe': 'existing-api' },
      },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
    })

    await reconciler.reconcile(recipe)

    expect(scoped).not.toBe('api')
    expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
      name: 'api',
      namespace: 'sandbox-recipes',
    })
  })

  it('does NOT delete a raw Deployment owned by a different recipe during migration (issue #571 F2)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'existing-api', namespace: 'sandbox-recipes', uid: 'uid-existing-api' },
      spec: { workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }] },
      status: { phase: 'active' },
    })

    // A raw "api" Deployment exists but is owned by ANOTHER recipe → must be left alone.
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: {
        resourceVersion: '1',
        generation: 1,
        labels: { 'clerum.io/recipe': 'some-other-recipe' },
      },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
    })

    await reconciler.reconcile(recipe)

    expect(mockAppsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('does NOT re-scope a Deployment that mounts a recipe PVC — avoids RWO deadlock (issue #571 B1)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'stateful-dep', namespace: 'sandbox-recipes', uid: 'uid-stateful-dep' },
      spec: {
        workloads: [
          {
            id: 'api',
            type: 'deployment',
            image: 'api:latest',
            port: 8080,
            volumeMounts: [{ name: 'data', mountPath: '/data' }],
          },
        ],
        resources: [{ id: 'data', type: 'pvc', size: '1Gi' }],
      },
      status: { phase: 'active' },
    })

    // The raw "api" Deployment exists and is owned by this recipe → adopted (not
    // re-scoped) because it mounts a PVC (issue #571 B1 + S1 ownership gate).
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: {
        resourceVersion: '1',
        generation: 1,
        labels: { 'clerum.io/recipe': 'stateful-dep' },
      },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
    })

    await reconciler.reconcile(recipe)

    // PVC-mounting Deployment keeps the raw name (adopted), so the scoped Deployment
    // is never created and no cleanup/deletion is attempted.
    const createdNames = mockAppsApi.createNamespacedDeployment.mock.calls.map(
      ([arg]) => arg.body.metadata.name
    )
    expect(createdNames).toContain('api')
    expect(mockAppsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('keeps requeueing deferred legacy cleanup when only legacy Services remain', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'existing-db', namespace: 'sandbox-recipes', uid: 'uid-existing-db' },
      spec: {
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            port: 5432,
            volumeClaimTemplates: [
              {
                name: 'pgdata',
                size: '10Gi',
                accessMode: 'ReadWriteOnce',
                storageClass: 'standard',
              },
            ],
          },
        ],
      },
      status: {
        phase: 'active',
        workloadInstances: {
          db: 'existing-db-db-14b8a457',
        },
      },
    })

    mockAppsApi.readNamespacedStatefulSet.mockImplementation(({ name }) => {
      if (name === 'db') return Promise.reject({ code: 404 })
      return Promise.resolve({
        metadata: { resourceVersion: '1' },
        spec: { replicas: 1 },
        status: { readyReplicas: 0 },
      })
    })
    mockCoreApi.readNamespacedService.mockImplementation(({ name }) => {
      if (name === 'db-headless') {
        return Promise.resolve({
          metadata: { name, resourceVersion: '1', labels: { 'clerum.io/recipe': 'existing-db' } },
          spec: { clusterIP: 'None' },
        })
      }
      return Promise.reject({ code: 404 })
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.requeueAfterMs).toBeGreaterThan(0)
    expect(mockAppsApi.deleteNamespacedStatefulSet).not.toHaveBeenCalled()
    expect(mockCoreApi.deleteNamespacedService).not.toHaveBeenCalled()
    expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
  })

  it('continues legacy raw StatefulSet cleanup when only legacy Services remain', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'existing-db', namespace: 'sandbox-recipes', uid: 'uid-existing-db' },
      spec: {
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            port: 5432,
            volumeClaimTemplates: [
              {
                name: 'pgdata',
                size: '10Gi',
                accessMode: 'ReadWriteOnce',
                storageClass: 'standard',
              },
            ],
          },
        ],
      },
      status: {
        phase: 'active',
        workloadInstances: {
          db: 'existing-db-db-14b8a457',
        },
      },
    })

    mockAppsApi.readNamespacedStatefulSet.mockImplementation(({ name }) => {
      if (name === 'db') return Promise.reject({ code: 404 })
      return Promise.resolve({
        metadata: { resourceVersion: '1' },
        spec: { replicas: 1 },
        status: { readyReplicas: 1 },
      })
    })
    mockCoreApi.readNamespacedService.mockImplementation(({ name }) => {
      if (name === 'db-headless') {
        return Promise.resolve({
          metadata: { name, resourceVersion: '1', labels: { 'clerum.io/recipe': 'existing-db' } },
          spec: { clusterIP: 'None' },
        })
      }
      if (name === 'db') {
        return Promise.resolve({
          metadata: { name, resourceVersion: '1', labels: { 'clerum.io/recipe': 'existing-db' } },
          spec: { clusterIP: '10.0.0.1' },
        })
      }
      return Promise.reject({ code: 404 })
    })

    await reconciler.reconcile(recipe)

    // The raw StatefulSet is already gone (404) → its delete is correctly skipped
    // (ownership-gated, per-resource; issue #571 S2). The lingering owned Services
    // are still torn down.
    expect(mockAppsApi.deleteNamespacedStatefulSet).not.toHaveBeenCalled()
    const deletedServices = mockCoreApi.deleteNamespacedService.mock.calls.map(([arg]) => arg.name)
    expect(deletedServices).toEqual(expect.arrayContaining(['db-headless', 'db']))
    expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
  })

  it('does NOT adopt a raw StatefulSet owned by another recipe — uses scoped name (issue #571 S1)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'sts-recipe', namespace: 'sandbox-recipes', uid: 'uid-sts' },
      spec: { workloads: [{ id: 'db', type: 'statefulset', image: 'postgres:16', port: 5432 }] },
      status: { phase: 'active' },
    })
    const scoped = resolveScopedStatefulSetResourceName(recipe, 'db')

    // A raw "db" StatefulSet exists but is owned by ANOTHER recipe → never adopted.
    mockAppsApi.readNamespacedStatefulSet.mockResolvedValue({
      metadata: { resourceVersion: '1', labels: { 'clerum.io/recipe': 'some-other-recipe' } },
      spec: { replicas: 1 },
      status: { readyReplicas: 1 },
    })

    await reconciler.reconcile(recipe)

    expect(scoped).not.toBe('db')
    expect(mockCustomApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      expect.objectContaining({ body: { status: { workloadInstances: { db: scoped } } } }),
      expect.anything()
    )
  })

  it('does NOT delete a raw StatefulSet owned by another recipe during cleanup (issue #571 S2)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'sts-recipe', namespace: 'sandbox-recipes', uid: 'uid-sts' },
      spec: {
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            port: 5432,
            volumeClaimTemplates: [
              {
                name: 'pgdata',
                size: '1Gi',
                accessMode: 'ReadWriteOnce',
                storageClass: 'standard',
              },
            ],
          },
        ],
      },
      status: { phase: 'active' },
    })

    // Raw "db" StatefulSet + Services exist but owned by ANOTHER recipe → left alone.
    mockAppsApi.readNamespacedStatefulSet.mockResolvedValue({
      metadata: { resourceVersion: '1', labels: { 'clerum.io/recipe': 'some-other-recipe' } },
      spec: { replicas: 1 },
      status: { readyReplicas: 1 },
    })
    mockCoreApi.readNamespacedService.mockResolvedValue({
      metadata: { resourceVersion: '1', labels: { 'clerum.io/recipe': 'some-other-recipe' } },
      spec: { clusterIP: '10.0.0.1' },
    })

    await reconciler.reconcile(recipe)

    expect(mockAppsApi.deleteNamespacedStatefulSet).not.toHaveBeenCalled()
  })

  it('does NOT probe legacy raw workloads for a fresh non-legacy-phase recipe (mayHaveLegacyRawWorkloads short-circuit)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'fresh-recipe', namespace: 'sandbox-recipes', uid: 'uid-fresh' },
      spec: { workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }] },
      status: { phase: 'approved' }, // non-legacy phase → cleanup must short-circuit
    })

    await reconciler.reconcile(recipe)

    // The cleanup short-circuit must skip the legacy-raw ownership probe entirely:
    // the RAW workload name "api" is never read (only the scoped name is, for
    // readiness). Mutating mayHaveLegacyRawWorkloads to `return true` would make
    // this probe fire and fail the assertion.
    const rawDeploymentReads = mockAppsApi.readNamespacedDeployment.mock.calls.filter(
      ([arg]) => arg.name === 'api'
    )
    expect(rawDeploymentReads).toHaveLength(0)
  })

  it('does NOT migrate-probe workloads of a workflow recipe (mayHaveLegacyRawWorkloads short-circuit)', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'wf-recipe', namespace: 'sandbox-recipes', uid: 'uid-wf' },
      spec: {
        workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }],
        steps: [{ id: 'step-1', instruction: 'do something' }],
      },
      status: { phase: 'active' },
    })

    await reconciler.reconcile(recipe).catch(() => undefined)

    // A workflow recipe never had raw-named workloads → no raw-name teardown probe.
    const rawDeploymentReads = mockAppsApi.readNamespacedDeployment.mock.calls.filter(
      ([arg]) => arg.name === 'api'
    )
    expect(rawDeploymentReads).toHaveLength(0)
    expect(mockAppsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('refuses to mount an existing StatefulSet PVC owned by another recipe', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'leadforge', namespace: 'sandbox-recipes', uid: 'uid-leadforge' },
      spec: {
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            volumeClaimTemplates: [
              {
                name: 'pgdata',
                size: '10Gi',
                accessMode: 'ReadWriteOnce',
                storageClass: 'standard',
              },
            ],
          },
        ],
      },
      status: { phase: 'approved' },
    })
    const expectedSts = resolveScopedStatefulSetResourceName(recipe, 'db')
    mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValueOnce({
      metadata: {
        name: 'pgdata-' + expectedSts + '-0',
        labels: { 'clerum.io/recipe': 'recipe-sales-crm', 'clerum.io/workload': 'db' },
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(mockCoreApi.readNamespacedPersistentVolumeClaim).toHaveBeenCalledWith({
      name: 'pgdata-' + expectedSts + '-0',
      namespace: 'sandbox-recipes',
    })
    expect(mockAppsApi.createNamespacedStatefulSet).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedService).not.toHaveBeenCalled()
    expect(result.phase).toBe('degraded')
    expect(result.workloadStatuses).toEqual([
      expect.objectContaining({
        id: 'db',
        phase: 'failed',
        ready: false,
        message: expect.stringContaining('belongs to recipe "recipe-sales-crm" workload "db"'),
      }),
    ])
  })

  it('allows an existing StatefulSet PVC when recipe and workload labels match', async () => {
    const recipe = makeRecipe({
      metadata: { name: 'leadforge', namespace: 'sandbox-recipes', uid: 'uid-leadforge' },
      spec: {
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            volumeClaimTemplates: [
              {
                name: 'pgdata',
                size: '10Gi',
                accessMode: 'ReadWriteOnce',
                storageClass: 'standard',
              },
            ],
          },
        ],
      },
      status: { phase: 'approved' },
    })
    const expectedSts = resolveScopedStatefulSetResourceName(recipe, 'db')
    mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValueOnce({
      metadata: {
        name: 'pgdata-' + expectedSts + '-0',
        labels: { 'clerum.io/recipe': 'leadforge', 'clerum.io/workload': 'db' },
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('active')
    expect(mockAppsApi.createNamespacedStatefulSet).toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedStatefulSet.mock.calls[0][0].body.metadata.name).toBe(
      expectedSts
    )
  })

  it('uses the clamped CronJob runtime name for create and observe paths', async () => {
    const workload: CronJobDef = {
      id: 'prospector-enrich-cron',
      type: 'cronjob',
      image: 'pg:15',
      schedule: '0 2 * * *',
    }
    const recipe = makeRecipe({
      metadata: {
        name: 'recipe-leadforge-app-v1-1-17-4a09ccfe',
        namespace: 'sandbox-recipes',
        uid: 'long-cronjob-uid',
      },
      spec: {
        workloads: [workload],
      },
      status: {
        phase: 'approved',
        workloadInstances: {
          [workload.id]: 'recipe-leadforge-app-v1-1-17-4a-prospector-enrich-cron-22afc990',
        },
      },
    })
    const expectedName = resolveWorkloadRuntimeResourceName(recipe, workload)

    await reconciler.reconcile(recipe)

    expect(expectedName.length).toBeLessThanOrEqual(52)
    expect(mockBatchApi.createNamespacedCronJob).toHaveBeenCalledWith({
      namespace: 'sandbox-recipes',
      body: expect.objectContaining({
        metadata: expect.objectContaining({ name: expectedName }),
      }),
    })
    expect(mockBatchApi.readNamespacedCronJob).toHaveBeenCalledWith({
      name: expectedName,
      namespace: 'sandbox-recipes',
    })
  })

  it('persists the clamped CronJob workload instance before materialization', async () => {
    const workload: CronJobDef = {
      id: 'prospector-enrich-cron',
      type: 'cronjob',
      image: 'pg:15',
      schedule: '0 2 * * *',
    }
    const recipe = makeRecipe({
      metadata: {
        name: 'recipe-leadforge-app-v1-1-17-4a09ccfe',
        namespace: 'sandbox-recipes',
        uid: 'long-cronjob-uid',
      },
      spec: {
        workloads: [workload],
      },
      status: { phase: 'approved' },
    })

    await reconciler.reconcile(recipe)

    const statusPatchCall = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.find(
      ([arg]) => arg.body?.status?.workloadInstances?.[workload.id]
    )
    expect(statusPatchCall).toBeDefined()
    const persistedName = statusPatchCall![0].body.status.workloadInstances[workload.id]

    expect(persistedName.length).toBeLessThanOrEqual(52)
    expect(mockBatchApi.createNamespacedCronJob).toHaveBeenCalledWith({
      namespace: 'sandbox-recipes',
      body: expect.objectContaining({
        metadata: expect.objectContaining({ name: persistedName }),
      }),
    })
    expect(mockBatchApi.readNamespacedCronJob).toHaveBeenCalledWith({
      name: persistedName,
      namespace: 'sandbox-recipes',
    })
  })

  it('uses the clamped CronJob runtime name for finalizer cleanup', async () => {
    const workload: CronJobDef = {
      id: 'prospector-enrich-cron',
      type: 'cronjob',
      image: 'pg:15',
      schedule: '0 2 * * *',
    }
    const recipe = makeRecipe({
      metadata: {
        name: 'recipe-leadforge-app-v1-1-17-4a09ccfe',
        namespace: 'sandbox-recipes',
        uid: 'long-cronjob-uid',
      },
      spec: {
        workloads: [workload],
      },
      status: {
        phase: 'degraded',
        workloadInstances: {
          [workload.id]: 'recipe-leadforge-app-v1-1-17-4a-prospector-enrich-cron-22afc990',
        },
      },
    })
    const expectedName = resolveWorkloadRuntimeResourceName(recipe, workload)

    await reconciler.reconcileDelete(recipe)

    expect(expectedName.length).toBeLessThanOrEqual(52)
    expect(mockBatchApi.deleteNamespacedCronJob).toHaveBeenCalledWith({
      name: expectedName,
      namespace: 'sandbox-recipes',
      // Issue #637 — Background so the CronJob's child Jobs/Pods are reaped, not orphaned.
      propagationPolicy: 'Background',
    })
  })

  // ─── Phase 6: MCP Delegation Integration ────────────────────────

  it('R.6.1 — transport workload + contextRef triggers delegation', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp-srv',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp', path: '/mcp' },
          },
        ],
      },
    })
    await reconciler.reconcile(recipe)
    // McpServer CRD ensured via customApi (create OR replace depending on pre-check result)
    const mcpEnsured =
      mockCustomApi.createNamespacedCustomObject.mock.calls.length > 0 ||
      mockCustomApi.replaceNamespacedCustomObject.mock.calls.length > 0
    expect(mcpEnsured).toBe(true)
    // Transport Service created
    const svcCalls = mockCoreApi.createNamespacedService.mock.calls
    expect(svcCalls.length).toBeGreaterThanOrEqual(1)
    // H-04: per-recipe Context CRD created (not shared Context patched)
    const contextCreated = mockCustomApi.createNamespacedCustomObject.mock.calls.some(
      (call: unknown[]) => (call[0] as Record<string, unknown>)?.plural === 'contexts'
    )
    expect(contextCreated).toBe(true)
  })

  it('does not materialize workloads when the recipe is deleted during network wait', async () => {
    mockCustomApi.getNamespacedCustomObject
      .mockReset()
      .mockResolvedValueOnce({ metadata: { uid: 'uid-123' } })
      .mockRejectedValueOnce({ code: 404 })
      .mockRejectedValueOnce({ code: 404 })
      .mockRejectedValueOnce({ code: 404 })

    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp-srv',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp', path: '/mcp' },
          },
        ],
      },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.skipStatusPatch).toBe(true)
    expect(result.message).toContain('Recipe deleted during reconcile')
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedService).not.toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'sandbox-recipes' })
    )
  })

  it('R.6.2 — transport workload without contextRef delegates using private workflow context', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [
          {
            id: 'mcp',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('active')
    const mcpServerCall =
      mockCustomApi.createNamespacedCustomObject.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>)?.plural === 'mcpservers'
      ) ??
      mockCustomApi.replaceNamespacedCustomObject.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>)?.plural === 'mcpservers'
      )
    expect(mcpServerCall).toBeDefined()
    expect((mcpServerCall![0].body.spec as Record<string, unknown>).contextRef).toBe(
      'wf-test-recipe'
    )
    const contextCreate =
      mockCustomApi.createNamespacedCustomObject.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>)?.plural === 'contexts'
      ) ??
      mockCustomApi.replaceNamespacedCustomObject.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>)?.plural === 'contexts'
      )
    expect(contextCreate).toBeDefined()
    expect((contextCreate![0].body.spec as Record<string, unknown>).contextId).toBe(
      'wf-test-recipe'
    )
  })

  it('R.6.3 — transport workload without port fails validation', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp',
            type: 'deployment',
            image: 'mcp:latest',
            transport: { type: 'sse' },
          },
        ],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('failed')
    expect(result.message).toContain('port')
  })

  it('R.6.4 — transport pre-deploy failure degrades (retryable) instead of latching failed', async () => {
    // The pre-deploy McpServer handshake is an eventually-consistent wait on
    // HCC. A failure means HCC has not caught up, NOT that the recipe is
    // broken — so it must degrade + retry, never brick at terminal `failed`.
    mockCustomApi.replaceNamespacedCustomObject.mockRejectedValueOnce(new Error('API unavailable'))
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('degraded')
    expect(result.message).toContain('Pre-deploy failed for WorkflowRecipe "test-recipe"')
    expect(result.message).toContain('child McpServers')
    expect(result.workloadStatuses).toEqual([])
  })

  it('R.6.5 — reconcileDelete calls delegation cleanup for transport workloads', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp-srv',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    await reconciler.reconcileDelete(recipe)
    // McpServer CRD deleted
    expect(mockCustomApi.deleteNamespacedCustomObject).toHaveBeenCalled()
    // Transport Service deleted
    expect(mockCoreApi.deleteNamespacedService).toHaveBeenCalled()
  })

  it('reconcileDelete fails when cross-namespace delegation cleanup cannot verify deletion', async () => {
    mockCustomApi.deleteCollectionNamespacedCustomObject.mockRejectedValueOnce(
      new Error('api down')
    )
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp-srv',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })

    await expect(reconciler.reconcileDelete(recipe)).rejects.toThrow(
      'McpServer label sweep failed: api down'
    )
  })

  // ─── Phase 8: Namespace Splitting ─────────────────────────────────

  it('R.8.1 — non-MCP workload deploys to sandbox-recipes namespace', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'redis', type: 'deployment', image: 'redis:7', port: 6379 }],
      },
    })
    await reconciler.reconcile(recipe)
    const call = mockAppsApi.createNamespacedDeployment.mock.calls[0][0]
    expect(call.namespace).toBe('sandbox-recipes')
    expect(call.body.metadata.namespace).toBe('sandbox-recipes')
  })

  it('R.8.2 — MCP workload stays in mcp-server namespace', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp-srv',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    await reconciler.reconcile(recipe)
    const call = mockAppsApi.createNamespacedDeployment.mock.calls[0][0]
    expect(call.namespace).toBe('mcp-server')
    expect(call.body.metadata.namespace).toBe('mcp-server')
  })

  it('R.8.3 — mixed recipe routes each workload to correct namespace', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          { id: 'redis', type: 'deployment', image: 'redis:7', port: 6379 },
          {
            id: 'redis-mcp',
            type: 'deployment',
            image: 'redis-mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    await reconciler.reconcile(recipe)
    const calls = mockAppsApi.createNamespacedDeployment.mock.calls
    // redis (non-MCP) → sandbox-recipes
    const redisName = resolveScopedWorkloadResourceName(recipe, 'redis')
    const redisCall = calls.find(
      (c: unknown[]) =>
        (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === redisName
    )
    expect(redisCall![0].namespace).toBe('sandbox-recipes')
    // redis-mcp (MCP) → mcp-server
    const mcpName = resolveScopedWorkloadResourceName(recipe, 'redis-mcp')
    const mcpCall = calls.find(
      (c: unknown[]) =>
        (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === mcpName
    )
    expect(mcpCall![0].namespace).toBe('mcp-server')
  })

  it('R.8.4 — sandbox non-MCP workloads keep same-namespace ownerReferences', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'worker', type: 'deployment', image: 'worker:latest' }],
      },
    })
    await reconciler.reconcile(recipe)
    const call = mockAppsApi.createNamespacedDeployment.mock.calls[0][0]
    // Non-MCP workload goes to sandbox-recipes with the WorkflowRecipe CRD.
    expect(call.namespace).toBe('sandbox-recipes')
    expect(call.body.metadata.ownerReferences).toBeDefined()
    expect(call.body.metadata.ownerReferences[0].name).toBe('test-recipe')
  })

  it('R.8.5 — MCP transport workloads strip ownerReferences in mcp-server', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'mcp',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    await reconciler.reconcile(recipe)
    const call = mockAppsApi.createNamespacedDeployment.mock.calls[0][0]
    expect(call.namespace).toBe('mcp-server')
    expect(call.body.metadata.ownerReferences).toBeUndefined()
  })

  it('R.8.6 — Service for non-MCP workload deploys to sandbox-recipes', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }],
      },
    })
    await reconciler.reconcile(recipe)
    const svcCall = mockCoreApi.createNamespacedService.mock.calls[0][0]
    expect(svcCall.namespace).toBe('sandbox-recipes')
  })

  it('R.8.7 — resource follows workload namespace via volumeMount', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [
          {
            id: 'pg',
            type: 'deployment',
            image: 'pg:15',
            volumeMounts: [{ name: 'pg-data', mountPath: '/var/lib/postgresql/data' }],
          },
        ],
        resources: [{ id: 'pg-data', type: 'pvc', size: '10Gi' }],
      },
    })
    await reconciler.reconcile(recipe)
    // PVC should be created in sandbox-recipes (where the non-MCP workload goes)
    const pvcCall = mockCoreApi.createNamespacedPersistentVolumeClaim.mock.calls[0][0]
    expect(pvcCall.namespace).toBe('sandbox-recipes')
  })

  it('R.8.8 — unmounted resource stays in recipe namespace', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'app:latest' }],
        resources: [{ id: 'creds', type: 'secret', data: { key: 'val' } }],
      },
    })
    await reconciler.reconcile(recipe)
    // Secret not mounted by any workload → stays with the recipe runtime.
    const secretCall = mockCoreApi.createNamespacedSecret.mock.calls[0][0]
    expect(secretCall.namespace).toBe('sandbox-recipes')
  })

  it('R.8.9 — reconcileDelete cleans up from correct namespaces', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          { id: 'redis', type: 'deployment', image: 'redis:7', port: 6379 },
          {
            id: 'redis-mcp',
            type: 'deployment',
            image: 'redis-mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    await reconciler.reconcileDelete(recipe)
    const deleteCalls = mockAppsApi.deleteNamespacedDeployment.mock.calls
    // redis (non-MCP) deleted from sandbox-recipes
    const redisDelete = deleteCalls.find(
      (c: unknown[]) => (c[0] as { name: string }).name === 'redis'
    )
    expect(redisDelete![0].namespace).toBe('sandbox-recipes')
    // redis-mcp (MCP) deleted from mcp-server
    const mcpDelete = deleteCalls.find(
      (c: unknown[]) => (c[0] as { name: string }).name === 'redis-mcp'
    )
    expect(mcpDelete![0].namespace).toBe('mcp-server')
  })

  it('R.8.20 — workload referenced by spec.ui.workloadRef deploys to sandbox-ui', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'frontend:1', port: 8080 }],
        ui: { workloadRef: 'frontend', port: 8080 },
      },
    })
    await reconciler.reconcile(recipe)
    const call = mockAppsApi.createNamespacedDeployment.mock.calls[0][0]
    expect(call.namespace).toBe('sandbox-ui')
    expect(call.body.metadata.namespace).toBe('sandbox-ui')
    // Cross-namespace from the WorkflowRecipe CRD (sandbox-recipes), so
    // ownerReferences must be stripped to satisfy the K8s GC invariant.
    expect(call.body.metadata.ownerReferences).toBeUndefined()
  })

  it('R.8.21 — three-way mixed recipe routes UI / sibling / MCP each to their own ns', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          { id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 },
          { id: 'postgres', type: 'deployment', image: 'pg:15', port: 5432 },
          {
            id: 'mcp-srv',
            type: 'deployment',
            image: 'mcp:1',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
        ui: { workloadRef: 'frontend', port: 8080 },
      },
    })
    await reconciler.reconcile(recipe)
    const calls = mockAppsApi.createNamespacedDeployment.mock.calls
    const byName = (name: string) => {
      const runtimeName = resolveScopedWorkloadResourceName(recipe, name)
      return calls.find(
        (c: unknown[]) =>
          (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === runtimeName
      )
    }
    expect(byName('frontend')![0].namespace).toBe('sandbox-ui')
    expect(byName('postgres')![0].namespace).toBe('sandbox-recipes')
    expect(byName('mcp-srv')![0].namespace).toBe('mcp-server')
  })

  it('R.8.22 — Service for the UI workload is created in sandbox-ui', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
        ui: { workloadRef: 'frontend', port: 8080 },
      },
    })
    await reconciler.reconcile(recipe)
    const svcCall = mockCoreApi.createNamespacedService.mock.calls[0][0]
    expect(svcCall.namespace).toBe('sandbox-ui')
  })

  it('R.8.23 — ui-egress NetworkPolicy is created in sandbox-ui when spec.ui is set', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
        ui: {
          workloadRef: 'frontend',
          port: 8080,
          egress: {
            internal: [{ workloadRef: 'postgres', port: 5432 }],
            external: [{ fqdn: 'api.stripe.com', port: 443 }],
          },
        },
      },
    })
    const kc = new k8s.KubeConfig()
    const reconcilerWithLookup = new WorkflowRecipeReconciler(kc, undefined, {
      fqdnLookup: async () => ({ kind: 'ok', ipv4: ['93.184.216.10'], ipv6: [], ttlSeconds: 300 }),
    })
    await reconcilerWithLookup.reconcile(recipe)
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    const npCall = mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls[0][0] as {
      namespace: string
      body: { metadata: { name: string }; spec: { egress: unknown[] } }
    }
    expect(npCall.namespace).toBe('sandbox-ui')
    expect(npCall.body.metadata.name).toBe('ui-egress-test-recipe')
    expect(npCall.body.spec.egress).toHaveLength(2) // internal + external
  })

  // issue #299 — the WRC lane must leave a per-host resolution history.
  //
  // HCC emits `[NetPol] Resolved <fqdn> → [cidrs]` per DNS binding, so its lane
  // replays from retained logs: which addresses a host used, whether its
  // universe is closed, whether it drifts. WRC has had its own resolution path
  // since the same initial commit and simply never got the equivalent record,
  // so `wl-egress-*`/`ui-egress-*` were observable only in the present through
  // the live annotation — and that is the lane where the currently-exposed
  // hosts sit.
  //
  // What these tests pin, and why each matters:
  //   - the STRUCTURE of the record (a substring assert would let a rename of
  //     every field pass while every downstream query broke);
  //   - PER-FQDN attribution on a multi-host policy (a flat union cannot say
  //     which host used which address, which is the only question it is for);
  //   - that the record equals the set the written policy ENFORCES;
  //   - that a declared host resolving to nothing still emits an empty set;
  //   - both lanes, ui and workload;
  //   - and the change gate, with a positive control so "correctly quiet" is
  //     distinguishable from "never ran".
  //
  // The logger is `observability/logger.ts`, which writes one JSON line to
  // stdout and is silent under NODE_ENV=test unless LOG_LEVEL is set — hence
  // the capture helper below rather than a console spy.
  type EgressRecord = Record<string, unknown>
  function captureEgressRecords(): {
    entries: EgressRecord[]
    payloads: () => Array<{ policy: unknown; fqdn: unknown; cidrs: unknown; ports: unknown }>
    restore: () => void
  } {
    const previousLevel = process.env.LOG_LEVEL
    process.env.LOG_LEVEL = 'info'
    const entries: EgressRecord[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString()
      for (const line of text.split('\n')) {
        if (!line.startsWith('{')) continue // vitest's own stdout, not ours
        const parsed = JSON.parse(line) as EgressRecord
        if (parsed.msg === 'resolved external egress set') entries.push(parsed)
      }
      return true
    }) as unknown as typeof process.stdout.write)
    return {
      entries,
      // The payload the record exists to carry, separated from the logger's
      // envelope (ts/level/correlationId/component/...) so a test can pin the
      // four fields a log query keys on without asserting a timestamp.
      payloads: () =>
        entries.map(e => ({ policy: e.policy, fqdn: e.fqdn, cidrs: e.cidrs, ports: e.ports })),
      restore: () => {
        spy.mockRestore()
        if (previousLevel === undefined) delete process.env.LOG_LEVEL
        else process.env.LOG_LEVEL = previousLevel
      },
    }
  }

  function uiRecipeWithExternals(external: Array<{ fqdn: string; port: number }>) {
    return makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
        ui: { workloadRef: 'frontend', port: 8080, egress: { external } },
      },
    })
  }

  function createdPolicy(name: string): k8s.V1NetworkPolicy | undefined {
    return mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls
      .map(c => (c[0] as { body: k8s.V1NetworkPolicy }).body)
      .find(b => b.metadata?.name === name)
  }

  it('records the ui lane egress set with the exact enforced cidrs and ports', async () => {
    const cap = captureEgressRecords()
    try {
      const kc = new k8s.KubeConfig()
      const rec = new WorkflowRecipeReconciler(kc, undefined, {
        // Deliberately chosen so the three candidate orders all differ: input
        // order is 140 then 93; a plain string sort (and the accumulator's own
        // key order) also puts "140" first because it compares '1' to '9'; only
        // an address-wise sort puts 93 first.
        fqdnLookup: async () => ({
          kind: 'ok',
          ipv4: ['140.82.112.4', '93.184.216.11'],
          ipv6: [],
          ttlSeconds: 300,
        }),
      })

      await rec.reconcile(uiRecipeWithExternals([{ fqdn: 'api.stripe.com', port: 443 }]))

      // The whole record, not a substring: field names and value shapes are the
      // contract a log query depends on, so a rename must fail here.
      expect(cap.payloads()).toEqual([
        {
          policy: 'ui-egress-test-recipe',
          fqdn: 'api.stripe.com',
          cidrs: ['93.184.216.11/32', '140.82.112.4/32'], // by address, not lexeme
          ports: [443],
        },
      ])

      // It must go through the service's structured logger, not a bare
      // console.log: the envelope is what makes the record queryable and what
      // gives operators a LOG_LEVEL switch. A regression to console.log emits
      // no JSON line at all and fails above; this pins the envelope's shape.
      expect(cap.entries[0]).toMatchObject({
        level: 'info',
        component: 'wrc',
        recipeName: 'test-recipe',
        msg: 'resolved external egress set',
      })

      // ...and it must equal what the policy actually enforces. This is the
      // property the record exists to have: an audit trail that disagrees with
      // the policy would attest to an allowance that never existed.
      const written = createdPolicy('ui-egress-test-recipe')
      const enforced = (written?.spec?.egress ?? [])
        .flatMap(rule => rule.to ?? [])
        .flatMap(peer => (peer.ipBlock ? [peer.ipBlock.cidr] : []))
        .sort()
      // Compared as content, not order — the record's order is its own readable
      // contract, pinned above; what must match the policy is the SET.
      expect([...(cap.payloads()[0].cidrs as string[])].sort()).toEqual(enforced)
    } finally {
      cap.restore()
    }
  })

  it('attributes each address to its own host on a multi-FQDN policy', async () => {
    // A flat union per policy — the shape this replaced — cannot answer "which
    // addresses did THIS host use", which is the only question the history is
    // for. `egress.external[]` is a list, so multi-host is the normal case.
    const cap = captureEgressRecords()
    try {
      const kc = new k8s.KubeConfig()
      const rec = new WorkflowRecipeReconciler(kc, undefined, {
        fqdnLookup: async (fqdn: string) =>
          fqdn === 'api.github.com'
            ? { kind: 'ok' as const, ipv4: ['140.82.112.4'], ipv6: [], ttlSeconds: 60 }
            : { kind: 'ok' as const, ipv4: ['93.184.216.10'], ipv6: [], ttlSeconds: 300 },
      })

      await rec.reconcile(
        uiRecipeWithExternals([
          { fqdn: 'api.stripe.com', port: 443 },
          { fqdn: 'api.github.com', port: 443 },
        ])
      )

      expect(cap.payloads()).toEqual([
        {
          policy: 'ui-egress-test-recipe',
          fqdn: 'api.github.com',
          cidrs: ['140.82.112.4/32'],
          ports: [443],
        },
        {
          policy: 'ui-egress-test-recipe',
          fqdn: 'api.stripe.com',
          cidrs: ['93.184.216.10/32'],
          ports: [443],
        },
      ])
      // Neither host's address leaks into the other's record.
      expect(cap.payloads()[0].cidrs).not.toContain('93.184.216.10/32')
      expect(cap.payloads()[1].cidrs).not.toContain('140.82.112.4/32')
    } finally {
      cap.restore()
    }
  })

  it('keeps a port-only change visible when the address set is identical', async () => {
    // `changed` is defined over (fqdn,ip,port,protocol), so the same host on a
    // second port IS a change and rewrites the policy. Carrying only addresses
    // would render an identical record and hide it.
    const cap = captureEgressRecords()
    try {
      const kc = new k8s.KubeConfig()
      const rec = new WorkflowRecipeReconciler(kc, undefined, {
        fqdnLookup: async () => ({
          kind: 'ok',
          ipv4: ['93.184.216.10'],
          ipv6: [],
          ttlSeconds: 300,
        }),
      })

      await rec.reconcile(
        uiRecipeWithExternals([
          { fqdn: 'api.stripe.com', port: 443 },
          { fqdn: 'api.stripe.com', port: 8443 },
        ])
      )

      expect(cap.payloads()).toEqual([
        {
          policy: 'ui-egress-test-recipe',
          fqdn: 'api.stripe.com',
          cidrs: ['93.184.216.10/32'],
          ports: [443, 8443], // numeric sort, and both ports survive
        },
      ])
    } finally {
      cap.restore()
    }
  })

  it('still records a declared host that resolved to no addresses', async () => {
    // A set collapsing to empty is the most consequential event in the series.
    // Suppressing the record when there is nothing to list would make it
    // indistinguishable from "nothing happened" for a log-based replay.
    const cap = captureEgressRecords()
    try {
      const kc = new k8s.KubeConfig()
      const rec = new WorkflowRecipeReconciler(kc, undefined, {
        fqdnLookup: async (fqdn: string) =>
          fqdn === 'gone.example.com'
            ? { kind: 'ok' as const, ipv4: [], ipv6: [], ttlSeconds: 60 }
            : { kind: 'ok' as const, ipv4: ['93.184.216.10'], ipv6: [], ttlSeconds: 300 },
      })

      await rec.reconcile(
        uiRecipeWithExternals([
          { fqdn: 'api.stripe.com', port: 443 },
          { fqdn: 'gone.example.com', port: 443 },
        ])
      )

      const empty = cap.payloads().find(r => r.fqdn === 'gone.example.com')
      expect(empty).toEqual({
        policy: 'ui-egress-test-recipe',
        fqdn: 'gone.example.com',
        cidrs: [],
        ports: [],
      })
    } finally {
      cap.restore()
    }
  })

  it('records the workload lane too, not only the ui lane', async () => {
    // One emitter serves both call sites; without this test, silencing the
    // `wl-egress-*` half would pass the whole suite.
    const cap = captureEgressRecords()
    try {
      const kc = new k8s.KubeConfig()
      const rec = new WorkflowRecipeReconciler(kc, undefined, {
        fqdnLookup: async () => ({
          kind: 'ok',
          ipv4: ['93.184.216.10'],
          ipv6: [],
          ttlSeconds: 300,
        }),
      })

      await rec.reconcile(
        makeRecipe({
          spec: {
            contextRef: 'default',
            workloads: [
              {
                id: 'worker',
                type: 'deployment',
                image: 'worker:latest',
                port: 8080,
                // The workload lane declares hosts as exact-host egressBindings,
                // not ui.egress.external — the reconciler maps b.dns to the
                // accumulator's fqdn.
                egressBindings: [{ dns: 'api.stripe.com', port: 443 }],
              },
            ],
          },
        })
      )

      expect(cap.payloads()).toEqual([
        {
          policy: 'wl-egress-test-recipe-worker',
          fqdn: 'api.stripe.com',
          cidrs: ['93.184.216.10/32'],
          ports: [443],
        },
      ])
    } finally {
      cap.restore()
    }
  })

  it('never records an address the M3 filter kept OUT of the written policy', async () => {
    // The record is taken from the post-filter set, so it cannot attest to an
    // allowance that never existed. Fresh DNS cannot exercise this — the
    // resolver fails a whole host closed if any A record is blocked — so the
    // blocked address arrives the only way it can: rehydrated from the live
    // policy's state annotation, which parseState validates for SYNTAX only.
    const cap = captureEgressRecords()
    try {
      const now = Date.now()
      const rehydrated = [
        // A private address someone put on the annotation. Syntactically valid,
        // still inside its window, and dropped by isBlockedExternalIPv4.
        {
          ip: '10.0.0.5',
          port: 443,
          protocol: 'TCP',
          fqdn: 'api.stripe.com',
          expiresAt: now + 600_000,
          lastObservedAt: now,
        },
        {
          ip: '93.184.216.10',
          port: 443,
          protocol: 'TCP',
          fqdn: 'api.stripe.com',
          expiresAt: now + 600_000,
          lastObservedAt: now,
        },
      ]
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue({
        metadata: {
          name: 'ui-egress-test-recipe',
          resourceVersion: '1',
          annotations: { 'clerum.io/egress-fqdn-state': JSON.stringify(rehydrated) },
        },
      })

      const kc = new k8s.KubeConfig()
      const rec = new WorkflowRecipeReconciler(kc, undefined, {
        // A NEW address this round, so the set changed and a record is due.
        fqdnLookup: async () => ({
          kind: 'ok',
          ipv4: ['93.184.216.99'],
          ipv6: [],
          ttlSeconds: 300,
        }),
      })

      await rec.reconcile(uiRecipeWithExternals([{ fqdn: 'api.stripe.com', port: 443 }]))

      expect(cap.payloads()).toHaveLength(1)
      const recorded = cap.payloads()[0].cidrs as string[]
      expect(recorded).not.toContain('10.0.0.5/32')
      expect(recorded).toEqual(['93.184.216.10/32', '93.184.216.99/32'])
    } finally {
      cap.restore()
    }
  })

  it('does NOT record a RENEWAL write, which writes with the set unchanged', async () => {
    // The gate is `changed`, not "did we write". A renewal (audit M1) re-persists
    // an aging window with an identical set: the policy IS rewritten and no
    // record is due, because nothing about the resolved set changed. That is the
    // direction the record does NOT run — an entry implies a write, not the
    // converse.
    //
    // ISOLATING renewalDue. The live policy fed back here is the reconciler's OWN
    // first render, with only the state annotation's `expiresAt` rewound. That
    // matters: it makes the rendered spec.egress byte-identical, so
    // `egressWriteNeeded` is FALSE and `changed` is FALSE, leaving renewalDue as
    // the only term of the H4 gate that can still authorise a write. A fixture
    // carrying just `metadata` would leave egressWriteNeeded true and the test
    // would pass without renewalDue ever being the cause.
    const kc = new k8s.KubeConfig()
    const rec = new WorkflowRecipeReconciler(kc, undefined, {
      // The SAME address both rounds, so the (fqdn,ip,port,protocol) set is unchanged.
      fqdnLookup: async () => ({
        kind: 'ok',
        ipv4: ['93.184.216.10'],
        ipv6: [],
        ttlSeconds: 300,
      }),
    })
    const recipe = uiRecipeWithExternals([{ fqdn: 'api.stripe.com', port: 443 }])

    await rec.reconcile(recipe)
    const rendered = createdPolicy('ui-egress-test-recipe')
    expect(rendered).toBeDefined()

    // Rewind ONLY the persisted expiry, keeping every (fqdn,ip,port,protocol)
    // tuple. renewalDue fires when a surviving entry's persisted expiry is within
    // overlap/2 of now and this round would advance it.
    const persisted = JSON.parse(
      rendered!.metadata!.annotations!['clerum.io/egress-fqdn-state']
    ) as Array<Record<string, unknown>>
    const aging = persisted.map(e => ({ ...e, expiresAt: Date.now() + 30_000 }))
    mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue({
      ...rendered,
      metadata: {
        ...rendered!.metadata,
        resourceVersion: '1',
        annotations: {
          ...rendered!.metadata!.annotations,
          'clerum.io/egress-fqdn-state': JSON.stringify(aging),
        },
      },
    })

    const cap = captureEgressRecords()
    const noOpSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()

      await rec.reconcile(recipe)

      // POSITIVE CONTROL: a write really happened. With the spec identical and the
      // set unchanged, renewalDue is the only term left that could have caused it,
      // so this also proves the no-op gate did NOT short-circuit.
      const wrote =
        mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls.length +
        mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls.length
      expect(wrote).toBeGreaterThan(0)
      expect(noOpSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('ui-egress-test-recipe" in sandbox-ui egress set unchanged — no-op')
      )

      // ...and no record, because the resolved set did not change.
      expect(cap.payloads()).toHaveLength(0)
    } finally {
      noOpSpy.mockRestore()
      cap.restore()
    }
  })

  it('does NOT re-record when the resolved set is unchanged', async () => {
    const kc = new k8s.KubeConfig()
    const rec = new WorkflowRecipeReconciler(kc, undefined, {
      fqdnLookup: async () => ({ kind: 'ok', ipv4: ['93.184.216.10'], ipv6: [], ttlSeconds: 300 }),
    })
    const recipe = uiRecipeWithExternals([{ fqdn: 'api.stripe.com', port: 443 }])

    await rec.reconcile(recipe)
    // Feed the first render back as the live policy, exactly as the H-E test
    // below does — no hand-built fixture.
    const created = createdPolicy('ui-egress-test-recipe')
    expect(created).toBeDefined()
    mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValue(created!)

    const cap = captureEgressRecords()
    const noOpSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await rec.reconcile(recipe)

      expect(cap.payloads()).toHaveLength(0)
      // POSITIVE CONTROL. Without it this assertion also passes when the second
      // reconcile never reached the egress path at all, which would make the
      // test a tautology rather than a check of the change gate.
      expect(noOpSpy).toHaveBeenCalledWith(
        expect.stringContaining('ui-egress-test-recipe" in sandbox-ui egress set unchanged — no-op')
      )
    } finally {
      noOpSpy.mockRestore()
      cap.restore()
    }
  })

  // H-E (audit): a rename of the external FQDN onto the SAME resolved IP/port
  // renders identical spec.egress, so the egress-signature gate alone would no-op
  // and discard the re-attributed state annotation. acc.changed must force the
  // write. This guards the reconciler WIRING of egressStateChanged (the closing
  // Fable cert flagged the gate term as untested). Uses the reconciler's own
  // first-reconcile output as the live policy — no hand-built fixture.
  it('R.8.24 — H-E: renaming the external FQDN onto the same IP re-persists the policy', async () => {
    const kc = new k8s.KubeConfig()
    const rec = new WorkflowRecipeReconciler(kc, undefined, {
      fqdnLookup: async () => ({ kind: 'ok', ipv4: ['93.184.216.10'], ipv6: [], ttlSeconds: 300 }),
    })
    const uiWith = (fqdn: string) =>
      makeRecipe({
        spec: {
          workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
          ui: {
            workloadRef: 'frontend',
            port: 8080,
            egress: { external: [{ fqdn, port: 443 }] },
          },
        },
      })

    // First reconcile authors the live ui-egress policy (IP pinned under old fqdn).
    await rec.reconcile(uiWith('old.example.com'))
    const p1 = mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls
      .map(c => c[0].body)
      .find(b => b?.metadata?.name === 'ui-egress-test-recipe')
    expect(p1).toBeTruthy()

    // That policy is now live; the next reconcile renames the FQDN onto the SAME IP.
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(({ name }: { name: string }) =>
      Promise.resolve(
        name === 'ui-egress-test-recipe' ? p1 : { metadata: { name, resourceVersion: '1' } }
      )
    )
    mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()

    await rec.reconcile(uiWith('new.example.com'))

    const wroteUiEgress =
      mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls.some(
        c => c[0]?.body?.metadata?.name === 'ui-egress-test-recipe'
      ) ||
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls.some(
        c =>
          c[0]?.name === 'ui-egress-test-recipe' ||
          c[0]?.body?.metadata?.name === 'ui-egress-test-recipe'
      )
    // Rendered egress is byte-identical (same /32, same port); only acc.changed
    // (old→new attribution) forces this write. Reverting the gate term no-ops it.
    expect(wroteUiEgress).toBe(true)
  })

  // R1-M2 (zach88): an internal-only ui-egress policy (no external[]) must reach
  // the no-op gate on an unchanged reconcile. Before the fix the live-policy read
  // sat inside the externals-only branch, so `existing` stayed null and the policy
  // was rewritten every reconcile (amplified for mixed recipes by the 60s refresh).
  it('R1-M2: an internal-only ui-egress policy is a no-op on the second reconcile', async () => {
    const kc = new k8s.KubeConfig()
    const rec = new WorkflowRecipeReconciler(kc, undefined, {})
    const recipe = makeRecipe({
      spec: {
        workloads: [
          { id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 },
          { id: 'backend', type: 'deployment', image: 'be:1', port: 9090 },
        ],
        ui: {
          workloadRef: 'frontend',
          port: 8080,
          egress: { internal: [{ workloadRef: 'backend', port: 9090 }] },
        },
      },
    })
    await rec.reconcile(recipe)
    const p1 = mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls
      .map(c => c[0].body)
      .find(b => b?.metadata?.name === 'ui-egress-test-recipe')
    expect(p1).toBeTruthy()

    // The policy is now live; a second identical reconcile must NOT rewrite it.
    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(({ name }: { name: string }) =>
      Promise.resolve(
        name === 'ui-egress-test-recipe' ? p1 : { metadata: { name, resourceVersion: '1' } }
      )
    )
    mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()

    await rec.reconcile(recipe)

    const wroteUiEgress =
      mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls.some(
        c => c[0]?.body?.metadata?.name === 'ui-egress-test-recipe'
      ) ||
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls.some(
        c =>
          c[0]?.name === 'ui-egress-test-recipe' ||
          c[0]?.body?.metadata?.name === 'ui-egress-test-recipe'
      )
    expect(wroteUiEgress).toBe(false)
  })

  // R1-M3 (zach88): the no-op gate must hold when the LIVE policy is apiserver-
  // shaped — each rule's keys reordered ({ports,to} not {to,ports}) and each
  // port's keys reordered ({protocol,port} not {port,protocol}) — which is
  // exactly what the canonicalize/egressSignature fix motivates but R.8.24
  // (which feeds the builder's own output back verbatim) never exercised. The
  // builder already emits protocol:'TCP' on every port, so this exercises key
  // ORDER only; egressSignature deliberately treats an absent protocol as
  // distinct from 'TCP', a shape that cannot arise for builder-written policies.
  it('R1-M3: external egress is a no-op against an apiserver-normalized live policy', async () => {
    const kc = new k8s.KubeConfig()
    const rec = new WorkflowRecipeReconciler(kc, undefined, {
      fqdnLookup: async () => ({ kind: 'ok', ipv4: ['93.184.216.10'], ipv6: [], ttlSeconds: 300 }),
    })
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
        ui: {
          workloadRef: 'frontend',
          port: 8080,
          egress: { external: [{ fqdn: 'api.example.com', port: 443 }] },
        },
      },
    })
    await rec.reconcile(recipe)
    const p1 = mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls
      .map(c => c[0].body)
      .find(b => b?.metadata?.name === 'ui-egress-test-recipe')
    expect(p1).toBeTruthy()

    // Reshape p1 the way the apiserver returns it: reorder each rule's keys
    // ({ports,to}) and each port's keys ({protocol,port}). The builder already
    // set protocol:'TCP', so this preserves the value and only changes key
    // order. The state annotation is preserved.
    const live = JSON.parse(JSON.stringify(p1))
    live.spec.egress = (live.spec.egress ?? []).map((rule: Record<string, unknown>) => ({
      ports: ((rule.ports as Array<Record<string, unknown>>) ?? []).map(pt => ({
        protocol: pt.protocol,
        port: pt.port,
      })),
      to: (rule.to as Array<Record<string, unknown>>) ?? [],
    }))

    mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(({ name }: { name: string }) =>
      Promise.resolve(
        name === 'ui-egress-test-recipe' ? live : { metadata: { name, resourceVersion: '1' } }
      )
    )
    mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
    mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()

    await rec.reconcile(recipe) // identical resolver output → same set → no-op

    const wrote =
      mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls.some(
        c => c[0]?.body?.metadata?.name === 'ui-egress-test-recipe'
      ) ||
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mock.calls.some(
        c =>
          c[0]?.name === 'ui-egress-test-recipe' ||
          c[0]?.body?.metadata?.name === 'ui-egress-test-recipe'
      )
    expect(wrote).toBe(false)
  })

  it('fails sandbox UI external egress in required mode when cluster enforcement is not confirmed', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
        ui: {
          workloadRef: 'frontend',
          port: 8080,
          egress: {
            external: [{ fqdn: 'api.stripe.com', port: 443 }],
          },
        },
      },
    })
    const unconfirmedReconciler = new WorkflowRecipeReconciler(
      new k8s.KubeConfig(),
      {
        ...loadConfig(),
        networkPolicyEnforcementMode: 'required',
        networkPolicyEnforcementConfirmed: false,
      },
      {
        fqdnLookup: async () => ({
          kind: 'ok',
          ipv4: ['93.184.216.10'],
          ipv6: [],
          ttlSeconds: 300,
        }),
      }
    )

    const result = await unconfirmedReconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED')
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'sandbox-ui',
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'ui-egress-test-recipe' }),
        }),
      })
    )
  })

  it('fails closed when sandbox UI external egress resolves to a blocked address', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
        ui: {
          workloadRef: 'frontend',
          port: 8080,
          egress: {
            external: [{ fqdn: 'api.stripe.com', port: 443 }],
          },
        },
      },
    })
    const kc = new k8s.KubeConfig()
    const reconcilerWithLookup = new WorkflowRecipeReconciler(kc, undefined, {
      fqdnLookup: async () => ({
        kind: 'ok',
        ipv4: ['169.254.169.254'],
        ipv6: [],
        ttlSeconds: 300,
      }),
    })

    const result = await reconcilerWithLookup.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('ui external egress resolution failed')
    expect(result.message).toContain('resolved to blocked IPv4 address')
  })

  it('fails workflow deployment before execution when sandbox UI egress cannot be enforced', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
        ui: {
          workloadRef: 'frontend',
          port: 8080,
          egress: {
            external: [{ fqdn: 'api.stripe.com', port: 443 }],
          },
        },
        steps: [{ id: 'render', run: snippetRun() }],
      },
    })
    const kc = new k8s.KubeConfig()
    const reconcilerWithLookup = new WorkflowRecipeReconciler(kc, undefined, {
      fqdnLookup: async () => ({
        kind: 'ok',
        ipv4: ['169.254.169.254'],
        ipv6: [],
        ttlSeconds: 300,
      }),
    })
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconcilerWithLookup as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const result = await reconcilerWithLookup.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('ui external egress resolution failed')
    expect(result.message).toContain('resolved to blocked IPv4 address')
    expect(workflowReconcile).not.toHaveBeenCalled()
    expect(mockCustomApi.createNamespacedCustomObject).not.toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'sandbox-recipes',
        body: expect.objectContaining({
          kind: 'WorkflowRecipe',
          metadata: expect.objectContaining({ name: expect.stringContaining('render') }),
        }),
      })
    )
  })

  it('degrades (does not fail) when sandbox UI external egress hits a transient DNS error', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
        ui: {
          workloadRef: 'frontend',
          port: 8080,
          egress: {
            external: [{ fqdn: 'api.anthropic.com', port: 443 }],
          },
        },
      },
    })
    const kc = new k8s.KubeConfig()
    const reconcilerWithLookup = new WorkflowRecipeReconciler(kc, undefined, {
      fqdnLookup: async () => ({
        kind: 'error',
        error:
          'DNS resolution for "api.anthropic.com" failed (ESERVFAIL) — resolver or upstream unavailable',
        retryable: true,
      }),
    })

    const result = await reconcilerWithLookup.reconcile(recipe)

    // Non-terminal: the periodic reconcile must retry once DNS recovers, so the
    // recipe self-heals instead of bricking at the terminal `failed` phase.
    expect(result.phase).toBe('degraded')
    expect(result.message).toContain('ui external egress resolution failed')
    expect(result.message).toContain('ESERVFAIL')
  })

  it('degrades a workflow recipe (without running it) on a transient UI egress DNS error', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
        ui: {
          workloadRef: 'frontend',
          port: 8080,
          egress: {
            external: [{ fqdn: 'api.anthropic.com', port: 443 }],
          },
        },
        steps: [{ id: 'render', run: snippetRun() }],
      },
    })
    const kc = new k8s.KubeConfig()
    const reconcilerWithLookup = new WorkflowRecipeReconciler(kc, undefined, {
      fqdnLookup: async () => ({
        kind: 'error',
        error:
          'DNS resolution for "api.anthropic.com" failed (ETIMEOUT) — resolver or upstream unavailable',
        retryable: true,
      }),
    })
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconcilerWithLookup as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const result = await reconcilerWithLookup.reconcile(recipe)

    expect(result.phase).toBe('degraded')
    expect(result.message).toContain('ui external egress resolution failed')
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('R.8.24 — no ui-egress NetworkPolicy is created when spec.ui is unset', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'app:1', port: 8080 }],
      },
    })
    await reconciler.reconcile(recipe)
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    // Convergence path: stale policy from a prior reconcile (when ui was set)
    // is removed unconditionally. safeDelete swallows the 404 if none exists.
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ui-egress-test-recipe', namespace: 'sandbox-ui' })
    )
  })

  it('R.8.25 — ui-egress NetworkPolicy is deleted on WorkflowRecipe cleanup', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'fe:1', port: 8080 }],
        ui: { workloadRef: 'frontend', port: 8080 },
      },
    })
    await reconciler.reconcileDelete(recipe)
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ui-egress-test-recipe', namespace: 'sandbox-ui' })
    )
  })

  it('deletes workflow transport workloads from mcp-server on WorkflowRecipe finalizer cleanup', async () => {
    const workflowInfraCleanup = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: { reconcileDelete: typeof workflowInfraCleanup }
      }
    ).workflowReconciler = { reconcileDelete: workflowInfraCleanup }

    const recipe = makeRecipe({
      spec: {
        steps: [{ id: 'research', instruction: 'run', mcpServers: ['web-search'] }],
        mcpServers: [{ id: 'web-search', endpoint: 'http://web-search.mcp-server.svc/mcp' }],
        workloads: [
          {
            id: 'web-search',
            type: 'deployment',
            image: 'web-search:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
      status: {
        phase: 'active',
        workloadInstances: { 'web-search': 'test-recipe-web-search-12345678' },
      },
    })

    await reconciler.reconcileDelete(recipe)

    expect(workflowInfraCleanup).toHaveBeenCalledWith('test-recipe', 'sandbox-recipes', recipe.spec)
    expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledWith({
      name: 'test-recipe-web-search-12345678',
      namespace: 'mcp-server',
    })
    expect(mockCoreApi.deleteNamespacedService).toHaveBeenCalledWith({
      name: 'test-recipe-web-search-12345678',
      namespace: 'mcp-server',
    })
  })

  it('fences SDK authority before deleting a hybrid workflow recipe', async () => {
    const order: string[] = []
    const cleanupPluginWorkloadSdk = vi.fn(async () => {
      order.push('sdk-revoke-and-cleanup')
    })
    const workflowInfraCleanup = vi.fn(async () => {
      order.push('workflow-cleanup')
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          cleanupPluginWorkloadSdk: typeof cleanupPluginWorkloadSdk
          reconcileDelete: typeof workflowInfraCleanup
        }
      }
    ).workflowReconciler = { cleanupPluginWorkloadSdk, reconcileDelete: workflowInfraCleanup }

    const recipe = makeRecipe({
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
        pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['api'] },
      },
      status: {
        phase: 'active',
        pluginWorkloadSdk: { state: 'validated', promptBridge: true, clientNotifications: false },
      },
    })

    await reconciler.reconcileDelete(recipe)

    expect(order).toEqual(['sdk-revoke-and-cleanup', 'workflow-cleanup'])
    expect(workflowInfraCleanup).toHaveBeenCalledWith('test-recipe', 'sandbox-recipes', recipe.spec)
  })

  it('forwards custom coordinator workflow fields to the workflow reconciler', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const inputContract = {
      type: 'object',
      properties: {
        requestId: { type: 'string', default: 'e2e-custom' },
        approvalThreshold: { type: 'number', default: 1000 },
      },
    }
    const recipe = makeRecipe({
      spec: {
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        inputContract,
        output: { destination: 'pvc', format: 'json', storageSize: '128Mi' },
        steps: [
          { id: 'prepare' },
          { id: 'transform', dependsOn: ['prepare'] },
          { id: 'emit', dependsOn: ['transform'] },
        ],
      },
      status: { phase: 'candidate' },
    })

    await reconciler.reconcile(recipe)

    const forwardedSpec = workflowReconcile.mock.calls[0][3]
    expect(forwardedSpec).toMatchObject({
      coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
      inputContract,
      output: { destination: 'pvc', format: 'json', storageSize: '128Mi' },
    })
    expect(forwardedSpec.steps).toEqual([
      { id: 'prepare' },
      { id: 'transform', dependsOn: ['prepare'] },
      { id: 'emit', dependsOn: ['transform'] },
    ])
    expect(workflowReconcile.mock.calls[0][5]).toEqual({
      requestId: 'e2e-custom',
      approvalThreshold: 1000,
    })
  })

  it('forwards the exact GFS read/write intent to the workflow reconciler', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const gfs: WorkflowRecipeGfsIntentSpec = {
      mounts: [
        {
          drive: 'main',
          target: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          scopes: ['gfs.read', 'gfs.write'],
        },
      ],
    }
    const recipe = makeRecipe({
      spec: {
        steps: [{ id: 'read-write', run: snippetRun() }],
        gfs,
      },
    })

    await reconciler.reconcile(recipe)

    expect(workflowReconcile.mock.calls[0][3].gfs).toEqual(gfs)
  })

  it('does not synthesize GFS intent when the recipe omits it', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      spec: {
        steps: [{ id: 'no-gfs', run: snippetRun() }],
      },
    })

    await reconciler.reconcile(recipe)

    expect(workflowReconcile.mock.calls[0][3].gfs).toBeUndefined()
  })

  it('delegates workflow transport workloads without contextRef and waits for ExternalEgressReady', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'research', instruction: 'search', mcpServers: ['web-search'] }],
        workloads: [
          {
            id: 'web-search',
            type: 'deployment',
            image: 'clerum/web-search:test',
            port: 3000,
            transport: { type: 'streamableHttp', path: '/mcp' },
            egressBindings: [{ dns: 'duckduckgo.com', port: 443 }],
          },
        ],
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('deploying')
    const mcpServerCall =
      mockCustomApi.createNamespacedCustomObject.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>)?.plural === 'mcpservers'
      ) ??
      mockCustomApi.replaceNamespacedCustomObject.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>)?.plural === 'mcpservers'
      )
    expect(mcpServerCall).toBeDefined()
    const mcpSpec = mcpServerCall![0].body.spec as Record<string, unknown>
    expect(mcpSpec.contextRef).toBe('wf-test-recipe')
    expect(mcpSpec.egressBindings).toEqual([{ dns: 'duckduckgo.com', port: 443 }])
    const contextCall =
      mockCustomApi.createNamespacedCustomObject.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>)?.plural === 'contexts'
      ) ??
      mockCustomApi.replaceNamespacedCustomObject.mock.calls.find(
        (call: unknown[]) => (call[0] as Record<string, unknown>)?.plural === 'contexts'
      )
    expect(contextCall).toBeDefined()
    expect((contextCall![0].body.spec as Record<string, unknown>).contextId).toBe('wf-test-recipe')
    expect(workflowReconcile).toHaveBeenCalled()
  })

  it('fails external-egress workflows in required mode when cluster enforcement is not confirmed', async () => {
    const unconfirmedReconciler = new WorkflowRecipeReconciler(new k8s.KubeConfig(), {
      ...loadConfig(),
      networkPolicyEnforcementMode: 'required',
      networkPolicyEnforcementConfirmed: false,
    })
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      unconfirmedReconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const result = await unconfirmedReconciler.reconcile(
      makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          steps: [{ id: 'research', instruction: 'search', mcpServers: ['web-search'] }],
          workloads: [
            {
              id: 'web-search',
              type: 'deployment',
              image: 'clerum/web-search:test',
              port: 3000,
              transport: { type: 'streamableHttp', path: '/mcp' },
              egressBindings: [{ dns: 'duckduckgo.com', port: 443 }],
            },
          ],
        },
        status: { phase: 'candidate' },
      })
    )

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED')
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('forwards transport endpoints using the delegated Service name for StatefulSet transport workloads', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const workload = {
      id: 'web-search-transport-with-a-name-long-enough-to-clamp-statefulset',
      type: 'statefulset' as const,
      image: 'clerum/web-search:test',
      port: 3000,
      transport: { type: 'streamableHttp' as const, path: '/custom-mcp' },
    }
    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'research', instruction: 'search', mcpServers: [workload.id] }],
        workloads: [workload],
      },
      status: { phase: 'candidate' },
    })
    await reconciler.reconcile(recipe)

    const transportServiceCall = mockCoreApi.createNamespacedService.mock.calls.find(([arg]) => {
      const body = arg.body as { metadata?: { namespace?: string }; spec?: { clusterIP?: string } }
      return body.metadata?.namespace === 'mcp-server' && body.spec?.clusterIP !== 'None'
    })
    expect(transportServiceCall).toBeDefined()
    const serviceName = transportServiceCall![0].body.metadata.name
    const runtimeName = resolveWorkloadRuntimeResourceName(recipe, workload)
    expect(serviceName).toBe(runtimeName)

    const forwardedSpec = workflowReconcile.mock.calls[0][3] as {
      mcpServers?: Array<{ id: string; endpoint: string }>
    }
    expect(forwardedSpec.mcpServers).toContainEqual({
      id: workload.id,
      endpoint: `http://${serviceName}.mcp-server.svc.cluster.local:3000/custom-mcp`,
    })
  })

  // Regression: the WRC controller is level-triggered and watches ONLY the
  // WorkflowRecipe CR, not the Pods it creates. While the inner workflow
  // reconciler is waiting on the output-prepare pod it returns a non-terminal
  // `phase: 'deploying'` result. Without a timer-driven requeue, the
  // output-prepare → mcp-host transition (a Pod change, not a CR change) never
  // re-triggers reconcile: the run wedges at phase=deploying forever and
  // dbRunProcessor keeps logging "orphaned running run reclaimed". The mapped
  // watcher result for a `deploying` workflow phase MUST carry a non-undefined
  // requeueAfterMs so the controller re-reconciles on its own and advances once
  // the output-prepare pod succeeds.
  it('requeues a deploying workflow reconcile waiting on the output-prepare pod', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message:
        'Created workflow output prepare pod "test-recipe-output-prepare"; waiting before starting runtime pods',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    expect(workflowReconcile).toHaveBeenCalled()
    expect(result.phase).toBe('deploying')
    // The fix: a non-terminal `deploying` result must schedule a requeue.
    expect(result.requeueAfterMs).toBeDefined()
    expect(result.requeueAfterMs).toBe(WORKFLOW_PROGRESS_REQUEUE_BASE_MS)
  })

  // Counterpart: a steady-state (`active`) workflow result must NOT requeue —
  // otherwise the fix above would turn into an unconditional hot loop.
  it('does not requeue a steady-state active workflow reconcile', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'active',
      message: 'Workflow running',
      workflowPhase: 'running',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('active')
    expect(result.requeueAfterMs).toBeUndefined()
    // active is steady-state ⇒ no fixed-interval requeue either.
    expect(result.requeueFixedInterval).toBeFalsy()
  })

  // §5: a `deploying` PROGRESS requeue must be a FIXED interval (no exponential
  // backoff) — requeueFixedInterval signals the watcher to skip backoff and reset
  // attempts, else the poll cadence degrades toward the 60s cap and the 240s
  // mcp-host readiness deadline can still be exceeded.
  it('marks a deploying workflow requeue as fixed-interval (no transient backoff)', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Waiting for workflow output prepare pod to complete',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('deploying')
    expect(result.requeueAfterMs).toBe(WORKFLOW_PROGRESS_REQUEUE_BASE_MS)
    // The fix: progress requeues are FIXED-interval, NOT exponential-backoff.
    expect(result.requeueFixedInterval).toBe(true)
  })

  // Terminal `failed` results must not requeue at all — neither timer nor flag.
  it('does not requeue a failed workflow reconcile', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'failed',
      message: 'readiness deadline exceeded',
      workflowPhase: 'failed',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('failed')
    expect(result.requeueAfterMs).toBeUndefined()
    expect(result.requeueFixedInterval).toBeFalsy()
  })

  // §5 priority: a transient ERROR (skipStatusPatch) wins over PROGRESS even when
  // the phase is `deploying`. The error path keeps the TRANSIENT base + backoff
  // (requeueFixedInterval false), so genuine flakiness still backs off; it must
  // NOT be downgraded to the fixed progress interval.
  it('keeps the transient (backoff) requeue path when skipStatusPatch is set, even at phase deploying', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Transient infra blip; retry',
      workflowPhase: 'initializing',
      skipStatusPatch: true,
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.skipStatusPatch).toBe(true)
    expect(result.requeueAfterMs).toBe(TRANSIENT_REQUEUE_BASE_MS)
    // Transient error ⇒ exponential backoff path, NOT the fixed progress path.
    expect(result.requeueFixedInterval).toBe(false)
  })

  it('degrades (retryable) workflow transport workloads when child McpServer pre-deploy fails', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }
    mockCustomApi.replaceNamespacedCustomObject.mockRejectedValueOnce(new Error('api down'))

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          steps: [{ id: 'research', instruction: 'search', mcpServers: ['web-search'] }],
          workloads: [
            {
              id: 'web-search',
              type: 'deployment',
              image: 'clerum/web-search:test',
              port: 3000,
              transport: { type: 'streamableHttp', path: '/mcp' },
            },
          ],
        },
        status: { phase: 'candidate' },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.message).toContain('Pre-deploy failed for workflow "test-recipe"')
    expect(result.message).toContain('child McpServers')
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('degrades (retryable) workflow transport workloads when final delegation fails', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }
    mockCustomApi.replaceNamespacedCustomObject
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('delegation write failed'))

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          steps: [{ id: 'research', instruction: 'search', mcpServers: ['web-search'] }],
          workloads: [
            {
              id: 'web-search',
              type: 'deployment',
              image: 'clerum/web-search:test',
              port: 3000,
              transport: { type: 'streamableHttp', path: '/mcp' },
            },
          ],
        },
        status: { phase: 'candidate' },
      })
    )

    expect(result.phase).toBe('degraded')
    expect(result.message).toContain('MCP delegation failed for workflow "test-recipe"')
    expect(result.message).toContain('persisted child McpServers')
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('fails workflow transport workloads with egressBindings when ExternalEgressReady is false', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }
    mockCustomApi.getNamespacedCustomObject.mockImplementation(
      ({ plural, name }: { plural?: string; name?: string }) => {
        if (plural === 'mcpservers') {
          return Promise.resolve({
            metadata: {
              resourceVersion: '1',
              labels: { 'clerum.io/recipe': 'test-recipe' },
            },
            status: {
              conditions: [
                {
                  type: 'ExternalEgressReady',
                  status: 'False',
                  message: 'DNS resolution failed for duckduckgo.com',
                },
              ],
            },
          })
        }
        return Promise.resolve({
          metadata: {
            uid: liveWorkflowRecipeUid(name),
            resourceVersion: '1',
            labels: { 'clerum.io/recipe': 'test-recipe' },
          },
          spec: { mcpServers: [] },
        })
      }
    )

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          steps: [{ id: 'research', instruction: 'search', mcpServers: ['web-search'] }],
          workloads: [
            {
              id: 'web-search',
              type: 'deployment',
              image: 'clerum/web-search:test',
              port: 3000,
              transport: { type: 'streamableHttp', path: '/mcp' },
              egressBindings: [{ dns: 'duckduckgo.com', port: 443 }],
            },
          ],
        },
        status: { phase: 'candidate' },
      })
    )

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('External egress policy readiness not achieved')
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('resolves agentic workload env, command, and args using assigned Service names', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        triggers: { onDemand: { allowedActors: ['user'] } },
        inputContract: {
          properties: {
            db_name: { type: 'string', default: 'clerum' },
          },
        },
        computed: [{ name: 'db_mode', expression: "'readonly'" }],
        workloads: [
          { id: 'postgres', type: 'statefulset', image: 'postgres:16', port: 5432 },
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
            env: [
              {
                name: 'DATABASE_URL',
                value: 'postgres://{{postgres:host}}:{{postgres:port}}/{{inputs.db_name}}',
              },
              { name: 'DB_MODE', value: '{{computed.db_mode}}' },
            ],
            command: ['node'],
            args: ['server.js', '--db-host={{postgres:host}}'],
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    expect(result.phase).toBe('deploying')
    const postgresRuntimeName = resolveWorkloadRuntimeResourceName(
      recipe,
      recipe.spec.workloads![0]
    )
    const expectedHost = `${postgresRuntimeName}.sandbox-recipes.svc.cluster.local`
    const deployment = mockAppsApi.createNamespacedDeployment.mock.calls.find(
      ([arg]) => arg.body?.metadata?.labels?.['clerum.io/workload'] === 'qa-api'
    )?.[0].body
    const container = deployment.spec.template.spec.containers[0]
    expect(container.env).toEqual(
      expect.arrayContaining([
        {
          name: 'DATABASE_URL',
          value: `postgres://${expectedHost}:5432/clerum`,
        },
        { name: 'DB_MODE', value: 'readonly' },
      ])
    )
    expect(container.command).toEqual(['node'])
    expect(container.args).toEqual(['server.js', `--db-host=${expectedHost}`])
    expect(JSON.stringify(deployment)).not.toContain('{{')
    expect(workflowReconcile.mock.calls[0][5]).toMatchObject({
      db_name: 'clerum',
      db_mode: 'readonly',
    })
  })

  it('DENIES and tears down a workload that declares the reserved platform pull secret (Issue #637)', async () => {
    // The orchestrator-level counterpart to the builder tests in platformPullSecret.test.ts.
    // The platform credential is injected, never declared: control-api labels it
    // `managed-by=control-api` only, which is *unlabeled* to the #637 ownership model. So a
    // recipe that names it in imagePullSecrets does NOT get "the declared copy stripped and
    // ours injected" — the whole WORKLOAD is denied here, in the reconciler, and torn down
    // instead of rendered. This is the authoritative gate; the builders only normalize.
    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === EVENFIRE_REGISTRY_PULL_SECRET_NAME
        ? Promise.resolve({
            metadata: {
              resourceVersion: '1',
              // Exactly what registryPullSecretService writes — provenance only, no
              // owner-recipe/shared label (labelling it `shared` would open the envSecret
              // exfiltration path, so it must stay denied).
              labels: { 'clerum.io/managed-by': 'control-api' },
            },
            type: 'kubernetes.io/dockerconfigjson',
            data: { '.dockerconfigjson': 'eA==' },
          })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )

    const recipe = makeRecipe({
      spec: {
        workloads: [
          {
            id: 'app',
            type: 'deployment',
            image: 'registry.evenfire.ai/acme/plugin:1.0',
            port: 8080,
            imagePullSecrets: [EVENFIRE_REGISTRY_PULL_SECRET_NAME],
          },
        ],
      },
    })

    const r = await reconciler.reconcile(recipe)

    const cond = (r.secretOwnershipConditions ?? []).find(
      c => c.type === 'EnvSecretOwnershipDenied'
    )
    expect(cond?.status).toBe('True')
    expect(cond?.message).toContain(EVENFIRE_REGISTRY_PULL_SECRET_NAME)
    expect(r.workloadStatuses[0]).toMatchObject({ id: 'app', phase: 'failed', ready: false })

    // Not rendered — and any prior instance torn down (revocation, not a silent strip).
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalled()
  })

  it('surfaces EnvSecretOwnershipDenied from the WORKFLOW build path (Issue #637)', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    // qa-api's envSecret is owned by ANOTHER recipe → denied. Previously the
    // workflow build path computed the EnvSecretOwnershipDenied condition and
    // dropped it (returned only internalDependencyConditions); now it must reach
    // the reconcile result (and thus patchStatus).
    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === 'qa-creds'
        ? Promise.resolve({
            metadata: {
              resourceVersion: '1',
              labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
            },
            data: { token: 'eA==' },
          })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
            port: 8080,
            envSecret: { name: 'qa-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
      },
      status: { phase: 'candidate' },
    })

    const r = await reconciler.reconcile(recipe)

    const cond = (r.secretOwnershipConditions ?? []).find(
      c => c.type === 'EnvSecretOwnershipDenied'
    )
    expect(cond?.status).toBe('True')
    expect(cond?.message).toMatch(/not owned by recipe/)
    // The denied workload was never rendered with the foreign credential.
    const qaDeploy = mockAppsApi.createNamespacedDeployment.mock.calls.find(
      ([arg]) => arg.body?.metadata?.labels?.['clerum.io/workload'] === 'qa-api'
    )
    expect(qaDeploy).toBeUndefined()
  })

  it('fail-closed: degrades + does NOT run the workflow when a denied WORKFLOW workload teardown FAILS (Issue #637, no silent swallow)', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    // qa-creds is owned by ANOTHER recipe → qa-api is denied and must be torn down.
    // Force the teardown to FAIL: previously this was swallowed (.catch(() => undefined))
    // and the workflow proceeded; now it must degrade + requeue (fail-closed).
    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === 'qa-creds'
        ? Promise.resolve({
            metadata: {
              resourceVersion: '1',
              labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
            },
            data: { token: 'eA==' },
          })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )
    const teardownSpy = vi
      .spyOn(
        reconciler as unknown as { teardownDeniedWorkload: () => Promise<void> },
        'teardownDeniedWorkload'
      )
      .mockRejectedValue(new Error('apiserver 500 during teardown'))

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
            port: 8080,
            envSecret: { name: 'qa-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
      },
      status: { phase: 'candidate' },
    })

    const r = await reconciler.reconcile(recipe)

    // Fail-closed: the failed teardown degrades the recipe (was a silent swallow that
    // let the workflow run with a possibly-live foreign-credentialed pod). The periodic
    // ownership backstop (workflowNeedsOwnershipBackstop) retries the revocation.
    expect(r.phase).toBe('degraded')
    expect(r.message).toMatch(/teardown of denied workflow workload .* failed/)
    // The workflow infrastructure reconcile must NOT have run — we degraded first.
    expect(workflowReconcile).not.toHaveBeenCalled()

    teardownSpy.mockRestore()
  })

  it('CRITICAL: a denied WORKFLOW Deployment whose underlying delete fails non-404 degrades (caller 2 real-delete path, Issue #637)', async () => {
    // Caller 2 (deploy-workflow teardown) analog of the deploy-non-workflow CRITICAL test:
    // mock the REAL deleteNamespacedDeployment to fail non-404, NOT spy teardownDeniedWorkload
    // (a spy masks whether the real delete propagates through deleteWorkload→deleteOrThrow→
    // RetryableReconcileError — the exact masking that hid the original safeDelete fail-open).
    // Pre-fix the swallow let the workflow proceed with a live foreign pod; now it degrades.
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === 'qa-creds'
        ? Promise.resolve({
            metadata: {
              resourceVersion: '1',
              labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
            },
            data: { token: 'eA==' },
          })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )
    // The REAL Deployment delete (the revocation teardown) fails non-404.
    mockAppsApi.deleteNamespacedDeployment.mockRejectedValue({
      code: 500,
      body: { message: 'apiserver 500' },
    })

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
            port: 8080,
            envSecret: { name: 'qa-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
      },
      status: { phase: 'candidate' },
    })

    const r = await reconciler.reconcile(recipe)

    // The real delete failure propagated through deleteOrThrow → RetryableReconcileError →
    // degrade; the workflow did NOT proceed with a live foreign-credentialed pod. Reverting
    // throwOnError makes this red (safeDelete swallows → workflow proceeds, phase 'deploying').
    expect(r.phase).toBe('degraded')
    expect(r.message).toMatch(/teardown of denied workflow workload .* failed/)
    expect(workflowReconcile).not.toHaveBeenCalled()

    // Restore the shared delete mock (the suite clears calls, not mock implementations).
    mockAppsApi.deleteNamespacedDeployment.mockResolvedValue({})
  })

  it('revokes an ACTIVE/running workflow workload when its Secret is re-labeled foreign (Issue #637)', async () => {
    // Regression for the active-phase revocation hole: a running workflow's reconcile
    // short-circuits BEFORE the Step 8 ownership gate (to protect the coordinator
    // 409-window). The SecretWatcher fan-out routes through that same short-circuit,
    // so a mid-run re-label was never enforced. The active short-circuit must now run
    // targeted teardown + surface the EnvSecretOwnershipDenied condition WITHOUT
    // redeploying (coordinator untouched). Reverting the enforceActiveWorkflowSecret-
    // Ownership calls makes this test red.
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
          ensureMcpHostRuntimeCredentials?: () => Promise<void>
        }
      }
    ).workflowReconciler = {
      reconcile: workflowReconcile,
      validateWorkflowSpec: () => undefined,
      ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
    }

    // qa-creds is now owned by ANOTHER recipe (mid-run revocation).
    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === 'qa-creds'
        ? Promise.resolve({
            metadata: {
              resourceVersion: '1',
              labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
            },
            data: { token: 'eA==' },
          })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
            port: 8080,
            envSecret: { name: 'qa-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
      },
      // Triggered run → workflowRunId label set → awaitsTriggeredRun=false → the
      // reconcile hits the ACTIVE short-circuit (not the first-deploy path).
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        labels: { 'clerum.io/workflow-run-id': 'run-123' },
      },
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    })

    const r = await reconciler.reconcile(recipe)

    // 1) The denial is surfaced and written (previously the active short-circuit
    //    returned skipStatusPatch:true with NO condition → silent revocation miss).
    const cond = (r.secretOwnershipConditions ?? []).find(
      c => c.type === 'EnvSecretOwnershipDenied'
    )
    expect(cond?.status).toBe('True')
    expect(r.skipStatusPatch).toBeFalsy()
    // 2) The foreign-owned workload was TORN DOWN (the security action), not left running.
    expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalled()
    // 3) The coordinator was NOT re-driven and the workload was NOT redeployed
    //    (the 409-window protection the short-circuit exists for is preserved).
    expect(workflowReconcile).not.toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('revokes an AWAITING-TRIGGER workflow workload when its Secret is re-labeled foreign (Issue #637)', async () => {
    // The awaiting-trigger short-circuit (active + awaitsTriggeredRun + no execution)
    // also returns before the Step 8 gate, yet the envSecret workload was already
    // deployed. A mid-life re-label must still be enforced there.
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
          ensureMcpHostRuntimeCredentials?: () => Promise<void>
        }
      }
    ).workflowReconciler = {
      reconcile: workflowReconcile,
      validateWorkflowSpec: () => undefined,
      ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
    }

    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === 'qa-creds'
        ? Promise.resolve({
            metadata: {
              resourceVersion: '1',
              labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
            },
            data: { token: 'eA==' },
          })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        triggers: { onDemand: { allowedActors: ['user'] } },
        workloads: [
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
            port: 8080,
            envSecret: { name: 'qa-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
      },
      // active, NO run-id label, NO workflowExecution → awaiting-trigger short-circuit.
      status: { phase: 'active' },
    })

    const r = await reconciler.reconcile(recipe)

    const cond = (r.secretOwnershipConditions ?? []).find(
      c => c.type === 'EnvSecretOwnershipDenied'
    )
    expect(cond?.status).toBe('True')
    expect(r.skipStatusPatch).toBeFalsy()
    expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalled()
    expect(workflowReconcile).not.toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('revokes a TERMINAL (completed) workflow workload when its Secret is re-labeled foreign (Issue #637)', async () => {
    // A terminal workflow that is not run-scoped keeps steady envSecret workloads;
    // a mid-life re-label must be enforced on the terminal short-circuit too. The
    // EnvSecretOwnershipDenied condition + a forced status patch are produced ONLY by
    // the enforcement (the normal terminal return carries neither).
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
          ensureMcpHostRuntimeCredentials?: () => Promise<void>
        }
      }
    ).workflowReconciler = {
      reconcile: workflowReconcile,
      validateWorkflowSpec: () => undefined,
      ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
    }

    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === 'qa-creds'
        ? Promise.resolve({
            metadata: {
              resourceVersion: '1',
              labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
            },
            data: { token: 'eA==' },
          })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
            port: 8080,
            envSecret: { name: 'qa-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
      },
      // run-id label → awaitsTriggeredRun=false; completed execution → wfTerminal.
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        labels: { 'clerum.io/workflow-run-id': 'run-123' },
      },
      status: { phase: 'active', workflowExecution: { phase: 'completed' } },
    })

    const r = await reconciler.reconcile(recipe)

    const cond = (r.secretOwnershipConditions ?? []).find(
      c => c.type === 'EnvSecretOwnershipDenied'
    )
    expect(cond?.status).toBe('True')
    expect(r.skipStatusPatch).toBeFalsy()
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('requeues (NO false "revoked") when a steady workflow Secret ownership cannot be verified — transient read error (Issue #637 fail-closed)', async () => {
    // Fail-closed parity with the deploy path: an `error`-state classification must
    // requeue, NOT silently skip (which would leave a foreign Secret projected with a
    // healthy status). Reverting the `secretOwnership.errored` requeue branch makes
    // this red.
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
          ensureMcpHostRuntimeCredentials?: () => Promise<void>
        }
      }
    ).workflowReconciler = {
      reconcile: workflowReconcile,
      validateWorkflowSpec: () => undefined,
      ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
    }

    // qa-creds read FAILS with a non-404 → classifySecretAccess => 'error' => partition errored.
    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === 'qa-creds'
        ? Promise.reject({ code: 500, body: { message: 'apiserver boom' } })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
            port: 8080,
            envSecret: { name: 'qa-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
      },
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        labels: { 'clerum.io/workflow-run-id': 'run-123' },
      },
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    })

    const r = await reconciler.reconcile(recipe)

    // Fail-closed: requeue, and DO NOT claim the credential was revoked.
    expect(r.requeueAfterMs).toBeGreaterThan(0)
    expect(r.skipStatusPatch).toBe(true)
    const cond = (r.secretOwnershipConditions ?? []).find(
      c => c.type === 'EnvSecretOwnershipDenied'
    )
    expect(cond?.status).not.toBe('True')
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('requeues (NO false "revoked") when StatefulSet revocation teardown FAILS (Issue #637 fail-closed)', async () => {
    // If teardown throws (e.g. RBAC 403 / apiserver 5xx on the Pod deletecollection),
    // the foreign credential is still live — the code must NOT report
    // EnvSecretOwnershipDenied=True (a status lie); it must requeue and retry. Reverting
    // the try/catch+requeue (back to `.catch(() => undefined)` + hadDenied:true) makes
    // this red. Also asserts the data-safety guard holds on failure.
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
          ensureMcpHostRuntimeCredentials?: () => Promise<void>
        }
      }
    ).workflowReconciler = {
      reconcile: workflowReconcile,
      validateWorkflowSpec: () => undefined,
      ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
    }

    // qa-creds is foreign → denied → teardown attempted.
    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === 'qa-creds'
        ? Promise.resolve({
            metadata: {
              resourceVersion: '1',
              labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
            },
            data: { token: 'eA==' },
          })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )
    // The StatefulSet Pod deletecollection (the revocation teardown) FAILS with a non-404.
    mockCoreApi.deleteCollectionNamespacedPod.mockRejectedValue({
      code: 500,
      body: { message: 'teardown boom' },
    })

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            envSecret: { name: 'qa-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA workload.' }],
      },
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        labels: { 'clerum.io/workflow-run-id': 'run-123' },
      },
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    })

    const r = await reconciler.reconcile(recipe)

    // The credential is still live (delete failed) → requeue, NOT a false "revoked".
    expect(r.requeueAfterMs).toBeGreaterThan(0)
    expect(r.skipStatusPatch).toBe(true)
    const cond = (r.secretOwnershipConditions ?? []).find(
      c => c.type === 'EnvSecretOwnershipDenied'
    )
    expect(cond?.status).not.toBe('True')
    // Data-safety preserved even on failure: the StatefulSet object is never deleted.
    expect(mockAppsApi.deleteNamespacedStatefulSet).not.toHaveBeenCalled()
  })

  it('requeues (NO false "revoked") when a steady DEPLOYMENT revocation teardown delete FAILS non-404 (Issue #637 fail-closed, steady enforcer 3997)', async () => {
    // Mirror of the deploy-path CRITICAL test, but on the STEADY enforcer path: a denied
    // Deployment's REAL delete fails non-404. Before the safeDelete fix the steady enforcer
    // swallowed it and returned hadDenied:true → EnvSecretOwnershipDenied=True (a false
    // "revoked" over a still-live foreign pod). Now deleteOrThrow propagates and the enforcer
    // requeues. Reverting throwOnError on the Deployment teardown makes this red — closing the
    // gap that the StatefulSet-only steady tests above left (they use deleteCollectionNamespacedPod,
    // which already threw pre-fix; the Deployment path went through the swallowing safeDelete).
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
          ensureMcpHostRuntimeCredentials?: () => Promise<void>
        }
      }
    ).workflowReconciler = {
      reconcile: workflowReconcile,
      validateWorkflowSpec: () => undefined,
      ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
    }

    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === 'qa-creds'
        ? Promise.resolve({
            metadata: {
              resourceVersion: '1',
              labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
            },
            data: { token: 'eA==' },
          })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )
    // The Deployment delete (the revocation teardown) FAILS with a non-404.
    mockAppsApi.deleteNamespacedDeployment.mockRejectedValue({
      code: 500,
      body: { message: 'teardown boom' },
    })

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
            port: 8080,
            envSecret: { name: 'qa-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA workload.' }],
      },
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        labels: { 'clerum.io/workflow-run-id': 'run-123' },
      },
      status: { phase: 'active', workflowExecution: { phase: 'running' } },
    })

    const r = await reconciler.reconcile(recipe)

    // The credential is still live (delete failed) → requeue, NOT a false "revoked".
    expect(r.requeueAfterMs).toBeGreaterThan(0)
    expect(r.skipStatusPatch).toBe(true)
    const cond = (r.secretOwnershipConditions ?? []).find(
      c => c.type === 'EnvSecretOwnershipDenied'
    )
    expect(cond?.status).not.toBe('True')

    // Restore the shared delete mock: the suite clears call history but not mock
    // implementations, so this failure injection would otherwise leak into the next
    // test (which relies on deleteNamespacedDeployment succeeding).
    mockAppsApi.deleteNamespacedDeployment.mockResolvedValue({})
  })

  it('revokes an IN-PROGRESS (deploying+running) workflow workload when its Secret is re-labeled foreign (Issue #637)', async () => {
    // The in-progress short-circuit (phase 'deploying'/'failed' + a running execution
    // that is NOT initializing/recovering) is a DISTINCT branch from the active
    // short-circuit and must enforce revocation too. Reverting the
    // revokeOrRequeueSteadyWorkflow call on the in-progress branch makes this red.
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
          ensureMcpHostRuntimeCredentials?: () => Promise<void>
        }
      }
    ).workflowReconciler = {
      reconcile: workflowReconcile,
      validateWorkflowSpec: () => undefined,
      ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
    }

    mockCoreApi.readNamespacedSecret.mockImplementation((args: { name: string }) =>
      args.name === 'qa-creds'
        ? Promise.resolve({
            metadata: {
              resourceVersion: '1',
              labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
            },
            data: { token: 'eA==' },
          })
        : Promise.resolve({ metadata: { resourceVersion: '1' } })
    )

    const recipe = makeRecipe({
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        workloads: [
          {
            id: 'qa-api',
            type: 'deployment',
            image: 'qa-api:test',
            port: 8080,
            envSecret: { name: 'qa-creds', keys: [{ secretKey: 'token', envVar: 'TOKEN' }] },
          },
        ],
        steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
      },
      // phase 'deploying' + execution 'running' (not initializing/recovering) → the
      // in-progress short-circuit (NOT the active branch, NOT the full deploy path).
      status: { phase: 'deploying', workflowExecution: { phase: 'running' } },
    })

    const r = await reconciler.reconcile(recipe)

    const cond = (r.secretOwnershipConditions ?? []).find(
      c => c.type === 'EnvSecretOwnershipDenied'
    )
    expect(cond?.status).toBe('True')
    expect(r.skipStatusPatch).toBeFalsy()
    expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalled()
    // The coordinator was NOT re-driven (in-progress short-circuit, not the deploy path).
    expect(workflowReconcile).not.toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('fails workflow reconciliation before workload deploy when a template is unresolved', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          triggers: { onDemand: { allowedActors: ['user'] } },
          workloads: [
            {
              id: 'qa-api',
              type: 'deployment',
              image: 'qa-api:test',
              args: ['--db-host={{postgres:host}}'],
            },
          ],
          steps: [{ id: 'run-qa', instruction: 'Validate the QA API workload.' }],
        },
        status: { phase: 'candidate' },
      })
    )

    expect(result.phase).toBe('failed')
    expect(result.message).toContain('spec.workloads[0].args[0]')
    expect(result.message).toContain('postgres:host')
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedService).not.toHaveBeenCalled()
    expect(workflowReconcile).not.toHaveBeenCalled()
  })

  it('fails classic reconciliation with the same actionable template error format', async () => {
    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          workloads: [
            {
              id: 'qa-api',
              type: 'deployment',
              image: 'qa-api:test',
              args: ['--db-host={{postgres:host}}'],
            },
          ],
        },
      })
    )

    expect(result.phase).toBe('failed')
    expect(result.message).toBe(
      'spec.workloads[0].args[0]: Unresolved template reference: "postgres:host"'
    )
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedService).not.toHaveBeenCalled()
  })

  it('repairs workflow mcpHost runtime credentials before skipping completed active workflows', async () => {
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    const teardownComputePodsForTerminalRun = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
          teardownComputePodsForTerminalRun: typeof teardownComputePodsForTerminalRun
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = {
      ensureMcpHostRuntimeCredentials,
      teardownComputePodsForTerminalRun,
      validateWorkflowSpec: () => undefined,
    }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
        message: 'Workflow completed',
        workflowExecution: { phase: 'completed' },
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow completed',
      skipStatusPatch: true,
    })
    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'child-run',
      recipe.spec,
      'parent-recipe',
      'uid-child'
    )
    expect(mockVerifyWorkflowRunProvenance).toHaveBeenCalledWith({
      runId: 'run-child',
      parentNamespace: 'sandbox-recipes',
      parentName: 'parent-recipe',
      childNamespace: 'sandbox-recipes',
      childName: 'child-run',
    })
    // Terminal run-scoped workflow → compute pods are freed.
    expect(teardownComputePodsForTerminalRun).toHaveBeenCalledWith('child-run')
  })

  describe('terminal-run compute teardown (CPU-starvation fix)', () => {
    type TeardownStub = {
      ensureMcpHostRuntimeCredentials: ReturnType<typeof vi.fn>
      teardownComputePodsForTerminalRun: ReturnType<typeof vi.fn>
      reconcile: ReturnType<typeof vi.fn>
      validateWorkflowSpec: () => undefined
    }

    function stubWorkflowReconciler(): TeardownStub {
      const stub: TeardownStub = {
        ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
        teardownComputePodsForTerminalRun: vi.fn().mockResolvedValue(undefined),
        // Long-lived (non-run-scoped) recipes fall through to the inner
        // reconcile; stub it so the fall-through path does not crash.
        reconcile: vi.fn().mockResolvedValue({
          phase: 'active',
          message: 'Workflow infrastructure created',
          workflowPhase: 'completed',
        }),
        validateWorkflowSpec: () => undefined,
      }
      ;(reconciler as unknown as { workflowReconciler: TeardownStub }).workflowReconciler = stub
      return stub
    }

    function makeTerminalRunRecipe(
      overrides: {
        name?: string
        phase?: 'completed' | 'failed' | 'cancelled'
        runScoped?: boolean
        transport?: boolean
        // A PVC-backed stateful transport workload — the over-delete guard
        // must SKIP it (never delete a StatefulSet / its PVC).
        statefulTransport?: boolean
      } = {}
    ): WorkflowRecipeCRD {
      const name = overrides.name ?? 'wf-run-123'
      const runScoped = overrides.runScoped ?? true
      const phase = overrides.phase ?? 'completed'
      const labels: Record<string, string> = {
        'clerum.io/parent-recipe': 'parent-recipe',
      }
      if (runScoped) labels['clerum.io/workflow-run-id'] = 'run-123'
      const workloads: WorkloadDef[] = []
      const workloadInstances: Record<string, string> = {}
      if (overrides.transport) {
        workloads.push({
          id: 'web-search',
          type: 'deployment',
          image: 'web-search:latest',
          transport: { type: 'streamableHttp', path: '/mcp' },
        })
        // Pin the run-scoped resolved name so the Deployment delete is
        // deterministic (resolveWorkloadResourceName status fast-path).
        workloadInstances['web-search'] = `${name}-web-search-run`
      }
      if (overrides.statefulTransport) {
        workloads.push({
          id: 'stateful-mcp',
          type: 'statefulset',
          image: 'stateful-mcp:latest',
          transport: { type: 'streamableHttp', path: '/mcp' },
          volumeClaimTemplates: [
            { name: 'data', storageClass: 'standard', accessMode: 'ReadWriteOnce', size: '1Gi' },
          ],
        } as WorkloadDef)
        workloadInstances['stateful-mcp'] = `${name}-stateful-mcp-run`
      }
      return makeRecipe({
        metadata: {
          name,
          namespace: 'sandbox-recipes',
          uid: `uid-${name}`,
          labels,
          ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
        },
        spec: {
          ...(workloads.length ? { workloads } : {}),
          steps: [{ id: 'research', instruction: 'run' }],
        },
        status: {
          phase: phase === 'completed' ? 'active' : 'failed',
          message: `Workflow ${phase}`,
          ...(Object.keys(workloadInstances).length ? { workloadInstances } : {}),
          workflowExecution: { phase },
        } as WorkflowRecipeCRD['status'],
      })
    }

    it('frees compute pods for a terminal run-scoped workflow', async () => {
      const stub = stubWorkflowReconciler()
      const recipe = makeTerminalRunRecipe({ name: 'wf-run-completed', phase: 'completed' })

      await reconciler.reconcile(recipe)

      expect(stub.teardownComputePodsForTerminalRun).toHaveBeenCalledWith('wf-run-completed')
    })

    it('frees compute pods for a terminal FAILED run too', async () => {
      const stub = stubWorkflowReconciler()
      const recipe = makeTerminalRunRecipe({ name: 'wf-run-failed', phase: 'failed' })

      await reconciler.reconcile(recipe)

      expect(stub.teardownComputePodsForTerminalRun).toHaveBeenCalledWith('wf-run-failed')
    })

    it('frees compute pods for a terminal CANCELLED run too', async () => {
      const stub = stubWorkflowReconciler()
      const recipe = makeTerminalRunRecipe({ name: 'wf-run-cancelled', phase: 'cancelled' })

      const result = await reconciler.reconcile(recipe)

      expect(result.phase).toBe('failed')
      expect(stub.teardownComputePodsForTerminalRun).toHaveBeenCalledWith('wf-run-cancelled')
      expect(stub.reconcile).not.toHaveBeenCalled()
    })

    it('deletes the cross-namespace transport McpServer CRD AND its WRC-owned Deployment on terminal', async () => {
      const stub = stubWorkflowReconciler()
      mockCustomApi.deleteNamespacedCustomObject.mockClear()
      mockAppsApi.deleteNamespacedDeployment.mockClear()
      const recipe = makeTerminalRunRecipe({
        name: 'wf-run-transport',
        phase: 'completed',
        transport: true,
      })

      await reconciler.reconcile(recipe)

      expect(stub.teardownComputePodsForTerminalRun).toHaveBeenCalledWith('wf-run-transport')
      // (a) McpServer CRD deleted by recipe scope (delegation cleanup).
      expect(mockCustomApi.deleteNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({ plural: 'mcpservers' })
      )
      // (b) CRITICAL: the WRC-owned (managed:false) Deployment is HTTP transport
      // → NOT HCC-GC'd → must be deleted directly, or the ~100m pod leaks. Assert
      // the run-scoped Deployment delete happened in the mcp-server namespace.
      expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'wf-run-transport-web-search-run',
          namespace: 'mcp-server',
        })
      )
    })

    it('still deletes terminal transport resources when workflow reconciler is unavailable', async () => {
      ;(reconciler as unknown as { workflowReconciler?: undefined }).workflowReconciler = undefined
      mockCustomApi.deleteNamespacedCustomObject.mockClear()
      mockAppsApi.deleteNamespacedDeployment.mockClear()
      const recipe = makeTerminalRunRecipe({
        name: 'wf-run-transport-no-wfr',
        phase: 'failed',
        transport: true,
      })

      const result = await reconciler.reconcile(recipe)

      expect(result.phase).toBe('failed')
      expect(mockCustomApi.deleteNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({ plural: 'mcpservers' })
      )
      expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'wf-run-transport-no-wfr-web-search-run',
          namespace: 'mcp-server',
        })
      )
    })

    it('over-delete guard: a stateful transport workload is NEVER deleted (no StatefulSet, no PVC delete)', async () => {
      stubWorkflowReconciler()
      mockAppsApi.deleteNamespacedStatefulSet.mockClear()
      mockAppsApi.deleteNamespacedDeployment.mockClear()
      mockCoreApi.deleteNamespacedPersistentVolumeClaim.mockClear()
      const recipe = makeTerminalRunRecipe({
        name: 'wf-run-stateful',
        phase: 'completed',
        statefulTransport: true,
      })

      await reconciler.reconcile(recipe)

      // The stateful transport workload (PVC-backed) must be skipped entirely.
      expect(mockAppsApi.deleteNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
      // And it must NOT be deleted as a Deployment either.
      expect(mockAppsApi.deleteNamespacedDeployment).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: 'wf-run-stateful-stateful-mcp-run' })
      )
    })

    it('does NOT tear down a non-run-scoped (long-lived) recipe', async () => {
      const stub = stubWorkflowReconciler()
      const recipe = makeTerminalRunRecipe({
        name: 'long-lived',
        phase: 'completed',
        runScoped: false,
      })

      await reconciler.reconcile(recipe)

      expect(stub.teardownComputePodsForTerminalRun).not.toHaveBeenCalled()
    })

    it('is best-effort: a teardown failure does not block the terminal status result', async () => {
      const stub = stubWorkflowReconciler()
      stub.teardownComputePodsForTerminalRun.mockRejectedValueOnce(new Error('K8s API blip'))
      const recipe = makeTerminalRunRecipe({ name: 'wf-run-flaky', phase: 'completed' })

      const result = await reconciler.reconcile(recipe)

      expect(stub.teardownComputePodsForTerminalRun).toHaveBeenCalledWith('wf-run-flaky')
      // The terminal phase still resolves — artifacts/CR are preserved regardless.
      expect(result.phase).toBe('active')
    })

    it('re-running a terminal reconcile stays idempotent (teardown invoked again, never recreates)', async () => {
      const stub = stubWorkflowReconciler()
      const recipe = makeTerminalRunRecipe({ name: 'wf-run-idem', phase: 'completed' })

      await reconciler.reconcile(recipe)
      await reconciler.reconcile(recipe)

      // Inner reconcile (which creates/recreates pods) is never invoked on the
      // terminal path; only the idempotent teardown runs, each pass.
      expect(stub.teardownComputePodsForTerminalRun).toHaveBeenCalledTimes(2)
      expect(stub.reconcile).not.toHaveBeenCalled()
    })
  })

  it('repairs active normal DB-run workflow credentials using verified parent provenance', async () => {
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureMcpHostRuntimeCredentials }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow completed',
      skipStatusPatch: true,
    })
    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'child-run',
      recipe.spec,
      'parent-recipe',
      'uid-child'
    )
  })

  it('uses the child runtime identity when the DB run does not bind the exact child', async () => {
    mockVerifyWorkflowRunProvenance.mockResolvedValue('invalid')
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureMcpHostRuntimeCredentials }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: { steps: [{ id: 'research', instruction: 'run' }] },
      status: { phase: 'active' } as WorkflowRecipeCRD['status'],
    })

    await reconciler.reconcile(recipe)

    expect(mockVerifyWorkflowRunProvenance).toHaveBeenCalledWith({
      runId: 'run-child',
      parentNamespace: 'sandbox-recipes',
      parentName: 'parent-recipe',
      childNamespace: 'sandbox-recipes',
      childName: 'child-run',
    })
    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'child-run',
      recipe.spec,
      'child-run',
      'uid-child'
    )
  })

  it('requeues a Pending DB binding before creating or rotating workflow runtime resources', async () => {
    mockVerifyWorkflowRunProvenance.mockResolvedValue('pending')
    const ensureCoordinatorRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    const refreshRuntimeHttpEgressNetworkPolicies = vi.fn().mockResolvedValue(undefined)
    const reconcileWorkflow = vi.fn().mockResolvedValue({ phase: 'active', message: 'unexpected' })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureCoordinatorRuntimeCredentials: typeof ensureCoordinatorRuntimeCredentials
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
          refreshRuntimeHttpEgressNetworkPolicies: typeof refreshRuntimeHttpEgressNetworkPolicies
          reconcile: typeof reconcileWorkflow
        }
      }
    ).workflowReconciler = {
      ensureCoordinatorRuntimeCredentials,
      ensureMcpHostRuntimeCredentials,
      refreshRuntimeHttpEgressNetworkPolicies,
      reconcile: reconcileWorkflow,
    }
    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: { steps: [{ id: 'research', instruction: 'run' }] },
      status: {
        phase: 'active',
        message: 'Workflow running',
        workflowExecution: { phase: 'running' },
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow running',
      skipStatusPatch: true,
      requeueAfterMs: TRANSIENT_REQUEUE_BASE_MS,
    })
    expect(ensureCoordinatorRuntimeCredentials).not.toHaveBeenCalled()
    expect(ensureMcpHostRuntimeCredentials).not.toHaveBeenCalled()
    expect(refreshRuntimeHttpEgressNetworkPolicies).not.toHaveBeenCalled()
    expect(reconcileWorkflow).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedSecret).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('requeues a transient DB provenance failure without downgrading to child identity', async () => {
    mockVerifyWorkflowRunProvenance.mockRejectedValue(new Error('ECONNRESET'))
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureMcpHostRuntimeCredentials }
    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: { steps: [{ id: 'research', instruction: 'run' }] },
      status: {
        phase: 'active',
        message: 'Workflow running',
        workflowExecution: { phase: 'running' },
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow running',
      skipStatusPatch: true,
      requeueAfterMs: TRANSIENT_REQUEUE_BASE_MS,
    })
    expect(ensureMcpHostRuntimeCredentials).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedSecret).not.toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      name: 'child-run-coordinator-to-gfs',
      namespace: 'sandbox-recipes',
      body: {
        preconditions: {
          uid: 'uid-child-run-coordinator-to-gfs',
          resourceVersion: '1',
        },
      },
    })
  })

  it('does not open coordinator GFS egress while a child DB binding is Pending', async () => {
    mockVerifyWorkflowRunProvenance.mockResolvedValue('pending')
    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
        gfs: { publishTargets: [{ drive: 'main', target: 'outputs' }] },
      },
      status: {
        phase: 'active',
        message: 'Workflow running',
        workflowExecution: { phase: 'running' },
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow running',
      skipStatusPatch: true,
      requeueAfterMs: TRANSIENT_REQUEUE_BASE_MS,
    })
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('requeues a transient owner lookup failure without downgrading to child identity', async () => {
    mockCustomApi.getNamespacedCustomObject
      .mockReset()
      .mockResolvedValueOnce({ metadata: { uid: 'uid-child' } })
      .mockRejectedValueOnce({ code: 503 })
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureMcpHostRuntimeCredentials }
    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: { steps: [{ id: 'research', instruction: 'run' }] },
      status: {
        phase: 'active',
        message: 'Workflow running',
        workflowExecution: { phase: 'running' },
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow running',
      skipStatusPatch: true,
      requeueAfterMs: TRANSIENT_REQUEUE_BASE_MS,
    })
    expect(mockVerifyWorkflowRunProvenance).not.toHaveBeenCalled()
    expect(ensureMcpHostRuntimeCredentials).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedSecret).not.toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('uses the child runtime identity when the workflow run id is missing', async () => {
    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: { 'clerum.io/parent-recipe': 'parent-recipe' },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: { steps: [{ id: 'research', instruction: 'run' }] },
      status: { phase: 'active' } as WorkflowRecipeCRD['status'],
    })

    const runtimeScope = await (
      reconciler as unknown as {
        workflowRuntimeScopeRecipeName: (input: WorkflowRecipeCRD) => Promise<string>
      }
    ).workflowRuntimeScopeRecipeName(recipe)

    expect(mockVerifyWorkflowRunProvenance).not.toHaveBeenCalled()
    expect(runtimeScope).toBe('child-run')
  })

  it('keeps the verified parent identity when the live parent GFS changes after run creation', async () => {
    mockCustomApi.getNamespacedCustomObject.mockResolvedValue({
      metadata: { uid: 'uid-parent-recipe', resourceVersion: '1' },
      spec: {
        gfs: {
          mounts: [
            {
              drive: 'main',
              target: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              scopes: ['gfs.write'],
            },
          ],
        },
      },
    })

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
        gfs: {
          mounts: [
            {
              drive: 'main',
              target: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              scopes: ['gfs.read'],
            },
          ],
        },
      },
      status: { phase: 'active' } as WorkflowRecipeCRD['status'],
    })

    const runtimeScope = await (
      reconciler as unknown as {
        workflowRuntimeScopeRecipeName: (input: WorkflowRecipeCRD) => Promise<string>
      }
    ).workflowRuntimeScopeRecipeName(recipe)

    expect(mockVerifyWorkflowRunProvenance).toHaveBeenCalledWith({
      runId: 'run-child',
      parentNamespace: 'sandbox-recipes',
      parentName: 'parent-recipe',
      childNamespace: 'sandbox-recipes',
      childName: 'child-run',
    })
    expect(runtimeScope).toBe('parent-recipe')
    expect(recipe.spec.gfs?.mounts?.[0]?.scopes).toEqual(['gfs.read'])
  })

  it('does not trust forged controller ownerReferences with mismatched UIDs', async () => {
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureMcpHostRuntimeCredentials }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [
          {
            ...workflowRecipeOwnerRef('parent-recipe'),
            uid: 'forged-parent-uid',
          },
        ],
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
      } as WorkflowRecipeCRD['status'],
    })

    await reconciler.reconcile(recipe)

    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'child-run',
      recipe.spec,
      'child-run',
      'uid-child'
    )
  })

  it('does not trust controller ownerReferences whose target WorkflowRecipe is missing', async () => {
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureMcpHostRuntimeCredentials }
    mockCustomApi.getNamespacedCustomObject
      .mockReset()
      .mockResolvedValueOnce({ metadata: { uid: 'uid-child' } })
      .mockRejectedValueOnce({ code: 404 })

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'missing-parent',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('missing-parent')],
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
      } as WorkflowRecipeCRD['status'],
    })

    await reconciler.reconcile(recipe)

    expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'clerum.io',
      version: 'v1alpha1',
      namespace: 'sandbox-recipes',
      plural: 'workflowrecipes',
      name: 'missing-parent',
    })
    expect(mockVerifyWorkflowRunProvenance).not.toHaveBeenCalled()
    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'child-run',
      recipe.spec,
      'child-run',
      'uid-child'
    )
  })

  it('does not trust controller ownerReferences whose live owner is deleting', async () => {
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureMcpHostRuntimeCredentials }
    mockCustomApi.getNamespacedCustomObject.mockImplementation(({ name }: { name?: string }) =>
      Promise.resolve({
        metadata: {
          uid: liveWorkflowRecipeUid(name),
          deletionTimestamp: name === 'parent-recipe' ? '2026-05-06T00:00:00Z' : undefined,
          resourceVersion: '1',
          annotations: { 'clerum.io/network-ready': 'true' },
          labels: { 'clerum.io/recipe': 'test-recipe' },
        },
        spec: { mcpServers: [] },
      })
    )

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
      } as WorkflowRecipeCRD['status'],
    })

    await reconciler.reconcile(recipe)

    expect(mockCustomApi.getNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'clerum.io',
      version: 'v1alpha1',
      namespace: 'sandbox-recipes',
      plural: 'workflowrecipes',
      name: 'parent-recipe',
    })
    expect(mockVerifyWorkflowRunProvenance).not.toHaveBeenCalled()
    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'child-run',
      recipe.spec,
      'child-run',
      'uid-child'
    )
  })

  it('does not trust WorkflowRecipe ownerReferences without a UID', async () => {
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureMcpHostRuntimeCredentials }

    const ownerRefWithoutUid = { ...workflowRecipeOwnerRef('parent-recipe'), uid: undefined }
    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [ownerRefWithoutUid],
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
      } as WorkflowRecipeCRD['status'],
    })

    await reconciler.reconcile(recipe)

    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'child-run',
      recipe.spec,
      'child-run',
      'uid-child'
    )
  })

  it('does not trust parent-recipe labels without a controller ownerReference', async () => {
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureMcpHostRuntimeCredentials }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        labels: {
          'clerum.io/parent-recipe': 'victim-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
      } as WorkflowRecipeCRD['status'],
    })

    await reconciler.reconcile(recipe)

    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'child-run',
      recipe.spec,
      'child-run',
      'uid-child'
    )
  })

  it('binds Codex context as uncertain when parent labels are claimed without provenance', async () => {
    const setCodexReconcileContext = vi.fn()
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          setCodexReconcileContext: typeof setCodexReconcileContext
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { setCodexReconcileContext, ensureMcpHostRuntimeCredentials }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        labels: {
          'clerum.io/parent-recipe': 'victim-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
      },
      spec: {
        agent: { provider: 'codex-subscription', model: 'gpt-5.3-codex' },
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
      } as WorkflowRecipeCRD['status'],
    })

    await reconciler.reconcile(recipe)

    expect(setCodexReconcileContext).toHaveBeenCalledWith({
      recipeUid: 'uid-child',
      recipeName: 'child-run',
      runtimeScopeRecipeName: 'child-run',
      claimedParent: true,
      parentSpec: null,
      connectionKey: 'unassigned',
    })
  })

  it('binds the inherited parent Codex spec when child provenance is verified', async () => {
    const parentSpec = {
      agent: { provider: 'codex-subscription' as const, model: 'gpt-5.3-codex' },
      steps: [{ id: 'research', instruction: 'parent target' }],
    }
    mockCustomApi.getNamespacedCustomObject.mockImplementation(({ name }: { name?: string }) =>
      Promise.resolve({
        metadata: {
          uid: liveWorkflowRecipeUid(name),
          resourceVersion: '1',
        },
        spec: name === 'parent-recipe' ? parentSpec : { mcpServers: [] },
      })
    )
    const setCodexReconcileContext = vi.fn()
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          setCodexReconcileContext: typeof setCodexReconcileContext
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { setCodexReconcileContext, ensureMcpHostRuntimeCredentials }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: {
        agent: { provider: 'openai', model: 'gpt-5.4-mini' },
        steps: [{ id: 'research', instruction: 'child body must not win' }],
      },
      status: {
        phase: 'active',
      } as WorkflowRecipeCRD['status'],
    })

    await reconciler.reconcile(recipe)

    expect(setCodexReconcileContext).toHaveBeenCalledWith({
      recipeUid: 'uid-child',
      recipeName: 'child-run',
      runtimeScopeRecipeName: 'parent-recipe',
      claimedParent: true,
      parentSpec,
      connectionKey: 'unassigned',
    })
  })

  it('binds the inherited parent Codex grant annotation to the reconcile context', async () => {
    const parentSpec = {
      agent: { provider: 'codex-subscription' as const, model: 'gpt-5.3-codex' },
      steps: [{ id: 'research', instruction: 'parent target' }],
    }
    mockCustomApi.getNamespacedCustomObject.mockImplementation(({ name }: { name?: string }) =>
      Promise.resolve({
        metadata: {
          uid: liveWorkflowRecipeUid(name),
          resourceVersion: '1',
          ...(name === 'parent-recipe'
            ? { annotations: { 'clerum.io/codex-connection-ref': 'team-plus' } }
            : {}),
        },
        spec: name === 'parent-recipe' ? parentSpec : { mcpServers: [] },
      })
    )
    const setCodexReconcileContext = vi.fn()
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          setCodexReconcileContext: typeof setCodexReconcileContext
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { setCodexReconcileContext, ensureMcpHostRuntimeCredentials }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        annotations: { [INHERITED_PARENT_RESOURCES_ANNOTATION]: 'true' },
        labels: {
          'clerum.io/parent-recipe': 'parent-recipe',
          'clerum.io/workflow-run-id': 'run-child',
        },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: {
        agent: { provider: 'openai', model: 'gpt-5.4-mini' },
        steps: [{ id: 'research', instruction: 'child body must not win' }],
      },
      status: {
        phase: 'active',
      } as WorkflowRecipeCRD['status'],
    })

    await reconciler.reconcile(recipe)

    expect(setCodexReconcileContext).toHaveBeenCalledWith({
      recipeUid: 'uid-child',
      recipeName: 'child-run',
      runtimeScopeRecipeName: 'parent-recipe',
      claimedParent: true,
      parentSpec,
      connectionKey: 'team-plus',
    })
  })

  it('does not inherit a parent scope on first reconcile without DB-run metadata', async () => {
    const reconcileWorkflow = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof reconcileWorkflow
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: reconcileWorkflow, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        labels: { 'clerum.io/parent-recipe': 'spoofed-parent' },
        ownerReferences: [workflowRecipeOwnerRef('parent-recipe')],
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'candidate',
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    expect(reconcileWorkflow).toHaveBeenCalledWith(
      'child-run',
      'uid-child',
      'sandbox-recipes',
      expect.objectContaining({ steps: recipe.spec.steps }),
      expect.objectContaining({ workflowExecution: undefined }),
      {},
      'child-run',
      undefined,
      undefined,
      undefined,
      undefined
    )
  })

  it('enforces configured workflow limits before resolving step MCP servers', async () => {
    const reconcileWorkflow = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof reconcileWorkflow
        }
        config: { workflowStepMcpServersMaxItems: number }
      }
    ).workflowReconciler = { reconcile: reconcileWorkflow }
    ;(
      reconciler as unknown as {
        config: { workflowStepMcpServersMaxItems: number }
      }
    ).config.workflowStepMcpServersMaxItems = 2

    const result = await reconciler.reconcile(
      makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          steps: [
            {
              id: 'research',
              instruction: 'run',
              mcpServers: ['srv0', 'srv1', 'srv2'],
            },
          ],
        },
        status: { phase: 'candidate' } as WorkflowRecipeCRD['status'],
      })
    )

    expect(result).toMatchObject({
      phase: 'failed',
      message: 'spec.steps[0].mcpServers must contain at most 2 items',
    })
    expect(reconcileWorkflow).not.toHaveBeenCalled()
  })

  it('passes workflow admin usage actor labels into the runtime reconciler', async () => {
    const reconcileWorkflow = vi.fn().mockResolvedValue({
      phase: 'deploying',
      message: 'Workflow infrastructure created',
      workflowPhase: 'initializing',
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof reconcileWorkflow
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: reconcileWorkflow, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        labels: {
          'clerum.io/workflow-run-id': '00000000-0000-4000-8000-000000000123',
          'clerum.io/workflow-team-id': 'control-plane-admin-ui',
          'clerum.io/workflow-actor-id': '11111111-1111-4111-8111-111111111111',
          'clerum.io/workflow-actor-type': 'admin',
        },
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'candidate',
      } as WorkflowRecipeCRD['status'],
    })

    await reconciler.reconcile(recipe)

    expect(reconcileWorkflow).toHaveBeenCalledWith(
      'child-run',
      'uid-child',
      'sandbox-recipes',
      expect.objectContaining({ steps: recipe.spec.steps }),
      expect.objectContaining({ workflowExecution: undefined }),
      {},
      'child-run',
      '00000000-0000-4000-8000-000000000123',
      'control-plane-admin-ui',
      '11111111-1111-4111-8111-111111111111',
      'admin'
    )
  })

  it('repairs failed parent workflows without a run id as active trigger infrastructure', async () => {
    const reconcileWorkflow = vi.fn().mockResolvedValue({
      phase: 'active',
      message: 'Workflow trigger infrastructure registered (workflow-agentic)',
      clearWorkflowExecution: true,
    })
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof reconcileWorkflow
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = { reconcile: reconcileWorkflow, validateWorkflowSpec: () => undefined }

    const recipe = makeRecipe({
      metadata: {
        name: 'e2e-parent',
        namespace: 'sandbox-recipes',
        uid: 'uid-parent',
        labels: {},
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'failed',
        workflowExecution: { phase: 'failed' },
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow trigger infrastructure registered (workflow-agentic)',
      clearWorkflowExecution: true,
    })
    expect(reconcileWorkflow).toHaveBeenCalledWith(
      'e2e-parent',
      'uid-parent',
      'sandbox-recipes',
      expect.objectContaining({ steps: recipe.spec.steps }),
      expect.objectContaining({ workflowExecution: { phase: 'failed' } }),
      {},
      'e2e-parent',
      undefined,
      undefined,
      undefined,
      undefined
    )
  })

  it('marks running workflow infrastructure active before skipping reconcile', async () => {
    const ensureCoordinatorRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureCoordinatorRuntimeCredentials: typeof ensureCoordinatorRuntimeCredentials
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = {
      ensureCoordinatorRuntimeCredentials,
      ensureMcpHostRuntimeCredentials,
      validateWorkflowSpec: () => undefined,
    }

    const recipe = makeRecipe({
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        labels: { 'clerum.io/workflow-run-id': 'run-test' },
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'deploying',
        workflowExecution: { phase: 'running' },
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow running',
      skipStatusPatch: false,
    })
    expect(ensureCoordinatorRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'test-recipe',
      recipe.spec,
      'test-recipe'
    )
    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'test-recipe',
      recipe.spec,
      'test-recipe',
      'uid-123'
    )
  })

  it('keeps active running workflows active without another status patch', async () => {
    const ensureCoordinatorRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureCoordinatorRuntimeCredentials: typeof ensureCoordinatorRuntimeCredentials
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureCoordinatorRuntimeCredentials, ensureMcpHostRuntimeCredentials }

    const recipe = makeRecipe({
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        labels: { 'clerum.io/workflow-run-id': 'run-test' },
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
        workflowExecution: { phase: 'running' },
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow running',
      skipStatusPatch: true,
    })
    expect(ensureCoordinatorRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'test-recipe',
      recipe.spec,
      'test-recipe'
    )
    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalledWith(
      'sandbox-recipes',
      'test-recipe',
      recipe.spec,
      'test-recipe',
      'uid-123'
    )
  })

  describe('steady workflow coordinator GFS NetworkPolicy convergence', () => {
    function stubSteadyWorkflowRuntime(): void {
      ;(
        reconciler as unknown as {
          workflowReconciler: {
            ensureCoordinatorRuntimeCredentials: () => Promise<void>
            ensureMcpHostRuntimeCredentials: () => Promise<void>
          }
        }
      ).workflowReconciler = {
        ensureCoordinatorRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
        ensureMcpHostRuntimeCredentials: vi.fn().mockResolvedValue(undefined),
      }
    }

    function activeWorkflow(
      publishTargets?: Array<{ drive: string; target: string }>
    ): WorkflowRecipeCRD {
      return makeRecipe({
        metadata: {
          name: 'gfs-policy-workflow',
          namespace: 'sandbox-recipes',
          uid: 'uid-gfs-policy',
          labels: { 'clerum.io/workflow-run-id': 'run-gfs-policy' },
        },
        spec: {
          steps: [{ id: 'publish', instruction: 'publish output' }],
          gfs: publishTargets ? { publishTargets } : undefined,
        },
        status: {
          phase: 'active',
          workflowExecution: { phase: 'running' },
        } as WorkflowRecipeCRD['status'],
      })
    }

    it('creates the exact coordinator GFS policy when publishTargets become present', async () => {
      stubSteadyWorkflowRuntime()
      const recipe = activeWorkflow([{ drive: 'main', target: 'published-results' }])

      const result = await reconciler.reconcile(recipe)

      expect(result).toMatchObject({
        phase: 'active',
        message: 'Workflow running',
        skipStatusPatch: true,
      })
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledWith({
        namespace: 'sandbox-recipes',
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'gfs-policy-workflow-coordinator-to-gfs',
            namespace: 'sandbox-recipes',
          }),
          spec: expect.objectContaining({
            podSelector: {
              matchLabels: {
                'clerum.io/recipe': 'gfs-policy-workflow',
                'clerum.io/component': 'workflow-coordinator',
              },
            },
            egress: [
              {
                to: [
                  {
                    namespaceSelector: {
                      matchLabels: { 'kubernetes.io/metadata.name': 'gfs' },
                    },
                    podSelector: { matchLabels: { app: 'gfs-controller' } },
                  },
                ],
                ports: [{ port: 8087, protocol: 'TCP' }],
              },
            ],
          }),
        }),
      })
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('deletes only the exact coordinator GFS policy when publishTargets become absent', async () => {
      stubSteadyWorkflowRuntime()

      const result = await reconciler.reconcile(activeWorkflow())

      expect(result).toMatchObject({
        phase: 'active',
        message: 'Workflow running',
        skipStatusPatch: true,
      })
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'gfs-policy-workflow-coordinator-to-gfs',
        namespace: 'sandbox-recipes',
        body: {
          preconditions: {
            uid: 'uid-gfs-policy-workflow-coordinator-to-gfs',
            resourceVersion: '1',
          },
        },
      })
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('tolerates an already-absent coordinator GFS policy', async () => {
      stubSteadyWorkflowRuntime()
      mockNetworkingApi.readNamespacedNetworkPolicy.mockRejectedValueOnce({ code: 404 })

      const result = await reconciler.reconcile(activeWorkflow())

      expect(result).toMatchObject({
        phase: 'active',
        message: 'Workflow running',
        skipStatusPatch: true,
      })
      expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'gfs-policy-workflow-coordinator-to-gfs',
        namespace: 'sandbox-recipes',
      })
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('tolerates a concurrent 404 after reading the owned policy', async () => {
      stubSteadyWorkflowRuntime()
      mockNetworkingApi.deleteNamespacedNetworkPolicy.mockRejectedValueOnce({ code: 404 })

      const result = await reconciler.reconcile(activeWorkflow())

      expect(result).toMatchObject({ phase: 'active', message: 'Workflow running' })
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    })

    it('surfaces non-404 reads without attempting a delete', async () => {
      stubSteadyWorkflowRuntime()
      const apiError = { code: 503, message: 'apiserver unavailable' }
      mockNetworkingApi.readNamespacedNetworkPolicy.mockRejectedValueOnce(apiError)

      await expect(reconciler.reconcile(activeWorkflow())).rejects.toBe(apiError)
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('refuses to delete an owned policy without complete live identity', async () => {
      stubSteadyWorkflowRuntime()
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValueOnce({
        metadata: {
          name: 'gfs-policy-workflow-coordinator-to-gfs',
          resourceVersion: '7',
          labels: { 'clerum.io/managed-by': 'wrc', 'clerum.io/recipe': 'gfs-policy-workflow' },
        },
      })

      await expect(reconciler.reconcile(activeWorkflow())).rejects.toThrow(
        'live object identity is incomplete'
      )
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('surfaces non-404 revocation failures instead of reporting false convergence', async () => {
      stubSteadyWorkflowRuntime()
      const apiError = { code: 503, message: 'apiserver unavailable' }
      mockNetworkingApi.deleteNamespacedNetworkPolicy.mockRejectedValueOnce(apiError)

      await expect(reconciler.reconcile(activeWorkflow())).rejects.toBe(apiError)
    })

    it.each([
      {
        branch: 'awaiting-trigger',
        recipe: () =>
          makeRecipe({
            metadata: {
              name: 'gfs-policy-workflow',
              namespace: 'sandbox-recipes',
              uid: 'uid-gfs-policy',
            },
            spec: {
              agent: { provider: 'zai', model: 'glm-4.7' },
              triggers: { onDemand: { allowedActors: ['user'] } },
              steps: [{ id: 'publish', instruction: 'publish output' }],
            },
            status: { phase: 'active' },
          }),
        expected: {
          phase: 'active',
          message: 'Workflow trigger infrastructure registered',
          skipStatusPatch: true,
        },
      },
      {
        branch: 'terminal',
        recipe: () =>
          makeRecipe({
            metadata: {
              name: 'gfs-policy-workflow',
              namespace: 'sandbox-recipes',
              uid: 'uid-gfs-policy',
              labels: { 'clerum.io/workflow-run-id': 'run-gfs-policy' },
            },
            spec: {
              agent: { provider: 'zai', model: 'glm-4.7' },
              steps: [{ id: 'publish', instruction: 'publish output' }],
            },
            status: {
              phase: 'active',
              message: 'Workflow completed',
              workflowExecution: { phase: 'completed' },
            } as WorkflowRecipeCRD['status'],
          }),
        expected: {
          phase: 'active',
          message: 'Workflow completed',
          skipStatusPatch: true,
        },
      },
      {
        branch: 'in-progress',
        recipe: () =>
          makeRecipe({
            metadata: {
              name: 'gfs-policy-workflow',
              namespace: 'sandbox-recipes',
              uid: 'uid-gfs-policy',
            },
            spec: {
              agent: { provider: 'zai', model: 'glm-4.7' },
              steps: [{ id: 'publish', instruction: 'publish output' }],
            },
            status: {
              phase: 'deploying',
              workflowExecution: { phase: 'running' },
            } as WorkflowRecipeCRD['status'],
          }),
        expected: {
          phase: 'active',
          message: 'Workflow running',
          skipStatusPatch: false,
        },
      },
    ])('converges the absent policy without changing the $branch result', async testCase => {
      stubSteadyWorkflowRuntime()
      const workflowRuntime = (
        reconciler as unknown as {
          workflowReconciler: Record<string, unknown>
        }
      ).workflowReconciler
      workflowRuntime.teardownComputePodsForTerminalRun = vi.fn().mockResolvedValue(undefined)

      const result = await reconciler.reconcile(testCase.recipe())

      expect(result).toMatchObject(testCase.expected)
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'gfs-policy-workflow-coordinator-to-gfs',
        namespace: 'sandbox-recipes',
        body: {
          preconditions: {
            uid: 'uid-gfs-policy-workflow-coordinator-to-gfs',
            resourceVersion: '1',
          },
        },
      })
    })

    it.each([
      {
        branch: 'awaiting-trigger',
        recipe: () =>
          makeRecipe({
            metadata: {
              name: 'gfs-policy-workflow',
              namespace: 'sandbox-recipes',
              uid: 'uid-gfs-policy',
            },
            spec: {
              agent: { provider: 'zai', model: 'glm-4.7' },
              triggers: { onDemand: { allowedActors: ['user'] } },
              steps: [{ id: 'publish', instruction: 'publish output' }],
              gfs: { publishTargets: [{ drive: 'main', target: 'published-results' }] },
            },
            status: { phase: 'active' },
          }),
      },
      {
        branch: 'terminal',
        recipe: () =>
          makeRecipe({
            metadata: {
              name: 'gfs-policy-workflow',
              namespace: 'sandbox-recipes',
              uid: 'uid-gfs-policy',
              labels: { 'clerum.io/workflow-run-id': 'run-gfs-policy' },
            },
            spec: {
              agent: { provider: 'zai', model: 'glm-4.7' },
              steps: [{ id: 'publish', instruction: 'publish output' }],
              gfs: { publishTargets: [{ drive: 'main', target: 'published-results' }] },
            },
            status: {
              phase: 'active',
              message: 'Workflow completed',
              workflowExecution: { phase: 'completed' },
            } as WorkflowRecipeCRD['status'],
          }),
      },
      {
        branch: 'in-progress',
        recipe: () =>
          makeRecipe({
            metadata: {
              name: 'gfs-policy-workflow',
              namespace: 'sandbox-recipes',
              uid: 'uid-gfs-policy',
            },
            spec: {
              agent: { provider: 'zai', model: 'glm-4.7' },
              steps: [{ id: 'publish', instruction: 'publish output' }],
              gfs: { publishTargets: [{ drive: 'main', target: 'published-results' }] },
            },
            status: {
              phase: 'deploying',
              workflowExecution: { phase: 'running' },
            } as WorkflowRecipeCRD['status'],
          }),
      },
    ])('converges the present policy before returning from $branch', async testCase => {
      stubSteadyWorkflowRuntime()
      const workflowRuntime = (
        reconciler as unknown as { workflowReconciler: Record<string, unknown> }
      ).workflowReconciler
      workflowRuntime.teardownComputePodsForTerminalRun = vi.fn().mockResolvedValue(undefined)

      await reconciler.reconcile(testCase.recipe())

      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledWith({
        namespace: 'sandbox-recipes',
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'gfs-policy-workflow-coordinator-to-gfs',
          }),
        }),
      })
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('does not open coordinator GFS egress for a workflow rejected by preflight', async () => {
      stubSteadyWorkflowRuntime()
      const workflowRuntime = (
        reconciler as unknown as { workflowReconciler: Record<string, unknown> }
      ).workflowReconciler
      workflowRuntime.validateWorkflowSpec = vi.fn().mockReturnValue('invalid runtime spec')

      const result = await reconciler.reconcile(
        activeWorkflow([{ drive: 'main', target: 'published-results' }])
      )

      expect(result).toMatchObject({ phase: 'active', message: 'Workflow running' })
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'gfs-policy-workflow-coordinator-to-gfs',
        namespace: 'sandbox-recipes',
        body: {
          preconditions: {
            uid: 'uid-gfs-policy-workflow-coordinator-to-gfs',
            resourceVersion: '1',
          },
        },
      })
    })

    it('refuses to replace a homonymous policy not owned by the exact recipe', async () => {
      stubSteadyWorkflowRuntime()
      mockNetworkingApi.createNamespacedNetworkPolicy.mockRejectedValueOnce({ code: 409 })
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValueOnce({
        metadata: {
          name: 'gfs-policy-workflow-coordinator-to-gfs',
          uid: 'uid-foreign-policy',
          resourceVersion: '7',
          labels: { 'clerum.io/managed-by': 'operator', 'clerum.io/recipe': 'other-recipe' },
        },
      })

      await expect(
        reconciler.reconcile(activeWorkflow([{ drive: 'main', target: 'published-results' }]))
      ).rejects.toThrow('existing policy is not owned by WRC')
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('replaces the exact owned coordinator GFS policy with its live resourceVersion', async () => {
      stubSteadyWorkflowRuntime()
      mockNetworkingApi.createNamespacedNetworkPolicy.mockRejectedValueOnce({ code: 409 })
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValueOnce({
        metadata: {
          name: 'gfs-policy-workflow-coordinator-to-gfs',
          uid: 'uid-owned-policy',
          resourceVersion: '7',
          labels: { 'clerum.io/managed-by': 'wrc', 'clerum.io/recipe': 'gfs-policy-workflow' },
        },
      })

      await reconciler.reconcile(activeWorkflow([{ drive: 'main', target: 'published-results' }]))

      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'gfs-policy-workflow-coordinator-to-gfs',
        namespace: 'sandbox-recipes',
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'gfs-policy-workflow-coordinator-to-gfs',
            resourceVersion: '7',
          }),
        }),
      })
    })

    it('does not replace an already-converged owned policy', async () => {
      stubSteadyWorkflowRuntime()
      const existing = buildCoordinatorGfsNetworkPolicy({
        recipeName: 'gfs-policy-workflow',
        sandboxNamespace: 'sandbox-recipes',
      })
      existing.metadata = {
        ...existing.metadata,
        uid: 'uid-owned-policy',
        resourceVersion: '7',
      }
      mockNetworkingApi.createNamespacedNetworkPolicy.mockRejectedValueOnce({ code: 409 })
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValueOnce(existing)

      const result = await reconciler.reconcile(
        activeWorkflow([{ drive: 'main', target: 'published-results' }])
      )

      expect(result).toMatchObject({ phase: 'active', message: 'Workflow running' })
      expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('refuses to delete a homonymous policy not owned by the exact recipe', async () => {
      stubSteadyWorkflowRuntime()
      mockNetworkingApi.readNamespacedNetworkPolicy.mockResolvedValueOnce({
        metadata: {
          name: 'gfs-policy-workflow-coordinator-to-gfs',
          uid: 'uid-foreign-policy',
          resourceVersion: '7',
          labels: { 'clerum.io/managed-by': 'operator', 'clerum.io/recipe': 'other-recipe' },
        },
      })

      await expect(reconciler.reconcile(activeWorkflow())).rejects.toThrow(
        'existing policy is not owned by WRC'
      )
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).not.toHaveBeenCalled()
    })

    it('revokes stale coordinator GFS egress before returning a spec limit failure', async () => {
      const recipe = makeRecipe({
        metadata: {
          name: 'gfs-policy-workflow',
          namespace: 'sandbox-recipes',
          uid: 'uid-gfs-policy',
        },
        spec: {
          gfs: { publishTargets: [{ drive: 'main', target: 'published-results' }] },
          steps: [
            { id: 'duplicate', instruction: 'first' },
            { id: 'duplicate', instruction: 'second' },
          ],
        },
        status: { phase: 'active' },
      })

      const result = await reconciler.reconcile(recipe)

      expect(result).toMatchObject({ phase: 'failed' })
      expect(result.message).toContain('duplicate step id "duplicate" is not allowed')
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
        name: 'gfs-policy-workflow-coordinator-to-gfs',
        namespace: 'sandbox-recipes',
        body: {
          preconditions: {
            uid: 'uid-gfs-policy-workflow-coordinator-to-gfs',
            resourceVersion: '1',
          },
        },
      })
    })

    it('opens coordinator GFS egress once only after a successful first deploy', async () => {
      const workflowReconcile = vi.fn().mockResolvedValue({
        phase: 'deploying',
        message: 'Workflow infrastructure created',
        workflowPhase: 'initializing',
      })
      ;(
        reconciler as unknown as {
          workflowReconciler: {
            reconcile: typeof workflowReconcile
            validateWorkflowSpec: () => undefined
          }
        }
      ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

      const result = await reconciler.reconcile(
        makeRecipe({
          metadata: {
            name: 'gfs-policy-workflow',
            namespace: 'sandbox-recipes',
            uid: 'uid-gfs-policy',
          },
          spec: {
            steps: [{ id: 'publish', instruction: 'publish output' }],
            gfs: { publishTargets: [{ drive: 'main', target: 'published-results' }] },
          },
          status: { phase: 'candidate' },
        })
      )

      expect(result).toMatchObject({ phase: 'deploying' })
      expect(workflowReconcile).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      expect(workflowReconcile.mock.invocationCallOrder[0]).toBeLessThan(
        mockNetworkingApi.createNamespacedNetworkPolicy.mock.invocationCallOrder[0]
      )
    })

    it('does not open coordinator GFS egress when first deploy fails asynchronously', async () => {
      const workflowReconcile = vi.fn().mockResolvedValue({
        phase: 'failed',
        message: 'snippet Secret reference is invalid',
        workflowPhase: 'failed',
      })
      ;(
        reconciler as unknown as {
          workflowReconciler: {
            reconcile: typeof workflowReconcile
            validateWorkflowSpec: () => undefined
          }
        }
      ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

      const result = await reconciler.reconcile(
        makeRecipe({
          metadata: {
            name: 'gfs-policy-workflow',
            namespace: 'sandbox-recipes',
            uid: 'uid-gfs-policy',
          },
          spec: {
            steps: [{ id: 'publish', instruction: 'publish output' }],
            gfs: { publishTargets: [{ drive: 'main', target: 'published-results' }] },
          },
          status: { phase: 'candidate' },
        })
      )

      expect(result).toMatchObject({ phase: 'failed' })
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
    })

    it.each(['failed', 'cancelled'] as const)(
      'revokes coordinator GFS egress for a terminal %s workflow',
      async workflowPhase => {
        stubSteadyWorkflowRuntime()
        const workflowRuntime = (
          reconciler as unknown as { workflowReconciler: Record<string, unknown> }
        ).workflowReconciler
        workflowRuntime.teardownComputePodsForTerminalRun = vi.fn().mockResolvedValue(undefined)

        const result = await reconciler.reconcile(
          makeRecipe({
            metadata: {
              name: 'gfs-policy-workflow',
              namespace: 'sandbox-recipes',
              uid: 'uid-gfs-policy',
              labels: { 'clerum.io/workflow-run-id': 'run-gfs-policy' },
            },
            spec: {
              steps: [{ id: 'publish', instruction: 'publish output' }],
              gfs: { publishTargets: [{ drive: 'main', target: 'published-results' }] },
            },
            status: {
              phase: 'active',
              workflowExecution: { phase: workflowPhase },
            } as WorkflowRecipeCRD['status'],
          })
        )

        expect(result).toMatchObject({ phase: 'failed', message: `Workflow ${workflowPhase}` })
        expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
        expect(mockNetworkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1)
      }
    )
  })

  it('keeps completed active workflows active when runtime credential repair fails', async () => {
    const ensureMcpHostRuntimeCredentials = vi
      .fn()
      .mockRejectedValue(new Error('control-api unavailable'))
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
        }
      }
    ).workflowReconciler = { ensureMcpHostRuntimeCredentials }

    const recipe = makeRecipe({
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        labels: { 'clerum.io/workflow-run-id': 'run-test' },
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
        message: 'Workflow completed',
        workflowExecution: { phase: 'completed' },
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow completed',
      skipStatusPatch: true,
    })
    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalled()
  })

  it('patches a stale active workflow message after execution completes', async () => {
    const ensureMcpHostRuntimeCredentials = vi.fn().mockResolvedValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          ensureMcpHostRuntimeCredentials: typeof ensureMcpHostRuntimeCredentials
          validateWorkflowSpec: () => undefined
        }
      }
    ).workflowReconciler = {
      ensureMcpHostRuntimeCredentials,
      validateWorkflowSpec: () => undefined,
    }

    const recipe = makeRecipe({
      metadata: {
        name: 'child-run',
        namespace: 'sandbox-recipes',
        uid: 'uid-child',
        labels: {
          'clerum.io/workflow-run-id': 'run-child',
        },
      },
      spec: {
        steps: [{ id: 'research', instruction: 'run' }],
      },
      status: {
        phase: 'active',
        message: 'Workflow running',
        workflowExecution: { phase: 'completed' },
      } as WorkflowRecipeCRD['status'],
    })

    const result = await reconciler.reconcile(recipe)

    expect(result).toMatchObject({
      phase: 'active',
      message: 'Workflow completed',
      skipStatusPatch: false,
    })
    expect(ensureMcpHostRuntimeCredentials).toHaveBeenCalled()
  })

  // ─── Finalizer Tests ──────────────────────────────────────────────

  it('R.8.10 — ensureFinalizer adds finalizer when not present', async () => {
    const recipe = makeRecipe()
    await reconciler.ensureFinalizer(recipe)
    expect(mockCustomApi.patchNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'test-recipe',
        body: [{ op: 'add', path: '/metadata/finalizers', value: ['clerum.io/workload-cleanup'] }],
      })
    )
  })

  it('R.8.11 — ensureFinalizer skips if already present', async () => {
    const recipe = makeRecipe({
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        finalizers: ['clerum.io/workload-cleanup'],
      },
    })
    await reconciler.ensureFinalizer(recipe)
    expect(mockCustomApi.patchNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('R.8.12 — removeFinalizer removes the finalizer', async () => {
    const recipe = makeRecipe({
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        finalizers: ['clerum.io/workload-cleanup'],
      },
    })
    await reconciler.removeFinalizer(recipe)
    expect(mockCustomApi.patchNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'test-recipe',
        body: [{ op: 'remove', path: '/metadata/finalizers/0' }],
      })
    )
  })

  it('R.8.13 — removeFinalizer treats already-deleted recipes as stale cleanup', async () => {
    mockCustomApi.patchNamespacedCustomObject.mockRejectedValueOnce({ code: 404 })
    const recipe = makeRecipe({
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        finalizers: ['clerum.io/workload-cleanup'],
      },
    })

    await expect(reconciler.removeFinalizer(recipe)).resolves.toBeUndefined()
  })

  // ─── PVC retention annotation ─────────────────────────────────────

  it('reconcileDelete retains PVCs by default when no retention annotation is set', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'app:latest' }],
        resources: [{ id: 'data', type: 'pvc', size: '10Gi' }],
      },
    })
    await reconciler.reconcileDelete(recipe)
    expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
  })

  it("reconcileDelete retains PVCs when retention annotation is 'retain'", async () => {
    const recipe = makeRecipe({
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        annotations: { 'clerum.io/pvc-retention': 'retain' },
      },
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'app:latest' }],
        resources: [{ id: 'data', type: 'pvc', size: '10Gi' }],
      },
    })
    await reconciler.reconcileDelete(recipe)
    expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
  })

  it("reconcileDelete deletes PVCs when retention annotation is 'delete'", async () => {
    const recipe = makeRecipe({
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        annotations: { 'clerum.io/pvc-retention': 'delete' },
      },
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'app:latest' }],
        resources: [{ id: 'data', type: 'pvc', size: '10Gi' }],
      },
    })
    // The PVC exists and is owned by this recipe (issue #571 delete-path guard reads
    // it before deleting).
    mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
      metadata: { labels: { 'clerum.io/recipe': 'test-recipe' } },
    })
    await reconciler.reconcileDelete(recipe)
    // issue #571: PVCs are deleted by their recipe-scoped physical name, not the
    // raw logical id.
    expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).toHaveBeenCalledWith(
      expect.objectContaining({ name: resolveResourceName(recipe, 'data') })
    )
  })

  it('reconcileDelete does NOT delete a resource owned by another recipe (issue #571 Finding 3)', async () => {
    const recipe = makeRecipe({
      metadata: {
        name: 'test-recipe',
        namespace: 'sandbox-recipes',
        uid: 'uid-123',
        annotations: { 'clerum.io/pvc-retention': 'delete' },
      },
      spec: {
        workloads: [{ id: 'app', type: 'deployment', image: 'app:latest' }],
        resources: [
          { id: 'data', type: 'pvc', size: '10Gi' },
          { id: 'creds', type: 'secret', data: { k: 'v' } },
        ],
      },
    })
    // The objects at the resolved names exist but are owned by ANOTHER recipe
    // (e.g. a poisoned status.resourceInstances pointing at a foreign object).
    mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
      metadata: { labels: { 'clerum.io/recipe': 'some-other-recipe' } },
    })
    mockCoreApi.readNamespacedSecret.mockResolvedValue({
      metadata: { labels: { 'clerum.io/recipe': 'some-other-recipe' } },
    })

    await reconciler.reconcileDelete(recipe)

    expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(mockCoreApi.deleteNamespacedSecret).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: resolveResourceName(recipe, 'creds') })
    )
  })

  // ─── Dry-run preview mode ──────────────────────────────────────────

  it('dryRun returns candidate phase with preview workloads', async () => {
    const recipe = makeRecipe({
      spec: {
        dryRun: true,
        workloads: [
          { id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 },
          { id: 'worker', type: 'deployment', image: 'worker:latest' },
        ],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('candidate')
    expect(result.message).toContain('Dry-run')
    expect(result.workloadStatuses).toHaveLength(2)
    expect(result.workloadStatuses[0].phase).toBe('preview')
    expect(result.workloadStatuses[0].message).toContain('Would deploy')
  })

  it('dryRun does not create Kubernetes resources', async () => {
    const recipe = makeRecipe({
      spec: {
        dryRun: true,
        workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 }],
        resources: [{ id: 'data', type: 'pvc', size: '10Gi' }],
      },
    })
    await reconciler.reconcile(recipe)
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedService).not.toHaveBeenCalled()
  })

  it('workflow dryRun does not persist workload instances or create runtime resources', async () => {
    const workflowReconcile = vi.fn().mockResolvedValue({
      phase: 'active',
      message: 'Workflow infrastructure created',
      workflowPhase: 'running',
    })
    const validateWorkflowSpec = vi.fn().mockReturnValue(undefined)
    ;(
      reconciler as unknown as {
        workflowReconciler: {
          reconcile: typeof workflowReconcile
          validateWorkflowSpec: typeof validateWorkflowSpec
        }
      }
    ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec }

    const recipe = makeRecipe({
      metadata: { name: 'dry-run-workflow', namespace: 'sandbox-recipes', uid: 'uid-dry-wf' },
      spec: {
        dryRun: true,
        workloads: [{ id: 'api', type: 'deployment', image: 'api:latest', port: 8080 }],
        resources: [{ id: 'data', type: 'pvc', size: '10Gi' }],
        steps: [{ id: 'run', run: snippetRun() }],
        gfs: { publishTargets: [{ drive: 'main', target: 'published-results' }] },
      },
      status: { phase: 'candidate' },
    })

    const result = await reconciler.reconcile(recipe)

    const workloadInstancePatches =
      mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.filter(
        ([arg]) => arg.body?.status?.workloadInstances
      )
    expect(result.phase).toBe('candidate')
    expect(result.message).toContain('Dry-run')
    expect(workloadInstancePatches).toHaveLength(0)
    expect(validateWorkflowSpec).toHaveBeenCalled()
    expect(workflowReconcile).not.toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedService).not.toHaveBeenCalled()
    expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
  })

  it('dryRun still validates that at least one workload or step is configured', async () => {
    const recipe = makeRecipe({
      spec: { dryRun: true, workloads: [] },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('failed')
    expect(result.message).toContain('at least one workload')
  })

  it('dryRun shows correct namespace per workload', async () => {
    const recipe = makeRecipe({
      spec: {
        dryRun: true,
        contextRef: 'default',
        workloads: [
          { id: 'redis', type: 'deployment', image: 'redis:7', port: 6379 },
          {
            id: 'mcp',
            type: 'deployment',
            image: 'mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('candidate')
    // redis (non-MCP) → sandbox-recipes
    expect(result.workloadStatuses[0].message).toContain('sandbox-recipes')
    // mcp (MCP) → mcp-server
    expect(result.workloadStatuses[1].message).toContain('mcp-server')
  })

  // ─── includeWhen filtering ─────────────────────────────────────────

  it('workload with includeWhen=false is excluded from deployment', async () => {
    const recipe = makeRecipe({
      spec: {
        inputs: { cacheEnabled: false },
        workloads: [
          { id: 'app', type: 'deployment', image: 'app:latest', port: 8080 },
          {
            id: 'cache',
            type: 'deployment',
            image: 'redis:7',
            port: 6379,
            includeWhen: '{{inputs.cacheEnabled}}',
          },
        ],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('active')
    // Only 'app' should be deployed, 'cache' excluded
    expect(result.workloadStatuses).toHaveLength(1)
    expect(result.workloadStatuses[0].id).toBe('app')
    expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
  })

  it('workload with includeWhen=true is included', async () => {
    const recipe = makeRecipe({
      spec: {
        inputs: { cacheEnabled: true },
        workloads: [
          { id: 'app', type: 'deployment', image: 'app:latest', port: 8080 },
          {
            id: 'cache',
            type: 'deployment',
            image: 'redis:7',
            port: 6379,
            includeWhen: '{{inputs.cacheEnabled}}',
          },
        ],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.workloadStatuses).toHaveLength(2)
  })

  it('all workloads excluded by includeWhen returns failed phase', async () => {
    const recipe = makeRecipe({
      spec: {
        inputs: { enabled: false },
        workloads: [
          { id: 'app', type: 'deployment', image: 'app:latest', includeWhen: '{{inputs.enabled}}' },
        ],
      },
    })
    const result = await reconciler.reconcile(recipe)
    expect(result.phase).toBe('failed')
    expect(result.message).toContain('All workloads excluded')
  })

  // ─── Issue #15 — clerum.io/mcpserver label on transport workloads ─────

  it('R.15.1 — transport workload Deployment has clerum.io/mcpserver label', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'redis-mcp',
            type: 'deployment',
            image: 'redis:7-alpine',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    await reconciler.reconcile(recipe)
    const call = mockAppsApi.createNamespacedDeployment.mock.calls[0][0]
    // Deployment metadata labels
    expect(call.body.metadata.labels['clerum.io/mcpserver']).toBe('test-recipe-redis-mcp')
    // Pod template labels (critical for NetworkPolicy podSelector)
    expect(call.body.spec.template.metadata.labels['clerum.io/mcpserver']).toBe(
      'test-recipe-redis-mcp'
    )
  })

  it('R.15.2 — non-transport workload does NOT have clerum.io/mcpserver label', async () => {
    const recipe = makeRecipe({
      spec: {
        workloads: [{ id: 'worker', type: 'deployment', image: 'worker:latest', port: 8080 }],
      },
    })
    await reconciler.reconcile(recipe)
    const call = mockAppsApi.createNamespacedDeployment.mock.calls[0][0]
    expect(call.body.metadata.labels['clerum.io/mcpserver']).toBeUndefined()
    expect(call.body.spec.template.metadata.labels['clerum.io/mcpserver']).toBeUndefined()
  })

  it('R.15.3 — mixed recipe: only transport workloads get mcpserver label', async () => {
    const recipe = makeRecipe({
      spec: {
        contextRef: 'default',
        workloads: [
          { id: 'redis', type: 'deployment', image: 'redis:7', port: 6379 },
          {
            id: 'redis-mcp',
            type: 'deployment',
            image: 'redis-mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    await reconciler.reconcile(recipe)
    const calls = mockAppsApi.createNamespacedDeployment.mock.calls
    const redisName = resolveScopedWorkloadResourceName(recipe, 'redis')
    const redisCall = calls.find(
      (c: unknown[]) =>
        (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === redisName
    )
    const mcpName = resolveScopedWorkloadResourceName(recipe, 'redis-mcp')
    const mcpCall = calls.find(
      (c: unknown[]) =>
        (c[0] as { body: { metadata: { name: string } } }).body.metadata.name === mcpName
    )
    // Non-transport: no mcpserver label
    expect(redisCall![0].body.metadata.labels['clerum.io/mcpserver']).toBeUndefined()
    // Transport: has mcpserver label
    expect(mcpCall![0].body.metadata.labels['clerum.io/mcpserver']).toBe('test-recipe-redis-mcp')
    expect(mcpCall![0].body.spec.template.metadata.labels['clerum.io/mcpserver']).toBe(
      'test-recipe-redis-mcp'
    )
  })

  it('R.15.4 — mcpserver label value matches mcpServerName() format', async () => {
    mockCustomApi.getNamespacedCustomObject.mockImplementation(
      ({ name, plural }: { name?: string; plural?: string }) => {
        if (plural === 'mcpservers') return Promise.reject({ code: 404 })
        return Promise.resolve({
          metadata: {
            uid: name === 'mcp-postgres' ? 'uid-456' : liveWorkflowRecipeUid(name),
            resourceVersion: '1',
            annotations: { 'clerum.io/network-ready': 'true' },
            labels: { 'clerum.io/recipe': name ?? 'test-recipe' },
          },
          status: {
            conditions: [{ type: 'ExternalEgressReady', status: 'True' }],
          },
          spec: { mcpServers: [] },
        })
      }
    )
    const recipe = makeRecipe({
      metadata: { name: 'mcp-postgres', namespace: 'sandbox-recipes', uid: 'uid-456' },
      spec: {
        contextRef: 'default',
        workloads: [
          {
            id: 'pg-mcp',
            type: 'deployment',
            image: 'postgres-mcp:latest',
            port: 3000,
            transport: { type: 'streamableHttp' },
          },
        ],
      },
    })
    await reconciler.reconcile(recipe)
    const call = mockAppsApi.createNamespacedDeployment.mock.calls[0][0]
    // Must match format: {recipeName}-{workloadId}
    expect(call.body.metadata.labels['clerum.io/mcpserver']).toBe('mcp-postgres-pg-mcp')
  })

  // ─── resolveWorkloadResourceName: prefixed names for workflow recipes ──

  it('uses the persisted scoped workload instance on 409 update for catalog recipes', async () => {
    mockAppsApi.createNamespacedDeployment.mockRejectedValueOnce({ code: 409 })

    const recipe = makeRecipe({
      metadata: { name: 'simple-recipe', namespace: 'sandbox-recipes', uid: 'uid-nw' },
      spec: {
        workloads: [
          { id: 'web-server', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 80 },
        ],
      },
      status: { phase: 'approved' },
    })
    await reconciler.reconcile(recipe)

    const expectedName = resolveScopedWorkloadResourceName(recipe, 'web-server')
    const readCall = mockAppsApi.readNamespacedDeployment.mock.calls[0][0]
    expect(readCall.name).toBe(expectedName)
    expect(readCall.name).not.toBe('web-server')
  })

  it('patchStatus stores terminal workflowExecution phase for pre-runtime workflow failures', async () => {
    const recipe = makeRecipe({
      spec: {
        steps: [
          {
            id: 'bad',
            run: {
              type: 'snippet',
              language: 'python' as never,
              code: 'return {}',
            },
          },
        ],
      },
      status: { phase: 'candidate' },
    })

    await reconciler.patchStatus(recipe, {
      phase: 'failed',
      message: 'step "bad" snippet language must be typescript',
      workloadStatuses: [],
      workflowPhase: 'failed',
    })

    const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
    expect(patch.status.workflowExecution).toMatchObject({
      phase: 'failed',
      message: 'step "bad" snippet language must be typescript',
    })
    expect(patch.status.workflowExecution.startedAt).toEqual(expect.any(String))
    expect(patch.status.workflowExecution.completedAt).toEqual(expect.any(String))
  })

  it('patchStatus closes initializing workflowExecution when workflow reconcile fails before runtime', async () => {
    mockCustomApi.getNamespacedCustomObject.mockResolvedValueOnce({
      metadata: { name: 'test-recipe', namespace: 'sandbox-recipes' },
      spec: {},
      status: {
        workflowExecution: {
          phase: 'initializing',
          startedAt: '2026-05-06T17:11:30.496Z',
        },
      },
    })
    const recipe = makeRecipe({
      spec: {
        steps: [{ id: 'calculate', agent: { provider: 'zai', model: 'glm-4.7' } }],
      },
      status: {
        phase: 'candidate',
        workflowExecution: {
          phase: 'initializing',
          startedAt: '2026-05-06T17:11:30.496Z',
        },
      },
    })

    await reconciler.patchStatus(recipe, {
      phase: 'failed',
      message: 'Step "calculate" references MCP server "missing-tools" not found',
      workloadStatuses: [],
    })

    const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
    expect(patch.status.workflowExecution).toMatchObject({
      phase: 'failed',
      message: 'Step "calculate" references MCP server "missing-tools" not found',
      startedAt: '2026-05-06T17:11:30.496Z',
    })
    expect(patch.status.workflowExecution.completedAt).toEqual(expect.any(String))
  })

  it('patchStatus preserves terminal workflowExecution detail while deriving recipe phase', async () => {
    mockCustomApi.getNamespacedCustomObject.mockResolvedValueOnce({
      metadata: { name: 'test-recipe', namespace: 'sandbox-recipes' },
      spec: {},
      status: {
        workflowExecution: {
          phase: 'failed',
          message: 'artifact body exceeds 8 bytes',
          startedAt: '2026-05-06T17:24:49.188Z',
          completedAt: '2026-05-06T17:25:20.005Z',
        },
      },
    })
    const recipe = makeRecipe({
      spec: {
        steps: [{ id: 'oversized', run: snippetRun() }],
      },
      status: {
        phase: 'deploying',
        workflowExecution: {
          phase: 'failed',
          message: 'artifact body exceeds 8 bytes',
          startedAt: '2026-05-06T17:24:49.188Z',
          completedAt: '2026-05-06T17:25:20.005Z',
        },
      },
    })

    await reconciler.patchStatus(recipe, {
      phase: 'failed',
      message: 'Workflow failed',
      workloadStatuses: [],
    })

    const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
    expect(patch.status.phase).toBe('failed')
    expect(patch.status.message).toBe('Workflow failed')
    expect(patch.status.workflowExecution).toBeUndefined()
  })

  it('patchStatus does not overwrite a live terminal workflowExecution with stale initializing status', async () => {
    mockCustomApi.getNamespacedCustomObject.mockResolvedValueOnce({
      metadata: { name: 'test-recipe', namespace: 'sandbox-recipes' },
      spec: {},
      status: {
        workflowExecution: {
          phase: 'completed',
          startedAt: '2026-05-06T16:31:46.000Z',
          completedAt: '2026-05-06T16:31:47.000Z',
        },
      },
    })
    const recipe = makeRecipe({
      spec: {
        coordinatorImage: 'clerum/workflow-custom-sdk-e2e:test',
        steps: [{ id: 'prepare' }, { id: 'transform' }, { id: 'emit' }],
      },
      status: { phase: 'candidate' },
    })

    await reconciler.patchStatus(recipe, {
      phase: 'deploying',
      message: 'Workflow infrastructure created (workflow-custom)',
      workloadStatuses: [],
      workflowPhase: 'initializing',
    })

    const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
    expect(patch.status.workflowExecution).toBeUndefined()
  })

  it('patchStatus does not overwrite a live running workflowExecution with stale initializing status', async () => {
    mockCustomApi.getNamespacedCustomObject.mockResolvedValueOnce({
      metadata: { name: 'test-recipe', namespace: 'sandbox-recipes' },
      spec: {},
      status: {
        workflowExecution: {
          phase: 'running',
          startedAt: '2026-05-06T16:31:46.000Z',
          message: 'Workflow started',
        },
      },
    })
    const recipe = makeRecipe({
      spec: {
        steps: [
          {
            id: 'query-mongo',
            run: { type: 'snippet', language: 'typescript', code: 'return {}' },
          },
        ],
      },
      status: { phase: 'candidate' },
    })

    await reconciler.patchStatus(recipe, {
      phase: 'deploying',
      message: 'Workflow infrastructure created (snippet-runner)',
      workloadStatuses: [],
      workflowPhase: 'initializing',
    })

    const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
    expect(patch.status.workflowExecution).toBeUndefined()
  })

  it('patchStatus can mark workflow infrastructure active while execution is running', async () => {
    const recipe = makeRecipe({
      spec: {
        steps: [{ id: 'run', instruction: 'run' }],
      },
      status: { phase: 'deploying' },
    })

    await reconciler.patchStatus(recipe, {
      phase: 'active',
      message: 'Workflow running',
      workloadStatuses: [],
      workflowPhase: 'running',
    })

    const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
    expect(patch.status).toMatchObject({
      phase: 'active',
      message: 'Workflow running',
      workflowExecution: {
        phase: 'running',
        message: 'Workflow running',
      },
    })
  })

  it('patchStatus clears stale workflowExecution for active parent recipes waiting on triggers', async () => {
    const recipe = makeRecipe({
      spec: {
        steps: [{ id: 'run', instruction: 'run' }],
      },
      status: {
        phase: 'active',
        workflowExecution: { phase: 'pending', message: 'stale pending status' },
      } as WorkflowRecipeCRD['status'],
    })

    await reconciler.patchStatus(recipe, {
      phase: 'active',
      message: 'Workflow trigger infrastructure registered (workflow-agentic)',
      workloadStatuses: [],
      clearWorkflowExecution: true,
    })

    const patch = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls[0][0].body
    expect(patch.status).toMatchObject({
      phase: 'active',
      message: 'Workflow trigger infrastructure registered (workflow-agentic)',
      workflowExecution: null,
    })
  })

  // ─── adjustManifestNamespace: cross-namespace ownerRef stripping ──

  describe('adjustManifestNamespace (cross-namespace ownerRef stripping)', () => {
    it('strips ownerReferences when targetNs differs from recipe.metadata.namespace', () => {
      const manifest = {
        metadata: {
          namespace: 'original',
          ownerReferences: [
            {
              apiVersion: 'clerum.io/v1alpha1',
              kind: 'WorkflowRecipe',
              name: 'r1',
              uid: 'abc',
            } as k8s.V1OwnerReference,
          ],
        },
        spec: {},
      }

      // recipe lives in sandbox-recipes, manifest targets mcp-server → strip
      ;(
        reconciler as unknown as {
          adjustManifestNamespace: (
            m: typeof manifest,
            targetNs: string,
            recipeNamespace: string
          ) => void
        }
      ).adjustManifestNamespace(manifest, 'mcp-server', 'sandbox-recipes')

      expect(manifest.metadata.namespace).toBe('mcp-server')
      expect(manifest.metadata.ownerReferences).toBeUndefined()
    })

    it('preserves ownerReferences when targetNs === recipe.metadata.namespace', () => {
      const manifest = {
        metadata: {
          namespace: 'original',
          ownerReferences: [
            {
              apiVersion: 'clerum.io/v1alpha1',
              kind: 'WorkflowRecipe',
              name: 'r1',
              uid: 'abc',
            } as k8s.V1OwnerReference,
          ],
        },
        spec: {},
      }

      ;(
        reconciler as unknown as {
          adjustManifestNamespace: (
            m: typeof manifest,
            targetNs: string,
            recipeNamespace: string
          ) => void
        }
      ).adjustManifestNamespace(manifest, 'sandbox-recipes', 'sandbox-recipes')

      expect(manifest.metadata.namespace).toBe('sandbox-recipes')
      expect(manifest.metadata.ownerReferences).toHaveLength(1)
    })
  })

  // ─── Webhook Gateway (W1.1) ─────────────────────────────────────────

  describe('webhook gateway', () => {
    function recipeWithWebhook(overrides?: {
      secretMissing?: boolean
      deploymentReady?: boolean
      transportOnHandler?: boolean
    }): WorkflowRecipeCRD {
      const recipe: WorkflowRecipeCRD = {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'wh-recipe', namespace: 'sandbox-recipes', uid: 'uid-wh' },
        spec: {
          workloads: [
            overrides?.transportOnHandler
              ? {
                  id: 'handler',
                  type: 'deployment',
                  image: 'echo:1',
                  port: 8080,
                  transport: { type: 'streamableHttp' },
                }
              : { id: 'handler', type: 'deployment', image: 'echo:1', port: 8080 },
          ],
          webhooks: [
            {
              id: 'fireflies',
              workloadRef: 'handler',
              path: '/webhooks/fireflies',
              verification: {
                scheme: 'hmac-sha256-body',
                secretRef: { name: 'fireflies-creds', key: 'signing-secret' },
                signatureHeader: 'X-Hub-Signature-256',
              },
            },
          ],
        },
        status: { phase: 'approved' },
      }
      // Configure mocks per-test scenario.
      mockCoreApi.readNamespacedSecret.mockReset()
      if (overrides?.secretMissing) {
        const e = new Error('not found') as Error & { code: number }
        e.code = 404
        mockCoreApi.readNamespacedSecret.mockRejectedValue(e)
      } else {
        mockCoreApi.readNamespacedSecret.mockResolvedValue({
          metadata: {
            resourceVersion: '1',
            labels: { 'clerum.io/owner-recipe': 'wh-recipe' },
          },
          data: { 'signing-secret': 'YmFzZTY0LXNlY3JldA==' },
        })
      }
      mockAppsApi.readNamespacedDeployment.mockReset()
      mockAppsApi.readNamespacedDeployment.mockResolvedValue({
        metadata: { resourceVersion: '1' },
        status: { readyReplicas: overrides?.deploymentReady === false ? 0 : 1 },
      })
      return recipe
    }

    it('skips webhook reconcile when spec.webhooks is empty', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      const r = await reconciler.reconcile(makeRecipe())
      // Only the workload deployment, not the gateway deployment.
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
      expect(r.webhookConditions ?? []).toHaveLength(0)
    })

    it('builds gateway Deployment + Service + ConfigMap + 3 NetworkPolicies on the happy path', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockCoreApi.createNamespacedService.mockClear()
      mockCoreApi.createNamespacedConfigMap.mockClear()
      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()

      const r = await reconciler.reconcile(recipeWithWebhook())

      // 1 Deployment for the handler workload + 1 for the gateway.
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(2)
      // 1 Service for the handler workload + 1 for the gateway.
      expect(mockCoreApi.createNamespacedService).toHaveBeenCalledTimes(2)
      // 1 ConfigMap for the gateway config.
      expect(mockCoreApi.createNamespacedConfigMap).toHaveBeenCalledTimes(1)
      // 3 NetworkPolicies (proxy ingress + handler egress + handler ingress).
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(3)
      expect(r.phase).toBe('active')
      // WebhookHandlerInvalid + WebhookSecretMissing + WebhookGatewayNotReady — all False.
      const types = (r.webhookConditions ?? []).map(c => c.type)
      expect(types).toContain('WebhookHandlerInvalid')
      expect(types).toContain('WebhookSecretMissing')
      expect(types).toContain('WebhookGatewayNotReady')
      const allFalse = (r.webhookConditions ?? []).every(c => c.status === 'False')
      expect(allFalse).toBe(true)
    })

    it('T6 (#575) converges the 3 gateway NetworkPolicies through live reads', async () => {
      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
      mockNetworkingApi.readNamespacedNetworkPolicy.mockRejectedValue({ code: 404 })
      await reconciler.reconcile(recipeWithWebhook())

      const sealed = new Map<string, unknown>()
      for (const call of mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls) {
        const body = (call[0] as { body: k8s.V1NetworkPolicy }).body
        sealed.set(body.metadata!.name!, JSON.parse(JSON.stringify(body)))
      }
      // Which three, not just how many: cardinality alone stays green if a refactor
      // stops emitting gateway policies and three arrive from another family.
      expect([...sealed.keys()].sort()).toEqual([
        'allow-gateway-egress-to-handler-wf-wh-recipe',
        'allow-gateway-ingress-to-handler-wf-wh-recipe',
        'allow-webhook-proxy-ingress-wf-wh-recipe',
      ])

      mockNetworkingApi.readNamespacedNetworkPolicy.mockImplementation(
        ({ name }: { name: string }) => {
          const previous = sealed.get(name) as k8s.V1NetworkPolicy | undefined
          if (!previous) return Promise.resolve({ metadata: { name, resourceVersion: '1' } })
          return Promise.resolve({
            ...previous,
            metadata: { ...previous.metadata, resourceVersion: '9' },
          })
        }
      )
      mockNetworkingApi.replaceNamespacedNetworkPolicy.mockClear()
      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
      mockNetworkingApi.readNamespacedNetworkPolicy.mockClear()
      const previousLevel = process.env.LOG_LEVEL
      process.env.LOG_LEVEL = 'info'
      const logEntries: Array<Record<string, unknown>> = []
      const logSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString()
        for (const line of text.split('\n')) {
          if (!line.startsWith('{')) continue
          const parsed = JSON.parse(line) as Record<string, unknown>
          if (parsed.msg === 'network policy unchanged; skipping update') logEntries.push(parsed)
        }
        return true
      }) as unknown as typeof process.stdout.write)

      try {
        await reconciler.reconcile(recipeWithWebhook())

        for (const name of sealed.keys()) {
          expect(mockNetworkingApi.replaceNamespacedNetworkPolicy).not.toHaveBeenCalledWith(
            expect.objectContaining({ name })
          )
          expect(mockNetworkingApi.readNamespacedNetworkPolicy).toHaveBeenCalledWith(
            expect.objectContaining({ name })
          )
          expect(logEntries).toContainEqual(
            expect.objectContaining({
              policy: name,
              family: 'webhook-gateway',
              msg: 'network policy unchanged; skipping update',
            })
          )
        }
        expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      } finally {
        logSpy.mockRestore()
        if (previousLevel === undefined) delete process.env.LOG_LEVEL
        else process.env.LOG_LEVEL = previousLevel
      }
    })

    it('fail-closed when secretRef is missing: no gateway resources, condition set, phase degraded', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockCoreApi.createNamespacedService.mockClear()
      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()

      const r = await reconciler.reconcile(recipeWithWebhook({ secretMissing: true }))

      // Workload Deployment (handler) is still created. Gateway resources are NOT.
      // We can detect this because the gateway uses createNamespacedDeployment too,
      // and the handler-only run produces exactly 1 call.
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
      expect(mockCoreApi.createNamespacedService).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(r.phase).toBe('degraded')
      const missingCond = (r.webhookConditions ?? []).find(c => c.type === 'WebhookSecretMissing')
      expect(missingCond?.status).toBe('True')
      expect(missingCond?.message).toMatch(/fireflies-creds/)
    })

    it('fail-closed when secretRef belongs to a different recipe (cross-recipe ownership refused)', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
      const recipe = recipeWithWebhook()
      // Override the happy-path mock with a Secret labeled for ANOTHER recipe.
      mockCoreApi.readNamespacedSecret.mockReset()
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: {
          resourceVersion: '1',
          labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
        },
        data: { 'signing-secret': 'YmFzZTY0LXNlY3JldA==' },
      })

      const r = await reconciler.reconcile(recipe)

      // Gateway not built — only the handler Deployment.
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(r.phase).toBe('degraded')
      const missingCond = (r.webhookConditions ?? []).find(c => c.type === 'WebhookSecretMissing')
      expect(missingCond?.status).toBe('True')
      expect(missingCond?.message).toMatch(/not accessible/)
      expect(missingCond?.message).toMatch(/owner-recipe/)
    })

    it('fail-closed when secretRef is unlabeled (no ownership claim)', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      const recipe = recipeWithWebhook()
      mockCoreApi.readNamespacedSecret.mockReset()
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: { resourceVersion: '1' },
        data: { 'signing-secret': 'YmFzZTY0LXNlY3JldA==' },
      })

      const r = await reconciler.reconcile(recipe)

      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
      expect(r.phase).toBe('degraded')
      const missingCond = (r.webhookConditions ?? []).find(c => c.type === 'WebhookSecretMissing')
      expect(missingCond?.status).toBe('True')
      expect(missingCond?.message).toMatch(/ownership=unlabeled/)
    })

    it('honors clerum.io/shared=true for webhook secretRef', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
      const recipe = recipeWithWebhook()
      mockCoreApi.readNamespacedSecret.mockReset()
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: {
          resourceVersion: '1',
          labels: { 'clerum.io/shared': 'true' },
        },
        data: { 'signing-secret': 'YmFzZTY0LXNlY3JldA==' },
      })

      const r = await reconciler.reconcile(recipe)

      // Handler + gateway Deployment, plus 3 gateway NetworkPolicies.
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(2)
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(3)
      expect(r.phase).toBe('active')
    })

    it('fail-closed on W2 violation: workloadRef points at a non-deployment workload', async () => {
      // Use a statefulset (no contextRef requirements) so the rest of the
      // pipeline still passes and we exercise the W2 path cleanly.
      const recipe: WorkflowRecipeCRD = {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'wh-recipe', namespace: 'sandbox-recipes', uid: 'uid-wh' },
        spec: {
          workloads: [{ id: 'handler', type: 'statefulset', image: 'pg:16', port: 5432 }],
          webhooks: [
            {
              id: 'fireflies',
              workloadRef: 'handler',
              path: '/webhooks/fireflies',
              verification: {
                scheme: 'hmac-sha256-body',
                secretRef: { name: 'fireflies-creds', key: 'signing-secret' },
                signatureHeader: 'X-Hub-Signature-256',
              },
            },
          ],
        },
        status: { phase: 'approved' },
      }
      mockNetworkingApi.createNamespacedNetworkPolicy.mockClear()
      const r = await reconciler.reconcile(recipe)
      // Gateway not created.
      expect(mockNetworkingApi.createNamespacedNetworkPolicy).not.toHaveBeenCalled()
      expect(r.phase).toBe('degraded')
      const cond = (r.webhookConditions ?? []).find(c => c.type === 'WebhookHandlerInvalid')
      expect(cond?.status).toBe('True')
      expect(cond?.message).toMatch(/must be type=deployment/)
    })

    it('marks WebhookGatewayNotReady=True when Deployment has zero ready replicas', async () => {
      const r = await reconciler.reconcile(recipeWithWebhook({ deploymentReady: false }))
      const notReady = (r.webhookConditions ?? []).find(c => c.type === 'WebhookGatewayNotReady')
      expect(notReady?.status).toBe('True')
      expect(r.phase).toBe('degraded')
    })

    // ─── Phase 2: webhooks[].optional ───────────────────────────────────

    function recipeWithOptionalWebhook(overrides?: { secretMissing?: boolean }): WorkflowRecipeCRD {
      const recipe: WorkflowRecipeCRD = {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'wh-recipe', namespace: 'sandbox-recipes', uid: 'uid-wh' },
        spec: {
          workloads: [{ id: 'handler', type: 'deployment', image: 'echo:1', port: 8080 }],
          webhooks: [
            {
              id: 'fireflies',
              workloadRef: 'handler',
              path: '/webhooks/fireflies',
              optional: true,
              verification: {
                scheme: 'hmac-sha256-body',
                secretRef: { name: 'fireflies-creds', key: 'signing-secret' },
                signatureHeader: 'X-Hub-Signature-256',
              },
            },
          ],
        },
        status: { phase: 'approved' },
      }
      mockCoreApi.readNamespacedSecret.mockReset()
      if (overrides?.secretMissing) {
        const e = new Error('not found') as Error & { code: number }
        e.code = 404
        mockCoreApi.readNamespacedSecret.mockRejectedValue(e)
      } else {
        mockCoreApi.readNamespacedSecret.mockResolvedValue({
          metadata: {
            resourceVersion: '1',
            labels: { 'clerum.io/owner-recipe': 'wh-recipe' },
          },
          data: { 'signing-secret': 'YmFzZTY0LXNlY3JldA==' },
        })
      }
      mockAppsApi.readNamespacedDeployment.mockReset()
      mockAppsApi.readNamespacedDeployment.mockResolvedValue({
        metadata: { resourceVersion: '1' },
        status: { readyReplicas: 1 },
      })
      return recipe
    }

    it('optional+missing webhook keeps the gateway up and emits WebhookDormant', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockCoreApi.createNamespacedConfigMap.mockClear()

      const r = await reconciler.reconcile(recipeWithOptionalWebhook({ secretMissing: true }))

      // Gateway IS built (handler Deployment + gateway Deployment = 2 calls).
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(2)
      // Configmap built — gateway has a dormant entry but still serves.
      expect(mockCoreApi.createNamespacedConfigMap).toHaveBeenCalledTimes(1)
      // WebhookSecretMissing stays False (no required secret missing).
      const missing = (r.webhookConditions ?? []).find(c => c.type === 'WebhookSecretMissing')
      expect(missing?.status).toBe('False')
      // WebhookDormant is True with the dormant id in the message.
      const dormant = (r.webhookConditions ?? []).find(c => c.type === 'WebhookDormant')
      expect(dormant?.status).toBe('True')
      expect(dormant?.message).toMatch(/fireflies/)
      // Recipe reaches active despite the missing optional Secret.
      expect(r.phase).toBe('active')
    })

    it('optional+resolved webhook does not emit WebhookDormant', async () => {
      const r = await reconciler.reconcile(recipeWithOptionalWebhook({ secretMissing: false }))
      const dormant = (r.webhookConditions ?? []).find(c => c.type === 'WebhookDormant')
      expect(dormant?.status).toBe('False')
      expect(r.phase).toBe('active')
    })

    it('writes dormant: true into the gateway ConfigMap for optional+missing entries', async () => {
      mockCoreApi.createNamespacedConfigMap.mockClear()
      await reconciler.reconcile(recipeWithOptionalWebhook({ secretMissing: true }))
      const cmCall = mockCoreApi.createNamespacedConfigMap.mock.calls[0][0]
      const cm = cmCall.body as { data?: { 'config.json'?: string } }
      const config = JSON.parse(cm.data!['config.json']!)
      expect(config.webhooks.fireflies.dormant).toBe(true)
      expect(config.webhooks.fireflies.dormantSecretName).toBe('fireflies-creds')
    })

    it('required (non-optional) + missing still fails closed even alongside optional+missing', async () => {
      const recipe: WorkflowRecipeCRD = {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'wh-recipe', namespace: 'sandbox-recipes', uid: 'uid-wh' },
        spec: {
          workloads: [{ id: 'handler', type: 'deployment', image: 'echo:1', port: 8080 }],
          webhooks: [
            {
              id: 'fireflies',
              workloadRef: 'handler',
              path: '/webhooks/fireflies',
              optional: true,
              verification: {
                scheme: 'hmac-sha256-body',
                secretRef: { name: 'fireflies-creds', key: 'signing-secret' },
                signatureHeader: 'X-Hub-Signature-256',
              },
            },
            {
              id: 'stripe',
              workloadRef: 'handler',
              path: '/webhooks/stripe',
              verification: {
                scheme: 'hmac-sha256-body',
                secretRef: { name: 'stripe-creds', key: 'signing-secret' },
                signatureHeader: 'Stripe-Signature',
              },
            },
          ],
        },
        status: { phase: 'approved' },
      }
      mockCoreApi.readNamespacedSecret.mockReset()
      const e = new Error('not found') as Error & { code: number }
      e.code = 404
      mockCoreApi.readNamespacedSecret.mockRejectedValue(e)
      mockAppsApi.createNamespacedDeployment.mockClear()

      const r = await reconciler.reconcile(recipe)
      // Required (stripe) fails closed: only handler Deployment, no gateway.
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
      expect(r.phase).toBe('degraded')
      const missing = (r.webhookConditions ?? []).find(c => c.type === 'WebhookSecretMissing')
      expect(missing?.status).toBe('True')
      expect(missing?.message).toMatch(/stripe/)
      // Optional+missing webhook does NOT appear in WebhookSecretMissing
      // (it would have been dormant if the gateway built).
      expect(missing?.message).not.toMatch(/fireflies/)
    })
  })

  // ─── envSecret optional keys (Phase 3) ──────────────────────────────────

  describe('envSecret optional keys', () => {
    beforeEach(() => {
      mockCoreApi.readNamespacedSecret.mockReset()
    })

    function recipeWithOptionalKey(): WorkflowRecipeCRD {
      return makeRecipe({
        spec: {
          workloads: [
            {
              id: 'app',
              type: 'deployment',
              image: 'nginx:1.30.1-alpine',
              port: 8080,
              envSecret: {
                name: 'app-creds',
                keys: [
                  { secretKey: 'required-token', envVar: 'REQUIRED_TOKEN' },
                  { secretKey: 'optional-token', envVar: 'OPTIONAL_TOKEN', optional: true },
                ],
              },
            },
          ],
        },
      })
    }

    it('omits an optional env var when the Secret is missing entirely (404)', async () => {
      const err = Object.assign(new Error('not found'), {
        response: { statusCode: 404 },
        code: 404,
      })
      mockCoreApi.readNamespacedSecret.mockRejectedValue(err)

      await reconciler.reconcile(recipeWithOptionalKey())

      const body = mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body
      const envVars = body.spec.template.spec.containers[0].env as Array<{ name: string }>
      const names = envVars.map(e => e.name)
      expect(names).toContain('REQUIRED_TOKEN')
      expect(names).not.toContain('OPTIONAL_TOKEN')
    })

    it('omits an optional env var when the key is absent from an existing Secret', async () => {
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: {
          resourceVersion: '1',
          labels: { 'clerum.io/owner-recipe': 'test-recipe' },
        },
        data: { 'required-token': 'eA==' },
      })

      await reconciler.reconcile(recipeWithOptionalKey())

      const body = mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body
      const envVars = body.spec.template.spec.containers[0].env as Array<{
        name: string
        valueFrom?: { secretKeyRef?: { key: string } }
      }>
      const names = envVars.map(e => e.name)
      expect(names).toContain('REQUIRED_TOKEN')
      expect(names).not.toContain('OPTIONAL_TOKEN')
      const required = envVars.find(e => e.name === 'REQUIRED_TOKEN')!
      expect(required.valueFrom?.secretKeyRef?.key).toBe('required-token')
    })

    it('projects an optional env var when the key is present in the Secret', async () => {
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: {
          resourceVersion: '1',
          labels: { 'clerum.io/owner-recipe': 'test-recipe' },
        },
        data: { 'required-token': 'eA==', 'optional-token': 'eA==' },
      })

      await reconciler.reconcile(recipeWithOptionalKey())

      const body = mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body
      const envVars = body.spec.template.spec.containers[0].env as Array<{ name: string }>
      expect(envVars.map(e => e.name).sort()).toEqual(['OPTIONAL_TOKEN', 'REQUIRED_TOKEN'])
    })

    it('honors clerum.io/shared=true the same way as owner-recipe', async () => {
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: { resourceVersion: '1', labels: { 'clerum.io/shared': 'true' } },
        data: { 'required-token': 'eA==', 'optional-token': 'eA==' },
      })

      await reconciler.reconcile(recipeWithOptionalKey())

      const body = mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body
      const envVars = body.spec.template.spec.containers[0].env as Array<{ name: string }>
      expect(envVars.map(e => e.name).sort()).toEqual(['OPTIONAL_TOKEN', 'REQUIRED_TOKEN'])
    })

    it('fails closed: does NOT render a workload whose envSecret Secret is owned by another recipe (Issue #637)', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: {
          resourceVersion: '1',
          labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
        },
        data: { 'required-token': 'eA==', 'optional-token': 'eA==' },
      })

      const r = await reconciler.reconcile(recipeWithOptionalKey())

      // The offending workload is not rendered — no foreign secretKeyRef reaches
      // a pod, for required OR optional mappings (the #637 fix; previously the
      // required key was still projected and the kubelet injected the credential).
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      expect(r.phase).toBe('degraded')
      const cond = (r.secretOwnershipConditions ?? []).find(
        c => c.type === 'EnvSecretOwnershipDenied'
      )
      expect(cond?.status).toBe('True')
      expect(cond?.message).toMatch(/not owned by recipe/)
    })

    it('revokes a denied StatefulSet without data loss: re-renders credential-free + deletes ONLY the Pods (Issue #637)', async () => {
      mockAppsApi.createNamespacedStatefulSet.mockClear()
      mockAppsApi.deleteNamespacedStatefulSet.mockClear()
      mockCoreApi.deleteCollectionNamespacedPod.mockClear()
      mockCoreApi.deleteNamespacedPersistentVolumeClaim.mockClear()
      // Secret exists and HAS the key, but it is owned by ANOTHER recipe → denied.
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: {
          resourceVersion: '1',
          labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
        },
        data: { 'db-password': 'eA==' },
      })

      const recipe = makeRecipe({
        spec: {
          workloads: [
            {
              id: 'db',
              type: 'statefulset',
              image: 'postgres:16',
              port: 5432,
              envSecret: {
                name: 'db-creds',
                keys: [{ secretKey: 'db-password', envVar: 'POSTGRES_PASSWORD' }],
              },
            },
          ],
        },
      })

      const r = await reconciler.reconcile(recipe)

      // Data-safe: the StatefulSet object and its PVCs survive.
      expect(mockAppsApi.deleteNamespacedStatefulSet).not.toHaveBeenCalled()
      expect(mockCoreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
      // The StatefulSet is re-rendered WITHOUT the foreign credential...
      expect(mockAppsApi.createNamespacedStatefulSet).toHaveBeenCalled()
      const stsBody = mockAppsApi.createNamespacedStatefulSet.mock.calls.at(-1)![0].body
      const envNames = (stsBody.spec.template.spec.containers[0].env ?? []).map(
        (e: { name: string }) => e.name
      )
      expect(envNames).not.toContain('POSTGRES_PASSWORD')
      // ...and ONLY its managed Pods are deleted (forced restart from clean template).
      expect(mockCoreApi.deleteCollectionNamespacedPod).toHaveBeenCalledWith(
        expect.objectContaining({ labelSelector: expect.stringMatching(/^app=/) })
      )
      expect(r.phase).toBe('degraded')
      const cond = (r.secretOwnershipConditions ?? []).find(
        c => c.type === 'EnvSecretOwnershipDenied'
      )
      expect(cond?.status).toBe('True')
    })

    it('fails closed: does NOT render a workload whose envSecret Secret is unlabeled (no ownership claim) (Issue #637)', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: { resourceVersion: '1' },
        data: { 'required-token': 'eA==', 'optional-token': 'eA==' },
      })

      const r = await reconciler.reconcile(recipeWithOptionalKey())

      // Unlabeled in a co-tenant namespace = deny-by-default.
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      expect(r.phase).toBe('degraded')
      const cond = (r.secretOwnershipConditions ?? []).find(
        c => c.type === 'EnvSecretOwnershipDenied'
      )
      expect(cond?.status).toBe('True')
    })

    it('requeues (no silent swallow) when a denied workload teardown FAILS (Issue #637 fail-closed)', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: {
          resourceVersion: '1',
          labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
        },
        data: { 'required-token': 'eA==', 'optional-token': 'eA==' },
      })
      // Force the denied-workload teardown to throw. Previously this was swallowed
      // (.catch(() => undefined)) with no requeue, so a foreign-credentialed pod could
      // linger until an unrelated event; now it must requeue to retry the revocation.
      const teardownSpy = vi
        .spyOn(
          reconciler as unknown as { teardownDeniedWorkload: () => Promise<void> },
          'teardownDeniedWorkload'
        )
        .mockRejectedValue(new Error('apiserver 500 during teardown'))

      const r = await reconciler.reconcile(recipeWithOptionalKey())

      // The denied workload is still not rendered and the condition is still accurate...
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      const cond = (r.secretOwnershipConditions ?? []).find(
        c => c.type === 'EnvSecretOwnershipDenied'
      )
      expect(cond?.status).toBe('True')
      // ...but the failed teardown now forces a requeue instead of being dropped.
      expect(r.requeueAfterMs).toBeGreaterThan(0)

      teardownSpy.mockRestore()
    })

    it('CRITICAL: a denied DEPLOYMENT whose underlying delete fails non-404 requeues — the revocation teardown must NOT go through the swallowing safeDelete (Issue #637 fail-open)', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockAppsApi.deleteNamespacedDeployment.mockClear()
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: {
          resourceVersion: '1',
          labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
        },
        data: { 'required-token': 'eA==', 'optional-token': 'eA==' },
      })
      // Unlike the test above (which spies teardownDeniedWorkload and so bypasses the
      // real delete), this mocks the UNDERLYING Deployment delete to fail with a non-404.
      // Before the fix, deleteWorkload→safeDelete SWALLOWED non-404 → teardownDeniedWorkload
      // returned normally → no requeue, and a false EnvSecretOwnershipDenied=True was
      // written while the old foreign-credentialed pod stayed live (fail-open). Now the
      // revocation path uses the throwing variant, so the failure propagates and requeues.
      mockAppsApi.deleteNamespacedDeployment.mockRejectedValue({
        code: 500,
        message: 'apiserver 500',
      })

      const r = await reconciler.reconcile(recipeWithOptionalKey())

      // The foreign credential is never rendered into a new pod...
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      // ...the teardown delete WAS attempted (and failed non-404)...
      expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalled()
      // ...and its failure now drives a requeue (was undefined before the fix, because
      // safeDelete swallowed the non-404 so teardownDeniedWorkload returned normally).
      expect(r.requeueAfterMs).toBeGreaterThan(0)

      // Restore the shared delete mock so this failure injection does not leak into a
      // later test that relies on deleteNamespacedDeployment succeeding.
      mockAppsApi.deleteNamespacedDeployment.mockResolvedValue({})
    })

    it('a denied Job and CronJob revocation deletes with Background propagation so their running pods are reaped, not orphaned (Issue #637)', async () => {
      mockBatchApi.deleteNamespacedJob.mockClear()
      mockBatchApi.deleteNamespacedCronJob.mockClear()
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: {
          resourceVersion: '1',
          labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
        },
        data: { 'required-token': 'eA==' },
      })
      const recipe = makeRecipe({
        spec: {
          workloads: [
            {
              id: 'batch',
              type: 'job',
              image: 'batch:test',
              envSecret: {
                name: 'creds',
                keys: [{ secretKey: 'required-token', envVar: 'TOKEN' }],
              },
            },
            {
              id: 'sched',
              type: 'cronjob',
              image: 'batch:test',
              schedule: '0 0 * * *',
              envSecret: {
                name: 'creds',
                keys: [{ secretKey: 'required-token', envVar: 'TOKEN' }],
              },
            },
          ],
        },
      })

      await reconciler.reconcile(recipe)

      // The denied Job/CronJob teardown (revocation path, throwOnError) must delete with
      // Background propagation so the apiserver reaps the running (foreign-credentialed)
      // pods instead of orphaning them (the apiserver default for a Job is Orphan).
      // Removing propagationPolicy from the job/cronjob branch of deleteWorkload makes
      // this red — closing the gap that the finalizer-only CronJob test left (no Job
      // assertion, and only on the non-revocation path).
      expect(mockBatchApi.deleteNamespacedJob).toHaveBeenCalledWith(
        expect.objectContaining({ propagationPolicy: 'Background' })
      )
      expect(mockBatchApi.deleteNamespacedCronJob).toHaveBeenCalledWith(
        expect.objectContaining({ propagationPolicy: 'Background' })
      )
    })

    it('fails closed on the CROSS-NAMESPACE first-wins bypass: a transport workload listed first must not mask a foreign Secret in a non-transport workload (Issue #637, @claude review)', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      // The SAME Secret name resolves to two namespaces: the transport workload
      // (listed FIRST) reads it in mcp-server where the attacker never created it
      // (404 → missing); the non-transport workload reads it in sandbox-recipes
      // where it EXISTS and is owned by another recipe (denied). A first-wins
      // name→namespace map would classify only mcp-server (missing) and render the
      // non-transport pod with the foreign secretKeyRef. Worst-wins combine must
      // make the verdict denied.
      mockCoreApi.readNamespacedSecret.mockImplementation((args: { namespace: string }) =>
        args.namespace === 'mcp-server'
          ? Promise.reject({ code: 404 })
          : Promise.resolve({
              metadata: {
                resourceVersion: '1',
                labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
              },
              data: { k: 'eA==' },
            })
      )

      const recipe = makeRecipe({
        spec: {
          workloads: [
            {
              id: 'mcp',
              type: 'deployment',
              image: 'clerum/mock-mcp-server:test',
              port: 3000,
              transport: { type: 'streamableHttp', path: '/mcp' },
              envSecret: { name: 'shared-name', keys: [{ secretKey: 'k', envVar: 'TOKEN' }] },
            },
            {
              id: 'app',
              type: 'deployment',
              image: 'nginx:1.30.1-alpine',
              port: 8080,
              envSecret: { name: 'shared-name', keys: [{ secretKey: 'k', envVar: 'STOLEN' }] },
            },
          ],
        },
      })

      const r = await reconciler.reconcile(recipe)

      // The non-transport 'app' pod must NOT be rendered with the foreign credential.
      const appDeploys = mockAppsApi.createNamespacedDeployment.mock.calls.filter(
        ([arg]) => arg.body?.metadata?.labels?.['clerum.io/workload'] === 'app'
      )
      expect(appDeploys).toHaveLength(0)
      expect(r.phase).toBe('degraded')
      const cond = (r.secretOwnershipConditions ?? []).find(
        c => c.type === 'EnvSecretOwnershipDenied'
      )
      expect(cond?.status).toBe('True')
    })

    it('projects a required envSecret key when the Secret is owned by this recipe', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      const recipe = recipeWithOptionalKey()
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: {
          resourceVersion: '1',
          labels: { 'clerum.io/owner-recipe': recipe.metadata.name },
        },
        data: { 'required-token': 'eA==', 'optional-token': 'eA==' },
      })

      await reconciler.reconcile(recipe)

      const body = mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body
      const envVars = body.spec.template.spec.containers[0].env as Array<{ name: string }>
      const names = envVars.map(e => e.name)
      expect(names).toContain('REQUIRED_TOKEN')
      expect(names).toContain('OPTIONAL_TOKEN')
    })

    it('projects a required envSecret key from a shared Secret (clerum.io/shared=true)', async () => {
      mockAppsApi.createNamespacedDeployment.mockClear()
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        metadata: { resourceVersion: '1', labels: { 'clerum.io/shared': 'true' } },
        data: { 'required-token': 'eA==', 'optional-token': 'eA==' },
      })

      await reconciler.reconcile(recipeWithOptionalKey())

      const body = mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body
      const envVars = body.spec.template.spec.containers[0].env as Array<{ name: string }>
      expect(envVars.map(e => e.name)).toContain('REQUIRED_TOKEN')
    })

    it('still projects a required (non-optional) env var even when the Secret is missing — kubelet fails the pod', async () => {
      const err = Object.assign(new Error('not found'), {
        response: { statusCode: 404 },
        code: 404,
      })
      mockCoreApi.readNamespacedSecret.mockRejectedValue(err)

      const recipe = makeRecipe({
        spec: {
          workloads: [
            {
              id: 'app',
              type: 'deployment',
              image: 'nginx:1.30.1-alpine',
              port: 8080,
              envSecret: {
                name: 'app-creds',
                keys: [{ secretKey: 'k', envVar: 'K' }],
              },
            },
          ],
        },
      })
      await reconciler.reconcile(recipe)

      const body = mockAppsApi.createNamespacedDeployment.mock.calls[0][0].body
      const envVars = body.spec.template.spec.containers[0].env as Array<{
        name: string
        valueFrom?: { secretKeyRef?: { name: string; key: string } }
      }>
      expect(envVars).toHaveLength(1)
      expect(envVars[0].valueFrom?.secretKeyRef).toEqual({ name: 'app-creds', key: 'k' })
    })
  })

  // ─── oauthClientRefs admission-time validation ─────────────────────────
  describe('oauthClientRefs validation', () => {
    function recipeWithRef(
      refs: string[],
      overrides?: {
        clients?: NonNullable<WorkflowRecipeCRD['spec']['oauthClients']>
        transport?: { type: 'streamableHttp' }
        ui?: WorkflowRecipeCRD['spec']['ui']
        workloadId?: string
      }
    ): WorkflowRecipeCRD {
      const workloadId = overrides?.workloadId ?? 'app'
      return makeRecipe({
        spec: {
          ...(overrides?.ui ? { ui: overrides.ui } : {}),
          workloads: [
            {
              id: workloadId,
              type: 'deployment',
              image: 'nginx:1.30.1-alpine',
              port: 8080,
              oauthClientRefs: refs,
              ...(overrides?.transport
                ? { transport: overrides.transport, contextRef: 'ctx' as never }
                : {}),
            },
          ],
          oauthClients: overrides?.clients,
          ...(overrides?.transport ? { contextRef: 'default' } : {}),
        },
      })
    }

    it('rejects an oauthClientRefs entry that names no spec.oauthClients[].id', async () => {
      const recipe = recipeWithRef(['ghost'], {
        clients: [
          {
            id: 'sf',
            provider: 'salesforce',
            clientIdRef: { name: 'creds', key: 'cid' },
            clientSecretRef: { name: 'creds', key: 'cs' },
            backgroundAccess: true,
          },
        ],
      })
      const result = await reconciler.reconcile(recipe)
      expect(result.phase).toBe('failed')
      expect(result.message).toMatch(/oauthClientRefs/)
      expect(result.message).toMatch(/"ghost"/)
      expect(result.message).toMatch(/does not reference any spec\.oauthClients/)
    })

    it('rejects an oauthClientRefs entry pointing at a non-backgroundAccess client', async () => {
      const recipe = recipeWithRef(['sf'], {
        clients: [
          {
            id: 'sf',
            provider: 'salesforce',
            clientIdRef: { name: 'creds', key: 'cid' },
            clientSecretRef: { name: 'creds', key: 'cs' },
            // backgroundAccess omitted — defaults to undefined/false
          },
        ],
      })
      const result = await reconciler.reconcile(recipe)
      expect(result.phase).toBe('failed')
      expect(result.message).toMatch(/oauthClientRefs/)
      expect(result.message).toMatch(/"sf"/)
      expect(result.message).toMatch(/backgroundAccess: true/)
    })

    it('rejects a duplicate id within oauthClientRefs', async () => {
      const recipe = recipeWithRef(['sf', 'sf'], {
        clients: [
          {
            id: 'sf',
            provider: 'salesforce',
            clientIdRef: { name: 'creds', key: 'cid' },
            clientSecretRef: { name: 'creds', key: 'cs' },
            backgroundAccess: true,
          },
        ],
      })
      const result = await reconciler.reconcile(recipe)
      expect(result.phase).toBe('failed')
      expect(result.message).toMatch(/duplicate id "sf"/)
    })

    it('rejects oauthClientRefs on an MCP transport workload', async () => {
      const recipe = recipeWithRef(['sf'], {
        clients: [
          {
            id: 'sf',
            provider: 'salesforce',
            clientIdRef: { name: 'creds', key: 'cid' },
            clientSecretRef: { name: 'creds', key: 'cs' },
            backgroundAccess: true,
          },
        ],
        transport: { type: 'streamableHttp' },
      })
      const result = await reconciler.reconcile(recipe)
      expect(result.phase).toBe('failed')
      expect(result.message).toMatch(/transport \(MCP\)/)
    })

    it('rejects oauthClientRefs on the UI workload', async () => {
      const recipe = recipeWithRef(['sf'], {
        clients: [
          {
            id: 'sf',
            provider: 'salesforce',
            clientIdRef: { name: 'creds', key: 'cid' },
            clientSecretRef: { name: 'creds', key: 'cs' },
            backgroundAccess: true,
          },
        ],
        workloadId: 'ui-app',
        ui: { workloadRef: 'ui-app', port: 8080 },
      })
      const result = await reconciler.reconcile(recipe)
      expect(result.phase).toBe('failed')
      expect(result.message).toMatch(/UI workload/)
    })

    it('accepts a workload whose oauthClientRefs all resolve to backgroundAccess clients', async () => {
      const recipe = recipeWithRef(['sf'], {
        clients: [
          {
            id: 'sf',
            provider: 'salesforce',
            clientIdRef: { name: 'creds', key: 'cid' },
            clientSecretRef: { name: 'creds', key: 'cs' },
            backgroundAccess: true,
          },
        ],
      })
      const result = await reconciler.reconcile(recipe)
      // No validateSpec throw → phase is whatever the workload deploy yields.
      // The point of this test is to assert NOT failed-from-validation.
      expect(result.phase).not.toBe('failed')
    })
  })

  // ─── Broker-token issuance failure is non-fatal ─────────────────────────
  //
  // A transient control-api blip during reconcile (e.g. it is mid-restart)
  // used to permanently brick the recipe — phase=failed is a terminal,
  // non-deployable state and the rotation loop alone cannot transition out
  // of it. Reconcile now logs and continues so dependent pods sit in
  // ContainerCreating until the next rotation tick succeeds, rather than
  // the whole recipe getting stuck.
  describe('broker-token issuance failure during reconcile', () => {
    beforeEach(() => {
      vi.spyOn(brokerIssuer, 'issueOAuthBrokerToken').mockReset()
      mockCoreApi.readNamespacedSecret.mockReset()
    })

    function recipeWithBackgroundAccess(): WorkflowRecipeCRD {
      return makeRecipe({
        spec: {
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 }],
          oauthClients: [
            {
              id: 'gmail',
              provider: 'google',
              clientIdRef: { name: 'creds', key: 'client-id' },
              clientSecretRef: { name: 'creds', key: 'client-secret' },
              scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
              backgroundAccess: true,
            },
          ],
        },
      })
    }

    it('does not transition the recipe to failed when issueOAuthBrokerToken throws', async () => {
      // Secret missing → reconcile takes the "create" branch, which calls
      // issueOAuthBrokerToken. The mock makes that call time out.
      mockCoreApi.readNamespacedSecret.mockRejectedValue(
        Object.assign(new Error('not found'), { code: 404 })
      )
      vi.spyOn(brokerIssuer, 'issueOAuthBrokerToken').mockRejectedValue(
        new Error('OAuth broker token issuance timed out after 10000ms for recipe "test-recipe"')
      )
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const result = await reconciler.reconcile(recipeWithBackgroundAccess())

      expect(result.phase).not.toBe('failed')
      expect(result.phase).toBe('active')
      // Warning was emitted so the operator can see what happened.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Broker-token issuance failed during reconcile')
      )
      // Workloads still deployed.
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
    })
  })

  // ─── Transient API-server blip must not latch a healthy recipe ──────────
  //
  // A momentary controller↔API partition (connect ETIMEDOUT) used to throw
  // mid-reconcile and flip an otherwise-healthy recipe to the terminal
  // `failed` phase, which the skip guard then refused to re-process — a
  // false-positive failure with no self-recovery. Reconcile now classifies
  // retryable infra errors and leaves the recipe alone so the next resync
  // retries, and re-reconciles a transiently-latched recipe back to active.
  describe('transient infra error handling', () => {
    function etimedout(): Error {
      return Object.assign(
        new Error(
          'request to https://203.0.113.10/api/v1/namespaces/sandbox-recipes/services/app failed, reason: connect ETIMEDOUT 203.0.113.10:443'
        ),
        { code: 'ETIMEDOUT', name: 'FetchError' }
      )
    }

    it('does not latch an active recipe to failed when an API call times out', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      // A K8s call deep in the pipeline (Service create) times out at connect.
      mockCoreApi.createNamespacedService.mockRejectedValueOnce(etimedout())

      const recipe = makeRecipe({
        status: {
          phase: 'active',
          message: 'All workloads deployed',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
      const result = await reconciler.reconcile(recipe)

      expect(result.phase).not.toBe('failed')
      expect(result.phase).toBe('active')
      // Status is left untouched — no churn, no false "Failed" in the UI.
      expect(result.skipStatusPatch).toBe(true)
      // Prior workload readiness is preserved, not wiped to [].
      expect(result.workloadStatuses).toEqual([
        { id: 'app', phase: 'deployed', ready: true, message: undefined },
      ])
    })

    it('does not latch an active recipe to failed when the API server returns a top-level 5xx', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockCoreApi.createNamespacedService.mockRejectedValueOnce({
        statusCode: 503,
        message: 'apiserver temporarily unavailable',
      })

      const recipe = makeRecipe({
        status: {
          phase: 'active',
          message: 'All workloads deployed',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
      const result = await reconciler.reconcile(recipe)

      expect(result.phase).toBe('active')
      expect(result.message).toBe('All workloads deployed')
      expect(result.skipStatusPatch).toBe(true)
      expect(result.requeueAfterMs).toBeGreaterThan(0)
      expect(result.workloadStatuses).toEqual([
        { id: 'app', phase: 'deployed', ready: true, message: undefined },
      ])
    })

    it('re-reconciles a recipe latched in failed by a transient message and recovers it to active', async () => {
      const recipe = makeRecipe({
        status: {
          phase: 'failed',
          message:
            'FetchError: request to https://203.0.113.10/apis/networking.k8s.io/v1/namespaces/sandbox-recipes/networkpolicies failed, reason: connect ETIMEDOUT 203.0.113.10:443',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
      const result = await reconciler.reconcile(recipe)

      // Self-healed: the pipeline ran and drove it back to active.
      expect(result.phase).toBe('active')
      expect(result.message).toBe('All workloads deployed')
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalled()
    })

    it('re-reconciles a recipe failed by shared mcp-server internal dependency boundary', async () => {
      mockAppsApi.readNamespacedDeployment.mockResolvedValue({
        metadata: { resourceVersion: '1' },
        status: { readyReplicas: 1 },
      })
      const recipe = makeRecipe({
        spec: {
          workloads: [
            {
              id: 'api',
              type: 'deployment',
              image: 'api:test',
              port: 8080,
              env: [
                { name: 'DB_HOST', value: '{{db:host}}' },
                {
                  name: 'CONTACT_FINDER_MCP_URL',
                  value: 'http://mcp-contact-finder.mcp-server.svc.cluster.local:3000/mcp',
                },
              ],
            },
            { id: 'db', type: 'deployment', image: 'postgres:16', port: 5432 },
          ],
        },
        status: {
          phase: 'failed',
          message:
            'Workload "api" env.CONTACT_FINDER_MCP_URL references cluster-local host "mcp-contact-finder.mcp-server.svc.cluster.local", but it is not an eligible runtime Service in WorkflowRecipe "test-recipe"',
          conditions: [
            {
              type: 'InternalDependenciesReady',
              status: 'False',
              reason: 'InvalidInternalDependency',
              message:
                'Workload "api" env.CONTACT_FINDER_MCP_URL references cluster-local host "mcp-contact-finder.mcp-server.svc.cluster.local", but it is not an eligible runtime Service in WorkflowRecipe "test-recipe"',
              lastTransitionTime: '2026-06-08T00:00:00.000Z',
            },
          ],
          workloads: [{ id: 'api', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })

      const result = await reconciler.reconcile(recipe)

      expect(result.phase).toBe('active')
      expect(result.internalDependencyConditions?.[0]).toMatchObject({
        type: 'InternalDependenciesReady',
        status: 'True',
        reason: 'Reconciled',
      })
      expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalled()
      const internalPolicies = mockNetworkingApi.createNamespacedNetworkPolicy.mock.calls
        .map(call => call[0].body)
        .filter(
          policy => policy.metadata?.labels?.['clerum.io/policy-type'] === 'internal-dependency'
        )
      expect(internalPolicies.map(policy => policy.metadata?.name)).toEqual([
        'wr-intdep-egress-test-recipe-api',
        'wr-intdep-ingress-test-recipe-db',
      ])
    })

    it('still skips a recipe that failed for a non-transient, recipe-specific reason', async () => {
      const recipe = makeRecipe({
        status: {
          phase: 'failed',
          message: 'All workloads excluded by includeWhen conditions',
          workloads: [],
        },
      })
      const result = await reconciler.reconcile(recipe)

      expect(result.phase).toBe('failed')
      expect(result.message).toContain('excluded')
      // Guard held — the deploy pipeline never ran.
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    })

    it('does NOT self-heal a policy-violation failure even when the message embeds a transient token (security)', async () => {
      // A policy-rejected recipe whose operator-controlled image is named to
      // smuggle "ETIMEDOUT" into the persisted "Policy violation: …" message.
      // The transient self-heal exception must NOT fire — otherwise the
      // alreadyPolicyFailed idempotency guard would skip re-enforcement and the
      // policy-rejected workload would deploy.
      const recipe = makeRecipe({
        status: {
          phase: 'failed',
          message:
            'Policy violation: [pol] imageAllowlist: Workload "app" image "docker.io/evil:ETIMEDOUT" not in allowlist',
          workloads: [],
        },
      })
      const result = await reconciler.reconcile(recipe)

      expect(result.phase).toBe('failed')
      expect(result.message).toContain('Policy violation:')
      // Critical: the deploy pipeline must NOT run for a policy-failed recipe.
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      expect(mockCoreApi.createNamespacedService).not.toHaveBeenCalled()
    })

    it('does NOT self-heal a policy-violation failure with a stale shared mcp-server internal-dependency condition (security)', async () => {
      const staleBoundaryMessage =
        'Workload "api" env.CONTACT_FINDER_MCP_URL references cluster-local host "mcp-contact-finder.mcp-server.svc.cluster.local", but it is not an eligible runtime Service in WorkflowRecipe "test-recipe"'
      const recipe = makeRecipe({
        status: {
          phase: 'failed',
          message:
            'Policy violation: [pol] imageAllowlist: Workload "api" image "docker.io/evil:latest" not in allowlist',
          conditions: [
            {
              type: 'InternalDependenciesReady',
              status: 'False',
              reason: 'InvalidInternalDependency',
              message: staleBoundaryMessage,
              lastTransitionTime: '2026-06-08T00:00:00.000Z',
            },
          ],
          workloads: [],
        },
      })

      const result = await reconciler.reconcile(recipe)

      expect(result.phase).toBe('failed')
      expect(result.message).toContain('Policy violation:')
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      expect(mockCoreApi.createNamespacedService).not.toHaveBeenCalled()
    })

    it('re-enforces policy on the self-heal path: a transient-latched recipe is still rejected by an active denylist (security invariant)', async () => {
      // The fix's safety rests on policy ALWAYS re-running before deploy on the
      // self-heal path. This recipe IS self-heal-eligible (genuine transient
      // message, not a "Policy violation:" one) but its image violates an
      // active denylist policy. It must re-fail at policy enforcement, never
      // reaching resource creation.
      const recipe = makeRecipe({
        spec: {
          workloads: [
            { id: 'app', type: 'deployment', image: 'docker.io/evil:latest', port: 8080 },
          ],
        },
        status: {
          phase: 'failed',
          message:
            'FetchError: request to https://10.96.0.1/apis/networking.k8s.io/v1/namespaces/sandbox-recipes/networkpolicies failed, reason: connect ETIMEDOUT 10.96.0.1:443',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
      const denyPolicy = {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipePolicy',
        metadata: { name: 'deny-evil', namespace: 'sandbox-recipes' },
        // `**` globstar matches across `/` path segments (single `*` would not).
        spec: { detection: { imageDenylist: ['**evil**'] } },
      }
      mockCustomApi.listNamespacedCustomObject.mockImplementation((args: { plural?: string }) =>
        Promise.resolve({
          items: args?.plural === 'workflowrecipepolicies' ? [denyPolicy] : [],
        })
      )
      try {
        const result = await reconciler.reconcile(recipe)

        // Self-heal was eligible, but policy re-enforcement rejected it first.
        expect(result.phase).toBe('failed')
        expect(result.message).toContain('Policy violation:')
        expect(result.message).toContain('denylist')
        // Invariant: a denylisted image never deploys, even via self-heal.
        expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
      } finally {
        mockCustomApi.listNamespacedCustomObject.mockResolvedValue({ items: [] })
      }
    })

    // The exact persisted messages observed on dev (helpdesk / leadforge / recap)
    // when the controller↔API-server link blipped mid-reconcile.
    it('self-heals recipes latched by the real dev API-timeout messages', async () => {
      const devMessages = [
        // helpdesk — pre-deploy Context allowlist fetch
        'Error: Pre-deploy failed for WorkflowRecipe "recipe-helpdesk-v1-0-0-4549198b". WRC cannot start transport workloads until HCC can reconcile child McpServers: Error: Pre-deploy Context allowlist failed for "recipe-helpdesk-v1-0-0-4549198b": request to https://203.0.113.10/apis/clerum.io/v1alpha1/namespaces/mcp-server/contexts/context1 failed, reason: connect ETIMEDOUT 203.0.113.10:443',
        // leadforge — NetworkPolicy fetch
        'FetchError: request to https://203.0.113.10/apis/networking.k8s.io/v1/namespaces/sandbox-recipes/networkpolicies/wl-egress-recipe-leadforge-app-v1-0-0-bdb457b6-prospector-api failed, reason: connect ETIMEDOUT 203.0.113.10:443',
        // recap — NetworkPolicy list
        'FetchError: request to https://203.0.113.10/apis/networking.k8s.io/v1/namespaces/sandbox-recipes/networkpolicies failed, reason: connect ETIMEDOUT 203.0.113.10:443',
      ]
      for (const message of devMessages) {
        const recipe = makeRecipe({
          status: {
            phase: 'failed',
            message,
            workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
          },
        })
        const result = await reconciler.reconcile(recipe)
        expect(result.phase, message).toBe('active')
      }
    })

    // ── Observed-health self-heal (fix #3) ──────────────────────────────
    // The durable backstop: even when the latched message is NOT recognized
    // by the transport-error classifier, a recipe whose last-observed
    // workloads were all ready must re-derive its phase from live health
    // rather than staying stuck at `failed`. This is the exact worktracker
    // pre-deploy incident — the message ("Pre-deploy failed … cannot start
    // transport workloads … Reconciler will retry") carries no `connect
    // ETIMEDOUT`/`reason:` shape, so isRetryableInfraError(message) is false.
    const worktrackerLatchMessage =
      'Pre-deploy failed for WorkflowRecipe "test-recipe". WRC cannot start transport ' +
      'workloads until HCC can reconcile child McpServers: Error: Pre-deploy failed for ' +
      'workload(s): wt-mcp. Reconciler will retry to ensure all NetworkPolicies are applied ' +
      'before workloads start.'

    it('self-heals a failed recipe with an UNRECOGNIZED message when all observed workloads are ready', async () => {
      // Guard against a false positive from the transport classifier — the
      // recovery here must come from observed health, not message matching.
      expect(isRetryableInfraError(worktrackerLatchMessage)).toBe(false)
      const recipe = makeRecipe({
        status: {
          phase: 'failed',
          message: worktrackerLatchMessage,
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
      const result = await reconciler.reconcile(recipe)
      expect(result.phase).toBe('active')
    })

    it('does NOT self-heal a failed recipe with NO observed workloads (pre-workload failure stays terminal)', async () => {
      // status.workloads empty ⇒ the recipe failed before any workload was
      // observed healthy (bad spec, pre-deploy never succeeded). Re-running it
      // would churn; it must stay skipped at `failed`.
      const recipe = makeRecipe({
        status: { phase: 'failed', message: worktrackerLatchMessage, workloads: [] },
      })
      const result = await reconciler.reconcile(recipe)
      expect(result.phase).toBe('failed')
      expect(result.message).toBe(worktrackerLatchMessage)
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    })

    it('does NOT self-heal a failed recipe when an observed workload is not ready', async () => {
      const recipe = makeRecipe({
        status: {
          phase: 'failed',
          message: worktrackerLatchMessage,
          workloads: [
            { id: 'app', type: 'deployment', phase: 'deployed', ready: true },
            { id: 'db', type: 'statefulset', phase: 'pending', ready: false },
          ],
        },
      })
      const result = await reconciler.reconcile(recipe)
      expect(result.phase).toBe('failed')
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    })

    it('does NOT self-heal a policy-violation failure even with all observed workloads ready (security)', async () => {
      const recipe = makeRecipe({
        status: {
          phase: 'failed',
          message: 'Policy violation: [deny-evil] imageDenylist: image matches **evil**',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
      const result = await reconciler.reconcile(recipe)
      expect(result.phase).toBe('failed')
      expect(result.message).toContain('Policy violation:')
      expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    })

    it('does NOT self-heal a genuinely failed WORKFLOW run even when its workloads are ready', async () => {
      // For a workflow, workload readiness ≠ run success. A real "Workflow
      // failed" must stay terminal — the observed-health heuristic is scoped
      // to non-workflow recipes only.
      const recipe = makeRecipe({
        spec: {
          agent: { provider: 'zai', model: 'glm-4.7' },
          steps: [{ id: 'research', instruction: 'search' }],
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 }],
        },
        status: {
          phase: 'failed',
          message: 'Workflow failed',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
          workflowExecution: { phase: 'failed', message: 'step research crashed' },
        },
      })
      const result = await reconciler.reconcile(recipe)
      expect(result.phase).toBe('failed')
    })

    it('keeps phase + requeues when a live NetworkPolicy create times out (leadforge path)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const kc = new k8s.KubeConfig()
      const r = new WorkflowRecipeReconciler(kc, undefined, {
        fqdnLookup: async () => ({
          kind: 'ok',
          ipv4: ['93.184.216.34'],
          ipv6: [],
          ttlSeconds: 300,
        }),
      })
      mockNetworkingApi.createNamespacedNetworkPolicy.mockRejectedValueOnce(
        Object.assign(
          new Error(
            'request to https://10.96.0.1/apis/networking.k8s.io/v1/namespaces/sandbox-recipes/networkpolicies failed, reason: connect ETIMEDOUT 10.96.0.1:443'
          ),
          { code: 'ETIMEDOUT', name: 'FetchError' }
        )
      )
      const recipe = makeRecipe({
        spec: {
          workloads: [
            {
              id: 'app',
              type: 'deployment',
              image: 'nginx:1.30.1-alpine',
              port: 8080,
              egressBindings: [{ dns: 'api.example.com', port: 443 }],
            },
          ],
        },
        status: {
          phase: 'active',
          message: 'All workloads deployed',
          workloads: [{ id: 'app', type: 'deployment', phase: 'deployed', ready: true }],
        },
      })
      const result = await r.reconcile(recipe)

      expect(result.phase).not.toBe('failed')
      expect(result.skipStatusPatch).toBe(true)
      expect(result.requeueAfterMs).toBeGreaterThan(0)
    })

    it('self-heals a child workflow latched failed by an API timeout via the recovering handoff', async () => {
      // The recipe phase is failed and the top-level message is just "Workflow
      // failed" — the transient timeout lives on the INNER workflowExecution.
      const recipe = makeRecipe({
        spec: { steps: [{ id: 'render', run: snippetRun() }] },
        status: {
          phase: 'failed',
          message: 'Workflow failed',
          workflowExecution: {
            phase: 'failed',
            message:
              'FetchError: request to https://10.96.0.1/apis/networking.k8s.io/v1/namespaces/sandbox-recipes/networkpolicies failed, reason: connect ETIMEDOUT 10.96.0.1:443',
          },
        },
      })
      const kc = new k8s.KubeConfig()
      const r = new WorkflowRecipeReconciler(kc)
      const workflowReconcile = vi.fn().mockResolvedValue({
        phase: 'deploying',
        message: 'Workflow infrastructure recreated',
        workflowPhase: 'recovering',
      })
      ;(
        r as unknown as {
          workflowReconciler: {
            reconcile: typeof workflowReconcile
            validateWorkflowSpec: () => undefined
          }
        }
      ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

      const result = await r.reconcile(recipe)

      // Terminal guard bypassed → inner reconcile invoked for recovery...
      expect(workflowReconcile).toHaveBeenCalledTimes(1)
      // ...with a `recovering` execution phase (not the stale `failed`),
      // preserving the original inner message.
      const inboundStatus = workflowReconcile.mock.calls[0][4] as {
        workflowExecution?: { phase?: string; message?: string }
      }
      expect(inboundStatus.workflowExecution?.phase).toBe('recovering')
      expect(inboundStatus.workflowExecution?.message).toContain('ETIMEDOUT')
      // Did NOT re-confirm the terminal failure.
      expect(result.phase).not.toBe('failed')
    })

    it('self-heals a workflow latched failed by a transient status.message with NO workflowExecution (fresh path)', async () => {
      // Edge case: latchedByTransientError is true via status.message alone, but
      // there is no existing workflowExecution to hand a `recovering` phase to.
      // The recovery handoff must NOT fire (nothing to preserve); the inner
      // reconciler starts fresh and the recipe is not re-latched failed.
      const recipe = makeRecipe({
        spec: { steps: [{ id: 'render', run: snippetRun() }] },
        status: {
          phase: 'failed',
          message:
            'FetchError: request to https://10.96.0.1/apis/networking.k8s.io/v1/namespaces/sandbox-recipes/networkpolicies failed, reason: connect ETIMEDOUT 10.96.0.1:443',
          // NOTE: no workflowExecution — recipe failed before one was persisted.
        },
      })
      const kc = new k8s.KubeConfig()
      const r = new WorkflowRecipeReconciler(kc)
      const workflowReconcile = vi.fn().mockResolvedValue({
        phase: 'deploying',
        message: 'Workflow infrastructure created',
        workflowPhase: 'deploying',
      })
      ;(
        r as unknown as {
          workflowReconciler: {
            reconcile: typeof workflowReconcile
            validateWorkflowSpec: () => undefined
          }
        }
      ).workflowReconciler = { reconcile: workflowReconcile, validateWorkflowSpec: () => undefined }

      const result = await r.reconcile(recipe)

      // Terminal guard bypassed (transient) → inner reconcile invoked for a fresh start.
      expect(workflowReconcile).toHaveBeenCalledTimes(1)
      // No `recovering` handoff: inboundStatus.workflowExecution is undefined
      // because there was no existing execution to preserve.
      const inboundStatus = workflowReconcile.mock.calls[0][4] as {
        workflowExecution?: unknown
      }
      expect(inboundStatus.workflowExecution).toBeUndefined()
      // Did NOT re-latch the terminal failure.
      expect(result.phase).not.toBe('failed')
    })
  })

  // ── issue #375 BLOCKER (jozer-rami review): clientNotifications-only workflow-
  // lane SDK recipes must FALL THROUGH the two active-phase short-circuits (the
  // awaiting-trigger one and the steady-active one) the same way promptBridge
  // does, so the inner reconcile gathers the bootstrap proof and the capability
  // projects `validated` with NO skipStatusPatch. Before the fix both
  // short-circuits returned skipStatusPatch:true, shouldPatchRecipeStatus bailed
  // at its first line, and the awaiting_policy→validated transition was never
  // published — the original #375 symptom, unchanged, for that family.
  describe('issue #375 BLOCKER — clientNotifications-only workflow-lane fall-through', () => {
    const CN_MESSAGE = 'Workflow trigger infrastructure registered'

    function clientNotificationsOnlyRecipe(labels?: Record<string, string>): WorkflowRecipeCRD {
      return makeRecipe({
        metadata: {
          name: 'test-recipe',
          namespace: 'sandbox-recipes',
          uid: 'uid-123',
          ...(labels ? { labels } : {}),
        },
        spec: {
          steps: [{ id: 'step-1', run: snippetRun() }],
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 }],
          pluginWorkloadSdk: {
            clientNotifications: { allowedEventTypes: ['workflow.completed'] },
            allowedCallers: ['app'],
          },
        },
        status: {
          phase: 'active',
          message: CN_MESSAGE,
          pluginWorkloadSdk: {
            state: 'awaiting_policy',
            promptBridge: false,
            clientNotifications: true,
            message: 'Plugin Workload SDK clientNotifications is awaiting an operator grant',
            verifiedAt: new Date(Date.now() - 10_000).toISOString(),
          } as never,
        },
      })
    }

    function stubWorkflowReconciler() {
      const workflowReconcile = vi.fn().mockResolvedValue({
        phase: 'active',
        message: CN_MESSAGE,
        pluginWorkloadSdkBootstrapProof: {
          ready: true,
          contractVersion: 2,
          podUid: 'sdk-pod-uid',
          policyReady: true,
          clientNotificationsPolicyReady: true,
          verifiedAt: new Date().toISOString(),
        },
      })
      const reconcilePluginWorkloadSdkOnly = vi.fn()
      ;(
        reconciler as unknown as { config: { pluginWorkloadSdkEnabled: boolean } }
      ).config.pluginWorkloadSdkEnabled = true
      ;(
        reconciler as unknown as {
          workflowReconciler: {
            reconcile: typeof workflowReconcile
            reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
            validateWorkflowSpec: () => undefined
          }
        }
      ).workflowReconciler = {
        reconcile: workflowReconcile,
        reconcilePluginWorkloadSdkOnly,
        validateWorkflowSpec: () => undefined,
      }
      return { workflowReconcile, reconcilePluginWorkloadSdkOnly }
    }

    it('awaiting-trigger lane: recomputes and publishes awaiting_policy→validated (no skipStatusPatch)', async () => {
      // Phase active + mcpHost required (flag ON) + no run label + no
      // workflowExecution ⇒ the awaiting-trigger short-circuit. Pre-fix this
      // returned skipStatusPatch:true without ever calling the inner reconcile.
      const { workflowReconcile, reconcilePluginWorkloadSdkOnly } = stubWorkflowReconciler()
      const recipe = clientNotificationsOnlyRecipe()

      const result = await reconciler.reconcile(recipe)

      // Fall-through proof: the inner reconcile actually ran (steps present ⇒
      // the stepless SDK-only adapter must NOT be used).
      expect(workflowReconcile).toHaveBeenCalledTimes(1)
      expect(reconcilePluginWorkloadSdkOnly).not.toHaveBeenCalled()
      // The reconcile pass has an SDK opinion and does not suppress the patch.
      expect(result.skipStatusPatch).toBeFalsy()
      expect(result.pluginWorkloadSdkProjection?.capability?.state).toBe('validated')
      // The full chain the incident depends on: the watcher would publish it.
      expect(shouldPatchRecipeStatus(recipe, result)).toBe(true)
    })

    it('steady-active lane (run-labelled): recomputes and publishes awaiting_policy→validated (no skipStatusPatch)', async () => {
      // Phase active + run-id label ⇒ awaitsTriggeredRun=false ⇒ the steady-
      // active short-circuit, which pre-fix returned skipStatusPatch:true
      // unconditionally (no family carve-out at all).
      const { workflowReconcile, reconcilePluginWorkloadSdkOnly } = stubWorkflowReconciler()
      const recipe = clientNotificationsOnlyRecipe({ 'clerum.io/workflow-run-id': 'run-e2e-1' })

      const result = await reconciler.reconcile(recipe)

      expect(workflowReconcile).toHaveBeenCalledTimes(1)
      expect(reconcilePluginWorkloadSdkOnly).not.toHaveBeenCalled()
      expect(result.skipStatusPatch).toBeFalsy()
      expect(result.pluginWorkloadSdkProjection?.capability?.state).toBe('validated')
      expect(shouldPatchRecipeStatus(recipe, result)).toBe(true)
    })

    it('steady-active lane (run-labelled): promptBridge recipes ALSO fall through (no family re-carve)', async () => {
      // Side effect of the carve-out being family-agnostic: a promptBridge SDK
      // recipe in phase active, run-labelled (awaitsTriggeredRun false), with NO
      // in-progress execution, falls through the steady-active short-circuit
      // too — intended, bounded by the verifiedAt throttle. This pin turns RED
      // if the condition is ever re-carved by family (e.g.
      // `!recipe.spec.pluginWorkloadSdk?.clientNotifications`) or reverted to
      // the unconditional skipStatusPatch:true return.
      const { workflowReconcile, reconcilePluginWorkloadSdkOnly } = stubWorkflowReconciler()
      const recipe = makeRecipe({
        metadata: {
          name: 'test-recipe',
          namespace: 'sandbox-recipes',
          uid: 'uid-123',
          labels: { 'clerum.io/workflow-run-id': 'run-e2e-4' },
        },
        spec: {
          steps: [{ id: 'step-1', run: snippetRun() }],
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 }],
          pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
        },
        status: {
          phase: 'active',
          message: CN_MESSAGE,
          pluginWorkloadSdk: {
            state: 'awaiting_policy',
            promptBridge: true,
            clientNotifications: false,
            message: 'Plugin Workload SDK promptBridge is awaiting an operator grant',
            verifiedAt: new Date(Date.now() - 10_000).toISOString(),
          } as never,
        },
      })

      const result = await reconciler.reconcile(recipe)

      expect(workflowReconcile).toHaveBeenCalledTimes(1)
      expect(reconcilePluginWorkloadSdkOnly).not.toHaveBeenCalled()
      expect(result.skipStatusPatch).toBeFalsy()
      expect(result.pluginWorkloadSdkProjection?.capability?.state).toBe('validated')
      expect(shouldPatchRecipeStatus(recipe, result)).toBe(true)
    })

    it('steady-active lane with an IN-PROGRESS execution: SDK recipes still short-circuit (409-window protection)', async () => {
      // The carve-out is bounded: while a workflow execution is in progress the
      // steady-active short-circuit is KEPT even for SDK recipes — that branch
      // protects the coordinator's 409-free windows, and the capability
      // publication is level-triggered so it lands on the next non-running
      // pass. Removing the `|| wfInProgress` term from the carve-out condition
      // turns this RED: the running recipe would fall through to the inner
      // reconcile and drop skipStatusPatch.
      const { workflowReconcile, reconcilePluginWorkloadSdkOnly } = stubWorkflowReconciler()
      const recipe = clientNotificationsOnlyRecipe({ 'clerum.io/workflow-run-id': 'run-e2e-3' })
      recipe.status = {
        ...recipe.status,
        phase: 'active',
        workflowExecution: { phase: 'running' },
      } as typeof recipe.status

      const result = await reconciler.reconcile(recipe)

      expect(result.skipStatusPatch).toBe(true)
      expect(workflowReconcile).not.toHaveBeenCalled()
      expect(reconcilePluginWorkloadSdkOnly).not.toHaveBeenCalled()
    })

    it('non-SDK workflow recipes keep both steady-state short-circuits (no regression)', async () => {
      // The carve-out is SDK-scoped: a plain workflow recipe in the same two
      // shapes must still short-circuit with skipStatusPatch:true and must NOT
      // reach the inner reconcile on every steady tick.
      const { workflowReconcile } = stubWorkflowReconciler()
      const awaitingTrigger = makeRecipe({
        spec: {
          steps: [{ id: 'step-1', instruction: 'run' }],
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 }],
        },
        status: { phase: 'active', message: CN_MESSAGE },
      })
      const awaitingResult = await reconciler.reconcile(awaitingTrigger)
      expect(awaitingResult.skipStatusPatch).toBe(true)
      expect(workflowReconcile).not.toHaveBeenCalled()

      const runLabelled = makeRecipe({
        metadata: {
          name: 'test-recipe',
          namespace: 'sandbox-recipes',
          uid: 'uid-123',
          labels: { 'clerum.io/workflow-run-id': 'run-e2e-2' },
        },
        spec: {
          steps: [{ id: 'step-1', run: snippetRun() }],
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 }],
        },
        status: { phase: 'active', message: CN_MESSAGE },
      })
      const steadyResult = await reconciler.reconcile(runLabelled)
      expect(steadyResult.skipStatusPatch).toBe(true)
      expect(workflowReconcile).not.toHaveBeenCalled()
    })
  })

  // ── issue #375 M1 (jozer review): the projection WIRING is pinned against the
  // real pipeline, not hand-built ReconcileResults. Each test goes RED if its
  // wiring line is neutered:
  //   - reconcile() must ATTACH result.pluginWorkloadSdkProjection (the single
  //     line the whole P1 fix hangs on),
  //   - projectPluginWorkloadSdk must pass the persisted capability through as
  //     existingCapability (the R1 validatedAt carry-forward),
  //   - patchStatus must REUSE the attached projection instead of recomputing.
  describe('issue #375 M1 — projection wiring through the real pipeline', () => {
    it('reconcile() attaches a populated pluginWorkloadSdkProjection to every result', async () => {
      // Non-SDK recipe: the projection must still be attached (capability null =
      // "clear the field"), proving production populates it on EVERY reconcile.
      const result = await reconciler.reconcile(makeRecipe())
      expect(result.pluginWorkloadSdkProjection).toBeDefined()
      expect(result.pluginWorkloadSdkProjection?.capability).toBeNull()
    })

    it('reconcile() projects the SDK-only lane bootstrap proof into a validated capability', async () => {
      const reconcilePluginWorkloadSdkOnly = vi.fn().mockResolvedValue({
        phase: 'active',
        message: 'Plugin Workload SDK mcp-host registered',
        pluginWorkloadSdkBootstrapProof: {
          ready: true,
          contractVersion: 2,
          podUid: 'sdk-pod-uid',
          provider: 'zai',
          model: 'glm-4.7',
          policyReady: true,
          verifiedAt: '2026-08-04T00:00:00.000Z',
        },
      })
      ;(
        reconciler as unknown as { config: { pluginWorkloadSdkEnabled: boolean } }
      ).config.pluginWorkloadSdkEnabled = true
      ;(
        reconciler as unknown as {
          workflowReconciler: {
            reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
          }
        }
      ).workflowReconciler = { reconcilePluginWorkloadSdkOnly }

      const result = await reconciler.reconcile(
        makeRecipe({
          spec: {
            agent: { provider: 'zai', model: 'glm-4.7' },
            workloads: [
              { id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 },
            ],
            pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
          },
        })
      )

      // The REAL pipeline attached the projection and it carries the computed
      // capability — no test-side hand-building involved.
      expect(result.pluginWorkloadSdkProjection?.capability?.state).toBe('validated')
      expect(result.pluginWorkloadSdkProjection?.capability?.bootstrapPodUid).toBe('sdk-pod-uid')
    })

    it('carries forward the persisted validatedAt on a steady validated capability (R1 wiring)', async () => {
      const FIRST_VALIDATED_AT = '2026-08-01T00:00:00.000Z'
      const reconcilePluginWorkloadSdkOnly = vi.fn().mockResolvedValue({
        phase: 'active',
        message: 'Plugin Workload SDK mcp-host registered',
        pluginWorkloadSdkBootstrapProof: {
          ready: true,
          contractVersion: 2,
          podUid: 'sdk-pod-uid',
          provider: 'zai',
          model: 'glm-4.7',
          policyReady: true,
          verifiedAt: new Date().toISOString(),
        },
      })
      ;(
        reconciler as unknown as { config: { pluginWorkloadSdkEnabled: boolean } }
      ).config.pluginWorkloadSdkEnabled = true
      ;(
        reconciler as unknown as {
          workflowReconciler: {
            reconcilePluginWorkloadSdkOnly: typeof reconcilePluginWorkloadSdkOnly
          }
        }
      ).workflowReconciler = { reconcilePluginWorkloadSdkOnly }

      const result = await reconciler.reconcile(
        makeRecipe({
          spec: {
            agent: { provider: 'zai', model: 'glm-4.7' },
            workloads: [
              { id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 },
            ],
            pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
          },
          status: {
            phase: 'active',
            pluginWorkloadSdk: {
              state: 'validated',
              promptBridge: true,
              clientNotifications: false,
              validatedAt: FIRST_VALIDATED_AT,
              verifiedAt: new Date(Date.now() - 60_000).toISOString(),
            } as never,
          },
        })
      )

      // existingCapability wiring (workflowRecipeReconciler.ts): the stable
      // validatedAt marker must be CARRIED FORWARD, not re-stamped to `now`.
      expect(result.pluginWorkloadSdkProjection?.capability?.state).toBe('validated')
      expect(result.pluginWorkloadSdkProjection?.capability?.validatedAt).toBe(FIRST_VALIDATED_AT)
    })

    it('patchStatus REUSES the attached projection instead of recomputing it', async () => {
      // The attached projection is deliberately DISTINCT from anything
      // patchStatus could recompute from this recipe/result (no bootstrap proof
      // ⇒ a recompute projects degraded/BootstrapNotReady). If patchStatus
      // recomputes instead of reusing, the marker never reaches the patch body.
      const recipe = makeRecipe({
        spec: {
          workloads: [{ id: 'app', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 }],
          pluginWorkloadSdk: { promptBridge: {}, allowedCallers: ['app'] },
        },
        status: { phase: 'active' },
      })
      ;(
        reconciler as unknown as { config: { pluginWorkloadSdkEnabled: boolean } }
      ).config.pluginWorkloadSdkEnabled = true

      const attachedCapability = {
        state: 'validated' as const,
        promptBridge: true,
        clientNotifications: false,
        message: 'REUSED-PROJECTION-MARKER',
        bootstrapPodUid: 'marker-pod',
        verifiedAt: new Date().toISOString(),
      }
      await reconciler.patchStatus(recipe, {
        phase: 'active',
        message: 'All workloads deployed',
        workloadStatuses: [],
        pluginWorkloadSdkProjection: {
          conditions: [
            {
              type: 'PluginWorkloadSdkCapability',
              status: 'True',
              reason: 'Validated',
              message: 'REUSED-PROJECTION-MARKER',
              lastTransitionTime: new Date().toISOString(),
            },
          ],
          capability: attachedCapability as never,
        },
      })

      const patchCall = mockCustomApi.patchNamespacedCustomObjectStatus.mock.calls.at(-1)?.[0] as {
        body: { status: { pluginWorkloadSdk?: { message?: string; bootstrapPodUid?: string } } }
      }
      expect(patchCall.body.status.pluginWorkloadSdk?.message).toBe('REUSED-PROJECTION-MARKER')
      expect(patchCall.body.status.pluginWorkloadSdk?.bootstrapPodUid).toBe('marker-pod')
    })
  })
})
