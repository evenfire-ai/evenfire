import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GoogleIdentityRejectedError,
  GoogleTokenVerificationError,
  verifyGoogleIdToken,
} from '../src/utils/auth/googleAuth.js'

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

  it('replaces a library verification error with a token-free typed error', async () => {
    const submittedToken = 'synthetic-id-token'
    const payloadEmail = 'synthetic-payload@example.invalid'
    googleMock.verifyIdToken.mockRejectedValue(
      new Error(`Wrong number of segments in token: ${submittedToken} ${payloadEmail}`)
    )

    const error = await verifyGoogleIdToken(submittedToken).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(GoogleTokenVerificationError)
    expect(error).not.toBeInstanceOf(GoogleIdentityRejectedError)
    expect((error as Error).message).toBe('Google ID token verification failed')
    expect((error as Error).message).not.toContain(submittedToken)
    expect((error as Error).message).not.toContain(payloadEmail)
    expect(String((error as Error).stack)).not.toContain(submittedToken)
    expect(String((error as Error).stack)).not.toContain(payloadEmail)
    expect((error as Error).cause).toBeUndefined()
    expect(error).not.toHaveProperty('status')
    expect(error).not.toHaveProperty('statusCode')
    expect(error).not.toHaveProperty('code')
    // Liveness witness: the library verifier was actually consulted.
    expect(googleMock.verifyIdToken).toHaveBeenCalledWith({
      idToken: submittedToken,
      audience: 'google-client-id',
    })
  })
})
