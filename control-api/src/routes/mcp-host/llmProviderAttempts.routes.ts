import { type Request, type Response, Router } from 'express'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import type { K8sGateway } from '../../k8s.js'
import { requireMcpHostJwt } from '../../middleware/mcpHostJwtAuth.js'
import { rootLogger } from '../../observability/logger.js'
import {
  CODEX_CONNECTION_REF_ANNOTATION,
  readHostCodexConnectionRef,
} from '../../services/codexSubscriptionConnection.js'
import {
  LlmProviderAttemptAuthorizeError,
  authorizeLlmProviderAttempt,
} from '../../services/llmProviderAttemptAuthorizer.js'
import { llmProviderAttemptAuthorizeRateLimits } from '../workflows/shared/rateLimit.js'

const log = rootLogger.child({ module: 'mcp-host-llm-provider-attempts' })

const ERROR_STATUS: Record<string, number> = {
  disabled: 404,
  insufficient_scope: 403,
  no_grant: 403,
  model_not_allowed: 403,
  budget_denied: 403,
  connection_unavailable: 503,
  unassigned_connection: 403,
  host_binding_mismatch: 403,
  unknown_field: 400,
  invalid_request: 400,
  stale_generation: 409,
  idempotency_conflict: 409,
  provider_unavailable: 503,
}

function sendAuthorizeError(res: Response, err: unknown): void {
  if (err instanceof LlmProviderAttemptAuthorizeError) {
    const status = ERROR_STATUS[err.code] ?? 400
    log.warn({ event: 'codex_attempt_authorize_denied', code: err.code }, err.message)
    res.status(status).json({ error: err.code })
    return
  }
  throw err
}

export async function resolveHostAssignedConnectionKey(
  gateway: Pick<K8sGateway, 'getResource'>,
  hostRef: string
): Promise<string> {
  if (hostRef.includes('/')) {
    // Workflow callers attest as `namespace/recipeName`. The grant identity is
    // the `clerum.io/codex-connection-ref` annotation on that WorkflowRecipe
    // (WRC stamps the parent's chosen key onto DB-run children). Missing or
    // empty annotations resolve to the fail-closed `unassigned` sentinel.
    const [recipeNamespace, recipeName, ...rest] = hostRef.split('/')
    if (!recipeNamespace || !recipeName || rest.length > 0) {
      throw new LlmProviderAttemptAuthorizeError(
        'host_binding_mismatch',
        'Recipe assignment could not be attested'
      )
    }
    try {
      const recipe = (await gateway.getResource(
        'workflowrecipes',
        recipeName,
        recipeNamespace
      )) as { metadata?: { annotations?: Record<string, string> } }
      return readHostCodexConnectionRef(
        recipe?.metadata?.annotations?.[CODEX_CONNECTION_REF_ANNOTATION]
      )
    } catch {
      throw new LlmProviderAttemptAuthorizeError(
        'host_binding_mismatch',
        'Recipe assignment could not be attested'
      )
    }
  }
  try {
    const host = (await gateway.getResource('hosts', hostRef, config.hostsNamespace)) as {
      spec?: { model?: { connectionRef?: string } }
    }
    return readHostCodexConnectionRef(host?.spec?.model?.connectionRef)
  } catch {
    throw new LlmProviderAttemptAuthorizeError(
      'host_binding_mismatch',
      'Host assignment could not be attested'
    )
  }
}

export function createMcpHostLlmProviderAttemptRoutes(gateway: K8sGateway): Router {
  const router = Router()
  router.post(
    '/mcp-host/llm/provider-attempts/authorize',
    ...llmProviderAttemptAuthorizeRateLimits(),
    requireMcpHostJwt,
    asyncHandler(async (req: Request, res: Response) => {
      const claims = req.mcpHostJwt
      if (!claims) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      try {
        const result = await authorizeLlmProviderAttempt(claims, req.body, {
          resolveConnectionKey: hostRef => resolveHostAssignedConnectionKey(gateway, hostRef),
        })
        res.status(200).json(result)
      } catch (err) {
        sendAuthorizeError(res, err)
      }
    })
  )
  return router
}
