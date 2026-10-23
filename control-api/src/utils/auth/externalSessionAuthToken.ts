import jwt from 'jsonwebtoken'
import { createPublicKey, randomUUID } from 'node:crypto'
import { config } from '../../config.js'
import { AuthClaims, TEAM_ROLES } from '../../profileTypes.js'
import { legacyExternalSessionAuthGeneration } from '../../services/auth/legacyV1Generation.js'

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
      jwtid: randomUUID(),
    }
  )
}

const BASE64URL_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/
const JWS_SEGMENT_COUNT = 3

/**
 * V1 revocation is keyed by the SHA-256 of the exact token string, so an
 * alternate base64url encoding of the same JWS segments would carry a
 * different hash and escape its revocation record. A canonical segment is
 * unpadded base64url over the base64url alphabet and re-encodes to exactly
 * the presented text; verification accepts nothing else.
 */
function isCanonicalBase64UrlSegment(segment: string): boolean {
  if (!BASE64URL_SEGMENT_PATTERN.test(segment)) return false
  return Buffer.from(segment, 'base64url').toString('base64url') === segment
}

function hasCanonicalJwsRepresentation(token: string): boolean {
  const segments = token.split('.')
  return segments.length === JWS_SEGMENT_COUNT && segments.every(isCanonicalBase64UrlSegment)
}

export function verifyExternalSessionToken(token: string): AuthClaims | null {
  try {
    if (token.length > 4096) return null
    if (!hasCanonicalJwsRepresentation(token)) return null
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
      legacyExternalSessionAuthGeneration({ authGeneration }) === null
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
      ...(typeof payload.iat === 'number' ? { iat: payload.iat } : {}),
      ...(typeof payload.jti === 'string' ? { jti: payload.jti } : {}),
    }
  } catch {
    return null
  }
}
