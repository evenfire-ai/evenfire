import type { RpcAccessClaims } from './types.js'

export function rpcInvocationContext(claims: Pick<RpcAccessClaims, 'accessScope' | 'teamId'>): {
  accessScope: 'team' | 'user'
  teamId?: string
} {
  switch (claims.accessScope) {
    case 'team':
      if (!claims.teamId) {
        throw new Error('Team-scoped RPC tokens require a team id')
      }
      return { accessScope: 'team', teamId: claims.teamId }
    case 'user':
      return { accessScope: 'user' }
    case 'service':
      throw new Error('Service-scoped RPC tokens cannot invoke user RPC routes')
    default: {
      const _exhaustive: never = claims.accessScope
      throw new Error(`Unsupported RPC access scope: ${String(_exhaustive)}`)
    }
  }
}
