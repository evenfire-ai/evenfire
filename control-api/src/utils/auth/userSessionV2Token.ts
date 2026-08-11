import jwt from 'jsonwebtoken'
import { createPublicKey } from 'node:crypto'
import { config } from '../../config.js'

export const USER_SESSION_V2_AUDIENCE = 'evenfire-user-session'
export const USER_SESSION_V2_TTL_SECONDS = 60 * 60
export const USER_SESSION_V2_CLOCK_TOLERANCE_SECONDS = 5
export const USER_SESSION_V2_TYPE = 'user_session' as const
export const USER_SESSION_V2_VERSION = 2 as const

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ALLOWED_CLAIMS = new Set([
  'sub',
  'sid',
  'jti',
  'sv',
  'ver',
  'typ',
  'email',
  'auth_time',
  'amr',
  'iat',
  'exp',
  'iss',
  'aud',
])

let publicKey: ReturnType<typeof createPublicKey> | null = null

function sessionPublicKey() {
  if (!publicKey) publicKey = createPublicKey(config.sessionJwtPrivateKey)
  return publicKey
}

export type UserSessionV2Claims = {
  sub: string
  sid: string
  jti: string
  sv: number
  ver: typeof USER_SESSION_V2_VERSION
  typ: typeof USER_SESSION_V2_TYPE
  email?: string
  auth_time: number
  amr: string[]
  iat: number
  exp: number
}

export type UserSessionV2SignInput = Omit<UserSessionV2Claims, 'ver' | 'typ' | 'iat' | 'exp'>

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function validAuthenticationMethods(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 8 &&
    value.every(method => isNonEmptyString(method) && method.length <= 32) &&
    new Set(value).size === value.length
  )
}

export function signUserSessionV2Token(
  input: UserSessionV2SignInput,
  issuedAtSeconds = Math.floor(Date.now() / 1000)
): string {
  if (!isUuid(input.sub) || !isUuid(input.sid) || !isUuid(input.jti)) {
    throw new Error('user-session identity must use UUID values')
  }
  if (!Number.isInteger(input.sv) || input.sv < 1) {
    throw new Error('user-session version must be a positive integer')
  }
  if (!validAuthenticationMethods(input.amr)) {
    throw new Error('user-session authentication methods are invalid')
  }

  return jwt.sign(
    {
      sub: input.sub,
      sid: input.sid,
      jti: input.jti,
      sv: input.sv,
      ver: USER_SESSION_V2_VERSION,
      typ: USER_SESSION_V2_TYPE,
      ...(input.email ? { email: input.email.trim().toLowerCase() } : {}),
      auth_time: input.auth_time,
      amr: [...input.amr],
      iat: issuedAtSeconds,
    },
    config.sessionJwtPrivateKey,
    {
      algorithm: 'RS256',
      expiresIn: USER_SESSION_V2_TTL_SECONDS,
      issuer: config.jwtIssuer,
      audience: USER_SESSION_V2_AUDIENCE,
    }
  )
}

export function verifyUserSessionV2Token(token: string): UserSessionV2Claims | null {
  try {
    const payload = jwt.verify(token, sessionPublicKey(), {
      algorithms: ['RS256'],
      issuer: config.jwtIssuer,
      audience: USER_SESSION_V2_AUDIENCE,
      clockTolerance: USER_SESSION_V2_CLOCK_TOLERANCE_SECONDS,
    }) as jwt.JwtPayload

    if (Object.keys(payload).some(claim => !ALLOWED_CLAIMS.has(claim))) return null
    const now = Math.floor(Date.now() / 1000)
    if (
      !isUuid(payload.sub) ||
      !isUuid(payload.sid) ||
      !isUuid(payload.jti) ||
      !Number.isInteger(payload.sv) ||
      Number(payload.sv) < 1 ||
      payload.ver !== USER_SESSION_V2_VERSION ||
      payload.typ !== USER_SESSION_V2_TYPE ||
      payload.iss !== config.jwtIssuer ||
      payload.aud !== USER_SESSION_V2_AUDIENCE ||
      typeof payload.auth_time !== 'number' ||
      !validAuthenticationMethods(payload.amr) ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      payload.exp - payload.iat !== USER_SESSION_V2_TTL_SECONDS ||
      payload.iat > now + USER_SESSION_V2_CLOCK_TOLERANCE_SECONDS ||
      payload.auth_time > payload.iat + USER_SESSION_V2_CLOCK_TOLERANCE_SECONDS ||
      (payload.email !== undefined && !isNonEmptyString(payload.email))
    ) {
      return null
    }

    return {
      sub: payload.sub,
      sid: payload.sid,
      jti: payload.jti,
      sv: Number(payload.sv),
      ver: USER_SESSION_V2_VERSION,
      typ: USER_SESSION_V2_TYPE,
      ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
      auth_time: payload.auth_time,
      amr: [...payload.amr],
      iat: payload.iat,
      exp: payload.exp,
    }
  } catch {
    return null
  }
}
