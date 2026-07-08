import jwt from 'jsonwebtoken'
import { generateKeyPairSync } from 'node:crypto'

const keyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
})

export const TEST_SESSION_PRIVATE_KEY = keyPair.privateKey
export const TEST_SESSION_PUBLIC_KEY = keyPair.publicKey

type SessionJwtOptions = {
  userId?: string
  email?: string
  teamId?: string
  role?: 'admin' | 'inviter' | 'member'
  issuer?: string
  audience?: string
  issuedAt?: number
  expiresInSeconds?: number
  privateKey?: string
  extraClaims?: Record<string, unknown>
}

export function signSessionJwt(options: SessionJwtOptions = {}): string {
  const now = options.issuedAt ?? Math.floor(Date.now() / 1000)
  const exp = now + (options.expiresInSeconds ?? 300)
  return jwt.sign(
    {
      userId: options.userId ?? 'user-e2e-1',
      email: options.email ?? 'dev@clerum.local',
      teamId: options.teamId ?? 'team-e2e-1',
      role: options.role ?? 'admin',
      iat: now,
      exp,
      ...(options.extraClaims || {}),
    },
    options.privateKey ?? TEST_SESSION_PRIVATE_KEY,
    {
      algorithm: 'RS256',
      issuer: options.issuer ?? 'control-api',
      audience: options.audience ?? 'profile-ui',
    }
  )
}

export function signWithWrongKey(options: Omit<SessionJwtOptions, 'privateKey'> = {}): string {
  const wrong = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  })
  return signSessionJwt({ ...options, privateKey: wrong.privateKey })
}
