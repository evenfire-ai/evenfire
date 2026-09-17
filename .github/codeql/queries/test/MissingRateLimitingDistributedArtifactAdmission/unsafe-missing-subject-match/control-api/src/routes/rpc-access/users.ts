import { Router } from 'express'
import { config } from '../../config.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import {
  requireRpcTokenHostMatch,
  requireRpcTokenUserMatch,
  requireValidRpcAccessTokenAny,
} from '../../middleware/rpcAccessAuth.js'
import { authorizeRpcHostAccess } from '../../services/access/rpcHostAccessAuthorizer.js'

type ArtifactRequest = {
  params: { userId: string; hostRef: string }
  rpcAuth?: { sub?: string }
  artifactReadConnection?: { hostRef: string }
}

async function resolveAuthorizedHostConnection(
  req: ArtifactRequest,
  _res: unknown,
  gateway: unknown,
  directory: unknown,
): Promise<{ hostRef: string } | null> {
  const userId = String(req.params.userId || '').trim()
  const hostRef = String(req.params.hostRef || '').trim()
  const claims = req.rpcAuth
  if (!claims) return null
  const authorization = await authorizeRpcHostAccess(gateway, claims, userId, hostRef, directory)
  if (!authorization.authorized) return null
  return authorization.connection
}

export function createRpcAccessUsersRouter(gateway: unknown, options: { directory?: unknown }) {
  const router = Router()
  const { directory } = options
  const hostAccessPath = '/rpc/access/users/:userId/mcp-hosts/:hostRef'
  router.get(
    `${hostAccessPath}/artifact-read`,
    requireValidRpcAccessTokenAny(['host:task:read']),
    (_req, _res, next) => next(),
    requireRpcTokenHostMatch(),
    rateLimitMiddleware({
      bucketType: 'host_artifact_pre_admission',
      maxPerMinute: config.hostArtifactReadRlPerMin,
      getBucketKey: req => {
        const subject = (req as ArtifactRequest).rpcAuth?.sub
        return subject ? `host-artifact-pre-admission:${subject}` : null
      },
    }),
    async (req: ArtifactRequest, res, next) => {
      try {
        const connection = await resolveAuthorizedHostConnection(req, res, gateway, directory)
        if (!connection) return
        req.artifactReadConnection = connection
        next()
      } catch (error) {
        next(error)
      }
    },
    rateLimitMiddleware({
      bucketType: 'host_artifact_read',
      maxPerMinute: config.hostArtifactReadRlPerMin,
      getBucketKey: req => {
        const artifactRead = req as ArtifactRequest
        const subject = artifactRead.rpcAuth?.sub
        const hostRef = artifactRead.artifactReadConnection?.hostRef
        return subject && hostRef ? `host-artifact-read:${subject}:${hostRef}` : null
      },
    }),
    (_req, res) => res.status(200).json({ ok: true }),
  )
  return router
}
