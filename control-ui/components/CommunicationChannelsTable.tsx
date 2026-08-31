'use client'

import { useMemo, useState } from 'react'
import { DataTable, TableRow, TableStateRow, useTableSort } from '@clerum/frontend-table-system'
import {
  COMMUNICATION_CHANNEL_PROVIDERS,
  type CommunicationChannelProvider,
  communicationChannelProviderLabel,
} from '@lib/communicationChannelProviders'
import type { CommunicationChannelItem } from '@lib/communicationChannels'
import { apiSend } from '../lib/api'
import { useConfirmDialog } from './ConfirmDialog'
import { RowActionsMenu } from './RowActionsMenu'
import { SectionSearchInput } from './SectionSearchInput'
import { IconBroadcast } from './Sidebar/icons'
import { TableHeaderRow } from './TableHeaderRow'
import type { TableHeaderColumn } from './TableHeaderRow/types'
import { TablePanelHeader } from './TablePanelHeader'
import { useToast } from './Toast'
import { IconRefresh } from './icons'

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
  { key: 'type', label: 'Type', width: '18%' },
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
  onOpenChannel,
}: {
  items: CommunicationChannelItem[]
  onChanged: () => Promise<void>
  loading?: boolean
  onRefresh?: () => void
  refreshing?: boolean
  onCreateChannel?: () => void
  onCopyChannel?: (name: string, provider: CommunicationChannelProvider) => void
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
  const channelSort = useTableSort<(typeof filteredRows)[number], 'name' | 'agent' | 'type'>({
    rows: filteredRows,
    defaultKey: 'name',
    identity: row => row.key,
    accessors: {
      name: row => row.item.metadata?.name,
      agent: row => row.item.spec?.hostRef,
      type: row =>
        COMMUNICATION_CHANNEL_PROVIDERS.filter(provider =>
          configuredProviders(row.item).has(provider)
        )
          .map(communicationChannelProviderLabel)
          .join(', '),
    },
  })
  const columns = COMMUNICATION_CHANNEL_COLUMNS.map(column =>
    column.key === 'actions'
      ? column
      : {
          ...column,
          activeDirection: channelSort.key === column.key ? channelSort.direction : null,
          onSort: () => channelSort.sortBy(column.key as 'name' | 'agent' | 'type'),
        }
  )

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
        <div className="eft-table-viewport cu-table-wrap">
          <DataTable className="eft-table cu-table cu-table--header-band">
            <thead>
              <TableHeaderRow columns={columns} />
            </thead>
            <tbody>
              {isInitialLoad ? (
                <TableStateRow
                  colSpan={columns.length}
                  kind="loading"
                  message="Loading communication channels…"
                />
              ) : filteredRows.length === 0 ? (
                <TableStateRow
                  colSpan={columns.length}
                  message={
                    normalizedSearch ? 'No channels match this search.' : 'No resources found.'
                  }
                />
              ) : (
                channelSort.sortedRows.map(({ key, item }) => {
                  const name = item.metadata?.name || '-'
                  const spec = item.spec || {}
                  const configuredProviderTypes = configuredProviders(item)
                  const providerTypes = COMMUNICATION_CHANNEL_PROVIDERS.filter(provider =>
                    configuredProviderTypes.has(provider)
                  )
                  return (
                    <TableRow
                      key={key}
                      onNavigate={onOpenChannel ? () => onOpenChannel(name) : undefined}
                    >
                      <td className="cu-channel-table__name">{name}</td>
                      <td>
                        <span className="cu-table__cell-muted">{spec.hostRef || '-'}</span>
                      </td>
                      <td>
                        {providerTypes.map(communicationChannelProviderLabel).join(', ') || '-'}
                      </td>
                      <td>
                        <div className="cu-table-actions">
                          <RowActionsMenu
                            ariaLabel={`Actions for channel ${name}`}
                            horizontalTrigger
                            actions={[
                              ...(onOpenChannel
                                ? [
                                    {
                                      key: 'view',
                                      label: 'View details',
                                      onClick: () => onOpenChannel(name),
                                    },
                                  ]
                                : []),
                              ...copyTargetsForChannel(item).map(provider => ({
                                key: `copy-${provider}`,
                                label: `Copy config into ${communicationChannelProviderLabel(provider)}`,
                                onClick: () => onCopyChannel?.(name, provider),
                                disabled: !onCopyChannel,
                              })),
                              {
                                key: 'delete',
                                label: deletingKey === key ? 'Deleting…' : 'Delete',
                                danger: true,
                                disabled: deletingKey === key,
                                onClick: () => void deleteRow(item),
                              },
                            ]}
                          />
                        </div>
                      </td>
                    </TableRow>
                  )
                })
              )}
            </tbody>
          </DataTable>
        </div>
      </div>
      {confirmDialog}
    </>
  )
}
