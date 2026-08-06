import type {
  MicrosoftDirectoryResponse,
  MicrosoftSetupMemberDraft,
  MicrosoftSetupTeamDraft,
  ReviewTeam,
} from './types'

function normalizedName(value: string): string {
  return value.trim().toLowerCase()
}

function destinationKey(team: MicrosoftSetupTeamDraft): string {
  return team.existingTeamId || normalizedName(team.name)
}

export function createTeamDrafts(directory: MicrosoftDirectoryResponse): MicrosoftSetupTeamDraft[] {
  return directory.teams.map(team => ({
    id: `microsoft:${team.id}`,
    selected: true,
    manual: false,
    externalTeamId: team.id,
    externalTeamName: team.displayName,
    existingTeamId: team.importedTeamId,
    name: team.importedTeamName || team.displayName,
    contextIds: team.importedTeamId ? directory.teamContexts[team.importedTeamId] || [] : [],
    agentNames: team.importedTeamId ? directory.teamAgents[team.importedTeamId] || [] : [],
  }))
}

export function createMemberDrafts(
  directory: MicrosoftDirectoryResponse,
  teams: MicrosoftSetupTeamDraft[]
): MicrosoftSetupMemberDraft[] {
  const canonicalTeamRefByDestination = new Map<string, string>()
  const teamRefByMicrosoftId = new Map<string, string>()
  for (const team of teams.filter(item => item.selected)) {
    const key = destinationKey(team)
    const canonical = team.existingTeamId || canonicalTeamRefByDestination.get(key) || team.id
    canonicalTeamRefByDestination.set(key, canonical)
    if (team.externalTeamId) teamRefByMicrosoftId.set(team.externalTeamId, canonical)
  }

  return directory.users
    .filter(user => user.accountEnabled)
    .map(user => ({
      externalSubject: user.id,
      selected: true,
      microsoftDisplayName: user.displayName,
      displayName: user.existingMemberName || user.displayName,
      email: user.email,
      userPrincipalName: user.userPrincipalName,
      teamRefs: Array.from(
        new Set(
          user.microsoftTeamIds
            .map(teamId => teamRefByMicrosoftId.get(teamId) || '')
            .filter(Boolean)
        )
      ),
      teamSelectionCustomized: false,
      existingMemberId: user.existingMemberId,
    }))
}

export function reconcileMemberDrafts(
  directory: MicrosoftDirectoryResponse,
  teams: MicrosoftSetupTeamDraft[],
  members: MicrosoftSetupMemberDraft[]
): MicrosoftSetupMemberDraft[] {
  const defaults = createMemberDrafts(directory, teams)
  const existingBySubject = new Map(members.map(member => [member.externalSubject, member]))
  const validTeamRefs = new Set(teamSelectionOptions(directory, teams).map(option => option.value))

  return defaults.map(defaultMember => {
    const existing = existingBySubject.get(defaultMember.externalSubject)
    if (!existing) return defaultMember
    return {
      ...defaultMember,
      ...existing,
      teamRefs: existing.teamSelectionCustomized
        ? existing.teamRefs.filter(teamRef => validTeamRefs.has(teamRef))
        : defaultMember.teamRefs,
    }
  })
}

export function teamSelectionOptions(
  directory: MicrosoftDirectoryResponse,
  teams: MicrosoftSetupTeamDraft[]
): Array<{ value: string; label: string; description?: string }> {
  const options = new Map<string, { value: string; label: string; description?: string }>()
  for (const team of directory.evenfireTeams) {
    options.set(team.id, {
      value: team.id,
      label: team.name,
      description: 'Existing Evenfire team',
    })
  }
  for (const team of teams.filter(item => item.selected && item.name.trim())) {
    const key = destinationKey(team)
    if (options.has(key)) continue
    options.set(key, {
      value: team.id,
      label: team.name.trim(),
      description: team.existingTeamId ? 'Existing Evenfire team' : 'Will be created',
    })
  }
  return Array.from(options.values()).sort((left, right) => left.label.localeCompare(right.label))
}

export function buildReviewTeams(
  directory: MicrosoftDirectoryResponse,
  teams: MicrosoftSetupTeamDraft[],
  members: MicrosoftSetupMemberDraft[]
): ReviewTeam[] {
  const existingIds = new Set(directory.evenfireTeams.map(team => team.id))
  const reviewByDestination = new Map<string, ReviewTeam>()
  const teamRefToDestination = new Map<string, string>()

  for (const team of teams.filter(item => item.selected && item.name.trim())) {
    const key = destinationKey(team)
    teamRefToDestination.set(team.id, key)
    teamRefToDestination.set(key, key)
    const existingReview = reviewByDestination.get(key)
    if (existingReview) {
      existingReview.contextIds = Array.from(
        new Set([...existingReview.contextIds, ...team.contextIds])
      )
      existingReview.agentNames = Array.from(
        new Set([...existingReview.agentNames, ...team.agentNames])
      )
    } else {
      reviewByDestination.set(key, {
        key,
        name: team.name.trim(),
        existing: Boolean(team.existingTeamId && existingIds.has(team.existingTeamId)),
        contextIds: team.contextIds,
        agentNames: team.agentNames,
        members: [],
      })
    }
  }
  for (const existing of directory.evenfireTeams) {
    teamRefToDestination.set(existing.id, existing.id)
  }

  const teamless: MicrosoftSetupMemberDraft[] = []
  for (const member of members.filter(item => item.selected)) {
    const destinations = Array.from(
      new Set(member.teamRefs.map(ref => teamRefToDestination.get(ref) || ref).filter(Boolean))
    )
    if (destinations.length === 0) {
      teamless.push(member)
      continue
    }
    for (const destination of destinations) {
      let review = reviewByDestination.get(destination)
      if (!review) {
        const existing = directory.evenfireTeams.find(team => team.id === destination)
        if (!existing) continue
        review = {
          key: existing.id,
          name: existing.name,
          existing: true,
          contextIds: directory.teamContexts[existing.id] || [],
          agentNames: directory.teamAgents[existing.id] || [],
          members: [],
        }
        reviewByDestination.set(destination, review)
      }
      review.members.push(member)
    }
  }

  const result = Array.from(reviewByDestination.values()).sort((left, right) =>
    left.name.localeCompare(right.name)
  )
  if (teamless.length > 0) {
    result.push({
      key: 'no-team',
      name: 'NO TEAM',
      existing: false,
      contextIds: [],
      agentNames: [],
      members: teamless,
    })
  }
  return result
}

export function duplicateManualTeamIds(teams: MicrosoftSetupTeamDraft[]): ReadonlySet<string> {
  const idsByName = new Map<string, string[]>()
  const manualIds = new Set(teams.filter(team => team.manual).map(team => team.id))
  for (const team of teams) {
    if (!team.selected || !team.name.trim()) continue
    const name = normalizedName(team.name)
    idsByName.set(name, [...(idsByName.get(name) || []), team.id])
  }
  return new Set(
    Array.from(idsByName.values())
      .filter(ids => ids.length > 1)
      .flatMap(ids => ids.filter(id => manualIds.has(id)))
  )
}
