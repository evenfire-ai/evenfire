'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { Button } from '@components/Button'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { useProfileAccess } from '@components/ProfileAccessContext'
import { ProfileBodySkeleton } from '@components/ProfileBodySkeleton'
import { ProfileShell } from '@components/ProfileShell'
import { useToast } from '@components/Toast'
import { IconRefresh, IconSlack, IconTelegram } from '@components/icons'
import { PROFILE_ROUTES } from '@constants/routes'
import { isSilentApiError } from '@lib/api'
import {
  activeApprovalAccounts,
  disconnectWorkflowApprovalMedium,
  listWorkflowApprovalMediums,
} from '@lib/approvalChannels'
import type { WorkflowApprovalMediumAccount } from '@/app/types/approvalChannels'
import { TelegramVerificationPanel } from './TelegramVerificationPanel'
import { PROFILE_SOCIAL_CHANNEL_TABS } from './constants'
import type { SocialChannelTabKey } from './types'

type LoadState = 'loading' | 'ready' | 'error'

const SOCIAL_TAB_ICONS: Partial<Record<SocialChannelTabKey, ReactNode>> = {
  slack: <IconSlack width={14} height={14} />,
  teams: <Image src="/brand/teams.svg" alt="" width={14} height={14} aria-hidden="true" />,
  telegram: <IconTelegram width={14} height={14} />,
}

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
  const telegramAccounts = useMemo(
    () => accounts.filter(account => account.medium === 'telegram'),
    [accounts]
  )
  const slackAccounts = useMemo(
    () => accounts.filter(account => account.medium === 'slack'),
    [accounts]
  )
  const teamsAccounts = useMemo(
    () => accounts.filter(account => account.medium === 'teams'),
    [accounts]
  )
  const visibleSocialTabs = PROFILE_SOCIAL_CHANNEL_TABS
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
        listWorkflowApprovalMediums(),
      ]).then(([, nextAccounts]) => setAccounts(activeApprovalAccounts(nextAccounts)))
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
    const next = activeApprovalAccounts(await listWorkflowApprovalMediums())
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
      setAccounts(activeApprovalAccounts(await listWorkflowApprovalMediums()))
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
            <div className="small-plus muted">
              Connect Telegram, Slack, or Teams to receive approval notifications.
            </div>
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
            {currentChannel && currentTargets.length > 0 ? (
              <Button
                onClick={() => setConnectRequestCount(count => count + 1)}
                disabled={formDisabled}
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
                  {SOCIAL_TAB_ICONS[tab.key]}
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
          ) : state === 'ready' && hasSocialAccess && currentChannel ? (
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
          ) : state === 'ready' ? (
            <p className="body-copy">No social channels are set up yet.</p>
          ) : null}
        </section>

        {confirmDialog}
      </div>
    </ProfileShell>
  )
}
