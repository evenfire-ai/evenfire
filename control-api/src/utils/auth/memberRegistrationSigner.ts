import { createHmac, randomUUID } from 'node:crypto'
import { config } from '../../config.js'

// Signs the per-tenant HMAC JWT that control-api presents to the centralized
// member-registration service (on evenfire-hub, example.com) for
// its three machine-to-machine routes. Mirrors the InternalControl-JWT
// convention used by WRC/HCC; the member-registration service verifies the
// signature against this tenant's secret (resolved by `kid`) and binds the
// request to `sub` = tenantId.
const AUDIENCE = 'member-registration-service'
const ISSUER = 'control-api'
const TTL_SECONDS = 60

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export function signMemberRegistrationJwt(now: Date = new Date()): string {
  const secret = config.memberRegistrationServiceHmacSecret
  const kid = config.memberRegistrationServiceHmacKid
  const tenantId = config.memberRegistrationTenantId
  const iat = Math.floor(now.getTime() / 1000)

  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT', kid })
  const payload = base64UrlJson({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: tenantId,
    iat,
    exp: iat + TTL_SECONDS,
    jti: randomUUID(),
  })
  const signingInput = `${header}.${payload}`
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url')
  return `${signingInput}.${signature}`
}
