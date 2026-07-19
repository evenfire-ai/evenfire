/**
 * Types for the agent system.
 */
import type { SingleTurnProvider } from '../llm'
import type { FailoverEngine } from '../llm/failover/engine'
import type { FallbackEntry, LlmPolicy } from '../llm/failover/types'
import { Task } from '../queue/types'

/**
 * R5 — per-task provider-fallback support injected into the agent (built in
 * `main.ts` over the live ConfigStore keys). When present with a non-empty
 * `policy.fallbacks`, each task's `LlmPort` is wrapped so an eligible provider
 * error switches to the next fallback below the loop. Absent = no failover =
 * byte-identical to today.
 */
export interface ExecutorFailoverSupport {
  /** Host-wide sticky failover state (cooldown + served pair). */
  engine: FailoverEngine
  /** Normalized policy for THIS task (fallbacks may be pre-sliced at boot). */
  policy: LlmPolicy
  /**
   * Build a fresh provider instance for a fallback entry from the LIVE
   * ConfigStore keys; `null` when the entry's provider/credentials are absent.
   */
  buildProvider: (entry: FallbackEntry) => SingleTurnProvider | null
}

/** Returns the current {@link ExecutorFailoverSupport}, or null when no policy. */
export type FailoverSupportProvider = () => ExecutorFailoverSupport | null

/**
 * R2 — per-task model resolution. `resolveTaskModel` (built in `main.ts`,
 * injected into the agent) turns a session's saved `{ provider → model }`
 * selection map into the concrete provider instance + effective model to run
 * the task with. Built PER TASK from the live ConfigStore keys so a key
 * rotation never reverts a session's selection (the next task rebuilds with the
 * new key). Returns `null` when no Host model is configured or the provider
 * cannot be built (dev/tests fall back to the agent's default provider).
 */
export interface ResolvedTaskModel {
  provider: SingleTurnProvider
  model: string
  /** Context-window override from the allowlist entry for `model` (R2.6). */
  contextWindowTokens?: number
}

export type TaskModelResolver = (
  selections: Record<string, string> | undefined
) => ResolvedTaskModel | null

/**
 * Agent state.
 */
export type AgentState =
  | 'idle' // No active task, ready to process
  | 'processing' // Processing a task
  | 'waiting_tool' // Waiting for tool execution
  | 'paused' // Manually paused
  | 'error' // In error state
  | 'waiting_approval' // Waiting for user to approve a tool call

/**
 * Agent configuration.
 */
export interface AgentConfig {
  // Maximum time to process a single task (ms)
  maxTaskDuration: number

  // Maximum tool calls per task
  maxToolCallsPerTask: number

  // Whether to auto-start processing
  autoStart: boolean

  // Processing delay between tasks (ms)
  taskDelay: number

  // Timeout for approval responses (ms). 0 = no timeout.
  approvalTimeout: number
}

/**
 * Default agent configuration.
 */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxTaskDuration: 5 * 60 * 1000, // 5 minutes
  maxToolCallsPerTask: 50,
  autoStart: true,
  taskDelay: 100, // 100ms between tasks
  approvalTimeout: 0, // 0 = no in-memory auto-deny; the request stays available until resolved. Override via CLERUM_APPROVAL_TIMEOUT
}

/**
 * Agent statistics.
 */
export interface AgentStats {
  state: AgentState
  currentTaskId: string | null
  tasksProcessed: number
  tasksSucceeded: number
  tasksFailed: number
  totalToolCalls: number
  uptime: number // ms since start
  lastTaskCompletedAt: Date | null
}

/**
 * Tool execution request.
 */
export interface ToolExecutionRequest {
  taskId: string
  toolName: string
  arguments: Record<string, unknown>
}

/**
 * Tool execution result.
 */
export interface ToolExecutionResult {
  taskId: string
  toolName: string
  result: unknown
  isError: boolean
  executionTime: number // ms
}

/**
 * Cron job definition.
 */
export interface CronJob {
  id: string
  name: string
  schedule: string // Cron expression
  task: string // Task content/prompt
  enabled: boolean
  lastRun?: Date
  nextRun?: Date
  createdAt: Date
  createdBy?: string // Task ID that created this cron
  origin?: {
    channelType: 'telegram' | 'email' | 'slack' | 'teams' | 'rpc'
    channelId: string
    sender: string
  }
}

/**
 * Agent event types.
 */
export type AgentEventType =
  | 'state:changed'
  | 'task:started'
  | 'task:completed'
  | 'task:failed'
  | 'tool:called'
  | 'tool:completed'
  | 'tool:approval_needed'
  | 'tool:approval_granted'
  | 'tool:approval_denied'
  | 'cron:created'
  | 'cron:triggered'
  | 'cron:deleted'

/**
 * Agent event payload.
 */
export interface AgentEvent {
  type: AgentEventType
  data: unknown
  timestamp: Date
}
