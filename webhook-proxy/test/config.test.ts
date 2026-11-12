import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config'

const TOKEN_VAR = 'WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('loadConfig: control-api service token', () => {
  it('returns the configured token (the read the refusals below depend on)', () => {
    vi.stubEnv(TOKEN_VAR, 'webhook-proxy-token-from-secret')

    expect(loadConfig().controlApiServiceToken).toBe('webhook-proxy-token-from-secret')
  })

  it('refuses to start when the token is unset', () => {
    vi.stubEnv(TOKEN_VAR, undefined)

    expect(() => loadConfig()).toThrow(/WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN must be set/)
  })

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('refuses to start when the token is %s (an empty Secret value)', (_label, value) => {
    vi.stubEnv(TOKEN_VAR, value)

    expect(() => loadConfig()).toThrow(/WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN must be set/)
  })

  it('refuses to start with a replace-with-* placeholder left by an earlier release', () => {
    vi.stubEnv(TOKEN_VAR, 'replace-with-real-webhook-proxy-token')

    expect(() => loadConfig()).toThrow(/placeholder value.*apply-inter-service-tokens\.sh/)
  })
})
