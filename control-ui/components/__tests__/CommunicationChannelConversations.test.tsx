import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { CommunicationChannelConversationsTable } from '../CommunicationChannelConversations'

afterEach(cleanup)

describe('CommunicationChannelConversationsTable', () => {
  it('renders duplicate provider channel ids as distinct rows', () => {
    render(
      <CommunicationChannelConversationsTable
        conversations={[
          {
            provider: 'telegram',
            channelId: '-5565231468',
            chatType: 'group',
            title: 'Research group',
            confirmedByUserId: 'user-1',
            confirmedAt: '2026-06-19T14:22:00.000Z',
          },
          {
            provider: 'telegram',
            channelId: '-5565231468',
            chatType: 'group',
            title: 'Research group',
            confirmedByUserId: 'user-2',
            confirmedAt: '2026-06-19T14:25:00.000Z',
          },
        ]}
      />
    )

    expect(screen.getAllByText('Research group')).toHaveLength(2)
  })

  it('shows the confirming user name while preserving the user details link', () => {
    render(
      <CommunicationChannelConversationsTable
        conversations={[
          {
            provider: 'telegram',
            channelId: '777',
            chatType: 'private',
            userIds: ['777'],
            confirmedByUserId: 'user-1',
            confirmedAt: '2026-06-19T14:22:00.000Z',
          },
        ]}
        showUserColumn
        userLabelsById={{ 'user-1': 'Admin User' }}
      />
    )

    expect(screen.getByRole('link', { name: 'Admin User' })).toHaveAttribute(
      'href',
      '/profile-admin/users/user-1'
    )
    expect(screen.queryByText('user-1')).not.toBeInTheDocument()
    expect(screen.queryByText('2026-06-19T14:22:00.000Z')).not.toBeInTheDocument()
  })
})
