import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import McpServerDetailPage from '../../app/mcp-servers/[name]/page'
import * as api from '../../lib/api'
import { ConnectorDetailProvider } from '../ConnectorDetailProvider'

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  params: { name: 'search' } as { name: string; tab?: string },
}))

function renderDetailPage() {
  return render(
    <ConnectorDetailProvider>
      <McpServerDetailPage />
    </ConnectorDetailProvider>
  )
}

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
  navigation.params = { name: 'search' }
})

describe('McpServerDetailPage', () => {
  it('keeps the route-derived connector name visible while its resource is loading', async () => {
    let resolveResource: ((resource: Awaited<ReturnType<typeof api.getMcpServer>>) => void) | null =
      null
    vi.mocked(api.getMcpServer).mockReturnValue(
      new Promise(resolve => {
        resolveResource = resolve
      })
    )
    renderDetailPage()

    expect(screen.getByRole('heading', { name: 'Connector: search' })).toBeVisible()

    resolveResource?.({ metadata: { name: 'search' }, spec: {} })
    expect(await screen.findByRole('heading', { name: 'Connector: search' })).toBeVisible()
  })

  it('renders non-secret configuration in route-backed, read-only fields and links to edit', async () => {
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
    renderDetailPage()

    expect(await screen.findByRole('heading', { name: 'Connector: search' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'Configuration' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(screen.getByRole('tab', { name: 'Runtime status' })).toHaveAttribute(
      'href',
      '/connectors/search/runtime'
    )
    expect(screen.getByText('Search the public web')).toBeVisible()
    expect(screen.getByText('https://search.example/mcp')).toBeVisible()
    expect(screen.queryByText('search-credentials')).not.toBeInTheDocument()
    expect(screen.queryByText('token')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit connector' }))
    expect(navigation.push).toHaveBeenCalledWith('/connectors/search/edit')
  })

  it('shows runtime status on the route-backed runtime tab without rendering editable controls', async () => {
    vi.mocked(api.getMcpServer).mockResolvedValue({
      metadata: { name: 'search' },
      spec: {},
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
    const { rerender } = renderDetailPage()
    expect(await screen.findByRole('heading', { name: 'Configuration' })).toBeVisible()
    navigation.params = { name: 'search', tab: 'runtime' }
    rerender(
      <ConnectorDetailProvider>
        <McpServerDetailPage />
      </ConnectorDetailProvider>
    )

    expect(await screen.findByRole('heading', { name: 'Runtime status' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'Runtime status' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(screen.getByText('Ready')).toBeVisible()
    expect(screen.getByText('True')).toBeVisible()
    expect(screen.getByText('Connector is ready.')).toBeVisible()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument()
  })

  it('switches to runtime status when its route-backed tab is activated', async () => {
    vi.mocked(api.getMcpServer).mockResolvedValue({
      metadata: { name: 'search' },
      spec: { description: 'Search the public web' },
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
    renderDetailPage()

    expect(await screen.findByText('Search the public web')).toBeVisible()
    fireEvent.click(screen.getByRole('tab', { name: 'Runtime status' }))

    expect(await screen.findByRole('heading', { name: 'Runtime status' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'Runtime status' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(screen.queryByText('Search the public web')).not.toBeInTheDocument()
    expect(screen.getByText('Connector is ready.')).toBeVisible()
  })

  it('refreshes in place and keeps failures on the detail page', async () => {
    vi.mocked(api.getMcpServer)
      .mockResolvedValueOnce({ metadata: { name: 'search' }, spec: {} })
      .mockRejectedValueOnce(new Error('Connector search was not found.'))
    renderDetailPage()
    await screen.findByRole('heading', { name: 'Connector: search' })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connector' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('was not found'))
    expect(navigation.push).not.toHaveBeenCalled()
  })
})
