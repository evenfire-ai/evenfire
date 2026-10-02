import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  isProtectedSubscriptionBusinessPath,
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
    ])
      expect(isProtectedSubscriptionBusinessPath(pathname)).toBe(true)
    for (const pathname of [
      '/api/v1/admin/auth/me',
      '/secrets/llm/subscriptions',
      '/api/v1/health',
    ]) {
      expect(isProtectedSubscriptionBusinessPath(pathname)).toBe(false)
    }
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
