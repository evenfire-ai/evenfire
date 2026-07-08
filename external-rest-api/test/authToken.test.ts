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
})
