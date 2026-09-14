import { OAuth2Client } from 'google-auth-library'
import { config } from '../../config.js'

const googleClient = new OAuth2Client(config.googleClientId)

export type VerifiedGoogleProfile = {
  email: string
  name?: string
  picture?: string
}

export async function verifyGoogleIdToken(idToken: string): Promise<VerifiedGoogleProfile> {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: config.googleClientId,
  })
  const payload = ticket.getPayload()
  if (!payload?.email) {
    throw new Error('Google token has no email')
  }
  if (payload.email_verified !== true) {
    throw new Error('Google token email is not verified')
  }
  return {
    email: payload.email.toLowerCase(),
    name: payload.name,
    picture: payload.picture,
  }
}
