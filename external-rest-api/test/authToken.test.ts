import { beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyToken } from '../src/authToken.js'
import { config } from '../src/config.js'

const jwtMock = vi.hoisted(() => ({
  verify: vi.fn(),
}))

vi.mock('jsonwebtoken', () => ({
  default: jwtMock,
}))

describe('authToken', () => {
  beforeEach(() => {
    jwtMock.verify.mockReset()
    config.authProtocolCutoverEnabled = false
  })

  it('exposes an empty string sentinel for teamless invitation sessions', () => {
    jwtMock.verify.mockReturnValue({
      userId: 'user-1',
      email: 'invitee@example.com',
      teamId: null,
      role: 'member',
      authProtocolVersion: 2,
      exp: 9999999999,
    })

    expect(verifyToken('teamless-token')).toEqual({
      userId: 'user-1',
      email: 'invitee@example.com',
      teamId: '',
      role: 'member',
      authProtocolVersion: 2,
      exp: 9999999999,
    })
  })

  it('rejects a legacy session token without the test-fleet protocol claim', () => {
    config.authProtocolCutoverEnabled = true
    jwtMock.verify.mockReturnValue({
      userId: 'user-1',
      email: 'user@example.invalid',
      teamId: 'team-1',
      role: 'member',
      exp: 9999999999,
    })

    expect(verifyToken('legacy-token')).toBeNull()
  })

  it('accepts an unversioned legacy token while the cutover is disabled', () => {
    jwtMock.verify.mockReturnValue({
      userId: 'user-1',
      email: 'user@example.invalid',
      teamId: 'team-1',
      role: 'member',
      exp: 9999999999,
    })

    expect(verifyToken('legacy-token')).toMatchObject({ userId: 'user-1', teamId: 'team-1' })
    expect(verifyToken('legacy-token')).not.toHaveProperty('authProtocolVersion')
  })

  it('rejects an unversioned token when the test-fleet cutover is enabled', () => {
    config.authProtocolCutoverEnabled = true
    jwtMock.verify.mockReturnValue({
      userId: 'user-1',
      email: 'user@example.invalid',
      teamId: 'team-1',
      role: 'member',
      exp: 9999999999,
    })

    expect(verifyToken('legacy-token')).toBeNull()
  })
})
