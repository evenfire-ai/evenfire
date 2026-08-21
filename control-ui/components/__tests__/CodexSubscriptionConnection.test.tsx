import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  isCodexBrowserOAuthUnavailableError,
  readCodexOAuthQueryParam,
  sanitizeCodexConnection,
} from '@lib/codexSubscription'
import type { CodexSubscriptionConnectionView } from '@lib/codexSubscription'
import {
  getCodexSubscriptionConnection,
  refreshCodexSubscriptionConnection,
  revokeCodexSubscription,
  startCodexBrowserConnect,
  startCodexDeviceConnect,
  syncCodexSubscriptionCatalog,
} from '@lib/codexSubscription'
import { loadCodexSubscriptionCapability } from '@lib/codexSubscriptionFeature'
import { CodexSubscriptionConnection } from '../CodexSubscriptionConnection'
import { ToastProvider } from '../Toast'

const confirmMock = vi.fn()
const replaceMock = vi.fn()
let searchParams = new URLSearchParams()
const assignMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: replaceMock }),
  useSearchParams: () => searchParams,
}))

vi.mock('@components/ConfirmDialog', () => ({
  useConfirmDialog: () => ({
    confirm: confirmMock,
    confirmDialog: null,
  }),
}))

vi.mock('@lib/codexSubscriptionFeature', () => ({
  loadCodexSubscriptionCapability: vi.fn(),
  isCodexSubscriptionUiEnabled: (capability: { enabled?: boolean } | null) =>
    capability?.enabled === true,
}))

vi.mock('@lib/codexSubscription', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/codexSubscription')>()
  return {
    ...actual,
    getCodexSubscriptionConnection: vi.fn(),
    startCodexBrowserConnect: vi.fn(),
    startCodexDeviceConnect: vi.fn(),
    pollCodexDevice: vi.fn(),
    refreshCodexSubscriptionConnection: vi.fn(),
    syncCodexSubscriptionCatalog: vi.fn(),
    revokeCodexSubscription: vi.fn(),
  }
})

const connected: CodexSubscriptionConnectionView = {
  connectionKey: 'deployment-default',
  status: 'connected',
  credentialRevision: 2,
  catalogRevision: 4,
  accountFingerprint: 'fp-safe',
  catalogStatus: 'ready',
  catalogSyncedAt: '2026-08-20T00:00:00.000Z',
  lastRefreshAt: '2026-08-20T00:00:00.000Z',
  lastAuthAt: '2026-08-20T00:00:00.000Z',
  refreshLockHeld: false,
}

function renderSurface() {
  return render(
    <ToastProvider>
      <CodexSubscriptionConnection />
    </ToastProvider>
  )
}

function browserOAuthUnavailableError() {
  const error = new Error('400 Bad Request - browser_oauth_unregistered') as Error & {
    code?: string
    status?: number
  }
  error.code = 'browser_oauth_unregistered'
  error.status = 400
  return error
}

describe('CodexSubscriptionConnection', () => {
  beforeEach(() => {
    confirmMock.mockReset()
    replaceMock.mockReset()
    assignMock.mockReset()
    searchParams = new URLSearchParams()
    confirmMock.mockResolvedValue(true)
    vi.mocked(loadCodexSubscriptionCapability).mockResolvedValue({ enabled: true })
    vi.mocked(getCodexSubscriptionConnection).mockResolvedValue(connected)
    vi.stubGlobal('location', { assign: assignMock })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('strips tokens from a leaked connection fixture', () => {
    expect(() =>
      sanitizeCodexConnection({
        ...connected,
        accessToken: 'sk-leaked',
      })
    ).toThrow(/accessToken/)
  })

  it('hides the surface when Control API capability is disabled', async () => {
    vi.mocked(loadCodexSubscriptionCapability).mockResolvedValue({ enabled: false })
    renderSurface()
    expect(await screen.findByText('Codex subscription is unavailable.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in with ChatGPT' })).not.toBeInTheDocument()
  })

  it('renders connected status without tokens or account ids', async () => {
    renderSurface()
    expect(await screen.findByTestId('codex-connection-status')).toHaveTextContent('Connected')
    expect(screen.getByTestId('codex-fingerprint')).toHaveTextContent('fp-safe')
    expect(document.body.textContent).not.toMatch(/sk-|accessToken|acct_raw|Authorization/i)
  })

  it.each([
    ['disconnected', 'Disconnected'],
    ['connecting', 'Connecting'],
    ['reauth_required', 'Reauthorization required'],
  ] as const)('maps backend status %s to %s', async (status, label) => {
    vi.mocked(getCodexSubscriptionConnection).mockResolvedValue({ ...connected, status })
    renderSurface()
    expect(await screen.findByTestId('codex-connection-status')).toHaveTextContent(label)
  })

  it('starts Sign in with ChatGPT through the device flow without rendering secrets', async () => {
    const openMock = vi.fn()
    vi.stubGlobal('open', openMock)
    vi.mocked(startCodexDeviceConnect).mockResolvedValue({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.openai.com/codex/device',
      intervalSeconds: 5,
      state: 'dev',
      intent: 'connect',
    })
    renderSurface()
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with ChatGPT' }))
    await waitFor(() => {
      expect(startCodexDeviceConnect).toHaveBeenCalledWith('connect')
    })
    expect(openMock).toHaveBeenCalledWith(
      'https://auth.openai.com/codex/device',
      '_blank',
      'noopener,noreferrer'
    )
    expect(assignMock).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toMatch(/sk-|deviceCode|accessToken/i)
  })

  it('shows the ChatGPT sign-in banner when a leftover browser callback is unregistered', async () => {
    searchParams = new URLSearchParams('codex_oauth=browser_oauth_unregistered')
    renderSurface()
    expect(await screen.findByTestId('codex-browser-oauth-blocked')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeVisible()
    expect(assignMock).not.toHaveBeenCalled()
  })

  it('reloads connection after a successful browser callback query param', async () => {
    searchParams = new URLSearchParams('codex_oauth=connected')
    renderSurface()
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/llm-models/providers/codex-subscription')
    })
    expect(await screen.findByTestId('codex-connection-status')).toHaveTextContent('Connected')
  })

  it('shows device-code progress without the secret device code', async () => {
    vi.mocked(startCodexDeviceConnect).mockResolvedValue({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.openai.com/codex/device',
      intervalSeconds: 5,
      state: 'dev',
      intent: 'connect',
    })
    renderSurface()
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with ChatGPT' }))
    expect(await screen.findByTestId('codex-connection-status')).toHaveTextContent(
      'Device code pending'
    )
    expect(screen.getByTestId('codex-device-code')).toHaveTextContent('ABCD-EFGH')
    expect(document.body.textContent).not.toContain('device_secret')
  })

  it('confirms replacement impact before starting a replace flow', async () => {
    vi.mocked(startCodexDeviceConnect).mockResolvedValue({
      userCode: 'REPL-CODE',
      verificationUri: 'https://auth.openai.com/codex/device',
      intervalSeconds: 5,
      state: 'rep',
      intent: 'replace',
    })
    renderSurface()
    fireEvent.click(await screen.findByRole('button', { name: 'Replace account' }))
    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalled()
    })
    expect(String(confirmMock.mock.calls[0]?.[0]?.message)).toMatch(/lose the current grant/i)
    await waitFor(() => {
      expect(startCodexDeviceConnect).toHaveBeenCalledWith('replace')
    })
  })

  it('syncs catalog and keeps newly discovered models disabled in the summary', async () => {
    vi.mocked(syncCodexSubscriptionCatalog).mockResolvedValue({
      outcome: 'ready',
      added: 2,
      refreshed: 1,
      staled: 1,
      connection: connected,
    })
    renderSurface()
    fireEvent.click(await screen.findByRole('button', { name: 'Sync catalog' }))
    expect(await screen.findByTestId('codex-sync-summary')).toHaveTextContent(
      'New models stay disabled until enabled'
    )
    expect(syncCodexSubscriptionCatalog).toHaveBeenCalled()
  })

  it('tests and revokes the connection', async () => {
    vi.mocked(refreshCodexSubscriptionConnection).mockResolvedValue(connected)
    vi.mocked(revokeCodexSubscription).mockResolvedValue({
      ...connected,
      status: 'revoked',
    })
    renderSurface()
    fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }))
    await waitFor(() => {
      expect(refreshCodexSubscriptionConnection).toHaveBeenCalled()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await waitFor(() => {
      expect(revokeCodexSubscription).toHaveBeenCalled()
    })
    expect(await screen.findByTestId('codex-connection-status')).toHaveTextContent('Disconnected')
  })

  it('anti-false-positive: a leaked accessToken never reaches the DOM', async () => {
    vi.mocked(getCodexSubscriptionConnection).mockImplementation(async () =>
      sanitizeCodexConnection({
        ...connected,
        accessToken: 'sk-should-not-render',
      })
    )
    renderSurface()
    expect(await screen.findByTestId('codex-connection-status')).toHaveTextContent('Unavailable')
    expect(document.body.textContent).not.toContain('sk-should-not-render')
    expect(document.body.textContent).not.toContain('accessToken')
  })
})

describe('codex subscription query helpers', () => {
  it('reads the oauth callback query param', () => {
    expect(readCodexOAuthQueryParam(new URLSearchParams('codex_oauth=connected'))).toBe('connected')
  })

  it('detects browser oauth unregistered API errors', () => {
    expect(isCodexBrowserOAuthUnavailableError(browserOAuthUnavailableError())).toBe(true)
  })
})
