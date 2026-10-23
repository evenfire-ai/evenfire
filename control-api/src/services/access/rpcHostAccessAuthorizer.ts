import { config } from '../../config.js'
import type { K8sGateway } from '../../k8s.js'
import type { RpcAccessClaims } from '../../profileTypes.js'
import { getCurrentTeam, getTeamAgents, getUserAgents } from '../directory/index.js'
import { extractK8sStatus } from '../resourceServiceHelpers.js'

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

/**
 * The Host directory could not be read from the cluster. A Kubernetes 404 on
 * the namespaced Host listing means the configured namespace or the Host CRD is
 * absent: an operational dependency failure, not a caller-visible "not found"
 * for this RPC path. It must stay 5xx, because rpc-proxy maps any 404 here to a
 * peer version mismatch and that verdict would hide a broken deployment.
 */
export class HostDirectoryUnavailableError extends Error {
  readonly httpStatus = 500

  constructor(cause: unknown) {
    super('Host directory could not be read', { cause })
    this.name = 'HostDirectoryUnavailableError'
  }
}

async function listHostDirectory(gateway: K8sGateway): Promise<unknown[]> {
  try {
    return await gateway.listResource('hosts', config.hostsNamespace)
  } catch (error) {
    if (extractK8sStatus(error) === 404) {
      throw new HostDirectoryUnavailableError(error)
    }
    throw error
  }
}

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
  directory: RpcHostAccessDirectory = defaultDirectory
): Promise<RpcHostAccessAuthorization> {
  if (claims.sub !== userId) {
    return { authorized: false, reason: 'subject_mismatch' }
  }
  if (!claims.hostRefs.includes(hostRef)) {
    return { authorized: false, reason: 'host_claim_missing' }
  }

  const userAgents = await directory.getUserAgents(userId)
  if (!userAgents.agentNames.includes(hostRef)) {
    if (!claims.teamId) {
      return { authorized: false, reason: 'directory_grant_missing' }
    }
    const activeTeam = await directory.getCurrentTeam(userId, claims.teamId)
    if (!activeTeam) {
      return { authorized: false, reason: 'team_membership_missing' }
    }
    const teamAgents = await directory.getTeamAgents(claims.teamId)
    if (!teamAgents.agentNames.includes(hostRef)) {
      return { authorized: false, reason: 'directory_grant_missing' }
    }
  }

  const hosts = (await listHostDirectory(gateway)) as Array<{
    metadata?: { name?: string }
    spec?: { enabled?: boolean }
  }>
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
