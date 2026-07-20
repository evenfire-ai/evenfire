import { type Request, Router } from 'express'
import type {
  GovernedTraceOrigin,
  GovernedTraceSessionDetailV1,
  GovernedTraceSessionPageV1,
} from '../../../services/tracing/contracts.js'
import type { SessionReplayFilters } from '../../../services/tracing/postgresGovernedSessionReplayRepository.js'

const ORIGINS = new Set<GovernedTraceOrigin>([
  'direct_chat',
  'workflow_runtime',
  'channel_event',
  'api',
])
const APPROVAL_STATES = new Set(['requested', 'approved', 'denied'])
const RUN_OUTCOMES = new Set([
  'started',
  'succeeded',
  'failed',
  'cancelled',
  'approved',
  'denied',
  'unknown',
])
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface GovernedSessionReplayReader {
  list(input: {
    filters: SessionReplayFilters
    cursor?: string
    limit: number
  }): Promise<GovernedTraceSessionPageV1>
  detail(input: {
    hostRef: string
    sessionId: string
    cursor?: string
    limit: number
  }): Promise<GovernedTraceSessionDetailV1 | null>
}

function one(req: Request, key: string): string | undefined {
  const value = req.query[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a single string`)
  return value
}

function list(req: Request, key: string, max = 256): string[] {
  const raw = one(req, key)
  if (!raw) return []
  const values = [...new Set(raw.split(',').map(value => value.trim()))].sort()
  if (
    values.length > 20 ||
    values.some(value => !value || value.length > max || value.includes('\0'))
  ) {
    throw new Error(`${key} is invalid`)
  }
  return values
}

function paging(req: Request): { cursor?: string; limit: number } {
  const cursor = one(req, 'cursor')
  const rawLimit = one(req, 'limit')
  const limit = rawLimit === undefined ? 50 : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || (cursor && cursor.length > 4096)) {
    throw new Error('invalid pagination')
  }
  return { ...(cursor ? { cursor } : {}), limit }
}

function parseFilters(req: Request): SessionReplayFilters {
  const allowed = new Set([
    'occurredFrom',
    'occurredTo',
    'outcome',
    'sourceService',
    'limit',
    'cursor',
    'sessionId',
    'hostRef',
    'humanUserId',
    'agentSub',
    'origin',
    'toolName',
    'approvalState',
  ])
  const unexpected = Object.keys(req.query).find(key => !allowed.has(key))
  if (unexpected) throw new Error(`unsupported query parameter: ${unexpected}`)
  const fromRaw = one(req, 'occurredFrom')
  const toRaw = one(req, 'occurredTo')
  if (!fromRaw || !toRaw) throw new Error('occurredFrom and occurredTo are required')
  const from = new Date(fromRaw)
  const to = new Date(toRaw)
  if (
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    from >= to ||
    to.getTime() - from.getTime() > MAX_WINDOW_MS
  )
    throw new Error('invalid time window')
  const origin = list(req, 'origin', 32)
  const approvalState = list(req, 'approvalState', 32)
  const outcome = list(req, 'outcome', 32)
  if (
    origin.some(value => !ORIGINS.has(value as GovernedTraceOrigin)) ||
    approvalState.some(value => !APPROVAL_STATES.has(value)) ||
    outcome.some(value => !RUN_OUTCOMES.has(value))
  )
    throw new Error('invalid enum filter')
  const humanUserId = list(req, 'humanUserId', 36)
  if (humanUserId.some(value => !UUID_RE.test(value))) throw new Error('invalid humanUserId filter')
  return {
    occurredFrom: from.toISOString(),
    occurredTo: to.toISOString(),
    outcome,
    sourceService: list(req, 'sourceService', 128),
    sessionId: list(req, 'sessionId'),
    hostRef: list(req, 'hostRef'),
    humanUserId,
    agentSub: list(req, 'agentSub'),
    origin: origin as GovernedTraceOrigin[],
    toolName: list(req, 'toolName'),
    approvalState: approvalState as Array<'requested' | 'approved' | 'denied'>,
  }
}

function boundedPath(value: string | undefined): string | null {
  if (!value) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return null
  }
  return decoded.length <= 256 && !decoded.includes('\0') ? decoded : null
}

export function createAdminTracingSessionsRouter(reader: GovernedSessionReplayReader): Router {
  const router = Router()
  router.get('/admin/tracing/sessions', async (req, res, next) => {
    try {
      const page = paging(req)
      res.status(200).json(await reader.list({ ...page, filters: parseFilters(req) }))
    } catch (error) {
      if (error instanceof Error && !('status' in error)) {
        res.status(400).json({ error: 'invalid_query', detail: error.message })
        return
      }
      next(error)
    }
  })
  router.get('/admin/tracing/sessions/:hostRef/:sessionId', async (req, res, next) => {
    try {
      const allowed = new Set(['limit', 'cursor'])
      const unexpected = Object.keys(req.query).find(key => !allowed.has(key))
      if (unexpected) throw new Error(`unsupported query parameter: ${unexpected}`)
      const hostRef = boundedPath(req.params.hostRef)
      const sessionId = boundedPath(req.params.sessionId)
      if (!hostRef || !sessionId) throw new Error('invalid session reference')
      const detail = await reader.detail({ hostRef, sessionId, ...paging(req) })
      if (!detail) {
        res.status(404).json({ error: 'session_not_found' })
        return
      }
      res.status(200).json(detail)
    } catch (error) {
      if (error instanceof Error && !('status' in error)) {
        res.status(400).json({ error: 'invalid_query', detail: error.message })
        return
      }
      next(error)
    }
  })
  return router
}
