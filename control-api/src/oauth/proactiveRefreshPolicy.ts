import type { GetAccessTokenResult } from './tokenHelper.js'

/**
 * Pure decision helpers for the PROACTIVE remote-token refresh + DCR client
 * lifecycle sweep (mini-spec L §4/§5). This module holds NO IO, so each helper is
 * property-testable in isolation (pr-discipline T2) and the cron
 * (`services/oauthProactiveRefreshCron.ts`) stays a thin orchestrator over them.
 *
 * It does NOT decide WHICH grants to refresh: the proactive candidate selection
 * is the SQL `WHERE` of `listRemoteGrantsInProactiveWindow` (`store.ts`) plus the
 * staleness check inside the reactive `getAccessToken` the cron feeds each
 * candidate to (mini-spec §6.2). What lives here is `resultToOutcome` (map a
 * `getAccessToken` result to a metric outcome, §4) and `classifyDcrSecretDecision`
 * (the DCR client-secret warn/expire decision, §5).
 */

// ─── §4 · Refresh-result interpretation ─────────────────────────────────────

/**
 * Outcome label for `oauth_proactive_refresh_grants_total{outcome}`. `skipped`
 * is NOT produced by {@link resultToOutcome} — the cron emits it directly when a
 * `FOR UPDATE SKIP LOCKED` claim finds 0 rows (another replica holds it, or the
 * reactive path already renewed it out of the window).
 */
export type ProactiveRefreshOutcome =
  | 'ok'
  | 'transient'
  | 'client_invalid'
  | 'no_grant'
  | 'skipped'
  | 'error'

/**
 * Map a `getAccessToken` result to a proactive outcome (mini-spec §4, second
 * table). `refresh_failed` with a 400/401 status is a client-credential failure
 * (`invalid_client`) that triggers the DCR policy (§5); any other
 * `refresh_failed` is transient and degrades to the reactive path. Config-broken
 * kinds are `error` and are never retried in a tight loop.
 */
export function resultToOutcome(result: GetAccessTokenResult): ProactiveRefreshOutcome {
  switch (result.kind) {
    case 'ok':
      return 'ok'
    case 'no_grant':
      return 'no_grant'
    case 'refresh_failed':
      return result.status === 400 || result.status === 401 ? 'client_invalid' : 'transient'
    case 'recipe_not_found':
    case 'unknown_oauth_client':
    case 'unsupported_provider':
    case 'secret_missing':
      return 'error'
  }
}

// ─── §5 · DCR client-secret lifecycle decision ──────────────────────────────

/** The subset of a `dynamic_clients` row the DCR decision depends on (§5). */
export interface DcrSecretInput {
  clientMode: 'public' | 'confidential'
  /** RFC 7591 `client_secret_expires_at`; NULL ⇒ non-expiring (0/absent). */
  clientSecretExpiresAt: Date | null
}

/**
 * DCR lifecycle decision (mini-spec §5). `warn` = C4 (expiring within Wc);
 * `expired` = C5 (already lapsed → the confidential refresh will fail
 * `invalid_client` and the reactive path degrades to `connect_required`). Both
 * are avisar/degrade only — this unit never re-registers or mutates (C6 is
 * transparent and needs no branch here).
 */
export type DcrSecretDecision =
  | { kind: 'noop'; reason: 'public' | 'no_expiry' | 'healthy' }
  | { kind: 'warn' }
  | { kind: 'expired' }

/**
 * Classify one `dynamic_clients` row against the warn window `Wc` (mini-spec §5).
 *
 * Precedence:
 *  1. `public`                         → noop `public`   (C1)
 *  2. `clientSecretExpiresAt == null`  → noop `no_expiry`(C2)
 *  3. `exp ≤ now`                      → expired         (C5)
 *  4. `now < exp ≤ now+Wc`             → warn            (C4)
 *  5. else (`exp > now+Wc`)            → noop `healthy`  (C3)
 *
 * @param now epoch milliseconds
 * @param wcMs warn window (Wc)
 */
export function classifyDcrSecretDecision(
  input: DcrSecretInput,
  now: number,
  wcMs: number
): DcrSecretDecision {
  if (input.clientMode === 'public') return { kind: 'noop', reason: 'public' }
  if (input.clientSecretExpiresAt === null) return { kind: 'noop', reason: 'no_expiry' }

  const exp = input.clientSecretExpiresAt.getTime()
  if (exp <= now) return { kind: 'expired' }
  if (exp <= now + wcMs) return { kind: 'warn' }
  return { kind: 'noop', reason: 'healthy' }
}
