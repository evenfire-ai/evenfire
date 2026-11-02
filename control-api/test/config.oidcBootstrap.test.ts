import { afterEach, describe, expect, it, vi } from 'vitest'

const originalOidcEnvironment = new Map(
  Object.entries(process.env).filter(([name]) => name.startsWith('CONTROL_API_OIDC_'))
)

async function importOrdinaryBootstrap(overrides: Record<string, string>): Promise<void> {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('CONTROL_API_OIDC_')) delete process.env[name]
  }
  Object.assign(process.env, overrides)
  vi.resetModules()

  const { config } = await import('../src/config.js')
  expect(config).not.toHaveProperty('oidcProviderConfiguration')

  const { pool } = await import('../src/db.js')
  await pool.end()
}

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('CONTROL_API_OIDC_')) delete process.env[name]
  }
  for (const [name, value] of originalOidcEnvironment) {
    if (value !== undefined) process.env[name] = value
  }
  vi.resetModules()
})

describe('inactive OIDC bootstrap compatibility', () => {
  it.each([
    ['an unknown future setting', { CONTROL_API_OIDC_FUTURE_SETTING: '' }],
    ['a present but empty provider credential', { CONTROL_API_OIDC_CLIENT_SECRET: '' }],
  ])('imports ordinary API and migration dependencies with %s', async (_case, overrides) => {
    await importOrdinaryBootstrap(overrides)
  })
})
