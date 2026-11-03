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

  it('relays a control-api 403 body as a result value', async () => {
    clientMock.controlApiRequest.mockRejectedValueOnce(
      new ControlApiError(
        'Control API POST /external/rpc/token failed (403): desktop_requires_team',
        403,
        { error: 'desktop_requires_team' }
      )
    )

    await expect(issueRpcAccessToken('session', ['desktop:view'], ['pro-agent'])).resolves.toEqual({
      error: 'desktop_requires_team',
    })
  })

  it('maps malformed 403 bodies to the generic forbidden reason', async () => {
    for (const body of [{ error: ['desktop_requires_team'] }, { error: 42 }]) {
      clientMock.controlApiRequest.mockRejectedValueOnce(
        new ControlApiError(
          `Control API POST /external/rpc/token failed (403): ${String(body.error)}`,
          403,
          body
        )
      )

      await expect(
        issueRpcAccessToken('session', ['desktop:view'], ['pro-agent'])
      ).resolves.toEqual({ error: 'forbidden' })
    }
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

    await expect(
      issueRpcAccessToken('session', ['host:message:invoke'], ['pro-agent'])
    ).rejects.toThrow()
  })
})
