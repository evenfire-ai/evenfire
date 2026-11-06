/**
 * Guarded hook transport (spec §8.2 / §8.6), shared by the LLM lane
 * (`RemoteLlmHook`) and the tool lane (`RemoteToolHook`) so both lanes apply the
 * same quarantine gate, circuit breaker and hard deadline to every `/v1` dial.
 *
 *  - Quarantine (§8.2): a quarantined hook (e.g. digest mismatch, DuplicatePath
 *    loser) never reaches the network — every call reports `unavailable`, so the
 *    calling point's §8.6 fail-posture applies (a `may_deny` fail-closed hook
 *    denies; an advisory hook contributes nothing).
 *  - Circuit breaker (§8.6): honored only for an advisory hook that opted into
 *    `breaker` mode. While tripped, calls short-circuit to `unavailable` WITHOUT
 *    dialing for the cooldown window. A deny-authoritative (`may_deny`) hook
 *    always dials strict so it can never be tripped into failing open.
 *  - Hard deadline: an absolute ceiling on every dial, independent of the
 *    transport's own timeout, so a dial that never settles still resolves to
 *    `unavailable` and the awaiting turn cannot hang.
 *
 * Every branch reports `unavailable` — never a silent allow.
 */
import { logger } from '../../../logger'
import { type HookBreakerRegistry, defaultBreakerRegistry } from './hookBreaker'
import type { HookDescriptor, HookFetcher, HookHttpResult } from './types'

export interface GuardHookFetcherOptions {
  descriptor: HookDescriptor
  fetch: HookFetcher
  /** Shared so a trip survives the per-task rebuild of hook instances (§8.6). */
  breakers?: HookBreakerRegistry
  /** Injectable clock for deterministic breaker tests. */
  now?: () => number
  /** Absolute per-dial ceiling; set well above the transport timeout. */
  hardDeadlineMs?: number
}

export const DEFAULT_HOOK_HARD_DEADLINE_MS = 15000

/** Fresh object per short-circuit so callers never share a mutable result. */
const unavailable = (): HookHttpResult => ({ status: 0, body: undefined, unavailable: true })

/** Identity of the breaker state (per hook pod+path), shared across tasks and lanes (§8.6). */
export function hookBreakerKey(descriptor: HookDescriptor): string {
  return `${descriptor.endpoint}${descriptor.path}`
}

/** The breaker is honored only for an advisory hook that opted into `breaker` mode (§8.6). */
export function hookBreakerEngaged(descriptor: HookDescriptor): boolean {
  return (
    descriptor.onUnavailable?.mode === 'breaker' && !descriptor.capabilities.includes('may_deny')
  )
}

/**
 * Race the transport against an absolute deadline. Promise.race attaches a
 * handler to the loser, so a late transport rejection is not an unhandled
 * rejection.
 */
function withDeadline(
  fetch: HookFetcher,
  args: Parameters<HookFetcher>[0],
  hardDeadlineMs: number
): Promise<HookHttpResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<HookHttpResult>(resolve => {
    timer = setTimeout(() => resolve(unavailable()), hardDeadlineMs)
    // Don't let the backstop timer keep the event loop alive.
    ;(timer as { unref?: () => void }).unref?.()
  })
  return Promise.race([fetch(args), deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** Wrap a raw `HookFetcher` with the quarantine gate, §8.6 breaker and hard deadline. */
export function guardHookFetcher(opts: GuardHookFetcherOptions): HookFetcher {
  const { descriptor, fetch } = opts
  const breakers = opts.breakers ?? defaultBreakerRegistry
  const now = opts.now ?? (() => Date.now())
  const hardDeadlineMs = opts.hardDeadlineMs ?? DEFAULT_HOOK_HARD_DEADLINE_MS
  const key = hookBreakerKey(descriptor)

  return async args => {
    if (descriptor.quarantined) return unavailable()
    const engaged = hookBreakerEngaged(descriptor)
    // Breaker open: skip the dial (and its timeout); report unavailable.
    if (engaged && breakers.isOpen(key, now())) return unavailable()

    const res = await withDeadline(fetch, args, hardDeadlineMs)
    if (engaged) {
      const policy = descriptor.onUnavailable!
      // "Response too big" (oversized) is NOT a hook-down failure — leave breaker
      // state unchanged so small payloads that fit are still dialed. Only a real
      // transport failure counts, and a reachable response resets it.
      if (res.oversized) {
        // no-op on breaker state
      } else if (res.unavailable) {
        const tripped = breakers.recordFailure(
          key,
          policy.failureThreshold,
          policy.cooldownMs,
          now()
        )
        if (tripped) {
          logger.warn(
            {
              hookId: descriptor.id,
              failureThreshold: policy.failureThreshold,
              cooldownMs: policy.cooldownMs,
            },
            '[Guardrails] hook breaker tripped; failing open for cooldown'
          )
        }
      } else {
        breakers.recordSuccess(key)
      }
    }
    return res
  }
}
