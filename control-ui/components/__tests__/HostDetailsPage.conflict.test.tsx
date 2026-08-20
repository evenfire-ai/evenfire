import React from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import HostDetailsPage from '../../app/hosts/[name]/page'
import * as api from '../../lib/api'
import { ToastProvider } from '../Toast'

const replaceMock = vi.fn()
const pushMock = vi.fn()
let mockParams: { name: string; tab?: string } = { name: 'foo' }

vi.mock('next/navigation', () => ({
  useParams: () => mockParams,
  usePathname: () => '/agents/foo',
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('../AuthContext', () => ({
  useAuth: () => ({ logout: vi.fn() }),
}))

vi.mock('../Sidebar', () => ({
  Sidebar: () => <aside data-testid="sidebar" />,
}))

vi.mock('../HostIdentityTab', () => ({
  HostIdentityTab: ({ hostName }: { hostName: string }) => (
    <div data-testid="identity-tab">Identity editor for {hostName}</div>
  ),
}))

vi.mock('../HostAccessTab', () => ({
  HostAccessTab: ({ hostName }: { hostName: string }) => (
    <div data-testid="access-tab">Access editor for {hostName}</div>
  ),
}))

vi.mock('../../lib/api', () => ({
  apiGet: vi.fn(),
  apiSend: vi.fn(),
  getAdminTeamAgents: vi.fn(),
  getAdminUserAgents: vi.fn(),
  getAgentTeams: vi.fn(),
  getAgentUsers: vi.fn(),
  getHost: vi.fn(),
  getHostDetailBundle: vi.fn(),
  getLlmModels: vi.fn().mockResolvedValue({ rows: [] }),
  isSilentApiError: vi.fn().mockReturnValue(false),
  updateAdminTeamAgents: vi.fn(),
  updateAdminUserAgents: vi.fn(),
}))

const baseSpec = {
  approval: { tools: { shell_exec: true } },
  channels: [],
  contextRef: 'ctx',
  host: 'foo-display',
  model: { name: 'gpt-5.4-mini', provider: 'openai' },
  secretRef: 'openai-secret',
}

type TestHost = {
  metadata: { name: string; resourceVersion?: string }
  spec: Record<string, unknown>
  status?: Record<string, unknown>
}

// The version the edit form is BUILT FROM (the loadData read).
const formLoadHost: TestHost = {
  metadata: { name: 'foo', resourceVersion: 'rv-form-load' },
  spec: { ...baseSpec },
}

// A NEWER version returned by saveHost's pre-save re-fetch — proves the PUT
// carries the form-load version, not the re-fetch one (AP-6: the guard must
// cover the whole human edit window).
const refetchedHost: TestHost = {
  metadata: { name: 'foo', resourceVersion: 'rv-refetch' },
  spec: { ...baseSpec },
}

function setupApiMocks(bundleHost: TestHost, refetchHost: TestHost = bundleHost) {
  ;(api.getHostDetailBundle as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    host: bundleHost,
    contexts: [{ metadata: { name: 'ctx' }, spec: { contextId: 'ctx' } }],
    secrets: [{ name: 'openai-secret' }],
    users: [],
    teams: [],
    agentUsers: [],
    agentTeams: [],
  })
  ;(api.getHost as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(refetchHost)
  ;(api.apiSend as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({})
}

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

function navigateToTab(view: ReturnType<typeof rtlRender>, tab: 'overview' | 'model'): void {
  mockParams = tab === 'overview' ? { name: 'foo' } : { name: 'foo', tab }
  view.rerender(
    <ToastProvider>
      <HostDetailsPage />
    </ToastProvider>
  )
}

async function openOverviewEdit() {
  const [overviewEditButton] = await screen.findAllByRole('button', { name: 'Edit' })
  await waitFor(() => expect(overviewEditButton).toBeEnabled())
  fireEvent.click(overviewEditButton)
}

function findHostPutPayload(): Record<string, unknown> {
  const call = (api.apiSend as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
    args => args[0] === 'PUT' && args[1] === '/api/v1/admin/hosts/foo'
  )
  expect(call).toBeDefined()
  return call![2] as Record<string, unknown>
}

// Shape produced by lib/api formatApiError for the facade's AP-6 response
// body {error:'conflict', reason:'resource_changed'}.
function makeConflictError(): Error {
  return Object.assign(new Error('409 Conflict - conflict'), {
    status: 409,
    code: 'conflict',
  })
}

afterEach(() => {
  cleanup()
})

describe('HostDetailsPage AP-6 save conflict handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockParams = { name: 'foo' }
  })

  it('sends the resourceVersion captured at form load, not the pre-save re-fetch version', async () => {
    setupApiMocks(formLoadHost, refetchedHost)
    render(<HostDetailsPage />)
    await openOverviewEdit()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.apiSend).toHaveBeenCalledWith('PUT', '/api/v1/admin/hosts/foo', expect.any(Object))
    )
    const payload = findHostPutPayload() as { metadata?: { resourceVersion?: string } }
    expect(payload.metadata?.resourceVersion).toBe('rv-form-load')
  })

  it('omits metadata when the form-load read carried no resourceVersion (legacy last-write-wins)', async () => {
    setupApiMocks({ metadata: { name: 'foo' }, spec: { ...baseSpec } })
    render(<HostDetailsPage />)
    await openOverviewEdit()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.apiSend).toHaveBeenCalledWith('PUT', '/api/v1/admin/hosts/foo', expect.any(Object))
    )
    expect('metadata' in findHostPutPayload()).toBe(false)
  })

  it('renders the both-causes conflict banner on 409, keeps the edit form open, and shows no success toast', async () => {
    setupApiMocks(formLoadHost, refetchedHost)
    ;(api.apiSend as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(makeConflictError())
    render(<HostDetailsPage />)
    await openOverviewEdit()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // The resourceVersion precondition is whole-object, so a 409 cannot tell a
    // human edit apart from the agent's own lifecycle tick. The banner must
    // cover BOTH causes truthfully rather than asserting "someone else edited".
    expect(
      await screen.findByText(
        "This agent changed since you opened the form (another edit, or the agent's own lifecycle state updated). Reload to see the latest, then re-apply your change."
      )
    ).toBeInTheDocument()
    // It must NOT overclaim the human-edit cause.
    expect(screen.queryByText(/modified by someone else/i)).not.toBeInTheDocument()
    // No silent success…
    expect(screen.queryByText('Agent configuration saved.')).not.toBeInTheDocument()
    // …and the edit form stays open so the operator's draft is preserved.
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('recovers after a 409: reloading then re-applying the same save succeeds and clears the banner', async () => {
    setupApiMocks(formLoadHost, refetchedHost)
    const apiSendMock = api.apiSend as unknown as ReturnType<typeof vi.fn>
    // First save conflicts (lifecycle tick or concurrent edit); the retry — the
    // operator's re-applied change after a reload — succeeds.
    apiSendMock.mockRejectedValueOnce(makeConflictError()).mockResolvedValue({})
    render(<HostDetailsPage />)
    await openOverviewEdit()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(
      await screen.findByText(
        "This agent changed since you opened the form (another edit, or the agent's own lifecycle state updated). Reload to see the latest, then re-apply your change."
      )
    ).toBeInTheDocument()
    // Draft survives: the form is still in edit mode after the conflict.
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()

    // Re-apply the change (the reload+re-apply recovery the banner instructs).
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // The retry succeeds: success toast shows and the conflict banner is gone.
    expect(await screen.findByText('Agent configuration saved.')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByText(/lifecycle state updated/i)).not.toBeInTheDocument()
    )
    expect(apiSendMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the non-conflict error path intact (generic message, form stays open)', async () => {
    setupApiMocks(formLoadHost, refetchedHost)
    ;(api.apiSend as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    render(<HostDetailsPage />)
    await openOverviewEdit()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('boom')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })
})

describe('HostDetailsPage cross-tab draft preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockParams = { name: 'foo' }
    setupApiMocks(formLoadHost, refetchedHost)
  })

  it('preserves an open Overview draft when Model & credentials is saved', async () => {
    const view = render(<HostDetailsPage />)
    await openOverviewEdit()
    fireEvent.change(screen.getByLabelText('Display name'), {
      target: { value: 'unsaved-overview-name' },
    })

    navigateToTab(view, 'model')
    expect(
      await screen.findByText(
        'Provider, allowed models, fallback policy, and credentials for this agent.'
      )
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    // Keep the existing static-credentials secret. Emptying it now fails
    // closed (Codex broker chains omit secretRef; OpenAI still requires one).
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Model & credentials saved.')).toBeInTheDocument()

    navigateToTab(view, 'overview')
    expect(await screen.findByDisplayValue('unsaved-overview-name')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('preserves an open Model & credentials draft when Overview is saved', async () => {
    const view = render(<HostDetailsPage />)
    navigateToTab(view, 'model')
    expect(
      await screen.findByText(
        'Provider, allowed models, fallback policy, and credentials for this agent.'
      )
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Secret reference'), { target: { value: '' } })

    navigateToTab(view, 'overview')
    await openOverviewEdit()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Agent configuration saved.')).toBeInTheDocument()

    navigateToTab(view, 'model')
    await waitFor(() =>
      expect((screen.getByLabelText('Secret reference') as HTMLSelectElement).value).toBe('')
    )
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })
})
