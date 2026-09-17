import { Router } from 'express'
import { config } from '../../config.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import {
  requireRpcTokenHostMatch,
  requireRpcTokenUserMatch,
  requireValidRpcAccessTokenAny,
} from '../../middleware/rpcAccessAuth.js'

type ArtifactRequest = { rpcAuth?: { sub?: string }; artifactReadConnection?: { hostRef: string } }

declare function resolveAuthorizedHostConnection(req: ArtifactRequest): Promise<{ hostRef: string }>

export function createRpcAccessUsersRouter() {
  const router = Router()
  const hostAccessPath = '/rpc/access/users/:userId/mcp-hosts/:hostRef'
  router.get(
    `${hostAccessPath}/artifact-read`,
    requireValidRpcAccessTokenAny(['host:task:read']),
    requireRpcTokenUserMatch(),
    requireRpcTokenHostMatch(),
    rateLimitMiddleware({
      bucketType: 'host_artifact_pre_admission',
      maxPerMinute: config.hostArtifactReadRlPerMin,
      getBucketKey: req => {
        const subject = (req as ArtifactRequest).rpcAuth?.sub
        return subject ? `host-artifact-pre-admission:${subject}` : null
      },
    }),
    async (req: ArtifactRequest, _res, next) => {
      req.artifactReadConnection = await resolveAuthorizedHostConnection(req)
      next()
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
