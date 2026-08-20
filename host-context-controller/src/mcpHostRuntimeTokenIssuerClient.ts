/**
 * HCC provisions the shared 1st-party mcp-host credentials.
 * All 1st-party hosts share the sentinel binding `<target namespace>`/`standalone`;
 * per-host authorization is still enforced by Host/User bindings elsewhere.
 */
import { config } from './config'
import { hccLogger } from './logger'
import type { EffectiveMcpHostControlScope } from './types'
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

/**
 * `hostName` is sent as `host` in the body so control-api can populate
 * the JWT's `hostRefs[0]` with the actual Host CRD name (not the sentinel
 * recipe pair). Per-event identity binding (e.g. usage ingest) uses this
 * to verify the bearer pod is acting on its own behalf.
 */
export async function issueMcpHostRuntimeTokens(
  hostName: string,
  workflowControlScopes: EffectiveMcpHostControlScope[] = []
): Promise<McpHostRuntimeTokenResponse> {
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
        workflowControlScopes,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(
        `mcpHost runtime token issuance failed: HTTP ${response.status} for host "${hostName}"`
      )
    }

    const data = (await response.json()) as CanonicalMcpHostTokenResponse

    if (
      typeof data.mcpHostAccessToken !== 'string' ||
      typeof data.mcpHostRefreshToken !== 'string' ||
      typeof data.mcpHostControlToken !== 'string'
    ) {
      throw new Error(`mcpHost credential response missing required fields for host "${hostName}"`)
    }
    const accessTtl =
      typeof data.expiresInSeconds?.access === 'number' ? data.expiresInSeconds.access : 0
    const refreshTtl =
      typeof data.expiresInSeconds?.refresh === 'number' ? data.expiresInSeconds.refresh : 0
    const controlTtl =
      typeof data.expiresInSeconds?.control === 'number' ? data.expiresInSeconds.control : 0

    log.info('Issued mcpHost credentials for host', {
      hostName,
      accessTtlSeconds: accessTtl,
      refreshTtlSeconds: refreshTtl,
      controlTtlSeconds: controlTtl,
      workflowControlScopes,
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
      throw new Error(
        `mcpHost runtime token issuance timed out after ${REQUEST_TIMEOUT_MS}ms for host "${hostName}"`
      )
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
}
