import { AgentStateMachine } from './agent'
import { LlmErrorCode } from './core/errors'
import type { Attachment } from './core/types'
import type { TaskLifecycle } from './lifecycle/taskLifecycle'
import { MessageQueue, Task, TaskResponsePayload } from './queue'
import type { TaskError } from './queue'
import { ResultStore } from './resultStore'
import type { IncomingMessage, MessageResponse } from './server'
import { parseBackgroundPrefix, serializeSessionKey } from './session'
import type { SessionProcessor } from './session'

export interface PendingTaskEntry {
  status: 'completed' | 'waiting_approval' | 'failed'
  response?: string
  attachments?: Attachment[]
  error?: TaskError
  model: string
  storedAt: number
  source: {
    channelType: string
    channelId: string
    sender: string
  }
  approval?: {
    requestId: string
    userId: string
    notification: string
  }
}

export interface MessageHandlerDeps {
  messageQueue: MessageQueue
  agent: AgentStateMachine | null
  pendingTaskResults: ResultStore<PendingTaskEntry>
  getModel: () => string
  sanitizeAttachments: (raw: Attachment[] | undefined) => Attachment[] | undefined
  timeoutMs?: number
  sessionProcessor?: SessionProcessor
  taskLifecycle: TaskLifecycle
}

/**
 * Handles a single incoming message lifecycle: enqueue, listen for
 * completion/approval, clean up listeners.
 *
 * Replaces the nested-closure pattern in main.ts handleIncomingMessage().
 */
export class IncomingMessageHandler {
  private resolved = false
  private task: Task
  private resolve!: (response: MessageResponse) => void
  private timeout: ReturnType<typeof setTimeout> | null = null
  private backgroundSessionKey: string | null = null

  // Bound listener refs for cleanup
  private onApprovalNeeded: ((event: { data: unknown }) => void) | null = null
  private onApprovalConsumed: ((event: { data: unknown }) => void) | null = null
  private onComplete: ((event: { task?: Task }) => void) | null = null
  private onFail: ((event: { task?: Task }) => void) | null = null

  constructor(
    private readonly message: IncomingMessage,
    private readonly deps: MessageHandlerDeps
  ) {
    const { isBackground, content } = parseBackgroundPrefix(message.content)
    const effectiveMessage = isBackground ? { ...message, content } : message

    const responseCallback = this.handleResponse.bind(this)
    this.task = deps.messageQueue.createTaskFromMessage(
      effectiveMessage,
      responseCallback,
      'normal'
    )

    // Reporter creation lives in TaskExecutor.buildLoopConfig — single
    // construction site so SSE redaction wiring can't drift between callers.
    // SSE clients connecting before the agent dequeues block in
    // progressReporterRegistry.waitFor(taskId, 180s) until taskExecutor registers.

    if (isBackground && deps.sessionProcessor) {
      this.backgroundSessionKey = `bg-${this.task.id}`
    }
  }

  execute(): Promise<MessageResponse> {
    // Background tasks always return immediately
    if (this.backgroundSessionKey) {
      return Promise.resolve(this.executeAsync())
    }

    return new Promise<MessageResponse>(resolve => {
      this.resolve = resolve

      // Invariant I12: lifecycle.register MUST run before sessionProcessor.enqueue
      this.deps.taskLifecycle.register(this.task)
      this.deps.messageQueue.enqueue(this.task)
      console.log(`[Main] Message queued as task ${this.task.id}`)

      // Dispatch to SessionProcessor if available
      if (this.deps.sessionProcessor) {
        const msg = this.message
        const sessionKey =
          this.backgroundSessionKey ??
          serializeSessionKey({
            userId: msg.sender,
            channelType: msg.channelType,
            channelId: msg.channelId || 'default',
            threadId: msg.threadId,
          })
        this.deps.sessionProcessor.enqueue(sessionKey, this.task)
      }

      this.attachListeners()
      this.startTimeout()
    })
  }

  /**
   * Enqueue the task and return immediately with a pending status.
   * Results and approval notifications are stored in pendingTaskResults
   * for polling via GET /v1/runtime/tasks/:taskId/result.
   */
  executeAsync(): MessageResponse {
    // Override responseCallback to store results in pendingTaskResults
    this.task.responseCallback = async payload => {
      const attachments = this.deps.sanitizeAttachments(payload.attachments)
      const status: PendingTaskEntry['status'] = payload.error ? 'failed' : 'completed'
      console.log(
        `[Main] Storing async result for task ${this.task.id} (status=${status}, attachments=${
          attachments?.length ?? 0
        })`
      )
      this.deps.pendingTaskResults.set(this.task.id, {
        status,
        response: payload.response,
        attachments,
        error: payload.error,
        model: this.deps.getModel(),
        storedAt: Date.now(),
        source: {
          channelType: this.message.channelType,
          channelId: this.message.channelId,
          sender: this.message.sender,
        },
      })
    }

    // Attach approval listener that stores to pendingTaskResults
    if (this.deps.agent) {
      const onApproval = (event: { data: unknown }) => {
        const data = event.data as Record<string, unknown>
        if (data.taskId !== this.task.id) return
        console.log(`[Main] Storing async approval notification for task ${this.task.id}`)
        this.deps.pendingTaskResults.set(this.task.id, {
          status: 'waiting_approval',
          model: this.deps.getModel(),
          storedAt: Date.now(),
          source: {
            channelType: this.message.channelType,
            channelId: this.message.channelId,
            sender: this.message.sender,
          },
          approval: {
            requestId: data.requestId as string,
            userId: data.userId as string,
            notification: data.notification as string,
          },
        })
      }
      this.deps.agent.on('tool:approval_needed', onApproval)

      // Listener that clears the stored waiting_approval entry once the
      // approval is granted or denied. Without this, GET /tasks/:id/result
      // keeps returning the obsolete notification (with the now-consumed
      // requestId) until either a *new* approval fires (overwriting the entry)
      // or the task fully completes — which makes channel-reader's poll loop
      // believe the same approval is still needed and re-prompt the user.
      const onApprovalConsumed = (event: { data: unknown }) => {
        const data = event.data as Record<string, unknown>
        if (data.taskId !== this.task.id) return
        console.log(
          `[Main] Clearing stale approval entry for task ${this.task.id} ` +
            `(request: ${data.requestId})`
        )
        this.deps.pendingTaskResults.delete(this.task.id)
      }
      this.deps.agent.on('tool:approval_granted', onApprovalConsumed)
      this.deps.agent.on('tool:approval_denied', onApprovalConsumed)

      // Clean up listeners when task completes or fails
      const cleanup = (event: { task?: { id: string; error?: TaskError } }) => {
        if (event.task?.id !== this.task.id) return
        this.deps.agent?.removeListener('tool:approval_needed', onApproval)
        this.deps.agent?.removeListener('tool:approval_granted', onApprovalConsumed)
        this.deps.agent?.removeListener('tool:approval_denied', onApprovalConsumed)
        this.deps.messageQueue.off('task:completed', cleanup)
        this.deps.messageQueue.off('task:failed', onFinalFailure)
      }
      // Delivery is handled by the overridden responseCallback above — this handler
      // only cleans up the event listeners so we don't leak them after the task ends.
      const onFinalFailure = (event: { task?: { id: string } }) => {
        if (event.task?.id !== this.task.id) return
        cleanup(event)
      }
      this.deps.messageQueue.on('task:completed', cleanup)
      this.deps.messageQueue.on('task:failed', onFinalFailure)
    }

    // Invariant I12: lifecycle.register MUST run before sessionProcessor.enqueue
    this.deps.taskLifecycle.register(this.task)
    this.deps.messageQueue.enqueue(this.task)
    console.log(`[Main] Message queued as async task ${this.task.id}`)

    // Dispatch to SessionProcessor if available
    if (this.deps.sessionProcessor) {
      const msg = this.message
      const sessionKey =
        this.backgroundSessionKey ??
        serializeSessionKey({
          userId: msg.sender,
          channelType: msg.channelType,
          channelId: msg.channelId,
          threadId: msg.threadId,
        })
      this.deps.sessionProcessor.enqueue(sessionKey, this.task)
    }

    return {
      success: true,
      taskId: this.task.id,
      status: 'pending',
    }
  }

  private async handleResponse(payload: TaskResponsePayload): Promise<void> {
    const attachments = this.deps.sanitizeAttachments(payload.attachments)

    if (!this.resolved) {
      this.resolved = true
      if (payload.error) {
        this.resolve({
          success: false,
          error: payload.error,
          model: this.deps.getModel(),
        })
      } else {
        this.resolve({
          success: true,
          status: 'completed',
          response: payload.response,
          attachments,
          model: this.deps.getModel(),
        })
      }
    } else {
      console.log(`[Main] Storing post-approval result for task ${this.task.id}`)
      this.deps.pendingTaskResults.set(this.task.id, {
        status: 'completed',
        response: payload.response,
        attachments,
        error: payload.error,
        model: this.deps.getModel(),
        storedAt: Date.now(),
        source: {
          channelType: this.message.channelType,
          channelId: this.message.channelId,
          sender: this.message.sender,
        },
      })
    }
  }

  private attachListeners(): void {
    // Approval listener
    this.onApprovalNeeded = (event: { data: unknown }) => {
      const data = event.data as Record<string, unknown>
      if (data.taskId !== this.task.id) return

      if (!this.resolved) {
        this.resolved = true
        console.log(`[Main] Returning approval notification for task ${this.task.id}`)
        this.resolve({
          success: true,
          status: 'waiting_approval',
          approval: {
            taskId: this.task.id,
            requestId: data.requestId as string,
            userId: data.userId as string,
            notification: data.notification as string,
          },
          model: this.deps.getModel(),
        })
      } else {
        console.log(
          `[Main] Storing approval notification for task ${this.task.id} (request: ${data.requestId})`
        )
        this.deps.pendingTaskResults.set(this.task.id, {
          status: 'waiting_approval',
          model: this.deps.getModel(),
          storedAt: Date.now(),
          source: {
            channelType: this.message.channelType,
            channelId: this.message.channelId,
            sender: this.message.sender,
          },
          approval: {
            requestId: data.requestId as string,
            userId: data.userId as string,
            notification: data.notification as string,
          },
        })
      }
    }

    if (this.deps.agent) {
      this.deps.agent.on('tool:approval_needed', this.onApprovalNeeded)
    }

    // See executeAsync's onApprovalConsumed for the rationale — same staleness
    // bug applies to subsequent-approval entries stored after the first resolve.
    this.onApprovalConsumed = (event: { data: unknown }) => {
      const data = event.data as Record<string, unknown>
      if (data.taskId !== this.task.id) return
      console.log(
        `[Main] Clearing stale approval entry for task ${this.task.id} ` +
          `(request: ${data.requestId})`
      )
      this.deps.pendingTaskResults.delete(this.task.id)
    }
    if (this.deps.agent) {
      this.deps.agent.on('tool:approval_granted', this.onApprovalConsumed)
      this.deps.agent.on('tool:approval_denied', this.onApprovalConsumed)
    }

    // Completion listener
    this.onComplete = (event: { task?: Task }) => {
      if (event.task?.id === this.task.id) {
        this.dispose()
      }
    }

    // Failure listener
    this.onFail = (event: { task?: Task }) => {
      if (event.task?.id !== this.task.id) return
      this.dispose()
      if (!this.resolved) {
        this.resolved = true
        const err: TaskError = event.task?.error ?? {
          code: LlmErrorCode.ApiCallFailed,
          message: 'Task failed',
          retryable: true,
          provider: 'unknown',
        }
        this.resolve({ success: false, error: err })
      }
    }

    this.deps.messageQueue.on('task:completed', this.onComplete)
    this.deps.messageQueue.on('task:failed', this.onFail)
  }

  private startTimeout(): void {
    const ms = this.deps.timeoutMs ?? 5 * 60 * 1000
    this.timeout = setTimeout(() => {
      if (!this.resolved) {
        this.resolved = true
        this.dispose()
        this.resolve({
          success: false,
          error: {
            code: LlmErrorCode.ApiCallFailed,
            message: 'Task processing timeout',
            retryable: true,
            provider: 'unknown',
          },
        })
      }
    }, ms)
  }

  private dispose(): void {
    if (this.timeout) {
      clearTimeout(this.timeout)
      this.timeout = null
    }
    if (this.onApprovalNeeded) {
      this.deps.agent?.removeListener('tool:approval_needed', this.onApprovalNeeded)
      this.onApprovalNeeded = null
    }
    if (this.onApprovalConsumed) {
      this.deps.agent?.removeListener('tool:approval_granted', this.onApprovalConsumed)
      this.deps.agent?.removeListener('tool:approval_denied', this.onApprovalConsumed)
      this.onApprovalConsumed = null
    }
    if (this.onComplete) {
      this.deps.messageQueue.off('task:completed', this.onComplete)
      this.onComplete = null
    }
    if (this.onFail) {
      this.deps.messageQueue.off('task:failed', this.onFail)
      this.onFail = null
    }
  }
}
