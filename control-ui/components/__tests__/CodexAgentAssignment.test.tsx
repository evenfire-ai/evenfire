import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CodexSubscriptionConnectionView } from '@lib/codexSubscription'
import {
  createCodexSubscriptionConnection,
  listCodexConnectionModels,
  listCodexSubscriptionConnections,
} from '@lib/codexSubscription'
import { CodexAgentAssignment } from '../CodexAgentAssignment'
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
    listCodexSubscriptionConnections: vi.fn(),
    listCodexConnectionModels: vi.fn(),
    createCodexSubscriptionConnection: vi.fn(),
    startCodexDeviceConnect: vi.fn(),
    pollCodexDevice: vi.fn(),
    revokeCodexSubscription: vi.fn(),
    syncCodexSubscriptionCatalog: vi.fn(),
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

function renderAssignment(connectionRef: string, onConnectionRefChange = vi.fn()) {
  return {
    onConnectionRefChange,
    ...render(
      <ToastProvider>
        <CodexAgentAssignment
          connectionRef={connectionRef}
          onConnectionRefChange={onConnectionRefChange}
        />
      </ToastProvider>
    ),
  }
}

describe('CodexAgentAssignment', () => {
  beforeEach(() => {
    vi.mocked(listCodexConnectionModels).mockResolvedValue([])
    confirmMock.mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('keeps an unknown connectionRef and does not rematch on load', async () => {
    vi.mocked(listCodexSubscriptionConnections).mockResolvedValue([
      connection({ connectionKey: 'deployment-default', displayName: 'Default deployment' }),
    ])
    const { onConnectionRefChange } = renderAssignment('ghost-grant')
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'ghost-grant (unavailable)' })).toBeInTheDocument()
    })
    expect((screen.getByLabelText('ChatGPT subscription') as HTMLSelectElement).value).toBe(
      'ghost-grant'
    )
    expect(onConnectionRefChange).not.toHaveBeenCalled()
  })

  it('does not rewrite connectionRef when the connection list fails', async () => {
    vi.mocked(listCodexSubscriptionConnections).mockRejectedValue(new Error('list failed'))
    const { onConnectionRefChange } = renderAssignment('team-plus')
    await waitFor(() => {
      expect(screen.getByText('list failed')).toBeInTheDocument()
    })
    expect(onConnectionRefChange).not.toHaveBeenCalled()
    expect((screen.getByLabelText('ChatGPT subscription') as HTMLSelectElement).value).toBe(
      'team-plus'
    )
  })

  it('keeps a revoked current grant visible instead of replacing it', async () => {
    vi.mocked(listCodexSubscriptionConnections).mockResolvedValue([
      connection({
        connectionKey: 'team-plus',
        displayName: 'Team Plus',
        status: 'revoked',
      }),
      connection({ connectionKey: 'deployment-default', displayName: 'Default deployment' }),
    ])
    const { onConnectionRefChange } = renderAssignment('team-plus')
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Team Plus (revoked)' })).toBeInTheDocument()
    })
    expect((screen.getByLabelText('ChatGPT subscription') as HTMLSelectElement).value).toBe(
      'team-plus'
    )
    expect(onConnectionRefChange).not.toHaveBeenCalled()
  })

  it('changes connectionRef only after a successful create', async () => {
    vi.mocked(listCodexSubscriptionConnections).mockResolvedValue([
      connection({ connectionKey: 'deployment-default', displayName: 'Default deployment' }),
    ])
    vi.mocked(createCodexSubscriptionConnection).mockResolvedValue(
      connection({ connectionKey: 'codex-aabbccddeeff0011', displayName: 'Codex subscription' })
    )
    const { onConnectionRefChange } = renderAssignment('deployment-default')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New subscription' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: 'New subscription' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => {
      expect(onConnectionRefChange).toHaveBeenCalledWith('codex-aabbccddeeff0011')
    })
    expect(onConnectionRefChange).toHaveBeenCalledTimes(1)
  })
})
