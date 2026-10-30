/**
 * The shared-grant sweep interval goes straight into `setInterval`, and each
 * tick lists every Context and runs one delete per Context: a value below the
 * floor is a hot loop against the apiserver and Postgres, so it is refused at
 * boot rather than clamped.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const KEY = 'OAUTH_SHARED_GRANT_SWEEP_INTERVAL_MS'

async function loadConfigWith(value?: string) {
  const original = process.env[KEY]
  delete process.env[KEY]
  if (value !== undefined) process.env[KEY] = value
  vi.resetModules()
  try {
    const mod = await import('../src/config.js')
    return mod.config
  } finally {
    if (original === undefined) delete process.env[KEY]
    else process.env[KEY] = original
  }
}

describe('control-api shared OAuth grant sweep interval config', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('defaults to 10 minutes when unset', async () => {
    const config = await loadConfigWith()
    expect(config.oauthSharedGrantSweepIntervalMs).toBe(600_000)
  })

  it('accepts the floor and anything above it', async () => {
    expect((await loadConfigWith('10000')).oauthSharedGrantSweepIntervalMs).toBe(10_000)
    expect((await loadConfigWith('60000')).oauthSharedGrantSweepIntervalMs).toBe(60_000)
  })

  it.each(['0', '-1', '1.5', 'abc'])('rejects %s', async value => {
    await expect(loadConfigWith(value)).rejects.toThrow(new RegExp(KEY))
  })

  it('rejects a positive value below the floor', async () => {
    await expect(loadConfigWith('9999')).rejects.toThrow(new RegExp(KEY))
  })
})
