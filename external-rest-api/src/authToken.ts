import jwt from 'jsonwebtoken'
import { config } from './config.js'
import { AuthClaims, TEAM_ROLES } from './types.js'

const ALLOWED_ROLES = new Set<AuthClaims['role']>(TEAM_ROLES)
const USER_SESSION_V2_AUDIENCE = 'evenfire-user-session'

function verifyUserSessionV2(token: string): AuthClaims | null {
  try {
    const payload = jwt.verify(token, config.jwtPublicKey, {
      algorithms: ['RS256'],
      issuer: config.jwtIssuer,
      audience: USER_SESSION_V2_AUDIENCE,
    }) as jwt.JwtPayload
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.sid !== 'string' ||
      typeof payload.jti !== 'string' ||
      !Number.isInteger(payload.sv) ||
      Number(payload.sv) < 1 ||
      payload.ver !== 2 ||
      payload.typ !== 'user_session' ||
      typeof payload.exp !== 'number' ||
      (payload.email !== undefined && typeof payload.email !== 'string') ||
      payload.teamId !== undefined ||
      payload.role !== undefined ||
      payload.memberships !== undefined ||
      payload.grants !== undefined ||
      payload.capabilities !== undefined
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
