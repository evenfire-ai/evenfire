import express, { type NextFunction, type Request, type Response, Router } from 'express'
import type { IncomingHttpHeaders } from 'node:http'
import {
  BODY_STRUCTURE_LIMITS as GROK_BODY_STRUCTURE_LIMITS,
  ENVELOPE_ALLOWANCE_BYTES as GROK_ENVELOPE_ALLOWANCE_BYTES,
  LIMITS as GROK_LIMITS,
} from '@clerum/grok-provider-attempt-contract'
import {
  BODY_STRUCTURE_LIMITS,
  ENVELOPE_ALLOWANCE_BYTES,
  LIMITS,
  createBodyStructureVerify,
} from '@clerum/llm-provider-attempt-contract'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import type { K8sGateway } from '../../k8s.js'
import { LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY } from '../../middleware/llmProviderAttemptAdmissionLimits.js'
import {
  AuthorizeBodyAdmission,
  AuthorizeWorkInterrupted,
} from '../../middleware/llmProviderAttemptBodyAdmission.js'
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
} from '../../services/subscriptionGrantIdentity.js'
import { llmProviderAttemptAuthorizeRateLimits } from '../workflows/shared/rateLimit.js'

const LOG_MODULE = 'mcp-host-llm-provider-attempts'
const log = rootLogger.child({ module: LOG_MODULE })

// Retained bodies belong to the Node process, including when multiple apps or
// routers are constructed. A per-router owner would multiply the allowance.
const authorizeBodyAdmission = new AuthorizeBodyAdmission(LLM_PROVIDER_ATTEMPT_ADMISSION_POLICY)

// JSON.parse allocates one heap object per container, so a body under
// the byte limit can exhaust the heap before either authorizer runs. The
// parser scans the raw bytes first. The five supported scan bounds below are
// merged key-by-key at the larger contract value, so the scan refuses no body
// either authorizer accepts. Adding a contract bound also requires updating
// the raw scanners and their supported-key guard; merging a value alone does
// not implement its enforcement.
type MergedBodyStructureLimits = Readonly<
  Record<keyof typeof BODY_STRUCTURE_LIMITS | keyof typeof GROK_BODY_STRUCTURE_LIMITS, number>
>

export function mergeBodyStructureLimits(
  ...contracts: ReadonlyArray<Readonly<Record<string, number>>>
): MergedBodyStructureLimits {
  const merged: Record<string, number> = {}
  for (const limits of contracts) {
    for (const [key, value] of Object.entries(limits)) {
      merged[key] = Math.max(merged[key] ?? value, value)
    }
  }
  return Object.freeze(merged) as MergedBodyStructureLimits
}

export const MCP_HOST_BODY_STRUCTURE_LIMITS = mergeBodyStructureLimits(
  BODY_STRUCTURE_LIMITS,
  GROK_BODY_STRUCTURE_LIMITS
)
const verifyBodyStructure = createBodyStructureVerify(MCP_HOST_BODY_STRUCTURE_LIMITS)

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
  payload_too_large: 413,
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

export async function resolveHostAssignedAssignment(
  gateway: Pick<K8sGateway, 'getResource'>,
  hostRef: string,
  signal?: AbortSignal
): Promise<LiveBrokerAssignment> {
  signal?.throwIfAborted()
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
        recipeNamespace,
        signal
      )) as { metadata?: { annotations?: Record<string, string> }; spec?: Record<string, unknown> }
      signal?.throwIfAborted()
      const spec = recipe?.spec && typeof recipe.spec === 'object' ? recipe.spec : {}
      const liveBrokerProviders = collectRecipeOauthBrokerProviders(spec)
      return {
        liveBrokerProviders,
        liveConnectionRef: CODEX_UNASSIGNED_CONNECTION_KEY,
        annotations: recipe?.metadata?.annotations,
      }
    } catch (err) {
      signal?.throwIfAborted()
      if (err instanceof LlmProviderAttemptAuthorizeError) throw err
      throw new LlmProviderAttemptAuthorizeError(
        'host_binding_mismatch',
        'Recipe assignment could not be attested'
      )
    }
  }
  try {
    const host = (await gateway.getResource('hosts', hostRef, config.hostsNamespace, signal)) as {
      spec?: Record<string, unknown>
    }
    signal?.throwIfAborted()
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
    signal?.throwIfAborted()
    if (err instanceof LlmProviderAttemptAuthorizeError) throw err
    throw new LlmProviderAttemptAuthorizeError(
      'host_binding_mismatch',
      'Host assignment could not be attested'
    )
  }
}

// The text authorize envelope: the non-image request budget plus the envelope
// allowance, the same cap each contract's structural scan uses.
export const AUTHORIZE_TEXT_BODY_BYTES = Math.max(
  LIMITS.maxRequestBodyBytes + ENVELOPE_ALLOWANCE_BYTES,
  GROK_LIMITS.maxRequestBodyBytes + GROK_ENVELOPE_ALLOWANCE_BYTES
)

export type AuthorizeBudget = 'ordinary' | 'retained'

// Node frames a body at exactly its Content-Length, and the ordinary parser
// refuses a declared length above its limit before reading, so a declared
// length at or below the text envelope bounds what the request can retain.
// Only those requests skip the retained-body unit. Chunked bodies and lengths
// that are not plain digits take the retained path, so a framing the bound
// cannot read fails closed. A request with neither header has no body.
export function selectAuthorizeBudget(headers: IncomingHttpHeaders): AuthorizeBudget {
  if (headers['transfer-encoding'] !== undefined) return 'retained'
  const declared = headers['content-length']
  if (declared === undefined) return 'ordinary'
  if (!/^\d+$/.test(declared)) return 'retained'
  return Number(declared) <= AUTHORIZE_TEXT_BODY_BYTES ? 'ordinary' : 'retained'
}

export function createMcpHostLlmProviderAttemptRoutes(gateway: K8sGateway): Router {
  const router = Router()
  // Shared by both providers: preserve the larger visual envelope (Codex
  // #660, Grok #784) and each authorizer's provider-specific limit. Refuse
  // encoded bodies and scan raw structure before JSON.parse allocates objects.
  const retainedBodyParser = express.json({
    limit: Math.max(LIMITS.maxVisualRequestBodyBytes, GROK_LIMITS.maxVisualRequestBodyBytes),
    inflate: false,
    verify: verifyBodyStructure,
  })
  const ordinaryBodyParser = express.json({
    limit: AUTHORIZE_TEXT_BODY_BYTES,
    inflate: false,
    verify: verifyBodyStructure,
  })
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
      const work = async (signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted()
        const result = await authorizeLlmProviderAttempt(claims, req.body, {
          signal,
          resolveAssignment: hostRef => resolveHostAssignedAssignment(gateway, hostRef, signal),
        })
        signal.throwIfAborted()
        res.status(200).json(result)
      }
      try {
        if (selectAuthorizeBudget(req.headers) === 'ordinary') {
          await authorizeBodyAdmission.runUncharged(req, res, ordinaryBodyParser, work)
        } else {
          await authorizeBodyAdmission.run(req, res, retainedBodyParser, work, claims)
        }
      } catch (err) {
        if (err instanceof AuthorizeWorkInterrupted) {
          // A closed transport only requests cancellation. run() has awaited
          // dependency/transaction cleanup before ownership reaches this catch.
          if (req.aborted || res.destroyed || res.writableEnded) return
          const requestLog = req.log?.child({ module: LOG_MODULE }) ?? log
          requestLog.warn({ event: 'llm_provider_attempt_authorize_interrupted', code: err.code })
          res.status(503).json({ error: 'authorize_timeout' })
          return
        }
        sendAuthorizeError(res, err)
      }
    })
  )
  // The size, structure, depth, charset, encoding and JSON.parse errors are
  // answered here, because body-parser attaches the raw body to them as
  // `err.body` and the global error handler would parse it again. The other
  // parser errors (`request.aborted`, `request.size.invalid`, `stream.*`)
  // carry no body and go to the global handler, which logs no body. The log
  // carries only the fixed parser `type` and the status: `err.message` of a
  // JSON.parse error can quote a fragment of the body. It goes through the
  // request-scoped logger when there is one, so it keeps the correlationId;
  // that logger lacks this route's module binding, so it is added back.
  router.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    const typed = err as { type?: string; status?: number }
    const requestLog = req.log?.child({ module: LOG_MODULE }) ?? log
    const refuse = (status: number, error: string): void => {
      requestLog.warn({ event: 'llm_provider_attempt_body_refused', type: typed.type, status })
      res.status(status).json({ error })
    }
    if (typed.type === 'entity.too.large' || typed.status === 413) {
      refuse(413, 'payload_too_large')
      return
    }
    if (typed.type === 'encoding.unsupported' || typed.type === 'charset.unsupported') {
      refuse(415, 'unsupported_media_type')
      return
    }
    if (typed.type === 'entity.parse.failed' || typed.type === 'body.structure.too.deep') {
      refuse(400, 'invalid_request')
      return
    }
    next(err)
  })
  return router
}
