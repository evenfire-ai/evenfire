import jwt from 'jsonwebtoken'
import { generateKeyPairSync } from 'node:crypto'

// Generated once per test process so no signing material is committed. The
// matching public half is exported for the spawned rpc-proxy verifier env.
const testKeyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
})

export const TEST_JWT_PRIVATE_KEY = testKeyPair.privateKey
export const TEST_JWT_PUBLIC_KEY = testKeyPair.publicKey

type RpcJwtOptions = {
  sub?: string
  typ?: 'user' | 'service'
  teamId?: string
  scopes?: string[]
  hostRefs?: string[]
  iss?: string
  aud?: string
  expiresInSeconds?: number
  now?: number
  privateKey?: string
  jti?: string
}

export function signRpcJwt(opts: RpcJwtOptions = {}): string {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const exp = now + (opts.expiresInSeconds ?? 300)
  return jwt.sign(
    {
      sub: opts.sub ?? 'e2e-user',
      typ: opts.typ ?? 'user',
      teamId: opts.teamId ?? 'e2e-team',
      scopes: opts.scopes ?? ['mcp:servers:list', 'mcp:server:invoke'],
      hostRefs: opts.hostRefs ?? ['agent2'],
      jti: opts.jti ?? `e2e-${now}`,
      iat: now,
      exp,
    },
    opts.privateKey ?? TEST_JWT_PRIVATE_KEY,
    {
      algorithm: 'RS256',
      issuer: opts.iss ?? 'control-api',
      audience: opts.aud ?? 'rpc-proxy',
    }
  )
}

export function signWithWrongKey(opts: Omit<RpcJwtOptions, 'privateKey'> = {}): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  })
  return signRpcJwt({ ...opts, privateKey })
}
