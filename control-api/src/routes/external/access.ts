import { Router } from 'express'
import { asyncHandler } from '../../http/asyncHandler.js'
import { sendPublicApiError } from '../../http/publicApiError.js'
import type { K8sGateway } from '../../k8s.js'
import {
  type ExternalAuthedRequest,
  requireCompletedExternalSessionAuthenticationWithPublicErrors,
  requireExternalSessionLimiterIdentityWithPublicErrors,
} from '../../middleware/externalSessionAuth.js'
import {
  externalUserRateLimitOptions,
  requireAuthenticatedExternalUserRateLimitContext,
} from '../../middleware/externalUserRateLimitPolicy.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import {
  AccessCatalogRequestError,
  buildAccessCatalog,
} from '../../services/access/accessCatalogCoordinator.js'
import { AccessCatalogCursorError } from '../../services/access/accessCatalogCursor.js'
import {
  AccessBudgetExceededError,
  AccessExecutionBudget,
  AccessExecutionCancelledError,
} from '../../services/access/accessExecutionBudget.js'
import { isAccessCapability } from '../../services/access/capabilityRegistry.js'
import { CATALOG_FAMILIES, type CatalogFamily } from '../../services/access/catalogContracts.js'
import { resolveLiveAuthorization } from '../../services/access/liveAuthorizationResolver.js'
import { validateOperationTarget } from '../../services/access/operationTarget.js'
import { canonicalEnvironmentId } from '../../services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../../services/access/resourceIdentity.js'
import {
  configuredCatalogBudgetOptions,
  userAccessCapabilityManifest,
} from '../../services/access/userAccessPolicy.js'
import { resolveEffectiveUserAccessPolicy } from '../../services/access/userAccessRuntimePolicy.js'

const CATALOG_RATE_LIMIT_PER_MINUTE = 10
const RESOLVE_RATE_LIMIT_PER_MINUTE = 10
const ACCESS_PATH_PATTERN = /^ap1_[A-Za-z0-9_-]{43}$/

export function attachAccessExecutionBudget(
  req: ExternalAuthedRequest,
  res: Parameters<typeof sendPublicApiError>[1],
  next: () => void
): void {
  const kind = req.method === 'GET' && req.path.endsWith('/catalog') ? 'catalog' : 'action'
  const budget = AccessExecutionBudget.create(
    kind,
    kind === 'catalog' ? configuredCatalogBudgetOptions : undefined
  )
  req.accessExecutionBudget = budget
  let settled = false
  const detach = () => {
    req.removeListener('aborted', onAborted)
    res.removeListener('finish', onFinished)
    res.removeListener('close', onClosed)
  }
  const onAborted = () => budget.cancel()
  const onFinished = () => {
    if (settled) return
    settled = true
    detach()
    budget.close()
  }
  const onClosed = () => {
    if (settled) return
    settled = true
    if (!res.writableEnded) budget.cancel()
    detach()
    budget.close()
  }
  req.once('aborted', onAborted)
  res.once('finish', onFinished)
  res.once('close', onClosed)
  next()
}

function catalogFamilies(value: unknown): CatalogFamily[] | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return null
  const values = [
    ...new Set(
      value
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
    ),
  ]
  if (
    values.length === 0 ||
    values.some(value => !CATALOG_FAMILIES.includes(value as CatalogFamily))
  ) {
    return null
  }
  return CATALOG_FAMILIES.filter(family => values.includes(family))
}

function pageLimit(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null
}

async function requireEffectiveV2Contract(
  feature: 'catalog' | 'action',
  req: ExternalAuthedRequest,
  res: Parameters<typeof sendPublicApiError>[1],
  next: () => void
): Promise<void> {
  try {
    const policy = await resolveEffectiveUserAccessPolicy({ budget: req.accessExecutionBudget })
    const enabled = feature === 'catalog' ? policy.serveCatalog : policy.actionContextV2
    if (req.externalAuth?.sessionContract === 'v2' && enabled) {
      next()
      return
    }
    sendPublicApiError(
      req,
      res,
      409,
      'invalid_request',
      'This access contract is not enabled for the current session.'
    )
  } catch {
    sendPublicApiError(
      req,
      res,
      503,
      'authority_unavailable',
      'Access capability state is temporarily unavailable.',
      true
    )
  }
}

function sendCatalogError(
  req: ExternalAuthedRequest,
  res: Parameters<typeof sendPublicApiError>[1],
  error: unknown
): void {
  if (error instanceof AccessCatalogCursorError) {
    sendPublicApiError(
      req,
      res,
      error.code === 'invalid_cursor' ? 400 : 409,
      error.code === 'invalid_cursor' ? 'invalid_request' : 'conflict',
      error.code === 'invalid_cursor'
        ? 'The catalog cursor is not valid.'
        : 'Catalog access changed; refresh from the first page.'
    )
    return
  }
  if (error instanceof AccessCatalogRequestError && error.code === 'session_not_live') {
    sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
    return
  }
  if (error instanceof AccessCatalogRequestError && error.code === 'invalid_request') {
    sendPublicApiError(req, res, 400, 'invalid_request', 'The catalog request is not valid.')
    return
  }
  if (
    error instanceof AccessCatalogRequestError ||
    error instanceof AccessBudgetExceededError ||
    error instanceof AccessExecutionCancelledError
  ) {
    sendPublicApiError(
      req,
      res,
      503,
      'authority_unavailable',
      'Authorization is temporarily unavailable.',
      true
    )
    return
  }
  throw error
}

export function createExternalAccessRouter(gateway: K8sGateway): Router {
  const router = Router()
  router.use('/external/access', attachAccessExecutionBudget)

  router.get(
    '/external/access/capabilities',
    requireExternalSessionLimiterIdentityWithPublicErrors,
    requireAuthenticatedExternalUserRateLimitContext,
    rateLimitMiddleware(externalUserRateLimitOptions('access_capabilities', 'authenticated')),
    requireCompletedExternalSessionAuthenticationWithPublicErrors,
    asyncHandler(async (req: ExternalAuthedRequest, res) => {
      try {
        const policy = await resolveEffectiveUserAccessPolicy({ budget: req.accessExecutionBudget })
        res.status(200).json({
          contractVersion: '2',
          currentSessionContract: req.externalAuth!.sessionContract ?? 'v1',
          ...userAccessCapabilityManifest(policy),
        })
      } catch {
        sendPublicApiError(
          req,
          res,
          503,
          'authority_unavailable',
          'Access capability state is temporarily unavailable.',
          true
        )
      }
    })
  )

  router.get(
    '/external/access/catalog',
    requireExternalSessionLimiterIdentityWithPublicErrors,
    requireAuthenticatedExternalUserRateLimitContext,
    rateLimitMiddleware({
      bucketType: 'external_access_catalog',
      maxPerMinute: CATALOG_RATE_LIMIT_PER_MINUTE,
      getBucketKey: req =>
        `external_access_catalog:${(req as ExternalAuthedRequest).externalAuth!.userId}`,
      onLimited: (req, res, retryAfterSeconds) =>
        sendPublicApiError(
          req,
          res,
          429,
          'rate_limited',
          'Too many access catalog requests; retry later.',
          true,
          { retryAfterSeconds }
        ),
    }),
    requireCompletedExternalSessionAuthenticationWithPublicErrors,
    asyncHandler((req, res, next) => requireEffectiveV2Contract('catalog', req, res, next)),
    asyncHandler(async (req: ExternalAuthedRequest, res) => {
      const families = catalogFamilies(req.query.families)
      const limit = pageLimit(req.query.limit)
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined
      if (families === null || limit === null || (req.query.cursor !== undefined && !cursor)) {
        sendPublicApiError(req, res, 400, 'invalid_request', 'The catalog query is not valid.')
        return
      }
      try {
        const catalog = await buildAccessCatalog(
          {
            session: req.externalSessionAuthority!,
            ...(families ? { families } : {}),
            ...(limit ? { limit } : {}),
            ...(cursor ? { cursor } : {}),
          },
          { budget: req.accessExecutionBudget! }
        )
        res.status(200).json(catalog)
      } catch (error) {
        sendCatalogError(req, res, error)
      }
    })
  )

  router.post(
    '/external/access/resolve',
    requireExternalSessionLimiterIdentityWithPublicErrors,
    requireAuthenticatedExternalUserRateLimitContext,
    rateLimitMiddleware({
      bucketType: 'external_access_resolve',
      maxPerMinute: RESOLVE_RATE_LIMIT_PER_MINUTE,
      getBucketKey: req =>
        `external_access_resolve:${(req as ExternalAuthedRequest).externalAuth!.userId}`,
      onLimited: (req, res, retryAfterSeconds) =>
        sendPublicApiError(
          req,
          res,
          429,
          'rate_limited',
          'Too many authorization requests; retry later.',
          true,
          { retryAfterSeconds }
        ),
    }),
    requireCompletedExternalSessionAuthenticationWithPublicErrors,
    asyncHandler((req, res, next) => requireEffectiveV2Contract('action', req, res, next)),
    asyncHandler(async (req: ExternalAuthedRequest, res) => {
      const body = req.body as Record<string, unknown> | undefined
      const rawResource =
        body?.resource && typeof body.resource === 'object' && !Array.isArray(body.resource)
          ? (body.resource as Record<string, unknown>)
          : null
      const capability = typeof body?.requiredCapability === 'string' ? body.requiredCapability : ''
      const accessPathId = typeof body?.accessPathId === 'string' ? body.accessPathId : undefined
      let resource
      try {
        resource = canonicalResourceIdentity({
          environmentId: rawResource?.environmentId,
          type: rawResource?.type,
          logicalId: rawResource?.logicalId,
          displayName: rawResource?.logicalId,
        })
      } catch {
        resource = null
      }
      if (
        !resource ||
        resource.environmentId !== canonicalEnvironmentId() ||
        !isAccessCapability(capability) ||
        (accessPathId !== undefined && !ACCESS_PATH_PATTERN.test(accessPathId))
      ) {
        sendPublicApiError(
          req,
          res,
          400,
          'invalid_request',
          'The authorization request is invalid.'
        )
        return
      }
      let target
      try {
        target = validateOperationTarget({
          capability,
          resource,
          operationTarget: body?.operationTarget,
        })
      } catch {
        sendPublicApiError(
          req,
          res,
          400,
          'invalid_request',
          'The authorization request is invalid.'
        )
        return
      }
      const result = await resolveLiveAuthorization(
        {
          session: req.externalSessionAuthority!,
          requiredCapability: capability,
          resource,
          ...(accessPathId ? { requestedAccessPathId: accessPathId } : {}),
          ...(target ? { operationTarget: target } : {}),
        },
        {
          gateway,
          correlationId: req.correlationId,
          budget: req.accessExecutionBudget!,
        }
      )
      if (result.status === 'allowed') {
        res.status(200).json({
          status: result.status,
          effectiveCapabilities: result.effectiveCapabilities,
          paths: result.paths.map(path => ({
            accessPathId: path.id,
            kind: path.kind,
            ...(path.teamId ? { teamId: path.teamId } : {}),
          })),
          selectedAccessPathId: result.selectedPath.id,
          authorizationRevision: result.authorizationRevision,
        })
        return
      }
      if (result.status === 'access_path_required') {
        sendPublicApiError(
          req,
          res,
          409,
          'access_path_required',
          'Choose an access path for this operation.',
          false,
          { paths: result.safePathDescriptors }
        )
        return
      }
      if (result.status === 'access_path_stale') {
        sendPublicApiError(
          req,
          res,
          409,
          'access_path_stale',
          'The access path is stale; refresh access before retrying.'
        )
        return
      }
      if (result.status === 'unavailable') {
        sendPublicApiError(
          req,
          res,
          503,
          'authority_unavailable',
          'Authorization is temporarily unavailable.',
          true
        )
        return
      }
      if (result.status === 'not_found') {
        sendPublicApiError(req, res, 404, 'not_found', 'The resource was not found.')
        return
      }
      sendPublicApiError(
        req,
        res,
        result.status === 'invalid' ? 400 : result.code === 'session_not_live' ? 401 : 403,
        result.status === 'invalid'
          ? 'invalid_request'
          : result.code === 'session_not_live'
            ? 'invalid_session'
            : 'forbidden',
        result.status === 'invalid'
          ? 'The authorization request is invalid.'
          : result.code === 'session_not_live'
            ? 'The session is not valid.'
            : 'The requested operation is not allowed.'
      )
    })
  )

  return router
}
