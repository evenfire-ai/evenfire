'use client'

import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { Button } from '@components/Button'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { FormField } from '@components/FormField'
import { ProfileBodySkeleton } from '@components/ProfileBodySkeleton'
import { ProfileShell } from '@components/ProfileShell'
import { TextInput } from '@components/TextInput'
import { useToast } from '@components/Toast'
import { IconCopy } from '@components/icons'
import { PROFILE_ROUTES } from '@constants/routes'
import {
  getConfiguredExternalRestApiBaseUrl,
  getDesktopEnvironment,
  getMe,
  isSilentApiError,
  updatePassword,
  updateProfile,
} from '@lib/api'
import {
  buildDesktopEnvironmentLink,
  isDesktopEnvironmentHandoffEnabled,
  navigateToDesktopApp,
} from '@lib/desktopAppLinks'
import {
  EMPTY_PROFILE_CHANNELS,
  addDraftRow,
  channelsToDraft,
  draftToChannels,
  normalizeProfileChannels,
  removeDraftRow,
  updateDraftRow,
} from '@lib/profileSettings'
import { refreshReleaseIdentity } from '@lib/releaseIdentity'
import type { DesktopEnvironmentResponse } from '@/app/types/api'
import type { Me } from '@/app/types/profile'
import { SettingsChannelSection } from './SettingsChannelSection'
import { SettingsPageHeader } from './SettingsPageHeader'
import { SettingsTabs } from './SettingsTabs'
import { EMAIL_CHANNEL_SECTION } from './constants'
import type {
  ProfileChannelDraft,
  ProfileChannelKey,
  ProfileChannelSection,
  ReadonlyChannelValue,
} from './types'

type LoadState = 'loading' | 'ready' | 'error'
type EditScope = 'profile' | null

export function SettingsContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { checkAuth, logout } = useAuth()
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [me, setMe] = useState<Me | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [draft, setDraft] = useState<ProfileChannelDraft>(() =>
    channelsToDraft(EMPTY_PROFILE_CHANNELS)
  )
  const [state, setState] = useState<LoadState>('loading')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editScope, setEditScope] = useState<EditScope>(null)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [showDesktopSetupModal, setShowDesktopSetupModal] = useState(false)
  const [desktopEnvironment, setDesktopEnvironment] = useState<DesktopEnvironmentResponse | null>(
    null
  )
  const [desktopSetupBusy, setDesktopSetupBusy] = useState(false)
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const formDisabled = busy || state === 'loading'
  const configuredExternalRestApiBaseUrl = useMemo(() => getConfiguredExternalRestApiBaseUrl(), [])
  const desktopSetupExternalRestApiBaseUrl =
    desktopEnvironment?.externalRestApiBaseUrl || configuredExternalRestApiBaseUrl

  useEffect(() => {
    if (searchParams.get('action') === 'password') {
      setPasswordError('')
      setShowPasswordModal(true)
    }
  }, [searchParams])

  async function loadAll(forceAccess = false) {
    setState('loading')
    setError('')
    // An explicit Refresh re-reads the release too, so a label left on
    // "Release unavailable" by a transient failure heals here instead of
    // waiting for a remount. Deliberately not on the mount path: that would
    // defeat the per-session cache the label shares with the sidebar.
    if (forceAccess) void refreshReleaseIdentity()
    try {
      const current = await getMe()
      const channels = normalizeProfileChannels(current.profile.channels)
      setMe({ ...current, profile: { ...current.profile, channels } })
      setDisplayName(current.profile.displayName || current.name || current.email)
      setDraft(channelsToDraft(channels))
      setState('ready')
    } catch (err) {
      if (isSilentApiError(err)) return
      setState('error')
      setError(err instanceof Error ? err.message : 'Failed to load profile settings')
    }
  }

  useEffect(() => {
    void loadAll()
  }, [])

  function updateChannel(key: ProfileChannelKey, rowId: string, value: string) {
    setDraft(current => updateDraftRow(current, key, rowId, value))
  }

  function addChannel(key: ProfileChannelKey) {
    setDraft(current => addDraftRow(current, key))
  }

  async function removeChannel(key: ProfileChannelKey, rowId: string) {
    const shouldRemove = await confirm({
      title: 'Remove profile value?',
      message: 'Remove this value from your profile draft?',
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!shouldRemove) return
    setDraft(current => removeDraftRow(current, key, rowId))
  }

  function resetDraftFromCurrentProfile() {
    if (!me) return
    const channels = normalizeProfileChannels(me.profile.channels)
    setDisplayName(me.profile.displayName || me.name || me.email)
    setDraft(channelsToDraft(channels))
  }

  function closeEditModal() {
    resetDraftFromCurrentProfile()
    setEditScope(null)
  }

  function closePasswordModal() {
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setPasswordError('')
    setShowPasswordModal(false)
  }

  async function saveProfile() {
    setBusy(true)
    setError('')
    try {
      const updated = await updateProfile(displayName, draftToChannels(draft))
      const channels = normalizeProfileChannels(updated.channels)
      setMe(current =>
        current
          ? {
              ...current,
              profile: {
                ...current.profile,
                displayName: updated.displayName || current.email,
                channels,
              },
            }
          : current
      )
      setDisplayName(updated.displayName || me?.email || '')
      setDraft(channelsToDraft(channels))
      await checkAuth()
      setEditScope(null)
      showToast('Profile settings saved.', { tone: 'success' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save profile settings')
    } finally {
      setBusy(false)
    }
  }

  async function submitPasswordUpdate() {
    setPasswordError('')
    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters.')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match.')
      return
    }
    setPasswordBusy(true)
    try {
      await updatePassword(currentPassword, newPassword)
      closePasswordModal()
      showToast('Password updated. Sign in again.', { tone: 'success' })
      const nextEmail = me?.email || ''
      logout()
      router.replace(PROFILE_ROUTES.login({ email: nextEmail }))
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : 'Failed to update password')
    } finally {
      setPasswordBusy(false)
    }
  }

  async function openDesktopSetupModal() {
    setShowDesktopSetupModal(true)
    setDesktopSetupBusy(true)
    setDesktopEnvironment(null)
    try {
      setDesktopEnvironment(await getDesktopEnvironment())
    } catch {
      setDesktopEnvironment(null)
    } finally {
      setDesktopSetupBusy(false)
    }
  }

  async function copyDesktopEnvironmentUrl() {
    if (!desktopSetupExternalRestApiBaseUrl) return
    await navigator.clipboard.writeText(desktopSetupExternalRestApiBaseUrl)
    showToast('External REST API copied.', { tone: 'success' })
  }

  function openDesktopAppSetup() {
    const desktopEnvironmentLink = buildDesktopEnvironmentLink(desktopEnvironment)
    if (!desktopEnvironmentLink) return
    navigateToDesktopApp(desktopEnvironmentLink)
  }

  return (
    <ProfileShell currentRoute="settings">
      <div className="profile-page">
        <SettingsPageHeader
          disabled={formDisabled}
          spinning={state === 'loading'}
          refreshAriaLabel={state === 'loading' ? 'Refreshing settings' : 'Refresh settings'}
          onRefresh={() => void loadAll(true)}
          actions={
            <Button variant="secondary" onClick={openDesktopSetupModal} disabled={formDisabled}>
              Setup desktop app
            </Button>
          }
        />
        <SettingsTabs active="profile" />

        {error && <div className="message message--error">{error}</div>}

        {state === 'loading' ? (
          <ProfileBodySkeleton
            label="Loading settings"
            sections={[{ title: 'Profile', actions: ['Update password', 'Edit'], rows: 3 }]}
          />
        ) : (
          <section className="section settings-section">
            <div className="settings-section-head">
              <div>
                <h2 className="section-title">Profile</h2>
                <p className="body-copy">
                  Manage your profile name, account email, and contact email values.
                </p>
              </div>
              <div className="toolbar">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPasswordError('')
                    setShowPasswordModal(true)
                  }}
                  disabled={formDisabled}
                >
                  Update password
                </Button>
                <Button onClick={() => setEditScope('profile')} disabled={formDisabled}>
                  Edit
                </Button>
              </div>
            </div>
            <div className="settings-profile-grid">
              <ReadonlyValue label="Display name" value={displayName || 'No display name'} />
              <ReadonlyValue label="Login email" value={me?.email || 'Unavailable'} />
              <ReadonlyChannelSection
                section={EMAIL_CHANNEL_SECTION}
                rows={draft[EMAIL_CHANNEL_SECTION.key]}
              />
            </div>
          </section>
        )}
      </div>

      {editScope ? (
        <SettingsEditModal
          busy={busy}
          title="Edit profile"
          onClose={closeEditModal}
          onSubmit={() => void saveProfile()}
        >
          {editScope === 'profile' ? (
            <div className="settings-profile-grid">
              <FormField label="Display name">
                <TextInput
                  value={displayName}
                  onChange={event => setDisplayName(event.target.value)}
                  placeholder="Your name"
                  disabled={formDisabled}
                />
              </FormField>
              <div className="form-field">
                <span className="form-field__label">Login email</span>
                <div className="settings-readonly-field">{me?.email || 'Unavailable'}</div>
              </div>
              <SettingsChannelSection
                section={EMAIL_CHANNEL_SECTION}
                rows={draft[EMAIL_CHANNEL_SECTION.key]}
                disabled={formDisabled}
                onUpdate={updateChannel}
                onRemove={removeChannel}
                onAdd={addChannel}
              />
            </div>
          ) : null}
        </SettingsEditModal>
      ) : null}

      {showPasswordModal ? (
        <div
          className="cu-modal-backdrop"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget && !passwordBusy) closePasswordModal()
          }}
        >
          <section
            className="cu-modal-panel cu-modal-panel--narrow"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-password-title"
            onMouseDown={event => event.stopPropagation()}
          >
            <div className="cu-modal-panel__head">
              <h3 id="settings-password-title" className="cu-modal-panel__title">
                Update password
              </h3>
              <button
                type="button"
                className="cu-btn cu-btn--ghost"
                onClick={closePasswordModal}
                disabled={passwordBusy}
              >
                Close
              </button>
            </div>
            <div className="cu-modal-panel__body">
              <FormField label="Current password">
                <TextInput
                  type="password"
                  value={currentPassword}
                  onChange={event => setCurrentPassword(event.target.value)}
                  autoComplete="current-password"
                  disabled={passwordBusy}
                />
              </FormField>
              <FormField label="New password">
                <TextInput
                  type="password"
                  value={newPassword}
                  onChange={event => setNewPassword(event.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  disabled={passwordBusy}
                />
              </FormField>
              <FormField label="Confirm new password">
                <TextInput
                  type="password"
                  value={confirmPassword}
                  onChange={event => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  disabled={passwordBusy}
                />
              </FormField>
              {passwordError ? <div className="message message--error">{passwordError}</div> : null}
            </div>
            <div className="cu-modal-panel__foot">
              <Button variant="secondary" onClick={closePasswordModal} disabled={passwordBusy}>
                Cancel
              </Button>
              <Button
                onClick={() => void submitPasswordUpdate()}
                disabled={passwordBusy || !currentPassword || !newPassword || !confirmPassword}
              >
                {passwordBusy ? 'Updating...' : 'Update password'}
              </Button>
            </div>
          </section>
        </div>
      ) : null}
      {showDesktopSetupModal ? (
        <DesktopSetupModal
          busy={desktopSetupBusy}
          handoffEnabled={isDesktopEnvironmentHandoffEnabled()}
          environment={desktopEnvironment}
          externalRestApiBaseUrl={desktopSetupExternalRestApiBaseUrl}
          onClose={() => setShowDesktopSetupModal(false)}
          onCopy={copyDesktopEnvironmentUrl}
          onOpenDesktop={openDesktopAppSetup}
        />
      ) : null}
      {confirmDialog}
    </ProfileShell>
  )
}

function ReadonlyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="settings-channel-section">
      <span className="form-field__label">{label}</span>
      <div className="settings-readonly-field">{value}</div>
    </div>
  )
}

function ReadonlyChannelSection({
  section,
  rows,
  readonlyValues = [],
}: {
  section: ProfileChannelSection
  rows: ProfileChannelDraft[ProfileChannelKey]
  readonlyValues?: ReadonlyChannelValue[]
}) {
  const values = rows.map(row => row.value.trim()).filter(Boolean)
  const hasValues = values.length > 0 || readonlyValues.length > 0

  return (
    <div className="settings-channel-section">
      <div>
        <h3 className="settings-subtitle">{section.title}</h3>
        <p className="settings-help">{section.description}</p>
      </div>
      {!hasValues ? <div className="small muted">No values added.</div> : null}
      {values.map(value => (
        <div className="settings-readonly-field" key={value}>
          {value}
        </div>
      ))}
      {readonlyValues.map(value => (
        <div className="settings-readonly-field" key={value.id}>
          {value.value}
        </div>
      ))}
    </div>
  )
}

function DesktopSetupModal({
  busy,
  handoffEnabled,
  environment,
  externalRestApiBaseUrl,
  onClose,
  onCopy,
  onOpenDesktop,
}: {
  busy: boolean
  handoffEnabled: boolean
  environment: DesktopEnvironmentResponse | null
  externalRestApiBaseUrl: string
  onClose: () => void
  onCopy: () => void
  onOpenDesktop: () => void
}) {
  return (
    <div
      className="cu-modal-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section
        className="cu-modal-panel cu-modal-panel--narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-desktop-setup-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="cu-modal-panel__head">
          <h3 id="settings-desktop-setup-title" className="cu-modal-panel__title">
            Setup desktop app
          </h3>
          <button type="button" className="cu-btn cu-btn--ghost" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
        <div className="cu-modal-panel__body">
          <div className="form-field">
            <span className="form-field__label">External REST API</span>
            <div className="settings-desktop-url-field">
              <span className="settings-desktop-url-field__value">
                {externalRestApiBaseUrl || (busy ? 'Loading...' : 'Unavailable')}
              </span>
              <Button
                variant="secondary"
                className="settings-desktop-url-field__copy"
                onClick={onCopy}
                disabled={!externalRestApiBaseUrl}
                aria-label="Copy External REST API URL"
                title="Copy External REST API URL"
              >
                <IconCopy />
              </Button>
            </div>
          </div>
          {handoffEnabled ? (
            <div className="settings-desktop-setup-actions">
              <Button
                onClick={onOpenDesktop}
                disabled={busy || !environment?.externalRestApiBaseUrl}
              >
                Open desktop app and setup
              </Button>
            </div>
          ) : (
            <p className="settings-help">
              Automatic Desktop handoff is temporarily unavailable. You can copy this API URL and
              add it in Desktop.
            </p>
          )}
        </div>
      </section>
    </div>
  )
}

function SettingsEditModal({
  busy,
  children,
  onClose,
  onSubmit,
  title,
}: {
  busy: boolean
  children: React.ReactNode
  onClose: () => void
  onSubmit: () => void
  title: string
}) {
  return (
    <div
      className="cu-modal-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section
        className="cu-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-edit-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="cu-modal-panel__head">
          <h3 id="settings-edit-title" className="cu-modal-panel__title">
            {title}
          </h3>
          <button type="button" className="cu-btn cu-btn--ghost" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
        <div className="cu-modal-panel__body">{children}</div>
        <div className="cu-modal-panel__foot">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={busy}>
            {busy ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </section>
    </div>
  )
}
