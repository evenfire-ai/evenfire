/**
 * OAuth proactive-refresh cron config (mini-spec L §3/§5.1).
 *
 * The load-bearing invariant is `Bp > Br` (T5a): a proactive buffer that does not
 * clear the reactive buffer would let the proactive and reactive paths compete
 * for the same row on the happy path, defeating the idempotency argument. It is
 * refused at boot (throw), against the reactive buffer's single source of truth,
 * never a re-typed literal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REACTIVE_REFRESH_BUFFER_MS } from '../src/oauth/tokenHelper.js'

const BUFFER = 'OAUTH_PROACTIVE_REFRESH_BUFFER_MS'
const INTERVAL = 'OAUTH_PROACTIVE_REFRESH_INTERVAL_MS'
const ENABLED = 'OAUTH_PROACTIVE_REFRESH_CRON_ENABLED'
const WARN = 'OAUTH_DCR_SECRET_WARN_MS'
const KEYS = [BUFFER, INTERVAL, ENABLED, WARN] as const

async function loadConfigWith(env: Partial<Record<(typeof KEYS)[number], string>>) {
  const original = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))
  for (const key of KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  vi.resetModules()
  try {
    const mod = await import('../src/config.js')
    return mod.config
  } finally {
    for (const key of KEYS) {
      const value = original[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('control-api oauth proactive-refresh config', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('defaults: cron off, 60s interval, Bp=300s, Wc=7d', async () => {
    const config = await loadConfigWith({})
    expect(config.oauthProactiveRefreshCronEnabled).toBe(false)
    expect(config.oauthProactiveRefreshIntervalMs).toBe(60_000)
    expect(config.oauthProactiveRefreshBufferMs).toBe(300_000)
    expect(config.oauthDcrSecretWarnMs).toBe(604_800_000)
  })

  it('enables only on the exact token "true"', async () => {
    expect((await loadConfigWith({ [ENABLED]: 'true' })).oauthProactiveRefreshCronEnabled).toBe(
      true
    )
    expect((await loadConfigWith({ [ENABLED]: 'TRUE' })).oauthProactiveRefreshCronEnabled).toBe(
      false
    )
    expect((await loadConfigWith({ [ENABLED]: '1' })).oauthProactiveRefreshCronEnabled).toBe(false)
  })

  it('accepts a Bp strictly greater than the reactive buffer Br', async () => {
    const config = await loadConfigWith({ [BUFFER]: String(REACTIVE_REFRESH_BUFFER_MS + 1) })
    expect(config.oauthProactiveRefreshBufferMs).toBe(REACTIVE_REFRESH_BUFFER_MS + 1)
  })

  it('rejects Bp equal to Br (T5a boundary)', async () => {
    await expect(loadConfigWith({ [BUFFER]: String(REACTIVE_REFRESH_BUFFER_MS) })).rejects.toThrow(
      /must be greater than the reactive refresh buffer/
    )
  })

  it('rejects Bp below Br', async () => {
    await expect(
      loadConfigWith({ [BUFFER]: String(REACTIVE_REFRESH_BUFFER_MS - 1) })
    ).rejects.toThrow(/must be greater than the reactive refresh buffer/)
  })

  it('accepts an interval and warn-window override', async () => {
    const config = await loadConfigWith({ [INTERVAL]: '120000', [WARN]: '1000' })
    expect(config.oauthProactiveRefreshIntervalMs).toBe(120_000)
    expect(config.oauthDcrSecretWarnMs).toBe(1_000)
  })
})
