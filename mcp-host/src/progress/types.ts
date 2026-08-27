// mcp-host/src/progress/types.ts
import type { CanonicalReason } from '../lifecycle/types.js'
import type { TaskError } from '../queue/types.js'

export interface ProgressReporter {
  reportToolStart(event: ToolStartEvent): void
  reportToolComplete(event: ToolCompleteEvent): void
  reportToolProgress(event: ToolProgressEvent): void
  reportThinking(event: ThinkingEvent): void
  reportLlmInProgress(event: LlmInProgressEvent): void
  // Terminal emission is driven by TaskLifecycle subscription in the reporter implementation.
  // No public API for terminal emission — callers route through TaskLifecycle.transition.
}

export interface OutputPreview {
  headLines: string[]
  tailLines: string[]
  totalLines: number
  truncated: boolean
}

export interface ToolStartEvent {
  taskId: string
  toolCallId: string
  toolName: string
  displayName: string
  intentSummary: string
  iteration: number
  stepIndex: number
  totalSteps: number
  inputPreview?: string
}

/** Tokens of the LLM call that requested this tool. Same shape and semantics
 *  as SessionTokensWire (server/types.ts) — declared locally because progress/
 *  is upstream of server/. cacheRead/cacheWrite are present ONLY when the
 *  provider reports cache info (Anthropic); absent for OpenAI/zai/bailian.
 *  Attached ONLY to the first emitted step of the iteration's batch (the
 *  batch shares one LLM call). */
export interface ToolCallTokens {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export interface ToolCompleteEvent {
  taskId: string
  toolCallId: string
  toolName: string
  displayName: string
  durationMs: number
  isError: boolean
  errorSummary?: string
  iteration: number
  stepIndex: number
  totalSteps: number
  outputPreview?: OutputPreview
  metadata?: Record<string, unknown>
  tokens?: ToolCallTokens
}

export interface ToolProgressEvent {
  taskId: string
  toolCallId: string
  toolName: string
  elapsedMs: number
  /**
   * Output snapshot since the last tick. Omitted when the command produced
   * no new bytes in this window — clients should tick `elapsedMs` regardless
   * (so silent long-running commands still show elapsed time) and preserve
   * any previously-displayed preview rather than clearing it.
   */
  outputPreview?: OutputPreview
}

export interface ThinkingEvent {
  taskId: string
  summary: string
}

/**
 * Emitted periodically while the reasoning loop is blocked on a single LLM
 * inference call. The Desktop App uses this as a keep-alive so its 30s
 * no-event watchdog does not fire during slow completions (e.g. glm-4.7
 * regularly takes 60s+ on large prompts).
 */
export interface LlmInProgressEvent {
  taskId: string
  iteration: number
  /** Milliseconds elapsed since the current LLM call started. */
  elapsedMs: number
}

export interface SuspendedEvent {
  taskId: string
  requestId: string
  // P1-1: the approval event carries ONLY the server-derived displayName, never
  // the raw tool_name (mirrors the REST `pendingApproval` wire shape; the
  // progress stream is owner-scoped). NOTE: the operator-only `GET /status`
  // endpoint still exposes raw tool_name in `pendingApprovals[]` — separate
  // channel, tracked as a follow-up.
  displayName: string
  // U5 — 'connect_required' is a reactive OAuth-consent suspension; the default
  // HITL gate stays 'approval_required'.
  reason: 'approval_required' | 'connect_required'
  /** Set iff reason==='connect_required' — the oauth mcp-server to connect. */
  mcpServerName?: string
}

/**
 * Unified terminal event (spec §6.3). Emitted by SseProgressReporter when
 * TaskLifecycle transitions to a terminal state. Discriminated by `status`.
 *
 * - status='completed': client should fetch /result for the response payload
 * - status='failed':    error payload is inline; no /result fetch needed
 * - status='cancelled': no fetch, render cancelled badge with reason
 */
export interface TerminalEvent {
  taskId: string
  status: 'completed' | 'failed' | 'cancelled'
  reason: CanonicalReason
  error?: TaskError // iff status='failed'
}

/** Union of all SSE event payloads */
export type ProgressEvent =
  | { type: 'tool_start'; data: ToolStartEvent }
  | { type: 'tool_complete'; data: ToolCompleteEvent }
  | { type: 'tool_progress'; data: ToolProgressEvent }
  | { type: 'llm_in_progress'; data: LlmInProgressEvent }
  | { type: 'suspended'; data: SuspendedEvent }
  | { type: 'terminal'; data: TerminalEvent }
