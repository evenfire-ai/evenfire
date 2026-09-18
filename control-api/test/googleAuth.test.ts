import { beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyGoogleIdToken } from '../src/utils/auth/googleAuth.js'

const googleMock = vi.hoisted(() => ({ verifyIdToken: vi.fn() }))

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken = googleMock.verifyIdToken
  },
}))

vi.mock('../src/config.js', () => ({
  config: { googleClientId: 'google-client-id' },
}))

describe('verifyGoogleIdToken', () => {
  beforeEach(() => {
    googleMock.verifyIdToken.mockReset()
  })

  it('accepts only a Google-verified email identity', async () => {
    googleMock.verifyIdToken.mockResolvedValue({
      getPayload: () => ({
        email: 'User@Example.com',
        email_verified: true,
        name: 'User',
      }),
    })

    await expect(verifyGoogleIdToken('verified-token')).resolves.toEqual({
      email: 'user@example.com',
      name: 'User',
      picture: undefined,
    })
  })

  it('rejects an identity whose email is not verified by Google', async () => {
    googleMock.verifyIdToken.mockResolvedValue({
      getPayload: () => ({
        email: 'user@example.com',
        email_verified: false,
      }),
    })

    await expect(verifyGoogleIdToken('unverified-token')).rejects.toThrow(
      'Google token email is not verified'
    )
  })
})
