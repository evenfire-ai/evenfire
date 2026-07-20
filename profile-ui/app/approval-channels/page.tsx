'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { Button } from '@components/Button'
import { ProfileShell } from '@components/ProfileShell'
import { SelectControl } from '@components/SelectControl'
import { useToast } from '@components/Toast'
import { IconRefresh } from '@components/icons'
import { PROFILE_ROUTES } from '@constants/routes'
import {
  getMe,
  getNotificationPreferences,
  isSilentApiError,
  updateNotificationPreferences,
} from '@lib/api'
import {
  activeApprovalAccounts,
  listApprovalChannelTargets,
  listWorkflowApprovalMediums,
  preferredAccountOptionLabel,
} from '@lib/approvalChannels'
import type {
  ApprovalChannelTarget,
  WorkflowApprovalMediumAccount,
} from '@/app/types/approvalChannels'
import type { Me, NotificationPreferences } from '@/app/types/profile'

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

function LoadingSkeleton() {
  return (
    <div className="profile-skeleton" role="status" aria-label="Loading">
      <span className="profile-skeleton__line profile-skeleton__line--medium" />
      <span className="profile-skeleton__line" />
      <span className="profile-skeleton__line profile-skeleton__line--short" />
    </div>
  )
}

function settingsPathForMedium(medium: string): string {
  if (medium === 'slack') return PROFILE_ROUTES.settings.social('slack')
  if (medium === 'teams') return PROFILE_ROUTES.settings.social('teams')
  return PROFILE_ROUTES.settings.social('telegram')
}

function ApprovalChannelsContent() {
  const router = useRouter()
  const { showToast } = useToast()
  const [me, setMe] = useState<Me | null>(null)
  const [accounts, setAccounts] = useState<WorkflowApprovalMediumAccount[]>([])
  const [targets, setTargets] = useState<ApprovalChannelTarget[]>([])
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null)
  const [state, setState] = useState<LoadState>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const activeAccounts = useMemo(() => {
    const authorizedTargetIds = new Set(targets.map(target => target.id))
    return activeApprovalAccounts(accounts).filter(account =>
      (account.targets || []).some(target => authorizedTargetIds.has(target.id))
    )
  }, [accounts, targets])
  const selectedPreferredAccountId = preferences?.preferredAccountId ?? ''
  const selectedAccount = activeAccounts.find(account => account.id === selectedPreferredAccountId)
  const manageMedium = selectedAccount?.medium || activeAccounts[0]?.medium || 'telegram'

  async function loadAll() {
    setState('loading')
    setError('')
    try {
      const [current, nextTargets, nextAccounts, nextPreferences] = await Promise.all([
        getMe() as Promise<Me>,
        listApprovalChannelTargets(),
        listWorkflowApprovalMediums(),
        getNotificationPreferences(),
      ])
      setMe(current)
      setTargets(nextTargets)
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
    setError('')
    try {
      const next = await updateNotificationPreferences({
        preferredMedium:
          preferredMedium === 'telegram' || preferredMedium === 'slack' ? preferredMedium : null,
        preferredAccountId,
        channelFallbackEnabled: preferences.channelFallbackEnabled,
      })
      setPreferences(next)
      showToast(
        preferredAccountId ? 'Preferred channel updated.' : 'Preferred channel set to automatic.',
        { tone: 'success' }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      setError(
        message.includes('preferred_account_not_found')
          ? 'That channel is no longer available. Pick another or leave Automatic.'
          : 'Could not update the preferred channel.'
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <ProfileShell currentRoute="approvalChannels">
      <div className="profile-page">
        <header className="header-row">
          <div>
            <h1 className="page-title">Approval Channels</h1>
            <div className="small-plus muted">
              {me ? `Signed in as ${me.email}` : 'Loading user session'}
            </div>
          </div>
          <div className="toolbar">
            <Button
              variant="secondary"
              className="cu-btn--icon cu-btn--toolbar"
              onClick={loadAll}
              disabled={busy || state === 'loading'}
              aria-label={
                state === 'loading' ? 'Refreshing approval channels' : 'Refresh approval channels'
              }
            >
              <IconRefresh className={state === 'loading' ? 'cu-spin' : undefined} />
            </Button>
          </div>
        </header>

        {state === 'loading' ? <LoadingSkeleton /> : null}
        {error ? <div className="message message--error">{error}</div> : null}

        {state !== 'loading' && preferences && targets.length > 0 ? (
          <section className="section">
            <div className="settings-section-head">
              <div>
                <h2 className="section-title">Preferred approval channel</h2>
                <p className="body-copy">
                  Choose which connected conversation receives approval notifications by default.
                </p>
              </div>
              <Button
                variant="secondary"
                onClick={() => router.push(settingsPathForMedium(manageMedium))}
              >
                Manage
              </Button>
            </div>

            {activeAccounts.length === 0 ? (
              <div className="message message--plain">
                No external channels are connected. Use Manage to connect one.
              </div>
            ) : (
              <label className="stack-tight" htmlFor="preferred-notification-account">
                <span className="small muted">Preferred channel</span>
                <SelectControl
                  id="preferred-notification-account"
                  value={selectedPreferredAccountId}
                  onChange={event => void changePreferredAccount(event.target.value)}
                  disabled={busy}
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
          </section>
        ) : null}
      </div>
    </ProfileShell>
  )
}

export default function ApprovalChannelsPage() {
  return (
    <AuthGate>
      <ApprovalChannelsContent />
    </AuthGate>
  )
}
