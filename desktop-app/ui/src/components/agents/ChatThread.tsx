import {
  Fragment,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useAgentChatActionsContext } from '@contexts/AgentChatActionsContext'
import { useChatComposerStateContext } from '@contexts/ChatComposerStateContext'
import { useChatListContext } from '@contexts/ChatListContext'
import { useChatThreadStateContext } from '@contexts/ChatThreadStateContext'
import { useMcpRuntimeContext } from '@contexts/McpRuntimeContext'
import { useNavigationContext } from '@contexts/NavigationContext'
import { useNotificationsContext } from '@contexts/NotificationsContext'
import { Button, IconButton, MenuItem } from '@components/Common'
import { ConfirmDialog } from '@components/ConfirmDialog'
import { GfsFileIcon } from '@components/GfsFileIcon'
import { GfsImagePreview } from '@components/GfsImagePreview'
import { MessageArtifactActions } from '@components/MessageArtifactActions'
import { SecureHtmlPreview } from '@components/SecureHtmlPreview'
import { IconConnectors, IconContexts, IconWorkflows } from '@components/SidebarNav/icons'
import { WorkflowRunArtifactActions } from '@components/WorkflowRunArtifactActions'
import {
  AGENT_ERROR_CODE_LABELS,
  CHAT_NEAR_BOTTOM_THRESHOLD_PX,
  SESSION_PREVIEW_LIMIT,
} from '@constants/agents'
import { HTML_PREVIEW_INLINE_MAX_BYTES } from '@constants/htmlPreview'
import type { ChatMessageAttachment } from '../../../../src/types'
import { chatMessageDomId } from '../../lib/chatLocalSearch'
import {
  getChatMessageAttachmentTypeLabel,
  parseChatMessageDisplay,
} from '../../lib/chatMessageAttachments'
import { getComposerDraft, setComposerDraft } from '../../lib/composerDraftStore'
import { buildComposerResendDraft, findNearestPrecedingUserMessage } from '../../lib/composerResend'
import {
  extractHtmlVisualization,
  formatChatTimestamp,
  formatRelativeTime,
  looksLikeJson,
} from '../../lib/format'
import { resolveTaskActionState } from '../../pages/AgentsPage.helpers'
import type { AgentChatMessage, ProgressStep, TaskProgress } from '../../uiTypes'
import { ProgressStepper } from '../ProgressStepper'
import { ChatMarkdownContent } from './ChatMarkdownContent'
import { ChatStateBadge } from './ChatStateBadge'
import { InFlightAssistantPlaceholder } from './InFlightAssistantPlaceholder'
import { MessageTokens } from './MessageTokens'
import { NudgeArea } from './NudgeArea'

type ChatThreadProps = {
  showAgentLabel?: boolean
  onScrollPositionChange?: (isScrolledAwayFromBottom: boolean) => void
}
type RenderableChatMessage = AgentChatMessage & {
  messageKey: string
}

const VIRTUAL_MESSAGE_GROUPS_PER_CHUNK = 8

type ChunkableMessageGroup = {
  groupKey: string
  items: Array<Pick<RenderableChatMessage, 'serverTurnNumber'>>
}

export function buildMessageGroupChunks<T extends ChunkableMessageGroup>(
  groupedWithKeys: T[]
): Array<{
  chunkKey: string
  groups: Array<{ group: T; groupIndex: number }>
}> {
  const chunks: Array<{
    chunkKey: string
    groups: Array<{ group: T; groupIndex: number }>
  }> = []
  const seenBaseKeys = new Set<string>()
  let lastBaseKey: string | null = null
  for (const [groupIndex, group] of groupedWithKeys.entries()) {
    const firstTurn = group.items[0]?.serverTurnNumber
    const baseKey =
      firstTurn !== undefined
        ? `server-turns-${Math.floor((firstTurn - 1) / (VIRTUAL_MESSAGE_GROUPS_PER_CHUNK / 2))}`
        : `local-${group.groupKey}`
    const current = chunks.at(-1)
    if (current && lastBaseKey === baseKey) {
      current.groups.push({ group, groupIndex })
    } else {
      const chunkKey = seenBaseKeys.has(baseKey) ? `${baseKey}#${group.groupKey}` : baseKey
      seenBaseKeys.add(baseKey)
      chunks.push({ chunkKey, groups: [{ group, groupIndex }] })
      lastBaseKey = baseKey
    }
  }
  return chunks
}

type WorkflowArtifactScope = {
  namespace: string
  name: string
  label: string
  runId: string
  requestedAt?: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function extractWorkflowArtifactScopeFromProgress(
  progress: TaskProgress | undefined
): WorkflowArtifactScope | null {
  if (!progress?.steps.length) return null
  const triggerStep = [...progress.steps]
    .reverse()
    .find(step => step.toolName === 'workflow_trigger' && step.state === 'completed')
  const metadata = asRecord(triggerStep?.metadata)
  const scope = asRecord(metadata?.workflowArtifactScope)
  const namespace = typeof scope?.namespace === 'string' ? scope.namespace : ''
  const name = typeof scope?.name === 'string' ? scope.name : ''
  const label = typeof scope?.label === 'string' ? scope.label : name
  const runId = typeof scope?.runId === 'string' ? scope.runId : ''
  const requestedAt = typeof scope?.requestedAt === 'number' ? scope.requestedAt : undefined
  if (!namespace || !name || !runId) return null
  return {
    namespace,
    name,
    label,
    runId,
    ...(requestedAt !== undefined && Number.isFinite(requestedAt) ? { requestedAt } : {}),
  }
}

function getChatMessageAttachmentIcon(attachment: ChatMessageAttachment) {
  if (attachment.type === 'plugin') return <IconWorkflows />
  if (attachment.type === 'connector') return <IconConnectors />
  if (attachment.type === 'agent_file') return <IconContexts />
  return <GfsFileIcon name={attachment.filename || attachment.label} />
}

function canDownloadResponseFileAttachment(attachment: ChatMessageAttachment): boolean {
  return (
    attachment.type === 'response_file' &&
    attachment.encoding === 'base64' &&
    typeof attachment.dataBase64 === 'string' &&
    attachment.dataBase64.length > 0
  )
}

/**
 * BUG-176: a user-attached image whose bytes ride on the attachment
 * (inline base64, same contract as response_file) can reopen the shared
 * `GfsImagePreview` modal from the sent-message chip. Parsed legacy
 * `[Attached images]` chips carry labels only and stay inert.
 */
function canPreviewUploadedFileAttachment(attachment: ChatMessageAttachment): boolean {
  return (
    attachment.type === 'uploaded_file' &&
    attachment.encoding === 'base64' &&
    typeof attachment.dataBase64 === 'string' &&
    attachment.dataBase64.length > 0 &&
    (attachment.mimeType ?? '').startsWith('image/')
  )
}

function downloadResponseFileAttachment(attachment: ChatMessageAttachment): void {
  if (!canDownloadResponseFileAttachment(attachment)) return
  const binary = window.atob(attachment.dataBase64 ?? '')
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  const blob = new Blob([bytes], {
    type: attachment.mimeType || 'application/octet-stream',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = (attachment.filename || attachment.label || 'download').replace(/[\\/]/g, '_')
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function MessageAttachmentList({ attachments }: { attachments: ChatMessageAttachment[] }) {
  const [previewAttachmentId, setPreviewAttachmentId] = useState<string | null>(null)
  if (!attachments.length) return null
  const previewAttachment =
    attachments.find(
      attachment =>
        attachment.id === previewAttachmentId && canPreviewUploadedFileAttachment(attachment)
    ) ?? null
  return (
    <span className="message-attachments-list" aria-label="Message attachments">
      {attachments.map(attachment => {
        const typeLabel = attachment.tooltip || getChatMessageAttachmentTypeLabel(attachment.type)
        const iconTypeClass =
          attachment.type === 'uploaded_file' ? 'uploaded-image' : attachment.type
        const downloadable = canDownloadResponseFileAttachment(attachment)
        const isResponseFile = attachment.type === 'response_file'
        const previewable = canPreviewUploadedFileAttachment(attachment)
        const chipBody = (
          <>
            <span
              className={`composer-reference-icon message-attachment-icon composer-reference-icon--${iconTypeClass}`}
              aria-hidden="true"
            >
              {getChatMessageAttachmentIcon(attachment)}
            </span>
            {isResponseFile ? (
              <span className="message-attachment-type-label">Generated file</span>
            ) : null}
            <span className="message-attachment-label">{attachment.label}</span>
          </>
        )
        return (
          <span
            key={attachment.id}
            className={`message-attachment-chip${isResponseFile ? ' message-attachment-chip--response-file' : ''}`}
            title={typeLabel}
          >
            {previewable ? (
              <button
                type="button"
                className="message-attachment-preview-trigger"
                onClick={() => setPreviewAttachmentId(attachment.id)}
                title={typeLabel}
              >
                {chipBody}
              </button>
            ) : (
              chipBody
            )}
            {downloadable ? (
              <Button
                className="message-attachment-download-button"
                color="neutral"
                onClick={() => downloadResponseFileAttachment(attachment)}
                size="xs"
                variant="text"
              >
                Download
              </Button>
            ) : null}
          </span>
        )
      })}
      {previewAttachment ? (
        <GfsImagePreview
          byteLength={
            previewAttachment.sizeBytes ??
            // Base64 length overstates the decoded size by ~33%; the accurate
            // 3/4 estimate keeps the 10 MB early-skip from refusing previews
            // that are actually under the limit (PR #859 review).
            Math.floor(((previewAttachment.dataBase64 ?? '').length * 3) / 4)
          }
          fileName={previewAttachment.filename || previewAttachment.label}
          dataBase64={previewAttachment.dataBase64}
          mimeType={previewAttachment.mimeType || 'image/png'}
          onClose={() => setPreviewAttachmentId(null)}
        />
      ) : null}
    </span>
  )
}

export function ChatThread({ showAgentLabel = false, onScrollPositionChange }: ChatThreadProps) {
  const { selectedAgent, handleSelectChatAgent: onStartNewChat } = useNavigationContext()
  const { decideApproval, pushToast } = useNotificationsContext()
  const { composerImageAttachments, composerReferenceAttachments, requestComposerFocus } =
    useChatComposerStateContext()
  const {
    activeMessages,
    groupedMessages,
    chatMessagesLoading,
    hasOlderMessages,
    olderMessagesLoading,
    handleLoadOlderMessages,
    activeChatId,
    activityByMessageId,
    progressByMessageId,
    localSearchQuery,
    localSearchCurrentMatch,
    semanticModelsByMessageId,
  } = useChatThreadStateContext()
  const {
    chatList,
    chatListLoading,
    chatListMoreLoading = false,
    chatListHasMoreRemoteSessions = false,
    loadMoreChatSessions,
    sessionStateByChatId,
  } = useChatListContext()
  const {
    chatEndRef,
    handleSelectChat: onSelectChat,
    handleRenameChat: onRenameChat,
    handleDeleteChat: onDeleteChat,
    handleAddComposerImageAttachments: onAddComposerImageAttachments,
    handleAddComposerReferenceAttachments: onAddComposerReferenceAttachments,
  } = useAgentChatActionsContext()
  const { cancelTask: onCancelTask } = useMcpRuntimeContext()

  const [copiedMessageKey, setCopiedMessageKey] = useState<string | null>(null)
  const [showAllSessions, setShowAllSessions] = useState(false)
  const [sessionMenuChatId, setSessionMenuChatId] = useState<string | null>(null)
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [sessionRenameValue, setSessionRenameValue] = useState('')
  const [pendingDeleteSession, setPendingDeleteSession] = useState<{
    id: string
    title: string
  } | null>(null)
  const dedicatedSessionsRef = useRef<HTMLDivElement | null>(null)
  const sessionRenameInputRef = useRef<HTMLInputElement | null>(null)
  const chatThreadRef = useRef<HTMLDivElement | null>(null)
  const sessionRenameClosedRef = useRef(false)
  const chatListRef = useRef(chatList)
  const copyResetTimeoutRef = useRef<number | null>(null)

  const groupedWithKeys = useMemo(
    () =>
      groupedMessages.map((group, groupIndex) => {
        const first = group.items[0]
        const last = group.items.at(-1)
        const firstKey = first?.id ?? first?.timestamp ?? groupIndex
        const lastKey = last?.id ?? last?.timestamp ?? groupIndex
        return {
          ...group,
          groupKey: `${group.role}-${firstKey}-${lastKey}-${group.items.length}`,
          items: group.items.map(message => ({
            ...message,
            messageKey: message.id,
          })),
        }
      }),
    [groupedMessages]
  )
  const messageGroupChunks = useMemo(
    () => buildMessageGroupChunks(groupedWithKeys),
    [groupedWithKeys]
  )

  const localMessageIds = useMemo(
    () => new Set(activeMessages.map(message => message.id)),
    [activeMessages]
  )

  const sortedChats = useMemo(
    () =>
      [...chatList].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      ),
    [chatList]
  )
  const hasMoreSessions =
    sortedChats.length > SESSION_PREVIEW_LIMIT || chatListHasMoreRemoteSessions
  const visibleChats = showAllSessions ? sortedChats : sortedChats.slice(0, SESSION_PREVIEW_LIMIT)

  const isDedicatedAgentView = !activeChatId

  useEffect(() => {
    chatListRef.current = chatList
  }, [chatList])

  useEffect(() => {
    const chatThread = chatThreadRef.current
    if (!chatThread || !activeChatId) {
      onScrollPositionChange?.(false)
      return
    }

    const updateScrollPosition = () => {
      const distanceFromBottom =
        chatThread.scrollHeight - chatThread.scrollTop - chatThread.clientHeight
      onScrollPositionChange?.(distanceFromBottom > CHAT_NEAR_BOTTOM_THRESHOLD_PX)
    }

    updateScrollPosition()
    chatThread.addEventListener('scroll', updateScrollPosition, { passive: true })
    return () => chatThread.removeEventListener('scroll', updateScrollPosition)
  }, [activeChatId, chatMessagesLoading, groupedWithKeys, onScrollPositionChange])

  useEffect(() => {
    if (renamingSessionId && sessionRenameInputRef.current) {
      sessionRenameInputRef.current.focus()
      sessionRenameInputRef.current.select()
    }
  }, [renamingSessionId])

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current != null) {
        window.clearTimeout(copyResetTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (
      chatList.length <= SESSION_PREVIEW_LIMIT &&
      !chatListHasMoreRemoteSessions &&
      showAllSessions
    ) {
      setShowAllSessions(false)
    }
    if (sessionMenuChatId && !chatList.some(chat => chat.id === sessionMenuChatId)) {
      setSessionMenuChatId(null)
    }
    if (renamingSessionId && !chatList.some(chat => chat.id === renamingSessionId)) {
      setRenamingSessionId(null)
      setSessionRenameValue('')
    }
  }, [
    chatList,
    chatListHasMoreRemoteSessions,
    renamingSessionId,
    sessionMenuChatId,
    showAllSessions,
  ])

  useEffect(() => {
    if (!sessionMenuChatId) return
    const handleOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (dedicatedSessionsRef.current?.contains(target)) return
      setSessionMenuChatId(null)
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSessionMenuChatId(null)
      }
    }
    window.addEventListener('mousedown', handleOutside)
    window.addEventListener('keydown', handleEscape)
    return () => {
      window.removeEventListener('mousedown', handleOutside)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [sessionMenuChatId])

  const startSessionRename = useCallback((chatId: string, currentTitle: string) => {
    sessionRenameClosedRef.current = false
    setRenamingSessionId(chatId)
    setSessionRenameValue(currentTitle)
    setSessionMenuChatId(null)
  }, [])

  const cancelSessionRename = useCallback(() => {
    sessionRenameClosedRef.current = true
    setRenamingSessionId(null)
    setSessionRenameValue('')
  }, [])

  const commitSessionRename = useCallback(() => {
    if (sessionRenameClosedRef.current) return
    if (!renamingSessionId) return
    sessionRenameClosedRef.current = true
    const nextTitle = sessionRenameValue.trim()
    const currentTitle =
      chatListRef.current.find(chat => chat.id === renamingSessionId)?.title || ''
    if (nextTitle && nextTitle !== currentTitle) {
      void onRenameChat(renamingSessionId, nextTitle)
    }
    cancelSessionRename()
  }, [cancelSessionRename, onRenameChat, renamingSessionId, sessionRenameValue])

  const deleteSession = useCallback((chatId: string, chatTitle: string) => {
    setSessionMenuChatId(null)
    setPendingDeleteSession({ id: chatId, title: chatTitle })
  }, [])

  const confirmDeleteSession = useCallback(() => {
    if (!pendingDeleteSession) return
    void onDeleteChat(pendingDeleteSession.id)
    setPendingDeleteSession(null)
  }, [onDeleteChat, pendingDeleteSession])

  const handleCopyMessage = useCallback(async (messageKey: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      setCopiedMessageKey(messageKey)
      if (copyResetTimeoutRef.current != null) {
        window.clearTimeout(copyResetTimeoutRef.current)
      }
      copyResetTimeoutRef.current = window.setTimeout(() => {
        setCopiedMessageKey(previous => (previous === messageKey ? null : previous))
        copyResetTimeoutRef.current = null
      }, 1200)
    } catch {
      setCopiedMessageKey(null)
    }
  }, [])

  // TASK-42: resend repopulates the composer from the ORIGINAL prompt — text in
  // the per-chat draft store, uploaded files re-attached (bytes ride the chip),
  // plugin/connector/file indicators re-applied as composer references. The
  // source is always a user message: resending a reply re-issues the prompt that
  // produced it (see `findNearestPrecedingUserMessage`).
  //
  // Replace-vs-append contract (PR #859 review): like the failed-send recovery
  // path (`handleRecoverFailedAgentSend`), resend REFUSES to touch a dirty
  // composer instead of silently merging into a half-written draft — text is
  // replaced and attachments are appended by the store handlers, so merging
  // would strand the user's earlier chips under the resent ones. Once the
  // composer is clean, the resend is a full repopulate.
  const handleResendMessage = useCallback(
    (source: Pick<RenderableChatMessage, 'content' | 'attachments'>) => {
      if (!activeChatId) return
      if (
        getComposerDraft(activeChatId) ||
        composerImageAttachments.length ||
        composerReferenceAttachments.length
      ) {
        pushToast('Keep or clear the current draft before resending this message.', 'error')
        return
      }
      const draft = buildComposerResendDraft(source)
      setComposerDraft(activeChatId, draft.content)
      if (draft.imageAttachments.length) {
        onAddComposerImageAttachments(draft.imageAttachments)
      }
      if (draft.referenceAttachments.length) {
        onAddComposerReferenceAttachments(draft.referenceAttachments)
      }
      if (draft.unrestorable.length) {
        const count = draft.unrestorable.length
        pushToast(
          `${count} ${count === 1 ? 'attachment' : 'attachments'} from the original message couldn't be restored.`,
          'warn'
        )
      }
      requestComposerFocus()
    },
    [
      activeChatId,
      composerImageAttachments,
      composerReferenceAttachments,
      onAddComposerImageAttachments,
      onAddComposerReferenceAttachments,
      pushToast,
      requestComposerFocus,
    ]
  )

  const renderProgressStepper = useCallback(
    (message: RenderableChatMessage, filterStatus?: 'completed' | 'non-completed') => {
      if (progressByMessageId[message.id] == null) return null
      const prog = progressByMessageId[message.id]!
      if (filterStatus === 'completed' && prog.status !== 'completed') return null
      if (filterStatus === 'non-completed' && prog.status === 'completed') return null
      const activity = activityByMessageId[message.id]
      const si = prog.suspendedInfo
      const { canAct, canCancel, taskId } = resolveTaskActionState(
        activity,
        prog,
        selectedAgent,
        onCancelTask
      )
      return (
        <ProgressStepper
          key={`progress-${message.messageKey}`}
          progress={prog}
          hostRef={selectedAgent || undefined}
          onApprove={
            canAct && si && selectedAgent && activeChatId
              ? () => {
                  // Surface (c), §4.7.4: the in-chat gate funnels through the
                  // central decider (optimistic FSM dispatch + RPC + resolve/toast).
                  void decideApproval({
                    agentRef: selectedAgent,
                    chatId: activeChatId,
                    taskId: taskId!,
                    requestId: si.requestId,
                    decision: 'approve',
                    source: 'in_chat',
                  })
                }
              : undefined
          }
          onDeny={
            canAct && si && selectedAgent && activeChatId
              ? () => {
                  void decideApproval({
                    agentRef: selectedAgent,
                    chatId: activeChatId,
                    taskId: taskId!,
                    requestId: si.requestId,
                    decision: 'deny',
                    source: 'in_chat',
                  })
                }
              : undefined
          }
          onCancel={canCancel ? () => onCancelTask!(taskId!) : undefined}
          onConnect={
            // U5: a connect_required suspension opens the provider OAuth flow,
            // host-bound to this conversation's agent (hostRef ≡ selectedAgent).
            // The deep-link completion resumes the task via the same approval RPC.
            si?.reason === 'connect_required' && si.mcpServerName && selectedAgent
              ? () => {
                  // R4-L1: a failed mint (403 membership, rpc-proxy down) must not
                  // escape as an unhandled rejection. The ProgressStepper's 5s timer
                  // re-enables the Connect button so the user can retry; log the
                  // failure so it is observable. (Follow-up: a user-facing error
                  // indicator on the button — needs pushToast wiring / an
                  // onConnect→Promise contract in ProgressStepper.)
                  window.clerum.rpc
                    .connectMcpServer(si.mcpServerName!, selectedAgent)
                    .catch(err => {
                      console.error('[connect] connectMcpServer failed', {
                        mcpServerName: si.mcpServerName,
                        error: err instanceof Error ? err.message : String(err),
                      })
                    })
                }
              : undefined
          }
        />
      )
    },
    [
      activityByMessageId,
      activeChatId,
      decideApproval,
      onCancelTask,
      progressByMessageId,
      selectedAgent,
    ]
  )

  // #582: reload fallback — when the live progress map has nothing for a turn
  // (renderer-only, lost on refresh), render the completed stepper from the
  // assistant message's persisted/hydrated `toolSteps` so the "N tools" list
  // survives a reload / cold-load.
  const renderHydratedToolSteps = useCallback(
    (message: RenderableChatMessage) => {
      const toolSteps = message.toolSteps
      if (!Array.isArray(toolSteps) || toolSteps.length === 0) return null
      const steps: ProgressStep[] = toolSteps.map((s, i) => ({
        toolCallId: `${message.id}-tool-${i}`,
        toolName: s.toolName,
        displayName: s.displayName,
        intentSummary: '',
        iteration: 0,
        stepIndex: i,
        totalSteps: toolSteps.length,
        state: s.state,
        ...(s.durationMs != null ? { durationMs: s.durationMs } : {}),
        ...(s.errorSummary ? { errorSummary: s.errorSummary } : {}),
      }))
      const progress: TaskProgress = {
        taskId: message.task_id ?? '',
        status: 'completed',
        steps,
        currentIteration: 0,
      }
      return (
        <ProgressStepper
          key={`progress-hydrated-${message.messageKey}`}
          progress={progress}
          hostRef={selectedAgent || undefined}
        />
      )
    },
    [selectedAgent]
  )

  return (
    <div
      ref={chatThreadRef}
      data-testid="message-list"
      className={`chat-thread ${isDedicatedAgentView ? 'chat-thread-dedicated' : ''}`}
    >
      {activeChatId && hasOlderMessages && (
        <div className="chat-history-page-control">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={olderMessagesLoading}
            onClick={() => void handleLoadOlderMessages()}
          >
            {olderMessagesLoading ? 'Loading older messages…' : 'Load older messages'}
          </Button>
        </div>
      )}
      {activeChatId &&
        messageGroupChunks.map(chunk => (
          <div key={chunk.chunkKey} className="virtualized-message-chunk">
            {chunk.groups.map(({ group, groupIndex }) => {
              const prevGroup = groupIndex > 0 ? groupedWithKeys[groupIndex - 1] : null

              return (
                <Fragment key={group.groupKey}>
                  <section className={`chat-group ${group.role}`}>
                    {group.items.map((message, messageIndex) => {
                      const parsedUserMessage =
                        message.role === 'user' ? parseChatMessageDisplay(message.content) : null
                      const displayContent = parsedUserMessage?.content ?? message.content
                      const semanticModel = semanticModelsByMessageId.get(message.id)
                      if (!semanticModel) return null
                      const activeSearchOccurrence =
                        localSearchCurrentMatch?.messageId === message.id
                          ? localSearchCurrentMatch.occurrence
                          : null
                      const displayAttachments =
                        message.role === 'user'
                          ? message.attachments && message.attachments.length
                            ? message.attachments
                            : (parsedUserMessage?.attachments ?? [])
                          : message.attachments && message.attachments.length
                            ? message.attachments
                            : []
                      const hasResponseFileAttachment = displayAttachments.some(
                        attachment => attachment.type === 'response_file'
                      )
                      const isJson = looksLikeJson(displayContent)
                      const htmlPreview =
                        message.role === 'assistant'
                          ? extractHtmlVisualization(displayContent)
                          : null
                      const hasHtmlArtifactMention =
                        message.role === 'assistant' &&
                        /\b[a-zA-Z0-9][a-zA-Z0-9._-]*\.html?\b/i.test(displayContent)
                      const showMetaRow = message.role === 'assistant' || message.role === 'user'
                      const copyContent = message.role === 'user' ? displayContent : message.content
                      // TASK-42: a user message resends itself; an assistant
                      // message (including error bubbles) resends the user
                      // prompt that produced it.
                      const resendSource =
                        message.role === 'user'
                          ? message
                          : findNearestPrecedingUserMessage(groupedWithKeys, groupIndex)
                      const metaRowRoleClass =
                        message.role === 'user'
                          ? 'chat-message-meta-row--user'
                          : message.role === 'assistant'
                            ? 'chat-message-meta-row--assistant'
                            : ''
                      const isLastAssistantMessage =
                        group.role === 'assistant' && messageIndex === group.items.length - 1
                      const workflowArtifactScopeForAssistant =
                        message.role === 'assistant' && prevGroup?.role === 'user'
                          ? (prevGroup.items
                              .map(prevMessage =>
                                extractWorkflowArtifactScopeFromProgress(
                                  progressByMessageId[prevMessage.id]
                                )
                              )
                              .find((scope): scope is WorkflowArtifactScope => scope !== null) ??
                            null)
                          : null
                      return (
                        <article
                          key={message.messageKey}
                          id={chatMessageDomId(message.id)}
                          data-chat-message-id={message.id}
                          data-testid={message.role === 'assistant' ? 'agent-response' : undefined}
                          className={`chat-bubble ${message.role}${message.isError ? ' chat-bubble--error' : ''}${
                            htmlPreview || hasHtmlArtifactMention ? ' chat-bubble--wide' : ''
                          }`}
                        >
                          {message.isError ? (
                            <div className="error-bubble-content">
                              <div className="error-bubble-icon">✕</div>
                              <div className="error-bubble-body">
                                <div className="error-bubble-label">
                                  {AGENT_ERROR_CODE_LABELS[message.errorCode ?? ''] ?? 'Error'}
                                  {message.errorProvider
                                    ? ` · ${message.errorProvider.toUpperCase()}`
                                    : ''}
                                </div>
                                <div className="error-bubble-message">
                                  {localSearchQuery ? (
                                    <ChatMarkdownContent
                                      model={semanticModel}
                                      query={localSearchQuery}
                                      activeOccurrence={activeSearchOccurrence}
                                    />
                                  ) : message.content.length <= 180 ? (
                                    message.content
                                  ) : (
                                    `${message.content.slice(0, 177)}...`
                                  )}
                                </div>
                                <details className="error-bubble-details">
                                  <summary>Details</summary>
                                  <pre className="error-bubble-details-text">{message.content}</pre>
                                </details>
                              </div>
                            </div>
                          ) : (
                            <>
                              {htmlPreview && (
                                <SecureHtmlPreview
                                  html={htmlPreview}
                                  previewId={message.messageKey}
                                  title="HTML visualization"
                                  maxBytes={HTML_PREVIEW_INLINE_MAX_BYTES}
                                />
                              )}
                              {isJson ? (
                                <pre className="message-block json-content">
                                  <ChatMarkdownContent
                                    model={semanticModel}
                                    query={localSearchQuery}
                                    activeOccurrence={activeSearchOccurrence}
                                  />
                                </pre>
                              ) : message.role === 'assistant' ? (
                                <div className="message-block markdown-content">
                                  <ChatMarkdownContent
                                    model={semanticModel}
                                    query={localSearchQuery}
                                    activeOccurrence={activeSearchOccurrence}
                                  />
                                  {selectedAgent && !hasResponseFileAttachment && (
                                    <MessageArtifactActions
                                      hostRef={selectedAgent}
                                      content={displayContent}
                                    />
                                  )}
                                  {workflowArtifactScopeForAssistant ? (
                                    <WorkflowRunArtifactActions
                                      workflow={workflowArtifactScopeForAssistant}
                                    />
                                  ) : null}
                                </div>
                              ) : displayContent ? (
                                <p className="message-block">
                                  <ChatMarkdownContent
                                    model={semanticModel}
                                    query={localSearchQuery}
                                    activeOccurrence={activeSearchOccurrence}
                                  />
                                </p>
                              ) : null}
                            </>
                          )}
                          <MessageAttachmentList attachments={displayAttachments} />
                          {isLastAssistantMessage &&
                            prevGroup?.role === 'user' &&
                            (() => {
                              // Prefer the live progress (keyed by the user message);
                              // fall back to the assistant's persisted toolSteps after
                              // a reload, when the live map is empty (#582).
                              const liveNodes = prevGroup.items
                                .map(msg => renderProgressStepper(msg, 'completed'))
                                .filter((node): node is ReactElement => node != null)
                              if (liveNodes.length > 0) return liveNodes
                              return renderHydratedToolSteps(message)
                            })()}
                          {showMetaRow && (
                            <footer className={`chat-message-meta-row ${metaRowRoleClass}`.trim()}>
                              <div className="chat-message-meta-main">
                                <span className="chat-time-label">
                                  {formatChatTimestamp(message.timestamp || Date.now())}
                                </span>
                                {message.role === 'assistant' && message.tokens && (
                                  <MessageTokens tokens={message.tokens} />
                                )}
                              </div>
                              {resendSource ? (
                                <IconButton
                                  className="message-resend-button message-copy-button message-copy-button--inline"
                                  onClick={() => handleResendMessage(resendSource)}
                                  aria-label={
                                    message.role === 'user' ? 'Resend message' : 'Resend prompt'
                                  }
                                  label={
                                    message.role === 'user' ? 'Resend message' : 'Resend prompt'
                                  }
                                  size="xs"
                                  variant="ghost"
                                >
                                  <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path fill="none" d="M0 0h24v24H0V0z" />
                                    <path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
                                  </svg>
                                </IconButton>
                              ) : null}
                              <IconButton
                                className={`message-copy-button message-copy-button--inline${
                                  copiedMessageKey === message.messageKey ? ' copied' : ''
                                }`}
                                onClick={() =>
                                  void handleCopyMessage(message.messageKey, copyContent)
                                }
                                aria-label={
                                  copiedMessageKey === message.messageKey ? 'Copied' : 'Copy text'
                                }
                                label={
                                  copiedMessageKey === message.messageKey ? 'Copied' : 'Copy text'
                                }
                                size="xs"
                                variant="ghost"
                              >
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                  <path fill="none" d="M0 0h24v24H0V0z" />
                                  <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
                                </svg>
                                {copiedMessageKey === message.messageKey && (
                                  <span className="copy-tooltip">Copied!</span>
                                )}
                              </IconButton>
                            </footer>
                          )}
                        </article>
                      )
                    })}
                  </section>
                  {group.role === 'user' &&
                    group.items.map(message => {
                      const node = renderProgressStepper(message, 'non-completed')
                      if (!node) return null
                      return (
                        <section
                          key={`progress-${message.messageKey}`}
                          className="chat-group assistant"
                        >
                          <div className="chat-bubble assistant">{node}</div>
                        </section>
                      )
                    })}
                </Fragment>
              )
            })}
          </div>
        ))}
      {activeChatId && chatMessagesLoading && groupedWithKeys.length === 0 && (
        <section className="chat-group assistant" aria-label="Loading conversation">
          <div className="chat-bubble assistant chat-loading-bubble">
            <div className="chat-loading-skeleton">
              <div className="chat-loading-skeleton-row chat-loading-skeleton-row-title" />
              <div className="chat-loading-skeleton-row" />
              <div className="chat-loading-skeleton-row chat-loading-skeleton-row-short" />
            </div>
          </div>
        </section>
      )}
      {activeChatId && selectedAgent && (
        <InFlightAssistantPlaceholder
          agentRef={selectedAgent}
          chatId={activeChatId}
          localMessageIds={localMessageIds}
          onCancelTask={onCancelTask}
          decideApproval={decideApproval}
          pendingApproval={sessionStateByChatId[activeChatId]?.pendingApproval}
        />
      )}
      {activeChatId && selectedAgent && (
        <NudgeArea
          agentRef={selectedAgent}
          chatId={activeChatId}
          onStartNewChat={() => onStartNewChat(selectedAgent, { selectLatest: false })}
          onRefreshState={() => onSelectChat(activeChatId)}
        />
      )}
      {isDedicatedAgentView && (
        <section className="agent-dedicated-sessions-card agent-dedicated-sessions-card-inline">
          <div className="agent-dedicated-sessions-header">
            <strong>Latest sessions</strong>
          </div>
          {chatListLoading ? (
            <div className="sessions-skeleton-list">
              <div className="sessions-skeleton-row" />
              <div className="sessions-skeleton-row" />
              <div className="sessions-skeleton-row" />
            </div>
          ) : !sortedChats.length ? (
            <p className="muted">
              No sessions yet. Start a message below to create your first one.
            </p>
          ) : (
            <div className="agent-dedicated-sessions-list" ref={dedicatedSessionsRef}>
              {visibleChats.map(chat => {
                const isMenuOpen = sessionMenuChatId === chat.id
                const isRenaming = renamingSessionId === chat.id
                return (
                  <div
                    key={chat.id}
                    className={`agent-dedicated-session-row${isMenuOpen ? ' menu-open' : ''}`}
                  >
                    <span className="agent-dedicated-session-main">
                      <span className="agent-dedicated-session-icon" aria-hidden="true">
                        {chat.title.trim() === '?' ? (
                          '?'
                        ) : /html|code|dev/i.test(chat.title) ? (
                          '</>'
                        ) : (
                          <svg viewBox="0 0 24 24">
                            <path fill="none" d="M0 0h24v24H0V0z" />
                            <path d="M4 4h16v12H5.17L4 17.17V4m0-2c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2H4z" />
                          </svg>
                        )}
                      </span>
                      {isRenaming ? (
                        <input
                          ref={sessionRenameInputRef}
                          className="agent-dedicated-session-rename-input"
                          aria-label="Rename session"
                          value={sessionRenameValue}
                          onChange={event => setSessionRenameValue(event.target.value)}
                          onKeyDown={event => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              commitSessionRename()
                            }
                            if (event.key === 'Escape') {
                              event.preventDefault()
                              cancelSessionRename()
                            }
                          }}
                          onBlur={commitSessionRename}
                          maxLength={100}
                        />
                      ) : (
                        <Button
                          align="start"
                          block
                          className="agent-dedicated-session-title-btn"
                          color="transparent"
                          onClick={() => onSelectChat(chat.id)}
                          size="sm"
                          title={chat.title}
                          variant="text"
                        >
                          <span className="agent-dedicated-session-title">{chat.title}</span>
                        </Button>
                      )}
                    </span>
                    <span className="agent-dedicated-session-side">
                      {showAgentLabel && selectedAgent && (
                        <span className="agent-dedicated-session-agent">{selectedAgent}</span>
                      )}
                      <ChatStateBadge
                        sessionState={sessionStateByChatId[chat.id]}
                        unreadTerminal={chat.unreadTerminal === true}
                      />
                      <span className="agent-dedicated-session-time">
                        {formatRelativeTime(chat.updatedAt)}
                      </span>
                      {!isRenaming && (
                        <IconButton
                          className="agent-dedicated-session-menu-btn"
                          aria-label={`Session actions for ${chat.title}`}
                          aria-haspopup="true"
                          aria-expanded={isMenuOpen}
                          label={`Session actions for ${chat.title}`}
                          onClick={event => {
                            event.stopPropagation()
                            setSessionMenuChatId(previous =>
                              previous === chat.id ? null : chat.id
                            )
                          }}
                          size="xs"
                          variant="ghost"
                        >
                          &#8230;
                        </IconButton>
                      )}
                      <span className="agent-dedicated-session-chevron" aria-hidden="true">
                        ›
                      </span>
                    </span>
                    {isMenuOpen && !isRenaming && (
                      <div
                        className="agent-dedicated-session-menu"
                        role="group"
                        aria-label={`Session actions for ${chat.title}`}
                      >
                        <MenuItem
                          className="agent-dedicated-session-menu-item"
                          onClick={() => startSessionRename(chat.id, chat.title)}
                        >
                          Rename
                        </MenuItem>
                        <MenuItem
                          className="agent-dedicated-session-menu-item danger"
                          color="danger"
                          onClick={() => deleteSession(chat.id, chat.title)}
                        >
                          Delete
                        </MenuItem>
                      </div>
                    )}
                  </div>
                )
              })}
              <div className="agent-dedicated-sessions-footer">
                <span className="agent-dedicated-sessions-meta">
                  {sortedChats.length} {sortedChats.length === 1 ? 'session' : 'sessions'}
                </span>
                {hasMoreSessions && !showAllSessions && (
                  <Button
                    color="neutral"
                    onClick={() => setShowAllSessions(true)}
                    size="xs"
                    variant="text"
                  >
                    Show more
                  </Button>
                )}
                {showAllSessions && sortedChats.length > SESSION_PREVIEW_LIMIT && (
                  <Button
                    color="neutral"
                    onClick={() => setShowAllSessions(false)}
                    size="xs"
                    variant="text"
                  >
                    Show less
                  </Button>
                )}
                {showAllSessions && chatListHasMoreRemoteSessions && loadMoreChatSessions && (
                  <Button
                    color="neutral"
                    disabled={chatListMoreLoading}
                    onClick={() => {
                      void loadMoreChatSessions()
                    }}
                    size="xs"
                    variant="text"
                  >
                    {chatListMoreLoading ? 'Loading…' : 'Load more'}
                  </Button>
                )}
              </div>
            </div>
          )}
        </section>
      )}
      {pendingDeleteSession ? (
        <ConfirmDialog
          title="Delete session?"
          body={
            <p>
              Delete <strong>{pendingDeleteSession.title}</strong>? Messages cannot be recovered.
            </p>
          }
          confirmLabel="Delete"
          tone="danger"
          onCancel={() => setPendingDeleteSession(null)}
          onConfirm={confirmDeleteSession}
        />
      ) : null}
      <div ref={chatEndRef} />
    </div>
  )
}
