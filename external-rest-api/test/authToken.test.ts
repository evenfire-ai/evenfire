import { beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyToken } from '../src/authToken.js'

const jwtMock = vi.hoisted(() => ({
  verify: vi.fn(),
}))

vi.mock('jsonwebtoken', () => ({
  default: jwtMock,
}))

describe('authToken', () => {
  beforeEach(() => {
    jwtMock.verify.mockReset()
  })

  it('exposes an empty string sentinel for teamless invitation sessions', () => {
    jwtMock.verify.mockReturnValue({
      userId: 'user-1',
      email: 'invitee@example.com',
      teamId: null,
      role: 'member',
      exp: 9999999999,
    })

    expect(verifyToken('teamless-token')).toEqual({
      userId: 'user-1',
      email: 'invitee@example.com',
      teamId: '',
      role: 'member',
      exp: 9999999999,
    })
  })

  it('accepts the v2 user-session audience without team or role authority', () => {
    jwtMock.verify.mockReturnValue({
      sub: 'user-1',
      email: 'user@example.com',
      sid: 'session-1',
      jti: 'representation-1',
      sv: 3,
      ver: 2,
      typ: 'user_session',
      exp: 9999999999,
    })

    expect(verifyToken('v2-token')).toEqual({
      userId: 'user-1',
      email: 'user@example.com',
      teamId: '',
      role: 'member',
      exp: 9999999999,
      sessionContract: 'v2',
      sid: 'session-1',
      jti: 'representation-1',
      sv: 3,
      ver: 2,
    })
    expect(jwtMock.verify).toHaveBeenCalledWith(
      'v2-token',
      expect.anything(),
      expect.objectContaining({ audience: 'evenfire-user-session' })
    )
  })
})
