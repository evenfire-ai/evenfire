import jwt from 'jsonwebtoken'
import { createPublicKey } from 'node:crypto'
import { config } from '../../config.js'
import { AuthClaims, TEAM_ROLES } from '../../profileTypes.js'

const ALLOWED_ROLES = new Set<AuthClaims['role']>(TEAM_ROLES)
const sessionJwtPublicKey = createPublicKey(config.sessionJwtPrivateKey).export({
  type: 'spki',
  format: 'pem',
})

export function signExternalSessionToken(
  claims: Omit<AuthClaims, 'exp'>,
  ttlSeconds = 60 * 60 * 12
): string {
  const authGeneration = claims.authGeneration
  if (
    typeof authGeneration !== 'number' ||
    !Number.isSafeInteger(authGeneration) ||
    authGeneration < 1
  ) {
    throw new Error('auth_generation_required')
  }
  return jwt.sign(
    {
      ...claims,
      authGeneration,
    },
    config.sessionJwtPrivateKey,
    {
      algorithm: 'RS256',
      expiresIn: ttlSeconds,
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    }
  )
}

export function verifyExternalSessionToken(token: string): AuthClaims | null {
  try {
    const payload = jwt.verify(token, sessionJwtPublicKey, {
      algorithms: ['RS256'],
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    }) as jwt.JwtPayload & Omit<AuthClaims, 'exp'>

    const teamId = payload?.teamId
    const authGeneration = payload?.authGeneration
    if (
      typeof payload?.userId !== 'string' ||
      typeof payload?.email !== 'string' ||
      (teamId !== null && typeof teamId !== 'string') ||
      typeof payload?.role !== 'string' ||
      typeof payload?.exp !== 'number' ||
      !Number.isSafeInteger(authGeneration) ||
      Number(authGeneration) < 1
    ) {
      return null
    }
    if (!ALLOWED_ROLES.has(payload.role as AuthClaims['role'])) {
      return null
    }

    return {
      userId: payload.userId,
      email: payload.email,
      teamId,
      role: payload.role as AuthClaims['role'],
      authGeneration: Number(authGeneration),
      exp: payload.exp,
    }
  } catch {
    return null
  }
}
