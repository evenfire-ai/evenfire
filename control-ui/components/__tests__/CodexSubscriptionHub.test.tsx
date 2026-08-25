import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CodexSubscriptionConnectionView } from '@lib/codexSubscription'
import {
  bindCodexHost,
  createCodexSubscriptionConnection,
  listCodexSubscriptionFleet,
  revokeCodexSubscription,
  unbindCodexHost,
} from '@lib/codexSubscription'
import { CodexSubscriptionHub } from '../CodexSubscriptionHub'
import { ToastProvider } from '../Toast'

const confirmMock = vi.fn()

vi.mock('@components/ConfirmDialog', () => ({
  useConfirmDialog: () => ({
    confirm: confirmMock,
    confirmDialog: null,
  }),
}))

vi.mock('@lib/codexSubscriptionFeature', () => ({
  isCodexSubscriptionUiEnabled: (capability?: { enabled?: boolean } | null) =>
    capability?.enabled === true,
  loadCodexSubscriptionCapability: async () => ({ enabled: true }),
}))

vi.mock('@lib/codexSubscription', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/codexSubscription')>()
  return {
    ...actual,
    listCodexSubscriptionFleet: vi.fn(),
    listCodexSubscriptionConnections: vi.fn(),
    createCodexSubscriptionConnection: vi.fn(),
    startCodexDeviceConnect: vi.fn(),
    pollCodexDevice: vi.fn(),
    syncCodexSubscriptionCatalog: vi.fn(),
    revokeCodexSubscription: vi.fn(),
    unbindCodexHost: vi.fn(),
    bindCodexHost: vi.fn(),
  }
})

function connection(
  overrides: Partial<CodexSubscriptionConnectionView> &
    Pick<CodexSubscriptionConnectionView, 'connectionKey'>
): CodexSubscriptionConnectionView {
  return {
    status: 'connected',
    credentialRevision: 1,
    catalogRevision: 1,
    accountFingerprint: 'fp',
    catalogStatus: 'ready',
    catalogSyncedAt: '2026-08-20T00:00:00.000Z',
    lastRefreshAt: '2026-08-20T00:00:00.000Z',
    lastAuthAt: '2026-08-20T00:00:00.000Z',
    refreshLockHeld: false,
    displayName: overrides.connectionKey,
    ...overrides,
  }
}

describe('CodexSubscriptionHub', () => {
  beforeEach(() => {
    confirmMock.mockReset()
    vi.mocked(listCodexSubscriptionFleet).mockResolvedValue({
      connections: [connection({ connectionKey: 'codex-aaa', displayName: 'Team A' })],
      assignableHosts: [
        {
          name: 'chatllm',
          connectionRef: 'codex-aaa',
          displayName: 'chatllm',
          provider: 'codex-subscription',
          model: 'gpt-5.1',
        },
        { name: 'writer', connectionRef: 'unassigned', displayName: 'writer' },
        { name: 'researcher', connectionRef: 'unassigned', displayName: 'researcher' },
      ],
      assignableHostsUnavailable: false,
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('creates a subscription from the hub CTA', async () => {
    vi.mocked(createCodexSubscriptionConnection).mockResolvedValue(
      connection({ connectionKey: 'codex-bbb', displayName: 'New team' })
    )
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add subscription' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add subscription' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => {
      expect(createCodexSubscriptionConnection).toHaveBeenCalled()
    })
    expect(revokeCodexSubscription).not.toHaveBeenCalled()
  })

  it('renders subscriptions as one Secrets table, not stacked cards', async () => {
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    await waitFor(() => {
      expect(screen.getByTestId('codex-hub-table')).toBeInTheDocument()
    })
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Agents' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'chatllm' })).toBeInTheDocument()
    expect(screen.getByText('gpt-5.1')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Available' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Assigned' })).not.toBeInTheDocument()
    expect(document.querySelectorAll('.cu-llm-config__block').length).toBe(0)
    expect(screen.getByLabelText('Add agents to this subscription')).toBeInTheDocument()
  })

  it('assigns one available agent without revoking', async () => {
    vi.mocked(bindCodexHost).mockResolvedValue({
      host: 'writer',
      connectionRef: 'codex-aaa',
      model: 'gpt-5.1',
    })
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    await waitFor(() => {
      expect(screen.getByLabelText('Add agents to this subscription')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByLabelText('Add agents to this subscription'))
    fireEvent.click(screen.getByRole('option', { name: 'writer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add agents' }))
    await waitFor(() => {
      expect(bindCodexHost).toHaveBeenCalledWith('codex-aaa', 'writer')
    })
    expect(bindCodexHost).toHaveBeenCalledTimes(1)
    expect(revokeCodexSubscription).not.toHaveBeenCalled()
  })

  it('assigns multiple available agents to the same subscription in one action', async () => {
    vi.mocked(bindCodexHost)
      .mockResolvedValueOnce({ host: 'writer', connectionRef: 'codex-aaa' })
      .mockResolvedValueOnce({ host: 'researcher', connectionRef: 'codex-aaa' })
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    await waitFor(() => {
      expect(screen.getByLabelText('Add agents to this subscription')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByLabelText('Add agents to this subscription'))
    fireEvent.click(screen.getByRole('option', { name: 'writer' }))
    fireEvent.click(screen.getByRole('option', { name: 'researcher' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 agents' }))
    await waitFor(() => {
      expect(bindCodexHost).toHaveBeenCalledTimes(2)
    })
    expect(bindCodexHost).toHaveBeenNthCalledWith(1, 'codex-aaa', 'writer')
    expect(bindCodexHost).toHaveBeenNthCalledWith(2, 'codex-aaa', 'researcher')
    expect(revokeCodexSubscription).not.toHaveBeenCalled()
  })

  it('keeps assigning remaining agents when one bind fails', async () => {
    vi.mocked(bindCodexHost)
      .mockRejectedValueOnce(new Error('writer bind failed'))
      .mockResolvedValueOnce({ host: 'researcher', connectionRef: 'codex-aaa' })
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    await waitFor(() => {
      expect(screen.getByLabelText('Add agents to this subscription')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByLabelText('Add agents to this subscription'))
    fireEvent.click(screen.getByRole('option', { name: 'writer' }))
    fireEvent.click(screen.getByRole('option', { name: 'researcher' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 agents' }))
    await waitFor(() => {
      expect(bindCodexHost).toHaveBeenCalledTimes(2)
    })
    expect(bindCodexHost).toHaveBeenNthCalledWith(2, 'codex-aaa', 'researcher')
    expect(revokeCodexSubscription).not.toHaveBeenCalled()
  })

  it('confirms before switching a host from another named grant', async () => {
    confirmMock.mockResolvedValue(true)
    vi.mocked(listCodexSubscriptionFleet).mockResolvedValue({
      connections: [
        connection({ connectionKey: 'codex-aaa', displayName: 'Team A' }),
        connection({ connectionKey: 'codex-bbb', displayName: 'Team B' }),
      ],
      assignableHosts: [
        { name: 'chatllm', connectionRef: 'codex-bbb', displayName: 'chatllm' },
        { name: 'writer', connectionRef: 'unassigned', displayName: 'writer' },
      ],
      assignableHostsUnavailable: false,
    })
    vi.mocked(bindCodexHost).mockResolvedValue({ host: 'chatllm', connectionRef: 'codex-aaa' })
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    const teamA = await screen.findByTestId('codex-hub-grant-codex-aaa')
    fireEvent.click(within(teamA).getByLabelText('Add agents to this subscription'))
    fireEvent.click(within(teamA).getByRole('option', { name: 'chatllm' }))
    fireEvent.click(within(teamA).getByRole('button', { name: 'Add agents' }))
    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Switch chatllm to this subscription?',
        })
      )
    })
    expect(bindCodexHost).toHaveBeenCalledWith('codex-aaa', 'chatllm')
    expect(revokeCodexSubscription).not.toHaveBeenCalled()
  })

  it('confirms before switching a non-Codex agent to ChatGPT', async () => {
    confirmMock.mockResolvedValue(true)
    vi.mocked(listCodexSubscriptionFleet).mockResolvedValue({
      connections: [connection({ connectionKey: 'codex-aaa', displayName: 'Team A' })],
      assignableHosts: [
        {
          name: 'writer',
          connectionRef: 'unassigned',
          displayName: 'writer',
          provider: 'zai',
          model: 'glm-4.7',
        },
      ],
      assignableHostsUnavailable: false,
    })
    vi.mocked(bindCodexHost).mockResolvedValue({
      host: 'writer',
      connectionRef: 'codex-aaa',
      model: 'gpt-5.1',
    })
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    await waitFor(() => {
      expect(screen.getByLabelText('Add agents to this subscription')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByLabelText('Add agents to this subscription'))
    fireEvent.click(screen.getByRole('option', { name: 'writer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add agents' }))
    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Switch writer to ChatGPT?',
        })
      )
    })
    expect(bindCodexHost).toHaveBeenCalledWith('codex-aaa', 'writer')
  })

  it('unbinds an assigned agent without revoking', async () => {
    confirmMock.mockResolvedValue(true)
    vi.mocked(unbindCodexHost).mockResolvedValue({
      host: 'chatllm',
      connectionRef: 'unassigned',
    })
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove agent chatllm' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Remove agent chatllm' }))
    await waitFor(() => {
      expect(unbindCodexHost).toHaveBeenCalledWith('codex-aaa', 'chatllm')
    })
    expect(revokeCodexSubscription).not.toHaveBeenCalled()
  })

  it('revokes only from the hub danger action', async () => {
    confirmMock.mockResolvedValue(true)
    vi.mocked(revokeCodexSubscription).mockResolvedValue(
      connection({ connectionKey: 'codex-aaa', displayName: 'Team A', status: 'revoked' })
    )
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Revoke subscription' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Revoke subscription' }))
    await waitFor(() => {
      expect(revokeCodexSubscription).toHaveBeenCalledWith('codex-aaa')
    })
  })
})
