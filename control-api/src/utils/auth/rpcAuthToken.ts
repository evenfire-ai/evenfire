import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import { config } from '../../config.js'
import {
  RPC_SCOPES,
  RpcAccessClaims,
  RpcAccessScope,
  RpcScope,
  TEAM_ROLES,
  TeamRole,
} from '../../profileTypes.js'

const ALLOWED_RPC_SCOPES = new Set<RpcScope>(RPC_SCOPES)
const ALLOWED_TEAM_ROLES = new Set<TeamRole>(TEAM_ROLES)
const TEAM_ONLY_RPC_SCOPES = new Set<RpcScope>(['desktop:view'])

/**
 * Reserved synthetic host reference for sandbox UI RPC tokens.
 *
 * This value is a capability discriminator, not an agent or MCP host name.
 * Requests must pair it exclusively with `sandbox:ui:view`; mixing it with
 * agent host references would let one token cross authorization domains.
 */
export const SANDBOX_UI_RPC_HOST_REF = 'sandbox-ui'

function defaultScopesForRole(role: TeamRole): RpcScope[] {
  if (role === 'admin' || role === 'inviter' || role === 'member') {
    return [
      'mcp:servers:list',
      'mcp:server:invoke',
      'host:health:read',
      'host:status:read',
      'host:activity:read',
      'host:message:invoke',
      'host:wake:write',
      'host:task:read',
      'host:approval:write',
      'host:session:read',
      'desktop:view',
    ]
  }
  return ['mcp:servers:list']
}

export function normalizeRequestedScopes(input: unknown): RpcScope[] {
  if (!Array.isArray(input)) return []
  const deduped = new Set<RpcScope>()
  for (const value of input) {
    if (typeof value !== 'string') continue
    const scope = value.trim() as RpcScope
    if (ALLOWED_RPC_SCOPES.has(scope)) {
      deduped.add(scope)
    }
  }
  return [...deduped]
}

function resolveRpcTokenTtlSeconds(ttlSeconds?: number): number {
  if (!Number.isFinite(ttlSeconds) || !ttlSeconds || ttlSeconds <= 0) {
    return config.rpcTokenTtlSeconds
  }
  return Math.floor(ttlSeconds)
}

function filterScopesForAccessScope(scopes: RpcScope[], accessScope: 'team' | 'user'): RpcScope[] {
  if (accessScope === 'team') return scopes
  return scopes.filter(scope => !TEAM_ONLY_RPC_SCOPES.has(scope))
}

export function signRpcAccessToken(
  claims: Omit<RpcAccessClaims, 'accessScope' | 'exp' | 'iat'> & {
    accessScope?: RpcAccessScope
  },
  options?: { ttlSeconds?: number }
): string {
  const ttlSeconds = resolveRpcTokenTtlSeconds(options?.ttlSeconds)
  return jwt.sign(claims, config.rpcJwtPrivateKey, {
    algorithm: 'RS256',
    expiresIn: ttlSeconds,
    issuer: config.rpcJwtIssuer,
    audience: config.rpcJwtAudience,
  })
}

export function verifyRpcAccessToken(token: string): RpcAccessClaims | null {
  try {
    const payload = jwt.verify(token, config.rpcJwtPublicKey, {
      algorithms: ['RS256'],
      issuer: config.rpcJwtIssuer,
      audience: config.rpcJwtAudience,
    }) as jwt.JwtPayload

    if (
      typeof payload?.sub !== 'string' ||
      (payload?.typ !== 'user' && payload?.typ !== 'service') ||
      !Array.isArray(payload?.scopes) ||
      !Array.isArray(payload?.hostRefs) ||
      typeof payload?.jti !== 'string' ||
      typeof payload?.iat !== 'number' ||
      typeof payload?.exp !== 'number'
    ) {
      return null
    }

    const rawTeamId = payload.teamId
    const rawAccessScope = payload.accessScope
    let accessScope: RpcAccessScope
    let teamId: string | null
    if (payload.typ === 'service') {
      if (
        (rawAccessScope !== undefined && rawAccessScope !== 'service') ||
        typeof rawTeamId !== 'string' ||
        !rawTeamId.trim()
      ) {
        return null
      }
      accessScope = 'service'
      teamId = rawTeamId.trim()
    } else if (rawAccessScope === 'user') {
      if (rawTeamId !== null) return null
      accessScope = 'user'
      teamId = null
    } else if (rawAccessScope === 'team' || rawAccessScope === undefined) {
      if (typeof rawTeamId !== 'string' || !rawTeamId.trim()) return null
      accessScope = 'team'
      teamId = rawTeamId.trim()
    } else {
      return null
    }

    const scopes = payload.scopes.filter((entry): entry is RpcScope => {
      return typeof entry === 'string' && ALLOWED_RPC_SCOPES.has(entry as RpcScope)
    })
    if (scopes.length === 0) {
      return null
    }

    const hostRefs = normalizeRequestedHostRefs(payload.hostRefs)
    if (hostRefs.length === 0) {
      return null
    }

    return {
      sub: payload.sub,
      typ: payload.typ,
      accessScope,
      teamId,
      scopes,
      hostRefs,
      jti: payload.jti,
      iat: payload.iat,
      exp: payload.exp,
      ...(typeof payload.service === 'string' ? { service: payload.service } : {}),
      ...(typeof payload.role === 'string' && ALLOWED_TEAM_ROLES.has(payload.role as TeamRole)
        ? { role: payload.role as TeamRole }
        : {}),
    }
  } catch {
    return null
  }
}

export function normalizeRequestedHostRefs(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const refs: string[] = []
  for (const value of input) {
    if (typeof value !== 'string') return []
    const ref = value.trim()
    if (!ref || ref === '*') return []
    refs.push(ref)
  }
  return Array.from(new Set(refs))
}

export function issueRpcAccessToken(
  auth: { userId: string; teamId: string | null; role: TeamRole },
  requestedScopesInput: unknown,
  requestedHostRefsInput?: unknown,
  extraGrantedScopes: readonly RpcScope[] = []
): {
  token: string
  accessScope: 'team' | 'user'
  teamId: string | null
  scopes: RpcScope[]
  hostRefs: string[]
  expiresInSeconds: number
  droppedScopes?: RpcScope[]
} | null {
  // Role-based defaults plus dynamically-resolved grants (e.g. `sandbox:ui:view`
  // when the user appears in `user_workflow_triggers` for a UI-bearing
  // recipe — checked once at issuance, not encoded by role).
  const permitted = new Set<RpcScope>([...defaultScopesForRole(auth.role), ...extraGrantedScopes])
  const requested = normalizeRequestedScopes(requestedScopesInput)
  const hostRefs = normalizeRequestedHostRefs(requestedHostRefsInput)

  const userId = auth.userId.trim()
  if (!userId) return null
  const teamId = auth.teamId?.trim() || null
  const accessScope = teamId ? 'team' : 'user'
  const permittedRequestedScopes =
    requested.length > 0 ? requested.filter(scope => permitted.has(scope)) : [...permitted]
  const scopes = filterScopesForAccessScope(permittedRequestedScopes, accessScope)

  // Compute requested scopes that were not granted by role or access-scope boundary.
  const droppedScopes =
    requested.length > 0
      ? requested.filter(scope => !permitted.has(scope) || !scopes.includes(scope))
      : []

  if (scopes.length === 0 || hostRefs.length === 0) {
    return null
  }

  const token = signRpcAccessToken({
    sub: userId,
    typ: 'user',
    accessScope,
    teamId,
    role: auth.role,
    hostRefs,
    jti: randomUUID(),
    scopes,
  })

  const result: {
    token: string
    accessScope: 'team' | 'user'
    teamId: string | null
    scopes: RpcScope[]
    hostRefs: string[]
    expiresInSeconds: number
    droppedScopes?: RpcScope[]
  } = {
    token,
    accessScope,
    teamId,
    scopes,
    hostRefs,
    expiresInSeconds: config.rpcTokenTtlSeconds,
  }

  if (droppedScopes.length > 0) {
    result.droppedScopes = droppedScopes
  }

  return result
}

export type RpcTokenDenialReason = 'desktop_requires_team' | 'no_permitted_scopes'

/**
 * Explains why {@link issueRpcAccessToken} returned null for a scope request so
 * callers can surface a specific, actionable error instead of a blanket 403.
 *
 * Meaningful only on a real denial (issuance returned null) where hostRefs were
 * already non-empty — i.e. the denial was scope-related. Mirrors the scope
 * filtering in issueRpcAccessToken (role defaults + dynamic grants, then
 * access-scope narrowing); keep the two in sync.
 */
export function classifyRpcTokenDenial(
  auth: { userId: string; teamId: string | null; role: TeamRole },
  requestedScopesInput: unknown,
  extraGrantedScopes: readonly RpcScope[] = []
): RpcTokenDenialReason {
  const permitted = new Set<RpcScope>([...defaultScopesForRole(auth.role), ...extraGrantedScopes])
  const requested = normalizeRequestedScopes(requestedScopesInput)
  const permittedRequested =
    requested.length > 0 ? requested.filter(scope => permitted.has(scope)) : [...permitted]
  const accessScope: 'team' | 'user' = auth.teamId?.trim() ? 'team' : 'user'
  // A teamless (user-scoped) caller whose only otherwise-permitted scopes are
  // team-only (e.g. desktop:view) is denied solely for lack of a team — say so
  // instead of a generic failure, so the desktop app can prompt accordingly.
  if (
    accessScope === 'user' &&
    permittedRequested.length > 0 &&
    filterScopesForAccessScope(permittedRequested, 'user').length === 0
  ) {
    return 'desktop_requires_team'
  }
  return 'no_permitted_scopes'
}

export function issueRpcServiceAccessToken(input: {
  service: string
  scopes: RpcScope[]
  hostRefs: string[]
  subject?: string
  teamId?: string
  ttlSeconds?: number
}): {
  token: string
  scopes: RpcScope[]
  hostRefs: string[]
  expiresInSeconds: number
} | null {
  const service = input.service.trim()
  if (!service) return null

  const scopes = normalizeRequestedScopes(input.scopes)
  if (scopes.length !== input.scopes.length) return null

  const hostRefs = normalizeRequestedHostRefs(input.hostRefs)
  if (hostRefs.length !== input.hostRefs.length || hostRefs.length === 0) return null

  const ttlSeconds = resolveRpcTokenTtlSeconds(input.ttlSeconds)
  const token = signRpcAccessToken(
    {
      sub: input.subject?.trim() || `${service}/${hostRefs[0]}`,
      typ: 'service',
      accessScope: 'service',
      teamId: input.teamId?.trim() || 'system',
      service,
      hostRefs,
      jti: randomUUID(),
      scopes,
    },
    { ttlSeconds }
  )

  return {
    token,
    scopes,
    hostRefs,
    expiresInSeconds: ttlSeconds,
  }
}
