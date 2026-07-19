'use client'

import { type FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'
import { IconInfoCircle } from '@components/icons'
import { CheckboxField } from '@components/ui'
import { CONTROL_ROUTES } from '@constants/routes'
import { completeControlAdminInvitation } from '@lib/api'
import { deriveUsernameFromEmail } from '@lib/string'

type DesktopAccessTeam = {
  id: string
  name: string
}

type FormFieldName =
  | 'username'
  | 'password'
  | 'confirmPassword'
  | 'memberPassword'
  | 'confirmMemberPassword'

type FieldErrors = Partial<Record<FormFieldName, string>>

function fieldNameFromServer(field: string, message: string): FormFieldName | null {
  const normalizedField = field.trim()
  if (
    normalizedField === 'username' ||
    normalizedField === 'password' ||
    normalizedField === 'confirmPassword' ||
    normalizedField === 'memberPassword' ||
    normalizedField === 'confirmMemberPassword'
  ) {
    return normalizedField
  }

  const normalizedMessage = message.toLowerCase()
  if (normalizedMessage.includes('username')) return 'username'
  if (normalizedMessage.includes('desktop app password and confirmation')) {
    return 'confirmMemberPassword'
  }
  if (normalizedMessage.includes('desktop app password')) return 'memberPassword'
  if (normalizedMessage.includes('password and confirmation')) return 'confirmPassword'
  if (normalizedMessage.includes('confirm your password')) return 'confirmPassword'
  if (normalizedMessage.includes('password must')) return 'password'
  return null
}

interface AdminInvitationFormProps {
  csrfToken: string
  desktopTeams: DesktopAccessTeam[]
  email: string
  hasDesktopAccess: boolean
  initialError?: string
  initialErrorField?: string
  initialUsername?: string
  initialUseSameMemberPassword?: boolean
  token: string
}

export function AdminInvitationForm({
  csrfToken,
  desktopTeams,
  email,
  hasDesktopAccess,
  initialError = '',
  initialErrorField = '',
  initialUsername = '',
  initialUseSameMemberPassword = true,
  token,
}: AdminInvitationFormProps) {
  const router = useRouter()
  const [useSameMemberPassword, setUseSameMemberPassword] = useState(initialUseSameMemberPassword)
  const [username, setUsername] = useState(() => initialUsername || deriveUsernameFromEmail(email))
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [memberPassword, setMemberPassword] = useState('')
  const [confirmMemberPassword, setConfirmMemberPassword] = useState('')
  const [error, setError] = useState(() =>
    initialError && !fieldNameFromServer(initialErrorField, initialError) ? initialError : ''
  )
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>(() => {
    const fieldName = fieldNameFromServer(initialErrorField, initialError)
    return fieldName ? { [fieldName]: initialError } : {}
  })
  const [saving, setSaving] = useState(false)

  function friendlyError(value: unknown): string {
    if (!(value instanceof Error)) return 'Failed to complete admin setup.'
    return value.message.replace(/^\d{3}\s+[A-Za-z ]+\s+-\s+/, '')
  }

  function setSingleFieldError(field: FormFieldName, message: string) {
    setFieldErrors({ [field]: message })
    setError('')
  }

  function setSubmitError(message: string) {
    const fieldName = fieldNameFromServer('', message)
    if (fieldName) {
      setSingleFieldError(fieldName, message)
      return
    }
    setFieldErrors({})
    setError(message)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    setError('')
    setFieldErrors({})
    const normalizedUsername = username.trim()
    if (!email) {
      setError('All fields are required.')
      return
    }
    if (!normalizedUsername) {
      setSingleFieldError('username', 'Username is required.')
      return
    }
    if (!password) {
      setSingleFieldError('password', 'Password is required.')
      return
    }
    if (!confirmPassword) {
      setSingleFieldError('confirmPassword', 'Confirm your password.')
      return
    }
    if (password.length < 8 || password.length > 256) {
      setSingleFieldError('password', 'Password must be between 8 and 256 characters.')
      return
    }
    if (password !== confirmPassword) {
      setSingleFieldError('confirmPassword', 'Password and confirmation must match.')
      return
    }
    if (hasDesktopAccess && !useSameMemberPassword) {
      if (memberPassword.length < 8 || memberPassword.length > 256) {
        setSingleFieldError(
          'memberPassword',
          'Desktop App password must be between 8 and 256 characters.'
        )
        return
      }
      if (memberPassword !== confirmMemberPassword) {
        setSingleFieldError(
          'confirmMemberPassword',
          'Desktop App password and confirmation must match.'
        )
        return
      }
    }

    setSaving(true)
    try {
      const response = await completeControlAdminInvitation({
        token,
        email,
        username: normalizedUsername,
        password,
        useSameMemberPassword: !hasDesktopAccess || useSameMemberPassword,
        memberPassword: hasDesktopAccess && !useSameMemberPassword ? memberPassword : undefined,
      })
      const searchParams = new URLSearchParams({ login: response.login.username })
      router.push(CONTROL_ROUTES.adminInvitations.setupComplete(Object.fromEntries(searchParams)))
    } catch (submitError) {
      setSubmitError(friendlyError(submitError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      method="post"
      action={CONTROL_ROUTES.adminInvitations.complete(token)}
      onSubmit={event => void handleSubmit(event)}
      noValidate
    >
      {/* The signed invitation token intentionally remains in the URL path for email-link UX.
          The form posts directly to Control API, never stores the token in browser storage,
          and Control API validates token expiry before completing setup. */}
      <input type="hidden" name="email" value={email} />
      <input type="hidden" name="csrfToken" value={csrfToken} />
      <div className="cu-admin-invite-email">
        <span className="cu-settings-row__label">Email</span>
        <span className="cu-settings-row__value">{email}</span>
      </div>
      {hasDesktopAccess ? (
        <div className="cu-admin-invite-email">
          <span className="cu-settings-row__label">Desktop App teams</span>
          <span className="cu-settings-row__value">
            {desktopTeams.map(team => team.name).join(', ')}
            {desktopTeams.length === 0 ? 'No teams selected' : ''}
          </span>
        </div>
      ) : null}
      <div className="cu-field">
        <label htmlFor="control-admin-invite-username">
          Username<span className="cu-field__required"> *</span>
        </label>
        <input
          id="control-admin-invite-username"
          name="username"
          className="cu-input"
          value={username}
          onChange={event => setUsername(event.target.value)}
          disabled={saving}
          aria-invalid={Boolean(fieldErrors.username)}
          aria-describedby={
            fieldErrors.username ? 'control-admin-invite-username-error' : undefined
          }
          autoComplete="username"
        />
        {fieldErrors.username ? (
          <span id="control-admin-invite-username-error" className="cu-field__error">
            {fieldErrors.username}
          </span>
        ) : null}
        <span className="cu-field__hint">
          The default is generated from your email. You can change it before continuing.
        </span>
      </div>
      <div className="cu-field">
        <label htmlFor="control-admin-invite-password">
          Password<span className="cu-field__required"> *</span>
        </label>
        <input
          id="control-admin-invite-password"
          name="password"
          className="cu-input"
          type="password"
          value={password}
          onChange={event => setPassword(event.target.value)}
          disabled={saving}
          aria-invalid={Boolean(fieldErrors.password)}
          aria-describedby={
            fieldErrors.password ? 'control-admin-invite-password-error' : undefined
          }
          autoComplete="new-password"
        />
        {fieldErrors.password ? (
          <span id="control-admin-invite-password-error" className="cu-field__error">
            {fieldErrors.password}
          </span>
        ) : null}
      </div>
      <div className="cu-field">
        <label htmlFor="control-admin-invite-password-confirm">
          Confirm password<span className="cu-field__required"> *</span>
        </label>
        <input
          id="control-admin-invite-password-confirm"
          name="confirmPassword"
          className="cu-input"
          type="password"
          value={confirmPassword}
          onChange={event => setConfirmPassword(event.target.value)}
          disabled={saving}
          aria-invalid={Boolean(fieldErrors.confirmPassword)}
          aria-describedby={
            fieldErrors.confirmPassword ? 'control-admin-invite-password-confirm-error' : undefined
          }
          autoComplete="new-password"
        />
        {fieldErrors.confirmPassword ? (
          <span id="control-admin-invite-password-confirm-error" className="cu-field__error">
            {fieldErrors.confirmPassword}
          </span>
        ) : null}
      </div>
      {hasDesktopAccess ? (
        <>
          <CheckboxField
            className="cu-checkbox-field--centered cu-desktop-password-toggle"
            checked={useSameMemberPassword}
            disabled={saving}
            name="useSameMemberPassword"
            value="true"
            onChange={event => setUseSameMemberPassword(event.currentTarget.checked)}
            label={
              <span className="cu-inline-label">
                Use same password for Desktop App
                <span
                  className="cu-inline-help"
                  title="Uncheck to set a separate Desktop App password."
                  aria-label="Uncheck to set a separate Desktop App password."
                >
                  <IconInfoCircle width={14} height={14} />
                </span>
              </span>
            }
          />
          <div className="cu-desktop-password-fields">
            <div className="cu-field">
              <label htmlFor="control-admin-invite-member-password">
                Desktop App password<span className="cu-field__required"> *</span>
              </label>
              <input
                id="control-admin-invite-member-password"
                name="memberPassword"
                className="cu-input"
                type="password"
                value={memberPassword}
                onChange={event => setMemberPassword(event.target.value)}
                disabled={saving}
                aria-invalid={Boolean(fieldErrors.memberPassword)}
                aria-describedby={
                  fieldErrors.memberPassword
                    ? 'control-admin-invite-member-password-error'
                    : undefined
                }
                autoComplete="new-password"
              />
              {fieldErrors.memberPassword ? (
                <span id="control-admin-invite-member-password-error" className="cu-field__error">
                  {fieldErrors.memberPassword}
                </span>
              ) : null}
            </div>
            <div className="cu-field">
              <label htmlFor="control-admin-invite-member-password-confirm">
                Confirm Desktop App password<span className="cu-field__required"> *</span>
              </label>
              <input
                id="control-admin-invite-member-password-confirm"
                name="confirmMemberPassword"
                className="cu-input"
                type="password"
                value={confirmMemberPassword}
                onChange={event => setConfirmMemberPassword(event.target.value)}
                disabled={saving}
                aria-invalid={Boolean(fieldErrors.confirmMemberPassword)}
                aria-describedby={
                  fieldErrors.confirmMemberPassword
                    ? 'control-admin-invite-member-password-confirm-error'
                    : undefined
                }
                autoComplete="new-password"
              />
              {fieldErrors.confirmMemberPassword ? (
                <span
                  id="control-admin-invite-member-password-confirm-error"
                  className="cu-field__error"
                >
                  {fieldErrors.confirmMemberPassword}
                </span>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
      {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
      <button
        type="submit"
        className="cu-btn cu-btn--primary cu-btn--block cu-login-submit"
        disabled={saving}
      >
        {saving ? (
          <span className="cu-btn__content">
            <span className="cu-btn__spinner" aria-hidden="true" />
            <span>Finishing...</span>
          </span>
        ) : (
          'Finish setup'
        )}
      </button>
    </form>
  )
}
