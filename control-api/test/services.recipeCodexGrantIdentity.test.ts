import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSafeCodexSubscriptionConnection } from '../src/services/codexSubscriptionConnection.js'
import { getSafeGrokSubscriptionConnection } from '../src/services/grokSubscriptionConnection.js'
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

vi.mock('../src/services/grokSubscriptionConnection.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/services/grokSubscriptionConnection.js')
  >('../src/services/grokSubscriptionConnection.js')
  return {
    ...actual,
    getSafeGrokSubscriptionConnection: vi.fn(),
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
    vi.mocked(getSafeGrokSubscriptionConnection).mockReset()
    vi.mocked(getSafeGrokSubscriptionConnection).mockResolvedValue({
      ...liveGrant,
      connectionKey: 'team-grok',
    } as never)
  })

  it('reads empty and blank annotations as unassigned', () => {
    expect(readRecipeGrantIdentity(undefined)).toBe('unassigned')
    expect(readRecipeGrantIdentity({})).toBe('unassigned')
    expect(readRecipeGrantIdentity({ 'clerum.io/codex-connection-ref': '' })).toBe('unassigned')
    expect(readRecipeGrantIdentity({ 'clerum.io/codex-connection-ref': 'team-plus' })).toBe(
      'team-plus'
    )
    expect(
      readRecipeGrantIdentity({ 'clerum.io/subscription-connection-ref': 'personal-pro' })
    ).toBe('personal-pro')
  })

  it('rejects disagreeing subscription annotations', () => {
    expect(() =>
      readRecipeGrantIdentity({
        'clerum.io/codex-connection-ref': 'team-plus',
        'clerum.io/subscription-connection-ref': 'other-key',
      })
    ).toThrow(/disagree/)
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
          annotations: {
            'clerum.io/codex-connection-ref': '',
            'clerum.io/subscription-connection-ref': '',
          },
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

  it('publishes a Grok grant on the canonical annotation and clears the Codex alias', async () => {
    getResource.mockResolvedValue({
      metadata: {
        resourceVersion: '4',
        annotations: { 'clerum.io/codex-connection-ref': 'leftover' },
      },
      spec: { agent: { provider: 'grok-subscription' } },
    })
    await expect(
      publishRecipeGrantIdentity({
        gateway: { getResource, updateResource },
        namespace: 'sandbox-recipes',
        name: 'grok-recipe',
        next: 'team-grok',
        provider: 'grok-subscription',
      })
    ).resolves.toMatchObject({ published: 'team-grok', noop: false })
    expect(getSafeGrokSubscriptionConnection).toHaveBeenCalledWith(expect.anything(), 'team-grok')
    expect(getSafeCodexSubscriptionConnection).not.toHaveBeenCalled()
    expect(updateResource).toHaveBeenCalledWith(
      'workflowrecipes',
      'grok-recipe',
      expect.objectContaining({
        metadata: expect.objectContaining({
          annotations: {
            'clerum.io/codex-connection-ref': '',
            'clerum.io/subscription-connection-ref': 'team-grok',
          },
        }),
      }),
      'sandbox-recipes'
    )
  })

  it.each([
    ['agent', { agent: { provider: 'codex-subscription' } }],
    [
      'step agent',
      {
        agent: { provider: 'openai' },
        steps: [{ id: 's', agent: { provider: 'codex-subscription' } }],
      },
    ],
  ])(
    'refuses (409) to publish a Grok identity on a recipe whose %s is Codex',
    async (_label, spec) => {
      getResource.mockResolvedValue({
        metadata: {
          resourceVersion: '5',
          annotations: {
            'clerum.io/codex-connection-ref': 'team-plus',
            'clerum.io/subscription-connection-ref': 'team-plus',
          },
        },
        spec,
      })
      await expect(
        publishRecipeGrantIdentity({
          gateway: { getResource, updateResource },
          namespace: 'sandbox-recipes',
          name: 'codex-recipe',
          next: 'team-grok',
          provider: 'grok-subscription',
        })
      ).rejects.toMatchObject({ status: 409, error: 'oauth_broker_provider_conflict' })
      expect(updateResource).not.toHaveBeenCalled()
    }
  )

  it('refuses (409) to publish a Codex identity on a Grok-agent recipe', async () => {
    getResource.mockResolvedValue({
      metadata: {
        resourceVersion: '6',
        annotations: {
          'clerum.io/codex-connection-ref': '',
          'clerum.io/subscription-connection-ref': 'team-grok',
        },
      },
      spec: { agent: { provider: 'grok-subscription' } },
    })
    await expect(
      publishRecipeGrantIdentity({
        gateway: { getResource, updateResource },
        namespace: 'sandbox-recipes',
        name: 'grok-recipe',
        next: 'team-plus',
      })
    ).rejects.toMatchObject({ status: 409, error: 'oauth_broker_provider_conflict' })
    expect(updateResource).not.toHaveBeenCalled()
  })

  it('publishes a Grok identity on an SDK-only recipe with a static agent', async () => {
    getResource.mockResolvedValue({
      metadata: { resourceVersion: '7', annotations: {} },
      spec: { agent: { provider: 'openai' }, pluginWorkloadSdk: { family: 'promptBridge' } },
    })
    await expect(
      publishRecipeGrantIdentity({
        gateway: { getResource, updateResource },
        namespace: 'sandbox-recipes',
        name: 'sdk-recipe',
        next: 'team-grok',
        provider: 'grok-subscription',
      })
    ).resolves.toMatchObject({ published: 'team-grok', noop: false })
    expect(updateResource).toHaveBeenCalledTimes(1)
  })

  it('rejects a named Grok publish when the Grok grant is not live', async () => {
    vi.mocked(getSafeGrokSubscriptionConnection).mockResolvedValueOnce(null)
    await expect(
      publishRecipeGrantIdentity({
        gateway: { getResource, updateResource },
        namespace: 'sandbox-recipes',
        name: 'grok-recipe',
        next: 'team-grok',
        provider: 'grok-subscription',
      })
    ).rejects.toMatchObject({
      status: 422,
      error: 'grok_connection_not_allowed',
    })
    expect(getResource).not.toHaveBeenCalled()
  })
})
