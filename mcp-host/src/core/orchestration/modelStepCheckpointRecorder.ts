import {
  type CheckpointAttachmentBinding,
  type CheckpointImageCapture,
  type RecordedCheckpointContentPart,
  type RecordedCheckpointMessage,
  createCheckpointImageCapture,
  inlineFileAttachmentBytes,
} from '../../agent/modelStepCheckpointAttachments'
import type {
  ModelStepCheckpointAttachmentInput,
  ModelStepCheckpointAttachmentRow,
  ModelStepCheckpointEntryInput,
  ModelStepCheckpointEntryRow,
  ModelStepCheckpointFence,
  ModelStepCheckpointOpenHeader,
} from '../../db/worker/modelStepCheckpointOps'
import {
  parseModelStepCheckpointLoopState,
  serializeModelStepCheckpointLoopState,
} from '../../db/worker/protocol'
import { logger } from '../../logger'
import type { ModelStepCheckpointStore } from '../conversation/persistence/modelStepCheckpointStore'
import {
  type Attachment,
  type ChatMessage,
  type LoopResult,
  type ToolCall,
  type ToolResult,
  textContentFromParts,
} from '../types'
import { isModelStepCheckpointEligibleError } from './modelStepCheckpointEligibility'
import { isRetryableLlmError } from './toolUseLoopIntentRecovery'

/**
 * Records a turn only once it dispatches a tool into a durable checkpoint (#1043).
 *
 * The loop calls it at fixed points: `begin` buffers history before the first completion,
 * `syncMessages` before every context-management pass and before a tool batch
 * is dispatched, `recordDispatch`/`recordResult` around each tool execution,
 * `updateState` once the tool results are in, and `settle` once per loop
 * exit. A turn paused for approval may enter another loop with this
 * recorder. The first dispatch writes its header and buffered history together.
 * A `tool_dispatch` is written before the tool's effect, so a dispatch
 * without a result reads `unknown` and is never re-executed. A confirmed
 * result and its tool message share one fenced append.
 *
 * A failed write poisons the recorder: the loop keeps running as it does
 * without a recorder, and the checkpoint can never become `resumable` —
 * except in continuation mode, where `recordDispatch` throws instead: an
 * unacknowledged dispatch means the tool's effect state is unknown, so the
 * turn must stop before executing it. A fence mismatch also calls
 * `onFenceLost` so the task is cancelled.
 */
export interface ModelStepCheckpointRecorder {
  readonly checkpointId: string
  /** Writer identity; `null` until the origin header is open. */
  readonly fence: ModelStepCheckpointFence | null
  readonly poisoned: boolean
  /** Whether settle applied a transition out of the continuation claim. */
  readonly claimReleased: boolean
  /** The continuation transition durably applied by settle, if any. */
  readonly appliedSettlement: 'resumable' | 'abandoned' | undefined
  begin(initialMessages: ChatMessage[]): Promise<void>
  syncMessages(messages: ChatMessage[]): Promise<void>
  /** Context management replaced the array; later pushes start at `length`. */
  rebase(length: number): void
  /**
   * Rebuilds the batch-scoped tool-message dedup set from the durable
   * ordered ledger. A cold continuation must call this before `begin`:
   * providers reuse call ids across batches, so only the messages after the
   * last assistant tool-call envelope belong to the batch being resumed.
   */
  adoptRecordedToolMessages(entries: readonly ModelStepCheckpointEntryRow[]): void
  recordDispatch(call: ToolCall): Promise<void>
  recordResult(call: ToolCall, result: ToolResult): Promise<void>
  updateState(nextIteration: number): Promise<void>
  /**
   * `settle`'s `resumable` condition for one error: the fence is open, the
   * recorder is not poisoned, at least one tool result was confirmed in the
   * turn and the error is checkpoint-eligible. It is the gate the automatic
   * model-step retry applies before retrying a failed step, and one of the two
   * ways `settle` can still make a checkpoint resumable (the other is the
   * remembered first failure, see `noteModelStepRetry`). Reads local state only.
   */
  canResume(error: Error): boolean
  /**
   * Records the failure that started this step's automatic retries and the
   * error those retries ended on. `settle` keeps the checkpoint resumable when
   * the retries end on the very same `finalError` object and that final error
   * is itself retryable, so an eligible first failure still survives a retry
   * that ends on another transient error, while a step whose retry ended
   * without access is not offered a Retry. The memory is per step: it is
   * overwritten by the next retried step and never matches another error
   * object, so a failure the retries did not produce cannot use it.
   */
  noteModelStepRetry(cause: Error, finalError: Error): void
  /**
   * Returns the checkpoint id when resumable and updates claimReleased only
   * after an applied transition. A failed continuation abandon throws so the
   * executor can clean up the still-owned claim.
   */
  settle(result: LoopResult | undefined): Promise<string | undefined>
}

/** A continuation tool did not run because its dispatch was not acknowledged. */
export class ModelStepContinuationDispatchError extends Error {
  constructor(
    readonly kind: 'operational' | 'lost',
    cause?: unknown
  ) {
    super('Model-step continuation dispatch was not durably acknowledged', { cause })
    this.name = 'ModelStepContinuationDispatchError'
  }
}

/** A continuation could not durably settle after its model step failed. */
export class ModelStepContinuationSettlementError extends Error {
  constructor(
    readonly kind: 'operational' | 'lost',
    readonly loopError: Error,
    cause?: unknown
  ) {
    super('Model-step continuation settlement was not durably acknowledged', { cause })
    this.name = 'ModelStepContinuationSettlementError'
  }
}

export type ModelStepCheckpointRecorderMode =
  | {
      kind: 'origin'
      header: Omit<ModelStepCheckpointOpenHeader, 'loopState' | 'taskBudget'>
      /**
       * 0-based index of THIS turn's user message inside the messages the loop
       * is started with — the executor's origin-capture boundary. It is frozen
       * into `loop_state.originUserMessageIndex`; the recorder never scans for
       * a user message, so an earlier turn's user message or a later
       * loop-injected one can never be taken for the origin.
       */
      originUserMessageIndex: number
    }
  | {
      kind: 'continuation'
      fence: ModelStepCheckpointFence
      /** Confirmed tool results already in the checkpoint. */
      confirmedResults: number
      /**
       * Durable `loop_state` of the checkpoint being continued. Its frozen
       * origin-user index is retained by every state update. A continuation
       * is only built from a validated snapshot, whose loop state is present.
       */
      loopState: string
    }

export interface ModelStepCheckpointRecorderOptions {
  store: ModelStepCheckpointStore
  sessionKey: string
  mode: ModelStepCheckpointRecorderMode
  /** Secret redaction applied to every model-authored string before it is stored. */
  redact: (text: string) => string
  /** Serialized `TaskExecutionBudget` snapshot, read at each state update. */
  taskBudget: () => string | null
  /** Lifetime of a `resumable` checkpoint from the failure. */
  resumableTtlMs: number
  /**
   * Inline bytes of the turn's source-message files, read only when the
   * checkpoint becomes `resumable` (never on `open`), so a turn that ends
   * normally never writes them.
   */
  sourceAttachments?: readonly Attachment[]
  /**
   * Byte rows a continuation restored from this checkpoint. Their identity and
   * first-capture deadlines are reused, so a retry can never extend retention
   * — even after the sweep deleted the row.
   */
  restoredAttachments?: readonly ModelStepCheckpointAttachmentRow[]
  /** Lifetime of a first-captured byte set. */
  attachmentTtlMs: number
  now: () => number
  onFenceLost: () => void
}

type WriteKind = 'open' | 'append' | 'update_state' | 'transition'
type WriteFailure = { kind: 'lost' } | { kind: 'operational'; error: unknown }

class StoreBackedRecorder implements ModelStepCheckpointRecorder {
  readonly checkpointId: string
  private currentFence: ModelStepCheckpointFence | null
  private recordedUpTo = 0
  private readonly recordedToolMessages = new Set<string>()
  private confirmedResults: number
  private isPoisoned = false
  private settled = false
  private appliedClaimSettlement: 'resumable' | 'abandoned' | undefined
  private lastWriteFailure: WriteFailure | undefined
  private preDispatchFailure: WriteFailure | undefined
  private dispatchFailed = false
  /**
   * The first failure that started this step's automatic retries and the
   * error those retries ended on. Overwritten by the next retried step.
   */
  private retriedStep: { cause: Error; finalError: Error } | undefined
  private readonly imageCapture: CheckpointImageCapture
  private pendingMessages: ChatMessage[] = []
  private readonly restoredBindings: CheckpointAttachmentBinding[]
  private readonly opts: Omit<ModelStepCheckpointRecorderOptions, 'restoredAttachments'>
  /**
   * 0-based index of the origin user message among the recorded message
   * entries. Frozen at the first recording of that message.
   */
  private originUserMessageIndex: number | undefined

  constructor(opts: ModelStepCheckpointRecorderOptions) {
    const { restoredAttachments = [], ...recordingOptions } = opts
    this.opts = recordingOptions
    this.restoredBindings = restoredAttachments.map(row => ({
      attachment_id: row.attachment_id,
      digest_hex: row.digest_hex,
      size_bytes: row.size_bytes,
      expires_at: row.expires_at,
    }))
    this.imageCapture = createCheckpointImageCapture(restoredAttachments, {
      now: opts.now,
      ttlMs: opts.attachmentTtlMs,
    })
    if (opts.mode.kind === 'origin') {
      this.checkpointId = opts.mode.header.checkpointId
      this.currentFence = null
      this.confirmedResults = 0
    } else {
      this.checkpointId = opts.mode.fence.checkpointId
      this.currentFence = opts.mode.fence
      this.confirmedResults = opts.mode.confirmedResults
      this.originUserMessageIndex = parseModelStepCheckpointLoopState(
        opts.mode.loopState
      ).originUserMessageIndex
    }
  }

  get fence(): ModelStepCheckpointFence | null {
    return this.currentFence
  }

  get poisoned(): boolean {
    return this.isPoisoned
  }

  get claimReleased(): boolean {
    return this.appliedClaimSettlement !== undefined
  }

  get appliedSettlement(): 'resumable' | 'abandoned' | undefined {
    return this.appliedClaimSettlement
  }

  async begin(initialMessages: ChatMessage[]): Promise<void> {
    this.recordedUpTo = initialMessages.length
    const { mode } = this.opts
    // Continuations rebuild their own entries; warm approvals reuse the origin prefix.
    if (mode.kind === 'continuation' || this.originUserMessageIndex !== undefined) return
    // The origin identity comes from the executor's capture boundary, never
    // from scanning for a user message: history already contains earlier turns'
    // user messages, and the loop appends synthetic ones later.
    const originIndex = mode.originUserMessageIndex
    if (
      !Number.isSafeInteger(originIndex) ||
      originIndex < 0 ||
      originIndex >= initialMessages.length
    ) {
      throw new Error('Model-step checkpoint origin user message index is out of range')
    }
    if (initialMessages[originIndex].role !== 'user') {
      throw new Error(
        'Model-step checkpoint origin user message index does not point at a user message'
      )
    }
    this.originUserMessageIndex = originIndex
    this.pendingMessages = initialMessages.slice()
  }

  async syncMessages(messages: ChatMessage[]): Promise<void> {
    if (this.isPoisoned) return
    const pending = messages.slice(this.recordedUpTo)
    this.recordedUpTo = messages.length
    if (!this.currentFence) {
      this.pendingMessages.push(...pending)
      return
    }
    if (pending.length === 0) return
    const toolCallEnvelopesOnly = pending.every(
      message =>
        message.role === 'assistant' &&
        Array.isArray(message.tool_calls) &&
        message.tool_calls.length > 0
    )
    const written = await this.append(() =>
      pending
        .filter(message => {
          // Providers may restart call ids on each assistant response. Only
          // recordResult's messages from this batch have already been appended.
          if (message.role === 'assistant' && message.tool_calls) {
            this.recordedToolMessages.clear()
          }
          return (
            message.role !== 'tool' || !this.recordedToolMessages.has(message.tool_call_id ?? '')
          )
        })
        .map(message => this.messageEntry(message))
    )
    if (!written && this.opts.mode.kind === 'continuation' && toolCallEnvelopesOnly) {
      // This write precedes dispatch. A failed result/state write is not safe
      // to classify the same way: an earlier tool may already have run.
      this.preDispatchFailure = this.lastWriteFailure
    }
  }

  rebase(length: number): void {
    this.recordedUpTo = length
  }

  adoptRecordedToolMessages(entries: readonly ModelStepCheckpointEntryRow[]): void {
    if (this.opts.mode.kind !== 'continuation') {
      throw new Error('Only a continuation recorder can adopt recorded tool messages')
    }
    this.recordedToolMessages.clear()
    for (const entry of entries) {
      if (entry.kind !== 'message') continue
      if (entry.tool_call_id !== null) {
        this.recordedToolMessages.add(entry.tool_call_id)
        continue
      }
      let message: { role?: unknown; tool_calls?: unknown }
      try {
        message = JSON.parse(entry.payload) as { role?: unknown; tool_calls?: unknown }
      } catch (err) {
        throw new Error(
          `Model-step checkpoint message entry ${entry.checkpoint_id}/${entry.seq} is not valid JSON`,
          { cause: err }
        )
      }
      if (
        message.role === 'assistant' &&
        Array.isArray(message.tool_calls) &&
        message.tool_calls.length > 0
      ) {
        // Same batch boundary as `syncMessages`: ids from earlier batches may
        // be reused and must stay recordable in the new batch.
        this.recordedToolMessages.clear()
      }
    }
  }

  async recordDispatch(call: ToolCall): Promise<void> {
    if (this.isPoisoned) {
      if (this.opts.mode.kind === 'continuation') {
        if (this.preDispatchFailure) {
          this.dispatchFailed = true
          throw new ModelStepContinuationDispatchError(
            this.preDispatchFailure.kind,
            this.preDispatchFailure.kind === 'operational'
              ? this.preDispatchFailure.error
              : undefined
          )
        }
        throw new Error(
          'Model-step continuation dispatch is unknown after a failed checkpoint write'
        )
      }
      return
    }
    const dispatch = (): ModelStepCheckpointEntryInput => ({
      kind: 'tool_dispatch',
      toolCallId: call.id,
      payload: JSON.stringify({ name: call.name }),
    })
    if (!this.currentFence && this.opts.mode.kind === 'origin') {
      const { header } = this.opts.mode
      await this.write('open', async () => {
        this.currentFence = await this.opts.store.open(
          { ...header, loopState: this.loopState(0), taskBudget: this.opts.taskBudget() },
          [...this.pendingMessages.map(message => this.messageEntry(message)), dispatch()]
        )
        this.pendingMessages = []
        return true
      })
      return
    }
    const acknowledged = await this.append(() => [dispatch()])
    if (this.opts.mode.kind === 'continuation' && !acknowledged) {
      const failure = this.lastWriteFailure
      if (!failure)
        throw new Error('Model-step continuation dispatch failed without a write outcome')
      this.dispatchFailed = true
      throw new ModelStepContinuationDispatchError(
        failure.kind,
        failure.kind === 'operational' ? failure.error : undefined
      )
    }
  }

  /** Confirm the result only with the message Retry needs to reconstruct it. */
  async recordResult(call: ToolCall, result: ToolResult): Promise<void> {
    if (this.isPoisoned || !this.currentFence) return
    const written = await this.append(() => [
      {
        kind: 'tool_result',
        toolCallId: call.id,
        payload: JSON.stringify({ name: call.name, isError: result.is_error === true }),
      },
      this.messageEntry({
        role: 'tool',
        content: result.content,
        tool_call_id: result.tool_call_id,
        name: result.name,
        spillover_ref: result.spillover_ref,
      }),
    ])
    if (written) {
      this.confirmedResults += 1
      this.recordedToolMessages.add(call.id)
    }
  }

  async updateState(nextIteration: number): Promise<void> {
    const fence = this.currentFence
    if (this.isPoisoned || !fence) return
    await this.write('update_state', () =>
      this.opts.store.updateState(
        this.opts.sessionKey,
        fence,
        this.loopState(nextIteration),
        this.opts.taskBudget()
      )
    )
  }

  canResume(error: Error): boolean {
    return (
      this.currentFence !== null &&
      !this.isPoisoned &&
      this.confirmedResults > 0 &&
      isModelStepCheckpointEligibleError(error)
    )
  }

  noteModelStepRetry(cause: Error, finalError: Error): void {
    this.retriedStep = { cause, finalError }
  }

  async settle(result: LoopResult | undefined): Promise<string | undefined> {
    if (this.settled) throw new Error('model-step checkpoint recorder settled twice')
    // Warm approvals retain even an origin that has not dispatched its first tool.
    if (result?.type === 'need_approval' && !this.isPoisoned) return undefined
    const fence = this.currentFence
    if (!fence) {
      this.settled = true
      this.pendingMessages = []
      this.imageCapture.clear()
      return undefined
    }
    const source = this.opts.mode.kind === 'origin' ? 'open' : 'claimed'

    this.settled = true

    // The tool did not run, and the claim owner must distinguish an unknown
    // dispatch write from a lost fence before choosing the terminal transition.
    if (this.dispatchFailed) {
      this.imageCapture.clear()
      return undefined
    }

    // An eligible failure keeps the checkpoint resumable either when it is the
    // error the loop ended on, or when it is the failure this step's automatic
    // retries started from, those retries ended on exactly this error object
    // and that final error is itself retryable. The object identity is what
    // keeps a later step's failure from latching onto the memory.
    const retried = this.retriedStep
    const stepError = result?.type === 'error' ? result.error : undefined
    const leavesResumable =
      stepError !== undefined &&
      (this.canResume(stepError) ||
        (retried?.finalError === stepError &&
          isRetryableLlmError(stepError) &&
          this.canResume(retried.cause)))

    if (leavesResumable) {
      const now = this.opts.now()
      let version: number | null | undefined
      const resumable = await this.write('transition', async () => {
        const bytes = this.pendingByteAttachments(now)
        // The failed call's iterations and active time stay spent: the stored
        // budget snapshot only moves forward. A null snapshot keeps the stored
        // one instead of clearing it.
        const taskBudget = this.opts.taskBudget()
        version = await this.opts.store.transition(this.opts.sessionKey, fence, {
          from: [source],
          to: 'resumable',
          failedAt: now,
          expiresAt: now + this.opts.resumableTtlMs,
          ...(taskBudget === null ? {} : { taskBudget }),
          ...(bytes.length > 0 ? { attachments: bytes } : {}),
        })
        return version !== null
      })
      this.imageCapture.clear()
      if (resumable) {
        if (source === 'claimed') this.appliedClaimSettlement = 'resumable'
        logger.info(
          {
            component: 'ModelStepCheckpoint',
            checkpointId: this.checkpointId,
            status: 'resumable',
          },
          'model-step checkpoint left resumable'
        )
        return this.checkpointId
      }
      if (source === 'claimed') {
        const failure = this.lastWriteFailure
        if (!failure)
          throw new Error('Model-step continuation settlement failed without a write outcome')
        throw new ModelStepContinuationSettlementError(
          failure.kind,
          stepError!,
          failure.kind === 'operational' ? failure.error : undefined
        )
      }
      if (source === 'open' && version === undefined) {
        // The failed write left no expiry on this origin. Cleanup must never
        // replace the model failure, even when storage rejects this write too.
        try {
          const abandoned = await this.opts.store.transition(this.opts.sessionKey, fence, {
            from: ['open'],
            to: 'abandoned',
          })
          if (abandoned === null) throw new Error('Checkpoint cleanup fence lost')
        } catch (err) {
          logger.warn(
            {
              checkpointId: this.checkpointId,
              op: 'abandon',
              errorName: err instanceof Error ? err.name : typeof err,
            },
            'model-step checkpoint cleanup failed after resumable settlement failure'
          )
        }
      }
      return undefined
    }

    // A continuation's final response completes the checkpoint in the same
    // transaction as the response message (`persist_turn_boundary`).
    if (result?.type === 'response' && source === 'claimed' && !this.isPoisoned) {
      this.imageCapture.clear()
      return undefined
    }

    const abandoned = await this.write('transition', async () => {
      const version = await this.opts.store.transition(this.opts.sessionKey, fence, {
        from: [source],
        to: 'abandoned',
      })
      return version !== null
    })
    if (source === 'claimed' && abandoned) this.appliedClaimSettlement = 'abandoned'
    this.imageCapture.clear()
    // A continuation must enter the executor's cleanup if settlement failed;
    // otherwise an answered turn can retain a claim until checkpoint expiry.
    if (source === 'claimed' && !abandoned) {
      throw new Error('Model-step checkpoint abandonment did not release its claim')
    }
    return undefined
  }

  private async append(buildEntries: () => ModelStepCheckpointEntryInput[]): Promise<boolean> {
    const fence = this.currentFence
    if (this.isPoisoned || !fence) return false
    return this.write('append', async () => {
      const entries = buildEntries()
      if (entries.length === 0) return true
      return this.opts.store.append(this.opts.sessionKey, fence, entries)
    })
  }

  /**
   * Runs one store write. `false` from the store is a lost fence; a thrown
   * error is a failed write. Both poison the recorder; neither is rethrown,
   * because the turn itself must not fail on its checkpoint (§5.3.5).
   */
  private async write(kind: WriteKind, op: () => Promise<boolean>): Promise<boolean> {
    this.lastWriteFailure = undefined
    try {
      if (await op()) return true
      this.lastWriteFailure = { kind: 'lost' }
      this.isPoisoned = true
      this.pendingMessages = []
      this.imageCapture.clear()
      logger.warn(
        { component: 'ModelStepCheckpoint', checkpointId: this.checkpointId, op: kind },
        'model-step checkpoint fence lost; cancelling the task'
      )
      this.opts.onFenceLost()
      return false
    } catch (err) {
      // The onFenceLost callback can itself throw; it must not turn an
      // already-established fence mismatch into an unknown write outcome.
      if (!this.lastWriteFailure) this.lastWriteFailure = { kind: 'operational', error: err }
      this.isPoisoned = true
      this.pendingMessages = []
      this.imageCapture.clear()
      logger.warn(
        {
          component: 'ModelStepCheckpoint',
          checkpointId: this.checkpointId,
          op: kind,
          errorName: err instanceof Error ? err.name : typeof err,
        },
        'model-step checkpoint write failed; checkpoint will not be resumable'
      )
      return false
    }
  }

  private messageEntry(message: ChatMessage): ModelStepCheckpointEntryInput {
    const recorded = this.recordMessage(message)
    return {
      kind: 'message',
      toolCallId: message.tool_call_id ?? null,
      payload: JSON.stringify(recorded),
    }
  }

  /** `loop_state` with the frozen origin-user identity retained. */
  private loopState(nextIteration: number): string {
    return serializeModelStepCheckpointLoopState({
      nextIteration,
      ...(this.originUserMessageIndex === undefined
        ? {}
        : { originUserMessageIndex: this.originUserMessageIndex }),
    })
  }

  /**
   * Byte sets this transition may persist. A set whose first-capture deadline
   * has already elapsed is left out: its recorded reference and rows stay
   * untouched, the header still goes `resumable`, and the next continuation
   * blocks `attachment_expired` exactly like an expired file attachment. The
   * store refuses an expired insert, so the recorder never attempts one.
   */
  private pendingByteAttachments(now: number): ModelStepCheckpointAttachmentInput[] {
    const bytes = [
      ...inlineFileAttachmentBytes(
        this.opts.sourceAttachments,
        { now: this.opts.now, ttlMs: this.opts.attachmentTtlMs },
        this.restoredBindings
      ),
      ...this.imageCapture.pendingAttachments(),
    ]
    const live = bytes.filter(attachment => attachment.expiresAt > now)
    if (live.length < bytes.length) {
      logger.warn(
        {
          component: 'ModelStepCheckpoint',
          checkpointId: this.checkpointId,
          droppedBytes: bytes.length - live.length,
        },
        'model-step checkpoint byte retention elapsed before the failure; a resend is required'
      )
    }
    return live
  }

  /**
   * Redacts model-authored text, then replaces inline image bytes with durable
   * references: the entry JSON never carries `data`, only the binding digest.
   */
  private recordMessage(message: ChatMessage): RecordedCheckpointMessage {
    const sanitized = this.sanitizeMessage(message)
    if (!sanitized.contentParts) return { ...sanitized, contentParts: undefined }
    const contentParts: RecordedCheckpointContentPart[] = sanitized.contentParts.map(part =>
      part.type === 'image' ? this.imageCapture.capture(part) : part
    )
    return { ...sanitized, contentParts }
  }

  /**
   * Tool output already went through the tool-output sanitizer before it
   * entered the transcript; everything the model wrote is redacted here.
   */
  private sanitizeMessage(message: ChatMessage): ChatMessage {
    if (message.role === 'tool') return message
    const { redact } = this.opts
    const sanitized: ChatMessage = { ...message }
    if (message.contentParts) {
      sanitized.contentParts = message.contentParts.map(part =>
        part.type === 'text' ? { ...part, text: redact(part.text) } : part
      )
      sanitized.content = textContentFromParts(sanitized.contentParts)
    } else {
      sanitized.content = redact(message.content)
    }
    if (typeof message.reasoning_content === 'string') {
      sanitized.reasoning_content = redact(message.reasoning_content)
    }
    if (message.tool_calls) {
      sanitized.tool_calls = message.tool_calls.map(call => ({
        ...call,
        arguments: redactValue(call.arguments, redact) as Record<string, unknown>,
      }))
    }
    return sanitized
  }
}

/** Redacts string leaves so stored arguments stay valid JSON. */
function redactValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(item => redactValue(item, redact))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactValue(item, redact),
      ])
    )
  }
  return value
}

export function createModelStepCheckpointRecorder(
  opts: ModelStepCheckpointRecorderOptions
): ModelStepCheckpointRecorder {
  return new StoreBackedRecorder(opts)
}
