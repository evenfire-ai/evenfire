import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import EditMcpServerPage from '../../app/mcp-servers/[name]/edit/page'
import * as api from '../../lib/api'
import { buildContextList, buildContextResource } from '../../test/fixtures/contextResource'

const replace = vi.fn()
const push = vi.fn()
let activeTab = 'context'

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
    getMcpServer: vi.fn(),
    updateMcpServer: vi.fn(),
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  activeTab = 'context'
})

describe('connector edit Context access', () => {
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

    render(<EditMcpServerPage />)

    expect(await screen.findByLabelText('Connector contexts')).toHaveTextContent('Contexts: None')
    expect(screen.queryByText('removed-context')).not.toBeInTheDocument()
    await waitFor(() => expect(api.getMcpServer).toHaveBeenCalledWith('search'))
    expect(api.getContextUsers).not.toHaveBeenCalled()
    expect(api.getContextTeams).not.toHaveBeenCalled()
    expect(api.getHosts).not.toHaveBeenCalled()
  })

  it('keeps credentials and egress usable when the Context list is unavailable', async () => {
    vi.mocked(api.getMcpServer).mockResolvedValue({
      metadata: { name: 'search' },
      spec: { image: 'example/search:latest' },
    })
    vi.mocked(api.getContexts).mockRejectedValue(new Error('Context service unavailable'))

    const { rerender } = render(<EditMcpServerPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Context access data is unavailable. Try again later.'
    )

    activeTab = 'credentials'
    rerender(<EditMcpServerPage />)
    expect(screen.getByRole('button', { name: 'Rotate credential' })).toBeEnabled()

    activeTab = 'egress'
    rerender(<EditMcpServerPage />)
    expect(screen.getByRole('textbox', { name: 'Egress rules' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Save egress' })).toBeEnabled()
    expect(screen.getByText('Unavailable')).toBeInTheDocument()
  })
})
