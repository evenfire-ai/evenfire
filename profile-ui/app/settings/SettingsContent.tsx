'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type React from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@components/AuthContext'
import { Button } from '@components/Button'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { FormField } from '@components/FormField'
import { ProfileShell } from '@components/ProfileShell'
import { TextInput } from '@components/TextInput'
import { useToast } from '@components/Toast'
import { IconCopy, IconRefresh } from '@components/icons'
import {
  getConfiguredExternalRestApiBaseUrl,
  getDesktopEnvironment,
  getMe,
  isSilentApiError,
  updatePassword,
  updateProfile,
} from '@lib/api'
import {
  disconnectWorkflowApprovalMedium,
  listApprovalChannelTargets,
  listWorkflowApprovalMediums,
} from '@lib/approvalChannels'
import {
  EMPTY_PROFILE_CHANNELS,
  addDraftRow,
  channelsToDraft,
  draftToChannels,
  normalizeProfileChannels,
  removeDraftRow,
  updateDraftRow,
} from '@lib/profileSettings'
import type { DesktopEnvironmentResponse } from '@/app/types/api'
import type {
  ApprovalChannelTarget,
  WorkflowApprovalMediumAccount,
} from '@/app/types/approvalChannels'
import type { Me } from '@/app/types/profile'
import packageJson from '../../package.json'
import { SettingsChannelSection } from './SettingsChannelSection'
import { TelegramVerificationPanel } from './TelegramVerificationPanel'
import { EMAIL_CHANNEL_SECTION, PROFILE_SOCIAL_CHANNEL_TABS } from './constants'
import type {
  ProfileChannelDraft,
  ProfileChannelKey,
  ProfileChannelSection,
  ReadonlyChannelValue,
  SocialChannelTabKey,
} from './types'

type LoadState = 'idle' | 'loading' | 'ready' | 'error'
type SettingsTab = 'profile' | 'social'
type EditScope = 'profile' | null

function LoadingSkeleton() {
  return (
    <div className="profile-skeleton" role="status" aria-label="Loading">
      <span className="profile-skeleton__line profile-skeleton__line--medium" />
      <span className="profile-skeleton__line" />
      <span className="profile-skeleton__line profile-skeleton__line--short" />
    </div>
  )
}

export function SettingsContent({
  activeSettingsTab,
  activeSocialTab,
}: {
  activeSettingsTab: SettingsTab
  activeSocialTab: SocialChannelTabKey
}) {
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
  const [targets, setTargets] = useState<ApprovalChannelTarget[]>([])
  const [accounts, setAccounts] = useState<WorkflowApprovalMediumAccount[]>([])
  const [state, setState] = useState<LoadState>('idle')
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

  const telegramTargets = useMemo(
    () => targets.filter(target => target.medium === 'telegram'),
    [targets]
  )
  const slackTargets = useMemo(() => targets.filter(target => target.medium === 'slack'), [targets])
  const telegramAccounts = useMemo(() => {
    const targetIds = new Set(telegramTargets.map(target => target.id))
    return accounts.filter(
      account =>
        account.medium === 'telegram' &&
        (account.targets || []).some(target => targetIds.has(target.id))
    )
  }, [accounts, telegramTargets])
  const slackAccounts = useMemo(() => {
    const targetIds = new Set(slackTargets.map(target => target.id))
    return accounts.filter(
      account =>
        account.medium === 'slack' &&
        (account.targets || []).some(target => targetIds.has(target.id))
    )
  }, [accounts, slackTargets])
  const visibleSocialTabs = useMemo(
    () =>
      PROFILE_SOCIAL_CHANNEL_TABS.filter(tab => targets.some(target => target.medium === tab.key)),
    [targets]
  )
  const currentSocialTab =
    visibleSocialTabs.find(tab => tab.key === activeSocialTab) || visibleSocialTabs[0] || null
  const hasSocialAccess = visibleSocialTabs.length > 0
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

  async function loadAll() {
    setState('loading')
    setError('')
    try {
      const [current, nextTargets, nextAccounts] = await Promise.all([
        getMe(),
        listApprovalChannelTargets(),
        listWorkflowApprovalMediums({ includeDisabled: true }),
      ])
      const channels = normalizeProfileChannels(current.profile.channels)
      setMe({ ...current, profile: { ...current.profile, channels } })
      setDisplayName(current.profile.displayName || current.name || current.email)
      setDraft(channelsToDraft(channels))
      setTargets(nextTargets)
      setAccounts(nextAccounts)
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

  async function removeApprovalMediumAccount(accountId: string, isDisconnected: boolean) {
    const account = accounts.find(item => item.id === accountId)
    const providerLabel = account?.medium === 'slack' ? 'Slack' : 'Telegram'
    const shouldRemove = await confirm({
      title: isDisconnected
        ? `Remove ${providerLabel} record?`
        : `Delete ${providerLabel} connection?`,
      message: isDisconnected
        ? `Permanently remove this disconnected ${providerLabel} verification record?`
        : `Delete this ${providerLabel} identity connection and stop using it with Evenfire?`,
      confirmLabel: isDisconnected ? 'Remove record' : 'Delete connection',
      tone: 'danger',
    })
    if (!shouldRemove) return
    setBusy(true)
    setError('')
    try {
      await disconnectWorkflowApprovalMedium(accountId)
      setAccounts(await listWorkflowApprovalMediums({ includeDisabled: true }))
      showToast(
        isDisconnected
          ? `Disconnected ${providerLabel} verification record removed.`
          : `${providerLabel} identity disconnected.`,
        { tone: 'success' }
      )
    } catch (err) {
      setError(
        err instanceof Error ? err.message : `Failed to update ${providerLabel} verification`
      )
    } finally {
      setBusy(false)
    }
  }

  const refreshApprovalAccounts = useCallback(async (): Promise<
    WorkflowApprovalMediumAccount[]
  > => {
    const next = await listWorkflowApprovalMediums({ includeDisabled: true })
    setAccounts(next)
    return next
  }, [])

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
      router.replace(nextEmail ? `/?email=${encodeURIComponent(nextEmail)}` : '/')
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
    if (!desktopEnvironment?.externalRestApiBaseUrl) return
    const params = new URLSearchParams()
    params.set('externalRestApiBaseUrl', desktopEnvironment.externalRestApiBaseUrl)
    params.set('tenantName', desktopEnvironment.appName || 'Evenfire')
    window.location.href = `evenfire://desktop-environment?${params.toString()}`
  }

  return (
    <ProfileShell currentRoute="settings">
      <div className="profile-page profile-page--settings">
        <header className="header-row">
          <div>
            <p className="eyebrow">Profile settings</p>
            <h1 className="page-title">Settings</h1>
            <div className="small-plus muted">Version {packageJson.version}</div>
            <div className="small-plus muted">
              {me ? `Signed in as ${me.email}` : 'Loading user session'}
            </div>
            <Button
              variant="secondary"
              className="settings-desktop-setup-button"
              onClick={openDesktopSetupModal}
              disabled={formDisabled}
            >
              Setup desktop app
            </Button>
          </div>
          <div className="toolbar">
            <Button
              variant="secondary"
              className="cu-btn--icon cu-btn--toolbar"
              onClick={loadAll}
              disabled={formDisabled}
              aria-label={state === 'loading' ? 'Refreshing settings' : 'Refresh settings'}
            >
              <IconRefresh className={state === 'loading' ? 'cu-spin' : undefined} />
            </Button>
          </div>
        </header>

        {state === 'loading' && <LoadingSkeleton />}
        {error && <div className="message message--error">{error}</div>}

        <div className="tabs" role="tablist" aria-label="Settings sections">
          <Link
            href="/settings/profile"
            className={`tab-button${activeSettingsTab === 'profile' ? ' is-active' : ''}`}
            role="tab"
            aria-selected={activeSettingsTab === 'profile'}
          >
            Profile
          </Link>
          {hasSocialAccess ? (
            <Link
              href={`/settings/social/${currentSocialTab?.key || visibleSocialTabs[0]?.key || 'telegram'}`}
              className={`tab-button${activeSettingsTab === 'social' ? ' is-active' : ''}`}
              role="tab"
              aria-selected={activeSettingsTab === 'social'}
            >
              Social channels
            </Link>
          ) : null}
        </div>

        {activeSettingsTab === 'profile' ? (
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
        ) : null}

        {activeSettingsTab === 'social' && currentSocialTab ? (
          <section className="section settings-section">
            <div className="tabs" role="tablist" aria-label="Social networks">
              {visibleSocialTabs.map(tab => (
                <Link
                  key={tab.key}
                  href={`/settings/social/${tab.key}`}
                  className={`tab-button${tab.key === activeSocialTab ? ' is-active' : ''}`}
                  role="tab"
                  aria-selected={tab.key === activeSocialTab}
                >
                  {tab.label}
                </Link>
              ))}
            </div>
            {currentSocialTab.key === 'telegram' ? (
              <TelegramVerificationPanel
                targets={telegramTargets}
                accounts={telegramAccounts}
                disabled={formDisabled}
                onAccountsRefresh={refreshApprovalAccounts}
                onRemoveAccount={removeApprovalMediumAccount}
              />
            ) : null}
            {currentSocialTab.key === 'slack' ? (
              <TelegramVerificationPanel
                medium="slack"
                targets={slackTargets}
                accounts={slackAccounts}
                disabled={formDisabled}
                onAccountsRefresh={refreshApprovalAccounts}
                onRemoveAccount={removeApprovalMediumAccount}
              />
            ) : null}
          </section>
        ) : null}
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
  environment,
  externalRestApiBaseUrl,
  onClose,
  onCopy,
  onOpenDesktop,
}: {
  busy: boolean
  environment: DesktopEnvironmentResponse | null
  externalRestApiBaseUrl: string
  onClose: () => void
  onCopy: () => void
  onOpenDesktop: () => void
}) {
  const canOpenDesktop = Boolean(environment?.externalRestApiBaseUrl)

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
          <div className="settings-desktop-setup-actions">
            <Button onClick={onOpenDesktop} disabled={busy || !canOpenDesktop}>
              Open desktop app and setup
            </Button>
          </div>
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
