import { controlApiRequest } from '../controlApiClient.js'
import { TeamRole } from '../types.js'

export type GoogleLoginInput = {
  idToken: string
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
  password: string
): Promise<Omit<LoginResult, 'isNewUser'>> {
  const payload = await controlApiRequest<Omit<LoginResult, 'isNewUser'>>(
    'POST',
    '/external/auth/password-login',
    {
      body: { email, password },
    }
  )
  return payload
}

export async function requestPasswordReset(email: string): Promise<{ requested: true }> {
  return controlApiRequest<{ requested: true }>('POST', '/external/auth/password-reset/request', {
    body: { email },
  })
}
