export type TeamRole = 'admin' | 'inviter' | 'member'
export const TEAM_ROLES: TeamRole[] = ['admin', 'inviter', 'member']

export type RpcScope =
  | 'mcp:servers:list'
  | 'mcp:server:invoke'
  | 'host:health:read'
  | 'host:status:read'
  | 'host:activity:read'
  | 'host:message:invoke'
  | 'host:workflow-approval:decide'
  | 'host:task:read'
  | 'host:approval:write'
  | 'host:session:read'
  | 'host:cron:read'
  | 'host:cron:ack'
  | 'desktop:view'
  | 'sandbox:ui:view'
export const RPC_SCOPES: RpcScope[] = [
  'mcp:servers:list',
  'mcp:server:invoke',
  'host:health:read',
  'host:status:read',
  'host:activity:read',
  'host:message:invoke',
  'host:workflow-approval:decide',
  'host:task:read',
  'host:approval:write',
  'host:session:read',
  'host:cron:read',
  'host:cron:ack',
  'desktop:view',
  'sandbox:ui:view',
]
export type RpcTokenType = 'service' | 'user'
export type RpcAccessScope = 'service' | 'team' | 'user'

export type AuthClaims = {
  userId: string
  email: string
  teamId: string | null
  role: TeamRole
  exp: number
}

export type RpcAccessClaims = {
  sub: string
  typ: RpcTokenType
  accessScope: RpcAccessScope
  teamId: string | null
  scopes: RpcScope[]
  hostRefs: string[]
  jti: string
  iat: number
  exp: number
  service?: string
  role?: TeamRole
}
