import { beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyRpcToken } from './authToken.js'
import { config } from './config.js'

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
  authProtocolVersion: 2,
}

describe('verifyRpcToken access scope binding', () => {
  beforeEach(() => {
    jwtMock.verify.mockReset()
    config.authProtocolCutoverEnabled = false
  })

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

  it('rejects a user token minted before the test-fleet authentication cutover', () => {
    jwtMock.verify.mockReturnValue({
      ...BASE_PAYLOAD,
      authProtocolVersion: 1,
      accessScope: 'user',
      teamId: null,
    })

    expect(verifyRpcToken('legacy-token')).toBeNull()
  })

  it('preserves an unversioned legacy claim when cutover is disabled', () => {
    const { authProtocolVersion: _ignored, ...legacyPayload } = BASE_PAYLOAD
    jwtMock.verify.mockReturnValue({
      ...legacyPayload,
      accessScope: 'user',
      teamId: null,
    })

    expect(verifyRpcToken('legacy-token')).not.toHaveProperty('authProtocolVersion')
  })

  it('rejects an unversioned user token when the test-fleet cutover is enabled', () => {
    const { authProtocolVersion: _ignored, ...legacyPayload } = BASE_PAYLOAD
    config.authProtocolCutoverEnabled = true
    jwtMock.verify.mockReturnValue({
      ...legacyPayload,
      accessScope: 'user',
      teamId: null,
    })

    expect(verifyRpcToken('legacy-token')).toBeNull()
  })
})

describe('verifyRpcToken scope allow-list', () => {
  beforeEach(() => jwtMock.verify.mockReset())

  it('preserves a write-only host:session:write token through the allow-list filter', () => {
    jwtMock.verify.mockReturnValue({
      ...BASE_PAYLOAD,
      scopes: ['host:session:write'],
      accessScope: 'user',
      teamId: null,
    })

    // Guards the ALLOWED_SCOPES membership of 'host:session:write': dropping it
    // there would filter a write-only token down to zero scopes -> null -> 401.
    expect(verifyRpcToken('token')).toMatchObject({
      scopes: ['host:session:write'],
    })
  })

  it('drops scopes outside the allow-list while keeping the recognized one', () => {
    jwtMock.verify.mockReturnValue({
      ...BASE_PAYLOAD,
      scopes: ['host:session:write', 'totally:unknown:scope'],
      accessScope: 'user',
      teamId: null,
    })

    expect(verifyRpcToken('token')).toMatchObject({
      scopes: ['host:session:write'],
    })
  })
})
