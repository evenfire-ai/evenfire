/**
 * Obtains a recipe-bound OAuth broker token from control-api.
 *
 * WRC authenticates with a per-request InternalControl JWT (iss=wrc); control-api
 * verifies the recipe exists and declares a `backgroundAccess` oauthClient before
 * minting the broker token. Path B, spec §9. Mirrors mcpHostRuntimeTokenIssuerClient.
 */
import { createLogger } from '../observability/logger'
import { signInternalControlJwt } from '../utils/internalControlSigner'

const log = createLogger('wrc', 'oauth-broker-token-issuer')

const CONTROL_API_BASE_URL =
  process.env.CONTROL_API_BASE_URL || 'http://control-api.control-plane.svc.cluster.local:8090'

const REQUEST_TIMEOUT_MS = 10_000

export interface OAuthBrokerTokenResponse {
  brokerToken: string
  expiresInSeconds: number
}

export async function issueOAuthBrokerToken(
  recipeNamespace: string,
  recipeName: string
): Promise<OAuthBrokerTokenResponse> {
  const url = `${CONTROL_API_BASE_URL}/api/v1/auth/recipe-oauth/${encodeURIComponent(recipeNamespace)}/${encodeURIComponent(recipeName)}/broker-token`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${signInternalControlJwt()}`,
      },
      body: JSON.stringify({}),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(
        `OAuth broker token issuance failed: HTTP ${response.status} for recipe "${recipeName}"`
      )
    }

    const data = (await response.json()) as {
      brokerToken?: unknown
      expiresInSeconds?: unknown
    }
    if (typeof data.brokerToken !== 'string') {
      throw new Error(`OAuth broker token response missing brokerToken for recipe "${recipeName}"`)
    }
    const expiresInSeconds = typeof data.expiresInSeconds === 'number' ? data.expiresInSeconds : 0

    log.info(`Issued OAuth broker token for recipe "${recipeName}"`, {
      recipeName,
      expiresInSeconds,
    })

    return { brokerToken: data.brokerToken, expiresInSeconds }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(
        `OAuth broker token issuance timed out after ${REQUEST_TIMEOUT_MS}ms for recipe "${recipeName}"`
      )
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
}
