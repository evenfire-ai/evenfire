import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import TeamDetailsPage from '../../app/profile-admin/teams/[teamId]/page'
import UserDetailsPage from '../../app/profile-admin/users/[userId]/page'
import * as api from '../../lib/api'
import { ToastProvider } from '../Toast'

const pushMock = vi.fn()
const replaceMock = vi.fn()
const navigationState = vi.hoisted(() => ({
  params: { tab: 'agents' } as { userId?: string; teamId?: string; tab?: string },
}))

vi.mock('next/navigation', () => ({
  useParams: () => navigationState.params,
  usePathname: () =>
    navigationState.params.teamId
      ? '/users-and-teams/teams/team-1/agents'
      : '/users-and-teams/users/user-1/agents',
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@components/DetailPageShell', () => ({
  DetailPageShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}))

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    addAdminTeamMember: vi.fn(),
    apiGet: vi.fn(),
    deleteAdminMember: vi.fn(),
    deleteAdminTeam: vi.fn(),
    deleteAdminUser: vi.fn(),
    getAdminTeam: vi.fn(),
    getAdminTeamAgents: vi.fn(),
    getAdminTeamContexts: vi.fn(),
    getAdminTeamMembers: vi.fn(),
    getAdminTeamPendingInvitations: vi.fn(),
    getAdminTeams: vi.fn(),
    getAdminUserAgents: vi.fn(),
    getAdminUserContext: vi.fn(),
    getAdminUserContexts: vi.fn(),
    getAdminUserTeams: vi.fn(),
    getAdminUsers: vi.fn(),
    getContexts: vi.fn(),
    getHosts: vi.fn(),
    inviteAdminTeamMember: vi.fn(),
    renameAdminTeam: vi.fn(),
    updateAdminMemberRole: vi.fn(),
    updateAdminTeamAgents: vi.fn(),
    updateAdminTeamContexts: vi.fn(),
    updateAdminUserAgents: vi.fn(),
    updateAdminUserContext: vi.fn(),
    updateAdminUserContexts: vi.fn(),
  }
})

function render(children: React.ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

function renderTeamDetails() {
  navigationState.params = { teamId: 'team-1', tab: 'agents' }
  return render(<TeamDetailsPage />)
}

function renderUserDetails() {
  navigationState.params = { userId: 'user-1', tab: 'agents' }
  return render(<UserDetailsPage />)
}

const contextItems = [
  { metadata: { name: 'ctx-alpha' }, spec: { contextId: 'ctx-alpha' } },
  { metadata: { name: 'ctx-unrelated' }, spec: { contextId: 'ctx-unrelated' } },
  { metadata: { name: 'ctx-beta' }, spec: { contextId: 'ctx-beta' } },
]

const hostItems = [
  { metadata: { name: 'agent-alpha' }, spec: { contextRef: 'ctx-alpha' } },
  { metadata: { name: 'agent-beta' }, spec: { contextRef: 'ctx-beta' } },
]

beforeEach(() => {
  vi.clearAllMocks()
  navigationState.params = { tab: 'agents' }
  vi.mocked(api.getContexts).mockResolvedValue({ items: contextItems })
  vi.mocked(api.getHosts).mockResolvedValue({ items: hostItems })
  vi.mocked(api.apiGet).mockResolvedValue({ items: [] })
  vi.mocked(api.getAdminTeams).mockResolvedValue({
    items: [{ id: 'team-1', name: 'Platform', memberCount: 1 }],
  })
  vi.mocked(api.getAdminUserTeams).mockResolvedValue({ items: [] })
  vi.mocked(api.getAdminUsers).mockResolvedValue({
    items: [
      {
        id: 'user-1',
        email: 'member@example.com',
        name: 'Member One',
        displayName: 'Member One',
        activeTeamCount: 1,
      },
    ],
  })
  vi.mocked(api.getAdminUserContext).mockResolvedValue({
    email: 'member@example.com',
    name: 'Member One',
    displayName: 'Member One',
    channels: { emails: [], slackUserNames: [], telegramIds: [] },
  })
  vi.mocked(api.getAdminTeam).mockResolvedValue({ id: 'team-1', name: 'Platform' })
  vi.mocked(api.getAdminTeamMembers).mockResolvedValue({ items: [] })
  vi.mocked(api.getAdminTeamPendingInvitations).mockResolvedValue({ items: [] })
})

afterEach(() => {
  cleanup()
})

describe('profile-admin agent compatibility access', () => {
  it('removes only owned Context grants when a member loses final agent access', async () => {
    vi.mocked(api.getAdminUserContexts)
      .mockResolvedValueOnce({ userId: 'user-1', contextIds: ['ctx-alpha', 'ctx-unrelated'] })
      .mockResolvedValueOnce({ userId: 'user-1', contextIds: ['ctx-alpha', 'ctx-unrelated'] })
    vi.mocked(api.getAdminUserAgents).mockResolvedValue({
      userId: 'user-1',
      agentNames: ['agent-alpha'],
      deletedAgentNames: [],
      deletedHistoryLimit: 10,
    })
    vi.mocked(api.updateAdminUserAgents).mockResolvedValue({
      userId: 'user-1',
      agentNames: [],
      deletedAgentNames: ['agent-alpha'],
      deletedHistoryLimit: 10,
    })
    vi.mocked(api.updateAdminUserContexts).mockResolvedValue({
      userId: 'user-1',
      contextIds: ['ctx-unrelated'],
    })

    renderUserDetails()

    await screen.findByRole('button', { name: 'Actions for agent-alpha' })
    fireEvent.click(screen.getByRole('button', { name: 'Actions for agent-alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke access' }))
    fireEvent.click((await screen.findByRole('alertdialog')).querySelector('.cu-btn--danger')!)

    await waitFor(() => {
      expect(api.updateAdminUserAgents).toHaveBeenCalledWith('user-1', [], ['agent-alpha'])
    })
    expect(api.updateAdminUserContexts).toHaveBeenCalledWith('user-1', ['ctx-unrelated'])
  })

  it('removes only owned Context grants when a team loses final agent access', async () => {
    vi.mocked(api.getAdminTeamContexts)
      .mockResolvedValueOnce({ teamId: 'team-1', contextIds: ['ctx-alpha', 'ctx-unrelated'] })
      .mockResolvedValueOnce({ teamId: 'team-1', contextIds: ['ctx-alpha', 'ctx-unrelated'] })
    vi.mocked(api.getAdminTeamAgents).mockResolvedValue({
      teamId: 'team-1',
      agentNames: ['agent-alpha'],
      deletedAgentNames: [],
      deletedHistoryLimit: 10,
    })
    vi.mocked(api.updateAdminTeamAgents).mockResolvedValue({
      teamId: 'team-1',
      agentNames: [],
      deletedAgentNames: ['agent-alpha'],
      deletedHistoryLimit: 10,
    })
    vi.mocked(api.updateAdminTeamContexts).mockResolvedValue({
      teamId: 'team-1',
      contextIds: ['ctx-unrelated'],
    })

    renderTeamDetails()

    await screen.findByRole('button', { name: 'Actions for agent agent-alpha' })
    fireEvent.click(screen.getByRole('button', { name: 'Actions for agent agent-alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke agent access' }))
    fireEvent.click((await screen.findByRole('alertdialog')).querySelector('.cu-btn--danger')!)

    await waitFor(() => {
      expect(api.updateAdminTeamAgents).toHaveBeenCalledWith('team-1', [], ['agent-alpha'])
    })
    expect(api.updateAdminTeamContexts).toHaveBeenCalledWith('team-1', ['ctx-unrelated'])
  })
})
