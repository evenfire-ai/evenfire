/**
 * Types for the agent system.
 */
import { Task } from '../queue/types'

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
    channelType: 'telegram' | 'email' | 'slack' | 'rpc'
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
