import {
  Fragment,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useAgentChatActionsContext } from '@contexts/AgentChatActionsContext'
import { useChatListContext } from '@contexts/ChatListContext'
import { useChatThreadStateContext } from '@contexts/ChatThreadStateContext'
import { useMcpRuntimeContext } from '@contexts/McpRuntimeContext'
import { useNavigationContext } from '@contexts/NavigationContext'
import { useNotificationsContext } from '@contexts/NotificationsContext'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button, IconButton, MenuItem } from '@components/Common'
import { ConfirmDialog } from '@components/ConfirmDialog'
import { MessageArtifactActions } from '@components/MessageArtifactActions'
import { SecureHtmlPreview } from '@components/SecureHtmlPreview'
import {
  IconAttachFile,
  IconConnectors,
  IconContexts,
  IconWorkflows,
} from '@components/SidebarNav/icons'
import { WorkflowRunArtifactActions } from '@components/WorkflowRunArtifactActions'
import { AGENT_ERROR_CODE_LABELS, SESSION_PREVIEW_LIMIT } from '@constants/agents'
import { HTML_PREVIEW_INLINE_MAX_BYTES } from '@constants/htmlPreview'
import type { ChatMessageAttachment } from '../../../../src/types'
import {
  getChatMessageAttachmentTypeLabel,
  parseChatMessageDisplay,
} from '../../lib/chatMessageAttachments'
import {
  extractHtmlVisualization,
  formatChatTimestamp,
  formatRelativeTime,
  looksLikeJson,
} from '../../lib/format'
import { resolveTaskActionState } from '../../pages/AgentsPage.helpers'
import type { AgentChatMessage, ProgressStep, TaskProgress } from '../../uiTypes'
import { ProgressStepper } from '../ProgressStepper'
import { ChatStateBadge } from './ChatStateBadge'
import { InFlightAssistantPlaceholder } from './InFlightAssistantPlaceholder'
import { MessageTokens } from './MessageTokens'
import { NudgeArea } from './NudgeArea'

type ChatThreadProps = {
  showAgentLabel?: boolean
}

type RenderableChatMessage = AgentChatMessage & {
  messageKey: string
}

const VIRTUAL_MESSAGE_GROUPS_PER_CHUNK = 8

function VirtualizedMessageChunk({
  estimatedHeight,
  initiallyVisible,
  render,
}: {
  estimatedHeight: number
  initiallyVisible: boolean
  render: () => ReactNode
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(initiallyVisible)
  const measuredHeightRef = useRef(estimatedHeight)

  useEffect(() => {
    const element = containerRef.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      entries => {
        const entry = entries[0]
        if (!entry) return
        if (entry.isIntersecting) {
          setVisible(true)
        } else if (measuredHeightRef.current > 0) {
          setVisible(false)
        }
      },
      {
        root: element.closest('.chat-thread'),
        rootMargin: '1000px 0px',
      }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = containerRef.current
    if (!element || !visible || typeof ResizeObserver === 'undefined') return
    const updateHeight = () => {
      const height = element.getBoundingClientRect().height
      if (height > 0) measuredHeightRef.current = height
    }
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(element)
    return () => observer.disconnect()
  }, [visible])

  return (
    <div
      ref={containerRef}
      className="virtualized-message-chunk"
      style={visible ? undefined : { height: measuredHeightRef.current }}
    >
      {visible ? render() : null}
    </div>
  )
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

function getChatMessageAttachmentIcon(type: ChatMessageAttachment['type']) {
  if (type === 'plugin') return <IconWorkflows />
  if (type === 'connector') return <IconConnectors />
  if (type === 'agent_file') return <IconContexts />
  if (type === 'global_file') return <IconAttachFile />
  return <IconAttachFile />
}

function canDownloadResponseFileAttachment(attachment: ChatMessageAttachment): boolean {
  return (
    attachment.type === 'response_file' &&
    attachment.encoding === 'base64' &&
    typeof attachment.dataBase64 === 'string' &&
    attachment.dataBase64.length > 0
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
  if (!attachments.length) return null
  return (
    <span className="message-attachments-list" aria-label="Message attachments">
      {attachments.map(attachment => {
        const typeLabel = attachment.tooltip || getChatMessageAttachmentTypeLabel(attachment.type)
        const iconTypeClass =
          attachment.type === 'uploaded_file' ? 'uploaded-image' : attachment.type
        const downloadable = canDownloadResponseFileAttachment(attachment)
        const isResponseFile = attachment.type === 'response_file'
        return (
          <span
            key={attachment.id}
            className={`message-attachment-chip${isResponseFile ? ' message-attachment-chip--response-file' : ''}`}
            title={typeLabel}
          >
            <span
              className={`composer-reference-icon message-attachment-icon composer-reference-icon--${iconTypeClass}`}
              aria-hidden="true"
            >
              {getChatMessageAttachmentIcon(attachment.type)}
            </span>
            {isResponseFile ? (
              <span className="message-attachment-type-label">Generated file</span>
            ) : null}
            <span className="message-attachment-label">{attachment.label}</span>
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
    </span>
  )
}

export function ChatThread({ showAgentLabel = false }: ChatThreadProps) {
  const { selectedAgent, handleSelectChatAgent: onStartNewChat } = useNavigationContext()
  const { decideApproval } = useNotificationsContext()
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
  const messageGroupChunks = useMemo(() => {
    const chunks: Array<{
      chunkKey: string
      groups: Array<{ group: (typeof groupedWithKeys)[number]; groupIndex: number }>
    }> = []
    for (const [groupIndex, group] of groupedWithKeys.entries()) {
      const firstTurn = group.items[0]?.serverTurnNumber
      const chunkKey =
        firstTurn !== undefined
          ? `server-turns-${Math.floor((firstTurn - 1) / (VIRTUAL_MESSAGE_GROUPS_PER_CHUNK / 2))}`
          : `local-${group.groupKey}`
      const current = chunks.at(-1)
      if (current?.chunkKey === chunkKey) {
        current.groups.push({ group, groupIndex })
      } else {
        chunks.push({ chunkKey, groups: [{ group, groupIndex }] })
      }
    }
    return chunks
  }, [groupedWithKeys])

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
      if (!toolSteps || toolSteps.length === 0) return null
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
        messageGroupChunks.map((chunk, chunkIndex) => (
          <VirtualizedMessageChunk
            key={chunk.chunkKey}
            estimatedHeight={Math.max(240, chunk.groups.length * 180)}
            initiallyVisible={chunkIndex >= messageGroupChunks.length - 2}
            render={() =>
              chunk.groups.map(({ group, groupIndex }) => {
                const prevGroup = groupIndex > 0 ? groupedWithKeys[groupIndex - 1] : null

                return (
                  <Fragment key={group.groupKey}>
                    <section className={`chat-group ${group.role}`}>
                      {group.items.map((message, messageIndex) => {
                        const parsedUserMessage =
                          message.role === 'user' ? parseChatMessageDisplay(message.content) : null
                        const displayContent = parsedUserMessage?.content ?? message.content
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
                        const copyContent =
                          message.role === 'user' ? displayContent : message.content
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
                            data-testid={
                              message.role === 'assistant' ? 'agent-response' : undefined
                            }
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
                                    {message.content.length > 180
                                      ? `${message.content.slice(0, 177)}...`
                                      : message.content}
                                  </div>
                                  <details className="error-bubble-details">
                                    <summary>Details</summary>
                                    <pre className="error-bubble-details-text">
                                      {message.content}
                                    </pre>
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
                                  <pre className="message-block json-content">{displayContent}</pre>
                                ) : message.role === 'assistant' ? (
                                  <div className="message-block markdown-content">
                                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                      {displayContent}
                                    </ReactMarkdown>
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
                                  <p className="message-block">{displayContent}</p>
                                ) : null}
                                <MessageAttachmentList attachments={displayAttachments} />
                              </>
                            )}
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
                              <footer
                                className={`chat-message-meta-row ${metaRowRoleClass}`.trim()}
                              >
                                <div className="chat-message-meta-main">
                                  <span className="chat-time-label">
                                    {formatChatTimestamp(message.timestamp || Date.now())}
                                  </span>
                                  {message.role === 'assistant' && message.tokens && (
                                    <MessageTokens tokens={message.tokens} />
                                  )}
                                </div>
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
              })
            }
          />
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
