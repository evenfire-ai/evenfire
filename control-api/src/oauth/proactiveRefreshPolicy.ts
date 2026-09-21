import type { GetAccessTokenResult } from './tokenHelper.js'

/**
 * Pure decision layer for the PROACTIVE remote-token refresh + DCR client
 * lifecycle sweep (mini-spec L §4/§5). This module holds NO IO: every function
 * is `(input, now, buffers) → decision`, so the two decision tables are
 * property-testable in isolation (pr-discipline T2) and the cron
 * (`services/oauthProactiveRefreshCron.ts`) stays a thin orchestrator over them.
 *
 * The refresh machinery itself is NOT reimplemented here — the cron feeds each
 * `refresh` decision into the existing reactive `getAccessToken` (mini-spec §6.2).
 */

// ─── §4 · Proactive token-refresh decision ──────────────────────────────────

/**
 * The subset of an `oauth_grants` row the token decision depends on. Derived by
 * the caller from the enumerated row; `accessTokenExpiresAt` is the authoritative
 * expiry (NULL ⇒ the AS never supplied `expires_in`).
 */
export interface ProactiveTokenInput {
  /** Authoritative access-token expiry; NULL ⇒ no computable threshold (P1). */
  accessTokenExpiresAt: Date | null
  /** Whether a refresh token is stored for the grant. */
  hasRefreshToken: boolean
  /** `spec.oauth.supportsRefresh`, fail-closed from pinned metadata (D-8). */
  supportsRefresh: boolean
  /** Whether the grant is eligible for unattended (background) use (P7). */
  eligibleForBackground: boolean
}

/**
 * A noop carries WHY it was a noop so the cron can emit a precise metric/log
 * without re-deriving the reason. `reactive_window` = the grant is inside the
 * REACTIVE window (`remaining ≤ Br`); the reactive path owns it, not the cron.
 */
export type ProactiveTokenDecision =
  | {
      kind: 'noop'
      reason: 'not_eligible' | 'null_expiry' | 'expired' | 'healthy' | 'reactive_window'
    }
  | { kind: 'refresh' }
  | { kind: 'reconsent_imminent'; reason: 'no_refresh_support' | 'no_refresh_token' }

/**
 * Classify one candidate grant against the proactive window (mini-spec §4).
 *
 * Precedence (each branch is exclusive; the first match wins):
 *  1. `!eligibleForBackground`      → noop `not_eligible`   (P7; the "cualquiera" gate)
 *  2. `accessTokenExpiresAt == null`→ noop `null_expiry`    (P1)
 *  3. `remaining ≤ 0`               → noop `expired`        (P6; proactive never chases dead tokens)
 *  4. `remaining > Bp`              → noop `healthy`        (P2; outside the window, healthy)
 *  5. `remaining ≤ Br`             → noop `reactive_window` (below the proactive window)
 *  6. in-window + `!supportsRefresh`→ reconsent_imminent    (P4; fail-closed, no refresh attempt)
 *  7. in-window + no refresh token  → reconsent_imminent    (P5)
 *  8. in-window, refreshable        → refresh              (P3)
 *
 * Proactive window is the strict-open/closed interval `(now+Br, now+Bp]` i.e.
 * `Br < remaining ≤ Bp`. `Bp > Br` is a config invariant (validated at boot).
 *
 * @param now epoch milliseconds
 * @param bpMs proactive buffer (Bp)
 * @param brMs reactive buffer (Br)
 */
export function classifyProactiveTokenDecision(
  input: ProactiveTokenInput,
  now: number,
  bpMs: number,
  brMs: number
): ProactiveTokenDecision {
  if (!input.eligibleForBackground) return { kind: 'noop', reason: 'not_eligible' }
  if (input.accessTokenExpiresAt === null) return { kind: 'noop', reason: 'null_expiry' }

  const remaining = input.accessTokenExpiresAt.getTime() - now
  if (remaining <= 0) return { kind: 'noop', reason: 'expired' }
  if (remaining > bpMs) return { kind: 'noop', reason: 'healthy' }
  if (remaining <= brMs) return { kind: 'noop', reason: 'reactive_window' }

  // Inside the proactive window (Br < remaining ≤ Bp).
  if (!input.supportsRefresh) return { kind: 'reconsent_imminent', reason: 'no_refresh_support' }
  if (!input.hasRefreshToken) return { kind: 'reconsent_imminent', reason: 'no_refresh_token' }
  return { kind: 'refresh' }
}

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
