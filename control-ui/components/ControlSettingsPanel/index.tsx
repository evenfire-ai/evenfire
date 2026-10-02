'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { SimpleEditDialog, SingleValueEditDialog } from '@clerum/frontend-components'
import {
  hasControlAdminBridgeAlertOverrides,
  resetControlAdminBridgeAlerts,
} from '@components/AdminBridgeAlerts'
import { useAuth } from '@components/AuthContext'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { IconSettings, IconThemeMoon, IconThemeSun } from '@components/Sidebar/icons'
import { TablePanelHeader } from '@components/TablePanelHeader'
import { useTheme } from '@components/ThemeContext'
import { useToast } from '@components/Toast'
import { Button, Field, TextInput } from '@components/ui'
import {
  getControlUISettingsMe,
  requestControlUISettingsEmailChange,
  updateControlUISettingsPassword,
  updateControlUISettingsUsername,
} from '@lib/api'
import packageJson from '../../package.json'

type EditingField = 'email' | 'username' | null

interface ControlSettingsPanelProps {
  emailConfirmationStatus?: string | null
}

export function ControlSettingsPanel({ emailConfirmationStatus }: ControlSettingsPanelProps) {
  const { checkAuth, logout } = useAuth()
  const { setThemeMode, themeMode } = useTheme()
  const searchParams = useSearchParams()
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [loading, setLoading] = useState(true)
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)
  const [error, setError] = useState('')
  const [profileError, setProfileError] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [pendingEmailChange, setPendingEmailChange] = useState<{
    email: string
    expiresAt: string
    createdAt: string
  } | null>(null)
  const [editingField, setEditingField] = useState<EditingField>(null)
  const [emailValid, setEmailValid] = useState(true)
  const [usernameValid, setUsernameValid] = useState(true)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [hasResettableAlerts, setHasResettableAlerts] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError('')
      try {
        const settingsResponse = await getControlUISettingsMe()
        if (!cancelled) {
          const loadedEmail = settingsResponse.me.email || ''
          const loadedUsername = settingsResponse.me.username || ''
          setEmail(loadedEmail)
          setUsername(loadedUsername)
          setPendingEmailChange(settingsResponse.me.pendingEmailChange || null)
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load settings')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (loading || searchParams.get('focus') !== 'email') return
    beginEditing('email')
    window.setTimeout(() => {
      const emailInput = document.querySelector<HTMLInputElement>('input[aria-label="Email"]')
      emailInput?.focus()
    }, 0)
  }, [loading, searchParams])

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
    setEmailValid(true)
    setUsernameValid(true)
    setEditingField(field)
  }

  function cancelEditing() {
    setEditingField(null)
    setProfileError('')
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
      setEmail(response.me.email || '')
      setUsername(response.me.username || '')
      setPendingEmailChange(response.me.pendingEmailChange || pendingEmailChange)
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

  async function handleSavePassword() {
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

  return (
    <div className="cu-card cu-card--viewport-fill cu-settings-card">
      <TablePanelHeader
        title={
          <>
            <IconSettings />
            Settings
          </>
        }
        subtitle="Manage your Control UI admin account and theme."
      />
      <div className="cu-card__body">
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
              <div className="cu-settings-row">
                <div className="cu-settings-row__main">
                  <span className="cu-settings-row__label">Username</span>
                  <span className="cu-settings-row__value">
                    {loading ? 'Loading...' : username || 'Not set'}
                  </span>
                </div>
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
              </div>

              <div className="cu-settings-row">
                <div className="cu-settings-row__main">
                  <span className="cu-settings-row__label">Email</span>
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
                </div>
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
            <div className="cu-settings-list">
              {hasResettableAlerts ? (
                <div className="cu-settings-row">
                  <div className="cu-settings-row__main">
                    <span className="cu-settings-row__label">Reset Alerts</span>
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
              ) : null}
            </div>
          </section>
        </div>
        <div className="cu-settings-version" aria-label="Control UI version">
          <span className="cu-settings-row__label">Control UI version</span>
          <span className="cu-settings-version__value">{packageJson.version}</span>
        </div>
      </div>

      <SingleValueEditDialog
        open={editingField === 'username'}
        initialValue={username}
        title="Edit username"
        description="Choose the username shown for this Control UI admin account."
        pending={savingProfile}
        error={editingField === 'username' ? profileError : undefined}
        isValid={usernameValid}
        onDismiss={cancelEditing}
        onSave={nextUsername => void saveUsername(nextUsername.trim())}
        renderEditor={({ value, onChange, disabled }) => (
          <Field label="Username" htmlFor="settings-username" required>
            <TextInput
              id="settings-username"
              aria-label="Username"
              value={value}
              onChange={event => {
                const nextValue = event.target.value
                setUsernameValid(nextValue.trim().length > 0)
                onChange(nextValue)
              }}
              disabled={disabled}
              autoComplete="username"
            />
          </Field>
        )}
      />

      <SingleValueEditDialog
        open={editingField === 'email'}
        initialValue={pendingEmailChange?.email || email}
        title="Change email"
        description="We will send a confirmation link before replacing your current email."
        pending={savingProfile}
        error={editingField === 'email' ? profileError : undefined}
        isValid={emailValid}
        saveLabel="Send confirmation"
        onDismiss={cancelEditing}
        onSave={nextEmail => void requestEmailChange(nextEmail.trim().toLowerCase())}
        renderEditor={({ value, onChange, disabled }) => (
          <Field label="Email" htmlFor="settings-email" required>
            <TextInput
              id="settings-email"
              aria-label="Email"
              type="email"
              value={value}
              onChange={event => {
                const nextValue = event.target.value
                setEmailValid(nextValue.trim().length > 0)
                onChange(nextValue)
              }}
              disabled={disabled}
              autoComplete="email"
            />
          </Field>
        )}
      />

      <SimpleEditDialog
        open={showPasswordModal}
        title="Change password"
        description="Confirm your current password, then choose a new password."
        pending={savingPassword}
        error={passwordError}
        isDirty={currentPassword.length > 0 || newPassword.length > 0 || confirmPassword.length > 0}
        isValid={canSavePassword}
        saveLabel="Save password"
        onCancel={closePasswordModal}
        onSave={() => void handleSavePassword()}
      >
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
        </div>
      </SimpleEditDialog>
      {confirmDialog}
    </div>
  )
}
