import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { challengeImage, paddedChallengeImage } from './e2e-playwright/codexImageChallenge.js'

const MIB = 1024 * 1024
const { inspectVisualImage } = createRequire(import.meta.url)(
  '../../packages/llm-provider-attempt-contract/visualPayload.cjs'
) as {
  inspectVisualImage: (input: { mimeType: string; data: string }) => {
    ok: boolean
    message?: string
  }
}

describe('Codex image challenge fixtures', () => {
  it('keeps the answer out of the small PNG/JPEG containers', () => {
    for (const format of ['png', 'jpeg'] as const) {
      const image = challengeImage(format)
      expect(image.code).toMatch(/^[0-9A-F]{16}$/)
      expect(image.bytes.includes(Buffer.from(image.code))).toBe(false)
      expect(
        inspectVisualImage({
          mimeType: `image/${format}`,
          data: image.bytes.toString('base64'),
        }).ok
      ).toBe(true)
    }
  })

  it('pads a 5 MiB JPEG without putting the answer in the file bytes as text', () => {
    const image = paddedChallengeImage('jpeg', 5 * MIB)
    expect(image.bytes).toHaveLength(5 * MIB)
    expect(image.bytes.includes(Buffer.from(image.code))).toBe(false)
    const inspected = inspectVisualImage({
      mimeType: 'image/jpeg',
      data: image.bytes.toString('base64'),
    })
    expect(inspected.ok, inspected.message).toBe(true)
  })
})
