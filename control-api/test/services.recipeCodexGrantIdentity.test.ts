import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSafeCodexSubscriptionConnection } from '../src/services/codexSubscriptionConnection.js'
import {
  publishRecipeGrantIdentity,
  readRecipeGrantIdentity,
} from '../src/services/recipeCodexGrantIdentity.js'
import { K8sConflictError } from '../src/services/resourceService.js'

vi.mock('../src/services/codexSubscriptionConnection.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/services/codexSubscriptionConnection.js')
  >('../src/services/codexSubscriptionConnection.js')
  return {
    ...actual,
    getSafeCodexSubscriptionConnection: vi.fn(),
  }
})

const liveGrant = {
  id: '11111111-1111-1111-1111-111111111111',
  connectionKey: 'team-plus',
  displayName: 'Team Plus',
  status: 'connected',
}

describe('recipe Codex grant identity', () => {
  const getResource = vi.fn()
  const updateResource = vi.fn()

  beforeEach(() => {
    getResource.mockReset()
    updateResource.mockReset()
    vi.mocked(getSafeCodexSubscriptionConnection).mockReset()
    vi.mocked(getSafeCodexSubscriptionConnection).mockResolvedValue(liveGrant as never)
  })

  it('reads empty and blank annotations as unassigned', () => {
    expect(readRecipeGrantIdentity(undefined)).toBe('unassigned')
    expect(readRecipeGrantIdentity({})).toBe('unassigned')
    expect(readRecipeGrantIdentity({ 'clerum.io/codex-connection-ref': '' })).toBe('unassigned')
    expect(readRecipeGrantIdentity({ 'clerum.io/codex-connection-ref': 'team-plus' })).toBe(
      'team-plus'
    )
  })

  it('rejects a named publish when the grant is not live', async () => {
    vi.mocked(getSafeCodexSubscriptionConnection).mockResolvedValueOnce(null)
    await expect(
      publishRecipeGrantIdentity({
        gateway: { getResource, updateResource },
        namespace: 'sandbox-recipes',
        name: 'codex-recipe',
        next: 'team-plus',
      })
    ).rejects.toMatchObject({
      status: 422,
      error: 'codex_connection_not_allowed',
    })
    expect(getResource).not.toHaveBeenCalled()
    expect(updateResource).not.toHaveBeenCalled()
  })

  it('no-ops when the live annotation already matches', async () => {
    getResource.mockResolvedValue({
      metadata: {
        resourceVersion: '12',
        annotations: { 'clerum.io/codex-connection-ref': 'team-plus' },
      },
      spec: { agent: { provider: 'codex-subscription' } },
    })
    await expect(
      publishRecipeGrantIdentity({
        gateway: { getResource, updateResource },
        namespace: 'sandbox-recipes',
        name: 'codex-recipe',
        next: 'team-plus',
      })
    ).resolves.toEqual({ published: 'team-plus', resourceVersion: '12', noop: true })
    expect(updateResource).not.toHaveBeenCalled()
  })

  it('writes empty string for unassigned and requires resourceVersion', async () => {
    getResource.mockResolvedValue({
      metadata: {
        resourceVersion: '9',
        annotations: { 'clerum.io/codex-connection-ref': 'team-plus' },
        labels: { app: 'recipe' },
      },
      spec: { pluginWorkloadSdk: { family: 'promptBridge' } },
    })
    await expect(
      publishRecipeGrantIdentity({
        gateway: { getResource, updateResource },
        namespace: 'sandbox-recipes',
        name: 'sdk-recipe',
        next: 'unassigned',
      })
    ).resolves.toEqual({ published: 'unassigned', resourceVersion: '9', noop: false })
    expect(getSafeCodexSubscriptionConnection).not.toHaveBeenCalled()
    expect(updateResource).toHaveBeenCalledWith(
      'workflowrecipes',
      'sdk-recipe',
      {
        metadata: {
          labels: { app: 'recipe' },
          annotations: { 'clerum.io/codex-connection-ref': '' },
          resourceVersion: '9',
        },
        spec: { pluginWorkloadSdk: { family: 'promptBridge' } },
      },
      'sandbox-recipes'
    )
  })

  it('surfaces a 409 when the recipe changed under the CAS write', async () => {
    getResource.mockResolvedValue({
      metadata: {
        resourceVersion: '3',
        annotations: {},
      },
      spec: {},
    })
    updateResource.mockRejectedValueOnce(new K8sConflictError('resource changed'))
    await expect(
      publishRecipeGrantIdentity({
        gateway: { getResource, updateResource },
        namespace: 'sandbox-recipes',
        name: 'codex-recipe',
        next: 'team-plus',
      })
    ).rejects.toMatchObject({ status: 409, error: 'conflict' })
  })
})
