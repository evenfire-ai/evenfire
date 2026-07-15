import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Cross-service regression guard for the host-wake rate-limit budget
 * (config.hostWakeRlPerMin, bucket `host-wake:<hostRef>` in
 * routes/rpc-access/hosts.ts).
 *
 * Three legitimate caller classes share that single per-host bucket:
 *   1. rpc-proxy's wake-and-hold retrigger loop (the mechanism's own
 *      backstop) — rpc-proxy/src/services/wakeAndHold.ts,
 *   2. Desktop prewarm bursts — desktop-app/src/appService.ts,
 *   3. real user messages.
 * The rate limiter is mounted BEFORE the route handler and the
 * hostWakeCoalesceWindowMs coalescer runs INSIDE the handler (it coalesces
 * annotation projections, not HTTP calls), so EVERY raw call consumes
 * budget. The default budget must therefore cover the mechanism's raw-call
 * worst case with headroom — otherwise correctness-critical message wakes
 * get starved by the backstop + prewarm noise.
 *
 * The rpc-proxy/deploy constants below are hard-coded mirrors of:
 *   - RPC_PROXY_WAKE_RETRIGGER_MS default  → rpc-proxy/src/config.ts
 *   - RPC_PROXY_WAKE_MAX_HOLD_MS default   → rpc-proxy/src/config.ts
 *   - replicas: 2                          → deploy/base/rpc-proxy/rpc-proxy.yaml
 *   - 1 + PREWARM_REEMIT_MAX_ATTEMPTS (=2) → desktop-app/src/appService.ts
 * and each mirror is verified against the live source file (same idiom as
 * deploy.channelReaderControlApiBoundary.test.ts), so changing the rpc-proxy
 * cadence without re-deriving this budget fails HERE, in control-api CI.
 */

// Hard-coded mirrors (source files named above).
const WAKE_RETRIGGER_MS = 15_000
const WAKE_MAX_HOLD_MS = 90_000
const RPC_PROXY_REPLICAS = 2
const PREWARM_CALLS_PER_DEVICE = 3 // 1 initial + PREWARM_REEMIT_MAX_ATTEMPTS
const PREWARM_CONCURRENT_DEVICES_BUDGET = 4

// Worst case of the wake-and-hold mechanism alone, in raw calls:
//   per instance: 1 initial + floor(maxHold / retrigger) retriggers = 7
//   fleet-wide:   x replicas (per-instance dedup, no cross-instance dedup)
//   per minute:   14 calls / 90s = ~9.33/min
const HOLD_CALLS_PER_INSTANCE = 1 + Math.floor(WAKE_MAX_HOLD_MS / WAKE_RETRIGGER_MS)
const HOLD_CALLS_FLEET = HOLD_CALLS_PER_INSTANCE * RPC_PROXY_REPLICAS
const MECHANISM_CALLS_PER_MIN = HOLD_CALLS_FLEET * (60_000 / WAKE_MAX_HOLD_MS)

const ENV_KEYS = [
  'CONTROL_API_HOST_WAKE_RL_PER_MIN',
  'CONTROL_API_HOST_WAKE_COALESCE_WINDOW_MS',
] as const

async function loadConfigWith(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  const originalValues = new Map<string, string | undefined>()
  for (const key of ENV_KEYS) {
    originalValues.set(key, process.env[key])
    delete process.env[key]
  }
  Object.assign(process.env, overrides)
  vi.resetModules()
  try {
    const mod = await import('../src/config.js')
    return mod.config
  } finally {
    for (const key of ENV_KEYS) {
      const value = originalValues.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function read(relativeFromThisFile: string): string {
  return readFileSync(new URL(relativeFromThisFile, import.meta.url), 'utf-8')
}

/** Fail-loud single-match extraction — a miss means the source moved. */
function extractOne(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern)
  if (!match || match[1] === undefined) {
    throw new Error(`Could not extract ${label} with ${pattern} — re-derive the mirrors`)
  }
  return match[1]
}

describe('host-wake rate limit budget (cross-service derivation guard)', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('mirrors match the live rpc-proxy wake cadence defaults', () => {
    const rpcProxyConfig = read('../../rpc-proxy/src/config.ts')
    const retrigger = extractOne(
      rpcProxyConfig,
      /RPC_PROXY_WAKE_RETRIGGER_MS\s*\|\|\s*'(\d+)'/,
      'rpc-proxy wakeRetriggerMs default'
    )
    const maxHold = extractOne(
      rpcProxyConfig,
      /RPC_PROXY_WAKE_MAX_HOLD_MS\s*\|\|\s*'(\d+)'/,
      'rpc-proxy wakeMaxHoldMs default'
    )
    expect(Number(retrigger)).toBe(WAKE_RETRIGGER_MS)
    expect(Number(maxHold)).toBe(WAKE_MAX_HOLD_MS)
  })

  it('mirror matches the live rpc-proxy replica count', () => {
    const manifest = read('../../deploy/base/rpc-proxy/rpc-proxy.yaml')
    const replicas = extractOne(manifest, /^\s*replicas:\s*(\d+)\s*$/m, 'rpc-proxy replicas')
    expect(Number(replicas)).toBe(RPC_PROXY_REPLICAS)
  })

  it('mirror matches the live desktop prewarm re-emit budget', () => {
    const appService = read('../../desktop-app/src/appService.ts')
    const reemits = extractOne(
      appService,
      /PREWARM_REEMIT_MAX_ATTEMPTS\s*=\s*(\d+)/,
      'desktop prewarm re-emit attempts'
    )
    expect(1 + Number(reemits)).toBe(PREWARM_CALLS_PER_DEVICE)
  })

  it('default budget covers the derived worst case with headroom', async () => {
    const config = await loadConfigWith({})

    // Sanity-pin the derivation arithmetic itself.
    expect(HOLD_CALLS_PER_INSTANCE).toBe(7)
    expect(HOLD_CALLS_FLEET).toBe(14)
    expect(MECHANISM_CALLS_PER_MIN).toBeCloseTo(9.333, 3)

    // Invariant 1: >=3x the single-hold mechanism volume, so the backstop
    // alone can never come close to exhausting the bucket.
    expect(config.hostWakeRlPerMin).toBeGreaterThanOrEqual(3 * MECHANISM_CALLS_PER_MIN)

    // Invariant 2: one held wake + prewarm bursts from a few concurrent
    // devices + at least one real message must fit in a single minute.
    expect(config.hostWakeRlPerMin).toBeGreaterThanOrEqual(
      MECHANISM_CALLS_PER_MIN + PREWARM_CALLS_PER_DEVICE * PREWARM_CONCURRENT_DEVICES_BUDGET + 1
    )
  })

  it('defaults host wake rate limit to the derived 30/min', async () => {
    const config = await loadConfigWith({})

    expect(config.hostWakeRlPerMin).toBe(30)
  })

  it('accepts the host wake rate limit environment override', async () => {
    const config = await loadConfigWith({ CONTROL_API_HOST_WAKE_RL_PER_MIN: '5' })

    expect(config.hostWakeRlPerMin).toBe(5)
  })

  it('keeps the coalescence window default independent of the budget change', async () => {
    const config = await loadConfigWith({})

    expect(config.hostWakeCoalesceWindowMs).toBe(2000)
  })
})
