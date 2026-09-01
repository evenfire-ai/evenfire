import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import EditMcpServerPage from '../../app/mcp-servers/[name]/edit/page'
import * as api from '../../lib/api'
import { buildContextList, buildContextResource } from '../../test/fixtures/contextResource'

const replace = vi.fn()
const push = vi.fn()
let activeTab = 'access'

vi.mock('next/navigation', () => ({
  useParams: () => ({ name: 'search', tab: activeTab }),
  useRouter: () => ({ push, replace }),
}))

vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('@components/Toast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))

vi.mock('@components/UpdateConnectorCredentials', () => ({
  UpdateConnectorCredentials: () => <button type="button">Rotate credential</button>,
}))

vi.mock('@components/EgressEditor', () => ({
  EgressEditor: () => <input aria-label="Egress rules" />,
}))

vi.mock('../../lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    getContexts: vi.fn(),
    getContextTeams: vi.fn(),
    getContextUsers: vi.fn(),
    getHosts: vi.fn(),
    getAgentTeams: vi.fn(),
    getAgentUsers: vi.fn(),
    getMcpServer: vi.fn(),
    updateMcpServer: vi.fn(),
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  activeTab = 'access'
})

describe('connector edit agent access', () => {
  it('does not expose a stale legacy contextRef after allowlist membership is removed', async () => {
    vi.mocked(api.getMcpServer).mockResolvedValue({
      metadata: { name: 'search' },
      spec: { contextRef: 'removed-context', image: 'example/search:latest' },
    })
    vi.mocked(api.getContexts).mockResolvedValue(
      buildContextList([
        buildContextResource({
          metadata: { name: 'removed-context', resourceVersion: 'rv-2' },
          spec: { mcpServers: [] },
        }),
      ])
    )
    vi.mocked(api.getHosts).mockResolvedValue({ items: [] })

    render(<EditMcpServerPage />)

    expect(
      await screen.findByText('No agents have access to this connector yet.')
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Agent access' })).toBeInTheDocument()
    expect(screen.queryByText('removed-context')).not.toBeInTheDocument()
    await waitFor(() => expect(api.getMcpServer).toHaveBeenCalledWith('search'))
    expect(api.getContextUsers).not.toHaveBeenCalled()
    expect(api.getContextTeams).not.toHaveBeenCalled()
    expect(api.getHosts).toHaveBeenCalled()
  })

  it('hides private connector scopes that are not owned by an agent', async () => {
    vi.mocked(api.getMcpServer).mockResolvedValue({
      metadata: { name: 'search' },
      spec: { image: 'example/search:latest' },
    })
    vi.mocked(api.getContexts).mockResolvedValue(
      buildContextList([
        buildContextResource({
          metadata: { name: 'install-private', resourceVersion: 'rv-1' },
          spec: { mcpServers: ['search'] },
        }),
        buildContextResource({
          metadata: { name: 'recipe-private', resourceVersion: 'rv-2' },
          spec: { mcpServers: ['search'] },
        }),
      ])
    )
    vi.mocked(api.getHosts).mockResolvedValue({ items: [] })

    render(<EditMcpServerPage />)

    expect(
      await screen.findByText('No agents have access to this connector yet.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Teams' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Users' })).not.toBeInTheDocument()
    expect(api.getAgentUsers).not.toHaveBeenCalled()
    expect(api.getAgentTeams).not.toHaveBeenCalled()
  })

  it('shows access inherited through a host-owned connector scope', async () => {
    vi.mocked(api.getMcpServer).mockResolvedValue({
      metadata: { name: 'search' },
      spec: { image: 'example/search:latest' },
    })
    vi.mocked(api.getContexts).mockResolvedValue(
      buildContextList([
        buildContextResource({
          metadata: { name: 'agent-scope', resourceVersion: 'rv-1' },
          spec: { mcpServers: ['search'] },
        }),
      ])
    )
    vi.mocked(api.getHosts).mockResolvedValue({
      items: [
        {
          metadata: { name: 'agent-alpha' },
          spec: { host: 'Alpha', contextRef: 'agent-scope' },
        },
      ],
    })
    vi.mocked(api.getAgentUsers).mockResolvedValue({
      items: [
        {
          id: 'user-1',
          email: 'ada@example.com',
          name: 'Ada',
          displayName: 'Ada Lovelace',
        },
      ],
    })
    vi.mocked(api.getAgentTeams).mockResolvedValue({
      items: [{ id: 'team-1', name: 'Research' }],
    })

    render(<EditMcpServerPage />)

    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText('Research')).toBeInTheDocument()
    expect(api.getAgentUsers).toHaveBeenCalledWith('agent-alpha')
    expect(api.getAgentTeams).toHaveBeenCalledWith('agent-alpha')
  })

  it('keeps credentials and egress usable when the agent access list is unavailable', async () => {
    vi.mocked(api.getMcpServer).mockResolvedValue({
      metadata: { name: 'search' },
      spec: { image: 'example/search:latest' },
    })
    vi.mocked(api.getContexts).mockRejectedValue(new Error('Context service unavailable'))

    const { rerender } = render(<EditMcpServerPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Agent access data is unavailable. Try again later.'
    )

    activeTab = 'credentials'
    rerender(<EditMcpServerPage />)
    expect(screen.getByRole('button', { name: 'Rotate credential' })).toBeEnabled()

    activeTab = 'egress'
    rerender(<EditMcpServerPage />)
    expect(screen.getByRole('textbox', { name: 'Egress rules' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Save egress' })).toBeEnabled()
  })
})
