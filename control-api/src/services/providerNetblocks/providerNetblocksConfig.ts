/**
 * issue #299 Phase 2 — provider-netblocks cron config resolution, extracted from
 * main.ts for testability (CA-8) and safety.
 *
 * A malformed numeric env (e.g. a typo) parsed with `Number(x || default)` would
 * become NaN → `setTimeout(NaN)` fires immediately → the self-rescheduling cron
 * becomes a HOT fetch loop against the provider (rate-limit burn). Every numeric
 * field therefore validates and falls back LOUDLY to its default rather than ever
 * yielding NaN — the safe direction for a background loop on control-api's
 * critical path (a boot crash from a typo would be worse).
 */
export interface ProviderNetblocksCronConfig {
  enabled: boolean
  intervalMs: number
  timeoutMs: number
  maxResponseBytes: number
  namespace: string
}

export const PROVIDER_NETBLOCKS_DEFAULTS = {
  intervalMs: 21_600_000, // 6h
  timeoutMs: 10_000,
  maxResponseBytes: 8_000_000,
  namespace: 'control-plane',
} as const

function positiveIntEnv(
  env: Record<string, string | undefined>,
  name: string,
  def: number,
  warn: (msg: string) => void
): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    warn(`[ControlAPI] ${name}="${raw}" is not a positive integer; using default ${def}`)
    return def
  }
  return n
}

export function resolveProviderNetblocksCronConfig(
  env: Record<string, string | undefined> = process.env,
  warn: (msg: string) => void = console.warn
): ProviderNetblocksCronConfig {
  return {
    enabled: env.PROVIDER_NETBLOCKS_FETCHER_ENABLED !== 'false',
    intervalMs: positiveIntEnv(
      env,
      'PROVIDER_NETBLOCKS_REFRESH_INTERVAL_MS',
      PROVIDER_NETBLOCKS_DEFAULTS.intervalMs,
      warn
    ),
    timeoutMs: positiveIntEnv(
      env,
      'PROVIDER_NETBLOCKS_FETCH_TIMEOUT_MS',
      PROVIDER_NETBLOCKS_DEFAULTS.timeoutMs,
      warn
    ),
    maxResponseBytes: positiveIntEnv(
      env,
      'PROVIDER_NETBLOCKS_MAX_RESPONSE_BYTES',
      PROVIDER_NETBLOCKS_DEFAULTS.maxResponseBytes,
      warn
    ),
    namespace: env.PROVIDER_NETBLOCKS_CONFIGMAP_NAMESPACE || PROVIDER_NETBLOCKS_DEFAULTS.namespace,
  }
}
