import {
  ContextMapperRequestError,
  isContextMapperInventoryAuthorityRevocation,
} from '../contextMapperClient'
import type { McpDetachedServerCleanup } from './manager'

interface ClosableMcpAuthorityManager {
  close(scheduleCleanup: (cleanup: McpDetachedServerCleanup) => void): Promise<void>
}

interface McpAuthorityCoordinator<TManager extends object> {
  closeManager(manager: TManager): void
  scheduleCleanup(cleanup: McpDetachedServerCleanup): void
}

export interface RevokeMcpAuthorityOptions<TManager extends ClosableMcpAuthorityManager> {
  reason: string
  restartPolling: boolean
  invalidateInitialization(): void
  stopPolling(): void
  clearStalenessDeadline(): void
  withdrawManager(): TManager | null
  clearServerState(): void
  clearLastSuccess(): void
  coordinator: McpAuthorityCoordinator<TManager>
  onCleanupFailure(): void
  onRevoked(): void
  shouldRestartPolling(): boolean
  startPolling(): void
}

/**
 * Withdraw all locally-published MCP authority before scheduling transport
 * cleanup. The injected state operations keep this ordering explicit and make
 * the fail-closed lifecycle independently testable without starting main.
 */
export function revokeMcpAuthorityState<TManager extends ClosableMcpAuthorityManager>(
  options: RevokeMcpAuthorityOptions<TManager>
): void {
  options.invalidateInitialization()
  options.stopPolling()
  options.clearStalenessDeadline()
  const closingManager = options.withdrawManager()
  options.clearServerState()
  options.clearLastSuccess()

  if (closingManager) {
    options.coordinator.closeManager(closingManager)
    void closingManager
      .close(cleanup => options.coordinator.scheduleCleanup(cleanup))
      .catch(() => options.onCleanupFailure())
  }
  options.onRevoked()

  if (options.restartPolling && options.shouldRestartPolling()) {
    options.startPolling()
  }
}

export function isMcpAuthorityStale(
  lastSuccessAt: number,
  now: number,
  maxStalenessMs: number
): boolean {
  return (
    lastSuccessAt > 0 &&
    Number.isFinite(now) &&
    Number.isFinite(maxStalenessMs) &&
    maxStalenessMs > 0 &&
    now - lastSuccessAt >= maxStalenessMs
  )
}

/**
 * Arm an absolute authority deadline from the last successful HCC snapshot.
 * The independent timeout prevents a slow or failed polling cadence from
 * extending retained authority beyond the configured staleness ceiling.
 */
export function createMcpAuthorityStalenessDeadline(
  maxStalenessMs: number,
  onExpired: () => void,
  now: () => number = Date.now
): { recordSuccess(successAt?: number): void; clear(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let deadlineAt = 0

  const clear = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    deadlineAt = 0
  }

  const schedule = (): void => {
    const remaining = deadlineAt - now()
    timer = setTimeout(
      () => {
        timer = null
        if (now() < deadlineAt) {
          schedule()
          return
        }
        deadlineAt = 0
        onExpired()
      },
      Math.max(0, remaining)
    )
  }

  return {
    recordSuccess: (successAt = now()) => {
      clear()
      if (!Number.isFinite(successAt) || !Number.isFinite(maxStalenessMs) || maxStalenessMs <= 0) {
        return
      }
      deadlineAt = successAt + maxStalenessMs
      schedule()
    },
    clear,
  }
}

export type McpAuthorityPollFailureDisposition =
  | 'caller_authorization_rejected'
  | 'inventory_not_found'
  | 'authority_stale'
  | 'unavailable'

export interface HandleMcpAuthorityPollFailureOptions {
  hasPublishedManager(): boolean
  lastSuccessAt(): number
  now(): number
  maxStalenessMs: number
  revoke(reason: string, restartPolling: boolean): void
  onCallerAuthorizationRejected(): void
  onInventoryAuthorityRevoked(): void
  onUnavailable(): void
}

/** Apply the main polling loop's fail-closed classification to one HCC error. */
export function handleMcpAuthorityPollFailure(
  error: unknown,
  options: HandleMcpAuthorityPollFailureOptions
): McpAuthorityPollFailureDisposition {
  if (error instanceof ContextMapperRequestError && error.authorizationFailure) {
    // ContextMapperClient already revoked synchronously through its callback.
    options.onCallerAuthorizationRejected()
    return 'caller_authorization_rejected'
  }
  if (isContextMapperInventoryAuthorityRevocation(error)) {
    options.revoke('inventory_not_found', true)
    options.onInventoryAuthorityRevoked()
    return 'inventory_not_found'
  }

  options.onUnavailable()
  if (
    options.hasPublishedManager() &&
    isMcpAuthorityStale(options.lastSuccessAt(), options.now(), options.maxStalenessMs)
  ) {
    options.revoke('authority_stale', true)
    return 'authority_stale'
  }
  return 'unavailable'
}
