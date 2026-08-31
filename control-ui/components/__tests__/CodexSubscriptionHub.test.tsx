import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CodexSubscriptionConnectionView } from '@lib/codexSubscription'
import {
  createCodexSubscriptionConnection,
  listCodexConnectionModels,
  listCodexSubscriptionConnections,
  patchCodexCatalogModel,
  patchCodexSubscriptionConnection,
  pollCodexDevice,
  revokeCodexSubscription,
  startCodexDeviceConnect,
  syncCodexSubscriptionCatalog,
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
    listCodexSubscriptionConnections: vi.fn(),
    listCodexConnectionModels: vi.fn(),
    createCodexSubscriptionConnection: vi.fn(),
    patchCodexSubscriptionConnection: vi.fn(),
    patchCodexCatalogModel: vi.fn(),
    startCodexDeviceConnect: vi.fn(),
    pollCodexDevice: vi.fn(),
    syncCodexSubscriptionCatalog: vi.fn(),
    revokeCodexSubscription: vi.fn(),
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
    defaultModel: 'gpt-5.1',
    ...overrides,
  }
}

describe('CodexSubscriptionHub', () => {
  beforeEach(() => {
    confirmMock.mockReset()
    vi.mocked(listCodexSubscriptionConnections).mockResolvedValue([
      connection({ connectionKey: 'codex-aaa', displayName: 'Team A' }),
    ])
    vi.mocked(listCodexConnectionModels).mockResolvedValue([
      { model: 'gpt-5.1', enabled: true, stale: false },
      { model: 'gpt-5.3-codex', enabled: false, stale: false },
    ])
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('opens Add with a draft grant and the full setup form, and finishes with the typed name', async () => {
    vi.mocked(createCodexSubscriptionConnection).mockResolvedValue(
      connection({
        connectionKey: 'codex-bbb',
        displayName: 'Codex subscription',
        defaultModel: null,
      })
    )
    vi.mocked(patchCodexSubscriptionConnection).mockResolvedValue(
      connection({ connectionKey: 'codex-bbb', displayName: 'New team', defaultModel: null })
    )
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    expect(await screen.findByText('Team A')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add subscription' }))
    const nameInput = await screen.findByRole('textbox', { name: 'Name' })
    fireEvent.change(nameInput, { target: { value: 'New team' } })
    expect(await screen.findByRole('button', { name: 'Finish setup' })).toBeInTheDocument()
    expect(createCodexSubscriptionConnection).toHaveBeenCalledWith({ displayName: '' })
    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }))
    await waitFor(() => {
      expect(patchCodexSubscriptionConnection).toHaveBeenCalledWith('codex-bbb', {
        displayName: 'New team',
        defaultModel: null,
      })
    })
    expect(revokeCodexSubscription).not.toHaveBeenCalled()
  })

  it('revokes the pristine draft when the Add dialog is cancelled', async () => {
    vi.mocked(createCodexSubscriptionConnection).mockResolvedValue(
      connection({
        connectionKey: 'codex-ccc',
        displayName: 'Codex subscription',
        defaultModel: null,
        status: 'disconnected',
      })
    )
    vi.mocked(revokeCodexSubscription).mockResolvedValue(
      connection({
        connectionKey: 'codex-ccc',
        displayName: 'Codex subscription',
        status: 'revoked',
      })
    )
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    expect(await screen.findByText('Team A')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add subscription' }))
    await screen.findByRole('button', { name: 'Finish setup' })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => {
      expect(revokeCodexSubscription).toHaveBeenCalledWith('codex-ccc')
    })
  })

  it('renders subscriptions as a Secrets table with a row actions menu', async () => {
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    expect(await screen.findByText('Team A')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'LLM API Keys' })).toHaveAttribute(
      'href',
      '/secrets/llm'
    )
    expect(screen.getByRole('tab', { name: 'LLM Subscriptions' })).toHaveAttribute(
      'href',
      '/secrets/llm/subscriptions'
    )
    expect(screen.queryByRole('columnheader', { name: 'Agents' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Add agents to this subscription')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for ChatGPT subscription Team A' }))
    expect(screen.getByRole('menuitem', { name: 'Update' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument()
  })

  it('opens the grant modal for Sign in, Sync, and model toggles without binding hosts', async () => {
    vi.mocked(startCodexDeviceConnect).mockResolvedValue({
      userCode: 'ABCD-1234',
      verificationUri: 'https://chatgpt.com/device',
      intervalSeconds: 1,
      state: 'state-1',
      intent: 'connect',
    })
    vi.mocked(syncCodexSubscriptionCatalog).mockResolvedValue({
      outcome: 'ready',
      added: 1,
      refreshed: 0,
      staled: 0,
      connection: connection({ connectionKey: 'codex-aaa', displayName: 'Team A' }),
    })
    vi.mocked(patchCodexCatalogModel).mockResolvedValue([
      { model: 'gpt-5.1', enabled: true, stale: false },
      { model: 'gpt-5.3-codex', enabled: true, stale: false },
    ])
    vi.mocked(patchCodexSubscriptionConnection).mockResolvedValue(
      connection({ connectionKey: 'codex-aaa', displayName: 'Team A', defaultModel: 'gpt-5.1' })
    )
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for ChatGPT subscription Team A' })
    )
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Update' }))
    expect(await screen.findByRole('button', { name: 'Sign in with ChatGPT' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sync catalog' })).toBeInTheDocument()
    expect(listCodexConnectionModels).toHaveBeenCalledWith('codex-aaa')
    fireEvent.click(screen.getByRole('button', { name: 'Sync catalog' }))
    await waitFor(() => {
      expect(syncCodexSubscriptionCatalog).toHaveBeenCalledWith('codex-aaa')
    })
    fireEvent.click(screen.getByLabelText('gpt-5.3-codex'))
    await waitFor(() => {
      expect(patchCodexCatalogModel).toHaveBeenCalledWith('codex-aaa', 'gpt-5.3-codex', true)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Update subscription' }))
    await waitFor(() => {
      expect(patchCodexSubscriptionConnection).toHaveBeenCalledWith('codex-aaa', {
        displayName: 'Team A',
        defaultModel: 'gpt-5.1',
      })
    })
  })

  it('opens ChatGPT in a new tab and shows the device code with copy actions', async () => {
    const openMock = vi.fn(() => null)
    vi.stubGlobal('open', openMock)
    vi.mocked(startCodexDeviceConnect).mockResolvedValue({
      userCode: 'ABCD-1234',
      verificationUri: 'https://chatgpt.com/device',
      // Long enough that the card is observable; short enough that the
      // auto-dismiss waitFor completes comfortably inside its timeout.
      intervalSeconds: 0.3,
      state: 'state-1',
      intent: 'connect',
    })
    vi.mocked(pollCodexDevice).mockResolvedValue({
      status: 'connected',
      connection: connection({ connectionKey: 'codex-aaa', displayName: 'Team A' }),
    })
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for ChatGPT subscription Team A' })
    )
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Update' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with ChatGPT' }))
    const card = await screen.findByTestId('codex-device-code')
    expect(card).toHaveTextContent('ABCD-1234')
    expect(openMock).toHaveBeenCalledWith(
      'https://chatgpt.com/device',
      '_blank',
      'noopener,noreferrer'
    )
    expect(screen.getByRole('link', { name: 'https://chatgpt.com/device' })).toHaveAttribute(
      'target',
      '_blank'
    )
    expect(screen.getByRole('button', { name: 'Copy sign-in link' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy device code' })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByTestId('codex-device-code')).not.toBeInTheDocument()
    })
    expect(listCodexConnectionModels).toHaveBeenCalledWith('codex-aaa')
  })

  it('revokes from the table delete action after confirm', async () => {
    confirmMock.mockResolvedValue(true)
    vi.mocked(revokeCodexSubscription).mockResolvedValue(
      connection({ connectionKey: 'codex-aaa', displayName: 'Team A', status: 'revoked' })
    )
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for ChatGPT subscription Team A' })
    )
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    await waitFor(() => {
      expect(revokeCodexSubscription).toHaveBeenCalledWith('codex-aaa')
    })
  })
})
