import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
        { name: 'chatllm', connectionRef: 'codex-aaa' },
        { name: 'writer', connectionRef: 'unassigned' },
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

  it('shows Assigned and Available fleet rows for a grant', async () => {
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Assigned' })).toBeInTheDocument()
    })
    expect(screen.getByRole('link', { name: 'chatllm' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Available' })).toBeInTheDocument()
    expect(screen.getByText(/writer/)).toBeInTheDocument()
    expect(screen.getByText(/no subscription assigned/i)).toBeInTheDocument()
  })

  it('assigns an available agent without revoking', async () => {
    vi.mocked(bindCodexHost).mockResolvedValue({ host: 'writer', connectionRef: 'codex-aaa' })
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Assign' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }))
    await waitFor(() => {
      expect(bindCodexHost).toHaveBeenCalledWith('codex-aaa', 'writer')
    })
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
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Assign' }).length).toBeGreaterThan(0)
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Assign' })[0])
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
      expect(screen.getByRole('button', { name: 'Remove agent' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }))
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
