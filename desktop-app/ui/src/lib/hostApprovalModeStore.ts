/**
 * Per-session approval mode, following hostModelSelectionStore.
 *
 * A blank chat has no chatId, so the pick is held locally and the first send
 * carries it. After the session exists, a change is a PATCH. A 400, 401 or 404
 * leaves the painted label alone. Any other failure is not proof of the stored
 * mode: the next session read paints the label, including a write the server
 * committed before the response was dropped.
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
  /** Store-wide write sequence at the moment this chat's last write started. */
  lastWriteSeq: number
  listeners: Set<() => void>
  view: HostApprovalModeView | null
}

const entries = new Map<string, Entry>()
let scopeGeneration = 0
/** Bumps on every mode write, for every chat. Reads capture this before they start. */
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
      lastWriteSeq: 0,
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

  entry.writing = true
  notify(entry)
  try {
    const result = await transport.setApprovalMode(agentRef, chatId, mode)
    if (!current(entry)) return false
    applySnapshot(entry, result)
    return true
  } catch (error) {
    if (!current(entry)) return false
    if (isNotFound(error)) {
      entry.storedMode = mode
      entry.effectiveMode = mode
      entry.heldForFirstSend = mode === 'manual' ? null : mode
      entry.persisted = false
      notify(entry)
      return true
    }
    if (isDefiniteRejection(error)) return false
    try {
      const read = await transport.readSessionApproval(agentRef, chatId)
      if (!current(entry)) return false
      applySnapshot(entry, read)
    } catch (readError) {
      console.warn('[hostApprovalModeStore] session re-read failed:', readError)
    }
    return false
  } finally {
    if (current(entry)) {
      entry.writing = false
      notify(entry)
    }
  }
}

export function resetHostApprovalModeStore(): void {
  scopeGeneration += 1
  // writeSeq stays monotonic. A read captured before this reset must still
  // lose to a write that happens after it.
  entries.clear()
}
