import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Deploy mirror for the subscription catalog reconciliation cron's config keys.
 *
 * The cron reads three keys. Two of them were added by this change and the
 * third is its older sibling, and nothing so far asserts that what
 * `config.ts` reads is what the cluster actually sets. A key renamed in code
 * and not in `configmaps.yaml` leaves the cron silently at its code default,
 * which for `SUBSCRIPTION_CATALOG_SYNC_CRON_ENABLED` means permanently off —
 * a reconciler that never runs and never says so.
 *
 * The assertions are NOT "every key equals the code default". Two of these
 * values are deliberately not the default, and pinning them to the default
 * would be wrong: `LLM_CATALOG_SYNC_CRON_ENABLED` is deliberately ON in the
 * cluster while its code default is off. Each key is pinned to the value the
 * deployment means, with the reason beside it.
 *
 * The pattern (`read` + a fail-loud single-match `extractOne`) follows
 * `config.pluginSdkRateLimits.test.ts`. A key that is absent from the manifest
 * makes `extractOne` throw rather than skipping the assertion.
 */

const CRON_KEYS = [
  'SUBSCRIPTION_CATALOG_SYNC_CRON_ENABLED',
  'SUBSCRIPTION_CATALOG_SYNC_INTERVAL_MS',
  'LLM_CATALOG_SYNC_CRON_ENABLED',
] as const

type CronKey = (typeof CRON_KEYS)[number]

/** The code floor in `config.ts`; below it control-api refuses to boot. */
const MIN_INTERVAL_MS = 15 * 60_000

async function loadConfigWith(overrides: Partial<Record<CronKey, string>>) {
  const originalValues = new Map<string, string | undefined>()
  for (const key of CRON_KEYS) {
    originalValues.set(key, process.env[key])
    delete process.env[key]
  }
  Object.assign(process.env, overrides)
  vi.resetModules()
  try {
    const mod = await import('../src/config.js')
    return mod.config
  } finally {
    for (const key of CRON_KEYS) {
      const value = originalValues.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function read(relativeFromThisFile: string): string {
  return readFileSync(new URL(relativeFromThisFile, import.meta.url), 'utf-8')
}

/** Fail-loud single-match extraction — a miss means the key is unregistered. */
function extractOne(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern)
  if (!match || match[1] === undefined) {
    throw new Error(`Could not extract ${label} with ${pattern} — register the key`)
  }
  return match[1]
}

describe('subscription catalog sync cron config', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('defaults the reconciliation off and the interval to six hours', async () => {
    const config = await loadConfigWith({})

    expect(config.subscriptionCatalogSyncCronEnabled).toBe(false)
    expect(config.subscriptionCatalogSyncIntervalMs).toBe(6 * 60 * 60 * 1000)
  })

  it('honours an interval override at or above the floor', async () => {
    const config = await loadConfigWith({
      SUBSCRIPTION_CATALOG_SYNC_INTERVAL_MS: String(MIN_INTERVAL_MS),
    })

    expect(config.subscriptionCatalogSyncIntervalMs).toBe(MIN_INTERVAL_MS)
  })

  it('refuses to boot on an interval below the floor', async () => {
    // Fail loud, at import. A silently clamped interval would turn a typo into
    // one vendor call per connected grant every few seconds.
    await expect(
      loadConfigWith({ SUBSCRIPTION_CATALOG_SYNC_INTERVAL_MS: String(MIN_INTERVAL_MS - 1) })
    ).rejects.toThrow(/SUBSCRIPTION_CATALOG_SYNC_INTERVAL_MS must be an integer >= 900000/)
  })

  it('turns the reconciliation on only for the exact string "true"', async () => {
    // Same exact-token idiom as the discovery cron: `enabled=1` or `yes` must
    // not silently start issuing vendor calls.
    expect(
      (await loadConfigWith({ SUBSCRIPTION_CATALOG_SYNC_CRON_ENABLED: 'true' }))
        .subscriptionCatalogSyncCronEnabled
    ).toBe(true)
    expect(
      (await loadConfigWith({ SUBSCRIPTION_CATALOG_SYNC_CRON_ENABLED: '1' }))
        .subscriptionCatalogSyncCronEnabled
    ).toBe(false)
    expect(
      (await loadConfigWith({ SUBSCRIPTION_CATALOG_SYNC_CRON_ENABLED: 'TRUE' }))
        .subscriptionCatalogSyncCronEnabled
    ).toBe(false)
  })

  it('registers all three cron keys in the base ConfigMap with the deployed values', async () => {
    const config = await loadConfigWith({})
    const source = read('../../deploy/base/control-plane/configmaps.yaml')

    // Off in the cluster, matching the code default: each tick calls the broker
    // once per connected grant, so this is turned on per deployment.
    expect(
      extractOne(
        source,
        /SUBSCRIPTION_CATALOG_SYNC_CRON_ENABLED:\s*"([^"]+)"/,
        'SUBSCRIPTION_CATALOG_SYNC_CRON_ENABLED in deploy/base/control-plane/configmaps.yaml'
      )
    ).toBe('false')
    expect(config.subscriptionCatalogSyncCronEnabled).toBe(false)

    // Declared at the code default so the interval is visible where it is set.
    const interval = Number(
      extractOne(
        source,
        /SUBSCRIPTION_CATALOG_SYNC_INTERVAL_MS:\s*"(\d+)"/,
        'SUBSCRIPTION_CATALOG_SYNC_INTERVAL_MS in deploy/base/control-plane/configmaps.yaml'
      )
    )
    expect(interval).toBe(config.subscriptionCatalogSyncIntervalMs)
    expect(interval).toBeGreaterThanOrEqual(MIN_INTERVAL_MS)

    // Deliberately NOT the code default: the discovery sync is one call to
    // models.dev per tick, so it runs everywhere.
    expect(
      extractOne(
        source,
        /LLM_CATALOG_SYNC_CRON_ENABLED:\s*"([^"]+)"/,
        'LLM_CATALOG_SYNC_CRON_ENABLED in deploy/base/control-plane/configmaps.yaml'
      )
    ).toBe('true')
    expect(config.llmCatalogSyncCronEnabled).toBe(false)
  })
})
