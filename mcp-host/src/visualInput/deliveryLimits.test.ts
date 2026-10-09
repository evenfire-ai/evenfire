import { describe, expect, it } from 'vitest'
import {
  resolveOfficialVisualDeliveryLimits,
  resolveVisualDeliveryLimits,
  visualDimensionLimit,
} from './deliveryLimits'

describe('effective visual delivery limits', () => {
  it('reuses the Codex contract as the explicit subscription profile', () => {
    expect(resolveVisualDeliveryLimits('codex-subscription')).toEqual({
      maxImageBytes: 16 * 1024 * 1024,
      maxTotalImageBytes: 16 * 1024 * 1024,
      maxImages: 20,
      maxVisualRequestBytes: 24 * 1024 * 1024,
      maxNonImageRequestBytes: 8 * 1024 * 1024,
      maxDimension: 2048,
      maxPixels: 4_194_304,
    })
  })

  it('does not invent profiles for other providers or wire families', () => {
    expect(resolveVisualDeliveryLimits('openai')).toBeNull()
    expect(resolveVisualDeliveryLimits('grok-subscription')).toBeNull()
    expect(resolveVisualDeliveryLimits('unknown')).toBeNull()
  })

  it('binds official OpenAI payload limits to its exact endpoint and implemented operation', () => {
    const profile = resolveOfficialVisualDeliveryLimits(
      'openai',
      'https://api.openai.com:443/v1/',
      'completeWithTools'
    )!
    expect(profile).toEqual({ maxImages: 1500, maxVisualRequestBytes: 512_000_000 })
    expect(profile.maxImageBytes).toBeUndefined()
    expect(profile.maxTotalImageBytes).toBeUndefined()
    expect(
      resolveOfficialVisualDeliveryLimits('openai', 'https://api.openai.com/v1', 'complete')
    ).toBeNull()
    expect(
      resolveOfficialVisualDeliveryLimits(
        'openai',
        'https://api.openai.com/v1',
        'completeWithToolsAndCache'
      )
    ).toBeNull()
  })

  it.each([
    undefined,
    'http://api.openai.com/v1',
    'https://api.openai.com:444/v1',
    'https://api.openai.com.evil.invalid/v1',
    'https://unit-only.invalid/v1',
    'https://api.openai.com/v1?unit=1',
    'https://api.openai.com/v1#unit',
    'https://api.openai.com/v1/custom',
    'https://unit-user@api.openai.com/v1',
  ])('does not derive an official profile from an unverified endpoint: %s', endpoint => {
    expect(resolveOfficialVisualDeliveryLimits('openai', endpoint, 'completeWithTools')).toBeNull()
  })

  it('uses Claude encoded/wire limits and a documented safe count when model-window metadata is absent', () => {
    const profile = resolveOfficialVisualDeliveryLimits(
      'claude',
      'https://api.anthropic.com/',
      'completeWithToolsAndCache'
    )!
    expect(profile).toMatchObject({
      maxImageEncodedBytes: 10_000_000,
      maxImageBytes: 7_500_000,
      maxImages: 100,
      maxVisualRequestBytes: 32_000_000,
      maxDimension: 8000,
    })
    expect(profile.maxTotalImageBytes).toBeUndefined()
    expect(visualDimensionLimit(profile, 20)).toBe(8000)
    expect(visualDimensionLimit(profile, 21)).toBe(2000)
    expect(
      resolveOfficialVisualDeliveryLimits('claude', 'https://api.anthropic.com', 'complete')
    ).toBeNull()
    expect(
      resolveOfficialVisualDeliveryLimits('claude', 'https://api.anthropic.com', 'completeAndCache')
    ).not.toBeNull()
    expect(
      resolveOfficialVisualDeliveryLimits(
        'claude',
        'https://api.anthropic.com/v1',
        'completeWithTools'
      )
    ).toBeNull()
    expect(
      resolveOfficialVisualDeliveryLimits(
        'claude',
        'https://unit-only.invalid',
        'completeWithTools'
      )
    ).toBeNull()
  })
})
