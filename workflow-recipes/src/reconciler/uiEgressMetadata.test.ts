import { afterEach, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { loadConfig } from '../config'
import type { WorkflowRecipeCRD } from '../types'
import { captureLogger } from './__tests__/captureLogger'
import { buildUiEgressNetworkPolicy } from './resourceBuilder'
import { WorkflowRecipeReconciler } from './workflowRecipeReconciler'

afterEach(() => vi.restoreAllMocks())

function uiPolicyFixture() {
  const config = loadConfig()
  const recipe: WorkflowRecipeCRD = {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: 'ui-metadata', namespace: config.sandboxNamespace, uid: 'recipe-uid' },
    spec: {
      workloads: [{ id: 'backend', type: 'deployment', image: 'nginx:1.30.1-alpine', port: 8080 }],
      ui: {
        workloadRef: 'backend',
        port: 8080,
        egress: { internal: [{ workloadRef: 'backend', port: 8080 }] },
      },
    },
  }
  let live = buildUiEgressNetworkPolicy(
    recipe,
    config.sandboxUiNamespace,
    config.sandboxNamespace,
    []
  )!
  live.metadata = {
    ...live.metadata,
    uid: 'policy-uid',
    resourceVersion: '7',
    labels: { ...live.metadata!.labels, 'external.example/owner': 'retain' },
    annotations: { 'external.example/note': 'retain' },
    finalizers: ['external.example/hold'],
  }
  const read = vi.fn(async () => structuredClone(live))
  const create = vi.fn(async (): Promise<unknown> => {
    throw { code: 409 }
  })
  const replace = vi.fn(async ({ body }: { body: k8s.V1NetworkPolicy }) => {
    expect(body.metadata?.resourceVersion).toBe(live.metadata?.resourceVersion)
    live = structuredClone(body)
    return structuredClone(live)
  })
  const networking = {
    readNamespacedNetworkPolicy: read,
    createNamespacedNetworkPolicy: create,
    replaceNamespacedNetworkPolicy: replace,
    deleteNamespacedNetworkPolicy: vi.fn(),
  }
  const kc = new k8s.KubeConfig()
  vi.spyOn(kc, 'makeApiClient').mockImplementation((() => networking) as typeof kc.makeApiClient)
  const reconciler = new WorkflowRecipeReconciler(kc, config, {
    fqdnLookup: async () => {
      throw new Error('Internal-only UI must not resolve DNS')
    },
  })
  const reconcile = () =>
    (
      reconciler as unknown as {
        reconcileUiEgressPolicy(recipe: WorkflowRecipeCRD): Promise<void>
      }
    ).reconcileUiEgressPolicy(recipe)
  return { recipe, read, create, replace, reconcile, live: () => live }
}

describe('UI egress dedicated writer metadata and lifecycle', () => {
  it('keeps an equivalent UI policy read-only with a positive no-op witness', async () => {
    const fixture = uiPolicyFixture()
    const logs = captureLogger('info')

    await fixture.reconcile()

    expect(fixture.read).toHaveBeenCalledTimes(1)
    expect(logs).toHaveBeenCalledWith('NetworkPolicy egress set unchanged; no-op', {
      policyName: fixture.live().metadata!.name,
      ns: fixture.live().metadata!.namespace,
    })
    expect(fixture.create).not.toHaveBeenCalled()
    expect(fixture.replace).not.toHaveBeenCalled()
  })

  it('creates a missing UI policy through the dedicated writer', async () => {
    const fixture = uiPolicyFixture()
    fixture.read.mockRejectedValueOnce({ code: 404 })
    fixture.create.mockResolvedValueOnce({})

    await fixture.reconcile()

    expect(fixture.read).toHaveBeenCalledTimes(1)
    expect(fixture.create).toHaveBeenCalledWith({
      namespace: fixture.live().metadata!.namespace,
      body: expect.objectContaining({ spec: fixture.live().spec }),
    })
    expect(fixture.replace).not.toHaveBeenCalled()
  })

  it.each(['clerum.io/recipe-namespace', 'clerum.io/recipe-name'])(
    'preserves external metadata while repairing missing %s',
    async label => {
      const fixture = uiPolicyFixture()
      delete fixture.live().metadata!.labels![label]

      await fixture.reconcile()

      expect(fixture.read).toHaveBeenCalledTimes(2)
      expect(fixture.create).toHaveBeenCalledTimes(1)
      expect(fixture.replace).toHaveBeenCalledTimes(1)
      expect(fixture.live().metadata).toMatchObject({
        labels: {
          'external.example/owner': 'retain',
          [label]: label.endsWith('namespace')
            ? fixture.recipe.metadata.namespace
            : fixture.recipe.metadata.name,
        },
        annotations: { 'external.example/note': 'retain' },
        finalizers: ['external.example/hold'],
      })
    }
  )

  it('preserves external metadata when current intent adds a UI destination port', async () => {
    const fixture = uiPolicyFixture()
    fixture.recipe.spec.ui!.egress!.internal!.push({ workloadRef: 'backend', port: 9090 })

    await fixture.reconcile()

    expect(fixture.replace).toHaveBeenCalledTimes(1)
    expect(
      fixture.live().spec!.egress!.flatMap(rule => rule.ports!.map(port => port.port))
    ).toEqual([8080, 9090])
    expect(fixture.live().metadata).toMatchObject({
      labels: { 'external.example/owner': 'retain' },
      annotations: { 'external.example/note': 'retain' },
      finalizers: ['external.example/hold'],
    })
  })

  it.each(['terminating', 'controller-owner', 'non-controller-owner'])(
    'rejects %s appearing between contraction and final replacement',
    async lifecycle => {
      const fixture = uiPolicyFixture()
      delete fixture.live().metadata!.labels!['clerum.io/recipe-namespace']
      fixture.read
        .mockImplementationOnce(async () => structuredClone(fixture.live()))
        .mockImplementationOnce(async () => {
          const raced = structuredClone(fixture.live())
          if (lifecycle === 'terminating') raced.metadata!.deletionTimestamp = new Date()
          else
            raced.metadata!.ownerReferences = [
              {
                apiVersion: 'v1',
                kind: 'ConfigMap',
                name: 'foreign',
                uid: 'foreign-uid',
                controller: lifecycle === 'controller-owner',
              },
            ]
          return raced
        })

      await expect(fixture.reconcile()).rejects.toThrow(
        lifecycle === 'terminating' ? 'terminating' : 'owner-reference-mismatch'
      )
      expect(fixture.read).toHaveBeenCalledTimes(2)
      expect(fixture.create).toHaveBeenCalledTimes(1)
      expect(fixture.replace).not.toHaveBeenCalled()
    }
  )
})
