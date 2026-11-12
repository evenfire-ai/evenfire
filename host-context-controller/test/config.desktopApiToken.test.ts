import { afterEach, describe, expect, it, vi } from 'vitest'

describe('config.desktopApiToken', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('loads the token without its surrounding whitespace, as rpc-proxy trims its copy', async () => {
    vi.stubEnv('CONTEXT_MAPPER_DESKTOP_API_TOKEN', '  tok-with-newline\n')
    const { config } = await import('../src/config')
    expect(config.desktopApiToken).toBe('tok-with-newline')
  })

  it('loads an empty token when the variable is unset', async () => {
    vi.stubEnv('CONTEXT_MAPPER_DESKTOP_API_TOKEN', undefined)
    const { config } = await import('../src/config')
    expect(config.desktopApiToken).toBe('')
  })
})
