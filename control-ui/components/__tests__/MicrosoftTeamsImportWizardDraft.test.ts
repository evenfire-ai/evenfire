import { describe, expect, it } from 'vitest'
import {
  buildReviewTeams,
  createMemberDrafts,
  createTeamDrafts,
  reconcileMemberDrafts,
} from '../MicrosoftTeamsImportWizard/draft'
import type { MicrosoftDirectoryResponse } from '../MicrosoftTeamsImportWizard/types'

function directoryFixture(): MicrosoftDirectoryResponse {
  return {
    users: [
      {
        id: 'microsoft-user-1',
        displayName: 'Alex Example',
        email: 'alex@example.com',
        userPrincipalName: 'alex@example.com',
        accountEnabled: true,
        imported: false,
        invitationPending: false,
        microsoftTeamIds: ['microsoft-team-a', 'microsoft-team-b'],
        existingMemberId: null,
        existingMemberName: null,
      },
    ],
    teams: [
      {
        id: 'microsoft-team-a',
        displayName: 'Development A',
        description: '',
        importedTeamId: null,
        importedTeamName: null,
      },
      {
        id: 'microsoft-team-b',
        displayName: 'Development B',
        description: '',
        importedTeamId: null,
        importedTeamName: null,
      },
    ],
    evenfireTeams: [],
    agents: [],
    contexts: [],
    teamAgents: {},
    teamContexts: {},
  }
}

describe('Microsoft Teams import draft mapping', () => {
  it('collapses multiple Microsoft teams mapped to one Evenfire team', () => {
    const directory = directoryFixture()
    const teams = createTeamDrafts(directory).map((team, index) => ({
      ...team,
      name: 'Development',
      contextIds: [`context-${index + 1}`],
      agentNames: [`agent-${index + 1}`],
    }))

    const members = createMemberDrafts(directory, teams)
    const review = buildReviewTeams(directory, teams, members)

    expect(members[0]?.teamRefs).toHaveLength(1)
    expect(review).toHaveLength(1)
    expect(review[0]?.name).toBe('Development')
    expect(review[0]?.members.map(member => member.email)).toEqual(['alex@example.com'])
    expect(review[0]?.contextIds).toEqual(['context-1', 'context-2'])
    expect(review[0]?.agentNames).toEqual(['agent-1', 'agent-2'])
  })

  it('keeps selected users valid when every Microsoft team is unchecked', () => {
    const directory = directoryFixture()
    const teams = createTeamDrafts(directory).map(team => ({ ...team, selected: false }))

    const members = createMemberDrafts(directory, teams)
    const review = buildReviewTeams(directory, teams, members)

    expect(members[0]?.teamRefs).toEqual([])
    expect(review).toHaveLength(1)
    expect(review[0]?.name).toBe('NO TEAM')
    expect(review[0]?.members).toHaveLength(1)
  })

  it('recalculates default mappings without overwriting explicit member choices', () => {
    const directory = directoryFixture()
    const initialTeams = createTeamDrafts(directory)
    const initialMembers = createMemberDrafts(directory, initialTeams)
    const remappedTeams = initialTeams.map(team => ({ ...team, name: 'Engineering' }))

    const recalculated = reconcileMemberDrafts(directory, remappedTeams, initialMembers)
    const customized = reconcileMemberDrafts(directory, remappedTeams, [
      { ...initialMembers[0]!, teamRefs: [], teamSelectionCustomized: true },
    ])

    expect(recalculated[0]?.teamRefs).toHaveLength(1)
    expect(customized[0]?.teamRefs).toEqual([])
  })
})
