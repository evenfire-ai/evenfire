import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { config } from '../src/config.js'
import {
  consumeMcpHostRefreshJwt,
  getMcpHostExpiredRefreshRateLimitKey,
  getMcpHostRefreshRateLimitKey,
  issueMcpHostControlJwt,
  verifyExpiredMcpHostRefreshJwt,
  verifyMcpHostAccessJwt,
  verifyMcpHostControlJwt,
  verifyMcpHostRefreshJwt,
} from '../src/utils/auth/mcpHostJwtToken.js'
import { issueOAuthBrokerJwt, verifyOAuthBrokerJwt } from '../src/utils/auth/oauthBrokerJwtToken.js'

describe('oauthBrokerJwtToken', () => {
  it('round-trips a freshly issued broker token', () => {
    const { token, expiresInSeconds } = issueOAuthBrokerJwt('sandbox-recipes', 'crm')
    expect(expiresInSeconds).toBe(config.oauthBrokerJwtTtlSec)

    const claims = verifyOAuthBrokerJwt(token)
    expect(claims).not.toBeNull()
    expect(claims?.sub).toBe('sandbox-recipes/crm')
    expect(claims?.recipeNamespace).toBe('sandbox-recipes')
    expect(claims?.recipeName).toBe('crm')
    expect(claims?.scope).toBe('oauth:service-token')
    expect(claims?.aud).toBe('oauth-broker')
  })

  it('[SEC-2] rejects an mcp-host control token (audience confusion)', () => {
    const { token } = issueMcpHostControlJwt('sandbox-recipes', 'crm')
    // Shares the control-api signing key, so the signature verifies — only the
    // strict `aud` check stops it being accepted as a broker token.
    expect(verifyOAuthBrokerJwt(token)).toBeNull()
  })

  it('rejects a token with the wrong scope', () => {
    const forged = jwt.sign(
      {
        sub: 'sandbox-recipes/crm',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'crm',
        scope: 'wrong',
      },
      config.adminJwtPrivateKey,
      {
        algorithm: 'RS256',
        issuer: config.adminJwtIssuer,
        audience: 'oauth-broker',
        jwtid: 'test',
        expiresIn: 600,
      }
    )
    expect(verifyOAuthBrokerJwt(forged)).toBeNull()
  })

  it('rejects a tampered token', () => {
    const { token } = issueOAuthBrokerJwt('sandbox-recipes', 'crm')
    expect(verifyOAuthBrokerJwt(token.slice(0, -2) + 'XX')).toBeNull()
  })
})

// [SEC-2] Reverse audience-confusion: every mcp-host validator MUST reject a
// broker token. The signing key is shared with mcp-host token classes (see the
// comment in `utils/auth/oauthBrokerJwtToken.ts`), so the signature verifies —
// only the strict `aud` check on each verifier stops the broker token being
// honored as `aud=mcp-host` or `aud=workflow-approvals`. If you add a new
// mcp-host verifier path, add it here too: a relaxed check on either side is
// the audience-confusion bug.
describe('[SEC-2] reverse audience confusion — mcp-host validators reject a broker token', () => {
  function brokerToken(): string {
    return issueOAuthBrokerJwt('sandbox-recipes', 'crm').token
  }

  it('verifyMcpHostControlJwt rejects an aud=oauth-broker token', () => {
    expect(verifyMcpHostControlJwt(brokerToken())).toBeNull()
  })

  it('verifyMcpHostAccessJwt rejects an aud=oauth-broker token', () => {
    expect(verifyMcpHostAccessJwt(brokerToken())).toBeNull()
  })

  it('verifyMcpHostRefreshJwt rejects an aud=oauth-broker token', async () => {
    expect(await verifyMcpHostRefreshJwt(brokerToken())).toBeNull()
  })

  it('verifyExpiredMcpHostRefreshJwt rejects an aud=oauth-broker token', async () => {
    expect(await verifyExpiredMcpHostRefreshJwt(brokerToken())).toBeNull()
  })

  it('consumeMcpHostRefreshJwt rejects an aud=oauth-broker token (and does not consume a jti)', async () => {
    expect(await consumeMcpHostRefreshJwt(brokerToken())).toBeNull()
  })

  it('getMcpHostRefreshRateLimitKey returns null for an aud=oauth-broker token', () => {
    expect(getMcpHostRefreshRateLimitKey(brokerToken())).toBeNull()
  })

  it('getMcpHostExpiredRefreshRateLimitKey returns null for an aud=oauth-broker token', () => {
    expect(getMcpHostExpiredRefreshRateLimitKey(brokerToken())).toBeNull()
  })

  it('a forged token that claims aud=mcp-host but uses scope=oauth:service-token is still rejected', () => {
    // Belt-and-braces: even if an attacker forges the audience but leaves the
    // broker scope in place, the mcp-host control verifier rejects it because
    // `typ !== 'service'` and `scopes` is missing.
    const forged = jwt.sign(
      {
        sub: 'sandbox-recipes/crm',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'crm',
        scope: 'oauth:service-token',
      },
      config.adminJwtPrivateKey,
      {
        algorithm: 'RS256',
        issuer: config.adminJwtIssuer,
        audience: 'mcp-host',
        jwtid: 'test',
        expiresIn: 600,
      }
    )
    expect(verifyMcpHostControlJwt(forged)).toBeNull()
  })
})
