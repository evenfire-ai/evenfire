import { type Request, type Response, Router } from 'express'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import type { K8sGateway } from '../../k8s.js'
import { requireMcpHostJwt } from '../../middleware/mcpHostJwtAuth.js'
import { rootLogger } from '../../observability/logger.js'
import {
  CODEX_UNASSIGNED_CONNECTION_KEY,
  readHostCodexConnectionRef,
} from '../../services/codexSubscriptionConnection.js'
import {
  LlmProviderAttemptAuthorizeError,
  authorizeLlmProviderAttempt,
} from '../../services/llmProviderAttemptAuthorizer.js'
import {
  collectHostOauthBrokerProviders,
  collectRecipeOauthBrokerProviders,
  readSubscriptionConnectionRef,
} from '../../services/subscriptionGrantIdentity.js'
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

export type LiveBrokerAssignment = {
  liveBrokerProviders: string[]
  liveConnectionRef: string
  annotations?: Record<string, string>
}

function throwAttestError(result: { ok: false; code: string; message: string }): never {
  throw new LlmProviderAttemptAuthorizeError(
    result.code as 'host_binding_mismatch' | 'unassigned_connection',
    result.message
  )
}

export async function resolveHostAssignedAssignment(
  gateway: Pick<K8sGateway, 'getResource'>,
  hostRef: string
): Promise<LiveBrokerAssignment> {
  if (hostRef.includes('/')) {
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
      )) as { metadata?: { annotations?: Record<string, string> }; spec?: Record<string, unknown> }
      const spec = recipe?.spec && typeof recipe.spec === 'object' ? recipe.spec : {}
      const liveBrokerProviders = collectRecipeOauthBrokerProviders(spec)
      return {
        liveBrokerProviders,
        liveConnectionRef: CODEX_UNASSIGNED_CONNECTION_KEY,
        annotations: recipe?.metadata?.annotations,
      }
    } catch (err) {
      if (err instanceof LlmProviderAttemptAuthorizeError) throw err
      throw new LlmProviderAttemptAuthorizeError(
        'host_binding_mismatch',
        'Recipe assignment could not be attested'
      )
    }
  }
  try {
    const host = (await gateway.getResource('hosts', hostRef, config.hostsNamespace)) as {
      spec?: Record<string, unknown>
    }
    const spec = host?.spec && typeof host.spec === 'object' ? host.spec : {}
    const model = spec.model
    const connectionRef =
      model && typeof model === 'object' && !Array.isArray(model)
        ? (model as { connectionRef?: string }).connectionRef
        : undefined
    return {
      liveBrokerProviders: collectHostOauthBrokerProviders(spec),
      liveConnectionRef: readHostCodexConnectionRef(connectionRef),
    }
  } catch (err) {
    if (err instanceof LlmProviderAttemptAuthorizeError) throw err
    throw new LlmProviderAttemptAuthorizeError(
      'host_binding_mismatch',
      'Host assignment could not be attested'
    )
  }
}

export async function resolveHostAssignedConnectionKey(
  gateway: Pick<K8sGateway, 'getResource'>,
  hostRef: string
): Promise<string> {
  const assignment = await resolveHostAssignedAssignment(gateway, hostRef)
  if (!assignment.annotations) return assignment.liveConnectionRef
  const read = readSubscriptionConnectionRef({
    provider: assignment.liveBrokerProviders[0] ?? 'codex-subscription',
    annotations: assignment.annotations,
  })
  if (!read.ok) throwAttestError(read)
  return read.connectionKey
}

export function createMcpHostLlmProviderAttemptRoutes(gateway: K8sGateway): Router {
  const router = Router()
  router.post(
    '/mcp-host/llm/provider-attempts/authorize',
    requireMcpHostJwt,
    ...llmProviderAttemptAuthorizeRateLimits(),
    asyncHandler(async (req: Request, res: Response) => {
      const claims = req.mcpHostJwt
      if (!claims) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      try {
        const result = await authorizeLlmProviderAttempt(claims, req.body, {
          resolveConnectionKey: hostRef => resolveHostAssignedConnectionKey(gateway, hostRef),
          resolveAssignment: hostRef => resolveHostAssignedAssignment(gateway, hostRef),
        })
        res.status(200).json(result)
      } catch (err) {
        sendAuthorizeError(res, err)
      }
    })
  )
  return router
}
