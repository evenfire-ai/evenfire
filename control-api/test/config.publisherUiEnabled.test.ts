import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  vi.resetModules()
  process.env = { ...ORIGINAL_ENV }
  delete process.env.CONTROL_API_PUBLISHER_UI_ENABLED
  delete process.env.REGISTRY_CONNECTION_MODE
})
afterEach(() => {
  process.env = ORIGINAL_ENV
  vi.resetModules()
})

describe('config: publisherUiEnabled (mode-based default + env override)', () => {
  it('defaults to false when REGISTRY_CONNECTION_MODE=self-hosted', async () => {
    process.env.REGISTRY_CONNECTION_MODE = 'self-hosted'
    const { config } = await import('../src/config.js')
    expect(config.publisherUiEnabled).toBe(false)
  })

  it('defaults to true when REGISTRY_CONNECTION_MODE=managed', async () => {
    process.env.REGISTRY_CONNECTION_MODE = 'managed'
    const { config } = await import('../src/config.js')
    expect(config.publisherUiEnabled).toBe(true)
  })

  it('defaults to true when REGISTRY_CONNECTION_MODE is unset (implicit managed)', async () => {
    const { config } = await import('../src/config.js')
    expect(config.publisherUiEnabled).toBe(true)
  })

  it('CONTROL_API_PUBLISHER_UI_ENABLED=true overrides the self-hosted default to true', async () => {
    process.env.REGISTRY_CONNECTION_MODE = 'self-hosted'
    process.env.CONTROL_API_PUBLISHER_UI_ENABLED = 'true'
    const { config } = await import('../src/config.js')
    expect(config.publisherUiEnabled).toBe(true)
  })

  it('CONTROL_API_PUBLISHER_UI_ENABLED=false overrides the managed default to false', async () => {
    process.env.REGISTRY_CONNECTION_MODE = 'managed'
    process.env.CONTROL_API_PUBLISHER_UI_ENABLED = 'false'
    const { config } = await import('../src/config.js')
    expect(config.publisherUiEnabled).toBe(false)
  })

  it('an unrecognized CONTROL_API_PUBLISHER_UI_ENABLED value falls back to the mode-based default', async () => {
    process.env.REGISTRY_CONNECTION_MODE = 'self-hosted'
    process.env.CONTROL_API_PUBLISHER_UI_ENABLED = 'yes'
    const { config } = await import('../src/config.js')
    expect(config.publisherUiEnabled).toBe(false)
  })
})
