// HS256 InternalControl JWT signer for Desktop App E2E harnesses.
//
// Mirrors `control-api/src/utils/auth/internalControlToken.ts` — same
// algorithm, same claim shape, same TTL. Used to authenticate as the WRC
// or HCC provisioner when calling `/auth/mcp-host/...` from outside the cluster.
import { execFileSync } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'

const CONTROL_PLANE_NS = 'control-plane'
const HMAC_SECRET_NAME = 'internal-control-jwt-secrets'
const JWT_TTL_SECONDS = 60
type InternalControlIssuer = 'wrc' | 'hcc'

function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function envSuffixForIssuer(iss: InternalControlIssuer): 'WRC' | 'HCC' {
  return iss === 'wrc' ? 'WRC' : 'HCC'
}

export function resolveInternalControlHmacSecret(
  iss: InternalControlIssuer,
  k8sContext?: string
): string | null {
  const issuer = envSuffixForIssuer(iss)
  const hmacSecretKey = `INTERNAL_CONTROL_JWT_${issuer}_HMAC_SECRET`
  const fromEnv = (process.env[`E2E_${hmacSecretKey}`] ?? process.env[hmacSecretKey])?.trim()
  if (fromEnv) return fromEnv

  try {
    const args = [
      '-n',
      CONTROL_PLANE_NS,
      'get',
      'secret',
      HMAC_SECRET_NAME,
      '-o',
      `jsonpath={.data.${hmacSecretKey}}`,
    ]
    if (k8sContext) args.unshift('--context', k8sContext)
    const encoded = execFileSync('kubectl', args, { encoding: 'utf-8', timeout: 10_000 }).trim()
    if (!encoded) return null
    return Buffer.from(encoded, 'base64').toString('utf-8')
  } catch {
    return null
  }
}

export function signInternalControlJwt(iss: InternalControlIssuer, k8sContext?: string): string {
  const secret = resolveInternalControlHmacSecret(iss, k8sContext)
  if (!secret) {
    const issuer = envSuffixForIssuer(iss)
    throw new Error(
      `InternalControl JWT HMAC secret missing for ${issuer} — set E2E_INTERNAL_CONTROL_JWT_${issuer}_HMAC_SECRET or ensure cluster Secret ${HMAC_SECRET_NAME} is reachable`
    )
  }
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(
    JSON.stringify({
      iss,
      aud: 'control-api',
      sub: `${iss}-provisioner`,
      iat: now,
      exp: now + JWT_TTL_SECONDS,
      jti: randomUUID(),
    })
  )
  const data = `${header}.${payload}`
  const sig = b64url(createHmac('sha256', secret).update(data).digest())
  return `${data}.${sig}`
}
