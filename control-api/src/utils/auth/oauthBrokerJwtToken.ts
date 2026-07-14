import jwt from 'jsonwebtoken'
import { createPublicKey, randomUUID } from 'node:crypto'
import { config } from '../../config.js'
import { oauthBrokerJwtIssueTotal } from '../../observability/metrics.js'

// Broker tokens carry a background workload's recipe identity to the
// `/recipe-oauth/token` route. WRC mints one per opted-in recipe and writes it
// to a short-lived Secret; the workload presents it to obtain provider access
// tokens for the recipe-owned `service` grant. Path B, spec §9.1 / §10.
//
// [SEC-2] v1 decision: the broker token shares the control-api RS256 signing
// key with mcp-host runtime tokens, so `aud` is the ONLY separator between the
// two token classes. Splitting to a dedicated broker key is tracked as the
// spec §9.1 follow-up; until then the audience separation MUST hold from BOTH
// sides:
//   - `verifyOAuthBrokerJwt` stays strict on `aud === 'oauth-broker'` + scope.
//     Forward-confusion test (mcp-host token rejected here) lives in
//     `test/oauth.brokerJwt.test.ts`.
//   - Every mcp-host verifier in `utils/auth/mcpHostJwtToken.ts` stays strict
//     on its own audience (`mcp-host` / `workflow-approvals`). Reverse-
//     confusion tests (broker token rejected by each mcp-host validator) live
//     in `test/oauth.brokerJwt.test.ts` under the "reverse audience
//     confusion" suite.
// A relaxed check on either side is an audience-confusion bug.

const BROKER_AUDIENCE = 'oauth-broker'
const BROKER_SCOPE = 'oauth:service-token'

const brokerJwtPublicKey = createPublicKey(config.adminJwtPrivateKey).export({
  type: 'spki',
  format: 'pem',
})

export type OAuthBrokerClaims = {
  sub: string
  recipeNamespace: string
  recipeName: string
  scope: typeof BROKER_SCOPE
  iss: string
  aud: string
  jti: string
  exp: number
}

export function issueOAuthBrokerJwt(
  recipeNamespace: string,
  recipeName: string
): { token: string; expiresInSeconds: number } {
  const ttlSec = config.oauthBrokerJwtTtlSec
  const token = jwt.sign(
    {
      sub: `${recipeNamespace}/${recipeName}`,
      recipeNamespace,
      recipeName,
      scope: BROKER_SCOPE,
    },
    config.adminJwtPrivateKey,
    {
      algorithm: 'RS256',
      issuer: config.adminJwtIssuer,
      audience: BROKER_AUDIENCE,
      jwtid: randomUUID(),
      expiresIn: ttlSec,
    }
  )
  oauthBrokerJwtIssueTotal.inc({ result: 'issued' }, 1)
  return { token, expiresInSeconds: ttlSec }
}

/**
 * Verify a broker token. Returns claims only when the signature, issuer,
 * audience (`oauth-broker`), and scope (`oauth:service-token`) all check out —
 * null otherwise. The caller surfaces an opaque 401 so it cannot tell which
 * check failed.
 */
export function verifyOAuthBrokerJwt(token: string): OAuthBrokerClaims | null {
  try {
    const payload = jwt.verify(token, brokerJwtPublicKey, {
      algorithms: ['RS256'],
      issuer: config.adminJwtIssuer,
      audience: BROKER_AUDIENCE,
    }) as jwt.JwtPayload

    const { sub, recipeNamespace, recipeName, scope, jti, exp } = payload
    if (
      typeof sub !== 'string' ||
      typeof recipeNamespace !== 'string' ||
      typeof recipeName !== 'string' ||
      scope !== BROKER_SCOPE ||
      typeof jti !== 'string' ||
      typeof exp !== 'number'
    ) {
      return null
    }

    return {
      sub,
      recipeNamespace,
      recipeName,
      scope: BROKER_SCOPE,
      iss: payload.iss as string,
      aud: payload.aud as string,
      jti,
      exp,
    }
  } catch {
    return null
  }
}
