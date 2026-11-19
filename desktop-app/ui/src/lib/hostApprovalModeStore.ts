/**
 * Per-session approval mode, following hostModelSelectionStore.
 *
 * A blank chat has no chatId, so the pick is held locally and the first send
 * carries it. After the session exists, a change is a PATCH. A 400 or 401
 * leaves the painted label alone. A 404 before the first send holds the mode
 * for that send. While the first send of a chat whose session row the store
 * has not seen is in flight, the mode cannot change: a PATCH would reach the
 * Host before the send creates the row. Any other failure is not proof of the
 * stored mode: the next session read paints the label, including a write the
 * server committed before the response was dropped.
 *
 * Each existing chat also remembers whether its latest pick was not saved
 * (`saveFailed`), so the picker can say so after a chat switch or a remount.
 * Only the chat's latest write sets or clears it. A failed pick of the mode the
 * chat already stores is not a failure, and a read that shows the requested
 * mode clears it.
 */
import type { ApprovalMode } from '../../../src/types'

export type { ApprovalMode }

export interface SessionApprovalSnapshot {
  approvalMode: ApprovalMode
  modeCeiling: ApprovalMode
  channelCap: ApprovalMode
  effectiveApprovalMode: ApprovalMode
  shellClassifierAvailable: boolean
}

export interface HostApprovalModeView {
  storedMode: ApprovalMode
  effectiveMode: ApprovalMode
  /** Shown while the effective mode is auto or allow-all. Null for manual. */
  label: string | null
  shellClassifierAvailable: boolean
  /** Non-manual mode the first message should carry. Null once the server has it. */
  firstSendMode: ApprovalMode | null
  /**
   * The chat's first send is in flight and the store has not seen its session
   * row. The mode cannot change until the send is acknowledged or fails.
   */
  firstSendInFlight: boolean
  /** The chat's latest pick was not saved, and the stored mode is still not that pick. */
  saveFailed: boolean
}

export interface HostApprovalModeTransport {
  setApprovalMode: (
    agentRef: string,
    chatId: string,
    mode: ApprovalMode
  ) => Promise<SessionApprovalSnapshot>
  readSessionApproval: (agentRef: string, chatId: string) => Promise<SessionApprovalSnapshot>
}

interface Entry {
  scopeGeneration: number
  agentRef: string
  chatId: string | null
  storedMode: ApprovalMode
  effectiveMode: ApprovalMode
  modeCeiling: ApprovalMode
  channelCap: ApprovalMode
  shellClassifierAvailable: boolean
  /** Unpersisted non-manual hold. Null when the hold is manual or the server has the mode. */
  heldForFirstSend: ApprovalMode | null
  persisted: boolean
  writing: boolean
  /** First sends handed to main for this chat and not yet acknowledged or failed. */
  firstSendsInFlight: number
  /** First sends ever begun for this chat. A write compares it across its PATCH. */
  firstSendsBegun: number
  /**
   * Store-wide write sequence when this chat's last write started, stamped
   * again when it completed. A read that started before the completion stamp
   * may have been answered before the write landed.
   */
  lastWriteSeq: number
  /** Mode of the latest pick that was not saved. Null when it was saved or nothing failed. */
  failedMode: ApprovalMode | null
  /** Id of the latest write for this chat. Only that write may set or clear `failedMode`. */
  latestWriteId: number
  listeners: Set<() => void>
  view: HostApprovalModeView | null
}

const entries = new Map<string, Entry>()
let scopeGeneration = 0
/** Write ids, store-wide and monotonic, so an id never repeats across scopes. */
let writeIdSeq = 0
/**
 * Bumps when a mode write starts and again when a PATCH completes, for every
 * chat. Reads capture this before they start.
 */
let writeSeq = 0

function keyFor(agentRef: string, chatId: string | null): string {
  return `${agentRef}::${chatId ?? ''}`
}

function isMode(value: unknown): value is ApprovalMode {
  return value === 'manual' || value === 'auto' || value === 'allow_all'
}

function labelFor(mode: ApprovalMode): string | null {
  if (mode === 'auto') return 'Auto-approve'
  if (mode === 'allow_all') return 'Allow all'
  return null
}

/** IPC keeps the HTTP status in the message. A status property is accepted too. */
function rejectionStatus(error: unknown): number | null {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status
    if (status === 400 || status === 401 || status === 404) return status
  }
  const message = error instanceof Error ? error.message : String(error)
  const match = message.match(/\((400|401|404)\)/)
  return match ? Number(match[1]) : null
}

function isNotFound(error: unknown): boolean {
  return rejectionStatus(error) === 404
}

function isDefiniteRejection(error: unknown): boolean {
  const status = rejectionStatus(error)
  return status === 400 || status === 401
}

function buildView(entry: Entry): HostApprovalModeView {
  return {
    storedMode: entry.storedMode,
    effectiveMode: entry.effectiveMode,
    label: labelFor(entry.effectiveMode),
    shellClassifierAvailable: entry.shellClassifierAvailable,
    firstSendMode: entry.persisted ? null : entry.heldForFirstSend,
    firstSendInFlight: entry.firstSendsInFlight > 0,
    // Derived, so a writer that sets the stored mode without applySnapshot
    // (the 404 hold, migrateHeldApprovalMode) cannot show an error for it.
    saveFailed: entry.failedMode !== null && entry.failedMode !== entry.storedMode,
  }
}

function notify(entry: Entry): void {
  entry.view = null
  for (const listener of entry.listeners) listener()
}

function getEntry(agentRef: string, chatId: string | null): Entry {
  const key = keyFor(agentRef, chatId)
  let entry = entries.get(key)
  if (!entry || entry.scopeGeneration !== scopeGeneration) {
    entry = {
      scopeGeneration,
      agentRef,
      chatId,
      storedMode: 'manual',
      effectiveMode: 'manual',
      modeCeiling: 'manual',
      channelCap: 'manual',
      shellClassifierAvailable: true,
      heldForFirstSend: null,
      persisted: false,
      writing: false,
      firstSendsInFlight: 0,
      firstSendsBegun: 0,
      lastWriteSeq: 0,
      failedMode: null,
      latestWriteId: 0,
      listeners: entry?.scopeGeneration === scopeGeneration ? entry.listeners : new Set(),
      view: null,
    }
    entries.set(key, entry)
  }
  return entry
}

function current(entry: Entry): boolean {
  return entry.scopeGeneration === scopeGeneration
}

function applySnapshot(entry: Entry, snapshot: SessionApprovalSnapshot): void {
  if (!isMode(snapshot.approvalMode) || !isMode(snapshot.effectiveApprovalMode)) return
  entry.storedMode = snapshot.approvalMode
  entry.effectiveMode = snapshot.effectiveApprovalMode
  if (isMode(snapshot.modeCeiling)) entry.modeCeiling = snapshot.modeCeiling
  if (isMode(snapshot.channelCap)) entry.channelCap = snapshot.channelCap
  if (typeof snapshot.shellClassifierAvailable === 'boolean') {
    entry.shellClassifierAvailable = snapshot.shellClassifierAvailable
  }
  entry.heldForFirstSend = null
  entry.persisted = true
  // A read that shows the requested mode proves the save, whichever write or
  // read carried it.
  if (entry.failedMode === entry.storedMode) entry.failedMode = null
}

export function snapshotFromSessionRead(
  value:
    | {
        approvalMode?: unknown
        modeCeiling?: unknown
        channelCap?: unknown
        effectiveApprovalMode?: unknown
        shellClassifierAvailable?: unknown
      }
    | null
    | undefined
): SessionApprovalSnapshot | null {
  if (
    !value ||
    !isMode(value.approvalMode) ||
    !isMode(value.modeCeiling) ||
    !isMode(value.channelCap) ||
    !isMode(value.effectiveApprovalMode) ||
    typeof value.shellClassifierAvailable !== 'boolean'
  ) {
    return null
  }
  return {
    approvalMode: value.approvalMode,
    modeCeiling: value.modeCeiling,
    channelCap: value.channelCap,
    effectiveApprovalMode: value.effectiveApprovalMode,
    shellClassifierAvailable: value.shellClassifierAvailable,
  }
}

/**
 * Sequence to capture before a session or catalog read. The chat id is ignored:
 * the counter is store-wide, so a catalog read is not tied to the blank chat.
 */
export function hostApprovalModeEpoch(_agentRef?: string, _chatId?: string | null): number {
  return writeSeq
}

export function noteHostApprovalModeFromSession(
  agentRef: string,
  chatId: string,
  snapshot: SessionApprovalSnapshot,
  readEpoch?: number
): void {
  if (!agentRef || !chatId) return
  const entry = getEntry(agentRef, chatId)
  if (entry.writing) return
  if (readEpoch !== undefined && entry.lastWriteSeq > readEpoch) return
  applySnapshot(entry, snapshot)
  notify(entry)
}

export function readHostApprovalMode(
  agentRef: string,
  chatId: string | null
): HostApprovalModeView {
  return buildView(getEntry(agentRef, chatId))
}

export function getHostApprovalModeSnapshot(
  agentRef: string,
  chatId: string | null
): HostApprovalModeView {
  const entry = getEntry(agentRef, chatId)
  if (!entry.view) entry.view = buildView(entry)
  return entry.view
}

export function subscribeHostApprovalMode(
  agentRef: string,
  chatId: string | null,
  listener: () => void
): () => void {
  const entry = getEntry(agentRef, chatId)
  entry.listeners.add(listener)
  return () => {
    entry.listeners.delete(listener)
  }
}

/** Mode a first message should carry. Null for manual and for a session the server already has. */
export function approvalModeForFirstSend(
  agentRef: string,
  chatId: string | null
): ApprovalMode | null {
  const entry = entries.get(keyFor(agentRef, chatId))
  if (!entry || entry.scopeGeneration !== scopeGeneration || entry.persisted) return null
  return entry.heldForFirstSend
}

/**
 * Marks the chat's first send as handed to main and returns the mode it
 * carries, in one step so no pick can land between the two. Until `release`
 * runs, `selectHostApprovalMode` refuses a change for the chat: a PATCH sent
 * now would reach the Host before the send creates the session row, get a 404,
 * and paint a mode the session never stores. A chat the store already knows
 * the server has is not locked. `release` is idempotent; call it when the send
 * is acknowledged, fails or is abandoned.
 */
export function beginApprovalModeFirstSend(
  agentRef: string,
  chatId: string
): { mode: ApprovalMode | null; release: () => void } {
  const mode = approvalModeForFirstSend(agentRef, chatId)
  if (!agentRef || !chatId) return { mode, release: () => undefined }
  const entry = getEntry(agentRef, chatId)
  if (entry.persisted) return { mode, release: () => undefined }
  entry.firstSendsInFlight += 1
  entry.firstSendsBegun += 1
  notify(entry)
  let released = false
  return {
    mode,
    release: () => {
      if (released) return
      released = true
      // A scope reset dropped this entry; the new scope's entry was never locked.
      if (!current(entry) || entries.get(keyFor(agentRef, chatId)) !== entry) return
      entry.firstSendsInFlight -= 1
      notify(entry)
    },
  }
}

/** Moves a blank-chat hold onto the chat created by the first send. */
export function migrateHeldApprovalMode(agentRef: string, chatId: string): void {
  if (!agentRef || !chatId) return
  const pre = entries.get(keyFor(agentRef, null))
  const held = pre && pre.scopeGeneration === scopeGeneration ? pre.heldForFirstSend : null
  if (held !== 'auto' && held !== 'allow_all') return
  const entry = getEntry(agentRef, chatId)
  if (entry.persisted) return
  entry.storedMode = held
  entry.effectiveMode = held
  entry.heldForFirstSend = held
  entry.persisted = false
  if (pre) {
    pre.heldForFirstSend = null
    pre.storedMode = 'manual'
    pre.effectiveMode = 'manual'
    notify(pre)
  }
  notify(entry)
}

/** The first send was accepted. Later messages must not carry the field. */
export function confirmHeldApprovalModeFromSend(agentRef: string, chatId: string | null): void {
  if (!agentRef || !chatId) return
  const entry = entries.get(keyFor(agentRef, chatId))
  if (!entry || entry.scopeGeneration !== scopeGeneration) return
  entry.persisted = true
  entry.heldForFirstSend = null
  notify(entry)
}

export async function selectHostApprovalMode(
  transport: HostApprovalModeTransport,
  agentRef: string,
  chatId: string | null,
  mode: ApprovalMode
): Promise<boolean> {
  if (!agentRef || !isMode(mode)) return false
  const entry = getEntry(agentRef, chatId)
  // Every pick on an existing chat is a write for the save-failure flag, the
  // refusal below included. The id gates only `failedMode`: labels, `writing`,
  // `lastWriteSeq` and the return value behave as before.
  const writeId = chatId ? ++writeIdSeq : 0
  if (chatId) entry.latestWriteId = writeId
  const settleSaveFailure = (failed: boolean) => {
    if (!chatId || !current(entry) || entry.latestWriteId !== writeId) return
    entry.failedMode = failed && mode !== entry.storedMode ? mode : null
  }
  // Refused before the write is stamped, so a read that starts now still
  // paints the label. The picker is disabled for the same window.
  if (chatId && entry.firstSendsInFlight > 0) {
    settleSaveFailure(true)
    notify(entry)
    return false
  }
  writeSeq += 1
  entry.lastWriteSeq = writeSeq
  if (!chatId) {
    entry.storedMode = mode
    entry.effectiveMode = mode
    entry.heldForFirstSend = mode === 'manual' ? null : mode
    entry.persisted = false
    notify(entry)
    return true
  }

  const firstSendsBegunAtStart = entry.firstSendsBegun
  entry.writing = true
  notify(entry)
  try {
    const result = await transport.setApprovalMode(agentRef, chatId, mode)
    if (!current(entry)) return false
    applySnapshot(entry, result)
    settleSaveFailure(false)
    return true
  } catch (error) {
    if (!current(entry)) return false
    if (isNotFound(error)) {
      // A first send began after this PATCH left. The 404 only says the row
      // did not exist yet; the send creates it with the mode it carried, which
      // the label still shows. Holding this mode would paint a mode the
      // session never stores, so the pick counts as not saved.
      if (entry.firstSendsBegun !== firstSendsBegunAtStart) {
        settleSaveFailure(true)
        return false
      }
      entry.storedMode = mode
      entry.effectiveMode = mode
      entry.heldForFirstSend = mode === 'manual' ? null : mode
      entry.persisted = false
      settleSaveFailure(false)
      notify(entry)
      return true
    }
    if (isDefiniteRejection(error)) {
      settleSaveFailure(true)
      return false
    }
    try {
      const read = await transport.readSessionApproval(agentRef, chatId)
      if (!current(entry)) return false
      applySnapshot(entry, read)
    } catch (readError) {
      console.warn('[hostApprovalModeStore] session re-read failed:', readError)
    }
    // Decided after the re-read: a read that shows the requested mode means
    // the Host saved it and only the response was lost.
    settleSaveFailure(true)
    return false
  } finally {
    // A read captured while the PATCH was in flight holds the start stamp, and
    // the server may have answered it before the PATCH landed. Stamp the
    // completion so such a read cannot paint the pre-write mode (R6-MJ2).
    writeSeq += 1
    if (current(entry)) {
      entry.lastWriteSeq = writeSeq
      entry.writing = false
      notify(entry)
    }
  }
}

/** The user opened the picker again: the earlier failed pick has been seen. */
export function clearHostApprovalModeSaveFailure(agentRef: string, chatId: string | null): void {
  if (!agentRef || !chatId) return
  const entry = entries.get(keyFor(agentRef, chatId))
  if (!entry || !current(entry) || entry.failedMode === null) return
  entry.failedMode = null
  notify(entry)
}

export function resetHostApprovalModeStore(): void {
  scopeGeneration += 1
  // writeSeq stays monotonic. A read captured before this reset must still
  // lose to a write that happens after it.
  entries.clear()
}
