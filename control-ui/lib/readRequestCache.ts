import {
  METADATA_READ_CACHE_MAX_ENTRIES,
  METADATA_READ_MAX_RECOVERY_ATTEMPTS,
  METADATA_READ_UNTIMED_COOLDOWN_MS,
} from '@constants/readRequests'
import type { ApiRequestError } from './api.types'

type CacheEntry = {
  value: unknown
  expiresAtMs: number
}

type CooldownEntry = {
  error: ApiRequestError
  retryAtMs: number
}

type RecoveryEntry = {
  deadlineMs: number
  timer?: ReturnType<typeof setTimeout>
  controller: AbortController
  pending: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
  state: 'scheduled' | 'running'
  // Every URL whose own read was denied while this recovery was scheduled,
  // in denial order. Each is reread once at the deadline.
  members: Map<string, (signal: AbortSignal) => Promise<unknown>>
  removeListeners: () => void
  addSubscribers: (signals: Array<AbortSignal | undefined>) => void
}

type PrincipalContext = {
  principalId: string
  scope: string
}

const READ_REQUEST_INVALIDATION_CHANNEL = 'control-ui-read-metadata-invalidation'
const entries = new Map<string, CacheEntry>()
const cooldowns = new Map<string, CooldownEntry>()
const recoveries = new Map<string, RecoveryEntry>()
let principal: PrincipalContext | null = null
let invalidationChannel: BroadcastChannel | null = null
let invalidationHandler: ((remote?: boolean) => void) | null = null
let generation = 0
// Changes only when the confirmed principal changes (A -> B, A -> none,
// none -> A). Unlike `generation`, unrelated metadata mutations leave it alone,
// so mounted consumers can use it to drop the previous session's state.
let sessionIdentity = 0
const sessionIdentityListeners = new Set<() => void>()

function isBrowser(): boolean {
  return typeof window !== 'undefined'
}

function announceSessionIdentityChange(): void {
  sessionIdentity += 1
  for (const listener of Array.from(sessionIdentityListeners)) listener()
}

export function getReadRequestSessionIdentity(): number {
  return sessionIdentity
}

export function subscribeReadRequestSessionIdentity(listener: () => void): () => void {
  sessionIdentityListeners.add(listener)
  return () => {
    sessionIdentityListeners.delete(listener)
  }
}

function ensureChannel(): BroadcastChannel | null {
  if (!isBrowser() || typeof BroadcastChannel === 'undefined') return null
  if (!invalidationChannel) {
    invalidationChannel = new BroadcastChannel(READ_REQUEST_INVALIDATION_CHANNEL)
    invalidationChannel.onmessage = event => {
      if ((event.data as { type?: unknown } | null)?.type === 'session-invalidation') {
        // Another tab may have replaced the shared cookie. A fresh authenticated
        // /me read must confirm the principal before this tab can cache again.
        const wasVerified = principal !== null
        principal = null
        clearReadRequestCache()
        invalidationHandler?.(true)
        if (wasVerified) announceSessionIdentityChange()
      }
    }
  }
  return invalidationChannel
}

export function setReadRequestInvalidationHandler(
  handler: ((remote?: boolean) => void) | null
): void {
  invalidationHandler = handler
}

export function getReadRequestPrincipal(): PrincipalContext | null {
  return isBrowser() ? principal : null
}

export function setReadRequestPrincipal(principalId: string, scope: string): void {
  if (!isBrowser()) return
  if (!principalId || !scope) {
    clearReadRequestPrincipal()
    return
  }
  if (principal?.principalId === principalId && principal.scope === scope) return
  const wasVerified = principal !== null
  principal = { principalId, scope }
  clearReadRequestCache()
  invalidationHandler?.()
  const channel = ensureChannel()
  // Initial /me confirmation is local; rebroadcasting it would make two tabs
  // invalidate one another indefinitely. Actual identity/scope changes propagate.
  if (wasVerified) channel?.postMessage({ type: 'session-invalidation' })
  announceSessionIdentityChange()
}

export function clearReadRequestPrincipal(options: { sessionChanged?: boolean } = {}): void {
  const wasVerified = principal !== null
  principal = null
  clearReadRequestCache()
  invalidationHandler?.()
  const channel = ensureChannel()
  // Only a locally verified principal or a committed cookie change is news to
  // other tabs. A tab already cleared by a remote invalidation answers its /me
  // 401 here; rebroadcasting that would make logged-out tabs invalidate one
  // another indefinitely. A peer may have reconfirmed the old cookie while a
  // login/logout POST was pending, so the committed change always propagates.
  if (wasVerified || options.sessionChanged) {
    channel?.postMessage({ type: 'session-invalidation' })
  }
  if (wasVerified) announceSessionIdentityChange()
}

export function clearReadRequestCache(): void {
  generation += 1
  entries.clear()
  cooldowns.clear()
  for (const recovery of recoveries.values()) disposeRecovery(recovery)
  recoveries.clear()
}

export function getReadRequestCacheGeneration(): number {
  return generation
}

export function invalidateReadRequestCache(): void {
  // A successful write invalidates displayed metadata, not the independent
  // read-family quota. Preserve its deadline and one recovery reservation.
  generation += 1
  entries.clear()
}

export function invalidateReadRequestCacheEntry(key: string): void {
  entries.delete(key)
}

export function getReadRequestCacheEntry(key: string, nowMs = Date.now()): unknown | undefined {
  if (!isBrowser()) return undefined
  const entry = entries.get(key)
  if (!entry) return undefined
  if (entry.expiresAtMs <= nowMs) {
    entries.delete(key)
    return undefined
  }
  entries.delete(key)
  entries.set(key, entry)
  return structuredClone(entry.value)
}

export function setReadRequestCacheEntry(
  key: string,
  value: unknown,
  ttlMs: number,
  nowMs = Date.now()
): void {
  if (!isBrowser()) return
  entries.delete(key)
  while (entries.size >= METADATA_READ_CACHE_MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
  entries.set(key, { value: structuredClone(value), expiresAtMs: nowMs + ttlMs })
}

export function getReadRequestCooldown(
  key: string,
  nowMs = Date.now()
): ApiRequestError | undefined {
  if (!isBrowser()) return undefined
  const entry = cooldowns.get(key)
  if (!entry) return undefined
  if (entry.retryAtMs <= nowMs) {
    cooldowns.delete(key)
    return undefined
  }
  return entry.error
}

export function setReadRequestCooldown(
  key: string,
  error: ApiRequestError,
  retryAfterSeconds: number | undefined,
  nowMs = Date.now()
): number {
  if (!isBrowser()) return 0
  const delayMs =
    retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : METADATA_READ_UNTIMED_COOLDOWN_MS
  const retryAtMs = Math.max(nowMs + delayMs, cooldowns.get(key)?.retryAtMs ?? 0)
  error.retryAtMs = retryAtMs
  while (cooldowns.size >= METADATA_READ_CACHE_MAX_ENTRIES && !cooldowns.has(key)) {
    const oldest = cooldowns.keys().next().value
    if (oldest === undefined) break
    cooldowns.delete(oldest)
  }
  cooldowns.set(key, { error, retryAtMs })
  return retryAtMs - nowMs
}

function disposeRecovery(entry: RecoveryEntry): void {
  if (entry.timer) clearTimeout(entry.timer)
  entry.removeListeners()
  entry.controller.abort()
  entry.reject(new DOMException('The read was cancelled', 'AbortError'))
}

/**
 * Register a consumer that the family cooldown refused as an interest in the
 * scheduled recovery, so another consumer unmounting cannot cancel it while
 * this one is still mounted. It sends nothing and leaves the deadline, the
 * reread members and the attempt budget unchanged. A consumer without a
 * signal has no lifecycle to observe and is not registered, so it can never
 * hold a recovery alive on its own.
 */
export function joinReadRequestRecovery(key: string, signal: AbortSignal | undefined): void {
  if (!signal || signal.aborted) return
  const recovery = recoveries.get(key)
  if (recovery?.state === 'scheduled') recovery.addSubscribers([signal])
}

export function getReadRequestRecovery(key: string): Promise<void> | undefined {
  const recovery = recoveries.get(key)
  return recovery && recovery.deadlineMs <= Date.now() ? recovery.pending : undefined
}

/**
 * Reserve the family's single recovery, or join the scheduled one. A denied
 * URL that joins adds its own reread, so concurrently denied siblings are all
 * recovered by the same attempt instead of only the URL that reserved it.
 */
export function reserveReadRequestRecovery(
  key: string,
  deadlineMs: number,
  memberKey: string,
  recover: (signal: AbortSignal) => Promise<unknown>,
  signals: Array<AbortSignal | undefined> = [undefined]
): boolean {
  if (!isBrowser() || METADATA_READ_MAX_RECOVERY_ATTEMPTS < 1) return false
  const existing = recoveries.get(key)
  if (existing) {
    if (existing.state === 'scheduled') {
      existing.deadlineMs = Math.max(existing.deadlineMs, deadlineMs)
      existing.addSubscribers(signals)
      if (!existing.members.has(memberKey)) existing.members.set(memberKey, recover)
    }
    return false
  }
  if (signals.every(signal => signal?.aborted)) return false
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const pending = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  // A recovery can have no current waiter. Keep its rejection handled until a
  // consumer joins at the deadline; that consumer still receives the real error.
  void pending.catch(() => undefined)
  const controller = new AbortController()
  const interests = new Set<AbortSignal | undefined>()
  const watchedSignals = new Set<AbortSignal>()
  const onAbort = () => {
    if (!Array.from(interests).every(signal => signal?.aborted)) return
    // Release the reservation so a later mount's denial can schedule its own.
    if (recoveries.get(key) !== entry) return
    recoveries.delete(key)
    disposeRecovery(entry)
  }
  const entry: RecoveryEntry = {
    deadlineMs,
    controller,
    pending,
    resolve,
    reject,
    state: 'scheduled',
    members: new Map([[memberKey, recover]]),
    removeListeners: () =>
      watchedSignals.forEach(signal => signal.removeEventListener('abort', onAbort)),
    addSubscribers: addedSignals => {
      for (const signal of addedSignals) {
        if (signal?.aborted || interests.has(signal)) continue
        interests.add(signal)
        if (signal) {
          watchedSignals.add(signal)
          signal.addEventListener('abort', onAbort, { once: true })
        }
      }
    },
  }
  entry.addSubscribers(signals)
  while (recoveries.size >= METADATA_READ_CACHE_MAX_ENTRIES) {
    const oldest = recoveries.keys().next().value
    if (oldest === undefined) break
    const oldEntry = recoveries.get(oldest)
    if (oldEntry) disposeRecovery(oldEntry)
    recoveries.delete(oldest)
  }
  recoveries.set(key, entry)
  const schedule = () => {
    // Native timers cap their delay at 2^31-1 ms; chunk longer server deadlines
    // rather than letting the platform clamp them into an immediate retry.
    entry.timer = setTimeout(
      () => {
        if (recoveries.get(key) !== entry || controller.signal.aborted) return
        if (Date.now() < entry.deadlineMs) {
          schedule()
          return
        }
        entry.timer = undefined
        entry.state = 'running'
        void runRecovery(key, entry)
      },
      Math.min(2_147_483_647, Math.max(0, entry.deadlineMs - Date.now()))
    )
  }
  schedule()
  return true
}

/**
 * Reread the members one at a time. The first failure ends the attempt: a
 * fresh denial has already set the family cooldown, so the remaining members
 * would only be refused locally. Either outcome releases the entry, which keeps
 * one recovery per denial while letting a later denial schedule its own.
 */
async function runRecovery(key: string, entry: RecoveryEntry): Promise<void> {
  try {
    for (const recover of entry.members.values()) {
      if (recoveries.get(key) !== entry || entry.controller.signal.aborted) return
      await recover(entry.controller.signal)
    }
  } catch (error) {
    if (recoveries.get(key) !== entry) return
    recoveries.delete(key)
    entry.removeListeners()
    entry.reject(error)
    return
  }
  if (recoveries.get(key) !== entry) return
  recoveries.delete(key)
  entry.removeListeners()
  entry.resolve()
}

export function completeReadRequestRecovery(key: string): void {
  const recovery = recoveries.get(key)
  // A running recovery settles itself once every member has been reread.
  if (!recovery || recovery.state === 'running') return
  if (recovery.timer) clearTimeout(recovery.timer)
  recovery.removeListeners()
  recovery.resolve()
  recoveries.delete(key)
}

export function __resetReadRequestCacheForTests(): void {
  principal = null
  if (invalidationChannel) {
    invalidationChannel.close()
    invalidationChannel = null
  }
  clearReadRequestCache()
  invalidationHandler?.()
}
