import { config } from '../../config.js'
import type { K8sGateway } from '../../k8s.js'
import type { RpcAccessClaims } from '../../profileTypes.js'
import { getCurrentTeam, getTeamAgents, getUserAgents } from '../directory/index.js'

export type RpcHostAccessDenialReason =
  | 'subject_mismatch'
  | 'host_claim_missing'
  | 'team_membership_missing'
  | 'directory_grant_missing'
  | 'host_missing'
  | 'host_disabled'

export type RpcHostAccessDirectory = {
  getUserAgents: typeof getUserAgents
  getCurrentTeam: typeof getCurrentTeam
  getTeamAgents: typeof getTeamAgents
}

export type AuthorizedRpcHostAccess = {
  userId: string
  hostRef: string
  url: string
}

export type RpcHostAccessAuthorization =
  | { authorized: true; connection: AuthorizedRpcHostAccess }
  | { authorized: false; reason: RpcHostAccessDenialReason }

const defaultDirectory: RpcHostAccessDirectory = {
  getUserAgents,
  getCurrentTeam,
  getTeamAgents,
}

export async function authorizeRpcHostAccess(
  gateway: K8sGateway,
  claims: RpcAccessClaims,
  userId: string,
  hostRef: string,
  directory: RpcHostAccessDirectory = defaultDirectory,
  signal?: AbortSignal
): Promise<RpcHostAccessAuthorization> {
  signal?.throwIfAborted()
  if (claims.sub !== userId) {
    return { authorized: false, reason: 'subject_mismatch' }
  }
  if (!claims.hostRefs.includes(hostRef)) {
    return { authorized: false, reason: 'host_claim_missing' }
  }

  const userAgents = await directory.getUserAgents(userId)
  signal?.throwIfAborted()
  if (!userAgents.agentNames.includes(hostRef)) {
    if (!claims.teamId) {
      return { authorized: false, reason: 'directory_grant_missing' }
    }
    const activeTeam = await directory.getCurrentTeam(userId, claims.teamId)
    signal?.throwIfAborted()
    if (!activeTeam) {
      return { authorized: false, reason: 'team_membership_missing' }
    }
    const teamAgents = await directory.getTeamAgents(claims.teamId)
    signal?.throwIfAborted()
    if (!teamAgents.agentNames.includes(hostRef)) {
      return { authorized: false, reason: 'directory_grant_missing' }
    }
  }

  const hostList = signal
    ? gateway.listResource('hosts', config.hostsNamespace, signal)
    : gateway.listResource('hosts', config.hostsNamespace)
  const hosts = (await hostList) as Array<{
    metadata?: { name?: string }
    spec?: { enabled?: boolean }
  }>
  signal?.throwIfAborted()
  const host = hosts.find(candidate => candidate.metadata?.name === hostRef)
  if (!host) {
    return { authorized: false, reason: 'host_missing' }
  }
  if (host.spec?.enabled === false) {
    return { authorized: false, reason: 'host_disabled' }
  }

  return {
    authorized: true,
    connection: {
      userId,
      hostRef,
      url: `http://${hostRef}.${config.hostsNamespace}.svc.cluster.local:8080`,
    },
  }
}
