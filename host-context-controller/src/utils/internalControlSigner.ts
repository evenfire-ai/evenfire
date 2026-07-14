import { createHmac, randomUUID } from 'node:crypto'

const ISSUER = 'hcc'
const SUBJECT = 'hcc-provisioner'
const AUDIENCE = 'control-api'
const TTL_SECONDS = 60
const INTERNAL_CONTROL_SECRET_ENV = 'INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET'

interface InternalControlClaims {
  iss: typeof ISSUER
  aud: typeof AUDIENCE
  sub: typeof SUBJECT
  iat: number
  exp: number
  jti: string
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export function assertInternalControlJwtHmacSecret(
  secret = process.env[INTERNAL_CONTROL_SECRET_ENV] ?? ''
): string {
  if (!secret.trim()) {
    throw new Error(`${INTERNAL_CONTROL_SECRET_ENV} env var is required`)
  }
  if (/^replace-with-/.test(secret)) {
    throw new Error(
      `${INTERNAL_CONTROL_SECRET_ENV} has placeholder value. ` +
        'Run deploy/scripts/apply-inter-service-tokens.sh before deploying.'
    )
  }
  return secret
}

export function signInternalControlJwt(now = new Date()): string {
  const secret = assertInternalControlJwtHmacSecret()
  const iat = Math.floor(now.getTime() / 1000)
  const claims: InternalControlClaims = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: SUBJECT,
    iat,
    exp: iat + TTL_SECONDS,
    jti: randomUUID(),
  }

  const encodedHeader = base64UrlJson({ alg: 'HS256', typ: 'JWT' })
  const encodedPayload = base64UrlJson(claims)
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url')

  return `${signingInput}.${signature}`
}
