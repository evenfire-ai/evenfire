/** Authenticates to control-api with a per-request InternalControl JWT. */
import { createLogger } from '../observability/logger'
import { signInternalControlJwt } from '../utils/internalControlSigner'

const log = createLogger('wrc', 'mcp-host-runtime-token-issuer')

export interface McpHostRuntimeTokenResponse {
  accessToken: string
  refreshToken: string
  mcpHostControlToken: string
  expiresInSeconds: number
  controlExpiresInSeconds: number
}

const CONTROL_API_BASE_URL =
  process.env.CONTROL_API_BASE_URL || 'http://control-api.control-plane.svc.cluster.local:8090'

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

const REQUEST_TIMEOUT_MS = 10_000

export type WorkflowControlScope =
  | 'workflow:list'
  | 'workflow:read'
  | 'workflow:trigger'
  | 'workflow:approval:resolve'
  | 'workflow:approval:decide'
  | 'plugin-workload-sdk'

export type DerivedPlatformScope = 'llm:codex:execute'
export type EffectiveWorkflowControlScope = WorkflowControlScope | DerivedPlatformScope

async function postMcpHostTokenIssue(
  recipeNamespace: string,
  recipeName: string,
  workflowControlScopes: EffectiveWorkflowControlScope[] = []
): Promise<CanonicalMcpHostTokenResponse> {
  const url = `${CONTROL_API_BASE_URL}/api/v1/auth/mcp-host/${encodeURIComponent(recipeNamespace)}/${encodeURIComponent(recipeName)}/tokens`
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
        workflowControlScopes,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(
        `mcpHost credential issuance failed: HTTP ${response.status} for recipe "${recipeName}"`
      )
    }

    return (await response.json()) as CanonicalMcpHostTokenResponse
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(
        `mcpHost credential issuance timed out after ${REQUEST_TIMEOUT_MS}ms for recipe "${recipeName}"`
      )
    }
    throw err
    /* v8 ignore next -- finally cleanup executes but V8 reports it as a synthetic branch. */
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function issueMcpHostWorkflowControlToken(
  recipeNamespace: string,
  recipeName: string,
  workflowControlScopes: EffectiveWorkflowControlScope[] = []
): Promise<string> {
  return (await issueMcpHostRuntimeTokens(recipeNamespace, recipeName, workflowControlScopes))
    .mcpHostControlToken
}

export async function issueMcpHostRuntimeTokens(
  recipeNamespace: string,
  recipeName: string,
  workflowControlScopes: EffectiveWorkflowControlScope[] = []
): Promise<McpHostRuntimeTokenResponse> {
  const data = await postMcpHostTokenIssue(recipeNamespace, recipeName, workflowControlScopes)
  if (
    typeof data.mcpHostAccessToken !== 'string' ||
    typeof data.mcpHostRefreshToken !== 'string' ||
    typeof data.mcpHostControlToken !== 'string'
  ) {
    throw new Error(
      `mcpHost credential response missing required fields for recipe "${recipeName}"`
    )
  }

  const accessTtl =
    typeof data.expiresInSeconds?.access === 'number' ? data.expiresInSeconds.access : 0
  const controlTtl =
    typeof data.expiresInSeconds?.control === 'number' ? data.expiresInSeconds.control : 0

  log.info(`Issued mcpHost credentials for recipe "${recipeName}"`, {
    recipeName,
    expiresInSeconds: accessTtl,
    controlExpiresInSeconds: controlTtl,
    workflowControlScopes,
  })

  return {
    accessToken: data.mcpHostAccessToken,
    refreshToken: data.mcpHostRefreshToken,
    mcpHostControlToken: data.mcpHostControlToken,
    expiresInSeconds: accessTtl,
    controlExpiresInSeconds: controlTtl,
  }
}
