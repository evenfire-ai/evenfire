import * as fs from 'node:fs'
import { config } from '../config'
import { loadPersistedRuntimeAuth, persistRuntimeAuthTokens } from './mcpHostJwtState'
import { getJwtRuntimeBinding } from './mcpHostRuntimeJwt'
import { type McpHostRuntimeAuth, type ReIssuedTokenPair } from './userApprovalRequester'

/**
 * Timeout for the recovery /workflow-auth/reissue HTTP call. Kept short:
 * the client has already burned its refresh retry budget, so a hung server
 * should fail fast rather than extend the workflow stall further.
 */
const REISSUE_FETCH_TIMEOUT_MS = 10_000

export type ReIssueRuntimeBinding =
  | { kind: 'workflow'; recipeName: string }
  | { kind: 'standalone_host'; hostRef: string }

function workflowBindingRef(recipeNamespace: string, recipeName: string): string {
  return `${recipeNamespace}/${recipeName}`
}

function reIssueRequestBody(binding: ReIssueRuntimeBinding): Record<string, string> {
  if (binding.kind === 'standalone_host') {
    return { host_ref: binding.hostRef }
  }
  return { recipe_name: binding.recipeName }
}

function getReIssueRuntimeBinding(auth: McpHostRuntimeAuth): ReIssueRuntimeBinding {
  const workflowHostRef = workflowBindingRef(auth.recipeNamespace, auth.recipeName)
  if (auth.hostRef === workflowHostRef) {
    const recipeName =
      config.userApprovalRequestRecipeName || config.workflowRecipeName || auth.recipeName
    return { kind: 'workflow', recipeName }
  }

  return { kind: 'standalone_host', hostRef: auth.hostRef }
}

/**
 * Factory producing the reIssueTokens callback wired to control-api's
 * POST /api/v1/workflow-auth/reissue endpoint.
 *
 * The endpoint name is historical. The body is intentionally binding-specific:
 * workflow pods prove the recipe binding, while HCC-managed standalone hosts
 * prove hostRefs[0]. Standalone hostRefs are not WorkflowRecipe names.
 */
export function createReIssueTokensCallback(
  authRef: { accessToken: string; refreshToken: string; baseUrl: string },
  binding: ReIssueRuntimeBinding
): () => Promise<ReIssuedTokenPair> {
  return async function reIssueTokens(): Promise<ReIssuedTokenPair> {
    const url = `${authRef.baseUrl}/api/v1/workflow-auth/reissue`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REISSUE_FETCH_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Send the CURRENT refresh token at call-time — not one captured
          // at wiring time — so a prior rotate inside the same recovery
          // cycle is honoured.
          Authorization: `Bearer ${authRef.refreshToken}`,
        },
        body: JSON.stringify(reIssueRequestBody(binding)),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`reIssueTokens fetch failed: ${message}`)
    }
    clearTimeout(timer)

    if (res.status === 401) {
      // Opaque on the server; signal to upstream layers that retrying
      // is pointless because either the signature is wrong or the jti
      // is already burned.
      throw new Error('reIssueTokens: unauthorized (401)')
    }

    if (!res.ok) {
      throw new Error(`reIssueTokens failed (${res.status})`)
    }

    const data = (await res.json()) as {
      accessToken?: unknown
      refreshToken?: unknown
      mcpHostControlToken?: unknown
    }
    if (typeof data.accessToken !== 'string' || typeof data.refreshToken !== 'string') {
      throw new Error('reIssueTokens response missing accessToken or refreshToken')
    }
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      ...(typeof data.mcpHostControlToken === 'string'
        ? { mcpHostControlToken: data.mcpHostControlToken }
        : {}),
    }
  }
}

export function createMcpHostRuntimeAuthFromValues(params: {
  accessToken: string
  refreshToken: string
  baseUrl: string
  mcpHostControlToken?: string
}): McpHostRuntimeAuth {
  const binding = getJwtRuntimeBinding(params.accessToken)
  if (!binding) {
    throw new Error(
      'MCP_HOST_RUNTIME_ACCESS_TOKEN must include hostRefs[0], recipeNamespace, and recipeName'
    )
  }

  const auth = loadPersistedRuntimeAuth({
    accessToken: params.accessToken,
    refreshToken: params.refreshToken,
    baseUrl: params.baseUrl,
    ...(params.mcpHostControlToken ? { mcpHostControlToken: params.mcpHostControlToken } : {}),
    ...binding,
    persistRotatedTokens: async ({ accessToken, refreshToken, mcpHostControlToken }) => {
      await persistRuntimeAuthTokens({ accessToken, refreshToken, mcpHostControlToken })
    },
  })

  auth.reIssueTokens = createReIssueTokensCallback(auth, getReIssueRuntimeBinding(auth))

  return auth
}

function workflowControlTokenFromConfig(): string | undefined {
  const inlineToken = config.mcpHostWorkflowControlToken?.trim()
  if (inlineToken) return inlineToken

  const tokenFile = config.mcpHostWorkflowControlTokenFile?.trim()
  if (!tokenFile) return undefined

  try {
    const fileToken = fs.readFileSync(tokenFile, 'utf8').trim()
    return fileToken || undefined
  } catch (err) {
    console.warn(
      '[RuntimeAuthFactory] Could not read workflow control token file; continuing without it.',
      err instanceof Error ? err.message : String(err)
    )
    return undefined
  }
}

/**
 * Build an McpHostRuntimeAuth wired to the per-host MCP_HOST_RUNTIME_* token Secret.
 *
 * Returns null when the runtime-token env vars are absent (dev mode without
 * HCC/WRC). Callers MUST treat null as "auth disabled" rather than a hard
 * failure — features that need auth (workflow approvals, usage reporting)
 * decide their own response.
 *
 * The same instance should be passed to every consumer (WorkflowService and
 * UsageReporter) so refresh-on-401 mutates a single shared `accessToken` and
 * both call paths see the rotated value.
 */
export function createMcpHostRuntimeAuth(): McpHostRuntimeAuth | null {
  if (
    !config.mcpHostRuntimeAccessToken ||
    !config.mcpHostRuntimeRefreshToken ||
    !config.mcpHostGatewayUrl
  ) {
    return null
  }

  const controlCredential = workflowControlTokenFromConfig()

  return createMcpHostRuntimeAuthFromValues({
    accessToken: config.mcpHostRuntimeAccessToken,
    refreshToken: config.mcpHostRuntimeRefreshToken,
    baseUrl: config.mcpHostGatewayUrl,
    ...(config.mcpHostWorkflowControlToken
      ? { mcpHostControlToken: config.mcpHostWorkflowControlToken }
      : {}),
    ...(controlCredential ? { mcpHostControlToken: controlCredential } : {}),
  })
}
