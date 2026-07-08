import { NextRequest } from 'next/server'
import { verifyControlAdminPasswordResetCsrfToken } from '@lib/controlAdminCsrf'
import { completeControlAdminPasswordResetServer } from '@lib/controlAdminPublicServerApi'
import { sameOriginRedirect } from '@lib/sameOriginRedirect'

function resetPath(token: string, error: string): string {
  const searchParams = new URLSearchParams({ error })
  return `/admin-password-resets/${encodeURIComponent(token)}?${searchParams}`
}

function resetCompletePath(login: string): string {
  const searchParams = new URLSearchParams({ login })
  return `/admin-password-resets/complete?${searchParams}`
}

export async function POST(req: NextRequest, context: { params: Promise<{ token?: string }> }) {
  const { token: rawToken } = await context.params
  const token = String(rawToken || '')
  const formData = await req.formData()
  const email = String(formData.get('email') || '')
    .trim()
    .toLowerCase()
  const password = String(formData.get('password') || '')
  const confirmPassword = String(formData.get('confirmPassword') || '')
  const csrfToken = String(formData.get('csrfToken') || '')

  if (!token) {
    return sameOriginRedirect(resetPath(token, 'Password reset token is missing.'))
  }
  if (!verifyControlAdminPasswordResetCsrfToken(token, csrfToken)) {
    return sameOriginRedirect(
      resetPath(token, 'Password reset form expired. Reopen the reset link.')
    )
  }
  if (!email || !password || !confirmPassword) {
    return sameOriginRedirect(resetPath(token, 'All fields are required.'))
  }
  if (password.length < 8) {
    return sameOriginRedirect(resetPath(token, 'Password must be at least 8 characters.'))
  }
  if (password !== confirmPassword) {
    return sameOriginRedirect(resetPath(token, 'Password and confirmation must match.'))
  }

  try {
    const response = await completeControlAdminPasswordResetServer({
      token,
      email,
      password,
    })
    return sameOriginRedirect(resetCompletePath(response.login.username))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reset password'
    return sameOriginRedirect(resetPath(token, message))
  }
}
