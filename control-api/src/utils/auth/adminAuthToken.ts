import jwt from 'jsonwebtoken'
import { createPublicKey, randomUUID } from 'node:crypto'
import { config } from '../../config.js'
import { AdminAuthClaims } from './adminAuthTypes.js'

const adminJwtPublicKey = createPublicKey(config.adminJwtPrivateKey).export({
  type: 'spki',
  format: 'pem',
})

export function signAdminToken(
  subject: string,
  role: AdminAuthClaims['role'] = 'admin',
  sessionVersion = 0
): string {
  return jwt.sign(
    {
      sub: subject,
      typ: 'user',
      role,
      jti: randomUUID(),
      sessionVersion,
    },
    config.adminJwtPrivateKey,
    {
      algorithm: 'RS256',
      issuer: config.adminJwtIssuer,
      audience: config.adminJwtAudience,
      expiresIn: config.adminJwtTtlSeconds,
    }
  )
}

export function verifyAdminToken(token: string): AdminAuthClaims | null {
  try {
    const payload = jwt.verify(token, adminJwtPublicKey, {
      algorithms: ['RS256'],
      issuer: config.adminJwtIssuer,
      audience: config.adminJwtAudience,
    }) as jwt.JwtPayload

    if (
      typeof payload?.sub !== 'string' ||
      payload?.typ !== 'user' ||
      payload?.role !== 'admin' ||
      typeof payload?.jti !== 'string' ||
      typeof payload?.exp !== 'number' ||
      (typeof payload?.sessionVersion !== 'number' && payload?.sessionVersion !== undefined)
    ) {
      return null
    }

    return {
      sub: payload.sub,
      typ: 'user',
      role: 'admin',
      jti: payload.jti,
      exp: payload.exp,
      sessionVersion: Number(payload.sessionVersion || 0),
    }
  } catch {
    return null
  }
}
