import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import McpServerDetailPage from '../../app/mcp-servers/[name]/page'
import * as api from '../../lib/api'

const navigation = vi.hoisted(() => ({ push: vi.fn(), params: { name: 'search' } }))

vi.mock('next/navigation', () => ({
  useParams: () => navigation.params,
  useRouter: () => ({ push: navigation.push }),
}))
vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('../../lib/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  getMcpServer: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('McpServerDetailPage', () => {
  it('renders non-secret configuration and links to the existing edit route', async () => {
    vi.mocked(api.getMcpServer).mockResolvedValue({
      metadata: { name: 'search', namespace: 'mcp-server' },
      spec: {
        description: 'Search the public web',
        image: 'registry.example/search:1',
        managed: true,
        enabled: true,
        transport: { type: 'streamable-http', url: 'https://search.example/mcp' },
        envSecret: { name: 'search-credentials', keys: [{ secretKey: 'token' }] },
      },
      status: {
        conditions: [
          {
            type: 'Ready',
            status: 'True',
            reason: 'Available',
            message: 'Connector is ready.',
            lastTransitionTime: '2026-09-23T00:00:00Z',
          },
        ],
      },
    })
    render(<McpServerDetailPage />)

    expect(await screen.findByRole('heading', { name: 'search' })).toBeVisible()
    expect(screen.getByText('Search the public web')).toBeVisible()
    expect(screen.getByText('https://search.example/mcp')).toBeVisible()
    expect(screen.queryByText('search-credentials')).not.toBeInTheDocument()
    expect(screen.queryByText('token')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit connector' }))
    expect(navigation.push).toHaveBeenCalledWith('/connectors/search/edit')
  })

  it('refreshes in place and keeps failures on the detail page', async () => {
    vi.mocked(api.getMcpServer)
      .mockResolvedValueOnce({ metadata: { name: 'search' }, spec: {} })
      .mockRejectedValueOnce(new Error('Connector search was not found.'))
    render(<McpServerDetailPage />)
    await screen.findByRole('heading', { name: 'search' })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connector' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('was not found'))
    expect(navigation.push).not.toHaveBeenCalled()
  })
})
