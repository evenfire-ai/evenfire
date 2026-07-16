import type { TaskBrakeTrip } from '../../budget/taskBrake'
import { clerumCompactionTotal } from '../extensions/contextManager'
import type {
  Attachment,
  ChatMessage,
  LoopResult,
  ReasoningContext,
  RespondResult,
  TokenUsage,
  ToolResult,
} from '../types'
import type { LoopConfig } from './loopConfig'
import { isRetryableLlmTransportError } from './toolUseLoopIntentRecovery'

const LLM_TRANSPORT_RETRY_DELAY_MS = 350

export async function manageMessagesForIteration(
  config: LoopConfig,
  messages: ChatMessage[],
  iteration: number,
  logCompaction = false
): Promise<ChatMessage[]> {
  // IronClaw invariant #1 (P.3 §4.1): if the conversation has a pending_approval,
  // the snapshot frozen at suspend time is the source of truth. Compaction here
  // would mutate `messages` and invalidate the snapshot. Skip silently and emit a
  // typed event for observability. `logCompaction` doubles as the pre-LLM (true)
  // vs post-tool (false) phase discriminator at the two call sites.
  if (config.skipContextManager) {
    config.events.emit({
      type: 'compaction:skipped',
      data: {
        reason: 'pending_approval',
        iteration,
        phase: logCompaction ? 'pre_llm' : 'post_tool',
      },
      timestamp: new Date(),
    })
    // T1.4 / P.3 cross-plan: the loop owns the `skipped:pending_approval` counter
    // increment (cross-plan discovery 2026-05-22). The manager's own outcomes
    // (`ok`/`thrashing`) are mutually exclusive with this one.
    clerumCompactionTotal.inc({ tier: 'none', outcome: 'skipped:pending_approval' })
    return messages
  }
  const beforeCount = messages.length
  // P.5: the canonical signature requires the conversation so the manager's
  // defensive guard and tier selection can see `pending_approval`/state.
  const managed = await config.contextManager.manage(messages, config.conversation)
  if (managed.length < beforeCount) {
    if (logCompaction) {
      console.log(
        `[ContextManager] context:compacted — before=${beforeCount}, after=${managed.length}, dropped=${beforeCount - managed.length}, iter=${iteration}`
      )
    }
    config.events.emit({
      type: 'context:compacted',
      data: {
        beforeCount,
        afterCount: managed.length,
        droppedCount: beforeCount - managed.length,
        iteration,
      },
      timestamp: new Date(),
    })
  }
  return managed
}

export async function callReasoningForIteration(
  config: LoopConfig,
  context: ReasoningContext,
  lastToolResults: ToolResult[] | null,
  iteration: number
): Promise<{ result: RespondResult; continuingFromToolResults: boolean }> {
  const callStartedAt = Date.now()
  const heartbeatInterval = config.progressReporter
    ? setInterval(() => {
        try {
          config.progressReporter!.reportLlmInProgress({
            taskId: '',
            iteration,
            elapsedMs: Date.now() - callStartedAt,
          })
        } catch {
          // Reporter errors are non-fatal.
        }
      }, 10_000)
    : null
  try {
    const continuingFromToolResults = Boolean(lastToolResults)
    const callReasoning = async (): Promise<RespondResult> => {
      if (lastToolResults) {
        console.log(
          `[NewCore:Loop] iter=${iteration} → continueWithToolResults (${lastToolResults.length} results)`
        )
        return config.reasoning.continueWithToolResults(context, lastToolResults)
      }
      console.log(`[NewCore:Loop] iter=${iteration} → respondWithTools`)
      return config.reasoning.respondWithTools(context)
    }

    let result = await callReasoning()
    if (
      result.type === 'error' &&
      isRetryableLlmTransportError(result.error) &&
      !config.abortSignal?.aborted
    ) {
      console.log(
        `[NewCore:Loop] iter=${iteration} → retrying retryable LLM transport error once: ${result.error.message}`
      )
      await delay(LLM_TRANSPORT_RETRY_DELAY_MS, config.abortSignal)
      if (!config.abortSignal?.aborted) {
        result = await callReasoning()
      }
    }

    // Latency attribution — one event per reasoning roundtrip (covers the
    // single transport retry above when it fires). Consumed by the
    // TaskExecutor [TurnTiming] recorder; with no subscriber this is a no-op.
    config.events.emit({
      type: 'llm:completed',
      data: { iteration, durationMs: Date.now() - callStartedAt },
      timestamp: new Date(),
    })
    return { result, continuingFromToolResults }
  } finally {
    if (heartbeatInterval) clearInterval(heartbeatInterval)
  }
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return
  await new Promise<void>(resolve => {
    const timeout = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true }
    )
  })
}

export function responseResult(
  config: LoopConfig,
  iteration: number,
  content: string,
  usage: TokenUsage,
  attachments: Attachment[],
  logMessage: string
): LoopResult {
  console.log(logMessage)
  config.events.emit({
    type: 'loop:completed',
    data: { iteration, resultType: 'response' },
    timestamp: new Date(),
  })
  return {
    type: 'response',
    content,
    usage,
    attachments: attachments.length > 0 ? attachments : undefined,
  }
}

/**
 * User-facing message returned when the P2 per-task budget brake trips. The
 * brake fires BETWEEN iterations (before the next LLM call), so any work
 * already produced (tool results, attachments) is preserved and returned
 * alongside this notice.
 */
export const TASK_BUDGET_BRAKE_MESSAGE =
  'This task reached its per-task usage budget and was stopped before the next ' +
  'model call. Any results produced so far are included above.'

/**
 * P2 token budgets (§5.2) — terminate the loop cleanly when the per-task brake
 * trips. Modeled on `exhaustionResult` (a graceful "limit hit" exit that
 * preserves collected work) rather than `cancelled` (which would scrub the
 * turn): the task completes normally with the brake notice + any attachments,
 * so the work done up to the cut is not lost.
 */
export function taskBrakeResult(
  config: LoopConfig,
  iteration: number,
  trip: TaskBrakeTrip,
  attachments: Attachment[]
): LoopResult {
  console.log(
    `[NewCore:Loop] EXIT → task budget brake (${trip.unit}: spent=${trip.spent} > limit=${trip.limit}), iterations=${iteration}`
  )
  config.events.emit({
    type: 'loop:completed',
    data: { iteration, resultType: 'task_brake', brakeUnit: trip.unit },
    timestamp: new Date(),
  })
  return {
    type: 'exhaustion',
    message: TASK_BUDGET_BRAKE_MESSAGE,
    iterations: iteration,
    attachments: attachments.length > 0 ? attachments : undefined,
  }
}

export function exhaustionResult(
  config: LoopConfig,
  maxIterations: number,
  message: string,
  attachments: Attachment[]
): LoopResult {
  console.log(`[NewCore:Loop] EXIT → exhaustion, iterations=${maxIterations}`)
  config.events.emit({
    type: 'loop:completed',
    data: { iteration: maxIterations, resultType: 'exhaustion' },
    timestamp: new Date(),
  })
  return {
    type: 'exhaustion',
    message,
    iterations: maxIterations,
    attachments: attachments.length > 0 ? attachments : undefined,
  }
}
