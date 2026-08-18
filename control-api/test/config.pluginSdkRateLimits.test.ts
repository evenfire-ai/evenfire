import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Plugin Workload SDK platform rate-limit config (issue #348, plan D2).
 *
 * RED-FIRST (plan §6.6): the RED was captured pre-change — against the old
 * code the four `pluginSdk*RlPerMin` config fields and the four
 * `CONTROL_API_PLUGIN_SDK_*_PER_MIN` ConfigMap keys did not exist. Phase 1
 * (step 1.1) and Phase 3 (D1) have LANDED, so the behavior asserted below is
 * now live and this suite is GREEN. Do not weaken these assertions.
 *
 * Covered:
 *   1. Code defaults 150/120/600/600 (decision Q3: recalibrated from the old
 *      hardcoded 120/60; request-bucket and pre-auth unchanged at 600 but
 *      moved to ENV).
 *   2. Each ENV override honored.
 *   3. Invalid values fail loudly at import (positiveIntegerFromEnv).
 *   4. Empty string falls back to the code default.
 *   5. Deploy mirror: the base ConfigMap AND the minikube strategic-merge
 *      patch overlay both register every key at the code default (plan D1/R1 —
 *      the overlay is a strategic-merge patch, so an omitted key inherits the
 *      BASE value; all four keys are pinned so drift must fail HERE in CI).
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
    defaultValue: 150,
  },
  {
    env: 'CONTROL_API_PLUGIN_SDK_PROMPTBRIDGE_PER_MIN',
    field: 'pluginSdkPromptBridgeRlPerMin',
    defaultValue: 120,
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
    // The four fields exist on Config now; the widening cast is only to allow
    // dynamic `config[field]` access in the it.each below (the values are
    // asserted strictly there — no soft pass).
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

  it('defaults the four platform rate limits to 150/120/600/600', async () => {
    const config = await loadConfigWith({})

    expect(config.pluginSdkNotificationsRlPerMin).toBe(150)
    expect(config.pluginSdkPromptBridgeRlPerMin).toBe(120)
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

    expect(config.pluginSdkNotificationsRlPerMin).toBe(150)
    expect(config.pluginSdkPromptBridgeRlPerMin).toBe(120)
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

  it('registers every key at the code default in the minikube strategic-merge patch overlay', async () => {
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

  it('documents the platform per-minute defaults and ENV keys in the WorkflowRecipe CRD', () => {
    const source = read('../../charts/clerum-crds/crds/workflowrecipe.yaml')

    const invocationsDescription = extractOne(
      source,
      /maxInvocationsPerMinute:\s*\n\s*type: integer\s*\n\s*minimum: 1\s*\n\s*description: (.+)/,
      'maxInvocationsPerMinute description in charts/clerum-crds/crds/workflowrecipe.yaml'
    )
    expect(invocationsDescription).toContain('default 120')
    expect(invocationsDescription).toContain('CONTROL_API_PLUGIN_SDK_PROMPTBRIDGE_PER_MIN')

    const notificationsDescription = extractOne(
      source,
      /maxNotificationsPerMinute:\s*\n\s*type: integer\s*\n\s*minimum: 1\s*\n\s*description: (.+)/,
      'maxNotificationsPerMinute description in charts/clerum-crds/crds/workflowrecipe.yaml'
    )
    expect(notificationsDescription).toContain('default 150')
    expect(notificationsDescription).toContain('CONTROL_API_PLUGIN_SDK_NOTIFICATIONS_PER_MIN')
  })

  // Wiring guard: the request-bucket and pre-auth limits are only exercised for
  // their config VALUE above; their two CONSUMERS must actually read the config
  // field, not a hardcoded 600. A regression to `maxPerMinute: 600` / `limit:
  // 600` would otherwise pass every value/default test. extractOne fails loud if
  // the config reference is replaced by a literal.
  it('wires the request-bucket limit from config in the SDK request middleware', () => {
    const source = read('../src/middleware/pluginWorkloadSdkRateLimits.ts')
    const field = extractOne(
      source,
      /maxPerMinute:\s*config\.(pluginSdkRequestBucketRlPerMin)\b/,
      'maxPerMinute wired from config in src/middleware/pluginWorkloadSdkRateLimits.ts'
    )
    expect(field).toBe('pluginSdkRequestBucketRlPerMin')
  })

  it('wires the pre-auth flood-guard limit from config in the SDK routes', () => {
    const source = read('../src/routes/mcp-host/plugin-workload-sdk.routes.ts')
    const field = extractOne(
      source,
      /limit:\s*config\.(pluginSdkPreauthRlPerMin)\b/,
      'limit wired from config in src/routes/mcp-host/plugin-workload-sdk.routes.ts'
    )
    expect(field).toBe('pluginSdkPreauthRlPerMin')
  })
})
