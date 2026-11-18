import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'

/**
 * V1 external session tokens with the claim set of control-api's
 * `signExternalSessionToken` (utils/auth/externalSessionAuthToken.ts):
 * `userId`, `email`, `teamId`, `role`, `authGeneration`, plus `iat`, `exp`,
 * `iss`, `aud` and `jti` from jsonwebtoken, RS256 over canonical unpadded
 * base64url. The producer itself cannot be imported here: it loads
 * control-api's config and `jsonwebtoken`, neither available to this package.
 * Main never verifies the signature, so a throwaway key is enough.
 */
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

export type V1Claims = {
  userId: string
  email?: string
  teamId?: string | null
  role?: string
  authGeneration: number
}

export function signV1SessionToken(claims: V1Claims): string {
  const iat = Math.floor(Date.now() / 1000)
  const header = b64url({ alg: 'RS256', typ: 'JWT' })
  const payload = b64url({
    userId: claims.userId,
    email: claims.email ?? `${claims.userId.slice(0, 8)}@example.test`,
    teamId: claims.teamId ?? null,
    role: claims.role ?? 'member',
    authGeneration: claims.authGeneration,
    iat,
    exp: iat + 7 * 24 * 60 * 60,
    aud: 'evenfire-external',
    iss: 'evenfire-control-api',
    jti: randomUUID(),
  })
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString(
    'base64url'
  )
  return `${header}.${payload}.${signature}`
}

export const USER_A = '6f1c2a3b-4d5e-4f60-8a7b-1c2d3e4f5a6b'
export const USER_B = '0a9b8c7d-6e5f-4a3b-9c2d-1e0f2a3b4c5d'
export const TEAM_1 = '11111111-2222-4333-8444-555555555555'
export const TEAM_2 = '66666666-7777-4888-9999-aaaaaaaaaaaa'

/** A canonical key for drive `d1` and a hex index. */
export function key(kind: 'file' | 'dir', n: number, drive = 'd1'): string {
  return `${kind}:gfs://${drive}/${n.toString(16).padStart(32, '0')}`
}
