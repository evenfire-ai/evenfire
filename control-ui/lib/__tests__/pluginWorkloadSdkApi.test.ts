import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deletePluginWorkloadSdkGrant,
  getPluginWorkloadSdkLegacyInventory,
  getPluginWorkloadSdkQuota,
  listLlmHostSecrets,
  listPluginWorkloadSdkGrants,
  searchPluginWorkloadSdkInvocations,
  upsertPluginWorkloadSdkGrant,
} from '../api'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Plugin Workload SDK admin api — URL shape', () => {
  it('loads credential slot names from host Secrets, never recipe-scoped Secrets', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { items: [{ name: 'chatllm-api-keys', keys: [] }] }))
    await listLlmHostSecrets()
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/secrets')
    expect(url).not.toContain('/recipe-secrets')
  })

  it('listPluginWorkloadSdkGrants hits the grants endpoint with cookie credentials', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { items: [] }))
    await listPluginWorkloadSdkGrants()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/plugin-workload-sdk/grants')
    expect(init.credentials).toBe('include')
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined()
  })

  it('listPluginWorkloadSdkGrants forwards recipe filters as query params', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { items: [] }))
    await listPluginWorkloadSdkGrants({ recipeNamespace: 'sandbox-recipes', recipeName: 'r1' })
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('recipeNamespace=sandbox-recipes')
    expect(url).toContain('recipeName=r1')
  })

  it('loads the read-only legacy grant inventory for explicit operator review', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { legacyPromptBridgeGrants: 1, items: [] }))
    await getPluginWorkloadSdkLegacyInventory()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/plugin-workload-sdk/legacy-inventory')
    expect(init.credentials).toBe('include')
  })

  it('upsertPluginWorkloadSdkGrant POSTs the grant payload as JSON', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { grant: { id: 'g1' } }))
    await upsertPluginWorkloadSdkGrant({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'r1',
      capabilityFamily: 'promptBridge',
      provider: 'zai',
      allowedModels: ['glm-4.7'],
      promptTargets: [
        {
          targetRef: 'primary-zai',
          provider: 'zai',
          model: 'glm-4.7',
          credentialSlot: 'zai-api-key',
        },
      ],
      defaultTargetRef: 'primary-zai',
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/plugin-workload-sdk/grants')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toMatchObject({
      recipeName: 'r1',
      capabilityFamily: 'promptBridge',
      provider: 'zai',
      allowedModels: ['glm-4.7'],
      promptTargets: [
        expect.objectContaining({ targetRef: 'primary-zai', credentialSlot: 'zai-api-key' }),
      ],
    })
  })

  it('deletePluginWorkloadSdkGrant encodes the id and uses DELETE', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { deleted: true }))
    await deletePluginWorkloadSdkGrant('grant/with/slash', 'sandbox-recipes', 'r1')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('DELETE')
    expect(url).toContain('/api/v1/admin/plugin-workload-sdk/grants/grant%2Fwith%2Fslash')
    expect(url).toContain('recipeNamespace=sandbox-recipes')
    expect(url).toContain('recipeName=r1')
  })

  it('getPluginWorkloadSdkQuota encodes namespace and name path segments', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { items: [] }))
    await getPluginWorkloadSdkQuota('sandbox-recipes', 'r 1')
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/plugin-workload-sdk/quota/sandbox-recipes/r%201')
  })

  it('searchPluginWorkloadSdkInvocations forwards method/status/limit filters', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { items: [] }))
    await searchPluginWorkloadSdkInvocations({
      recipeName: 'r1',
      method: 'promptBridge',
      status: 'complete',
      limit: '100',
    })
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('recipeName=r1')
    expect(url).toContain('method=promptBridge')
    expect(url).toContain('status=complete')
    expect(url).toContain('limit=100')
  })

  it('searchPluginWorkloadSdkInvocations omits empty filters', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { items: [] }))
    await searchPluginWorkloadSdkInvocations({})
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).not.toContain('method=')
    expect(url).not.toContain('status=')
  })
})
