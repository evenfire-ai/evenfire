import { getJwtExpiry } from './mcpHostRuntimeJwt'
import { type McpHostRuntimeAuth, refreshWithRecovery } from './userApprovalRequester'

/**
 * Proactive runtime-auth refresh.
 *
 * The pod's runtime-auth chain is otherwise refreshed only reactively (on a
 * 401 from an approval/poll/usage call). An idle first-party mcp-host that
 * makes no gateway calls therefore lets its refresh token expire beyond the
 * reissue grace window, after which it cannot self-heal and HCC will not roll
 * it because the pod still reports ready.
 *
 * This scheduler refreshes the chain a margin BEFORE the refresh token expires,
 * keeping an idle pod alive indefinitely. When the chain becomes unrecoverable,
 * the repeated failures flow through refreshWithRecovery into
 * runtimeAuthHealth; after the degraded threshold the readiness probe
 * (/v1/runtime/health) returns 503, the pod goes NotReady, and HCC rolls it.
 */

const DEFAULT_MARGIN_SEC = 600
const DEFAULT_MIN_INTERVAL_SEC = 60
const DEFAULT_FALLBACK_SEC = 1800

export type ProactiveRefreshConfig = {
  enabled: boolean
  marginSec: number
  minIntervalSec: number
  fallbackSec: number
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
  }
}

/**
 * Pure: ms until the next proactive refresh, derived from the refresh token's
 * `exp`. Refreshes `marginSec` before expiry, clamped to `minIntervalSec` so a
 * past-due or undecodable token retries promptly rather than hot-looping.
 */
export function computeNextRefreshDelayMs(
  refreshToken: string,
  nowMs: number,
  cfg: ProactiveRefreshConfig
): number {
  const minMs = cfg.minIntervalSec * 1000
  const expSec = getJwtExpiry(refreshToken)
  if (expSec == null) return Math.max(cfg.fallbackSec * 1000, minMs)
  const targetMs = expSec * 1000 - cfg.marginSec * 1000
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

  const refresh = deps.refresh ?? refreshWithRecovery
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
        // refreshWithRecovery already recorded the failure into runtimeAuthHealth.
        // Swallow here so the loop survives and keeps accumulating failures until
        // the readiness probe degrades and HCC rolls the pod.
        ok = false
      }
      // Success: reschedule from the rotated token's fresh expiry. Failure: retry
      // soon so consecutive failures reach the degraded threshold quickly.
      arm(ok ? computeNextRefreshDelayMs(auth.refreshToken, now(), cfg) : cfg.minIntervalSec * 1000)
    })()
  }

  arm(computeNextRefreshDelayMs(auth.refreshToken, now(), cfg))
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
