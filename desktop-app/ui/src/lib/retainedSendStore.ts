/**
 * Memory-only retention of a send whose outcome is not a terminal acknowledgement
 * (issue #654 §4.4 "Retención transaccional del envío").
 *
 * The composer clears its draft and attachments as soon as a send is accepted
 * for delivery, so a POST that throws, a synchronous `error` envelope, or an
 * asynchronous task that fails would otherwise drop the user's input (including
 * images that can no longer be re-attached by hand).
 *
 * A snapshot is keyed by the send identity `(agentRef, chatId, userMessageId)`
 * and released only on an explicit terminal outcome: a successful reply, a
 * user-initiated discard, or a newer send for the same chat that supersedes it.
 * Receiving a `taskId` is NOT a terminal acknowledgement — a started task can
 * still fail — so it never releases the snapshot by itself.
 *
 * Nothing here is persisted: recovery lives for the Desktop process lifetime
 * only, until the durable-history contract (#652) exists.
 */
import type {
  ComposerImageAttachment,
  ComposerReferenceAttachment,
  FailedAgentSend,
} from '../uiTypes'

export interface RetainedSendSnapshot {
  agentRef: string
  chatId: string | null
  userMessageId: string
  /** Task id once known; never used to release the snapshot on its own. */
  taskId?: string
  content: string
  attachments: ComposerImageAttachment[]
  references: ComposerReferenceAttachment[]
  /** Model the guard validated for this send, when one was captured. */
  model?: string
  /** Why the snapshot is still retained (stable code for tests/telemetry). */
  reason: RetainedSendReason
  timestamp: number
  draftRevision: number
  failure?: { message: string; kind: FailedAgentSend['kind'] }
}

export type RetainedSendReason =
  /** Retained as soon as the composer cleared; outcome still unknown. */
  'awaiting_terminal' | 'post_failed' | 'sync_error_envelope' | 'async_task_failed' | 'stream_lost'

/** Each controller owns its bytes; no module-global data survives an identity change. */
export function createRetainedSendStore(changed: () => void) {
  const snapshots = new Map<string, RetainedSendSnapshot>()

  function keyFor(agentRef: string, chatId: string | null, userMessageId: string): string {
    return `${agentRef}::${chatId ?? ''}::${userMessageId}`
  }

  function retainSendSnapshot(snapshot: RetainedSendSnapshot): void {
    if (!snapshot.agentRef || !snapshot.userMessageId) return
    snapshots.set(keyFor(snapshot.agentRef, snapshot.chatId, snapshot.userMessageId), snapshot)
    changed()
  }

  function getRetainedSendSnapshot(
    agentRef: string,
    chatId: string | null,
    userMessageId: string
  ): RetainedSendSnapshot | undefined {
    return snapshots.get(keyFor(agentRef, chatId, userMessageId))
  }

  /** Newest snapshot for a chat, regardless of which message produced it. */
  function getLatestRetainedSendSnapshotForChat(
    agentRef: string,
    chatId: string | null
  ): RetainedSendSnapshot | undefined {
    let latest: RetainedSendSnapshot | undefined
    for (const snapshot of snapshots.values()) {
      if (snapshot.agentRef !== agentRef || snapshot.chatId !== chatId || !snapshot.failure)
        continue
      if (!latest || snapshot.timestamp >= latest.timestamp) latest = snapshot
    }
    return latest
  }

  /** Attaches the task id once the async task is accepted (still retained). */
  function attachTaskIdToRetainedSend(
    agentRef: string,
    chatId: string | null,
    userMessageId: string,
    taskId: string
  ): void {
    const key = keyFor(agentRef, chatId, userMessageId)
    const existing = snapshots.get(key)
    if (!existing) return
    snapshots.set(key, { ...existing, taskId })
    changed()
  }

  function releaseRetainedSend(
    agentRef: string,
    chatId: string | null,
    userMessageId: string
  ): void {
    if (snapshots.delete(keyFor(agentRef, chatId, userMessageId))) changed()
  }

  function releaseRetainedSendsForTask(taskId: string): void {
    let released = false
    for (const [key, snapshot] of snapshots) {
      if (snapshot.taskId === taskId) {
        snapshots.delete(key)
        released = true
      }
    }
    if (released) changed()
  }

  /**
   * Records why a snapshot is still held once the async outcome is known. Keeps
   * the payload and identity untouched; only the recovery code changes.
   */
  function markRetainedSendReason(
    taskId: string,
    reason: RetainedSendReason,
    message: string,
    kind: FailedAgentSend['kind']
  ): void {
    for (const [key, snapshot] of snapshots) {
      if (snapshot.taskId !== taskId) continue
      snapshots.set(key, { ...snapshot, reason, failure: { message, kind } })
      changed()
    }
  }

  /** Release retained input on logout/reset or controller teardown. */
  function resetRetainedSendStore(): void {
    snapshots.clear()
    changed()
  }

  function failRetainedSend(
    agentRef: string,
    chatId: string | null,
    userMessageId: string,
    reason: RetainedSendReason,
    message: string,
    kind: FailedAgentSend['kind']
  ): void {
    const key = keyFor(agentRef, chatId, userMessageId)
    const existing = snapshots.get(key)
    if (!existing) return
    snapshots.set(key, { ...existing, reason, failure: { message, kind } })
    changed()
  }
  return {
    retainSendSnapshot,
    getRetainedSendSnapshot,
    getLatestRetainedSendSnapshotForChat,
    attachTaskIdToRetainedSend,
    releaseRetainedSend,
    releaseRetainedSendsForTask,
    markRetainedSendReason,
    failRetainedSend,
    resetRetainedSendStore,
  }
}
