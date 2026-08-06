'use client'

import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  hasControlAdminBridgeAlertOverrides,
  resetControlAdminBridgeAlerts,
} from '@components/AdminBridgeAlerts'
import { useAuth } from '@components/AuthContext'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { useSettingsData } from '@components/SettingsDataContext'
import { IconThemeMoon, IconThemeSun } from '@components/Sidebar/icons'
import { useTheme } from '@components/ThemeContext'
import { useToast } from '@components/Toast'
import { Button, Field, TextInput } from '@components/ui'
import {
  requestControlUISettingsEmailChange,
  updateControlUISettingsPassword,
  updateControlUISettingsUsername,
} from '@lib/api'
import packageJson from '../../package.json'

type EditingField = 'email' | 'username' | null

interface ControlSettingsPanelProps {
  emailConfirmationStatus?: string | null
  section: 'account' | 'ui'
}

export function ControlSettingsPanel({
  emailConfirmationStatus,
  section,
}: ControlSettingsPanelProps) {
  const { checkAuth, logout } = useAuth()
  const {
    accountError: error,
    accountLoading: loading,
    profile,
    updatePendingEmailChange,
    updateProfile,
  } = useSettingsData()
  const { setThemeMode, themeMode } = useTheme()
  const searchParams = useSearchParams()
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [pendingEmailChange, setPendingEmailChange] = useState<{
    email: string
    expiresAt: string
    createdAt: string
  } | null>(null)
  const [draftEmail, setDraftEmail] = useState('')
  const [draftUsername, setDraftUsername] = useState('')
  const [editingField, setEditingField] = useState<EditingField>(null)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [hasResettableAlerts, setHasResettableAlerts] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  useEffect(() => {
    if (section !== 'account' || !profile) return
    const loadedEmail = profile.email || ''
    const loadedUsername = profile.username || ''
    setEmail(loadedEmail)
    setUsername(loadedUsername)
    setPendingEmailChange(profile.pendingEmailChange || null)
    setDraftEmail(loadedEmail)
    setDraftUsername(loadedUsername)
  }, [profile, section])

  useEffect(() => {
    if (section !== 'account' || loading || searchParams.get('focus') !== 'email') return
    beginEditing('email')
    window.setTimeout(() => {
      const emailInput = document.querySelector<HTMLInputElement>('input[aria-label="Email"]')
      emailInput?.focus()
    }, 0)
  }, [loading, searchParams, section])

  useEffect(() => {
    function updateResettableAlerts() {
      setHasResettableAlerts(hasControlAdminBridgeAlertOverrides())
    }
    updateResettableAlerts()
    window.addEventListener('control-admin-bridge-alerts-changed', updateResettableAlerts)
    window.addEventListener('control-admin-bridge-alerts-reset', updateResettableAlerts)
    return () => {
      window.removeEventListener('control-admin-bridge-alerts-changed', updateResettableAlerts)
      window.removeEventListener('control-admin-bridge-alerts-reset', updateResettableAlerts)
    }
  }, [])

  const canSaveEmail = useMemo(
    () => draftEmail.trim().length > 0 && !savingProfile && !loading,
    [draftEmail, loading, savingProfile]
  )

  const canSaveUsername = useMemo(
    () => draftUsername.trim().length > 0 && !savingProfile && !loading,
    [draftUsername, loading, savingProfile]
  )

  const canSavePassword = useMemo(
    () =>
      currentPassword.length > 0 &&
      newPassword.length >= 8 &&
      confirmPassword.length > 0 &&
      !savingPassword,
    [confirmPassword, currentPassword, newPassword, savingPassword]
  )

  function beginEditing(field: EditingField) {
    setProfileError('')
    setEditingField(field)
    setDraftEmail(field === 'email' ? pendingEmailChange?.email || email : email)
    setDraftUsername(username)
  }

  function cancelEditing() {
    setEditingField(null)
    setProfileError('')
    setDraftEmail(email)
    setDraftUsername(username)
  }

  function closePasswordModal() {
    if (savingPassword) return
    setShowPasswordModal(false)
    setPasswordError('')
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
  }

  async function saveUsername(nextUsername: string) {
    setSavingProfile(true)
    setProfileError('')
    try {
      const response = await updateControlUISettingsUsername(nextUsername)
      const nextPendingEmailChange = response.me.pendingEmailChange || pendingEmailChange
      updateProfile({ ...response.me, pendingEmailChange: nextPendingEmailChange })
      setEmail(response.me.email || '')
      setUsername(response.me.username || '')
      setPendingEmailChange(nextPendingEmailChange)
      setDraftEmail(response.me.email || '')
      setDraftUsername(response.me.username || '')
      setEditingField(null)
      await checkAuth()
      showToast('Username updated.', { tone: 'success' })
    } catch (saveError) {
      setProfileError(saveError instanceof Error ? saveError.message : 'Failed to update username')
    } finally {
      setSavingProfile(false)
    }
  }

  async function requestEmailChange(nextEmail: string) {
    setSavingProfile(true)
    setProfileError('')
    try {
      const response = await requestControlUISettingsEmailChange(nextEmail)
      setPendingEmailChange({
        email: response.confirmation.email,
        expiresAt: response.confirmation.expiresAt,
        createdAt: response.confirmation.createdAt,
      })
      updatePendingEmailChange({
        email: response.confirmation.email,
        expiresAt: response.confirmation.expiresAt,
        createdAt: response.confirmation.createdAt,
      })
      setDraftEmail(email)
      setEditingField(null)
      showToast('Confirmation email sent.', { tone: 'success' })
    } catch (saveError) {
      setProfileError(
        saveError instanceof Error ? saveError.message : 'Failed to send confirmation email'
      )
    } finally {
      setSavingProfile(false)
    }
  }

  async function handleSaveEmail() {
    if (!canSaveEmail) return
    await requestEmailChange(draftEmail.trim().toLowerCase())
  }

  async function handleResendEmailConfirmation() {
    if (!pendingEmailChange || savingProfile) return
    await requestEmailChange(pendingEmailChange.email)
  }

  async function handleResetAlerts() {
    const confirmed = await confirm({
      title: 'Reset alerts?',
      message:
        'Reset hidden and snoozed admin/member access alerts for this browser? Alerts that still apply will start showing again.',
      confirmLabel: 'Reset alerts',
    })
    if (!confirmed) return
    resetControlAdminBridgeAlerts()
    showToast('Alerts reset.', { tone: 'success' })
  }

  async function handleSaveUsername() {
    if (!canSaveUsername) return
    await saveUsername(draftUsername.trim())
  }

  async function handleSavePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSavePassword) return
    setPasswordError('')
    if (newPassword !== confirmPassword) {
      setPasswordError('New password and confirmation must match.')
      return
    }
    setSavingPassword(true)
    try {
      await updateControlUISettingsPassword({
        currentPassword,
        newPassword,
      })
      showToast('Password updated. Sign in again.', { tone: 'success' })
      await logout()
    } catch (saveError) {
      setPasswordError(saveError instanceof Error ? saveError.message : 'Failed to update password')
    } finally {
      setSavingPassword(false)
    }
  }

  if (section === 'ui') {
    return (
      <>
        <div className="cu-settings-version" aria-label="Control UI version">
          <span className="cu-settings-row__label">Control UI version</span>
          <span className="cu-settings-version__value">{packageJson.version}</span>
        </div>
        <section className="cu-settings-section">
          <div className="cu-settings-section__header">
            <span className="cu-settings-section__title">Appearance</span>
          </div>
          <div className="cu-settings-theme-options" role="radiogroup" aria-label="Theme">
            <label
              className={`cu-settings-theme-option${
                themeMode === 'dark' ? ' cu-settings-theme-option--selected' : ''
              }`}
              htmlFor="settings-theme-dark"
              title="Use the darker interface across Control UI."
            >
              <input
                id="settings-theme-dark"
                type="radio"
                name="settings-theme"
                value="dark"
                checked={themeMode === 'dark'}
                onChange={() => setThemeMode('dark')}
              />
              <span className="cu-settings-theme-option__icon" aria-hidden="true">
                <IconThemeMoon />
              </span>
              <span className="cu-settings-theme-option__copy">
                <span className="cu-settings-theme-option__title">Dark</span>
                <span className="cu-settings-theme-option__description">
                  Use the darker interface across Control UI.
                </span>
              </span>
            </label>
            <label
              className={`cu-settings-theme-option${
                themeMode === 'light' ? ' cu-settings-theme-option--selected' : ''
              }`}
              htmlFor="settings-theme-light"
              title="Use the lighter interface across Control UI."
            >
              <input
                id="settings-theme-light"
                type="radio"
                name="settings-theme"
                value="light"
                checked={themeMode === 'light'}
                onChange={() => setThemeMode('light')}
              />
              <span className="cu-settings-theme-option__icon" aria-hidden="true">
                <IconThemeSun />
              </span>
              <span className="cu-settings-theme-option__copy">
                <span className="cu-settings-theme-option__title">Light</span>
                <span className="cu-settings-theme-option__description">
                  Use the lighter interface across Control UI.
                </span>
              </span>
            </label>
          </div>
        </section>
      </>
    )
  }

  return (
    <div className="cu-settings-tab-content">
      <div className="cu-settings-tab-content__body">
        {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
        <div className="cu-settings-sections">
          <section className="cu-settings-section">
            <div className="cu-settings-section__header">
              <span className="cu-settings-section__title">Account info</span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setShowPasswordModal(true)}
              >
                Change password
              </Button>
            </div>
            <div className="cu-settings-list">
              <div
                className={`cu-settings-row${editingField === 'username' ? ' cu-settings-row--editing' : ''}`}
              >
                <div className="cu-settings-row__main">
                  <span className="cu-settings-row__label">Username</span>
                  {editingField === 'username' ? (
                    <div className="cu-settings-row__edit">
                      <TextInput
                        aria-label="Username"
                        value={draftUsername}
                        onChange={event => setDraftUsername(event.target.value)}
                        disabled={savingProfile}
                        autoComplete="username"
                      />
                      <div className="cu-settings-row__actions">
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          disabled={!canSaveUsername}
                          onClick={() => void handleSaveUsername()}
                        >
                          {savingProfile ? 'Saving...' : 'Save'}
                        </Button>
                        <Button type="button" variant="ghost" size="sm" onClick={cancelEditing}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <span className="cu-settings-row__value">
                      {loading ? 'Loading...' : username || 'Not set'}
                    </span>
                  )}
                </div>
                {editingField !== 'username' ? (
                  <div className="cu-settings-row__actions">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => beginEditing('username')}
                      disabled={loading || editingField !== null}
                    >
                      Edit
                    </Button>
                  </div>
                ) : null}
              </div>

              <div
                className={`cu-settings-row${editingField === 'email' ? ' cu-settings-row--editing' : ''}`}
              >
                <div className="cu-settings-row__main">
                  <span className="cu-settings-row__label">Email</span>
                  {editingField === 'email' ? (
                    <div className="cu-settings-row__edit">
                      <TextInput
                        aria-label="Email"
                        type="email"
                        value={draftEmail}
                        onChange={event => setDraftEmail(event.target.value)}
                        disabled={savingProfile}
                        autoComplete="email"
                      />
                      <div className="cu-settings-row__actions">
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          disabled={!canSaveEmail}
                          onClick={() => void handleSaveEmail()}
                        >
                          {savingProfile ? 'Saving...' : 'Save'}
                        </Button>
                        <Button type="button" variant="ghost" size="sm" onClick={cancelEditing}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <span className="cu-settings-row__value">
                        {loading
                          ? 'Loading...'
                          : pendingEmailChange && !email
                            ? `Confirmation sent to ${pendingEmailChange.email}`
                            : email || 'No email set'}
                      </span>
                      {pendingEmailChange && email ? (
                        <span className="cu-settings-row__hint">
                          Confirmation pending for {pendingEmailChange.email}.
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
                {editingField !== 'email' ? (
                  <div className="cu-settings-row__actions">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => beginEditing('email')}
                      disabled={loading || editingField !== null}
                    >
                      Edit
                    </Button>
                    {pendingEmailChange ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleResendEmailConfirmation()}
                        disabled={loading || savingProfile}
                      >
                        Resend confirmation
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
            {emailConfirmationStatus === 'confirmed' ? (
              <div className="cu-banner cu-banner--ok">Email confirmed.</div>
            ) : null}
            {emailConfirmationStatus === 'already' ? (
              <div className="cu-banner cu-banner--info">Email already confirmed.</div>
            ) : null}
            {profileError ? <div className="cu-banner cu-banner--error">{profileError}</div> : null}
          </section>

          {hasResettableAlerts ? (
            <section className="cu-settings-section">
              <div className="cu-settings-section__header">
                <span className="cu-settings-section__title">Alerts</span>
              </div>
              <div className="cu-settings-list">
                <div className="cu-settings-row">
                  <div className="cu-settings-row__main">
                    <span className="cu-settings-row__label">Reset alerts</span>
                    <span className="cu-settings-row__value">
                      Show dismissed account and access alerts again in this browser.
                    </span>
                  </div>
                  <div className="cu-settings-row__actions">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => void handleResetAlerts()}
                    >
                      Reset
                    </Button>
                  </div>
                </div>
              </div>
            </section>
          ) : null}
        </div>
      </div>

      {showPasswordModal ? (
        <div
          className="cu-modal-backdrop"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget) closePasswordModal()
          }}
        >
          <form
            className="cu-modal-panel cu-modal-panel--narrow"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-password-title"
            onSubmit={event => void handleSavePassword(event)}
          >
            <div className="cu-modal-panel__head">
              <h3 id="settings-password-title" className="cu-modal-panel__title">
                Change password
              </h3>
            </div>
            <div className="cu-modal-panel__body">
              <Field label="Current password" htmlFor="settings-current-password" required>
                <TextInput
                  id="settings-current-password"
                  type="password"
                  value={currentPassword}
                  onChange={event => setCurrentPassword(event.target.value)}
                  disabled={savingPassword}
                  autoComplete="current-password"
                />
              </Field>
              <Field label="New password" htmlFor="settings-new-password" required>
                <TextInput
                  id="settings-new-password"
                  type="password"
                  value={newPassword}
                  onChange={event => setNewPassword(event.target.value)}
                  disabled={savingPassword}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Confirm new password" htmlFor="settings-confirm-password" required>
                <TextInput
                  id="settings-confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={event => setConfirmPassword(event.target.value)}
                  disabled={savingPassword}
                  autoComplete="new-password"
                />
              </Field>
              {passwordError ? (
                <div className="cu-banner cu-banner--error">{passwordError}</div>
              ) : null}
            </div>
            <div className="cu-modal-panel__foot">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={closePasswordModal}
                disabled={savingPassword}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" disabled={!canSavePassword}>
                {savingPassword ? 'Saving...' : 'Save password'}
              </Button>
            </div>
          </form>
        </div>
      ) : null}
      {confirmDialog}
    </div>
  )
}
