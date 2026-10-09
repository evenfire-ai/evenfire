import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
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

    await expect(
      issueRpcAccessToken('session', ['host:message:invoke'], ['pro-agent'])
    ).rejects.toThrow()
  })
  it('E1: relays the exact mint revocation fields and makes the correct Control API request', async () => {
    const sessionToken = randomUUID()
    const scopes = ['host:message:invoke']
    const hostRefs = ['host-a', 'host-b']
    clientMock.controlApiRequest.mockRejectedValueOnce(
      new ControlApiError('Host access denied', 403, {
        error: 'host_access_denied',
        code: 'host_access_revoked',
        revokedHostRefs: hostRefs,
        extraControlApiField: true,
      })
    )

    const result = await issueRpcAccessToken(sessionToken, scopes, hostRefs)
    expect(result).toEqual({
      error: 'host_access_denied',
      code: 'host_access_revoked',
      revokedHostRefs: hostRefs,
    })
    expect(clientMock.controlApiRequest.mock.calls.length).toBe(1)
    const [method, path, options] = clientMock.controlApiRequest.mock.calls[0]
    expect(method).toBe('POST')
    expect(path).toBe('/external/rpc/token')
    expect(Object.keys(options)).toEqual(['body'])
    const { sessionToken: forwardedSession, ...requestBody } = options.body
    expect(forwardedSession === sessionToken).toBe(true)
    expect(requestBody).toEqual({ scopes, hostRefs })
  })

  it('E1: accepts the canonical mint list for padded and duplicate requested refs', async () => {
    const hostRefs = [' host-b ', 'host-a', 'host-b']
    const revokedHostRefs = ['host-a', 'host-b']
    clientMock.controlApiRequest.mockRejectedValueOnce(
      new ControlApiError('Host access denied', 403, {
        error: 'host_access_denied',
        code: 'host_access_revoked',
        revokedHostRefs,
      })
    )

    expect(await issueRpcAccessToken('session', ['host:message:invoke'], hostRefs)).toEqual({
      error: 'host_access_denied',
      code: 'host_access_revoked',
      revokedHostRefs,
    })
  })

  it.each([
    { name: 'missing list', fields: {} },
    { name: 'empty list', fields: { revokedHostRefs: [] } },
    { name: 'non-string element', fields: { revokedHostRefs: ['host-a', 42] } },
    { name: 'empty-string element', fields: { revokedHostRefs: ['host-a', ''] } },
    { name: 'padded element', fields: { revokedHostRefs: [' host-a '] } },
    { name: 'wildcard element', fields: { revokedHostRefs: ['host-a', '*'] } },
    { name: 'duplicate element', fields: { revokedHostRefs: ['host-a', 'host-a'] } },
    { name: 'unrequested element', fields: { revokedHostRefs: ['host-a', 'host-b'] } },
  ])('E2: drops revocation extras for $name', async ({ fields }) => {
    const sessionToken = randomUUID()
    const validBody = {
      error: 'host_access_denied',
      code: 'host_access_revoked',
      revokedHostRefs: ['host-a'],
    }
    clientMock.controlApiRequest.mockRejectedValueOnce(
      new ControlApiError('Host access denied', 403, validBody)
    )
    expect(await issueRpcAccessToken(sessionToken, ['host:message:invoke'], ['host-a'])).toEqual(
      validBody
    )

    const rejected = new ControlApiError('Host access denied', 403, {
      error: 'host_access_denied',
      code: 'host_access_revoked',
      ...fields,
    })
    clientMock.controlApiRequest.mockRejectedValueOnce(rejected)
    const result = await issueRpcAccessToken(sessionToken, ['host:message:invoke'], ['host-a'])

    expect(rejected.status).toBe(403)
    expect(result).toEqual({ error: 'host_access_denied' })
    expect(clientMock.controlApiRequest.mock.calls.length).toBe(2)
    for (const [method, path, options] of clientMock.controlApiRequest.mock.calls) {
      expect(method).toBe('POST')
      expect(path).toBe('/external/rpc/token')
      expect(options.body.sessionToken === sessionToken).toBe(true)
      expect(options.body.hostRefs).toEqual(['host-a'])
    }
  })

  it('E2: drops an unsorted revocation list for two requested Hosts', async () => {
    clientMock.controlApiRequest.mockRejectedValueOnce(
      new ControlApiError('Host access denied', 403, {
        error: 'host_access_denied',
        code: 'host_access_revoked',
        revokedHostRefs: ['host-b', 'host-a'],
      })
    )

    expect(
      await issueRpcAccessToken('session', ['host:message:invoke'], ['host-a', 'host-b'])
    ).toEqual({ error: 'host_access_denied' })
  })

  it.each([
    { name: 'unknown code', code: 'future_host_access_signal' },
    { name: 'host_access_denied code', code: 'host_access_denied' },
  ])('E3: drops revocation extras for $name despite a valid list', async ({ code }) => {
    const sessionToken = randomUUID()
    const validBody = {
      error: 'host_access_denied',
      code: 'host_access_revoked',
      revokedHostRefs: ['host-a'],
    }
    clientMock.controlApiRequest.mockRejectedValueOnce(
      new ControlApiError('Host access denied', 403, validBody)
    )
    expect(await issueRpcAccessToken(sessionToken, ['host:message:invoke'], ['host-a'])).toEqual(
      validBody
    )

    const rejected = new ControlApiError('Host access denied', 403, {
      error: 'host_access_denied',
      code,
      revokedHostRefs: ['host-a'],
    })
    clientMock.controlApiRequest.mockRejectedValueOnce(rejected)
    const result = await issueRpcAccessToken(sessionToken, ['host:message:invoke'], ['host-a'])

    expect(rejected.status).toBe(403)
    expect(result).toEqual({ error: 'host_access_denied' })
    expect(clientMock.controlApiRequest.mock.calls.length).toBe(2)
    for (const [method, path, options] of clientMock.controlApiRequest.mock.calls) {
      expect(method).toBe('POST')
      expect(path).toBe('/external/rpc/token')
      expect(options.body.sessionToken === sessionToken).toBe(true)
      expect(options.body.hostRefs).toEqual(['host-a'])
    }
  })
})
