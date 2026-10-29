import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TeamCreatePage from '../../app/profile-admin/teams/new/page'
import * as api from '../../lib/api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/users-and-teams/teams/new',
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

vi.mock('../../lib/api', () => ({
  addAdminTeamMember: vi.fn(),
  createAdminTeam: vi.fn(),
  getAdminUsers: vi.fn(),
  getHosts: vi.fn(),
  updateAdminTeamAgents: vi.fn(),
  updateAdminTeamContexts: vi.fn(),
}))

afterEach(() => {
  cleanup()
})

async function createTeamWithAgent(agentName: string) {
  const { container } = render(<TeamCreatePage />)
  fireEvent.change(await screen.findByPlaceholderText('Team name'), {
    target: { value: 'Platform' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await screen.findByText('Select agents')
  fireEvent.click(container.querySelector('#new-team-agent-picker') as HTMLElement)
  fireEvent.click(screen.getByRole('option', { name: new RegExp(agentName) }))
  fireEvent.click(screen.getByRole('button', { name: 'Create team' }))
  await waitFor(() =>
    expect(api.updateAdminTeamAgents).toHaveBeenCalledWith('team-1', [agentName], [])
  )
}

describe('team create Context membership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.getAdminUsers).mockResolvedValue({ items: [] })
    vi.mocked(api.createAdminTeam).mockResolvedValue({ id: 'team-1', name: 'Platform' })
    vi.mocked(api.updateAdminTeamAgents).mockResolvedValue({
      teamId: 'team-1',
      agentNames: [],
      deletedAgentNames: [],
      deletedHistoryLimit: 10,
    })
    vi.mocked(api.updateAdminTeamContexts).mockResolvedValue({ teamId: 'team-1', contextIds: [] })
  })

  it('stores the Context name the selected agent references', async () => {
    vi.mocked(api.getHosts).mockResolvedValue({
      items: [{ metadata: { name: 'agent-a' }, spec: { contextRef: 'ctx-a' } }],
    })

    await createTeamWithAgent('agent-a')

    expect(api.updateAdminTeamContexts).toHaveBeenCalledWith('team-1', ['ctx-a'])
  })

  it('stores a padded contextRef verbatim instead of normalizing it to another Context name', async () => {
    vi.mocked(api.getHosts).mockResolvedValue({
      items: [{ metadata: { name: 'agent-a' }, spec: { contextRef: 'ctx-a ' } }],
    })

    await createTeamWithAgent('agent-a')

    expect(api.updateAdminTeamContexts).toHaveBeenCalledTimes(1)
    expect(api.updateAdminTeamContexts).toHaveBeenCalledWith('team-1', ['ctx-a '])
  })
})
