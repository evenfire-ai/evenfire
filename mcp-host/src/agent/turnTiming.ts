/**
 * Per-turn phase timing attribution (stateless-agents latency work).
 *
 * A TurnTimingRecorder accumulates cheap Date.now() phase durations for one
 * task (turn) and emits a single machine-parseable info line on completion:
 *
 *   [TurnTiming] {"taskId":"...","total_ms":...,"queue_wait_ms":...,
 *     "session_load_ms":...,"prompt_assembly_ms":...,"llm_wall_ms":...,
 *     "llm_calls":...,"tool_loop_ms":...,"tools_called":...,
 *     "input_chars_approx":...}
 *
 * Contract (observability only, NO behavior change):
 *  - every method is fail-safe: a timing bug must never throw into the turn
 *    (explicit requirement of the attribution mission)
 *  - all math is Date.now() stamps; no tokenization, no async work
 */

export interface TurnTimingSnapshot {
  taskId: string
  /** Wall time from task creation (enqueue) to emission. */
  total_ms: number
  /** Task creation -> executor run() start. */
  queue_wait_ms: number
  /** Conversation getOrCreate + startTurn + history rehydration/compaction. */
  session_load_ms: number
  /** buildLoopConfig: tool registry (MCP schemas) + system identity build. */
  prompt_assembly_ms: number
  /** Sum of reasoning roundtrip wall times (includes provider latency). */
  llm_wall_ms: number
  /** Number of reasoning roundtrips (loop iterations that called the LLM). */
  llm_calls: number
  /** Sum of tool execution wall times reported by the loop. */
  tool_loop_ms: number
  /** Number of tool invocations in the turn. */
  tools_called: number
  /** Approximate chars of conversation input sent to the first LLM call. */
  input_chars_approx: number
}

export class TurnTimingRecorder {
  private readonly createdAtMs: number
  private readonly startedAtMs: number
  private sessionLoadMs = 0
  private promptAssemblyMs = 0
  private llmWallMs = 0
  private llmCalls = 0
  private toolLoopMs = 0
  private toolsCalled = 0
  private inputCharsApprox = 0

  constructor(taskCreatedAt?: Date, nowMs: number = Date.now()) {
    this.startedAtMs = nowMs
    const created = taskCreatedAt instanceof Date ? taskCreatedAt.getTime() : Number.NaN
    this.createdAtMs = Number.isFinite(created) && created <= nowMs ? created : nowMs
  }

  addSessionLoadMs(ms: number): void {
    this.sessionLoadMs += clampMs(ms)
  }

  addPromptAssemblyMs(ms: number): void {
    this.promptAssemblyMs += clampMs(ms)
  }

  setInputCharsApprox(chars: number): void {
    this.inputCharsApprox = Number.isFinite(chars) && chars > 0 ? Math.floor(chars) : 0
  }

  /**
   * Feed loop events. Wired into the TaskExecutor tracking emitter so the
   * recorder observes the same 'llm:completed' / 'tool:called' /
   * 'tool:completed' stream the loop already emits. Never throws.
   */
  recordEvent(type: string, data: unknown): void {
    try {
      const d = (data ?? {}) as Record<string, unknown>
      if (type === 'llm:completed') {
        this.llmCalls += 1
        this.llmWallMs += clampMs(typeof d.durationMs === 'number' ? d.durationMs : 0)
      } else if (type === 'tool:called') {
        this.toolsCalled += 1
      } else if (type === 'tool:completed') {
        this.toolLoopMs += clampMs(typeof d.duration_ms === 'number' ? d.duration_ms : 0)
      }
    } catch {
      // Fail-safe by explicit mission requirement: timing must never throw.
    }
  }

  snapshot(taskId: string, nowMs: number = Date.now()): TurnTimingSnapshot {
    return {
      taskId,
      total_ms: clampMs(nowMs - this.createdAtMs),
      queue_wait_ms: clampMs(this.startedAtMs - this.createdAtMs),
      session_load_ms: this.sessionLoadMs,
      prompt_assembly_ms: this.promptAssemblyMs,
      llm_wall_ms: this.llmWallMs,
      llm_calls: this.llmCalls,
      tool_loop_ms: this.toolLoopMs,
      tools_called: this.toolsCalled,
      input_chars_approx: this.inputCharsApprox,
    }
  }

  /**
   * Emit the single [TurnTiming] info line for a completed turn. Fail-safe:
   * serialization or logger errors are contained (explicit mission
   * requirement — timing must never throw into the completion path).
   */
  emit(taskId: string, log: (line: string) => void = console.log): void {
    try {
      log('[TurnTiming] ' + JSON.stringify(this.snapshot(taskId)))
    } catch {
      // Fail-safe by explicit mission requirement: timing must never throw.
    }
  }
}

function clampMs(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0
}
