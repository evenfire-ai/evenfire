import { describe, expect, it, vi } from 'vitest'
import type { K8sGateway } from '../src/k8s.js'
import type { RpcAccessClaims } from '../src/profileTypes.js'
import { authorizeRpcHostAccess } from '../src/services/access/rpcHostAccessAuthorizer.js'

const CLAIMS: RpcAccessClaims = {
  sub: 'user-1',
  typ: 'user',
  accessScope: 'team',
  teamId: 'team-1',
  scopes: ['host:message:invoke'],
  hostRefs: ['host-a'],
  jti: 'jti-1',
  iat: 1,
  exp: 9999999999,
  role: 'member',
}

function dependencies(
  options: {
    userAgents?: string[]
    teamAgents?: string[]
    activeTeam?: boolean
    hosts?: Array<{ metadata: { name: string }; spec?: { enabled?: boolean } }>
  } = {}
) {
  const gateway = {
    listResource: vi.fn(async () =>
      options.hosts === undefined
        ? [{ metadata: { name: 'host-a' }, spec: { enabled: true } }]
        : options.hosts
    ),
  } as unknown as K8sGateway
  const directory = {
    getUserAgents: vi.fn(async (userId: string) => ({
      userId,
      agentNames: options.userAgents ?? ['host-a'],
    })),
    getCurrentTeam: vi.fn(async (userId: string, teamId: string) =>
      options.activeTeam === false ? null : { id: teamId, name: 'Team', role: 'member', userId }
    ),
    getTeamAgents: vi.fn(async (teamId: string) => ({
      teamId,
      agentNames: options.teamAgents ?? [],
    })),
  }
  return { gateway, directory }
}

describe('authorizeRpcHostAccess', () => {
  it('returns a typed subject mismatch before directory or Kubernetes access', async () => {
    const { gateway, directory } = dependencies()
    await expect(
      authorizeRpcHostAccess(gateway, CLAIMS, 'different-user', 'host-a', directory)
    ).resolves.toEqual({ authorized: false, reason: 'subject_mismatch' })
    expect(directory.getUserAgents).not.toHaveBeenCalled()
    expect(gateway.listResource).not.toHaveBeenCalled()
  })

  it('returns a typed missing-claim reason before directory access', async () => {
    const { gateway, directory } = dependencies()
    await expect(
      authorizeRpcHostAccess(gateway, { ...CLAIMS, hostRefs: [] }, 'user-1', 'host-a', directory)
    ).resolves.toEqual({ authorized: false, reason: 'host_claim_missing' })
    expect(directory.getUserAgents).not.toHaveBeenCalled()
  })

  it('returns a typed directory denial and skips Kubernetes', async () => {
    const { gateway, directory } = dependencies({ userAgents: [], teamAgents: [] })
    await expect(
      authorizeRpcHostAccess(gateway, CLAIMS, 'user-1', 'host-a', directory)
    ).resolves.toEqual({ authorized: false, reason: 'directory_grant_missing' })
    expect(gateway.listResource).not.toHaveBeenCalled()
  })

  it('rejects a stale team claim when the user is no longer an active member', async () => {
    const { gateway, directory } = dependencies({
      userAgents: [],
      teamAgents: ['host-a'],
      activeTeam: false,
    })
    await expect(
      authorizeRpcHostAccess(gateway, CLAIMS, 'user-1', 'host-a', directory)
    ).resolves.toEqual({ authorized: false, reason: 'team_membership_missing' })
    expect(directory.getTeamAgents).not.toHaveBeenCalled()
    expect(gateway.listResource).not.toHaveBeenCalled()
  })

  it.each([
    [[], 'host_missing'],
    [[{ metadata: { name: 'host-a' }, spec: { enabled: false } }], 'host_disabled'],
  ] as const)('returns a typed Host denial for %s', async (hosts, reason) => {
    const { gateway, directory } = dependencies({ hosts: [...hosts] })
    await expect(
      authorizeRpcHostAccess(gateway, CLAIMS, 'user-1', 'host-a', directory)
    ).resolves.toEqual({ authorized: false, reason })
  })
})
