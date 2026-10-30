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

const DELETE_TEAM_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  team_not_empty:
    'This team still has active members. Remove every member from the team, then delete it.',
  team_has_audit_history:
    'This team cannot be deleted because workflow audit history references it, and audit history is retained.',
}

/** Maps the delete-team route's 409 codes to actionable copy; falls back to the error message. */
export function describeDeleteTeamError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  const known = typeof code === 'string' ? DELETE_TEAM_ERROR_MESSAGES[code] : undefined
  if (known) return known
  return err instanceof Error && err.message ? err.message : 'Failed to delete team'
}
