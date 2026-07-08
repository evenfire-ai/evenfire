import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ControlApiError } from '../src/controlApiClient.js'
import { issueRpcAccessToken } from '../src/services/rpcService.js'

const clientMock = vi.hoisted(() => ({ controlApiRequest: vi.fn() }))
vi.mock('../src/controlApiClient.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/controlApiClient.js')>()
  return { ...actual, controlApiRequest: clientMock.controlApiRequest }
})

describe('rpcService.issueRpcAccessToken', () => {
  beforeEach(() => {
    clientMock.controlApiRequest.mockReset()
  })

  it('surfaces the control-api denial reason on a 403 instead of collapsing to null', async () => {
    clientMock.controlApiRequest.mockRejectedValueOnce(
      new ControlApiError(
        'Control API POST /external/rpc/token failed (403): desktop_requires_team',
        403,
        { error: 'desktop_requires_team' }
      )
    )

    const result = await issueRpcAccessToken('session', ['desktop:view'], ['pro-agent'])

    expect(result).toEqual({ error: 'desktop_requires_team' })
  })

  it('returns the issued token unchanged on success', async () => {
    const token = {
      token: 't',
      accessScope: 'user' as const,
      teamId: null,
      scopes: ['host:message:invoke'],
      hostRefs: ['pro-agent'],
      expiresInSeconds: 300,
    }
    clientMock.controlApiRequest.mockResolvedValueOnce(token)

    const result = await issueRpcAccessToken('session', ['host:message:invoke'], ['pro-agent'])

    expect(result).toEqual(token)
  })

  it('rethrows non-403 control-api errors rather than masking them', async () => {
    clientMock.controlApiRequest.mockRejectedValueOnce(
      new ControlApiError('Control API POST /external/rpc/token failed (500): boom', 500, {
        error: 'boom',
      })
    )

    await expect(issueRpcAccessToken('session', ['host:message:invoke'], ['pro-agent'])).rejects.toThrow()
  })
})
