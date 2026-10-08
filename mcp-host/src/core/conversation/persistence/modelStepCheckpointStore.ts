/**
 * Main-thread access to durable model-step checkpoints (#1043). Every write
 * goes through `enqueueSync` on the session's `PersistQueue` chain, the same
 * durability barrier as `persistTurnFail`, so a checkpoint write is ordered
 * after the turn boundary that precedes it. Payloads are never logged.
 */
import type {
  ModelStepCheckpointAttachmentInput,
  ModelStepCheckpointAttachmentRow,
  ModelStepCheckpointEntryInput,
  ModelStepCheckpointEntryRow,
  ModelStepCheckpointFence,
  ModelStepCheckpointOpenHeader,
  ModelStepCheckpointRowStatus,
  ModelStepCheckpointSnapshot,
  ModelStepClaimOutcome,
} from '../../../db/worker/modelStepCheckpointOps'
import type { PersistQueue } from './persistQueue'

/** Result of a fenced write: `false` means the fence no longer matches. */
interface Applied {
  applied: boolean
}

export interface ModelStepCheckpointStoreOptions {
  /** Clock in epoch ms. Injected so TTL and lease tests are deterministic. */
  now: () => number
}

export class ModelStepCheckpointStore {
  constructor(
    private readonly queue: PersistQueue,
    private readonly opts: ModelStepCheckpointStoreOptions
  ) {}

  /** Creates the `open` header owned by the origin task (generation 0). */
  async open(
    header: ModelStepCheckpointOpenHeader,
    entries: ModelStepCheckpointEntryInput[]
  ): Promise<ModelStepCheckpointFence> {
    await this.queue.enqueueSync<Applied>(
      { kind: 'model_step_checkpoint_open', header, entries, now: this.opts.now() },
      header.sessionKey
    )
    return { checkpointId: header.checkpointId, owner: header.originTaskId, generation: 0 }
  }

  async append(
    sessionKey: string,
    fence: ModelStepCheckpointFence,
    entries: ModelStepCheckpointEntryInput[]
  ): Promise<boolean> {
    const result = await this.queue.enqueueSync<Applied>(
      { kind: 'model_step_checkpoint_append', fence, entries, now: this.opts.now() },
      sessionKey
    )
    return result.applied
  }

  async updateState(
    sessionKey: string,
    fence: ModelStepCheckpointFence,
    loopState: string,
    taskBudget: string | null
  ): Promise<boolean> {
    const result = await this.queue.enqueueSync<Applied>(
      {
        kind: 'model_step_checkpoint_update_state',
        fence,
        loopState,
        taskBudget,
        now: this.opts.now(),
      },
      sessionKey
    )
    return result.applied
  }

  /**
   * Fenced status change. Returns the new version when applied, `null` when
   * the fence or the source status no longer matches.
   */
  async transition(
    sessionKey: string,
    fence: ModelStepCheckpointFence,
    change: {
      from: ModelStepCheckpointRowStatus[]
      to: ModelStepCheckpointRowStatus
      failedAt?: number
      expiresAt?: number
      blockedReason?: string
      /** Inline file bytes; only with `to: 'resumable'`. */
      attachments?: ModelStepCheckpointAttachmentInput[]
      attachmentsExpireAt?: number
    }
  ): Promise<number | null> {
    const result = await this.queue.enqueueSync<{ applied: boolean; version?: number }>(
      { kind: 'model_step_checkpoint_transition', fence, now: this.opts.now(), ...change },
      sessionKey
    )
    if (!result.applied) return null
    if (result.version === undefined) {
      throw new Error('model-step checkpoint transition applied without a version')
    }
    return result.version
  }

  async renewLease(
    sessionKey: string,
    fence: ModelStepCheckpointFence,
    leaseMs: number
  ): Promise<boolean> {
    const now = this.opts.now()
    const result = await this.queue.enqueueSync<Applied>(
      { kind: 'model_step_checkpoint_renew_lease', fence, claimExpiresAt: now + leaseMs, now },
      sessionKey
    )
    return result.applied
  }

  claim(request: {
    sessionKey: string
    checkpointId: string
    version: number
    hostInstanceId: string
    newTaskId: string
    leaseMs: number
  }): Promise<ModelStepClaimOutcome> {
    return this.queue.enqueueSync<ModelStepClaimOutcome>(
      { kind: 'model_step_checkpoint_claim', ...request, now: this.opts.now() },
      request.sessionKey
    )
  }

  /** The single non-terminal checkpoint of a session, or `null`. */
  loadLive(sessionKey: string): Promise<ModelStepCheckpointSnapshot | null> {
    return this.queue.enqueueSync<ModelStepCheckpointSnapshot | null>(
      { kind: 'model_step_checkpoint_load_live', sessionKey },
      sessionKey
    )
  }

  loadEntries(sessionKey: string, checkpointId: string): Promise<ModelStepCheckpointEntryRow[]> {
    return this.queue.enqueueSync<ModelStepCheckpointEntryRow[]>(
      { kind: 'model_step_checkpoint_load_entries', checkpointId },
      sessionKey
    )
  }

  /** Unexpired inline file bytes of a resumable or claimed checkpoint. */
  loadAttachments(
    sessionKey: string,
    checkpointId: string
  ): Promise<ModelStepCheckpointAttachmentRow[]> {
    return this.queue.enqueueSync<ModelStepCheckpointAttachmentRow[]>(
      { kind: 'model_step_checkpoint_load_attachments', checkpointId, now: this.opts.now() },
      sessionKey
    )
  }

  /** Runs once at process start, before any task is admitted. */
  bootReap(hostInstanceId: string): Promise<{ abandoned: number; reopened: number }> {
    return this.queue.enqueueSync({
      kind: 'model_step_checkpoint_boot_reap',
      hostInstanceId,
      now: this.opts.now(),
    })
  }

  sweep(terminalRetentionMs: number): Promise<{
    expired: number
    purgedCheckpoints: number
    purgedAttachments: number
  }> {
    return this.queue.enqueueSync({
      kind: 'model_step_checkpoint_sweep',
      now: this.opts.now(),
      terminalRetentionMs,
    })
  }
}
