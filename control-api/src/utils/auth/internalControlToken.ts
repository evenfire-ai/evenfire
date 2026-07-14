import jwt from 'jsonwebtoken'
import { config } from '../../config.js'

export type InternalControlIssuer = 'wrc' | 'hcc'

export type InternalControlClaims = {
  iss: InternalControlIssuer
  aud: 'control-api'
  sub: string
  iat: number
  exp: number
  jti: string
}

function isInternalControlIssuer(value: unknown): value is InternalControlIssuer {
  return value === 'wrc' || value === 'hcc'
}

function getSecretForIssuer(issuer: InternalControlIssuer): string {
  return issuer === 'wrc'
    ? config.internalControlJwtWrcHmacSecret
    : config.internalControlJwtHccHmacSecret
}

export function verifyInternalControlJwt(token: string): InternalControlClaims | null {
  try {
    const decoded = jwt.decode(token)
    if (!decoded || typeof decoded !== 'object' || !isInternalControlIssuer(decoded.iss)) {
      return null
    }

    const issuer = decoded.iss
    const payload = jwt.verify(token, getSecretForIssuer(issuer), {
      algorithms: ['HS256'],
      audience: 'control-api',
      issuer,
    })
    if (
      !payload ||
      typeof payload !== 'object' ||
      payload.iss !== issuer ||
      payload.aud !== 'control-api' ||
      typeof payload.sub !== 'string' ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      typeof payload.jti !== 'string'
    ) {
      return null
    }
    return {
      iss: issuer,
      aud: 'control-api',
      sub: payload.sub,
      iat: payload.iat,
      exp: payload.exp,
      jti: payload.jti,
    }
  } catch {
    return null
  }
}
