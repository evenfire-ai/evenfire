import { afterEach, describe, expect, it, vi } from 'vitest'

const CHALLENGE_KEYS = [
  'WORKFLOW_APPROVAL_MEDIUM_CHALLENGE_TTL_SEC',
  'TELEGRAM_PROVIDER_EVENT_CHALLENGE_TTL_SEC',
] as const

async function loadConfigWith(overrides: Partial<Record<(typeof CHALLENGE_KEYS)[number], string>>) {
  const originalValues = new Map<string, string | undefined>()
  for (const key of CHALLENGE_KEYS) {
    originalValues.set(key, process.env[key])
    delete process.env[key]
  }
  Object.assign(process.env, overrides)
  vi.resetModules()
  try {
    const mod = await import('../src/config.js')
    return mod.config
  } finally {
    for (const key of CHALLENGE_KEYS) {
      const value = originalValues.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('control-api approval medium challenge config', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('defaults challenge TTL to one hour', async () => {
    const config = await loadConfigWith({})

    expect(config.approvalMediumChallengeTtlSec).toBe(60 * 60)
  })

  it('accepts the challenge TTL environment override', async () => {
    const config = await loadConfigWith({
      WORKFLOW_APPROVAL_MEDIUM_CHALLENGE_TTL_SEC: '120',
    })

    expect(config.approvalMediumChallengeTtlSec).toBe(120)
  })

  it('defaults Telegram provider-event challenge TTL to two minutes', async () => {
    const config = await loadConfigWith({})

    expect(config.telegramProviderEventChallengeTtlSec).toBe(120)
  })

  it('accepts the Telegram provider-event TTL environment override', async () => {
    const config = await loadConfigWith({
      TELEGRAM_PROVIDER_EVENT_CHALLENGE_TTL_SEC: '300',
    })

    expect(config.telegramProviderEventChallengeTtlSec).toBe(300)
  })
})
