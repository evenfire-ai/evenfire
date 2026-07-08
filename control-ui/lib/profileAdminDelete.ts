import type { TeamListItem, TeamSummary } from './api'

export type DeleteCandidateTeam = Pick<TeamListItem, 'id' | 'name'>

export function getSoloMemberTeamsForUser(
  userTeams: readonly TeamSummary[],
  teams: readonly TeamListItem[]
): DeleteCandidateTeam[] {
  const memberCountByTeamId = new Map(teams.map(team => [team.id, team.memberCount]))
  return userTeams
    .filter(team => memberCountByTeamId.get(team.id) === 1)
    .map(team => ({ id: team.id, name: team.name }))
}

export function formatTeamNames(teams: readonly DeleteCandidateTeam[]): string {
  return teams.map(team => team.name).join(', ')
}
