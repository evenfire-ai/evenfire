import { Request } from 'express'
import { createHash } from 'node:crypto'
import { rateLimitMiddleware } from '../../../middleware/rateLimitMiddleware.js'
import { extractBearerToken } from '../../../utils/extractBearerToken.js'

export function workflowTriggerRateLimit() {
  return rateLimitMiddleware({
    bucketType: 'workflow_trigger',
    maxPerMinute: 10,
    getBucketKey: (req: Request) => {
      const bearer = extractBearerToken(req)
      const userSessionToken = req.header('x-user-session-token')
      const token = bearer || userSessionToken
      if (!token) return null
      const hash = createHash('sha256').update(token).digest('hex').slice(0, 32)
      return `workflow_trigger:${hash}`
    },
  })
}

export function workflowGrantReadRateLimit() {
  return rateLimitMiddleware({
    bucketType: 'workflow_grants_read',
    maxPerMinute: 60,
    getBucketKey: hashedBearerBucket('workflow_grants_read'),
  })
}

export function workflowGrantWriteRateLimit() {
  return rateLimitMiddleware({
    bucketType: 'workflow_grants_write',
    maxPerMinute: 20,
    getBucketKey: hashedBearerBucket('workflow_grants_write'),
  })
}

function hashedBearerBucket(prefix: string) {
  return (req: Request): string | null => {
    const bearer = extractBearerToken(req)
    if (!bearer) return null
    const hash = createHash('sha256').update(bearer).digest('hex').slice(0, 32)
    return `${prefix}:${hash}`
  }
}
