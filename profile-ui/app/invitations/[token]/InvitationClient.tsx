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
import { useRouter } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { Button } from '@components/Button'
import { FormField } from '@components/FormField'
import { TextInput } from '@components/TextInput'
import { PROFILE_ROUTES } from '@constants/routes'
import {
  acceptInvitation,
  getEvenfireDownloadUrl,
  setupInvitationPasswordWithToken,
} from '@lib/api'
import {
  buildInvitationHeading,
  buildInvitationTeamsLabel,
  formatRemaining,
} from '@lib/invitations'
import { formatTeamRole } from '@lib/teamRoles'
import type { InvitationPreview } from '@/app/types/api'
import type { InvitationClientProps } from './types'

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
  const message = value.message.replace(/^\d{3}\s+[A-Za-z ]+\s+-\s+/, '')
  if (message === 'recovery_outcome_unknown') return true
  if (value instanceof TypeError || value.name === 'SyntaxError') return true
  const status = value.message.match(/^\s*(\d{3})\b/)
  return Boolean(
    status &&
    Number(status[1]) >= 500 &&
    !message.includes('authority_unavailable') &&
    !message.includes('rate_limited')
  )
}

export function InvitationClient({
  invitationToken,
  initialInvitation,
  initialError,
}: InvitationClientProps) {
  const router = useRouter()
  const { checkAuth } = useAuth()
  const [invitation, setInvitation] = useState<InvitationPreview | null>(initialInvitation)
  const [error, setError] = useState(initialError)
  const [status, setStatus] = useState(() =>
    initialInvitation ? statusForInvitation(initialInvitation) : ''
  )
  const [now, setNow] = useState(() => Date.now())
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState<'accept' | 'password' | null>(null)
  const [recoveryCommitted, setRecoveryCommitted] = useState(false)
  const [recoveryOutcomeUnknown, setRecoveryOutcomeUnknown] = useState(false)
  const [sessionCheckInFlight, setSessionCheckInFlight] = useState(false)
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
    setRecoveryCommitted(false)
    setRecoveryOutcomeUnknown(false)
  }, [invitationToken])

  const invitationExpired = useMemo(() => {
    if (!invitation || invitation.status !== 'pending') return false
    return formatRemaining(invitation.expiresAt, now) === 'expired'
  }, [invitation, now])

  const expirationText = useMemo(() => {
    if (!invitation || invitation.status !== 'pending') return ''
    const remaining = formatRemaining(invitation.expiresAt, now)
    return remaining === 'expired'
      ? 'This invitation has expired.'
      : `This invitation will expire in ${remaining}.`
  }, [invitation, now])

  const downloadUrl = getEvenfireDownloadUrl()
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

  function friendlyInvitationError(value: unknown): string {
    if (!(value instanceof Error)) return 'Failed to update invitation.'
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

  async function verifyRecoveredSession(expectedUserId: string) {
    setSessionCheckInFlight(true)
    setError('')
    try {
      const result = await checkAuth()
      if (result.status === 'authenticated') {
        if (result.me.id === expectedUserId) {
          router.replace(PROFILE_ROUTES.home)
          return
        }
        setError(
          'Your password was updated, but the signed-in account does not match this recovery link.'
        )
        return
      }
      setError(
        'Your password was updated, but we could not verify your account session. Try again.'
      )
    } catch {
      setError(
        'Your password was updated, but we could not verify your account session. Try again.'
      )
    } finally {
      setSessionCheckInFlight(false)
    }
  }

  async function retryRecoveredSession() {
    if (!recoveryCommitted || !invitation?.userId || sessionCheckInFlight || busy) return
    await verifyRecoveredSession(invitation.userId)
  }

  async function handlePasswordSubmit() {
    if (
      !invitation ||
      busy ||
      actionInFlightRef.current ||
      (isPasswordReset && (recoveryCommitted || recoveryOutcomeUnknown))
    ) {
      return
    }
    setError('')
    if (password.length < 8 || password.length > 256) {
      setError('Password must be between 8 and 256 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    actionInFlightRef.current = true
    setSubmitting('password')
    try {
      const response = await setupInvitationPasswordWithToken(
        invitationToken,
        invitation.email,
        invitation.id,
        password
      )
      if (isPasswordReset) {
        setRecoveryCommitted(true)
        setStatus('Your password has been updated.')
        setPassword('')
        setConfirmPassword('')
        if (!invitation.userId || response.userId !== invitation.userId) {
          setError(
            'Your password was updated, but the signed-in account does not match this recovery link.'
          )
          return
        }
        await verifyRecoveredSession(invitation.userId)
        return
      }
      applyInvitationUpdate({
        ...invitation,
        ...response,
        status: response.status || 'accepted',
        passwordPending: false,
      })
    } catch (nextError) {
      if (isPasswordReset && isAmbiguousRecoveryOutcome(nextError)) {
        setRecoveryOutcomeUnknown(true)
        setPassword('')
        setConfirmPassword('')
        setError(
          'We could not confirm whether your password change completed. Try signing in with the new password. If that does not work, request a new reset link.'
        )
      } else {
        setError(friendlyInvitationError(nextError))
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

  function buttonLabel(kind: 'accept' | 'password', label: string) {
    if (submitting !== kind) return label
    return (
      <span className="cu-btn__content">
        <span className="cu-btn__spinner" aria-hidden="true" />
        <span>{kind === 'accept' ? 'Accepting...' : 'Saving...'}</span>
      </span>
    )
  }

  return (
    <main className="center-page">
      <section className="page-card">
        <div className="stack-tight">
          <p className="eyebrow">Evenfire Invitation</p>
          <h1 className="page-title page-title--large">
            {isPasswordReset ? 'Reset password' : buildInvitationHeading(invitation?.teamName)}
          </h1>
          <p className="body-copy">
            {status || (error ? 'We could not open this invitation.' : 'Invitation loaded.')}
          </p>
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

        {!invitation ? null : isPasswordReset && recoveryCommitted ? (
          <div className="stack">
            <Button
              type="button"
              disabled={busy || sessionCheckInFlight || !invitation.userId}
              onClick={() => void retryRecoveredSession()}
            >
              {sessionCheckInFlight ? 'Checking account session...' : 'Retry account session check'}
            </Button>
            <a className="cu-btn" href={profileLoginHref}>
              Sign in instead
            </a>
          </div>
        ) : isPasswordReset && recoveryOutcomeUnknown ? (
          <div className="stack">
            <a className="cu-btn cu-btn--primary" href={profileLoginHref}>
              Try signing in
            </a>
            <a className="cu-btn" href={forgotPasswordHref}>
              Request a new recovery link
            </a>
          </div>
        ) : (isPasswordReset && invitation.status === 'pending') ||
          (invitation.status === 'accepted' && invitation.passwordPending) ? (
          <div className="stack">
            <div className="form-card">
              <strong>{isPasswordReset ? 'Set a new password' : 'Set your password'}</strong>
              <div className="muted">
                Use at least 8 characters. This password stays with your Evenfire account.
              </div>
              <FormField label="Password">
                <TextInput
                  name="password"
                  type="password"
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={event => setPassword(event.currentTarget.value)}
                  onKeyDown={handlePasswordKeyDown}
                  disabled={busy}
                  minLength={8}
                  required
                />
              </FormField>
              <FormField label="Confirm password">
                <TextInput
                  name="confirmPassword"
                  type="password"
                  placeholder="Repeat your password"
                  value={confirmPassword}
                  onChange={event => setConfirmPassword(event.currentTarget.value)}
                  onKeyDown={handlePasswordKeyDown}
                  disabled={busy}
                  minLength={8}
                  required
                />
              </FormField>
            </div>
            <Button
              type="button"
              disabled={busy}
              onClick={handlePasswordAction}
              onPointerDown={handlePasswordAction}
            >
              {buttonLabel(
                'password',
                isPasswordReset ? 'Reset password' : 'Set password and continue'
              )}
            </Button>
          </div>
        ) : invitation.status === 'accepted' ? (
          <div className="stack">
            <a
              className="cu-btn cu-btn--primary"
              href={downloadUrl}
              target="_blank"
              rel="noreferrer"
            >
              Download Evenfire
            </a>
            <a className="cu-btn" href={profileLoginHref}>
              Manage Profile
            </a>
          </div>
        ) : invitationExpired ? (
          <div className="message message--error-plain">This invitation has expired.</div>
        ) : (
          <div>
            <Button
              type="button"
              disabled={busy}
              onClick={handleAcceptAction}
              onPointerDown={handleAcceptAction}
            >
              {buttonLabel('accept', 'Accept invitation')}
            </Button>
          </div>
        )}
      </section>
    </main>
  )
}
