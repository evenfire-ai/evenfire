import { NextRequest } from 'next/server'
import { verifyControlAdminInvitationCsrfToken } from '@lib/controlAdminCsrf'
import { completeControlAdminInvitationServer } from '@lib/controlAdminPublicServerApi'
import { sameOriginRedirect } from '@lib/sameOriginRedirect'

type InvitationErrorOptions = {
  field?: string
  separateDesktopPassword?: boolean
  username?: string
}

function fieldForErrorMessage(message: string): string | undefined {
  const normalizedMessage = message.toLowerCase()
  if (normalizedMessage.includes('username')) return 'username'
  if (normalizedMessage.includes('desktop app password and confirmation')) {
    return 'confirmMemberPassword'
  }
  if (normalizedMessage.includes('desktop app password')) return 'memberPassword'
  if (normalizedMessage.includes('password and confirmation')) return 'confirmPassword'
  if (normalizedMessage.includes('confirm your password')) return 'confirmPassword'
  if (normalizedMessage.includes('password must')) return 'password'
  return undefined
}

function invitationPath(
  token: string,
  error: string,
  options: InvitationErrorOptions = {}
): string {
  const searchParams = new URLSearchParams({ error })
  if (options.field) searchParams.set('field', options.field)
  if (options.username) searchParams.set('username', options.username)
  if (options.separateDesktopPassword) searchParams.set('separateDesktopPassword', 'true')
  return `/admin-invitations/${encodeURIComponent(token)}?${searchParams}`
}

function setupCompletePath(login: string): string {
  const searchParams = new URLSearchParams({ login })
  return `/admin-invitations/setup-complete?${searchParams}`
}

export async function POST(req: NextRequest, context: { params: Promise<{ token?: string }> }) {
  const { token: rawToken } = await context.params
  const token = String(rawToken || '')
  const formData = await req.formData()
  const email = String(formData.get('email') || '')
    .trim()
    .toLowerCase()
  const username = String(formData.get('username') || '').trim()
  const password = String(formData.get('password') || '')
  const confirmPassword = String(formData.get('confirmPassword') || '')
  const memberPassword = String(formData.get('memberPassword') || '')
  const confirmMemberPassword = String(formData.get('confirmMemberPassword') || '')
  const requestedSameMemberPassword = formData
    .getAll('useSameMemberPassword')
    .some(value => String(value) === 'true')
  const useSameMemberPassword =
    requestedSameMemberPassword || (!memberPassword && !confirmMemberPassword)
  const csrfToken = String(formData.get('csrfToken') || '')
  const formErrorPath = (message: string, field?: string) =>
    invitationPath(token, message, {
      field: field || fieldForErrorMessage(message),
      separateDesktopPassword: !useSameMemberPassword,
      username,
    })

  if (!token) {
    return sameOriginRedirect(invitationPath(token, 'Invitation token is missing.'))
  }
  if (!verifyControlAdminInvitationCsrfToken(token, csrfToken)) {
    return sameOriginRedirect(
      invitationPath(token, 'Invitation form expired. Reopen the invitation link.')
    )
  }
  if (!email || !username || !password || !confirmPassword) {
    if (!username) return sameOriginRedirect(formErrorPath('Username is required.', 'username'))
    if (!password) return sameOriginRedirect(formErrorPath('Password is required.', 'password'))
    if (!confirmPassword) {
      return sameOriginRedirect(formErrorPath('Confirm your password.', 'confirmPassword'))
    }
    return sameOriginRedirect(formErrorPath('All fields are required.'))
  }
  if (password.length < 8 || password.length > 256) {
    return sameOriginRedirect(
      formErrorPath('Password must be between 8 and 256 characters.', 'password')
    )
  }
  if (password !== confirmPassword) {
    return sameOriginRedirect(
      formErrorPath('Password and confirmation must match.', 'confirmPassword')
    )
  }
  if (!useSameMemberPassword && (memberPassword.length < 8 || memberPassword.length > 256)) {
    return sameOriginRedirect(
      formErrorPath('Desktop App password must be between 8 and 256 characters.', 'memberPassword')
    )
  }
  if (!useSameMemberPassword && memberPassword !== confirmMemberPassword) {
    return sameOriginRedirect(
      formErrorPath('Desktop App password and confirmation must match.', 'confirmMemberPassword')
    )
  }

  try {
    const response = await completeControlAdminInvitationServer({
      token,
      email,
      username,
      password,
      useSameMemberPassword,
      memberPassword: useSameMemberPassword ? undefined : memberPassword,
    })
    return sameOriginRedirect(setupCompletePath(response.login.username))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to complete admin setup'
    return sameOriginRedirect(formErrorPath(message))
  }
}
