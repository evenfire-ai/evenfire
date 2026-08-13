import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Plugin Workload SDK platform rate-limit config (issue #348, plan D2).
 *
 * RED-FIRST (plan §6.6): this suite asserts the POST-change target behavior.
 * Against pre-change code the four `pluginSdk*RlPerMin` config fields and the
 * four `CONTROL_API_PLUGIN_SDK_*_PER_MIN` ConfigMap keys do not exist yet, so
 * every test here FAILS until Phase 1 (step 1.1) and Phase 3 (D1) land. Do
 * not weaken these assertions to pass early.
 *
 * Covered:
 *   1. Code defaults 200/180/600/600 (decision Q3: recalibrated upward from
 *      the old hardcoded 120/60; request-bucket and pre-auth unchanged at 600
 *      but moved to ENV).
 *   2. Each ENV override honored.
 *   3. Invalid values fail loudly at import (positiveIntegerFromEnv).
 *   4. Empty string falls back to the code default.
 *   5. Deploy mirror: the base ConfigMap AND the full-copy minikube overlay
 *      both register every key at the code default (plan D1/R1 — omitting a
 *      key in the minikube full-copy overlay silently falls back to code
 *      defaults, so drift must fail HERE in CI).
 */

const RATE_LIMIT_KEYS = [
  'CONTROL_API_PLUGIN_SDK_NOTIFICATIONS_PER_MIN',
  'CONTROL_API_PLUGIN_SDK_PROMPTBRIDGE_PER_MIN',
  'CONTROL_API_PLUGIN_SDK_REQUEST_BUCKET_PER_MIN',
  'CONTROL_API_PLUGIN_SDK_PREAUTH_PER_MIN',
] as const

type RateLimitKey = (typeof RATE_LIMIT_KEYS)[number]

/** Canonical config field per ENV key with its locked default (plan §5). */
const EXPECTED: Array<{ env: RateLimitKey; field: string; defaultValue: number }> = [
  {
    env: 'CONTROL_API_PLUGIN_SDK_NOTIFICATIONS_PER_MIN',
    field: 'pluginSdkNotificationsRlPerMin',
    defaultValue: 200,
  },
  {
    env: 'CONTROL_API_PLUGIN_SDK_PROMPTBRIDGE_PER_MIN',
    field: 'pluginSdkPromptBridgeRlPerMin',
    defaultValue: 180,
  },
  {
    env: 'CONTROL_API_PLUGIN_SDK_REQUEST_BUCKET_PER_MIN',
    field: 'pluginSdkRequestBucketRlPerMin',
    defaultValue: 600,
  },
  {
    env: 'CONTROL_API_PLUGIN_SDK_PREAUTH_PER_MIN',
    field: 'pluginSdkPreauthRlPerMin',
    defaultValue: 600,
  },
]

async function loadConfigWith(overrides: Partial<Record<RateLimitKey, string>>) {
  const originalValues = new Map<string, string | undefined>()
  for (const key of RATE_LIMIT_KEYS) {
    originalValues.set(key, process.env[key])
    delete process.env[key]
  }
  Object.assign(process.env, overrides)
  vi.resetModules()
  try {
    const mod = await import('../src/config.js')
    // The four fields are added by Phase 1 step 1.1; index access keeps the
    // TARGET assertion expressible before the Config type gains the fields
    // (the values are still asserted strictly below — no soft pass).
    return mod.config as typeof mod.config & Record<string, unknown>
  } finally {
    for (const key of RATE_LIMIT_KEYS) {
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
    throw new Error(`Could not extract ${label} with ${pattern} — register the key (plan D1)`)
  }
  return match[1]
}

describe('plugin SDK platform rate-limit config (issue #348)', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('defaults the four platform rate limits to 200/180/600/600', async () => {
    const config = await loadConfigWith({})

    expect(config.pluginSdkNotificationsRlPerMin).toBe(200)
    expect(config.pluginSdkPromptBridgeRlPerMin).toBe(180)
    expect(config.pluginSdkRequestBucketRlPerMin).toBe(600)
    expect(config.pluginSdkPreauthRlPerMin).toBe(600)
  })

  it.each(EXPECTED)('honors the $env override', async ({ env, field }) => {
    const config = await loadConfigWith({ [env]: '60' })

    expect(config[field]).toBe(60)
  })

  it.each(
    EXPECTED.flatMap(({ env }) => ['abc', '0', '-5', '1.5'].map(invalid => ({ env, invalid })))
  )('rejects $env=$invalid loudly at import', async ({ env, invalid }) => {
    await expect(loadConfigWith({ [env]: invalid })).rejects.toThrow(/must be a positive integer/)
  })

  it('treats an empty string as unset and falls back to the defaults', async () => {
    const config = await loadConfigWith({
      CONTROL_API_PLUGIN_SDK_NOTIFICATIONS_PER_MIN: '',
      CONTROL_API_PLUGIN_SDK_PROMPTBRIDGE_PER_MIN: '',
      CONTROL_API_PLUGIN_SDK_REQUEST_BUCKET_PER_MIN: '',
      CONTROL_API_PLUGIN_SDK_PREAUTH_PER_MIN: '',
    })

    expect(config.pluginSdkNotificationsRlPerMin).toBe(200)
    expect(config.pluginSdkPromptBridgeRlPerMin).toBe(180)
    expect(config.pluginSdkRequestBucketRlPerMin).toBe(600)
    expect(config.pluginSdkPreauthRlPerMin).toBe(600)
  })

  it('registers every key at the code default in the base ConfigMap', async () => {
    const config = await loadConfigWith({})
    const source = read('../../deploy/base/control-plane/configmaps.yaml')

    for (const { env, field } of EXPECTED) {
      const value = extractOne(
        source,
        new RegExp(`${env}:\\s*"(\\d+)"`),
        `${env} in deploy/base/control-plane/configmaps.yaml`
      )
      expect(Number(value), env).toBe(config[field])
    }
  })

  it('registers every key at the code default in the minikube full-copy overlay', async () => {
    const config = await loadConfigWith({})
    const source = read('../../deploy/overlays/minikube/configmaps/control-api-config.yaml')

    for (const { env, field } of EXPECTED) {
      const value = extractOne(
        source,
        new RegExp(`${env}:\\s*"(\\d+)"`),
        `${env} in deploy/overlays/minikube/configmaps/control-api-config.yaml`
      )
      expect(Number(value), env).toBe(config[field])
    }
  })
})
