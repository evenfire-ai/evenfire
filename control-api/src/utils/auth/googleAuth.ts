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
 */
export class GoogleIdentityRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoogleIdentityRejectedError'
  }
}

/**
 * A Google ID token that the verification library refused (malformed, expired,
 * wrong audience, certificate fetch failure). The library's own errors embed
 * the submitted token and its decoded payload in their message and stack, so
 * they are never propagated: this error carries a fixed message, no `cause`
 * and no library text. Callers keep the sanitized 500 path.
 *
 * It deliberately carries no `status`, `statusCode` or `code`, because the
 * global error handler branches on those and would otherwise forward it as a
 * client error.
 */
export class GoogleTokenVerificationError extends Error {
  constructor() {
    super('Google ID token verification failed')
    this.name = 'GoogleTokenVerificationError'
  }
}

async function verifyWithLibrary(idToken: string) {
  try {
    return await googleClient.verifyIdToken({
      idToken,
      audience: config.googleClientId,
    })
  } catch {
    // Never propagate the library error, not even as a cause: its text is the
    // submitted token or its decoded payload.
    throw new GoogleTokenVerificationError()
  }
}

export async function verifyGoogleIdToken(idToken: string): Promise<VerifiedGoogleProfile> {
  const ticket = await verifyWithLibrary(idToken)
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
