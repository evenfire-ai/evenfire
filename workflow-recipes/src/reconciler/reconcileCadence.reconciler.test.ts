/**
 * Issue #1016 — the DNS-block record a full reconcile writes. Uses the same
 * apiserver doubles as reconciler.test.ts, reduced to what these passes touch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import type { WorkflowRecipeCRD } from '../types'
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
