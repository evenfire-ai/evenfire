import { Router } from 'express'
import { asyncHandler } from '../../http/asyncHandler.js'
import { sendPublicApiError } from '../../http/publicApiError.js'
import type { K8sGateway } from '../../k8s.js'
import {
  type ExternalAuthedRequest,
  requireValidExternalSessionTokenWithPublicErrors,
} from '../../middleware/externalSessionAuth.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { aggregateAccessRequestsTotal } from '../../observability/metrics.js'
import {
  ACCESS_CATALOG_RESOURCE_TYPES,
  AccessCatalogAuthorityUnavailableError,
  AccessCatalogCapacityError,
  AccessCatalogCursorError,
  AccessCatalogInvalidSessionError,
  buildAccessCatalog,
  canonicalEnvironmentId,
} from '../../services/access/accessCatalog.js'
import { CAPABILITIES, isCapability } from '../../services/access/capabilityRegistry.js'
import {
  claimsToLiveAuthorizationIdentity,
  resolveLiveAuthorization,
} from '../../services/access/liveAuthorizationResolver.js'
import {
  RESOURCE_TYPES,
  type ResourceType,
  canonicalResourceIdentity,
} from '../../services/access/resourceIdentity.js'
import { userAccessRollout } from '../../services/access/userAccessRollout.js'

const resourceTypes = new Set<string>(RESOURCE_TYPES)
const catalogResourceTypes = new Set<string>(ACCESS_CATALOG_RESOURCE_TYPES)
const ACCESS_CATALOG_RATE_LIMIT_PER_MINUTE = 10
const ACCESS_RESOLVE_RATE_LIMIT_PER_MINUTE = 10
const MAX_RESOURCE_LOGICAL_ID_LENGTH = 512
const ACCESS_PATH_ID_PATTERN = /^ap1_[A-Za-z0-9_-]{43}$/

function catalogTypes(value: unknown): ResourceType[] | null {
  if (value === undefined) return []
  if (typeof value !== 'string') return null
  const values = [
    ...new Set(
      value
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
    ),
  ]
  if (!values.every(item => resourceTypes.has(item) && catalogResourceTypes.has(item))) return null
  return values as ResourceType[]
}

function pageLimit(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null
}

function boundedOperationTarget(
  value: unknown,
  requiredCapability: string
): Record<string, string> | null | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 0 || keys.length > 3) return null
  const allowedKeys = new Set(['teamId'])
  if (['team.member.read', 'team.member.manage'].includes(requiredCapability)) {
    allowedKeys.add('userId')
  }
  if (['team.member.invite', 'team.member.manage'].includes(requiredCapability)) {
    allowedKeys.add('role')
  }
  if (keys.some(key => !allowedKeys.has(key))) return null

  const normalized: Record<string, string> = {}
  for (const key of keys) {
    const item = record[key]
    if (typeof item !== 'string') return null
    const text = item.trim()
    if (!text || text.length > 128) return null
    normalized[key] = text
  }
  if (normalized.role && !['admin', 'inviter', 'member'].includes(normalized.role)) return null
  return normalized
}

export function createExternalAccessRouter(gateway: K8sGateway): Router {
  const router = Router()
  router.use('/external/access', requireValidExternalSessionTokenWithPublicErrors)

  router.get('/external/access/capabilities', (req: ExternalAuthedRequest, res) => {
    aggregateAccessRequestsTotal.inc({ operation: 'capabilities', result: 'success' }, 1)
    const claims = req.externalAuth!
    const currentV2 = claims.sessionContract === 'v2'
    res.status(200).json({
      contractVersion: '2',
      session: {
        v2Accepted: userAccessRollout.sessionV2Acceptance,
        v2Issued: userAccessRollout.sessionV2Issuance,
        issuanceMode: 'client_negotiated',
        currentContract: currentV2 ? 'v2' : 'v1',
      },
      aggregateCatalog: {
        shadow: userAccessRollout.aggregateCatalogShadowing,
        served: userAccessRollout.aggregateCatalogServing,
        contractVersion: '2',
        resourceTypes: ACCESS_CATALOG_RESOURCE_TYPES,
      },
      actionContext: { v2: userAccessRollout.actionContextV2 },
      rpcDelegation: { v2: userAccessRollout.rpcDelegationV2 },
      clientModes: {
        desktopV2: userAccessRollout.desktopAllTeamMode,
        profileV2: userAccessRollout.profileV2Mode,
      },
      compatibility: {
        legacyV1Accepted: userAccessRollout.legacyV1Acceptance,
        legacySwitchEndpoint: userAccessRollout.legacySwitchEndpoint,
        minimumClientVersion: userAccessRollout.minimumClientVersion,
      },
      capabilities: CAPABILITIES,
    })
  })

  const requireV2AccessContract = (
    gate: 'catalog' | 'action',
    req: ExternalAuthedRequest,
    res: Parameters<typeof sendPublicApiError>[1],
    next: () => void
  ) => {
    const enabled =
      gate === 'catalog'
        ? userAccessRollout.aggregateCatalogServing
        : userAccessRollout.actionContextV2
    if (req.externalAuth?.sessionContract !== 'v2' || !enabled) {
      sendPublicApiError(
        req,
        res,
        409,
        'invalid_request',
        'A user-session v2 login is required for this access contract.'
      )
      return
    }
    next()
  }

  router.get(
    '/external/access/catalog',
    (req, res, next) => requireV2AccessContract('catalog', req, res, next),
    rateLimitMiddleware({
      bucketType: 'external_access_catalog',
      maxPerMinute: ACCESS_CATALOG_RATE_LIMIT_PER_MINUTE,
      getBucketKey: req => {
        const userId = (req as ExternalAuthedRequest).externalAuth?.userId
        return userId ? `external_access_catalog:${userId}` : 'external_access_catalog:unknown'
      },
      onLimited: (req, res, retryAfterSeconds) => {
        sendPublicApiError(
          req,
          res,
          429,
          'rate_limited',
          'Too many access catalog requests; retry later.',
          true,
          { retryAfterSeconds }
        )
      },
    }),
    asyncHandler(async (req: ExternalAuthedRequest, res) => {
      const types = catalogTypes(req.query.types)
      const limit = pageLimit(req.query.limit)
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined
      if (types === null || limit === null || (req.query.cursor !== undefined && !cursor)) {
        sendPublicApiError(req, res, 400, 'invalid_request', 'Invalid catalog query.')
        return
      }
      try {
        const catalog = await buildAccessCatalog(
          req.externalAuth!,
          gateway,
          {
            ...(limit === undefined ? {} : { limit }),
            ...(cursor ? { cursor } : {}),
            ...(types.length ? { resourceTypes: types } : {}),
          },
          { correlationId: req.correlationId }
        )
        aggregateAccessRequestsTotal.inc(
          { operation: 'catalog', result: catalog.complete ? 'complete' : 'partial' },
          1
        )
        res.status(200).json(catalog)
      } catch (error) {
        if (error instanceof AccessCatalogCursorError) {
          aggregateAccessRequestsTotal.inc({ operation: 'catalog', result: error.code }, 1)
          const status = error.code === 'invalid_request' ? 400 : 409
          sendPublicApiError(
            req,
            res,
            status,
            error.code,
            error.code === 'invalid_request'
              ? 'Invalid catalog cursor.'
              : 'Catalog authorization changed; refresh from the first page.'
          )
          return
        }
        if (error instanceof AccessCatalogInvalidSessionError) {
          aggregateAccessRequestsTotal.inc({ operation: 'catalog', result: 'invalid_session' }, 1)
          sendPublicApiError(req, res, 401, 'invalid_session', 'The session is not valid.')
          return
        }
        if (
          error instanceof AccessCatalogAuthorityUnavailableError ||
          error instanceof AccessCatalogCapacityError
        ) {
          aggregateAccessRequestsTotal.inc(
            { operation: 'catalog', result: 'authority_unavailable' },
            1
          )
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
    })
  )

  router.post(
    '/external/access/resolve',
    (req, res, next) => requireV2AccessContract('action', req, res, next),
    rateLimitMiddleware({
      bucketType: 'external_access_resolve',
      maxPerMinute: ACCESS_RESOLVE_RATE_LIMIT_PER_MINUTE,
      getBucketKey: req => {
        const userId = (req as ExternalAuthedRequest).externalAuth?.userId
        return userId ? `external_access_resolve:${userId}` : 'external_access_resolve:unknown'
      },
      onLimited: (req, res, retryAfterSeconds) => {
        sendPublicApiError(
          req,
          res,
          429,
          'rate_limited',
          'Too many authorization requests; retry later.',
          true,
          { retryAfterSeconds }
        )
      },
    }),
    asyncHandler(async (req: ExternalAuthedRequest, res) => {
      const body = req.body as Record<string, unknown> | undefined
      const resource =
        body?.resource && typeof body.resource === 'object' && !Array.isArray(body.resource)
          ? (body.resource as Record<string, unknown>)
          : undefined
      const environmentId =
        typeof resource?.environmentId === 'string' ? resource.environmentId.trim() : ''
      const type = typeof resource?.type === 'string' ? resource.type.trim() : ''
      const canonicalPrefix = resourceTypes.has(type) ? `${type}:` : ''
      const logicalId =
        typeof resource?.logicalId === 'string'
          ? resource.logicalId.trim()
          : typeof resource?.id === 'string'
            ? (canonicalPrefix && resource.id.startsWith(canonicalPrefix)
                ? resource.id.slice(canonicalPrefix.length)
                : resource.id
              ).trim()
            : ''
      const requiredCapability =
        typeof body?.requiredCapability === 'string' ? body.requiredCapability.trim() : ''
      const requestedAccessPathId =
        typeof body?.accessPathId === 'string' ? body.accessPathId.trim() : undefined
      const operationTarget = boundedOperationTarget(body?.operationTarget, requiredCapability)
      if (
        !environmentId ||
        environmentId !== canonicalEnvironmentId() ||
        !resourceTypes.has(type) ||
        !logicalId ||
        logicalId.length > MAX_RESOURCE_LOGICAL_ID_LENGTH ||
        /[\u0000-\u001f\u007f]/.test(logicalId) ||
        !isCapability(requiredCapability) ||
        (body?.accessPathId !== undefined &&
          (!requestedAccessPathId || !ACCESS_PATH_ID_PATTERN.test(requestedAccessPathId))) ||
        operationTarget === null
      ) {
        sendPublicApiError(req, res, 400, 'invalid_request', 'Invalid authorization request.')
        return
      }
      const identity = claimsToLiveAuthorizationIdentity(req.externalAuth!)
      const result = await resolveLiveAuthorization(
        {
          ...identity,
          requiredCapability,
          resource: canonicalResourceIdentity({
            environmentId,
            type: type as ResourceType,
            logicalId,
            displayName: logicalId,
          }),
          ...(requestedAccessPathId ? { requestedAccessPathId } : {}),
          ...(operationTarget ? { operationTarget } : {}),
        },
        { correlationId: req.correlationId, gateway }
      )
      aggregateAccessRequestsTotal.inc({ operation: 'resolve', result: result.status }, 1)
      switch (result.status) {
        case 'allowed':
          res.status(200).json({
            status: 'allowed',
            effectiveCapabilities: result.effectiveCapabilities,
            paths: result.paths.map(path => ({
              accessPathId: path.id,
              kind: path.kind,
              ...(path.teamId ? { teamId: path.teamId } : {}),
            })),
            ...(result.selectedPath ? { selectedAccessPathId: result.selectedPath.id } : {}),
            authorizationRevision: result.authorizationRevision,
          })
          return
        case 'denied':
          sendPublicApiError(
            req,
            res,
            result.code === 'session_not_live' ? 401 : 403,
            result.code === 'session_not_live' ? 'invalid_session' : 'forbidden',
            result.code === 'session_not_live'
              ? 'The session is not valid.'
              : 'The requested operation is not allowed.'
          )
          return
        case 'not_found':
          sendPublicApiError(req, res, 404, 'not_found', 'The resource was not found.')
          return
        case 'access_path_required':
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
        case 'access_path_stale':
          sendPublicApiError(
            req,
            res,
            409,
            'access_path_stale',
            'The access path is stale; refresh access before retrying.'
          )
          return
        case 'unavailable':
          sendPublicApiError(
            req,
            res,
            503,
            'authority_unavailable',
            'Authorization is temporarily unavailable.',
            true
          )
      }
    })
  )

  return router
}
