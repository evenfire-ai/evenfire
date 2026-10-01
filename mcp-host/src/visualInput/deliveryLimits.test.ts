import { describe, expect, it } from 'vitest'
import { resolveVisualDeliveryLimits } from './deliveryLimits'

describe('effective visual delivery limits', () => {
  it('reuses the Codex contract as the explicit subscription profile', () => {
    expect(resolveVisualDeliveryLimits('codex-subscription')).toEqual({
      maxImageBytes: 16 * 1024 * 1024,
      maxTotalImageBytes: 16 * 1024 * 1024,
      maxImages: 20,
      maxVisualRequestBytes: 24 * 1024 * 1024,
      maxDimension: 2048,
      maxPixels: 4_194_304,
    })
  })

  it('does not invent profiles for other providers or wire families', () => {
    expect(resolveVisualDeliveryLimits('openai')).toBeNull()
    expect(resolveVisualDeliveryLimits('grok-subscription')).toBeNull()
    expect(resolveVisualDeliveryLimits('unknown')).toBeNull()
  })
})
