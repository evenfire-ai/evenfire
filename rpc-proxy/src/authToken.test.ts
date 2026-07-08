import { beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyRpcToken } from './authToken.js'

const jwtMock = vi.hoisted(() => ({ verify: vi.fn() }))

vi.mock('jsonwebtoken', () => ({
  default: { verify: jwtMock.verify },
}))

const BASE_PAYLOAD = {
  sub: 'user-1',
  typ: 'user',
  scopes: ['host:message:invoke'],
  hostRefs: ['pro-agent'],
  jti: 'rpc-token-1',
  iat: 1,
  exp: 2,
}

describe('verifyRpcToken access scope binding', () => {
  beforeEach(() => jwtMock.verify.mockReset())

  it('accepts an explicit user-scoped token without a team id', () => {
    jwtMock.verify.mockReturnValue({
      ...BASE_PAYLOAD,
      accessScope: 'user',
      teamId: null,
    })

    expect(verifyRpcToken('token')).toMatchObject({
      accessScope: 'user',
      teamId: null,
      hostRefs: ['pro-agent'],
    })
  })

  it('normalizes a legacy team token to team scope', () => {
    jwtMock.verify.mockReturnValue({ ...BASE_PAYLOAD, teamId: 'team-1' })

    expect(verifyRpcToken('token')).toMatchObject({
      accessScope: 'team',
      teamId: 'team-1',
    })
  })

  it('rejects inconsistent scope/team combinations and wildcard hosts', () => {
    jwtMock.verify.mockReturnValue({
      ...BASE_PAYLOAD,
      accessScope: 'user',
      teamId: 'team-1',
    })
    expect(verifyRpcToken('token')).toBeNull()

    jwtMock.verify.mockReturnValue({
      ...BASE_PAYLOAD,
      accessScope: 'team',
      teamId: null,
    })
    expect(verifyRpcToken('token')).toBeNull()

    jwtMock.verify.mockReturnValue({
      ...BASE_PAYLOAD,
      accessScope: 'user',
      teamId: null,
      hostRefs: ['pro-agent', '*'],
    })
    expect(verifyRpcToken('token')).toBeNull()
  })
})
