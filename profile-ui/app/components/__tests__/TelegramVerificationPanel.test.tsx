import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  ApprovalChannelTarget,
  WorkflowApprovalMediumAccount,
} from '@/app/types/approvalChannels'
import { TelegramVerificationPanel } from '../../channels/TelegramVerificationPanel'
import { ToastProvider } from '../Toast'

const mocks = vi.hoisted(() => ({
  updateDisplayName: vi.fn(),
  createChallenge: vi.fn(),
}))

vi.mock('@lib/approvalChannels', async importOriginal => {
  const original = await importOriginal<typeof import('@lib/approvalChannels')>()
  return {
    ...original,
    updateWorkflowApprovalMediumDisplayName: mocks.updateDisplayName,
    createWorkflowApprovalMediumChallenge: mocks.createChallenge,
  }
})

const account: WorkflowApprovalMediumAccount = {
  id: 'account-1',
  userId: 'user-1',
  medium: 'slack',
  providerUserId: 'provider-user',
  providerWorkspaceId: 'workspace-1',
  providerChannelId: 'channel-1',
  displayName: 'Operations approvals',
  targets: [],
}

afterEach(cleanup)

describe('TelegramVerificationPanel display name editing', () => {
  const onAccountsRefresh = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    onAccountsRefresh.mockResolvedValue([account])
    mocks.updateDisplayName.mockResolvedValue(undefined)
  })

  function renderPanel() {
    return render(
      <ToastProvider>
        <TelegramVerificationPanel
          accounts={[account]}
          disabled={false}
          medium="slack"
          onAccountsRefresh={onAccountsRefresh}
          onRemoveAccount={() => undefined}
          targets={[]}
        />
      </ToastProvider>
    )
  }

  async function openEditor() {
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Operations approvals' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit display name' }))
    return screen.findByRole('dialog', { name: 'Edit conversation name' })
  }

  it('saves a changed display name and refreshes authoritative account data', async () => {
    renderPanel()
    const dialog = await openEditor()
    const input = within(dialog).getByRole('textbox', { name: 'Display name' })
    expect(input).toHaveValue('Operations approvals')
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()

    fireEvent.change(input, { target: { value: 'Leadership approvals' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(mocks.updateDisplayName).toHaveBeenCalledWith('account-1', 'Leadership approvals')
    )
    expect(onAccountsRefresh).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('Conversation display name saved.')).toBeInTheDocument()
  })

  it('retains a failed draft and discards it on cancel', async () => {
    mocks.updateDisplayName.mockRejectedValue(new Error('Display name update failed'))
    renderPanel()
    const dialog = await openEditor()
    const input = within(dialog).getByRole('textbox', { name: 'Display name' })
    fireEvent.change(input, { target: { value: 'Retry approvals' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Display name update failed')
    expect(input).toHaveValue('Retry approvals')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    const reopened = await openEditor()
    expect(within(reopened).getByRole('textbox', { name: 'Display name' })).toHaveValue(
      'Operations approvals'
    )
  })
})

describe('TelegramVerificationPanel channel table', () => {
  const telegramTarget: ApprovalChannelTarget = {
    id: 'target-1',
    medium: 'telegram',
    agentName: 'Ops agent',
    channelName: 'Ops chat',
    channelNamespace: 'ops',
    botLabel: 'Ops bot',
    botUsername: 'ops_bot',
    botDeepLink: null,
    status: 'ready',
  }
  const telegramAccount: WorkflowApprovalMediumAccount = {
    id: 'account-2',
    userId: 'user-1',
    medium: 'telegram',
    providerUserId: 'provider-user',
    providerWorkspaceId: null,
    providerChannelId: 'chat-1',
    providerChannelType: 'supergroup',
    providerChannelTitle: 'Ops chat',
    targets: [telegramTarget],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createChallenge.mockResolvedValue({
      challengeId: 'challenge-1',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      code: 'verify-code-1',
      delivery: { channel: 'telegram' },
    })
  })

  it('renders telegram connections with name, chat type, bot handle, and status columns', () => {
    render(
      <ToastProvider>
        <TelegramVerificationPanel
          accounts={[telegramAccount]}
          disabled={false}
          medium="telegram"
          onAccountsRefresh={vi.fn()}
          onRemoveAccount={() => undefined}
          targets={[telegramTarget]}
        />
      </ToastProvider>
    )

    const table = screen.getByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'Name' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Chat type' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Bot handle' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Status' })).toBeInTheDocument()

    expect(within(table).getByRole('cell', { name: 'Ops chat' })).toBeInTheDocument()
    expect(within(table).getByRole('cell', { name: 'Supergroup' })).toBeInTheDocument()
    expect(within(table).getByRole('cell', { name: '@ops_bot' })).toBeInTheDocument()
    const verifiedTag = within(table).getByText('Verified')
    expect(verifiedTag).toHaveClass('cu-status-tag')
    expect(verifiedTag).toHaveClass('cu-status-tag--verified')
    expect(screen.getByRole('button', { name: 'Actions for Ops chat' })).toBeInTheDocument()
  })

  it('lists unverified targets as Not connected and connects a row straight to verification', async () => {
    const pendingTarget: ApprovalChannelTarget = {
      ...telegramTarget,
      id: 'target-2',
      channelName: 'Ops tasks',
      botUsername: 'ops_tasks_bot',
    }
    render(
      <ToastProvider>
        <TelegramVerificationPanel
          accounts={[telegramAccount]}
          disabled={false}
          medium="telegram"
          onAccountsRefresh={vi.fn()}
          onRemoveAccount={() => undefined}
          targets={[telegramTarget, pendingTarget]}
        />
      </ToastProvider>
    )

    const table = screen.getByRole('table')
    expect(within(table).getByRole('cell', { name: 'Ops tasks' })).toBeInTheDocument()
    const notConnectedTags = within(table).getAllByText('Not connected')
    expect(notConnectedTags).toHaveLength(2)
    for (const tag of notConnectedTags) {
      expect(tag).toHaveClass('cu-status-tag--not-connected')
    }
    const pendingRow = within(table)
      .getByRole('cell', { name: 'Ops tasks' })
      .closest('tr') as HTMLTableRowElement
    const chatTypeCell = within(pendingRow).getAllByRole('cell', { name: 'Not connected' })[0]!
    expect(within(chatTypeCell).getByText('Not connected')).toHaveClass(
      'cu-status-tag--not-connected'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Ops tasks' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Connect' }))

    const dialog = await screen.findByRole('dialog', { name: 'Verify your Telegram channel' })
    expect(mocks.createChallenge).toHaveBeenCalledWith({ medium: 'telegram', targetId: 'target-2' })
    expect(
      within(dialog).queryByRole('button', { name: /Communication channel/ })
    ).not.toBeInTheDocument()
    expect(within(dialog).getByTestId('telegram-bot-handle')).toHaveTextContent('@ops_tasks_bot')
    expect(within(dialog).getByTestId('telegram-verification-command')).toHaveTextContent(
      '/verify verify-code-1'
    )
    expect(within(dialog).getByRole('timer')).toHaveTextContent('Expires in')
    expect(within(dialog).getByText('Message the verification bot')).toBeInTheDocument()
    expect(within(dialog).queryByText('What happens next?')).not.toBeInTheDocument()

    // The verify summary fronts the agent with the robot badge.
    const agentItem = within(dialog).getByText('Agent').closest('.cu-connect-summary__item')
    expect(agentItem).not.toBeNull()
    expect(agentItem!.querySelector('.cu-agent-badge svg')).not.toBeNull()
    expect(within(agentItem as HTMLElement).getByText('Ops agent')).toBeInTheDocument()
  })

  it('shows an in-modal loading state while a row connect request starts', async () => {
    let resolveChallenge: (value: {
      challengeId: string
      expiresAt: string
      code?: string
      delivery: { channel: string }
    }) => void = () => undefined
    mocks.createChallenge.mockReturnValue(
      new Promise(resolve => {
        resolveChallenge = resolve
      })
    )
    render(
      <ToastProvider>
        <TelegramVerificationPanel
          accounts={[]}
          disabled={false}
          medium="telegram"
          onAccountsRefresh={vi.fn()}
          onRemoveAccount={() => undefined}
          targets={[telegramTarget]}
        />
      </ToastProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Ops chat' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Connect' }))

    const dialog = screen.getByRole('dialog', { name: 'Verify your Telegram channel' })
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      'Starting Telegram verification...'
    )
    expect(within(dialog).queryByTestId('telegram-verification-command')).not.toBeInTheDocument()

    resolveChallenge({
      challengeId: 'challenge-1',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      code: 'verify-code-1',
      delivery: { channel: 'telegram' },
    })
    await screen.findByRole('dialog', { name: 'Verify your Telegram channel' })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('keeps the channel selection step for connect requests that do not come from a row', () => {
    const { rerender } = render(
      <ToastProvider>
        <TelegramVerificationPanel
          accounts={[telegramAccount]}
          disabled={false}
          medium="telegram"
          onAccountsRefresh={vi.fn()}
          onRemoveAccount={() => undefined}
          targets={[telegramTarget]}
        />
      </ToastProvider>
    )

    rerender(
      <ToastProvider>
        <TelegramVerificationPanel
          accounts={[telegramAccount]}
          disabled={false}
          medium="telegram"
          onAccountsRefresh={vi.fn()}
          onRemoveAccount={() => undefined}
          targets={[telegramTarget]}
          connectRequestCount={1}
        />
      </ToastProvider>
    )

    const dialog = screen.getByRole('dialog', { name: 'Verify your Telegram channel' })
    const dropdownTrigger = within(dialog).getByRole('button', { name: /Communication channel/ })
    expect(dropdownTrigger).toHaveTextContent('Ops chat')
    expect(mocks.createChallenge).not.toHaveBeenCalled()
  })

  it('drops the provider name from dropdown options and leads the handle with the telegram logo', () => {
    const { rerender } = render(
      <ToastProvider>
        <TelegramVerificationPanel
          accounts={[telegramAccount]}
          disabled={false}
          medium="telegram"
          onAccountsRefresh={vi.fn()}
          onRemoveAccount={() => undefined}
          targets={[telegramTarget]}
        />
      </ToastProvider>
    )

    rerender(
      <ToastProvider>
        <TelegramVerificationPanel
          accounts={[telegramAccount]}
          disabled={false}
          medium="telegram"
          onAccountsRefresh={vi.fn()}
          onRemoveAccount={() => undefined}
          targets={[telegramTarget]}
          connectRequestCount={1}
        />
      </ToastProvider>
    )

    const dialog = screen.getByRole('dialog', { name: 'Verify your Telegram channel' })
    fireEvent.click(within(dialog).getByRole('button', { name: /Communication channel/ }))
    const search = within(dialog).getByPlaceholderText('Search communication channels...')

    const option = screen.getByRole('option', { name: 'Ops chat' })
    expect(within(option).queryByText(/Telegram/)).toBeNull()
    const agentBadge = option.querySelector('span.cu-agent-badge svg')
    expect(agentBadge).not.toBeNull()
    expect(within(option).getByText('Ops agent')).toBeInTheDocument()
    const logo = option.querySelector('svg.cu-selection-dropdown__option-icon')
    expect(logo).toHaveAttribute('viewBox', '0 0 512 512')
    expect(logo?.nextSibling).toHaveTextContent('@ops_bot')

    // The plain-text description keeps the handle searchable.
    fireEvent.change(search, { target: { value: 'ops_bot' } })
    expect(screen.getByRole('option', { name: 'Ops chat' })).toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'Telegram' } })
    expect(screen.queryByRole('option', { name: 'Ops chat' })).toBeNull()
  })

  it('renders slack dropdown options with the agent badge and slack logo before the app handle', () => {
    const slackTarget: ApprovalChannelTarget = {
      id: 'slack-target-1',
      medium: 'slack',
      agentName: 'Ops agent',
      channelName: 'Ops slack',
      channelNamespace: 'ops',
      botLabel: 'Ops App',
      botUsername: null,
      botDeepLink: null,
      status: 'ready',
    }
    const { rerender } = render(
      <ToastProvider>
        <TelegramVerificationPanel
          accounts={[]}
          disabled={false}
          medium="slack"
          onAccountsRefresh={vi.fn()}
          onRemoveAccount={() => undefined}
          targets={[slackTarget]}
        />
      </ToastProvider>
    )

    rerender(
      <ToastProvider>
        <TelegramVerificationPanel
          accounts={[]}
          disabled={false}
          medium="slack"
          onAccountsRefresh={vi.fn()}
          onRemoveAccount={() => undefined}
          targets={[slackTarget]}
          connectRequestCount={1}
        />
      </ToastProvider>
    )

    const dialog = screen.getByRole('dialog', { name: 'Verify your Slack channel' })
    fireEvent.click(within(dialog).getByRole('button', { name: /Communication channel/ }))

    const option = screen.getByRole('option', { name: 'Ops slack' })
    expect(within(option).queryByText(/Slack/)).toBeNull()
    expect(option.querySelector('span.cu-agent-badge svg')).not.toBeNull()
    expect(within(option).getByText('Ops agent')).toBeInTheDocument()
    const slackLogo = option.querySelector('svg.cu-selection-dropdown__option-icon')
    expect(slackLogo).toHaveAttribute('viewBox', '0 0 512 512')
    expect(slackLogo?.nextSibling).toHaveTextContent('Ops App')
  })

  it('offers Connect for every unverified target while verified rows keep record actions', () => {
    const unverified: ApprovalChannelTarget = {
      ...telegramTarget,
      id: 'target-3',
      channelName: 'Ops alerts',
    }
    render(
      <ToastProvider>
        <TelegramVerificationPanel
          accounts={[telegramAccount]}
          disabled={false}
          medium="telegram"
          onAccountsRefresh={vi.fn()}
          onRemoveAccount={() => undefined}
          targets={[telegramTarget, unverified]}
        />
      </ToastProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Ops alerts' }))
    expect(screen.getByRole('menuitem', { name: 'Connect' })).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole('button', { name: 'Actions for Ops alerts' }), {
      key: 'Escape',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Ops chat' }))
    expect(screen.getByRole('menuitem', { name: 'Delete connection' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Connect' })).not.toBeInTheDocument()
  })

  it('renders slack connections with headers, naming the handle column App handle', () => {
    render(
      <ToastProvider>
        <TelegramVerificationPanel
          accounts={[account]}
          disabled={false}
          medium="slack"
          onAccountsRefresh={vi.fn()}
          onRemoveAccount={() => undefined}
          targets={[]}
        />
      </ToastProvider>
    )

    const table = screen.getByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'Name' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Chat type' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'App handle' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Status' })).toBeInTheDocument()
    expect(
      within(screen.getByRole('table')).getByRole('cell', { name: 'Operations approvals' })
    ).toBeInTheDocument()
  })
})

describe('TelegramVerificationPanel empty state', () => {
  it('shows the empty state only when no targets and no accounts exist', () => {
    render(
      <ToastProvider>
        <TelegramVerificationPanel
          accounts={[]}
          disabled={false}
          medium="slack"
          onAccountsRefresh={vi.fn()}
          onRemoveAccount={() => undefined}
          targets={[]}
        />
      </ToastProvider>
    )

    expect(screen.getByText('No Slack channels set up yet.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('lists connectable targets as Not connected rows instead of an empty state', () => {
    render(
      <ToastProvider>
        <TelegramVerificationPanel
          accounts={[]}
          disabled={false}
          medium="telegram"
          onAccountsRefresh={vi.fn()}
          onRemoveAccount={() => undefined}
          targets={[
            {
              id: 'target-1',
              medium: 'telegram',
              agentName: 'Ops agent',
              channelName: 'Ops chat',
              channelNamespace: 'ops',
              botLabel: 'Ops bot',
              botUsername: 'ops_bot',
              botDeepLink: null,
              status: 'ready',
            },
          ]}
        />
      </ToastProvider>
    )

    const table = screen.getByRole('table')
    expect(within(table).getByRole('cell', { name: 'Ops chat' })).toBeInTheDocument()
    const notConnectedCells = within(table).getAllByRole('cell', { name: 'Not connected' })
    expect(notConnectedCells).toHaveLength(2)
    for (const cell of notConnectedCells) {
      expect(within(cell).getByText('Not connected')).toHaveClass('cu-status-tag--not-connected')
    }
    expect(screen.queryByText('No Telegram channels set up yet.')).not.toBeInTheDocument()
  })
})
