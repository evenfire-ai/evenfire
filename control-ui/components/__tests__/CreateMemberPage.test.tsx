import type React from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import CreateMemberPage from '../../app/profile-admin/users/new/page'
import { getAdminTeams, inviteAdminTeamMember } from '../../lib/api'
import { ToastProvider } from '../Toast'

const mockPush = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    getAdminTeams: vi.fn(),
    inviteAdminTeamMember: vi.fn(),
  }
})

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

describe('CreateMemberPage', () => {
  beforeEach(() => {
    mockPush.mockClear()
    vi.mocked(getAdminTeams).mockResolvedValue({
      items: [
        { id: 'team-1', name: 'Marketing', memberCount: 0 },
        { id: 'team-2', name: 'Support', memberCount: 0 },
      ],
    })
    vi.mocked(inviteAdminTeamMember).mockResolvedValue({
      id: 'invitation-1',
      team_id: 'team-1',
      invitee_name: 'Jane Doe',
      email: 'jane@example.com',
      role: 'member',
      token: 'token',
      status: 'pending',
      created_at: '2026-04-30T12:00:00.000Z',
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('sends one invitation with every selected team instead of creating a user directly', async () => {
    render(<CreateMemberPage />)

    expect(screen.getByRole('heading', { name: 'Member identity' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Jane Doe' } })
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'Jane@Example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(screen.getByLabelText('Teams')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('Teams'))
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Marketing' })).toBeInTheDocument()
    )
    expect(screen.queryByText('team-1')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: 'Marketing' }))
    fireEvent.click(screen.getByRole('option', { name: 'Support' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }))

    await waitFor(() => {
      expect(inviteAdminTeamMember).toHaveBeenCalledWith(null, {
        name: 'Jane Doe',
        email: 'jane@example.com',
        role: 'member',
        teams: [
          { teamId: 'team-1', role: 'member' },
          { teamId: 'team-2', role: 'member' },
        ],
      })
    })
    expect(inviteAdminTeamMember).toHaveBeenCalledTimes(1)
    expect(mockPush).toHaveBeenCalledWith('/users-and-teams/users')
  })

  it('sends an invitation without a team when there are no teams yet', async () => {
    vi.mocked(getAdminTeams).mockResolvedValueOnce({ items: [] })

    render(<CreateMemberPage />)

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Jane Doe' } })
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'Jane@Example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(screen.queryByText(/Loading teams/)).not.toBeInTheDocument())
    expect(screen.queryByLabelText('Team', { selector: 'select' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }))

    await waitFor(() => {
      expect(inviteAdminTeamMember).toHaveBeenCalledWith(null, {
        name: 'Jane Doe',
        email: 'jane@example.com',
        role: 'member',
        teams: [],
      })
    })
    expect(mockPush).toHaveBeenCalledWith('/users-and-teams/users')
  })

  it('shows a friendly duplicate email message without leaving the form', async () => {
    vi.mocked(getAdminTeams).mockResolvedValueOnce({ items: [] })
    vi.mocked(inviteAdminTeamMember).mockRejectedValueOnce(
      new Error(
        '409 Conflict - A member with this email already exists. Open the existing member and add them to more teams instead.'
      )
    )

    render(<CreateMemberPage />)

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Jane Doe' } })
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'Jane@Example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(screen.queryByText(/Loading teams/)).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }))

    await waitFor(() => {
      expect(
        screen.getByText(
          'A member with this email already exists. Open the existing member and add them to more teams instead.'
        )
      ).toBeInTheDocument()
    })
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('does not advance through the step rail when the email is invalid', async () => {
    render(<CreateMemberPage />)

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Jane Doe' } })
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'notanemail' } })

    await waitFor(() => expect(screen.getByRole('button', { name: /Team/ })).toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: /Team/ }))

    expect(screen.getByRole('heading', { name: 'Member identity' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Team assignment' })).not.toBeInTheDocument()
  })
})
