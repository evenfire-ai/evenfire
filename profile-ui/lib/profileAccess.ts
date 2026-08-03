import type { ApprovalChannelTarget } from '../app/types/approvalChannels'
import type { ManageableTeam } from '../app/types/profile'
import { getManageableTeams } from './api'
import { listApprovalChannelTargets } from './approvalChannels'

type ProfileAccessCacheEntry = {
  approvalTargets?: ApprovalChannelTarget[]
  approvalTargetsRequest?: Promise<ApprovalChannelTarget[]>
  manageableTeams?: ManageableTeam[]
  manageableTeamsRequest?: Promise<ManageableTeam[]>
}

const accessCache = new Map<string, ProfileAccessCacheEntry>()

function entryFor(userId: string): ProfileAccessCacheEntry {
  const cached = accessCache.get(userId)
  if (cached) return cached
  const next: ProfileAccessCacheEntry = {}
  accessCache.set(userId, next)
  return next
}

export function readProfileAccessCache(userId: string): {
  approvalTargets?: ApprovalChannelTarget[]
  manageableTeams?: ManageableTeam[]
} {
  const cached = accessCache.get(userId)
  return {
    approvalTargets: cached?.approvalTargets,
    manageableTeams: cached?.manageableTeams,
  }
}

export function requestManageableTeams(
  userId: string,
  options: { force?: boolean } = {}
): Promise<ManageableTeam[]> {
  const cached = entryFor(userId)
  if (!options.force && cached.manageableTeams) return Promise.resolve(cached.manageableTeams)
  if (cached.manageableTeamsRequest) return cached.manageableTeamsRequest

  const request = getManageableTeams()
    .then(response => {
      const teams = Array.isArray(response.items) ? response.items : []
      cached.manageableTeams = teams
      return teams
    })
    .finally(() => {
      delete cached.manageableTeamsRequest
    })
  cached.manageableTeamsRequest = request
  return request
}

export function requestApprovalTargets(
  userId: string,
  options: { force?: boolean } = {}
): Promise<ApprovalChannelTarget[]> {
  const cached = entryFor(userId)
  if (!options.force && cached.approvalTargets) return Promise.resolve(cached.approvalTargets)
  if (cached.approvalTargetsRequest) return cached.approvalTargetsRequest

  const request = listApprovalChannelTargets()
    .then(targets => {
      cached.approvalTargets = targets
      return targets
    })
    .finally(() => {
      delete cached.approvalTargetsRequest
    })
  cached.approvalTargetsRequest = request
  return request
}

export function resetProfileAccessCache(userId?: string): void {
  if (userId) {
    accessCache.delete(userId)
    return
  }
  accessCache.clear()
}
