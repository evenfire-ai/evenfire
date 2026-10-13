/**
 * Memory-only retention of a send whose outcome is not a terminal acknowledgement
 * (issue #654 §4.4 "Transactional send retention").
 *
 * The composer clears its draft and attachments as soon as a send is accepted
 * for delivery, so a POST that throws, a synchronous `error` envelope, or an
 * asynchronous task that fails would otherwise drop the user's input (including
 * images that can no longer be re-attached by hand).
 *
 * A snapshot is keyed by the send identity `(agentRef, chatId, userMessageId)`
 * and released only on an explicit terminal outcome: its own successful reply
 * or cancel, a user-initiated discard (which also drops the older failures of
 * that chat), or a newer send for the same chat that reaches a successful
 * terminal, which supersedes every failure recorded before it. Documents the
 * Host never received are the exception (#678 D13): only a discard, recovery or
 * retry of that snapshot itself, or a store reset, releases them. A snapshot still
 * awaiting its own terminal is never released by another send. Receiving a
 * `taskId` is NOT a terminal acknowledgement — a started task can still fail —
 * so it never releases the snapshot by itself.
 *
 * Nothing here is persisted: recovery lives for the Desktop process lifetime
 * only, until the durable-history contract (#652) exists.
 */
import type {
  ComposerImageAttachment,
  ComposerReferenceAttachment,
  FailedAgentSend,
  ReadyComposerFileAttachment,
} from '../uiTypes'

export interface RetainedSendSnapshot {
  agentRef: string
  chatId: string | null
  userMessageId: string
  /** Task id once known; never used to release the snapshot on its own. */
  taskId?: string
  content: string
  attachments: ComposerImageAttachment[]
  /** Documents already read and hashed; a retry sends them without reading again. */
  files: ReadyComposerFileAttachment[]
  references: ComposerReferenceAttachment[]
  /** Model the guard validated for this send, when one was captured. */
  model?: string
  /** Why the snapshot is still retained (stable code for tests/telemetry). */
  reason: RetainedSendReason
  /**
   * Set only with `host_files_dropped`: the ids of the documents the Host did
   * not admit. `files` keeps every document so a later failure can still retry
   * the whole send; recovery after the answer brings back only these.
   */
  undeliveredFileIds?: string[]
  timestamp: number
  draftRevision: number
  failure?: { message: string; kind: FailedAgentSend['kind'] }
}

export type RetainedSendReason =
  /** Retained as soon as the composer cleared; outcome still unknown. */
  | 'awaiting_terminal'
  | 'post_failed'
  | 'sync_error_envelope'
  | 'async_task_failed'
  | 'stream_lost'
  /** The Host rejected the send because of its documents; nothing was answered (#678, D13). */
  | 'host_files_unsupported'
  /**
   * The Host answered the text without confirming every document (#678, D13).
   * Only the documents are recoverable: a retry would send the answered text again.
   */
  | 'host_files_dropped'

/** Both reasons hold documents the Host never received, which exist nowhere else. */
export function holdsUndeliveredFiles(reason: RetainedSendReason): boolean {
  return reason === 'host_files_unsupported' || reason === 'host_files_dropped'
}

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

  /**
   * The task ended without a reply to recover (a cancel, or a lost stream the
   * turn already covered). A snapshot holding documents the Host never received
   * stays with its failure and reason: those files exist nowhere else.
   */
  function releaseRetainedSendsForTask(taskId: string): void {
    let released = false
    for (const [key, snapshot] of snapshots) {
      if (snapshot.taskId === taskId && !holdsUndeliveredFiles(snapshot.reason)) {
        snapshots.delete(key)
        released = true
      }
    }
    if (released) changed()
  }

  /**
   * Releases the failed snapshots of one chat recorded at or before
   * `upToTimestamp`. Snapshots without a failure are still awaiting their own
   * terminal and stay held: that send can still fail, and then its snapshot is
   * the only copy of the payload. A later success and a user discard pass
   * `keepUndeliveredFiles`: they supersede an older failure, but not documents
   * the Host never received, which exist nowhere else.
   */
  function releaseRetainedFailuresForChat(
    agentRef: string,
    chatId: string | null,
    upToTimestamp: number,
    options: { keepUndeliveredFiles?: boolean } = {}
  ): void {
    let released = false
    for (const [key, snapshot] of snapshots) {
      if (snapshot.agentRef !== agentRef || snapshot.chatId !== chatId) continue
      if (!snapshot.failure || snapshot.timestamp > upToTimestamp) continue
      if (options.keepUndeliveredFiles && holdsUndeliveredFiles(snapshot.reason)) continue
      snapshots.delete(key)
      released = true
    }
    if (released) changed()
  }

  /**
   * A synchronous send reached a successful terminal: release it and every
   * older failure of its chat, which the success supersedes. Without the second
   * part the newest older failure resurfaced under the successful reply.
   */
  function releaseSucceededRetainedSend(
    agentRef: string,
    chatId: string | null,
    userMessageId: string
  ): void {
    const succeeded = snapshots.get(keyFor(agentRef, chatId, userMessageId))
    if (succeeded) {
      releaseRetainedFailuresForChat(succeeded.agentRef, succeeded.chatId, succeeded.timestamp, {
        keepUndeliveredFiles: true,
      })
    }
    releaseRetainedSend(agentRef, chatId, userMessageId)
  }

  /**
   * Task-based counterpart of `releaseSucceededRetainedSend`. A task that
   * succeeded without the documents the Host never received keeps its snapshot:
   * those files exist nowhere else.
   */
  function releaseSucceededRetainedSendsForTask(taskId: string): void {
    const succeeded = [...snapshots.values()].filter(
      snapshot => snapshot.taskId === taskId && !holdsUndeliveredFiles(snapshot.reason)
    )
    for (const snapshot of succeeded) {
      releaseRetainedFailuresForChat(snapshot.agentRef, snapshot.chatId, snapshot.timestamp, {
        keepUndeliveredFiles: true,
      })
      releaseRetainedSend(snapshot.agentRef, snapshot.chatId, snapshot.userMessageId)
    }
  }

  /**
   * A snapshot whose documents the Host never received keeps holding them when a
   * later failure is recorded: the reason is what stops a later success from
   * releasing files that exist nowhere else. Any other failure after
   * `host_files_dropped` means the text was not answered either, so the snapshot
   * becomes a rejected send (`host_files_unsupported`) and Retry and text
   * recovery come back. A lost stream (`stream_lost`) does not say whether the
   * text was answered, so the snapshot stays `host_files_dropped`: only the
   * files come back, and the text is never sent again.
   */
  function nextReason(
    snapshot: RetainedSendSnapshot,
    reason: RetainedSendReason
  ): RetainedSendReason {
    if (
      snapshot.reason === 'host_files_dropped' &&
      reason !== 'host_files_dropped' &&
      reason !== 'stream_lost'
    ) {
      return 'host_files_unsupported'
    }
    return holdsUndeliveredFiles(snapshot.reason) ? snapshot.reason : reason
  }

  /** The failed snapshot, with the undelivered ids kept only while the text counts as answered. */
  function withFailure(
    snapshot: RetainedSendSnapshot,
    reason: RetainedSendReason,
    message: string,
    kind: FailedAgentSend['kind'],
    undeliveredFileIds: string[] | undefined
  ): RetainedSendSnapshot {
    const { undeliveredFileIds: previousIds, ...rest } = snapshot
    const next = nextReason(snapshot, reason)
    const ids = next === 'host_files_dropped' ? (undeliveredFileIds ?? previousIds) : undefined
    return {
      ...rest,
      reason: next,
      ...(ids ? { undeliveredFileIds: ids } : {}),
      failure: { message, kind },
    }
  }

  /**
   * Records why a snapshot is still held once the async outcome is known. Keeps
   * the payload and identity untouched; only the recovery code changes.
   */
  function markRetainedSendReason(
    taskId: string,
    reason: RetainedSendReason,
    message: string,
    kind: FailedAgentSend['kind'],
    undeliveredFileIds?: string[]
  ): void {
    for (const [key, snapshot] of snapshots) {
      if (snapshot.taskId !== taskId) continue
      snapshots.set(key, withFailure(snapshot, reason, message, kind, undeliveredFileIds))
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
    kind: FailedAgentSend['kind'],
    undeliveredFileIds?: string[]
  ): void {
    const key = keyFor(agentRef, chatId, userMessageId)
    const existing = snapshots.get(key)
    if (!existing) return
    snapshots.set(key, withFailure(existing, reason, message, kind, undeliveredFileIds))
    changed()
  }
  return {
    retainSendSnapshot,
    getRetainedSendSnapshot,
    getLatestRetainedSendSnapshotForChat,
    attachTaskIdToRetainedSend,
    releaseRetainedSend,
    releaseRetainedSendsForTask,
    releaseRetainedFailuresForChat,
    releaseSucceededRetainedSend,
    releaseSucceededRetainedSendsForTask,
    markRetainedSendReason,
    failRetainedSend,
    resetRetainedSendStore,
  }
}
