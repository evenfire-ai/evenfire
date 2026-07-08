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
  usePathname: () => '/hosts/foo',
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
  updateAdminTeamAgents: vi.fn(),
  updateAdminUserAgents: vi.fn(),
}))

const host = {
  metadata: { name: 'foo' },
  spec: {
    approval: { tools: { shell_exec: true } },
    channels: ['telegram'],
    contextRef: 'ctx',
    host: 'foo-display',
    memory: { enabled: true },
    model: { name: 'gpt-5.4', provider: 'openai' },
    personalization: {
      enabled: true,
      agents: 'Use tools.',
      identity: 'I am Clerum.',
      soul: 'Be helpful.',
      user: 'User context.',
    },
    secretRef: 'openai-secret',
  },
}

function setupApiMocks() {
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

afterEach(() => {
  cleanup()
})

describe('HostDetailsPage identity integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockParams = { name: 'foo' }
    setupApiMocks()
  })

  it('renders the Identity section tab with the current host name', async () => {
    mockParams = { name: 'foo', tab: 'identity' }
    render(<HostDetailsPage />)
    expect(await screen.findByTestId('identity-tab')).toHaveTextContent('Identity editor for foo')
  })

  it('places Identity as the second agent detail tab', async () => {
    render(<HostDetailsPage />)

    const tabs = await screen.findAllByRole('tab')

    expect(tabs.map(tab => tab.textContent)).toEqual([
      'Overview',
      'Identity',
      'Contexts',
      'Env vars',
      'Member access',
      'Team access',
    ])
  })

  it('preserves personalization when saving overview changes', async () => {
    render(<HostDetailsPage />)
    const [overviewEditButton] = await screen.findAllByRole('button', { name: 'Edit' })
    fireEvent.click(overviewEditButton)
    fireEvent.change(screen.getByLabelText('Display ID'), { target: { value: 'foo-updated' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(api.apiSend).toHaveBeenCalledWith('PUT', '/api/v1/admin/hosts/foo', expect.any(Object))
    )
    const payload = (api.apiSend as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(payload.spec.host).toBe('foo-updated')
    expect(payload.spec.personalization).toEqual(host.spec.personalization)
    expect(payload.spec.approval).toEqual(host.spec.approval)
  })
})
