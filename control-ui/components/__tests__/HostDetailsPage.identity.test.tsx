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
  updateAdminTeamAgents: vi.fn(),
  updateAdminUserAgents: vi.fn(),
  // The model picker loads the operator allowlist via useLlmAllowedModels.
  getLlmModels: vi.fn().mockResolvedValue({ rows: [] }),
  isSilentApiError: vi.fn().mockReturnValue(false),
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
    const { container } = render(<HostDetailsPage />)
    expect(await screen.findByTestId('identity-tab')).toHaveTextContent('Identity editor for foo')
    expect(container.querySelector('.cu-agent-detail-card')).toBeNull()
  })

  it('renders the agent detail tabs in order', async () => {
    render(<HostDetailsPage />)

    const tabs = await screen.findAllByRole('tab')

    expect(tabs.map(tab => tab.textContent)).toEqual([
      'Overview',
      'Identity',
      'Models & creds',
      'Context',
      'Access',
      'Advanced',
    ])
  })

  it('puts Allowed models in place of Model name and spells out Secret reference', async () => {
    mockParams = { name: 'foo', tab: 'model' }
    const { container } = render(<HostDetailsPage />)

    expect(await screen.findByText('Allowed models')).toBeInTheDocument()
    expect(screen.queryByText('Model name')).not.toBeInTheDocument()
    expect(screen.getByText('Secret reference')).toBeInTheDocument()
    expect(container.querySelector('.cu-agent-detail-card')).toBeNull()
    expect(container.querySelector('.cu-agent-detail-heading')).not.toBeNull()
    expect(container.querySelector('.cu-agent-detail-toolbar')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    expect(
      screen.getByLabelText('Allowed models · OpenAI', { selector: '#llm-allowed-openai' })
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Model', { selector: '#llm-primary-model' })).toBeNull()
    expect(screen.getByLabelText('Secret reference')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Save' }).closest('.cu-agent-detail-toolbar')
    ).not.toBeNull()
    expect(container.querySelector('.cu-agent-detail-card .cu-agent-detail-scroll')).not.toBeNull()
  })

  it('keeps Per-tool approval actions in the top toolbar without a duplicate title', async () => {
    mockParams = { name: 'foo', tab: 'advanced' }
    const { container } = render(<HostDetailsPage />)

    expect(await screen.findByLabelText('http_request')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Save' }).closest('.cu-host-approval-section__actions')
    ).not.toBeNull()
    expect(container.querySelector('.cu-host-approval-section .cu-section-title')).toBeNull()
  })

  it('shows editable Type in Overview without Display ID and preserves personalization', async () => {
    const { container } = render(<HostDetailsPage />)
    expect(await screen.findByText('Name')).toBeInTheDocument()
    expect(await screen.findByText('Type')).toBeInTheDocument()
    expect(screen.queryByText('Display ID')).not.toBeInTheDocument()
    expect(container.querySelector('.cu-agent-detail-card')).toBeNull()
    expect(container.querySelector('.cu-agent-detail-heading')).not.toBeNull()
    expect(container.querySelector('.cu-agent-detail-toolbar')).toBeNull()

    const [overviewEditButton] = await screen.findAllByRole('button', { name: 'Edit' })
    await waitFor(() => expect(overviewEditButton).toBeEnabled())
    fireEvent.click(overviewEditButton)
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'stateless' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(api.apiSend).toHaveBeenCalledWith('PUT', '/api/v1/admin/hosts/foo', expect.any(Object))
    )
    const putCall = (api.apiSend as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      c => c[0] === 'PUT' && c[1] === '/api/v1/admin/hosts/foo'
    )
    const payload = putCall![2]
    expect(payload.spec.lifecycle).toEqual({ stateless: true })
    expect(payload.spec.personalization).toEqual(host.spec.personalization)
    expect(payload.spec.approval).toEqual(host.spec.approval)
  })

  // UT-3 — the identifier is readonly and only the display name (spec.host) is
  // editable. Saving is a SINGLE PUT that updates spec.host and leaves
  // metadata.name intact, with ZERO create (POST) / delete (DELETE) calls: the
  // behavioral proof that the create+migrate+delete rename dance is gone.
  it('makes the identifier readonly and saves the display name via one PUT (no rename dance)', async () => {
    render(<HostDetailsPage />)

    const [overviewEditButton] = await screen.findAllByRole('button', { name: 'Edit' })
    await waitFor(() => expect(overviewEditButton).toBeEnabled())
    fireEvent.click(overviewEditButton)

    // Identifier ("Name") is present but not editable.
    const nameField = screen.getByLabelText('Name')
    expect(nameField).toHaveAttribute('readonly')
    expect(nameField).toHaveValue('foo')

    // The display name (spec.host) is the editable field.
    const displayField = screen.getByLabelText('Display name')
    expect(displayField).toHaveValue('foo-display')
    fireEvent.change(displayField, { target: { value: 'Product Agents' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(api.apiSend).toHaveBeenCalledWith('PUT', '/api/v1/admin/hosts/foo', expect.any(Object))
    )

    const calls = (api.apiSend as unknown as ReturnType<typeof vi.fn>).mock.calls
    const puts = calls.filter(c => c[0] === 'PUT' && c[1] === '/api/v1/admin/hosts/foo')
    expect(puts).toHaveLength(1)
    const payload = puts[0][2]
    expect(payload.spec.host).toBe('Product Agents')
    // The identifier is untouched: the PUT targets the same slug and never sets
    // a different metadata.name.
    expect(payload.metadata?.name).toBeUndefined()

    // The dance is gone: no create of a new host and no delete of the old one.
    expect(calls.some(c => c[0] === 'POST')).toBe(false)
    expect(calls.some(c => c[0] === 'DELETE')).toBe(false)
    // And the route was never re-navigated to a renamed slug.
    expect(replaceMock).not.toHaveBeenCalledWith('/agents/Product Agents')
    expect(pushMock).not.toHaveBeenCalledWith('/agents/Product Agents')
  })
})
