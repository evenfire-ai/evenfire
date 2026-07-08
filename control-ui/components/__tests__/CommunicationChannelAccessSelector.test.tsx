import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getAgentTeams, getAgentUsers } from '../../lib/api'
import { CommunicationChannelAccessSelector } from '../CommunicationChannelAccessSelector'

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    getAgentTeams: vi.fn(),
    getAgentUsers: vi.fn(),
  }
})

describe('CommunicationChannelAccessSelector', () => {
  beforeEach(() => {
    vi.mocked(getAgentUsers).mockResolvedValue({
      items: [
        {
          id: 'user-1',
          email: 'admin@example.com',
          name: 'Admin User',
          displayName: 'Admin',
        },
      ],
    })
    vi.mocked(getAgentTeams).mockResolvedValue({
      items: [{ id: 'team-1', name: 'Operations' }],
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('keeps member and team options closed until their tab dropdown opens', async () => {
    const onUsersChange = vi.fn()
    const onTeamsChange = vi.fn()

    render(
      <CommunicationChannelAccessSelector
        agentName="chatllm"
        selectedUserIds={['user-1']}
        selectedTeamIds={[]}
        onSelectedUserIdsChange={onUsersChange}
        onSelectedTeamIdsChange={onTeamsChange}
      />
    )

    await waitFor(() => expect(screen.getByLabelText('Members')).toBeEnabled())
    expect(screen.queryByRole('option', { name: 'Admin' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Selected members')).toHaveTextContent('Admin')

    fireEvent.click(screen.getByLabelText('Members'))
    expect(screen.getByRole('option', { name: 'Admin' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Teams (0)' }))
    expect(screen.queryByRole('option', { name: 'Operations' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Teams'))
    fireEvent.click(screen.getByRole('option', { name: 'Operations' }))

    expect(onTeamsChange).toHaveBeenCalledWith(['team-1'])
    expect(onUsersChange).not.toHaveBeenCalled()
  })

  it('can render access options inline for constrained create/edit flows', async () => {
    render(
      <CommunicationChannelAccessSelector
        agentName="chatllm"
        inlineDropdowns
        selectedUserIds={[]}
        selectedTeamIds={[]}
        onSelectedUserIdsChange={vi.fn()}
        onSelectedTeamIdsChange={vi.fn()}
      />
    )

    expect(await screen.findByRole('option', { name: 'Admin' })).toBeInTheDocument()
  })
})
