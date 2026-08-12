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
  return jwt.sign(
    {
      ...claims,
      // A zero generation is an explicit legacy marker. Current issuers pass
      // the user's lifecycle_version; consumers reject the marker when the
      // authoritative row is checked, so an old token cannot survive a retire.
      authGeneration: typeof claims.authGeneration === 'number' ? claims.authGeneration : 0,
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
      Number(authGeneration) < 0
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
