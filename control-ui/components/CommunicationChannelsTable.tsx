'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  COMMUNICATION_CHANNEL_PROVIDERS,
  type CommunicationChannelProvider,
  communicationChannelProviderLabel,
} from '@lib/communicationChannelProviders'
import type { CommunicationChannelItem } from '@lib/communicationChannels'
import { apiSend } from '../lib/api'
import { useConfirmDialog } from './ConfirmDialog'
import { SectionSearchInput } from './SectionSearchInput'
import { IconBroadcast } from './Sidebar/icons'
import { SkeletonTableRows } from './SkeletonTableRows'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { useToast } from './Toast'
import { IconCopy, IconPencil, IconRefresh, IconX } from './icons'

function summary(item: CommunicationChannelItem): string {
  const spec = item.spec || {}
  const tg = Array.isArray(spec.telegram) ? spec.telegram.length : 0
  const sl = Array.isArray(spec.slack) ? spec.slack.length : 0
  const tm = Array.isArray(spec.teams) ? spec.teams.length : 0
  const agent = typeof spec.hostRef === 'string' ? spec.hostRef : '-'
  return `agent: ${agent} | telegram: ${tg}, slack: ${sl}, teams: ${tm}`
}

const COMMUNICATION_CHANNEL_COLUMNS: TableHeaderColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'agent', label: 'Agent', width: '18%' },
  { key: 'telegram', label: 'Telegram', width: '10%' },
  { key: 'slack', label: 'Slack', width: '10%' },
  { key: 'teams', label: 'Teams', width: '10%' },
  { key: 'actions', width: '7rem', align: 'right', ariaLabel: 'Actions' },
]

function hasConversationEntries(
  conversations: NonNullable<CommunicationChannelItem['spec']>['telegram']
): boolean {
  return Array.isArray(conversations) && conversations.length > 0
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function configuredProviders(item: CommunicationChannelItem): Set<CommunicationChannelProvider> {
  const spec = item.spec || {}
  const providers = new Set<CommunicationChannelProvider>()
  if (
    hasConversationEntries(spec.telegram) ||
    hasNonEmptyString(spec.telegramSettings?.botHandle)
  ) {
    providers.add('telegram')
  }
  if (
    hasConversationEntries(spec.slack) ||
    hasNonEmptyString(spec.slackSettings?.botHandle) ||
    hasNonEmptyString(spec.slackSettings?.workspaceId)
  ) {
    providers.add('slack')
  }
  if (
    hasConversationEntries(spec.teams) ||
    hasNonEmptyString(spec.teamsSettings?.appName) ||
    hasNonEmptyString(spec.teamsSettings?.appId) ||
    hasNonEmptyString(spec.teamsSettings?.tenantId)
  ) {
    providers.add('teams')
  }
  return providers
}

function copyTargetsForChannel(item: CommunicationChannelItem): CommunicationChannelProvider[] {
  const configured = configuredProviders(item)
  if (configured.size === 0) return [...COMMUNICATION_CHANNEL_PROVIDERS]
  return COMMUNICATION_CHANNEL_PROVIDERS.filter(provider => !configured.has(provider))
}

export function CommunicationChannelsTable({
  items,
  onChanged,
  loading,
  onRefresh,
  refreshing,
  onCreateChannel,
  onCopyChannel,
  onEditChannel,
  onOpenChannel,
}: {
  items: CommunicationChannelItem[]
  onChanged: () => Promise<void>
  loading?: boolean
  onRefresh?: () => void
  refreshing?: boolean
  onCreateChannel?: () => void
  onCopyChannel?: (name: string, provider: CommunicationChannelProvider) => void
  onEditChannel?: (name: string) => void
  onOpenChannel?: (name: string) => void
}) {
  const [deletingKey, setDeletingKey] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()

  const rows = useMemo(
    () =>
      items.map(i => ({
        key: `${i.metadata?.namespace || 'default'}/${i.metadata?.name || 'unknown'}`,
        item: i,
      })),
    [items]
  )
  const normalizedSearch = searchQuery.trim().toLowerCase()
  const filteredRows = useMemo(() => {
    if (!normalizedSearch) return rows
    return rows.filter(({ item, key }) => {
      const spec = item.spec || {}
      const channelIds = [
        ...(spec.telegram || []).map(group => group.channelId || ''),
        ...(spec.email || []).map(group => group.channelId || ''),
        ...(spec.slack || []).map(group => group.channelId || ''),
        ...(spec.teams || []).map(group => group.channelId || ''),
      ]
      return [key, spec.hostRef || '', summary(item), ...channelIds]
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch)
    })
  }, [normalizedSearch, rows])

  async function deleteRow(item: CommunicationChannelItem) {
    const name = item.metadata?.name
    const key = `${item.metadata?.namespace || 'default'}/${name || 'unknown'}`
    if (!name) return

    const ok = await confirm({
      title: 'Delete Communication Channel',
      message: `Delete communication channel ${key}?`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return

    setDeletingKey(key)
    setError('')
    try {
      await apiSend('DELETE', `/api/v1/admin/communication-channels/${encodeURIComponent(name)}`)
      await onChanged()
      showToast(`Communication channel ${key} deleted.`, { tone: 'success' })
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to delete ${key}`)
    } finally {
      setDeletingKey(null)
    }
  }

  const isInitialLoad = loading && items.length === 0

  return (
    <>
      <div className="cu-card cu-card--viewport-fill" style={{ marginBottom: '1.25rem' }}>
        <TablePanelHeader
          title={
            <>
              <IconBroadcast />
              {isInitialLoad
                ? 'Communication channels'
                : `Communication channels (${filteredRows.length})`}
            </>
          }
          subtitle="Route channel messages to the selected agent."
          actions={
            <>
              <SectionSearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search channels"
                ariaLabel="Search communication channels"
                disabled={isInitialLoad}
              />
              {onRefresh && (
                <button
                  type="button"
                  className="cu-btn cu-btn--icon cu-btn--toolbar"
                  onClick={() => void onRefresh()}
                  disabled={refreshing || isInitialLoad}
                  aria-label={refreshing ? 'Refreshing…' : 'Reload communication channels'}
                >
                  <IconRefresh
                    className={refreshing ? 'cu-spin' : undefined}
                    width={18}
                    height={18}
                  />
                </button>
              )}
              <button
                type="button"
                className="cu-btn cu-btn--primary cu-btn--sm"
                onClick={() => onCreateChannel?.()}
                disabled={!onCreateChannel || isInitialLoad}
              >
                Add channel
              </button>
            </>
          }
        />
        {error ? (
          <div className="cu-banner cu-banner--error" role="alert">
            {error}
          </div>
        ) : null}
        {isInitialLoad ? (
          <div className="cu-table-wrap">
            <table className="cu-table cu-table--header-band">
              <thead>
                <TableHeaderRow columns={COMMUNICATION_CHANNEL_COLUMNS} />
              </thead>
              <tbody>
                <SkeletonTableRows columns={COMMUNICATION_CHANNEL_COLUMNS.length} rows={3} />
              </tbody>
            </table>
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="cu-empty">
            {normalizedSearch ? 'No channels match this search.' : 'No resources found.'}
          </div>
        ) : (
          <div className="cu-table-wrap">
            <table className="cu-table cu-table--header-band">
              <thead>
                <TableHeaderRow columns={COMMUNICATION_CHANNEL_COLUMNS} />
              </thead>
              <tbody>
                {filteredRows.map(({ key, item }) => {
                  const name = item.metadata?.name || '-'
                  const spec = item.spec || {}
                  const telegramCount = Array.isArray(spec.telegram) ? spec.telegram.length : 0
                  const slackCount = Array.isArray(spec.slack) ? spec.slack.length : 0
                  const teamsCount = Array.isArray(spec.teams) ? spec.teams.length : 0
                  return (
                    <React.Fragment key={key}>
                      <tr>
                        <td>
                          <button
                            type="button"
                            className="cu-channel-table__name"
                            onClick={() => onOpenChannel?.(name)}
                            disabled={!onOpenChannel}
                          >
                            {name}
                          </button>
                        </td>
                        <td>
                          <span className="cu-table__cell-muted">{spec.hostRef || '-'}</span>
                        </td>
                        <td>{telegramCount}</td>
                        <td>{slackCount}</td>
                        <td>{teamsCount}</td>
                        <td>
                          <div className="cu-table-actions">
                            <CopyChannelMenu
                              item={item}
                              onCopyChannel={onCopyChannel}
                              disabled={!onCopyChannel}
                            />
                            <button
                              type="button"
                              className="cu-btn cu-btn--icon cu-btn--toolbar"
                              onClick={() => onEditChannel?.(name)}
                              disabled={!onEditChannel}
                              aria-label={`Edit channel ${name}`}
                            >
                              <IconPencil width={17} height={17} />
                            </button>
                            <button
                              type="button"
                              className="cu-btn cu-btn--icon cu-btn--danger-icon"
                              onClick={() => void deleteRow(item)}
                              disabled={deletingKey === key}
                              aria-label={
                                deletingKey === key ? 'Deleting…' : `Delete channel ${name}`
                              }
                            >
                              <IconX width={17} height={17} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {confirmDialog}
    </>
  )
}

function CopyChannelMenu({
  disabled,
  item,
  onCopyChannel,
}: {
  disabled?: boolean
  item: CommunicationChannelItem
  onCopyChannel?: (name: string, provider: CommunicationChannelProvider) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const name = item.metadata?.name || ''
  const copyTargets = copyTargetsForChannel(item)

  useEffect(() => {
    if (!open) return
    function handleDocClick(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    function handleEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleDocClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleDocClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open])

  return (
    <div ref={ref} className="cu-kebab">
      <button
        type="button"
        className="cu-btn cu-btn--icon cu-btn--toolbar cu-kebab__trigger"
        onClick={() => setOpen(value => !value)}
        disabled={disabled || !name}
        aria-label={`Copy channel ${name} config`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <IconCopy width={17} height={17} />
      </button>
      {open ? (
        <div role="menu" className="cu-kebab__menu cu-kebab__menu--nowrap">
          {copyTargets.length === 0 ? (
            <button type="button" role="menuitem" className="cu-kebab__item" disabled>
              No provider targets
            </button>
          ) : (
            copyTargets.map(provider => (
              <button
                key={provider}
                type="button"
                role="menuitem"
                className="cu-kebab__item"
                onClick={() => {
                  setOpen(false)
                  onCopyChannel?.(name, provider)
                }}
              >
                Copy config into {communicationChannelProviderLabel(provider)}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
