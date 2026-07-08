// mcp-host/src/progress/sseProgressReporter.ts
import type { Safety } from '../core/interfaces.js'
import type { TaskLifecycle } from '../lifecycle/taskLifecycle.js'
import type { TransitionEvent } from '../lifecycle/types.js'
import type {
  LlmInProgressEvent,
  OutputPreview,
  ProgressEvent,
  ProgressReporter,
  TerminalEvent,
  ThinkingEvent,
  ToolCompleteEvent,
  ToolProgressEvent,
  ToolStartEvent,
} from './types.js'

export class SseProgressReporter implements ProgressReporter {
  private subscribers = new Set<(event: ProgressEvent) => void>()
  private completed = false
  public completedAt: number = Infinity

  // Terminal events are buffered so late subscribers get an immediate replay.
  // This handles the race where the LLM fails fast (~2s) before the desktop
  // app's SSE connection is established.
  private terminalBuffer: ProgressEvent[] = []

  // P1 - approval stuck and lost response: sticky replay of the last
  // non-terminal `suspended` event. The desktop SSE bridge reconnects invisibly
  // to the tracker (up to 3 attempts) and re-subscribes here; if a transient
  // blip falls AFTER emitSuspended published, the live suspended state would be
  // lost forever (only terminal events were replayed). We keep the last
  // suspended event so a late/re-connected subscriber can rebuild the live gate
  // state. Holds the SAME redacted payload published live (server-derived
  // displayName via getDisplayName — never the raw tool_name or args).
  private lastSuspended: ProgressEvent | undefined = undefined

  private lifecycleUnsubscribe: (() => void) | null = null

  // safety is the SSE redaction chokepoint; required so callers can't silently opt out. Tests pass NoopSafety from core/safety.
  constructor(
    public readonly taskId: string,
    lifecycle: TaskLifecycle | undefined,
    private readonly safety: Safety
  ) {
    if (lifecycle) this.subscribeToLifecycle(lifecycle)
  }

  // Phase D.2: subscribe to all three terminal transitions and emit a single
  // typed 'terminal' event for each. Legacy reportCancelled/reportError/complete
  // public methods are removed — all terminal emission flows through here.
  private subscribeToLifecycle(lifecycle: TaskLifecycle): void {
    const handler = (ev: TransitionEvent) => {
      try {
        if (ev.taskId !== this.taskId) return
        if (ev.to === 'completed' || ev.to === 'failed' || ev.to === 'cancelled') {
          this.emitTerminal({
            taskId: this.taskId,
            status: ev.to,
            reason: ev.reason,
            error: ev.error,
          })
        }
      } catch (err) {
        // Invariant I11: TaskLifecycle subscribers MUST be exception-safe.
        // A throw here would halt Node's EventEmitter.emit() and stall
        // other subscribers (e.g., AgentStateMachine's executor.abort() dispatcher).
        console.error('[SseProgressReporter] lifecycle handler raised', {
          taskId: this.taskId,
          err,
        })
      }
    }
    lifecycle.on('transition', handler)
    this.lifecycleUnsubscribe = () => lifecycle.off('transition', handler)
  }

  private emitTerminal(data: TerminalEvent): void {
    if (this.completed) return
    const safe = this.redactTerminal(data)
    const event: ProgressEvent = { type: 'terminal', data: safe }
    this.terminalBuffer.push(event)
    this.publish(event)
    this.completed = true
    this.completedAt = Date.now()
  }

  /**
   * Clean up subscription. Call when reporter is no longer needed.
   */
  dispose(): void {
    this.lifecycleUnsubscribe?.()
    this.lifecycleUnsubscribe = null
  }

  subscribe(handler: (event: ProgressEvent) => void): () => void {
    this.subscribers.add(handler)
    // Replay buffered terminal events for late subscribers
    for (const event of this.terminalBuffer) {
      try {
        handler(event)
      } catch {
        /* swallow */
      }
    }
    // replay the sticky suspended state so a late/re-connected subscriber
    // can render the live approval gate instead of being stuck on "Connecting".
    // Guarded by !this.completed (mirrors the per-event completed guards) so a
    // terminal task never replays a stale suspended; lastSuspended is also
    // cleared once execution resumes past the gate (see reportToolStart /
    // reportLlmInProgress).
    if (!this.completed && this.lastSuspended) {
      try {
        handler(this.lastSuspended)
      } catch {
        /* swallow */
      }
    }
    return () => {
      this.subscribers.delete(handler)
    }
  }

  reportToolStart(event: ToolStartEvent): void {
    if (this.completed) return
    // P1: a tool start AFTER a suspend means the gate was resolved and the loop
    // resumed (the approved tool is now executing). Drop the sticky suspended so
    // a late subscriber never sees an already-resolved approval.
    this.lastSuspended = undefined
    const safe = this.redactToolStart(event)
    this.publish({ type: 'tool_start', data: { ...safe, taskId: this.taskId } })
  }

  reportToolComplete(event: ToolCompleteEvent): void {
    if (this.completed) return
    const safe = this.redactToolComplete(event)
    this.publish({ type: 'tool_complete', data: { ...safe, taskId: this.taskId } })
  }

  reportToolProgress(event: ToolProgressEvent): void {
    if (this.completed) return
    const safe = this.redactToolProgress(event)
    this.publish({ type: 'tool_progress', data: { ...safe, taskId: this.taskId } })
  }

  reportThinking(event: ThinkingEvent): void {
    // Reserved — when implementing, redact event.summary via redactString to keep boundary coverage.
    void event
  }

  reportLlmInProgress(event: LlmInProgressEvent): void {
    if (this.completed) return
    // P1: LLM back in progress after a suspend means the gate resolved and the
    // loop fed the tool result back to the model. Clear the sticky suspended.
    this.lastSuspended = undefined
    this.publish({ type: 'llm_in_progress', data: { ...event, taskId: this.taskId } })
  }

  // P1-1: takes only the server-derived displayName (not the raw tool_name).
  emitSuspended(displayName: string, requestId: string): void {
    if (this.completed) return
    const event: ProgressEvent = {
      type: 'suspended',
      data: { taskId: this.taskId, requestId, displayName, reason: 'approval_required' },
    }
    // P1: store the exact redacted payload we publish live so late/re-connected
    // subscribers can replay it (see subscribe). displayName is already the
    // server-derived name from getDisplayName — never the raw tool_name/args.
    this.lastSuspended = event
    this.publish(event)
  }

  // Boundary redaction helpers: idempotent re-pass over upstream sanitize in toolUseLoop.
  private redactString(toolName: string, value: string | undefined): string | undefined {
    if (!value) return value
    return this.safety.sanitizeOutput(toolName, value).content
  }

  private redactToolStart(e: ToolStartEvent): ToolStartEvent {
    return {
      ...e,
      intentSummary: this.redactString(e.toolName, e.intentSummary) ?? e.intentSummary,
      inputPreview: this.redactString(e.toolName, e.inputPreview),
    }
  }

  private redactPreview(
    toolName: string,
    preview: OutputPreview | undefined
  ): OutputPreview | undefined {
    if (!preview) return preview
    return {
      ...preview,
      headLines: preview.headLines.map(l => this.redactString(toolName, l) ?? l),
      tailLines: preview.tailLines.map(l => this.redactString(toolName, l) ?? l),
    }
  }

  private redactMetadata(toolName: string, value: unknown): unknown {
    if (typeof value === 'string') return this.redactString(toolName, value) ?? value
    if (Array.isArray(value)) return value.map(item => this.redactMetadata(toolName, item))
    if (!value || typeof value !== 'object') return value
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output[key] = this.redactMetadata(toolName, child)
    }
    return output
  }

  private redactToolComplete(e: ToolCompleteEvent): ToolCompleteEvent {
    return {
      ...e,
      errorSummary: this.redactString(e.toolName, e.errorSummary),
      outputPreview: this.redactPreview(e.toolName, e.outputPreview),
      metadata: this.redactMetadata(e.toolName, e.metadata) as Record<string, unknown> | undefined,
    }
  }

  private redactToolProgress(e: ToolProgressEvent): ToolProgressEvent {
    return {
      ...e,
      outputPreview: this.redactPreview(e.toolName, e.outputPreview),
    }
  }

  private redactTerminal(e: TerminalEvent): TerminalEvent {
    if (!e.error) return e
    const redactedMessage = this.redactString('__terminal__', e.error.message) ?? e.error.message
    return {
      ...e,
      error: { ...e.error, message: redactedMessage },
    }
  }

  private publish(event: ProgressEvent): void {
    for (const handler of this.subscribers) {
      try {
        handler(event)
      } catch {
        // Swallow subscriber errors
      }
    }
  }
}

/**
 * TTL for completed reporters. 5 minutes matches the RPC JWT token lifetime,
 * ensuring the Desktop App can always connect to a stream for tasks that finished
 * within the current auth window. Previously 60s, which caused "temporarily
 * unavailable" errors when the stream connected even slightly late.
 */
const REPORTER_TTL_MS = 5 * 60 * 1000

type Waiter = {
  resolve: (reporter: SseProgressReporter) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Registry that stores SseProgressReporter instances keyed by taskId.
 *
 * Extends plain Map storage with:
 * - TTL-based cleanup (reporters are evicted `REPORTER_TTL_MS` after completion)
 * - `waitFor(taskId, timeoutMs)` — returns a Promise that resolves when the
 *   reporter for `taskId` becomes available. This eliminates the race condition
 *   where the Desktop App opens the progress stream before the agent dequeues
 *   the task and creates its reporter.
 */
class ProgressReporterRegistry {
  private store = new Map<string, SseProgressReporter>()
  private waiters = new Map<string, Waiter[]>()

  set(id: string, reporter: SseProgressReporter): void {
    this.store.set(id, reporter)

    // Wake any waiters blocked on this taskId
    const pending = this.waiters.get(id)
    if (pending) {
      this.waiters.delete(id)
      for (const waiter of pending) {
        clearTimeout(waiter.timer)
        waiter.resolve(reporter)
      }
    }
  }

  get(id: string): SseProgressReporter | undefined {
    this.cleanup()
    return this.store.get(id)
  }

  delete(id: string): boolean {
    return this.store.delete(id)
  }

  /**
   * Wait for a reporter to appear in the registry.
   *
   * If the reporter already exists, resolves immediately.
   * Otherwise blocks until `set(taskId, ...)` is called or `timeoutMs` elapses.
   * Returns `undefined` on timeout.
   */
  waitFor(taskId: string, timeoutMs: number = 30_000): Promise<SseProgressReporter | undefined> {
    this.cleanup()
    const existing = this.store.get(taskId)
    if (existing) return Promise.resolve(existing)

    return new Promise<SseProgressReporter | undefined>(resolve => {
      const timer = setTimeout(() => {
        // Timeout — remove this waiter and resolve with undefined
        const list = this.waiters.get(taskId)
        if (list) {
          const idx = list.findIndex(w => w.resolve === resolve)
          if (idx >= 0) list.splice(idx, 1)
          if (list.length === 0) this.waiters.delete(taskId)
        }
        resolve(undefined)
      }, timeoutMs)

      const waiter: Waiter = { resolve, timer }
      const list = this.waiters.get(taskId)
      if (list) {
        list.push(waiter)
      } else {
        this.waiters.set(taskId, [waiter])
      }
    })
  }

  /** For testing — returns all entries after cleanup. */
  entries(): Array<[string, SseProgressReporter]> {
    this.cleanup()
    return Array.from(this.store.entries())
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [id, reporter] of this.store) {
      if (now - reporter.completedAt > REPORTER_TTL_MS) {
        reporter.dispose() // C1: remove lifecycle listener before drop
        this.store.delete(id)
      }
    }
  }
}

export const progressReporterRegistry = new ProgressReporterRegistry()

/**
 * Idempotent get-or-create for the SSE progress reporter of a task.
 *
 * Returns the existing registered reporter when one is already present
 * (the normal executor path), otherwise constructs one, registers it — which
 * wakes any `waitFor(taskId)` blocked on the stream endpoint — and returns it.
 *
 * Used by BOTH the executor (`TaskExecutor.ensureProgressReporter`) and the
 * canonical failure path (`AgentStateMachine.handleTaskFailure`), so a task
 * that fails BEFORE the executor is ever created (e.g. a budget deny or a null
 * `llmProvider`) still has a reporter subscribed to the lifecycle when the
 * terminal transition fires. Without it the terminal SSE event is lost and the
 * stream waits the full `waitFor` timeout (~180s) — the "Agent is thinking"
 * hang (§5.3.1 of the token-budgets design).
 *
 * CALLER GUARD: only call this when a terminal lifecycle transition is still
 * pending. Registering a reporter for an already-terminal task leaves it with
 * `completedAt=Infinity` (its lifecycle handler never fires) so the TTL sweep
 * never evicts it — a reporter + lifecycle-listener leak.
 */
export function ensureReporter(
  taskId: string,
  lifecycle: TaskLifecycle | undefined,
  safety: Safety
): SseProgressReporter {
  const existing = progressReporterRegistry.get(taskId)
  if (existing) return existing
  const reporter = new SseProgressReporter(taskId, lifecycle, safety)
  progressReporterRegistry.set(taskId, reporter)
  return reporter
}
