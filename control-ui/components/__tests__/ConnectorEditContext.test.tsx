import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import EditMcpServerPage from '../../app/mcp-servers/[name]/edit/page'
import * as api from '../../lib/api'

const replace = vi.fn()
const push = vi.fn()

vi.mock('next/navigation', () => ({
  useParams: () => ({ name: 'search', tab: 'context' }),
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
})

describe('connector edit Context access', () => {
  it('does not expose a stale legacy contextRef after allowlist membership is removed', async () => {
    vi.mocked(api.getMcpServer).mockResolvedValue({
      metadata: { name: 'search' },
      spec: { contextRef: 'removed-context', image: 'example/search:latest' },
    })
    vi.mocked(api.getContexts).mockResolvedValue({
      items: [
        {
          metadata: { name: 'removed-context', resourceVersion: 'rv-2' },
          spec: { contextId: 'removed-context', mcpServers: [] },
        },
      ],
    })

    render(<EditMcpServerPage />)

    expect(await screen.findByLabelText('Connector contexts')).toHaveTextContent('Contexts: None')
    expect(screen.queryByText('removed-context')).not.toBeInTheDocument()
    await waitFor(() => expect(api.getMcpServer).toHaveBeenCalledWith('search'))
    expect(api.getContextUsers).not.toHaveBeenCalled()
    expect(api.getContextTeams).not.toHaveBeenCalled()
    expect(api.getHosts).not.toHaveBeenCalled()
  })
})
