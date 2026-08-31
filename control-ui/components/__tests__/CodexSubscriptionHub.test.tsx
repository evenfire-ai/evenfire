import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CodexSubscriptionConnectionView } from '@lib/codexSubscription'
import {
  createCodexSubscriptionConnection,
  listCodexConnectionModels,
  listCodexSubscriptionConnections,
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
    startCodexDeviceConnect: vi.fn(),
    pollCodexDevice: vi.fn(),
    syncCodexSubscriptionCatalog: vi.fn(),
    revokeCodexSubscription: vi.fn(),
  }
})

type DevicePollView = Awaited<ReturnType<typeof pollCodexDevice>>

const pendingPolls: Array<(value: DevicePollView) => void> = []

function holdDevicePoll() {
  vi.mocked(pollCodexDevice).mockImplementation(
    () =>
      new Promise<DevicePollView>(resolve => {
        pendingPolls.push(resolve)
      })
  )
}

function releaseDevicePolls(view: DevicePollView = { status: 'expired' }) {
  const resolvers = pendingPolls.splice(0)
  for (const resolve of resolvers) resolve(view)
}

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
    vi.mocked(startCodexDeviceConnect).mockResolvedValue({
      userCode: 'ABCD-1234',
      verificationUri: 'https://auth.openai.com/codex/device',
      intervalSeconds: 0.001,
      state: 'state-1',
      intent: 'connect',
    })
    pendingPolls.length = 0
    holdDevicePoll()
  })

  afterEach(async () => {
    try {
      await new Promise(resolve => setTimeout(resolve, 20))
      releaseDevicePolls()
    } finally {
      cleanup()
      vi.clearAllMocks()
    }
  })

  it('opens the sync modal and starts device connect after Create without using the pencil', async () => {
    const created = connection({
      connectionKey: 'codex-bbb',
      displayName: 'New team',
      status: 'disconnected',
      catalogStatus: 'never_synced',
    })
    vi.mocked(createCodexSubscriptionConnection).mockResolvedValue(created)
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    expect(await screen.findByText('Team A')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add subscription' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'New team' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => {
      expect(createCodexSubscriptionConnection).toHaveBeenCalledWith({ displayName: 'New team' })
    })
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Sign in with ChatGPT' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sync catalog' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Enabled models' })).not.toBeInTheDocument()
    await waitFor(() => {
      expect(startCodexDeviceConnect).toHaveBeenCalledWith('connect', 'codex-bbb')
    })
    expect(syncCodexSubscriptionCatalog).not.toHaveBeenCalled()
    expect(revokeCodexSubscription).not.toHaveBeenCalled()
  })

  it('keeps the Add subscription dialog when Create is rejected', async () => {
    vi.mocked(createCodexSubscriptionConnection).mockRejectedValue(new Error('name taken'))
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Add subscription' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Taken name' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByText('name taken')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Add subscription' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in with ChatGPT' })).not.toBeInTheDocument()
    expect(startCodexDeviceConnect).not.toHaveBeenCalled()
  })

  it('does not POST when Create is clicked with an empty name', async () => {
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Add subscription' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByText('Subscription name is required.')).toBeInTheDocument()
    expect(createCodexSubscriptionConnection).not.toHaveBeenCalled()
    expect(startCodexDeviceConnect).not.toHaveBeenCalled()
  })

  it('renders a ChatGPT verification link and copies the device code', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    vi.mocked(createCodexSubscriptionConnection).mockResolvedValue(
      connection({
        connectionKey: 'codex-bbb',
        displayName: 'New team',
        status: 'disconnected',
        catalogStatus: 'never_synced',
      })
    )
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Add subscription' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'New team' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    const link = await screen.findByTestId('codex-device-verification-link')
    expect(link).toHaveAttribute('href', 'https://auth.openai.com/codex/device')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel') ?? '').toContain('noopener')
    expect(link.getAttribute('rel') ?? '').toContain('noreferrer')
    expect(screen.getByTestId('codex-device-code').closest('[role="status"]')).toHaveTextContent(
      'ABCD-1234'
    )
    expect(screen.getByRole('button', { name: 'Update subscription' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Saving…' })).not.toBeInTheDocument()
    expect(screen.getByTestId('codex-device-code')).toHaveTextContent('ABCD-1234')
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('ABCD-1234')
    })
    expect(await screen.findByText('Code copied')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  it('does not POST catalog/sync after a ready poll', async () => {
    vi.mocked(createCodexSubscriptionConnection).mockResolvedValue(
      connection({
        connectionKey: 'codex-bbb',
        displayName: 'New team',
        status: 'disconnected',
        catalogStatus: 'never_synced',
      })
    )
    vi.mocked(startCodexDeviceConnect).mockResolvedValue({
      userCode: 'ABCD-1234',
      verificationUri: 'https://auth.openai.com/codex/device',
      intervalSeconds: 0.001,
      state: 'state-1',
      intent: 'connect',
    })
    vi.mocked(pollCodexDevice).mockResolvedValue({
      status: 'connected',
      connection: connection({
        connectionKey: 'codex-bbb',
        displayName: 'New team',
        catalogStatus: 'ready',
      }),
    })
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Add subscription' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'New team' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => {
      expect(pollCodexDevice).toHaveBeenCalled()
    })
    expect(await screen.findByText('Connected — catalog synced')).toBeInTheDocument()
    expect(syncCodexSubscriptionCatalog).not.toHaveBeenCalled()
  })

  it('does not toast Connected after Cancel during the post-connect catalog load', async () => {
    let resolveModels!: (value: Array<{ model: string; enabled: boolean; stale: boolean }>) => void
    vi.mocked(listCodexConnectionModels).mockImplementation(
      () =>
        new Promise(resolve => {
          resolveModels = resolve
        })
    )
    vi.mocked(createCodexSubscriptionConnection).mockResolvedValue(
      connection({
        connectionKey: 'codex-bbb',
        displayName: 'New team',
        status: 'disconnected',
        catalogStatus: 'never_synced',
      })
    )
    vi.mocked(pollCodexDevice).mockResolvedValue({
      status: 'connected',
      connection: connection({
        connectionKey: 'codex-bbb',
        displayName: 'New team',
        catalogStatus: 'ready',
      }),
    })
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Add subscription' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'New team' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => {
      expect(listCodexConnectionModels).toHaveBeenCalledWith('codex-bbb')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    resolveModels([{ model: 'gpt-5.1', enabled: true, stale: false }])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen.queryByText('Connected — catalog synced')).not.toBeInTheDocument()
  })

  it('keeps the sync modal open with Sign in when device/start fails after Create', async () => {
    vi.mocked(createCodexSubscriptionConnection).mockResolvedValue(
      connection({
        connectionKey: 'codex-ccc',
        displayName: 'Retry team',
        status: 'disconnected',
        catalogStatus: 'never_synced',
      })
    )
    vi.mocked(startCodexDeviceConnect).mockRejectedValue(new Error('device start failed'))
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Add subscription' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Retry team' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByRole('button', { name: 'Sign in with ChatGPT' })).toBeInTheDocument()
    expect(await screen.findByText('device start failed')).toBeInTheDocument()
  })

  it('renders subscriptions as a Secrets table with pencil and delete actions', async () => {
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    expect(await screen.findByText('Team A')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'API-KEY' })).toHaveAttribute('href', '/secrets/llm')
    expect(screen.getByRole('tab', { name: 'Subscriptions' })).toHaveAttribute(
      'href',
      '/secrets/llm/subscriptions'
    )
    expect(screen.queryByRole('columnheader', { name: 'Agents' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Add agents to this subscription')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Update ChatGPT subscription Team A' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Delete ChatGPT subscription Team A' })
    ).toBeInTheDocument()
  })

  it('renders the ChatGPT verification link from the pencil Sign in path', async () => {
    vi.mocked(startCodexDeviceConnect).mockResolvedValue({
      userCode: 'WXYZ-9876',
      verificationUri: 'https://auth.openai.com/codex/device',
      intervalSeconds: 0.001,
      state: 'state-pencil',
      intent: 'reconnect',
    })
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Update ChatGPT subscription Team A' })
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with ChatGPT' }))
    const link = await screen.findByTestId('codex-device-verification-link')
    expect(link).toHaveAttribute('href', 'https://auth.openai.com/codex/device')
    expect(link.getAttribute('rel') ?? '').toContain('noopener')
    expect(link.getAttribute('rel') ?? '').toContain('noreferrer')
    expect(screen.getByTestId('codex-device-code').closest('[role="status"]')).toHaveTextContent(
      'WXYZ-9876'
    )
    expect(screen.getByRole('button', { name: 'Update subscription' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Saving…' })).not.toBeInTheDocument()
  })

  it('opens the grant modal for Sign in and default model without a Sync catalog control', async () => {
    vi.mocked(startCodexDeviceConnect).mockResolvedValue({
      userCode: 'ABCD-1234',
      verificationUri: 'https://auth.openai.com/codex/device',
      intervalSeconds: 1,
      state: 'state-1',
      intent: 'connect',
    })
    vi.mocked(patchCodexSubscriptionConnection).mockResolvedValue(
      connection({ connectionKey: 'codex-aaa', displayName: 'Team A', defaultModel: 'gpt-5.1' })
    )
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Update ChatGPT subscription Team A' })
    )
    expect(await screen.findByRole('button', { name: 'Sign in with ChatGPT' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sync catalog' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Enabled models' })).not.toBeInTheDocument()
    expect(listCodexConnectionModels).toHaveBeenCalledWith('codex-aaa')
    expect(syncCodexSubscriptionCatalog).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Update subscription' }))
    await waitFor(() => {
      expect(patchCodexSubscriptionConnection).toHaveBeenCalledWith('codex-aaa', {
        displayName: 'Team A',
        defaultModel: 'gpt-5.1',
      })
    })
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
      await screen.findByRole('button', { name: 'Delete ChatGPT subscription Team A' })
    )
    await waitFor(() => {
      expect(revokeCodexSubscription).toHaveBeenCalledWith('codex-aaa')
    })
  })
})
