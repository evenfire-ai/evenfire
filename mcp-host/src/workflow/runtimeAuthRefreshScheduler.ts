import { config } from '../config'
import { getJwtExpiry, getJwtIssuedAt } from './mcpHostRuntimeJwt'
import { type McpHostRuntimeAuth, refreshWithRecovery } from './userApprovalRequester'

/**
 * Proactive runtime-auth refresh.
 *
 * Without it the pod's runtime-auth chain is refreshed only reactively (on a
 * 401 from an approval/poll/usage call), that is after the access token has
 * already expired. An idle first-party mcp-host that makes no gateway calls
 * would let its refresh token expire beyond the reissue grace window, after
 * which it cannot self-heal and HCC will not roll it because the pod still
 * reports ready.
 *
 * This scheduler refreshes the chain a margin BEFORE the refresh token expires,
 * keeping an idle pod alive indefinitely. On a Host pod (`runtimeKind`
 * standalone) it also renews the access token at half its lifetime, so a token
 * always has that half left when an identity-service outage starts: polls keep
 * working through a shorter outage instead of refreshing inside it. Recipe pods
 * keep the refresh-token rule only. When the chain becomes unrecoverable, the
 * repeated failures flow through refreshWithRecovery into runtimeAuthHealth;
 * after the degraded threshold the readiness probe (/v1/runtime/health)
 * returns 503, the pod goes NotReady, and HCC rolls it.
 *
 * On a Host pod, a renewal that fails only because control-api is unavailable
 * (network error or 5xx on every attempt) does not count toward that threshold
 * while the current access token is still valid at the next retry
 * (`minIntervalSec`): the pod still holds its authority. A refused refresh, a
 * failed re-issue, a malformed answer, any failure once the token would not
 * outlive the next retry, every reactive refresh and every recipe-pod renewal
 * still count.
 */

const DEFAULT_MARGIN_SEC = 600
const DEFAULT_MIN_INTERVAL_SEC = 60
const DEFAULT_FALLBACK_SEC = 1800

export type ProactiveRefreshConfig = {
  enabled: boolean
  marginSec: number
  minIntervalSec: number
  fallbackSec: number
  /** Also renew the access token at half its lifetime (Host pods only). */
  accessHalfLife?: boolean
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function proactiveRefreshConfig(): ProactiveRefreshConfig {
  return {
    enabled: process.env.MCP_HOST_RUNTIME_AUTH_PROACTIVE_REFRESH_ENABLED !== 'false',
    marginSec: envInt('MCP_HOST_RUNTIME_AUTH_PROACTIVE_REFRESH_MARGIN_SEC', DEFAULT_MARGIN_SEC),
    minIntervalSec: envInt(
      'MCP_HOST_RUNTIME_AUTH_PROACTIVE_REFRESH_MIN_SEC',
      DEFAULT_MIN_INTERVAL_SEC
    ),
    fallbackSec: envInt(
      'MCP_HOST_RUNTIME_AUTH_PROACTIVE_REFRESH_FALLBACK_SEC',
      DEFAULT_FALLBACK_SEC
    ),
    // Resolved from the environment at config load, so it is the same for
    // every caller that arms the loop, whichever arms first.
    accessHalfLife: config.runtimeKind === 'standalone',
  }
}

/**
 * Pure: ms until the next proactive refresh. Refreshes `marginSec` before the
 * refresh token's `exp`; with `accessHalfLife`, at the access token's midpoint
 * if that comes first. Clamped to `minIntervalSec` so a past-due token retries
 * promptly rather than hot-looping. An undecodable access token falls back to
 * the refresh-token rule; an undecodable refresh token to `fallbackSec`.
 */
export function computeNextRefreshDelayMs(
  refreshToken: string,
  nowMs: number,
  cfg: ProactiveRefreshConfig,
  accessToken?: string
): number {
  const minMs = cfg.minIntervalSec * 1000
  const expSec = getJwtExpiry(refreshToken)
  let targetMs = expSec == null ? null : expSec * 1000 - cfg.marginSec * 1000
  if (cfg.accessHalfLife && accessToken) {
    const iat = getJwtIssuedAt(accessToken)
    const exp = getJwtExpiry(accessToken)
    if (iat != null && exp != null && exp > iat) {
      const midpointMs = (iat + (exp - iat) / 2) * 1000
      targetMs = targetMs == null ? midpointMs : Math.min(targetMs, midpointMs)
    }
  }
  if (targetMs == null) return Math.max(cfg.fallbackSec * 1000, minMs)
  return Math.max(targetMs - nowMs, minMs)
}

type SchedulerDeps = {
  refresh?: (auth: McpHostRuntimeAuth) => Promise<void>
  now?: () => number
  config?: ProactiveRefreshConfig
}

let timer: ReturnType<typeof setTimeout> | null = null
let running = false

/**
 * Start the proactive refresh loop for the shared runtime auth. Idempotent:
 * a second call while running is a no-op. Honors
 * MCP_HOST_RUNTIME_AUTH_PROACTIVE_REFRESH_ENABLED=false.
 */
export function startRuntimeAuthProactiveRefresh(
  auth: McpHostRuntimeAuth,
  deps: SchedulerDeps = {}
): void {
  const cfg = deps.config ?? proactiveRefreshConfig()
  if (!cfg.enabled || running) return
  running = true

  const refresh =
    deps.refresh ??
    (cfg.accessHalfLife
      ? (a: McpHostRuntimeAuth) =>
          refreshWithRecovery(a, { deferUnavailableWhileAccessValidMs: cfg.minIntervalSec * 1000 })
      : refreshWithRecovery)
  const now = deps.now ?? (() => Date.now())

  const arm = (delayMs: number): void => {
    if (!running) return
    timer = setTimeout(tick, delayMs)
    timer.unref?.()
  }

  const tick = (): void => {
    void (async () => {
      let ok = false
      try {
        await refresh(auth)
        ok = true
      } catch {
        // refreshWithRecovery already recorded the failure (or, on a Host pod,
        // the deferral) into runtimeAuthHealth. Swallow here so the loop
        // survives and keeps accumulating failures until the readiness probe
        // degrades and HCC rolls the pod.
        ok = false
      }
      // Success: reschedule from the rotated token's fresh expiry. Failure: retry
      // soon so consecutive failures reach the degraded threshold quickly.
      arm(
        ok
          ? computeNextRefreshDelayMs(auth.refreshToken, now(), cfg, auth.accessToken)
          : cfg.minIntervalSec * 1000
      )
    })()
  }

  arm(computeNextRefreshDelayMs(auth.refreshToken, now(), cfg, auth.accessToken))
}

/** Stop the proactive refresh loop. Idempotent; used on shutdown and in tests. */
export function stopRuntimeAuthProactiveRefresh(): void {
  running = false
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

/** Test-only: report whether the loop is currently armed. */
export function isRuntimeAuthProactiveRefreshRunning(): boolean {
  return running
}
