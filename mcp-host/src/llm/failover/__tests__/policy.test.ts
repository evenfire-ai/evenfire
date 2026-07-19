import { describe, expect, it } from 'vitest'
import { parseLlmPolicy } from '../policy'

describe('parseLlmPolicy', () => {
  it('returns null for absent / non-object / empty input (no failover)', () => {
    expect(parseLlmPolicy(undefined)).toBeNull()
    expect(parseLlmPolicy(null)).toBeNull()
    expect(parseLlmPolicy('nope')).toBeNull()
    expect(parseLlmPolicy({})).toBeNull()
    expect(parseLlmPolicy({ fallbacks: [] })).toBeNull()
    expect(parseLlmPolicy({ fallbacks: 'not-array' })).toBeNull()
  })

  it('parses a full policy with defaults resolved', () => {
    const p = parseLlmPolicy({
      fallbacks: [
        { provider: 'claude', model: 'claude-haiku-4-5', credentialSlot: 'claude-api-key-fb1' },
      ],
    })
    expect(p).toEqual({
      cooldownSeconds: 300,
      triggerOn: ['insufficient_quota', 'auth', 'provider_unavailable', 'rate_limited'],
      fallbacks: [
        { provider: 'claude', model: 'claude-haiku-4-5', credentialSlot: 'claude-api-key-fb1' },
      ],
    })
  })

  it('honours an explicit cooldown + triggerOn subset, dropping unknown classes', () => {
    const p = parseLlmPolicy({
      cooldownSeconds: 60,
      triggerOn: ['auth', 'bogus', 'rate_limited'],
      fallbacks: [{ provider: 'openai', model: 'gpt-5.4' }],
    })
    expect(p?.cooldownSeconds).toBe(60)
    expect(p?.triggerOn).toEqual(['auth', 'rate_limited'])
  })

  it('honours an explicitly empty triggerOn (operator disables all triggers)', () => {
    const p = parseLlmPolicy({
      triggerOn: [],
      fallbacks: [{ provider: 'openai', model: 'gpt-5.4' }],
    })
    expect(p?.triggerOn).toEqual([])
  })

  it('drops malformed fallback entries and collapses to null if none remain', () => {
    expect(
      parseLlmPolicy({
        fallbacks: [{ provider: 'openai' }, { model: 'x' }, { provider: '', model: 'y' }],
      })
    ).toBeNull()
    const p = parseLlmPolicy({
      fallbacks: [{ provider: 'openai' }, { provider: 'zai', model: 'glm-5.1' }],
    })
    expect(p?.fallbacks).toEqual([{ provider: 'zai', model: 'glm-5.1' }])
  })

  it('ignores a negative / non-integer cooldown, keeping the default', () => {
    expect(
      parseLlmPolicy({ cooldownSeconds: -5, fallbacks: [{ provider: 'openai', model: 'g' }] })
        ?.cooldownSeconds
    ).toBe(300)
    expect(
      parseLlmPolicy({ cooldownSeconds: 1.5, fallbacks: [{ provider: 'openai', model: 'g' }] })
        ?.cooldownSeconds
    ).toBe(300)
  })

  it('preserves cooldownSeconds: 0 (immediate expiry — CRD minimum:0), not coerced to 300', () => {
    expect(
      parseLlmPolicy({ cooldownSeconds: 0, fallbacks: [{ provider: 'openai', model: 'g' }] })
        ?.cooldownSeconds
    ).toBe(0)
  })
})
