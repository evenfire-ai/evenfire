import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CommunicationChannelItem } from '../../lib/communicationChannels'
import { CommunicationChannelsTable } from '../CommunicationChannelsTable'
import { ToastProvider } from '../Toast'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderTable({
  items,
  onCopyChannel = vi.fn(),
}: {
  items: CommunicationChannelItem[]
  onCopyChannel?: (name: string, provider: 'telegram' | 'slack' | 'teams') => void
}) {
  return render(
    <ToastProvider>
      <CommunicationChannelsTable
        items={items}
        onChanged={vi.fn().mockResolvedValue(undefined)}
        onCopyChannel={onCopyChannel}
      />
    </ToastProvider>
  )
}

describe('CommunicationChannelsTable', () => {
  it('offers copy targets for providers not already configured on the channel', () => {
    const onCopyChannel = vi.fn()
    renderTable({
      onCopyChannel,
      items: [
        {
          metadata: { name: 'telegram-channel', namespace: 'channels' },
          spec: {
            access: {
              teams: ['team-a'],
              users: ['user-a'],
            },
            hostRef: 'agent-a',
            telegramSettings: {
              botHandle: '@evenfire_bot',
              replyOnlyWhenMentioned: true,
            },
          },
        },
      ],
    })

    fireEvent.click(screen.getByRole('button', { name: 'Copy channel telegram-channel config' }))

    expect(
      screen.queryByRole('menuitem', { name: 'Copy config into Telegram' })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy config into Slack' }))

    expect(onCopyChannel).toHaveBeenCalledWith('telegram-channel', 'slack')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('ignores default settings when offering copy targets for a Slack channel', () => {
    const onCopyChannel = vi.fn()
    renderTable({
      onCopyChannel,
      items: [
        {
          metadata: { name: 'slack-channel', namespace: 'channels' },
          spec: {
            access: {
              teams: ['team-a'],
              users: ['user-a'],
            },
            hostRef: 'agent-a',
            telegramSettings: {
              replyOnlyWhenMentioned: true,
            },
            slackSettings: {
              botHandle: 'Evenfire Test App',
              replyOnlyWhenMentioned: true,
              replyInThreads: true,
            },
          },
        },
      ],
    })

    fireEvent.click(screen.getByRole('button', { name: 'Copy channel slack-channel config' }))

    expect(
      screen.queryByRole('menuitem', { name: 'Copy config into Slack' })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy config into Telegram' }))

    expect(onCopyChannel).toHaveBeenCalledWith('slack-channel', 'telegram')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('offers copy targets for providers not already configured on a Teams channel', () => {
    const onCopyChannel = vi.fn()
    renderTable({
      onCopyChannel,
      items: [
        {
          metadata: { name: 'teams-channel', namespace: 'channels' },
          spec: {
            access: {
              teams: ['team-a'],
              users: ['user-a'],
            },
            hostRef: 'agent-a',
            teamsSettings: {
              appName: 'evenfire',
              appId: '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82',
              tenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
            },
          },
        },
      ],
    })

    fireEvent.click(screen.getByRole('button', { name: 'Copy channel teams-channel config' }))

    expect(
      screen.queryByRole('menuitem', { name: 'Copy config into Microsoft Teams' })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy config into Slack' }))

    expect(onCopyChannel).toHaveBeenCalledWith('teams-channel', 'slack')
  })
})
