import React, { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  allowWorkflowApprovalTeam,
  getAdminTeams,
  getAdminUsers,
  listWorkflowApprovalAllowedTeams,
  listWorkflowGrants,
  listWorkflowTeamGrants,
  revokeWorkflowApprovalTeam,
  setWorkflowGrants,
  setWorkflowTeamGrants,
} from '@lib/api'
import { ToastProvider } from '../Toast'
import { WorkflowAccessPanel } from '../WorkflowAccessPanel'

vi.mock('@lib/api', () => ({
  getAdminUsers: vi.fn(),
  getAdminTeams: vi.fn(),
  listWorkflowGrants: vi.fn(),
  listWorkflowTeamGrants: vi.fn(),
  listWorkflowApprovalAllowedTeams: vi.fn(),
  isSilentApiError: (error: unknown) =>
    Boolean(error && typeof error === 'object' && (error as { silent?: unknown }).silent),
  setWorkflowGrants: vi.fn(),
  setWorkflowTeamGrants: vi.fn(),
  allowWorkflowApprovalTeam: vi.fn(),
  revokeWorkflowApprovalTeam: vi.fn(),
}))

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function EditHarness() {
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([])
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([])
  const [selectedApprovalTeamIds, setSelectedApprovalTeamIds] = useState<string[]>([])

  return (
    <ToastProvider>
      <WorkflowAccessPanel
        mode="edit"
        namespace="sandbox-recipes"
        recipeName="installed-recipe"
        selectedUserIds={selectedUserIds}
        selectedTeamIds={selectedTeamIds}
        selectedApprovalTeamIds={selectedApprovalTeamIds}
        onSelectedUserIdsChange={setSelectedUserIds}
        onSelectedTeamIdsChange={setSelectedTeamIds}
        onSelectedApprovalTeamIdsChange={setSelectedApprovalTeamIds}
      />
    </ToastProvider>
  )
}

const aliceGrant = {
  id: 'u-1',
  email: 'alice@example.com',
  name: 'Alice',
  displayName: null,
}

const bobGrant = {
  id: 'u-2',
  email: 'bob@example.com',
  name: 'Bob',
  displayName: null,
}

const triggerTeamGrant = {
  id: 'team-trigger',
  name: 'Trigger Team',
  createdAt: '2026-01-01T00:00:00Z',
}
const nextTeamGrant = { id: 'team-next', name: 'Next Team', createdAt: '2026-01-01T00:00:00Z' }
const finalTeamGrant = { id: 'team-final', name: 'Final Team', createdAt: '2026-01-01T00:00:00Z' }
const lastTeamGrant = { id: 'team-last', name: 'Last Team', createdAt: '2026-01-01T00:00:00Z' }

beforeEach(() => {
  vi.mocked(getAdminUsers).mockResolvedValue({
    items: [
      { ...aliceGrant, picture: null, activeTeamCount: 1 },
      { ...bobGrant, picture: null, activeTeamCount: 1 },
    ],
  })
  vi.mocked(getAdminTeams).mockResolvedValue({
    items: [
      { ...triggerTeamGrant, memberCount: 2 },
      { ...nextTeamGrant, memberCount: 2 },
      { ...finalTeamGrant, memberCount: 2 },
      { ...lastTeamGrant, memberCount: 2 },
    ],
  })
  vi.mocked(listWorkflowGrants).mockResolvedValue({ items: [] })
  vi.mocked(listWorkflowTeamGrants).mockResolvedValue({ items: [] })
  vi.mocked(listWorkflowApprovalAllowedTeams).mockResolvedValue({ items: [] })
  vi.mocked(setWorkflowGrants).mockResolvedValue({ userIds: [] })
  vi.mocked(setWorkflowTeamGrants).mockResolvedValue({ teamIds: [], added: [], removed: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('WorkflowAccessPanel', () => {
  it('does not render workflow access save-mode badges in the editor flow', async () => {
    render(<EditHarness />)

    await waitFor(() => expect(screen.getByText('Workflow access')).toBeInTheDocument())
    expect(screen.queryByText('Live save')).not.toBeInTheDocument()
    expect(screen.queryByText('Saved on deploy')).not.toBeInTheDocument()
  })

  it('does not render team ids as secondary text in team access sections', async () => {
    vi.mocked(listWorkflowTeamGrants).mockResolvedValue({ items: [triggerTeamGrant] })
    vi.mocked(listWorkflowApprovalAllowedTeams).mockResolvedValue({ items: [nextTeamGrant] })

    render(<EditHarness />)

    fireEvent.click(screen.getByRole('tab', { name: /Teams/ }))
    const teamSection = screen.getByTestId('workflow-access-trigger-teams')
    await waitFor(() => expect(within(teamSection).getByText('Trigger Team')).toBeInTheDocument())
    await waitFor(() =>
      expect(within(teamSection).getAllByText('Next Team').length).toBeGreaterThan(0)
    )
    expect(within(teamSection).queryByText('team-trigger')).not.toBeInTheDocument()
    expect(within(teamSection).queryByText('team-next')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /Approval target teams/ }))
    const approvalSection = screen.getByTestId('workflow-access-approval-target-teams')
    await waitFor(() => expect(within(approvalSection).getByText('Next Team')).toBeInTheDocument())
    await waitFor(() =>
      expect(within(approvalSection).getAllByText('Trigger Team').length).toBeGreaterThan(0)
    )
    expect(within(approvalSection).queryByText('team-trigger')).not.toBeInTheDocument()
    expect(within(approvalSection).queryByText('team-next')).not.toBeInTheDocument()
  })

  it('confirms before revoking loaded member trigger access', async () => {
    vi.mocked(listWorkflowGrants).mockResolvedValue({ items: [aliceGrant, bobGrant] })

    render(<EditHarness />)

    const section = screen.getByTestId('workflow-access-trigger-users')
    await waitFor(() => expect(within(section).getByText(/alice@example\.com/)).toBeInTheDocument())

    fireEvent.click(within(section).getByRole('button', { name: 'Actions for Alice' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove member trigger access' }))
    expect(setWorkflowGrants).not.toHaveBeenCalled()
    expect(
      await screen.findByRole('alertdialog', { name: 'Remove Member Trigger Access' })
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remove access' }))

    await waitFor(() =>
      expect(setWorkflowGrants).toHaveBeenCalledWith('sandbox-recipes', 'installed-recipe', ['u-2'])
    )
  })

  it('sorts visible access records by human identity with a stable id tie-break', async () => {
    vi.mocked(listWorkflowGrants).mockResolvedValue({
      items: [
        bobGrant,
        { id: 'u-10', email: 'same-10@example.com', name: 'Same', displayName: null },
        { id: 'u-3', email: 'same-3@example.com', name: 'Same', displayName: null },
        aliceGrant,
      ],
    })

    render(<EditHarness />)

    const section = screen.getByTestId('workflow-access-trigger-users')
    await waitFor(() => expect(within(section).getByText('Alice')).toBeInTheDocument())
    const rows = section.querySelectorAll('.cu-workflow-access__row-title')
    expect([...rows].map(row => row.textContent)).toEqual(['Alice', 'Bob', 'Same', 'Same'])
    expect(
      within(section)
        .getAllByRole('listitem')
        .map(row => row.getAttribute('data-access-id'))
    ).toEqual(['u-1', 'u-2', 'u-3', 'u-10'])
    expect(section.querySelector('.cu-workflow-access__rows')).toHaveAttribute('role', 'list')
  })

  it('sorts trigger-team and approval-team records by name with stable id tie-breaks', async () => {
    vi.mocked(listWorkflowTeamGrants).mockResolvedValue({
      items: [
        { id: 'team-z', name: 'Zulu' },
        { id: 'team-10', name: 'Same Team' },
        { id: 'team-2', name: 'Same Team' },
        { id: 'team-a', name: 'Alpha Team' },
      ],
    })
    vi.mocked(listWorkflowApprovalAllowedTeams).mockResolvedValue({
      items: [
        { id: 'approval-z', name: 'Zulu Approval', createdAt: '2026-01-01T00:00:00Z' },
        { id: 'approval-10', name: 'Same Approval', createdAt: '2026-01-01T00:00:00Z' },
        { id: 'approval-2', name: 'Same Approval', createdAt: '2026-01-01T00:00:00Z' },
        { id: 'approval-a', name: 'Alpha Approval', createdAt: '2026-01-01T00:00:00Z' },
      ],
    })

    render(<EditHarness />)

    fireEvent.click(screen.getByRole('tab', { name: /Teams/ }))
    const teamSection = screen.getByTestId('workflow-access-trigger-teams')
    await waitFor(() => expect(within(teamSection).getByText('Alpha Team')).toBeInTheDocument())
    expect(
      within(teamSection)
        .getAllByRole('listitem')
        .map(row => row.getAttribute('data-access-id'))
    ).toEqual(['team-a', 'team-2', 'team-10', 'team-z'])

    fireEvent.click(screen.getByRole('tab', { name: /Approval target teams/ }))
    const approvalSection = screen.getByTestId('workflow-access-approval-target-teams')
    await waitFor(() =>
      expect(within(approvalSection).getByText('Alpha Approval')).toBeInTheDocument()
    )
    expect(
      within(approvalSection)
        .getAllByRole('listitem')
        .map(row => row.getAttribute('data-access-id'))
    ).toEqual(['approval-a', 'approval-2', 'approval-10', 'approval-z'])
  })

  it('blocks live grant writes until the current edit-mode grants are loaded', async () => {
    const userGrants = createDeferred<{ items: (typeof aliceGrant)[] }>()
    const teamGrants = createDeferred<{ items: (typeof triggerTeamGrant)[] }>()
    vi.mocked(listWorkflowGrants)
      .mockReturnValueOnce(userGrants.promise)
      .mockResolvedValue({ items: [aliceGrant, bobGrant] })
    vi.mocked(listWorkflowTeamGrants)
      .mockReturnValueOnce(teamGrants.promise)
      .mockResolvedValue({ items: [triggerTeamGrant, nextTeamGrant] })

    render(<EditHarness />)

    await waitFor(() => expect(screen.getByText('Loading workflow access...')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('tab', { name: /Teams/ }))
    const teamSection = screen.getByTestId('workflow-access-trigger-teams')

    fireEvent.click(screen.getByRole('tab', { name: /Members/ }))
    expect(
      within(screen.getByTestId('workflow-access-trigger-users')).getByRole('button', {
        name: /^Add member$/,
      })
    ).toBeDisabled()
    fireEvent.click(screen.getByRole('tab', { name: /Teams/ }))
    expect(
      within(screen.getByTestId('workflow-access-trigger-teams')).getByRole('button', {
        name: /^Add team$/,
      })
    ).toBeDisabled()

    fireEvent.click(screen.getByRole('tab', { name: /Members/ }))
    fireEvent.click(
      within(screen.getByTestId('workflow-access-trigger-users')).getByRole('option', {
        name: /Bob/,
      })
    )
    fireEvent.click(screen.getByRole('button', { name: /^Add member$/ }))
    fireEvent.click(screen.getByRole('tab', { name: /Teams/ }))
    fireEvent.click(
      within(screen.getByTestId('workflow-access-trigger-teams')).getByRole('option', {
        name: 'Next Team',
      })
    )
    fireEvent.click(screen.getByRole('button', { name: /^Add team$/ }))
    expect(setWorkflowGrants).not.toHaveBeenCalled()
    expect(setWorkflowTeamGrants).not.toHaveBeenCalled()

    await act(async () => {
      userGrants.resolve({ items: [aliceGrant] })
      teamGrants.resolve({ items: [triggerTeamGrant] })
    })

    fireEvent.click(screen.getByRole('tab', { name: /Members/ }))
    await waitFor(() => expect(screen.getByText(/alice@example\.com/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /Teams/ }))
    await waitFor(() =>
      expect(
        within(screen.getByTestId('workflow-access-trigger-teams')).getByText('Trigger Team')
      ).toBeInTheDocument()
    )
    fireEvent.click(screen.getByRole('tab', { name: /Members/ }))
    const loadedUserPick = within(
      screen.getByTestId('workflow-access-trigger-users')
    ).getByLabelText('Search users...')
    expect(loadedUserPick).not.toBeDisabled()
    fireEvent.click(screen.getByRole('tab', { name: /Teams/ }))
    const loadedTeamSection = screen.getByTestId('workflow-access-trigger-teams')
    const loadedTeamPick = within(loadedTeamSection).getByLabelText('Search teams...')
    expect(loadedTeamPick).not.toBeDisabled()

    fireEvent.click(screen.getByRole('tab', { name: /Members/ }))
    fireEvent.click(
      within(screen.getByTestId('workflow-access-trigger-users')).getByRole('option', {
        name: /Bob/,
      })
    )
    fireEvent.click(screen.getByRole('button', { name: /^Add member$/ }))
    await waitFor(() =>
      expect(setWorkflowGrants).toHaveBeenCalledWith('sandbox-recipes', 'installed-recipe', [
        'u-1',
        'u-2',
      ])
    )

    fireEvent.click(screen.getByRole('tab', { name: /Teams/ }))
    fireEvent.click(
      within(screen.getByTestId('workflow-access-trigger-teams')).getByRole('option', {
        name: 'Next Team',
      })
    )
    fireEvent.click(screen.getByRole('button', { name: /^Add team$/ }))
    await waitFor(() =>
      expect(setWorkflowTeamGrants).toHaveBeenCalledWith('sandbox-recipes', 'installed-recipe', [
        'team-trigger',
        'team-next',
      ])
    )
  })

  it('serializes approval-team writes, reloads after a rate limit, and shows one retry message', async () => {
    const firstAllow = createDeferred<{ teamId: string }>()
    const rateLimitError = Object.assign(new Error('429 Too Many Requests'), {
      status: 429,
      body: { error: 'Too Many Requests', retryAfterSeconds: 12 },
    })
    vi.mocked(listWorkflowApprovalAllowedTeams).mockResolvedValue({ items: [triggerTeamGrant] })
    vi.mocked(allowWorkflowApprovalTeam)
      .mockReturnValueOnce(firstAllow.promise)
      .mockRejectedValueOnce(rateLimitError)

    render(<EditHarness />)

    fireEvent.click(screen.getByRole('tab', { name: /Approval target teams/ }))
    const section = screen.getByTestId('workflow-access-approval-target-teams')
    await waitFor(() => expect(within(section).getByText('Trigger Team')).toBeInTheDocument())

    fireEvent.click(within(section).getByRole('option', { name: 'Next Team' }))
    fireEvent.click(within(section).getByRole('option', { name: 'Final Team' }))
    fireEvent.click(within(section).getByRole('option', { name: 'Last Team' }))
    fireEvent.click(within(section).getByRole('button', { name: 'Allow teams' }))

    await waitFor(() => expect(allowWorkflowApprovalTeam).toHaveBeenCalledTimes(1))
    expect(allowWorkflowApprovalTeam).toHaveBeenCalledWith(
      'sandbox-recipes',
      'installed-recipe',
      'team-next'
    )
    expect(allowWorkflowApprovalTeam).toHaveBeenCalledTimes(1)

    await act(async () => {
      firstAllow.resolve({ teamId: 'team-next' })
    })

    await waitFor(() => expect(allowWorkflowApprovalTeam).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(listWorkflowApprovalAllowedTeams).toHaveBeenCalledTimes(2))
    expect(allowWorkflowApprovalTeam).toHaveBeenLastCalledWith(
      'sandbox-recipes',
      'installed-recipe',
      'team-final'
    )
    expect(allowWorkflowApprovalTeam).not.toHaveBeenCalledWith(
      'sandbox-recipes',
      'installed-recipe',
      'team-last'
    )
    expect(revokeWorkflowApprovalTeam).not.toHaveBeenCalled()
    expect(within(section).getByRole('alert')).toHaveTextContent(
      'Some changes were saved. Too many approval target team changes. Try again in about 12 seconds.'
    )
    expect(screen.queryByText('Approval target teams updated.')).not.toBeInTheDocument()
  })

  it('stops approval-team writes when the session expires', async () => {
    const authExpired = Object.assign(new Error('Session expired'), {
      status: 401,
      silent: true,
    })
    vi.mocked(allowWorkflowApprovalTeam).mockRejectedValueOnce(authExpired)

    render(<EditHarness />)

    fireEvent.click(screen.getByRole('tab', { name: /Approval target teams/ }))
    const section = screen.getByTestId('workflow-access-approval-target-teams')
    await waitFor(() =>
      expect(within(section).getByRole('option', { name: 'Next Team' })).toBeInTheDocument()
    )
    fireEvent.click(within(section).getByRole('option', { name: 'Next Team' }))
    fireEvent.click(within(section).getByRole('button', { name: 'Allow team' }))

    await waitFor(() => expect(allowWorkflowApprovalTeam).toHaveBeenCalledOnce())
    expect(revokeWorkflowApprovalTeam).not.toHaveBeenCalled()
    expect(listWorkflowApprovalAllowedTeams).toHaveBeenCalledOnce()
    expect(within(section).queryByRole('alert')).not.toBeInTheDocument()
  })
})
