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
 *   1. Code defaults 750/600/6000/600, plus authenticated pre-auth 6000 and
 *      credential operations 1800. The 600 pre-auth value remains the anonymous or
 *      invalid-credential source-IP ceiling.
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
  'CONTROL_API_PLUGIN_SDK_AUTHENTICATED_PREAUTH_PER_MIN',
  'CONTROL_API_PLUGIN_SDK_ADMIN_PER_MIN',
  'CONTROL_API_PLUGIN_SDK_INTERNAL_PER_MIN',
  'CONTROL_API_PLUGIN_SDK_CREDENTIAL_PER_MIN',
] as const

type RateLimitKey = (typeof RATE_LIMIT_KEYS)[number]

/** Canonical config field per ENV key with its locked default (plan §5). */
const EXPECTED: Array<{ env: RateLimitKey; field: string; defaultValue: number }> = [
  {
    env: 'CONTROL_API_PLUGIN_SDK_NOTIFICATIONS_PER_MIN',
    field: 'pluginSdkNotificationsRlPerMin',
    defaultValue: 750,
  },
  {
    env: 'CONTROL_API_PLUGIN_SDK_PROMPTBRIDGE_PER_MIN',
    field: 'pluginSdkPromptBridgeRlPerMin',
    defaultValue: 600,
  },
  {
    env: 'CONTROL_API_PLUGIN_SDK_REQUEST_BUCKET_PER_MIN',
    field: 'pluginSdkRequestBucketRlPerMin',
    defaultValue: 6000,
  },
  {
    env: 'CONTROL_API_PLUGIN_SDK_PREAUTH_PER_MIN',
    field: 'pluginSdkPreauthRlPerMin',
    defaultValue: 600,
  },
  {
    env: 'CONTROL_API_PLUGIN_SDK_AUTHENTICATED_PREAUTH_PER_MIN',
    field: 'pluginSdkAuthenticatedPreauthRlPerMin',
    defaultValue: 6000,
  },
  {
    env: 'CONTROL_API_PLUGIN_SDK_ADMIN_PER_MIN',
    field: 'pluginSdkAdminRlPerMin',
    defaultValue: 600,
  },
  {
    env: 'CONTROL_API_PLUGIN_SDK_INTERNAL_PER_MIN',
    field: 'pluginSdkInternalRlPerMin',
    defaultValue: 600,
  },
  {
    env: 'CONTROL_API_PLUGIN_SDK_CREDENTIAL_PER_MIN',
    field: 'pluginSdkCredentialRlPerMin',
    defaultValue: 1800,
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

  it('defaults platform rate limits without raising the anonymous pre-auth ceiling', async () => {
    const config = await loadConfigWith({})

    expect(config.pluginSdkNotificationsRlPerMin).toBe(750)
    expect(config.pluginSdkPromptBridgeRlPerMin).toBe(600)
    expect(config.pluginSdkRequestBucketRlPerMin).toBe(6000)
    expect(config.pluginSdkPreauthRlPerMin).toBe(600)
    expect(config.pluginSdkAuthenticatedPreauthRlPerMin).toBe(6000)
    expect(config.pluginSdkAdminRlPerMin).toBe(600)
    expect(config.pluginSdkInternalRlPerMin).toBe(600)
    expect(config.pluginSdkCredentialRlPerMin).toBe(1800)
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
      CONTROL_API_PLUGIN_SDK_AUTHENTICATED_PREAUTH_PER_MIN: '',
      CONTROL_API_PLUGIN_SDK_ADMIN_PER_MIN: '',
      CONTROL_API_PLUGIN_SDK_INTERNAL_PER_MIN: '',
      CONTROL_API_PLUGIN_SDK_CREDENTIAL_PER_MIN: '',
    })

    expect(config.pluginSdkNotificationsRlPerMin).toBe(750)
    expect(config.pluginSdkPromptBridgeRlPerMin).toBe(600)
    expect(config.pluginSdkRequestBucketRlPerMin).toBe(6000)
    expect(config.pluginSdkPreauthRlPerMin).toBe(600)
    expect(config.pluginSdkAuthenticatedPreauthRlPerMin).toBe(6000)
    expect(config.pluginSdkCredentialRlPerMin).toBe(1800)
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
    expect(invocationsDescription).toContain('default 600')
    expect(invocationsDescription).toContain('CONTROL_API_PLUGIN_SDK_PROMPTBRIDGE_PER_MIN')

    const notificationsDescription = extractOne(
      source,
      /maxNotificationsPerMinute:\s*\n\s*type: integer\s*\n\s*minimum: 1\s*\n\s*description: (.+)/,
      'maxNotificationsPerMinute description in charts/clerum-crds/crds/workflowrecipe.yaml'
    )
    expect(notificationsDescription).toContain('default 750')
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

  it('keeps anonymous pre-auth separate from the verified principal allowance', () => {
    const source = read('../src/middleware/pluginWorkloadSdkRateLimits.ts')
    expect(source).toContain('limit: config.pluginSdkPreauthRlPerMin')
    expect(source).toContain('limit: config.pluginSdkAuthenticatedPreauthRlPerMin')
    expect(source).toContain('maxPerMinute: config.pluginSdkAdminRlPerMin')
    expect(source).toContain('maxPerMinute: config.pluginSdkInternalRlPerMin')

    const routes = read('../src/routes/mcp-host/plugin-workload-sdk.routes.ts')
    const mounted = routes.slice(routes.indexOf("'/mcp-host/plugin-workload-sdk'"))
    const anonymous = mounted.indexOf('createPluginWorkloadSdkAnonymousPreauthRateLimit()')
    const authenticated = mounted.indexOf('createPluginWorkloadSdkAuthenticatedPreauthRateLimit()')
    const jwt = mounted.indexOf('requireMcpHostJwt,')
    const bucket = mounted.indexOf('createPluginWorkloadSdkRequestRateLimit()')
    expect(anonymous).toBeGreaterThan(-1)
    expect(anonymous).toBeLessThan(authenticated)
    expect(authenticated).toBeLessThan(jwt)
    expect(jwt).toBeLessThan(bucket)
  })

  it('gives a verified principal its own pre-auth allowance', async () => {
    const config = await loadConfigWith({})
    const { pluginSdkPreauthAssignment } =
      await import('../src/middleware/pluginWorkloadSdkRateLimits.js')

    expect(pluginSdkPreauthAssignment(null)).toEqual({
      limit: config.pluginSdkPreauthRlPerMin,
      key: null,
    })
    expect(pluginSdkPreauthAssignment('recipe:alpha')).toEqual({
      limit: config.pluginSdkAuthenticatedPreauthRlPerMin,
      key: 'plugin_workload_sdk_preauth:recipe:alpha',
    })
    expect(config.pluginSdkPreauthRlPerMin).toBe(600)
    expect(config.pluginSdkAuthenticatedPreauthRlPerMin).toBe(6000)
  })
})
