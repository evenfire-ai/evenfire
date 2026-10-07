import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../core/types'
import { PNG_2X2_BASE64, realPngOfDecodedBytesBase64 } from '../llm/__tests__/codexImageFixtures'
import { resolveOfficialVisualDeliveryLimits, resolveVisualDeliveryLimits } from './deliveryLimits'
import { VISUAL_INPUT_LIMITS } from './policy'
import { assertVisualRequestFits } from './requestPolicy'

const codexProfile = resolveVisualDeliveryLimits('codex-subscription')!

function messages(count: number): ChatMessage[] {
  return [
    {
      role: 'user',
      content: '',
      contentParts: Array.from({ length: count }, (_, index) => ({
        type: 'image' as const,
        mimeType: 'image/png' as const,
        data: PNG_2X2_BASE64,
        width: 2,
        height: 2,
        ...(index === 0
          ? {
              source: {
                kind: 'gfs' as const,
                drive: 'main',
                resourceId: 'a'.repeat(32),
                gfsUri: `gfs://main/${'a'.repeat(32)}`,
                version: 1,
                name: 'image.png',
              },
            }
          : {}),
      })),
    },
  ]
}

describe('last-mile visual request limits', () => {
  it('counts images from all origins once GFS input is present', () => {
    expect(() => assertVisualRequestFits(messages(20), {}, false, codexProfile)).not.toThrow()
    expect(() => assertVisualRequestFits(messages(21), {}, false, codexProfile)).toThrow(
      'limit_exceeded'
    )
  })

  it.each([undefined, null])(
    'rejects even small GFS pixels without an explicit attempt profile: %s',
    provider => {
      expect(() => assertVisualRequestFits(messages(1), {}, false, provider)).toThrow(
        'unsupported_format'
      )
    }
  )

  it('keeps ordinary images unchanged but does not lose a required GFS verification after source shaping', () => {
    const ordinary = messages(4)
    for (const part of ordinary[0]!.contentParts!) if (part.type === 'image') delete part.source
    expect(() => assertVisualRequestFits(ordinary, {}, false, null)).not.toThrow()
    expect(() => assertVisualRequestFits(ordinary, {}, true, null)).toThrow('unsupported_format')
    expect(() => assertVisualRequestFits(ordinary, {}, true, codexProfile)).not.toThrow()
  })

  it('checks the serialized request, including text/schema overhead', () => {
    const profile = resolveVisualDeliveryLimits('codex-subscription')!
    expect(() =>
      assertVisualRequestFits(
        messages(1),
        'x'.repeat(profile.maxVisualRequestBytes - 2),
        false,
        codexProfile
      )
    ).not.toThrow()
    expect(() =>
      assertVisualRequestFits(
        messages(1),
        'x'.repeat(profile.maxVisualRequestBytes - 1),
        false,
        codexProfile
      )
    ).toThrow('limit_exceeded')
  })

  it('uses the validated 16 MiB profile and sums GFS plus ordinary image bytes', () => {
    const mixed = messages(2)
    const large = realPngOfDecodedBytesBase64(9 * 1024 * 1024)
    if (mixed[0]!.contentParts![0]!.type !== 'image') throw new Error('expected image')
    mixed[0]!.contentParts![0]!.data = large
    expect(() => assertVisualRequestFits(messages(1), {}, false, codexProfile)).not.toThrow()
    expect(() => assertVisualRequestFits(mixed, {}, false, codexProfile)).not.toThrow()
    if (mixed[0]!.contentParts![1]!.type !== 'image') throw new Error('expected image')
    mixed[0]!.contentParts![1]!.data = large
    expect(() => assertVisualRequestFits(mixed, {}, false, codexProfile)).toThrow('limit_exceeded')
  })

  it('accepts a real image beyond 3 MiB through each official API profile', () => {
    const original = messages(1)
    const part = original[0]!.contentParts![0]!
    if (part.type !== 'image') throw new Error('expected image')
    part.data = realPngOfDecodedBytesBase64(3 * 1024 * 1024 + 1)
    for (const [provider, endpoint] of [
      ['openai', 'https://api.openai.com/v1'],
      ['claude', 'https://api.anthropic.com'],
    ] as const) {
      const profile = resolveOfficialVisualDeliveryLimits(provider, endpoint, 'completeWithTools')!
      expect(() =>
        assertVisualRequestFits(original, { messages: original }, false, profile)
      ).not.toThrow()
    }
  })

  it('checks the Claude encoded-image boundary without inventing an aggregate raw bound', () => {
    const profile = resolveOfficialVisualDeliveryLimits(
      'claude',
      'https://api.anthropic.com',
      'completeWithTools'
    )!
    const original = messages(2)
    for (const part of original[0]!.contentParts!) {
      if (part.type === 'image') part.data = realPngOfDecodedBytesBase64(7_500_000)
    }
    expect(() =>
      assertVisualRequestFits(original, { messages: original }, false, profile)
    ).not.toThrow()
    const part = original[0]!.contentParts![0]!
    if (part.type !== 'image') throw new Error('expected image')
    part.data = realPngOfDecodedBytesBase64(7_500_001)
    expect(() => assertVisualRequestFits(original, {}, false, profile)).toThrow('limit_exceeded')
  })

  it('counts ordinary images when applying the Claude many-image dimension threshold', () => {
    const profile = resolveOfficialVisualDeliveryLimits(
      'claude',
      'https://api.anthropic.com',
      'completeWithTools'
    )!
    const original = messages(21)
    const part = original[0]!.contentParts![0]!
    if (part.type !== 'image') throw new Error('expected image')
    part.data = realPngOfDecodedBytesBase64(64 * 1024, 2001, 2)
    part.width = 2001
    part.height = 2
    expect(() => assertVisualRequestFits(original, {}, false, profile)).toThrow('limit_exceeded')
    original[0]!.contentParts!.pop()
    expect(() => assertVisualRequestFits(original, {}, false, profile)).not.toThrow()
  })

  it.each([undefined, 0, -1, 1.5, Number.NaN])(
    'requires measured geometry for every image under a shape profile: width=%s',
    width => {
      const original = messages(2)
      const ordinary = original[0]!.contentParts![1]!
      if (ordinary.type !== 'image') throw new Error('expected image')
      if (width === undefined) delete ordinary.width
      else ordinary.width = width
      expect(() => assertVisualRequestFits(original, {}, false, codexProfile)).toThrow(
        'unsupported_format'
      )
    }
  )

  it('keeps ordinary images without measured geometry unchanged when no GFS verification is required', () => {
    const original = messages(1)
    const image = original[0]!.contentParts![0]!
    if (image.type !== 'image') throw new Error('expected image')
    delete image.source
    delete image.width
    delete image.height
    const profile = resolveOfficialVisualDeliveryLimits(
      'claude',
      'https://api.anthropic.com',
      'completeWithTools'
    )!
    expect(() => assertVisualRequestFits(original, {}, false, profile)).not.toThrow()
  })

  it('does not change existing text-only requests', () => {
    expect(() =>
      assertVisualRequestFits(
        [{ role: 'user', content: 'text' }],
        'x'.repeat(VISUAL_INPUT_LIMITS.requestBytes + 1)
      )
    ).not.toThrow()
  })
})
