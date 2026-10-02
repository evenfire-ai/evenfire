import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  requireSubscriptionImageRun,
  verifyRunnerObservation,
} from './e2e-playwright/subscriptionImageRunContract.js'

// These are unit-only bindings. They are never a runtime receipt or login identity.
function env(): NodeJS.ProcessEnv {
  return {
    E2E_SUBSCRIPTION_IMAGE_INPUT: '1',
    E2E_SUBSCRIPTION_IMAGE_MODE: 'fixture',
    SUBSCRIPTION_IMAGE_FIXTURE_CONFIRM: '1',
    E2E_SUBSCRIPTION_IMAGE_RUN_ID: 'subscription-image-123456abcdef',
    SUBSCRIPTION_IMAGE_RUNNER_RECEIPT: '/tmp/runner-proof.json',
    SUBSCRIPTION_IMAGE_RUN_ROOT: '/tmp/runner-owned',
    E2E_GROK_IMAGE_EVIDENCE_PATH: '/tmp/runner-owned/grok-vendor.json',
    E2E_CODEX_IMAGE_EVIDENCE_PATH: '/tmp/runner-owned/codex-vendor.json',
    MINIKUBE_PROFILE: 'unit-owned-profile',
    CONTROL_API_REAL_PG_CONTEXT: 'unit-owned-profile',
    EXTERNAL_REST_API_BASE_URL: 'http://127.0.0.1:34011',
    RPC_PROXY_BASE_URL: 'http://127.0.0.1:34012',
    E2E_SUBSCRIPTION_IMAGE_LOGIN_EMAIL: 'unit@fixture.invalid',
    E2E_SUBSCRIPTION_IMAGE_LOGIN_PASSWORD: ['unit', 'only'].join('-'),
    E2E_GROK_IMAGE_HOST_REF: 'unit-grok',
    E2E_GROK_IMAGE_HOST_LABEL: 'Unit Grok',
    E2E_GROK_IMAGE_MODEL: 'unit-grok-model',
    E2E_GROK_IMAGE_MODEL_LABEL: 'Unit Grok Model',
    E2E_GROK_IMAGE_UNSUPPORTED_MODEL: 'unit-grok-text',
    E2E_GROK_IMAGE_UNSUPPORTED_MODEL_LABEL: 'Unit Grok Text',
    E2E_CODEX_IMAGE_HOST_REF: 'unit-codex',
    E2E_CODEX_IMAGE_HOST_LABEL: 'Unit Codex',
    E2E_CODEX_IMAGE_MODEL: 'unit-codex-model',
    E2E_CODEX_IMAGE_MODEL_LABEL: 'Unit Codex Model',
    E2E_CODEX_IMAGE_UNSUPPORTED_MODEL: 'unit-codex-text',
    E2E_CODEX_IMAGE_UNSUPPORTED_MODEL_LABEL: 'Unit Codex Text',
  }
}

describe('subscription image load admission', () => {
  it('refuses missing opt-ins before considering any fixture or setup', () => {
    expect(() => requireSubscriptionImageRun({})).toThrow(/E2E_SUBSCRIPTION_IMAGE_INPUT/)
    for (const name of [
      'E2E_SUBSCRIPTION_IMAGE_MODE',
      'SUBSCRIPTION_IMAGE_FIXTURE_CONFIRM',
      'SUBSCRIPTION_IMAGE_RUNNER_RECEIPT',
    ]) {
      const input = env()
      delete input[name]
      expect(() => requireSubscriptionImageRun(input)).toThrow(new RegExp(name))
    }
  })

  it('requires both real-provider authorizations without downgrading malformed mode', () => {
    const input: NodeJS.ProcessEnv = { ...env(), E2E_SUBSCRIPTION_IMAGE_MODE: 'real' }
    expect(() => requireSubscriptionImageRun(input)).toThrow(/GROK_REAL_UPSTREAM_CONFIRM/)
    input.GROK_REAL_UPSTREAM_CONFIRM = '1'
    expect(() => requireSubscriptionImageRun(input)).toThrow(/CODEX_REAL_UPSTREAM_CONFIRM/)
    input.CODEX_REAL_UPSTREAM_CONFIRM = '1'
    expect(requireSubscriptionImageRun(input).mode).toBe('real')
    expect(() =>
      requireSubscriptionImageRun({ ...env(), E2E_SUBSCRIPTION_IMAGE_MODE: 'invalid' })
    ).toThrow(/MODE/)
  })

  it('rejects unowned defaults, remote targets and ambiguous provider bindings', () => {
    for (const patch of [
      { EXTERNAL_REST_API_BASE_URL: 'http://127.0.0.1:8091' },
      { RPC_PROXY_BASE_URL: 'https://fixture.invalid:34123' },
      { CONTROL_API_REAL_PG_CONTEXT: 'another-profile' },
      { E2E_CODEX_IMAGE_HOST_REF: 'unit-grok' },
      { E2E_GROK_IMAGE_EVIDENCE_PATH: '/tmp/outside.json' },
    ])
      expect(() => requireSubscriptionImageRun({ ...env(), ...patch })).toThrow()
  })

  it('checks actual namespace, mount, OS identity and HOME observations instead of a boolean assertion', () => {
    const observed = {
      platform: 'linux',
      uid: 1000,
      gid: 1000,
      home: '/home/runner',
      mountNamespace: 'mnt:[123]',
      pidNamespace: 'pid:[234]',
      userNamespace: 'user:[345]',
      mountInfoSha256: 'a'.repeat(64),
    }
    expect(() =>
      verifyRunnerObservation(observed, { ...observed }, { HOME: observed.home })
    ).not.toThrow()
    for (const field of [
      'uid',
      'gid',
      'home',
      'mountNamespace',
      'pidNamespace',
      'userNamespace',
      'mountInfoSha256',
    ] as const) {
      expect(() =>
        verifyRunnerObservation(
          observed,
          { ...observed, [field]: typeof observed[field] === 'number' ? 1001 : 'different' },
          { HOME: observed.home }
        )
      ).toThrow(/runner|isolation/i)
    }
    expect(() =>
      verifyRunnerObservation(observed, { ...observed, uid: 0 }, { HOME: observed.home })
    ).toThrow()
    expect(() =>
      verifyRunnerObservation(
        observed,
        { ...observed },
        { HOME: observed.home, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/outside/bus' }
      )
    ).toThrow(/socket/i)
    expect(() => verifyRunnerObservation(observed, { ...observed }, { HOME: '/outside' })).toThrow(
      /HOME/
    )
  })

  it('keeps the dedicated suite out of general collection and independent of legacy setup', () => {
    const root = path.resolve(__dirname, 'e2e-playwright')
    expect(fs.readFileSync(path.join(root, 'playwright.config.ts'), 'utf8')).toContain(
      "'**/subscription-image-input.spec.ts'"
    )
    const dedicated = fs.readFileSync(
      path.join(root, 'playwright.subscription-image.config.ts'),
      'utf8'
    )
    expect(dedicated).toContain('requireSubscriptionImageRun')
    expect(dedicated).not.toMatch(/global-setup|from ['"].*playwright\.config|\.env/)
    expect(dedicated).toContain('subscription-image-input.spec.ts')
  })
})
