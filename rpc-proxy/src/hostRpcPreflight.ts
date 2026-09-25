import type { NextFunction, Response } from 'express'
import {
  validateHostModelSelectionRequest,
  validateSessionRenameTitle,
} from '@clerum/action-context-contracts'
import type { AuthedRequest } from './middleware/auth.js'

const SESSION_LIMIT_CAP = 100
const MESSAGE_LIMIT_CAP = 200
const SESSION_SEARCH_LIMIT_CAP = 50

export type HostRpcPreflight = {
  route: string
  hostRef: string
  agent?: string
  chatId?: string
  taskId?: string
  query?: string
  scope?: string
  channel?: string
  since?: string
  limit?: number
  beforeTurn?: number
  afterTurn?: number
  cursor?: string
  body?: Record<string, unknown>
  validatedTitle?: string
}

type ParseResult = { value: HostRpcPreflight } | { status: number; body: unknown }

function safePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    value.length <= 500 &&
    !/[/\\\u0000-\u001f\u007f]/.test(value)
  )
}

function safeAgentSegment(value: string): boolean {
  return safePathSegment(value) && value.length <= 200 && !value.includes(':')
}

function integerQuery(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function fail(error: string): ParseResult {
  return { status: 400, body: { error } }
}

export function hostStreamBodyError(req: AuthedRequest): string | undefined {
  if (Number(req.headers['content-length'] || 0) <= 0) return undefined
  const route = String(req.route?.path || '')
  if (route.endsWith('/status/stream'))
    return 'Status stream is read-only and does not accept request bodies'
  if (route.endsWith('/activity/stream'))
    return 'Activity stream is read-only and does not accept request bodies'
  if (route.endsWith('/progress/stream'))
    return 'Progress stream is read-only and does not accept request bodies'
  return undefined
}

function parseRoute(req: AuthedRequest): ParseResult {
  const route = `${req.method.toUpperCase()} ${String(req.route?.path || '')}`
  const hostRef = String(req.params.hostRef || '').trim()
  const base: HostRpcPreflight = { route, hostRef }

  if (route === 'GET /rpc/hosts/:hostRef/sessions/search') {
    const rawQuery = req.query.q
    const rawScope = req.query.scope
    const rawChannel = req.query.channel
    const rawSince = req.query.since
    const limit = integerQuery(req.query.limit)
    if (
      !safePathSegment(hostRef) ||
      typeof rawQuery !== 'string' ||
      !rawQuery.trim() ||
      (rawScope !== undefined && typeof rawScope !== 'string') ||
      (rawChannel !== undefined && (typeof rawChannel !== 'string' || !rawChannel.trim())) ||
      (rawSince !== undefined && (typeof rawSince !== 'string' || !rawSince.trim())) ||
      limit === null ||
      (limit !== undefined && limit < 1)
    )
      return fail('Invalid session search query')
    return {
      value: {
        ...base,
        query: rawQuery.trim(),
        scope: rawScope as string | undefined,
        channel: typeof rawChannel === 'string' ? rawChannel.trim() : undefined,
        since: typeof rawSince === 'string' ? rawSince.trim() : undefined,
        limit: limit === undefined ? undefined : Math.min(limit, SESSION_SEARCH_LIMIT_CAP),
      },
    }
  }

  if (route === 'GET /rpc/hosts/:hostRef/sessions') {
    const rawAgent = req.query.agent
    const agent = typeof rawAgent === 'string' ? rawAgent.trim() : undefined
    const rawCursor = req.query.cursor
    const cursor = typeof rawCursor === 'string' ? rawCursor : ''
    const limit = integerQuery(req.query.limit)
    if (
      !safePathSegment(hostRef) ||
      (rawAgent !== undefined && typeof rawAgent !== 'string') ||
      (rawCursor !== undefined && typeof rawCursor !== 'string') ||
      (rawAgent !== undefined && (!agent || !safeAgentSegment(agent))) ||
      (rawCursor !== undefined && !cursor) ||
      cursor.length > 2048 ||
      limit === null ||
      (limit !== undefined && limit < 1)
    )
      return fail('Invalid session pagination query')
    return {
      value: {
        ...base,
        agent,
        cursor,
        limit: limit === undefined ? undefined : Math.min(limit, SESSION_LIMIT_CAP),
      },
    }
  }

  if (route === 'GET /rpc/hosts/:hostRef/sessions/:agent/:chatId/messages') {
    const agent = String(req.params.agent || '').trim()
    const chatId = String(req.params.chatId || '').trim()
    const limit = integerQuery(req.query.limit)
    const beforeTurn = integerQuery(req.query.beforeTurn)
    const afterTurn = integerQuery(req.query.afterTurn)
    const invalidShape = ['limit', 'beforeTurn', 'afterTurn'].some(
      key => req.query[key] !== undefined && typeof req.query[key] !== 'string'
    )
    if (
      !safePathSegment(hostRef) ||
      !safeAgentSegment(agent) ||
      !safePathSegment(chatId) ||
      invalidShape ||
      limit === null ||
      (limit !== undefined && limit < 1) ||
      beforeTurn === null ||
      (beforeTurn !== undefined && beforeTurn < 1) ||
      afterTurn === null ||
      (afterTurn !== undefined && afterTurn < 0) ||
      (beforeTurn !== undefined && afterTurn !== undefined)
    )
      return fail(
        invalidShape ||
          limit === null ||
          beforeTurn === null ||
          afterTurn === null ||
          (limit !== undefined && limit < 1) ||
          (beforeTurn !== undefined && beforeTurn < 1) ||
          (afterTurn !== undefined && afterTurn < 0) ||
          (beforeTurn !== undefined && afterTurn !== undefined)
          ? 'Invalid session messages pagination query'
          : 'Invalid hostRef, agent, or chatId'
      )
    return {
      value: {
        ...base,
        agent,
        chatId,
        limit: limit === undefined ? undefined : Math.min(limit, MESSAGE_LIMIT_CAP),
        beforeTurn,
        afterTurn,
      },
    }
  }

  if (route === 'GET /rpc/hosts/:hostRef/sessions/:agent/:chatId/context-breakdown') {
    const agent = String(req.params.agent || '').trim()
    const chatId = String(req.params.chatId || '').trim()
    if (!safePathSegment(hostRef) || !safeAgentSegment(agent) || !safePathSegment(chatId))
      return fail('Invalid hostRef, agent, or chatId')
    return { value: { ...base, agent, chatId } }
  }

  if (route === 'PATCH /rpc/hosts/:hostRef/sessions/:agent/:chatId/name') {
    const agent = String(req.params.agent || '').trim()
    const chatId = String(req.params.chatId || '').trim()
    if (!safePathSegment(hostRef) || !safeAgentSegment(agent) || !safePathSegment(chatId))
      return fail('Invalid hostRef, agent, or chatId')
    const body = req.body as unknown
    const titleCandidate =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).title
        : undefined
    const rawTitle = typeof titleCandidate === 'string' ? titleCandidate : ''
    const titleValidation = validateSessionRenameTitle(rawTitle)
    if (!titleValidation.ok) return fail(titleValidation.error)
    return { value: { ...base, agent, chatId, validatedTitle: titleValidation.title } }
  }

  if (route === 'POST /rpc/hosts/:hostRef/model') {
    const body = req.body as unknown
    if (!hostRef) return fail('hostRef is required')
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return fail('Invalid set-model request payload')
    const modelValidation = validateHostModelSelectionRequest(body)
    if (!modelValidation.ok) return fail(modelValidation.error)
    return {
      value: {
        ...base,
        body: {
          ...(body as Record<string, unknown>),
          chatId: modelValidation.chatId,
          model: modelValidation.model,
        },
      },
    }
  }

  if (
    /^\w+ \/rpc\/hosts\/:hostRef\/tasks\/:taskId\/(result|cancel|progress\/stream)$/.test(route)
  ) {
    const taskId = String(req.params.taskId || '').trim()
    if (!hostRef) return fail('hostRef is required')
    const progress = route.endsWith('/progress/stream')
    if (
      progress
        ? !taskId || taskId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(taskId)
        : !taskId || !/^[a-zA-Z0-9_-]+$/.test(taskId)
    ) {
      return fail(
        progress ? 'taskId is required and must be alphanumeric (max 128 chars)' : 'Invalid taskId'
      )
    }
    if (progress) {
      const bodyError = hostStreamBodyError(req)
      if (bodyError) return fail(bodyError)
    }
    return { value: { ...base, taskId } }
  }

  if (route.includes('/approvals/')) {
    if (!hostRef) return fail('hostRef is required')
    return { value: base }
  }
  if (route.endsWith('/wake')) {
    if (!safePathSegment(hostRef)) return fail('Invalid hostRef')
    return { value: base }
  }
  if (route.endsWith('/models')) {
    if (!hostRef) return fail('hostRef is required')
    const chatId = typeof req.query.chatId === 'string' ? req.query.chatId.trim() : ''
    return { value: { ...base, chatId } }
  }
  if (
    route.endsWith('/activity') ||
    route.endsWith('/status') ||
    route.endsWith('/health') ||
    route.endsWith('/status/stream') ||
    route.endsWith('/activity/stream')
  ) {
    if (!hostRef) return fail('hostRef is required')
    if (
      (route.endsWith('/status/stream') || route.endsWith('/activity/stream')) &&
      /[*%]/.test(hostRef)
    )
      return fail('hostRef is required')
    const bodyError = hostStreamBodyError(req)
    if (bodyError) return fail(bodyError)
    return { value: base }
  }
  throw new Error(`Spec 65 Host-RPC route has no canonical preflight: ${route}`)
}

export function hostRpcRoutePreflight(req: AuthedRequest, res: Response, next: NextFunction): void {
  const result = parseRoute(req)
  if ('status' in result) {
    res.status(result.status).json(result.body)
    return
  }
  req.hostRpcPreflight = result.value
  next()
}

export function getHostRpcPreflight<T extends HostRpcPreflight>(req: AuthedRequest): T {
  if (!req.hostRpcPreflight) throw new Error('Host-RPC route preflight was not run')
  return req.hostRpcPreflight as T
}
