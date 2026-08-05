import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProfileAccessProvider, useProfileAccess } from '@components/ProfileAccessContext'
import { resetProfileAccessCache } from '@lib/profileAccess'
import type { ApprovalChannelTarget } from '@/app/types/approvalChannels'
import type { ManageableTeam } from '@/app/types/profile'

const authState = vi.hoisted(() => ({
  isLoggedIn: true,
  isLoading: false,
  me: {
    id: 'user-1',
    email: 'lead@example.com',
    name: 'Lead User',
    role: 'member' as const,
  },
}))

vi.mock('@components/AuthContext', () => ({
  useAuth: () => ({
    authState,
    checkAuth: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
  }),
}))

function team(id: string): ManageableTeam {
  return {
    id,
    name: id,
    role: 'admin',
    canAssignLeader: true,
  }
}

function target(id: string): ApprovalChannelTarget {
  return {
    id,
    medium: 'slack',
    agentName: 'agent-1',
    channelName: id,
    channelNamespace: 'default',
    botLabel: 'Slack App',
    botUsername: null,
    botDeepLink: null,
    status: 'ready',
  }
}

function jsonResponse(items: unknown[]): Response {
  return new Response(JSON.stringify({ items }), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  })
}

function errorResponse(): Response {
  return new Response(JSON.stringify({ message: 'temporary failure' }), {
    headers: { 'Content-Type': 'application/json' },
    status: 500,
    statusText: 'Internal Server Error',
  })
}

function AccessProbe() {
  const {
    approvalTargets,
    approvalTargetsError,
    canManageMembers,
    manageableTeams,
    manageableTeamsError,
    refreshApprovalTargets,
    refreshManageableTeams,
  } = useProfileAccess()

  return (
    <div>
      <div data-testid="member-access">
        {canManageMembers ? 'members-visible' : 'members-hidden'}
      </div>
      <div data-testid="teams">{manageableTeams.map(item => item.id).join(',') || 'no-teams'}</div>
      <div data-testid="team-error">{manageableTeamsError ? 'team-error' : 'team-ok'}</div>
      <div data-testid="targets">
        {approvalTargets.map(item => item.id).join(',') || 'no-targets'}
      </div>
      <div data-testid="target-error">{approvalTargetsError ? 'target-error' : 'target-ok'}</div>
      <button
        type="button"
        onClick={() => void refreshManageableTeams({ force: true }).catch(() => {})}
      >
        Refresh teams
      </button>
      <button
        type="button"
        onClick={() => void refreshApprovalTargets({ force: true }).catch(() => {})}
      >
        Refresh targets
      </button>
    </div>
  )
}

function renderProvider() {
  return render(
    <ProfileAccessProvider>
      <AccessProbe />
    </ProfileAccessProvider>
  )
}

let originalFetch: typeof fetch
let teamsResult: ManageableTeam[] | 'error'
let targetsResult: ApprovalChannelTarget[] | 'error'

beforeEach(() => {
  originalFetch = globalThis.fetch
  resetProfileAccessCache()
  authState.isLoggedIn = true
  authState.isLoading = false
  authState.me = {
    id: 'user-1',
    email: 'lead@example.com',
    name: 'Lead User',
    role: 'member',
  }
  teamsResult = [team('team-1')]
  targetsResult = [target('target-1')]
  globalThis.fetch = (async input => {
    const url = String(input)
    if (url.includes('/members/manageable-teams')) {
      return teamsResult === 'error' ? errorResponse() : jsonResponse(teamsResult)
    }
    if (url.includes('/workflow-approval-mediums/targets')) {
      return targetsResult === 'error' ? errorResponse() : jsonResponse(targetsResult)
    }
    throw new Error(`unexpected request: ${url}`)
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  resetProfileAccessCache()
  globalThis.fetch = originalFetch
})

describe('ProfileAccessProvider refresh errors', () => {
  it('preserves known access after transient refresh failures', async () => {
    renderProvider()

    await waitFor(() => expect(screen.getByTestId('teams')).toHaveTextContent('team-1'))
    await waitFor(() => expect(screen.getByTestId('targets')).toHaveTextContent('target-1'))
    expect(screen.getByTestId('member-access')).toHaveTextContent('members-visible')

    teamsResult = 'error'
    fireEvent.click(screen.getByRole('button', { name: 'Refresh teams' }))
    await waitFor(() => expect(screen.getByTestId('team-error')).toHaveTextContent('team-error'))
    expect(screen.getByTestId('teams')).toHaveTextContent('team-1')
    expect(screen.getByTestId('member-access')).toHaveTextContent('members-visible')

    targetsResult = 'error'
    fireEvent.click(screen.getByRole('button', { name: 'Refresh targets' }))
    await waitFor(() =>
      expect(screen.getByTestId('target-error')).toHaveTextContent('target-error')
    )
    expect(screen.getByTestId('targets')).toHaveTextContent('target-1')

    teamsResult = [team('team-2')]
    targetsResult = [target('target-2')]
    fireEvent.click(screen.getByRole('button', { name: 'Refresh teams' }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh targets' }))

    await waitFor(() => expect(screen.getByTestId('teams')).toHaveTextContent('team-2'))
    await waitFor(() => expect(screen.getByTestId('targets')).toHaveTextContent('target-2'))
    expect(screen.getByTestId('team-error')).toHaveTextContent('team-ok')
    expect(screen.getByTestId('target-error')).toHaveTextContent('target-ok')
  })

  it('does not expose preserved access after a user id change', async () => {
    const view = renderProvider()
    await waitFor(() => expect(screen.getByTestId('teams')).toHaveTextContent('team-1'))

    teamsResult = 'error'
    fireEvent.click(screen.getByRole('button', { name: 'Refresh teams' }))
    await waitFor(() => expect(screen.getByTestId('team-error')).toHaveTextContent('team-error'))
    expect(screen.getByTestId('teams')).toHaveTextContent('team-1')

    authState.me = {
      id: 'user-2',
      email: 'member@example.com',
      name: 'Member User',
      role: 'member',
    }
    teamsResult = []
    targetsResult = []
    view.rerender(
      <ProfileAccessProvider>
        <AccessProbe />
      </ProfileAccessProvider>
    )

    expect(screen.getByTestId('teams')).toHaveTextContent('no-teams')
    expect(screen.getByTestId('member-access')).toHaveTextContent('members-hidden')
    expect(screen.getByTestId('targets')).toHaveTextContent('no-targets')
  })
})
