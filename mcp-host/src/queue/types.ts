/**
 * Types for the message queue and task system.
 */
import type { BudgetVerdict } from '../budget/types'
import type { Attachment } from '../core/types'
import { IncomingMessage } from '../server'

/**
 * A structured error for a task that failed.
 *
 * Flows unchanged through all four user-delivery channels:
 * task.responseCallback, sync POST /messages response, async pendingTaskResults
 * polling, and the SSE progress stream's "error" event.
 *
 * See docs/superpowers/specs/2026-04-10-llm-error-handling-design.md.
 */
export interface TaskError {
  code: string // LlmErrorCode string, e.g. "LLM_INSUFFICIENT_QUOTA"
  message: string // raw provider message, passed through verbatim
  /**
   * Advisory hint for the UI: if true, a manual "Retry" affordance may succeed.
   * NOT a system behavior driver — mcp-host itself never retries based on this flag.
   */
  retryable: boolean
  provider: string // a registered LlmProvider id (llm/registryCore.ts) or "unknown"
}

export interface TaskResponsePayload {
  response?: string // optional — absent on failure
  attachments?: Attachment[]
  error?: TaskError // present iff task failed
}

/**
 * Task status in the state machine.
 */
export type TaskStatus =
  | 'pending' // In queue, waiting to be processed
  | 'processing' // Currently being processed by the agent
  | 'waiting_approval' // Waiting for user to approve a tool call
  | 'completed' // Successfully completed
  | 'failed' // Failed with error
  | 'cancelled' // Cancelled by user or system

/**
 * Task priority levels.
 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'

/**
 * Task source types.
 */
export type TaskSource =
  | 'channel' // From channel-reader (Telegram, Email, Slack)
  | 'cron' // From cron scheduler
  | 'internal' // Internal system task

/**
 * A task in the queue.
 */
export interface Task {
  // Unique task identifier
  id: string

  // Task source information
  source: TaskSource
  sourceMessage?: IncomingMessage

  // Task metadata
  priority: TaskPriority
  status: TaskStatus

  // Conversation history for multi-turn interactions
  conversationHistory: ConversationMessage[]

  // Timestamps
  createdAt: Date
  startedAt?: Date
  completedAt?: Date

  // Results
  result?: TaskResult
  error?: TaskError

  // Optional cron information
  cronJobId?: string

  // Response callback for channel messages
  responseCallback?: (payload: TaskResponsePayload) => Promise<void>

  /**
   * P1 token budgets — the verdict from the pre-task budget check, persisted
   * here when `allowed` so the P2 per-task brake (max_task_amount) can read
   * `maxTaskTokens`/`maxTaskCost`/`price` without re-querying. Absent when the
   * budgets flag is off or the check failed open.
   */
  budgetVerdict?: BudgetVerdict
}

/**
 * Conversation message for maintaining context.
 */
export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  timestamp: Date
  toolCallId?: string
  toolName?: string
}

/**
 * Task result after completion.
 */
export interface TaskResult {
  response: string
  model: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  toolsUsed?: string[]
  artifacts?: TaskArtifact[]
}

/**
 * Artifacts created during task execution.
 */
export interface TaskArtifact {
  type: 'file' | 'code' | 'cronjob' | 'other'
  name: string
  content: string
  metadata?: Record<string, unknown>
}

/**
 * Queue statistics.
 */
export interface QueueStats {
  pending: number
  processing: number
  completed: number
  failed: number
  total: number
}

/**
 * Event types emitted by the queue.
 */
export type QueueEventType =
  | 'task:added'
  | 'task:started'
  | 'task:completed'
  | 'task:failed'
  | 'task:cancelled'
  | 'queue:empty'
  | 'queue:drained'
  | 'queue:full'

/**
 * Queue event payload.
 */
export interface QueueEvent {
  type: QueueEventType
  task?: Task
  timestamp: Date
}
