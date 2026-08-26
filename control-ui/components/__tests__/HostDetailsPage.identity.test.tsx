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
  getMcpServers: vi.fn(),
  updateAdminTeamAgents: vi.fn(),
  updateAdminUserAgents: vi.fn(),
  updateContext: vi.fn(),
  // The model picker loads the operator allowlist via useLlmAllowedModels.
  getLlmModels: vi.fn().mockResolvedValue({ rows: [] }),
  isSilentApiError: vi.fn().mockReturnValue(false),
}))

const host = {
  metadata: { name: 'foo', creationTimestamp: '2026-08-25T12:34:56Z' },
  spec: {
    approval: { tools: { shell_exec: true } },
    channels: ['telegram'],
    description:
      'This agent coordinates customer support requests, gathers the relevant context, and routes each case to the right workflow for follow-up.',
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
    secrets: [{ name: 'openai-secret', keys: ['openai-api-key'] }],
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
      'Connectors',
      'Access',
      'Advanced',
    ])
    expect(tabs.find(tab => tab.textContent === 'Connectors')).toHaveAttribute(
      'href',
      '/agents/foo/connectors'
    )
  })

  it('shows the provider model configuration and opens the linked LLM Secret modal inline', async () => {
    mockParams = { name: 'foo', tab: 'model' }
    const { container } = render(<HostDetailsPage />)

    const summary = await screen.findByRole('region', { name: 'LLM configuration summary' })
    expect(summary).toHaveTextContent('Primary provider')
    expect(summary).toHaveTextContent('OpenAI')
    expect(summary).toHaveTextContent('gpt-5.4')
    expect(summary).toHaveTextContent('Allowed models · OpenAI')
    expect(summary).toHaveTextContent('All enabled models')
    expect(screen.queryByText('Model name')).not.toBeInTheDocument()
    expect(screen.getByText('LLM Secret')).toBeInTheDocument()
    expect(container.querySelectorAll('.cu-llm-summary__value')).toHaveLength(2)
    expect(container.querySelector('.cu-agent-detail-card')).toBeNull()
    expect(container.querySelector('.cu-agent-detail-heading')).not.toBeNull()
    expect(container.querySelector('.cu-agent-detail-toolbar')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Edit LLM Secret credentials' }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Update LLM secret openai-secret')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Replace OpenAI API key' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update secret' })).toBeInTheDocument()
    expect(pushMock).not.toHaveBeenCalled()
    expect(container.querySelector('.cu-agent-detail-card')).toBeNull()
  })

  it('uses a custom LLM Secret picker with the enabled provider icons', async () => {
    mockParams = { name: 'foo', tab: 'model' }
    ;(api.getHostDetailBundle as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      host,
      contexts: [{ metadata: { name: 'ctx' }, spec: { contextId: 'ctx' } }],
      secrets: [
        { name: 'openai-secret', keys: ['openai-api-key', 'claude-api-key'] },
        { name: 'zai-secret', keys: ['zai-api-key'] },
      ],
      users: [],
      teams: [],
      agentUsers: [],
      agentTeams: [],
    })

    render(<HostDetailsPage />)

    const picker = await screen.findByRole('button', { name: 'LLM Secret' })
    expect(picker).toHaveTextContent('openai-secret')
    expect(picker.querySelectorAll('img')).toHaveLength(2)
    expect(picker.querySelector('img')).toHaveAttribute('src', '/provider-icons/openai.svg')
    expect(picker.querySelectorAll('img')[1]).toHaveAttribute('src', '/provider-icons/claude.svg')
    expect(screen.queryByRole('combobox')).toBeNull()

    fireEvent.click(picker)

    const zaiOption = screen.getByRole('option', { name: /zai-secret/ })
    expect(zaiOption).toHaveTextContent('Providers: Z.AI')
    expect(zaiOption.querySelector('img')).toHaveAttribute('src', '/provider-icons/zai.svg')
  })

  it('uses the shared LLM Secret editor for additional provider credentials', async () => {
    mockParams = { name: 'foo', tab: 'model' }
    render(<HostDetailsPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Edit LLM Secret credentials' }))

    expect(screen.getByText('Update LLM secret openai-secret')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Manage LLM Secrets' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Replace OpenAI API key' })).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Add provider'))
    fireEvent.click(screen.getByRole('option', { name: 'Anthropic' }))

    expect(
      screen.getByText('Anthropic', { selector: '.cu-llm-cred-group__title' })
    ).toBeInTheDocument()
    expect(screen.getByLabelText(/Claude API key/i)).toBeInTheDocument()
  })

  it('opens Advanced on the Hooks sub-tab', async () => {
    mockParams = { name: 'foo', tab: 'advanced' }
    render(<HostDetailsPage />)

    const hooksTab = await screen.findByRole('tab', { name: 'Hooks' })
    expect(hooksTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Per-tool approval' })).toHaveAttribute(
      'aria-selected',
      'false'
    )
    expect(await screen.findByText('No guardrail hooks on this agent yet.')).toBeInTheDocument()
    // The approval editor stays unmounted until its sub-tab is selected.
    expect(screen.queryByLabelText('http_request')).toBeNull()
  })

  it('keeps Per-tool approval actions in the top toolbar without a duplicate title', async () => {
    mockParams = { name: 'foo', tab: 'advanced' }
    const { container } = render(<HostDetailsPage />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Per-tool approval' }))

    expect(await screen.findByLabelText('http_request')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Save' }).closest('.cu-host-approval-section__actions')
    ).not.toBeNull()
    expect(container.querySelector('.cu-host-approval-section .cu-section-title')).toBeNull()
  })

  it('shows the agent description in place of the identifier and truncates long copy', async () => {
    const { container } = render(<HostDetailsPage />)
    const description = await screen.findByTitle(host.spec.description)

    expect(description).toHaveClass('cu-host-overview-identity__description')
    expect(description.textContent).toHaveLength(100)
    expect(description.textContent?.endsWith('…')).toBe(true)
    expect(screen.getByRole('button', { name: 'Edit agent name' })).toBeInTheDocument()
    expect(screen.getByText('Created').nextElementSibling).toHaveTextContent(/2026/)
    expect(screen.queryByText('Last updated')).not.toBeInTheDocument()
    expect(container.querySelector('.cu-host-overview-identity__slug')).toBeNull()
    expect(container.querySelector('.cu-agent-detail-card')).toBeNull()
  })

  it('edits the agent name inline via one PUT without changing the agent slug', async () => {
    render(<HostDetailsPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Edit agent name' }))
    const nameField = screen.getByLabelText('Agent name')
    expect(nameField).toHaveValue('foo-display')
    fireEvent.change(nameField, { target: { value: 'Product Agents' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save agent name' }))

    await waitFor(() =>
      expect(api.apiSend).toHaveBeenCalledWith('PUT', '/api/v1/admin/hosts/foo', expect.any(Object))
    )

    const calls = (api.apiSend as unknown as ReturnType<typeof vi.fn>).mock.calls
    const puts = calls.filter(c => c[0] === 'PUT' && c[1] === '/api/v1/admin/hosts/foo')
    expect(puts).toHaveLength(1)
    const payload = puts[0][2]
    expect(payload.spec.host).toBe('Product Agents')
    expect(payload.metadata?.name).toBeUndefined()
    expect(calls.some(c => c[0] === 'POST')).toBe(false)
    expect(calls.some(c => c[0] === 'DELETE')).toBe(false)
    expect(replaceMock).not.toHaveBeenCalledWith('/agents/Product Agents')
    expect(pushMock).not.toHaveBeenCalledWith('/agents/Product Agents')
  })

  it('cancels an inline agent name edit without persisting the draft', async () => {
    render(<HostDetailsPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Edit agent name' }))
    fireEvent.change(screen.getByLabelText('Agent name'), {
      target: { value: 'Discarded Draft' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing agent name' }))

    expect(screen.getByText('foo-display')).toBeInTheDocument()
    expect(screen.queryByText('Discarded Draft')).not.toBeInTheDocument()
    expect(api.apiSend).not.toHaveBeenCalled()
  })
})
