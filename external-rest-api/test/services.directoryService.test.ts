import { beforeEach, describe, expect, it, vi } from 'vitest'
import { searchDirectory } from '../src/services/directoryService.js'

const clientMock = vi.hoisted(() => ({ controlApiRequest: vi.fn() }))
vi.mock('../src/controlApiClient.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/controlApiClient.js')>()
  return { ...actual, controlApiRequest: clientMock.controlApiRequest }
})

// control-api's directory item: dev's raw row without `channels`, which stays private.
const DIRECTORY_ITEM_FIELDS = ['display_name', 'email', 'id', 'name']

describe('edge directory search', () => {
  beforeEach(() => {
    clientMock.controlApiRequest.mockReset()
  })

  it("relays control-api's four-field items unchanged and skips the call for a blank query", async () => {
    const payload = {
      items: [
        { id: 'u1', email: 'alice@example.com', name: null, display_name: 'Alice' },
        { id: 'u2', email: 'alina@example.com', name: 'Alina', display_name: null },
      ],
    }
    clientMock.controlApiRequest.mockResolvedValueOnce(structuredClone(payload))

    const result = await searchDirectory('team-1', ' alice ', 'synthetic-session-token')

    expect(result).toEqual(payload)
    for (const item of result.items as Record<string, unknown>[]) {
      expect(Object.keys(item).sort()).toEqual(DIRECTORY_ITEM_FIELDS)
      expect(item).not.toHaveProperty('channels')
      expect(item).not.toHaveProperty('sort_key')
      expect(item).not.toHaveProperty('displayName')
    }
    // Witness: the relayed body came from the one control-api read, with the trimmed query.
    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(1)
    expect(clientMock.controlApiRequest).toHaveBeenCalledWith('GET', '/external/directory/search', {
      query: { teamId: 'team-1', q: 'alice' },
      userSessionToken: 'synthetic-session-token',
    })

    await expect(searchDirectory('team-1', '   ', 'synthetic-session-token')).resolves.toEqual({
      items: [],
    })
    // The blank query answers locally: still the single call recorded above.
    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(1)
  })
})
