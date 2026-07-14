import jwt from 'jsonwebtoken'
import { config } from './config.js'
import { AuthClaims, TEAM_ROLES } from './types.js'

const ALLOWED_ROLES = new Set<AuthClaims['role']>(TEAM_ROLES)

export function verifyToken(token: string): AuthClaims | null {
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
