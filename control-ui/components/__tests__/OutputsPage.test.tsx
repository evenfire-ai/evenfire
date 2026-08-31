import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import OutputsPage from '../../app/outputs/page'
import {
  getAdminOutputsOverview,
  getHostArtifactDownloadUrl,
  getWorkflowRunArtifactDownloadUrl,
} from '../../lib/api'

const navigationState = vi.hoisted(() => ({
  params: {} as { tab?: string },
  replace: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: navigationState.replace }),
  useParams: () => navigationState.params,
}))

vi.mock('../../components/AuthContext', () => ({
  useAuth: () => ({
    authState: { isLoggedIn: true, isLoading: false },
    checkAuth: vi.fn(),
  }),
}))

vi.mock('../../components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('../../components/SectionSearchInput', () => ({
  SectionSearchInput: () => <input aria-label="Search agent outputs" />,
}))

vi.mock('../../components/Sidebar/icons', () => ({
  IconOutputs: () => <span data-testid="outputs-icon" />,
}))

vi.mock('../../components/TablePanelHeader', () => ({
  TablePanelHeader: ({
    title,
    subtitle,
    actions,
  }: {
    title: React.ReactNode
    subtitle: string
    actions: React.ReactNode
  }) => (
    <header>
      <div>{title}</div>
      <p>{subtitle}</p>
      <div>{actions}</div>
    </header>
  ),
}))

vi.mock('../../components/icons', () => ({
  IconRefresh: () => <span data-testid="refresh-icon" />,
}))

vi.mock('../../lib/api', () => ({
  getAdminOutputsOverview: vi.fn(),
  getHostArtifactDownloadUrl: vi.fn(),
  getWorkflowRunArtifactDownloadUrl: vi.fn(),
  isSilentApiError: vi.fn(() => false),
}))

const mockGetAdminOutputsOverview = vi.mocked(getAdminOutputsOverview)
const mockGetHostArtifactDownloadUrl = vi.mocked(getHostArtifactDownloadUrl)
const mockGetWorkflowRunArtifactDownloadUrl = vi.mocked(getWorkflowRunArtifactDownloadUrl)

afterEach(() => {
  cleanup()
  localStorage.clear()
  navigationState.params = {}
  navigationState.replace.mockClear()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('OutputsPage', () => {
  it('shows workflow artifact skeleton rows while the workflow tab is loading', () => {
    mockGetAdminOutputsOverview.mockReturnValue(new Promise<never>(() => {}))

    const { container } = render(<OutputsPage />)

    expect(screen.getByText('Agent Outputs')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'File' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Recipe' })).toBeInTheDocument()
    expect(screen.queryByText(/No workflow artifacts found/)).not.toBeInTheDocument()
    expect(container.querySelectorAll('.cu-skeleton')).toHaveLength(24)
  })

  it('shows desktop artifact skeleton rows while the desktop tab is loading', () => {
    navigationState.params = { tab: 'desktop-app-artifacts' }
    mockGetAdminOutputsOverview.mockReturnValue(new Promise<never>(() => {}))

    const { container } = render(<OutputsPage />)

    expect(screen.getByRole('columnheader', { name: 'File' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Host' })).toBeInTheDocument()
    expect(screen.queryByText(/No desktop app artifacts found/)).not.toBeInTheDocument()
    expect(container.querySelectorAll('.cu-skeleton')).toHaveLength(24)
  })

  it('loads workflow artifacts from exact runs and downloads through the run-scoped URL', async () => {
    mockGetAdminOutputsOverview.mockResolvedValue({
      chatArtifacts: [],
      workflowOutputs: [
        {
          recipeName: 'manual-report',
          namespace: 'sandbox-recipes',
          runId: 'run-12345678',
          fileName: 'report.md',
          format: 'md',
          sizeBytes: 12,
          completedAt: '2026-05-12T00:00:02.000Z',
        },
      ],
    })
    mockGetWorkflowRunArtifactDownloadUrl.mockReturnValue('http://localhost/run-artifact')
    const fetchMock = vi.fn().mockResolvedValue(new Response('artifact', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:artifact'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    render(<OutputsPage />)

    expect(await screen.findByText('report.md')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for workflow artifact report.md' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download' }))

    await waitFor(() =>
      expect(mockGetWorkflowRunArtifactDownloadUrl).toHaveBeenCalledWith(
        'sandbox-recipes',
        'manual-report',
        'run-12345678',
        'report.md'
      )
    )
    expect(fetchMock).toHaveBeenCalledWith('http://localhost/run-artifact', {
      credentials: 'include',
    })
    expect(click).toHaveBeenCalled()
  })

  it('downloads desktop artifacts through the far-right action menu', async () => {
    navigationState.params = { tab: 'desktop-app-artifacts' }
    mockGetAdminOutputsOverview.mockResolvedValue({
      chatArtifacts: [
        {
          hostRef: 'host-1',
          fileName: 'transcript.txt',
          format: 'txt',
          sizeBytes: 18,
          createdAt: '2026-05-12T00:00:02.000Z',
        },
      ],
      workflowOutputs: [],
    })
    mockGetHostArtifactDownloadUrl.mockReturnValue('http://localhost/host-artifact')
    const fetchMock = vi.fn().mockResolvedValue(new Response('artifact', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:artifact'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    render(<OutputsPage />)

    expect(await screen.findByText('transcript.txt')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Actions for desktop artifact transcript.txt' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download' }))

    await waitFor(() =>
      expect(mockGetHostArtifactDownloadUrl).toHaveBeenCalledWith('host-1', 'transcript.txt')
    )
    expect(fetchMock).toHaveBeenCalledWith('http://localhost/host-artifact', {
      credentials: 'include',
    })
    expect(click).toHaveBeenCalled()
  })
})
