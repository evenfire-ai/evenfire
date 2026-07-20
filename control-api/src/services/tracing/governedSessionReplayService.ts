import { canonicalPayloadSha256 } from './append.js'
import { approvalPromptHistoryConfig } from './approvalPromptHistoryService.js'
import type { GovernedTraceSessionDetailV1, GovernedTraceSessionPageV1 } from './contracts.js'
import {
  PostgresGovernedSessionReplayRepository,
  type SessionPageAnchor,
  type SessionReplayFilters,
} from './postgresGovernedSessionReplayRepository.js'
import { projectTraceSafeFields } from './traceSafeFieldProjection.js'

type SessionCursor = {
  v: 1
  kind: 'sessions' | 'session_detail'
  highWatermark: string
  queryHash: string
  after: SessionPageAnchor | string
}

export class GovernedSessionReplayInvalidQueryError extends Error {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'GovernedSessionReplayInvalidQueryError'
  }
}

function encodeCursor(cursor: SessionCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeCursor(raw: string): SessionCursor {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as SessionCursor
    if (
      value.v !== 1 ||
      !['sessions', 'session_detail'].includes(value.kind) ||
      !/^\d+$/.test(value.highWatermark) ||
      typeof value.queryHash !== 'string'
    )
      throw new Error()
    return value
  } catch {
    throw new GovernedSessionReplayInvalidQueryError('invalid session replay cursor')
  }
}

function promptState(): 'enabled' | 'disabled' | 'unavailable' {
  const state = approvalPromptHistoryConfig()
  return state.enabled ? 'enabled' : state.reason
}

export class GovernedSessionReplayService {
  constructor(private readonly repository: PostgresGovernedSessionReplayRepository) {}

  async list(input: {
    filters: SessionReplayFilters
    cursor?: string
    limit: number
  }): Promise<GovernedTraceSessionPageV1> {
    const queryHash = canonicalPayloadSha256({ filters: input.filters })
    const cursor = input.cursor ? decodeCursor(input.cursor) : null
    if (
      cursor &&
      (cursor.kind !== 'sessions' ||
        cursor.queryHash !== queryHash ||
        typeof cursor.after === 'string')
    ) {
      throw new GovernedSessionReplayInvalidQueryError(
        'session cursor does not belong to this query'
      )
    }
    const highWatermark = cursor?.highWatermark ?? (await this.repository.captureHighWatermark())
    const page = await this.repository.list({
      filters: input.filters,
      highWatermark,
      after: cursor?.after as SessionPageAnchor | null,
      limit: input.limit + 1,
      promptState: promptState(),
    })
    const hasMore = page.summaries.length > input.limit
    const sessions = page.summaries.slice(0, input.limit)
    const lastAnchor = page.anchors[Math.min(input.limit, page.anchors.length) - 1]
    return {
      sessions,
      capturedHighWatermark: highWatermark,
      nextCursor:
        hasMore && lastAnchor
          ? encodeCursor({
              v: 1,
              kind: 'sessions',
              highWatermark,
              queryHash,
              after: lastAnchor,
            })
          : null,
    }
  }

  async detail(input: {
    hostRef: string
    sessionId: string
    cursor?: string
    limit: number
  }): Promise<GovernedTraceSessionDetailV1 | null> {
    const queryHash = canonicalPayloadSha256({ hostRef: input.hostRef, sessionId: input.sessionId })
    const cursor = input.cursor ? decodeCursor(input.cursor) : null
    if (
      cursor &&
      (cursor.kind !== 'session_detail' ||
        cursor.queryHash !== queryHash ||
        typeof cursor.after !== 'string')
    ) {
      throw new GovernedSessionReplayInvalidQueryError(
        'session detail cursor does not belong to this query'
      )
    }
    const highWatermark = cursor?.highWatermark ?? (await this.repository.captureHighWatermark())
    const occurredTo = new Date().toISOString()
    const occurredFrom = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
    const empty: SessionReplayFilters = {
      occurredFrom,
      occurredTo,
      outcome: [],
      sourceService: [],
      sessionId: [input.sessionId],
      hostRef: [input.hostRef],
      humanUserId: [],
      agentSub: [],
      origin: [],
      toolName: [],
      approvalState: [],
    }
    const [summaryPage, runs, tools, approvals, tokenUsagePoints, interactions] = await Promise.all(
      [
        this.repository.list({
          filters: empty,
          highWatermark,
          after: null,
          limit: 1,
          promptState: promptState(),
        }),
        this.repository.readRuns(input.hostRef, input.sessionId, highWatermark),
        this.repository.readTools(input.hostRef, input.sessionId, highWatermark),
        this.repository.readApprovals(input.hostRef, input.sessionId, highWatermark, promptState()),
        this.repository.readTokenUsagePoints(input.hostRef, input.sessionId, highWatermark),
        this.repository.readInteractions({
          hostRef: input.hostRef,
          sessionId: input.sessionId,
          highWatermark,
          after: (cursor?.after as string | undefined) ?? '0',
          limit: input.limit + 1,
        }),
      ]
    )
    const summary = summaryPage.summaries[0]
    if (!summary) return null
    const hasMore = interactions.length > input.limit
    const visible = interactions.slice(0, input.limit).map(interaction => ({
      ...interaction,
      safeFields: projectTraceSafeFields(interaction.safeFields, 'session'),
    }))
    const last = visible.at(-1)
    return {
      summary,
      runs,
      tools,
      approvals,
      tokenUsage: { ...summary.tokenUsage, ...tokenUsagePoints },
      interactions: visible,
      capturedHighWatermark: highWatermark,
      nextCursor:
        hasMore && last
          ? encodeCursor({
              v: 1,
              kind: 'session_detail',
              highWatermark,
              queryHash,
              after: last.streamSequence,
            })
          : null,
    }
  }
}
