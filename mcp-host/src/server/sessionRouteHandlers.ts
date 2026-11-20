import {
  type ApprovalConfigSnapshot,
  effectiveApprovalMode,
  normalizeApprovalMode,
  readChannelCap,
  readModeCeiling,
} from '../core/approval/approvalMode'
import { classifierAvailable, classifierServingPair } from '../core/approval/shellClassifier'
import type { ConversationManager } from '../core/conversation/conversation'
import type {
  ConversationSessionMessages,
  ConversationSessionSummary,
} from '../core/conversation/conversationStore'
import { pendingApprovalWireFields } from '../core/conversation/pendingApprovalView'
import { type Conversation, ConversationState } from '../core/types'
import { projectApprovalInputPreview } from '../progress/approvalInputPreview'
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
  /**
   * Defense-in-depth redaction of a session title at projection time (spec 15
   * §5). The title is already redacted when materialized, but re-redacting on
   * read covers a secret rotated in after materialization and a mis-wired
   * secret provider that returned `[]` at write time. Owned by `main.ts` (closes
   * over the operator secret list). Non-logging (unlike `redactToolError`).
   */
  redactTitle: (rawTitle: string) => string
  /**
   * Live ceiling and channel cap. Read on each request, not captured when the
   * handler is wired. Absent → manual ceiling.
   */
  approvalSnapshot?: () => ApprovalConfigSnapshot
  /**
   * Provider id and model name a task for this session runs with: the saved
   * selection on the Host provider, or the boot fallback while it serves. The
   * caller resolves it the same way as the task model; this handler does not
   * construct a provider per session.
   */
  sessionModel?: (selections: Record<string, string> | undefined) => {
    providerType: string
    modelName: string
  }
  /**
   * The pair currently serving the Host when failover is active. Absent or
   * not a fallback means the session model is the classifier pair.
   */
  servedModel?: () => { provider: string; model: string; fallback: boolean } | null
  /**
   * Dedicated shell classifier pair, when the Host can build one. When it
   * returns a pair, shellClassifierAvailable uses that pair instead of the
   * chat or failover pair. Null keeps the chat pair. Admission must use the
   * same pair.
   */
  shellClassifierPair?: () => { providerType: string; modelName: string } | null
}

export function createSessionRouteHandlers(deps: SessionRouteHandlerDeps) {
  const { getConversationManager, redactToolError, redactTitle } = deps
  const approvalSnapshot =
    deps.approvalSnapshot ?? (() => ({ effective: undefined, hostSpec: undefined }))
  const sessionModel =
    deps.sessionModel ?? (() => ({ providerType: 'unknown', modelName: 'unknown' }))

  const approvalView = (
    session: Conversation | ConversationSessionSummary | ConversationSessionMessages
  ) => {
    const live =
      'key' in session ? getConversationManager().getSessionByKey(session.key) : undefined
    const stored = live
      ? live.approval_mode
      : 'approvalMode' in session
        ? session.approvalMode
        : undefined
    const channelType = live
      ? live.channel_type
      : 'channelType' in session
        ? session.channelType
        : undefined
    const selections = live ? live.modelSelections : session.modelSelections
    const snapshot = approvalSnapshot()
    const ceiling = readModeCeiling(snapshot)
    const cap = readChannelCap(snapshot, channelType)
    const approvalMode = normalizeApprovalMode(stored)
    const model = sessionModel(selections)
    const dedicated = deps.shellClassifierPair?.() ?? null
    const classifierModel =
      dedicated ??
      classifierServingPair({
        primaryProvider: model.providerType,
        primaryModel: model.modelName,
        served: deps.servedModel?.(),
      })
    return {
      approvalMode,
      modeCeiling: ceiling,
      channelCap: cap,
      effectiveApprovalMode: effectiveApprovalMode(approvalMode, ceiling, cap),
      shellClassifierAvailable: classifierAvailable(
        classifierModel.providerType,
        classifierModel.modelName,
        {}
      ),
    }
  }

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
    // Summaries intentionally omit raw parameters. Pending sessions are pinned
    // in the cache (including cold-start rehydration); derive the preview only
    // from that same live task and request, without widening the summary DTO.
    const liveSession =
      'key' in session ? getConversationManager().getSessionByKey(session.key) : session
    const previewApproval =
      activeTaskId &&
      liveSession?.activeTaskId === activeTaskId &&
      liveSession.pending_approval?.request_id === approval?.request_id &&
      liveSession.pending_approval?.tool_name === approval?.tool_name
        ? liveSession.pending_approval
        : undefined
    const pendingApproval =
      session.state === ConversationState.AwaitingApproval && approval
        ? {
            requestId: approval.request_id,
            displayName: getDisplayName(approval.tool_name),
            // U5 — the connect_required discriminator lets a reconnecting desktop
            // rebuild a "Connect <server>" suspension after a cold restart, and
            // alwaysApproveAllowed:false hides "Always approve" exactly when the
            // Host would refuse it. One projection for every view.
            ...pendingApprovalWireFields({
              ...approval,
              shellCard: previewApproval?.shellCard,
            }),
            ...(approval.reason !== 'connect_required' && previewApproval
              ? {
                  inputPreview: projectApprovalInputPreview(
                    previewApproval.tool_name,
                    previewApproval.parameters,
                    redactTitle
                  ),
                }
              : {}),
          }
        : undefined
    // Lifetime token totals — projected to the wire shape (omitted until the
    // session has had an LLM call; cache breakdown included only when the model
    // reports it). See `projectSessionTokens`.
    const tokens = projectSessionTokens(session)
    return { state, activeTaskId, pendingApproval, tokens, ...approvalView(session) }
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
    // A cursor that does not decode for this scope is a caller error. Treating
    // it as "no cursor" would silently restart the listing at page 1. The HTTP
    // route rejects it with 400 before reaching here; this guards other callers.
    if (query.cursor !== undefined && cursor === null) {
      throw new Error('Invalid sessions cursor')
    }
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
        // spec 15 — omit when unset; re-redact on read (defense in depth §5).
        ...(summary.title !== undefined ? { title: redactTitle(summary.title) } : {}),
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
