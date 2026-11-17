'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Button } from '@components/Button'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { useProfileAccess } from '@components/ProfileAccessContext'
import { ProfileBodySkeleton } from '@components/ProfileBodySkeleton'
import { ProfileShell } from '@components/ProfileShell'
import { useToast } from '@components/Toast'
import { IconRefresh } from '@components/icons'
import { PROFILE_ROUTES } from '@constants/routes'
import { isSilentApiError } from '@lib/api'
import {
  disconnectWorkflowApprovalMedium,
  listWorkflowApprovalMediums,
} from '@lib/approvalChannels'
import type { WorkflowApprovalMediumAccount } from '@/app/types/approvalChannels'
import { TelegramVerificationPanel } from './TelegramVerificationPanel'
import { PROFILE_SOCIAL_CHANNEL_TABS } from './constants'
import type { SocialChannelTabKey } from './types'

type LoadState = 'loading' | 'ready' | 'error'

export function ChannelsContent({ activeChannel }: { activeChannel: SocialChannelTabKey }) {
  const { approvalTargets: targets, refreshApprovalTargets } = useProfileAccess()
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [accounts, setAccounts] = useState<WorkflowApprovalMediumAccount[]>([])
  const [state, setState] = useState<LoadState>('loading')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [connectRequestCount, setConnectRequestCount] = useState(0)

  const telegramTargets = useMemo(
    () => targets.filter(target => target.medium === 'telegram'),
    [targets]
  )
  const slackTargets = useMemo(() => targets.filter(target => target.medium === 'slack'), [targets])
  const teamsTargets = useMemo(() => targets.filter(target => target.medium === 'teams'), [targets])
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
  const teamsAccounts = useMemo(() => {
    const targetIds = new Set(teamsTargets.map(target => target.id))
    return accounts.filter(
      account =>
        account.medium === 'teams' &&
        (account.targets || []).some(target => targetIds.has(target.id))
    )
  }, [accounts, teamsTargets])
  const visibleSocialTabs = useMemo(
    () =>
      PROFILE_SOCIAL_CHANNEL_TABS.filter(tab => targets.some(target => target.medium === tab.key)),
    [targets]
  )
  const currentChannel =
    visibleSocialTabs.find(tab => tab.key === activeChannel) || visibleSocialTabs[0] || null
  const currentTargets =
    currentChannel?.key === 'slack'
      ? slackTargets
      : currentChannel?.key === 'teams'
        ? teamsTargets
        : telegramTargets
  const hasSocialAccess = visibleSocialTabs.length > 0
  const formDisabled = busy || state === 'loading'

  async function loadAll(forceAccess = false) {
    setState('loading')
    setError('')
    try {
      await Promise.all([
        refreshApprovalTargets({ force: forceAccess }),
        listWorkflowApprovalMediums({ includeDisabled: true }),
      ]).then(([, nextAccounts]) => setAccounts(nextAccounts))
      setState('ready')
    } catch (err) {
      if (isSilentApiError(err)) return
      setState('error')
      setError(err instanceof Error ? err.message : 'Failed to load social channels')
    }
  }

  useEffect(() => {
    void loadAll()
  }, [])

  const refreshApprovalAccounts = useCallback(async (): Promise<
    WorkflowApprovalMediumAccount[]
  > => {
    const next = await listWorkflowApprovalMediums({ includeDisabled: true })
    setAccounts(next)
    return next
  }, [])

  async function removeApprovalMediumAccount(accountId: string, isDisconnected: boolean) {
    const account = accounts.find(item => item.id === accountId)
    const providerLabel =
      account?.medium === 'slack'
        ? 'Slack'
        : account?.medium === 'teams'
          ? 'Microsoft Teams'
          : 'Telegram'
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

  return (
    <ProfileShell currentRoute="socialChannels">
      <div className="profile-page">
        <header className="header-row">
          <div>
            <h1 className="page-title">Social channels</h1>
          </div>
          <div className="toolbar">
            <Button
              variant="secondary"
              className="cu-btn--icon cu-btn--toolbar"
              onClick={() => void loadAll(true)}
              disabled={formDisabled}
              aria-label={
                state === 'loading' ? 'Refreshing social channels' : 'Refresh social channels'
              }
            >
              <IconRefresh className={state === 'loading' ? 'cu-spin' : undefined} />
            </Button>
            {currentChannel ? (
              <Button
                onClick={() => setConnectRequestCount(count => count + 1)}
                disabled={formDisabled || currentTargets.length === 0}
              >
                Connect {currentChannel.label}
              </Button>
            ) : null}
          </div>
        </header>

        {error && <div className="message message--error">{error}</div>}

        <section className="section">
          {hasSocialAccess ? (
            <div className="tabs" role="tablist" aria-label="Social networks">
              {visibleSocialTabs.map(tab => (
                <Link
                  key={tab.key}
                  href={PROFILE_ROUTES.channels.channel(tab.key)}
                  className={`tab-button${tab.key === currentChannel?.key ? ' is-active' : ''}`}
                  role="tab"
                  aria-selected={tab.key === currentChannel?.key}
                >
                  {tab.label}
                </Link>
              ))}
            </div>
          ) : null}
          {state === 'loading' ? (
            <ProfileBodySkeleton
              label="Loading social channels"
              sections={[{ title: 'Social channels', rows: 4 }]}
              showHead={false}
            />
          ) : hasSocialAccess && currentChannel ? (
            <>
              {currentChannel.key === 'telegram' ? (
                <TelegramVerificationPanel
                  targets={telegramTargets}
                  accounts={telegramAccounts}
                  disabled={formDisabled}
                  onAccountsRefresh={refreshApprovalAccounts}
                  onRemoveAccount={removeApprovalMediumAccount}
                  connectRequestCount={connectRequestCount}
                />
              ) : null}
              {currentChannel.key === 'slack' ? (
                <TelegramVerificationPanel
                  medium="slack"
                  targets={slackTargets}
                  accounts={slackAccounts}
                  disabled={formDisabled}
                  onAccountsRefresh={refreshApprovalAccounts}
                  onRemoveAccount={removeApprovalMediumAccount}
                  connectRequestCount={connectRequestCount}
                />
              ) : null}
              {currentChannel.key === 'teams' ? (
                <TelegramVerificationPanel
                  medium="teams"
                  targets={teamsTargets}
                  accounts={teamsAccounts}
                  disabled={formDisabled}
                  onAccountsRefresh={refreshApprovalAccounts}
                  onRemoveAccount={removeApprovalMediumAccount}
                  connectRequestCount={connectRequestCount}
                />
              ) : null}
            </>
          ) : (
            <p className="body-copy">No social channels are set up yet.</p>
          )}
        </section>

        {confirmDialog}
      </div>
    </ProfileShell>
  )
}
