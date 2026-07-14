const CONTROL_API_INTERNAL_URL = process.env.CONTROL_API_INTERNAL_URL || 'http://127.0.0.1:8090'
const PUBLIC_TOKEN_TIMEOUT_MS = 15_000

function controlApiUrl(path: string): string {
  return `${CONTROL_API_INTERNAL_URL.replace(/\/$/, '')}${path}`
}

async function readError(res: Response): Promise<Error> {
  const text = await res.text()
  let detail = ''
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown }
    detail = String(parsed.message || parsed.error || text)
  } catch {
    detail = text
  }

  console.warn('[ControlUI] public admin token request failed', {
    status: res.status,
    statusText: res.statusText,
    detail,
  })

  if (res.status === 429) return new Error('Too many attempts. Try again later.')
  if (detail === 'invalid_invitation') {
    return new Error('This admin invitation is invalid or expired.')
  }
  if (detail === 'invalid_confirmation') {
    return new Error('This email confirmation link is invalid or expired.')
  }
  if (detail === 'invalid_password_reset') {
    return new Error('This password reset link is invalid or expired.')
  }
  if (detail === 'duplicate_email') return new Error('That email is already registered.')
  if (detail === 'duplicate_username') return new Error('That username is already taken.')
  if (detail === 'password must be between 8 and 256 characters') {
    return new Error('Password must be between 8 and 256 characters.')
  }
  if (detail === 'member password must be between 8 and 256 characters') {
    return new Error('Desktop App password must be between 8 and 256 characters.')
  }
  if (detail === 'not_found') return new Error('This link is invalid or expired.')

  return new Error('We could not complete this request. Try again later.')
}

// Blueprint for public signed-token pages: resolve token state on the server,
// then render only the loaded client form/state. This avoids client effect
// races and keeps token bootstrap out of browser storage.
export async function postControlAdminPublicToken<T>(path: string, body: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(controlApiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(PUBLIC_TOKEN_TIMEOUT_MS),
    })
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new Error(
        'Request timed out. Check that Control API and member-registration-service are running.'
      )
    }
    throw error
  }

  if (!res.ok) {
    throw await readError(res)
  }

  return (await res.json()) as T
}

export async function validateControlAdminInvitationServer(token: string): Promise<{
  valid: true
  email: string
  invitationUuid: string
  desktopAccess?: {
    id: string
    teams: Array<{ id: string; name: string; role: string }>
  } | null
}> {
  return postControlAdminPublicToken('/api/v1/admin/auth/control-admin-invitations/validate', {
    token,
  })
}

export async function completeControlAdminEmailConfirmationServer(token: string): Promise<{
  completed: true
  alreadyConfirmed?: boolean
  login: { username: string }
}> {
  return postControlAdminPublicToken(
    '/api/v1/admin/auth/control-admin-email-confirmations/complete',
    { token }
  )
}

export async function completeControlAdminInvitationServer(payload: {
  token: string
  email: string
  username: string
  password: string
  useSameMemberPassword?: boolean
  memberPassword?: string
}): Promise<{ completed: true; desktopAccessCompleted?: boolean; login: { username: string } }> {
  return postControlAdminPublicToken(
    '/api/v1/admin/auth/control-admin-invitations/complete',
    payload
  )
}

export async function validateControlAdminPasswordResetServer(token: string): Promise<{
  valid: true
  email: string
  resetUuid: string
}> {
  return postControlAdminPublicToken('/api/v1/admin/auth/password-reset/validate', {
    token,
  })
}

export async function completeControlAdminPasswordResetServer(payload: {
  token: string
  email: string
  password: string
}): Promise<{ completed: true; login: { username: string } }> {
  return postControlAdminPublicToken('/api/v1/admin/auth/password-reset/complete', payload)
}
