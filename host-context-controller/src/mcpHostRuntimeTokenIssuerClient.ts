/**
 * HCC provisions first-party mcp-host credentials through the existing
 * `<target namespace>`/`standalone` token family. Each credential is additionally
 * bound to the canonical live Host name and UID.
 */
import { config } from './config'
import { hccLogger } from './logger'
import { McpApiAuthenticator } from './mcpApiAuthentication'
import type { HostWorkflowControlScope } from './types'
import { signInternalControlJwt } from './utils/internalControlSigner'

export interface McpHostRuntimeTokenResponse {
  accessToken: string
  refreshToken: string
  mcpHostControlToken: string
  expiresInSeconds: number
  refreshExpiresInSeconds: number
  controlExpiresInSeconds: number
}

const REQUEST_TIMEOUT_MS = 10_000
const SENTINEL_RECIPE_NAME = 'standalone'
const HOST_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const log = hccLogger.child({ module: 'mcp-host-runtime-token-issuer' })

type CanonicalMcpHostTokenResponse = {
  mcpHostAccessToken?: unknown
  mcpHostRefreshToken?: unknown
  mcpHostControlToken?: unknown
  expiresInSeconds?: {
    access?: unknown
    refresh?: unknown
    control?: unknown
  }
}

function isBoundedCompactJwt(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 16_384 &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  )
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * `hostName` is sent as `host` in the body so control-api can populate
 * the JWT's `hostRefs[0]` with the actual Host CRD name (not the sentinel
 * recipe pair). The sentinel recipe pair is only the internal issuance
 * transport contract; the returned access JWT is cryptographically verified
 * below for the actual Host name, UID, HCC audience, and MCP capability before
 * any credential is persisted.
 */
export async function issueMcpHostRuntimeTokens(
  hostName: string,
  hostUid: string,
  workflowControlScopes: HostWorkflowControlScope[] = []
): Promise<McpHostRuntimeTokenResponse> {
  if (
    typeof hostName !== 'string' ||
    !hostName ||
    hostName.length > 63 ||
    !HOST_NAME_RE.test(hostName)
  ) {
    throw new Error('mcpHost runtime token issuance requires a canonical Host name')
  }
  if (
    typeof hostUid !== 'string' ||
    !hostUid.trim() ||
    hostUid.trim() !== hostUid ||
    hostUid.length > 128 ||
    /[^A-Za-z0-9._:-]/.test(hostUid)
  ) {
    throw new Error('mcpHost runtime token issuance requires a live Host UID')
  }
  if (config.hccTargetNamespace !== config.hostNamespace) {
    throw new Error(
      'HCC_TARGET_NAMESPACE must equal CONTEXT_MAPPER_HOST_NAMESPACE for caller-bound Host credentials'
    )
  }
  const recipeNamespace = config.hccTargetNamespace
  const url = `${config.controlApiBaseUrl}/api/v1/auth/mcp-host/${encodeURIComponent(recipeNamespace)}/${encodeURIComponent(SENTINEL_RECIPE_NAME)}/tokens`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${signInternalControlJwt()}`,
      },
      body: JSON.stringify({
        includeMcpHostControlToken: true,
        host: hostName,
        hostUid,
        workflowControlScopes,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`mcpHost runtime token issuance failed: HTTP ${response.status}`)
    }

    const data = (await response.json()) as CanonicalMcpHostTokenResponse

    if (
      !isBoundedCompactJwt(data.mcpHostAccessToken) ||
      !isBoundedCompactJwt(data.mcpHostRefreshToken) ||
      !isBoundedCompactJwt(data.mcpHostControlToken)
    ) {
      throw new Error('mcpHost credential response missing required fields')
    }
    const accessTtl = positiveInteger(data.expiresInSeconds?.access)
    const refreshTtl = positiveInteger(data.expiresInSeconds?.refresh)
    const controlTtl = positiveInteger(data.expiresInSeconds?.control)
    if (accessTtl === null || refreshTtl === null || controlTtl === null) {
      throw new Error('mcpHost credential response has invalid expiry fields')
    }

    // The issuer response is an authorization boundary, not merely a shape
    // check. A stale/old Control API during a rolling update could otherwise
    // return workflow-only credentials which the reconciler would persist and
    // later mount. Verify the access token with the same strict HCC verifier
    // used by the request routes before accepting the response.
    const issuedPrincipal = new McpApiAuthenticator({
      publicKey: config.mcpHostJwtPublicKey,
      issuer: config.mcpHostJwtIssuer,
      hostNamespace: config.hostNamespace,
      maxTokenLifetimeSeconds: config.mcpHostJwtMaxTtlSeconds,
    }).authenticate({ authorization: `Bearer ${data.mcpHostAccessToken}` }, [
      'Authorization',
      `Bearer ${data.mcpHostAccessToken}`,
    ])
    if (issuedPrincipal.hostName !== hostName || issuedPrincipal.hostUid !== hostUid) {
      throw new Error('mcpHost credential response identity does not match the live Host')
    }

    log.info('Issued mcpHost credentials', {
      accessTtlSeconds: accessTtl,
      refreshTtlSeconds: refreshTtl,
      controlTtlSeconds: controlTtl,
      workflowControlScopeCount: workflowControlScopes.length,
    })

    return {
      accessToken: data.mcpHostAccessToken,
      refreshToken: data.mcpHostRefreshToken,
      mcpHostControlToken: data.mcpHostControlToken,
      expiresInSeconds: accessTtl,
      refreshExpiresInSeconds: refreshTtl,
      controlExpiresInSeconds: controlTtl,
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`mcpHost runtime token issuance timed out after ${REQUEST_TIMEOUT_MS}ms`)
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
}
