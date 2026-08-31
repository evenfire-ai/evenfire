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
  it('shows configured provider types in one column', () => {
    renderTable({
      items: [
        {
          metadata: { name: 'multi-provider-channel', namespace: 'channels' },
          spec: {
            hostRef: 'agent-a',
            telegramSettings: { botHandle: '@evenfire_bot' },
            slack: [{ channelId: 'C123' }],
            teamsSettings: { appId: 'app-123' },
          },
        },
      ],
    })

    expect(screen.getByRole('columnheader', { name: 'Type' })).toBeInTheDocument()
    expect(
      screen.getByRole('cell', { name: 'Telegram, Slack, Microsoft Teams' })
    ).toBeInTheDocument()
    for (const removedHeading of ['Telegram', 'Slack', 'Teams']) {
      expect(screen.queryByRole('columnheader', { name: removedHeading })).not.toBeInTheDocument()
    }
  })

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

    fireEvent.click(screen.getByRole('button', { name: 'Actions for channel telegram-channel' }))

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

    fireEvent.click(screen.getByRole('button', { name: 'Actions for channel slack-channel' }))

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

    fireEvent.click(screen.getByRole('button', { name: 'Actions for channel teams-channel' }))

    expect(
      screen.queryByRole('menuitem', { name: 'Copy config into Microsoft Teams' })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy config into Slack' }))

    expect(onCopyChannel).toHaveBeenCalledWith('teams-channel', 'slack')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Row actions kebab
// ─────────────────────────────────────────────────────────────────────────────
describe('CommunicationChannelsTable — row actions kebab', () => {
  function teamsChannelItem(): CommunicationChannelItem {
    return {
      metadata: { name: 'teams-channel', namespace: 'channels' },
      spec: { hostRef: 'agent-a', teamsSettings: { appId: 'app-123' } },
    } as unknown as CommunicationChannelItem
  }

  it('opens the kebab with Edit + Delete and routes Edit through the matching handler', () => {
    const onEditChannel = vi.fn()
    render(
      <ToastProvider>
        <CommunicationChannelsTable
          items={[teamsChannelItem()]}
          onChanged={vi.fn().mockResolvedValue(undefined)}
          onEditChannel={onEditChannel}
          onRefresh={vi.fn()}
          refreshing={false}
        />
      </ToastProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for channel teams-channel' }))

    const editItem = screen.getByRole('menuitem', { name: 'Edit' })
    const deleteItem = screen.getByRole('menuitem', { name: 'Delete' })
    expect(deleteItem).toHaveClass('eft-row-actions__item--danger')

    fireEvent.click(editItem)
    expect(onEditChannel).toHaveBeenCalledWith('teams-channel')
  })

  it('opens the confirm dialog when Delete is clicked on the kebab', () => {
    render(
      <ToastProvider>
        <CommunicationChannelsTable
          items={[teamsChannelItem()]}
          onChanged={vi.fn().mockResolvedValue(undefined)}
          onEditChannel={vi.fn()}
          onRefresh={vi.fn()}
          refreshing={false}
        />
      </ToastProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for channel teams-channel' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))

    expect(screen.getByRole('alertdialog')).toHaveTextContent(/Delete communication channel/)
  })

  it('still renders the kebab without Edit when onEditChannel is omitted', () => {
    render(
      <ToastProvider>
        <CommunicationChannelsTable
          items={[teamsChannelItem()]}
          onChanged={vi.fn().mockResolvedValue(undefined)}
          onRefresh={vi.fn()}
          refreshing={false}
        />
      </ToastProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for channel teams-channel' }))

    expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument()
  })

  it('exposes each copy target as its own menu item inside the row kebab', () => {
    const onCopyChannel = vi.fn()
    render(
      <ToastProvider>
        <CommunicationChannelsTable
          items={[teamsChannelItem()]}
          onChanged={vi.fn().mockResolvedValue(undefined)}
          onCopyChannel={onCopyChannel}
          onRefresh={vi.fn()}
          refreshing={false}
        />
      </ToastProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for channel teams-channel' }))

    // teams-channel is configured for Teams, so copy targets are Slack + Telegram
    expect(screen.getByRole('menuitem', { name: 'Copy config into Slack' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Copy config into Telegram' })).toBeInTheDocument()
    expect(
      screen.queryByRole('menuitem', { name: 'Copy config into Microsoft Teams' })
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy config into Slack' }))
    expect(onCopyChannel).toHaveBeenCalledWith('teams-channel', 'slack')
  })

  it('disables copy-target items when onCopyChannel is not provided', () => {
    render(
      <ToastProvider>
        <CommunicationChannelsTable
          items={[teamsChannelItem()]}
          onChanged={vi.fn().mockResolvedValue(undefined)}
          onRefresh={vi.fn()}
          refreshing={false}
        />
      </ToastProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for channel teams-channel' }))

    const slackCopy = screen.getByRole('menuitem', { name: 'Copy config into Slack' })
    const telegramCopy = screen.getByRole('menuitem', { name: 'Copy config into Telegram' })
    expect(slackCopy).toBeDisabled()
    expect(telegramCopy).toBeDisabled()
  })
})
