/**
 * How long one Codex or Grok provider attempt can live, and the windows that
 * must outlast it.
 *
 * An attempt starts at authorize: its execution ticket stays redeemable for
 * the ticket TTL, and once redeemed the proxy streams for at most the
 * `maxStreamDurationMs` this service returns on redeem. Spend arrives at
 * finalize, after the stream ends. The budget reservation taken at authorize
 * and the in-flight usage grace the sweepers honour must both cover that
 * whole lifetime plus the rollup lag, or spend lands after the reservation
 * freed its headroom and after the sweeper closed the invocation.
 *
 * The base constants live here, not in the ticket and redemption modules
 * that re-export them: those modules import `llmProviderAttemptStore`, which
 * imports this one, so defining them there would make this module read them
 * before they are initialized whenever the ticket module loads first.
 */
import { LIMITS as GROK_CONTRACT_LIMITS } from '@clerum/grok-provider-attempt-contract'
import { LIMITS as CODEX_CONTRACT_LIMITS } from '@clerum/llm-provider-attempt-contract'
import { config } from '../config.js'

/**
 * The ticket TTL is a published contract limit: the proxies bound their
 * admission waits against it and the fixtures freeze it, so control-api signs
 * tickets with the contract value rather than a copy of it (#739).
 */
export const CODEX_EXECUTION_TICKET_TTL_SECONDS = CODEX_CONTRACT_LIMITS.executionTicketTtlMs / 1000
export const GROK_EXECUTION_TICKET_TTL_SECONDS = GROK_CONTRACT_LIMITS.executionTicketTtlMs / 1000

/** Per-attempt stream cap control-api returns on redeem (30 min). */
export const CODEX_MAX_STREAM_DURATION_MS = 1_800_000
export const GROK_MAX_STREAM_DURATION_MS = 1_800_000

export const CODEX_ATTEMPT_MAX_LIFETIME_MS =
  CODEX_EXECUTION_TICKET_TTL_SECONDS * 1000 + CODEX_MAX_STREAM_DURATION_MS
export const GROK_ATTEMPT_MAX_LIFETIME_MS =
  GROK_EXECUTION_TICKET_TTL_SECONDS * 1000 + GROK_MAX_STREAM_DURATION_MS

/**
 * Budget reservation TTL for one attempt: its lifetime plus the task-level
 * reservation TTL, which is already sized to the rollup lag (config.ts).
 */
export const CODEX_ATTEMPT_RESERVATION_TTL_SECONDS =
  Math.ceil(CODEX_ATTEMPT_MAX_LIFETIME_MS / 1000) + config.budgetReservationTtlSeconds
export const GROK_ATTEMPT_RESERVATION_TTL_SECONDS =
  Math.ceil(GROK_ATTEMPT_MAX_LIFETIME_MS / 1000) + config.budgetReservationTtlSeconds

/**
 * How long an authorized or redeemed attempt row without usage still counts
 * as in flight, for either provider.
 */
export const IN_FLIGHT_USAGE_GRACE_MS =
  Math.max(CODEX_ATTEMPT_MAX_LIFETIME_MS, GROK_ATTEMPT_MAX_LIFETIME_MS) +
  config.budgetReservationTtlSeconds * 1000
