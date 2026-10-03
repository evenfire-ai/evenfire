import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  isProtectedSubscriptionBusinessPath,
  isSubscriptionAdmissionAuthProbe,
  observeProtectedSubscriptionBusinessAccess,
  requireSubscriptionAdmissionGuardEnv,
} from '../../tests/e2e/playwright/helpers/subscription-admission-guard'

describe('negative subscription admission guard contract', () => {
  it('observes actual protected subscription/model access while permitting the public auth probe', () => {
    for (const pathname of [
      '/api/v1/admin/llm/providers/codex-subscription/connections',
      '/api/v1/admin/llm/providers/grok-subscription/connections/unit/models',
      '/api/v1/admin/agents/unit/model',
      '/api/v1/admin/hosts/unit',
      '/api/v1/admin/llm-models',
      '/control-api/api/v1/admin/llm/providers/codex-subscription/connections',
      '/control-api/api/v1/admin/llm/providers/grok-subscription/connections/unit/models',
      '/control-api/api/v1/admin/agents/unit/model',
      '/control-api/api/v1/admin/hosts/unit',
      '/control-api/api/v1/admin/llm-models',
    ])
      expect(isProtectedSubscriptionBusinessPath(pathname)).toBe(true)
    for (const pathname of [
      '/api/v1/admin/auth/me',
      '/secrets/llm/subscriptions',
      '/api/v1/health',
      '/control-api/api/v1/admin/auth/me',
      '/foreign/control-api/api/v1/admin/hosts/unit',
      '/control-api-copy/api/v1/admin/hosts/unit',
    ]) {
      expect(isProtectedSubscriptionBusinessPath(pathname)).toBe(false)
    }
  })
  it('matches the actual BFF auth probe and direct API route without suffix or method widening', () => {
    // This path/status was observed in all three anonymous native guard traces.
    const actual = {
      url: 'http://127.0.0.1:34013/control-api/api/v1/admin/auth/me',
      method: 'GET',
      status: 401,
    }
    expect(isSubscriptionAdmissionAuthProbe(actual.url, actual.method)).toBe(true)
    expect(actual.status).toBe(401)
    expect(
      isSubscriptionAdmissionAuthProbe('http://127.0.0.1:34103/api/v1/admin/auth/me', 'GET')
    ).toBe(true)
    for (const url of [
      'http://127.0.0.1:34013/foreign/control-api/api/v1/admin/auth/me',
      'http://127.0.0.1:34013/control-api-copy/api/v1/admin/auth/me',
      'http://127.0.0.1:34013/control-api/api/v1/admin/auth/me/permissions',
      'http://127.0.0.1:34013/api/v1/admin/auth/me-copy',
    ])
      expect(isSubscriptionAdmissionAuthProbe(url, 'GET')).toBe(false)
    expect(isSubscriptionAdmissionAuthProbe(actual.url, 'POST')).toBe(false)
  })
  it('captures protected BFF and direct requests so an empty business oracle cannot hide either form', () => {
    let listener: ((request: { url(): string; method(): string }) => void) | undefined
    const attempted = observeProtectedSubscriptionBusinessAccess({
      on: (_event, callback) => {
        listener = callback
      },
    })
    if (!listener) throw new Error('request observer was not installed')
    for (const url of [
      'http://127.0.0.1:34013/control-api/api/v1/admin/hosts/unit',
      'http://127.0.0.1:34103/api/v1/admin/llm/providers/codex-subscription/connections',
      'http://127.0.0.1:34013/control-api/api/v1/admin/auth/me',
      'http://127.0.0.1:34013/foreign/control-api/api/v1/admin/hosts/unit',
    ])
      listener({ url: () => url, method: () => 'GET' })
    expect(attempted).toEqual([
      'GET /control-api/api/v1/admin/hosts/unit',
      'GET /api/v1/admin/llm/providers/codex-subscription/connections',
    ])
  })
  it('refuses default/shared/remote or unapproved guard targets at config load', () => {
    expect(() => requireSubscriptionAdmissionGuardEnv({})).toThrow(
      /E2E_SUBSCRIPTION_ADMISSION_GUARDS/
    )
    const input = {
      E2E_SUBSCRIPTION_ADMISSION_GUARDS: '1',
      MINIKUBE_PROFILE: 'unit-owned',
      CONTROL_API_REAL_PG_CONTEXT: 'unit-owned',
      CONTROL_UI_URL: 'http://127.0.0.1:34000',
      E2E_SUBSCRIPTION_ADMISSION_OUTPUT_DIR: '/tmp/unit-guard-results',
    }
    expect(requireSubscriptionAdmissionGuardEnv(input).url).toBe(input.CONTROL_UI_URL)
    for (const patch of [
      { CONTROL_UI_URL: 'http://127.0.0.1:3000' },
      { CONTROL_UI_URL: 'https://fixture.invalid' },
      { CONTROL_API_REAL_PG_CONTEXT: 'another' },
      { E2E_SUBSCRIPTION_ADMISSION_OUTPUT_DIR: '' },
    ]) {
      expect(() => requireSubscriptionAdmissionGuardEnv({ ...input, ...patch })).toThrow()
    }
  })
  it('selects only the unauthenticated guards without the legacy setup or login preflight', () => {
    const config = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../tests/e2e/playwright/playwright.subscription-admission.config.ts'
      ),
      'utf8'
    )
    expect(config).toContain('grep: /unauthenticated/')
    expect(config).toContain("'control-ui/codex-subscription-admission.spec.ts'")
    expect(config).not.toMatch(/globalSetup|global-setup|visible-login/)
    expect(config).toContain('requireSubscriptionAdmissionGuardEnv')
  })
})
