import { describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import type { WorkflowRecipeGfsIntentSpec } from '../types.js'
import { createDbRunChildRecipe } from './dbRunChildRecipeCreator.js'
import { makeExistingChild, makeParent, makeRun } from './dbRunChildRecipeCreator.testFixtures.js'

describe('createDbRunChildRecipe', () => {
  it('creates a stable child name derived from the run id', async () => {
    const customApi = {
      getNamespacedCustomObject: vi.fn().mockResolvedValueOnce(makeParent()),
      createNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'demo-parent-00000000' },
      }),
    } as unknown as k8s.CustomObjectsApi

    const child = await createDbRunChildRecipe(customApi, makeRun())

    expect(child).toEqual({
      name: 'demo-parent-00000000',
      namespace: 'sandbox-recipes',
    })
    expect(
      (customApi.createNamespacedCustomObject as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]?.body?.metadata?.labels?.['clerum.io/workflow-run-id']
    ).toBe('00000000-0000-0000-0000-000000000123')
    expect(
      (customApi.createNamespacedCustomObject as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]?.body?.spec?.coordinatorImage
    ).toBe('clerum/workflow-custom-sdk-e2e:test')
    expect(
      (customApi.createNamespacedCustomObject as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]?.body?.spec?.inputContract?.properties?.greeting?.default
    ).toBe('hello')
    expect(
      (customApi.createNamespacedCustomObject as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]?.body?.spec?.runtimeEgress?.http?.allowedHosts
    ).toEqual(['swapi.info'])
    expect(
      (customApi.createNamespacedCustomObject as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]?.body?.spec?.computed
    ).toEqual([{ name: 'db_mode', expression: "'readonly'" }])
    expect(
      (customApi.createNamespacedCustomObject as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]?.body?.spec?.resources?.[0]?.id
    ).toBe('api-key')
    expect(
      (customApi.createNamespacedCustomObject as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]?.body?.metadata?.labels?.['clerum.io/workflow-actor-id']
    ).toBeUndefined()
  })

  it('labels child recipes with the workflow usage team id when the run has one', async () => {
    const customApi = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeParent()),
      createNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'demo-parent-00000000' },
      }),
    } as unknown as k8s.CustomObjectsApi

    await createDbRunChildRecipe(
      customApi,
      makeRun({
        team_id: '11111111-1111-4111-8111-111111111111',
        usage_team_id: '11111111-1111-4111-8111-111111111111',
      })
    )

    expect(
      (customApi.createNamespacedCustomObject as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]?.body?.metadata?.labels?.['clerum.io/workflow-team-id']
    ).toBe('11111111-1111-4111-8111-111111111111')
  })

  it('prefers the usage team id when it differs from the authorization team id', async () => {
    const customApi = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeParent()),
      createNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'demo-parent-00000000' },
      }),
    } as unknown as k8s.CustomObjectsApi

    await createDbRunChildRecipe(
      customApi,
      makeRun({
        team_id: null,
        usage_team_id: 'control-plane-admin-ui',
      })
    )

    expect(
      (customApi.createNamespacedCustomObject as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]?.body?.metadata?.labels?.['clerum.io/workflow-team-id']
    ).toBe('control-plane-admin-ui')
  })

  it('labels user-triggered child recipes with the workflow actor id', async () => {
    const customApi = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeParent()),
      createNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'demo-parent-00000000' },
      }),
    } as unknown as k8s.CustomObjectsApi

    await createDbRunChildRecipe(
      customApi,
      makeRun({ actor_type: 'user', actor_id: '22222222-2222-4222-8222-222222222222' })
    )

    expect(
      (customApi.createNamespacedCustomObject as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]?.body?.metadata?.labels?.['clerum.io/workflow-actor-id']
    ).toBe('22222222-2222-4222-8222-222222222222')
    expect(
      (customApi.createNamespacedCustomObject as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]?.body?.metadata?.labels?.['clerum.io/workflow-actor-type']
    ).toBe('user')
  })

  it('does not invent a workflow actor id for scheduled runs', async () => {
    const customApi = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeParent()),
      createNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'demo-parent-00000000' },
      }),
    } as unknown as k8s.CustomObjectsApi

    await createDbRunChildRecipe(
      customApi,
      makeRun({ actor_type: 'scheduled', actor_id: '22222222-2222-4222-8222-222222222222' })
    )

    expect(
      (customApi.createNamespacedCustomObject as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]?.body?.metadata?.labels?.['clerum.io/workflow-actor-id']
    ).toBeUndefined()
  })

  it('labels admin-ui runs as admin usage actors, not end-user actors', async () => {
    const customApi = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeParent()),
      createNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'demo-parent-00000000' },
      }),
    } as unknown as k8s.CustomObjectsApi

    await createDbRunChildRecipe(
      customApi,
      makeRun({
        actor_type: 'admin',
        actor_id: '99999999-9999-4999-8999-999999999999',
        team_id: null,
        usage_team_id: 'control-plane-admin-ui',
      })
    )

    const labels = (customApi.createNamespacedCustomObject as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0]?.body?.metadata?.labels
    expect(labels?.['clerum.io/workflow-actor-id']).toBe('99999999-9999-4999-8999-999999999999')
    expect(labels?.['clerum.io/workflow-actor-type']).toBe('admin')
    expect(labels?.['clerum.io/workflow-team-id']).toBe('control-plane-admin-ui')
  })

  it('reuses the existing child on 409 when the run-id label matches', async () => {
    const customApi = {
      getNamespacedCustomObject: vi
        .fn()
        .mockResolvedValueOnce(makeParent())
        .mockResolvedValueOnce(makeExistingChild()),
      createNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 409 }),
    } as unknown as k8s.CustomObjectsApi

    const child = await createDbRunChildRecipe(customApi, makeRun())

    expect(child).toEqual({
      name: 'demo-parent-00000000',
      namespace: 'sandbox-recipes',
    })
    expect(
      (customApi.getNamespacedCustomObject as unknown as ReturnType<typeof vi.fn>).mock.calls
    ).toHaveLength(2)
  })

  it('keeps parent computed values when on-demand inputs override parent inputs', async () => {
    const customApi = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeParent()),
      createNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'demo-parent-00000000' },
      }),
    } as unknown as k8s.CustomObjectsApi

    await createDbRunChildRecipe(customApi, makeRun({ inputs: { greeting: 'hola' } }))

    const childSpec = (
      customApi.createNamespacedCustomObject as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0]?.body?.spec
    expect(childSpec?.inputs).toEqual({ greeting: 'hola' })
    expect(childSpec?.computed).toEqual([{ name: 'db_mode', expression: "'readonly'" }])
  })

  it('retains the exact parent GFS intent on a DB-run child recipe', async () => {
    const gfs: WorkflowRecipeGfsIntentSpec = {
      publishTargets: [{ drive: 'main', target: 'published-results' }],
      mounts: [
        {
          drive: 'main',
          target: 'shared-inputs',
          scopes: ['gfs.read', 'gfs.write'],
        },
      ],
    }
    const customApi = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue(makeParent(gfs)),
      createNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { name: 'demo-parent-00000000' },
      }),
    } as unknown as k8s.CustomObjectsApi

    await createDbRunChildRecipe(customApi, makeRun())

    expect(
      (customApi.createNamespacedCustomObject as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]?.body?.spec?.gfs
    ).toEqual(gfs)
  })

  const expectedGfs: WorkflowRecipeGfsIntentSpec = {
    mounts: [{ drive: 'main', target: 'shared-inputs', scopes: ['gfs.read'] }],
  }
  const collisionCases: Array<[string, (child: ReturnType<typeof makeExistingChild>) => void]> = [
    [
      'a different run id',
      child => void (child.metadata.labels['clerum.io/workflow-run-id'] = 'other-run'),
    ],
    ['the wrong owner', child => void (child.metadata.ownerReferences[0]!.name = 'other-parent')],
    ['a stale parent UID', child => void (child.metadata.ownerReferences[0]!.uid = 'stale-uid')],
    ['no controller owner', child => void (child.metadata.ownerReferences = [])],
    [
      'the wrong parent label',
      child => void (child.metadata.labels['clerum.io/parent-recipe'] = 'other-parent'),
    ],
    [
      'the wrong inherited-resource annotation',
      child => void (child.metadata.annotations['clerum.io/inherited-parent-resources'] = 'false'),
    ],
    ['mismatched GFS intent', child => void (child.spec.gfs = { mounts: [] })],
    ['changed steps', child => void (child.spec.steps = [{ id: 'different-step' }])],
    ['changed coordinator image', child => void (child.spec.coordinatorImage = 'attacker/image')],
    ['changed resources', child => void (child.spec.resources[0]!.id = 'other-resource')],
    ['the wrong child kind', child => void (child.kind = 'ConfigMap')],
  ]

  it.each(collisionCases)('rejects a 409 collision with %s', async (_description, mutate) => {
    const existing = makeExistingChild(expectedGfs)
    mutate(existing)
    const customApi = {
      getNamespacedCustomObject: vi
        .fn()
        .mockResolvedValueOnce(makeParent(expectedGfs))
        .mockResolvedValueOnce(existing),
      createNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 409 }),
    } as unknown as k8s.CustomObjectsApi

    await expect(createDbRunChildRecipe(customApi, makeRun())).rejects.toThrow(
      /does not match the expected workflow run child identity/i
    )
  })
})
