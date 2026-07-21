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

describe('config: publisherUiEnabled (default ON; only CONTROL_API_PUBLISHER_UI_ENABLED=false disables)', () => {
  it('defaults to true on self-hosted (Publisher UI is production-ready)', async () => {
    process.env.REGISTRY_CONNECTION_MODE = 'self-hosted'
    const { config } = await import('../src/config.js')
    expect(config.publisherUiEnabled).toBe(true)
  })

  it('defaults to true on managed', async () => {
    process.env.REGISTRY_CONNECTION_MODE = 'managed'
    const { config } = await import('../src/config.js')
    expect(config.publisherUiEnabled).toBe(true)
  })

  it('defaults to true when REGISTRY_CONNECTION_MODE is unset', async () => {
    const { config } = await import('../src/config.js')
    expect(config.publisherUiEnabled).toBe(true)
  })

  it('CONTROL_API_PUBLISHER_UI_ENABLED=false disables it (even on managed)', async () => {
    process.env.REGISTRY_CONNECTION_MODE = 'managed'
    process.env.CONTROL_API_PUBLISHER_UI_ENABLED = 'false'
    const { config } = await import('../src/config.js')
    expect(config.publisherUiEnabled).toBe(false)
  })

  it('CONTROL_API_PUBLISHER_UI_ENABLED=false disables it on self-hosted too', async () => {
    process.env.REGISTRY_CONNECTION_MODE = 'self-hosted'
    process.env.CONTROL_API_PUBLISHER_UI_ENABLED = 'false'
    const { config } = await import('../src/config.js')
    expect(config.publisherUiEnabled).toBe(false)
  })

  it('CONTROL_API_PUBLISHER_UI_ENABLED=true keeps it enabled', async () => {
    process.env.REGISTRY_CONNECTION_MODE = 'self-hosted'
    process.env.CONTROL_API_PUBLISHER_UI_ENABLED = 'true'
    const { config } = await import('../src/config.js')
    expect(config.publisherUiEnabled).toBe(true)
  })

  it('an unrecognized value stays enabled — only "false" disables', async () => {
    process.env.REGISTRY_CONNECTION_MODE = 'self-hosted'
    process.env.CONTROL_API_PUBLISHER_UI_ENABLED = 'yes'
    const { config } = await import('../src/config.js')
    expect(config.publisherUiEnabled).toBe(true)
  })
})
