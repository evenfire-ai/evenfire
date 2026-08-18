import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  deleteAdminTeam,
  deleteAdminUser,
  getAdminTeams,
  getAdminUserTeams,
  getProfileAdminOverview,
  revokeAdminTeamInvitation,
} from '../../lib/api'
import { ProfileAdminHome } from '../ProfileAdminHome'
import { ToastProvider } from '../Toast'

const mockPush = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}))

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    getProfileAdminOverview: vi.fn(),
    getAdminTeams: vi.fn(),
    getAdminUserTeams: vi.fn(),
    deleteAdminTeam: vi.fn(),
    deleteAdminUser: vi.fn(),
    resendAdminTeamInvitation: vi.fn(),
    resendAdminUserPasswordSetupInvitation: vi.fn(),
    revokeAdminTeamInvitation: vi.fn(),
  }
})

vi.mock('../ControlAdminsPanel', () => ({
  ControlAdminsPanel: ({ searchInput }: { searchInput?: string }) => (
    <div>Control admins panel {searchInput}</div>
  ),
}))

function renderProfileAdminHome(activeTab: 'users' | 'teams' | 'admins' = 'users') {
  return render(
    <ToastProvider>
      <ProfileAdminHome activeTab={activeTab} />
    </ToastProvider>
  )
}

describe('ProfileAdminHome — members invitations', () => {
  beforeEach(() => {
    mockPush.mockClear()
    vi.mocked(getProfileAdminOverview).mockResolvedValue({
      teams: [{ id: 'team-1', name: 'Marketing', memberCount: 1 }],
      users: [
        {
          id: 'pending-user',
          email: 'pending@example.com',
          name: 'Pending Invitee',
          picture: null,
          displayName: 'Pending Invitee',
          activeTeamCount: 0,
        },
        {
          id: 'accepted-password-pending-user',
          email: 'accepted@example.com',
          name: 'Accepted Invitee',
          picture: null,
          displayName: 'Accepted Invitee',
          activeTeamCount: 1,
          passwordPendingFromAcceptedInvitation: true,
        },
      ],
      pendingInvitations: [
        {
          id: 'invitation-1',
          team_id: 'team-1',
          team_name: 'Marketing',
          email: 'pending@example.com',
          role: 'member',
          status: 'pending',
          created_at: '2026-04-30T12:00:00.000Z',
          expires_at: '2026-05-02T12:00:00.000Z',
        },
      ],
      teamAgentCounts: { 'team-1': 0 },
      teamContextCounts: { 'team-1': 0 },
    })
    vi.mocked(revokeAdminTeamInvitation).mockResolvedValue({
      revoked: true,
      id: 'invitation-1',
      email: 'pending@example.com',
    })
    vi.mocked(getAdminTeams).mockResolvedValue({
      items: [{ id: 'team-1', name: 'Marketing', memberCount: 1 }],
    })
    vi.mocked(getAdminUserTeams).mockResolvedValue({
      items: [{ id: 'team-1', name: 'Marketing', role: 'admin' }],
    })
    vi.mocked(deleteAdminUser).mockResolvedValue({
      deleted: true,
      id: 'accepted-password-pending-user',
    })
    vi.mocked(deleteAdminTeam).mockResolvedValue({ deleted: true, id: 'team-1' })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows pending invitations separately and keeps pending-only users out of members', async () => {
    renderProfileAdminHome()

    await waitFor(() => expect(screen.getByText('Pending invitations')).toBeInTheDocument())

    expect(screen.getByText('pending@example.com')).toBeInTheDocument()
    expect(screen.queryByText('Pending Invitee')).not.toBeInTheDocument()
    expect(screen.getByText('Accepted Invitee')).toBeInTheDocument()
    expect(screen.getByLabelText('Invitation accepted, password setup pending')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resend invite' })).toBeInTheDocument()
  })

  it('keeps the new create member route as the add-member flow', async () => {
    renderProfileAdminHome()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Create member' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: 'Create member' }))

    expect(mockPush).toHaveBeenCalledWith('/users-and-teams/users/new')
  })

  it('opens a member detail page from the whole member row', async () => {
    renderProfileAdminHome()

    const memberRow = await screen.findByLabelText('Open member Accepted Invitee')

    fireEvent.click(memberRow)
    expect(mockPush).toHaveBeenCalledWith(
      '/users-and-teams/users/accepted-password-pending-user/contact'
    )

    mockPush.mockClear()
    fireEvent.keyDown(memberRow, { key: 'Enter' })
    expect(mockPush).toHaveBeenCalledWith(
      '/users-and-teams/users/accepted-password-pending-user/contact'
    )
  })

  it('does not open a member detail page from row action buttons', async () => {
    renderProfileAdminHome()

    await screen.findByLabelText('Open member Accepted Invitee')

    fireEvent.click(screen.getByRole('button', { name: 'Delete member Accepted Invitee' }))

    expect(mockPush).not.toHaveBeenCalled()
  })

  it('opens admin creation from a member without offering desktop access again', async () => {
    renderProfileAdminHome()

    await screen.findByLabelText('Open member Accepted Invitee')

    const createAdminButton = screen.getByRole('button', { name: 'Create admin' })
    expect(createAdminButton).toHaveAttribute('title', 'Create admin')
    expect(createAdminButton.querySelector('svg')).toHaveAttribute(
      'data-relationship-role',
      'admin'
    )
    expect(createAdminButton.querySelector('svg')).toHaveAttribute('data-icon', 'shield')
    expect(createAdminButton.querySelector('svg')).toHaveAttribute('data-create-badge', 'true')

    fireEvent.click(createAdminButton)

    expect(mockPush).toHaveBeenCalledWith(
      '/users-and-teams/admins/new?email=accepted%40example.com&name=Accepted+Invitee&step=review&source=member'
    )
  })

  it('views the matching admin from a member with the destination-role SVG', async () => {
    vi.mocked(getProfileAdminOverview).mockResolvedValueOnce({
      teams: [],
      users: [
        {
          id: 'member-1',
          email: 'member@example.com',
          name: 'Member',
          picture: null,
          displayName: 'Member',
          controlAdminId: 'admin-1',
          activeTeamCount: 0,
        },
      ],
      pendingInvitations: [],
      teamAgentCounts: {},
      teamContextCounts: {},
    })
    renderProfileAdminHome()

    const viewAdminButton = await screen.findByRole('button', { name: 'View admin' })
    expect(viewAdminButton).toHaveAttribute('title', 'View admin')
    expect(viewAdminButton.querySelector('svg')).toHaveAttribute('data-relationship-role', 'admin')
    expect(viewAdminButton.querySelector('svg')).toHaveAttribute('data-icon', 'shield')
    expect(viewAdminButton.querySelector('svg')).not.toHaveAttribute('data-create-badge')

    fireEvent.click(viewAdminButton)

    expect(mockPush).toHaveBeenCalledWith('/users-and-teams/admins?highlightAdminId=admin-1')
  })

  it('opens a team detail page from the whole team row', async () => {
    renderProfileAdminHome('teams')

    const teamRow = await screen.findByLabelText('Open team Marketing')

    fireEvent.click(teamRow)
    expect(mockPush).toHaveBeenCalledWith('/users-and-teams/teams/team-1/members')

    mockPush.mockClear()
    fireEvent.keyDown(teamRow, { key: ' ' })
    expect(mockPush).toHaveBeenCalledWith('/users-and-teams/teams/team-1/members')
  })

  it('does not open a team detail page from row action buttons', async () => {
    renderProfileAdminHome('teams')

    await screen.findByLabelText('Open team Marketing')

    fireEvent.click(screen.getByRole('button', { name: 'Delete team Marketing' }))

    expect(mockPush).not.toHaveBeenCalled()
  })

  it('renders members first for the users route', async () => {
    renderProfileAdminHome()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Create member' })).toBeEnabled())

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    expect(tabs[0]).toHaveTextContent('Members (1, 1 pending)')
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[1]).toHaveTextContent(/^Teams$/)
    expect(tabs[2]).toHaveTextContent(/^Admins$/)
  })

  it('shows counts only on the selected tab', async () => {
    renderProfileAdminHome('teams')

    await waitFor(() => expect(screen.getByRole('button', { name: 'Create team' })).toBeEnabled())

    let tabs = screen.getAllByRole('tab')
    expect(tabs[0]).toHaveTextContent(/^Members$/)
    expect(tabs[1]).toHaveTextContent('Teams (1)')
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[2]).toHaveTextContent(/^Admins$/)

    cleanup()
    renderProfileAdminHome('admins')

    await waitFor(() => expect(screen.getByRole('button', { name: 'Invite admin' })).toBeEnabled())

    tabs = screen.getAllByRole('tab')
    expect(tabs[0]).toHaveTextContent(/^Members$/)
    expect(tabs[1]).toHaveTextContent(/^Teams$/)
    expect(tabs[2]).toHaveTextContent('Admins (0)')
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true')
  })

  it('shows admins as a Users & Teams tab', async () => {
    renderProfileAdminHome()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Create member' })).toBeEnabled())

    const adminsTab = screen.getByRole('tab', { name: /^Admins/ })

    expect(adminsTab).toHaveAttribute('href', '/users-and-teams/admins')
  })

  it('shows admin search and invite actions in the Users & Teams title bar', async () => {
    renderProfileAdminHome('admins')

    expect(
      screen.getByText(
        'Admins are operators who can access Control UI. They do not receive Desktop App access from this tab.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText('Control UI admins')).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search admins' }), {
      target: { value: 'josue' },
    })
    expect(screen.getByText('Control admins panel josue')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Invite admin' }))

    expect(mockPush).toHaveBeenCalledWith('/users-and-teams/admins/new')
  })

  it('opens a confirmation modal before cancelling a pending invitation', async () => {
    renderProfileAdminHome()

    await waitFor(() => expect(screen.getByText('Pending invitations')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByRole('alertdialog', { name: 'Cancel invitation?' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel invitation' }))

    await waitFor(() => {
      expect(revokeAdminTeamInvitation).toHaveBeenCalledWith('team-1', 'invitation-1')
    })
  })

  it('can delete solo-member teams after deleting a member', async () => {
    renderProfileAdminHome()

    await waitFor(() => expect(screen.getByText('Accepted Invitee')).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText('Delete member Accepted Invitee'))

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /Delete empty teams too/ })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('checkbox', { name: /Delete empty teams too/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))

    await waitFor(() => {
      expect(deleteAdminUser).toHaveBeenCalledWith(
        'accepted-password-pending-user',
        expect.objectContaining({
          reason: 'control_ui_user_retirement',
          idempotencyKey: expect.any(String),
          correlationId: expect.any(String),
        })
      )
      expect(deleteAdminTeam).toHaveBeenCalledWith('team-1')
    })
    expect(vi.mocked(deleteAdminUser).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deleteAdminTeam).mock.invocationCallOrder[0]
    )
  })

  it('reuses the same retirement request identity when a failed delete is retried', async () => {
    vi.mocked(deleteAdminUser)
      .mockRejectedValueOnce(new Error('temporary upstream failure'))
      .mockResolvedValueOnce({ deleted: true, id: 'accepted-password-pending-user' })
    renderProfileAdminHome()

    await waitFor(() => expect(screen.getByText('Accepted Invitee')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('Delete member Accepted Invitee'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Delete account' })).toBeEnabled()
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    await waitFor(() => expect(deleteAdminUser).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText('temporary upstream failure')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    await waitFor(() => expect(deleteAdminUser).toHaveBeenCalledTimes(2))

    expect(vi.mocked(deleteAdminUser).mock.calls[1]?.[1]).toEqual(
      vi.mocked(deleteAdminUser).mock.calls[0]?.[1]
    )
  })
})
