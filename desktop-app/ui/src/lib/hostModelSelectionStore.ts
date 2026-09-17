/**
 * Single source of truth for the per-session model selection (R2 selector).
 *
 * The selector chip, the composer image guard and the send path all read this
 * store, so an optimistic pick made in one place is immediately visible — and
 * enforced — in the others. It is module-scoped (not React state or a context)
 * because up to two `ComposerPanel`s can be mounted at once (main panel +
 * chat drawer) and the send path lives in the controller, outside both trees.
 *
 * Invariants (issue #654):
 *   - One monotone generation per `(agentRef, chatId)`. A response from an older
 *     generation never overwrites a newer user intent.
 *   - Selection writes are SERIALIZED per key and coalesced toward the latest
 *     intent: a second pick while a write is in flight does not race it.
 *   - The local intent (unpersisted pick) wins over an older server read until
 *     the matching write is acknowledged; it is cleared only by compare-and-clear.
 *   - A CAS conflict (`model_selection_conflict`) is terminal: the store keeps the
 *     last confirmed state, drops the rejected intent so it is never silently
 *     piggybacked, and blocks image capability until a refetch lands.
 *   - Image capability is always resolved for the EFFECTIVE model from the host
 *     projection. Loading, refetching or conflicted state reads as `unknown`,
 *     which blocks images and never text.
 */
import {
  type ImageInputDecision,
  canSendImagesWith,
  imageInputBlockMessage,
  resolveModelImageInput,
} from '../../../src/imageInputDecision'
import type { HostModelsResult, SetHostModelResult } from '../../../src/types'
import {
  clearPendingModelIntent,
  clearPreChatModelIntent,
  getPendingModelIntent,
  getPreChatModelIntent,
  resetHostModelIntentStore,
  setPendingModelIntent,
  setPreChatModelIntent,
} from './hostModelIntentStore'

/** Token embedded in a rejection message when the model is outside the allowlist. */
const MODEL_NOT_ALLOWED_TOKEN = 'model_not_allowed'
/** Token embedded in a rejection message when the CAS precondition fails. */
const MODEL_SELECTION_CONFLICT_TOKEN = 'model_selection_conflict'
/** Broker-backed hosts have no static default; the operator must name a model. */
const CODEX_SUBSCRIPTION_PROVIDER = 'codex-subscription'

export type HostModelSelectionState = 'unloaded' | 'loading' | 'ready' | 'unavailable'

export interface HostModelSelectionView {
  scopeGeneration: number
  data: HostModelsResult | null | undefined
  loading: boolean
  saving: boolean
  error: string | null
  state: HostModelSelectionState
  /** Model the NEXT send will use: local intent > server selection > host default. */
  effectiveModel: string
  /** Unpersisted local intent (pre-chat pick or pending piggyback), if any. */
  intentModel: string | null
  /** True when `effectiveModel` comes from an unconfirmed local intent. */
  pending: boolean
  /** True when a write is in flight or an intent awaits acknowledgement. */
  selectionUnsettled: boolean
  /** True after a CAS conflict, until a refetch lands. */
  conflicted: boolean
  /** Revision the last read/write was based on; null → never send `expectedRevision`. */
  confirmedRevision: number | null
  /** Image capability of `effectiveModel` (unknown while loading/conflicted). */
  imageInput: ImageInputDecision
  canAttachImages: boolean
  /** User copy explaining why images are blocked; null when allowed. */
  imageBlockMessage: string | null
  /** Images must not be sent yet, even if the model is capable (unsettled/loading). */
  visualSendBlocked: boolean
}

export interface HostModelSelectionTransport {
  getHostModels: (agentRef: string, chatId: string) => Promise<HostModelsResult | null>
  setHostModel: (
    agentRef: string,
    chatId: string,
    model: string,
    expectedRevision?: number
  ) => Promise<SetHostModelResult>
}

interface Entry {
  scopeGeneration: number
  agentRef: string
  chatId: string | null
  data: HostModelsResult | null | undefined
  loading: boolean
  saving: boolean
  error: string | null
  conflicted: boolean
  confirmedRevision: number | null
  /** Newest selection known to be on the server (accepted write or fresh read). */
  lastConfirmedModel: string | null
  /** True when the last read raced a newer write/intent, so its projection is old. */
  staleRead: boolean
  /** Monotone generation: bumped by every user intent and every explicit load. */
  seq: number
  fetchInFlight: boolean
  /**
   * Set while `loadHostModels` awaits, so a superseded read can still publish the
   * model LIST (host-level) while withholding the stale revision.
   */
  lastFetchSeq: number
  /** Latest model requested while a write was in flight (coalescing). */
  queuedModel: string | null
  listeners: Set<() => void>
  view: HostModelSelectionView | null
}

const entries = new Map<string, Entry>()
let scopeGeneration = 0

function keyFor(agentRef: string, chatId: string | null): string {
  return `${agentRef}::${chatId ?? ''}`
}

export function isBrokerBackedProvider(provider: string | null | undefined): boolean {
  return provider === CODEX_SUBSCRIPTION_PROVIDER
}

function getEntry(agentRef: string, chatId: string | null): Entry {
  const key = keyFor(agentRef, chatId)
  let entry = entries.get(key)
  if (!entry) {
    entry = {
      scopeGeneration,
      agentRef,
      chatId,
      data: undefined,
      loading: false,
      saving: false,
      error: null,
      conflicted: false,
      confirmedRevision: null,
      lastConfirmedModel: null,
      staleRead: false,
      seq: 0,
      fetchInFlight: false,
      lastFetchSeq: 0,
      queuedModel: null,
      listeners: new Set(),
      view: null,
    }
    entries.set(key, entry)
  }
  return entry
}

function intentFor(entry: Entry): string | null {
  if (!entry.agentRef) return null
  if (!entry.chatId) return getPreChatModelIntent(entry.agentRef) ?? null
  return getPendingModelIntent(entry.agentRef, entry.chatId) ?? null
}

function effectiveModelFor(entry: Entry): { model: string; pending: boolean } {
  const intent = intentFor(entry)
  if (intent) return { model: intent, pending: true }
  const data = entry.data
  if (data) {
    // A read that lost the race against a newer write/intent must not resurrect
    // the model it observed before that write.
    if (!entry.staleRead && data.sessionModel) return { model: data.sessionModel, pending: false }
    if (entry.lastConfirmedModel) return { model: entry.lastConfirmedModel, pending: false }
    if (!isBrokerBackedProvider(data.provider)) {
      return { model: data.hostDefault ?? '', pending: false }
    }
    return { model: '', pending: false }
  }
  // No projection (yet): an accepted write is still the newest known selection.
  if (entry.lastConfirmedModel) return { model: entry.lastConfirmedModel, pending: false }
  return { model: '', pending: false }
}

function buildView(entry: Entry, nowMs: number): HostModelSelectionView {
  const { model: effectiveModel, pending } = effectiveModelFor(entry)
  const data = entry.data
  const state: HostModelSelectionState =
    data === undefined && entry.loading
      ? 'loading'
      : data === undefined
        ? 'unloaded'
        : data === null
          ? 'unavailable'
          : 'ready'

  // Image capability is only trusted from a settled read: while a fetch is in
  // flight or a CAS conflict is unresolved the snapshot may be stale, so images
  // read as unknown (text stays allowed).
  const unsettledEvidence = entry.loading || entry.conflicted
  const imageInput: ImageInputDecision = unsettledEvidence
    ? { state: 'unknown', reason: 'model_unknown' }
    : resolveModelImageInput(data?.models, effectiveModel, nowMs)

  const canAttachImages = !entry.saving && !unsettledEvidence && canSendImagesWith(imageInput)
  const visualSendBlocked = !canAttachImages
  const imageBlockMessage = canAttachImages
    ? null
    : entry.saving
      ? 'Applying the model change — wait for it to settle before sending images.'
      : entry.conflicted
        ? 'This chat’s model changed elsewhere — re-checking the current selection before images can be sent.'
        : imageInputBlockMessage(effectiveModel, imageInput)

  return {
    scopeGeneration: entry.scopeGeneration,
    data,
    loading: entry.loading,
    saving: entry.saving,
    error: entry.error,
    state,
    effectiveModel,
    intentModel: intentFor(entry),
    pending,
    selectionUnsettled: entry.saving || pending || entry.conflicted,
    conflicted: entry.conflicted,
    confirmedRevision: entry.confirmedRevision,
    imageInput,
    canAttachImages,
    imageBlockMessage,
    visualSendBlocked,
  }
}

function notify(entry: Entry): void {
  entry.view = null
  for (const listener of entry.listeners) listener()
}

/**
 * Cached immutable view for React subscriptions: stable between store changes,
 * which is what `useSyncExternalStore` requires.
 */
export function getHostModelSelectionSnapshot(
  agentRef: string,
  chatId: string | null
): HostModelSelectionView {
  const entry = getEntry(agentRef, chatId)
  if (!entry.view) entry.view = buildView(entry, Date.now())
  return entry.view
}

/**
 * Fresh evaluation for imperative guards (send path). `validUntil` is
 * re-checked here on every call, so evidence that expires while the app is open
 * is enforced at the next attempt without needing a store write.
 */
export function readHostModelSelection(
  agentRef: string,
  chatId: string | null,
  nowMs: number = Date.now()
): HostModelSelectionView {
  return buildView(getEntry(agentRef, chatId), nowMs)
}

export function subscribeHostModelSelection(
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

/**
 * Re-reads a key after an external intent change (e.g. the send path migrated a
 * pre-chat pick into the chat's pending slot) so subscribers see it at once.
 */
export function markHostModelSelectionChanged(agentRef: string, chatId: string | null): void {
  const entry = entries.get(keyFor(agentRef, chatId))
  if (entry) notify(entry)
}

/** Dismisses the last inline error (e.g. a stale rejection notice). */
export function clearHostModelSelectionError(agentRef: string, chatId: string | null): void {
  const entry = entries.get(keyFor(agentRef, chatId))
  if (!entry || entry.error === null) return
  entry.error = null
  notify(entry)
}

export async function loadHostModels(
  transport: HostModelSelectionTransport,
  agentRef: string,
  chatId: string | null,
  options: { force?: boolean } = {}
): Promise<void> {
  if (!agentRef) return
  const entry = getEntry(agentRef, chatId)
  if (entry.fetchInFlight && !options.force) return
  if (entry.data !== undefined && !options.force) return

  const fetchSeq = ++entry.seq
  entry.lastFetchSeq = fetchSeq
  entry.fetchInFlight = true
  entry.loading = true
  if (options.force) entry.error = null
  notify(entry)

  try {
    const result = await transport.getHostModels(agentRef, chatId ?? '')
    if (entry.lastFetchSeq !== fetchSeq) return
    const olderRevision =
      result &&
      typeof result.modelSelectionRevision === 'number' &&
      entry.confirmedRevision !== null &&
      result.modelSelectionRevision < entry.confirmedRevision
    const superseded = entry.seq !== fetchSeq || Boolean(olderRevision)
    entry.data = result
    entry.staleRead = superseded
    if (!superseded) {
      entry.lastConfirmedModel = result?.sessionModel ?? null
      if (
        result &&
        Number.isSafeInteger(result.modelSelectionRevision) &&
        result.modelSelectionRevision! >= 0
      ) {
        entry.confirmedRevision = result.modelSelectionRevision!
      }
      entry.conflicted = false
      const pending = intentFor(entry)
      if (pending && result?.sessionModel === pending && !entry.saving) {
        if (chatId) clearPendingModelIntent(agentRef, chatId)
        else clearPreChatModelIntent(agentRef)
      }
    }
    // A superseded read must not erase a known CAS base and turn the next
    // write into an unconditional legacy update.
  } catch (error) {
    if (entry.lastFetchSeq !== fetchSeq) return
    console.warn('[useHostModels] fetch failed (ignored):', error)
    if (entry.seq === fetchSeq) entry.data = null
  } finally {
    if (entry.lastFetchSeq === fetchSeq) {
      entry.fetchInFlight = false
      entry.loading = false
      notify(entry)
    }
  }
}

/**
 * Applies a model choice. Resolves `true` when the selection is usable for the
 * next send (accepted, or kept as an unpersisted intent because the host is
 * unreachable), `false` on a terminal rejection (allowlist, CAS conflict).
 */
export async function selectHostModel(
  transport: HostModelSelectionTransport,
  agentRef: string,
  chatId: string | null,
  model: string
): Promise<boolean> {
  if (!agentRef || !model) return false
  const entry = getEntry(agentRef, chatId)

  if (!chatId) {
    entry.seq += 1
    // PRE-CHAT: there is no session to POST to. Hold the pick locally keyed by
    // agent; the send path migrates it and piggybacks it on message 1.
    setPreChatModelIntent(agentRef, model)
    entry.error = null
    notify(entry)
    return true
  }

  // New generation for this key: any response started earlier is superseded.
  const intentSeq = ++entry.seq
  setPendingModelIntent(agentRef, chatId, model)
  entry.error = null
  entry.conflicted = false
  notify(entry)

  if (entry.saving) {
    // Serialize: coalesce toward the latest intent; the in-flight writer drains it.
    entry.queuedModel = model
    return true
  }
  return runSelectionWrites(transport, entry, intentSeq, model)
}

async function runSelectionWrites(
  transport: HostModelSelectionTransport,
  entry: Entry,
  seq: number,
  model: string
): Promise<boolean> {
  const chatId = entry.chatId as string
  const ownerScope = entry.scopeGeneration
  entry.saving = true
  notify(entry)

  let currentModel = model
  let currentSeq = seq

  const finish = (ok: boolean): boolean => {
    entry.saving = false
    entry.queuedModel = null
    notify(entry)
    return ok
  }

  for (;;) {
    try {
      const expectedRevision = entry.confirmedRevision ?? undefined
      const result = await transport.setHostModel(
        entry.agentRef,
        chatId,
        currentModel,
        expectedRevision
      )
      if (entry.scopeGeneration !== ownerScope) return false
      if (typeof result?.modelSelectionRevision === 'number') {
        entry.confirmedRevision = result.modelSelectionRevision
      }
      entry.conflicted = false
      const serverModel =
        typeof result?.model === 'string' && result.model ? result.model : currentModel
      entry.lastConfirmedModel = serverModel
      // The held projection was read BEFORE this accepted write, so it must not
      // resurrect the previous session model; the next successful read refreshes
      // `staleRead` and takes over again.
      entry.staleRead = true
      // Compare-and-clear: drop the intent only when it is still the one we wrote.
      if (intentFor(entry) === currentModel && currentSeq === entry.seq) {
        clearPendingModelIntent(entry.agentRef, chatId)
      }
      const queued = entry.queuedModel
      if (queued && queued !== serverModel) {
        entry.queuedModel = null
        currentModel = queued
        currentSeq = entry.seq
        continue
      }
      entry.error = null
      return finish(true)
    } catch (error) {
      if (entry.scopeGeneration !== ownerScope) return false
      const message = error instanceof Error ? error.message : String(error)
      if (entry.queuedModel && currentSeq !== entry.seq && message.includes('model_not_allowed')) {
        currentModel = entry.queuedModel
        currentSeq = entry.seq
        entry.queuedModel = null
        continue
      }

      if (message.includes(MODEL_NOT_ALLOWED_TOKEN)) {
        // Real allowlist rejection (host was reachable): drop the optimistic
        // intent so the previous server selection is what a refetch shows.
        if (intentFor(entry) === currentModel && currentSeq === entry.seq) {
          clearPendingModelIntent(entry.agentRef, chatId)
        }
        entry.error = 'That model is no longer allowed — selection unchanged.'
        return finish(false)
      }

      if (message.includes(MODEL_SELECTION_CONFLICT_TOKEN)) {
        // CAS precondition failed: another writer moved the session selection.
        // Keep the last confirmed state, never piggyback the rejected intent, and
        // withhold image capability until the authoritative read lands.
        if (intentFor(entry) === currentModel && currentSeq === entry.seq) {
          clearPendingModelIntent(entry.agentRef, chatId)
        }
        entry.conflicted = true
        entry.error = 'This chat’s model was changed elsewhere — re-checking the current selection.'
        entry.saving = false
        entry.queuedModel = null
        notify(entry)
        void loadHostModels(transport, entry.agentRef, chatId, { force: true })
        return false
      }

      const queued = entry.queuedModel
      if (queued && queued !== currentModel) {
        // Host was unreachable for the older pick; try the newest intent once.
        entry.queuedModel = null
        currentModel = queued
        currentSeq = entry.seq
        continue
      }

      // Host unavailable (suspended / transport / 5xx): keep the optimistic UI
      // and the pending intent so the next send carries it and wakes the host.
      console.warn(
        '[useHostModels] set failed; host likely suspended — keeping optimistic selection, will piggyback on next send:',
        error
      )
      return finish(true)
    }
  }
}

/** Test helper: wipe every entry, listener and intent. */
export function resetHostModelSelectionStore(): void {
  scopeGeneration += 1
  resetHostModelIntentStore()
  for (const [key, entry] of entries) {
    entry.scopeGeneration = scopeGeneration
    entry.seq += 1
    entry.lastFetchSeq = -1
    entry.data = undefined
    entry.loading = false
    entry.fetchInFlight = false
    entry.saving = false
    entry.error = null
    entry.conflicted = false
    entry.confirmedRevision = null
    entry.lastConfirmedModel = null
    entry.staleRead = false
    entry.queuedModel = null
    notify(entry)
    if (entry.listeners.size === 0) entries.delete(key)
  }
}
