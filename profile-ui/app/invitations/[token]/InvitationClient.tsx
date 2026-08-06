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
import Image from 'next/image'
import { Button } from '@components/Button'
import { FormField } from '@components/FormField'
import { TextInput } from '@components/TextInput'
import { PROFILE_ROUTES } from '@constants/routes'
import {
  acceptInvitation,
  getEvenfireDownloadUrl,
  setupInvitationPasswordWithToken,
  startMicrosoftIdentityProviderLogin,
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
  if (
    invitation.identityProvider === 'microsoft' &&
    invitation.status === 'accepted' &&
    !invitation.identityProviderLinked
  ) {
    return 'Connect your Microsoft work or school account to finish joining Evenfire.'
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
  const [usePasswordInstead, setUsePasswordInstead] = useState(false)
  const [submitting, setSubmitting] = useState<'accept' | 'password' | 'provider' | null>(null)
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
  const isMicrosoftInvitation = invitation?.identityProvider === 'microsoft'
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
  const busy = submitting !== null

  function friendlyInvitationError(value: unknown): string {
    if (!(value instanceof Error)) return 'Failed to update invitation.'
    const message = value.message.replace(/^\d{3}\s+[A-Za-z ]+\s+-\s+/, '')
    if (message === 'invalid_password') return 'Password must be between 8 and 256 characters.'
    if (message === 'invitation_not_accepted')
      return 'Accept the invitation before setting a password.'
    if (message === 'invitation_not_pending') return 'This invitation has already been used.'
    if (message === 'invitation_not_ready')
      return 'This invitation is not ready for password setup.'
    if (message === 'expired') return 'This invitation has expired.'
    if (message === 'forbidden') return 'Invitation email does not match.'
    if (message === 'not_found') return 'Invitation not found.'
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
    if (!invitation || busy || actionInFlightRef.current) return
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
      applyInvitationUpdate({
        ...invitation,
        ...response,
        status: response.status || 'accepted',
        passwordPending: false,
      })
    } catch (nextError) {
      setError(friendlyInvitationError(nextError))
    } finally {
      actionInFlightRef.current = false
      setSubmitting(null)
    }
  }

  async function handleMicrosoftConnect() {
    if (!invitation?.identityProviderConnectionId || busy || actionInFlightRef.current) return
    actionInFlightRef.current = true
    setSubmitting('provider')
    setError('')
    try {
      const callbackUrl = new URL('/auth/provider-callback', window.location.origin)
      callbackUrl.searchParams.set('next', `/invitations/${encodeURIComponent(invitationToken)}`)
      const response = await startMicrosoftIdentityProviderLogin({
        connectionId: invitation.identityProviderConnectionId,
        flow: 'invitation_link',
        invitationToken,
        returnUrl: callbackUrl.toString(),
      })
      window.location.assign(response.authorizeUrl)
    } catch (nextError) {
      actionInFlightRef.current = false
      setSubmitting(null)
      setError(nextError instanceof Error ? nextError.message : 'Microsoft connection failed')
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

        {error ? <div className="message message--error">{error}</div> : null}

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

        {!invitation ? null : isMicrosoftInvitation &&
          invitation.status === 'accepted' &&
          !invitation.identityProviderLinked &&
          !usePasswordInstead ? (
          <div className="stack">
            <Button
              type="button"
              className="cu-provider-login__button"
              disabled={busy}
              onClick={() => void handleMicrosoftConnect()}
            >
              <Image src="/brand/microsoft.svg" alt="" width={21} height={21} aria-hidden="true" />
              {submitting === 'provider' ? 'Opening Microsoft...' : 'Connect with Microsoft'}
            </Button>
            <button
              type="button"
              className="text-link cu-auth-secondary-action"
              disabled={busy}
              onClick={() => setUsePasswordInstead(true)}
            >
              Use password instead
            </button>
          </div>
        ) : (isPasswordReset && invitation.status === 'pending') ||
          (invitation.status === 'accepted' &&
            invitation.passwordPending &&
            (!isMicrosoftInvitation || usePasswordInstead)) ? (
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
            {isMicrosoftInvitation ? (
              <button
                type="button"
                className="text-link cu-auth-secondary-action"
                disabled={busy}
                onClick={() => setUsePasswordInstead(false)}
              >
                Use Microsoft instead
              </button>
            ) : null}
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
