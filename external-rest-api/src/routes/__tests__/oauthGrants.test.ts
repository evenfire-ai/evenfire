import { describe, expect, it, vi } from 'vitest'
import * as client from '../../controlApiClient.js'

describe('oauth grants proxy', () => {
  it('GET forwards to control-api with the user session token', async () => {
    const spy = vi.spyOn(client, 'controlApiRequest').mockResolvedValue({ grants: [] } as never)
    const { listOauthGrants } = await import('../../services/oauthGrantsService.js')
    await listOauthGrants('SESSION_JWT')
    expect(spy).toHaveBeenCalledWith('GET', '/external/oauth/grants', {
      userSessionToken: 'SESSION_JWT',
    })
    spy.mockRestore()
  })

  it('DELETE forwards to control-api with URL-encoded params and the user session token', async () => {
    const spy = vi.spyOn(client, 'controlApiRequestWithStatus').mockResolvedValue(null as never)
    const { revokeOauthGrant } = await import('../../services/oauthGrantsService.js')
    await revokeOauthGrant('SESSION_JWT', 'my namespace', 'my recipe', 'client/id')
    expect(spy).toHaveBeenCalledWith(
      'DELETE',
      `/external/oauth/grants/${encodeURIComponent('my namespace')}/${encodeURIComponent('my recipe')}/${encodeURIComponent('client/id')}`,
      { userSessionToken: 'SESSION_JWT' }
    )
    spy.mockRestore()
  })
})
