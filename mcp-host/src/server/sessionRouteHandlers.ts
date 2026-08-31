import type { ConversationManager } from '../core/conversation/conversation'
import type {
  ConversationSessionMessages,
  ConversationSessionSummary,
} from '../core/conversation/conversationStore'
import { type Conversation, ConversationState } from '../core/types'
import { getDisplayName } from '../progress/intentExtraction'
import {
  decodeSessionsCursor,
  paginateSessionSummaries,
  projectMessageWindowBounds,
  projectSessionTokens,
  projectTurnTokens,
  projectTurnToolSteps,
  sessionsCursorScope,
} from './wireProjections'

/**
 * Dependencies for the session-read RPC handlers, injected so the handlers can
 * be unit-tested against a real `ConversationManager` (see
 * `sessionRouteHandlers.test.ts`) instead of only through the full `main.ts`
 * wiring. `redactToolError` stays owned by `main.ts` (it closes over the
 * operator secret list via `BasicSafety`).
 */
export interface SessionRouteHandlerDeps {
  getConversationManager: () => ConversationManager
  redactToolError: (toolName: string, rawError: string) => string
}

export function createSessionRouteHandlers(deps: SessionRouteHandlerDeps) {
  const { getConversationManager, redactToolError } = deps

  // Common projection: state + active task + pending approval + lifetime token
  // totals, shared by the list and messages handlers (RPC token exposure
  // patch P1-1).
  const sessionStateView = (
    session: Conversation | ConversationSessionSummary | ConversationSessionMessages
  ) => {
    const state =
      session.state === ConversationState.Processing
        ? ('processing' as const)
        : session.state === ConversationState.AwaitingApproval
          ? ('awaiting_approval' as const)
          : ('idle' as const)
    const activeTaskId = state === 'idle' ? undefined : session.activeTaskId
    const approval =
      'pendingApproval' in session
        ? session.pendingApproval
        : (session as Conversation).pending_approval
    const pendingApproval =
      session.state === ConversationState.AwaitingApproval && approval
        ? {
            requestId: approval.request_id,
            displayName: getDisplayName(approval.tool_name),
            // U5 — surface the connect_required discriminator on the REST rejoin
            // snapshot so a reconnecting desktop rebuilds a "Connect <server>"
            // suspension (not a generic approval) after a cold restart. Absent for
            // the default HITL gate (reason undefined ⇒ fields omitted).
            ...(approval.reason ? { reason: approval.reason } : {}),
            ...(approval.mcpServerName ? { mcpServerName: approval.mcpServerName } : {}),
          }
        : undefined
    // Lifetime token totals — projected to the wire shape (omitted until the
    // session has had an LLM call; cache breakdown included only when the model
    // reports it). See `projectSessionTokens`.
    const tokens = projectSessionTokens(session)
    return { state, activeTaskId, pendingApproval, tokens }
  }

  const handleSessionsList = async (
    userSub: string,
    query: { agent?: string; limit?: number; cursor?: string }
  ) => {
    const convManager = getConversationManager()
    // Normalize an empty `agent` to undefined ONCE, up front. An empty string is
    // "no agent scope", not the agent literally named "". Without this the three
    // downstream uses disagreed: the prefix treated '' as falsy (non-scoped) but
    // the store query and cursor scope received '' as a real agent — the store
    // then fail-closes ('' -> userIdFromRpcPrefix null -> []), so an empty agent
    // silently returned zero sessions instead of the unscoped catalog. The store
    // fail-close is correct and stays; the fix is to never send it '' from here.
    const agent = query.agent || undefined
    const keyPrefix = agent ? `${userSub}:rpc:${agent}:` : `${userSub}:rpc:`
    const cursorScope = sessionsCursorScope(userSub, agent)
    const cursor = decodeSessionsCursor(query.cursor, cursorScope)
    const entries = await convManager.listSessionSummariesForUserAsync(keyPrefix, {
      limit: query.limit === undefined ? undefined : query.limit + 1,
      cursor: cursor
        ? { updatedAt: new Date(cursor.updatedAt), key: `${keyPrefix}${cursor.key}` }
        : undefined,
      agent,
    })
    const { page, nextCursor } = paginateSessionSummaries(
      entries,
      query.limit,
      key => key.slice(keyPrefix.length),
      cursorScope
    )
    return {
      items: page.map(summary => ({
        agent: summary.agent,
        chatId: summary.chatId,
        turnCount: summary.turnCount,
        messageCount: summary.messageCount,
        lastActivityAt: summary.lastActivityAt.toISOString(),
        ...sessionStateView(summary),
      })),
      ...(nextCursor ? { nextCursor } : {}),
    }
  }

  const handleSessionMessages = async (
    userSub: string,
    agentName: string,
    chatId: string,
    query: { limit?: number; beforeTurn?: number; afterTurn?: number }
  ) => {
    const convManager = getConversationManager()
    // Direct O(1) key lookup — spec §2: `conversations.get(`${auth.sub}:rpc:${agent}:${chatId}`)`.
    const key = `${userSub}:rpc:${agentName}:${chatId}`
    const keyPrefix = `${userSub}:rpc:`
    const page = await convManager.getSessionMessagesByKeyAsync(key, keyPrefix, query)
    if (!page) return null
    const turns = page.turns
    const windowBounds = projectMessageWindowBounds(
      turns,
      {
        firstTurnNumber: page.firstTurnNumber,
        lastTurnNumber: page.lastTurnNumber,
      },
      query
    )
    return {
      agent: agentName,
      chatId,
      ...sessionStateView(page),
      totalTurns: page.totalTurns,
      ...windowBounds,
      turns: turns.map(t => ({
        number: t.number,
        user_input: t.user_input,
        response: t.response,
        started_at: t.started_at.toISOString(),
        completed_at: t.completed_at ? t.completed_at.toISOString() : undefined,
        tokens: projectTurnTokens(t),
        tool_steps: projectTurnToolSteps(t, redactToolError),
      })),
    }
  }

  return { handleSessionsList, handleSessionMessages }
}
