'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { SingleValueEditDialog } from '@clerum/frontend-components'
import { Button } from '@components/Button'
import { useProfileAccess } from '@components/ProfileAccessContext'
import { ProfileBodySkeleton } from '@components/ProfileBodySkeleton'
import { ProfileShell } from '@components/ProfileShell'
import { SelectControl } from '@components/SelectControl'
import { useToast } from '@components/Toast'
import { PROFILE_ROUTES } from '@constants/routes'
import {
  getNotificationPreferences,
  isSilentApiError,
  updateNotificationPreferences,
} from '@lib/api'
import {
  activeApprovalAccounts,
  listWorkflowApprovalMediums,
  preferredAccountOptionLabel,
} from '@lib/approvalChannels'
import type { WorkflowApprovalMediumAccount } from '@/app/types/approvalChannels'
import type { NotificationPreferences } from '@/app/types/profile'
import { SettingsPageHeader } from './SettingsPageHeader'
import { SettingsTabs } from './SettingsTabs'

type LoadState = 'loading' | 'ready' | 'error'

export function ApprovalChannelsContent() {
  const router = useRouter()
  const { showToast } = useToast()
  const { approvalTargets: targets, refreshApprovalTargets } = useProfileAccess()
  const [accounts, setAccounts] = useState<WorkflowApprovalMediumAccount[]>([])
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null)
  const [state, setState] = useState<LoadState>('loading')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editingPreferred, setEditingPreferred] = useState(false)
  const [preferredEditError, setPreferredEditError] = useState('')

  const activeAccounts = useMemo(() => {
    const authorizedTargetIds = new Set(targets.map(target => target.id))
    return activeApprovalAccounts(accounts).filter(account =>
      (account.targets || []).some(target => authorizedTargetIds.has(target.id))
    )
  }, [accounts, targets])
  const selectedPreferredAccountId = preferences?.preferredAccountId ?? ''
  const selectedAccount = activeAccounts.find(account => account.id === selectedPreferredAccountId)
  const selectedPreferredAccountLabel = selectedAccount
    ? preferredAccountOptionLabel(selectedAccount)
    : 'Automatic (most recent channel)'

  useEffect(() => {
    // The tab is only offered with external channel access; without it the
    // Profile tab is the only meaningful settings destination.
    if (state === 'ready' && targets.length === 0) {
      router.replace(PROFILE_ROUTES.settings.profile)
    }
  }, [router, state, targets.length])

  async function loadAll(forceAccess = false) {
    setState('loading')
    setError('')
    try {
      const [, nextAccounts, nextPreferences] = await Promise.all([
        refreshApprovalTargets({ force: forceAccess }),
        listWorkflowApprovalMediums(),
        getNotificationPreferences(),
      ])
      setAccounts(nextAccounts)
      setPreferences(nextPreferences)
      setState('ready')
    } catch (err) {
      if (isSilentApiError(err)) return
      setState('error')
      setError(err instanceof Error ? err.message : 'Failed to load approval channels')
    }
  }

  useEffect(() => {
    void loadAll()
  }, [])

  async function changePreferredAccount(nextAccountId: string) {
    if (!preferences) return
    const preferredAccountId = nextAccountId || null
    const preferredMedium = preferredAccountId
      ? (activeAccounts.find(account => account.id === preferredAccountId)?.medium ?? null)
      : null
    setBusy(true)
    setPreferredEditError('')
    try {
      const next = await updateNotificationPreferences({
        preferredMedium:
          preferredMedium === 'telegram' ||
          preferredMedium === 'slack' ||
          preferredMedium === 'teams'
            ? preferredMedium
            : null,
        preferredAccountId,
        channelFallbackEnabled: preferences.channelFallbackEnabled,
      })
      setPreferences(next)
      setEditingPreferred(false)
      showToast(
        preferredAccountId ? 'Preferred channel updated.' : 'Preferred channel set to automatic.',
        { tone: 'success' }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      setPreferredEditError(
        message.includes('preferred_account_not_found')
          ? 'That channel is no longer available. Pick another or leave Automatic.'
          : 'Could not update the preferred channel.'
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <ProfileShell currentRoute="settings">
      <div className="profile-page">
        <SettingsPageHeader
          disabled={busy || state === 'loading'}
          spinning={state === 'loading'}
          refreshAriaLabel={
            state === 'loading' ? 'Refreshing approval channels' : 'Refresh approval channels'
          }
          onRefresh={() => void loadAll(true)}
        />
        <SettingsTabs active="approvalChannels" />

        {error ? <div className="message message--error">{error}</div> : null}

        {state === 'loading' ? (
          <ProfileBodySkeleton
            label="Loading approval channels"
            sections={[{ title: 'Approval channels', rows: 3 }]}
            showHead={false}
          />
        ) : null}

        {state === 'ready' && preferences ? (
          <section className="section settings-section">
            <h2 className="section-title">Preferred approval channel</h2>
            <p className="small muted">
              Choose which connected conversation receives approval notifications by default.
            </p>
            {activeAccounts.length === 0 ? (
              <div className="message message--plain">
                No external channels are connected. Connect one under Social channels.
              </div>
            ) : (
              <div className="stack-tight">
                <span className="small muted">Preferred channel</span>
                <div className="settings-section-head">
                  <span>{selectedPreferredAccountLabel}</span>
                  <Button
                    variant="secondary"
                    aria-label="Edit preferred channel"
                    onClick={() => {
                      setPreferredEditError('')
                      setEditingPreferred(true)
                    }}
                    disabled={busy}
                  >
                    Edit
                  </Button>
                </div>
              </div>
            )}
          </section>
        ) : null}

        {preferences && activeAccounts.length > 0 ? (
          <SingleValueEditDialog
            open={editingPreferred}
            initialValue={selectedPreferredAccountId}
            title="Edit preferred approval channel"
            description="Choose which connected conversation receives approval notifications by default."
            pending={busy}
            error={preferredEditError || undefined}
            discardLabel="Cancel"
            onDismiss={() => {
              setPreferredEditError('')
              setEditingPreferred(false)
            }}
            onSave={value => void changePreferredAccount(value)}
            renderEditor={({ value, onChange, disabled }) => (
              <label className="stack-tight" htmlFor="preferred-notification-account">
                <span className="small muted">Preferred channel</span>
                <SelectControl
                  id="preferred-notification-account"
                  value={value}
                  onChange={event => onChange(event.target.value)}
                  disabled={disabled}
                >
                  <option value="">Automatic (most recent channel)</option>
                  {activeAccounts.map(account => (
                    <option key={account.id} value={account.id}>
                      {preferredAccountOptionLabel(account)}
                    </option>
                  ))}
                </SelectControl>
              </label>
            )}
          />
        ) : null}
      </div>
    </ProfileShell>
  )
}
