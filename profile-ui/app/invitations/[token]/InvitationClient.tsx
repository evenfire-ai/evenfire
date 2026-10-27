'use client'

import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { PROFILE_ROUTES } from '@constants/routes'
import {
  ProfileApiError,
  acceptInvitation,
  clearUnconfirmedLogout,
  setupAcceptedInvitationPasswordWithToken,
  setupInvitationPasswordWithToken,
} from '@lib/api'
import { isTerminalPasswordError } from '@lib/invitationErrors'
import {
  buildInvitationHeading,
  buildInvitationTeamsLabel,
  formatRemaining,
} from '@lib/invitations'
import { formatTeamRole } from '@lib/teamRoles'
import type { InvitationPreview } from '@/app/types/api'
import { InvitationActionPanel } from './InvitationActionPanel'
import type { InvitationClientProps } from './types'

type PasswordPhase = 'editing' | 'submitting' | 'updated' | 'outcome_unknown' | 'terminal'

function statusForInvitation(invitation: InvitationPreview): string {
  if (invitation.purpose === 'password_reset') {
    return invitation.status === 'accepted'
      ? 'Your password has been updated.'
      : 'Set a new password for your Evenfire account.'
  }
  const teamNames =
    Array.isArray(invitation.teams) && invitation.teams.length > 0
      ? invitation.teams.map(team => team.name)
      : invitation.teamName
        ? [invitation.teamName]
        : []
  const teamLabel = buildInvitationTeamsLabel(invitation.teams, invitation.teamName)
  const hasMultipleTeams = teamNames.length > 1
  if (!teamLabel) {
    if (invitation.status === 'accepted') {
      return invitation.passwordPending
        ? 'Set your password to finish joining Evenfire.'
        : 'You are now registered with Evenfire.'
    }
    return 'Accept your Evenfire invitation.'
  }

  if (hasMultipleTeams) {
    if (invitation.status === 'accepted') {
      return invitation.passwordPending
        ? 'Set your password to finish joining these teams.'
        : 'You are now registered to these teams.'
    }
    return 'You are invited to these teams.'
  }

  if (invitation.status === 'accepted') {
    return invitation.passwordPending
      ? `Set your password to finish joining ${teamLabel}.`
      : `You are now registered to ${teamLabel}.`
  }

  return `Accept your Evenfire invitation for ${teamLabel}.`
}

function isAmbiguousRecoveryOutcome(value: unknown): boolean {
  if (!(value instanceof Error)) return true
  if (value instanceof TypeError || value.name === 'SyntaxError') return true
  if (!(value instanceof ProfileApiError)) return false
  if (value.code === 'recovery_outcome_unknown') return true
  if (value.status === 500 && value.code === 'internal_error') return false
  if (value.code === 'authority_unavailable' || value.code === 'rate_limited') return false
  if (value.status === 429) return false
  return value.status >= 500
}

export function InvitationClient({
  invitationToken,
  initialInvitation,
  initialError,
}: InvitationClientProps) {
  const [invitation, setInvitation] = useState<InvitationPreview | null>(initialInvitation)
  const [error, setError] = useState(initialError)
  const [status, setStatus] = useState(() =>
    initialInvitation ? statusForInvitation(initialInvitation) : ''
  )
  const [now, setNow] = useState(() => Date.now())
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState<'accept' | 'password' | null>(null)
  const [passwordPhase, setPasswordPhase] = useState<PasswordPhase>('editing')
  const actionInFlightRef = useRef(false)

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    setInvitation(initialInvitation)
    setError(initialError)
    setStatus(initialInvitation ? statusForInvitation(initialInvitation) : '')
  }, [initialInvitation, initialError])

  useEffect(() => {
    setPasswordPhase('editing')
  }, [invitationToken])

  const invitationExpired = useMemo(() => {
    if (!invitation || invitation.status !== 'pending') return false
    return formatRemaining(invitation.expiresAt, now) === 'expired'
  }, [invitation, now])

  const expirationText = useMemo(() => {
    if (!invitation || invitation.status !== 'pending') return ''
    const remaining = formatRemaining(invitation.expiresAt, now)
    if (remaining === 'expired') return 'This invitation has expired.'
    return remaining ? `This invitation will expire in ${remaining}.` : ''
  }, [invitation, now])

  const isPasswordReset = invitation?.purpose === 'password_reset'
  const teamLabel = invitation
    ? buildInvitationTeamsLabel(invitation.teams, invitation.teamName)
    : ''
  const teamNames =
    invitation && Array.isArray(invitation.teams) && invitation.teams.length > 0
      ? invitation.teams.map(team => team.name)
      : invitation?.teamName
        ? [invitation.teamName]
        : []
  const hasMultipleTeams = teamNames.length > 1
  const profileLoginHref = PROFILE_ROUTES.login({
    email: invitation?.email.trim().toLowerCase(),
  })
  const forgotPasswordHref = PROFILE_ROUTES.forgotPassword({
    email: invitation?.email.trim().toLowerCase(),
  })
  const busy = submitting !== null
  const passwordUpdated = passwordPhase === 'updated'
  const recoveryOutcomeUnknown = isPasswordReset && passwordPhase === 'outcome_unknown'
  const passwordTerminal = passwordPhase === 'terminal'
  const invitationUsed = Boolean(
    invitation && invitation.status === 'accepted' && !invitation.passwordPending
  )
  const showPasswordSetup = Boolean(
    invitation &&
    !passwordUpdated &&
    !recoveryOutcomeUnknown &&
    !passwordTerminal &&
    !invitationUsed &&
    !invitationExpired &&
    ((isPasswordReset && invitation.status === 'pending') ||
      (invitation.status === 'accepted' && invitation.passwordPending))
  )
  const pageTitle = passwordUpdated
    ? 'Password updated'
    : isPasswordReset
      ? 'Reset password'
      : buildInvitationHeading(invitation?.teamName)
  const pageStatus = passwordUpdated
    ? 'Your password has been updated.'
    : passwordTerminal
      ? 'Sign in to continue with your account.'
      : invitationUsed
        ? 'This invitation has already been used.'
        : status || (error ? 'We could not open this invitation.' : 'Invitation loaded.')

  function friendlyInvitationError(value: unknown, isRecovery = false): string {
    if (!(value instanceof Error)) return 'Failed to update invitation.'
    if (isRecovery) {
      if (!(value instanceof ProfileApiError)) {
        return 'We could not update your password. Please try again.'
      }
      if (value.code === 'invalid_password') return 'Password must be between 8 and 256 characters.'
      if (value.code === 'invalid_invitation') return 'This recovery link is invalid or expired.'
      if (value.code === 'invitation_not_accepted')
        return 'Accept the invitation before setting a password.'
      if (value.code === 'invitation_not_pending' || value.code === 'invitation_not_ready')
        return 'This invitation has already been used.'
      if (value.code === 'expired' || value.status === 410) return 'This invitation has expired.'
      if (value.code === 'forbidden' || value.status === 403)
        return 'Invitation email does not match.'
      if (value.code === 'not_found' || value.status === 404) return 'Invitation not found.'
      if (value.code === 'rate_limited' || value.status === 429) {
        return 'Account recovery is temporarily busy. Please wait a moment and try again.'
      }
      if (value.code === 'authority_unavailable') {
        return 'Account recovery is temporarily unavailable. Please try again shortly.'
      }
      if (value.code === 'recovery_outcome_unknown') {
        return 'We could not confirm whether your password change completed. Try signing in with the new password. If that does not work, request a new reset link.'
      }
      if (value.status === 400 || value.status === 401) {
        return 'This recovery link is invalid or expired.'
      }
      return 'We could not update your password. Please try again.'
    }
    if (value instanceof ProfileApiError && value.code) {
      if (value.code === 'invalid_password') return 'Password must be between 8 and 256 characters.'
      if (value.code === 'invalid_invitation') return 'This recovery link is invalid or expired.'
      if (value.code === 'invitation_not_accepted')
        return 'Accept the invitation before setting a password.'
      if (value.code === 'invitation_not_pending' || value.code === 'invitation_not_ready')
        return 'This invitation has already been used.'
      if (value.code === 'expired') return 'This invitation has expired.'
      if (value.code === 'forbidden') return 'Invitation email does not match.'
      if (value.code === 'not_found') return 'Invitation not found.'
      if (value.code === 'password_already_set') {
        return 'This account already has a password. Sign in instead.'
      }
    }
    const message = value.message.replace(/^\d{3}\s+[A-Za-z ]+\s+-\s+/, '')
    if (message === 'invalid_password') return 'Password must be between 8 and 256 characters.'
    if (message === 'invalid_invitation') return 'This recovery link is invalid or expired.'
    if (message === 'invitation_not_accepted')
      return 'Accept the invitation before setting a password.'
    if (message === 'invitation_not_pending') return 'This invitation has already been used.'
    if (message === 'invitation_not_ready')
      return 'This invitation is not ready for password setup.'
    if (message === 'expired') return 'This invitation has expired.'
    if (message === 'forbidden') return 'Invitation email does not match.'
    if (message === 'not_found') return 'Invitation not found.'
    if (message === 'rate_limited')
      return 'Account recovery is temporarily busy. Please wait a moment and try again.'
    if (message === 'authority_unavailable')
      return 'Account recovery is temporarily unavailable. Please try again shortly.'
    if (message === 'recovery_outcome_unknown') {
      return 'We could not confirm whether your password change completed. Try signing in with the new password. If that does not work, request a new reset link.'
    }
    return message
  }

  function applyInvitationUpdate(nextInvitation: InvitationPreview) {
    setInvitation(nextInvitation)
    setStatus(statusForInvitation(nextInvitation))
    setPassword('')
    setConfirmPassword('')
  }

  async function handleAccept() {
    if (!invitation || busy || actionInFlightRef.current) return
    const previousInvitation = invitation
    actionInFlightRef.current = true
    setSubmitting('accept')
    setError('')
    applyInvitationUpdate({
      ...invitation,
      status: 'accepted',
      acceptedAt: invitation.acceptedAt || new Date().toISOString(),
      passwordPending: true,
    })
    try {
      const response = await acceptInvitation(invitationToken, invitation.email)
      applyInvitationUpdate({
        ...invitation,
        ...response,
        status: response.status || 'accepted',
        passwordPending: response.passwordPending ?? true,
      })
    } catch (nextError) {
      applyInvitationUpdate(previousInvitation)
      setError(friendlyInvitationError(nextError))
    } finally {
      actionInFlightRef.current = false
      setSubmitting(null)
    }
  }

  function handleAcceptAction(
    event: MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>
  ) {
    event.preventDefault()
    event.stopPropagation()
    void handleAccept()
  }

  async function handlePasswordSubmit() {
    if (
      !invitation ||
      busy ||
      actionInFlightRef.current ||
      passwordPhase === 'updated' ||
      passwordPhase === 'outcome_unknown'
    ) {
      return
    }
    setError('')
    const normalizedPasswordLength = password.trim().length
    if (normalizedPasswordLength < 8 || normalizedPasswordLength > 256) {
      setError('Password must be between 8 and 256 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    actionInFlightRef.current = true
    setSubmitting('password')
    setPasswordPhase('submitting')
    try {
      const setupPassword = isPasswordReset
        ? setupInvitationPasswordWithToken
        : setupAcceptedInvitationPasswordWithToken
      await setupPassword(invitationToken, invitation.email, invitation.id, password)
      // The server accepted the recovery proof. Only that authoritative result
      // releases the logout fence: a page view or a client-clock expiry is not
      // proof that the surviving session can be discarded safely.
      if (isPasswordReset) clearUnconfirmedLogout()
      // The backend issues no session from password setup. The screen must send
      // the person to the ordinary login instead of hydrating a recovery session.
      setPasswordPhase('updated')
      setStatus('Your password has been updated.')
      setPassword('')
      setConfirmPassword('')
    } catch (nextError) {
      if (isPasswordReset && isAmbiguousRecoveryOutcome(nextError)) {
        setPasswordPhase('outcome_unknown')
        setPassword('')
        setConfirmPassword('')
        setError(
          'We could not confirm whether your password change completed. Try signing in with the new password. If that does not work, request a new reset link.'
        )
      } else if (isTerminalPasswordError(nextError)) {
        // The proof was invalidated after this screen loaded. Offering the same
        // dead form again would trap the person, so end at a usable action.
        setPasswordPhase('terminal')
        setPassword('')
        setConfirmPassword('')
        setError(friendlyInvitationError(nextError, isPasswordReset))
      } else {
        setPasswordPhase('editing')
        setError(friendlyInvitationError(nextError, isPasswordReset))
      }
    } finally {
      actionInFlightRef.current = false
      setSubmitting(null)
    }
  }

  function handlePasswordAction(
    event: MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>
  ) {
    event.preventDefault()
    event.stopPropagation()
    void handlePasswordSubmit()
  }

  function handlePasswordKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void handlePasswordSubmit()
  }

  return (
    <main className="center-page">
      <section className="page-card">
        <div className="stack-tight">
          <p className="eyebrow">Evenfire Invitation</p>
          <h1 className="page-title page-title--large">{pageTitle}</h1>
          <p className="body-copy">{pageStatus}</p>
        </div>

        {error ? (
          <div className="message message--error" role="alert" aria-live="assertive">
            {error}
          </div>
        ) : null}

        {invitation ? (
          <div className="invite-card">
            <div>
              <strong>Email</strong>
              <div className="body-copy">{invitation.email}</div>
            </div>
            {!isPasswordReset ? (
              <div>
                <strong>{hasMultipleTeams ? 'Teams' : 'Team'}</strong>
                {hasMultipleTeams ? (
                  <ul className="invite-team-list">
                    {teamNames.map(teamName => (
                      <li key={teamName}>{teamName}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="body-copy">{teamLabel || 'Evenfire'}</div>
                )}
              </div>
            ) : null}
            {invitation.role && !hasMultipleTeams && !isPasswordReset ? (
              <div>
                <strong>Role</strong>
                <div className="body-copy">{formatTeamRole(invitation.role)}</div>
              </div>
            ) : null}
            {invitation.status !== 'accepted' ? (
              <div>
                <strong>Availability</strong>
                <div className="body-copy">{expirationText}</div>
              </div>
            ) : null}
          </div>
        ) : null}

        {!invitation ? (
          <InvitationActionPanel mode="link-error" loginHref={profileLoginHref} />
        ) : passwordUpdated ? (
          <InvitationActionPanel mode="password-updated" loginHref={profileLoginHref} />
        ) : recoveryOutcomeUnknown ? (
          <InvitationActionPanel
            mode="outcome-unknown"
            loginHref={profileLoginHref}
            forgotPasswordHref={forgotPasswordHref}
          />
        ) : passwordTerminal ? (
          <InvitationActionPanel
            mode="terminal"
            loginHref={profileLoginHref}
            forgotPasswordHref={forgotPasswordHref}
          />
        ) : invitationUsed ? (
          <InvitationActionPanel
            mode="used"
            loginHref={profileLoginHref}
            isPasswordReset={isPasswordReset}
            forgotPasswordHref={forgotPasswordHref}
          />
        ) : invitationExpired ? (
          <InvitationActionPanel mode="expired" loginHref={profileLoginHref} />
        ) : showPasswordSetup ? (
          <InvitationActionPanel
            mode="password-setup"
            isPasswordReset={isPasswordReset}
            busy={busy}
            submitting={submitting}
            password={password}
            confirmPassword={confirmPassword}
            onPasswordChange={setPassword}
            onConfirmPasswordChange={setConfirmPassword}
            onPasswordKeyDown={handlePasswordKeyDown}
            onPasswordAction={handlePasswordAction}
          />
        ) : (
          <InvitationActionPanel
            mode="accept"
            busy={busy}
            submitting={submitting}
            onAcceptAction={handleAcceptAction}
          />
        )}
      </section>
    </main>
  )
}
