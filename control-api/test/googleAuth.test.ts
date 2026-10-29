import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GoogleIdentityRejectedError, verifyGoogleIdToken } from '../src/utils/auth/googleAuth.js'

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

    const rejection = verifyGoogleIdToken('unverified-token')
    await expect(rejection).rejects.toBeInstanceOf(GoogleIdentityRejectedError)
    await expect(rejection).rejects.toThrow('Google token email is not verified')
  })

  it('rejects a verified payload without an email', async () => {
    googleMock.verifyIdToken.mockResolvedValue({
      getPayload: () => ({ email_verified: true }),
    })

    await expect(verifyGoogleIdToken('emailless-token')).rejects.toBeInstanceOf(
      GoogleIdentityRejectedError
    )
  })

  it('leaves library verification errors as plain errors', async () => {
    const libraryError = new Error('Wrong number of segments in token: secret-token')
    googleMock.verifyIdToken.mockRejectedValue(libraryError)

    await expect(verifyGoogleIdToken('malformed-token')).rejects.toBe(libraryError)
    await expect(verifyGoogleIdToken('malformed-token')).rejects.not.toBeInstanceOf(
      GoogleIdentityRejectedError
    )
  })
})
