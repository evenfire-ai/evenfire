import { afterEach, describe, expect, it, vi } from 'vitest'

const TOKEN_VAR = 'EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN'

async function importConfig() {
  vi.resetModules()
  return (await import('../src/config.js')).config
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('control-api service token has no code default in any NODE_ENV', () => {
  it('reads the token from the environment on the non-production path', async () => {
    // The dev-default branch only exists outside production; prove these cases run there.
    expect(process.env.NODE_ENV).not.toBe('production')
    vi.stubEnv(TOKEN_VAR, 'external-rest-api-token-from-secret')

    expect((await importConfig()).controlApiServiceToken).toBe(
      'external-rest-api-token-from-secret'
    )
  })

  it('refuses to start when the token is unset', async () => {
    vi.stubEnv(TOKEN_VAR, undefined)

    await expect(importConfig()).rejects.toThrow(
      `Missing required environment variable: ${TOKEN_VAR}`
    )
  })

  it('refuses to start with a replace-with-* placeholder', async () => {
    vi.stubEnv(TOKEN_VAR, 'replace-with-external-rest-api-token')

    await expect(importConfig()).rejects.toThrow(
      /EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN has placeholder value .*apply-inter-service-tokens\.sh/
    )
  })

  it('refuses to start when the token is empty', async () => {
    vi.stubEnv(TOKEN_VAR, '')

    await expect(importConfig()).rejects.toThrow(
      `Missing required environment variable: ${TOKEN_VAR}`
    )
  })

  it.each([
    ['spaces', '   '],
    ['a newline', '\n'],
  ])('refuses to start when the token is only %s', async (_label, value) => {
    vi.stubEnv(TOKEN_VAR, value)

    await expect(importConfig()).rejects.toThrow(
      `Missing required environment variable: ${TOKEN_VAR}`
    )
  })

  it('refuses a replace-with-* placeholder after trimming surrounding spaces', async () => {
    vi.stubEnv(TOKEN_VAR, '  replace-with-external-rest-api-token')

    await expect(importConfig()).rejects.toThrow(
      /EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN has placeholder value .*apply-inter-service-tokens\.sh/
    )
  })

  it('loads the token without its surrounding whitespace', async () => {
    vi.stubEnv(TOKEN_VAR, '  external-rest-api-token-from-secret\n')

    expect((await importConfig()).controlApiServiceToken).toBe(
      'external-rest-api-token-from-secret'
    )
  })
})
