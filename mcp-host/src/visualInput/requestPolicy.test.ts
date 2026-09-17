import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../core/types'
import { VISUAL_INPUT_LIMITS } from './policy'
import { assertVisualRequestFits } from './requestPolicy'

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

  it('does not change existing text-only requests', () => {
    expect(() =>
      assertVisualRequestFits(
        [{ role: 'user', content: 'text' }],
        'x'.repeat(VISUAL_INPUT_LIMITS.requestBytes + 1)
      )
    ).not.toThrow()
  })
})
