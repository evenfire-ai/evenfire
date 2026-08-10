import { controlApiRequest } from '../controlApiClient.js'
import { TeamRole } from '../types.js'

export type GoogleLoginInput = {
  idToken: string
  sessionContract?: 'v2'
}

type LoginResult = {
  token: string
  me: {
    id: string
    email: string
    name: string | null
    picture: string | null
    teamId: string | null
    teamName: string | null
    role: TeamRole
  }
  isNewUser: boolean
}

export async function loginWithGoogle(google: GoogleLoginInput): Promise<LoginResult> {
  const payload = await controlApiRequest<LoginResult>('POST', '/external/auth/google-login', {
    body: google,
  })
  return payload
}

export async function loginWithPassword(
  email: string,
  password: string,
  sessionContract?: 'v2'
): Promise<Omit<LoginResult, 'isNewUser'>> {
  const payload = await controlApiRequest<Omit<LoginResult, 'isNewUser'>>(
    'POST',
    '/external/auth/password-login',
    {
      body: { email, password, ...(sessionContract ? { sessionContract } : {}) },
    }
  )
  return payload
}

export async function requestPasswordReset(email: string): Promise<{ requested: true }> {
  return controlApiRequest<{ requested: true }>('POST', '/external/auth/password-reset/request', {
    body: { email },
  })
}

export async function renewUserSession(sessionToken: string): Promise<{
  token: string
  expiresInSeconds: number
  absoluteExpiresAt: string
}> {
  return controlApiRequest('POST', '/external/auth/session/renew', {
    userSessionToken: sessionToken,
  })
}

export async function logoutUserSession(sessionToken: string): Promise<{ revoked: boolean }> {
  return controlApiRequest('POST', '/external/auth/session/logout', {
    userSessionToken: sessionToken,
  })
}
