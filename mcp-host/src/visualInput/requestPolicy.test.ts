import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../core/types'
import { VISUAL_INPUT_LIMITS } from './policy'
import { assertVisualRequestFits, degradeUnverifiedImageInput } from './requestPolicy'

function messages(count: number): ChatMessage[] {
  return [
    {
      role: 'user',
      content: '',
      contentParts: Array.from({ length: count }, (_, index) => ({
        type: 'image' as const,
        mimeType: 'image/png' as const,
        data: 'YQ==',
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
    expect(() => assertVisualRequestFits(messages(3), {})).not.toThrow()
    expect(() => assertVisualRequestFits(messages(4), {})).toThrow('limit_exceeded')
  })

  it('checks the serialized request, including text/schema overhead', () => {
    expect(() =>
      assertVisualRequestFits(messages(1), 'x'.repeat(VISUAL_INPUT_LIMITS.requestBytes - 2))
    ).not.toThrow()
    expect(() =>
      assertVisualRequestFits(messages(1), 'x'.repeat(VISUAL_INPUT_LIMITS.requestBytes - 1))
    ).toThrow('limit_exceeded')
  })

  it('replaces every image part when the destination cannot take them', () => {
    const request = messages(2)
    expect(degradeUnverifiedImageInput(request)).toBe(true)
    expect(request[0].contentParts?.some(part => part.type === 'image')).toBe(false)
    expect(
      JSON.parse(
        request[0].contentParts![0].type === 'text' ? request[0].contentParts![0].text : '{}'
      )
    ).toMatchObject({
      delivery: 'reference_only',
      reason: 'image_input_not_verified_for_selected_model',
    })
    expect(request[0].content).toContain('not verified')
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
