import type {
  ModelStepCheckpointAttachmentInput,
  ModelStepCheckpointEntryInput,
  ModelStepCheckpointFence,
  ModelStepCheckpointOpenHeader,
} from '../../db/worker/modelStepCheckpointOps'
import { logger } from '../../logger'
import type { ModelStepCheckpointStore } from '../conversation/persistence/modelStepCheckpointStore'
import {
  type ChatMessage,
  type LoopResult,
  type ToolCall,
  type ToolResult,
  textContentFromParts,
} from '../types'
import { isModelStepCheckpointEligibleError } from './modelStepCheckpointEligibility'

/**
 * Records one tool-use turn into a durable model-step checkpoint (#1043).
 *
 * The loop calls it at fixed points: `begin` before the first completion,
 * `syncMessages` before every context-management pass and before a tool batch
 * is dispatched, `recordDispatch`/`recordResult` around each tool execution,
 * `updateState` once the tool results are in, and `settle` exactly once on
 * exit. A `tool_dispatch` is written before the tool's effect, so a dispatch
 * without a result reads `unknown` and is never re-executed. A result shares
 * the transaction of the next write (plan addendum A2).
 *
 * A failed write poisons the recorder: the loop keeps running as it does
 * without a recorder, and the checkpoint can never become `resumable`. A
 * fence mismatch also calls `onFenceLost` so the task is cancelled.
 */
export interface ModelStepCheckpointRecorder {
  readonly checkpointId: string
  /** Writer identity; `null` until the origin header is open. */
  readonly fence: ModelStepCheckpointFence | null
  readonly poisoned: boolean
  begin(initialMessages: ChatMessage[]): Promise<void>
  syncMessages(messages: ChatMessage[]): Promise<void>
  /** Context management replaced the array; later pushes start at `length`. */
  rebase(length: number): void
  recordDispatch(call: ToolCall): Promise<void>
  recordResult(call: ToolCall, result: ToolResult): Promise<void>
  updateState(nextIteration: number): Promise<void>
  /** Returns the checkpoint id when the turn left a resumable checkpoint. */
  settle(result: LoopResult | undefined): Promise<string | undefined>
}

export type ModelStepCheckpointRecorderMode =
  | {
      kind: 'origin'
      header: Omit<ModelStepCheckpointOpenHeader, 'loopState' | 'taskBudget'>
    }
  | {
      kind: 'continuation'
      fence: ModelStepCheckpointFence
      /** Confirmed tool results already in the checkpoint. */
      confirmedResults: number
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
   * Raw bytes of the turn's inline uploaded files, read only when the
   * checkpoint becomes `resumable` (never on `open`), so a turn that ends
   * normally never writes them.
   */
  inlineFileAttachments: () => ModelStepCheckpointAttachmentInput[]
  /** Lifetime of those bytes from the failure. */
  attachmentTtlMs: number
  now: () => number
  onFenceLost: () => void
}

type WriteKind = 'open' | 'append' | 'update_state' | 'transition'

class StoreBackedRecorder implements ModelStepCheckpointRecorder {
  readonly checkpointId: string
  private currentFence: ModelStepCheckpointFence | null
  private recordedUpTo = 0
  private pendingResults: ModelStepCheckpointEntryInput[] = []
  private confirmedResults: number
  private isPoisoned = false
  private settled = false

  constructor(private readonly opts: ModelStepCheckpointRecorderOptions) {
    if (opts.mode.kind === 'origin') {
      this.checkpointId = opts.mode.header.checkpointId
      this.currentFence = null
      this.confirmedResults = 0
    } else {
      this.checkpointId = opts.mode.fence.checkpointId
      this.currentFence = opts.mode.fence
      this.confirmedResults = opts.mode.confirmedResults
    }
  }

  get fence(): ModelStepCheckpointFence | null {
    return this.currentFence
  }

  get poisoned(): boolean {
    return this.isPoisoned
  }

  async begin(initialMessages: ChatMessage[]): Promise<void> {
    this.recordedUpTo = initialMessages.length
    const { mode } = this.opts
    // A continuation's initial messages are rebuilt from its own entries.
    if (mode.kind === 'continuation') return
    await this.write('open', async () => {
      this.currentFence = await this.opts.store.open(
        {
          ...mode.header,
          loopState: JSON.stringify({ nextIteration: 0 }),
          taskBudget: this.opts.taskBudget(),
        },
        initialMessages.map(message => this.messageEntry(message))
      )
      return true
    })
  }

  async syncMessages(messages: ChatMessage[]): Promise<void> {
    const pending = messages.slice(this.recordedUpTo)
    this.recordedUpTo = messages.length
    if (pending.length === 0 && this.pendingResults.length === 0) return
    await this.append(pending.map(message => this.messageEntry(message)))
  }

  rebase(length: number): void {
    this.recordedUpTo = length
  }

  async recordDispatch(call: ToolCall): Promise<void> {
    await this.append([
      { kind: 'tool_dispatch', toolCallId: call.id, payload: JSON.stringify({ name: call.name }) },
    ])
  }

  /**
   * The result is held and written in the next transaction (the next
   * dispatch, message sync or settle), never later than the next write: a
   * dispatch still precedes its effect, and a crash before that write reads
   * `unknown`, the same as a crash between the effect and its own write.
   */
  async recordResult(call: ToolCall, result: ToolResult): Promise<void> {
    if (this.isPoisoned || !this.currentFence) return
    this.pendingResults.push({
      kind: 'tool_result',
      toolCallId: call.id,
      payload: JSON.stringify({ name: call.name, isError: result.is_error === true }),
    })
  }

  async updateState(nextIteration: number): Promise<void> {
    const fence = this.currentFence
    if (this.isPoisoned || !fence) return
    await this.write('update_state', () =>
      this.opts.store.updateState(
        this.opts.sessionKey,
        fence,
        JSON.stringify({ nextIteration }),
        this.opts.taskBudget()
      )
    )
  }

  async settle(result: LoopResult | undefined): Promise<string | undefined> {
    if (this.settled) throw new Error('model-step checkpoint recorder settled twice')
    this.settled = true
    const fence = this.currentFence
    if (!fence) return undefined
    if (this.pendingResults.length > 0) await this.append([])
    const source = this.opts.mode.kind === 'origin' ? 'open' : 'claimed'

    if (
      result?.type === 'error' &&
      !this.isPoisoned &&
      this.confirmedResults > 0 &&
      isModelStepCheckpointEligibleError(result.error)
    ) {
      const now = this.opts.now()
      const resumable = await this.write('transition', async () => {
        const attachments = this.opts.inlineFileAttachments()
        const version = await this.opts.store.transition(this.opts.sessionKey, fence, {
          from: [source],
          to: 'resumable',
          failedAt: now,
          expiresAt: now + this.opts.resumableTtlMs,
          ...(attachments.length > 0
            ? { attachments, attachmentsExpireAt: now + this.opts.attachmentTtlMs }
            : {}),
        })
        return version !== null
      })
      if (resumable) {
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
      return undefined
    }

    // A continuation's final response completes the checkpoint in the same
    // transaction as the response message (`persist_turn_boundary`).
    if (result?.type === 'response' && source === 'claimed' && !this.isPoisoned) return undefined

    await this.write('transition', async () => {
      await this.opts.store.transition(this.opts.sessionKey, fence, {
        from: [source],
        to: 'abandoned',
      })
      return true
    })
    return undefined
  }

  /** Writes `entries` after any held tool results, in one transaction. */
  private async append(entries: ModelStepCheckpointEntryInput[]): Promise<void> {
    const fence = this.currentFence
    if (this.isPoisoned || !fence) return
    const results = this.pendingResults
    this.pendingResults = []
    const written = await this.write('append', () =>
      this.opts.store.append(this.opts.sessionKey, fence, [...results, ...entries])
    )
    if (written) this.confirmedResults += results.length
  }

  /**
   * Runs one store write. `false` from the store is a lost fence; a thrown
   * error is a failed write. Both poison the recorder; neither is rethrown,
   * because the turn itself must not fail on its checkpoint (§5.3.5).
   */
  private async write(kind: WriteKind, op: () => Promise<boolean>): Promise<boolean> {
    try {
      if (await op()) return true
      this.isPoisoned = true
      logger.warn(
        { component: 'ModelStepCheckpoint', checkpointId: this.checkpointId, op: kind },
        'model-step checkpoint fence lost; cancelling the task'
      )
      this.opts.onFenceLost()
      return false
    } catch (err) {
      this.isPoisoned = true
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
    return {
      kind: 'message',
      toolCallId: message.tool_call_id ?? null,
      payload: JSON.stringify(this.sanitizeMessage(message)),
    }
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
