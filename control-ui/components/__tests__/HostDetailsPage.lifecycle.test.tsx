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
  metadata: { name: string }
  spec: Record<string, unknown>
  status?: Record<string, unknown>
}

const statefulHost: TestHost = {
  metadata: { name: 'foo' },
  spec: { ...baseSpec },
}

const statelessHost: TestHost = {
  metadata: { name: 'foo' },
  spec: { ...baseSpec, lifecycle: { stateless: true } },
  status: {
    lifecycle: { state: 'active', reason: 'SuspendBlocked: pendingResults' },
  },
}

const rejectedHost: TestHost = {
  metadata: { name: 'foo' },
  spec: { ...baseSpec, lifecycle: { stateless: true } },
  status: {
    lifecycle: { state: 'active', reason: '' },
    conditions: [
      {
        type: 'StatelessEnableRejected',
        status: 'True',
        reason: 'ActiveCommunicationChannels',
        message: 'Host has active communication channels.',
      },
    ],
  },
}

// Addendum 6 (issue #791): a CONFIRMED CommunicationChannel association hard-rejects
// the requested stateless lifecycle. HCC selects the stateful template at replicas 1
// and writes a StatelessEnableRejected condition whose message names the channel
// count AND the disassociation recovery action. control-ui renders that condition
// message verbatim in the warning banner.
const channelHardRejectedHost: TestHost = {
  metadata: { name: 'foo' },
  spec: { ...baseSpec, lifecycle: { stateless: true } },
  status: {
    lifecycle: {
      state: 'active',
      reason:
        '2 CommunicationChannel(s) reference this Host; disassociate them to enable the requested stateless lifecycle',
    },
    conditions: [
      {
        type: 'StatelessEnableRejected',
        status: 'True',
        reason: 'ActiveCommunicationChannels',
        message:
          '2 CommunicationChannel(s) reference this Host; disassociate them to enable the requested stateless lifecycle',
      },
    ],
  },
}

// The same Host after the operator disassociates the channels: HCC clears the
// rejection and activates the requested stateless mode on the next reconcile.
const disassociatedStatelessHost: TestHost = {
  metadata: { name: 'foo' },
  spec: { ...baseSpec, lifecycle: { stateless: true } },
  status: {
    lifecycle: { state: 'active' },
  },
}

function setupApiMocks(host: TestHost) {
  ;(api.getHostDetailBundle as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    host,
    contexts: [{ metadata: { name: 'ctx' }, spec: { contextId: 'ctx' } }],
    secrets: [{ name: 'openai-secret' }],
    users: [],
    teams: [],
    agentUsers: [],
    agentTeams: [],
  })
  ;(api.getHost as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(host)
  ;(api.apiSend as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({})
}

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

async function openOverviewEdit() {
  const [overviewEditButton] = await screen.findAllByRole('button', { name: 'Edit' })
  await waitFor(() => expect(overviewEditButton).toBeEnabled())
  fireEvent.click(overviewEditButton)
}

async function saveOverviewAndGetPayload(): Promise<{ spec: Record<string, unknown> }> {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(api.apiSend).toHaveBeenCalledWith('PUT', '/api/v1/admin/hosts/foo', expect.any(Object))
  )
  const call = (api.apiSend as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
    args => args[0] === 'PUT' && args[1] === '/api/v1/admin/hosts/foo'
  )
  expect(call).toBeDefined()
  return call![2] as { spec: Record<string, unknown> }
}

afterEach(() => {
  cleanup()
})

describe('HostDetailsPage stateless lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockParams = { name: 'foo' }
  })

  it('shows Stateful (always on) for a host without spec.lifecycle', async () => {
    setupApiMocks(statefulHost)
    render(<HostDetailsPage />)

    expect(await screen.findByText('Stateful (always on)')).toBeInTheDocument()
    expect(screen.queryByText(/^Lifecycle:/)).not.toBeInTheDocument()
  })

  it('loads spec.lifecycle.stateless=true into the Agent type field', async () => {
    setupApiMocks(statelessHost)
    render(<HostDetailsPage />)

    expect(await screen.findByText('Stateless (suspends when idle)')).toBeInTheDocument()
  })

  it('renders the lifecycle state chip with state and reason for stateless hosts', async () => {
    setupApiMocks(statelessHost)
    render(<HostDetailsPage />)

    expect(
      await screen.findByText('Lifecycle: active — SuspendBlocked: pendingResults')
    ).toBeInTheDocument()
  })

  it('maps the activeCronSchedules reason to friendly text on the lifecycle chip (cron×stateless)', async () => {
    setupApiMocks({
      metadata: { name: 'foo' },
      spec: { ...baseSpec, lifecycle: { stateless: true } },
      status: {
        lifecycle: { state: 'active', reason: 'SuspendBlocked: activeCronSchedules' },
      },
    })
    render(<HostDetailsPage />)

    expect(
      await screen.findByText(
        'Lifecycle: active — Not suspending: active scheduled tasks keep this agent awake'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/SuspendBlocked: activeCronSchedules/)).not.toBeInTheDocument()
  })

  it('echoes spec.lifecycle when saving an unrelated field (full-replace safety)', async () => {
    setupApiMocks(statelessHost)
    render(<HostDetailsPage />)
    await openOverviewEdit()

    fireEvent.change(screen.getByLabelText('Display ID'), { target: { value: 'foo-updated' } })
    const payload = await saveOverviewAndGetPayload()

    expect(payload.spec.host).toBe('foo-updated')
    expect(payload.spec.lifecycle).toEqual({ stateless: true })
    expect(payload.spec.approval).toEqual(baseSpec.approval)
  })

  it('keeps spec.lifecycle absent when a stateful host is saved unchanged (absent = disabled)', async () => {
    setupApiMocks(statefulHost)
    render(<HostDetailsPage />)
    await openOverviewEdit()

    fireEvent.change(screen.getByLabelText('Display ID'), { target: { value: 'foo-updated' } })
    const payload = await saveOverviewAndGetPayload()

    expect('lifecycle' in payload.spec).toBe(false)
  })

  it('declares workflow-control scopes when saving a host that already has channel ingress', async () => {
    setupApiMocks({
      metadata: { name: 'foo' },
      spec: { ...baseSpec, channels: ['foo-channel'] },
    })
    render(<HostDetailsPage />)
    await openOverviewEdit()

    fireEvent.change(screen.getByLabelText('Display ID'), { target: { value: 'foo-updated' } })
    const payload = await saveOverviewAndGetPayload()

    expect(payload.spec.workflowControl).toEqual({
      scopes: [
        'workflow:list',
        'workflow:read',
        'workflow:trigger',
        'workflow:approval:resolve',
        'workflow:approval:decide',
      ],
    })
  })

  it('writes spec.lifecycle.stateless=true when the operator switches to Stateless', async () => {
    setupApiMocks(statefulHost)
    render(<HostDetailsPage />)
    await openOverviewEdit()

    fireEvent.change(screen.getByLabelText('Agent type'), { target: { value: 'stateless' } })
    const payload = await saveOverviewAndGetPayload()

    expect(payload.spec.lifecycle).toEqual({ stateless: true })
  })

  it('writes spec.lifecycle.stateless=false when a stateless host is switched back to Stateful', async () => {
    setupApiMocks(statelessHost)
    render(<HostDetailsPage />)
    await openOverviewEdit()

    fireEvent.change(screen.getByLabelText('Agent type'), { target: { value: 'stateful' } })
    const payload = await saveOverviewAndGetPayload()

    expect(payload.spec.lifecycle).toEqual({ stateless: false })
  })

  it('renders the StatelessEnableRejected condition prominently', async () => {
    setupApiMocks(rejectedHost)
    render(<HostDetailsPage />)

    expect(await screen.findByText('Stateless mode rejected:')).toBeInTheDocument()
    expect(screen.getByText(/Host has active communication channels\./)).toBeInTheDocument()
  })

  it('renders the CommunicationChannel hard-rejection banner with the disassociation recovery action verbatim (Addendum 6)', async () => {
    setupApiMocks(channelHardRejectedHost)
    render(<HostDetailsPage />)

    // Prominent warning banner on the (default) details view.
    const bannerLabel = await screen.findByText('Stateless mode rejected:')
    const banner = bannerLabel.closest('.cu-banner')
    expect(banner).not.toBeNull()
    // The banner surfaces the status condition message VERBATIM: the channel
    // count (the reason) AND the operator recovery action (disassociate).
    expect(banner).toHaveTextContent(
      '2 CommunicationChannel(s) reference this Host; disassociate them to enable the requested stateless lifecycle'
    )
  })

  it('clears the hard-rejection banner after the operator disassociates the channels and the view reloads', async () => {
    // First load: hard-rejected (channels still associated). After the operator
    // removes the channels, the overview save reloads the Host, which now reports
    // stateless-active with no StatelessEnableRejected condition.
    ;(api.getHostDetailBundle as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        host: channelHardRejectedHost,
        contexts: [{ metadata: { name: 'ctx' }, spec: { contextId: 'ctx' } }],
        secrets: [{ name: 'openai-secret' }],
        users: [],
        teams: [],
        agentUsers: [],
        agentTeams: [],
      })
      .mockResolvedValue({
        host: disassociatedStatelessHost,
        contexts: [{ metadata: { name: 'ctx' }, spec: { contextId: 'ctx' } }],
        secrets: [{ name: 'openai-secret' }],
        users: [],
        teams: [],
        agentUsers: [],
        agentTeams: [],
      })
    ;(api.getHost as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(channelHardRejectedHost)
    ;(api.apiSend as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({})

    render(<HostDetailsPage />)

    expect(await screen.findByText('Stateless mode rejected:')).toBeInTheDocument()

    await openOverviewEdit()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(screen.queryByText('Stateless mode rejected:')).not.toBeInTheDocument()
    )
    expect(screen.queryByText(/disassociate them to enable/)).not.toBeInTheDocument()
  })

  it('does not render the rejection banner when no condition is present', async () => {
    setupApiMocks(statelessHost)
    render(<HostDetailsPage />)

    await screen.findByText('Stateless (suspends when idle)')
    expect(screen.queryByText('Stateless mode rejected:')).not.toBeInTheDocument()
  })
})
