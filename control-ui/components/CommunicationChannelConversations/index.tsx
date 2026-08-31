'use client'

import Link from 'next/link'
import { DataTable, RowActionMenu } from '@clerum/frontend-table-system'
import { CONTROL_ROUTES } from '@constants/routes'
import { formatCommunicationChannelConfirmedAt } from '@lib/communicationChannels'
import type {
  CommunicationChannelConversation,
  CommunicationChannelConversationsTableProps,
} from './types'

function typeLabel(conversation: CommunicationChannelConversation): string {
  if (conversation.chatType === 'supergroup') return 'Supergroup'
  if (conversation.chatType === 'group') return 'Group'
  if (conversation.chatType === 'private') return 'Private chat'
  if (conversation.conversationType === 'personal') return 'Personal chat'
  if (conversation.conversationType === 'groupChat') return 'Group chat'
  if (conversation.conversationType === 'channel') return 'Channel'
  if (conversation.conversationType === 'private_channel') return 'Private channel'
  if (conversation.conversationType === 'im') return 'Direct message'
  if (conversation.conversationType === 'mpim') return 'Group direct message'
  if (conversation.provider === 'teams') return 'Teams conversation'
  return conversation.provider === 'telegram' ? 'Telegram chat' : 'Slack conversation'
}

function providerLabel(provider: CommunicationChannelConversation['provider']): string {
  if (provider === 'telegram') return 'Telegram'
  if (provider === 'slack') return 'Slack'
  return 'Teams'
}

function displayName(conversation: CommunicationChannelConversation): string {
  const handle = conversation.handle ? `@${conversation.handle.replace(/^@/, '')}` : ''
  return conversation.title || handle || typeLabel(conversation)
}

function conversationKey(conversation: CommunicationChannelConversation, index: number): string {
  return [
    conversation.provider,
    conversation.workspaceId || '',
    conversation.channelId || '',
    conversation.chatType || '',
    conversation.confirmedByUserId || '',
    conversation.confirmedAt || '',
    conversation.handle || '',
    conversation.title || '',
    String(index),
  ].join(':')
}

/**
 * An empty list is the normal state of a channel that was just set up, and the
 * step that fills it belongs to the end user, not the operator reading this
 * page. Saying only "none confirmed" made a working channel read as broken.
 */
const EMPTY_CONVERSATIONS_LABEL =
  'No conversations confirmed yet. Each user links their own by copying the verify command from their profile page and sending it in the conversation they want to link.'

export function CommunicationChannelConversationsTable({
  conversations,
  emptyLabel = EMPTY_CONVERSATIONS_LABEL,
  onDelete,
  showUserColumn = false,
  userLabelsById = {},
}: CommunicationChannelConversationsTableProps) {
  if (conversations.length === 0) {
    return <div className="cu-empty cu-empty--compact">{emptyLabel}</div>
  }
  return (
    <div className="eft-table-viewport cu-table-wrap">
      <DataTable className="eft-table cu-table cu-channel-conversations-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Type</th>
            <th>Name</th>
            {showUserColumn ? <th>User</th> : null}
            <th>Confirmed</th>
            {onDelete ? <th className="cu-table__actions">Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {conversations.map((conversation, index) => {
            const key = conversationKey(conversation, index)
            return (
              <tr key={key}>
                <td>{providerLabel(conversation.provider)}</td>
                <td>{typeLabel(conversation)}</td>
                <td>
                  <span className="cu-channel-conversations-table__name">
                    {displayName(conversation)}
                  </span>
                  {conversation.handle && conversation.title ? (
                    <span className="cu-muted"> @{conversation.handle.replace(/^@/, '')}</span>
                  ) : null}
                </td>
                {showUserColumn ? (
                  <td>
                    {conversation.confirmedByUserId ? (
                      <Link
                        href={CONTROL_ROUTES.usersAndTeams.user(conversation.confirmedByUserId)}
                      >
                        {userLabelsById[conversation.confirmedByUserId] || 'Unknown user'}
                      </Link>
                    ) : (
                      <span className="cu-muted">Unknown</span>
                    )}
                  </td>
                ) : null}
                <td>{formatCommunicationChannelConfirmedAt(conversation.confirmedAt)}</td>
                {onDelete ? (
                  <td className="cu-table__actions">
                    <RowActionMenu
                      ariaLabel={`Actions for ${displayName(conversation)}`}
                      actions={[
                        {
                          key: 'delete',
                          label: 'Delete',
                          danger: true,
                          onSelect: () => onDelete(conversation),
                        },
                      ]}
                    />
                  </td>
                ) : null}
              </tr>
            )
          })}
        </tbody>
      </DataTable>
    </div>
  )
}
