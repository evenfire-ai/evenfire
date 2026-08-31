import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import * as api from '@lib/api'
import { HostAccessTab } from '../HostAccessTab'
import { ToastProvider } from '../Toast'

const replaceMock = vi.fn()
const pushMock = vi.fn()
let mockParams: { name: string } = { name: 'foo' }

vi.mock('next/navigation', () => ({
  useParams: () => mockParams,
  usePathname: () => '/agents/foo/access',
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('../AuthContext', () => ({
  useAuth: () => ({ logout: vi.fn() }),
}))

vi.mock('../Sidebar', () => ({
  Sidebar: () => <aside data-testid="sidebar" />,
}))

vi.mock('@lib/api', () => ({
  apiGet: vi.fn(),
  apiSend: vi.fn(),
  getAdminTeamAgents: vi.fn(),
  getAdminTeams: vi.fn(),
  getAdminUserAgents: vi.fn(),
  getAdminUsers: vi.fn(),
  getAgentTeams: vi.fn(),
  getAgentUsers: vi.fn(),
  getHost: vi.fn(),
  getHostDetailBundle: vi.fn(),
  getLlmModels: vi.fn().mockResolvedValue({ rows: [] }),
  isSilentApiError: vi.fn().mockReturnValue(false),
  updateAdminTeamAgents: vi.fn(),
  updateAdminUserAgents: vi.fn(),
}))

function render(children: React.ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

afterEach(() => {
  cleanup()
})

describe('HostAccessTab — extracted access behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockParams = { name: 'foo' }
    ;(api.getAdminUsers as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        { id: 'u1', email: 'alice@example.com', name: null, displayName: 'Alice' },
        { id: 'u2', email: 'bob@example.com', name: null, displayName: 'Bob' },
      ],
    })
    ;(api.getAdminTeams as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [{ id: 't1', name: 'Platform', memberCount: 3 }],
    })
    ;(api.getAgentUsers as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [{ id: 'u1', email: 'alice@example.com', name: null, displayName: 'Alice' }],
    })
    ;(api.getAgentTeams as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [],
    })
  })

  it('renders Members by default and lists existing members', async () => {
    render(<HostAccessTab hostName="foo" />)

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument()
    })
    expect(
      screen.getByText('Grant or revoke which members can use this agent.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add member/i })).toBeEnabled()
  })

  it('switches to Teams sub-tab and shows the team description', async () => {
    render(<HostAccessTab hostName="foo" />)

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('tab', { name: 'Teams' }))

    await waitFor(() => {
      expect(
        screen.getByText('Grant or revoke team-level access to this agent.')
      ).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /Add team/i })).toBeEnabled()
    expect(screen.getByText('No teams have access yet.')).toBeInTheDocument()
  })

  it('grants member access end-to-end after Add member modal submission', async () => {
    ;(api.getAdminUserAgents as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      agentNames: [],
      deletedAgentNames: [],
    })
    ;(api.updateAdminUserAgents as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({})

    render(<HostAccessTab hostName="foo" />)

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /Add member/i }))

    // Pick Bob from the modal.
    const dialog = await waitFor(() => screen.getByRole('dialog', { name: /Add member/i }))
    fireEvent.click(screen.getByRole('option', { name: 'Bob' }))

    // The submit "Add member" lives inside the dialog; the section also has
    // a button of the same name, so scope the click to the dialog.
    fireEvent.click(dialog.querySelector('button.cu-btn--primary') as HTMLButtonElement)

    await waitFor(() => {
      expect(api.updateAdminUserAgents).toHaveBeenCalledWith('u2', ['foo'], expect.any(Array))
    })
  })

  it('revokes member access after confirm dialog approval', async () => {
    ;(api.getAdminUserAgents as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      agentNames: ['foo'],
      deletedAgentNames: [],
    })
    ;(api.updateAdminUserAgents as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({})

    render(<HostAccessTab hostName="foo" />)

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke access' }))

    // ConfirmDialog opens; click the danger "Revoke" button.
    const confirmDialog = await screen.findByRole('alertdialog')
    fireEvent.click(confirmDialog.querySelector('button.cu-btn--danger') as HTMLButtonElement)

    await waitFor(() => {
      expect(api.updateAdminUserAgents).toHaveBeenCalledWith('u1', [], expect.any(Array))
    })
  })
})
