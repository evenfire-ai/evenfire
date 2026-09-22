import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CodexSubscriptionConnectionView } from '@lib/codexSubscription'
import {
  CODEX_DEVICE_VERIFICATION_URI,
  createCodexSubscriptionConnection,
  listCodexConnectionModels,
  listCodexSubscriptionConnections,
  patchCodexCatalogModel,
  patchCodexSubscriptionConnection,
  pollCodexDevice,
  revokeCodexSubscription,
  startCodexDeviceConnect,
} from '@lib/codexSubscription'
import {
  listGrokConnectionModels,
  listGrokSubscriptionConnections,
  pollGrokDevice,
  revokeGrokSubscription,
  startGrokDeviceConnect,
} from '@lib/grokSubscription'
import { CodexSubscriptionHub } from '../CodexSubscriptionHub'
import { ToastProvider } from '../Toast'

const confirmMock = vi.fn()

const capabilityProbes = vi.hoisted(() => ({
  codex: vi.fn(),
  grok: vi.fn(),
}))

vi.mock('@components/ConfirmDialog', () => ({
  useConfirmDialog: () => ({
    confirm: confirmMock,
    confirmDialog: null,
  }),
}))

vi.mock('@lib/codexSubscriptionFeature', () => ({
  isCodexSubscriptionUiEnabled: (capability?: { enabled?: boolean } | null) =>
    capability?.enabled === true,
  loadCodexSubscriptionCapability: () => capabilityProbes.codex(),
}))

vi.mock('@lib/grokSubscriptionFeature', () => ({
  isGrokSubscriptionUiEnabled: (capability?: { enabled?: boolean } | null) =>
    capability?.enabled === true,
  loadGrokSubscriptionCapability: () => capabilityProbes.grok(),
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
    // syncCodexSubscriptionCatalog is deliberately NOT overridden: the catalog
    // re-sync suite drives the real client against a stubbed `fetch`, so the
    // assertions cover the method, the URL and the error taxonomy rather than
    // proving a button is wired to a spy.
    revokeCodexSubscription: vi.fn(),
  }
})

vi.mock('@lib/grokSubscription', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/grokSubscription')>()
  return {
    ...actual,
    listGrokSubscriptionConnections: vi.fn(),
    listGrokConnectionModels: vi.fn(),
    createGrokSubscriptionConnection: vi.fn(),
    patchGrokSubscriptionConnection: vi.fn(),
    patchGrokCatalogModel: vi.fn(),
    startGrokDeviceConnect: vi.fn(),
    pollGrokDevice: vi.fn(),
    revokeGrokSubscription: vi.fn(),
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

// Advance only the (faked) poll-loop setTimeout clock and flush the awaited
// poll/start promises so the next loop timer is registered.
async function advanceDevicePoll(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
  await vi.advanceTimersByTimeAsync(0)
}

describe('CodexSubscriptionHub', () => {
  beforeEach(() => {
    confirmMock.mockReset()
    capabilityProbes.codex.mockResolvedValue({ enabled: true })
    capabilityProbes.grok.mockResolvedValue({ enabled: false })
    vi.mocked(listGrokSubscriptionConnections).mockResolvedValue([])
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

  it('creates the subscription when the name is confirmed and auto-starts sign-in', async () => {
    vi.stubGlobal(
      'open',
      vi.fn(() => ({}))
    )
    vi.mocked(createCodexSubscriptionConnection).mockResolvedValue(
      connection({
        connectionKey: 'codex-bbb',
        displayName: 'New team',
        status: 'disconnected',
        defaultModel: null,
      })
    )
    vi.mocked(startCodexDeviceConnect).mockResolvedValue({
      userCode: 'ABCD-1234',
      verificationUri: CODEX_DEVICE_VERIFICATION_URI,
      intervalSeconds: 0.3,
      state: 'state-1',
      intent: 'connect',
    })
    vi.mocked(pollCodexDevice).mockResolvedValue({
      status: 'connected',
      connection: connection({ connectionKey: 'codex-bbb', displayName: 'New team' }),
    })
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

    // Before creating, the full form is shown and sign-in is live: clicking it
    // creates the grant with the typed name and chains into sign-in.
    expect(createCodexSubscriptionConnection).not.toHaveBeenCalled()
    const nameInput = screen.getByRole('textbox', { name: 'Name' })
    const signIn = screen.getByRole('button', { name: 'Sign in with ChatGPT' })
    expect(signIn).toBeEnabled()

    fireEvent.change(nameInput, { target: { value: 'New team' } })
    fireEvent.click(signIn)
    await waitFor(() => {
      expect(createCodexSubscriptionConnection).toHaveBeenCalledWith({ displayName: 'New team' })
    })
    await waitFor(() => {
      expect(startCodexDeviceConnect).toHaveBeenCalledWith('connect', 'codex-bbb')
    })
    // Once the device flow settles the dialog keeps the setup form with the
    // models synced by the connect handshake.
    await waitFor(() => {
      expect(listCodexConnectionModels).toHaveBeenCalledWith('codex-bbb')
    })
    const finish = await screen.findByRole('button', { name: 'Finish setup' })
    fireEvent.click(finish)
    await waitFor(() => {
      expect(patchCodexSubscriptionConnection).toHaveBeenCalledWith('codex-bbb', {
        displayName: 'New team',
        defaultModel: null,
      })
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(revokeCodexSubscription).not.toHaveBeenCalled()
  })

  it('reports partial success and still starts sign-in when the post-create reload fails', async () => {
    vi.stubGlobal(
      'open',
      vi.fn(() => ({}))
    )
    const listMock = vi.mocked(listCodexSubscriptionConnections)
    listMock
      .mockResolvedValueOnce([connection({ connectionKey: 'codex-aaa', displayName: 'Team A' })])
      .mockRejectedValueOnce(new Error('refresh boom'))
      .mockResolvedValue([connection({ connectionKey: 'codex-aaa', displayName: 'Team A' })])
    vi.mocked(createCodexSubscriptionConnection).mockResolvedValue(
      connection({
        connectionKey: 'codex-bbb',
        displayName: 'New team',
        status: 'disconnected',
        defaultModel: null,
      })
    )
    vi.mocked(startCodexDeviceConnect).mockResolvedValue({
      userCode: 'ABCD-1234',
      verificationUri: CODEX_DEVICE_VERIFICATION_URI,
      intervalSeconds: 0.3,
      state: 'state-1',
      intent: 'connect',
    })
    vi.mocked(pollCodexDevice).mockResolvedValue({
      status: 'connected',
      connection: connection({ connectionKey: 'codex-bbb', displayName: 'New team' }),
    })
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
    fireEvent.click(screen.getByRole('button', { name: 'Create and set up' }))
    await waitFor(() => {
      expect(createCodexSubscriptionConnection).toHaveBeenCalledWith({ displayName: 'New team' })
    })
    // The reload failure must not prevent sign-in from starting.
    await waitFor(() => {
      expect(startCodexDeviceConnect).toHaveBeenCalledWith('connect', 'codex-bbb')
    })
    // …and must be reported as partial success, not as a creation failure.
    expect(
      await screen.findByText('Subscription created, but the list could not be refreshed.')
    ).toBeInTheDocument()
    expect(screen.queryByText('Could not create subscription')).not.toBeInTheDocument()
    expect(screen.queryByText('refresh boom')).not.toBeInTheDocument()
    // The setup flow still completes once the device connect settles.
    await waitFor(() => {
      expect(listCodexConnectionModels).toHaveBeenCalledWith('codex-bbb')
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

  it('renders the ChatGPT verification link from the Update sign-in path', async () => {
    vi.stubGlobal(
      'open',
      vi.fn(() => ({}))
    )
    vi.mocked(startCodexDeviceConnect).mockResolvedValue({
      userCode: 'WXYZ-9876',
      verificationUri: 'https://auth.openai.com/codex/device',
      intervalSeconds: 0.3,
      state: 'state-pencil',
      intent: 'reconnect',
    })
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for ChatGPT subscription Team A' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with ChatGPT' }))
    const link = await screen.findByTestId('codex-device-verification-link')
    expect(link).toHaveAttribute('href', 'https://auth.openai.com/codex/device')
    expect(link.getAttribute('rel') ?? '').toContain('noopener')
    expect(link.getAttribute('rel') ?? '').toContain('noreferrer')
    expect(screen.getByTestId('codex-device-code')).toHaveTextContent('WXYZ-9876')
  })

  it('opens the grant modal for reconnect and model toggles without binding hosts', async () => {
    vi.mocked(startCodexDeviceConnect).mockResolvedValue({
      userCode: 'ABCD-1234',
      verificationUri: CODEX_DEVICE_VERIFICATION_URI,
      intervalSeconds: 1,
      state: 'state-1',
      intent: 'reconnect',
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
    // Connect syncs the catalog once; a connected grant also offers the manual
    // re-sync, because nothing refreshes it afterwards on its own.
    expect(screen.getByRole('button', { name: 'Sync catalog' })).toBeInTheDocument()
    // …and the hint must say so. Nothing refreshes a connected grant's catalog
    // on its own, so the old "refreshes automatically" was false for every grant
    // past its handshake. The witness for the negative is the positive clause
    // rendered by the same element.
    const signInHint = screen.getByText(/Agents authorize through this subscription/)
    expect(signInHint).toHaveTextContent('use Sync catalog to pick up models published since')
    expect(signInHint).not.toHaveTextContent('refreshes automatically')
    expect(listCodexConnectionModels).toHaveBeenCalledWith('codex-aaa')
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

  it('shows the device code card with the verification link and copy actions', async () => {
    const openMock = vi.fn(() => ({}))
    vi.stubGlobal('open', openMock)
    vi.mocked(startCodexDeviceConnect).mockResolvedValue({
      userCode: 'ABCD-1234',
      verificationUri: CODEX_DEVICE_VERIFICATION_URI,
      // Long enough that the card is observable; short enough that the
      // auto-dismiss waitFor completes comfortably inside its timeout.
      intervalSeconds: 0.3,
      state: 'state-1',
      intent: 'reconnect',
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
    // The verification tab opens synchronously in the click handler.
    expect(openMock).toHaveBeenCalledWith(
      'https://auth.openai.com/codex/device',
      '_blank',
      'noopener,noreferrer'
    )
    const link = screen.getByTestId('codex-device-verification-link')
    expect(link).toHaveAttribute('href', CODEX_DEVICE_VERIFICATION_URI)
    expect(link).toHaveAttribute('target', '_blank')
    expect(screen.getByRole('button', { name: 'Copy sign-in link' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument()
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

  // B-L7: the device poll loop must follow polled.intervalSeconds and back off
  // on slow_down (RFC 8628 §3.5: +5s), not re-use the start interval forever.
  it('backs off by 5s on a Codex slow_down before the next device poll', async () => {
    vi.stubGlobal(
      'open',
      vi.fn(() => ({}))
    )
    vi.mocked(startCodexDeviceConnect).mockResolvedValue({
      userCode: 'ABCD-1234',
      verificationUri: CODEX_DEVICE_VERIFICATION_URI,
      intervalSeconds: 5,
      state: 'state-1',
      intent: 'reconnect',
    })
    vi.mocked(pollCodexDevice)
      .mockResolvedValueOnce({ status: 'slow_down', intervalSeconds: 5, state: 'state-1' })
      .mockResolvedValue({ status: 'pending', intervalSeconds: 5, state: 'state-1' })
    render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for ChatGPT subscription Team A' })
    )
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Update' }))
    const signIn = await screen.findByRole('button', { name: 'Sign in with ChatGPT' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      fireEvent.click(signIn)
      // RTL findBy* drains via setTimeout(0), which is faked here — flush manually.
      await advanceDevicePoll(0)
      expect(screen.getByTestId('codex-device-code')).toHaveTextContent('ABCD-1234')
      await advanceDevicePoll(4_900)
      expect(pollCodexDevice).not.toHaveBeenCalled()
      await advanceDevicePoll(100)
      expect(pollCodexDevice).toHaveBeenCalledTimes(1)
      // slow_down with the same interval: 5s + 5s back-off, never the start 5s.
      await advanceDevicePoll(9_900)
      expect(pollCodexDevice).toHaveBeenCalledTimes(1)
      await advanceDevicePoll(100)
      expect(pollCodexDevice).toHaveBeenCalledTimes(2)
      expect(pollCodexDevice).toHaveBeenLastCalledWith('state-1', 'codex-aaa')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('CodexSubscriptionHub with Grok enabled', () => {
  function renderHub() {
    return render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
  }

  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  function attributeText(root: HTMLElement): string {
    return Array.from(root.querySelectorAll('*'))
      .flatMap(node => [node.getAttribute('aria-label'), node.getAttribute('title')])
      .filter(Boolean)
      .join(' ')
  }

  beforeEach(() => {
    confirmMock.mockReset()
    capabilityProbes.codex.mockResolvedValue({ enabled: true })
    capabilityProbes.grok.mockResolvedValue({ enabled: true })
    vi.mocked(listCodexSubscriptionConnections).mockResolvedValue([
      connection({ connectionKey: 'codex-aaa', displayName: 'Team A' }),
    ])
    vi.mocked(listGrokSubscriptionConnections).mockResolvedValue([
      connection({ connectionKey: 'grok-aaa', displayName: 'Team Grok', defaultModel: 'grok-4.6' }),
    ])
    vi.mocked(listCodexConnectionModels).mockResolvedValue([
      { model: 'gpt-5.1', enabled: true, stale: false },
    ])
    vi.mocked(listGrokConnectionModels).mockResolvedValue([
      { model: 'grok-4.6', enabled: true, stale: false },
      { model: 'grok-code-old', enabled: false, stale: true },
    ])
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps Grok rows and reports the Codex error when the Codex list fails', async () => {
    vi.mocked(listCodexSubscriptionConnections).mockRejectedValue(new Error('codex list boom'))
    renderHub()
    expect(await screen.findByText('Team Grok')).toBeInTheDocument()
    expect(await screen.findByText(/codex list boom/)).toBeInTheDocument()
    expect(screen.queryByText('Team A')).not.toBeInTheDocument()
  })

  it('keeps Codex rows and reports the Grok error when the Grok list fails', async () => {
    vi.mocked(listGrokSubscriptionConnections).mockRejectedValue(new Error('grok list boom'))
    renderHub()
    expect(await screen.findByText('Team A')).toBeInTheDocument()
    expect(await screen.findByText(/grok list boom/)).toBeInTheDocument()
    expect(screen.queryByText('Team Grok')).not.toBeInTheDocument()
  })

  it('recovers the failed provider on reload without losing the healthy one', async () => {
    vi.mocked(listGrokSubscriptionConnections)
      .mockRejectedValueOnce(new Error('grok list boom'))
      .mockResolvedValue([connection({ connectionKey: 'grok-aaa', displayName: 'Team Grok' })])
    renderHub()
    expect(await screen.findByText(/grok list boom/)).toBeInTheDocument()
    expect(screen.getByText('Team A')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Reload/ }))
    expect(await screen.findByText('Team Grok')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByText(/grok list boom/)).not.toBeInTheDocument()
    })
    expect(screen.getByText('Team A')).toBeInTheDocument()
  })

  it('surfaces a non-disabled Codex capability probe error while Grok is enabled', async () => {
    capabilityProbes.codex.mockRejectedValue(new Error('codex probe boom'))
    renderHub()
    expect(await screen.findByText('Team Grok')).toBeInTheDocument()
    expect(await screen.findByText(/codex probe boom/)).toBeInTheDocument()
  })

  it('surfaces a non-disabled Grok capability probe error while Codex is enabled', async () => {
    capabilityProbes.grok.mockRejectedValue(new Error('grok probe boom'))
    renderHub()
    expect(await screen.findByText('Team A')).toBeInTheDocument()
    expect(await screen.findByText(/grok probe boom/)).toBeInTheDocument()
  })

  it('surfaces a non-disabled Grok capability probe error when Codex is disabled', async () => {
    capabilityProbes.codex.mockResolvedValue({ enabled: false })
    capabilityProbes.grok.mockRejectedValue(new Error('grok probe boom'))
    renderHub()
    expect(await screen.findByText(/grok probe boom/)).toBeInTheDocument()
  })

  it('keeps same-key Codex and Grok rows independent for keys, busy state and edit-close', async () => {
    const consoleError = vi.spyOn(console, 'error')
    vi.mocked(listCodexSubscriptionConnections).mockResolvedValue([
      connection({ connectionKey: 'shared', displayName: 'Shared Codex' }),
    ])
    vi.mocked(listGrokSubscriptionConnections).mockResolvedValue([
      connection({ connectionKey: 'shared', displayName: 'Shared Grok' }),
    ])
    const revoke = deferred<CodexSubscriptionConnectionView>()
    vi.mocked(revokeCodexSubscription).mockReturnValue(revoke.promise)
    confirmMock.mockResolvedValue(true)
    renderHub()
    expect(await screen.findByText('Shared Codex')).toBeInTheDocument()
    expect(screen.getByText('Shared Grok')).toBeInTheDocument()
    expect(consoleError.mock.calls.some(call => String(call[0]).includes('same key'))).toBe(false)

    // Open the Grok row, then delete the same-key Codex row.
    fireEvent.click(
      screen.getByRole('button', { name: 'Actions for Grok subscription Shared Grok' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update' }))
    expect(
      await screen.findByRole('dialog', { name: 'Update Grok subscription Shared Grok' })
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Actions for ChatGPT subscription Shared Codex' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    await waitFor(() => expect(revokeCodexSubscription).toHaveBeenCalledWith('shared'))

    // Codex row is busy; the same-key Grok row is not.
    fireEvent.click(
      screen.getByRole('button', { name: 'Actions for Grok subscription Shared Grok' })
    )
    const grokDelete = screen.getByRole('menuitem', { name: 'Delete' })
    expect(grokDelete).not.toHaveAttribute('aria-disabled', 'true')
    expect(grokDelete).not.toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })

    revoke.resolve(connection({ connectionKey: 'shared', status: 'revoked' }))
    await waitFor(() => expect(listCodexSubscriptionConnections).toHaveBeenCalledTimes(2))
    // Revoking the Codex row must not close the open Grok dialog.
    expect(
      screen.getByRole('dialog', { name: 'Update Grok subscription Shared Grok' })
    ).toBeInTheDocument()
    expect(revokeGrokSubscription).not.toHaveBeenCalled()
  })

  it('uses Grok copy (no ChatGPT wording) across the Grok dialog, device card and models', async () => {
    const tab = { opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() }
    vi.stubGlobal(
      'open',
      vi.fn(() => tab)
    )
    vi.mocked(startGrokDeviceConnect).mockResolvedValue({
      userCode: 'GROK-1234',
      verificationUri: 'https://auth.x.ai/device?user_code=GROK-1234',
      intervalSeconds: 60,
      state: 'grok-state',
      intent: 'reconnect',
    })
    renderHub()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for Grok subscription Team Grok' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Update Grok subscription Team Grok',
    })
    expect(await within(dialog).findByLabelText('grok-4.6')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign in with Grok' }))
    expect(await within(dialog).findByTestId('codex-device-code')).toHaveTextContent('GROK-1234')
    expect(dialog.textContent ?? '').not.toMatch(/ChatGPT/)
    expect(attributeText(dialog)).not.toMatch(/ChatGPT/)
    expect(within(dialog).getByText(/No longer in the Grok catalog/)).toBeInTheDocument()
    expect(dialog.querySelectorAll('[data-provider="codex-subscription"]').length).toBe(0)
  })

  it('titles the Grok create dialog for Grok when Grok is the selected provider', async () => {
    renderHub()
    await screen.findByText('Team Grok')
    fireEvent.click(screen.getByRole('button', { name: 'Add subscription' }))
    const dialog = await screen.findByRole('dialog', { name: 'New ChatGPT subscription' })
    fireEvent.change(within(dialog).getByLabelText('Provider'), {
      target: { value: 'grok-subscription' },
    })
    expect(await screen.findByRole('dialog', { name: 'New Grok subscription' })).toBeInTheDocument()
    expect(dialog.textContent ?? '').not.toMatch(/ChatGPT sign-in|Sign in with ChatGPT/)
  })

  it('opens a tab before the awaited start and navigates it to the returned Grok verification URI', async () => {
    const tab = { opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() }
    const openMock = vi.fn(() => tab)
    vi.stubGlobal('open', openMock)
    const started = deferred<{
      userCode: string
      verificationUri: string
      intervalSeconds: number
      state: string
      intent: 'reconnect'
    }>()
    vi.mocked(startGrokDeviceConnect).mockReturnValue(started.promise)
    renderHub()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for Grok subscription Team Grok' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Grok' }))
    // Opened synchronously inside the click (user activation), before the start resolves.
    expect(openMock).toHaveBeenCalledTimes(1)
    expect(openMock.mock.calls[0]?.[0]).not.toBe('https://auth.x.ai')
    expect(tab.opener).toBeNull()
    started.resolve({
      userCode: 'GROK-1234',
      verificationUri: 'https://auth.x.ai/device?user_code=GROK-1234',
      intervalSeconds: 60,
      state: 'grok-state',
      intent: 'reconnect',
    })
    await waitFor(() => {
      expect(tab.location.replace).toHaveBeenCalledWith(
        'https://auth.x.ai/device?user_code=GROK-1234'
      )
    })
    expect(await screen.findByTestId('codex-device-verification-link')).toHaveAttribute(
      'href',
      'https://auth.x.ai/device?user_code=GROK-1234'
    )
    expect(tab.close).not.toHaveBeenCalled()
  })

  it('closes the pre-opened Grok tab when the device start fails', async () => {
    const tab = { opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() }
    vi.stubGlobal(
      'open',
      vi.fn(() => tab)
    )
    vi.mocked(startGrokDeviceConnect).mockRejectedValue(new Error('start boom'))
    renderHub()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for Grok subscription Team Grok' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Grok' }))
    expect(await screen.findByText('start boom')).toBeInTheDocument()
    expect(tab.close).toHaveBeenCalled()
    expect(tab.location.replace).not.toHaveBeenCalled()
    expect(pollGrokDevice).not.toHaveBeenCalled()
  })

  it('shows the returned Grok verification link when the tab is blocked', async () => {
    vi.stubGlobal(
      'open',
      vi.fn(() => null)
    )
    vi.mocked(startGrokDeviceConnect).mockResolvedValue({
      userCode: 'GROK-1234',
      verificationUri: 'https://auth.x.ai/device?user_code=GROK-1234',
      intervalSeconds: 60,
      state: 'grok-state',
      intent: 'reconnect',
    })
    renderHub()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for Grok subscription Team Grok' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Grok' }))
    const card = await screen.findByTestId('codex-device-code')
    expect(card).toHaveTextContent('Open the Grok verification page')
    expect(screen.getByTestId('codex-device-verification-link')).toHaveAttribute(
      'href',
      'https://auth.x.ai/device?user_code=GROK-1234'
    )
  })

  it('falls back to the Grok verification origin, never the ChatGPT URI, when no URI is returned', async () => {
    const tab = { opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() }
    vi.stubGlobal(
      'open',
      vi.fn(() => tab)
    )
    vi.mocked(startGrokDeviceConnect).mockResolvedValue({
      userCode: 'GROK-1234',
      verificationUri: null as unknown as string,
      intervalSeconds: 60,
      state: 'grok-state',
      intent: 'reconnect',
    })
    renderHub()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for Grok subscription Team Grok' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Grok' }))
    const link = await screen.findByTestId('codex-device-verification-link')
    expect(link).toHaveAttribute('href', 'https://accounts.x.ai/oauth2/device')
    expect(link).not.toHaveAttribute('href', CODEX_DEVICE_VERIFICATION_URI)
    // An unusable URI is never navigated to; the pre-opened tab is closed.
    expect(tab.location.replace).not.toHaveBeenCalled()
    expect(tab.close).toHaveBeenCalled()
    expect(screen.getByTestId('codex-device-code')).toHaveTextContent(
      'Open the Grok verification page'
    )
  })

  it('follows the polled Grok interval and backs off on slow_down between device polls', async () => {
    const tab = { opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() }
    vi.stubGlobal(
      'open',
      vi.fn(() => tab)
    )
    vi.mocked(startGrokDeviceConnect).mockResolvedValue({
      userCode: 'GROK-1234',
      verificationUri: 'https://auth.x.ai/device?user_code=GROK-1234',
      intervalSeconds: 5,
      state: 'grok-state',
      intent: 'reconnect',
    })
    vi.mocked(pollGrokDevice)
      .mockResolvedValueOnce({ status: 'pending', intervalSeconds: 12, state: 'grok-state' })
      .mockResolvedValueOnce({ status: 'slow_down', intervalSeconds: 12, state: 'grok-state' })
      .mockResolvedValue({ status: 'pending', intervalSeconds: 12, state: 'grok-state' })
    renderHub()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for Grok subscription Team Grok' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update' }))
    const signIn = await screen.findByRole('button', { name: 'Sign in with Grok' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      fireEvent.click(signIn)
      // RTL findBy* drains via setTimeout(0), which is faked here — flush manually.
      await advanceDevicePoll(0)
      expect(screen.getByTestId('codex-device-code')).toHaveTextContent('GROK-1234')
      await advanceDevicePoll(5_000)
      expect(pollGrokDevice).toHaveBeenCalledTimes(1)
      // pending carried intervalSeconds 12: wait 12s, not the start 5s.
      await advanceDevicePoll(11_900)
      expect(pollGrokDevice).toHaveBeenCalledTimes(1)
      await advanceDevicePoll(100)
      expect(pollGrokDevice).toHaveBeenCalledTimes(2)
      // slow_down: 12s + 5s back-off.
      await advanceDevicePoll(16_900)
      expect(pollGrokDevice).toHaveBeenCalledTimes(2)
      await advanceDevicePoll(100)
      expect(pollGrokDevice).toHaveBeenCalledTimes(3)
      expect(pollGrokDevice).toHaveBeenLastCalledWith('grok-state', 'grok-aaa')
      expect(pollCodexDevice).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

// The catalog re-sync action drives the REAL sync clients (neither broker module
// overrides them) against a stubbed `fetch`, so these assertions cover the HTTP
// method, the broker-scoped URL and the endpoint's error taxonomy. Asserting a
// module spy instead would prove only that a button is wired to a stub.
describe('CodexSubscriptionHub catalog re-sync', () => {
  function renderHub() {
    return render(
      <ToastProvider>
        <CodexSubscriptionHub />
      </ToastProvider>
    )
  }

  function makeResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  }

  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    confirmMock.mockReset()
    capabilityProbes.codex.mockResolvedValue({ enabled: true })
    capabilityProbes.grok.mockResolvedValue({ enabled: true })
    vi.mocked(listCodexSubscriptionConnections).mockResolvedValue([
      connection({ connectionKey: 'codex-aaa', displayName: 'Team A' }),
    ])
    vi.mocked(listGrokSubscriptionConnections).mockResolvedValue([
      connection({ connectionKey: 'grok-aaa', displayName: 'Team Grok', defaultModel: 'grok-4.6' }),
    ])
    vi.mocked(listCodexConnectionModels).mockResolvedValue([
      { model: 'gpt-5.1', enabled: true, stale: false },
    ])
    vi.mocked(listGrokConnectionModels).mockResolvedValue([
      { model: 'grok-4.6', enabled: true, stale: false },
    ])
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  async function openGrokDialog(): Promise<HTMLElement> {
    renderHub()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for Grok subscription Team Grok' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update' }))
    return screen.findByRole('dialog', { name: 'Update Grok subscription Team Grok' })
  }

  it('syncs the Grok catalog through the Grok endpoint and re-reads the models', async () => {
    vi.mocked(listGrokConnectionModels)
      .mockResolvedValueOnce([{ model: 'grok-4.6', enabled: true, stale: false }])
      .mockResolvedValueOnce([
        { model: 'grok-4.6', enabled: true, stale: false },
        { model: 'grok-4.7', enabled: false, stale: false },
      ])
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        outcome: 'ready',
        added: 1,
        refreshed: 1,
        staled: 0,
        connection: connection({ connectionKey: 'grok-aaa', displayName: 'Team Grok' }),
      })
    )

    const dialog = await openGrokDialog()
    expect(await within(dialog).findByLabelText('grok-4.6')).toBeInTheDocument()
    // The model the upstream has just published is not there yet.
    expect(within(dialog).queryByLabelText('grok-4.7')).not.toBeInTheDocument()
    expect(listGrokConnectionModels).toHaveBeenCalledTimes(1)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Sync catalog' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      '/control-api/api/v1/admin/llm/providers/grok-subscription/connections/grok-aaa/catalog/sync'
    )
    expect(init.method).toBe('POST')
    // The models block re-reads from the server; the new model now renders.
    await waitFor(() => expect(listGrokConnectionModels).toHaveBeenCalledTimes(2))
    expect(await within(dialog).findByLabelText('grok-4.7')).toBeInTheDocument()
    expect(await screen.findByText('Catalog synced')).toBeInTheDocument()
  })

  it('reports a non-ready outcome the endpoint returns with 200 instead of claiming success', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        outcome: 'auth-rejected',
        added: 0,
        refreshed: 0,
        staled: 0,
        connection: connection({
          connectionKey: 'grok-aaa',
          displayName: 'Team Grok',
          status: 'reauth_required',
          catalogStatus: 'auth-rejected',
        }),
      })
    )

    const dialog = await openGrokDialog()
    await within(dialog).findByLabelText('grok-4.6')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sync catalog' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/Catalog sync failed \(auth-rejected\)/)).toBeInTheDocument()
    expect(screen.queryByText('Catalog synced')).not.toBeInTheDocument()
  })

  it('syncs the Codex catalog through the Codex endpoint, not the Grok one', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        outcome: 'ready',
        added: 0,
        refreshed: 1,
        staled: 0,
        connection: connection({ connectionKey: 'codex-aaa', displayName: 'Team A' }),
      })
    )

    renderHub()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for ChatGPT subscription Team A' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Update ChatGPT subscription Team A',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sync catalog' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/codex-subscription/connections/codex-aaa/catalog/sync')
    expect(url).not.toContain('/grok-subscription/')
  })

  it('reports a raced sync distinctly and leaves the rendered models untouched', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(409, { error: 'stale_revision' }))

    const dialog = await openGrokDialog()
    expect(await within(dialog).findByLabelText('grok-4.6')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sync catalog' }))

    expect(await within(dialog).findByText(/changed while this sync ran/i)).toBeInTheDocument()
    // Liveness witness for the negative assertion below: the request was issued
    // and the endpoint answered, so the untouched list is the failure's doing.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(listGrokConnectionModels).toHaveBeenCalledTimes(1)
    expect(within(dialog).getByLabelText('grok-4.6')).toBeInTheDocument()
  })

  it('names the upstream outcome when the catalog sync itself fails', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(503, { error: 'catalog_sync_failed', outcome: 'unavailable' })
    )

    const dialog = await openGrokDialog()
    await within(dialog).findByLabelText('grok-4.6')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sync catalog' }))

    const banner = await within(dialog).findByText(/could not be reached/i)
    expect(banner).toHaveTextContent('unavailable')
    expect(listGrokConnectionModels).toHaveBeenCalledTimes(1)
  })

  it('tells the operator to reconnect when the grant no longer authorizes', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(404, { error: 'no_grant' }))

    const dialog = await openGrokDialog()
    await within(dialog).findByLabelText('grok-4.6')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sync catalog' }))

    expect(
      await within(dialog).findByText(/no longer authorizes|sign in again/i)
    ).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // The setup form is the one state where the models block renders while the
  // grant is still disconnected, so it is the only place the sync action's own
  // status guard decides anything. Fixtures where the block is hidden anyway
  // cannot see that guard and would pass with it removed.
  it('does not offer the sync action while a new grant is still signing in', async () => {
    vi.stubGlobal(
      'open',
      vi.fn(() => ({}))
    )
    vi.mocked(createCodexSubscriptionConnection).mockResolvedValue(
      connection({
        connectionKey: 'codex-new',
        displayName: 'New team',
        status: 'disconnected',
        defaultModel: null,
      })
    )
    vi.mocked(startCodexDeviceConnect).mockResolvedValue({
      userCode: 'ABCD-1234',
      verificationUri: CODEX_DEVICE_VERIFICATION_URI,
      intervalSeconds: 600,
      state: 'state-1',
      intent: 'connect',
    })
    // The device flow never completes during this test, so the grant stays
    // disconnected while the setup form — models block included — is on screen.
    vi.mocked(pollCodexDevice).mockReturnValue(new Promise(() => {}))

    renderHub()
    await screen.findByText('Team A')
    fireEvent.click(screen.getByRole('button', { name: 'Add subscription' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'New team' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }))
    await waitFor(() =>
      expect(startCodexDeviceConnect).toHaveBeenCalledWith('connect', 'codex-new')
    )

    // Liveness witness: the models block the action lives in really rendered.
    expect(await screen.findByText('Enabled models')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sync catalog' })).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
