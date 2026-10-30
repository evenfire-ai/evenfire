import type { TaskBrakeTrip } from '../../budget/taskBrake'
import { logger } from '../../logger'
import { clerumCompactionTotal } from '../extensions/contextManager'
import type {
  Attachment,
  ChatMessage,
  LoopResult,
  ReasoningContext,
  RespondResult,
  TokenUsage,
  ToolDefinition,
  ToolResult,
} from '../types'
import type { LoopConfig } from './loopConfig'
import { MODEL_STEP_RETRY_DEADLINE_MS, modelStepRetryDelayMs } from './modelStepRetrySchedule'
import { isRetryableLlmTransportError } from './toolUseLoopIntentRecovery'

const LLM_TRANSPORT_RETRY_DELAY_MS = 350

export async function manageMessagesForIteration(
  config: LoopConfig,
  messages: ChatMessage[],
  iteration: number,
  tools: ToolDefinition[],
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
  // R21-1: pressure counts the tools this iteration presents, which in Codex
  // discovery mode or under the bridge latch exclude the deferred MCP schemas.
  const managed = await config.contextManager.manage(messages, config.conversation, {
    tools,
    systemPrompt: config.systemPromptFor?.(tools),
  })
  if (managed.length < beforeCount) {
    if (logCompaction) {
      logger.debug({ beforeCount, afterCount: managed.length, iteration }, 'Context compacted')
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

/** Cancels model-step retries 60 s after the first eligible provider_unavailable. */
function startRetryDeadline(firstFailureAt: number, taskSignal: AbortSignal | undefined) {
  const cap = new AbortController()
  const timer = setTimeout(
    () => cap.abort(new DOMException('Model step retry deadline reached', 'TimeoutError')),
    firstFailureAt + MODEL_STEP_RETRY_DEADLINE_MS - Date.now()
  )
  return {
    signal: taskSignal ? AbortSignal.any([taskSignal, cap.signal]) : cap.signal,
    get expired() {
      return cap.signal.aborted
    },
    dispose: () => clearTimeout(timer),
  }
}

export async function callReasoningForIteration(
  config: LoopConfig,
  context: ReasoningContext,
  lastToolResults: ToolResult[] | null,
  iteration: number
): Promise<{ result: RespondResult; continuingFromToolResults: boolean }> {
  let deadline: ReturnType<typeof startRetryDeadline> | undefined
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
    const callReasoning = async (signal: AbortSignal | undefined): Promise<RespondResult> => {
      const attemptContext = { ...context, signal }
      if (lastToolResults) {
        logger.debug(
          { iteration, resultCount: lastToolResults.length },
          'Continuing with tool results'
        )
        return config.reasoning.continueWithToolResults(attemptContext, lastToolResults)
      }
      logger.debug({ iteration }, 'Requesting model response')
      return config.reasoning.respondWithTools(attemptContext)
    }

    let result = await callReasoning(context.signal)
    if (
      result.type === 'error' &&
      isRetryableLlmTransportError(result.error) &&
      !config.abortSignal?.aborted
    ) {
      logger.warn({ iteration, err: result.error }, 'Retrying model transport failure')
      await delay(LLM_TRANSPORT_RETRY_DELAY_MS, config.abortSignal)
      if (!config.abortSignal?.aborted) {
        result = await callReasoning(context.signal)
      }
    }

    // #1043 — a failure that would leave a resumable checkpoint retries this
    // model step, inside the same heartbeat window, before the loop can settle
    // the checkpoint. The gate is the recorder's own settle predicate, so a
    // retry can only happen where a manual Retry model step would have been
    // offered. Each retry uses its jittered schedule wait. The counter and
    // 60 s deadline are per model step and consume no loop iteration. The
    // transport retry above keeps its task signal and does not start the clock.
    const checkpointRecorder = config.modelStepCheckpointRecorder
    const firstFailureAt = Date.now()
    const random = config.modelStepRetryRandom ?? Math.random
    let modelStepRetries = 0
    let retryCause: Error | undefined
    const logRetryDeadline = (inFlight: boolean) =>
      logger.warn(
        {
          iteration,
          attempt: modelStepRetries,
          deadlineMs: MODEL_STEP_RETRY_DEADLINE_MS,
          inFlight,
          checkpointId: checkpointRecorder?.checkpointId,
        },
        'Model step retry deadline reached'
      )
    while (
      result.type === 'error' &&
      modelStepRetries < (config.modelStepAutoRetries ?? 0) &&
      checkpointRecorder !== undefined &&
      checkpointRecorder.canResume(result.error) &&
      !config.abortSignal?.aborted
    ) {
      const delayMs = modelStepRetryDelayMs(modelStepRetries, random)
      if (Date.now() + delayMs >= firstFailureAt + MODEL_STEP_RETRY_DEADLINE_MS) {
        logRetryDeadline(false)
        break
      }
      modelStepRetries++
      // F6: the first failure of this step is the one that keeps the checkpoint
      // resumable when the retries end on another error.
      retryCause ??= result.error
      logger.warn(
        {
          iteration,
          attempt: modelStepRetries,
          limit: config.modelStepAutoRetries,
          delayMs,
          checkpointId: checkpointRecorder.checkpointId,
        },
        'Retrying model step after provider_unavailable'
      )
      await delay(delayMs, config.abortSignal)
      if (config.abortSignal?.aborted) break
      deadline ??= startRetryDeadline(firstFailureAt, config.abortSignal)
      const retried = await callReasoning(deadline.signal)
      if (config.abortSignal?.aborted) break
      if (deadline.expired) {
        // The cut attempt carries no provider evidence. Preserve the previous
        // provider failure and its resumable notice, including during failover.
        logRetryDeadline(true)
        break
      }
      result = retried
    }
    if (retryCause !== undefined && result.type === 'error') {
      checkpointRecorder?.noteModelStepRetry(retryCause, result.error)
    }

    // Latency attribution — one event per reasoning roundtrip. It covers the
    // single transport retry and every automatic model-step retry above, since
    // both stay inside this call. Consumed by the TaskExecutor [TurnTiming]
    // recorder; with no subscriber this is a no-op.
    config.events.emit({
      type: 'llm:completed',
      data: { iteration, durationMs: Date.now() - callStartedAt },
      timestamp: new Date(),
    })
    return { result, continuingFromToolResults }
  } finally {
    if (heartbeatInterval) clearInterval(heartbeatInterval)
    deadline?.dispose()
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
  logger.debug({ message: logMessage }, 'Loop response')
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
  logger.info(
    { unit: trip.unit, spent: trip.spent, limit: trip.limit, iteration },
    'Task budget brake reached'
  )
  config.events.emit({
    type: 'loop:completed',
    data: { iteration, resultType: 'task_brake', brakeUnit: trip.unit },
    timestamp: new Date(),
  })
  return {
    type: 'exhaustion',
    reason: 'task_budget',
    message: TASK_BUDGET_BRAKE_MESSAGE,
    iterations: iteration,
    attachments: attachments.length > 0 ? attachments : undefined,
  }
}

/**
 * A15 U1 — a trusted tool result ended the turn (`ToolResult.stopTurn`). Like
 * the task brake, the task completes normally: `message` is the reply and the
 * attachments collected so far are kept. No further model call is made.
 */
export function turnStopResult(
  config: LoopConfig,
  iterations: number,
  message: string,
  attachments: Attachment[]
): LoopResult {
  logger.info({ iterations }, 'Turn stopped by a tool result')
  config.events.emit({
    type: 'loop:completed',
    data: { iteration: iterations, resultType: 'turn_stop' },
    timestamp: new Date(),
  })
  return {
    type: 'exhaustion',
    reason: 'turn_stop',
    message,
    iterations,
    attachments: attachments.length > 0 ? attachments : undefined,
  }
}

export function exhaustionResult(
  config: LoopConfig,
  maxIterations: number,
  message: string,
  attachments: Attachment[]
): LoopResult {
  logger.info({ iterations: maxIterations }, 'Loop iteration limit reached')
  config.events.emit({
    type: 'loop:completed',
    data: { iteration: maxIterations, resultType: 'exhaustion' },
    timestamp: new Date(),
  })
  return {
    type: 'exhaustion',
    reason: 'iteration_limit',
    message,
    iterations: maxIterations,
    attachments: attachments.length > 0 ? attachments : undefined,
  }
}
