import { createHmac, randomUUID } from 'node:crypto'

// Signs the per-tenant HMAC JWT that control-api presents to the member-
// registration service. Pure: the credential is supplied by the caller —
// remote mode passes the injected env credential, hosted mode passes the
// self-enrolled row (spec §8.5). Token shape is unchanged either way.
const AUDIENCE = 'member-registration-service'
const ISSUER = 'control-api'
const TTL_SECONDS = 60

export interface MemberRegistrationSigningCredential {
  secret: string
  kid: string
  tenantId: string
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export function signMemberRegistrationJwt(
  credential: MemberRegistrationSigningCredential,
  now: Date = new Date()
): string {
  const iat = Math.floor(now.getTime() / 1000)

  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT', kid: credential.kid })
  const payload = base64UrlJson({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: credential.tenantId,
    iat,
    exp: iat + TTL_SECONDS,
    jti: randomUUID(),
  })
  const signingInput = `${header}.${payload}`
  const signature = createHmac('sha256', credential.secret).update(signingInput).digest('base64url')
  return `${signingInput}.${signature}`
}
