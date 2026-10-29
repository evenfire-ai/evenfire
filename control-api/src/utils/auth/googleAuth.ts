import { OAuth2Client } from 'google-auth-library'
import { config } from '../../config.js'

const googleClient = new OAuth2Client(config.googleClientId)

export type VerifiedGoogleProfile = {
  email: string
  name?: string
  picture?: string
}

/**
 * A Google identity that this verifier itself refuses to authenticate after
 * the ID token verified. Callers answer it as a rejected credential (401).
 *
 * Errors raised by `verifyIdToken` (malformed, expired or wrong-audience
 * tokens, certificate fetch failures) are deliberately not wrapped: they stay
 * plain errors and keep the existing sanitized 500 path.
 */
export class GoogleIdentityRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoogleIdentityRejectedError'
  }
}

export async function verifyGoogleIdToken(idToken: string): Promise<VerifiedGoogleProfile> {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: config.googleClientId,
  })
  const payload = ticket.getPayload()
  if (!payload?.email) {
    throw new GoogleIdentityRejectedError('Google token has no email')
  }
  if (payload.email_verified !== true) {
    throw new GoogleIdentityRejectedError('Google token email is not verified')
  }
  return {
    email: payload.email.toLowerCase(),
    name: payload.name,
    picture: payload.picture,
  }
}
