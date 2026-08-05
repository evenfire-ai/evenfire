/**
 * The reconcile interval feeds `setInterval` directly, so an unvalidated value is not a
 * cosmetic problem: `0` and any sub-millisecond fraction turn a coarse background loop into
 * a hot one (each tick is three Secret reads plus a Postgres advisory-lock transaction), a
 * negative or `NaN` value produces a timer Node cannot honour, and both are silent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const KEY = 'REGISTRY_PULL_SECRET_RECONCILE_INTERVAL_MS'

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

describe('control-api registry pull secret reconcile interval config', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('defaults to 10 minutes when unset', async () => {
    const config = await loadConfigWith()
    expect(config.registryPullSecretReconcileIntervalMs).toBe(600_000)
  })

  it('accepts a positive integer override at or above the floor', async () => {
    const config = await loadConfigWith('60000')
    expect(config.registryPullSecretReconcileIntervalMs).toBe(60_000)
  })

  it.each(['0', '-1', '1.5', 'abc'])('rejects %s', async value => {
    await expect(loadConfigWith(value)).rejects.toThrow(new RegExp(KEY))
  })

  // A positive integer is not sufficient on its own: `1` parses fine and still reconciles a
  // thousand times a second. The floor is what actually rules out the hot loop.
  it('rejects a positive value below the floor', async () => {
    await expect(loadConfigWith('1')).rejects.toThrow(new RegExp(KEY))
  })
})
