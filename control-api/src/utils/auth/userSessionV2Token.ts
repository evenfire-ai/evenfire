import jwt from 'jsonwebtoken'
import { createPublicKey } from 'node:crypto'
import { config } from '../../config.js'

export const USER_SESSION_V2_AUDIENCE = 'evenfire-user-session'
export const USER_SESSION_V2_TTL_SECONDS = 60 * 60
export const USER_SESSION_V2_CLOCK_TOLERANCE_SECONDS = 5
export const USER_SESSION_V2_TYPE = 'user_session' as const
export const USER_SESSION_V2_VERSION = 2 as const

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

const FORBIDDEN_AUTHORITY_CLAIMS = [
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function signUserSessionV2Token(
  input: UserSessionV2SignInput,
  issuedAtSeconds = Math.floor(Date.now() / 1000)
): string {
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

    if (FORBIDDEN_AUTHORITY_CLAIMS.some(claim => payload[claim] !== undefined)) return null
    const now = Math.floor(Date.now() / 1000)
    if (
      !isNonEmptyString(payload.sub) ||
      !isNonEmptyString(payload.sid) ||
      !isNonEmptyString(payload.jti) ||
      !Number.isInteger(payload.sv) ||
      Number(payload.sv) < 1 ||
      payload.ver !== USER_SESSION_V2_VERSION ||
      payload.typ !== USER_SESSION_V2_TYPE ||
      typeof payload.auth_time !== 'number' ||
      !Array.isArray(payload.amr) ||
      !payload.amr.every(isNonEmptyString) ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      payload.exp - payload.iat !== USER_SESSION_V2_TTL_SECONDS ||
      payload.iat > now + USER_SESSION_V2_CLOCK_TOLERANCE_SECONDS ||
      payload.auth_time > now + USER_SESSION_V2_CLOCK_TOLERANCE_SECONDS ||
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
