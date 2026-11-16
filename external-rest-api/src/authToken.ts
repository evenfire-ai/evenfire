import jwt from 'jsonwebtoken'
import { config } from './config.js'
import { AuthClaims, TEAM_ROLES } from './types.js'

const ALLOWED_ROLES = new Set<AuthClaims['role']>(TEAM_ROLES)
const USER_SESSION_V2_AUDIENCE = 'evenfire-user-session'
const USER_SESSION_V2_TTL_SECONDS = 60 * 60
const USER_SESSION_V2_CLOCK_TOLERANCE_SECONDS = 5
const FORBIDDEN_USER_SESSION_AUTHORITY_CLAIMS = [
  'teamId',
  'role',
  'memberships',
  'grants',
  'resources',
  'budgets',
  'credentials',
  'policies',
  'capabilities',
  'filesystemScope',
  'runtime',
  'providerPolicy',
  'modelPolicy',
  'auditOwner',
] as const

function verifyUserSessionV2(token: string): AuthClaims | null {
  try {
    const payload = jwt.verify(token, config.jwtPublicKey, {
      algorithms: ['RS256'],
      issuer: config.jwtIssuer,
      audience: USER_SESSION_V2_AUDIENCE,
      clockTolerance: USER_SESSION_V2_CLOCK_TOLERANCE_SECONDS,
    }) as jwt.JwtPayload
    const now = Math.floor(Date.now() / 1000)
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.sid !== 'string' ||
      typeof payload.jti !== 'string' ||
      !Number.isInteger(payload.sv) ||
      Number(payload.sv) < 1 ||
      payload.ver !== 2 ||
      payload.typ !== 'user_session' ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      payload.exp - payload.iat !== USER_SESSION_V2_TTL_SECONDS ||
      payload.iat > now + USER_SESSION_V2_CLOCK_TOLERANCE_SECONDS ||
      typeof payload.auth_time !== 'number' ||
      payload.auth_time > now + USER_SESSION_V2_CLOCK_TOLERANCE_SECONDS ||
      !Array.isArray(payload.amr) ||
      !payload.amr.every(method => typeof method === 'string' && Boolean(method.trim())) ||
      (payload.email !== undefined && typeof payload.email !== 'string') ||
      FORBIDDEN_USER_SESSION_AUTHORITY_CLAIMS.some(claim => payload[claim] !== undefined)
    ) {
      return null
    }
    return {
      userId: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : '',
      teamId: '',
      role: 'member',
      exp: payload.exp,
      sessionContract: 'v2',
      sid: payload.sid,
      jti: payload.jti,
      sv: Number(payload.sv),
      ver: 2,
    }
  } catch {
    return null
  }
}

export function verifyToken(token: string): AuthClaims | null {
  const v2 = verifyUserSessionV2(token)
  if (v2) return v2
  try {
    const payload = jwt.verify(token, config.jwtPublicKey, {
      algorithms: ['RS256'],
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    }) as jwt.JwtPayload & Omit<AuthClaims, 'exp'>

    const teamId = payload?.teamId
    if (
      typeof payload?.userId !== 'string' ||
      typeof payload?.email !== 'string' ||
      (teamId !== null && typeof teamId !== 'string') ||
      typeof payload?.role !== 'string' ||
      typeof payload?.exp !== 'number'
    ) {
      return null
    }
    if (!ALLOWED_ROLES.has(payload.role as AuthClaims['role'])) {
      return null
    }

    return {
      userId: payload.userId,
      email: payload.email,
      // Teamless invitation sessions use null in the signed JWT. Keep the
      // AuthClaims contract as string by exposing "" as the no-team sentinel
      // for existing callers that require an explicit team id.
      teamId: teamId || '',
      role: payload.role as AuthClaims['role'],
      exp: payload.exp,
    }
  } catch {
    return null
  }
}
