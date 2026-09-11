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
        {
          provider: 'claude',
          model: 'claude-haiku-4-5',
          credentialSlot: 'claude-api-key-fb1',
          slotIndex: 0,
        },
      ],
    })
  })

  it('carries baseURL and the RAW fallback index (slotId source for the openai-compatible broker)', () => {
    const p = parseLlmPolicy({
      fallbacks: [
        {
          provider: 'openai-compatible',
          model: 'llama-3.3-70b',
          baseURL: 'http://10.0.0.5:8000/v1',
        },
      ],
    })
    expect(p?.fallbacks).toEqual([
      {
        provider: 'openai-compatible',
        model: 'llama-3.3-70b',
        baseURL: 'http://10.0.0.5:8000/v1',
        slotIndex: 0,
      },
    ])
  })

  it('trims a padded provider at the source so the fallback matches the fail-closed guard', () => {
    const p = parseLlmPolicy({
      fallbacks: [
        {
          provider: '  openai-compatible ',
          model: 'llama-3.3-70b',
          baseURL: 'http://10.0.0.5:8000/v1',
        },
      ],
    })
    // Canonical provider (not the padded literal), RAW slotIndex preserved. A
    // padded value here would slip past buildFallbackProvider's null-slotIndex
    // guard and dial the PRIMARY broker instead of the fallback's own.
    expect(p?.fallbacks).toEqual([
      {
        provider: 'openai-compatible',
        model: 'llama-3.3-70b',
        baseURL: 'http://10.0.0.5:8000/v1',
        slotIndex: 0,
      },
    ])
  })

  it('drops a whitespace-only provider fallback', () => {
    expect(parseLlmPolicy({ fallbacks: [{ provider: '   ', model: 'm' }] })).toBeNull()
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
    // slotIndex is the RAW index (1) — the malformed entry at index 0 was dropped
    // but must NOT renumber the survivor, or the openai-compatible broker dial
    // would target the wrong per-slot Service.
    expect(p?.fallbacks).toEqual([{ provider: 'zai', model: 'glm-5.1', slotIndex: 1 }])
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
